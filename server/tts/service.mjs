import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {speechSettings,speechSentences,speechText} from '../../shared/speech.mjs';
import {speechProviderEnabled} from '../../shared/speech-edition.mjs';
import {convertReference,MAX_REFERENCE_BYTES} from './audio.mjs';
import {installVoicePresets,restoreVoicePresets,presets} from './presets.mjs';
import {SpeechRuntime} from './runtime.mjs';
import {createSileroSupport,validateSilero} from './silero.mjs';
import {sileroModel} from '../../shared/silero.mjs';
import {safeFolder,downloadFile,installPythonRuntime,MAX_MODEL_BYTES,FISH_SOURCE_FOLDER} from './installer.mjs';
const catalog=JSON.parse(await fs.readFile(new URL('./catalog.json',import.meta.url),'utf8')).filter(m=>speechProviderEnabled(m.id));
const names={'kokoro-ru':'Kokoro RU','kokoro':'Kokoro-82M',xtts:'XTTS v2',fish:'Fish Speech 1.5'};
const licenses={'kokoro-ru':'OpenRAIL',kokoro:'Apache-2.0',xtts:'Coqui Public Model License',fish:'CC BY-NC-SA 4.0'};
// eSpeak supplies G2P for these packaged Kokoro voices. Japanese requires a different adapter.
const languages={'kokoro-ru':['ru'],kokoro:['en','en-gb','fr','es','it'],xtts:['ru','en','ja','fr','es','de','it','pt','pl','tr','ar','zh-cn','ko','hu','cs','nl'],fish:['ru','en','ja','zh','fr','de','es','ko']};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function validateSpeech(value){
 if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw fail('Неверные настройки озвучки.');
 const s=speechSettings(value);if(!['kokoro-ru','kokoro','silero','xtts','fish','custom','system'].includes(s.provider)||!['cpu','gpu'].includes(s.device))throw fail('Выберите движок и устройство озвучки.');
 validateSilero(s.silero);
 for(const [k,min,max] of [['volume',0,1],['pauseMs',0,2000],['maxSentenceChars',80,400],['threads',1,16],['idleSeconds',10,600]])if(!Number.isFinite(s[k])||s[k]<min||s[k]>max)throw fail('Неверный параметр озвучки: '+k);
 for(const k of ['kokoro','kokoro-ru','xtts','custom'])if(!Number.isFinite(s[k].speed)||s[k].speed<.5||s[k].speed>2)throw fail('Темп речи: 0.5–2.');
 for(const [group,fields] of [['xtts',[['temperature',.1,1.5],['topK',1,100],['topP',.1,1],['repetitionPenalty',1,10],['lengthPenalty',.1,5],['gptCondLen',3,30],['gptCondChunkLen',1,12],['maxRefLen',3,30]]],['fish',[['temperature',.1,1],['topP',.1,1],['repetitionPenalty',.9,2],['maxNewTokens',128,2048],['chunkLength',100,300],['seed',0,2147483647]]]])for(const [key,min,max] of fields)if(!Number.isFinite(s[group][key])||s[group][key]<min||s[group][key]>max)throw fail('Неверная настройка '+group+': '+key);
 if(s.xtts.gptCondChunkLen>s.xtts.gptCondLen)throw fail('Размер части образца XTTS не должен превышать общую длину.');
 for(const [group,keys] of [[s,['pauseMs','maxSentenceChars','threads','idleSeconds']],[s.xtts,['topK','gptCondLen','gptCondChunkLen','maxRefLen']],[s.fish,['maxNewTokens','chunkLength','seed']]])for(const key of keys)if(!Number.isInteger(group[key]))throw fail('Параметр озвучки должен быть целым: '+key);
 if(s.language!=='auto'&&!/^[a-z]{2}(?:-[a-z]{2})?$/.test(s.language))throw fail('Неверный язык озвучки.');
 if(!Array.isArray(s.pronunciations)||s.pronunciations.length>100||s.pronunciations.some(p=>typeof p?.from!=='string'||typeof p?.to!=='string'||p.from.length>100||p.to.length>200))throw fail('Правила произношения: до 100 замен.');
 if(!s.characterVoices||typeof s.characterVoices!=='object'||Array.isArray(s.characterVoices)||Object.keys(s.characterVoices).length>2000)throw fail('Неверный список голосов персонажей.');const assignments=[s.gmVoice,s.fanficVoice,...Object.values(s.characterVoices)];for(const a of assignments.filter(Boolean)){
  if(!['kokoro-ru','kokoro','silero','xtts','fish','system'].includes(a.provider)||typeof a.voice!=='string'||a.voice.length>100||a.referenceId&&!/^[a-f0-9-]{36}$/.test(a.referenceId)||a.language&&!/^(?:auto|[a-z]{2}(?:-[a-z]{2})?)$/.test(a.language))throw fail('Неверное назначение голоса.');
  if(a.provider==='silero'){
   const model=sileroModel(a.modelId||(a.language==='en'?s.silero.modelEn:s.silero.modelRu));
   if(!model||!model.voices.includes(a.voice)||a.language&&a.language!=='auto'&&a.language!==model.language)throw fail('Неверная модель или голос Silero в назначении.');
  }
 }return s;
}
export function createSpeechService({dataDir,getState,saveState,getModelsDir,runSpeech,installRuntime=installPythonRuntime,installSileroEngine,preparePresets=installVoicePresets,bundledRoot=process.env.SAS_SPEECH_BUNDLE_DIR||(process.resourcesPath?path.join(process.resourcesPath,'speech'):path.resolve(import.meta.dirname,'../../runtime/speech'))}={}){
 const router=express.Router(),runtime=new SpeechRuntime(),sessions=new Map(),cancelled=new Map(),cache=new Map(),jobs=new Map();let queue=Promise.resolve(),queued=0,cacheBytes=0;const benchmarks={};
 const registryPath=path.join(dataDir,'tts-models.json'),referenceDir=path.join(dataDir,'tts-references');let bootstrap,registryQueue=Promise.resolve();
 const readRegistry=()=>fs.readFile(registryPath,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
 async function writeRegistry(value){
  await fs.mkdir(dataDir,{recursive:true});const temporary=registryPath+'.'+crypto.randomUUID()+'.tmp';
  try{
   await fs.writeFile(temporary,JSON.stringify(value,null,2));
   for(let attempt=0;;attempt++){
    try{await fs.rename(temporary,registryPath);break;}
    catch(e){if(!['EPERM','EBUSY'].includes(e.code)||attempt>=6)throw e;await new Promise(resolve=>setTimeout(resolve,Math.min(400,20*2**attempt)));}
   }
  }catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
 }
 function updateRegistry(change){const next=registryQueue.then(async()=>{const value=await readRegistry();change(value);await writeRegistry(value);});registryQueue=next.catch(()=>{});return next;}
 async function root(){return path.join(await getModelsDir(),'sas-tts');}
 const silero=createSileroSupport({root,bundledRoot,readRegistry,updateRegistry,installRuntime:installSileroEngine,requireWeights:!runSpeech});
 async function prepareDefaults(){return bootstrap||=(async()=>{if(!bundledRoot)return;const registry=await readRegistry();for(const id of ['kokoro-ru','kokoro'].filter(speechProviderEnabled)){if(registry[id]?.folder&&await fs.stat(path.join(registry[id].folder,'sas-installed.json')).catch(()=>null))continue;const bundled=path.join(bundledRoot,'models',id);if(!await fs.stat(path.join(bundled,'sas-installed.json')).catch(()=>null))continue;const destination=await safeFolder(await root(),'models',id),m=catalog.find(m=>m.id===id);for(const f of m.files){const target=path.join(destination,...f.path.split('/'));await safeFolder(destination,...f.path.split('/').slice(0,-1));await fs.copyFile(path.join(bundled,...f.path.split('/')),target,1).catch(e=>{if(e.code!=='EEXIST')throw e;});}await fs.copyFile(path.join(bundled,'sas-installed.json'),path.join(destination,'sas-installed.json'));await updateRegistry(latest=>{latest[id]={...latest[id],folder:destination};});}})().catch(e=>{bootstrap=undefined;throw e;});}
 async function folder(id){await prepareDefaults();const registry=await readRegistry();return registry[id]?.folder||path.join(await root(),'models',id);}
 const publicJob=j=>({id:j.id,provider:j.provider,device:j.device,status:j.status,stage:j.stage,phase:j.phase,downloaded:j.downloaded,total:j.total,runtimeDownloaded:j.runtimeDownloaded||0,runtimeTotal:j.runtimeTotal||0,runtimeFile:j.runtimeFile||'',error:j.error||''});
 let recovered;
 async function recoverInstalls(){return recovered||=(async()=>{
  const registry=await readRegistry();if(!Object.values(registry).some(r=>r?.lastInstall?.status==='running'))return;
  await updateRegistry(latest=>{for(const entry of Object.values(latest))if(entry?.lastInstall?.status==='running'&&!jobs.has(entry.lastInstall.id))entry.lastInstall={...entry.lastInstall,status:'interrupted',error:'Установка прервана закрытием SAS. Продолжите установку движка; загруженные веса сохранены.'};});
 })().catch(error=>{recovered=undefined;throw error;});}
 function trackInstall(job,work){
  jobs.set(job.id,job);let previous='';
  const persist=(snapshot=publicJob(job))=>{const value=JSON.stringify(snapshot);if(value===previous)return Promise.resolve();return updateRegistry(registry=>{registry[job.provider]={...registry[job.provider],lastInstall:snapshot};}).then(()=>{previous=value;});};
  job.promise=(async()=>{
   const timer=setInterval(()=>{if(job.status==='running')void persist().catch(()=>{});},1500);timer.unref();
   let outcome;
   try{await persist();await work();outcome={status:'complete',phase:'complete',downloaded:job.total,stage:'Установлено'};}
   catch(error){const status=job.controller.signal.aborted?'cancelled':'error';outcome={status,error:status==='cancelled'?'Установка прервана. Загруженные веса сохранены; можно продолжить установку движка.':error.message};}
   finally{clearInterval(timer);try{await persist({...publicJob(job),...outcome});}catch(error){outcome={status:'error',error:'Не удалось сохранить установку: '+error.message};}Object.assign(job,outcome);job.controller=null;}
  })();return publicJob(job);
 }
 async function references(){await fs.mkdir(referenceDir,{recursive:true});const files=await fs.readdir(referenceDir);const result=[];for(const file of files.filter(f=>f.endsWith('.json'))){const item=JSON.parse(await fs.readFile(path.join(referenceDir,file),'utf8'));result.push({id:item.id,name:item.name,text:item.text,duration:item.duration,preset:!!item.preset,source:item.source,license:item.license});}return result;}
 async function status(){await recoverInstalls();await prepareDefaults();const registry=await readRegistry(),storage=await root(),models=[];await restoreVoicePresets(storage,referenceDir);
  for(const m of catalog){const installedFolder=registry[m.id]?.folder||path.join(storage,'models',m.id),ready=await fs.stat(path.join(installedFolder,'sas-installed.json')).catch(()=>null),voices=m.files.filter(f=>f.path.startsWith('voices/')).map(f=>path.basename(f.path,'.bin'));const runtimePaths=registry[m.id]?.runtimes||{};
   const runtimeReady={};for(const device of ['cpu','gpu']){const runtime=runtimePaths[device]||path.join(storage,'runtime',`${m.id}-${device}`);const marker=await fs.readFile(path.join(runtime,'sas-ready.json'),'utf8').then(raw=>JSON.parse(raw)).catch(()=>null);runtimeReady[device]=marker?.version===4&&marker.provider===m.id&&marker.device===device&&!!await fs.stat(path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python')).catch(()=>null);}
   models.push({id:m.id,name:names[m.id],bytes:m.bytes,license:licenses[m.id],source:`https://huggingface.co/${m.repo}`,installed:!!ready,path:ready?installedFolder:'',voices:m.id==='xtts'||m.id==='fish'?['female','male']:voices,languages:languages[m.id],runtimes:runtimePaths,runtimeReady,lastInstall:registry[m.id]?.lastInstall});}
  const sileroStatus=await silero.status();models.push(sileroStatus.model);
  return {models,sileroModels:sileroStatus.variants,jobs:[...jobs.values()].map(publicJob),references:await references(),modelsDir:await getModelsDir(),settings:speechSettings(getState().settings.speech),hardware:{cpu:os.cpus()[0]?.model||'CPU',cores:os.availableParallelism()},activeSessions:sessions.size,benchmarks};
 }
 async function install(provider,device='cpu',{runtimeOnly=false,modelId}={}){
  await recoverInstalls();
  if(provider==='silero'){
   if(!['cpu','gpu'].includes(device)||modelId&&!sileroModel(modelId))throw fail('Выберите устройство и модель Silero.');
   if([...jobs.values()].some(j=>j.status==='running'))throw fail('Дождитесь текущей установки.',409);
   const job={id:crypto.randomUUID(),provider,device,modelId,status:'running',phase:runtimeOnly?'runtime':'weights',stage:'Подготовка Silero',downloaded:0,total:0,controller:new AbortController()};
   return trackInstall(job,()=>silero.install(device,job,{modelId,runtimeOnly}));
  }
  const m=catalog.find(m=>m.id===provider);if(!m)throw fail('Неизвестная модель озвучки.');if(!['cpu','gpu'].includes(device))throw fail('Неизвестное устройство.');if(m.bytes>MAX_MODEL_BYTES)throw fail('Модель превышает 2 ГБ.');if([...jobs.values()].some(j=>j.status==='running'))throw fail('Дождитесь текущей установки.',409);
  if(runtimeOnly&&!['xtts','fish'].includes(provider))throw fail('Для этого движка отдельная установка не нужна.');const storage=await root(),destination=runtimeOnly?null:await safeFolder(storage,'models',provider),job={id:crypto.randomUUID(),provider,device,status:'running',phase:runtimeOnly?'runtime':'weights',stage:runtimeOnly?'Установка движка':'Загрузка модели',downloaded:0,total:runtimeOnly?0:m.bytes,controller:new AbortController()};
  return trackInstall(job,async()=>{if(!runtimeOnly){for(const file of m.files){job.stage='Загрузка '+file.path;const destinationFile=path.join(destination,...file.path.split('/'));await safeFolder(destination,...file.path.split('/').slice(0,-1));await downloadFile(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${file.path}`,destinationFile,{...file,sha256:file.sha256,signal:job.controller.signal,onBytes:n=>job.downloaded+=n});}
   await fs.writeFile(path.join(destination,'sas-installed.json'),JSON.stringify({provider,revision:m.revision,bytes:m.bytes}));await updateRegistry(registry=>{registry[provider]={...registry[provider],folder:destination};});}
   job.phase='runtime';
   const runtimePath=['xtts','fish'].includes(provider)?await installRuntime(storage,provider,device,job):null;
   if(runtimePath){job.phase='presets';job.stage='Подготовка мужского и женского голосов';await preparePresets(storage,referenceDir,runtimePath,job.controller.signal);}
   await updateRegistry(registry=>{registry[provider]={...registry[provider],...(destination?{folder:destination}:{}),...(provider==='fish'&&runtimePath?{source:path.join(storage,'fish-source',FISH_SOURCE_FOLDER)}:{}),runtimes:{...registry[provider]?.runtimes,...(runtimePath?{[device]:runtimePath}:{})}};});
  });
 }
 async function requestFor(settings,text,signal){
  if(settings.provider==='silero')return silero.request(settings,text,signal);
  const language=settings.language==='auto'?(/[А-Яа-яЁё]/u.test(text)?'ru':'en'):settings.language;let provider=settings.provider;if(settings.language==='auto'){if(provider==='kokoro-ru'&&language!=='ru')provider='kokoro';else if(provider==='kokoro'&&language==='ru')provider='kokoro-ru';}
  const options=settings[provider==='custom'?'custom':provider]||{};let actualProvider=provider,modelFolder=await folder(provider),registry=await readRegistry();
  if(provider==='custom'){actualProvider=settings.customAdapter;if(actualProvider==='endpoint'){return {endpoint:settings.endpoint,text,language,options,provider:'endpoint'};}if(!['kokoro','kokoro-ru','xtts','fish'].includes(actualProvider))throw fail('Выберите формат сторонней модели.');if(!registry.custom||registry.custom.folder!==settings.customPath||registry.custom.adapter!==actualProvider)throw fail('Сначала подключите папку сторонней модели.');modelFolder=registry.custom.folder;}
  if(!languages[actualProvider]?.includes(language))throw fail('Этот движок не поддерживает выбранный язык: '+language);
  const allowed=catalog.find(m=>m.id===actualProvider)?.files.filter(f=>f.path.startsWith('voices/')).map(f=>path.basename(f.path,'.bin'))||[];
  const voice=String(options.voice||'');if(['kokoro','kokoro-ru'].includes(actualProvider)&&(!/^[a-z_]+$/.test(voice)||provider!=='custom'&&!allowed.includes(voice)))throw fail('Выберите установленный голос.');
  const ownOptions=provider==='custom'?{...settings[actualProvider],...options}:options;
  let referencePath='',referenceText='';if(ownOptions.referenceId){if(!/^[a-f0-9-]{36}$/.test(ownOptions.referenceId))throw fail('Неверный образец голоса.');const ref=JSON.parse(await fs.readFile(path.join(referenceDir,ownOptions.referenceId+'.json'),'utf8'));referencePath=path.join(referenceDir,ref.id+'.wav');referenceText=ref.text;}
  if(actualProvider==='fish'&&!referencePath){await restoreVoicePresets(await root(),referenceDir);const preset=presets.find(p=>p.gender===(ownOptions.voice==='male'?'male':'female'));referencePath=path.join(referenceDir,preset.id+'.wav');referenceText=preset.text;await fs.access(referencePath).catch(()=>{throw fail('Установите голосовые пресеты: нажмите «Установить движок» в расширении «Голоса персонажа».');});}
  const runtimePath=registry[provider]?.runtimes?.[settings.device]||registry[actualProvider]?.runtimes?.[settings.device]||path.join(await root(),'runtime',`${actualProvider}-${settings.device}`),storage=await root();
  return {provider:actualProvider,folder:modelFolder,device:settings.device,text,language:language==='en'?'en-us':language,voice,speed:ownOptions.speed||1,options:ownOptions,threads:settings.threads,idleSeconds:settings.idleSeconds,runtime:runtimePath,source:registry[provider]?.source||registry[actualProvider]?.source||path.join(storage,'fish-source',FISH_SOURCE_FOLDER),referencePath,referenceText};
 }
 async function synthesize(settings,text,signal){
  text=speechText(text,settings.pronunciations);
  const request=await requestFor(settings,text,signal);if(['xtts','fish'].includes(request.provider)&&request.language==='en-us')request.language='en';
  const key=crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');if(cache.has(key)){const item=cache.get(key);cache.delete(key);cache.set(key,item);return item;}
  const started=performance.now();let result;
  if(runSpeech)result=await runSpeech(request,signal);
  else if(request.provider==='endpoint'){
   const url=new URL(request.endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('Неверный URL сервера озвучки.');const response=await fetch(new URL('/v1/audio/speech',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:text,model:request.options.model||'tts',voice:request.options.voice,speed:request.options.speed,response_format:'wav'}),signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});if(!response.ok)throw fail('Сервер озвучки: HTTP '+response.status,502);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>10_000_000||bytes.subarray(0,4).toString()!=='RIFF')throw fail('Сервер должен вернуть WAV.',502);result={audio:bytes.toString('base64'),duration:0};
  }else result=await runtime.request(request,signal);
  if(result.duration){const previous=benchmarks[request.provider+'-'+settings.device],seconds=(performance.now()-started)/1000;benchmarks[request.provider+'-'+settings.device]={samples:(previous?.samples||0)+1,rtf:seconds/result.duration,seconds,audioSeconds:result.duration};}
  if(!result.audio||result.audio.length>15_000_000)throw fail('Некорректное аудио от модели.',502);cache.set(key,result);cacheBytes+=result.audio.length;while(cacheBytes>16_000_000&&cache.size){const first=cache.keys().next().value;cacheBytes-=cache.get(first).audio.length;cache.delete(first);}return result;
 }
 const route=handler=>async(req,res,next)=>{try{await handler(req,res);}catch(e){next(e);}};
 router.get('/status',route(async(req,res)=>res.json(await status())));
 router.post('/install',route(async(req,res)=>res.status(202).json(await install(req.body?.provider,req.body?.device||'cpu',{runtimeOnly:req.body?.runtimeOnly===true,modelId:req.body?.modelId}))));
 router.post('/install/:id/cancel',route(async(req,res)=>{const job=jobs.get(req.params.id);job?.controller?.abort();await job?.promise;res.json({ok:true});}));
 router.post('/import',route(async(req,res)=>{const requested=req.body?.path,adapter=req.body?.adapter;if(typeof requested!=='string'||!path.isAbsolute(requested)||!catalog.some(m=>m.id===adapter))throw fail('Укажите папку и поддерживаемый формат модели.');const real=await fs.realpath(requested);let total=0;async function scan(dir,depth=0){if(depth>6)throw fail('Слишком вложенная папка.');for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('Папка модели содержит ссылку.');const file=path.join(dir,entry.name);if(entry.isDirectory())await scan(file,depth+1);else if(/\.(onnx|pth|safetensors|bin)$/i.test(entry.name))total+=(await fs.stat(file)).size;if(total>MAX_MODEL_BYTES)throw fail('Модель превышает 2 ГБ.');}}await scan(real);if(adapter.startsWith('kokoro')){if(!await fs.stat(path.join(real,'onnx/model_quantized.onnx')).catch(()=>null)&&!await fs.stat(path.join(real,'onnx/model.onnx')).catch(()=>null))throw fail('Нет ONNX-весов Kokoro.');await fs.access(path.join(real,adapter==='kokoro-ru'?'config.json':'tokenizer.json'));if(!(await fs.readdir(path.join(real,'voices'))).some(f=>f.endsWith('.bin')))throw fail('Нет файлов голосов Kokoro.');}else for(const file of adapter==='xtts'?['model.pth','config.json','vocab.json']:['model.pth','config.json','firefly-gan-vq-fsq-8x1024-21hz-generator.pth'])await fs.access(path.join(real,file));await updateRegistry(registry=>{registry.custom={folder:real,adapter};});const state=getState();state.settings.speech={...speechSettings(state.settings.speech),customPath:real,customAdapter:adapter};saveState(state);res.json({path:real,bytes:total});}));
 router.get('/install/log/:provider/:device',route(async(req,res)=>{const {provider,device}=req.params;if(!['xtts','fish','silero'].includes(provider)||!['cpu','gpu'].includes(device))throw fail('Неизвестный движок.');const log=await fs.readFile(path.join(await root(),'runtime',`${provider}-${device}`,'install.log'),'utf8').catch(e=>{if(e.code==='ENOENT')return 'Журнал установки пока отсутствует.';throw e;});res.json({log:log.slice(-20000)});}));
 router.get('/references/:id/audio',route(async(req,res)=>{if(!/^[a-f0-9-]{36}$/.test(req.params.id))throw fail('Неверный голос.');const bytes=await fs.readFile(path.join(referenceDir,req.params.id+'.wav')).catch(e=>{if(e.code==='ENOENT')throw fail('Голос не найден.',404);throw e;});res.type('audio/wav').send(bytes);}));
 router.patch('/references/:id',route(async(req,res)=>{if(!/^[a-f0-9-]{36}$/.test(req.params.id)||typeof req.body?.name!=='string'||!req.body.name.trim()||req.body.name.length>80)throw fail('Укажите название голоса до 80 символов.');const file=path.join(referenceDir,req.params.id+'.json'),ref=JSON.parse(await fs.readFile(file,'utf8'));if(ref.preset)throw fail('Название пресета задано разработчиком.');ref.name=req.body.name.trim();await fs.writeFile(file,JSON.stringify(ref,null,2));res.json(ref);}));
 router.post('/references',route(async(req,res)=>{const {name,text,audio}=req.body||{};if(typeof audio!=='string'||audio.length>Math.ceil(MAX_REFERENCE_BYTES*4/3)+4||typeof text!=='string'||text.length>2000||!text.trim())throw fail('Загрузите аудио 3–30 секунд и его точную расшифровку.');const registry=await readRegistry(),runtimes=Object.values(registry).flatMap(m=>Object.values(m.runtimes||{})),converted=await convertReference(Buffer.from(audio,'base64'),{runtimes}),id=crypto.randomUUID(),item={id,name:String(name||'Мой голос').slice(0,80),text:text.trim(),duration:converted.duration};await fs.mkdir(referenceDir,{recursive:true});await fs.writeFile(path.join(referenceDir,id+'.wav'),converted.bytes);await fs.writeFile(path.join(referenceDir,id+'.json'),JSON.stringify(item));res.json(item);}));
 router.delete('/references/:id',route(async(req,res)=>{if(!/^[a-f0-9-]{36}$/.test(req.params.id))throw fail('Неверный образец.');const ref=JSON.parse(await fs.readFile(path.join(referenceDir,req.params.id+'.json'),'utf8').catch(()=>'null'));if(ref?.preset)throw fail('Это предустановленный голос.');for(const suffix of ['.wav','.json'])await fs.unlink(path.join(referenceDir,req.params.id+suffix)).catch(()=>{});const state=getState(),s=speechSettings(state.settings.speech);for(const group of ['xtts','fish','custom'])if(s[group].referenceId===req.params.id)s[group].referenceId='';for(const key of ['gmVoice','fanficVoice'])if(s[key]?.referenceId===req.params.id)s[key]=null;for(const [key,v] of Object.entries(s.characterVoices))if(v.referenceId===req.params.id)delete s.characterVoices[key];state.settings.speech=s;saveState(state);res.json({ok:true});}));
 router.post('/sessions',route(async(req,res)=>{const text=req.body?.text;if(typeof text!=='string'||!text.trim()||text.length>1_000_000)throw fail('Текст озвучки: 1–1 000 000 символов.');if(sessions.size>=4)throw fail('Слишком много озвучиваний. Остановите предыдущее.',429);const settings=validateSpeech(req.body?.settings||getState().settings.speech);if(settings.provider==='system')throw fail('Системная озвучка выполняется браузером.');const actual=settings.provider==='custom'?settings.customAdapter:settings.provider,lang=settings.language==='auto'?(/[А-Яа-яЁё]/u.test(text)?'ru':'en'):settings.language,xttsLimits={en:240,ru:160,ja:60,ko:80,'zh-cn':80,ar:150,cs:170,tr:200,nl:240,hu:200},limit=actual==='xtts'?Math.min(settings.maxSentenceChars,xttsLimits[lang]||200):actual==='fish'?Math.min(settings.maxSentenceChars,160):settings.maxSentenceChars,prepared=speechText(text,settings.pronunciations),sentences=speechSentences(prepared,limit,lang);settings.pronunciations=[];if(!sentences.length)throw fail('Нет текста для озвучивания.');const id=req.body?.id||crypto.randomUUID();if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(id))throw fail('Неверный ID озвучки.');if(sessions.has(id))throw fail('Озвучка уже существует.',409);if((cancelled.get(id)||0)>Date.now())throw fail('Озвучка остановлена.',410);const controller=new AbortController();sessions.set(id,{settings,sentences,controller,created:Date.now(),last:Date.now(),inflight:new Map()});res.json({id,count:sentences.length});}));
 router.get('/sessions/:id/:index',route(async(req,res)=>{const session=sessions.get(req.params.id),index=Number(req.params.index);if(!session||!Number.isInteger(index)||index<0||index>=session.sentences.length)throw fail('Фраза не найдена.',404);session.last=Date.now();if(queued>=8)throw fail('Очередь озвучки заполнена.',429);
  if(!session.inflight.has(index)){queued++;const promise=queue.then(()=>{session.controller.signal.throwIfAborted();return synthesize(session.settings,session.sentences[index],session.controller.signal);});queue=promise.catch(()=>{});session.inflight.set(index,promise);promise.finally(()=>{queued--;session.inflight.delete(index);}).catch(()=>{});}
  const result=await session.inflight.get(index);if(!sessions.has(req.params.id))throw fail('Озвучка остановлена.',410);res.type('audio/wav').set('X-SAS-Audio-Duration',String(result.duration||0)).send(Buffer.from(result.audio,'base64'));}));
 router.delete('/sessions/:id',(req,res)=>{if(!/^[a-zA-Z0-9_-]{16,80}$/.test(req.params.id))return res.status(400).json({error:'Неверный ID озвучки.'});const session=sessions.get(req.params.id);session?.controller.abort();sessions.delete(req.params.id);cancelled.set(req.params.id,Date.now()+60000);while(cancelled.size>256)cancelled.delete(cancelled.keys().next().value);res.json({ok:true});});
 const timer=setInterval(()=>{for(const [id,s] of sessions)if(Date.now()-s.last>600000){s.controller.abort();sessions.delete(id);}},60000);timer.unref();
 return {router,status,install,synthesize,isInstalling:()=>[...jobs.values()].some(job=>job.status==='running'),close:async()=>{clearInterval(timer);for(const s of sessions.values())s.controller.abort();sessions.clear();for(const j of jobs.values())j.controller?.abort();await Promise.all([...jobs.values()].map(j=>j.promise));runtime.close();cache.clear();}};
}
