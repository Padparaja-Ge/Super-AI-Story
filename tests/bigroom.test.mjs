import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {validMemory,pendingMemory} from '../server/memory.mjs';
import {campaignBundle,restoreCampaign,validateCampaignBundle} from '../server/room-backups.mjs';
import {startServer} from '../server/index.mjs';
import {normalizeCast,pickSpeaker,mentions,speakerView,speakerLorebookIds,castBrief,bigRoomInstructions} from '../shared/bigroom.mjs';
import {validateStorybook} from '../server/storybooks.mjs';
import {selectRoomHistory} from '../server/room-history.mjs';
import {roomChat,createRoomMemory} from '../server/room-memory.mjs';

const chars=[{id:'a',name:'Ирис',lorebookIds:['la']},{id:'b',name:'Атлас Вейн',lorebookIds:['lb']},{id:'c',name:'Мира'}];

test('Big room cast: 2..8 distinct existing characters',()=>{
 assert.deepEqual(normalizeCast(chars,['a','b','a']),['a','b']);
 assert.throws(()=>normalizeCast(chars,['a']),/минимум 2/);
 assert.throws(()=>normalizeCast(chars,['a','zzz']),/не найден/);
 const many=Array.from({length:9},(_,i)=>({id:'x'+i,name:'X'+i}));
 assert.throws(()=>normalizeCast(many,many.map(c=>c.id)),/не больше 8/);
 assert.throws(()=>normalizeCast(chars,'a'),/Выберите/);
});

test('Speaker choice: explicit request, then a named character, then the longest silent one',()=>{
 const cast=['a','b','c'];
 assert.equal(pickSpeaker(cast,[],chars,{requested:'c'}),'c');
 assert.throws(()=>pickSpeaker(cast,[],chars,{requested:'zzz'}),/не участвует/);
 // Russian cases of the first name address the character
 assert.equal(pickSpeaker(cast,[{role:'user',content:'Атласу: что скажешь?'}],chars),'b');
 assert.ok(mentions('Спроси Ирису об архиве','Ирис'));assert.ok(!mentions('ирисовый чай','Мира'));
 // nobody named: everyone silent -> first; never the same speaker twice in a row
 const history=[{role:'user',content:'Привет всем'},{role:'assistant',characterId:'a',content:'..'},{role:'assistant',characterId:'b',content:'..'}];
 assert.equal(pickSpeaker(cast,history,chars),'c');
 assert.equal(pickSpeaker(cast,[...history,{role:'assistant',characterId:'c',content:'..'}],chars),'a');
 // a mention that was already answered no longer forces that speaker
 assert.equal(pickSpeaker(cast,[{role:'user',content:'Мира, привет'},{role:'assistant',characterId:'c',content:'Привет'}],chars),'a');
});

test('Speaker view labels other characters; lorebooks are room + own; brief lists the rest',()=>{
 const view=speakerView([{role:'user',content:'Гость: привет'},{role:'assistant',characterId:'a',name:'Ирис',content:'Здравствуй'},{role:'assistant',characterId:'b',name:'Атлас Вейн',content:'Добрый день'}],'a');
 assert.equal(view[1].role,'assistant');assert.equal(view[2].role,'user');assert.equal(view[2].content,'Атлас Вейн: Добрый день');
 assert.deepEqual(speakerLorebookIds({lorebookIds:['room','la']},chars[0]),['room','la']);
 assert.match(castBrief(['a','b','c'],chars,'a'),/Атлас Вейн[\s\S]*Мира/);assert.doesNotMatch(castBrief(['a','b'],chars,'a'),/Ирис/);
 assert.match(bigRoomInstructions({speaker:'Ирис',story:'Цель: найти ключ'}),/ТОЛЬКО за персонажа «Ирис»[\s\S]*Цель: найти ключ/);
});

test('Story book kind separates D&D books from big room books; histories keep the cast',()=>{
 const base={name:'Бал',world:'Дворец',start:'Зал',goal:'Раскрыть заговор',details:'',playerCount:'2-4'};
 assert.equal(validateStorybook(base).kind,'adventure');assert.equal(validateStorybook({...base,kind:'bigroom'}).kind,'bigroom');
 const state={characters:chars,chats:[],settings:{},multiplayerHistories:[]};
 const room=selectRoomHistory(state,{newHistory:true,mode:'bigroom',name:'Бал',castIds:['a','b']});
 assert.deepEqual(room.cast,['a','b']);assert.equal(room.chatId,'');
 assert.throws(()=>selectRoomHistory({...state,multiplayer:undefined},{newHistory:true,mode:'bigroom',castIds:['a']}),/минимум 2/);
 const chat=roomChat({...room,messages:[{id:'1',role:'assistant',characterId:'b',name:'Атлас Вейн',content:'Привет'}]},{characterId:'a'});
 assert.equal(chat.messages[0].role,'user');assert.equal(chat.messages[0].content,'Атлас Вейн: Привет');
});

