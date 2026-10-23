import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {startServer} from '../server/index.mjs';
import {extensionPackage,extensionDigest} from '../server/extensions.mjs';
import {releaseNetworkConfig} from '../scripts/release-config.mjs';
const bundle=()=>({manifest:{apiVersion:2,id:'trust-test',name:'Trust test',version:'1',description:'Trust boundary',frontend:'index.js',backend:'server.mjs',permissions:['studio:full-access','node:full-access']},files:{'index.js':'export function activate(){}','server.mjs':'export function activate(sas){sas.route("get","/ok",(req,res)=>res.json({ok:true}));}'}});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-trust-'));let server=await startServer({port:0,dataDir:dir});
 const request=async(url='',body,method=body?'POST':'GET')=>{const res=await fetch(`http://127.0.0.1:${server.port}/api/extensions${url}`,{method,headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const enable=r=>request('/trust-test/enabled',{enabled:true,trusted:true,revision:r.revision,digest:r.digest},'PUT');
 t.after(async()=>{await server.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,request,enable,restart:async edit=>{await server.close();await edit?.();server=await startServer({port:0,dataDir:dir});}};
}
test('Trust manifest is explicit, normalized identically for JSON/ZIP, and rejects false declarations',()=>{
 const p=bundle(),parsed=extensionPackage(p);assert.deepEqual(parsed.manifest.permissions,p.manifest.permissions);
 for(const permissions of [[],['node:full-access'],['filesystem:read'],['studio:full-access','studio:full-access'],false])assert.throws(()=>extensionPackage({...p,manifest:{...p.manifest,permissions}}));
 const old=bundle();delete old.manifest.permissions;assert.equal(extensionDigest(extensionPackage(old)),extensionDigest(parsed));
 const zip=new AdmZip();zip.addFile('manifest.json',Buffer.from(JSON.stringify(p.manifest)));for(const [file,content] of Object.entries(p.files))zip.addFile(file,Buffer.from(content));assert.equal(extensionDigest(extensionPackage({zip:zip.toBuffer().toString('base64')})),extensionDigest(parsed));
 for(const file of ['package.json','manifest.json'])assert.throws(()=>extensionPackage({...p,files:{...p.files,[file]:'{}'}}));
});
test('A confirmation cannot enable a newer revision or skip the displayed digest',async t=>{
 const f=await fixture(t),first=(await f.request('/install',bundle())).data;
 assert.equal((await f.request('/trust-test/enabled',{enabled:true,trusted:true},'PUT')).status,409);
 const updated=bundle();updated.manifest.version='2';updated.files['server.mjs']+='\n// new revision';const second=(await f.request('/install',updated)).data;
 assert.notEqual(first.digest,second.digest);assert.equal((await f.enable(first)).status,409);
 assert.equal((await f.request()).data.extensions[0].enabled,false);
 assert.equal((await f.enable(second)).data.enabled,true);assert.equal((await f.request('/trust-test/actions/ok')).data.ok,true);
 await f.restart();assert.equal((await f.request()).data.extensions[0].enabled,true);
});
test('Changed backend files cannot execute after restart and legacy consent cannot bypass verification',async t=>{
 const f=await fixture(t),r=(await f.request('/install',bundle())).data;await f.enable(r);
 const marker=path.join(f.dir,'untrusted-executed');
 await f.restart(async()=>{await fs.writeFile(path.join(f.dir,'extensions/packages/trust-test',r.revision,'server.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');export function activate(){}`);});
 assert.equal((await f.request()).data.extensions[0].enabled,false);assert.equal(await fs.stat(marker).catch(()=>null),null);
 const next=(await f.request('/install',bundle())).data;await f.enable(next);
 await f.restart(async()=>{const file=path.join(f.dir,'extensions/registry.json'),items=JSON.parse(await fs.readFile(file,'utf8'));delete items[0].approval;await fs.writeFile(file,JSON.stringify(items));});
 assert.equal((await f.request()).data.extensions[0].enabled,false);
});
test('Changed frontend resource is blocked before serving and safe mode prevents trusted backend activation',async t=>{
 const f=await fixture(t),r=(await f.request('/install',bundle())).data;await f.enable(r);
 await fs.appendFile(path.join(f.dir,'extensions/packages/trust-test',r.revision,'index.js'),'\n// tamper');
 assert.equal((await f.request(`/trust-test/${r.revision}/files/index.js`)).status,409);assert.equal((await f.request()).data.extensions[0].enabled,false);
 const before=process.env.SAS_DISABLE_EXTENSIONS;process.env.SAS_DISABLE_EXTENSIONS='1';
 try{await f.restart();const n=(await f.request('/install',bundle())).data;assert.equal((await f.enable(n)).status,400);}finally{if(before===undefined)delete process.env.SAS_DISABLE_EXTENSIONS;else process.env.SAS_DISABLE_EXTENSIONS=before;}
});
test('Release configuration is key-free and loopback-only regardless of the personal config',async()=>{
 const config=JSON.parse(await releaseNetworkConfig());assert.equal(config.accessKey,'');assert.equal(config.host,'127.0.0.1');assert.equal(config.mode,'allowlist');assert.deepEqual(config.allowlist,['localhost','127.0.0.1']);
 const ignores=await fs.readFile(new URL('../.gitignore',import.meta.url),'utf8');for(const pattern of ['/web-server.json','/distribution/web-server.json','.env','data/'])assert.ok(ignores.split(/\r?\n/).includes(pattern));
 const web=await fs.readFile(new URL('../scripts/package-web.mjs',import.meta.url),'utf8');assert.match(web,/zip.append\(await releaseNetworkConfig\(\),\{name:'web-server.json'\}\)/);
});
