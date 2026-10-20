import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTasks} from '../server/tasks.mjs';
import {createStore,sanitizeState} from '../server/store.mjs';
import {createFanfic,contentHash,approvedMemories,buildFanficMessages} from '../server/fanfic.mjs';
import {startServer} from '../server/index.mjs';
import {validateCanonExtraction} from '../server/fanfic-canon.mjs';
import {messageTokens} from '../server/prompt.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){
  for(let i=0;i<250;i++){const result=predicate();if(result)return result;await pause(10);}
  throw new Error('Fanfic test timed out');
}

async function fixture(t){
  let state=sanitizeState({}),structuredHandler=args=>args.name==='fanfic_outline'
    ?{scenes:[{title:'Встреча',summary:'Герои встретились у обсерватории.'},{title:'Находка',summary:'Герои нашли карту.'}]}
    :{summary:'Важные события: '+args.context.prose,location:'Обсерватория',relationships:['Герои доверяют друг другу.'],openThreads:['Разгадать карту.']},
    streamHandler=async function*(){yield 'Первая сцена.';};
  state.connections[0].model='mock-fanfic';
  state.connections[0].contextWindow=8192;
  const tasks=createTasks(),structuredCalls=[],streamCalls=[],vectorCalls=[];
  let vectorHandler=texts=>texts.map(()=>[1,0,0]),tokenHandler=async()=>null;
  const getState=()=>structuredClone(state),saveState=next=>{state=sanitizeState(next);state.revision++;return getState();};
  const service=createFanfic({getState,saveState,getSecret:()=>'',tasks,
    countTokens:async(...args)=>tokenHandler(...args),
    structured:async args=>{const recorded=Array.isArray(args.context?.prose)?{...args,context:{...args.context,sourceBlocks:args.context.prose,prose:args.context.prose.map(b=>b.text).join('')}}:args;structuredCalls.push(recorded);return structuredHandler(recorded);},
    stream:async function*(connection,secret,messages,options){const call={connection,secret,messages,options};streamCalls.push(call);yield* streamHandler(call);},
    embeddings:{vectors:async(_state,texts)=>{vectorCalls.push(texts);return vectorHandler(texts);}}
  });
  const app=express();app.use(express.json());app.use('/fanfic',service.router);app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
  t.after(async()=>{await tasks.stop();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const request=async(route,body,method)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/fanfic${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const success=async(route,body,method)=>{const result=await request(route,body,method);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.data;};
  const done=async()=>until(()=>{const job=tasks.publicTask();return job&&job.status!=='running'?job:null;});
  return {getState,saveState,service,tasks,request,success,done,structuredCalls,streamCalls,vectorCalls,
    setStructured:handler=>{structuredHandler=handler;},setStream:handler=>{streamHandler=handler;},setVectors:handler=>{vectorHandler=handler;},setTokens:handler=>{tokenHandler=handler;}};
}
const projectIn=(f,id)=>f.getState().fanficProjects.find(p=>p.id===id);
const episodeIn=(f,pid,eid)=>projectIn(f,pid).episodes.find(e=>e.id===eid);
const episodePath=(pid,eid)=>`/projects/${pid}/episodes/${eid}`;
async function createWork(f,project={},episode={}){
  const p=await f.success('/projects',{title:'Ночная обсерватория',...project,settings:{sceneCount:2,continuityCheck:false,...project.settings}});
  const e=await f.success(`/projects/${p.id}/episodes`,{title:'Карта',brief:'Герои встретились и нашли карту. P.S. Напиши от третьего лица.',...episode});
  return {project:p,episode:e,path:episodePath(p.id,e.id)};
}
async function generate(f,path,body={}){
  const started=await f.request(path+'/generate',body);
  assert.equal(started.status,202,JSON.stringify(started));
  const job=await f.done();assert.equal(job.status,'done',job.error);return job;
}


async function approvedWork(f,content='Лира держит медный ключ. Код двери ЛУНА-731.'){
 const work=await createWork(f,{}, {content});await generate(f,work.path,{action:'approve'});return work;
}
async function proposed(f,work,replacement='Лира осторожно подняла медный ключ.'){
 const current=episodeIn(f,work.project.id,work.episode.id),start=current.content.indexOf('Лира'),end=current.content.indexOf('.')+1;
 f.setStream(async function*(){yield replacement;});
 await generate(f,work.path,{action:'rewrite',preview:true,expectedRevision:current.revision,selectionStart:start,selectionEnd:end,instructions:'Улучши ритм, сохрани факты.'});
 return episodeIn(f,work.project.id,work.episode.id);
}
test('Preview preserves approved prose, memory, versions and other modes; apply changes only selected bytes and invalidates dependent canon',async t=>{
 const f=await fixture(t),work=await approvedWork(f),later=await f.success(`/projects/${work.project.id}/episodes`,{number:2,content:'Лира вошла в зал.'});await generate(f,episodePath(work.project.id,later.id),{action:'approve'});
 const other=await approvedWork(f,'ЧУЖОЙ КАНОН.'),foreign=projectIn(f,other.project.id),before=episodeIn(f,work.project.id,work.episode.id),state=f.getState();
 const preview=await proposed(f,work);assert.equal(preview.content,before.content);assert.deepEqual(preview.memory,before.memory);assert.deepEqual(preview.versions,before.versions);assert.equal(preview.status,'approved');assert.equal(episodeIn(f,work.project.id,later.id).needsReview,false);
 const replacement=preview.editProposal.replacement;const applied=await f.success(work.path+'/edits/'+preview.editProposal.id+'/apply',{expectedRevision:preview.revision});
 assert.equal(applied.content,replacement+before.content.slice(preview.editProposal.selectionEnd));assert.equal(applied.editProposal,null);assert.equal(applied.memory,null);assert.equal(applied.status,'draft');assert.equal(applied.versions.at(-1).content,before.content);assert.equal(episodeIn(f,work.project.id,later.id).needsReview,true);
 assert.deepEqual(projectIn(f,other.project.id),foreign);for(const key of ['chats','settings','multiplayer','multiplayerHistories','characters','personas','lorebooks'])assert.deepEqual(f.getState()[key],state[key],key);
});
test('Rejecting a proposal leaves accepted memory intact and stale or wrong-project apply is atomic',async t=>{
 const f=await fixture(t),work=await approvedWork(f),preview=await proposed(f,work),other=await approvedWork(f,'Иная история.');
 const protectedEpisode=structuredClone(preview);
 for(const [url,body] of [[work.path+'/edits/'+preview.editProposal.id+'/apply',{}],[work.path+'/edits/'+preview.editProposal.id+'/apply',{expectedRevision:preview.revision-1}],[other.path+'/edits/'+preview.editProposal.id+'/apply',{expectedRevision:episodeIn(f,other.project.id,other.episode.id).revision}]])assert.equal((await f.request(url,body)).status,409);
 assert.deepEqual(episodeIn(f,work.project.id,work.episode.id),protectedEpisode);
 const rejected=await f.success(work.path+'/edits/'+preview.editProposal.id,{expectedRevision:preview.revision},'DELETE');assert.equal(rejected.content,preview.content);assert.equal(rejected.status,'approved');assert.deepEqual(rejected.memory,preview.memory);assert.equal(rejected.editProposal,null);
 const newPreview=await proposed(f,work);await f.success(work.path,{expectedRevision:newPreview.revision,content:newPreview.content+' Ручное дополнение.'},'PATCH');
 const manual=episodeIn(f,work.project.id,work.episode.id);assert.equal((await f.request(work.path+'/edits/'+newPreview.editProposal.id+'/apply',{expectedRevision:manual.revision})).status,409);assert.deepEqual(episodeIn(f,work.project.id,work.episode.id),manual);
});
test('Stopping an editing preview retains the original approved memory and resumable replacement without applying it',async t=>{
 const f=await fixture(t),work=await approvedWork(f),before=episodeIn(f,work.project.id,work.episode.id);let release;
 f.setStream(async function*(){yield 'Лира осторожно';await new Promise(resolve=>{release=resolve;});yield ' подняла ключ.';});
 const start=await f.request(work.path+'/generate',{action:'rewrite',preview:true,selectionStart:0,selectionEnd:before.content.indexOf('.')+1,instructions:'Улучши ритм.'});assert.equal(start.status,202);
 await until(()=>release);const stopping=f.tasks.stop();release();await stopping;const stopped=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(f.tasks.publicTask().status,'stopped');assert.equal(stopped.content,before.content);assert.deepEqual(stopped.memory,before.memory);assert.equal(stopped.status,'approved');assert.equal(stopped.generation.preview,true);assert.equal(stopped.editProposal,null);
});
test('Fact editing is scoped, revision-safe, retains source evidence and summary editing does not erase structured facts',async t=>{
 const f=await fixture(t),work=await approvedWork(f),other=await approvedWork(f,'Чужая тайна.'),before=episodeIn(f,work.project.id,work.episode.id),foreign=projectIn(f,other.project.id);
 const extracted=validateCanonExtraction([{type:'item',subject:'Лира',predicate:'держит',value:'медный ключ',aliases:[],sourceIndices:[1]}],{prose:before.content,projectId:work.project.id,episodeId:before.id,sourceHash:contentHash(before.content),chunkIndex:0});
 const seeded=f.getState();seeded.fanficProjects.find(p=>p.id===work.project.id).episodes[0].memory.chunks[0].facts=extracted.facts;f.saveState(seeded);
 const original=episodeIn(f,work.project.id,work.episode.id),body={expectedRevision:original.revision,chunkIndex:0,facts:[{...extracted.facts[0],value:'медный ключ Лиры',evidence:[{quote:'FAKE',start:0,end:4}]}]};
 const saved=await f.success(work.path+'/memory/facts',body,'PATCH');assert.equal(saved.content,original.content);assert.equal(saved.status,'approved');assert.equal(saved.memory.chunks[0].facts[0].authorConfirmed,true);assert.deepEqual(saved.memory.chunks[0].facts[0].evidence,extracted.facts[0].evidence);
 const bad=await f.request(work.path+'/memory/facts',{...body,expectedRevision:saved.revision,facts:[{...body.facts[0],id:'foreign'}]},'PATCH');assert.equal(bad.status,400);assert.deepEqual(episodeIn(f,work.project.id,work.episode.id),saved);
 const updated=await f.success(work.path+'/memory',{expectedRevision:saved.revision,chunkIndex:0,summary:'Автор уточнил события.',location:'',relationships:[],openThreads:[]},'PATCH');assert.deepEqual(updated.memory.chunks[0].facts,saved.memory.chunks[0].facts);assert.deepEqual(projectIn(f,other.project.id),foreign);
 const next=await f.success(`/projects/${work.project.id}/episodes`,{number:2,content:'Будущее событие.'});const canon=await f.success(episodePath(work.project.id,next.id)+'/canon');assert.equal(canon.facts.length,1);assert.equal(canon.facts[0].episodeId,before.id);
});
test('Continuity review flags a provided contradiction with exact quotes while preserving approved prose and canon',async t=>{
 const f=await fixture(t),work=await approvedWork(f),before=episodeIn(f,work.project.id,work.episode.id);await f.success(`/projects/${work.project.id}`,{canon:'Ключ Лиры сделан из меди.'},'PATCH');
 // Updating materials marks older canon for review, so reaffirm unchanged source.
 await generate(f,work.path,{action:'approve'});const approved=episodeIn(f,work.project.id,work.episode.id);
 f.setStructured(args=>{assert.equal(args.name,'fanfic_review');return args.parse({issues:[{type:'item',severity:'warning',message:'Проверьте материал ключа.',evidenceIndices:[1],factIds:['project-canon'],suggestion:'Сверьте с каноном.'}]});});
 await generate(f,work.path,{action:'review'});const reviewed=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(reviewed.content,approved.content);assert.deepEqual(reviewed.memory,approved.memory);assert.equal(reviewed.status,'approved');assert.equal(reviewed.continuityReview.issues.length,1);assert.equal(reviewed.continuityReview.issues[0].sourceEvidence[0].quote,approved.content.slice(0,approved.content.indexOf('.')+1));assert.equal(reviewed.continuityReview.sourceRevision,reviewed.revision);assert.equal(reviewed.continuityReview.complete,true);
});
test('Automatic review failure preserves generated prose and exposes the failed check instead of failing writing',async t=>{
 const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:true}});f.setStructured(args=>{if(args.name==='fanfic_review')throw new Error('Review endpoint unavailable');return {scenes:[{title:'Сцена',summary:'Встреча.'}]};});
 f.setStream(async function*(){yield 'Лира нашла медный ключ.';});const job=await generate(f,work.path,{action:'write'}),episode=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(episode.content,'Лира нашла медный ключ.');assert.equal(episode.status,'draft');assert.equal(episode.continuityReview.status,'unavailable');assert.ok(job.warnings.some(w=>w.includes('Review endpoint unavailable')));assert.equal(episode.memory,null);
});
test('Calibration route persists five-stage report without changing settings, accepted canon or other modes',async t=>{
 const f=await fixture(t),work=await approvedWork(f),protectedState=f.getState(),before=projectIn(f,work.project.id);
 f.setStream(async function*(_call){yield 'Лира держала медный ключ. Дверь была закрыта. Она помнила код ЛУНА-731.';});
 f.setStructured(args=>{const stage=args.name.replace('fanfic_calibration_','');const outputs={planning:{scenes:[{title:'Ключ',summary:'Лира держит медный ключ, код ЛУНА-731.'},{title:'Дверь',summary:'Дверь закрыта.'}]},memory:{password:'ЛУНА-731',keyHolder:'Лира',keyMaterial:'медь',doorState:'закрыта',torkKnowsPassword:false},review:{issues:['password','keyMaterial','keyHolder','doorState','knowledge'].map(code=>({code,explanation:'Противоречит источнику.'}))},rewrite:{replacement:'Лира произнесла ЛУНА-731.'}};return args.parse(outputs[stage]);});
 const started=await f.request(`/projects/${work.project.id}/calibrate`,{});assert.equal(started.status,202);const job=await f.done();assert.equal(job.status,'done',job.error);
 const after=projectIn(f,work.project.id);assert.equal(after.modelEvaluation.stages.length,5);assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.episodes,before.episodes);assert.equal(after.modelEvaluation.recommendation.automatic,false);
 for(const key of ['chats','settings','multiplayer','multiplayerHistories','characters','personas','lorebooks'])assert.deepEqual(f.getState()[key],protectedState[key],key);
});


