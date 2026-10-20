import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {downloadRoomBinary} from '../server/room-network-download.mjs';
const bytes=Buffer.from('MZ-test-safe-component-content'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-network-download-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));return {file:path.join(dir,'component.part'),size:bytes.length,sha256};}
test('A slow continuously progressing component download outlives the inactivity timeout',async t=>{
 const f=await fixture(t);let timer;
 await downloadRoomBinary({...f,idleMs:200,attempts:1,fetchResponse:async()=>new Response(new ReadableStream({start(c){let i=0;timer=setInterval(()=>{c.enqueue(bytes.subarray(i,i+3));i+=3;if(i>=bytes.length){clearInterval(timer);c.close();}},40);},cancel(){clearInterval(timer);}}))});assert.deepEqual(await fs.readFile(f.file),bytes);
});
test('Dropped binary stream resumes its partial bytes and verifies the complete digest',async t=>{
 const f=await fixture(t),offsets=[];
 await downloadRoomBinary({...f,fetchResponse:async offset=>{offsets.push(offset);if(!offset)return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,8));setTimeout(()=>c.error(Error('network drop')),10);}}));return new Response(bytes.subarray(offset),{status:206,headers:{'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}});}});
 assert.deepEqual(offsets,[0,8]);assert.deepEqual(await fs.readFile(f.file),bytes);
});
test('A later installation reuses partial data, and a server ignoring Range safely restarts the file',async t=>{
 const f=await fixture(t);await assert.rejects(downloadRoomBinary({...f,attempts:1,fetchResponse:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,6));setTimeout(()=>c.error(Error('offline')),10);}}))}),/часть сохранена/);assert.equal((await fs.stat(f.file)).size,6);
 let offset;await downloadRoomBinary({...f,fetchResponse:async n=>{offset=n;return new Response(bytes);}});assert.equal(offset,6);assert.deepEqual(await fs.readFile(f.file),bytes);
});
test('Stalled download times out without deleting its partial; malformed range and corrupt digest never install',async t=>{
 const f=await fixture(t);await assert.rejects(downloadRoomBinary({...f,attempts:1,idleMs:30,fetchResponse:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,4));}}))}),/часть сохранена/);assert.equal((await fs.stat(f.file)).size,4);
 await assert.rejects(downloadRoomBinary({...f,fetchResponse:async()=>new Response(bytes.subarray(4),{status:206,headers:{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`}})}),/диапазон/);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 await assert.rejects(downloadRoomBinary({...f,fetchResponse:async()=>new Response(Buffer.alloc(bytes.length))}),/SHA256/);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 await downloadRoomBinary({...f,fetchResponse:async()=>new Response(bytes)});assert.deepEqual(await fs.readFile(f.file),bytes);
});
