import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createStore, sanitizeState} from '../server/store.mjs';
import {buildPrompt, selectLore} from '../server/prompt.mjs';
import {startServer} from '../server/index.mjs';
import {convertPreset, convertPlugin, convertRegexRules} from '../server/formats.mjs';

const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(seed);

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sas-core-'));
  const calls=[];
  let slow=false;
  const provider=http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;calls.push({body:JSON.parse(raw),authorization:req.headers.authorization});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const payload=Buffer.from(`data: ${JSON.stringify({choices:[{delta:{content:'Привет, '}}]})}\r\n\r\n`);
    res.write(payload.subarray(0,41));res.write(payload.subarray(41));
    const timeout=setTimeout(()=>{res.write(`data: ${JSON.stringify({choices:[{delta:{content:'мир!'}}]})}\n\n`);res.end('data: [DONE]\n\n');},slow?5000:15);
    res.on('close',()=>clearTimeout(timeout));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const runtime=await startServer({port:0,dataDir:directory});
  const base=`http://127.0.0.1:${runtime.port}/api`;
  const request=async(route,body,method)=>{
    const response=await fetch(base+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return response;
  };
  const state=runtime.app.locals.runtime.store.getState();
  state.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;state.connections[0].model='test-model';
  runtime.app.locals.runtime.store.saveState(state);
  t.after(async()=>{
    await runtime.close();await new Promise(resolve=>{provider.close(resolve);provider.closeAllConnections();});
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-core-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {runtime,base,request,directory,calls,setSlow:value=>{slow=value;}};
}

test('Prompt includes enabled character blocks, scoped lore, category memory, and native plugin',()=>{
  const state=clone(),chat=state.chats[0];
  chat.memory.push({id:'relationship',category:'relationships',content:'Доверие заслужено',enabled:true});
  chat.memory.push({id:'hidden',content:'DO_NOT_INCLUDE',enabled:false});
  chat.summary='Ранее нашли ключ.';
  const plugin=convertPlugin({name:'Atmosphere',version:'1',prompt:'Добавляй запах дождя.'});plugin.enabled=true;state.plugins.push(plugin);
  const prompt=buildPrompt(state,chat.id,'Вхожу в обсерваторию.');const text=prompt.messages.map(m=>m.content).join('\n');
  assert.match(text,/Отношения: Доверие заслужено/);assert.match(text,/Ранее нашли ключ/);assert.match(text,/слышит музыку/);assert.match(text,/запах дождя/);
  assert.ok(!text.includes('DO_NOT_INCLUDE'));assert.ok(!text.includes('{{char}}'));assert.equal(prompt.activeLore.length,1);
  state.settings.memoryMode='off';assert.ok(!buildPrompt(state,chat.id).messages.some(m=>m.content.includes('Доверие заслужено')));
  state.characters[0].lorebookIds=['unknown'];assert.equal(selectLore(state,chat,'обсерватория').selected.length,0);
});

test('Character lore selection respects entries, priority, case and budget independently of legacy global toggle',()=>{
  const state=clone(),chat=state.chats[0];chat.messages=[];state.settings.loreBudget=17;
  state.lorebooks[0].entries=[{id:'low',name:'L',content:'Низкий приоритет',keys:['word'],enabled:true,priority:1},{id:'high',name:'H',content:'Высокий приоритет',constant:true,enabled:true,priority:10},{id:'case',name:'C',content:'Регистр',keys:['WORD'],caseSensitive:true,enabled:true,priority:100}];
  const chosen=selectLore(state,chat,'word');assert.equal(chosen.selected[0].id,'high');assert.ok(chosen.used<=17);assert.ok(!chosen.selected.some(e=>e.id==='case'));
  state.lorebooks[0].enabled=false;assert.ok(selectLore(state,chat,'WORD').selected.length>0);
  state.characters[0].lorebookIds=[];assert.equal(selectLore(state,chat,'WORD').selected.length,0);
});

test('Preset enabled order and context overflow are enforced',()=>{
  const state=clone();state.presets=[convertPreset({prompts:[{identifier:'a',content:'ORDER_A'},{identifier:'b',content:'ORDER_B'},{identifier:'disabled',content:'HIDDEN_BLOCK'}],prompt_order:[{character_id:100001,order:[{identifier:'b',enabled:true},{identifier:'a',enabled:true},{identifier:'disabled',enabled:false}]}]})];state.activePresetId=state.presets[0].id;
  const prompt=buildPrompt(state,state.chats[0].id);assert.equal(prompt.messages[0].content,'ORDER_B');assert.equal(prompt.messages[1].content,'ORDER_A');assert.ok(!JSON.stringify(prompt.messages).includes('HIDDEN_BLOCK'));
  state.characters[0].description='X'.repeat(30000);state.connections[0].contextWindow=512;assert.throws(()=>buildPrompt(state,state.chats[0].id),/контекст/);
});

test('State save is durable and removes nested secrets',async t=>{
  const f=await fixture(t);const state=clone();state.characters[0].name='Сохранённый персонаж';state.apiKey='synthetic-test-secret';state.settings.nested={access_token:'synthetic-token',ok:1};
  f.runtime.app.locals.runtime.store.saveState(state);
  const restored=createStore(f.directory).getState();assert.equal(restored.characters[0].name,'Сохранённый персонаж');assert.equal(restored.settings.nested.ok,1);assert.ok(!JSON.stringify(restored).includes('synthetic'));
  assert.throws(()=>sanitizeState({...state,connections:[{id:'x',baseUrl:'https://user:password@example.com/v1'}]}),/HTTP/);
});

test('Local admin rejects foreign origins/host and mutation without client header',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/state',{headers:{Origin:'https://attacker.example'}})).status,403);
  const foreignHostStatus = await new Promise((resolve,reject)=>{const request=http.get(f.base+'/state',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(foreignHostStatus,403);
  assert.equal((await fetch(f.base+'/keys',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const reply=await (await f.request('/connections/ollama/test',{})).json();assert.equal(reply.ok,true);assert.deepEqual(reply.models,['test-model']);
});

test('Real HTTP SSE adapter persists UTF-8 answers, retries, keys and summaries',async t=>{
  const f=await fixture(t);await f.request('/keys',{connectionId:'ollama',apiKey:'synthetic-private-key'},'PUT');
  const response=await f.request('/chat',{chatId:'chat-first',content:'Привет из теста'});assert.equal(response.status,200);const text=await response.text();assert.match(text,/"type":"delta"/);assert.match(text,/"type":"done"/);
  let state=await (await f.request('/state')).json();assert.equal(state.chats[0].messages.at(-1).content,'Привет, мир!');assert.equal(state.chats[0].messages.at(-2).content,'Привет из теста');assert.ok(!JSON.stringify(state).includes('synthetic-private-key'));assert.equal(f.calls[0].authorization,'Bearer synthetic-private-key');
  const retry=await f.request('/chat',{chatId:'chat-first',regenerate:true});await retry.text();state=await (await f.request('/state')).json();assert.equal(state.chats[0].messages.at(-1).swipes.length,2);
  const summary=await (await f.request('/chats/chat-first/summarize',{})).json();assert.equal(summary.summary,'Привет, мир!');
});

test('Cancellation persists partial answer, prevents concurrent generation and keeps user input',async t=>{
  const f=await fixture(t);f.setSlow(true);const response=await f.request('/chat',{chatId:'chat-first',content:'Продолжай'});const reader=response.body.getReader();await reader.read();
  assert.equal((await f.request('/chat',{chatId:'chat-first',content:'Не одновременно'})).status,409);
  const stopped=await f.request('/chats/chat-first/stop',{});assert.equal(stopped.status,200);await reader.cancel();
  const state=await (await f.request('/state')).json();assert.equal(state.chats[0].messages.at(-1).content,'Привет, ');assert.equal(state.chats[0].messages.at(-1).interrupted,true);
  assert.equal(state.chats[0].messages.at(-2).content,'Продолжай');
});

test('Display-only Regex changes rendered output without altering stored text or model prompt',async t=>{
  const f=await fixture(t),store=f.runtime.app.locals.runtime.store;const state=store.getState();state.plugins.find(p=>p.id==='regex').enabled=true;state.regexRules=convertRegexRules({findRegex:'/обсерватории/g',replaceString:'библиотеки',placement:[2],markdownOnly:true});store.saveState(state);
  const rendered=await (await f.request('/chats/chat-first/render',{})).json();assert.match(rendered.messages[0].content,/библиотеки/);
  assert.match(store.getState().chats[0].messages[0].content,/обсерватории/);
  const prompt=await (await f.request('/prompt',{chatId:'chat-first'})).json();assert.ok(prompt.messages.some(m=>m.role==='assistant'&&m.content.includes('обсерватории')));
});

function waitMessage(socket,predicate){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off('message',listener);reject(new Error('WebSocket timeout'));},4000);const listener=data=>{const value=JSON.parse(data.toString());if(predicate(value)){clearTimeout(timer);socket.off('message',listener);resolve(value);}};socket.on('message',listener);});}
test('Multiplayer joins two guests, authenticates invitations and isolates personal APIs',async t=>{
  const f=await fixture(t);assert.equal((await (await f.request('/multiplayer/status')).json()).running,false);
  const room=await (await f.request('/multiplayer/start',{port:0,name:'Test room',userName:'Host',personaId:'persona-default'})).json();assert.ok(room.code);assert.ok(room.port>0);
  assert.equal((await fetch(`http://127.0.0.1:${room.port}/api/state`)).status,404);
  const sockets=[];t.after(()=>sockets.forEach(s=>s.terminate()));
  const wrong=new WebSocket(`ws://127.0.0.1:${room.port}/ws`);sockets.push(wrong);await once(wrong,'open');const rejected=waitMessage(wrong,m=>m.type==='error');wrong.send(JSON.stringify({type:'join',code:'wrong',name:'Intruder'}));assert.match((await rejected).error,/код/);
  const one=new WebSocket(`ws://127.0.0.1:${room.port}/ws`),two=new WebSocket(`ws://127.0.0.1:${room.port}/ws`);sockets.push(one,two);await Promise.all([once(one,'open'),once(two,'open')]);
  const joinedOne=waitMessage(one,m=>m.type==='state'),joinedTwo=waitMessage(two,m=>m.type==='state');one.send(JSON.stringify({type:'join',code:room.code,name:'Игрок 1',persona:{id:'one',name:'Персона 1',description:'Следопыт'}}));two.send(JSON.stringify({type:'join',code:room.code,name:'Игрок 2',persona:{id:'two',name:'Персона 2',description:'Учёный'}}));await Promise.all([joinedOne,joinedTwo]);
  const incoming=waitMessage(two,m=>m.type==='message');one.send(JSON.stringify({type:'message',content:'Общий привет',role:'assistant',name:'Forged'}));const broadcast=await incoming;assert.equal(broadcast.message.name,'Игрок 1');assert.equal(broadcast.message.role,'user');assert.equal(broadcast.message.content,'Общий привет');
  const generated=await (await f.request('/multiplayer/generate',{chatId:'chat-first'})).json();assert.equal(generated.message.content,'Привет, мир!');
  const status=await (await f.request('/multiplayer/status')).json();assert.equal(status.participants.length,3);assert.ok(status.messages.some(m=>m.content==='Общий привет'));assert.ok(!JSON.stringify(status).includes('baseUrl'));
  await f.request('/multiplayer/stop',{});assert.equal((await (await f.request('/multiplayer/status')).json()).running,false);
});
