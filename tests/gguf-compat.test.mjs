import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readGguf} from '../server/gguf.mjs';
import {compatibleGguf,modelLoadError,modelCompatibilityCache,parseGgufHeader,pruneCompatibilityCache} from '../server/gguf-compat.mjs';
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const string=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
function fixture({architecture='qwen35',sections=[11,11,10],padding='',splitCount=1,alignment=32}={}){
 const fields=[...Object.entries({'general.architecture':architecture,'general.name':'Compatibility fixture','general.description':padding,'general.alignment':alignment,'split.count':splitCount}).map(([key,value])=>Buffer.concat([string(key),u32(typeof value==='string'?8:4),typeof value==='string'?string(value):u32(value)])),Buffer.concat([string(architecture+'.rope.dimension_sections'),u32(9),u32(4),u64(sections.length),...sections.map(u32)])];
 const tensor=Buffer.concat([string('token_embd.weight'),u32(1),u64(16),u32(0),u64(0)]);
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(fields.length),...fields,tensor]);
 return Buffer.concat([header,Buffer.alloc((alignment-header.length%alignment)%alignment),Buffer.from(Array.from({length:64},(_,i)=>i))]);
}
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-gguf-compat-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));return {dir,file:path.join(dir,'source.gguf'),cache:path.join(dir,'cache')};}
test('Qwen3.5 repair pads MRoPE metadata, preserves every tensor byte and original file across alignment boundaries',async t=>{
 const {dir,cache}=await setup(t);
 for(const architecture of ['qwen35','qwen35moe'])for(let padding=0;padding<32;padding++){
  const file=path.join(dir,architecture+padding+'.gguf'),original=fixture({architecture,padding:'x'.repeat(padding)});await fs.writeFile(file,original);
  const oldInfo=await readGguf(file),progress=[];assert.deepEqual(oldInfo.ropeSections,[11,11,10]);
  const result=await compatibleGguf(file,cache,{onProgress:p=>progress.push(p)}),fixed=await fs.readFile(result.modelPath);
  assert.notEqual(result.modelPath,file);assert.equal(result.compatibility,'qwen35-mrope-4');assert.deepEqual(result.info.ropeSections,[11,11,10,0]);
  assert.deepEqual(fixed.subarray(result.info.dataStart),original.subarray(oldInfo.dataStart));assert.deepEqual(await fs.readFile(file),original);
  assert.equal(result.info.parameterCount,oldInfo.parameterCount);assert.ok(progress.length);
  const stat=await fs.stat(result.modelPath),again=await compatibleGguf(file,cache);assert.equal(again.cached,true);assert.equal((await fs.stat(again.modelPath)).mtimeMs,stat.mtimeMs);
 }
});
test('Valid four-section Qwen and unrelated architectures are passed through without creating cache files',async t=>{
 const {file,cache}=await setup(t);
 for(const options of [{sections:[11,11,10,0]},{architecture:'llama'},{architecture:'gemma4'}]){
  await fs.writeFile(file,fixture(options));const result=await compatibleGguf(file,cache);assert.equal(result.modelPath,file);assert.equal(result.compatibility,undefined);
 }
 await assert.rejects(fs.access(cache),{code:'ENOENT'});
});
test('Split models and invalid Qwen sections are rejected precisely; cancellation leaves original unchanged',async t=>{
 const {dir,file,cache}=await setup(t);
 // Independent models must not share a metadata cache key on coarse Windows timestamps.
 const splitFile=path.join(dir,'split.gguf'),invalidFile=path.join(dir,'invalid.gguf');
 await fs.writeFile(splitFile,fixture({splitCount:2}));await assert.rejects(compatibleGguf(splitFile,cache),/разделённый/);
 await fs.writeFile(invalidFile,fixture({sections:[0,0,0]}));await assert.rejects(compatibleGguf(invalidFile,cache),/Некорректные секции/);
 const original=fixture();await fs.writeFile(file,original);await assert.rejects(compatibleGguf(file,cache,{signal:AbortSignal.abort()}),{name:'AbortError'});assert.deepEqual(await fs.readFile(file),original);
});
test('Truncated compatibility cache is rebuilt and partial files are removed when interrupted',async t=>{
 const {file,cache}=await setup(t);await fs.writeFile(file,fixture());const first=await compatibleGguf(file,cache);await fs.writeFile(first.modelPath,'broken');
 const fixed=await compatibleGguf(file,cache);assert.deepEqual(fixed.info.ropeSections,[11,11,10,0]);
 await fs.rm(cache,{recursive:true});const controller=new AbortController();await assert.rejects(compatibleGguf(file,cache,{signal:controller.signal,onProgress(){controller.abort();}}),{name:'AbortError'});
 assert.deepEqual((await fs.readdir(cache)).filter(name=>name.endsWith('.part')),[]);
});
test('Model errors distinguish incompatible metadata, unknown architecture, VRAM exhaustion and generic exits',()=>{
 assert.match(modelLoadError('key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3',1),/MRoPE/);
 assert.doesNotMatch(modelLoadError('unknown model architecture: future',1),/Уменьшите/);
 assert.match(modelLoadError('CUDA error: out of memory',1),/недостаточно памяти/);
 assert.doesNotMatch(modelLoadError('invalid tensor shape',1),/контекст|GPU/);
});
test('Compatibility cache follows the configured model download folder',async t=>{
 const {dir}=await setup(t);assert.equal(await modelCompatibilityCache(dir),path.join(dir,'models','.sas-compat'));
 const custom=path.join(dir,'custom-models');await fs.writeFile(path.join(dir,'model-storage.json'),JSON.stringify({modelsDir:custom}));assert.equal(await modelCompatibilityCache(dir),path.join(custom,'.sas-compat'));
});

