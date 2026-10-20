import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRoomNetwork} from '../server/room-network.mjs';
import {createRoomDiscovery,broadcastAddresses} from '../server/room-discovery.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binary=Buffer.from('MZ-SAS-TEST-CLOUDFARED-NOT-AN-EXECUTABLE'),digest=crypto.createHash('sha256').update(binary).digest('hex');
function release(overrides={}){return {tag_name:'2026.10.0',assets:[{name:'cloudflared-windows-amd64.exe',size:binary.length,digest:'sha256:'+digest,state:'uploaded',browser_download_url:'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe',...overrides}]};}
async function fixture(t,extra={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-network-091-')),requests=[],spawns=[],room={running:true,port:34567,room:{id:'room-private'},code:'DO-NOT-BROADCAST',url:'http://127.0.0.1:9999/CORE-API'};
  const network=createRoomNetwork({dataDir,getRoom:()=>room,platform:'win32',arch:'x64',startTimeoutMs:200,roomCheckMs:20,fetchImpl:async url=>{requests.push(url);return url.includes('api.github.com')?Response.json(release()):new Response(binary);},spawnImpl:(executable,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{if(child.exitCode!=null)return;child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));};spawns.push({executable,args,options,child});setTimeout(()=>child.stderr.write('Tunnel ready https://test-sas-room.trycloudflare.com\n'),10);return child;},...extra});await network.ready;t.after(async()=>{await network.close();await fs.rm(dataDir,{recursive:true,force:true});});return {network,dataDir,requests,spawns,room};
}

test('network manager is inert until install/start, verifies official digest and exposes ONLY the room server',async t=>{
  const {network,requests,spawns,room,dataDir}=await fixture(t);assert.equal(requests.length,0);assert.equal(spawns.length,0);assert.equal(network.status().installed,false);
  await assert.rejects(network.start(),/Сначала установите/);assert.equal(spawns.length,0);
  await network.install();assert.equal(network.status().installed,true);assert.equal(requests.length,2);assert.equal(spawns.length,0);
  const state=await network.start();assert.equal(state.tunnel.state,'running');assert.equal(state.tunnel.url,'https://test-sas-room.trycloudflare.com');assert.equal(spawns.length,1);assert.ok(spawns[0].args.includes('http://127.0.0.1:34567'));assert.equal(spawns[0].args.some(arg=>String(arg).includes('9999')||String(arg).includes(room.code)),false);assert.equal(spawns[0].options.windowsHide,true);assert.ok(path.resolve(spawns[0].executable).startsWith(path.join(dataDir,'network')+path.sep));assert.ok(spawns[0].args.includes('--no-autoupdate'));
  await network.stop();assert.equal(network.status().tunnel.state,'stopped');assert.equal(spawns[0].child.exitCode,0);
  const manifest=JSON.parse(await fs.readFile(path.join(dataDir,'network/cloudflared.json'),'utf8'));await fs.writeFile(path.join(dataDir,'network',manifest.file),'TAMPER');await assert.rejects(network.start(),/повреждена/);assert.equal(spawns.length,1);assert.equal(network.status().installed,false);
});

test('cloudflared installation rejects absent digest, wrong digest, foreign release URL and excessive binary sizes',async t=>{
  for(const overrides of [{digest:null},{digest:'sha256:'+'0'.repeat(64)},{browser_download_url:'https://evil.invalid/file.exe'},{size:101*1024*1024}]){
    const fixtureData=await fixture(t,{fetchImpl:async url=>url.includes('api.github.com')?Response.json(release(overrides)):new Response(binary)});await assert.rejects(fixtureData.network.install());assert.equal(fixtureData.network.status().installed,false);assert.equal(fixtureData.spawns.length,0);
  }
});

test('room change stops a running tunnel and startup timeout terminates its own process',async t=>{
  const {network,room,spawns}=await fixture(t);await network.install();await network.start();room.room.id='other-room';for(let i=0;i<30&&network.status().tunnel.state!=='stopped';i++)await delay(10);assert.equal(network.status().tunnel.state,'stopped');assert.equal(spawns[0].child.exitCode,0);
  let child;const timed=await fixture(t,{startTimeoutMs:100,spawnImpl:()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));};return child;}});await timed.network.install();await assert.rejects(timed.network.start(),e=>e.status===504);await delay(10);assert.equal(child.exitCode,0);
});

test('repeated stop/start/close and discovery re-listen remain safe across room restarts',async t=>{
  const {network,spawns}=await fixture(t);await network.install();await network.start();await Promise.all([network.stop(),network.stop()]);assert.equal(network.status().tunnel.state,'stopped');await network.start();assert.equal(spawns.length,2);await Promise.all([network.close(),network.close()]);assert.equal(network.status().tunnel.state,'stopped');await assert.rejects(network.start(),/закрыт/);
  const discovery=createRoomDiscovery({getRoom:()=>({running:false}),port:0});t.after(()=>discovery.close());await discovery.listen();await Promise.all([discovery.close(),discovery.close()]);await discovery.listen();assert.equal(discovery.status().listening,true);await discovery.close();
});

test('diagnosis uses bounded /room-info request without code/token, validates SAS and gives LAN microphone/Radmin advice',async t=>{
  let seen='';const {network}=await fixture(t,{fetchImpl:async url=>{seen=url;return Response.json({sasRoom:1,id:'room-a',name:'Комната',mode:'dnd',lobby:true});}});
  const diagnosed=await network.diagnose('http://192.168.1.4:3213/play?code=DO_NOT_SEND');assert.equal(diagnosed.reachable,true);assert.equal(seen,'http://192.168.1.4:3213/room-info');assert.match(diagnosed.hint,/HTTPS/);await assert.rejects(network.diagnose('file:///secret'));await assert.rejects(network.diagnose('https://name:password@example.org'));
  const down=await fixture(t,{fetchImpl:async()=>{throw Error('offline');}});assert.match((await down.network.diagnose('http://192.168.1.4')).hint,/Radmin VPN/);
  const oversized=await fixture(t,{fetchImpl:async()=>new Response('a'.repeat(17000))});assert.equal((await oversized.network.diagnose('http://localhost')).reachable,false);
});

test('LAN discovery advertises only name/mode/public port with nonce, no code or private API and closes cleanly',async t=>{
  const room={running:true,port:3213,name:'Таверна',room:{id:'room-123',mode:'dnd'},code:'ULTRA-SECRET',url:'http://127.0.0.1:3212/private-api'},discovery=createRoomDiscovery({getRoom:()=>room,port:0,interfaces:()=>({})});t.after(()=>discovery.close());assert.equal(discovery.status().listening,false);await discovery.listen();const found=await discovery.scan({timeoutMs:320});assert.ok(found.some(item=>item.id==='room-123'&&item.port===3213));assert.doesNotMatch(JSON.stringify(found),/ULTRA-SECRET|private-api|3212/);assert.ok(found.every(item=>!item.url.includes('code=')&&item.url.includes('room=room-123')));await discovery.close();assert.equal(discovery.status().listening,false);
  assert.ok(broadcastAddresses({Ethernet:[{family:'IPv4',address:'192.168.10.40',netmask:'255.255.255.0',internal:false}]}).includes('192.168.10.255'));
});
