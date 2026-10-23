import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {startServer} from '../server/index.mjs';
import {extensionPackage} from '../server/extensions.mjs';
const manifest={apiVersion:2,id:'test-tools',name:'Test',version:'1.0.0',description:'Test extension',frontend:'index.js',backend:'server.mjs',styles:['style.css'],modes:['dnd','custom']};
const enable=async f=>{const record=(await f.request('')).data.extensions[0];return f.request('/test-tools/enabled',{enabled:true,trusted:true,revision:record.revision,digest:record.digest},'PUT');};
const bundle=()=>({manifest,files:{'index.js':'export function activate(sas){sas.registerPage({id:"page",title:"Test",mount(){}});}',
 'style.css':'.test-tools {color: red}',
 'server.mjs':`export async function activate(sas){const previous=await sas.storage.read();await sas.storage.write({...previous.value,activations:(previous.value.activations||0)+1},previous.revision);sas.route('get','/hello',(_req,res)=>res.json({id:sas.id}));sas.onPrompt(ctx=>'ONLY_THIS_MODE_'+ctx.mode);return ()=>{};}`}});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-extensions-090-')),server=await startServer({port:0,dataDir:dir});const request=async(url,body,method)=>{const res=await fetch(`http://127.0.0.1:${server.port}/api/extensions`+url,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json().catch(()=>null)};};t.after(async()=>{await server.close();await fs.rm(dir,{recursive:true,force:true});});return {request,server,dir,runtime:server.app.locals.runtime};}
test('Executable extension stays inert until trust, activates backend/storage, exposes scoped routes, disables and retains notes',async t=>{
 const f=await fixture(t),before=f.runtime.store.getState();
 const installed=await f.request('/install',bundle());assert.equal(installed.status,201);assert.equal(installed.data.enabled,false);
 assert.equal((await f.request('/test-tools/actions/hello')).status,409);
 assert.equal((await f.request('/test-tools/enabled',{enabled:true},'PUT')).status,400);
 assert.equal((await enable(f)).data.enabled,true);
 assert.equal((await f.request('/test-tools/actions/hello')).data.id,'test-tools');
 assert.equal((await f.request('/test-tools/storage')).data.value.activations,1);
 const info=(await f.request('')).data.extensions[0];
 const file=await fetch(`http://127.0.0.1:${f.server.port}/api/extensions/test-tools/${info.revision}/files/index.js`);assert.equal(file.status,200);assert.match(file.headers.get('content-type'),/javascript/);
 assert.equal((await fetch(`http://127.0.0.1:${f.server.port}/api/extensions/test-tools/${info.revision}/files/server.mjs`)).status,404);
 assert.equal(await f.runtime.extensions.prompt('roleplay',{chatId:'solo'}),'');
 assert.equal(await f.runtime.extensions.prompt('fanfic',{projectId:'other'}),'');
 assert.match(await f.runtime.extensions.prompt('dnd',{chatId:'room-a'}),/ONLY_THIS_MODE_dnd/);
 assert.equal((await f.request('/test-tools/enabled',{enabled:false},'PUT')).data.enabled,false);
 assert.equal(await f.runtime.extensions.prompt('dnd',{chatId:'room-a'}),'');
 assert.equal((await f.request('/test-tools/actions/hello')).status,409);
 assert.equal((await f.request('/test-tools',undefined,'DELETE')).data.storageRetained,true);
 const after=f.runtime.store.getState();assert.deepEqual(after,before,'Plugin lifecycle/storage must not alter story state');
});
test('Plugin storage uses revision conflicts; updates require trust again and survive a process restart',async t=>{
 const f=await fixture(t);await f.request('/install',bundle());await enable(f);
 const saved=(await f.request('/test-tools/storage')).data;
 assert.equal((await f.request('/test-tools/storage',{value:{notes:'ROOM_ONLY'},revision:saved.revision},'PUT')).status,200);
 assert.equal((await f.request('/test-tools/storage',{value:{notes:'STALE'},revision:saved.revision},'PUT')).status,409);
 const updated=bundle();updated.manifest={...manifest,version:'1.1.0'};const result=await f.request('/install',updated);assert.equal(result.data.enabled,false);
 assert.equal((await f.request('/test-tools/storage')).data.value.notes,'ROOM_ONLY');
 await f.server.close();const restarted=await startServer({port:0,dataDir:f.dir});t.after(()=>restarted.close());const listed=await fetch(`http://127.0.0.1:${restarted.port}/api/extensions`).then(r=>r.json());assert.equal(listed.extensions[0].enabled,false);assert.equal(listed.extensions[0].version,'1.1.0');
});
test('A broken backend is isolated and does not corrupt state or stop the core server',async t=>{
 const f=await fixture(t),broken=bundle();broken.files['server.mjs']='export function activate(){throw new Error("PLUGIN_BROKEN")}';await f.request('/install',broken);const enabled=await enable(f);assert.equal(enabled.status,200);assert.equal(enabled.data.enabled,false);assert.match(enabled.data.error,/PLUGIN_BROKEN/);assert.equal((await fetch(`http://127.0.0.1:${f.server.port}/api/state`)).status,200);
});
test('Package validation rejects traversal, missing modules, unknown modes, symlinks and oversized decompression',()=>{
 assert.throws(()=>extensionPackage({...bundle(),manifest:{...manifest,id:'../bad'}}));
 assert.throws(()=>extensionPackage({...bundle(),files:{'../escape.js':'bad'}}));
 assert.throws(()=>extensionPackage({...bundle(),manifest:{...manifest,modes:['all']}}));
 assert.throws(()=>extensionPackage({...bundle(),files:{...bundle().files,'large.txt':'x'.repeat(4_000_001)}}));
 const zip=new AdmZip();zip.addFile('manifest.json',Buffer.from(JSON.stringify(manifest)));for(const [name,content] of Object.entries(bundle().files))zip.addFile(name,Buffer.from(content));
 const parsed=extensionPackage({zip:zip.toBuffer().toString('base64')});assert.equal(parsed.manifest.id,'test-tools');
 const symlink=new AdmZip();symlink.addFile('manifest.json',Buffer.from(JSON.stringify(manifest)));symlink.addFile('index.js',Buffer.from('target'));const linked=symlink.getEntry('index.js');linked.header.attr=0o120777*65536;assert.throws(()=>extensionPackage({zip:symlink.toBuffer().toString('base64')}));
 const entry=zip.getEntry('index.js');entry.entryName='../escape.js';assert.throws(()=>extensionPackage({zip:zip.toBuffer().toString('base64')}));
});

test('A hanging prompt hook times out, receives an abort signal and leaves other modes untouched',async t=>{
 const f=await fixture(t),pkg=bundle();pkg.files['server.mjs']=`export function activate(sas){sas.onPrompt(context=>new Promise(resolve=>context.signal.addEventListener('abort',()=>resolve('LATE'))));}`;
 await f.request('/install',pkg);await enable(f);
 const start=Date.now();assert.equal(await f.runtime.extensions.prompt('dnd',{}),'');assert.ok(Date.now()-start<6000);assert.match((await f.request('')).data.extensions[0].error,/timeout/);
 assert.equal(await f.runtime.extensions.prompt('fanfic',{}),'');
});
