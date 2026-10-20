import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRoomMemory,roomChat,roundMessages,sourceDocuments,extractiveProtocol} from '../server/room-memory.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {sanitizeState} from '../server/store.mjs';
import {battlemapPreset,battlemapWorkflow,mapComfyConfig} from '../shared/battlemap-preset.mjs';
import {assertMapGuides,mapPrompt} from '../server/comfy.mjs';
import {generateMap,mapPNG} from '../server/battlemap.mjs';
import {installBattlemapAssets} from '../server/battlemap-assets.mjs';
import {createEmbeddings} from '../server/embeddings.mjs';
import {modelMessages} from '../server/llm.mjs';

const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
function fixture(options={}){
  let state=sanitizeState(structuredClone(seed));state.connections[0].model='mock';state.connections[0].contextWindow=8192;state.activePresetId='';
  state.chats[0].memory=[{id:'foreign',content:'SOLO_SECRET'}];state.multiplayer={id:'test',connectionId:state.connections[0].id,messages:[],memory:[],memorySettings:{autoSummary:true,summaryInterval:15,vectorMemory:true}};
  const calls=[];const service=createRoomMemory({getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',completion:async(c,k,m)=>{calls.push(m);return 'Факты: '+m[1].content.slice(-250);},...options});
  return {service,calls,get state(){return state;}};
}
test('Room summaries cover a long archive, preserve names and stay outside solo memory',async()=>{
  const f=fixture();f.state.multiplayer.messages=Array.from({length:210},(_,i)=>({id:'m'+i,role:i%5===4?'assistant':'user',name:'Игрок '+i%4,personaName:'Герой '+i%4,content:'Событие '+i+'. '+('Путь через город. '.repeat(4))}));
  await f.service.maintain('test');const c=roomChat(f.state.multiplayer);
  assert.ok(c.memory.length>10);assert.equal(f.service.validMemory(c).length,c.memory.length);
  assert.equal(new Set(c.memory.flatMap(m=>m.sources.map(s=>s.id))).size,210);
  assert.equal(f.state.chats[0].memory[0].content,'SOLO_SECRET');assert.match(f.calls[0][1].content,/Игрок 0 \(Герой 0\)/);
  f.state.multiplayer.messages[0].content='Исправленный факт';assert.ok(f.service.validMemory(roomChat(f.state.multiplayer)).length<c.memory.length);
});
test('Four oversized player posts all survive compaction and prompt budget; repeat uses digest cache',async()=>{
  const f=fixture();f.state.multiplayer.messages=[{id:'old',role:'assistant',content:'Ведущий закончил ход.'},...Array.from({length:4},(_,i)=>({id:'p'+i,role:'user',name:'ИГРОК_'+i,content:('Действие игрока '+i+'. ').repeat(350)}))];
  const chat=roomChat(f.state.multiplayer,{characterId:f.state.characters[0].id,connectionId:f.state.connections[0].id});
  const result=await f.service.compactRound(f.state,chat);assert.equal(result.compressed.length,4);assert.equal(result.messages.length,4);
  const prompt=buildPrompt({...f.state,chats:[chat]},chat.id,'',{historyMessages:result.messages,extraInstructions:'Большие инструкции. '.repeat(1800),extraFirst:true,compact:true,preserveHistory:true});
  assert.ok(prompt.estimatedTokens<=prompt.budget.available);assert.equal(prompt.messages.filter(m=>m.role==='user').length,4);
  for(let i=0;i<4;i++)assert.match(JSON.stringify(prompt.messages),new RegExp('ИГРОК_'+i));
  const count=f.calls.length;await f.service.compactRound(f.state,chat);assert.equal(f.calls.length,count);
});
test('Vector recall retrieves an exact source 200 posts back; other room and solo secrets are absent',async()=>{
  const encoded=[];const f=fixture({embeddings:{retrieve:async()=>({memoryIds:['remember']}),vectors:async(s,texts)=>{encoded.push(...texts);return texts.map(t=>/сапфир|САПФИР/.test(t)?[1,0]:[0,1]);}}});
  f.state.multiplayer.messages=[{id:'anchor',role:'assistant',content:'Хранитель дал пароль САПФИР-731 и просил вернуть печать.'},...Array.from({length:200},(_,i)=>({id:'d'+i,role:'assistant',content:'Караван проходит по дороге '+i})),{id:'question',role:'user',name:'Петр',content:'Спроси у NPC, зачем нам выдали сапфирную печать и какой был пароль.'}];
  f.state.multiplayerHistories=[{id:'foreign',messages:[{id:'x',role:'assistant',content:'ROOM_SECRET'}]}];
  const result=await f.service.recall(f.state,roomChat(f.state.multiplayer));assert.equal(result.report.vectorStatus,'ready');assert.match(result.text,/САПФИР-731/);assert.equal(result.report.sources[0].index,0);
  assert.doesNotMatch(encoded.join('\n'),/SOLO_SECRET|ROOM_SECRET/);assert.ok(!sourceDocuments(roomChat(f.state.multiplayer)).some(d=>d.messageId==='question'));
});
test('Embedding outage is visible and uses source keyword fallback; abort is propagated',async()=>{
  const f=fixture({embeddings:{retrieve:async()=>{throw Error('HTTP 500');},vectors:async()=>{throw Error('HTTP 500');}}});
  f.state.multiplayer.messages=[{id:'old',role:'assistant',content:'Хранитель башни дал героям сапфирную печать.'},{id:'q',role:'user',content:'Кто такой хранитель башни?'}];
  const result=await f.service.recall(f.state,roomChat(f.state.multiplayer));assert.equal(result.report.vectorStatus,'fallback');assert.match(result.text,/сапфирную/);assert.match(result.warnings[0],/HTTP 500/);
  const signal=AbortSignal.abort();await assert.rejects(f.service.recall(f.state,roomChat(f.state.multiplayer),signal),/abort/i);
});
test('Battlemap default is the pinned SD21 checkpoint, complete three-guide workflow; custom map model stays separate',()=>{
  assert.equal(battlemapPreset.baseModel,'SD 2.1 768');assert.equal(battlemapWorkflow['1'].inputs.ckpt_name,battlemapPreset.model);
  const slots=Object.fromEntries(['depth','normal'].map(k=>[k,Object.entries(battlemapWorkflow).filter(([,n])=>n._meta?.title==='SAS_'+k.toUpperCase()).map(([id,node])=>({id,node}))]));
  assert.doesNotThrow(()=>assertMapGuides(battlemapWorkflow,slots));const bad=structuredClone(battlemapWorkflow);bad['12'].inputs.positive=['2',0];bad['12'].inputs.negative=['3',0];assert.throws(()=>assertMapGuides(bad,slots),/ControlNet/);
  const config=mapComfyConfig({model:'character.safetensors',mapModel:'my-map.safetensors'});assert.equal(config.model,'my-map.safetensors');assert.doesNotMatch(config.positivePrefix,/1girl|depth of field/);
  const s=sanitizeState({settings:{comfy:{model:'character.safetensors'}}});assert.equal(s.settings.comfy.mapModel,battlemapPreset.model);
});
test('Playable guide layers share 1024+ dimensions and top-down prompt; actor paths remain procedural',()=>{
  const map=generateMap({width:24,height:24,seed:1,descriptor:{title:'Таверна',environment:'interior',entrySide:'south',rooms:['Общий зал','Кухня'],visualPrompt:'medieval tavern, wood floor, tables beside walls'}});
  const layers=['layout','depth','normal'].map(k=>mapPNG(map,k));for(const p of layers){assert.equal(p.readUInt32BE(16),1024);assert.equal(p.readUInt32BE(20),1024);}
  assert.match(mapPrompt(map),/Battlemap, Dungeon/);assert.match(mapPrompt(map),/medieval tavern/);assert.match(mapPrompt(map),/no characters/);assert.ok(map.start.length>=4);
  const hall={...map,rooms:[map.rooms[0]],visualPrompt:'tavern interior, wood floor, tables and benches, staircase to second floor, a door to the north'};
  const prompt=mapPrompt(hall);assert.match(prompt,/one rectangular room/);assert.match(prompt,/tables and benches/);assert.doesNotMatch(prompt,/staircase|door to/);assert.match(mapPrompt({...hall,environment:'outdoor'}),/Outdoor/);
});
test('Model installer streams checksummed files, reuses verified files and preserves existing different contents',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sas-map-assets-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'main.py'),'');await fs.mkdir(path.join(root,'models'));
  const data=Buffer.from('test model'),files=[{directory:'checkpoints',name:'test.safetensors',bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),url:'https://example.invalid/model'}];let calls=0;
  const fetcher=async()=>{calls++;return new Response(data);};const options={fetcher,files};
  const result=await installBattlemapAssets(root,options);assert.equal(result.files.length,1);await installBattlemapAssets(root,options);assert.equal(calls,1);
  await fs.writeFile(result.files[0],'user model');await assert.rejects(installBattlemapAssets(root,options),/другим содержимым/);assert.equal(await fs.readFile(result.files[0],'utf8'),'user model');
});

