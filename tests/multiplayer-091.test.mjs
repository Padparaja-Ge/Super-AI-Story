import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {createMultiplayerClient} from '../server/multiplayer-client.mjs';
import {createRoomBackups,campaignBundle,restoreCampaign,validateCampaignBundle} from '../server/room-backups.mjs';
import {correctRoom} from '../server/room-corrections.mjs';
import {roomAutosaveSettings} from '../shared/room-autosave.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {roomChat} from '../server/room-memory.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {sanitizeState} from '../server/store.mjs';
const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const pause=()=>new Promise(r=>setTimeout(r,15));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await pause();}throw Error('Timed out');}
const persona={id:'srp-test',kind:'srp',name:'Рей',className:'Воин',abilities:defaultAbilities(),inventory:[],spells:[]};
async function setup(t,{mode='dnd',lobby=true,autosave=true}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-mp-091-'));let state=sanitizeState(structuredClone(seed));state.personas.push(persona);state.multiplayer={};state.fanficProjects=[{id:'private-fanfic',summary:'PRIVATE_FANFIC'}];state.chats[0].summary='PRIVATE_SOLO';const translations=[];
 const getState=()=>structuredClone(state),saveState=s=>{state=structuredClone(s);};let saveEnabled=autosave;
 const room=createMultiplayer({getState,saveState,getSecret:()=>'',dataDir:path.join(dir,'host'),canAutoSave:()=>saveEnabled,tasks:{busy:()=>true},translationService:{async translate(text,source,target,provider){translations.push({text,source,target,provider});return {translation:'DISPLAY_TRANSLATION_ONLY',provider};}}});
 const opened=await room.start({port:0,personaId:persona.id,newHistory:true,mode,chatId:state.chats[0].id,lobby});const clients=[];
 const makeClient=()=>{const c=createMultiplayerClient({getState:()=>({personas:[persona]}),dataDir:path.join(dir,'guest-'+clients.length),canAutoSave:()=>saveEnabled});clients.push(c);return c;};
 const join=c=>c.join({url:opened.url,personaId:persona.id,name:'Гость'});
 t.after(async()=>{for(const c of clients)await c.close();await room.stop();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,room,opened,makeClient,join,get state(){return state;},saveState,translations,setAutoSave:v=>{saveEnabled=v;},getState};
}
test('Lobby hides history and engine before host approval, gates ready/start and protects HTTP archive',async t=>{
 const f=await setup(t),client=f.makeClient();let s=f.state;s.multiplayer.messages.push({id:'private',role:'assistant',content:'CAMPAIGN_ARCHIVE'});f.saveState(s);
 const waiting=await f.join(client),id=waiting.selfId;assert.equal(waiting.admission,'pending');assert.deepEqual(waiting.messages,[]);assert.equal(waiting.room.tactical,undefined);assert.equal(f.room.status().participants.length,1);assert.equal(f.room.status().room.lobby.players[0].status,'pending');assert.ok(!f.state.multiplayer.tactical.actors.some(a=>a.id===id));
 assert.throws(()=>f.room.lobby({action:'configure',enabled:false}),/заявки/);
 await assert.rejects(client.command('message',{content:'Слишком рано'}),/допуска/);await assert.rejects(client.command('lobby-ready',{ready:true}),/допуска/);assert.throws(()=>f.room.hostMessage('Рано'),/лобби/);await assert.rejects(f.room.generate(),/лобби/);
 assert.equal((await fetch(`http://127.0.0.1:${f.opened.port}/export?code=${f.opened.code}`)).status,404);
 const status=f.room.lobby({action:'approve',playerId:id});assert.ok(status.room.tactical.actors.some(a=>a.id===id));await until(()=>client.status().admission==='approved');assert.equal(client.status().messages[0].content,'CAMPAIGN_ARCHIVE');assert.equal(client.status().resumeToken,undefined);
 assert.throws(()=>f.room.lobby({action:'start'}),/готовности/);await client.command('lobby-ready',{ready:true});f.room.lobby({action:'start'});assert.equal(f.room.status().room.lobby.phase,'playing');const game=f.state.multiplayer.tactical;if(game.order[game.turn]==='host')assert.equal(f.room.hostMessage('Начали').message.content,'Начали');else{await client.command('message',{content:'Начали'});assert.equal(f.state.multiplayer.messages.at(-1).content,'Начали');}
});
test('Lobby pause/resume retains an admitted player sheet, and returning identity bypasses new-request approval',async t=>{
 const f=await setup(t),c=f.makeClient(),waiting=await f.join(c),id=waiting.selfId;f.room.lobby({action:'approve',playerId:id});await until(()=>c.status().admission==='approved');await c.command('lobby-ready',{ready:true});f.room.lobby({action:'start'});
 let state=f.state;const actor=state.multiplayer.tactical.actors.find(a=>a.id===id);actor.hp=3;actor.slots=1;actor.level=4;f.saveState(state);await c.leaveAsync();await until(()=>f.state.multiplayer.tactical.actors.find(a=>a.id===id).online===false);f.room.lobby({action:'pause'});
 const returned=await f.join(c);assert.equal(returned.selfId,id);assert.equal(returned.admission,'approved');assert.equal(f.state.multiplayer.tactical.actors.find(a=>a.id===id).hp,3);assert.equal(f.state.multiplayer.tactical.actors.filter(a=>a.id===id).length,1);await assert.rejects(c.command('dice',{sides:20}),/лобби/);
});
test('Host rejects a pending lobby request without adding a persona or an actor',async t=>{
 const f=await setup(t),c=f.makeClient(),pending=await f.join(c);f.room.lobby({action:'reject',playerId:pending.selfId});await until(()=>!c.status().connected);assert.equal(f.state.multiplayer.personas[pending.selfId],undefined);assert.ok(!f.state.multiplayer.tactical.actors.some(a=>a.id===pending.selfId));assert.equal(f.room.status().room.lobby.players.length,0);
});
test('Explicit GM corrections are audited and never reroll or reapply damage',async t=>{
 const f=await setup(t,{lobby:false}),room=f.state.multiplayer,g=room.tactical;g.eventArchive=[{id:'event',text:'Старое попадание',calculation:{kind:'attack',damage:5},round:1}];g.log=structuredClone(g.eventArchive);room.messages=[{id:'die',kind:'dice',role:'user',content:'Бросок d20: 2',dice:{sides:20,value:2}}];const hp=g.actors[0].hp;
 const event=correctRoom(room,{kind:'event',eventId:'event',text:'Уточнённое попадание',reason:'Опечатка'});assert.equal(g.eventArchive[0].text,'Уточнённое попадание');assert.equal(g.log[0].text,'Уточнённое попадание');assert.equal(g.actors[0].hp,hp);assert.equal(event.audit.mechanicsReapplied,false);
 correctRoom(room,{kind:'dice',messageId:'die',value:17,reason:'Мастер исправляет результат'});assert.equal(room.messages[0].dice.value,17);assert.equal(g.actors[0].hp,hp);assert.throws(()=>correctRoom(room,{kind:'dice',messageId:'die',value:21,reason:'Неверный кубик'}));
 correctRoom(room,{kind:'actor',actorId:'host',patch:{hp:3,actions:0},reason:'Исправление сбоя'});assert.equal(g.actors[0].hp,3);assert.equal(g.actors[0].actions,0);assert.equal(room.corrections.length,3);assert.ok(g.eventArchive.filter(e=>e.calculation?.kind==='host-correction').length===3);assert.throws(()=>correctRoom(room,{kind:'actor',actorId:'host',patch:{hp:10000},reason:'Неверное здоровье'}));
});
test('Campaign backups honor autosave OFF, bounded retention, manual snapshots and restore isolation',async t=>{
 const f=await setup(t,{lobby:false,autosave:false});f.room.hostMessage('Не должно быть записано автоматически');await new Promise(r=>setTimeout(r,300));assert.deepEqual((await f.room.backups()).backups,[]);
 const bundle=await f.room.backup();assert.ok((await f.room.backups()).backups.length>0);assert.equal(bundle.room.playerSessions,undefined);assert.equal(bundle.room.connectionId,undefined);assert.equal(bundle.room.media,undefined);
 f.room.configure({autosaveSettings:{enabled:false,maxSnapshots:3}});assert.throws(()=>f.room.configure({autosaveSettings:{intervalSeconds:1}}));assert.equal(roomAutosaveSettings({maxSnapshots:3}).maxSnapshots,3);
 for(let i=0;i<6;i++){f.room.hostMessage('Снимок '+i);await f.room.backup();}const backups=await f.room.backups();assert.equal(backups.backups.filter(b=>!b.latest).length,3);
 const oldChats=JSON.stringify(f.state.chats),oldFanfic=JSON.stringify(f.state.fanficProjects),oldId=f.state.multiplayer.id;await f.room.stop();const restored=await f.room.restoreBackup(bundle);assert.notEqual(restored.room.id,oldId);assert.equal(JSON.stringify(f.state.chats),oldChats);assert.equal(JSON.stringify(f.state.fanficProjects),oldFanfic);assert.ok(f.state.multiplayerHistories.some(r=>r.id===oldId));assert.equal(f.state.multiplayer.playerSessions,undefined);assert.equal(f.state.multiplayer.lobby.phase,'waiting');
 assert.throws(()=>validateCampaignBundle({...bundle,room:{...bundle.room,messages:[{id:'bad',role:'assistant',content:5}]}}));assert.throws(()=>validateCampaignBundle({...bundle,room:{...bundle.room,tactical:{...bundle.room.tactical,map:{width:100000,height:1,tiles:[],start:[]}}}}));
});
test('Approved guest archive is durable, complete, sanitized and recoverable after a client restart',async t=>{
 const f=await setup(t,{lobby:false}),c=f.makeClient();f.room.hostMessage('Наше событие');await f.join(c);const backup=await c.backup();assert.equal(backup.source,'guest');assert.equal(backup.room.playerSessions,undefined);assert.equal(backup.incompleteArchive,false);const entries=await c.recoveries();assert.equal(entries.backups.length,1);await c.close();
 const restarted=createMultiplayerClient({dataDir:path.join(f.dir,'guest-0'),getState:()=>({personas:[persona]})});const recovered=await restarted.recovery(entries.backups[0].id);assert.equal(recovered.room.messages[0].content,'Наше событие');assert.doesNotMatch(JSON.stringify(recovered),/tokenHash|resumeToken|apiKey/);assert.equal(recovered.room.id,backup.room.id);await restarted.close();
});
test('Room translation uses only an approved existing message and display translation never reaches prompt or memory',async t=>{
 const f=await setup(t,{mode:'roleplay'}),c=f.makeClient(),waiting=await f.join(c);f.room.lobby({action:'approve',playerId:waiting.selfId});await until(()=>c.status().admission==='approved');await c.command('lobby-ready',{ready:true});f.room.lobby({action:'start'});const {message}=f.room.hostMessage('ORIGINAL_ROOM_TEXT');
 const tokenFile=path.join(f.dir,'guest-0','room-resume-tokens.json');await until(()=>fs.access(tokenFile).then(()=>true,()=>false));
 const tokens=JSON.parse(await fs.readFile(tokenFile,'utf8')),token=Object.values(tokens)[0],base=`http://127.0.0.1:${f.opened.port}`,request=body=>fetch(base+'/translate?code='+f.opened.code,{method:'POST',headers:{'Content-Type':'application/json','X-SAS-Resume':token},body:JSON.stringify(body)});
 assert.equal((await request({messageId:'missing',text:'ARBITRARY_TEXT'})).status,404);const result=await(await request({messageId:message.id,targetLang:'en'})).json();assert.equal(result.translation,'DISPLAY_TRANSLATION_ONLY');assert.equal(f.translations[0].text,'ORIGINAL_ROOM_TEXT');assert.equal(f.state.multiplayer.messages.at(-1).content,'ORIGINAL_ROOM_TEXT');
 const context=f.room.context(),prompt=buildPrompt(context.state,context.chat.id,'',{extraInstructions:context.extraInstructions});assert.doesNotMatch(JSON.stringify(prompt.messages),/DISPLAY_TRANSLATION_ONLY|PRIVATE_FANFIC|PRIVATE_SOLO/);assert.equal(roomChat(f.state.multiplayer).messages.at(-1).content.includes('ORIGINAL_ROOM_TEXT'),true);
 assert.equal((await fetch(base+'/translate?code='+f.opened.code,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messageId:message.id,targetLang:'en'})})).status,403);
});
test('Global autosave OFF cancels a queued host checkpoint and prevents guest automatic or close snapshots',async t=>{
 const f=await setup(t,{lobby:false}),c=f.makeClient();f.room.hostMessage('До выключения');f.setAutoSave(false);await f.join(c);f.room.hostMessage('СЕКРЕТ ПОСЛЕ ВЫКЛЮЧЕНИЯ');await until(()=>c.status().messages.at(-1)?.content==='СЕКРЕТ ПОСЛЕ ВЫКЛЮЧЕНИЯ');await c.close();await f.room.stop();await new Promise(r=>setTimeout(r,600));
 assert.deepEqual((await f.room.backups()).backups,[]);assert.equal(await fs.stat(path.join(f.dir,'guest-0','room-last-known')).then(()=>true,()=>false),false);const bundle=await c.backup();assert.equal(bundle.room.messages.at(-1).content,'СЕКРЕТ ПОСЛЕ ВЫКЛЮЧЕНИЯ');assert.equal((await c.recoveries()).backups.length,1,'Manual save remains available while autosave is off');
});
test('Browser recovery permission cancels pending writes when host disables autosave; explicit export code is separate',async()=>{
 const {createBrowserRecovery}=await import('../server/room-recovery.js');let writes=0;const oldStorage=globalThis.localStorage,oldDB=globalThis.indexedDB;
 globalThis.localStorage={getItem:()=>null,setItem:()=>{}};globalThis.indexedDB={open(){writes++;throw Error('Autosave must not open IndexedDB');}};
 try{const browser=createBrowserRecovery();browser.checkpoint({room:{id:'test'}});browser.setAllowed(false);await browser.flush();assert.equal(writes,0);browser.setAllowed(true);browser.setEnabled(false);browser.checkpoint({room:{id:'test'}});await browser.flush();assert.equal(writes,0);}finally{globalThis.localStorage=oldStorage;globalThis.indexedDB=oldDB;}
});
test('Host can assign a restored offline hero in the lobby without resetting resources or creating a duplicate',async t=>{
 const f=await setup(t),first=f.makeClient(),pending=await f.join(first),id=pending.selfId;f.room.lobby({action:'approve',playerId:id});await until(()=>first.status().admission==='approved');let state=f.state;const a=state.multiplayer.tactical.actors.find(a=>a.id===id);a.hp=4;a.slots=2;a.level=3;f.saveState(state);await first.leaveAsync();await until(()=>f.state.multiplayer.tactical.actors.find(a=>a.id===id).online===false);
 const second=f.makeClient(),waiting=await f.join(second);assert.notEqual(waiting.selfId,id);assert.throws(()=>f.room.lobby({action:'approve',playerId:waiting.selfId,actorId:'host'}),/свободного/);f.room.lobby({action:'approve',playerId:waiting.selfId,actorId:id});await until(()=>second.status().admission==='approved');assert.equal(second.status().selfId,id);const saved=f.state.multiplayer.tactical.actors.find(a=>a.id===id);assert.equal(saved.hp,4);assert.equal(saved.slots,2);assert.equal(saved.level,3);assert.equal(f.state.multiplayer.tactical.actors.filter(a=>a.id===id).length,1);
});
test('Lobby can start a recovered incomplete round without changing its frozen roster or rerolling initiative',async t=>{
 const f=await setup(t),state=f.state;state.multiplayer.messages.push({id:'partial',role:'assistant',content:'Страж начал ',interrupted:true});state.multiplayer.narration={messageId:'partial',status:'incomplete',promptMessages:[{role:'system',content:'SNAPSHOT'}]};f.saveState(state);const before=JSON.stringify(f.state.multiplayer.tactical);f.room.lobby({action:'start'});assert.equal(f.room.status().room.lobby.phase,'playing');assert.equal(JSON.stringify(f.state.multiplayer.tactical),before);
});
test('Manual host address with no room query selects the current campaign resume key rather than another room on the same port',async t=>{
 const f=await setup(t,{lobby:false}),c=f.makeClient(),url=`http://127.0.0.1:${f.opened.port}/play?code=${f.opened.code}`,first=await c.join({url,personaId:persona.id});await c.leaveAsync();await until(()=>f.state.multiplayer.tactical.actors.find(a=>a.id===first.selfId).online===false);
 const tokenFile=path.join(f.dir,'guest-0','room-resume-tokens.json'),tokens=JSON.parse(await fs.readFile(tokenFile,'utf8'));tokens[`http://127.0.0.1:${f.opened.port}|${persona.id}`]='A'.repeat(43);await fs.writeFile(tokenFile,JSON.stringify(tokens));const next=createMultiplayerClient({dataDir:path.join(f.dir,'guest-0'),getState:()=>({personas:[persona]})});t.after(()=>next.close());const resumed=await next.join({url,personaId:persona.id});assert.equal(resumed.selfId,first.selfId);
});
test('Public room-info and static clients reveal no invitations; pending guests cannot fetch atmosphere, approved cookie supports range audio',async t=>{
 const f=await setup(t),wav=Buffer.alloc(364);wav.write('RIFF');wav.writeUInt32LE(356,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(320,40);
 const media=await f.room.mediaCommand({action:'upload',name:'Таверна',data:wav.toString('base64')}),track=media.playlist.tracks[0],base=`http://127.0.0.1:${f.opened.port}`,url=base+'/room-audio/'+track.id+'?code='+f.opened.code;
 const info=await(await fetch(base+'/room-info')).json();assert.deepEqual(Object.keys(info).sort(),['id','lobby','mode','name','sasRoom']);assert.doesNotMatch(JSON.stringify(info),new RegExp(f.opened.code));
 for(const file of ['room-client.js','room-media-runtime.js','room-media-client.js','room-media.css','room-recovery.js']){const response=await fetch(base+'/'+file);assert.equal(response.status,200,file);assert.ok((await response.text()).length>100);}
 assert.equal((await fetch(base+'/room-audio/invalid?code='+f.opened.code,{signal:AbortSignal.timeout(2000)})).status,404);assert.equal((await fetch(url)).status,403);
 const c=f.makeClient(),pending=await f.join(c);assert.equal((await fetch(url)).status,403);f.room.lobby({action:'approve',playerId:pending.selfId});await until(()=>c.status().admission==='approved');let token;await until(async()=>{try{token=Object.values(JSON.parse(await fs.readFile(path.join(f.dir,'guest-0','room-resume-tokens.json'),'utf8')))[0];return typeof token==='string'&&token.length>0;}catch(error){if(error.code==='ENOENT')return false;throw error;}});
 const admission=await fetch(base+'/admit-auth?code='+f.opened.code,{method:'POST',headers:{'X-SAS-Resume':token}});assert.equal(admission.status,204);const cookie=admission.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);const response=await fetch(url,{headers:{Cookie:cookie.split(';')[0],Range:'bytes=0-43'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await response.arrayBuffer()),wav.subarray(0,44));
 await c.command('voice',{action:'join'});for(let i=0;i<15;i++)await c.command('voice',{action:'muted',muted:true});assert.equal(f.state.multiplayer.messages.length,0,'Voice signalling never becomes chat');assert.equal(f.room.status().room.media.voice.participants.length,1);await f.room.stop();assert.equal(f.room.status().room.media.voice.participants.length,0,'Closing the room clears voice membership');
});
test('Three admitted guests and host get a complete first-round initiative tie-break only once, not on lobby pause',async t=>{
 const f=await setup(t),clients=[f.makeClient(),f.makeClient(),f.makeClient()];for(const c of clients){const waiting=await f.join(c);f.room.lobby({action:'approve',playerId:waiting.selfId});await until(()=>c.status().admission==='approved');await c.command('lobby-ready',{ready:true});}
 f.room.lobby({action:'start'});const first=structuredClone(f.state.multiplayer.tactical);assert.equal(new Set(first.order).size,4);assert.ok(first.eventArchive.filter(e=>e.calculation?.kind==='initiative-tie').length>=4,'Equal initiative of the complete party must be resolved by d20');f.room.lobby({action:'pause'});for(const c of clients)await c.command('lobby-ready',{ready:true});f.room.lobby({action:'start'});assert.deepEqual(f.state.multiplayer.tactical.order,first.order);assert.equal(f.state.multiplayer.tactical.eventArchive.filter(e=>e.calculation?.kind==='initiative-tie').length,first.eventArchive.filter(e=>e.calculation?.kind==='initiative-tie').length);
});
test('Host voice moderation reaches an actual guest socket; guests cannot remove it or moderate another participant',async t=>{
 const f=await setup(t,{lobby:false}),c=f.makeClient(),joined=await f.join(c);await c.command('voice',{action:'join'});const before=JSON.stringify(f.state.multiplayer);
 await assert.rejects(c.command('voice',{action:'moderate',target:'host',muted:true}),e=>e.status===403);f.room.voiceCommand({action:'moderate',target:joined.selfId,muted:true});await until(()=>c.status().room.media.voice.forcedMuted.includes(joined.selfId));assert.equal(c.status().room.media.voice.participants.find(p=>p.id===joined.selfId).forcedMuted,true);
 await assert.rejects(c.command('voice',{action:'muted',muted:false}),e=>e.status===403);await c.command('voice',{action:'leave'});await c.command('voice',{action:'join'});assert.ok(f.room.status().room.media.voice.forcedMuted.includes(joined.selfId));f.room.voiceCommand({action:'moderate',target:joined.selfId,muted:false});await until(()=>!c.status().room.media.voice.forcedMuted.includes(joined.selfId));assert.equal(c.status().room.media.voice.participants.find(p=>p.id===joined.selfId).muted,true);await c.command('voice',{action:'muted',muted:false});assert.equal(JSON.stringify(f.state.multiplayer),before,'Transient moderation must not write narrative or memory');
});
