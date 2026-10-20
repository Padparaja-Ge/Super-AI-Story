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

test('Fanfic projects save independent cast and lore snapshots and deleting them leaves libraries untouched',async t=>{
  const f=await fixture(t),initial=f.getState(),char=initial.characters[0],persona=initial.personas[0],lore=initial.lorebooks[0];
  const p=await f.success('/projects',{title:'Один',characterIds:[char.id],personaIds:[persona.id],lorebookIds:[lore.id]});
  const other=await f.success('/projects',{title:'Два',characterIds:[char.id]});
  assert.equal(p.characters[0].sourceId,char.id);assert.equal(p.personas[0].sourceId,persona.id);assert.equal(p.lorebooks[0].sourceId,lore.id);
  const changed=f.getState();changed.characters[0].name='Изменённая библиотека';changed.lorebooks[0].name='Новый лор';f.saveState(changed);
  assert.equal(projectIn(f,p.id).characters[0].name,char.name);assert.equal(projectIn(f,other.id).characters[0].name,char.name);assert.equal(projectIn(f,p.id).lorebooks[0].name,lore.name);
  await f.success(`/projects/${p.id}`,{characterIds:[char.id]},'PATCH');
  assert.equal(projectIn(f,p.id).characters[0].name,char.name);
  await f.success(`/projects/${p.id}`,{characterIds:[char.id],refreshSnapshots:true},'PATCH');
  assert.equal(projectIn(f,p.id).characters[0].name,'Изменённая библиотека');assert.equal(projectIn(f,other.id).characters[0].name,char.name);
  const removed=f.getState();removed.characters=removed.characters.filter(c=>c.id!==char.id);f.saveState(removed);
  await f.success(`/projects/${other.id}`,{characterIds:[char.id],title:'Переживший удаление карточки'},'PATCH');
  assert.equal(projectIn(f,other.id).characters[0].name,char.name);
  await f.success(`/projects/${p.id}`,undefined,'DELETE');
  const after=f.getState();assert.equal(after.fanficProjects.length,1);assert.ok(!after.characters.some(c=>c.id===char.id));assert.deepEqual(after.chats,initial.chats);assert.deepEqual(after.personas,initial.personas);
});

test('Scenes stream as prose, author instructions stay outside accepted memory and unrelated stories stay intact',async t=>{
  const f=await fixture(t),before=f.getState(),work=await createWork(f);
  let scene=0;f.setStream(async function*(){yield ++scene===1?'Ирис встретила гостя.':'Они нашли звёздную карту.';});
  await generate(f,work.path,{action:'write'});
  const p=projectIn(f,work.project.id),e=p.episodes[0];
  assert.equal(e.content,'Ирис встретила гостя.\n\nОни нашли звёздную карту.');assert.equal(e.status,'draft');assert.equal(e.memory,null);assert.equal(e.generation,null);
  assert.deepEqual(approvedMemories(p),[]);assert.equal(f.streamCalls.length,2);assert.equal(f.structuredCalls[0].name,'fanfic_outline');
  for(const call of f.streamCalls){assert.equal(call.options.responseFormat,undefined);assert.equal(call.options.disableThinking,true);assert.match(call.messages[0].content,/ONLY literary prose/);assert.match(call.messages[1].content,/AUTHOR REQUEST/);assert.match(call.messages[1].content,/P\.S\./);}
  assert.match(f.streamCalls[1].messages[1].content,/Ирис встретила гостя/);
  assert.equal(f.structuredCalls.filter(call=>call.name==='fanfic_memory').length,0);
  const after=f.getState();for(const key of ['chats','characters','personas','lorebooks','multiplayer','multiplayerHistories'])assert.deepEqual(after[key],before[key]);
});

test('Only accepted source-matched episodes provide chronological memory and edits invalidate dependent episodes',async t=>{
  const f=await fixture(t),{project:p,episode:e1,path:p1}=await createWork(f,{}, {content:'Герои нашли карту.',number:1});
  await generate(f,p1,{action:'approve'});
  let first=episodeIn(f,p.id,e1.id);assert.equal(first.status,'approved');assert.equal(first.memory.sourceHash,contentHash(first.content));
  assert.deepEqual(f.structuredCalls[0].context.prose,first.content);assert.ok(!JSON.stringify(f.structuredCalls[0].context).includes('P.S.'));
  const e2=await f.success(`/projects/${p.id}/episodes`,{number:2,content:'Герои отправились к башне.',brief:'Продолжение'}),p2=episodePath(p.id,e2.id);
  const e3=await f.success(`/projects/${p.id}/episodes`,{number:3,content:'Черновик, который не произошёл.',brief:'Черновик'});
  await generate(f,p2,{action:'approve'});
  let docs=approvedMemories(projectIn(f,p.id));assert.deepEqual(docs.map(d=>d.episodeId),[e1.id,e2.id]);
  assert.deepEqual(approvedMemories(projectIn(f,p.id),episodeIn(f,p.id,e2.id)).map(d=>d.episodeId),[e1.id]);
  const other=await f.success('/projects',{title:'Чужое произведение'});assert.deepEqual(approvedMemories(projectIn(f,other.id)),[]);
  const tampered=projectIn(f,p.id);tampered.episodes[0].content='Подменённый текст';assert.deepEqual(approvedMemories(tampered),[],'A stale approved predecessor blocks dependent continuity even if its review flag was lost.');
  first=episodeIn(f,p.id,e1.id);
  await f.success(p1,{content:'Герои потеряли карту.',expectedRevision:first.revision},'PATCH');
  assert.equal(episodeIn(f,p.id,e1.id).memory,null);assert.equal(episodeIn(f,p.id,e1.id).status,'draft');assert.equal(episodeIn(f,p.id,e2.id).needsReview,true);assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);
  assert.equal(episodeIn(f,p.id,e3.id).content,'Черновик, который не произошёл.');
  await generate(f,p1,{action:'approve'});assert.equal(approvedMemories(projectIn(f,p.id)).length,1);
  await generate(f,p2,{action:'approve'});assert.deepEqual(approvedMemories(projectIn(f,p.id)).map(d=>d.episodeId),[e1.id,e2.id]);
  await f.success(p1,undefined,'DELETE');assert.equal(episodeIn(f,p.id,e2.id).needsReview,true);assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);
});

