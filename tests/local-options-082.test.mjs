import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readGguf} from '../server/gguf.mjs';
import {moeRecommendation,resolveRuntimeOptions} from '../server/moe.mjs';
import {runtimeArgs} from '../server/local-runtime.mjs';
import {startServer} from '../server/index.mjs';
import {normalizeOptions,samplingBody,samplingFields} from '../shared/local-options.mjs';
import {applyModelProfile,modelProfiles} from '../shared/model-profiles.mjs';

test('Context Shift, SWA cache, MMAP, Flash Attention, quantized KV and advanced samplers reach the embedded runtime',()=>{
 const options={loadMode:'mmap',contextShift:'on',swaCache:'full',flashAttention:'on',cacheTypeK:'q8_0',cacheTypeV:'q8_0'};
 const args=runtimeArgs({...input,options});
 for(const [flag,value] of [['--load-mode','mmap'],['--flash-attn','on'],['--cache-type-k','q8_0'],['--cache-type-v','q8_0']])assert.equal(args[args.indexOf(flag)+1],value);
 assert.ok(args.includes('--context-shift'));assert.ok(args.includes('--swa-full'));
 const defaults=runtimeArgs(input);assert.ok(defaults.includes('--no-context-shift'));assert.ok(!defaults.includes('--swa-full'));
 const body=samplingBody({topNSigma:1.5,adaptiveTarget:.2,adaptiveDecay:.85});assert.equal(body.top_n_sigma,1.5);assert.equal(body.adaptive_target,.2);assert.equal(body.adaptive_decay,.85);
 assert.equal(samplingBody().adaptive_target,-1);assert.equal(samplingBody().top_n_sigma,-1);
 assert.throws(()=>normalizeOptions({contextShift:'invalid'}));assert.throws(()=>normalizeOptions({adaptiveTarget:1.2},samplingFields));
});
test('The optional SAINEMO Q8 profile reduces KV memory without changing unrelated settings',()=>{
 const settings={localDevice:'cpu',localEmbeddings:true,embeddingModelPath:'keep.gguf',localRuntime:{threads:6},localSampling:{adaptiveTarget:.2}};
 const before=structuredClone(settings),profile=modelProfiles.find(p=>p.match.test('SAINEMO-reMIX.Q6_K.gguf')),applied=applyModelProfile(settings,profile.id);
 assert.equal(profile.id,'sainemo-q8-kv');assert.equal(applied.localRuntime.cacheTypeK,'q8_0');assert.equal(applied.localRuntime.cacheTypeV,'q8_0');assert.equal(applied.localRuntime.flashAttention,'on');assert.equal(applied.localRuntime.threads,6);
 assert.equal(applied.localDevice,'cpu');assert.equal(applied.localEmbeddings,true);assert.equal(applied.embeddingModelPath,'keep.gguf');assert.deepEqual(settings,before);
});

const info={isMoe:true,architecture:'llama',experts:8,activeExperts:2,size:13*1024**3,expertBytes:12*1024**3,nonExpertBytes:1024**3,layers:32,kvHeads:8,keyLength:128,valueLength:128,splitCount:1};
const device={backend:'cuda',freeMiB:8000,device:'CUDA0'};
const input={modelPath:'local.gguf',context:8192,device,port:999,key:'test-only',modelInfo:info};

test('Auto placement works from metadata for multiple MoE architectures and preserves expert routing and other manual options',()=>{
 for(const architecture of ['llama','qwen2moe','qwen3moe']){
  const model={...info,architecture},settings={moeAuto:true,localRuntime:{cpuMoeLayers:1,expertUsedCount:3,threads:6,cacheTypeK:'q8_0'}};
  const before=structuredClone(settings),result=resolveRuntimeOptions(settings,model,device,8192);
  assert.equal(result.autoApplied,true);assert.ok(result.options.cpuMoeLayers>1);
  assert.equal(result.options.expertUsedCount,3);assert.equal(result.options.threads,6);assert.equal(result.options.cacheTypeK,'q8_0');assert.deepEqual(settings,before);
  const args=runtimeArgs({...input,modelInfo:model,options:result.options});assert.equal(args[args.indexOf('--override-kv')+1],architecture+'.expert_used_count=int:3');
 }
});

test('Manual placement is kept verbatim, including zero; dense flags are not auto-tuned',()=>{
 for(const cpuMoeLayers of [0,7]){
  const result=resolveRuntimeOptions({moeAuto:false,localRuntime:{cpuMoeLayers,expertUsedCount:2}},info,device,8192);
  assert.equal(result.autoApplied,false);assert.equal(result.options.cpuMoeLayers,cpuMoeLayers);assert.equal(result.options.expertUsedCount,2);
 }
 const dense=resolveRuntimeOptions({moeAuto:true,localRuntime:{cpuFfnLayers:4,threads:5,cpuMoeLayers:7,expertUsedCount:3}},{...info,isMoe:false,experts:0,expertBytes:0},device,8192);
 assert.equal(dense.autoApplied,false);assert.equal(dense.options.cpuFfnLayers,4);assert.equal(dense.options.threads,5);assert.equal(dense.options.cpuMoeLayers,0);assert.equal(dense.options.expertUsedCount,0);
 const denseArgs=runtimeArgs({...input,modelInfo:{...info,isMoe:false},options:dense.options});assert.ok(!denseArgs.includes('--override-kv'));assert.ok(!denseArgs.includes('--n-cpu-moe'));
 assert.throws(()=>runtimeArgs({...input,options:{expertUsedCount:9}}),/экспертов/);
 assert.throws(()=>runtimeArgs({...input,options:{cpuMoeLayers:33}}),/слоёв/);
});