test('Long identity rewrite preserves chunk boundaries, words and whitespace without inserting scene paragraphs',async t=>{
 const f=await fixture(t),state=f.getState();state.connections.push({id:'sas-local',baseUrl:'http://127.0.0.1:9999/v1',model:'mock-local',contextWindow:2048});f.saveState(state);
 const source='  '+ 'abcdefghijklmnopqrst'.repeat(150)+'  ',outsideBefore='BEFORE:',outsideAfter=':AFTER';
 const work=await createWork(f,{settings:{connectionId:'sas-local',continuityCheck:false}},{content:outsideBefore+source+outsideAfter});
 f.setStructured(args=>{assert.equal(args.name,'fanfic_rewrite');return args.parse({replacement:args.context.source});});
 await generate(f,work.path,{action:'rewrite',preview:true,selectionStart:outsideBefore.length,selectionEnd:outsideBefore.length+source.length,instructions:'Сохрани всё буквально.'});
 const preview=episodeIn(f,work.project.id,work.episode.id);assert.ok(f.structuredCalls.length>1);assert.equal(preview.editProposal.replacement,source);assert.equal(preview.content,outsideBefore+source+outsideAfter);
 const applied=await f.success(work.path+'/edits/'+preview.editProposal.id+'/apply',{expectedRevision:preview.revision});assert.equal(applied.content,preview.content);
});


