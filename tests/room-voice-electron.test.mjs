import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('Real WebRTC exchanges audio, survives early offers and stale reconnect signals, and obeys host mute',{skip:process.platform!=='win32',timeout:35000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-voice-webrtc-')),env={...process.env,SAS_VOICE_QA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[path.resolve('tests/fixtures/room-voice.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>{log=(log+String(d)).slice(-10000);});child.stderr.on('data',d=>{log=(log+String(d)).slice(-10000);});
 const timer=setTimeout(()=>child.kill(),30000);t.after(async()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'sas-voice-webrtc-')));await fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:100});});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,log);const proof=JSON.parse(await fs.readFile(path.join(dir,'voice-proof.json'),'utf8'));
 assert.equal(proof.success,true,JSON.stringify(proof));assert.equal(proof.reconnected,true);assert.equal(proof.cancelledJoin,true);assert.equal(proof.hostMuteVerified,true);assert.equal(proof.narrativeUnchanged,true);assert.ok(proof.initialAudio.every(peers=>peers.some(p=>p.audio.some(audio=>audio.bytesReceived>500&&audio.totalAudioEnergy>0))));assert.deepEqual(proof.finalErrors,[[],[]]);
});
