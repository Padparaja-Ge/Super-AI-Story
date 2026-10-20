import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const projectRoot=path.resolve(import.meta.dirname,'..');
const digest=value=>createHash('sha256').update(value).digest('hex');

export function windowsVersion(value){
  const match=String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!match||match.slice(1).some(part=>Number(part)>65535))throw new Error('SAS version cannot be represented in Windows executable resources.');
  return match.slice(1).concat('0').join('.');
}

function run(executable,args,options={}){
  return new Promise((resolve,reject)=>{const child=spawn(executable,args,{stdio:'inherit',windowsHide:true,...options});child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`SAS desktop process failed (${signal||code}).`)));});
}

export async function prepareDesktopRuntime({root=projectRoot,platform=process.platform}={}){
  const executable=require('electron');
  if(platform!=='win32')return {executable,branded:false};
  const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const icon=path.join(root,'assets','sas.ico'),source=path.dirname(executable),sourceStat=await fs.stat(executable);
  const electronVersion=JSON.parse(await fs.readFile(require.resolve('electron/package.json'),'utf8')).version;
  const fingerprint=digest(JSON.stringify({electronVersion,appVersion:metadata.version,icon:digest(await fs.readFile(icon)),size:sourceStat.size,mtime:sourceStat.mtimeMs,format:1})).slice(0,20);
  const cache=path.join(root,'runtime','desktop-shell'),destination=path.join(cache,`${electronVersion}-${fingerprint}`),target=path.join(destination,'Super AI Story.exe');
  const ready=async()=>{try{const manifest=JSON.parse(await fs.readFile(path.join(destination,'.sas-runtime.json'),'utf8'));return manifest.fingerprint===fingerprint&&(await fs.stat(target)).size>sourceStat.size*.9;}catch{return false;}};
  if(await ready())return {executable:target,branded:true,fingerprint,cached:true};
  const editor=require.resolve('electron-winstaller/vendor/rcedit.exe');
  const temporary=path.join(cache,`.preparing-${randomUUID()}`);
  await fs.mkdir(cache,{recursive:true});
  // Copy the runtime. Never alter npm's Electron executable: its signature and
  // other projects using it must remain untouched.
  await fs.cp(source,temporary,{recursive:true,errorOnExist:true,force:false});
  const stagedExecutable=path.join(temporary,'Super AI Story.exe');
  await fs.rename(path.join(temporary,'electron.exe'),stagedExecutable);
  const resourceVersion=windowsVersion(metadata.version);
  await run(editor,[stagedExecutable,'--set-icon',icon,'--set-file-version',resourceVersion,'--set-product-version',resourceVersion,
    '--set-version-string','FileDescription','SAS · Super AI Story',
    '--set-version-string','ProductName','Super AI Story',
    '--set-version-string','InternalName','Super AI Story',
    '--set-version-string','OriginalFilename','Super AI Story.exe',
    '--set-version-string','CompanyName','Padparaja-Ge and Wenzeslaus-first',
    '--set-version-string','LegalCopyright','Copyright 2026 Padparaja. Apache-2.0.']);
  await fs.writeFile(path.join(temporary,'.sas-runtime.json'),JSON.stringify({fingerprint,electronVersion,appVersion:metadata.version,createdAt:new Date().toISOString()}));
  try{await fs.rename(temporary,destination);}catch(error){if(!(await ready()))throw error;}
  // Concurrent first launches may leave a harmless staged copy. It is never
  // launched; cleaning old runtime caches is a separate explicit operation.
  return {executable:target,branded:true,fingerprint,cached:false};
}

export async function launchDesktop(args=process.argv.slice(2)){
  const runtime=await prepareDesktopRuntime();
  if(args.includes('--prepare-only')){console.log(JSON.stringify(runtime));return;}
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  // SW_HIDE also suppresses Electron's first BrowserWindow on Windows.
  // Hide command-line helpers, but let the application show its own window.
  await run(runtime.executable,[projectRoot,...args],{cwd:projectRoot,env,windowsHide:false});
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  launchDesktop().catch(error=>{console.error('Не удалось запустить SAS:',error.message);console.error('Проверьте зависимости: npm ci --include=dev. Для собранной версии запускайте Super AI Story.exe.');process.exitCode=1;});
}
