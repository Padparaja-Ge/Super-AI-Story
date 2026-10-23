import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createGameRag,gameMemoryPolicy,localEmbeddingConnection} from '../server/game-rag.mjs';
import {semanticChunkLorebook} from '../server/rag/chunking.mjs';
import {hybridSearch} from '../server/rag/search.mjs';
import {createRoomMemory,roomChat,roundMessages,sourceDocuments} from '../server/room-memory.mjs';
import {validMemory} from '../server/memory.mjs';

const fingerprint=m=>crypto.createHash('sha256').update(m.role+'\n'+m.content).digest('hex');
const when=i=>new Date(Date.UTC(2026,9,23,10,0,i)).toISOString();
function fixture({mode='dnd',memoryMode='hybrid',vectorMemory=true,url='http://127.0.0.1:3214/v1'}={}){
 const room={id:'ours',mode,personas:{host:{name:'Бог'}},scene:{location:'Башня'},lorebookIds:['world'],rulebookIds:['rules'],memorySettings:{memoryMode,vectorMemory,autoSummary:true,summaryInterval:2},memory:[],messages:[
  {id:'old',role:'assistant',content:'Арвин хранит пароль САПФИР-731 и северный ключ.',createdAt:when(0)},
  {id:'old-player',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Я попросил ключ у Арвина.',createdAt:when(1)},
  ...Array.from({length:5},(_,i)=>({id:'recent-'+i,role:i%2?'user':'assistant',...(i%2?{userId:'host',name:'AccountNickname',personaName:'Бог'}:{}),content:'RECENT_PROTECTED_'+i+' Свет на площади.',createdAt:when(i+2)})),
  {id:'current',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Напомни пароль САПФИР-731 и ключ Арвина.',createdAt:when(8)},
  {id:'dice',role:'user',kind:'dice',content:'DICE_SECRET_20',createdAt:when(9)},
  {id:'image',role:'assistant',kind:'image',content:'IMAGE_SECRET',createdAt:when(10)},
  {id:'draft',role:'assistant',interrupted:true,content:'INCOMPLETE_SECRET',createdAt:when(11)}
 ],tactical:{round:3,actors:[{id:'host',name:'Бог',player:true,hp:20},{id:'npc',name:'Арвин',player:false,hp:20}],eventArchive:[{id:'past-event',round:1,text:'Арвин: печать возвращена, пароль САПФИР-731.',at:when(0)},{id:'current-event',round:3,text:'CURRENT_ENGINE_PROTECTED',at:when(12)}]}};
 const state={activeConnectionId:'story',connections:[{id:'story',baseUrl:'http://127.0.0.1:3213/v1',model:'narrative'},{id:'encoder',baseUrl:url,model:'encoder',embeddingTokenLimit:512}],settings:{embeddings:{connectionId:'encoder',threshold:.35}},lorebooks:[
  {id:'world',name:'Наш мир',entries:[{id:'npc-lore',name:'Арвин',enabled:true,vectorized:true,content:'Арвин — хранитель северного ключа. Пароль САПФИР-731.'},{id:'lexical-lore',name:'Лексическая запись',enabled:true,vectorized:false,content:'LEXICAL_ONLY_DO_NOT_EMBED: Арвин назначил встречу у ворот.'},{id:'constant',name:'Постоянный факт',constant:true,content:'CONST_WORLD_FACT: небесные врата заперты.'},{id:'disabled',enabled:false,vectorized:true,content:'DISABLED_LORE_SECRET'}]},
  {id:'other-world',entries:[{id:'foreign',enabled:true,vectorized:true,content:'FOREIGN_LORE_SECRET'}]},
  {id:'rules',entries:[{id:'rule',enabled:true,vectorized:true,content:'RULEBOOK_NOT_WORLD_SECRET'}]}
 ],chats:[{id:'solo',memory:[{content:'SOLO_SECRET'}]}],fanficProjects:[{content:'FANFIC_SECRET'}],multiplayer:room,multiplayerHistories:[{id:'elsewhere',mode:'dnd',messages:[{role:'assistant',content:'OTHER_ROOM_SECRET'}]}]};
 const chat=roomChat(room);const source=chat.messages.find(m=>m.id==='old');room.memory.push({id:'automatic',automatic:true,enabled:true,content:'Арвин сохранил пароль САПФИР-731.',sources:[{id:source.id,hash:fingerprint(source),start:0,end:source.content.length}]},{id:'manual',automatic:false,enabled:true,content:'MANUAL_FACT: Арвин знает секрет северных ворот.'});
 return {state,room,chat:()=>roomChat(room)};
}
const rag=(embeddings,extra={})=>createGameRag({embeddings,sourceDocuments,roundMessages,...extra});
function nativeFixture(){
 const f=fixture({memoryMode:'off'});f.state.connections[1].id='sas-embedding';f.state.settings.embeddings.connectionId='sas-embedding';
 f.state.lorebooks[0].entries=[{id:'native-lore',name:'Справочник мира',vectorized:true,content:'NPC: Arvin\nArvin keeps the SAPPHIRE key. '.repeat(12)}];f.room.messages.find(m=>m.id==='current').content='Напомни пароль SAPPHIRE и ключ Arvin.';
 return f;
}
const nativeCount=text=>Array.from(text).length*3+2;
test('Zero lore or memory budget excludes that category before embedding',async()=>{
 const f=fixture();f.room.memorySettings.loreBudget=0;let encoded=[];
 const service=rag({vectors:async(_state,texts)=>{encoded=texts;return texts.map(()=>[1,.1]);}});
 let out=await service.recall(f.state,f.chat());assert.ok(!out.report.sources.some(s=>s.kind==='lore'));
 assert.doesNotMatch(encoded.slice(1).join('\n'),/LEXICAL_ONLY_DO_NOT_EMBED|CONST_WORLD_FACT|хранитель северного ключа/);
 f.room.memorySettings.memoryBudget=0;out=await service.recall(f.state,f.chat());assert.equal(out.retrieval.gameRagResults.length,0);
});
test('Always-on lore uses the same entity bonus formula as retrieved candidates',async()=>{
 const f=fixture({vectorMemory:false,memoryMode:'off'});f.state.lorebooks[0].entries=[{id:'always',name:'Арвин',constant:true,content:'Ремесленник у прилавка.'}];
 f.room.messages.find(m=>m.id==='current').content='Совсем посторонний запрос.';
 const out=await rag().recall(f.state,f.chat()),candidate=out.retrieval.gameRagResults.find(r=>r.chunk.metadata.entryId==='always');
 assert.ok(candidate);assert.equal(candidate.keywordScore,0);assert.equal(candidate.vectorScore,0);assert.ok(Math.abs(candidate.finalScore-.04)<1e-12);
});
test('A known narrative runtime cannot be used accidentally as the embedding runtime',async()=>{
 const f=fixture();f.state.connections[1].id='sas-local';f.state.settings.embeddings.connectionId='sas-local';
 const out=await rag({vectors:async()=>assert.fail('Narrative model must not receive embedding documents')}).recall(f.state,f.chat());
 assert.equal(out.report.vectorStatus,'fallback');assert.equal(out.report.rag.embeddingCalls,0);assert.ok(out.retrieval.gameRagResults.length);
});

test('D&D retrieval scopes every source before encoding, excludes recent/current posts and performs one local embedding call',async()=>{
 const f=fixture(),encoded=[],before=structuredClone(f.state),service=rag({vectors:async(_state,texts)=>{encoded.push(texts);return texts.map(()=>[1,.1]);}}),result=await service.recall(f.state,f.chat());
 assert.equal(encoded.length,1);assert.equal(result.report.rag.embeddingCalls,1);assert.equal(result.report.vectorStatus,'ready');assert.equal(result.text,'');assert.equal(result.retrieval.gameRag,true);assert.deepEqual(result.retrieval.memoryIds,[]);assert.deepEqual(result.retrieval.vectorLoreIds,[]);
 const payload=encoded[0].slice(1).join('\n');assert.match(payload,/САПФИР-731/);assert.doesNotMatch(payload,/SOLO_SECRET|FANFIC_SECRET|OTHER_ROOM_SECRET|FOREIGN_LORE_SECRET|DISABLED_LORE_SECRET|RULEBOOK_NOT_WORLD_SECRET|LEXICAL_ONLY_DO_NOT_EMBED|CONST_WORLD_FACT|INCOMPLETE_SECRET|DICE_SECRET|IMAGE_SECRET|CURRENT_ENGINE_PROTECTED|RECENT_PROTECTED_[1-4]/);
 const results=result.retrieval.gameRagResults;assert.ok(results.some(r=>r.chunk.metadata.kind==='source'));assert.ok(results.every(r=>r.chunk.metadata.scope==='room:ours'&&r.chunk.metadata.sourceHash.length===64&&r.chunk.metadata.documentId&&r.chunk.metadata.end>r.chunk.metadata.start));assert.deepEqual(f.state,before);
});
test('Lexical lore remains searchable when vector memory is disabled and non-vectorized lore never reaches encoder',async()=>{
 const f=fixture({vectorMemory:false});f.room.messages.at(-4).content='Арвин назначил встречу у ворот. LEXICAL_ONLY_DO_NOT_EMBED';
 const service=rag({vectors:()=>{throw Error('No encoder call expected');}}),result=await service.recall(f.state,f.chat());assert.equal(result.report.vectorStatus,'disabled');assert.equal(result.report.rag.embeddingCalls,0);assert.ok(result.retrieval.gameRagResults.some(r=>r.chunk.metadata.entryId==='lexical-lore'&&r.keywordScore>0));assert.ok(result.retrieval.gameRagResults.some(r=>r.chunk.metadata.entryId==='constant'));
});
test('Declared scene location, present NPCs and active quests pass through without being replaced by the tactical roster',async()=>{
 const f=fixture({vectorMemory:false});f.room.scene={location:'Old location',currentLocation:'Новая башня',presentNPCs:['Странник'],activeQuests:['Вернуть печать']};const chat=f.chat();assert.deepEqual(chat.gameScene,{currentLocation:'Новая башня',presentNPCs:['Странник'],activeQuests:['Вернуть печать']});assert.equal(chat.scene,f.room.scene);
 let observed;await rag(undefined,{search:async(_query,scene)=>{observed=scene;return [];}}).recall(f.state,chat);assert.deepEqual(observed,chat.gameScene);
});
test('Only configured loopback embeddings are permitted; external endpoints fall back to lexical retrieval without a call',async()=>{
 for(const url of ['https://example.com/v1','http://localhost.evil/v1','http://127.0.0.1.evil/v1','http://user:pass@localhost/v1']){
  const f=fixture({url}),service=rag({vectors:()=>{throw Error('External encoder must not receive sources');}}),result=await service.recall(f.state,f.chat());assert.equal(result.report.vectorStatus,'fallback');assert.equal(result.report.rag.embeddingCalls,0);assert.ok(result.warnings[0].includes('локальное'));assert.ok(result.retrieval.gameRagResults.length);
 }
 for(const url of ['http://localhost:123/v1','http://127.0.0.1:123/v1','http://[::1]:123/v1'])assert.ok(localEmbeddingConnection(fixture({url}).state));
 const f=fixture();f.state.settings.embeddings.connectionId='';assert.equal(localEmbeddingConnection(f.state),null);
});
test('Memory modes do not leak automatic notes or archive sources into off, summary, pinned or manual scopes',async()=>{
 for(const memoryMode of ['off','summary','pinned','manual','hybrid','full']){
  const f=fixture({memoryMode,vectorMemory:false}),result=await rag().recall(f.state,f.chat()),sources=result.report.sources,kinds=new Set(sources.map(s=>s.kind));assert.ok(sources.some(s=>s.kind==='lore'));
  if(memoryMode==='off'){assert.ok(!kinds.has('memory'));assert.ok(!kinds.has('source'));}
  if(['summary','pinned','manual'].includes(memoryMode))assert.ok(!kinds.has('source'));
  if(['pinned','manual'].includes(memoryMode)){assert.ok(sources.some(s=>s.memoryId==='manual'));assert.ok(!sources.some(s=>s.memoryId==='automatic'));}
  if(memoryMode==='summary'){assert.ok(sources.some(s=>s.memoryId==='automatic'));assert.ok(!sources.some(s=>s.memoryId==='manual'));}
 }
 assert.equal(gameMemoryPolicy({memorySettings:{memoryMode:'disabled'}}).memory,false);
});
test('Chunk manifests reuse unchanged sources and invalidate edits, deletions, selected books and settings without persisting cache into room state',async()=>{
 const f=fixture({vectorMemory:false});let chunkCalls=0;const service=rag(undefined,{chunkLorebook:(...args)=>{chunkCalls++;return semanticChunkLorebook(...args);}});
 await service.recall(f.state,f.chat());const first=chunkCalls;assert.ok(first>3);await service.recall(f.state,f.chat());assert.equal(chunkCalls,first);assert.ok(service.stats().hits>=first);
 f.state.lorebooks[0].entries[0].content='Арвин использует новый пароль РУБИН-592.';let result=await service.recall(f.state,f.chat());assert.equal(chunkCalls,first+1);assert.ok(result.retrieval.gameRagResults.some(r=>r.chunk.content.includes('РУБИН-592')));
 f.state.lorebooks[0].entries=f.state.lorebooks[0].entries.filter(e=>e.id!=='lexical-lore');result=await service.recall(f.state,f.chat());assert.ok(!result.report.sources.some(s=>s.entryId==='lexical-lore'));
 f.room.lorebookIds=[];result=await service.recall(f.state,f.chat());assert.ok(!result.report.sources.some(s=>s.kind==='lore'));
 f.room.memorySettings.memoryMode='off';result=await service.recall(f.state,f.chat());assert.deepEqual(result.retrieval.gameRagResults,[]);assert.equal(service.stats().documents,0);assert.equal(f.room.gameRag,undefined);
});
test('Room caches are bounded and deleted source memories never become valid again through stale chunks',async()=>{
 const f=fixture({vectorMemory:false}),service=rag(undefined,{maxRooms:2,maxSources:2,maxChunks:8});await service.recall(f.state,f.chat());assert.ok(service.stats().documents<=2);assert.ok(service.stats().chunks<=8);
 f.room.id='second';await service.recall(f.state,f.chat());f.room.id='third';await service.recall(f.state,f.chat());assert.equal(service.stats().rooms,2);assert.ok(service.stats().documents<=4);assert.ok(service.stats().chunks<=8);
 f.room.messages=f.room.messages.filter(m=>m.id!=='old');const result=await service.recall(f.state,f.chat());assert.ok(!result.report.sources.some(s=>s.memoryId==='automatic'||s.messageId==='old'));
});
test('Encoder failure keeps BM25 available while cancellation propagates and mismatched room scopes are rejected',async()=>{
 const f=fixture(),service=rag({vectors:async()=>{throw Error('HTTP 500');}}),result=await service.recall(f.state,f.chat());assert.equal(result.report.vectorStatus,'fallback');assert.ok(result.warnings.some(w=>/HTTP 500/.test(w)));assert.ok(result.retrieval.gameRagResults.some(r=>r.keywordScore>0));
 await assert.rejects(service.recall(f.state,f.chat(),AbortSignal.abort()),error=>error.name==='AbortError');
 await assert.rejects(service.recall(f.state,{...f.chat(),roomId:'different'}),/область/);
});
test('Native semantic chunks fit the actual encoder tokenizer and unchanged manifests do not tokenize again',async()=>{
 const f=nativeFixture(),encoded=[],observed=[];let counts=0,descriptors=0;
 const service=rag({nativeTokenizer:async()=>{descriptors++;return {identity:'native-model-a:128',tokenLimit:128,reserve:8,countTokens:async text=>{counts++;return nativeCount(text);}};},vectors:async(_state,texts)=>{encoded.push(texts);return texts.map(()=>[1,.1]);}},
  {search:async(query,scene,options)=>{observed.push(options.chunks);return hybridSearch(query,scene,options);}});
 const before=structuredClone(f.state),result=await service.recall(f.state,f.chat());assert.ok(counts>5);assert.equal(encoded.length,1);assert.ok(encoded[0].length>5);assert.ok(encoded[0].slice(1).every(text=>nativeCount(text)<=120));
 assert.equal(result.report.rag.tokenizer,'native');assert.equal(result.report.rag.nativeTokenLimit,120);assert.equal(result.report.vectorStatus,'ready');assert.equal(result.warnings.length,0);
 const chunks=observed[0],text=f.state.lorebooks[0].entries[0].content;assert.ok(chunks.every(c=>c.metadata.tokenization==='native'&&c.metadata.nativeTokenLimit===120&&c.content===text.slice(c.metadata.start,c.metadata.end)));assert.equal(chunks[0].metadata.start,0);assert.equal(chunks.at(-1).metadata.end,text.length);
 for(let i=1;i<chunks.length;i++)assert.ok(chunks[i].metadata.start<=chunks[i-1].metadata.end,'Native fallback must preserve the complete source');
 assert.ok(chunks.some(c=>c.metadata.name==='Arvin'));assert.ok(!chunks.some(c=>c.metadata.name==='Справочник мира'),'Entry captions must not overwrite inferred NPC names');
 const calls=counts;await service.recall(f.state,f.chat());assert.equal(counts,calls);assert.equal(descriptors,2);assert.equal(encoded.length,2);assert.ok(service.stats().hits>=1);assert.deepEqual(f.state,before);
});
test('Native tokenizer failure disables embedding for the entire recall, then recovered tokenization replaces unverified manifests',async()=>{
 const f=nativeFixture();f.state.lorebooks[0].entries.push({id:'second',vectorized:true,content:'Arvin owns another key. '.repeat(4)});let broken=true,counts=0,embeds=0;const observed=[];
 const service=rag({nativeTokenizer:async()=>({identity:'same-model',tokenLimit:128,reserve:8,countTokens:async text=>{counts++;if(broken)throw Error('Tokenizer HTTP 503');return nativeCount(text);}}),vectors:async(_state,texts)=>{embeds++;assert.ok(texts.slice(1).every(text=>nativeCount(text)<=120));return texts.map(()=>[1,.1]);}},
  {search:async(query,scene,options)=>{observed.push(options.chunks);return hybridSearch(query,scene,options);}});
 const first=await service.recall(f.state,f.chat());assert.equal(counts,1,'A failed tokenizer must not be retried for later sources in the same recall');assert.equal(embeds,0);assert.equal(first.report.rag.embeddingCalls,0);assert.equal(first.report.rag.tokenizer,'unavailable');assert.equal(first.report.vectorStatus,'fallback');assert.ok(first.warnings.some(w=>w.includes('HTTP 503')));assert.ok(first.retrieval.gameRagResults.some(r=>r.keywordScore>0));assert.ok(observed[0].every(c=>c.metadata.vectorized===false));
 broken=false;const recovered=await service.recall(f.state,f.chat());assert.ok(counts>1);assert.equal(embeds,1);assert.equal(recovered.report.rag.tokenizer,'native');assert.ok(observed[1].every(c=>c.metadata.tokenization==='native'));const verifiedCounts=counts;
 await service.recall(f.state,f.chat());assert.equal(counts,verifiedCounts);assert.equal(embeds,2);
});
test('Encoder identity and native token limit invalidate verified semantic manifests',async()=>{
 const f=nativeFixture();let identity='model-a',limit=128,counts=0;const batches=[];
 const service=rag({nativeTokenizer:async()=>({identity:identity+':'+limit,tokenLimit:limit,reserve:8,countTokens:async text=>{counts++;return nativeCount(text);}}),vectors:async(_state,texts)=>{assert.ok(texts.slice(1).every(text=>nativeCount(text)<=Math.min(512,limit-8)));batches.push(texts);return texts.map(()=>[1,.1]);}});
 await service.recall(f.state,f.chat());let previous=counts;identity='model-b';await service.recall(f.state,f.chat());assert.ok(counts>previous);previous=counts;
 limit=96;const result=await service.recall(f.state,f.chat());assert.ok(counts>previous);assert.equal(result.report.rag.nativeTokenLimit,88);assert.ok(batches[2].length>=batches[1].length);previous=counts;
 limit=2048;const large=await service.recall(f.state,f.chat());assert.ok(counts>previous);assert.equal(large.report.rag.nativeTokenLimit,512,'Native model capacity does not relax the hard 512-token RAG chunk limit');
});
test('Native tokenizer cancellation propagates without marking or embedding a partial manifest',async()=>{
 const f=nativeFixture(),controller=new AbortController();let aborted=true,counts=0,embeds=0;
 const service=rag({nativeTokenizer:async()=>({identity:'model-a',tokenLimit:128,reserve:8,countTokens:async text=>{counts++;if(aborted){controller.abort();controller.signal.throwIfAborted();}return nativeCount(text);}}),vectors:async(_state,texts)=>{embeds++;return texts.map(()=>[1,.1]);}});
 await assert.rejects(service.recall(f.state,f.chat(),controller.signal),error=>error.name==='AbortError');assert.equal(counts,1);assert.equal(embeds,0);assert.equal(service.stats().documents,0);
 aborted=false;await service.recall(f.state,f.chat());assert.ok(counts>1);assert.equal(embeds,1);
 const noSignalService=rag({nativeTokenizer:async()=>({identity:'model-b',tokenLimit:128,reserve:8,countTokens:async()=>{throw new DOMException('Cancelled','AbortError');}}),vectors:()=>{throw Error('Must not embed');}});
 await assert.rejects(noSignalService.recall(f.state,f.chat()),error=>error.name==='AbortError');
});
test('Native tokenizer absence keeps lexical retrieval usable and custom local encoders explicitly report approximate bounds',async()=>{
 const f=nativeFixture(),service=rag({vectors:()=>{throw Error('Must not embed unverified chunks');}}),result=await service.recall(f.state,f.chat());assert.equal(result.report.vectorStatus,'fallback');assert.equal(result.report.rag.embeddingCalls,0);assert.equal(result.report.rag.tokenizer,'unavailable');assert.ok(result.retrieval.gameRagResults.length);assert.ok(result.warnings.some(w=>w.includes('счётчик')));
 const custom=fixture(),approx=await rag({vectors:async(_state,texts)=>texts.map(()=>[1,.1])}).recall(custom.state,custom.chat());assert.equal(approx.report.rag.tokenizer,'approximate');assert.equal(approx.report.rag.nativeTokenLimit,undefined);assert.ok(approx.warnings.some(w=>w.includes('приближённо')));
});
test('D&D/custom summaries are bounded extractive Node work with exact source hashes, preserving recent posts and other stories',async()=>{
 for(const mode of ['dnd','custom']){
  const f=fixture({mode,vectorMemory:false});f.room.memory=[];f.room.messages=[...Array.from({length:24},(_,i)=>({id:'m'+i,role:i%3===2?'assistant':'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:`Арвин сохранил ключ ${i+100} в башне. Подтверждённое событие.`,createdAt:when(i)})),{id:'new-post',role:'user',userId:'host',personaName:'Бог',content:'CURRENT_ACTION_KEEP_FULL',createdAt:when(29)}];f.room.tactical.eventArchive=[];
  const original=structuredClone(f.room.messages),solo=structuredClone(f.state.chats),service=createRoomMemory({getState:()=>structuredClone(f.state),saveState:s=>{Object.assign(f.state,s);f.room=f.state.multiplayer;},getSecret:()=>{throw Error('No model secret expected');},completion:()=>{throw Error('A game summary must not call a model');}});
  const result=await service.summarize('ours');assert.ok(result.blocks>0);const chat=roomChat(f.state.multiplayer),byId=new Map(chat.messages.map(m=>[m.id,m]));assert.equal(validMemory(chat).length,result.blocks);
  for(const block of chat.memory){assert.equal(block.method,'extractive-v1');assert.ok(block.content.length<=1450);for(const source of block.sources){assert.equal(source.hash,fingerprint(byId.get(source.id)));assert.ok(source.start>=0&&source.end<=byId.get(source.id).content.length);assert.notEqual(source.id,'new-post');assert.ok(!['m20','m21','m22','m23'].includes(source.id));}}
  assert.deepEqual(f.state.multiplayer.messages,original);assert.deepEqual(f.state.chats,solo);const again=await service.summarize('ours');assert.equal(again.blocks,0);
 }
});
test('Extractive summaries reject source edits or abort before saving any derived block',async()=>{
 const f=fixture({vectorMemory:false});f.room.messages.unshift(...Array.from({length:8},(_,i)=>({id:'past-'+i,role:'assistant',content:'Арвин помнит печать '+i,createdAt:'2025-'+i})));f.room.memory=[];
 const service=createRoomMemory({getState:()=>structuredClone(f.state),saveState:s=>Object.assign(f.state,s),getSecret:()=>'',completion:()=>{throw Error('No model');}});
 await assert.rejects(service.summarize('ours',{signal:AbortSignal.abort()}),error=>error.name==='AbortError');assert.equal(f.state.multiplayer.memory.length,0);
 await assert.rejects(service.summarize('ours',{onProgress:()=>{f.state.multiplayer.messages.find(m=>m.id==='past-0').content='Изменённый источник';}}),/изменились/);assert.equal(f.state.multiplayer.memory.length,0);
});