test('Local embedding cache survives a changed server port but invalidates when model bytes change',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-embedding-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const model=path.join(dir,'encoder.gguf');await fs.writeFile(model,'model v1');let calls=0;
  const fetcher=async(url,options)=>{calls++;const body=JSON.parse(options.body);return new Response(JSON.stringify(String(url).endsWith('/tokenize')?{tokens:[1,2]}:{data:body.input.map((_,index)=>({index,embedding:[1,0,1]}))}));};
  const state={activeConnectionId:'sas-embedding',connections:[{id:'sas-embedding',baseUrl:'http://localhost:1111/v1',model:'bge-m3',embeddingTokenLimit:512}],settings:{embeddingModelPath:model,embeddings:{}}};
  const first=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher});await first.vectors(state,['Old event']);assert.equal(calls,2);
  state.connections[0].baseUrl='http://localhost:2222/v1';
  const restarted=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher});assert.deepEqual(await restarted.vectors(state,['Old event']),[[1,0,1]]);assert.equal(calls,2);
  await fs.writeFile(model,'updated model bytes');await restarted.vectors(state,['Old event']);assert.equal(calls,4);
});

test('Widened corridors still have closed doors spanning their width',()=>{
  const map=generateMap({width:24,height:24,seed:73,descriptor:{title:'Rooms',environment:'interior',entrySide:'south',rooms:['Hall','Kitchen'],visualPrompt:''}});
  assert.ok(map.doors.length>=2);assert.ok(map.doors.some((a,i)=>map.doors.some((b,j)=>i!==j&&Math.abs(a.x-b.x)+Math.abs(a.y-b.y)===1)));
  for(const d of map.doors)assert.equal(map.tiles[d.y*map.width+d.x],0);
});