test('Unknown MLA, recurrent, layerwise and split memory layouts never receive a misleading automatic override',()=>{
 for(const extra of [{kvLoraRank:512},{hasRecurrentState:true},{layerwiseAttention:true},{splitCount:3},{keyLength:0}]){
  const result=resolveRuntimeOptions({moeAuto:true,localRuntime:{cpuMoeLayers:3}},{...info,...extra},device,8192);
  assert.equal(result.autoApplied,false);assert.equal(result.options.cpuMoeLayers,3);assert.equal(result.recommendation.fits,null);assert.match(result.recommendation.reason,/Автонастройка SAS/);
 }
});

test('Quantized KV estimates account for actual q5 block overhead',()=>{
 for(const [type,bytes] of [['q5_0',22/32],['q5_1',24/32],['q8_0',34/32]]){
  const result=moeRecommendation(info,device,8192,{cacheTypeK:type,cacheTypeV:type});
  assert.equal(result.kvBytes,32*8192*8*256*bytes);
 }
});

function gguf(architecture,extra={}){
 const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
 const values={'general.architecture':architecture,[architecture+'.block_count']:2,[architecture+'.context_length']:8192,[architecture+'.embedding_length']:64,[architecture+'.attention.head_count']:8,[architecture+'.attention.head_count_kv']:2,[architecture+'.expert_count']:4,[architecture+'.expert_used_count']:2,...extra};
 const kv=Object.entries(values).map(([k,v])=>Buffer.concat([str(k),u32(Array.isArray(v)?9:typeof v==='string'?8:4),Array.isArray(v)?Buffer.concat([u32(4),u64(v.length),...v.map(u32)]):typeof v==='string'?str(v):u32(v)]));
 const tensor=(name,offset)=>Buffer.concat([str(name),u32(2),u64(4),u64(4),u32(0),u64(offset)]);
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(2),u64(kv.length),...kv,tensor('token_embd.weight',0),tensor('blk.0.ffn_up_exps.weight',64)]);
 return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(128)]);
}

test('GGUF reader exposes architecture-specific caveats without reading model weights or tokenizer arrays',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-082-gguf-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const [name,arch,extra,expected] of [['mla','deepseek2',{'deepseek2.attention.kv_lora_rank':512,'deepseek2.expert_shared_count':2},{kvLoraRank:512,sharedExperts:2}],['hybrid','qwen3next',{'qwen3next.ssm.inner_size':128},{hasRecurrentState:true}],['layerwise','qwen3moe',{'qwen3moe.attention.head_count_kv':[2,4]},{layerwiseAttention:true}]]){
  const file=path.join(dir,name+'.gguf');await fs.writeFile(file,gguf(arch,extra));const actual=await readGguf(file);
  for(const [key,value] of Object.entries(expected))assert.equal(actual[key],value);
  assert.equal(actual.isMoe,true);assert.equal(moeRecommendation(actual,device,8192).applicable,false);
 }
});

test('State API queues advanced launch flags while a model is running, but keeps device/embedding and generation protection',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-082-options-'));const runtime=await startServer({port:0,dataDir:dir});t.after(async()=>{await runtime.close();await fs.rm(dir,{recursive:true,force:true});});
 const integration=runtime.app.router.stack.map(layer=>layer.handle).find(handle=>typeof handle.runtimeLocked==='function');assert.ok(integration);integration.runtimeLocked=()=>true;
 const base='http://127.0.0.1:'+runtime.port;
 const state=await (await fetch(base+'/api/state')).json();
 state.settings.localRuntime.cpuMoeLayers=7;state.settings.localRuntime.expertUsedCount=2;state.settings.moeAuto=false;
 state.settings.localRuntime.contextShift='on';state.settings.localRuntime.swaCache='full';state.settings.localRuntime.cacheTypeK='q8_0';
 state.settings.localSampling.topNSigma=1.5;state.settings.localSampling.adaptiveTarget=.2;state.settings.localSampling.adaptiveDecay=.85;
 const put=body=>fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},body:JSON.stringify(body)});
 const accepted=await put(state);assert.equal(accepted.status,200);const saved=await accepted.json();assert.equal(saved.settings.localRuntime.cpuMoeLayers,7);assert.equal(saved.settings.localRuntime.expertUsedCount,2);assert.equal(saved.settings.moeAuto,false);
 assert.equal(saved.settings.localRuntime.contextShift,'on');assert.equal(saved.settings.localRuntime.swaCache,'full');assert.equal(saved.settings.localRuntime.cacheTypeK,'q8_0');assert.equal(saved.settings.localSampling.topNSigma,1.5);assert.equal(saved.settings.localSampling.adaptiveTarget,.2);
 const denied=structuredClone(saved);denied.settings.localEmbeddings=!denied.settings.localEmbeddings;assert.equal((await put(denied)).status,409);
 let release;const task=runtime.app.locals.runtime.tasks.run({kind:'test',stage:'test'},signal=>new Promise(resolve=>{release=resolve;signal.addEventListener('abort',resolve,{once:true});}));
 const during=structuredClone(saved);during.settings.localRuntime.cpuMoeLayers=8;assert.equal((await put(during)).status,409);release();await task.promise;
 const actual=await (await fetch(base+'/api/state')).json();assert.equal(actual.settings.localRuntime.cpuMoeLayers,7);
});
