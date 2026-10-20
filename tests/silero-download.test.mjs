import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {downloadSileroModel} from '../server/tts/silero.mjs';

const bytes=Buffer.from('SILERO_OFFLINE_TEST_WEIGHT_0123456789');
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
async function fixture(t,handler){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-silero-download-')),calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);handler(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`,destination=path.join(dir,'fixture.pt');
 const model={id:'fixture',bytes:bytes.length,file:{path:'fixture.pt',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),url:url+'/canonical',mirrors:[url+'/mirror']}};
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-silero-download-'));await fs.rm(dir,{recursive:true,force:true});});
 return {dir,destination,calls,model,url};
}
const missing=file=>assert.rejects(fs.stat(file),{code:'ENOENT'});

test('Silero model tries each mirror once, then canonical, and deduplicates repeated URLs',async t=>{
 const f=await fixture(t,(req,res)=>{if(req.url==='/canonical')res.end(bytes);else{res.statusCode=503;res.end('unavailable');}});
 f.model.file.mirrors=[f.url+'/mirror',f.url+'/mirror',f.url+'/second'];
 await downloadSileroModel(f.model,f.destination);assert.deepEqual(f.calls,['/mirror','/second','/canonical']);assert.deepEqual(await fs.readFile(f.destination),bytes);
 assert.deepEqual(await fs.readdir(f.dir),['fixture.pt']);
});

test('A valid existing Silero file is verified locally and never downloaded again',async t=>{
 const f=await fixture(t,(_req,res)=>{res.statusCode=500;res.end();});await fs.writeFile(f.destination,bytes);
 await downloadSileroModel(f.model,f.destination);assert.deepEqual(f.calls,[]);assert.deepEqual(await fs.readFile(f.destination),bytes);assert.deepEqual(await fs.readdir(f.dir),['fixture.pt']);
});

for(const reason of ['wrong-size','wrong-sha'])test(`A ${reason} existing Silero file is preserved in quarantine and repaired`,async t=>{
 const f=await fixture(t,(_req,res)=>res.end(bytes)),original=reason==='wrong-size'?Buffer.from('broken'):Buffer.alloc(bytes.length,88);await fs.writeFile(f.destination,original);
 await downloadSileroModel(f.model,f.destination);assert.deepEqual(await fs.readFile(f.destination),bytes);assert.deepEqual(f.calls,['/mirror']);
 const quarantines=(await fs.readdir(f.dir)).filter(name=>new RegExp('^fixture\\.pt\\.corrupt-'+uuid+'$','i').test(name));assert.equal(quarantines.length,1);assert.deepEqual(await fs.readFile(path.join(f.dir,quarantines[0])),original);
});

test('A partial file left by a previous crash is preserved rather than overwritten or trusted',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(bytes)),partial=Buffer.from('PREVIOUS_INTERRUPTED_BYTES');await fs.writeFile(f.destination+'.sas-part',partial);
 await downloadSileroModel(f.model,f.destination);assert.deepEqual(await fs.readFile(f.destination),bytes);await missing(f.destination+'.sas-part');
 const abandoned=(await fs.readdir(f.dir)).filter(name=>name.startsWith('fixture.pt')&&new RegExp('\\.abandoned-'+uuid+'$','i').test(name));assert.equal(abandoned.length,1);assert.deepEqual(await fs.readFile(path.join(f.dir,abandoned[0])),partial);
});

test('A bad mirror payload rolls progress back before the successful fallback',async t=>{
 const wrong=Buffer.alloc(bytes.length,42),f=await fixture(t,(req,res)=>res.end(req.url==='/mirror'?wrong:bytes)),progress=[];
 await downloadSileroModel(f.model,f.destination,{onBytes:n=>progress.push(n)});assert.deepEqual(f.calls,['/mirror','/canonical']);assert.deepEqual(await fs.readFile(f.destination),bytes);
 assert.ok(progress.some(n=>n<0),'Failed mirror bytes must be subtracted from progress');let total=0;for(const delta of progress){assert.ok(Number.isFinite(delta));total+=delta;assert.ok(total>=0&&total<=bytes.length,`Progress ${total} outside 0..${bytes.length}`);}assert.equal(total,bytes.length);
});

test('All failed URLs terminate without committing corrupt model bytes',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(Buffer.from('truncated'))),progress=[];
 await assert.rejects(downloadSileroModel(f.model,f.destination,{onBytes:n=>progress.push(n)}));assert.deepEqual(f.calls,['/mirror','/canonical']);await missing(f.destination);await missing(f.destination+'.sas-part');assert.equal(progress.reduce((sum,n)=>sum+n,0),0);
});

test('Abort cancels an active mirror and prevents any canonical fallback',async t=>{
 const f=await fixture(t,(req,res)=>{if(req.url==='/mirror'){res.write(bytes.subarray(0,5));}else res.end(bytes);}),controller=new AbortController();let received=false;
 await assert.rejects(downloadSileroModel(f.model,f.destination,{signal:controller.signal,onBytes:n=>{if(n>0){received=true;controller.abort(new Error('TEST_ABORT'));}}}));assert.equal(received,true);assert.deepEqual(f.calls,['/mirror']);await missing(f.destination);await missing(f.destination+'.sas-part');
 const prior=f.calls.length,alreadyAborted=new AbortController();alreadyAborted.abort();await assert.rejects(downloadSileroModel(f.model,f.destination,{signal:alreadyAborted.signal}));assert.equal(f.calls.length,prior);
});

test('Invalid model hashes and file names are rejected before any file or network mutation',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(bytes));await fs.writeFile(f.destination,Buffer.from('KEEP_EXISTING'));const original=await fs.readFile(f.destination);
 for(const patch of [{sha256:''},{sha256:'g'.repeat(64)},{sha256:'0'.repeat(63)},{path:'../fixture.pt'},{path:'nested/fixture.pt'},{path:'nested\\fixture.pt'},{path:''}]){
  const model={...f.model,file:{...f.model.file,...patch}};await assert.rejects(downloadSileroModel(model,f.destination));assert.deepEqual(await fs.readFile(f.destination),original);assert.deepEqual(await fs.readdir(f.dir),['fixture.pt']);
 }
 assert.deepEqual(f.calls,[]);
});

test('Directories and symbolic links are rejected without touching their target',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(bytes));await fs.mkdir(f.destination);await fs.writeFile(path.join(f.destination,'keep.txt'),'KEEP_DIRECTORY');
 await assert.rejects(downloadSileroModel(f.model,f.destination));assert.equal(await fs.readFile(path.join(f.destination,'keep.txt'),'utf8'),'KEEP_DIRECTORY');assert.deepEqual(f.calls,[]);
 const linked=path.join(f.dir,'linked.pt'),target=path.join(f.dir,'link-target');await fs.mkdir(target);await fs.writeFile(path.join(target,'keep.txt'),'KEEP_LINK_TARGET');
 // A Windows junction exercises the same lstat.isSymbolicLink guard without
 // requiring administrator privileges or changing developer-mode settings.
 await fs.symlink(target,linked,process.platform==='win32'?'junction':'dir');await assert.rejects(downloadSileroModel(f.model,linked));assert.equal((await fs.lstat(linked)).isSymbolicLink(),true);assert.equal(await fs.readFile(path.join(target,'keep.txt'),'utf8'),'KEEP_LINK_TARGET');assert.deepEqual(f.calls,[]);
});
