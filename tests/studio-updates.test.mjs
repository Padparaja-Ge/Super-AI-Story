import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createNetworkPolicy,networkDefaults,isAddressAllowed,validateNetwork} from '../server/network.mjs';
import {startServer} from '../server/index.mjs';
import {startWebServer} from '../server/web.mjs';
import {parseDevices,recommendedDevice,runtimeArgs} from '../server/local-runtime.mjs';

async function temp(t,cleanup=async()=>{}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-update-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'sas-update-')));await cleanup();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return dir;}
const request=(port,route,body,method)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});

test('Network defaults allow loopback including mapped IPv4; deny external addresses',()=>{
  for(const ip of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(isAddressAllowed(networkDefaults,ip),true);
  for(const ip of ['192.168.1.5','10.1.2.3','example.com'])assert.equal(isAddressAllowed(networkDefaults,ip),false);
  const config={...networkDefaults,allowlist:['localhost','192.168.2.0/24','2001:db8::/32'],blocklist:['192.168.2.10','2001:db8::f']};
  assert.equal(isAddressAllowed(config,'192.168.2.11'),true);assert.equal(isAddressAllowed(config,'192.168.2.10'),true);
  assert.equal(isAddressAllowed(config,'2001:db8::1'),true);assert.equal(isAddressAllowed(config,'2001:db8::f'),true);
  assert.throws(()=>validateNetwork({...config,allowlist:['192.168.2.1/50']}));assert.equal(isAddressAllowed(validateNetwork({...config,allowlist:[]}),'127.0.0.1'),false);
  const blocked={...config,mode:'blocklist'};assert.equal(isAddressAllowed(blocked,'192.168.2.10'),false);assert.equal(isAddressAllowed(blocked,'8.8.8.8'),true);
});
test('Network rules persist, reload from file, refuse self-lockout and fail closed on invalid JSON',async t=>{
  const dir=await temp(t),file=path.join(dir,'web-server.json'),policy=createNetworkPolicy({file});
  policy.save({...networkDefaults,allowlist:['localhost','10.0.0.3']},'127.0.0.1');
  assert.equal(createNetworkPolicy({file}).allowed('10.0.0.3'),true);
  assert.throws(()=>policy.save({...networkDefaults,mode:'blocklist',blocklist:['localhost']},'127.0.0.1'));
  await fs.writeFile(file,JSON.stringify({...networkDefaults,allowlist:['localhost','10.0.0.4']}));assert.equal(policy.allowed('10.0.0.3'),false);assert.equal(policy.allowed('10.0.0.4'),true);
  await fs.writeFile(file,'broken');assert.equal(policy.allowed('10.0.0.4'),false);assert.match(policy.snapshot().error,/web-server/);
});
test('Web gateway enforces IP rules before UI, login and APIs; forwarding header cannot impersonate an allowed IP',async t=>{
  let web;const dir=await temp(t,()=>web?.close()),file=path.join(dir,'web-server.json');
  await fs.writeFile(file,JSON.stringify({...networkDefaults,allowlist:['10.0.0.3']}));
  web=await startWebServer({port:0,dataDir:dir,coreMode:'embedded',networkFile:file});
  for(const route of ['/','/api/state','/auth/login'])assert.equal((await fetch(`http://127.0.0.1:${web.port}${route}`,{headers:{'x-forwarded-for':'10.0.0.3'}})).status,403);
  await fs.writeFile(file,JSON.stringify(networkDefaults));assert.equal((await request(web.port,'/state')).status,200);
  const data=await(await request(web.port,'/network')).json();assert.ok(data.clients.some(c=>c.ip==='127.0.0.1'));assert.equal(data.file,file);
  assert.equal((await request(web.port,'/network',{...networkDefaults,port:45678},'PUT')).status,200);
});
test('Host creates independent multiplayer histories, resumes stored context, deletes one and retains others across restart',async t=>{
  let runtime;const dir=await temp(t,()=>runtime?.close());runtime=await startServer({port:0,dataDir:dir});
  const store=runtime.app.locals.runtime.store,personaId=store.getState().personas[0].id;
  const call=(route,body,method)=>request(runtime.port,route,body,method);
  const first=await(await call('/multiplayer/start',{port:0,personaId,chatId:'chat-first',newHistory:true,name:'Первая'})).json();
  await call('/multiplayer/message',{content:'ONLY_FIRST_ROOM'});
  assert.equal((await call('/multiplayer/histories/'+first.room.id,undefined,'DELETE')).status,400);
  await call('/multiplayer/stop',{});
  const second=await(await call('/multiplayer/start',{port:0,personaId,chatId:'chat-first',newHistory:true,name:'Вторая'})).json();
  assert.notEqual(second.room.id,first.room.id);assert.equal(second.messages.length,0);
  await call('/multiplayer/message',{content:'ONLY_SECOND_ROOM'});await call('/multiplayer/stop',{});
  const resumed=await(await call('/multiplayer/start',{port:0,personaId,historyId:first.room.id})).json();
  assert.equal(resumed.room.name,'Первая');assert.equal(resumed.messages[0].content,'ONLY_FIRST_ROOM');
  assert.doesNotMatch(JSON.stringify(runtime.app.locals.runtime.multiplayer.context().chat),/ONLY_SECOND_ROOM/);
  await call('/multiplayer/stop',{});await runtime.close();runtime=await startServer({port:0,dataDir:dir});
  let status=await(await call('/multiplayer/status')).json();assert.equal(status.histories.length,2);
  await call('/multiplayer/histories/'+second.room.id,undefined,'DELETE');status=await(await call('/multiplayer/status')).json();
  assert.equal(status.histories.length,1);assert.equal(status.histories[0].id,first.room.id);
  assert.equal((await call('/multiplayer/start',{port:0,personaId,historyId:'not-found'})).status,400);
});
test('Whole-state saves cannot overwrite archived room histories',async t=>{
  let runtime;const dir=await temp(t,()=>runtime?.close());runtime=await startServer({port:0,dataDir:dir});const store=runtime.app.locals.runtime.store;
  const state=store.getState();state.multiplayerHistories=[{id:'preserve',messages:[{content:'kept'}]}];store.saveState(state);
  const body=store.getState();body.multiplayerHistories=[];
  assert.equal((await request(runtime.port,'/state',body,'PUT')).status,200);assert.equal(store.getState().multiplayerHistories[0].id,'preserve');
});
test('Importing a model folder collects GGUF files and skips later split shards',async t=>{
  let runtime;const dir=await temp(t,()=>runtime?.close());runtime=await startServer({port:0,dataDir:path.join(dir,'data')});
  const models=path.join(dir,'models');await fs.mkdir(models);
  for(const name of ['one.gguf','two-00001-of-00002.gguf','two-00002-of-00002.gguf'])await fs.writeFile(path.join(models,name),Buffer.from('GGUF0000'));
  await fs.writeFile(path.join(models,'notes.txt'),'not a model');
  const response=await request(runtime.port,'/local/import',{path:models});assert.equal(response.status,200);const result=await response.json();assert.equal(result.added.length,2);assert.equal(result.models.length,2);
});
test('Device discovery prefers actual CUDA over integrated shared memory; AMD uses Vulkan and CPU remains selectable',()=>{
  const gpu=parseDevices('  CUDA0: NVIDIA GeForce RTX 4060 (8192 MiB, 7600 MiB free)','cuda');
  const amd=parseDevices('  Vulkan0: AMD Radeon RX 7800 XT (16384 MiB, 15000 MiB free)\n  Vulkan1: AMD Radeon(TM) Graphics (32768 MiB, 32000 MiB free)','vulkan');
  assert.equal(recommendedDevice([...amd,...gpu]).id,'cuda:CUDA0');assert.equal(recommendedDevice(amd).id,'vulkan:Vulkan0');
  const args=runtimeArgs({modelPath:'C:/Models/model.gguf',context:8192,gpuLayers:'auto',device:gpu[0],port:54321,key:'session-key'});
  assert.equal(args[args.indexOf('--device')+1],'CUDA0');assert.equal(args[args.indexOf('-ngl')+1],'auto');assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');
  const cpu=runtimeArgs({modelPath:'file',context:512,gpuLayers:-1,device:{backend:'cpu',device:'none'},port:1,key:'x'});assert.equal(cpu[cpu.indexOf('-ngl')+1],'0');
});