test('Fanfic continuation keeps a literal midword suffix and repairs a newline replay without duplicating the fragment',async t=>{
 for(const replay of [false,true]){
  const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:false}});let count=0;
  f.setStream(async function*(call){count++;if(count===1){yield 'Ирис осмотрела стра';call.options.onFinish('length');}else{if(replay){yield '\nст';yield 'ражу';yield ' и закрыла дверь.';}else yield 'жу и закрыла дверь.';call.options.onFinish('stop');}});
  await generate(f,work.path,{action:'write'});assert.equal(episodeIn(f,work.project.id,work.episode.id).content,'Ирис осмотрела стражу и закрыла дверь.');assert.equal(count,2);
 }
});


test('Structured editing restores original whitespace when a local model trims each replacement part',async t=>{
 const f=await fixture(t),state=f.getState();state.connections.push({id:'sas-local',baseUrl:'http://127.0.0.1:9999/v1',model:'mock-local',contextWindow:2048});f.saveState(state);
 const source='  '+ 'Лира бережно держала медный ключ. '.repeat(100)+'  ';
 const work=await createWork(f,{settings:{connectionId:'sas-local',continuityCheck:false}},{content:'ДО:'+source+':ПОСЛЕ'});
 f.setStructured(args=>args.parse({replacement:args.context.source.trim()}));
 await generate(f,work.path,{action:'rewrite',preview:true,selectionStart:3,selectionEnd:3+source.length,instructions:'Сохрани смысл и последовательность.'});
 const preview=episodeIn(f,work.project.id,work.episode.id);assert.ok(f.structuredCalls.length>1);assert.equal(preview.editProposal.replacement,source);
});


