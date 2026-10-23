import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {sanitizeState} from '../server/store.mjs';
test('Room status uses one detached snapshot, refreshes the next read and releases it after an error',async t=>{
 let state=sanitizeState(JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'))),reads=0;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-status-snapshot-'));
 const room=createMultiplayer({getState:()=>{reads++;return structuredClone(state);},saveState:s=>{state=structuredClone(s);},getSecret:()=>'',dataDir:dir,tasks:{busy:()=>true}});
 t.after(async()=>{await room.stop();await fs.rm(dir,{recursive:true,force:true});});
 await room.start({port:0,mode:'roleplay',personaId:state.personas[0].id,chatId:state.chats[0].id});
 reads=0;const first=room.status();assert.equal(reads,1,'Do not repeatedly clone the campaign inside metadata helpers');
 first.room.scene.location='RESPONSE_ONLY';assert.notEqual(state.multiplayer.scene.location,'RESPONSE_ONLY');
 state.multiplayer.scene.location='UPDATED';reads=0;assert.equal(room.status().room.scene.location,'UPDATED');assert.equal(reads,1);
 const prior=state.lorebooks;state.lorebooks=null;assert.throws(()=>room.status());state.lorebooks=prior;
 state.multiplayer.scene.location='AFTER_ERROR';reads=0;assert.equal(room.status().room.scene.location,'AFTER_ERROR');assert.equal(reads,1);
});