test('Revision checks reject stale edits and targeted rewriting preserves the surrounding prose',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{}, {content:'Начало. старый фрагмент Конец.'});
  const content='Начало. старый фрагмент Конец.',start=content.indexOf('старый'),end=content.indexOf(' Конец.');
  const saved=await f.success(path,{content,brief:'Новая авторская просьба',expectedRevision:e.revision},'PATCH');
  assert.equal((await f.request(path,{content:'Потерянное обновление',expectedRevision:e.revision},'PATCH')).status,409);
  assert.equal((await f.request(path+'/generate',{action:'continue',expectedRevision:e.revision})).status,409);
  f.setStream(async function*(){yield 'новый фрагмент';});
  await generate(f,path,{action:'rewrite',instructions:'Добавь спокойствия.',selectionStart:start,selectionEnd:end,expectedRevision:saved.revision});
  const edited=episodeIn(f,p.id,e.id);assert.equal(edited.content,'Начало. новый фрагмент Конец.');assert.equal(edited.memory,null);assert.ok(edited.versions.some(v=>v.content===content));
  assert.match(f.streamCalls[0].messages[1].content,/старый фрагмент/);assert.equal(f.structuredCalls.length,0);
  assert.equal((await f.request(path+'/generate',{action:'rewrite',instructions:'Правка',selectionStart:20,selectionEnd:5})).status,400);
  const version=edited.versions.find(v=>v.content===content);
  assert.equal((await f.request(path+'/restore',{versionId:version.id,expectedRevision:e.revision})).status,409);
  await f.success(path+'/restore',{versionId:version.id,expectedRevision:edited.revision});assert.equal(episodeIn(f,p.id,e.id).content,content);
});

test('Long rewrites process all source blocks without injecting the original episode brief',async t=>{
  const f=await fixture(t),source=Array.from({length:14},(_,i)=>`Абзац ${i}: `+'Старый мост стоял над рекой. '.repeat(12)).join('\n\n');
  const {project:p,episode:e,path}=await createWork(f,{settings:{maxTokens:256}}, {content:'ДО\n'+source+'\nПОСЛЕ',brief:'UNRELATED ORIGINAL EPISODE INSTRUCTION'});
  const parts=[];
  f.setStream(async function*(call){const data=JSON.parse(call.messages[1].content);parts.push(data.source);assert.doesNotMatch(JSON.stringify(call.messages),/UNRELATED ORIGINAL EPISODE INSTRUCTION/);yield data.source.trim();});
  await generate(f,path,{action:'rewrite',instructions:'Сохрани факты и абзацы.',selectionStart:3,selectionEnd:3+source.length});
  assert.ok(parts.length>1);assert.equal(parts.join(''),source);
  const edited=episodeIn(f,p.id,e.id).content;assert.ok(edited.startsWith('ДО\n'));assert.ok(edited.endsWith('\nПОСЛЕ'));for(let i=0;i<14;i++)assert.ok(edited.includes(`Абзац ${i}:`));
});

test('Stopping preserves a partial scene; resume continues that scene without duplicating completed scenes',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f);
  let count=0,blocked=false;
  f.setStream(async function*(call){
    count++;
    if(count===1){yield 'Первая сцена завершена.';return;}
    yield 'Вторая сцена началась';blocked=true;
    await new Promise(resolve=>call.options.signal.addEventListener('abort',resolve,{once:true}));
    call.options.signal.throwIfAborted();
  });
  assert.equal((await f.request(path+'/generate',{action:'write'})).status,202);
  await until(()=>blocked);
  assert.equal((await f.request(path,{content:'Попытка вмешательства'},'PATCH')).status,409);
  await f.tasks.stop();assert.equal((await f.done()).status,'stopped');
  const stopped=episodeIn(f,p.id,e.id);assert.equal(stopped.status,'stopped');assert.equal(stopped.generation.sceneIndex,1);assert.equal(stopped.generation.partial,'Вторая сцена началась');assert.equal(stopped.content,'Первая сцена завершена.\n\nВторая сцена началась');
  f.setStream(async function*(){yield ' и закончилась.';});
  await generate(f,path,{action:'resume',expectedRevision:stopped.revision});
  const resumed=episodeIn(f,p.id,e.id);assert.equal(resumed.content,'Первая сцена завершена.\n\nВторая сцена началась и закончилась.');assert.equal(resumed.generation,null);assert.equal(resumed.status,'draft');
  assert.equal(f.structuredCalls.filter(c=>c.name==='fanfic_outline').length,1);assert.equal(f.streamCalls.length,3);assert.match(f.streamCalls.at(-1).messages[1].content,/Вторая сцена началась/);assert.match(f.streamCalls.at(-1).messages[1].content,/Continue exactly after its last character/);
});

