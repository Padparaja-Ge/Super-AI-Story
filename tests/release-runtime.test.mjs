import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

const require=createRequire(import.meta.url),AdmZip=require('adm-zip');
const root=path.resolve(import.meta.dirname,'..');
const digest=data=>createHash('sha256').update(data).digest('hex');

test('Runtime preparation verifies the archive before replacing files and rejects unsafe paths',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-runtime-import-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3}));
 await fs.mkdir(path.join(dir,'scripts'));await fs.copyFile(path.join(root,'scripts/prepare-runtime.mjs'),path.join(dir,'scripts/prepare-runtime.mjs'));
 await fs.cp(path.dirname(require.resolve('adm-zip/package.json')),path.join(dir,'node_modules/adm-zip'),{recursive:true});
 const name='engines/llama/example/cpu/llama-server.exe',content=Buffer.from('fixture runtime');
 const base={format:2,repository:'Padparaja-Ge/Super-AI-Story',version:'0.9.5',files:[{path:name,size:content.length,sha256:digest(content)}]};
 function run(manifest,extra){
  const zip=new AdmZip();zip.addFile('.sas-payload.json',Buffer.from(JSON.stringify(manifest)));zip.addFile(name,content);extra?.(zip);
  const file=path.join(dir,'runtime.zip');zip.writeZip(file);
  return spawnSync(process.execPath,[path.join(dir,'scripts/prepare-runtime.mjs'),'--archive',file],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:15000});
 }
 const target=path.join(dir,'runtime/llama/example/cpu/llama-server.exe');
 const valid=run(base);assert.equal(valid.status,0,valid.stderr);assert.deepEqual(await fs.readFile(target),content);
 await fs.writeFile(target,'existing runtime');
 const damaged=structuredClone(base);damaged.files[0].sha256='0'.repeat(64);assert.notEqual(run(damaged).status,0);
 assert.equal(await fs.readFile(target,'utf8'),'existing runtime');
 const unsafe=structuredClone(base);unsafe.files[0].path='engines/../../escaped.txt';assert.notEqual(run(unsafe).status,0);
 assert.equal(await fs.access(path.join(dir,'escaped.txt')).then(()=>true,()=>false),false);
 assert.notEqual(run(base,zip=>zip.addFile('engines/unlisted.txt',Buffer.from('unlisted'))).status,0);
 assert.deepEqual((await fs.readdir(dir)).filter(name=>name.startsWith('.runtime-prepare-')),[]);
});
