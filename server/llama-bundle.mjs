import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export const execute=promisify(execFile);
export const llamaManifest=JSON.parse(await fs.readFile(new URL('./config/llama-manifest.json',import.meta.url),'utf8'));

const extractScript=`Add-Type -AssemblyName System.IO.Compression.FileSystem
$destination=[IO.Path]::GetFullPath($env:SAS_LLAMA_DEST)
$archive=[IO.Compression.ZipFile]::OpenRead($env:SAS_LLAMA_ZIP)
try {
  foreach($entry in $archive.Entries){
    $target=[IO.Path]::GetFullPath([IO.Path]::Combine($destination,$entry.FullName))
    if(-not $target.StartsWith($destination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive entry outside destination'}
    if($entry.Name){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)}
  }
}finally{$archive.Dispose()}`;
export function bundleDirectory(root,backend){return path.join(root,llamaManifest.version,backend);}
export async function findExecutable(directory){
  const entries=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries)if(entry.isFile()&&entry.name==='llama-server.exe')return path.join(directory,entry.name);
  for(const entry of entries)if(entry.isDirectory()){const found=await findExecutable(path.join(directory,entry.name));if(found)return found;}
  return null;
}
export async function bundleExecutable(root,backend){
  const directory=bundleDirectory(root,backend);
  try{const ready=JSON.parse(await fs.readFile(path.join(directory,'sas-ready.json'),'utf8'));if(ready.version===llamaManifest.version)return await findExecutable(directory);}catch{}
  return null;
}
async function digest(file){const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function installBundle(root,backend,{signal,onProgress=()=>{}}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Встроенная сборка локальных моделей рассчитана на Windows x64. Подключения к внешним API доступны на этой системе.');
  const assets=llamaManifest.assets.filter(a=>a.backend===backend);if(!assets.length)throw new Error('Неизвестный вариант локального движка.');
  const directory=bundleDirectory(path.resolve(root),backend),cache=path.join(path.resolve(root),'downloads');
  await fs.mkdir(directory,{recursive:true});await fs.mkdir(cache,{recursive:true});
  for(const asset of assets){
    signal?.throwIfAborted();const target=path.join(cache,asset.name);
    if(!await fs.stat(target).then(s=>s.size===asset.size).catch(()=>false)||await digest(target)!==asset.sha256){
      const part=target+'.part';let received=0;
      const response=await fetch(asset.url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1800000)]):AbortSignal.timeout(1800000)});
      if(!response.ok||!response.body)throw new Error('Не удалось подготовить локальные модели: HTTP '+response.status);
      const hash=crypto.createHash('sha256');
      try{
        await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback){received+=chunk.length;if(received>asset.size)return callback(new Error('Размер пакета отличается от ожидаемого.'));hash.update(chunk);onProgress({backend,file:asset.name,downloaded:received,total:asset.size});callback(null,chunk);}}),createWriteStream(part),{signal});
        if(received!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('Проверка целостности локального движка не пройдена.');
        await fs.rename(part,target);
      }catch(error){await fs.unlink(part).catch(()=>{});throw error;}
    }
    onProgress({backend,file:asset.name,stage:'Распаковка',downloaded:asset.size,total:asset.size});
    await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',extractScript],{windowsHide:true,timeout:180000,env:{...process.env,SAS_LLAMA_ZIP:target,SAS_LLAMA_DEST:directory},signal});
  }
  const executable=await findExecutable(directory);if(!executable)throw new Error('В пакете нет локального движка.');
  await fs.writeFile(path.join(directory,'sas-ready.json'),JSON.stringify({version:llamaManifest.version,backend,assets:assets.map(a=>({name:a.name,sha256:a.sha256}))},null,2));
  return executable;
}
