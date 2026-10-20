import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createStore} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';
import {createTasks} from '../server/tasks.mjs';
import {createDiagnostics,safeDiagnostic} from '../server/diagnostics.mjs';
import {applyModelProfile} from '../shared/model-profiles.mjs';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-save-091-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('Autosave OFF keeps current session in RAM across task, flush and close; restart sees last explicit save',async t=>{
 const dir=await fixture(t),s=createStore(dir),file=path.join(dir,'state.json'),before=await fs.readFile(file,'utf8');await s.setAutosave({enabled:false});
 const state=s.getState();state.settings.userName='RAM_ONLY';state.chats[0].summary='PRIVATE_SESSION';s.saveState(state);
 const tasks=createTasks({flush:()=>s.autoCheckpoint('task')});await tasks.run({kind:'test'},async()=>{}).promise;await s.flush();await s.close();
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(s.getState().settings.userName,'RAM_ONLY');assert.equal(s.autosaveStatus().dirty,true);assert.deepEqual((await fs.readdir(dir)).filter(n=>n.endsWith('.tmp')),[]);
 const restart=createStore(dir);assert.equal(restart.autosaveStatus().enabled,false);assert.notEqual(restart.getState().settings.userName,'RAM_ONLY');await restart.close();
});
test('Manual save works with autosave OFF, while later edits remain unsaved',async t=>{
 const dir=await fixture(t),s=createStore(dir);await s.setAutosave({enabled:false});const state=s.getState();state.settings.userName='SAVED_MANUALLY';s.saveState(state);const saved=await s.persist();assert.equal(saved.dirty,false);assert.equal(saved.enabled,false);
 const next=s.getState();next.settings.userName='UNSAVED_AFTER_MANUAL';s.saveState(next);await s.close();const restart=createStore(dir);assert.equal(restart.getState().settings.userName,'SAVED_MANUALLY');assert.equal(restart.autosaveStatus().enabled,false);await restart.close();
});
test('Fresh manual-only store can save even before first edit',async t=>{
 const dir=await fixture(t);await fs.writeFile(path.join(dir,'autosave-policy.json'),JSON.stringify({enabled:false}));const s=createStore(dir);assert.equal(s.autosaveStatus().dirty,true);await s.persist();assert.ok((await fs.stat(path.join(dir,'state.json'))).isFile());assert.equal(s.autosaveStatus().dirty,false);await s.close();
});
test('Interval coalesces saves, turning OFF cancels the timer, task and close flags are respected',async t=>{
 const dir=await fixture(t),s=createStore(dir),file=path.join(dir,'state.json');await s.setAutosave({intervalSeconds:1,onTaskComplete:false,onClose:false});let before=await fs.readFile(file,'utf8');let state=s.getState();state.settings.userName='DEFERRED';s.saveState(state);await s.autoCheckpoint('task');assert.equal(await fs.readFile(file,'utf8'),before);await delay(1100);await s.flush();assert.equal(JSON.parse(await fs.readFile(file,'utf8')).settings.userName,'DEFERRED');
 before=await fs.readFile(file,'utf8');state=s.getState();state.settings.userName='CANCELLED_TIMER';s.saveState(state);await s.setAutosave({enabled:false});await delay(1100);await s.close();assert.equal(await fs.readFile(file,'utf8'),before);await assert.rejects(s.setAutosave({intervalSeconds:NaN}));
});
test('Autosave policy validates types and re-enabling immediate mode writes the latest RAM state',async t=>{
 const dir=await fixture(t),s=createStore(dir);await assert.rejects(s.setAutosave({enabled:'false'}));await assert.rejects(s.setAutosave({intervalSeconds:-1}));await s.setAutosave({enabled:false});let state=s.getState();state.settings.userName='ENABLE_LATEST';s.saveState(state);await s.setAutosave({enabled:true,intervalSeconds:0});assert.equal(JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).settings.userName,'ENABLE_LATEST');await s.close();
});
test('HTTP manual save and export preserve manual-only semantics, API changes remain in RAM until requested',async t=>{
 const dir=await fixture(t),runtime=await startServer({port:0,dataDir:dir});t.after(()=>runtime.close());const base='http://127.0.0.1:'+runtime.port,headers={'Content-Type':'application/json','X-SAS-Client':'test'},file=path.join(dir,'state.json');
 let response=await fetch(base+'/api/autosave',{method:'PUT',headers,body:JSON.stringify({enabled:false})});assert.equal(response.status,200);const before=await fs.readFile(file,'utf8');const state=runtime.app.locals.runtime.store.getState();state.settings.userName='HTTP_RAM_ONLY';runtime.app.locals.runtime.store.saveState(state);
 assert.equal((await (await fetch(base+'/api/autosave/export')).json()).settings.userName,'HTTP_RAM_ONLY');assert.equal(await fs.readFile(file,'utf8'),before);response=await fetch(base+'/api/autosave/save',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).dirty,false);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).settings.userName,'HTTP_RAM_ONLY');await runtime.close();
});
test('Diagnostics discard content/secrets and rotate a bounded log without exporting arbitrary fields',async t=>{
 const dir=await fixture(t),log=createDiagnostics({dataDir:dir,maxBytes:500,retained:2});await log.ready;const sanitized=safeDiagnostic('test',{content:'SECRET_STORY',headers:{Authorization:'SECRET_KEY'},text:'PRIVATE_TEXT',status:403,route:'https://private/?token=TOPSECRET'});assert.equal(sanitized.content,undefined);assert.equal(sanitized.headers,undefined);assert.equal(sanitized.route,'[redacted]');
 for(let i=0;i<50;i++)log.record('event',{status:200,content:'SECRET_STORY',token:'TOPSECRET',name:'safe'});await log.close();const files=await fs.readdir(path.join(dir,'logs'));assert.ok(files.length<=3);const text=(await Promise.all(files.map(f=>fs.readFile(path.join(dir,'logs',f),'utf8')))).join('');assert.doesNotMatch(text,/SECRET_STORY|TOPSECRET|PRIVATE_TEXT/);assert.match(text,/session_stop/);
});
test('Model presets keep user paths, embeddings and unrelated settings; experts/template reset to model defaults',()=>{
 const before={userName:'Owner',localModelPaths:['F:\\models'],embeddingModel:'bge',localRuntime:{expertUsedCount:8,chatTemplate:'chatml'},localSampling:{temperature:2}},after=applyModelProfile(before,'multiverse-moe');assert.equal(after.userName,before.userName);assert.deepEqual(after.localModelPaths,before.localModelPaths);assert.equal(after.embeddingModel,'bge');assert.equal(after.localRuntime.expertUsedCount,0);assert.equal(after.localRuntime.chatTemplate,'gguf');assert.equal(before.localRuntime.expertUsedCount,8);assert.throws(()=>applyModelProfile(before,'missing'));
});
