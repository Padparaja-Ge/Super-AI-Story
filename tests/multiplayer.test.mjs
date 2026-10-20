import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startServer} from '../server/index.mjs';
import {selectLore,buildPrompt} from '../server/prompt.mjs';
import {RoomTurns} from '../server/room-turns.mjs';
import {sanitizeState} from '../server/store.mjs';

const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){const result=await fn();if(result)return result;await delay(20);}throw new Error('Timed out');}
async function fixture(t){
  const dirs=await Promise.all(['host','guest'].map(n=>fs.mkdtemp(path.join(os.tmpdir(),'sas-room-'+n+'-')))),calls=[];
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};calls.push({path:req.url,body,authorization:req.headers.authorization});
    const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if(req.url==='/host/v1/chat/completions'||req.url==='/guest/v1/chat/completions'){
      const instruction=body.messages[0].content;
      const text=instruction.includes('литературный редактор')?'Я осторожно переступаю порог, оглядываясь и прислушиваясь к звукам вокруг.':instruction.includes('Write only an English')?'silver-haired narrator, standing in the room, holding a map':'Ведущий замечает исправленные действия игроков.';
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`);return;
    }
    if(req.url==='/prompt')return json({prompt_id:'room-image',node_errors:{}});
    if(req.url==='/history/room-image')return json({'room-image':{status:{completed:true},outputs:{9:{images:[{filename:'room.png',type:'output'}]}}}});
    if(req.url.startsWith('/view?')){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
    res.writeHead(404);res.end();
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const providerUrl=`http://127.0.0.1:${provider.address().port}`;
  const [host,guest]=await Promise.all(dirs.map(dataDir=>startServer({port:0,dataDir})));
  const api=runtime=>async(route,body,method)=>fetch(`http://127.0.0.1:${runtime.port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const h=api(host),g=api(guest),hostStore=host.app.locals.runtime.store,guestStore=guest.app.locals.runtime.store;
  for(const [runtime,side] of [[host,'host'],[guest,'guest']]){
    const store=runtime.app.locals.runtime.store,s=store.getState();s.personas[0].avatar='data:image/png;base64,'+png.toString('base64');s.connections[0].baseUrl=providerUrl+'/'+side+'/v1';s.connections[0].model=side+'-model';s.plugins.find(p=>p.id==='rpg').enabled=false;s.chats[0].summary=side.toUpperCase()+'_PRIVATE_MEMORY';s.characters[0].appearance='Серебряные волосы';s.settings.comfy.baseUrl=providerUrl;store.saveState(s);
  }
  const personaId=hostStore.getState().personas[0].id;
  const room=await(await h('/multiplayer/start',{port:0,personaId,chatId:'chat-first'})).json();
  assert.ok(room.running);
  const roomUrl=`http://127.0.0.1:${room.port}`;
  const join=async()=>{const response=await g('/multiplayer/client/join',{url:roomUrl+'/play?code='+room.code,personaId:guestStore.getState().personas[0].id});assert.equal(response.status,200);return response.json();};
  t.after(async()=>{await guest.close();await host.close();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});for(const dir of dirs){assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-room-'));await fs.rm(dir,{recursive:true,force:true});}});
  return {h,g,host,guest,hostStore,guestStore,room,roomUrl,join,calls,providerUrl};
}

test('Explicit character lore works with disabled legacy global flag and never spills to other cards',()=>{
  const s=structuredClone(seed),book=s.lorebooks[0],chat=s.chats[0];book.enabled=false;book.entries=[{id:'only',name:'World',content:'EXPLICIT_LORE',constant:true,enabled:true}];
  s.characters[0].lorebookIds=[book.id];s.characters[1].lorebookIds=[];
  assert.equal(selectLore(s,chat).selected.length,1);
  assert.equal(selectLore(s,{...chat,characterId:s.characters[1].id}).selected.length,0);
  assert.equal(selectLore(s,{...chat,lorebookIds:[]}).selected.length,0);
  book.entries[0].enabled=false;assert.equal(selectLore(s,chat).selected.length,0);
  delete s.characters[0].lorebookIds;assert.deepEqual(sanitizeState(s).characters[0].lorebookIds,[]);
});
test('Turn weights provide free mode, equal-priority group, narrator gate and next round',()=>{
  const t=new RoomTurns(),ids=['host','guest','narrator'];assert.equal(t.status(ids).free,true);t.complete('guest',ids);assert.equal(t.status(ids).free,true);
  t.configure({host:1,guest:1,narrator:2},ids);assert.deepEqual(t.status(ids).eligible,['host','guest']);
  assert.throws(()=>t.assert('narrator',ids),/другого/);t.complete('guest',ids);assert.deepEqual(t.status(ids).eligible,['host']);
  t.complete('host',ids);assert.deepEqual(t.status(ids).eligible,['narrator']);t.complete('narrator',ids);assert.equal(t.status(ids).round,2);
  assert.throws(()=>t.configure({host:-1},ids),/от 0 до 999/);
});
test('Host room lore is separate from solo card; guests see selected titles; prompt excludes solo memory',async t=>{
  const f=await fixture(t),s=f.hostStore.getState(),cardIds=[...s.characters[0].lorebookIds];
  s.lorebooks.push({id:'room-book',name:'Книга комнаты',enabled:false,entries:[{id:'room-entry',name:'Правила',content:'ROOM_ONLY_LORE',constant:true,enabled:true}]});f.hostStore.saveState(s);
  assert.equal((await f.h('/multiplayer/settings',{lorebookIds:['room-book']},'PUT')).status,200);
  const guest=await f.join();assert.deepEqual(guest.room.lorebooks,[{id:'room-book',name:'Книга комнаты'}]);
  assert.equal(guest.participants[0].avatar,'data:image/png;base64,'+png.toString('base64'));assert.equal(guest.room.avatars[guest.selfId],guest.participants[0].avatar);
  const generated=await f.h('/multiplayer/generate',{});assert.equal(generated.status,200,await generated.text());
  const prompt=JSON.stringify(f.calls.find(c=>c.path==='/host/v1/chat/completions').body.messages);
  assert.match(prompt,/ROOM_ONLY_LORE/);assert.doesNotMatch(prompt,/HOST_PRIVATE_MEMORY/);
  assert.deepEqual(f.hostStore.getState().characters[0].lorebookIds,cardIds);
  assert.equal((await f.h('/multiplayer/settings',{lorebookIds:[]},'PUT')).status,200);
  const context=f.host.app.locals.runtime.multiplayer.context();assert.equal(buildPrompt(context.state,context.chat.id,'',{extraInstructions:context.extraInstructions}).activeLore.length,0);
});
test('Server enforces host, guest and narrator turns; dice does not consume the player turn',async t=>{
  const f=await fixture(t),guest=await f.join(),id=guest.selfId;
  await f.h('/multiplayer/settings',{weights:{host:1,[id]:2,narrator:3}},'PUT');
  assert.equal((await f.g('/multiplayer/client/message',{content:'Слишком рано'})).status,409);
  assert.equal((await f.h('/multiplayer/generate',{})).status,409);assert.equal(f.calls.length,0);
  assert.equal((await f.h('/multiplayer/message',{content:'Я начинаю.'})).status,200);
  assert.equal((await f.g('/multiplayer/client/dice',{sides:20,value:999})).status,200);
  const roll=f.hostStore.getState().multiplayer.messages.at(-1);assert.equal(roll.kind,'dice');assert.ok(roll.dice.value>=1&&roll.dice.value<=20);
  assert.equal((await f.g('/multiplayer/client/message',{content:'Теперь мой ход.'})).status,200);
  assert.equal((await f.g('/multiplayer/client/message',{content:'Второй ход запрещён.'})).status,409);
  let status=await(await f.h('/multiplayer/status')).json();assert.deepEqual(status.turn.eligible,['narrator']);
  assert.equal((await f.h('/multiplayer/message',{content:'Попытка пропустить ведущего'})).status,409);
  assert.equal((await f.h('/multiplayer/generate',{})).status,200);
  status=await(await f.h('/multiplayer/status')).json();assert.equal(status.turn.round,2);assert.deepEqual(status.turn.eligible,['host']);
});
test('Zero weights allow repeat messages and arbitrary narrator turns',async t=>{
  const f=await fixture(t);await f.join();
  for(const content of ['Первое','Второе'])assert.equal((await f.g('/multiplayer/client/message',{content})).status,200);
  assert.equal((await f.h('/multiplayer/generate',{})).status,200);
  assert.equal((await f.h('/multiplayer/message',{content:'После ведущего'})).status,200);
});
test('Host can mute/unmute and kick; muted or departed participants cannot block the round',async t=>{
  const f=await fixture(t),guest=await f.join(),id=guest.selfId;
  await f.h('/multiplayer/settings',{weights:{host:1,[id]:2,narrator:3}},'PUT');await f.h('/multiplayer/message',{content:'Готово'});
  await f.h('/multiplayer/players/'+id,{action:'mute'});assert.equal((await f.g('/multiplayer/client/message',{content:'Нельзя'})).status,403);assert.equal((await f.g('/multiplayer/client/dice',{sides:20})).status,403);
  assert.deepEqual((await(await f.h('/multiplayer/status')).json()).turn.eligible,['narrator']);
  await f.h('/multiplayer/players/'+id,{action:'unmute'});assert.equal((await f.g('/multiplayer/client/message',{content:'Теперь можно'})).status,200);
  await f.h('/multiplayer/players/'+id,{action:'kick'});await until(async()=>!(await(await f.g('/multiplayer/client/status')).json()).connected);
  assert.equal((await(await f.h('/multiplayer/status')).json()).participants.length,1);
});
test('Host edits propagate to guests and future narrator context, including prior narrator messages',async t=>{
  const f=await fixture(t);await f.join();await f.g('/multiplayer/client/message',{content:'OLD_UNCORRECTED_TEXT'});
  let message=f.hostStore.getState().multiplayer.messages.at(-1);
  assert.equal((await f.h('/multiplayer/messages/'+message.id,{content:'NEW_CORRECTED_TEXT'},'PUT')).status,200);
  await until(async()=>(await(await f.g('/multiplayer/client/status')).json()).messages.some(m=>m.content==='NEW_CORRECTED_TEXT'&&m.editedAt));
  await f.h('/multiplayer/generate',{});const prompt=JSON.stringify(f.calls.find(c=>c.path==='/host/v1/chat/completions').body.messages);
  assert.match(prompt,/NEW_CORRECTED_TEXT/);assert.doesNotMatch(prompt,/OLD_UNCORRECTED_TEXT/);
  message=f.hostStore.getState().multiplayer.messages.at(-1);assert.equal(message.role,'assistant');
  assert.equal((await f.h('/multiplayer/messages/'+message.id,{content:'Исправленный ведущий'},'PUT')).status,200);
});
test('Guest rewrite calls only guest model and credentials, never host model and never sends draft',async t=>{
  const f=await fixture(t);await f.join();await f.h('/multiplayer/message',{content:'Дверь открыта.'});
  await f.g('/keys',{connectionId:'ollama',apiKey:'CLIENT_SESSION_KEY'},'PUT');
  const count=f.hostStore.getState().multiplayer.messages.length;
  const response=await f.g('/multiplayer/client/rewrite',{text:'я захожу',connectionId:'ollama'});assert.equal(response.status,200);assert.match((await response.json()).text,/осторожно/);
  assert.equal(f.calls.filter(c=>c.path.startsWith('/host')).length,0);
  const request=f.calls.find(c=>c.path==='/guest/v1/chat/completions');assert.equal(request.authorization,'Bearer CLIENT_SESSION_KEY');assert.equal(request.body.model,'guest-model');
  assert.doesNotMatch(JSON.stringify(request.body.messages),/GUEST_PRIVATE_MEMORY|HOST_PRIVATE_MEMORY/);
  assert.equal(f.hostStore.getState().multiplayer.messages.length,count);
});
test('Leaving disconnects from host, retaining chat for local export and allowing another join',async t=>{
  const f=await fixture(t);await f.join();await f.h('/multiplayer/message',{content:'Экспортируемая история'});
  await until(async()=>(await(await f.g('/multiplayer/client/status')).json()).messages.length===1);
  const result=await(await f.g('/multiplayer/client/leave',{})).json();assert.equal(result.connected,false);assert.equal(result.messages[0].content,'Экспортируемая история');
  await until(async()=>(await(await f.h('/multiplayer/status')).json()).participants.length===1);
  assert.equal((await f.join()).connected,true);
});
test('Public room interface rejects admin HTTP and WebSocket operations from guests',async t=>{
  const f=await fixture(t),ws=new WebSocket(f.roomUrl.replace('http','ws')+'/ws'),inbox=[];ws.on('message',raw=>inbox.push(JSON.parse(raw)));t.after(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({type:'join',code:f.room.code,name:'Guest',persona:{id:'g',name:'Guest'}}));await until(()=>inbox.find(e=>e.type==='state'));
  for(const type of ['generate','image','edit','settings','kick']){const requestId=type;ws.send(JSON.stringify({type,requestId,content:'forged',role:'assistant',host:true}));assert.match((await until(()=>inbox.find(e=>e.type==='error'&&e.requestId===requestId))).error,/только хосту/);}
  for(const route of ['/api/state','/api/multiplayer/images','/api/multiplayer/rewrite-draft'])assert.equal((await fetch(f.roomUrl+route,{method:'POST'})).status,404);
  assert.equal(f.calls.length,0);
});
test('Host Comfy workflow uses room context, preserves LoRA and shares only published room images',async t=>{
  const f=await fixture(t);await f.join();
  const s=f.hostStore.getState();s.chats[0].messages.push({id:'private',role:'user',content:'SOLO_LOCATION_SECRET'});
  Object.assign(s.settings.comfy,{positiveNode:'1',positiveInput:'text',workflowName:'Room LoRA',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'old',clip:['3',1]}},'3':{class_type:'LoraLoader',inputs:{lora_name:'room.safetensors',strength_model:.7}}}});f.hostStore.saveState(s);
  await f.h('/multiplayer/message',{content:'Мы стоим у карты комнаты.'});
  const prompt=await(await f.h('/multiplayer/image-prompt',{})).json();assert.match(prompt.prompt,/silver-haired/);
  const request=f.calls.find(c=>c.path==='/host/v1/chat/completions');assert.match(JSON.stringify(request.body.messages),/Серебряные волосы|карты комнаты/);assert.doesNotMatch(JSON.stringify(request.body.messages),/SOLO_LOCATION_SECRET/);
  const queued=await(await f.h('/multiplayer/images',{prompt:prompt.prompt})).json();assert.equal(queued.roomId,f.room.room.id);
  const message=await until(()=>f.hostStore.getState().multiplayer.messages.find(m=>m.imageId===queued.id));assert.equal(message.kind,'image');
  assert.equal(f.calls.find(c=>c.path==='/prompt').body.prompt['3'].inputs.lora_name,'room.safetensors');
  const publicUrl=f.roomUrl+'/media/'+queued.id+'/0';assert.equal((await fetch(publicUrl)).status,404);
  assert.deepEqual(Buffer.from(await(await fetch(publicUrl+'?code='+f.room.code)).arrayBuffer()),png);
  await until(async()=>(await(await f.g('/multiplayer/client/status')).json()).messages.some(m=>m.imageId===queued.id));
  const image=await f.g('/multiplayer/client/media/'+queued.id+'/0');assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  const fresh=f.hostStore.getState();fresh.images.push({...fresh.images[0],id:'deadbeef',roomId:undefined,chatId:'chat-first'});f.hostStore.saveState(fresh);
  assert.equal((await fetch(f.roomUrl+'/media/deadbeef/0?code='+f.room.code)).status,404);
});