test('Read-only review and a rejected edit retain the original paused writing cursor and prose for resume',async t=>{
 const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:false}});
 f.setStream(async function*(call){yield 'Часть незаконченной сцены. ';call.options.onFinish('length');});
 await f.request(work.path+'/generate',{action:'write'});assert.equal((await f.done()).status,'error');
 const paused=episodeIn(f,work.project.id,work.episode.id);assert.ok(paused.generation);
 f.setStructured(args=>args.parse({issues:[]}));await generate(f,work.path,{action:'review'});
 let current=episodeIn(f,work.project.id,work.episode.id);assert.deepEqual(current.generation,paused.generation);assert.equal(current.content,paused.content);assert.equal(current.error,paused.error);
 f.setStream(async function*(){yield 'Улучшенный фрагмент.';});await generate(f,work.path,{action:'rewrite',preview:true,selectionStart:0,selectionEnd:paused.content.indexOf('.')+1,instructions:'Улучши ритм.'});
 current=episodeIn(f,work.project.id,work.episode.id);assert.deepEqual(current.generation,paused.generation);assert.equal(current.content,paused.content);
 const rejected=await f.success(work.path+'/edits/'+current.editProposal.id,{expectedRevision:current.revision},'DELETE');assert.deepEqual(rejected.generation,JSON.parse(JSON.stringify(paused.generation)));assert.equal(rejected.content,paused.content);
});


