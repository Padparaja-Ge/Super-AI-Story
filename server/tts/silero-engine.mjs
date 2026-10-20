import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream} from 'node:fs';
import {downloadFile,run,safeFolder} from './installer.mjs';

export const SILERO_RUNTIME_VERSION=1;
export const SILERO_PYTHON_VERSION='3.11.9';
export const SILERO_TORCH_VERSION='2.5.1';
// SHA-256 from Python.org's .zip.sigstore messageSignature.messageDigest.
export const SILERO_PYTHON_ARCHIVE={size:11249023,sha256:'009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b'};
const dependencies=['numpy==1.26.4','filelock==3.19.1','typing_extensions==4.15.0','networkx==3.4.2','jinja2==3.1.6','MarkupSafe==3.0.3','fsspec==2025.9.0','sympy==1.13.1','mpmath==1.3.0','setuptools==80.9.0'];
export function sileroExecutable(runtime){return path.join(runtime,process.platform==='win32'?'python.exe':'bin/python');}
export function sileroRuntimeCompatible(marker,device,{platform:currentPlatform=process.platform,arch:currentArch=process.arch}={}){
 const platform=marker?.platform||(marker?.portable===true?'win32':null),arch=marker?.arch||(marker?.portable===true?'x64':null);
 return marker?.provider==='silero'&&marker.version===SILERO_RUNTIME_VERSION&&marker.device===device&&platform===currentPlatform&&arch===currentArch&&(currentPlatform!=='win32'||marker.portable===true);
}
const validMarker=sileroRuntimeCompatible;
async function markerAt(runtime){try{return JSON.parse(await fs.readFile(path.join(runtime,'sas-ready.json'),'utf8'));}catch{return null;}}
const developmentExtensions=/\.(?:h|hh|hpp|hxx|c|cc|cpp|cuh|inc|inl|tpp|cmake|in|txt|md|rst|lib|pc|def)$/i;
export function sileroRuntimeDevelopmentFile(relative){
 const name=relative.replaceAll('\\','/'),lower=name.toLowerCase(),base=path.posix.basename(name);
 if(/^(?:license|copying|notice)(?:[._-].*)?$/i.test(base)||lower.includes('.dist-info/'))return false;
 if(lower.endsWith('.pyc'))return true;
 if(/(?:^|\/)site-packages\/torch\/lib\/.*\.lib$/.test(lower))return true;
 return /(?:^|\/)site-packages\/torch\/(?:include|share\/cmake)\//.test(lower)&&developmentExtensions.test(base);
}
async function noLinkPath(target){
 const resolved=path.resolve(target),parsed=path.parse(resolved);let current=parsed.root;
 for(const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error('Runtime Silero не должен содержать ссылки.');}
 return resolved;
}
export async function pruneSileroRuntime(runtime,{storage=path.resolve(runtime,'../..')}={}){
 const root=path.resolve(runtime),storageRoot=path.resolve(storage),device=path.basename(root).replace(/^silero-/,'');
 if(!['cpu','gpu'].includes(device)||path.relative(path.join(storageRoot,'runtime','silero-'+device),root)!=='')throw new Error('Отказ очистки: недопустимый путь автономного Silero.');
 await noLinkPath(root);await noLinkPath(storageRoot);
 if(path.relative(root,await fs.realpath(root))!=='')throw new Error('Отказ очистки: недопустимый путь автономного Silero.');
 let marker=await markerAt(root);
 if(!marker){try{marker=JSON.parse(await fs.readFile(path.join(root,'sas-preparing.json'),'utf8'));}catch{}}
 if(!validMarker(marker,device))throw new Error('Отказ очистки: отсутствует проверенный marker Silero.');
 const files=[],directories=[];
 async function scan(directory){
  for(const item of await fs.readdir(directory,{withFileTypes:true})){const absolute=path.join(directory,item.name),stat=await fs.lstat(absolute);if(stat.isSymbolicLink())throw new Error('Отказ очистки: runtime Silero содержит ссылку.');if(stat.isDirectory()){directories.push(absolute);await scan(absolute);}else if(stat.isFile())files.push({absolute,relative:path.relative(root,absolute),bytes:stat.size});else throw new Error('Отказ очистки: неизвестный тип файла runtime Silero.');}
 }
 // Audit the entire tree before deleting any file. No recursive removal and
 // no following of links, even if they are outside the development subtrees.
 await scan(root);const selected=files.filter(file=>sileroRuntimeDevelopmentFile(file.relative)),removed=[];
 for(const file of selected){const relative=path.relative(root,file.absolute);if(relative.startsWith('..')||path.isAbsolute(relative)||!sileroRuntimeDevelopmentFile(relative))throw new Error('Отказ очистки: путь вышел за границы runtime.');await noLinkPath(file.absolute);const stat=await fs.lstat(file.absolute);if(!stat.isFile())throw new Error('Отказ очистки: тип файла изменился.');await fs.unlink(file.absolute);removed.push({path:file.relative,bytes:file.bytes});}
 for(const directory of directories.reverse()){const relative=path.relative(root,directory).replaceAll('\\','/').toLowerCase();if(relative.split('/').includes('__pycache__')||/(?:^|\/)site-packages\/torch\/(?:include|share\/cmake)(?:\/|$)/.test(relative)){await noLinkPath(directory);await fs.rmdir(directory).catch(error=>{if(!['ENOTEMPTY','ENOENT'].includes(error.code))throw error;});}}
 const beforeBytes=files.reduce((sum,file)=>sum+file.bytes,0),removedBytes=removed.reduce((sum,file)=>sum+file.bytes,0);
 return {runtime:root,storage:storageRoot,beforeBytes,afterBytes:beforeBytes-removedBytes,removedBytes,removedFiles:removed.length,removed};
}
async function validate(runtime,device,options={}){
 await run(sileroExecutable(runtime),['-I','-B','-c',`import sys, torch, numpy; assert torch.__version__.split('+')[0]=='${SILERO_TORCH_VERSION}'; assert numpy.__version__=='1.26.4'; ${device==='gpu'?"assert torch.cuda.is_available(), 'CUDA недоступна; выберите CPU.'":'assert True'}; print('SAS_SILERO_READY')`],options);
}
async function checkedBundle(runtime){
 // fs.cp would preserve links. A distributable runtime must contain its own
 // files, rather than refer to the build machine's Python or site-packages.
 const entries=await fs.readdir(runtime,{withFileTypes:true});
 for(const entry of entries){if(entry.isSymbolicLink())throw new Error('Бандл Silero содержит ссылку вместо автономного файла.');if(entry.isDirectory())await checkedBundle(path.join(runtime,entry.name));}
}
async function pipBootstrap(runtime,storage,signal){
 const response=await fetch('https://pypi.org/pypi/pip/24.3.1/json',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('Не удалось получить официальный пакет pip: HTTP '+response.status);
 const release=await response.json(),wheel=release.urls?.find(file=>file.filename==='pip-24.3.1-py3-none-any.whl');
 if(!wheel||!/^https:\/\/files\.pythonhosted\.org\//.test(wheel.url)||!Number.isInteger(wheel.size)||!wheel.size||wheel.size>5_000_000||!/^[a-f0-9]{64}$/.test(wheel.digests?.sha256||''))throw new Error('Неверные метаданные официального pip.');
 const archive=path.join(storage,'downloads',wheel.filename);
 await downloadFile(wheel.url,archive,{size:wheel.size,sha256:wheel.digests.sha256,signal});
 await run(process.execPath,[path.join(import.meta.dirname,'extract.mjs'),archive,path.join(runtime,'Lib','site-packages')],{signal});
}
async function portablePython(runtime,storage,signal){
 if(process.arch!=='x64')throw new Error('Автономный Silero для Windows требует x64.');
 const archive=path.join(storage,'downloads',`python-${SILERO_PYTHON_VERSION}-embed-amd64.zip`);
 await downloadFile(`https://www.python.org/ftp/python/${SILERO_PYTHON_VERSION}/python-${SILERO_PYTHON_VERSION}-embed-amd64.zip`,archive,{signal,...SILERO_PYTHON_ARCHIVE});
 await run(process.execPath,[path.join(import.meta.dirname,'extract.mjs'),archive,runtime],{signal});
 await fs.mkdir(path.join(runtime,'Lib','site-packages'),{recursive:true});
 // Every path is relative to python.exe. No venv/home pointer to another
 // Python installation survives into the distributable Windows runtime.
 await fs.writeFile(path.join(runtime,'python311._pth'),'python311.zip\n.\nLib/site-packages\nimport site\n');
 await pipBootstrap(runtime,storage,signal);
}
async function systemVenv(runtime,signal,log){
 for(const executable of [process.env.SAS_TTS_PYTHON,'python3','python'].filter(Boolean)){
  try{await run(executable,['-c','import sys; assert (3,10)<=sys.version_info[:2]<=(3,12)'],{signal,log});await run(executable,['-m','venv','--copies',runtime],{signal,log});
   // CPython's POSIX venv still adds lib64 -> lib even with --copies. It is
   // unnecessary for this runtime; remove only that known internal alias so
   // the same strict no-symlink audit applies to the installed packages.
   const alias=path.join(runtime,'lib64'),stat=await fs.lstat(alias).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(stat?.isSymbolicLink()){const target=path.resolve(runtime,await fs.readlink(alias));if(path.relative(path.join(runtime,'lib'),target)!=='')throw new Error('Неожиданная ссылка в Python runtime Silero.');await fs.unlink(alias);}
   return;}
  catch{signal?.throwIfAborted();}
 }
 throw new Error('Для Silero требуется Python 3.10–3.12 с модулем venv.');
}
export async function installSileroRuntime(storage,device,job,{bundledRoot}={}){
 if(!['cpu','gpu'].includes(device))throw new Error('Выберите CPU или GPU для Silero.');
 const signal=job?.controller?.signal,runtime=await safeFolder(storage,'runtime','silero-'+device);signal?.throwIfAborted();
 if(validMarker(await markerAt(runtime),device)){
  await pruneSileroRuntime(runtime,{storage});
  try{await validate(runtime,device,{signal});return runtime;}catch{signal?.throwIfAborted();}
 }
 const bundle=bundledRoot?path.join(bundledRoot,'runtime','silero-'+device):null;
 if(bundle&&path.resolve(bundle)!==path.resolve(runtime)&&validMarker(await markerAt(bundle),device)){
  if(job)job.stage='Подготовка предустановленного движка Silero';
  await checkedBundle(bundle);signal?.throwIfAborted();
  const marker=await markerAt(bundle);
  await fs.cp(bundle,runtime,{recursive:true,force:true,filter:source=>!['install.log','__pycache__','sas-ready.json'].includes(path.basename(source))});
  await fs.unlink(path.join(runtime,'sas-ready.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await fs.writeFile(path.join(runtime,'sas-preparing.json'),JSON.stringify(marker,null,2));
  try{await pruneSileroRuntime(runtime,{storage});await validate(runtime,device,{signal});await fs.writeFile(path.join(runtime,'sas-ready.json'),JSON.stringify(marker,null,2));}finally{await fs.unlink(path.join(runtime,'sas-preparing.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}return runtime;
 }
 if(job)job.stage='Установка автономного движка Silero';
 const log=createWriteStream(path.join(runtime,'install.log'),{flags:'a'});
 log.write('\n'+new Date().toISOString()+' Silero '+device+'\n');
 try{
  // Remove the readiness claim before repairing an incomplete installation.
  // Files and diagnostic logs are retained so an interrupted install can retry.
  await fs.unlink(path.join(runtime,'sas-ready.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(process.platform==='win32')await portablePython(runtime,storage,signal);else await systemVenv(runtime,signal,log);
  const executable=sileroExecutable(runtime),target=process.platform==='win32'?['--target',path.join(runtime,'Lib','site-packages')]:[],pip=['-B','-m','pip','install','--disable-pip-version-check','--no-cache-dir','--no-warn-script-location','--no-compile','--only-binary=:all:','--upgrade',...target];
  if(job)job.stage='Установка CPU-зависимостей Silero';
  await run(executable,[...pip,...dependencies,'--index-url','https://pypi.org/simple'],{signal,log});
  if(job)job.stage='Установка PyTorch для Silero '+(device==='gpu'?'CUDA':'CPU');
  await run(executable,[...pip,`torch==${SILERO_TORCH_VERSION}${device==='gpu'?'+cu121':'+cpu'}`,...(device==='gpu'&&process.platform!=='win32'?[]:['--no-deps']),'--index-url',device==='gpu'?'https://download.pytorch.org/whl/cu121':'https://download.pytorch.org/whl/cpu'],{signal,log});
  await validate(runtime,device,{signal,log});
  const marker={provider:'silero',version:SILERO_RUNTIME_VERSION,device,platform:process.platform,arch:process.arch,portable:process.platform==='win32',python:process.platform==='win32'?SILERO_PYTHON_VERSION:null,torch:SILERO_TORCH_VERSION};
  await fs.writeFile(path.join(runtime,'sas-preparing.json'),JSON.stringify(marker,null,2));
  try{await pruneSileroRuntime(runtime,{storage});await validate(runtime,device,{signal,log});await fs.writeFile(path.join(runtime,'sas-ready.json'),JSON.stringify(marker,null,2));}finally{await fs.unlink(path.join(runtime,'sas-preparing.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return runtime;
 }finally{await new Promise(resolve=>log.end(resolve));}
}
