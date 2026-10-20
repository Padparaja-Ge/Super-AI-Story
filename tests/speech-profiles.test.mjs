import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {spawnSync} from 'node:child_process';
import {speechFor,speechSettings,speechText} from '../shared/speech.mjs';
import {normalizePhonemes,phonemeIds,russianText} from '../server/tts/phoneme-normalize.mjs';
import {createSpeechService} from '../server/tts/service.mjs';
import {wavDuration} from '../server/tts/audio.mjs';
const id='f130dd36-5995-49d0-b78b-000000000099';
function audio(){const b=Buffer.alloc(44+24000*2*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
test('Voice assignments isolate characters, the single GM voice and the fanfic narrator',()=>{
 const s=speechSettings({characterVoices:{alice:{provider:'xtts',voice:'female',referenceId:id}},gmVoice:{provider:'fish',voice:'male'},fanficVoice:{provider:'kokoro-ru',voice:'dima'},xtts:{temperature:.8},device:'cpu'}),before=JSON.stringify(s);
 const a=speechFor(s,{characterId:'alice'});assert.equal(a.provider,'xtts');assert.equal(a.xtts.referenceId,id);assert.equal(a.xtts.temperature,.8);assert.equal(a.device,'cpu');
 assert.equal(speechFor(s,{characterId:'bob'}).provider,'kokoro-ru');assert.equal(speechFor(s,{characterId:'alice',gameMaster:true}).provider,'fish');assert.equal(speechFor(s,{fanfic:true}).provider,'kokoro-ru');assert.equal(speechFor(s,{fanfic:true})['kokoro-ru'].voice,'dima');assert.equal(JSON.stringify(s),before);
 const other=speechSettings();other.characterVoices.alice={provider:'fish',voice:'female'};other.pronunciations.push({from:'one',to:'two'});assert.deepEqual(speechSettings().characterVoices,{});assert.deepEqual(speechSettings().pronunciations,[]);
});
test('Pronunciation substitutions are literal, bounded to one pass, and do not mutate prose',()=>{
 const text='Тонерико видит C++ и тонерико.';assert.equal(speechText(text,[{from:'Тонерико',to:'Тонэрико'},{from:'C++',to:'си плюс плюс'},{from:'Тонэрико',to:'не использовать'}]),'Тонэрико видит си плюс плюс и Тонэрико.');assert.equal(text,'Тонерико видит C++ и тонерико.');
});
test('Russian G2P keeps hard L, ё and affricates instead of dropping consonants',()=>{
 const normalized=normalizePhonemes('sʲˈiɭnyj tʲaʒˈɵɭuj‍u ɕˈit kʌɭt‍sˈo t‍ʃʲˈustva','ru');assert.ok(normalized.includes('l'));assert.ok(normalized.includes('o'));assert.ok(normalized.includes('ʦ'));assert.ok(normalized.includes('ʧ'));assert.ok(normalized.includes('ɕː'));assert.ok(!/[ɭɵ\u200d]/.test(normalized));const v=Object.fromEntries([...new Set([...normalized])].map((c,i)=>[c,i+1]));assert.equal(phonemeIds(normalized,v).length,[...normalized].length);assert.throws(()=>phonemeIds('ɭ',v),/фонемы/);assert.equal(normalizePhonemes('kæts','en-us'),'kæts');assert.equal(russianText('Его чувства. Конечно!'),'ево чуства. конешно!');
});
test('XTTS casts integer JSON penalties and speed to float at the Python boundary',t=>{
 const exe=process.env.SAS_TTS_PYTHON||(process.platform==='win32'?'C:\\python312\\python.exe':'python3'),worker=path.resolve('server/tts/python-worker.py'),script="import importlib.util,sys; s=importlib.util.spec_from_file_location('worker',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); p=m.xtts_parameters(dict(temperature=1,topK=50,topP=1,repetitionPenalty=2,lengthPenalty=1,speed=1)); assert all(type(p[k]) is float for k in ['temperature','top_p','repetition_penalty','length_penalty','speed']); assert type(p['top_k']) is int";
 const result=spawnSync(exe,['-c',script,worker],{input:'',encoding:'utf8'});if(result.error?.code==='ENOENT'){t.skip('Python not installed');return;}assert.equal(result.status,0,result.stderr);
});
test('WAV metadata rejects forged byte rates and out-of-range samples',()=>{const b=audio();assert.equal(wavDuration(b),4);b.writeUInt32LE(1,28);assert.throws(()=>wavDuration(b),/формат/);});
test('Russian soft-sign eSpeak marker is palatalization rather than a dropped letter or unsupported caret',()=>{const normalized=normalizePhonemes('dvʲˈerɪ^','ru');assert.equal(normalized,'dvʲˈerʲ');assert.ok(!normalized.includes('^'));});
test('Saved clone is reusable, deletions clear only its assignments and memory remains unchanged',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-voice-profiles-')),state={settings:{speech:speechSettings()},chats:[{summary:'RP'}],fanficProjects:[{memory:'FANFIC'}],multiplayer:{memory:'DND'}},calls=[],service=createSpeechService({dataDir:dir,getState:()=>state,saveState:()=>{},getModelsDir:async()=>dir,bundledRoot:null,runSpeech:async r=>{calls.push(r);return {audio:audio().toString('base64'),duration:4};}}),app=express();app.use(express.json({limit:'24mb'}));app.use('/speech',service.router);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/speech`,request=(p,body,method='POST')=>fetch(url+p,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const before=JSON.stringify({rp:state.chats,fanfic:state.fanficProjects,dnd:state.multiplayer}),ref=await(await request('/references',{name:'Мой голос',text:'Текст записи.',audio:audio().toString('base64')})).json();assert.ok(ref.id);
 assert.equal((await request('/references/'+ref.id,{name:'Рассказчик'},'PATCH')).status,200);assert.equal((await service.status()).references[0].name,'Рассказчик');assert.equal((await request('/references/'+ref.id+'/audio',undefined,'GET')).status,200);
 state.settings.speech.characterVoices.alice={provider:'xtts',voice:'female',referenceId:ref.id};state.settings.speech.characterVoices.bob={provider:'kokoro-ru',voice:'dima'};state.settings.speech.gmVoice={provider:'fish',voice:'male',referenceId:ref.id};state.settings.speech.xtts.referenceId=ref.id;
 for(const provider of ['xtts','fish'])await service.synthesize(speechSettings({provider,[provider]:{referenceId:ref.id}}),'Проверяем клонированный голос.',new AbortController().signal);
 assert.equal(calls[0].referencePath,calls[1].referencePath);assert.equal(calls[0].referenceText,'Текст записи.');assert.equal((await request('/references/'+ref.id,undefined,'DELETE')).status,200);assert.equal(state.settings.speech.gmVoice,null);assert.equal(state.settings.speech.characterVoices.alice,undefined);assert.equal(state.settings.speech.characterVoices.bob.voice,'dima');assert.equal(state.settings.speech.xtts.referenceId,'');assert.equal(JSON.stringify({rp:state.chats,fanfic:state.fanficProjects,dnd:state.multiplayer}),before);
});