test('Big room end to end: each reply is written as one character with its own and the room lore',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-bigroom-')),calls=[];
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};calls.push(body);
  const all=JSON.stringify(body.messages||[]),who=/ТОЛЬКО за персонажа «([^»]+)»/.exec(all)?.[1]||'—';
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:`${who}: Реплика от ${who}.`}}]})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const runtime=await startServer({port:0,dataDir:dir});
 t.after(async()=>{await runtime.close();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});});
 const api=async(route,body,method)=>{const r=await fetch(`http://127.0.0.1:${runtime.port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw new Error(data.error||r.status);return data;};
 const store=runtime.app.locals.runtime.store,s=store.getState();
 s.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;s.connections[0].model='m';s.plugins.find(p=>p.id==='rpg').enabled=false;
 s.lorebooks.push({id:'room-lore',name:'Общий',enabled:false,entries:[{id:'r1',name:'Зал',content:'ROOM_SHARED_LORE',constant:true,enabled:true}]});
 s.lorebooks.push({id:'atlas-lore',name:'Атлас',enabled:false,entries:[{id:'t1',name:'Секрет',content:'ATLAS_OWN_LORE',constant:true,enabled:true}]});
 s.characters.find(c=>c.id==='char-atlas').lorebookIds=['atlas-lore'];
 s.storybooks.push({id:'sb-dnd',kind:'adventure',name:'Поход',world:'Лес',start:'Опушка',goal:'Дракон',details:'',playerCount:'2-4'});
 s.storybooks.push({id:'sb-big',kind:'bigroom',name:'Бал',world:'Дворец',start:'Бальный зал',goal:'BIGROOM_STORY_GOAL',details:'',playerCount:'2-4'});
 store.saveState(s);
 const personaId=s.personas[0].id;
 await assert.rejects(api('/multiplayer/start',{port:0,personaId,mode:'bigroom',newHistory:true,castIds:['char-iris','char-atlas'],storybookId:'sb-dnd',connectionId:s.connections[0].id,lorebookIds:['room-lore']}),/помеченный для большой комнаты/);
 const started=await api('/multiplayer/start',{port:0,personaId,mode:'bigroom',newHistory:true,castIds:['char-iris','char-atlas'],storybookId:'sb-big',connectionId:s.connections[0].id,lorebookIds:['room-lore']});
 assert.equal(started.room.mode,'bigroom');assert.deepEqual(started.room.cast.map(c=>c.name),['Ирис','Атлас']);
 await api('/multiplayer/message',{content:'Атлас, что ты знаешь о зале?'});
 const first=await api('/multiplayer/generate',{});
 assert.equal(first.message.name,'Атлас');assert.equal(first.message.characterId,'char-atlas');assert.equal(first.message.content,'Реплика от Атлас.');
 const prompt=JSON.stringify(calls.at(-1).messages);
 assert.match(prompt,/ROOM_SHARED_LORE/);assert.match(prompt,/ATLAS_OWN_LORE/);assert.match(prompt,/BIGROOM_STORY_GOAL/);assert.match(prompt,/Ирис/);
 // characters talk to each other: two replies, alternating speakers, each with only its own card lore
 const talk=await api('/multiplayer/converse',{count:2});
 assert.deepEqual(talk.messages.map(m=>m.name),['Ирис','Атлас']);
 const irisPrompt=JSON.stringify(calls.at(-2).messages);assert.match(irisPrompt,/ROOM_SHARED_LORE/);assert.doesNotMatch(irisPrompt,/ATLAS_OWN_LORE/);
 assert.match(irisPrompt,/Атлас: Реплика от Атлас/);
 const forced=await api('/multiplayer/generate',{speakerId:'char-iris'});assert.equal(forced.message.name,'Ирис');
 await assert.rejects(api('/multiplayer/generate',{speakerId:'char-unknown'}),/не участвует/);
});


test('Big room summaries stay valid for every speaker and invalidate after a canonical post is edited',()=>{
 const room={id:'memory-room',mode:'bigroom',messages:[{id:'one',role:'assistant',characterId:'a',name:'Ирис',content:'Я сохраню ключ.'},{id:'two',role:'assistant',characterId:'b',name:'Атлас',content:'Я запомню пароль.'}],memory:[]};
 const original=roomChat(room);
 room.memory=[{id:'summary',content:'Ирис хранит ключ, Атлас знает пароль.',sources:original.messages.map(message=>({id:message.id,hash:crypto.createHash('sha256').update(message.role+'\n'+message.content).digest('hex'),start:0,end:message.content.length}))}];
 const canonical=JSON.stringify(room);
 for(const characterId of ['a','b','c']){
  const chat=roomChat(room,{characterId});assert.equal(validMemory(chat).length,1);assert.deepEqual(pendingMemory(chat),[]);
 }
 assert.equal(JSON.stringify(room),canonical,'speaker projections must not rewrite persisted memory');
 room.messages[0].content='Ключ уже потерян.';
 assert.equal(validMemory(roomChat(room,{characterId:'b'})).length,0);
});

test('Big room host backups include cast cards and personal lore, and restore to a fresh studio',()=>{
 const state={characters:chars.map(character=>({...character,description:'Card '+character.id,blocks:[],personaId:'private-persona'})),chats:[],lorebooks:[{id:'shared',name:'Shared',entries:[]},{id:'la',name:'Own A',entries:[]},{id:'lb',name:'Own B',entries:[]},{id:'unrelated',name:'Private other story',entries:[]}],multiplayer:{id:'big-backup',mode:'bigroom',cast:['a','b'],speakerId:'b',lorebookIds:['shared'],messages:[{id:'post',role:'assistant',characterId:'b',name:'Атлас',content:'Я помню пароль.'}]}};
 const bundle=campaignBundle(state);assert.deepEqual(bundle.characters.map(character=>character.id),['a','b']);assert.deepEqual(bundle.lorebooks.map(book=>book.id),['shared','la','lb']);assert.equal(validateCampaignBundle(bundle).room.mode,'bigroom');
 const restored={characters:[],chats:[],lorebooks:[],multiplayerHistories:[]},room=restoreCampaign(restored,bundle);
 assert.equal(room.mode,'bigroom');assert.equal(room.chatId,'');assert.equal(restored.characters.length,2);assert.equal(restored.lorebooks.length,3);assert.deepEqual(normalizeCast(restored.characters,room.cast),room.cast);
 assert.notDeepEqual(room.cast,['a','b']);assert.equal(room.speakerId,room.cast[1]);assert.equal(room.messages[0].characterId,room.cast[1]);assert.equal(restored.characters[0].personaId,'');
 assert.equal(restored.characters[0].lorebookIds[0],restored.lorebooks.find(book=>book.name==='Own A').id);
 const broken=structuredClone(bundle);broken.room.cast=['a','missing'];delete broken.characters;
 const before=JSON.stringify(restored);assert.throws(()=>restoreCampaign(restored,broken),/отсутствуют карточки/);assert.equal(JSON.stringify(restored),before,'rejected restoration must not append lorebooks');
});

test('Big room guest backups restore minimal public cast cards without requiring a tactical game',()=>{
 const bundle={spec:'sas_campaign_backup_v1',source:'guest',room:{id:'guest-big',mode:'bigroom',cast:['guest-a','guest-b'],speakerId:'guest-a',messages:[]},lorebooks:[],characters:[{id:'guest-a',name:'А',description:'Public A',blocks:[],lorebookIds:[]},{id:'guest-b',name:'Б',description:'Public B',blocks:[],lorebookIds:[]}]};
 const state={characters:[],chats:[],lorebooks:[],multiplayerHistories:[]},room=restoreCampaign(state,bundle);
 assert.equal(room.recovery.partial,true);assert.equal(state.characters[0].description,'Public A');assert.equal(room.cast.length,2);assert.equal(room.tactical,undefined);
 for(const cast of [[],['guest-a'],['guest-a','guest-a']])assert.throws(()=>validateCampaignBundle({...bundle,room:{...bundle.room,cast}}),/состав/);
});


test('Big room summaries retain the name of each speaking character',async()=>{
 let state={connections:[{id:'connection',provider:'openai',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',contextWindow:8192,maxTokens:500}],settings:{},multiplayer:{id:'summary-room',mode:'bigroom',connectionId:'connection',memory:[],messages:[{id:'a-post',role:'assistant',name:'Ирис',characterId:'a',content:'Я храню ключ.'},{id:'b-post',role:'assistant',name:'Атлас',characterId:'b',content:'Я знаю пароль.'}]}};
 let prompt;
 const memory=createRoomMemory({getState:()=>structuredClone(state),saveState:value=>{state=value;},getSecret:()=>'',completion:async(connection,secret,messages)=>{prompt=messages;return 'Ирис хранит ключ; Атлас знает пароль.';}});
 await memory.summarize('summary-room');
 assert.match(prompt[1].content,/assistant \(Ирис\): Я храню ключ/);assert.match(prompt[1].content,/assistant \(Атлас\): Я знаю пароль/);
 assert.equal(validMemory(roomChat(state.multiplayer,{characterId:'a'})).length,1);
});
