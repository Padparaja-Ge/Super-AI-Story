import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('Web D&D keeps open panels, selected checks, drafts and map canvas across room updates',{skip:process.platform!=='win32',timeout:25000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sas-game-ui-')),env={...process.env,SAS_GAME_UI_QA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[path.resolve('tests/fixtures/room-game-ui.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
 child.stdout.on('data',chunk=>{log=(log+chunk).slice(-12000);});child.stderr.on('data',chunk=>{log=(log+chunk).slice(-12000);});
 const timer=setTimeout(()=>child.kill(),22000);
 t.after(async()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();await fs.rm(directory,{recursive:true,force:true,maxRetries:15,retryDelay:100});});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,0,log);
 const proof=JSON.parse(await fs.readFile(path.join(directory,'game-ui-proof.json'),'utf8'));
 for(const key of ['success','panelsPreserved','selectionPreserved','draftPreserved','canvasPreserved','mobileUsable','challengeIsolation','singleRoll','completedRoll','resultSurvivesLogTruncation','impossibleVisible','intentPreserved','intentPayload','freeCheckExplicit','offlineHostSkip'])assert.equal(proof[key],true,JSON.stringify(proof));
});
