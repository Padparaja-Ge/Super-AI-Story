import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {coreFailure,launchCore,logCoreStartup} from '../server/core-startup.mjs';

async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-core-start-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));return dir;}
function worker(){const child=new EventEmitter();child.killed=false;child.unref=()=>{};child.channel={unref(){}};child.kill=()=>{child.killed=true;};return child;}

test('Core startup reuses a ready core without launching another process',async t=>{
 const dataDir=await directory(t),descriptor={pid:123,port:3210};
 assert.equal(await launchCore({dataDir,findCore:()=>descriptor,spawnImpl:()=>assert.fail('Must reuse core')}),descriptor);
});
test('Early core failure reports its code immediately and excludes sensitive error text',async t=>{
 const dataDir=await directory(t),child=worker();
 await assert.rejects(launchCore({projectRoot:dataDir,dataDir,timeoutMs:2000,pollMs:2,findCore:()=>null,spawnImpl:()=>{queueMicrotask(()=>{child.emit('message',{type:'sas:core-error',code:'EPERM',message:'PRIVATE_STORY'});child.emit('exit',1);});return child;}}),error=>error.code==='EPERM'&&/core-startup.jsonl/.test(error.message)&&!/PRIVATE_STORY/.test(error.message));
 const log=await fs.readFile(path.join(dataDir,'logs/core-startup.jsonl'),'utf8');assert.match(log,/"code":"EPERM"/);assert.ok(!log.includes('PRIVATE_STORY'));
});
test('Core startup retries a closing old instance without killing its process or deleting locks',async t=>{
 const dataDir=await directory(t),descriptor={pid:333,port:4321},children=[];let ready=false;
 await fs.writeFile(path.join(dataDir,'core.lock'),'old-instance-owned-lock');
 const result=await launchCore({projectRoot:dataDir,dataDir,timeoutMs:2000,pollMs:2,findCore:()=>ready?descriptor:null,spawnImpl:()=>{
  const child=worker();children.push(child);
  queueMicrotask(()=>{if(children.length===1){child.emit('message',{type:'sas:core-error',code:'SAS_BACKEND_RUNNING'});child.emit('exit',1);}else ready=true;});return child;
 }});
 assert.equal(result,descriptor);assert.equal(children.length,2);assert.ok(children.every(c=>!c.killed));assert.equal(await fs.readFile(path.join(dataDir,'core.lock'),'utf8'),'old-instance-owned-lock');
});
test('Core startup waits for readiness and on timeout stops only its own pending worker',async t=>{
 const dataDir=await directory(t),child=worker(),descriptor={pid:999,port:1234};let ready=false;
 const timer=setTimeout(()=>{ready=true;},30);t.after(()=>clearTimeout(timer));
 assert.equal(await launchCore({projectRoot:dataDir,dataDir,timeoutMs:1000,pollMs:2,spawnImpl:()=>child,findCore:()=>ready?descriptor:null}),descriptor);assert.equal(child.killed,false);
 const stalled=worker();await assert.rejects(launchCore({projectRoot:dataDir,dataDir,timeoutMs:30,pollMs:2,spawnImpl:()=>stalled,findCore:()=>null}),{code:'CORE_START_TIMEOUT'});assert.equal(stalled.killed,true);
});
test('Synchronous spawn failures are diagnosed and logs rotate without storing raw error messages',async t=>{
 const dataDir=await directory(t),error=Object.assign(new Error('PRIVATE_STORY secret-header'),{code:'ENOENT'});error.stack='Error: PRIVATE_STORY\n    at loader (C:/sas/core-worker.mjs:1:1)\n    at fetch (https://host.invalid/secret-token)';
 await assert.rejects(launchCore({projectRoot:dataDir,dataDir,spawnImpl:()=>{throw error;},findCore:()=>null}),{code:'ENOENT'});
 const filename=path.join(dataDir,'logs/core-startup.jsonl');let raw=await fs.readFile(filename,'utf8');assert.match(raw,/core-worker.mjs/);assert.ok(!/PRIVATE_STORY|secret-header|secret-token/.test(raw));
 await fs.writeFile(filename,'x'.repeat(257*1024));logCoreStartup(dataDir,'test',error);assert.equal((await fs.stat(filename+'.previous')).size,257*1024);raw=await fs.readFile(filename,'utf8');assert.ok(raw.length<5000);assert.equal(coreFailure({code:'unsafe code: token'}).code,'CORE_START_FAILED');
});
