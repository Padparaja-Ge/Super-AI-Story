import test from 'node:test';
import assert from 'node:assert/strict';
import {recallArchive} from '../server/archive-recall.mjs';
import {recallChatArchive} from '../server/chat-archive.mjs';
import {createRoomMemory,roomChat} from '../server/room-memory.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {buildFanficMessages,approvedMemories,contentHash} from '../server/fanfic.mjs';
import {resolveFanficContext} from '../server/fanfic-context.mjs';

const scope='chat:one';
const source=(id,text,metadata={})=>({id,text,metadata:{kind:'source',role:'assistant',scope,...metadata}});
const summary=(id,text)=>source(id,text,{kind:'memory',automatic:true});
const location='Напомни, где сейчас лежит янтарный компас?';
const earlier='Янтарный компас лежал под лестницей.';
const found='Лира нашла янтарный компас в сундуке.';
const old=source('old',earlier);
const later=source('later',found);

test('Beta 2 expands the shortlist with new scene-related candidates',async()=>{
 const documents=Array.from({length:208},(_,i)=>source(String(i),i===37?'У старого скрипача есть запасной ключ от боковой двери.':'Рыбак чинит сеть у причала '+i+'.'));
 const calls=[];
 const result=await recallArchive({scope,version:2,query:'Как пройти незаметно?',relatedQuery:'Как пройти незаметно и чем может помочь старый скрипач?',documents,
   embed:texts=>{calls.push(texts);return texts.map(text=>/пройти|скрипача/iu.test(text)?[1,0]:[0,1]);}});
 assert.equal(result.report.stage,'context');
 assert.deepEqual(result.results.map(r=>r.chunk.metadata.documentId),['37']);
 assert.ok(!calls[0].some(text=>text.includes('запасной')));
 assert.ok(calls[1].some(text=>text.includes('запасной')));
 assert.ok(result.report.candidates<=28);
});

test('Beta 2 searches unvisited neighbours on the third pass and bounds the work',async()=>{
 const documents=Array.from({length:150},(_,i)=>source(String(i),i===0?'У пролёта висит шнурок.':i===1?'После трёх ударов привратник открывает калитку.':i>=22&&i<49?'Рыбаки чинят фонарь возле причала '+i+'.':'Сосны стоят далеко у пустыря '+i+'.'));
 const calls=[];
 const result=await recallArchive({scope,version:2,query:'Как открыть пролёт?',relatedQuery:'Как открыть пролёт? Фонарь и причал.',documents,
  embed:texts=>{calls.push(texts);return texts.map(text=>/трёх ударов|открыть/iu.test(text)?[1,0]:/шнурок/iu.test(text)?[.6,.8]:[0,1]);}});
 assert.equal(result.report.stage,'deep');
 assert.ok(result.results.some(row=>row.chunk.metadata.documentId==='1'));
 assert.ok(!calls[0].some(text=>text.includes('трёх ударов')));
 assert.ok(!calls[1].some(text=>text.includes('трёх ударов')));
 assert.ok(calls[2].some(text=>text.includes('трёх ударов')));
 assert.ok(result.report.candidates<=48);
 const all=calls.flat();
 assert.equal(all.length,new Set(all).size);
});

