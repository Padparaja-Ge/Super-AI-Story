import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {run,safeFolder} from '../server/tts/installer.mjs';
import {installSileroRuntime,sileroExecutable,pruneSileroRuntime,sileroRuntimeDevelopmentFile} from '../server/tts/silero-engine.mjs';
import {downloadSileroModel} from '../server/tts/silero.mjs';
import {sileroModels} from '../shared/silero.mjs';

const projectRoot=path.resolve(import.meta.dirname,'..');
const defaultDataDir=path.resolve(process.env.SAS_DATA_DIR||(process.platform==='win32'&&process.env.APPDATA?path.join(process.env.APPDATA,'Super AI Story','data'):path.join(projectRoot,'data')));
async function modelsDirectory(dataDir,override){
 if(override){if(!path.isAbsolute(override))throw new Error('Папка моделей должна быть абсолютной.');return path.resolve(override);}
 const config=await fs.readFile(path.join(dataDir,'model-storage.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(config?.modelsDir){if(!path.isAbsolute(config.modelsDir))throw new Error('В model-storage.json указан относительный путь моделей.');return path.resolve(config.modelsDir);}
 return path.join(dataDir,'models');
}
async function verifiedCopy(source,destination,file){
 const info=await fs.stat(source);if(info.size!==file.size)throw new Error('Неверный размер модели Silero: '+file.path);
 const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(source))hash.update(chunk);
 if(hash.digest('hex')!==file.sha256)throw new Error('Контрольная сумма модели Silero не совпала: '+file.path);
 await fs.mkdir(path.dirname(destination),{recursive:true});if(path.resolve(source)!==path.resolve(destination))await fs.copyFile(source,destination);
}
async function noLinks(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('В автономном движке Silero обнаружена ссылка.');if(entry.isDirectory())await noLinks(path.join(folder,entry.name));}}
export async function prepareSilero({modelsDir:override,dataDir=defaultDataDir,bundleRoot=path.join(projectRoot,'runtime','speech'),modelsOnly=false}={}){
 const modelsDir=await modelsDirectory(dataDir,override||process.env.SAS_MODELS_DIR),storage=await safeFolder(modelsDir,'sas-tts'),modelRoot=await safeFolder(storage,'models','silero'),bundledModels=await safeFolder(bundleRoot,'models','silero');
 for(const model of sileroModels.filter(model=>model.bundled)){
  if(model.file.size>100_000_000)throw new Error('Предустановленная модель Silero превышает лимит 100 МБ.');
  const source=path.join(modelRoot,model.file.path);console.log('Silero '+model.id+': проверка/загрузка весов');
  // Share the runtime installer's exact hash checks, pinned mirror fallback,
  // and non-destructive quarantine when an existing package is damaged.
  await downloadSileroModel(model,source);
  await verifiedCopy(source,path.join(bundledModels,model.file.path),model.file);
  const marker=JSON.stringify({id:model.id,size:model.file.size,sha256:model.file.sha256,revision:model.revision},null,2);
  await fs.writeFile(path.join(modelRoot,model.id+'.sas-installed.json'),marker);
  await fs.writeFile(path.join(bundledModels,model.id+'.sas-installed.json'),marker);
  console.log('Silero '+model.id+': SHA-256 проверен');
 }
 if(!modelsOnly){
  const job={controller:new AbortController(),stage:''};let previous='';
  const timer=setInterval(()=>{if(job.stage&&job.stage!==previous){console.log('Silero: '+job.stage);previous=job.stage;}},1000);timer.unref();
  try{
   const runtime=await installSileroRuntime(storage,'cpu',job,{bundledRoot:null}),target=await safeFolder(bundleRoot,'runtime','silero-cpu');
   await noLinks(runtime);
   const marker=await fs.readFile(path.join(runtime,'sas-ready.json'),'utf8');
   if(path.resolve(runtime)!==path.resolve(target)){
    await fs.unlink(path.join(target,'sas-ready.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.cp(runtime,target,{recursive:true,force:true,filter:source=>!['install.log','__pycache__','sas-ready.json','sas-preparing.json'].includes(path.basename(source))&&!sileroRuntimeDevelopmentFile(path.relative(runtime,source))});
   }
   await fs.writeFile(path.join(target,'sas-preparing.json'),marker);
   try{
    await pruneSileroRuntime(target,{storage:bundleRoot});
    await run(sileroExecutable(target),['-I','-B','-c',"import torch,numpy; assert torch.__version__.split('+')[0]=='2.5.1'; assert numpy.__version__=='1.26.4'; print('SAS_SILERO_PORTABLE_READY')"]);
    await fs.writeFile(path.join(target,'sas-ready.json'),marker);
   }finally{await fs.unlink(path.join(target,'sas-preparing.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
   console.log('Silero: автономный CPU-движок проверен после переноса');
  }finally{clearInterval(timer);}
 }
 return {modelsDir,storage,bundleRoot,models:sileroModels.filter(model=>model.bundled).map(model=>model.id)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=key=>{const at=args.indexOf(key);return at>=0?args[at+1]:undefined;};
 await prepareSilero({modelsDir:option('--models-dir'),dataDir:option('--data-dir')||defaultDataDir,bundleRoot:option('--bundle-root')||path.join(projectRoot,'runtime','speech'),modelsOnly:args.includes('--models-only')});
}
