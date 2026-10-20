import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRoomMedia,normalizeIceServers,validateVoiceSignal} from '../server/room-media.mjs';
import {microphoneUnavailableReason,playlistPosition,normalizeVoiceSettings} from '../public/room-media-runtime.js';

const wav=()=>{const bytes=Buffer.alloc(1044);bytes.write('RIFF');bytes.writeUInt32LE(1036,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(1000,40);return bytes;};
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-media-091-')),room={id:randomUUID(),messages:[{id:'canon',content:'Не изменять канон.'}],memoryBlocks:[{text:'Долг трактирщика.'}],tactical:{round:4,actors:[{hp:17}]}},events=[],delivered=[];let members=[{id:'host',name:'Мастер'},{id:'player-a',name:'Алиса'},{id:'player-b',name:'Борис'}],time=100000;const controller=createRoomMedia({getRoom:()=>room,saveRoom:media=>{room.media=structuredClone(media);},broadcast:event=>events.push(event),deliver:(target,event)=>delivered.push({target,event}),participants:()=>members,dataDir,now:()=>time});t.after(async()=>{await controller.close();await fs.rm(dataDir,{recursive:true,force:true});});return {controller,room,events,delivered,dataDir,setTime:v=>time=v,setMembers:v=>members=v};}

test('room playlist stores verified local audio, synchronizes controls and never mutates narrative or resources',async t=>{
  const {controller,room,setTime}=await fixture(t),protectedState=structuredClone({messages:room.messages,memoryBlocks:room.memoryBlocks,tactical:room.tactical});
  const result=await controller.hostCommand({action:'upload',name:'Таверна.wav',data:wav().toString('base64')}),id=result.playlist.currentId;
  assert.equal(result.playlist.tracks.length,1);assert.equal(result.playlist.tracks[0].mime,'audio/wav');
  await controller.hostCommand({action:'play'});setTime(104500);await controller.hostCommand({action:'pause'});assert.equal(controller.publicState().playlist.position,4.5);
  await controller.hostCommand({action:'seek',position:42});assert.equal(controller.publicState().playlist.position,42);
  await assert.rejects(controller.hostCommand({action:'seek',position:-1}),/позиция/);
  await assert.rejects(controller.hostCommand({action:'upload',name:'bad.mp3',data:Buffer.alloc(50).toString('base64')}),/Поддерживаются/);
  await controller.hostCommand({action:'remove',id});assert.equal(controller.publicState().playlist.tracks.length,0);
  assert.deepEqual({messages:room.messages,memoryBlocks:room.memoryBlocks,tactical:room.tactical},protectedState);
});

test('audio serving enforces admission, room scoping, range/HEAD and bounded responses',async t=>{
  const {controller,room}=await fixture(t);await controller.hostCommand({action:'upload',data:wav().toString('base64')});const id=controller.publicState().playlist.currentId;
  const server=http.createServer(async(req,res)=>{if(!await controller.handleHttp(req,res,new URL(req.url,'http://localhost'),{authorized:req.headers['x-admitted']==='yes'})){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port,url=origin+'/room-audio/'+id;
  const denied=await fetch(url);assert.equal(denied.status,403);
  const partial=await fetch(url,{headers:{'x-admitted':'yes',range:'bytes=10-19'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 10-19/1044');assert.equal((await partial.arrayBuffer()).byteLength,10);
  const suffix=await fetch(url,{headers:{'x-admitted':'yes',range:'bytes=-9'}});assert.equal((await suffix.arrayBuffer()).byteLength,9);
  const head=await fetch(url,{method:'HEAD',headers:{'x-admitted':'yes'}});assert.equal(head.headers.get('content-length'),'1044');assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const range of ['bytes=9999-','bytes=20-10','bytes=0-1,4-5','bytes=-'])assert.equal((await fetch(url,{headers:{'x-admitted':'yes',range}})).status,416);
  room.id=randomUUID();delete room.media;assert.equal((await fetch(url,{headers:{'x-admitted':'yes'}})).status,404);
});

test('voice signalling is admitted/audio-only, targeted and transient; rejoining starts muted',async t=>{
  const {controller,room,delivered,setMembers}=await fixture(t),before=JSON.stringify(room),a={id:'player-a'},b={id:'player-b'};
  assert.throws(()=>controller.command({id:'pending'},{action:'join'}),e=>e.status===403);
  controller.command(a,{action:'join'});controller.command(b,{action:'join'});assert.ok(controller.publicState().voice.participants.every(p=>p.muted));
  controller.command(a,{action:'muted',muted:false});assert.equal(controller.publicState().voice.participants[0].muted,false);
  const signal={description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}};controller.command(a,{action:'signal',target:b.id,signal});
  assert.equal(delivered.length,1);assert.equal(delivered[0].target,b.id);assert.equal(controller.signals(b.id).length,1);assert.equal(controller.signals(a.id).length,0);assert.equal(controller.signals(b.id,delivered[0].event.id).length,0);
  assert.throws(()=>controller.command(a,{action:'signal',target:b.id,signal:{description:{type:'offer',sdp:signal.description.sdp+'m=video 9 RTP 96\r\n'}}}),/только голосовая/);
  assert.throws(()=>controller.command(a,{action:'signal',target:'pending',signal}),e=>e.status===404);
  setMembers([{id:'host'},{id:a.id}]);assert.throws(()=>controller.command(a,{action:'signal',target:b.id,signal}),e=>e.status===404);
  controller.disconnected(a);assert.equal(controller.publicState().voice.participants.some(p=>p.id===a.id),false);controller.command(a,{action:'join'});assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).muted,true);
  assert.equal(JSON.stringify(room),before);
});

test('voice signal limits, ICE configuration and scope reset reject malformed or excessive data',async t=>{
  const {controller,room,setTime}=await fixture(t),a={id:'player-a'},b={id:'player-b'};
  assert.throws(()=>normalizeIceServers([{urls:'https://tracker.invalid'}]),/STUN/);assert.throws(()=>normalizeIceServers(Array(9).fill({urls:'stun:test'})),/8/);
  assert.deepEqual(normalizeIceServers([{urls:'stun:127.0.0.1:3478'},{urls:['turn:relay.test:3478?transport=udp'],username:'temporary',credential:'temporary-password'}])[0],{urls:['stun:127.0.0.1:3478']});
  assert.throws(()=>validateVoiceSignal({candidate:{candidate:'a',sdpMLineIndex:-1}}),/ICE/);
  controller.command(a,{action:'join'});controller.command(b,{action:'join'});for(let i=0;i<159;i++)controller.command(a,{action:'muted',muted:true});assert.throws(()=>controller.command(a,{action:'muted'}),e=>e.status===429);
  setTime(111000);assert.doesNotThrow(()=>controller.command(a,{action:'muted'}));room.id=randomUUID();assert.equal(controller.publicState().voice.participants.length,0);
});

test('playlist timing and microphone diagnosis distinguish HTTP LAN from supported secure context',()=>{
  assert.equal(playlistPosition({position:4,playing:true,updatedAt:1000,loop:true},4000,6),1);
  assert.equal(playlistPosition({position:4,playing:true,updatedAt:1000,loop:false},4000,6),6);
  assert.match(microphoneUnavailableReason({isSecureContext:false}),/HTTPS/);
  assert.equal(microphoneUnavailableReason({isSecureContext:true,navigator:{mediaDevices:{getUserMedia(){}}},RTCPeerConnection(){}}),'');
  const settings=normalizeVoiceSettings({gain:'bad',mode:'invalid',key:'ShiftLeft',voiceVolume:200,inputDevice:{},muted:'no'});assert.equal(settings.gain,1);assert.equal(settings.voiceVolume,1);assert.equal(settings.mode,'push');assert.equal(settings.key,'KeyV');assert.equal(settings.inputDevice,'');assert.equal(settings.muted,true);
});

test('Voice reconnect carries session identities and rejects late leave/signals from the old connection',async t=>{
 const {controller,delivered}=await fixture(t),a={id:'player-a'},b={id:'player-b'},old='session-aaaaaaaaaaaa',current='session-bbbbbbbbbbbb',other='session-cccccccccccc';
 controller.command(a,{action:'join',session:old});controller.command(b,{action:'join',session:other});controller.command(a,{action:'join',session:current});
 assert.throws(()=>controller.command(a,{action:'leave',session:old}),e=>e.status===409);assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).session,current);
 controller.command(a,{action:'signal',session:current,target:b.id,signal:{description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}}});assert.equal(delivered.at(-1).event.fromSession,current);assert.equal(delivered.at(-1).event.toSession,other);
 assert.throws(()=>controller.command(a,{action:'muted',session:old,muted:false}),e=>e.status===409);assert.throws(()=>normalizeIceServers([{urls:'turn:relay.test:3478'}]),/логин и пароль/);
});
test('Only host can force-mute admitted players, including before voice join; prohibition survives leave and reconnect',async t=>{
 const {controller,room,events}=await fixture(t),host={id:'host'},a={id:'player-a'},b={id:'player-b'},before=JSON.stringify(room);
 assert.throws(()=>controller.command(a,{action:'moderate',target:b.id,muted:true}),e=>e.status===403);
 assert.throws(()=>controller.command({id:'pending'},{action:'moderate',target:a.id,muted:true}),e=>e.status===403);
 assert.throws(()=>controller.command(host,{action:'moderate',target:'pending',muted:true}),e=>e.status===404);
 assert.throws(()=>controller.command(host,{action:'moderate',target:a.id,muted:'true'}),/заблокирован/);
 controller.command(host,{action:'moderate',target:a.id,muted:true});assert.deepEqual(controller.publicState().voice.forcedMuted,[a.id]);assert.equal(controller.publicState().voice.participants.length,0);
 controller.command(a,{action:'join'});let member=controller.publicState().voice.participants.find(p=>p.id===a.id);assert.equal(member.forcedMuted,true);assert.equal(member.muted,true);assert.throws(()=>controller.command(a,{action:'muted',muted:false}),e=>e.status===403);
 controller.command(a,{action:'leave'});assert.deepEqual(controller.publicState().voice.forcedMuted,[a.id]);controller.command(a,{action:'join'});controller.disconnected(a);controller.command(a,{action:'join'});assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).forcedMuted,true);
 controller.command(host,{action:'moderate',target:a.id,muted:false});member=controller.publicState().voice.participants.find(p=>p.id===a.id);assert.equal(member.forcedMuted,false);assert.equal(member.muted,true);assert.deepEqual(controller.publicState().voice.forcedMuted,[]);
 controller.command(a,{action:'muted',muted:false});assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).muted,false);assert.equal(JSON.stringify(room),before,'Moderation must not enter story, memory or saved media');assert.ok(events.some(e=>e.type==='media'&&e.media.voice.forcedMuted.includes(a.id)));
});
test('Forced-muted participant may receive negotiated audio, but moderation remains authoritative for all receivers',async t=>{
 const {controller,delivered}=await fixture(t),host={id:'host'},a={id:'player-a'},b={id:'player-b'};controller.command(a,{action:'join'});controller.command(b,{action:'join'});controller.command(host,{action:'moderate',target:a.id,muted:true});
 controller.command(a,{action:'signal',target:b.id,signal:{description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}}});assert.equal(delivered.length,1,'Muted player must retain an incoming audio connection');const state=controller.publicState();assert.equal(state.voice.participants.find(p=>p.id===a.id).forcedMuted,true);assert.ok(state.voice.forcedMuted.includes(a.id),'Receiver obtains authoritative mute separately from sender flags');
 await controller.close();assert.deepEqual(controller.publicState().voice.forcedMuted,[]);controller.command(host,{action:'moderate',target:a.id,muted:true});await controller.close();controller.command(a,{action:'join'});assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).forcedMuted,false);
});
test('Voice leave/join cannot reset command rate limits, and changing room drops moderation',async t=>{
 const {controller,room,setTime}=await fixture(t),host={id:'host'},a={id:'player-a'};controller.command(host,{action:'moderate',target:a.id,muted:true});
 for(let i=0;i<80;i++){controller.command(a,{action:'join'});controller.command(a,{action:'leave'});}assert.throws(()=>controller.command(a,{action:'join'}),e=>e.status===429);
 setTime(111000);controller.command(a,{action:'join'});assert.equal(controller.publicState().voice.participants.find(p=>p.id===a.id).forcedMuted,true);room.id=randomUUID();assert.deepEqual(controller.publicState().voice.forcedMuted,[]);assert.equal(controller.publicState().voice.participants.length,0);
});
