import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pruneSileroRuntime,sileroRuntimeDevelopmentFile} from '../server/tts/silero-engine.mjs';
async function fixture(t){const storage=await fs.mkdtemp(path.join(os.tmpdir(),'sas-silero-prune-')),runtime=path.join(storage,'runtime','silero-cpu');await fs.mkdir(runtime,{recursive:true});await fs.writeFile(path.join(runtime,'sas-ready.json'),JSON.stringify({provider:'silero',version:1,device:'cpu',platform:process.platform,arch:process.arch,portable:process.platform==='win32'}));const write=async(name,value='preserved')=>{const file=path.join(runtime,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);return file;};t.after(async()=>{const resolved=path.resolve(storage);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('sas-silero-prune-'));await fs.rm(resolved,{recursive:true,force:true});});return {storage,runtime,write};}
test('Silero pruning deletes only compiler artifacts and bytecode, preserving runtime and license files byte for byte',async t=>{
 const f=await fixture(t),deleted=['Lib/site-packages/torch/lib/dnnl.lib','Lib/site-packages/torch/lib/sub/extra.lib','Lib/site-packages/torch/include/ATen/tensor.h','Lib/site-packages/torch/share/cmake/Torch/TorchConfig.cmake','Lib/site-packages/torch/__pycache__/module.cpython-312.pyc'],kept=['python.exe','Lib/site-packages/torch/lib/torch_cpu.dll','Lib/site-packages/torch/_C.pyd','Lib/site-packages/torch/__init__.py','Lib/site-packages/torch/include/runtime.py','Lib/site-packages/torch/include/LICENSE.txt','Lib/site-packages/torch/include/model.bin','Lib/site-packages/torch-2.5.1+cpu.dist-info/LICENSE','Lib/site-packages/torch-2.5.1+cpu.dist-info/metadata.txt','models/voice.pt','other/lib/runtime.lib'];
 for(const file of [...deleted,...kept])await f.write(file,file);const result=await pruneSileroRuntime(f.runtime,{storage:f.storage});assert.equal(result.removedFiles,deleted.length);assert.equal(result.beforeBytes-result.afterBytes,result.removedBytes);
 for(const file of deleted)await assert.rejects(fs.access(path.join(f.runtime,file)));for(const file of kept)assert.equal(await fs.readFile(path.join(f.runtime,file),'utf8'),file);assert.equal((await pruneSileroRuntime(f.runtime,{storage:f.storage})).removedFiles,0);
});
test('Silero pruning rejects unknown markers and directories outside the exact runtime namespace before deleting anything',async t=>{
 const f=await fixture(t),file=await f.write('Lib/site-packages/torch/lib/test.lib');
 await fs.writeFile(path.join(f.runtime,'sas-ready.json'),JSON.stringify({provider:'xtts',version:1,device:'cpu'}));await assert.rejects(pruneSileroRuntime(f.runtime,{storage:f.storage}),/marker/);assert.equal(await fs.readFile(file,'utf8'),'preserved');
 await assert.rejects(pruneSileroRuntime(f.runtime,{storage:path.join(f.storage,'other')}),/путь/);assert.equal(await fs.readFile(file,'utf8'),'preserved');
});
test('Silero pruning audits links before deleting any developer artifact',async t=>{
 const f=await fixture(t),file=await f.write('Lib/site-packages/torch/lib/test.lib'),outside=path.join(f.storage,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep.lib'),'external');
 try{await fs.symlink(outside,path.join(f.runtime,'external-link'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symlink unavailable');return;}throw error;}
 await assert.rejects(pruneSileroRuntime(f.runtime,{storage:f.storage}),/ссылк/);assert.equal(await fs.readFile(file,'utf8'),'preserved');assert.equal(await fs.readFile(path.join(outside,'keep.lib'),'utf8'),'external');
});
test('Silero developer-file matching preserves DLL/PYD/PY/model assets and dist-info licenses',()=>{
 for(const relative of ['Lib/site-packages/torch/lib/dnnl.lib','lib/python3.11/site-packages/torch/include/ATen/core/Tensor.h','Lib/site-packages/torch/share/cmake/TorchConfig.cmake','Lib/__pycache__/abc.pyc'])assert.equal(sileroRuntimeDevelopmentFile(relative),true,relative);
 for(const relative of ['Lib/site-packages/torch/lib/torch_cpu.dll','Lib/site-packages/torch/include/real.py','Lib/site-packages/torch/include/model.pt','Lib/site-packages/torch/include/weights.bin','Lib/site-packages/torch/share/cmake/LICENSE','Lib/site-packages/torch-2.5.1.dist-info/LICENSE.txt','other/library.lib'])assert.equal(sileroRuntimeDevelopmentFile(relative),false,relative);
});
