import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {inflateSync} from 'node:zlib';
import {createStore} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';
import {createMemory,pendingMemory,validMemory,memoryDue} from '../server/memory.mjs';
import {createEmbeddings} from '../server/embeddings.mjs';
import {buildPrompt,messageTokens} from '../server/prompt.mjs';
import {samplerSchema,structuredCompletion} from '../server/services/structuredCompletion.js';
import {createGame,actorFromPersona,gameAction} from '../server/tactical.mjs';
import {generateMap,mapPNG,populateMap} from '../server/battlemap.mjs';
import {defaultAbilities,validateSRP} from '../shared/srp.mjs';
import {exportLorebook,convertLorebook} from '../server/formats.mjs';
import {createMultiplayerClient} from '../server/multiplayer-client.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const descriptor={title:'Зал гильдии',environment:'interior',entrySide:'west',rooms:['Приёмная','Архив','Зал'],npcs:[{name:'Страж',hp:12,armor:10}],visualPrompt:'guild hall, wooden floor, stone walls'};
const persona={id:'srp',name:'Рей',avatar:'R',kind:'srp',className:'Воин',abilities:defaultAbilities()};
async function temp(t,{cleanup=true}={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-050-'));if(cleanup)t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function provider(t,handler){const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;let body;try{body=JSON.parse(raw||'{}');}catch{body={};}await handler(req,res,body,raw);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return 'http://127.0.0.1:'+server.address().port;}
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const answer=(res,text)=>json(res,{choices:[{message:{content:text}}]});
async function app(t){const dir=await temp(t,{cleanup:false}),runtime=await startServer({port:0,dataDir:dir});t.after(async()=>{try{await runtime.close();}finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-050-'));await fs.rm(dir,{recursive:true,force:true});}});const store=runtime.app.locals.runtime.store;const request=(route,body,method)=>fetch(`http://127.0.0.1:${runtime.port}/api`+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body===undefined?{}:{body:JSON.stringify(body)})});const done=async()=>{for(let i=0;i<500;i++){const task=(await(await request('/tasks/current')).json()).task;if(task?.status!=='running')return task;await pause(10);}throw new Error('Task timeout');};return {runtime,store,request,done,dir};}

test('llama sampler removes large repetition bounds but keeps JSON shape and retries grammar rejection with generic JSON',async t=>{
 const schema={type:'object',properties:{description:{type:'string',maxLength:3200,minLength:2}},required:['description'],additionalProperties:false},safe=samplerSchema(schema);assert.equal(safe.properties.description.maxLength,undefined);assert.equal(schema.properties.description.maxLength,3200);
 const seen=[],url=await provider(t,(_req,res,body)=>{seen.push(body);if(body.response_format.schema)return json(res,{error:{message:'Failed to initialize samplers: failed to parse grammar'}},400);answer(res,'{"description":"готово"}');});
 const state={connections:[{id:'sas-local',baseUrl:url+'/v1',model:'local',contextWindow:8192}],activeConnectionId:'sas-local'};
 const result=await structuredCompletion({state,chat:{},getSecret:()=>'',schema,name:'test',instructions:'JSON',context:{},parse:JSON.parse});assert.equal(result.description,'готово');assert.equal(seen.length,2);assert.deepEqual(seen[1].response_format,{type:'json_object'});assert.equal(seen[0].response_format.schema.properties.description.maxLength,undefined);
});
test('Manual wizard edits replace one field, preserve lore and reject stale versions',async t=>{
 const f=await app(t),s=f.store.getState(),artifact={kind:'character',version:'v1',data:{name:'Ошибочное имя',description:'Канон',appearance:'Плащ'},lorebooks:[{name:'Мир',entries:[{name:'Город',content:'Столица',keys:['город']}]}]};s.wizardSessions=[{id:'w',artifact,draft:artifact,messages:[]}];f.store.saveState(s);
 const response=await f.request('/wizard/w/artifact',{version:'v1',field:'name',value:'Лира'},'PUT');assert.equal(response.status,200);const result=(await response.json()).artifact;assert.equal(result.data.name,'Лира');assert.equal(result.data.description,'Канон');assert.deepEqual(result.lorebooks,artifact.lorebooks);
 assert.equal((await f.request('/wizard/w/artifact',{version:'v1',field:'name',value:'Старое'},'PUT')).status,409);
 assert.equal((await f.request('/wizard/w/artifact',{version:result.version,field:'name',value:''},'PUT')).status,400);
 assert.equal((await f.request('/wizard/w/artifact',{version:result.version,bookIndex:0,entryIndex:0,field:'content',value:'Новая столица'},'PUT')).status,200);
});
test('Large histories and oversized posts are summarized in bounded chronological blocks, resume without duplicates, and stay isolated',async t=>{
 const store=createStore(await temp(t)),s=store.getState(),chat=s.chats[0];s.connections[0].contextWindow=2048;s.connections[0].maxTokens=300;chat.memory=[];chat.messages=Array.from({length:40},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:'Событие '+i+' '+('текст '.repeat(i===9?3000:150))}));s.chats.push({...structuredClone(chat),id:'other',memory:[]});store.saveState(s);
 let calls=0,fail=true;const memory=createMemory({...store,getSecret:()=>'',completion:async(c,_k,m)=>{assert.ok(messageTokens(m)+c.maxTokens<=c.contextWindow);calls++;if(fail&&calls===3)throw new Error('Stopped');return 'Ключевые события '+calls;}});
 await assert.rejects(memory.summarize(chat.id),/Stopped/);assert.equal(store.getState().chats[0].memory.length,2);fail=false;await memory.summarize(chat.id);const completed=store.getState().chats[0];assert.equal(pendingMemory(completed).length,0);assert.ok(completed.memory.length>3);assert.deepEqual(store.getState().chats[1].memory,[]);
 const count=completed.memory.length;await memory.summarize(chat.id);assert.equal(store.getState().chats[0].memory.length,count);assert.deepEqual(completed.memory.map(m=>m.order),completed.memory.map(m=>m.order).sort((a,b)=>a-b));
 completed.memory[0].enabled=false;assert.equal(pendingMemory(completed).length,0);completed.messages[0].content='Отредактировано';assert.ok(pendingMemory(completed).some(p=>p.id==='m0'));assert.ok(!validMemory(completed).includes(completed.memory[0]));
 assert.equal(memoryDue({...completed,memorySettings:{autoSummary:false}}),false);
});
test('Continue reserves instructions, fits giant cards and retains the end of a long last response',async t=>{
 const store=createStore(await temp(t)),s=store.getState(),chat=s.chats[0];s.connections[0].contextWindow=1024;s.connections[0].maxTokens=2000;s.characters[0].description='карточка '.repeat(10000);s.characters[0].postHistoryInstructions='инструкции '.repeat(10000);chat.messages=Array.from({length:2000},(_,i)=>({id:'m'+i,role:'assistant',content:'история '.repeat(200)+'LAST_'+i}));
 const p=buildPrompt(s,chat.id,'',{compact:true,tailInstructions:'Продолжи за персонажа. Не управляй игроком.'});assert.ok(p.estimatedTokens<=p.budget.available);assert.ok(p.budget.maxTokens<=512);assert.match(JSON.stringify(p.messages),/LAST_1999/);assert.match(JSON.stringify(p.messages),/Продолжи/);
});
test('Semantic memory/lore use real embeddings, cache repeated input and never select another character book',async t=>{
 const store=createStore(await temp(t)),s=store.getState(),chat=s.chats[0];chat.messages=[{id:'q',role:'user',content:'Что с собачкой?'}];chat.memory=[{id:'old',enabled:true,content:'Щенок ждёт у ворот.'},{id:'irrelevant',enabled:true,content:'Космическая станция.'}];chat.memorySettings.vectorMemory=true;s.characters[0].lorebookIds=['selected'];s.lorebooks=[{id:'selected',entries:[{id:'lore',name:'Домашний питомец',content:'Щенок',vectorized:true,enabled:true,keys:[]}]},{id:'private',entries:[{id:'secret',content:'Щенок',vectorized:true,enabled:true}]}];
 s.settings.embeddings.model='test-embedding';let calls=0;const embed=createEmbeddings({dataDir:await temp(t),getSecret:()=>'',fetcher:async(_u,options)=>{calls++;const {input}=JSON.parse(options.body);return Response.json({data:input.map((text,index)=>({index,embedding:/станция/.test(text)?[0,1]:[1,0]}))});}});
 const found=await embed.retrieve(s,chat);assert.deepEqual(found.memoryIds,['old']);assert.deepEqual(found.vectorLoreIds,['lore']);await embed.retrieve(s,chat);assert.equal(calls,1);
 const p=buildPrompt(s,chat.id,'',found);assert.ok(p.activeLore.some(l=>l.id==='lore'));assert.doesNotMatch(JSON.stringify(p.messages),/Космическая/);
 const book=convertLorebook(exportLorebook({name:'a',entries:s.lorebooks[0].entries}));assert.equal(book.entries[0].vectorized,true);
});
test('SRP points, movement walls, turn ownership, resources and hit calculations are server-authoritative',()=>{
 assert.throws(()=>validateSRP({...persona,abilities:{...defaultAbilities(),strength:64}}));const game=createGame('dnd');game.actors=[actorFromPersona('host',persona,game.rules),actorFromPersona('guest',{...persona,name:'Гость'},game.rules)];game.map=generateMap({width:16,height:16,descriptor,seed:10});populateMap(game,descriptor);
 const a=game.actors[0];assert.throws(()=>gameAction(game,{action:'move',actorId:'host',x:2,y:2},'guest'),/своим/);assert.throws(()=>gameAction(game,{action:'move',x:0,y:0},'host'),/недоступна/);assert.throws(()=>gameAction(game,{action:'set',hp:0},'guest'),/хосту/);
 game.inCombat=true;game.order=['host','guest'];game.turn=1;assert.throws(()=>gameAction(game,{action:'check',ability:'strength'},'host'),/другого/);game.turn=0;const b=game.actors[1];a.x=2;a.y=2;b.x=3;b.y=2;game.map.tiles[2*16+2]=game.map.tiles[2*16+3]=0;b.armor=1;
 gameAction(game,{action:'skill',skillId:'attack',targetId:'guest'},'host',{random:()=>4});assert.equal(b.hp,b.maxHp-4);assert.equal(a.actions,0);assert.throws(()=>gameAction(game,{action:'skill',skillId:'attack',targetId:'guest'},'host'),/Недостаточно/);gameAction(game,{action:'end'},'host');assert.equal(game.order[game.turn],'guest');
});
function pngPixels(png){const chunks=[];for(let o=8;o<png.length;){const n=png.readUInt32BE(o),name=png.toString('ascii',o+4,o+8);if(name==='IDAT')chunks.push(png.subarray(o+8,o+8+n));o+=n+12;}return inflateSync(Buffer.concat(chunks));}
test('Procedural maps have reachable rooms and aligned PNG depth/normal guide dimensions',()=>{
 const map=generateMap({width:24,height:18,descriptor,seed:3}),start=map.start[0],seen=new Set(),queue=[start];for(let i=0;i<queue.length;i++){const {x,y}=queue[i];if(seen.has(x+','+y))continue;seen.add(x+','+y);for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(map.tiles[(y+dy)*map.width+x+dx]===0&&!seen.has((x+dx)+','+(y+dy)))queue.push({x:x+dx,y:y+dy});}assert.equal(seen.size,map.tiles.filter(t=>t===0).length);
 const depth=mapPNG(map,'depth'),normal=mapPNG(map,'normal');assert.equal(depth.readUInt32BE(16),normal.readUInt32BE(16));assert.equal(depth.readUInt32BE(20),normal.readUInt32BE(20));const raw=pngPixels(depth);assert.ok(raw.includes(230));assert.ok(raw.includes(40));assert.notDeepEqual(pngPixels(normal),raw);
});
test('D&D room is independent of single-player characters, requires SRP, publishes maps and accepts guest checks only for self',async t=>{
 const f=await app(t),url=await provider(t,(_req,res,body)=>answer(res,body.response_format?JSON.stringify(descriptor):'Ведущий описывает зал.')),s=f.store.getState();s.personas.push(persona);s.chats=[];s.characters=[];s.connections[0].baseUrl=url+'/v1';s.connections[0].model='test';f.store.saveState(s);
 assert.equal((await f.request('/multiplayer/start',{newHistory:true,mode:'dnd',personaId:s.personas[0].id,port:0})).status,400);
 const opened=await f.request('/multiplayer/start',{newHistory:true,mode:'dnd',personaId:'srp',port:0});assert.equal(opened.status,200);const room=await opened.json();assert.equal(room.room.character.name,'AI Game Master');assert.equal(room.room.mode,'dnd');
 assert.equal((await f.request('/multiplayer/map',{width:24,height:24})).status,202);assert.equal((await f.done()).status,'done');const current=f.store.getState().multiplayer;assert.ok(current.tactical.map.start.length);assert.equal(current.tactical.actors.filter(a=>!a.player).length,1);
 const guide=await fetch(`http://127.0.0.1:${room.port}/map/depth?code=${room.code}`);assert.equal(guide.status,200);assert.equal(guide.headers.get('content-type'),'image/png');assert.equal((await fetch(`http://127.0.0.1:${room.port}/map/depth?code=wrong`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${room.port}/room-game.js`)).status,200);assert.equal((await f.request('/multiplayer/game',{action:'end'})).status,200);assert.equal((await f.request('/multiplayer/generate',{})).status,200);
 const client=createMultiplayerClient({getState:f.store.getState});try{const guest=await client.join({url:`http://127.0.0.1:${room.port}?code=${room.code}`,personaId:'srp',name:'Гость'});assert.equal(guest.room.mode,'dnd');assert.ok(guest.room.tactical.actors.some(a=>a.id===guest.selfId));await assert.rejects(client.command('game',{action:'check',actorId:'host',ability:'strength'}),/своим/);await f.request('/multiplayer/game',{action:'end'});await client.command('game',{action:'check',ability:'wisdom'});assert.match(f.store.getState().multiplayer.tactical.log.at(-1).text,/Мудрость/);}finally{client.leave();await pause(30);}
});

test('NRI bonus actions, healing, mana and custom dice follow configured rules',()=>{
 const game=createGame('custom',{mana:8,die:12,bonusActions:2,skills:[{id:'heal',name:'Лечение',ability:'wisdom',effect:'heal',damageDie:6,range:3,manaCost:3,actionCost:1,pool:'bonus',attack:false}]});
 game.actors=[actorFromPersona('host',persona,game.rules)];game.map=generateMap({width:16,height:16,descriptor,seed:3});const a=game.actors[0];Object.assign(a,game.map.start[0]);a.hp=3;game.inCombat=true;game.order=['host'];
 gameAction(game,{action:'skill',skillId:'heal',targetId:'host'},'host',{random:()=>4});assert.equal(a.hp,7);assert.equal(a.mana,5);assert.equal(a.bonusActions,1);assert.equal(a.actions,1);assert.match(game.log.at(-1).text,/лечение 4/);
});

test('Automatic summary runs after the configured message interval and can be disabled',async t=>{
 const f=await app(t),calls=[],url=await provider(t,(_req,res,body)=>{calls.push(body);answer(res,body.stream?'Персонаж подошёл к воротам.':'Путники достигли ворот города.');}),s=f.store.getState(),chat=s.chats[0];s.connections[0].baseUrl=url+'/v1';s.connections[0].model='test';chat.scene.autoUpdate=false;chat.memory=[];chat.messages=Array.from({length:13},(_,i)=>({id:'old-'+i,role:i%2?'assistant':'user',content:'Путешествие '+i}));chat.memorySettings={...chat.memorySettings,autoSummary:true,summaryInterval:15};f.store.saveState(s);
 assert.equal((await f.request('/generations',{chatId:chat.id,content:'Иду дальше.'})).status,202);const task=await f.done();assert.equal(task.status,'done',task.error);const saved=f.store.getState().chats[0];assert.ok(saved.memory.some(m=>m.automatic));assert.equal(pendingMemory(saved).length,0);assert.equal(calls.length,2);
 const state=f.store.getState();state.chats[0].memorySettings.autoSummary=false;state.chats[0].memorySettings.summaryInterval=2;f.store.saveState(state);await f.request('/generations',{chatId:chat.id,content:'Осматриваюсь.'});assert.equal((await f.done()).status,'done');assert.equal(calls.length,3);assert.equal(pendingMemory(f.store.getState().chats[0]).length,2);
});

test('AI GM takes NPC turns, keeps players under their control and excludes avatar bytes from prompts',async t=>{
 const f=await app(t),calls=[];let npc;const url=await provider(t,(_req,res,body)=>{calls.push(body);answer(res,body.messages[0].content.includes('You control only this NPC')?JSON.stringify({x:npc.x,y:npc.y,action:'pass',targetId:'',skillId:''}):'Страж отступил и ждёт решения игроков.');}),s=f.store.getState();s.personas.push({...persona,avatar:'data:image/png;base64,AVATAR_BYTES'});s.connections[0].baseUrl=url+'/v1';s.connections[0].model='test';f.store.saveState(s);
 await f.request('/multiplayer/start',{mode:'dnd',newHistory:true,personaId:'srp',port:0});const state=f.store.getState(),game=state.multiplayer.tactical;game.map=generateMap({width:16,height:16,descriptor,seed:2});populateMap(game,descriptor);npc=game.actors.find(a=>!a.player);game.actors.find(a=>a.id==='host').abilities.dexterity=14;npc.abilities.dexterity=8;delete game.initiativeVersion;game.order=['host'];game.phase='gm';game.inCombat=true;game.turn=0;game.round=1;state.multiplayer.scene.autoUpdate=false;f.store.saveState(state);
 const generated=await f.request('/multiplayer/generate',{});assert.equal(generated.status,200,await generated.text());const after=f.store.getState().multiplayer.tactical;assert.equal(after.order[after.turn],'host');assert.ok(calls[0].messages[0].content.includes('You control only this NPC'));assert.doesNotMatch(JSON.stringify(calls),/AVATAR_BYTES/);assert.equal(after.actors.find(a=>a.id==='host').hp,40);
});

test('Comfy map pipeline uploads both PNG guides, preserves ControlNet graph, and attaches texture only to that map',async t=>{
 const f=await app(t),uploads=[],prompts=[],url=await provider(t,(req,res,body,raw)=>{
  if(req.url==='/upload/image'){uploads.push(raw);return json(res,{name:'guide-'+uploads.length+'.png',subfolder:'sas'});}
  if(req.url==='/prompt'){prompts.push(body.prompt);return json(res,{prompt_id:'map-image'});}
  if(req.url==='/history/map-image')return json(res,{'map-image':{outputs:{save:{images:[{filename:'map.png'}]}},status:{completed:true}}});
  if(req.url.startsWith('/view')){res.setHeader('Content-Type','image/png');return res.end(mapPNG(generateMap({width:16,height:16,descriptor,seed:1}),'layout'));}
  res.writeHead(404);res.end();
 }),s=f.store.getState();s.personas.push(persona);s.settings.comfy={...s.settings.comfy,baseUrl:url,mapBaseUrl:url,model:'character.safetensors',mapModel:'map.safetensors',mapWorkflowName:'map.json',mapWorkflow:{
  '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old'}},
  '2':{class_type:'CLIPTextEncode',inputs:{text:'old',clip:['1',1]}},'3':{class_type:'CLIPTextEncode',inputs:{text:'old-negative',clip:['1',1]}},
  '4':{class_type:'LoadImage',inputs:{image:'{{SAS_DEPTH}}'}},'5':{class_type:'LoadImage',_meta:{title:'SAS_NORMAL'},inputs:{image:'old.png'}},
  '6':{class_type:'ControlNetApplyAdvanced',inputs:{positive:['2',0],negative:['3',0],image:['4',0],control_net:['10',0],strength:1,start_percent:0,end_percent:1}},
  '7':{class_type:'ControlNetApplyAdvanced',inputs:{positive:['6',0],negative:['6',1],image:['5',0],control_net:['11',0],strength:1,start_percent:0,end_percent:1}},
  '8':{class_type:'KSampler',inputs:{positive:['7',0],negative:['7',1],model:['1',0],latent_image:['9',0],seed:1}},
  '9':{class_type:'EmptyLatentImage',inputs:{width:512,height:512,batch_size:1}},'10':{class_type:'ControlNetLoader',inputs:{control_net_name:'depth.safetensors'}},'11':{class_type:'ControlNetLoader',inputs:{control_net_name:'normal.safetensors'}},'12':{class_type:'VAEDecode',inputs:{samples:['8',0],vae:['1',2]}},'13':{class_type:'SaveImage',inputs:{images:['12',0],filename_prefix:'map'}}
 }};f.store.saveState(s);await f.request('/multiplayer/start',{mode:'dnd',newHistory:true,personaId:'srp',port:0});const current=f.store.getState();current.multiplayer.tactical.map=generateMap({width:24,height:18,descriptor,seed:1});populateMap(current.multiplayer.tactical,descriptor);f.store.saveState(current);
 const response=await f.request('/multiplayer/map-texture',{});assert.equal(response.status,202);const image=await response.json();assert.equal(image.model,'map.safetensors');assert.equal(f.store.getState().settings.comfy.model,'character.safetensors');assert.equal(uploads.length,3);assert.match(uploads[2],/wall_mask\.png/);assert.match(uploads[0],/depth\.png/);assert.match(uploads[1],/normal\.png/);assert.equal(prompts[0]['4'].inputs.image,'sas/guide-1.png');assert.equal(prompts[0]['5'].inputs.image,'sas/guide-2.png');assert.equal(prompts[0]['1'].inputs.ckpt_name,'map.safetensors');assert.deepEqual(prompts[0]['7'].inputs.positive,['6',0]);assert.match(prompts[0]['2'].inputs.text,/orthographic/);assert.equal(prompts[0]['9'].inputs.width,1408);assert.equal(prompts[0]['9'].inputs.height,1024);
 for(let i=0;i<100&&f.store.getState().images.find(v=>v.id===image.id).status==='queued';i++)await pause(30);
 const saved=f.store.getState();assert.equal(saved.images.find(v=>v.id===image.id).status,'done');assert.equal(saved.multiplayer.tactical.map.imageId,image.id);assert.equal(saved.multiplayer.messages.some(m=>m.imageId===image.id),false);
 saved.settings.comfy.mapModel='';f.store.saveState(saved);const native=await f.request('/multiplayer/map-texture',{});assert.equal(native.status,202);assert.equal(prompts[1]['1'].inputs.ckpt_name,'old');assert.equal(f.store.getState().settings.comfy.model,'character.safetensors');
});
