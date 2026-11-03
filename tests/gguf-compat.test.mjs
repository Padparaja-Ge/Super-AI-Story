import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readGguf} from '../server/gguf.mjs';
import {compatibleGguf,modelLoadError,modelCompatibilityCache} from '../server/gguf-compat.mjs';
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
