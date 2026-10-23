import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {adventureActor} from '../server/adventure-engine.mjs';
import {beginInitiative} from '../server/initiative.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {sanitizeState} from '../server/store.mjs';

const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const persona={id:'sheet',name:'Герой',kind:'srp',className:'Воин',abilities:defaultAbilities(),inventory:[],spells:[]};
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for room state');}
async function setup(t,mode){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-room-disconnect-'));let state=sanitizeState(structuredClone(seed));state.personas.push(persona);state.multiplayer={};const sockets=[];
 let room=createMultiplayer({getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',dataDir:dir,tasks:{busy:()=>true}}),opened=await room.start({port:0,personaId:persona.id,mode,newHistory:true,lobby:false});
 t.after(async()=>{for(const ws of sockets)ws.terminate();await room.stop();await fs.rm(dir,{recursive:true,force:true,maxRetries:3});});
 const join=async(name,resumeToken)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${opened.port}/ws`);sockets.push(ws);const ready=new Promise((resolve,reject)=>{ws.on('message',raw=>{const data=JSON.parse(raw);if(data.type==='state')resolve(data);else if(data.type==='error')reject(Error(data.error));});ws.on('error',reject);});await once(ws,'open');ws.send(JSON.stringify({type:'join',name,code:opened.code,persona:{...persona,name},resumeToken}));const joined=await ready;
  return {ws,id:joined.selfId,token:joined.resumeToken};
 };
 const first=await join('Первый'),second=await join('Второй');
 const g=state.multiplayer.tactical;Object.assign(g.actors.find(a=>a.id==='host').abilities,{dexterity:16,strength:7});g.actors.find(a=>a.id===first.id).abilities.dexterity=12;g.actors.find(a=>a.id===second.id).abilities.dexterity=10;g.actors.push({...adventureActor('npc',{...persona,name:'Страж',abilities:{...defaultAbilities(),dexterity:8}},g.rules),player:false});g.inCombat=true;beginInitiative(g);room.act({action:'end'});assert.equal(state.multiplayer.tactical.order[state.multiplayer.tactical.turn],first.id);
 return {get room(){return room;},join,first,second,get state(){return state;},restart:async()=>{await room.stop();state=JSON.parse(JSON.stringify(state));room=createMultiplayer({getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',dataDir:dir,tasks:{busy:()=>true}});opened=await room.start({port:0,personaId:persona.id,mode,lobby:false});}};
}
for(const mode of ['dnd','custom'])test(`${mode}: two real transport drops retain unfinished turns, reconnect identity, resources and NPC order`,async t=>{
 const f=await setup(t,mode),before=structuredClone(f.state.multiplayer.tactical),turns=()=>f.state.multiplayer.tactical;
 f.first.ws.terminate();f.second.ws.terminate();await until(()=>turns().actors.filter(a=>[f.first.id,f.second.id].includes(a.id)).every(a=>a.online===false));
 assert.deepEqual(turns().order,before.order);assert.equal(turns().turn,before.turn);assert.equal(turns().phase,'players');assert.equal(turns().round,before.round);assert.deepEqual(turns().initiativeTies,before.initiativeTies);assert.throws(()=>f.room.hostMessage('Не мой ход'),/хода/);
 const second=await f.join('Второй',f.second.token);assert.equal(second.id,f.second.id);assert.equal(turns().order[turns().turn],f.first.id);
 const first=await f.join('Первый',f.first.token);assert.equal(first.id,f.first.id);assert.equal(turns().order[turns().turn],first.id);const actor=turns().actors.find(a=>a.id===first.id),old=before.actors.find(a=>a.id===first.id);for(const key of ['hp','slots','actions','fastActions','move','x','y'])assert.equal(actor[key],old[key],key);
 f.room.act({action:'end'},first.id);assert.equal(turns().order[turns().turn],second.id);first.ws.terminate();await until(()=>turns().actors.find(a=>a.id===first.id).online===false);await f.join('Первый',first.token);assert.equal(turns().order[turns().turn],second.id,'A completed player must not receive a second turn');
 f.room.act({action:'end'},second.id);assert.equal(turns().order[turns().turn],'npc');assert.equal(turns().phase,'gm');assert.equal(turns().round,before.round);assert.equal(turns().actors.filter(a=>a.id===first.id).length,1);
});
test('Explicit leave and host mute skip a pending turn; returning or unmuting cannot replay that completed position',async t=>{
 const f=await setup(t,'dnd'),g=()=>f.state.multiplayer.tactical;
 f.first.ws.close(1000,'Left room');await until(()=>g().actors.find(a=>a.id===f.first.id).online===false);assert.equal(g().order[g().turn],f.second.id);assert.equal(g().actors.find(a=>a.id===f.first.id).turnUnavailable,true);
 const back=await f.join('Первый',f.first.token);assert.equal(back.id,f.first.id);assert.equal(g().order[g().turn],f.second.id);assert.ok(!g().actors.find(a=>a.id===f.first.id).turnUnavailable);
 f.room.moderate(f.second.id,'mute');assert.equal(g().order[g().turn],'npc');f.room.moderate(f.second.id,'unmute');assert.equal(g().order[g().turn],'npc');
});
test('Host can explicitly skip the current disconnected player without acting for another or replaying a completed turn',async t=>{
 const f=await setup(t,'dnd'),g=()=>f.state.multiplayer.tactical;f.first.ws.terminate();await until(()=>g().actors.find(a=>a.id===f.first.id).online===false);
 assert.throws(()=>f.room.act({action:'end',actorId:f.first.id},f.second.id),/своим/);
 f.room.act({action:'end',actorId:f.first.id});assert.equal(g().order[g().turn],f.second.id);assert.ok(g().log.some(e=>e.calculation?.kind==='turn-skipped'&&e.calculation.actorId===f.first.id));
 await f.join('Первый',f.first.token);assert.equal(g().order[g().turn],f.second.id);assert.throws(()=>f.room.act({action:'end',actorId:f.first.id}),/ход/);
});
test('Reopening a serialized campaign retains a transport-disconnected current player and unfinished resources',async t=>{
 const f=await setup(t,'custom'),before=structuredClone(f.state.multiplayer.tactical);f.first.ws.terminate();await until(()=>f.state.multiplayer.tactical.actors.find(a=>a.id===f.first.id).online===false);await f.restart();
 let g=f.state.multiplayer.tactical;assert.deepEqual(g.order,before.order);assert.equal(g.turn,before.turn);assert.equal(g.phase,before.phase);assert.equal(g.round,before.round);assert.deepEqual(g.initiativeTies,before.initiativeTies);
 const back=await f.join('Первый',f.first.token);assert.equal(back.id,f.first.id);g=f.state.multiplayer.tactical;assert.equal(g.order[g.turn],back.id);assert.deepEqual(g.actors.find(a=>a.id===back.id).inventory,before.actors.find(a=>a.id===back.id).inventory);assert.equal(g.actors.find(a=>a.id===back.id).actions,before.actors.find(a=>a.id===back.id).actions);
});
