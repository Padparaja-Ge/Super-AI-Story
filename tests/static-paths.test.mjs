import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import {startWebServer} from '../server/web.mjs';
import {createComfyRouter} from '../server/comfy.mjs';

test('Web index and SPA routes work when the application directory contains hidden parents',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-ui-path-')),frontendDir=path.join(dir,'.workspace','.cache','dist');
 await fs.mkdir(path.join(frontendDir,'assets'),{recursive:true});
 const html='<!doctype html><title>SAS test</title><div id="root"></div>';
 await fs.writeFile(path.join(frontendDir,'index.html'),html);await fs.writeFile(path.join(frontendDir,'assets','main.js'),'window.sasReady=true;');
 const web=await startWebServer({host:'127.0.0.1',port:0,dataDir:path.join(dir,'data'),networkFile:path.join(dir,'network.json'),coreMode:'embedded',frontendDir});
 t.after(async()=>{await web.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:3});});
 for(const route of ['/','/fanfic/episode']){const response=await fetch(`http://127.0.0.1:${web.port}${route}`);assert.equal(response.status,200);assert.equal(await response.text(),html);}
 const asset=await fetch(`http://127.0.0.1:${web.port}/assets/main.js`);assert.equal(asset.status,200);assert.match(await asset.text(),/sasReady/);
});

test('Stored images can be served from a data directory with hidden parents',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-image-path-')),dataDir=path.join(dir,'.private','data'),file='abcdef.png',content=Buffer.from('image fixture');
 const router=createComfyRouter({getState:()=>({images:[{id:'image',status:'done',files:[file]}]}),saveState:()=>{},getSecret:()=>'',tasks:{},dataDir});
 await fs.writeFile(path.join(dataDir,'images',file),content);
 const app=express();app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await router.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true,maxRetries:3});});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/images/image/0`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),content);
});
