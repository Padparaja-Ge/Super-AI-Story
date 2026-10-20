import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {sileroModels,sileroModel} from '../../shared/silero.mjs';
import {downloadFile,safeFolder} from './installer.mjs';
import {installSileroRuntime,sileroExecutable,sileroRuntimeCompatible} from './silero-engine.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function downloadSileroModel(model,destination,{signal,onBytes=()=>{}}={}){
 const file=model?.file;
 if(!file||!Number.isInteger(file.size)||file.size<=0||file.size>100_000_000||model.bytes!==file.size||!/^[a-f0-9]{64}$/.test(file.sha256||'')||path.basename(file.path||'')!==file.path||!file.path.endsWith('.pt')||path.basename(destination)!==file.path)throw fail('Неверные метаданные модели Silero.');
 const urls=[...new Set([...(file.mirrors||[]),file.url])];if(!urls.length||urls.some(url=>!/^https?:\/\//.test(url)))throw fail('Неверный источник модели Silero.');
 signal?.throwIfAborted();
 const previous=await fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(previous){
  if(!previous.isFile()||previous.isSymbolicLink())throw fail('Файл Silero не должен быть ссылкой или папкой.');
  const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(destination)){signal?.throwIfAborted();hash.update(chunk);}
  if(previous.size===file.size&&hash.digest('hex')===file.sha256){onBytes(previous.size);return;}
  // Retain the exact damaged file so a repair never destroys user data.
  await fs.rename(destination,destination+'.corrupt-'+crypto.randomUUID());
 }
 const partial=destination+'.sas-part',leftover=await fs.lstat(partial).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(leftover){if(!leftover.isFile()||leftover.isSymbolicLink())throw fail('Неверный временный файл Silero.');await fs.rename(partial,partial+'.abandoned-'+crypto.randomUUID());}
 let lastError;
 for(const url of urls){
  signal?.throwIfAborted();let attemptBytes=0;
  try{await downloadFile(url,destination,{size:file.size,sha256:file.sha256,signal,onBytes:n=>{attemptBytes+=n;onBytes(n);}});return;}
  catch(e){if(attemptBytes)onBytes(-attemptBytes);signal?.throwIfAborted();lastError=e;}
 }
 throw lastError||fail('Не удалось загрузить модель Silero.',502);
}
export function validateSilero(s){
 for(const [key,language] of [['modelRu','ru'],['modelEn','en']])if(sileroModel(s[key])?.language!==language)throw fail('Выберите модель Silero для '+language+'.');
 for(const [modelKey,voiceKey] of [['modelRu','voice'],['modelEn','englishVoice']])if(!sileroModel(s[modelKey]).voices.includes(s[voiceKey]))throw fail('Этот голос недоступен в выбранной модели Silero.');
 if(![8000,24000,48000].includes(s.sampleRate)||!['modelRu','modelEn'].every(key=>sileroModel(s[key]).sampleRates.includes(s.sampleRate)))throw fail('Выберите частоту, поддерживаемую моделями Silero.');
 if(typeof s.putAccent!=='boolean'||typeof s.putYo!=='boolean'||s.speed!==1)throw fail('Неверные параметры Silero. Используется естественный темп речи.');
 return s;
}

