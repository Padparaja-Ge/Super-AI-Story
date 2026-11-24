import test from 'node:test';
import assert from 'node:assert/strict';
import {recallArchive} from '../server/archive-recall.mjs';
import {recallChatArchive} from '../server/chat-archive.mjs';
import {createRoomMemory,roomChat} from '../server/room-memory.mjs';
import {buildPrompt,messageTokens} from '../server/prompt.mjs';
import {resolveFanficContext} from '../server/fanfic-context.mjs';
import {approvedMemories,buildFanficMessages,contentHash} from '../server/fanfic.mjs';
import {fanficReviewReferences} from '../server/fanfic-review.mjs';
import {fanficDefaults} from '../shared/fanfic.mjs';

const focus='Напомни, где лежит янтарный компас?';
const answer='Янтарный компас лежит в серебряном футляре под третьей ступенью башни.';
const filler='Отряд миновал трактир и направился через пустырь. ';
const baseState={
 settings:{embeddings:{connectionId:'embed',model:'test-embedding',threshold:.4},historyLimit:4,memoryBudget:1200},
 characters:[{id:'iris',name:'Ирис',lorebookIds:[]}],personas:[],lorebooks:[],presets:[],
 connections:[{id:'llm',model:'test-llm',contextWindow:8192,maxTokens:512},{id:'embed',model:'test-embedding',baseUrl:'http://127.0.0.1:17864/v1'}],
 activeConnectionId:'llm'
};
const post=(id,role,content,extra={})=>({id,role,content,createdAt:new Date(Date.UTC(2026,0,1,0,0,Number(id)||0)).toISOString(),...extra});
const memorySettings={memoryMode:'hybrid',vectorMemory:true,archiveMemory:true,historyLimit:4};
const isolate=scope=>({scope,kind:'source'});
const useVectors=(texts)=>texts.map(text=>text.includes('компас')?[1,0]:[0,1]);

test('archive beta skips embeddings when the compact context already contains grounded evidence',async()=>{
 const result=await recallArchive({scope:'chat:iris',query:focus,recentEvidence:[answer],documents:[{id:'old',text:'Старый факт'}],
  embed:()=>assert.fail('Covered request must not invoke the embedding API')});
 assert.deepEqual(result.results,[]);
 assert.equal(result.report.stage,'recent');
 assert.equal(result.report.embeddingPasses,0);
});

test('recent questions and uncertainty do not hide an answer in the archive',async()=>{
 for(const [query,recent] of [
  [focus,'Янтарный компас лежит в серебряном футляре под третьей ступенью башни?'],
  [focus,'Никто в отряде пока не знает, где лежит янтарный компас, и всё ещё ищет его в башне.'],
  ['Remind me where the amber compass is hidden.','Nobody in the party knows where the amber compass is hidden.'],
  ['Remind me where the amber compass is hidden.','They don’t know where the amber compass is hidden.']
 ]){
  const result=await recallArchive({scope:'chat:iris',query,recentEvidence:[recent],
   documents:[{id:'old',text:'Янтарный компас лежит под лестницей. The amber compass is hidden under the third step.'}],
   embed:texts=>texts.map(()=>[1,0])});
  assert.equal(result.report.stage,'semantic');
  assert.equal(result.results[0]?.chunk.metadata.documentId,'old');
 }
});

test('archive beta scans all original passages, rejects other scopes and bounds embedding work',async()=>{
 const documents=Array.from({length:340},(_,i)=>({id:'room-'+i,text:i===2?filler.repeat(90)+answer:filler,metadata:isolate('room:one')}));
 documents.splice(2,0,{id:'different-history',text:answer+' чужая история',metadata:isolate('room:two')});
 const calls=[];
 const result=await recallArchive({scope:'room:one',query:focus,documents,embed:texts=>{calls.push(texts);return useVectors(texts);}});
 assert.equal(result.report.stage,'semantic');
 assert.ok(result.report.scanned>340);
 assert.ok(result.report.candidates<=24);
 assert.equal(calls.length,1);
 assert.ok(calls[0].every(text=>!text.includes('чужая история')));
 assert.match(result.results[0].chunk.content,/под третьей ступенью/);
 assert.equal(result.results[0].chunk.metadata.documentId,'room-2');
 assert.ok(result.results.length<=3);
 assert.ok(result.results.every(result=>result.chunk.content.length<=650));
});

