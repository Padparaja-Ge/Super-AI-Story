import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('React adventure checks expose engine difficulty, bind intended actions, prevent duplicate rolls and offer host controls',{skip:process.platform!=='win32',timeout:35000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sas-check-ui-')),env={...process.env,SAS_CHECK_UI_QA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
 let server,child,timer;
 t.after(async()=>{clearTimeout(timer);if(child?.exitCode===null)child.kill();await server?.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:15,retryDelay:100});});
 // Vite/Rollup probes process.execPath as a Node CLI on Windows. Keep build
 // tooling in Node: inside Electron that probe starts an invalid GUI app and
 // can play a Windows error sound even when the fixture window is hidden.
 const {createServer}=await import('vite');
 server=await createServer({configFile:false,root:path.resolve('.'),cacheDir:path.join(directory,'vite-cache'),optimizeDeps:{entries:['tests/fixtures/adventure-check-ui.tsx']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[{name:'adventure-ui-fixture',configureServer(vite){vite.middlewares.use('/qa-adventure',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/fixtures/adventure-check-ui.tsx"></script></body></html>');});}}],logLevel:'error'});
 await server.listen();env.SAS_CHECK_UI_QA_URL=`http://127.0.0.1:${server.httpServer.address().port}/qa-adventure`;
 child=spawn(require('electron'),[path.resolve('tests/fixtures/adventure-check-ui.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>{log=(log+chunk).slice(-16000);});child.stderr.on('data',chunk=>{log=(log+chunk).slice(-16000);});timer=setTimeout(()=>child.kill(),32000);
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,0,log);
 const proof=JSON.parse(await fs.readFile(path.join(directory,'adventure-check-ui-proof.json'),'utf8'));for(const key of ['success','challengeIsolation','singleRoll','completedRoll','resultSurvivesLogTruncation','impossibleVisible','intentPayload','freeCheckExplicit','offlineHostSkip','hostTaskPayload','hostNpcPayload'])assert.equal(proof[key],true,JSON.stringify(proof));
});