test('A token-limited response continues the same scene before advancing the outline',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{sceneCount:1}});
  let count=0;
  f.setStream(async function*(call){
    count++;
    yield count===1?'Незаконченная сцена ':'завершилась находкой.';
    call.options.onFinish(count===1?'length':'stop');
  });
  await generate(f,path,{action:'write'});
  assert.equal(count,2);assert.equal(episodeIn(f,p.id,e.id).content,'Незаконченная сцена завершилась находкой.');
  assert.match(f.streamCalls[1].messages[1].content,/Незаконченная сцена/);
  assert.equal(episodeIn(f,p.id,e.id).sceneIndex,1);assert.equal(episodeIn(f,p.id,e.id).generation,null);
});

test('An empty response after a token limit reports the unfinished scene and retains its complete resumable draft',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{sceneCount:1}});
 let requests=0;f.setStream(async function*(call){requests++;if(requests===1){yield 'Ирис подошла к воротам и';call.options.onFinish('length');}else call.options.onFinish('stop');});
 await f.request(path+'/generate',{action:'write'});const failed=await f.done();assert.equal(failed.status,'error');assert.match(failed.error,/не смогла завершить оборванную сцену/);assert.match(failed.error,/черновик сохранён/);
 const saved=episodeIn(f,p.id,e.id);assert.equal(saved.content,'Ирис подошла к воротам и');assert.equal(saved.generation.partial,saved.content);assert.equal(saved.generation.sceneIndex,0);assert.equal(saved.status,'error');assert.equal(saved.memory,null);
 f.setStream(async function*(call){yield ' показала печать.';call.options.onFinish('stop');});await generate(f,path,{action:'resume',expectedRevision:saved.revision});
 const completed=episodeIn(f,p.id,e.id);assert.equal(completed.content,'Ирис подошла к воротам и показала печать.');assert.equal(completed.generation,null);assert.equal(f.structuredCalls.filter(c=>c.name==='fanfic_outline').length,1);
});

test('Repeated token limits bound automatic calls and keep the scene cursor and text for explicit resume',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{sceneCount:1}});
  let count=0;
  f.setStream(async function*(call){count++;yield `Часть ${count}. `;call.options.onFinish('length');});
  assert.equal((await f.request(path+'/generate',{action:'write'})).status,202);
  const job=await f.done();assert.equal(job.status,'error');assert.equal(count,3);
  const limited=episodeIn(f,p.id,e.id);assert.equal(limited.generation.sceneIndex,0);assert.equal(limited.generation.partial,'Часть 1. Часть 2. Часть 3. ');assert.equal(limited.content,'Часть 1. Часть 2. Часть 3. ');
  f.setStream(async function*(call){yield 'Конец сцены.';call.options.onFinish('stop');});
  await generate(f,path,{action:'resume',expectedRevision:limited.revision});
  const resumed=episodeIn(f,p.id,e.id);assert.equal(resumed.content,'Часть 1. Часть 2. Часть 3. Конец сцены.');assert.equal(resumed.generation,null);assert.equal(f.structuredCalls.filter(c=>c.name==='fanfic_outline').length,1);
});

test('Rejected alternatives and restored versions remain drafts until explicitly approved',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{sceneCount:1}},{content:'Исходный вариант.'});
  await generate(f,path,{action:'approve'});assert.equal(approvedMemories(projectIn(f,p.id)).length,1);
  f.setStream(async function*(){yield 'Другой вариант.';});await generate(f,path,{action:'alternative'});
  let changed=episodeIn(f,p.id,e.id);assert.equal(changed.content,'Другой вариант.');assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);
  const original=changed.versions.find(v=>v.content==='Исходный вариант.');assert.ok(original);
  await f.success(path+'/restore',{versionId:original.id,expectedRevision:changed.revision});changed=episodeIn(f,p.id,e.id);
  assert.equal(changed.content,'Исходный вариант.');assert.equal(changed.status,'draft');assert.equal(changed.memory,null);assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);
});

test('A failed outline leaves existing prose recoverable and never replaces it with an empty alternative',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{}, {content:'Исходный текст, который нужно сохранить.'});
  f.setStructured(()=>{throw new Error('Модель вернула неполный план');});
  assert.equal((await f.request(path+'/generate',{action:'alternative'})).status,202);assert.equal((await f.done()).status,'error');
  const failed=episodeIn(f,p.id,e.id);assert.equal(failed.content,e.content);assert.equal(failed.generation.baseContent,e.content);assert.ok(failed.versions.some(v=>v.content===e.content));assert.equal(failed.memory,null);assert.equal(f.streamCalls.length,0);
});