test('Beta 2 returns a newer confirmed location with exact offsets and leaves the mover unknown',async()=>{
 const documents=[old,source('guess','Я думаю, стражник перенёс янтарный компас на крышу.',{role:'user',characterId:'hero'}),
  source('rumor','— Стражник перенёс янтарный компас на крышу, — сказала Ада. Цитата кончилась.'),
  source('speculation','Возможно, стражник перенёс янтарный компас на крышу.'),
  summary('summary','Стражник перенёс янтарный компас на крышу.'),later,
  source('foreign','Артём перенёс янтарный компас на крышу.',{scope:'chat:elsewhere'})];
 const vectors=[];
 const embed=texts=>{vectors.push(...texts);return texts.map(()=>[1,0]);};
 const result=await recallArchive({scope,version:2,query:location,documents,embed});
 assert.equal(result.report.evidence,'found');
 assert.deepEqual(result.results.map(r=>r.chunk.metadata.documentId),['later']);
 const {chunk}=result.results[0];
 assert.equal(chunk.metadata.evidenceStatus,'narration');
 assert.equal(chunk.content,later.text.slice(chunk.metadata.start,chunk.metadata.end));
 const expanded=await recallArchive({scope,version:2,query:location,documents:[
  old,source('longer','Над башней идёт дождь. '+found+' Лира ушла к воротам.')],embed});
 assert.equal(expanded.results[0].chunk.content,found);
 assert.equal(expanded.results[0].chunk.metadata.start,'Над башней идёт дождь. '.length);
 const focused=await recallArchive({scope,version:2,query:'Лира: '+location+' Ответь одним предложением.',documents,embed});
 assert.deepEqual(focused.results.map(row=>row.chunk.metadata.documentId),['later']);
 assert.doesNotMatch(vectors.join(' '),/крышу|стражник/iu);
 const mover=await recallArchive({scope,version:2,query:'Кто перенёс янтарный компас?',documents,embed});
 assert.equal(mover.report.evidence,'unknown');
 assert.deepEqual(mover.results,[]);
 const confirmed=source('engine','Подтверждённый результат движка: Марк перенёс янтарный компас в башню.',{role:'user',messageKind:'engine'});
 const known=await recallArchive({scope,version:2,query:'Кто перенёс янтарный компас?',documents:[...documents,confirmed],embed});
 assert.equal(known.results[0].chunk.metadata.evidenceStatus,'engine');
});

test('Beta 2 flags conflicting locations, ignores unrelated adjacent objects, and handles a disabled encoder',async()=>{
 const documents=[old,source('else','Янтарный компас лежит на столе.'),source('other','Ключ лежит рядом с янтарным компасом под ковром.')];
 const result=await recallArchive({scope,version:2,query:location,documents,embed:()=>{throw new Error('unavailable');}});
 assert.equal(result.report.vectorStatus,'fallback');
 assert.equal(result.report.evidence,'conflict');
 assert.deepEqual(result.results.map(r=>r.chunk.metadata.documentId),['else','old']);
 assert.ok(result.results.every(r=>r.chunk.metadata.evidenceConflict));
});

const settings={archiveMemory:true,archiveMemoryVersion:2,vectorMemory:true,memoryMode:'hybrid',memoryBudget:1000,historyLimit:4,loreBudget:1000};
const post=(id,role,content,extra={})=>({id,role,content,...extra});
const messages=[post('old','assistant',earlier),post('proposal','user','Стражник перенёс янтарный компас на крышу.',{characterId:'hero'}),
 post('found','assistant',found),post('asking','user',location)];
const connection={id:'llm',model:'test',contextWindow:4096,maxTokens:250};
const state={settings:{embeddings:{connectionId:'embedding',threshold:.3}},connections:[connection,{id:'embedding',model:'encoder',baseUrl:'http://127.0.0.1:1000/v1'}],
 activeConnectionId:'llm',characters:[{id:'hero',name:'Лира'}],personas:[],lorebooks:[],presets:[]};
const embeddings={vectors:(_state,texts)=>texts.map(()=>[1,0])};

test('Beta 2 reaches solo, D&D, custom and Big Room prompts while preserving the Beta 1 option',async()=>{
 const chat={id:'one',characterId:'hero',messages,memory:[],summary:'Автосводка утверждает, будто компас на крыше.',memorySettings:settings};
 const live={...state,chats:[chat]};
 const recall=await recallChatArchive(live,chat,location,undefined,embeddings);
 const prompt=buildPrompt(live,chat.id,location,recall.retrieval);
 const packed=prompt.includedSourceExcerpts;
 assert.equal(packed[0].messageId,'found');
 assert.equal(packed[0].evidenceStatus,'narration');
 assert.ok(prompt.messages.some(m=>m.content.includes('"status":"narration"')));
 assert.doesNotMatch(prompt.messages.find(m=>m.role==='system').content,/Автосводка/iu);
 const beta1=await recallChatArchive(live,{...chat,memorySettings:{...settings,archiveMemoryVersion:1}},location,undefined,embeddings);
 assert.equal(beta1.report.archiveRecall.version,undefined);
 for(const mode of ['dnd','custom','bigroom']){
  const roomMessages=messages.map(message=>message.id==='found'&&mode==='bigroom'?{...message,characterId:'other-npc',name:'Ада'}:message);
  const room={id:'one-'+mode,mode,scene:{location:'Башня'},messages:roomMessages,memory:[],memorySettings:settings,tactical:{round:4,actors:[]}};
  const roomState={...state,multiplayer:room};
  const memory=createRoomMemory({getState:()=>roomState,saveState:()=>{},getSecret:()=>'',embeddings});
  const result=await memory.recall(roomState,roomChat(room,{characterId:'hero'}));
  assert.equal(result.report.archiveRecall.version,2);
  assert.equal(result.report.archiveRecall.scope,'room:'+room.id);
  assert.ok(result.report.sourceExcerpts.some(chunk=>chunk.messageId==='found'&&chunk.evidenceStatus==='narration'&&chunk.text===found),mode);
  assert.ok(result.report.sourceExcerpts.every(chunk=>chunk.messageId!=='proposal'&&chunk.messageId!=='asking'));
 }
});

