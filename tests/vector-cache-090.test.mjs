import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createVectorCache} from '../server/vector-cache.mjs';
import {createEmbeddings} from '../server/embeddings.mjs';
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
test('Vectors survive RAM eviction/restart, retain double precision and do not rewrite the full historical cache',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-vector-090-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const entries=Array.from({length:12},(_,i)=>[hash('document-'+i),[i,.123456789012345,0]]),cache=createVectorCache({dataDir:dir,maxMemoryEntries:2});await cache.writeMany(entries);assert.equal(cache.stats().memoryEntries,2);
 assert.deepEqual([...(await cache.readMany(entries.map(e=>e[0])))].sort(),entries.sort());assert.ok(cache.stats().diskHits>=10);assert.equal(cache.stats().writes,12);
 const restarted=createVectorCache({dataDir:dir,maxMemoryEntries:2});assert.deepEqual((await restarted.readMany(entries.map(e=>e[0]))).get(entries[0][0]),entries[0][1]);assert.equal(restarted.stats().writes,0);assert.equal(restarted.stats().diskHits,12);assert.equal(await fs.stat(path.join(dir,'embeddings-cache.json')).catch(()=>null),null);
});
test('Embeddings API is not called again for historical documents after restart and identity changes do not reuse incompatible vectors',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-vector-api-090-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let calls=0,inputs=0;
 const fetcher=async(_url,options)=>{const body=JSON.parse(options.body);calls++;inputs+=body.input.length;return {ok:true,json:async()=>({data:body.input.map((_,index)=>({index,embedding:[1,0,.123456789012345]}))})};};
 const state={activeConnectionId:'embedding',connections:[{id:'embedding',baseUrl:'http://127.0.0.1:12345/v1',model:'model-a'}],settings:{embeddings:{connectionId:'embedding'}}};
 const texts=Array.from({length:20},(_,i)=>'Событие старой кампании '+i),one=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher});await one.vectors(state,texts);assert.equal(inputs,20);const before=calls;
 const two=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher});await two.vectors(state,texts);assert.equal(calls,before);await two.vectors(state,['Новое событие',...texts]);assert.equal(inputs,21);
 await two.vectors({...state,connections:[{...state.connections[0],model:'model-b'}]},texts);assert.equal(inputs,41);
});
test('Corrupt vector is regenerated, legacy JSON is migrated lazily, abort cannot be mistaken for a cache hit',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-vector-migrate-090-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const key=hash('legacy'),data=[1,.2,3];await fs.writeFile(path.join(dir,'embeddings-cache.json'),JSON.stringify([[key,data]]));const cache=createVectorCache({dataDir:dir});assert.deepEqual((await cache.readMany([key])).get(key),data);assert.equal(cache.stats().legacyHits,1);assert.equal(cache.stats().writes,1);
 const file=path.join(dir,'embedding-vectors',key.slice(0,2),key+'.vec');await fs.writeFile(file,'bad');const restarted=createVectorCache({dataDir:dir});assert.deepEqual((await restarted.readMany([key])).get(key),data);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>cache.readMany([key],controller.signal));
});
