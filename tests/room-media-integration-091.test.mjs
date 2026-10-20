import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startServer} from '../server/index.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){const value=fn();if(value)return value;await delay(15);}throw Error('Room media integration timed out');}
test('approved guests hear scoped playlist and exchange voice signals through actual room WS; pending guests cannot',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-media-integration-091-')),server=await startServer({port:0,dataDir}),api=async(route,body,method)=>fetch(`http://127.0.0.1:${server.port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body===undefined?{}:{body:JSON.stringify(body)})});let socket;
  t.after(async()=>{socket?.terminate();await server.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const state=server.app.locals.runtime.store.getState(),response=await api('/multiplayer/start',{port:0,personaId:state.personas[0].id,chatId:state.chats[0].id,lobby:true}),room=await response.json();assert.equal(response.status,200,JSON.stringify(room));
  const base='http://127.0.0.1:'+room.port,events=[];socket=new WebSocket(base.replace('http','ws')+'/ws');socket.on('message',raw=>events.push(JSON.parse(raw)));await once(socket,'open');socket.send(JSON.stringify({type:'join',code:room.code,name:'QA guest',persona:state.personas[0]}));const pending=await until(()=>events.find(e=>e.type==='state'&&e.admission==='pending'));
  socket.send(JSON.stringify({type:'voice',action:'join',requestId:'denied-voice'}));await until(()=>events.some(e=>e.type==='error'&&e.requestId==='denied-voice'&&e.status===403));
  let result=await api('/multiplayer/lobby',{action:'approve',playerId:pending.selfId});assert.equal(result.status,200,await result.text());const approved=await until(()=>events.find(e=>e.type==='state'&&e.admission==='approved'));
  const audio=Buffer.alloc(1044);audio.write('RIFF');audio.writeUInt32LE(1036,4);audio.write('WAVE',8);result=await api('/multiplayer/media',{action:'upload',name:'Atmosphere.wav',data:audio.toString('base64')});assert.equal(result.status,200);const media=await result.json(),id=media.playlist.currentId;
  assert.equal((await fetch(`${base}/room-audio/${id}?code=${room.code}`)).status,403);const auth=await fetch(`${base}/admit-auth?code=${room.code}`,{method:'POST',headers:{'X-SAS-Resume':approved.resumeToken}});assert.equal(auth.status,204);const cookie=auth.headers.get('set-cookie').split(';')[0];const stream=await fetch(`${base}/room-audio/${id}?code=${room.code}`,{headers:{Cookie:cookie,Range:'bytes=0-11'}});assert.equal(stream.status,206);assert.equal((await stream.arrayBuffer()).byteLength,12);
  await api('/multiplayer/voice',{action:'join'});socket.send(JSON.stringify({type:'voice',action:'join',requestId:'voice-join'}));await until(()=>events.some(e=>e.type==='ack'&&e.requestId==='voice-join'));
  const signal={description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}};socket.send(JSON.stringify({type:'voice',action:'signal',target:'host',signal,requestId:'offer'}));await until(()=>events.some(e=>e.type==='ack'&&e.requestId==='offer'));const host=await(await api('/multiplayer/status')).json();assert.ok(host.mediaSignals.some(e=>e.from===approved.selfId&&e.signal.description.type==='offer'));
  result=await api('/multiplayer/voice',{action:'signal',target:approved.selfId,signal:{description:{type:'answer',sdp:signal.description.sdp}}});assert.equal(result.status,200);await until(()=>events.some(e=>e.type==='voice-signal'&&e.from==='host'&&e.signal.description.type==='answer'));
  socket.send(JSON.stringify({type:'media',action:'play',requestId:'not-host'}));await until(()=>events.some(e=>e.type==='error'&&e.requestId==='not-host'));assert.equal((server.app.locals.runtime.store.getState().multiplayer.messages||[]).length,0);
  for(const route of ['/room-media-runtime.js','/room-media-client.js','/room-media.css'])assert.equal((await fetch(base+route)).status,200,route);
});
