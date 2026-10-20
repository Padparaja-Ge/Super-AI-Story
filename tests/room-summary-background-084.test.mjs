import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {startServer} from '../server/index.mjs';

test('Room summary returns an accepted background task before a slow model finishes and only updates room memory',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-room-summary-084-'));
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);await gate;if(res.destroyed)return;const text='Герои получили пароль ворот САПФИР-731.';if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:text}}]}));}});
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const runtime=await startServer({port:0,dataDir:dir}),store=runtime.app.locals.runtime.store;
 t.after(async()=>{release();await runtime.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const api=async(route,body)=>fetch('http://127.0.0.1:'+runtime.port+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
 let s=store.getState();s.activeConnectionId=s.connections[0].id;s.connections[0].baseUrl='http://127.0.0.1:'+provider.address().port+'/v1';s.connections[0].model='test';store.saveState(s);
 let response=await api('/multiplayer/start',{port:0,mode:'roleplay',newHistory:true,chatId:s.chats[0].id,personaId:s.personas[0].id});assert.equal(response.status,200,await response.text());
 s=store.getState();s.multiplayer.messages=[{id:'past',role:'assistant',content:'Хранитель дал героям пароль ворот САПФИР-731.',createdAt:new Date().toISOString()}];s.multiplayer.memory=[];s.multiplayer.summary='';store.saveState(s);const solo=structuredClone(s.chats),fanfic=structuredClone(s.fanficProjects);
 response=await api('/multiplayer/summarize',{background:true});assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.kind,'room-summary');assert.equal(accepted.status,'running');
 const current=await (await api('/tasks/current')).json();assert.equal(current.task.id,accepted.id);assert.equal(current.task.status,'running');assert.equal(store.getState().multiplayer.memory.length,0);
 release();let done;for(let i=0;i<500;i++){done=(await (await api('/tasks/current')).json()).task;if(done.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(done.status,'done',JSON.stringify(done));assert.ok(store.getState().multiplayer.memory.length>0);assert.deepEqual(store.getState().chats,solo);assert.deepEqual(store.getState().fanficProjects,fanfic);
});