test('Beta 2 Fanfic uses only eligible approved episode text and exposes chronology and status in the prompt',async()=>{
 const episode=(id,number,content,status='approved')=>({id,title:id,season:1,number,content,status,
   memory:{summary:'Автосводка утверждает, будто компас на крыше.',sourceHash:contentHash(content)}});
 const current={id:'current',season:1,number:5,brief:location,content:''};
 const project={id:'fanfic',settings:{...settings,memoryThreshold:.3},characters:[],personas:[],lorebooks:[],
   episodes:[episode('final',4,found),episode('first',1,earlier),episode('draft',3,'Фальк перенёс янтарный компас на крышу.','draft'),
     current,episode('future',6,'Янтарный компас теперь лежит в колодце.')]};
 const ctx=await resolveFanficContext({state,project,episode:current,memories:approvedMemories(project,current),instructions:location,embeddings});
 assert.equal(ctx.archiveEvidence.evidence,'found');
 assert.deepEqual(ctx.archive.map(item=>[item.episodeId,item.season,item.number,item.evidenceStatus,item.excerpt]),[['final',1,4,'approved-prose',found]]);
 const prompt=buildFanficMessages({project,episode:current,connection,instructions:location,...ctx});
 assert.ok(prompt.messages[1].content.includes('"evidenceStatus":"approved-prose"'));
 assert.doesNotMatch(prompt.messages[1].content,/крыше|крышу|колодце/iu);
});


test('D&D Beta 2 does not revive an older location when the latest evidence removes the object',async()=>{
 const messages=[
  post('old-place','assistant','Янтарный компас лежал под лестницей.'),
  post('moved','assistant','Лира переложила янтарный компас в сундук.'),
  post('chest','assistant','Янтарный компас лежит в сундуке.'),
  post('removed','assistant','Янтарный компас теперь не лежит в сундуке.'),
  post('rumor','assistant','— Янтарный компас перенесли на крышу, — сказал Орвин.'),
  post('asking','user',location,{userId:'host'}),
 ];
 const room={id:'vanishing-compass',mode:'dnd',scene:{location:'Крепость'},messages,memory:[],memorySettings:settings,tactical:{round:4,actors:[]}};
 const roomState={...state,multiplayer:room};
 const memory=createRoomMemory({getState:()=>roomState,embeddings});
 const recall=()=>memory.recall(roomState,roomChat(room),undefined,{focusQuery:location});
 const missing=await recall();
 assert.equal(missing.report.archiveRecall.evidence,'unknown');
 assert.deepEqual(missing.report.sourceExcerpts,[]);
 messages.find(m=>m.id==='removed').content='Янтарный компас лежит не в сундуке.';
 assert.equal((await recall()).report.archiveRecall.evidence,'unknown');
 messages.find(m=>m.id==='removed').content='Лира не нашла янтарный компас в сундуке.';
 const unproven=await recall();
 assert.equal(unproven.report.archiveRecall.evidence,'found');
 assert.deepEqual(unproven.report.sourceExcerpts.map(item=>item.messageId),['chest']);
 messages.find(m=>m.id==='removed').content='Янтарный компас теперь не лежит в сундуке.';
 messages.splice(-1,0,post('found-again','assistant','Лира нашла янтарный компас во дворе.'));
 const rediscovered=await recall();
 assert.equal(rediscovered.report.archiveRecall.evidence,'found');
 assert.deepEqual(rediscovered.report.sourceExcerpts.map(item=>item.messageId),['found-again']);
});