test('Vector memory retrieves only accepted episodes in this work and safely falls back when embeddings fail',async t=>{
  const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{vectorMemory:true,sceneCount:1}},{content:'Событие своего произведения 1.',number:1});
  await generate(f,path,{action:'approve'});
  for(let number=2;number<=3;number++){
    const part=await f.success(`/projects/${p.id}/episodes`,{number,content:`Событие своего произведения ${number}.`});
    await generate(f,episodePath(p.id,part.id),{action:'approve'});
  }
  await f.success(`/projects/${p.id}/episodes`,{number:4,content:'НЕУТВЕРЖДЁННЫЙ ЧЕРНОВИК'});
  const other=await createWork(f,{}, {content:'ЧУЖАЯ ИСТОРИЯ'});await generate(f,other.path,{action:'approve'});
  const next=await f.success(`/projects/${p.id}/episodes`,{number:5,brief:'Продолжи своё произведение'}),nextPath=episodePath(p.id,next.id);
  await generate(f,nextPath,{action:'write'});
  assert.equal(f.vectorCalls.length,2);for(const call of f.vectorCalls){assert.equal(call.length,4);assert.ok(call.slice(1).every(value=>value.includes('своего произведения')));assert.ok(!call.join().includes('ЧУЖАЯ'));assert.ok(!call.join().includes('ЧЕРНОВИК'));}
  f.setVectors(()=>{throw new Error('Embedding endpoint недоступен');});
  const job=await generate(f,nextPath,{action:'continue'});assert.ok(job.warnings.some(w=>w.includes('хронологические сводки')));assert.match(f.streamCalls.at(-1).messages[1].content,/Событие своего произведения/);
  assert.equal(episodeIn(f,p.id,e.id).status,'approved');
});

test('Exports omit connection secrets and import creates new identities with untrusted drafts',async t=>{
  const f=await fixture(t),initial=f.getState(),{project:p,episode:e,path}=await createWork(f,{characterIds:[initial.characters[0].id],settings:{connectionId:initial.activeConnectionId}},{content:'Сохранённый эпизод.'});
  await generate(f,path,{action:'approve'});
  const exported=await f.success(`/projects/${p.id}/export`);assert.equal(exported.spec,'sas_fanfic_v1');assert.equal(exported.project.settings.connectionId,'');assert.equal(exported.project.episodes[0].generation,null);assert.equal(exported.connections,undefined);
  exported.project.apiKey='secret';exported.project.settings.apiKey='secret';exported.project.characters[0].authorization='secret';exported.project.episodes[0].memory.summary='Поддельная доверенная память';
  const imported=await f.success('/import',exported);assert.notEqual(imported.id,p.id);assert.notEqual(imported.episodes[0].id,e.id);assert.equal(imported.episodes[0].content,'Сохранённый эпизод.');assert.equal(imported.episodes[0].status,'draft');assert.equal(imported.episodes[0].memory,null);assert.equal(imported.episodes[0].needsReview,false);assert.equal(imported.settings.connectionId,'');assert.ok(!JSON.stringify(imported).includes('secret'));assert.deepEqual(approvedMemories(imported),[]);
  assert.equal(projectIn(f,p.id).episodes[0].status,'approved');assert.deepEqual(f.getState().chats,initial.chats);
});

test('Long prose is summarized in bounded chronological blocks, and a failed approval can resume safely',async t=>{
  const f=await fixture(t),state=f.getState();state.connections[0].contextWindow=2048;f.saveState(state);
  const prose=Array.from({length:90},(_,i)=>`Событие ${i}: герои исследовали зал и записали сведения о найденных звёздных картах.`).join('\n\n');
  const {project:p,episode:e,path}=await createWork(f,{}, {content:prose});
  let broken=true;
  f.setStructured(args=>{
    if(args.context.part===2&&broken)throw new Error('Временный сбой модели');
    return {summary:`Сводка части ${args.context.part}`,location:'Башня',relationships:[],openThreads:[]};
  });
  assert.equal((await f.request(path+'/generate',{action:'approve'})).status,202);assert.equal((await f.done()).status,'error');
  let current=episodeIn(f,p.id,e.id);assert.equal(current.content,prose);assert.equal(current.generation.memoryIndex,1);assert.equal(current.memory,null);assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);
  broken=false;await generate(f,path,{action:'resume',expectedRevision:current.revision});current=episodeIn(f,p.id,e.id);
  assert.equal(current.status,'approved');assert.ok(current.memory.chunks.length>1);assert.equal(current.memory.sourceHash,contentHash(prose));assert.equal(f.structuredCalls.filter(c=>c.context.part===1).length,1);
  const successfulParts=f.structuredCalls.filter((c,i)=>!(c.context.part===2&&i===1));assert.equal(successfulParts.map(c=>c.context.prose).join(''),prose);assert.ok(f.structuredCalls.every(c=>c.context.prose.length<=2400));
});

test('Unknown ids and malformed generation requests fail without starting a task',async t=>{
  const f=await fixture(t),work=await createWork(f);
  assert.equal((await f.request('/projects/missing/episodes',{})).status,404);
  assert.equal((await f.request(`/projects/${work.project.id}/episodes/missing/generate`,{action:'write'})).status,404);
  assert.equal((await f.request(work.path+'/generate',{action:'invalid'})).status,400);
  assert.equal((await f.request(work.path+'/generate',{action:'resume'})).status,400);
  assert.equal((await f.request(work.path+'/generate',{action:'approve'})).status,400);
  assert.equal((await f.request('/projects',{characterIds:['missing']})).status,400);
  assert.equal((await f.request(work.path+'/generate',{instructions:{bad:true}})).status,400);
  assert.equal(f.tasks.publicTask(),null);
});