test('an old rare keyword survives pruning in a long archive when embeddings are unavailable',async()=>{
 const documents=[{id:'forgotten',text:'Яшма была у затонувшего купца.'},...Array.from({length:145},(_,i)=>({id:'common-'+i,text:'Осмотрены ворота.'}))];
 const result=await recallArchive({scope:'room:long',query:'ворота яшма',documents});
 assert.equal(result.report.vectorStatus,'fallback');
 assert.equal(result.report.scanned,documents.length);
 assert.equal(result.results[0].chunk.metadata.documentId,'forgotten');
});

test('recent scene anchors shortlist old context outside the uniform sample',async()=>{
 const documents=Array.from({length:205},(_,i)=>({id:'story-'+i,text:i===37?'У старого скрипача хранится кольцо.':'Сторож чинит старую рыболовную сеть.'}));
 const calls=[];
 const result=await recallArchive({scope:'room:scene',query:'Как это забрать?',relatedQuery:'Ранее был разговор про старого скрипача',documents,
   embed:texts=>{calls.push(texts);return texts.map(text=>/забрать|скрипача/iu.test(text)?[1,0]:[.6,.8]);}});
 assert.ok(calls[0].some(text=>text.includes('хранится кольцо')));
 assert.deepEqual(result.results.map(item=>item.chunk.metadata.documentId),['story-37']);
 assert.ok(result.report.candidates<=24);
});

test('weak semantic results trigger at most one query-only refinement and fall back on errors',async()=>{
 const documents=[{id:'guide',text:'Секретная карта указывает на северную шахту.'}];
 const calls=[];
 const refined=await recallArchive({scope:'chat:one',query:'Как найти выход?',relatedQuery:'Северная шахта карта',documents,
  embed:texts=>{calls.push(texts);return calls.length===1?[[1,0],[0,1]]:[[0,1]];}});
 assert.equal(refined.report.stage,'refined');
 assert.equal(refined.report.embeddingPasses,2);
 assert.deepEqual(calls.map(call=>call.length),[2,1]);
 assert.equal(refined.results[0].chunk.metadata.documentId,'guide');
 const fallback=await recallArchive({scope:'chat:one',query:'Секретная карта',documents,embed:()=>{throw Error('offline');}});
 assert.equal(fallback.report.vectorStatus,'fallback');
 assert.equal(fallback.results[0].chunk.metadata.documentId,'guide');
 await assert.rejects(recallArchive({scope:'chat:one',query:focus,documents,signal:AbortSignal.abort()}),{name:'AbortError'});
});

test('solo recall uses original chat only and prompt budget protects recent exchange',async()=>{
 const chat={id:'chat',characterId:'iris',messages:[post('1','assistant',answer)],memory:[],scene:{},memorySettings};
 for(let i=2;i<11;i++)chat.messages.push(post(String(i),i%2?'assistant':'user',filler));
 chat.messages[chat.messages.length-5]=post('6','user',focus);
 const other={...chat,id:'foreign',messages:[post('90','assistant',answer+' FOREIGN_MARKER')]};
 const state={...baseState,chats:[chat,other]};
 const staged=await recallChatArchive(state,chat,focus,undefined,{vectors:(_state,texts)=>useVectors(texts)});
 assert.equal(staged.report.archiveRecall.scope,'chat:chat');
 assert.equal(staged.retrieval.sourceExcerpts[0].messageId,'1');
 const prompt=buildPrompt(state,chat.id,focus,staged.retrieval);
 assert.match(prompt.messages.map(item=>item.content).join(' '),/под третьей ступенью/);
 assert.doesNotMatch(prompt.messages.map(item=>item.content).join(' '),/FOREIGN_MARKER/);
 assert.equal(prompt.includedSourceExcerpts.length,1);
 assert.ok(messageTokens(prompt.messages)<=prompt.budget.available);
 const tinyState={...state,connections:state.connections.map(c=>c.id==='llm'?{...c,contextWindow:384,maxTokens:64}:c)};
 const tinyPrompt=buildPrompt(tinyState,chat.id,focus,staged.retrieval);
 assert.equal(tinyPrompt.includedSourceExcerpts.length,0);
 assert.equal(tinyPrompt.messages.at(-1).content,focus);
 assert.ok(messageTokens(tinyPrompt.messages)<=tinyPrompt.budget.available);
 assert.equal(await recallChatArchive(state,{...chat,memorySettings:{...memorySettings,archiveMemory:false}},focus),null);
 assert.equal(await recallChatArchive(state,{...chat,memorySettings:{...memorySettings,memoryMode:'pinned'}},focus),null);
});

