import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server/index.mjs';
import {createMultiplayerClient} from '../server/multiplayer-client.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {returningPlayer,rememberPlayer} from '../server/room-resume.mjs';
const pause=()=>new Promise(r=>setTimeout(r,15));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await pause();}throw Error('Timed out');}
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-resume-090-'));let server=await startServer({port:0,dataDir:path.join(dir,'host')});
 const state=server.app.locals.runtime.store.getState();state.personas.push({id:'host-test',name:'Хост',kind:'srp',className:'Воин',abilities:defaultAbilities(),inventory:[],spells:[]});server.app.locals.runtime.store.saveState(state);
 const guestState={personas:[{id:'guest-test',name:'Гость',kind:'srp',className:'Маг',abilities:defaultAbilities(),inventory:[],spells:[]}]};
 const clients=[];const client=()=>{const c=createMultiplayerClient({dataDir:path.join(dir,'guest'),getState:()=>structuredClone(guestState)});clients.push(c);return c;};
 const request=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${server.port}/api${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},body:JSON.stringify(body)});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;};
 const open=()=>request('/multiplayer/start',{port:0,mode:'dnd',personaId:'host-test',newHistory:!server.app.locals.runtime.store.getState().multiplayer?.id});
 // This suite exercises local transport and persistence, independently of the
 // runner's LAN adapters, firewall and advertised invitation address.
 const join=(c,room)=>{const url=new URL(room.url);url.hostname='127.0.0.1';return c.join({url:url.href,personaId:'guest-test'});};
 t.after(async()=>{for(const c of clients)await c.close();await server.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:3});});
 return {dir,client,join,open,request,store:()=>server.app.locals.runtime.store,restart:async()=>{await server.close();server=await startServer({port:0,dataDir:path.join(dir,'host')});}};
}
test('Guest returns after disconnect and both processes restart without replacing campaign resources or identity',async t=>{
 const f=await fixture(t),room=await f.open(),c=f.client(),joined=await f.join(c,room),id=joined.selfId;
 assert.equal(joined.resumeToken,undefined,'Private resume token must not enter public status');
 const s=f.store().getState(),a=s.multiplayer.tactical.actors.find(a=>a.id===id);a.hp=3;a.slots=1;a.level=4;a.inventory=[{id:'keepsake',name:'Памятная вещь',kind:'item',quantity:7}];f.store().saveState(s);
 c.leave();await until(()=>f.store().getState().multiplayer.tactical.actors.find(a=>a.id===id)?.online===false);
 await f.restart();const resumed=await f.open(),next=f.client(),back=await f.join(next,resumed);
 assert.equal(back.selfId,id);const restored=f.store().getState().multiplayer.tactical.actors.find(a=>a.id===id);
 assert.equal(restored.hp,3);assert.equal(restored.slots,1);assert.equal(restored.level,4);assert.equal(restored.inventory.find(i=>i.id==='keepsake').quantity,7);assert.equal(restored.online,true);
 assert.equal(f.store().getState().multiplayer.tactical.actors.filter(a=>a.id===id).length,1);
});
test('Guest exports the complete archive after leaving, although the rendered chat keeps only 300 messages',async t=>{
 const f=await fixture(t),room=await f.open();const s=f.store().getState();s.multiplayer.messages=Array.from({length:450},(_,i)=>({id:'m'+i,role:'assistant',name:'GM',content:'Запись '+i}));f.store().saveState(s);
 const c=f.client();await f.join(c,room);await f.request('/multiplayer/message',{content:'Последняя запись'});await until(()=>c.status().messages.at(-1)?.content==='Последняя запись');c.leave();
 assert.equal(c.status().messages.length,300);assert.equal(c.exportChat().messages.length,451);assert.equal(c.exportChat().messages[0].content,'Запись 0');
 const publicExport=await fetch(`http://127.0.0.1:${room.port}/export?code=${encodeURIComponent(room.code)}`).then(r=>r.json());assert.equal(publicExport.messages.length,451);assert.equal(publicExport.room.playerSessions,undefined);
});
test('Muting persists on reconnect, and kicking revokes the personal resume token',async t=>{
 const f=await fixture(t),room=await f.open(),c=f.client(),{selfId}=await f.join(c,room);
 await f.request('/multiplayer/players/'+selfId,{action:'mute'});c.leave();await until(()=>f.store().getState().multiplayer.tactical.actors.find(a=>a.id===selfId)?.online===false);
 await f.join(c,room);assert.ok(c.status().participants.find(p=>p.id===selfId).muted);await assert.rejects(c.command('message',{content:'Нельзя'}),/запретил/);
 await f.request('/multiplayer/players/'+selfId,{action:'unmute'});await f.request('/multiplayer/players/'+selfId,{action:'kick'});await until(()=>!c.status().connected);
 await assert.rejects(f.join(c,room),/Ключ возвращения/);
});
test('A guest can join a campaign whose complete text exceeds the 16 MiB WebSocket limit',async t=>{
 const f=await fixture(t),room=await f.open(),state=f.store().getState();
 state.multiplayer.messages=Array.from({length:2200},(_,i)=>({id:'long'+i,role:'assistant',name:'GM',content:'Событие '+i+' '+ 'a'.repeat(8000)}));f.store().saveState(state);
 const c=f.client();await f.join(c,room);
 assert.equal(c.status().messages.length,300);assert.equal(c.status().archiveComplete,true);assert.equal(c.exportChat().messages.length,2200);assert.ok(c.exportChat().messages[0].content.startsWith('Событие 0 '));
});
test('Resume keys are bound to a room and original persona and never restore revoked actors',()=>{
 const room={personas:{actor:{id:'persona',name:'Герой'}},tactical:{actors:[{id:'actor'}]}};const token=rememberPlayer(room,'actor','persona');
 assert.equal(returningPlayer(room,token,'persona').actorId,'actor');assert.throws(()=>returningPlayer(room,token,'other'));assert.throws(()=>returningPlayer({...room,playerSessions:{}},token,'persona'));assert.throws(()=>returningPlayer(room,'invalid','persona'));
 room.playerSessions.actor.revoked=true;assert.throws(()=>returningPlayer(room,token,'persona'));
});