test('Local Alpaca retains system instructions and all four users in one instruction boundary',()=>{
  const source=[{role:'system',content:'Game master rules'},...Array.from({length:4},(_,i)=>({role:'user',content:'PLAYER_'+i})),{role:'system',content:'End the round'}],before=structuredClone(source);
  const result=modelMessages({id:'sas-local',promptFormat:'alpaca'},source);assert.equal(result.length,1);assert.equal(result[0].role,'user');assert.match(result[0].content,/Game master rules/);assert.match(result[0].content,/End the round/);for(let i=0;i<4;i++)assert.match(result[0].content,new RegExp('PLAYER_'+i));assert.deepEqual(source,before);
  assert.equal(modelMessages({id:'remote',promptFormat:'alpaca'},source),source);assert.equal(modelMessages({id:'sas-local'},source),source);
  const turns=modelMessages({id:'sas-local',promptFormat:'alpaca'},[{role:'user',content:'one'},{role:'assistant',content:'answer'},{role:'user',content:'two'}]);assert.equal(turns.length,3);assert.equal(turns[1].content,'answer');
});

test('Long-post protocols preserve original questions and late numbers without fabricated model prose',()=>{
  const text='Ирис просит хранителя напомнить пароль. '+('Свет фонаря падает на стол. '.repeat(250))+' Она обещает принести 37 монет. Какой срок возврата?';
  const compact=extractiveProtocol(text,500);assert.ok(compact.length<=500);assert.match(compact,/Ирис просит/);assert.match(compact,/37/);assert.match(compact,/Какой срок/);assert.equal(compact.match(/Свет фонаря/g)?.length,1);
});

test('Four player queries each reserve an archive source even when one query dominates global similarity',async()=>{
  const v=t=>{const match=t.match(/TOPIC_(\d)/);if(!match)return [0,0,0,0,0];const n=Number(match[1]),vector=[0,0,0,0,0];vector[n]=1;return /SOURCE/.test(t)&&n>0?vector.map((x,i)=>x*.5+(i===4?.8:0)):vector;};
  const f=fixture({embeddings:{retrieve:async()=>({}),vectors:async(s,texts)=>texts.map(v)}});
  f.state.multiplayer.messages=[...Array.from({length:7},(_,i)=>({id:'a'+i,role:'assistant',content:'SOURCE TOPIC_'+(i<4?0:i-3)})),...Array.from({length:4},(_,i)=>({id:'p'+i,role:'user',name:'Player '+i,content:'QUESTION TOPIC_'+i}))];
  const result=await f.service.recall(f.state,roomChat(f.state.multiplayer));assert.equal(result.report.sources.length,4);for(const id of ['a4','a5','a6'])assert.ok(result.report.sources.some(s=>s.messageId===id),id);
});

test('A repeated user question does not displace the archived NPC answer',async()=>{
  const f=fixture({embeddings:{retrieve:async()=>({}),vectors:async(s,texts)=>texts.map(t=>t.includes('пароль САПФИР')?[.9,.3]:[1,0])}});
  f.state.multiplayer.messages=[{id:'answer',role:'assistant',content:'Эльдор сообщил пароль САПФИР-731.'},...Array.from({length:6},(_,i)=>({id:'prior-question-'+i,role:'user',content:'Ирис просит: какой пароль?'})),{id:'round',role:'assistant',content:'Ответ ведущего.'},{id:'current',role:'user',content:'Ирис просит напомнить пароль из давней встречи.'}];
  const r=await f.service.recall(f.state,roomChat(f.state.multiplayer));assert.equal(r.report.sources[0].messageId,'answer');assert.match(r.report.sourceExcerpts[0].text,/731/);
});