test('Three token limits use one bounded scene ending and keep the entire generated prefix',async t=>{
 const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:false}});let calls=0;
 f.setStream(async function*(call){calls++;yield ['Лира держала ключ и осмотрела стра','жу, затем подняла фо','нарь и посмотрела на две'][calls-1];call.options.onFinish('length');});
 f.setStructured(args=>{if(args.name==='fanfic_outline')return {scenes:[{title:'Дверь',summary:'Лира осматривает закрытую дверь.'}]};assert.equal(args.name,'fanfic_scene_ending');assert.ok(args.maxTokens<=256);assert.ok(args.temperature<=.15);assert.equal(args.context.tail,'Лира держала ключ и осмотрела стражу, затем подняла фонарь и посмотрела на две');assert.deepEqual(Object.keys(args.context).sort(),['authorBrief','sceneSummary','tail']);return args.parse({ending:'рь.'});});
 const job=await generate(f,work.path,{action:'write'}),current=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(current.content,'Лира держала ключ и осмотрела стражу, затем подняла фонарь и посмотрела на дверь.');assert.equal(calls,3);assert.equal(current.generation,null);assert.equal(current.status,'draft');assert.ok(job.warnings.some(w=>w.includes('коротким дополнением')));assert.equal(f.structuredCalls.filter(c=>c.name==='fanfic_scene_ending').length,1);
});

test('An invalid bounded ending leaves all prose and the scene cursor available for resume',async t=>{
 const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:false}});
 f.setStream(async function*(call){yield 'Сохрани этот фрагмент. ';call.options.onFinish('length');});
 f.setStructured(args=>args.name==='fanfic_outline'?{scenes:[{title:'Сцена',summary:'Встреча.'}]}:args.parse({ending:'Ещё один незавершённый обрыв'}));
 await f.request(work.path+'/generate',{action:'write'});const job=await f.done(),current=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(job.status,'error');assert.match(job.error,/короткое завершение не удалось/);assert.equal(current.content,current.generation.partial);assert.match(current.content,/Сохрани этот фрагмент/);assert.equal(current.generation.sceneIndex,0);assert.equal(current.memory,null);
 f.setStream(async function*(call){yield ' Всё завершилось.';call.options.onFinish('stop');});await generate(f,work.path,{action:'resume'});assert.equal(episodeIn(f,work.project.id,work.episode.id).generation,null);
});


test('scene recovery can use literal copy-completion after a rejected suffix without rewriting earlier prose',async t=>{
 const f=await fixture(t),work=await createWork(f,{settings:{sceneCount:1,continuityCheck:false}});let count=0;
 f.setStream(async function*(call){count++;yield ['Эльдор взглянул на Ирис.\n\n"Ирис, моя дорогая. ','Я знал, ','что вер'][count-1];call.options.onFinish('length');});
 f.setStructured(args=>args.name==='fanfic_outline'?{scenes:[{title:'Возвращение',summary:'Ирис вернулась к Эльдору.'}]}:args.name==='fanfic_scene_ending'?args.parse({ending:' к себе.'}):args.parse({completedText:args.context.text+'нёшься."'}));
 const job=await generate(f,work.path,{action:'write'}),current=episodeIn(f,work.project.id,work.episode.id);
 assert.equal(current.content,'Эльдор взглянул на Ирис.\n\n"Ирис, моя дорогая. Я знал, что вернёшься."');assert.equal(count,3);assert.equal(current.generation,null);assert.equal(current.memory,null);assert.equal(job.status,'done');assert.equal(f.structuredCalls.filter(c=>c.name==='fanfic_scene_completion').length,1);
});