export function createSileroSupport({root,bundledRoot,readRegistry,updateRegistry,installRuntime=installSileroRuntime,requireWeights=true}){
 const bootstraps=new Map(),verified=new Map();
 const modelFolder=async()=>path.join(await root(),'models','silero');
 const markerPath=(folder,m)=>path.join(folder,m.id+'.sas-installed.json');
 async function marker(file){return fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;});}
 async function installed(folder,m){const info=await fs.stat(path.join(folder,m.file.path)).catch(()=>null),record=await marker(markerPath(folder,m));return !!info&&info.size===m.bytes&&record?.sha256===m.file.sha256;}
 async function verify(file,m){
  const info=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')throw fail('Модель Silero не установлена: '+m.id+'.',409);throw e;});
  if(!info.isFile()||info.isSymbolicLink()||info.size!==m.bytes)throw fail('Повреждён файл Silero: '+m.id+'. Переустановите модель.',409);
  const identity=[info.size,info.mtimeMs,info.ctimeMs].join(':'),cached=verified.get(file);if(cached===identity)return;
  const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==m.file.sha256)throw fail('Контрольная сумма Silero не совпала: '+m.id+'.',409);
  if(verified.size>=32)verified.clear();verified.set(file,identity);
 }
 async function prepareDefaults(){
  const storage=await root();if(!bundledRoot)return;
  if(bootstraps.has(storage))return bootstraps.get(storage);
  const promise=(async()=>{
   const destination=await safeFolder(storage,'models','silero');let copied=false;
   for(const m of sileroModels.filter(m=>m.bundled)){
    if(await installed(destination,m))continue;
    const bundled=path.join(bundledRoot,'models','silero',m.file.path);
    if(!await fs.stat(bundled).catch(()=>null))continue;
    await verify(bundled,m);
    const target=path.join(destination,m.file.path);
    if(!await fs.stat(target).catch(()=>null)){const temporary=target+'.bundled-part';await fs.copyFile(bundled,temporary);await fs.rename(temporary,target);}
    await verify(target,m);
    await fs.writeFile(markerPath(destination,m),JSON.stringify({id:m.id,size:m.bytes,sha256:m.file.sha256,revision:m.revision}));copied=true;
   }
   const bundleRuntime=await marker(path.join(bundledRoot,'runtime','silero-cpu','sas-ready.json'));
   if(sileroRuntimeCompatible(bundleRuntime,'cpu')){
    const runtime=await installRuntime(storage,'cpu',{controller:new AbortController(),stage:''},{bundledRoot});
    await updateRegistry(registry=>{registry.silero={...registry.silero,folder:destination,runtimes:{...registry.silero?.runtimes,cpu:runtime}};});
   }else if(copied)await updateRegistry(registry=>{registry.silero={...registry.silero,folder:destination};});
  })();bootstraps.set(storage,promise);promise.catch(()=>bootstraps.delete(storage));return promise;
 }
 async function status(){
  await prepareDefaults();const storage=await root(),folder=await modelFolder(),registry=await readRegistry(),variants=[];
  for(const m of sileroModels){const ready=await installed(folder,m);variants.push({...m,installed:ready,path:ready?path.join(folder,m.file.path):''});}
  const runtimeReady={},runtimes={};for(const device of ['cpu','gpu']){
   const location=path.join(storage,'runtime','silero-'+device),record=await marker(path.join(location,'sas-ready.json'));
   runtimeReady[device]=sileroRuntimeCompatible(record,device)&&!!await fs.stat(sileroExecutable(location)).catch(()=>null);runtimes[device]=location;
  }
  const defaults=variants.filter(m=>m.bundled);
  return {variants,model:{id:'silero',name:'Silero TTS',bytes:defaults.reduce((n,m)=>n+m.bytes,0),license:'CC BY-NC-SA 4.0',source:'https://github.com/snakers4/silero-models',installed:defaults.length>0&&defaults.every(m=>m.installed),path:folder,voices:[...new Set(defaults.flatMap(m=>m.voices))],languages:['ru','en'],runtimes,runtimeReady,lastInstall:registry.silero?.lastInstall}};
 }
 async function install(device,job,{modelId,runtimeOnly=false}={}){
  if(!['cpu','gpu'].includes(device))throw fail('Выберите CPU или GPU для Silero.');
  if(modelId&&!sileroModel(modelId))throw fail('Неизвестная модель Silero.');
  const chosen=runtimeOnly?[]:modelId?[sileroModel(modelId)]:sileroModels.filter(m=>m.bundled),storage=await root(),folder=await safeFolder(storage,'models','silero');
  job.total=chosen.reduce((n,m)=>n+m.bytes,0);
  for(const m of chosen){
   job.stage='Загрузка Silero '+m.id;
   await downloadSileroModel(m,path.join(folder,m.file.path),{signal:job.controller.signal,onBytes:n=>job.downloaded+=n});
   await fs.writeFile(markerPath(folder,m),JSON.stringify({id:m.id,size:m.bytes,sha256:m.file.sha256,revision:m.revision}));
  }
  const runtime=await installRuntime(storage,device,job,{bundledRoot});
  await updateRegistry(registry=>{registry.silero={...registry.silero,folder,runtimes:{...registry.silero?.runtimes,[device]:runtime}};});
 }
 async function request(settings,text,signal){
  signal?.throwIfAborted();validateSilero(settings.silero);
  const detected=settings.language==='auto'?(/[А-Яа-яЁё]/u.test(text)?'ru':'en'):settings.language;
  const language=detected==='ru'?'ru':/^en(?:-|$)/.test(detected)||detected==='eng'?'en':null;
  if(!language)throw fail('Silero поддерживает русский и английский языки.');
  const options={...settings.silero},m=sileroModel(language==='ru'?options.modelRu:options.modelEn),voice=language==='ru'?options.voice:options.englishVoice;
  if(!m.voices.includes(voice)||!m.sampleRates.includes(options.sampleRate))throw fail('Голос или частота недоступны в этой модели Silero.');
  await prepareDefaults();const folder=await modelFolder(),file=path.join(folder,m.file.path),runtime=path.join(await root(),'runtime','silero-'+settings.device);
  if(requireWeights){const ready=await marker(path.join(runtime,'sas-ready.json')),unavailable=()=>fail('Установите движок Silero для выбранного устройства в «Голоса персонажа».',409);if(ready&&!sileroRuntimeCompatible(ready,settings.device))throw unavailable();await verify(file,m);if(!sileroRuntimeCompatible(ready,settings.device)||!await fs.stat(sileroExecutable(runtime)).catch(()=>null))throw unavailable();}
  signal?.throwIfAborted();return {provider:'silero',folder,modelFile:file,modelId:m.id,device:settings.device,text,language,voice,options,threads:settings.threads,idleSeconds:settings.idleSeconds,runtime};
 }
 return {status,install,request,prepareDefaults};
}