test('Prompt assembly fits a small context even with a very large draft and retains the current tail',async t=>{
  const f=await fixture(t),{project:p,episode:e}=await createWork(f,{world:'Длинный мир. '.repeat(2000),settings:{maxTokens:2048}});
  const currentText='Предыстория. '.repeat(20000)+'ПОСЛЕДНЕЕ ПРЕДЛОЖЕНИЕ.';
  const connection={contextWindow:2048};
  const prepared=buildFanficMessages({project:p,episode:e,connection,purpose:'continue',instructions:'Продолжи после последнего предложения.',currentText});
  assert.ok(messageTokens(prepared.messages)+prepared.maxTokens+100<=connection.contextWindow);
  assert.match(prepared.messages[1].content,/ПОСЛЕДНЕЕ ПРЕДЛОЖЕНИЕ/);assert.equal(prepared.messages.length,2);
});

test('Old saves gain an empty fanfic library without replacing ordinary story or multiplayer data',()=>{
  const before=sanitizeState({}),old=structuredClone(before);
  delete old.fanficProjects;
  old.multiplayer={id:'room-old',name:'Старая комната',messages:[{id:'m-old',role:'assistant',content:'Начало приключения'}]};
  old.multiplayerHistories=[{id:'saved-room',name:'Другая комната'}];
  const migrated=sanitizeState(old);
  assert.deepEqual(migrated.fanficProjects,[]);
  assert.deepEqual(migrated.chats,before.chats);
  assert.deepEqual(migrated.characters,before.characters);
  assert.deepEqual(migrated.lorebooks,before.lorebooks);
  assert.deepEqual(migrated.multiplayer,old.multiplayer);
  assert.deepEqual(migrated.multiplayerHistories,old.multiplayerHistories);
});

test('Restart marks interrupted fanfic work stopped while preserving its resumable scene data',async t=>{
  const f=await fixture(t),{project:p,episode:e}=await createWork(f);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-fanfic-restart-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const state=f.getState(),episode=state.fanficProjects[0].episodes[0];
  episode.status='running';episode.content='Сохранённый фрагмент';episode.generation={action:'write',sceneIndex:1,outline:[{title:'Первая',summary:'Готово'},{title:'Вторая',summary:'Продолжение'}],partial:'фрагмент',completedText:'Сохранённый',baseContent:''};
  const store=createStore(dir);store.saveState(state);
  assert.equal(store.getState().fanficProjects[0].episodes[0].status,'running');
  const reopened=createStore(dir).getState(),restored=reopened.fanficProjects.find(v=>v.id===p.id).episodes.find(v=>v.id===e.id);
  assert.equal(restored.status,'stopped');assert.equal(restored.content,episode.content);assert.deepEqual(restored.generation,episode.generation);assert.deepEqual(reopened.chats,state.chats);assert.deepEqual(reopened.characters,state.characters);
});