test('D&D, custom adventures and big room query their own full archive with the configured encoder',async()=>{
 for(const mode of ['dnd','custom','bigroom']){
  const messages=[post('1','assistant',answer,{characterId:'iris',name:'Ирис'}),...Array.from({length:9},(_,i)=>post(String(i+2),'assistant',filler)),post('20','user',focus,{name:'Гость',personaName:'Лада'})];
  const room={id:'room-'+mode,mode,scene:{location:'Таверна'},messages,memory:[],memorySettings,tactical:mode!=='bigroom'?{round:2,actors:[]}:undefined};
  const state={...baseState,multiplayer:room};
  const roomMemory=createRoomMemory({getState:()=>state,saveState:()=>{},getSecret:()=>'',embeddings:{vectors:(_state,texts)=>useVectors(texts)}});
  const chat=roomChat(room,{characterId:'iris'});
  const found=await roomMemory.recall(state,chat);
  assert.equal(found.report.archiveRecall.scope,'room:'+room.id);
  assert.ok(found.report.sourceExcerpts.some(source=>source.messageId==='1'&&source.text.includes('третьей ступенью')));
  assert.ok(found.report.sourceExcerpts.every(source=>source.messageId!=='20'));
  assert.equal(!!found.retrieval.gameRag,mode!=='bigroom');
 }
});

test('fanfic retrieves original approved prose omitted by summaries and scopes by chronology through drafting and review',async()=>{
 const earlier={id:'earlier',title:'Скрытый футляр',season:1,number:1,status:'approved',content:filler.repeat(30)+answer};
 earlier.memory={sourceHash:contentHash(earlier.content),summary:'Герои исследовали башню.'};
 const draft={id:'draft',title:'Черновик',season:1,number:2,status:'draft',content:'Янтарный компас лежит в сундуке. UNAPPROVED_MARKER'};
 const current={id:'current',title:'Поиски',season:1,number:3,brief:focus,content:''};
 const future={...earlier,id:'future',number:4,content:answer+' FUTURE_MARKER'};
 future.memory={...earlier.memory,sourceHash:contentHash(future.content)};
 const project={id:'work',settings:{...fanficDefaults,vectorMemory:true,archiveMemory:true},episodes:[earlier,draft,current,future],characters:[],personas:[],lorebooks:[]};
 const state={...baseState},calls=[];
 const context=await resolveFanficContext({state,project,episode:current,memories:approvedMemories(project,current),embeddings:{vectors:(_state,texts)=>{calls.push(texts);return useVectors(texts);}},instructions:focus});
 assert.equal(context.report.archiveRecall.scope,'fanfic:work');
 assert.ok(context.archive.some(ref=>ref.excerpt.includes('третьей ступенью')));
 assert.ok(context.archive.every(ref=>ref.episodeId==='earlier'));
 assert.doesNotMatch(calls.flat().join(' '),/UNAPPROVED_MARKER|FUTURE_MARKER/);
 const prompt=buildFanficMessages({project,episode:current,connection:state.connections[0],instructions:focus,...context});
 assert.match(prompt.messages[1].content,/EARLIER APPROVED PROSE EXCERPTS[\s\S]*третьей ступенью/);
 assert.ok(prompt.included.archive.length);
 const reviewed=fanficReviewReferences({project,episode:current,context});
 assert.ok(reviewed.references.some(ref=>ref.kind==='approved-prose'&&ref.episodeId==='earlier'));
 earlier.needsReview=true;
 assert.ok(!fanficReviewReferences({project,episode:current,context}).references.some(ref=>ref.kind==='approved-prose'));
 const legacy=await resolveFanficContext({state,project:{...project,settings:{...project.settings,archiveMemory:false}},episode:current,memories:[],instructions:focus});
 assert.equal(legacy.report.archiveRecall,undefined);
});
