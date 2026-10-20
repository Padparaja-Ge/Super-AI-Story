import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMemory,pendingMemory} from '../server/memory.mjs';
import {createEmbeddings,retrievalQueries} from '../server/embeddings.mjs';
import {modelMessages} from '../server/llm.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {sanitizeState} from '../server/store.mjs';
const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
test('Single-System GGUF adapter preserves every instruction and attaches late sources to the current turn',()=>{
 const messages=[{role:'system',content:'PRESET'},{role:'system',content:'CARD PERSONA MEMORY'},{role:'user',content:'Past user'},{role:'assistant',content:'Past reply'},{role:'system',content:'SOURCE 37'},{role:'user',content:'Debt?'},{role:'system',content:'CURRENT TASK'}],saved=structuredClone(messages);
 const result=modelMessages({id:'sas-local',promptFormat:'single-system'},messages);
 assert.deepEqual(result,[{role:'system',content:'PRESET\n\nCARD PERSONA MEMORY'},...messages.slice(2,4),{role:'user',content:'SOURCE 37\n\nDebt?\n\nCURRENT TASK'}]);assert.deepEqual(messages,saved);
 assert.deepEqual(modelMessages({id:'external',promptFormat:'single-system'},messages),messages);
});
test('Long repeated prose does not obscure separate archive recall questions',()=>{
 const questions=retrievalQueries('Я смотрю на окно. '.repeat(100)+'Сколько я должна? Напомни пароль ворот, что стало с Борисом и когда верну печать?');
 assert.equal(questions.length,3);assert.match(questions[0],/Сколько/);assert.match(questions[1],/пароль/);assert.match(questions[2],/Борис/);assert.ok(questions.every(q=>!q.includes('окно')));
});
test('RP source retrieval stays within the supplied story and preserves originals omitted from summaries',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-rp-source-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls=[];
 const embedding=text=>[Number(/долг|монет|debt/iu.test(text)),Number(/пароль|ворот|gate/iu.test(text)),Number(/Борис|рыбак/iu.test(text)),.05];
 const service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async(_u,init)=>{const body=JSON.parse(init.body);calls.push(body.input);return new Response(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:embedding(text)}))}));}});
 const state=sanitizeState(seed);state.connections[0].model='embed';state.settings.embeddings={connectionId:state.connections[0].id,threshold:.3,topK:4};const chat=state.chats[0];chat.memorySettings.vectorMemory=true;chat.memory=[];chat.messages=[{id:'a',role:'assistant',content:'Долг 37 монет до полнолуния.'},{id:'b',role:'assistant',content:'Пароль ворот САПФИР-731.'},{id:'c',role:'assistant',content:'Борис — спасённый рыбак, жив.'},...Array.from({length:4},(_,i)=>({id:'recent'+i,role:'assistant',content:'Дорога и таверна.'}))];state.chats.push({...structuredClone(chat),id:'foreign',messages:[{id:'secret',role:'assistant',content:'FOREIGN долг 999 монет'}]});
 const retrieval=await service.retrieve(state,chat,'Сколько монет долг? Напомни пароль ворот. Что стало с Борисом?',undefined,{includeSources:true});assert.deepEqual(retrieval.sourceExcerpts.map(e=>e.messageId).sort(),['a','b','c']);assert.ok(!JSON.stringify(calls).includes('FOREIGN'));
 const prompt=buildPrompt(state,chat.id,'Напомни старые события.',retrieval);assert.match(JSON.stringify(prompt.messages),/37|731/);assert.ok(!JSON.stringify(prompt.messages).includes('FOREIGN'));
 const roomStyle=await service.retrieve(state,chat,'Долг?',undefined);assert.equal(roomStyle.sourceExcerpts,undefined);
 chat.memorySettings.memoryMode='off';const disabled=await service.retrieve(state,chat,'Долг?',undefined,{includeSources:true});assert.deepEqual(disabled,{});
});
test('Memory uses the native tokenizer to split even one post and covers every source character exactly once',async()=>{
 let state=sanitizeState(seed);state.connections[0].model='test';state.connections[0].contextWindow=1024;state.connections[0].maxTokens=128;const chat=state.chats[0];chat.memory=[];chat.messages=[{id:'long',role:'assistant',content:'События с 🐈. '.repeat(90)}];const before=structuredClone(chat.messages);let requests=0,measurements=0;
 const memory=createMemory({getState:()=>structuredClone(state),saveState:s=>{state=s;},getSecret:()=>'',countTokens:async(_c,_k,m,options)=>{assert.equal(options.adaptInstruction,true);assert.equal(options.disableThinking,true);measurements++;return m.reduce((n,m)=>n+m.content.length*2,0);},completion:async(c,_k,m,options)=>{requests++;assert.ok(m.reduce((n,m)=>n+m.content.length*2,0)<=1024-c.maxTokens-32);assert.equal(options.adaptInstruction,true);return 'Ключевые события.';}});
 await memory.summarize(chat.id);assert.ok(measurements>requests);assert.ok(requests>1);const ranges=state.chats[0].memory.flatMap(m=>m.sources).sort((a,b)=>a.start-b.start);let end=0;for(const range of ranges){assert.equal(range.start,end);end=range.end;}assert.equal(end,before[0].content.length);assert.deepEqual(state.chats[0].messages,before);assert.equal(pendingMemory(state.chats[0]).length,0);
});
test('Unfinished RP replies are not written into chronological memory until completed',()=>{
 const chat={memory:[],messages:[{id:'partial',role:'assistant',content:'Незаконченный факт',interrupted:true},{id:'done',role:'assistant',content:'Подтверждённый факт.'}]};assert.deepEqual(pendingMemory(chat).map(p=>p.id),['done']);
});