test('The real app owns fanfic data on the backend and stale UI state cannot erase it',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-fanfic-'));
  const runtime=await startServer({port:0,dataDir:dir});
  t.after(async()=>{await runtime.close();await fs.rm(dir,{recursive:true,force:true});});
  const request=async(route,body,method)=>{
    const response=await fetch(`http://127.0.0.1:${runtime.port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const original=(await request('/state')).data;
  const created=await request('/fanfic/projects',{title:'Ночная обсерватория'});
  assert.equal(created.status,201,JSON.stringify(created));
  const state=(await request('/state')).data;
  assert.equal(state.fanficProjects.length,1);
  const attempted={...state,fanficProjects:[]};
  assert.equal((await request('/state',attempted,'PUT')).status,200);
  const after=(await request('/state')).data;
  assert.equal(after.fanficProjects[0].id,created.data.id);
  assert.deepEqual(after.chats,original.chats);
  assert.deepEqual(after.characters,original.characters);
  assert.deepEqual(after.lorebooks,original.lorebooks);
  assert.deepEqual(after.multiplayer,original.multiplayer);
  assert.deepEqual(after.multiplayerHistories||[],original.multiplayerHistories||[]);
});


test('Episode numbers are unique per season, moving and importing duplicates is atomic',async t=>{
 const f=await fixture(t),{project:p,episode:e}=await createWork(f,{}, {season:1,number:1});
 assert.equal((await f.request('/projects/'+p.id+'/episodes',{season:1,number:1})).status,409);
 const second=await f.success('/projects/'+p.id+'/episodes',{season:2,number:1});
 assert.equal((await f.request(episodePath(p.id,second.id),{season:1,number:1},'PATCH')).status,409);
 assert.equal(episodeIn(f,p.id,second.id).season,2);
 const exported=await f.success('/projects/'+p.id+'/export');exported.project.episodes[1].season=1;
 assert.equal((await f.request('/import',exported)).status,409);assert.equal(f.getState().fanficProjects.length,1);
});

test('Reference changes mark canon for review, affect only this work and discard incompatible resume state',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{}, {content:'Событие первого мира.'});await generate(f,path,{action:'approve'});
 const other=await createWork(f,{}, {content:'Событие второго мира.'});await generate(f,other.path,{action:'approve'});
 const before=projectIn(f,other.project.id);
 await f.success('/projects/'+p.id,{world:'Изменившийся мир'},'PATCH');
 assert.equal(episodeIn(f,p.id,e.id).needsReview,true);assert.deepEqual(approvedMemories(projectIn(f,p.id)),[]);assert.deepEqual(projectIn(f,other.project.id),before);
 const pending=await f.success('/projects/'+p.id+'/episodes',{content:'Черновик',brief:'Продолжи'});
 f.setStream(async function*(){yield 'Начало';throw new Error('interrupted');});await f.request(episodePath(p.id,pending.id)+'/generate',{action:'continue'});await f.done();
 await f.success('/projects/'+p.id,{canon:'Новый канон'},'PATCH');assert.equal(episodeIn(f,p.id,pending.id).generation,null);
 assert.equal((await f.request(episodePath(p.id,pending.id)+'/generate',{action:'resume'})).status,400);
});

test('Context preview is read-only and excludes future, draft, foreign work and ordinary memory',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{vectorMemory:true}}, {content:'OWN_EARLY_FACT'});await generate(f,path,{action:'approve'});
 const current=await f.success('/projects/'+p.id+'/episodes',{season:2,number:1,brief:'Продолжи своё произведение'});
 const future=await f.success('/projects/'+p.id+'/episodes',{season:2,number:2,content:'FUTURE_SECRET'});await generate(f,episodePath(p.id,future.id),{action:'approve'});
 await f.success('/projects/'+p.id+'/episodes',{season:1,number:3,content:'DRAFT_SECRET'});
 const other=await createWork(f,{}, {content:'FOREIGN_SECRET'});await generate(f,other.path,{action:'approve'});
 const state=f.getState();state.chats[0].summary='ORDINARY_SECRET';f.saveState(state);const before=f.getState();
 const result=await f.success(episodePath(p.id,current.id)+'/context',{}),serialized=JSON.stringify(result);
 assert.match(serialized,/OWN_EARLY_FACT/);for(const secret of ['FUTURE_SECRET','DRAFT_SECRET','FOREIGN_SECRET','ORDINARY_SECRET'])assert.ok(!serialized.includes(secret));
 assert.equal(result.report.eligibleMemory,1);assert.equal(result.report.selectedMemory[0].included,true);assert.equal(result.report.projectId,p.id);assert.deepEqual(f.getState(),before);
 assert.equal((await f.request('/projects/'+other.project.id+'/episodes/'+e.id+'/context',{})).status,404);
});

test('Fanfic prose and vector candidates never inherit studio presets, RPG rules or a multiplayer room',async t=>{
 const f=await fixture(t),initial=f.getState();
 initial.settings.userName='GLOBAL_PROFILE_SECRET';
 initial.settings.narrative={mode:'gamemaster',instructions:'SOLO_NARRATIVE_SECRET',perspective:'first',tense:'present',length:'long'};
 initial.presets.push({id:'foreign-preset',name:'Foreign preset',systemPrompt:'STUDIO_PRESET_SECRET'});initial.activePresetId='foreign-preset';
 initial.plugins.push({id:'foreign-plugin',enabled:true,builtin:false,name:'Plugin',prompt:'PLUGIN_PROMPT_SECRET'});
 initial.characters[0].description='SOLO_CHARACTER_SECRET';
 initial.chats[0].summary='SOLO_MEMORY_SECRET';initial.chats[0].scene.location='SOLO_SCENE_SECRET';
 initial.lorebooks.push({id:'foreign-rules',name:'DND_RULEBOOK_SECRET',entries:[{id:'foreign-rule',content:'DND_RULE_CONTENT_SECRET',constant:true,vectorized:true,enabled:true,keys:[]}]});
 initial.storybooks.push({id:'foreign-story',name:'DND_STORYBOOK_SECRET',world:'DND_WORLD_SECRET',start:'Таверна',goal:'DND_GOAL_SECRET',details:'',players:'2-4'});
 initial.multiplayer={id:'foreign-room',mode:'dnd',rulebookIds:['foreign-rules'],lorebookIds:['foreign-rules'],summary:'ROOM_SUMMARY_SECRET',memory:[{id:'foreign-m',content:'ROOM_MEMORY_SECRET'}],messages:[{id:'foreign-msg',role:'assistant',content:'ROOM_MESSAGE_SECRET'}]};
 initial.multiplayerHistories=[{id:'saved-room',summary:'SAVED_ROOM_SECRET',messages:[]}];f.saveState(initial);
 const work=await createWork(f,{settings:{vectorMemory:true,style:'FANFIC_STYLE_OWN',instructions:'FANFIC_INSTRUCTION_OWN',sceneCount:1}},{content:'FANFIC_OWN_SOURCE'});
 await generate(f,work.path,{action:'approve'});
 const later=await f.success('/projects/'+work.project.id+'/episodes',{number:2,content:'FANFIC_OWN_TAIL',brief:'Продолжи историю этого произведения.'});
 const protectedState=f.getState();
 await generate(f,episodePath(work.project.id,later.id),{action:'continue',instructions:'Сохрани собственные факты произведения.'});
 const proseCall=f.streamCalls.at(-1),serialized=JSON.stringify({messages:proseCall.messages,vectors:f.vectorCalls});
 assert.match(serialized,/FANFIC_OWN_SOURCE/);assert.match(serialized,/FANFIC_OWN_TAIL/);assert.match(serialized,/FANFIC_STYLE_OWN/);assert.match(serialized,/FANFIC_INSTRUCTION_OWN/);
 for(const marker of ['GLOBAL_PROFILE_SECRET','SOLO_NARRATIVE_SECRET','STUDIO_PRESET_SECRET','PLUGIN_PROMPT_SECRET','SOLO_CHARACTER_SECRET','SOLO_MEMORY_SECRET','SOLO_SCENE_SECRET','DND_RULEBOOK_SECRET','DND_RULE_CONTENT_SECRET','DND_STORYBOOK_SECRET','DND_WORLD_SECRET','DND_GOAL_SECRET','ROOM_SUMMARY_SECRET','ROOM_MEMORY_SECRET','ROOM_MESSAGE_SECRET','SAVED_ROOM_SECRET'])assert.ok(!serialized.includes(marker),marker+' must not enter fanfic context');
 const after=f.getState();for(const key of ['settings','chats','characters','lorebooks','storybooks','presets','plugins','multiplayer','multiplayerHistories'])assert.deepEqual(after[key],protectedState[key],key+' must remain unchanged');
});

test('Local fragment editing uses a bounded JSON replacement and preserves unrelated prose and memory',async t=>{
 const f=await fixture(t),state=f.getState();state.connections.push({id:'sas-local',baseUrl:'http://127.0.0.1:9999/v1',model:'mock-local',contextWindow:2048});f.saveState(state);
 const {project:p,episode:e,path}=await createWork(f,{settings:{connectionId:'sas-local'}},{content:'ДО: Исходный фрагмент. ПОСЛЕ.'});
 f.setStructured(args=>{assert.equal(args.name,'fanfic_rewrite');assert.equal(args.context.source,'Исходный фрагмент.');assert.ok(!JSON.stringify(args.context).includes('P.S.'));return args.parse({replacement:'Улучшенный фрагмент.'});});
 const start=e.content.indexOf('Исходный'),end=start+'Исходный фрагмент.'.length;
 await generate(f,path,{action:'rewrite',instructions:'Улучши ритм.',selectionStart:start,selectionEnd:end});
 assert.equal(episodeIn(f,p.id,e.id).content,'ДО: Улучшенный фрагмент. ПОСЛЕ.');assert.equal(f.streamCalls.length,0);assert.equal(f.structuredCalls.length,1);assert.equal(episodeIn(f,p.id,e.id).memory,null);
});


test('Manual memory corrections keep source identity, invalidate later canon and do not change other works',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{}, {content:'Ирис получила печать.'});await generate(f,path,{action:'approve'});
 const later=await f.success('/projects/'+p.id+'/episodes',{number:2,content:'Ирис открыла ворота.'});await generate(f,episodePath(p.id,later.id),{action:'approve'});
 const other=await createWork(f,{}, {content:'Чужая история.'});await generate(f,other.path,{action:'approve'});const unchanged=projectIn(f,other.project.id);
 const current=episodeIn(f,p.id,e.id),body={expectedRevision:current.revision,chunkIndex:0,summary:'Ирис получила печать от Эльдора.',location:'Обсерватория',relationships:[],openThreads:['Открыть ворота.']};
 const saved=await f.success(path+'/memory',body,'PATCH');assert.equal(saved.memory.sourceHash,contentHash(e.content));assert.equal(saved.memory.chunks[0].editedByAuthor,true);assert.equal(saved.memory.summary,body.summary);assert.equal(saved.status,'approved');assert.equal(episodeIn(f,p.id,later.id).needsReview,true);
 assert.deepEqual(projectIn(f,other.project.id),unchanged);assert.equal((await f.request(path+'/memory',body,'PATCH')).status,409);
 assert.equal((await f.request(path+'/memory',{...body,expectedRevision:saved.revision,summary:''},'PATCH')).status,400);
 assert.equal((await f.request(path+'/memory',{...body,expectedRevision:saved.revision,chunkIndex:99},'PATCH')).status,404);
});

test('Changing early canon cancels a dependent paused plan while preserving its text and foreign work',async t=>{
 const f=await fixture(t),{project:p,episode:first,path:firstPath}=await createWork(f,{settings:{sceneCount:1}},{content:'Ирис получила старую печать.'});await generate(f,firstPath,{action:'approve'});
 const later=await f.success('/projects/'+p.id+'/episodes',{number:2,content:'Ирис подошла к воротам.',brief:'Продолжи'}),laterPath=episodePath(p.id,later.id);
 const other=await createWork(f,{}, {content:'Чужая серия.'});const unchanged=projectIn(f,other.project.id);
 f.setStream(async function*(){yield 'Она достала старую печать';throw new Error('Network closed');});await f.request(laterPath+'/generate',{action:'continue'});await f.done();
 const paused=episodeIn(f,p.id,later.id);assert.ok(paused.generation);assert.match(paused.content,/старую печать/);
 const current=episodeIn(f,p.id,first.id);
 await f.success(firstPath+'/memory',{expectedRevision:current.revision,chunkIndex:0,summary:'Ирис потеряла старую печать.',location:'',relationships:[],openThreads:[]},'PATCH');
 const invalid=episodeIn(f,p.id,later.id);assert.equal(invalid.generation,null);assert.equal(invalid.status,'draft');assert.equal(invalid.content,paused.content);assert.equal(invalid.needsReview,true);assert.ok(invalid.revision>paused.revision);
 assert.equal((await f.request(laterPath+'/generate',{action:'resume'})).status,400);assert.deepEqual(projectIn(f,other.project.id),unchanged);
});

test('Resuming memory after a model context change restarts all source chunks rather than skipping different boundaries',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{}, {content:'Ирис нашла ключ.\n\n'.repeat(900)});
 let failed=true;f.setStructured(args=>{if(args.context.part===2&&failed)throw new Error('Encoder interrupted');return {summary:'Факт части '+args.context.part,location:'',relationships:[],openThreads:[]};});
 await f.request(path+'/generate',{action:'approve'});await f.done();let current=episodeIn(f,p.id,e.id);assert.equal(current.generation.memoryIndex,1);
 const state=f.getState();state.connections[0].contextWindow=1024;f.saveState(state);failed=false;const beforeCalls=f.structuredCalls.length;
 const job=await generate(f,path,{action:'resume'});current=episodeIn(f,p.id,e.id);assert.equal(current.status,'approved');assert.ok(job.warnings.some(w=>w.includes('Контекст модели изменился')));
 const resumed=f.structuredCalls.slice(beforeCalls);assert.equal(resumed[0].context.part,1);assert.equal(resumed.map(call=>call.context.prose).join(''),e.content);assert.equal(current.memory.chunks.length,resumed.length);
});

test('Deletion removes only image metadata owned by the deleted fanfic target',async t=>{
 const f=await fixture(t),one=await createWork(f),two=await createWork(f),next=await f.success('/projects/'+one.project.id+'/episodes',{number:2});
 const state=f.getState();state.images=[{id:'one',fanficProjectId:one.project.id,episodeId:one.episode.id},{id:'next',fanficProjectId:one.project.id,episodeId:next.id},{id:'two',fanficProjectId:two.project.id,episodeId:two.episode.id},{id:'rp',chatId:state.chats[0].id},{id:'table',roomId:'room'}];f.saveState(state);
 await f.success(one.path,undefined,'DELETE');assert.deepEqual(f.getState().images.map(i=>i.id),['next','two','rp','table']);
 await f.success('/projects/'+one.project.id,undefined,'DELETE');assert.deepEqual(f.getState().images.map(i=>i.id),['two','rp','table']);assert.ok(projectIn(f,two.project.id));
});

test('A service-only model answer fails clearly instead of reporting an empty scene as finished',async t=>{
 const f=await fixture(t),{project:p,episode:e,path}=await createWork(f,{settings:{sceneCount:1}},{content:'Существующий текст.'});
 f.setStream(async function*(){yield '[SAS_SCENE_END]';});await f.request(path+'/generate',{action:'alternative'});const job=await f.done();
 assert.equal(job.status,'error');assert.match(job.error,/служебный комментарий/);const current=episodeIn(f,p.id,e.id);assert.equal(current.generation.sceneIndex,0);assert.ok(current.versions.some(v=>v.content===e.content));assert.equal(current.memory,null);
});

test('All local fanfic generation paths adapt Alpaca instructions and native rewrite fitting keeps the entire selection',async t=>{
 const f=await fixture(t),state=f.getState();state.connections.push({id:'sas-local',baseUrl:'http://127.0.0.1:9999/v1',model:'mock-moe',contextWindow:2048,promptFormat:'alpaca'});f.saveState(state);
 f.setTokens(async(_c,_s,messages,options)=>{assert.equal(options.adaptInstruction,true);return Math.ceil(messages.map(m=>m.content).join('').length/1.5)+30;});
 const {project:p,episode:e,path}=await createWork(f,{settings:{connectionId:'sas-local',sceneCount:1,maxTokens:600}},{content:'Начало. '+('Ирис осмотрела ворота. '.repeat(65))+' Конец.'});
 const start=e.content.indexOf('Ирис'),end=e.content.lastIndexOf(' Конец.');f.setStructured(args=>args.name==='fanfic_rewrite'?args.parse({replacement:args.context.source}):{summary:'Ирис увидела ворота.',location:'',relationships:[],openThreads:[]});
 await generate(f,path,{action:'rewrite',selectionStart:start,selectionEnd:end,instructions:'Сохрани события, улучши ритм.'});
 const rewrites=f.structuredCalls.filter(c=>c.name==='fanfic_rewrite');assert.ok(rewrites.length>1);assert.equal(rewrites.map(c=>c.context.source).join(''),e.content.slice(start,end));assert.ok(rewrites.every(c=>c.adaptInstruction===true));
 await generate(f,path,{action:'approve'});assert.ok(f.structuredCalls.filter(c=>c.name==='fanfic_memory').every(c=>c.adaptInstruction===true));
 f.setStructured(args=>({scenes:[{title:'Сцена',summary:'Ирис покинула ворота.'}]}));await generate(f,path,{action:'alternative'});assert.ok(f.structuredCalls.filter(c=>c.name==='fanfic_outline').every(c=>c.adaptInstruction===true));assert.ok(f.streamCalls.every(c=>c.options.adaptInstruction===true));
});
