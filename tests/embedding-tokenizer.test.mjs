import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEmbeddings} from '../server/embeddings.mjs';
import {createGameRag} from '../server/game-rag.mjs';
import {hybridSearch} from '../server/rag/search.mjs';

async function directory(t){
 const parent=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,'sas-native-tokenizer-'));
 t.after(async()=>{assert.equal(path.dirname(await fs.realpath(dir)),parent);assert.ok(path.basename(dir).startsWith('sas-native-tokenizer-'));await fs.rm(dir,{recursive:true,force:true});});return dir;
}
function state(){return {settings:{embeddings:{connectionId:'sas-embedding'}},activeConnectionId:'story',connections:[{id:'sas-embedding',baseUrl:'http://127.0.0.1:9914/v1/',model:'bge-small',embeddingTokenLimit:128}]};}
const count=text=>Array.from(text).length+2;
const tokens=text=>Response.json({tokens:Array(count(text)).fill(1)});

test('Native embedding token counts use the authenticated local tokenizer with special tokens and a bounded cache',async t=>{
 const dir=await directory(t),received=[],service=createEmbeddings({dataDir:dir,maxTokenCountEntries:2,getSecret:id=>{assert.equal(id,'sas-embedding');return 'test-key';},fetcher:async(url,request)=>{received.push({url,request});return tokens(JSON.parse(request.body).content);}}),s=state();
 const tokenizer=await service.nativeTokenizer(s);assert.equal(tokenizer.tokenLimit,128);assert.equal(tokenizer.reserve,8);assert.equal(await tokenizer.countTokens('Ключ 🗝️'),count('Ключ 🗝️'));assert.equal(received.length,1);assert.equal(received[0].url,'http://127.0.0.1:9914/tokenize');assert.equal(received[0].request.headers.Authorization,'Bearer test-key');assert.deepEqual(JSON.parse(received[0].request.body),{content:'Ключ 🗝️',add_special:true});
 assert.equal(await service.countTokens(s,'Ключ 🗝️'),count('Ключ 🗝️'));assert.equal(received.length,1);await tokenizer.countTokens('Second');await tokenizer.countTokens('Third');assert.deepEqual(service.tokenCacheStats(),{entries:2,limit:2});await tokenizer.countTokens('Ключ 🗝️');assert.equal(received.length,4,'LRU eviction must not grow the token cache without a bound');
 assert.ok(received.every(({url})=>url.endsWith('/tokenize')),'Counting must not invoke embeddings or a text model');
});
test('Native token cache identity follows model bytes, alias and context while surviving a server port change for the same file',async t=>{
 const dir=await directory(t),file=path.join(dir,'encoder.gguf');await fs.writeFile(file,'first model');let requests=0;const service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async(_url,request)=>{requests++;return tokens(JSON.parse(request.body).content);}}),s=state();s.settings.embeddingModelPath=file;
 const first=await service.nativeTokenizer(s);await first.countTokens('Arvin');s.connections[0].baseUrl='http://127.0.0.1:9915/v1';const restarted=await service.nativeTokenizer(s);assert.equal(restarted.identity,first.identity);await restarted.countTokens('Arvin');assert.equal(requests,1);
 s.settings.embeddings.model='encoder-alias';const renamed=await service.nativeTokenizer(s);assert.notEqual(renamed.identity,first.identity);await renamed.countTokens('Arvin');assert.equal(requests,2);
 s.connections[0].embeddingTokenLimit=256;const resized=await service.nativeTokenizer(s);assert.notEqual(resized.identity,renamed.identity);assert.equal(resized.tokenLimit,256);await resized.countTokens('Arvin');assert.equal(requests,3);
 await fs.writeFile(file,'replacement model with different bytes');const changed=await service.nativeTokenizer(s);assert.notEqual(changed.identity,resized.identity);await changed.countTokens('Arvin');assert.equal(requests,4);
 const other=path.join(dir,'other.gguf');await fs.writeFile(other,'replacement model with different bytes');s.settings.embeddingModelPath=other;assert.notEqual((await service.nativeTokenizer(s)).identity,changed.identity);
});
test('Only the built-in loopback encoder offers a native counter; invalid endpoints and input never make a request',async t=>{
 const dir=await directory(t);let requests=0;const service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async()=>{requests++;throw Error('No fetch expected');}}),s=state();
 for(const baseUrl of ['https://example.com/v1','http://localhost.evil/v1','http://user:pass@127.0.0.1/v1','file:///encoder']){s.connections[0].baseUrl=baseUrl;await assert.rejects(service.nativeTokenizer(s),error=>error.code==='NATIVE_TOKENIZER_UNAVAILABLE');}
 s.connections[0].baseUrl='http://[::1]:9914/v1';const native=await service.nativeTokenizer(s);await assert.rejects(native.countTokens('x'.repeat(200001)),/200 000/);await assert.rejects(native.countTokens(17),/200 000/);
 s.connections[0].id='custom-local';s.settings.embeddings.connectionId='custom-local';assert.equal(await service.nativeTokenizer(s),null);await assert.rejects(service.countTokens(s,'Arvin'),error=>error.code==='NATIVE_TOKENIZER_UNAVAILABLE');
 s.connections[0].id='sas-embedding';s.settings.embeddings.connectionId='sas-embedding';s.connections[0].model='';await assert.rejects(service.nativeTokenizer(s),/не выбрана/);assert.equal(requests,0);
});
test('Failed or malformed native token counts are not cached and can recover on the next request',async t=>{
 const dir=await directory(t);let failure='http',requests=0;const service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async(_url,request)=>{requests++;if(failure==='http')return new Response('',{status:503});if(failure==='shape')return Response.json({tokens:[1,-1]});if(failure==='fraction')return Response.json({tokens:[1,.5]});if(failure==='missing')return Response.json({count:3});return tokens(JSON.parse(request.body).content);}}),tokenizer=await service.nativeTokenizer(state());
 await assert.rejects(tokenizer.countTokens('Arvin'),/HTTP 503/);assert.equal(service.tokenCacheStats().entries,0);
 for(const value of ['shape','fraction','missing']){failure=value;await assert.rejects(tokenizer.countTokens('Arvin'),/корректные токены/);assert.equal(service.tokenCacheStats().entries,0);}
 failure='';assert.equal(await tokenizer.countTokens('Arvin'),count('Arvin'));assert.equal(requests,5);assert.equal(await tokenizer.countTokens('Arvin'),count('Arvin'));assert.equal(requests,5);
});
test('Native counting propagates preflight and in-flight cancellation without caching a partial answer',async t=>{
 const dir=await directory(t);let requests=0,started;const ready=new Promise(resolve=>started=resolve),service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async(_url,{signal})=>{requests++;started();return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}}),s=state();
 await assert.rejects(service.nativeTokenizer(s,AbortSignal.abort()),error=>error.name==='AbortError');assert.equal(requests,0);
 const tokenizer=await service.nativeTokenizer(s);await assert.rejects(tokenizer.countTokens('Arvin',AbortSignal.abort()),error=>error.name==='AbortError');assert.equal(requests,0);
 const controller=new AbortController(),pending=tokenizer.countTokens('Arvin',controller.signal);await ready;controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(service.tokenCacheStats().entries,0);assert.equal(requests,1);
});
test('D&D native semantic documents reach the real embedding pipeline intact, without secondary splitting or pooling',async t=>{
 const dir=await directory(t),embedded=[],observed=[];let tokenRequests=0;
 const nativeCount=text=>Array.from(text).length*3+2,encoder=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async(url,request)=>{
  const body=JSON.parse(request.body);if(String(url).endsWith('/tokenize')){tokenRequests++;return Response.json({tokens:Array(nativeCount(body.content)).fill(1)});}
  assert.ok(body.input.reduce((sum,text)=>sum+nativeCount(text),0)<=120,'Real embedding requests must fit the complete encoder batch');embedded.push(...body.input);return Response.json({data:body.input.map((_text,index)=>({index,embedding:[1,.1]}))});
 }}),s=state();s.lorebooks=[{id:'world',entries:[{id:'npc',vectorized:true,content:Array.from({length:12},(_,i)=>'NPC: Arvin\nArvin keeps key '+i+'. ').join('')}]}];
 const chat={id:'room-test',roomId:'test',mode:'dnd',memorySettings:{memoryMode:'off',vectorMemory:true},lorebookIds:['world'],messages:[{id:'current',role:'user',content:'Arvin key'}]},service=createGameRag({embeddings:encoder,search:async(query,scene,options)=>{observed.push(options.chunks);return hybridSearch(query,scene,options);}});
 const result=await service.recall(s,chat);assert.equal(result.report.rag.embeddingCalls,1);assert.equal(result.report.rag.tokenizer,'native');assert.deepEqual(embedded,[chat.messages[0].content,...observed[0].map(c=>c.content)],'Semantic chunk text must map one-to-one to encoder vectors');assert.ok(observed[0].every(c=>nativeCount(c.content)<=120));const requests=tokenRequests,encoded=embedded.length;
 await service.recall(s,chat);assert.equal(tokenRequests,requests,'Unchanged chunks and cached query vectors should not be re-tokenized each turn');assert.equal(embedded.length,encoded,'Persistent vector cache should avoid repeated native encoder work');
});