// Ollama single-file Qwen3.5 layout: vision (v.*) and MTP (mtp.*) tensors packed in,
// SSM dt bias without ".bias", per-layer KV heads and Ollama-only metadata keys.
const kv=(key,type,payload)=>Buffer.concat([string(key),u32(type),payload]);
const array=(values,item=4)=>Buffer.concat([u32(item),u64(values.length),...values.map(u32)]);
const bool=value=>Buffer.from([value?1:0]);
function ollamaFixture({architecture='qwen35',reordered=true,kvHeads=[0,0,0,2],extraTensor}={}){
 const entries=[kv('general.architecture',8,string(architecture)),kv('general.parameter_count',10,u64(999)),kv(architecture+'.block_count',4,u32(4)),kv(architecture+'.full_attention_interval',4,u32(4)),kv(architecture+'.attention.head_count',4,u32(8)),kv(architecture+'.attention.head_count_kv',9,array(kvHeads)),kv(architecture+'.rope.dimension_sections',9,array([11,11,10])),kv(architecture+'.mrope_sections',9,array([11,11,10])),kv(architecture+'.rope.mrope_interleaved',7,bool(true)),...(reordered===null?[]:[kv(architecture+'.ssm.v_head_reordered',7,bool(reordered))]),kv(architecture+'.vision.block_count',4,u32(2)),kv(architecture+'.image_token_id',4,u32(5)),kv('tokenizer.ggml.tokens',9,Buffer.concat([u32(8),u64(2),string('a'),string('b')]))];
 // Vision and MTP tensors sit between text tensors, so the copy must skip ranges, not just truncate.
 const tensors=[['token_embd.weight',4],['blk.0.ssm_dt',2],['v.blk.0.attn_q.weight',8],['blk.0.ssm_a',2],['blk.3.attn_q.weight',4],['mtp.fc.weight',4],['output_norm.weight',4],...(extraTensor?[[extraTensor,2]]:[])].map(([name,count],index)=>({name,count,data:Buffer.from(Array.from({length:count*4},(_,i)=>(index*37+i)&255))}));
 let offset=0;const infos=tensors.map(t=>{const info=Buffer.concat([string(t.name),u32(1),u64(t.count),u32(0),u64(offset)]);t.offset=offset;offset+=Math.ceil(t.data.length/32)*32;return info;});
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(entries.length),...entries,...infos]);
 return {tensors,bytes:Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),...tensors.map(t=>Buffer.concat([t.data,Buffer.alloc(Math.ceil(t.data.length/32)*32-t.data.length)]))])};
}
test('Ollama Qwen3.5 build becomes a llama.cpp copy with identical text tensor bytes; source stays untouched',async t=>{
 const {file,cache}=await setup(t),fixture=ollamaFixture();await fs.writeFile(file,fixture.bytes);
 const source=await readGguf(file);assert.deepEqual(source.ollamaLayout,{ssmDt:1,vision:1,mtp:1,vHeadReordered:true});
 const result=await compatibleGguf(file,cache),copy=await fs.readFile(result.modelPath),parsed=parseGgufHeader(copy);
 assert.equal(result.compatibility,'qwen35-ollama');assert.equal(result.cached,false);assert.equal(result.info.ollamaLayout,undefined);assert.deepEqual(result.info.ropeSections,[11,11,10,0]);
 assert.equal(result.info.kvHeads,2);assert.equal(result.info.layerwiseAttention,false);assert.equal(result.info.size,copy.length);
 assert.deepEqual(parsed.tensors.map(t=>t.name),['token_embd.weight','blk.0.ssm_dt.bias','blk.0.ssm_a','blk.3.attn_q.weight','output_norm.weight']);
 const keys=parsed.entries.map(e=>e.key);
 for(const key of ['general.parameter_count','qwen35.mrope_sections','qwen35.rope.mrope_interleaved','qwen35.ssm.v_head_reordered','qwen35.vision.block_count','qwen35.image_token_id'])assert.ok(!keys.includes(key),key);
 const original=parseGgufHeader(fixture.bytes),raw=key=>parsed.entries.find(e=>e.key===key)?.raw;
 assert.deepEqual(raw('tokenizer.ggml.tokens'),original.entries.find(e=>e.key==='tokenizer.ggml.tokens').raw);
 assert.deepEqual(parsed.entries.find(e=>e.key==='qwen35.attention.head_count_kv').value,2);
 const dataStart=Math.ceil(parsed.end/32)*32;
 for(const tensor of parsed.tensors){
  const before=fixture.tensors.find(t=>t.name===tensor.name.replace(/\.bias$/,''));assert.equal(tensor.offset%32,0);
  assert.deepEqual(copy.subarray(dataStart+tensor.offset,dataStart+tensor.offset+before.data.length),before.data,tensor.name);
 }
 assert.deepEqual(await fs.readFile(file),fixture.bytes);
 const receipt=JSON.parse(await fs.readFile(result.modelPath+'.json','utf8'));assert.equal(receipt.repair,'qwen35-ollama');assert.equal(receipt.source,path.resolve(file));assert.equal(receipt.sourceSize,fixture.bytes.length);
 const again=await compatibleGguf(file,cache);assert.equal(again.cached,true);assert.equal(again.modelPath,result.modelPath);
});
test('Unrecognised Ollama Qwen3.5 variants are refused before any copy is written',async t=>{
 const {dir,cache}=await setup(t);
 for(const [name,options] of Object.entries({unordered:{reordered:false},unmarked:{reordered:null},moe:{architecture:'qwen35moe'},heads:{kvHeads:[0,2,0,2]},tensor:{extraTensor:'blk.1.ssm_mystery.weight'},layer:{extraTensor:'blk.9.ssm_a'}})){
  const file=path.join(dir,name+'.gguf');await fs.writeFile(file,ollamaFixture(options).bytes);
  await assert.rejects(compatibleGguf(file,cache),/собран для Ollama/,name);
 }
 await assert.rejects(fs.access(cache),{code:'ENOENT'});
});
test('Compatibility cache drops copies of moved or changed models and abandoned partial files only',async t=>{
 const {dir,cache}=await setup(t);await fs.mkdir(cache);const now=Date.now(),hours=h=>new Date(now-h*3600000);
 const kept=path.join(dir,'kept.gguf'),changed=path.join(dir,'changed.gguf');await fs.writeFile(kept,'GGUF kept');await fs.writeFile(changed,'GGUF changed');
 const stat=await fs.stat(kept),changedStat=await fs.stat(changed);
 const copy=async(name,receipt)=>{await fs.writeFile(path.join(cache,name+'.gguf'),'copy');if(receipt)await fs.writeFile(path.join(cache,name+'.gguf.json'),JSON.stringify(receipt));};
 await copy('current',{source:kept,sourceSize:stat.size,sourceMtimeMs:stat.mtimeMs});
 await copy('moved',{source:path.join(dir,'gone.gguf'),sourceSize:1,sourceMtimeMs:1});
 await copy('replaced',{source:changed,sourceSize:changedStat.size+1,sourceMtimeMs:changedStat.mtimeMs});
 await copy('legacy',{identity:'x',size:4,repair:'qwen35-mrope-4'});
 await copy('unreceipted');
 for(const [name,age] of [['abandoned.part',7],['active.part',0]]){const part=path.join(cache,name);await fs.writeFile(part,'partial');await fs.utimes(part,hours(age),hours(age));}
 assert.deepEqual((await pruneCompatibilityCache(cache,now)).sort(),['abandoned.part','moved.gguf','replaced.gguf']);
 assert.deepEqual((await fs.readdir(cache)).sort(),['active.part','current.gguf','current.gguf.json','legacy.gguf','legacy.gguf.json','unreceipted.gguf']);
 if(process.platform==='win32'){
  // A model on a drive that is not attached right now may come back; its copy is kept.
  const letters='ZYXWVUTSRQPONMLKJIHG'.split('');let missing;for(const letter of letters)if(!await fs.stat(letter+':\\').then(()=>true,()=>false)){missing=letter;break;}
  if(missing){await copy('detached',{source:missing+':\\models\\model.gguf',sourceSize:1,sourceMtimeMs:1});assert.deepEqual(await pruneCompatibilityCache(cache,now),[]);assert.ok((await fs.readdir(cache)).includes('detached.gguf'));}
 }
 assert.deepEqual(await pruneCompatibilityCache(path.join(dir,'missing')),[]);
});
test('Load errors from a foreign tensor layout point to the converter, not to memory settings',()=>{
 for(const log of ["llama_model_load: error loading model: check_tensor_dims: tensor 'blk.0.ssm_dt.bias' not found",'done_getting_tensors: wrong number of tensors; expected 883, got 427',"check_tensor_dims: tensor 'output.weight' has wrong shape"]){
  const message=modelLoadError(log,1);assert.match(message,/Ollama/);assert.match(message,/не исправит/);assert.doesNotMatch(message,/Уменьшите/);
 }
});
