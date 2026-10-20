import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {startServer} from '../server/index.mjs';
import {createStore} from '../server/store.mjs';
import {createSpeechService} from '../server/tts/service.mjs';
import {speechFor,speechSettings} from '../shared/speech.mjs';
import {createAdventureGame,adventureActor} from '../server/adventure-engine.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {roleplayMessages} from '../server/roleplay.mjs';
import {complete} from '../server/llm.mjs';
import {buildFanficMessages} from '../server/fanfic.mjs';
import {fanficDefaults} from '../shared/fanfic.mjs';

const speechOnly=/TTS_ONLY_|TTSONLY|referenceText|referencePath|pronunciations|modelRu|modelEn|putAccent|putYo|sampleRate|repetitionPenalty|gptCondLen|data:audio|UklGR|kseniya|en_0|v3_1_ru|v3_en/;
const protectedKeys=['characters','chats','lorebooks','personas','fanficProjects','multiplayer','multiplayerHistories','wizardSessions','storybooks','images'];
const protectedState=state=>Object.fromEntries(protectedKeys.map(key=>[key,state[key]]));
const persona={id:'speech-test-player',name:'Рей',kind:'srp',className:'Воин',avatar:'R',abilities:defaultAbilities()};
const silero={modelRu:'v3_1_ru',modelEn:'v3_en',voice:'kseniya',englishVoice:'en_0',sampleRate:24000,putAccent:true,putYo:true,speed:1};
function wav(){
 const bytes=Buffer.alloc(44+24000*2*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;
}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture(t,mode='roleplay'){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-speech-context-')),payloads=[],synthesis=[];
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;payloads.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Проверенный ответ персонажа.'},finish_reason:'stop'}]}));}),providerUrl=await listen(provider);
 const runtime=await startServer({port:0,dataDir:dir}),store=runtime.app.locals.runtime.store;
 let state=store.getState();state.connections[0].baseUrl=providerUrl+'/v1';state.connections[0].model='context-isolation-mock';state.connections[0].contextWindow=16384;state.activeConnectionId=state.connections[0].id;state.activePresetId='';state.plugins=[];state.settings.narrative={mode:'roleplay',tense:'present',perspective:'third',length:'medium',instructions:''};
 state.settings.embeddings.enabled=false;state.personas.push(persona);state.characters[0].lorebookIds=[];
 state.chats[0].messages=[{id:'rp-user',role:'user',content:'Кто хранит печать?'},{id:'rp-npc',role:'assistant',content:'RP_PROSE: печать хранит смотритель.'}];state.chats[0].memory=[{id:'rp-memory',content:'RP_MEMORY: долг равен 37 монетам.',category:'facts',enabled:true}];state.chats[0].memorySettings={...state.chats[0].memorySettings,autoSummary:false,vectorMemory:false};state.chats[0].scene.autoUpdate=false;
 const game=createAdventureGame(mode==='roleplay'?'dnd':mode);game.actors=[adventureActor('host',persona,game.rules)];game.order=['host'];game.phase='players';
 state.multiplayer={id:'speech-room',name:'Тестовая комната',mode,chatId:state.chats[0].id,connectionId:state.activeConnectionId,messages:[{id:'room-user',role:'user',name:'Рей',content:'ROOM_PROSE: спрашиваю стража о воротах.',createdAt:'2026-10-15T00:00:00.000Z'}],memory:[{id:'room-memory',content:'ROOM_MEMORY: ворота закрываются в полночь.',enabled:true}],summary:'',memorySettings:{autoSummary:false,vectorMemory:false},scene:{location:'Площадь',autoUpdate:false},lorebookIds:[],rulebookIds:[],personas:{host:persona},...(mode==='roleplay'?{}:{tactical:game})};
 state.multiplayerHistories=[{id:'foreign-room',summary:'FOREIGN_ROOM_PRIVATE',messages:[]}];
 state.fanficProjects=[{id:'speech-fanfic',title:'Лунный архив',world:'FANFIC_WORLD',canon:'',divergence:'',settings:{...fanficDefaults,maxTokens:800,vectorMemory:false},characters:[],personas:[],lorebooks:[],episodes:[{id:'e1',season:1,number:1,brief:'Найти архив.',editorMessages:[],content:'FANFIC_PROSE: Ирис подняла печать.'}],memory:[{id:'f1',summary:'FANFIC_MEMORY: Ирис обещала вернуть печать.'}]}];store.saveState(state);await store.flush();
 let behavior='success',started,entered=new Promise(resolve=>started=resolve);
 // Use the production speech router against the same persistent store as the
 // real settings/prompt API; replace only the final native inference call.
 const speech=createSpeechService({dataDir:dir,getState:store.getState,saveState:store.saveState,getModelsDir:async()=>path.join(dir,'chosen-model-folder'),bundledRoot:null,runSpeech:async(request,signal)=>{synthesis.push(request);if(behavior==='error')throw new Error('TTS_ONLY_RUNTIME_FAILURE');if(behavior==='cancel'){started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('TTS_ONLY_CANCELLED')),{once:true}));}return {audio:wav().toString('base64'),duration:4};}}),speechApp=express();speechApp.use(express.json({limit:'24mb'}));speechApp.use('/speech',speech.router);speechApp.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));const speechServer=http.createServer(speechApp),speechUrl=await listen(speechServer);
 const request=async(url,route,body,method=body===undefined?'GET':'POST')=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const api=(route,body,method)=>request(`http://127.0.0.1:${runtime.port}/api`,route,body,method),tts=(route,body,method)=>request(speechUrl+'/speech',route,body,method);
 async function prompts(){
  const current=store.getState(),rpResponse=await api('/prompt',{chatId:current.chats[0].id,content:'Напомни прошлое.'});assert.equal(rpResponse.status,200,await rpResponse.clone().text());const rp=(await rpResponse.json()).messages;
  const room=runtime.app.locals.runtime.multiplayer.context(),roomPrompt=buildPrompt(room.state,room.chat.id,'',{extraInstructions:room.extraInstructions}).messages;
  if(room.priorityInstructions)roomPrompt.unshift({role:'system',content:room.priorityInstructions});
  const project=current.fanficProjects[0],fanfic=buildFanficMessages({project,episode:project.episodes[0],connection:current.connections[0],memories:project.memory,currentText:project.episodes[0].content,instructions:'Продолжи.'}).messages;
  // Older local instruction/MoE templates use this additional production
  // adapter. Its flattened user prompt must remain equally free of TTS data.
  const rpFocused=roleplayMessages(rp,{characterName:current.characters[0].name,playerName:current.personas[0].name,maxTokens:800});
  return {rp,rpFocused,room:roomPrompt,fanfic};
 }
 async function wire(prompts){const current=store.getState(),from=payloads.length;for(const messages of Object.values(prompts))await complete(current.connections[0],'',messages,{maxTokens:80});return payloads.slice(from);}
 t.after(async()=>{await speech.close();await close(speechServer);await runtime.close();await close(provider);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-speech-context-'));await fs.rm(dir,{recursive:true,force:true});});
 return {dir,store,api,tts,speech,synthesis,prompts,wire,setBehavior(value){behavior=value;},entered};
}
async function assertUnchanged(f,before,prompts,payloads){
 await f.store.flush();assert.deepEqual(protectedState(f.store.getState()),before);const disk=JSON.parse(await fs.readFile(path.join(f.dir,'state.json'),'utf8'));assert.deepEqual(protectedState(disk),before);
 const after=await f.prompts();assert.deepEqual(after,prompts);const actual=await f.wire(after);assert.deepEqual(actual,payloads);assert.doesNotMatch(JSON.stringify(actual),speechOnly);
}

for(const mode of ['roleplay','dnd','custom'])test(`Speech success, saved clone, pronunciation and voice settings leave ${mode}, solo RP and fanfic model payloads and memory intact`,async t=>{
 const f=await fixture(t,mode),before=protectedState(f.store.getState()),prompts=await f.prompts(),payloads=await f.wire(prompts);assert.match(JSON.stringify(prompts.rp),/RP_MEMORY/);assert.match(JSON.stringify(prompts.room),/ROOM_MEMORY/);assert.match(JSON.stringify(prompts.fanfic),/FANFIC_MEMORY/);assert.doesNotMatch(JSON.stringify(prompts.room),/RP_MEMORY|FANFIC_MEMORY|FOREIGN_ROOM_PRIVATE/);assert.doesNotMatch(JSON.stringify(prompts.fanfic),/RP_MEMORY|ROOM_MEMORY|FOREIGN_ROOM_PRIVATE/);
 const imported=await f.tts('/references',{name:'TTS_ONLY_VOICE_PROFILE',text:'TTS_ONLY_REFERENCE_TRANSCRIPT',audio:wav().toString('base64')});assert.equal(imported.status,200,await imported.clone().text());const reference=await imported.json(),state=f.store.getState();
 state.settings.speech=speechSettings({provider:'xtts',language:'ru',pronunciations:[{from:'печать',to:'TTS_ONLY_PRONUNCIATION'}],xtts:{referenceId:reference.id,temperature:.81},characterVoices:{[state.characters[0].id]:{provider:'xtts',voice:'female',referenceId:reference.id}},gmVoice:{provider:'xtts',voice:'female',referenceId:reference.id},fanficVoice:{provider:'xtts',voice:'female',referenceId:reference.id}});
 const saved=await f.api('/state',state,'PUT');assert.equal(saved.status,200,await saved.clone().text());const selected=speechFor(f.store.getState().settings.speech,{characterId:state.characters[0].id}),created=await f.tts('/sessions',{text:state.chats[0].messages[1].content,settings:selected});assert.equal(created.status,200,await created.clone().text());const session=await created.json();assert.equal((await f.tts(`/sessions/${session.id}/0`)).status,200);assert.equal(f.synthesis[0].referenceText,'TTS_ONLY_REFERENCE_TRANSCRIPT');assert.match(f.synthesis[0].text,/TTSONLYPRONUNCIATION/);assert.equal((await f.tts('/sessions/'+session.id,undefined,'DELETE')).status,200);
 await assertUnchanged(f,before,prompts,payloads);assert.equal((await f.tts('/references/'+reference.id,undefined,'DELETE')).status,200);await assertUnchanged(f,before,prompts,payloads);
 const restored=createStore(f.dir).getState();assert.deepEqual(protectedState(restored),before);assert.equal(restored.settings.speech.gmVoice,null);assert.equal(restored.settings.speech.fanficVoice,null);
});

test('Silero choices persist through the settings API and synthesis without entering RP, D&D or fanfic context',async t=>{
 const f=await fixture(t,'dnd'),before=protectedState(f.store.getState()),prompts=await f.prompts(),payloads=await f.wire(prompts),state=f.store.getState();
 state.settings.speech=speechSettings({provider:'silero',language:'ru',silero,pronunciations:[{from:'печать',to:'TTS_ONLY_SILERO_PRONUNCIATION'}],characterVoices:{[state.characters[0].id]:{provider:'silero',voice:'baya',language:'ru'}},gmVoice:{provider:'silero',voice:'aidar',language:'ru'},fanficVoice:{provider:'silero',voice:'kseniya',language:'ru'}});
 const response=await f.api('/state',state,'PUT');assert.equal(response.status,200,await response.clone().text());const restored=createStore(f.dir).getState();assert.deepEqual(restored.settings.speech.silero,silero);assert.equal(restored.settings.speech.provider,'silero');assert.equal(restored.settings.speech.gmVoice.voice,'aidar');
 for(const selection of [{characterId:state.characters[0].id},{gameMaster:true},{fanfic:true}]){const created=await f.tts('/sessions',{text:state.chats[0].messages[1].content,settings:speechFor(restored.settings.speech,selection)});assert.equal(created.status,200,await created.clone().text());const session=await created.json();assert.equal((await f.tts(`/sessions/${session.id}/0`)).status,200);await f.tts('/sessions/'+session.id,undefined,'DELETE');}
 assert.equal(f.synthesis.length,3);assert.ok(f.synthesis.every(request=>request.provider==='silero'));assert.deepEqual(f.synthesis.map(request=>[request.language,request.modelId,request.voice]),[['ru','v3_1_ru','baya'],['ru','v3_1_ru','aidar'],['ru','v3_1_ru','kseniya']]);await assertUnchanged(f,before,prompts,payloads);
});

test('Cancelled or failed speech never writes audio, error text, pronunciation or job metadata to RP, NRИ and fanfic memory',async t=>{
 const f=await fixture(t,'custom'),before=protectedState(f.store.getState()),prompts=await f.prompts(),payloads=await f.wire(prompts),settings=speechSettings({pronunciations:[{from:'печать',to:'TTS_ONLY_STOPPED'}]});
 f.setBehavior('cancel');let response=await f.tts('/sessions',{text:'Печать в архиве.',settings}),session=await response.json();const pending=f.tts(`/sessions/${session.id}/0`);await f.entered;assert.equal((await f.tts('/sessions/'+session.id,undefined,'DELETE')).status,200);assert.equal((await pending).status,500);assert.equal((await f.tts(`/sessions/${session.id}/0`)).status,404);await assertUnchanged(f,before,prompts,payloads);
 f.setBehavior('error');response=await f.tts('/sessions',{text:'Печать разбита.',settings});session=await response.json();const failed=await f.tts(`/sessions/${session.id}/0`);assert.equal(failed.status,500);assert.match((await failed.json()).error,/TTS_ONLY_RUNTIME_FAILURE/);await f.tts('/sessions/'+session.id,undefined,'DELETE');assert.equal((await f.speech.status()).activeSessions,0);await assertUnchanged(f,before,prompts,payloads);
});
