import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {readGguf} from '../server/gguf.mjs';
import {moeRecommendation} from '../server/moe.mjs';
import {runtimeArgs} from '../server/local-runtime.mjs';
import {createEmbeddings,embeddingChunks,poolEmbeddings} from '../server/embeddings.mjs';
import {normalizeOptions,samplingFields} from '../shared/local-options.mjs';
import {getConnection,complete} from '../server/llm.mjs';
import {sanitizeState} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';

async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-local071-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const string=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
function fixture({moe=true,experts=4,used=2}={}){
 const values={'general.architecture':'llama','general.name':'Test model','llama.context_length':8192,'llama.block_count':2,'llama.embedding_length':64,'llama.attention.head_count':8,'llama.attention.head_count_kv':2,...(moe?{'llama.expert_count':experts,'llama.expert_used_count':used}:{})};
 const kv=Object.entries(values).map(([k,v])=>Buffer.concat([string(k),u32(typeof v==='string'?8:4),typeof v==='string'?string(v):u32(v)]));
 // Include a tokenizer array that must be skipped without retaining its strings.
 kv.push(Buffer.concat([string('tokenizer.ggml.tokens'),u32(9),u32(8),u64(2),string('unused'),string('tokens')]));
 const tensor=(name,offset)=>Buffer.concat([string(name),u32(2),u64(4),u64(4),u32(0),u64(offset)]);
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(2),u64(kv.length),...kv,tensor('token_embd.weight',0),tensor(moe?'blk.0.ffn_up_exps.weight':'blk.0.ffn_up.weight',64)]);
 return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(128)]);
}
test('GGUF inspection reads tensor sizes and real expert counts; dense and truncated models are distinguished',async t=>{
 const dir=await directory(t),file=path.join(dir,'model.gguf');await fs.writeFile(file,fixture());
 const info=await readGguf(file);assert.equal(info.isMoe,true);assert.equal(info.experts,4);assert.equal(info.activeExperts,2);assert.equal(info.expertBytes,64);assert.equal(info.activeParameters,24);assert.equal(info.contextLength,8192);assert.equal(info.kvHeads,2);
 await fs.writeFile(path.join(dir,'dense.gguf'),fixture({moe:false}));assert.equal((await readGguf(path.join(dir,'dense.gguf'))).isMoe,false);
 await fs.writeFile(path.join(dir,'broken.gguf'),fixture().subarray(0,100));await assert.rejects(readGguf(path.join(dir,'broken.gguf')),/GGUF/);
});
test('MoE placement adapts to free VRAM without changing expert routing; dense and split models do not auto-tune',()=>{
 const info={isMoe:true,expertBytes:12*1024**3,nonExpertBytes:1024**3,size:13*1024**3,layers:32,kvHeads:8,keyLength:128,valueLength:128,splitCount:1};
 const large=moeRecommendation(info,{backend:'cuda',freeMiB:24000},8192),small=moeRecommendation(info,{backend:'vulkan',freeMiB:8000},8192);
 assert.equal(large.cpuMoeLayers,0);assert.ok(small.cpuMoeLayers>0&&small.cpuMoeLayers<32);assert.ok(small.estimatedGpuBytes<8000*1048576);
 assert.equal(moeRecommendation(info,{backend:'cpu'},8192).cpuMoeLayers,32);
 assert.equal(moeRecommendation({...info,isMoe:false},{backend:'cuda',freeMiB:8000},8192).applicable,false);
 assert.equal(moeRecommendation({...info,splitCount:2},{backend:'cuda',freeMiB:8000},8192).applicable,false);
 const nonuniform={...info,layers:4,size:11*1024**3,nonExpertBytes:3*1024**3,expertBytes:8*1024**3,expertLayerBytes:[0,0,4*1024**3,4*1024**3]};
 assert.equal(moeRecommendation(nonuniform,{backend:'cuda',freeMiB:10000},8192).cpuMoeLayers,3);
});
test('Runtime keeps encoder physical and logical batches equal, validates MoE overrides and translates advanced flags',()=>{
 const input={modelPath:'model.gguf',context:2048,device:{backend:'cuda',device:'CUDA0'},port:999,key:'private'};
 const encoder=runtimeArgs({...input,embedding:true});assert.equal(encoder[encoder.indexOf('--batch-size')+1],'2048');assert.equal(encoder[encoder.indexOf('--ubatch-size')+1],'2048');assert.ok(!encoder.includes('--n-cpu-moe'));
 const args=runtimeArgs({...input,modelInfo:{isMoe:true,experts:4,architecture:'llama'},options:{threads:6,cpuMoeLayers:15,expertUsedCount:2,cacheTypeK:'q8_0',ropeScaling:'yarn',ropeScale:2,kvOffload:'off',host:'0.0.0.0'}});
 assert.equal(args[args.indexOf('--threads')+1],'6');assert.equal(args[args.indexOf('--n-cpu-moe')+1],'15');assert.equal(args[args.indexOf('--override-kv')+1],'llama.expert_used_count=int:2');assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');assert.ok(args.includes('--no-kv-offload'));assert.ok(!args.includes('--embedding'));
 assert.throws(()=>runtimeArgs({...input,options:{batchSize:32,ubatchSize:64}}),/Физическая/);
 assert.throws(()=>runtimeArgs({...input,modelInfo:{isMoe:true,experts:4},options:{expertUsedCount:5}}),/экспертов/);
 assert.throws(()=>normalizeOptions({threads:Infinity}),/Недопустимое/);assert.throws(()=>normalizeOptions({loadMode:'--host'}),/Недопустимое/);
 assert.throws(()=>normalizeOptions({topP:2},samplingFields),/Недопустимое/);
});
test('Token-aware embedding chunks preserve all text and weighted pooling remains normalized',async()=>{
 const text='The ancient tower stands beside the gate. '.repeat(30),parts=await embeddingChunks(text,80,async s=>s.length);
 assert.equal(parts.map(p=>p.text).join(''),text);assert.ok(parts.every(p=>p.tokens<=80));assert.ok(parts.some(p=>p.text.endsWith('. ')));
 const pooled=poolEmbeddings([{vector:[1,0],tokens:3},{vector:[0,1],tokens:1}]);assert.ok(Math.abs(Math.hypot(...pooled)-1)<1e-10);assert.ok(pooled[0]>pooled[1]);
 const signal=AbortSignal.abort();await assert.rejects(embeddingChunks(text,80,async s=>s.length,signal),/abort/i);
});
test('Local embeddings split real-sized queries, bound whole batches, honor returned indices and cache pooled results',async t=>{
 const dir=await directory(t),batches=[];let tokenizerCalls=0;
 const fetcher=async(url,request)=>{const body=JSON.parse(request.body);if(String(url).endsWith('/tokenize')){tokenizerCalls++;return Response.json({tokens:Array(body.content.length+2).fill(1)});}
  const tokens=body.input.reduce((n,s)=>n+s.length+2,0);assert.ok(tokens<=120);batches.push(body.input);return Response.json({data:body.input.map((s,index)=>({index,embedding:s.includes('Башня')?[1,0]:[0,1]})).reverse()});};
 const state={settings:{embeddings:{connectionId:'sas-embedding'}},activeConnectionId:'chat',connections:[{id:'sas-embedding',baseUrl:'http://127.0.0.1:999/v1',model:'bge',embeddingTokenLimit:128}]};
 const service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher}),texts=['Башня и ключ. '.repeat(80),'Рынок и музыка. '.repeat(60)];
 const result=await service.vectors(state,texts);assert.equal(result.length,2);assert.ok(result[0][0]>.9);assert.ok(batches.length>16);const calls=batches.length,tokenCalls=tokenizerCalls;
 assert.deepEqual(await service.vectors(state,texts),result);assert.equal(batches.length,calls);assert.equal(tokenizerCalls,tokenCalls);
 await assert.rejects(service.vectors(state,['']),/непустой/);
});
test('Vector retrieval supplies distant relevant memory and selected vector lore, excluding another history',async t=>{
 const dir=await directory(t),fetcher=async(url,request)=>{const b=JSON.parse(request.body);return Response.json({data:b.input.map((s,index)=>({index,embedding:s.includes('tower')?[1,0]:[0,1]}))});};
 const state={settings:{embeddings:{threshold:.8,topK:2}},activeConnectionId:'api',connections:[{id:'api',baseUrl:'http://localhost/v1',model:'embedding'}],characters:[{id:'char',lorebookIds:['book']}],lorebooks:[{id:'book',entries:[{id:'lore',name:'Guardian',content:'tower',enabled:true,vectorized:true}]},{id:'other',entries:[{id:'wrong',content:'tower',enabled:true,vectorized:true}]}]};
 const chat={characterId:'char',messages:[],memorySettings:{vectorMemory:true},memory:[{id:'old',enabled:true,content:'tower key'},{id:'market',enabled:true,content:'music'}]};
 const result=await createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher}).retrieve(state,chat,'tower');assert.deepEqual(result.memoryIds,['old']);assert.deepEqual(result.vectorLoreIds,['lore']);
});
test('Embedding 500 errors describe processing failures without incorrectly rejecting an embedding-capable model',async t=>{
 const dir=await directory(t),service=createEmbeddings({dataDir:dir,getSecret:()=>'',fetcher:async()=>new Response('',{status:500})});
 await assert.rejects(service.vectors({settings:{},connections:[{id:'api',baseUrl:'http://localhost/v1',model:'bge'}],activeConnectionId:'api'},['test']),error=>/HTTP 500.*не обработал/.test(error.message)&&!error.message.includes('Нужна модель'));
});
test('Local sampler settings reach completions while preset overrides and remote API requests keep their contracts',async t=>{
 const received=[],server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'result'},finish_reason:'stop'}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const local={id:'sas-local',model:'moe',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,maxTokens:1024,temperature:.8};
 const state={connections:[local],activeConnectionId:local.id,settings:{localSampling:{temperature:.5,maxTokens:80,topK:25,minP:.08,dryMultiplier:.6,seed:123}}};
 await complete(getConnection(state),'',[{role:'user',content:'hello'}],{preset:{temperature:.3,topP:.7,maxTokens:60}});
 assert.equal(received[0].top_k,25);assert.equal(received[0].dry_multiplier,.6);assert.equal(received[0].seed,123);assert.equal(received[0].temperature,.3);assert.equal(received[0].top_p,.7);assert.equal(received[0].max_tokens,60);
 await complete({...local,id:'remote'},'',[{role:'user',content:'hello'}]);assert.equal(received[1].min_p,undefined);assert.equal(received[1].dry_multiplier,undefined);
});
test('Old states preserve map model behavior while new separate map checkpoints survive subsequent saves',()=>{
 const old=sanitizeState({settings:{comfy:{model:'old.safetensors',mapWorkflowName:'map.json',mapWorkflow:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}}}});assert.equal(old.settings.comfy.mapModel,'old.safetensors');assert.equal(old.settings.moeAuto,true);
 old.settings.comfy.mapModel='table.safetensors';const saved=sanitizeState(old);assert.equal(saved.settings.comfy.model,'old.safetensors');assert.equal(saved.settings.comfy.mapModel,'table.safetensors');
 saved.settings.comfy.mapModel='';assert.equal(sanitizeState(saved).settings.comfy.mapModel,'');
});
test('Local model API exposes real storage folders and metadata only for registered models',async t=>{
 const dir=await directory(t),file=path.join(dir,'added.gguf');await fs.writeFile(file,fixture());const server=await startServer({port:0,dataDir:dir});t.after(()=>server.close());
 const api=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${server.port}/api`+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 assert.equal((await api('/local/import',{path:file})).status,200);const list=(await api('/local/models')).data;assert.equal(list.modelsDir,path.join(dir,'models'));assert.deepEqual(list.importedDirectories,[await fs.realpath(dir)]);
 const detail=await api('/local/models/info?'+new URLSearchParams({path:file}));assert.equal(detail.status,200);assert.equal(detail.data.info.experts,4);
 assert.equal((await api('/local/models/info?'+new URLSearchParams({path:path.join(dir,'missing.gguf')}))).status,400);
});
