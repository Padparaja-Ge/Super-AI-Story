import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {createSpeechService,validateSpeech} from '../server/tts/service.mjs';
import {speechFor,speechSettings} from '../shared/speech.mjs';

function wav(){const b=Buffer.alloc(44+480);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
async function fixture(t,{realInference=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-silero-service-')),state={settings:{speech:speechSettings({provider:'silero'})},chats:[{id:'rp',summary:'PRIVATE_RP'}],multiplayer:{id:'room',summary:'PRIVATE_DND'},fanficProjects:[{id:'fanfic',memory:'PRIVATE_FANFIC'}]},calls=[];let modelsDir=path.join(dir,'chosen-hf-folder');
 const service=createSpeechService({dataDir:dir,getState:()=>structuredClone(state),saveState:next=>Object.assign(state,structuredClone(next)),getModelsDir:async()=>modelsDir,bundledRoot:null,...(realInference?{}:{runSpeech:async request=>{calls.push(structuredClone(request));return {audio:wav().toString('base64'),duration:.01};}})}),app=express();app.use(express.json());app.use('/speech',service.router);app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/speech`;
 const request=(route,body,method=body===undefined?'GET':'POST')=>fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),synthesize=(settings,text='Одна фраза.')=>service.synthesize(settings,text,new AbortController().signal);
 t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-silero-service-'));await fs.rm(dir,{recursive:true,force:true});});
 return {dir,state,calls,service,request,synthesize,get modelsDir(){return modelsDir;},setModelsDir(value){modelsDir=value;}};
}

test('Silero routes Russian, English, eng alias and automatic language detection without changing saved settings',async t=>{
 const f=await fixture(t),before=structuredClone(f.state),cases=[['ru','Дверь открыта.','ru','v3_1_ru','kseniya'],['en','The door is open.','en','v3_en','en_0'],['eng','Another door is open.','en','v3_en','en_0'],['auto','Свет загорелся.','ru','v3_1_ru','kseniya'],['auto','A light turned on.','en','v3_en','en_0']];
 for(const [language,text] of cases)await f.synthesize(validateSpeech({provider:'silero',language}),text);
 assert.deepEqual(f.calls.map(r=>[r.language,r.modelId,r.voice]),cases.map(c=>c.slice(2)));assert.ok(f.calls.every(r=>r.provider==='silero'&&r.device==='cpu'&&r.options.sampleRate===24000));assert.deepEqual(f.state,before);
});

test('Silero assignments select model and speaker; cache separates voices, languages, sample rates and models',async t=>{
 const f=await fixture(t),settings=validateSpeech({provider:'silero',language:'auto',characterVoices:{iris:{provider:'silero',modelId:'v4_ru',voice:'xenia',language:'ru'}},gmVoice:{provider:'silero',modelId:'v3_1_ru',voice:'aidar',language:'ru'},fanficVoice:{provider:'silero',modelId:'v3_en',voice:'en_17',language:'en'}}),before=structuredClone(settings),text='Test phrase.';
 const variants=[speechFor(settings,{characterId:'iris'}),speechFor(settings,{gameMaster:true}),speechFor(settings,{fanfic:true}),speechSettings({provider:'silero',language:'en',silero:{englishVoice:'en_18'}}),speechSettings({provider:'silero',language:'en',silero:{englishVoice:'en_18',sampleRate:48000}})];
 for(const selected of variants){await f.synthesize(selected,text);await f.synthesize(selected,text);}
 assert.equal(f.calls.length,variants.length);assert.deepEqual(f.calls.map(r=>[r.language,r.modelId,r.voice,r.options.sampleRate]),[['ru','v4_ru','xenia',24000],['ru','v3_1_ru','aidar',24000],['en','v3_en','en_17',24000],['en','v3_en','en_18',24000],['en','v3_en','en_18',48000]]);assert.deepEqual(settings,before);
});

test('A Silero session retains its settings snapshot while later sessions use newly saved voices and rates',async t=>{
 const f=await fixture(t),initial=speechSettings({provider:'silero',language:'ru',silero:{voice:'kseniya',sampleRate:24000}});f.state.settings.speech=initial;
 const response=await f.request('/sessions',{text:'Первая фраза. Вторая фраза.'});assert.equal(response.status,200,await response.clone().text());const old=await response.json();assert.equal(old.count,2);
 // Mutate the caller-owned object as well as the persistent state's values:
 // neither may alter a session which was already created.
 initial.silero.voice='xenia';initial.silero.sampleRate=8000;f.state.settings.speech=speechSettings({provider:'silero',language:'ru',silero:{modelRu:'v4_ru',voice:'baya',sampleRate:48000}});
 assert.equal((await f.request(`/sessions/${old.id}/0`)).status,200);assert.equal((await f.request(`/sessions/${old.id}/1`)).status,200);const freshResponse=await f.request('/sessions',{text:'Новая фраза.'}),fresh=await freshResponse.json();assert.equal(freshResponse.status,200);assert.equal((await f.request(`/sessions/${fresh.id}/0`)).status,200);
 assert.deepEqual(f.calls.map(r=>[r.modelId,r.voice,r.options.sampleRate]),[['v3_1_ru','kseniya',24000],['v3_1_ru','kseniya',24000],['v4_ru','baya',48000]]);await f.request('/sessions/'+old.id,undefined,'DELETE');await f.request('/sessions/'+fresh.id,undefined,'DELETE');
});

test('Changing the Hugging Face storage folder routes the next Silero weights and runtime to the new folder',async t=>{
 const f=await fixture(t),settings=speechSettings({provider:'silero',language:'ru'}),old=f.modelsDir;await f.synthesize(settings,'Проверка новой папки.');const next=path.join(f.dir,'another-hf-folder');f.setModelsDir(next);await f.synthesize(settings,'Проверка новой папки.');assert.equal(f.calls.length,2,'The old folder cache must not satisfy the new folder request');
 for(const [index,root] of [old,next].entries()){assert.equal(f.calls[index].folder,path.join(root,'sas-tts','models','silero'));assert.equal(f.calls[index].modelFile,path.join(root,'sas-tts','models','silero','v3_1_ru.pt'));assert.equal(f.calls[index].runtime,path.join(root,'sas-tts','runtime','silero-cpu'));}
});

test('Invalid Silero model, voice, sample rate and unsupported language fail without inference, installation or state changes',async t=>{
 const f=await fixture(t),before=structuredClone(f.state),invalid=[{silero:{modelRu:'not-allowed'}},{silero:{modelEn:'v3_1_ru'}},{silero:{voice:'not-a-speaker'}},{silero:{englishVoice:'en_999'}},{silero:{sampleRate:22050}},{silero:{putAccent:'yes'}}];
 for(const value of invalid){const response=await f.request('/sessions',{text:'Не начинать синтез.',settings:{provider:'silero',...value}});assert.equal(response.status,400,await response.text());}
 const unsupported=await f.request('/sessions',{text:'Bonjour.',settings:{provider:'silero',language:'fr'}});assert.equal(unsupported.status,200);const session=await unsupported.json(),failed=await f.request(`/sessions/${session.id}/0`);assert.equal(failed.status,400);assert.match((await failed.json()).error,/Silero.*русский.*английский/);await f.request('/sessions/'+session.id,undefined,'DELETE');
 const install=await f.request('/install',{provider:'silero',modelId:'not-allowed'});assert.equal(install.status,400);const status=await f.service.status();assert.equal(status.jobs.length,0);assert.equal(status.activeSessions,0);assert.equal(f.calls.length,0);assert.deepEqual(f.state,before);await assert.rejects(fs.stat(f.modelsDir),{code:'ENOENT'});
});

test('A damaged local Silero weight fails integrity checks before any runtime or worker starts',async t=>{
 const f=await fixture(t,{realInference:true}),before=structuredClone(f.state),folder=path.join(f.modelsDir,'sas-tts','models','silero');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'v3_1_ru.pt'),bad=Buffer.from('DAMAGED_TEST_WEIGHT');await fs.writeFile(file,bad);
 await assert.rejects(f.synthesize(speechSettings({provider:'silero',language:'ru'}),'Не запускать worker.'),error=>error.status===409&&/Повреждён файл Silero/.test(error.message));assert.deepEqual(await fs.readFile(file),bad);await assert.rejects(fs.stat(path.join(f.modelsDir,'sas-tts','runtime')),{code:'ENOENT'});assert.deepEqual(f.state,before);assert.deepEqual(await fs.readdir(folder),['v3_1_ru.pt']);
});
test('Silero status and inference reject mismatched runtime provider, device, OS, architecture or portability',async t=>{
 const f=await fixture(t,{realInference:true}),before=structuredClone(f.state),runtime=path.join(f.modelsDir,'sas-tts','runtime','silero-cpu'),valid={provider:'silero',version:1,device:'cpu',platform:process.platform,arch:process.arch,portable:process.platform==='win32'};await fs.mkdir(runtime,{recursive:true});await fs.writeFile(path.join(runtime,process.platform==='win32'?'python.exe':'bin/python'),'not executed').catch(async error=>{if(error.code!=='ENOENT')throw error;await fs.mkdir(path.join(runtime,'bin'));await fs.writeFile(path.join(runtime,'bin/python'),'not executed');});
 const invalid=[{...valid,provider:'xtts'},{...valid,device:'gpu'},{...valid,platform:process.platform==='win32'?'linux':'win32'},{...valid,arch:process.arch==='x64'?'arm64':'x64'},...(process.platform==='win32'?[{...valid,portable:false}]:[])];
 for(const marker of invalid){await fs.writeFile(path.join(runtime,'sas-ready.json'),JSON.stringify(marker));assert.equal((await f.service.status()).models.find(m=>m.id==='silero').runtimeReady.cpu,false);await assert.rejects(f.synthesize(speechSettings({provider:'silero',language:'ru'}),'Не запускать несовместимый движок.'),error=>error.status===409&&/Установите движок Silero/.test(error.message));}
 await fs.writeFile(path.join(runtime,'sas-ready.json'),'{interrupted JSON');assert.equal((await f.service.status()).models.find(m=>m.id==='silero').runtimeReady.cpu,false);assert.deepEqual(f.state,before);assert.equal(f.calls.length,0);await assert.rejects(fs.stat(path.join(f.modelsDir,'sas-tts','models')),{code:'ENOENT'});
});
