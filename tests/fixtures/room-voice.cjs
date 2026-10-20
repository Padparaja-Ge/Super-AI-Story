const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),directory=process.env.SAS_VOICE_QA_DIR;
assert.ok(directory,'Set SAS_VOICE_QA_DIR to an isolated test directory.');
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.setPath('userData',path.join(directory,'voice-profile'));
app.on('window-all-closed',()=>{});
const stage=name=>fs.writeFile(path.join(directory,'voice-stage.json'),JSON.stringify({stage:name,time:new Date().toISOString()}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=25000){const start=Date.now();while(Date.now()-start<timeout){const result=await check();if(result)return result;await pause(100);}throw Error('Voice test timeout');}
const html=`<!doctype html><meta charset="utf-8"><title>SAS voice regression</title><body>Voice regression<script type="module">
import {createRoomMediaController} from '/room-media-runtime.js';
const id=new URL(location.href).searchParams.get('id');window.errors=[];
const c=createRoomMediaController({selfId:id,settings:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},sendVoice:async body=>{const response=await fetch('/voice?id='+id,{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;},audioUrl:()=>'',onChange:s=>{window.last=s;if(s.error&&!window.errors.includes(s.error))window.errors.push(s.error);}});window.c=c;
setInterval(async()=>{try{const r=await(await fetch('/media?id='+id)).json();c.update(r.media,{id,online:true});for(const signal of r.signals)await c.signal(signal);}catch(error){window.errors.push(error.message);}},100);
window.ready=true;
</script>`;
app.whenReady().then(async()=>{
 let server,media;const windows=[],proof={};
 try{
  const {createRoomMedia}=await import(pathToFileURL(path.join(root,'server/room-media.mjs')).href),room={id:'11111111-1111-4111-8111-111111111111',messages:[{content:'CANON_UNCHANGED'}],memory:[{content:'MEMORY_UNCHANGED'}]},before=JSON.stringify(room);
  media=createRoomMedia({getRoom:()=>room,saveRoom:()=>assert.fail('Voice cannot save narrative'),participants:()=>[{id:'host',name:'Host'},{id:'player-b',name:'Guest'}],dataDir:path.join(directory,'media')});
  server=http.createServer(async(req,res)=>{try{
   const url=new URL(req.url,'http://localhost'),id=url.searchParams.get('id');
   if(url.pathname==='/room-media-runtime.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,'public/room-media-runtime.js')));return;}
   if(url.pathname==='/media'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({media:media.publicState(),signals:media.signals(id)}));return;}
   if(url.pathname==='/voice'){let body='';for await(const c of req)body+=c;const request=JSON.parse(body),result=media.command({id},request);if(id==='player-b'&&request.action==='join')await pause(700);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
   res.setHeader('Content-Type','text/html');res.end(html);
  }catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  for(const id of ['host','player-b']){const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});windows.push(w);w.webContents.setAudioMuted(true);w.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(true));await w.loadURL(`http://127.0.0.1:${server.address().port}/?id=${id}`);await until(()=>w.webContents.executeJavaScript('!!window.ready'));}
  await stage('windows-loaded');
  const [a,b]=windows,run=(w,code)=>w.webContents.executeJavaScript(code);
  await stage('joining-host');await run(a,"Promise.race([c.join(),new Promise((r,j)=>setTimeout(()=>j(Error('Join host timeout')),8000))])");await stage('cancel-pending-microphone');
  await run(b,"window.nativeResume=AudioContext.prototype.resume;AudioContext.prototype.resume=async function(){await nativeResume.call(this);window.resumePending=true;await new Promise(resolve=>window.releaseResume=resolve);};window.pendingJoin=c.join();true");
  await until(()=>run(b,'!!window.resumePending'));await run(b,'c.leave()');await run(b,'releaseResume();pendingJoin');await run(b,'AudioContext.prototype.resume=nativeResume;true');assert.equal(await run(b,'c.snapshot().joined||c.snapshot().joining'),false);assert.deepEqual(await run(b,'errors'),[]);proof.cancelledJoin=true;
  await stage('joining-guest');await run(b,"Promise.race([c.join(),new Promise((r,j)=>setTimeout(()=>j(Error('Join guest timeout')),8000))])");await stage('both-joined');
  await Promise.all(windows.map(w=>run(w,"c.setSettings({mode:'open',muted:false})")));
  await until(async()=>{const values=await Promise.all(windows.map(w=>run(w,"c.snapshot().peers.some(p=>p.state==='connected')")));return values.every(Boolean);});
  await until(async()=>{const values=await Promise.all(windows.map(w=>run(w,"c.diagnostics().then(p=>p.some(q=>q.audio.some(a=>a.bytesReceived>500&&a.totalAudioEnergy>0)))")));return values.every(Boolean);});
  await stage('audio-received');proof.initialAudio=await Promise.all(windows.map(w=>run(w,'c.diagnostics()')));proof.initialErrors=await Promise.all(windows.map(w=>run(w,'errors')));assert.ok(proof.initialErrors.every(list=>!list.length),JSON.stringify(proof.initialErrors));
  const old=media.signals('host').find(s=>s.from==='player-b');await run(b,'c.leave()');await pause(250);await run(b,'c.join()');await run(b,"c.setSettings({mode:'open',muted:false})");if(old)await run(a,'c.signal('+JSON.stringify(old)+')');
  await until(async()=>{const values=await Promise.all(windows.map(w=>run(w,"c.diagnostics().then(p=>p.some(q=>q.state==='connected'&&q.audio.some(a=>a.bytesReceived>500&&a.totalAudioEnergy>0)))")));return values.every(Boolean);});
  proof.reconnected=true;media.command({id:'host'},{action:'moderate',target:'player-b',muted:true});
  await until(()=>run(a,"c.snapshot().peers.some(p=>p.id==='player-b'&&p.silenced)"));await until(()=>run(b,'c.snapshot().forcedMuted&&c.snapshot().settings.muted'));proof.hostMuteVerified=true;
  assert.equal(JSON.stringify(room),before);proof.narrativeUnchanged=true;proof.finalErrors=await Promise.all(windows.map(w=>run(w,'errors')));proof.success=true;
 }catch(error){proof.success=false;proof.error=error.stack;proof.snapshots=await Promise.all(windows.map(w=>w.webContents.executeJavaScript('({last:window.last,errors:window.errors})').catch(()=>null)));process.exitCode=1;}
 finally{for(const w of windows)if(!w.isDestroyed()){await w.webContents.executeJavaScript('c.destroy()').catch(()=>{});w.destroy();}await media?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.writeFile(path.join(directory,'voice-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));app.exit(proof.success?0:1);}
});
