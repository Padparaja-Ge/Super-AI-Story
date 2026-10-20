import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startServer} from '../server/index.mjs';
import {startWebServer} from '../server/web.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {prepareWorkflow} from '../server/comfy.mjs';

import {readCore} from '../server/shared-core.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){const value=await fn();if(value)return value;await delay(40);}throw new Error('Timed out');}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-features-')),calls=[];let slow=false;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=req.headers['content-type']?.includes('application/json')?JSON.parse(raw||'{}'):Object.fromEntries(new URLSearchParams(raw));calls.push({path:req.url,body});
    const json=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url==='/translate')return json({translatedText:body.target+':'+body.q});
    if(req.url==='/v2/check')return json({matches:[{offset:2,length:3,message:'Ошибка согласования',replacements:[{value:'иду'}]}]});
    if(req.url==='/object_info')return json({CheckpointLoaderSimple:{input:{required:{ckpt_name:[['model.safetensors']]}}}});
    if(req.url==='/prompt')return json({prompt_id:'test-image',node_errors:{}});
    if(req.url==='/history/test-image')return json({'test-image':{status:{completed:true,status_str:'success'},outputs:{9:{images:[{filename:'test.png',type:'output',subfolder:''}]}}}});
    if(req.url.startsWith('/view?')){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
    if(req.url==='/v1/chat/completions'){
      const instruction=body.messages[0].content;
      const answer=instruction.includes('Извлеки текущее состояние')?'{"location":"Дом Тонерико","time":"Вечер","weather":"Дождь за окном"}':instruction.includes('Write only an English')?'silver-haired character, home interior, holding a book':instruction.includes('литературный редактор')?'Я неспешно вхожу в дом.':'Персонаж открывает дверь.';
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:answer.slice(0,8)}}]})}\n\n`);
      const timer=setTimeout(()=>res.end(`data: ${JSON.stringify({choices:[{delta:{content:answer.slice(8)}}]})}\n\ndata: [DONE]\n\n`),slow?500:10);res.on('close',()=>clearTimeout(timer));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const runtime=await startServer({port:0,dataDir:dir}),store=runtime.app.locals.runtime.store,url=`http://127.0.0.1:${provider.address().port}`;
  const state=store.getState();state.connections[0].baseUrl=url+'/v1';state.connections[0].model='mock';state.chats[0].scene.autoUpdate=false;store.saveState(state);
  const base=`http://127.0.0.1:${runtime.port}`;
  const request=(route,body,method)=>fetch(base+'/api'+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const done=()=>until(async()=>{const task=(await(await request('/tasks/current')).json()).task;return task&&task.status!=='running'?task:null;});
  t.after(async()=>{await runtime.close();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-features-'));await fs.rm(dir,{recursive:true,force:true});});
  return {runtime,store,request,done,base,url,dir,calls,setSlow:value=>{slow=value;}};
}

test('Detached chat generation survives closing the response; locks all stories and settings',async t=>{
  const f=await fixture(t);f.setSlow(true);
  const response=await f.request('/chat',{chatId:'chat-first',content:'Идём домой'});await response.body.getReader().cancel();
  assert.equal((await f.request('/generations',{chatId:'chat-first',continue:true})).status,409);
  assert.equal((await f.request('/state',f.store.getState(),'PUT')).status,409);
  const done=await f.done();assert.equal(done.status,'done');assert.equal(f.store.getState().chats[0].messages.at(-1).content,'Персонаж открывает дверь.');
});
test('Continue appends only a character reply and explicitly forbids player takeover',async t=>{
  const f=await fixture(t),before=f.store.getState().chats[0].messages.length;
  assert.equal((await f.request('/generations',{chatId:'chat-first',continue:true})).status,202);await f.done();
  const messages=f.store.getState().chats[0].messages;assert.equal(messages.length,before+1);assert.equal(messages.at(-1).role,'assistant');
  assert.match(f.calls.find(c=>c.path==='/v1/chat/completions').body.messages.at(-1).content,/Не пиши реплики, действия, мысли и решения за игрока/);
});
test('Personas, memory settings, summaries and scenes stay scoped to a story',async t=>{
  const f=await fixture(t),s=f.store.getState(),first=s.chats[0];
  s.personas.push({id:'p2',name:'Капитан',description:'Человек с серебряным протезом',appearance:'Седые волосы',personality:'Спокойный'});first.personaId='p2';first.summary='Секрет первой истории';first.memorySettings.memoryMode='hybrid';first.scene.location='Первый дом';
  const second={...structuredClone(first),id:'second',characterId:s.characters[1].id,personaId:s.personas[0].id,summary:'',memory:[],scene:{...first.scene,location:'Второй дом'},memorySettings:{...first.memorySettings,memoryMode:'off'},messages:[]};s.chats.push(second);
  const one=JSON.stringify(buildPrompt(s,first.id).messages),two=JSON.stringify(buildPrompt(s,second.id).messages);
  assert.match(one,/серебряным протезом/);assert.match(one,/Секрет первой истории/);assert.match(one,/Первый дом/);
  assert.doesNotMatch(two,/Секрет первой истории|серебряным протезом|Первый дом/);assert.match(two,/Второй дом/);
});
test('Scene extraction updates only current story and enters the next model context',async t=>{
  const f=await fixture(t),s=f.store.getState();s.chats[0].scene.autoUpdate=true;f.store.saveState(s);
  await f.request('/generations',{chatId:'chat-first',content:'Мы вошли в дом Тонерико.'});const job=await f.done();assert.equal(job.warnings.length,0);
  const state=f.store.getState();assert.equal(state.chats[0].scene.location,'Дом Тонерико');assert.equal(state.chats[0].scene.time,'Вечер');
  assert.match(JSON.stringify(buildPrompt(state,'chat-first').messages),/Дом Тонерико/);
});
test('Outgoing/incoming translation preserves originals and uses model-language history',async t=>{
  const f=await fixture(t),s=f.store.getState();Object.assign(s.settings.translation,{enabled:true,provider:'libre',baseUrl:f.url});f.store.saveState(s);
  await f.request('/generations',{chatId:'chat-first',content:'Привет'});assert.equal((await f.done()).status,'done');
  const messages=f.store.getState().chats[0].messages;assert.equal(messages.at(-2).originalContent,'Привет');assert.equal(messages.at(-2).content,'en:Привет');assert.equal(messages.at(-1).translatedContent,'ru:Персонаж открывает дверь.');
  assert.ok(f.calls.find(c=>c.path==='/v1/chat/completions').body.messages.some(m=>m.content==='en:Привет'));
});
test('Grammar reports replacement offsets and AI rewrite returns draft without sending it',async t=>{
  const f=await fixture(t),s=f.store.getState();Object.assign(s.settings.grammar,{enabled:true,baseUrl:f.url});f.store.saveState(s);
  const matches=(await(await f.request('/grammar',{text:'Я идти домой'})).json()).matches;assert.equal(matches[0].offset,2);assert.deepEqual(matches[0].replacements,['иду']);
  const count=f.store.getState().chats[0].messages.length;
  const rewrite=await(await f.request('/chats/chat-first/rewrite',{text:'я захожу в дом'})).json();assert.equal(rewrite.text,'Я неспешно вхожу в дом.');assert.equal(f.store.getState().chats[0].messages.length,count);
});
const workflow={'1':{class_type:'CLIPTextEncode',inputs:{text:'old',clip:['3',1]}},'2':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}},'3':{class_type:'LoraLoader',inputs:{model:['2',0],clip:['2',1],lora_name:'custom.safetensors',strength_model:.7}},'4':{class_type:'KSampler',inputs:{seed:1,positive:['1',0]}}};
test('Comfy workflow preserves LoRA/links and only changes mapped fields',()=>{
  const result=prepareWorkflow({workflow,positiveNode:'1',positiveInput:'text',modelNode:'2',modelInput:'ckpt_name',model:'new.safetensors',seedNode:'4',seedInput:'seed'},'new prompt',42);
  assert.deepEqual(result['3'],workflow['3']);assert.deepEqual(result['1'].inputs.clip,['3',1]);assert.equal(result['4'].inputs.seed,42);assert.equal(result['2'].inputs.ckpt_name,'new.safetensors');assert.equal(workflow['1'].inputs.text,'old');
  assert.throws(()=>prepareWorkflow({workflow:{nodes:[]}},'x'),/API/);
});
test('Comfy builds contextual image prompt, queues custom workflow, and caches output in this story',async t=>{
  const f=await fixture(t),s=f.store.getState();Object.assign(s.settings.comfy,{workflow,workflowName:'custom.json',positiveNode:'1',positiveInput:'text',baseUrl:f.url,modelNode:'2',modelInput:'ckpt_name',model:'model.safetensors'});s.characters[0].appearance='Серебряные волосы';f.store.saveState(s);
  const prompt=await(await f.request('/chats/chat-first/image-prompt',{})).json();assert.match(prompt.prompt,/silver-haired/);assert.match(JSON.stringify(f.calls.find(c=>c.path==='/v1/chat/completions').body),/Серебряные волосы/);
  const result=await(await f.request('/chats/chat-first/images',{prompt:prompt.prompt})).json();assert.equal(result.status,'queued');
  const output=await until(()=>f.store.getState().images.find(i=>i.id===result.id&&i.status==='done'));assert.equal(output.chatId,'chat-first');assert.equal(output.files.length,1);
  const image=await fetch(f.base+`/api/images/${output.id}/0`);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  await f.request('/generations',{chatId:'chat-first',content:'Сообщение после картинки'});assert.equal((await f.done()).status,'done');
  const after=f.store.getState().chats.find(c=>c.id==='chat-first').messages;assert.equal(after.at(-2).content,'Сообщение после картинки');assert.ok(after.at(-1).content);assert.ok(Date.parse(after.at(-1).createdAt)>=Date.parse(output.createdAt));
  assert.deepEqual(f.calls.find(c=>c.path==='/prompt').body.prompt['3'],workflow['3']);
});
test('Custom connection deletion removes selection and secret; builtins remain',async t=>{
  const f=await fixture(t),s=f.store.getState();s.connections.push({...s.connections[0],id:'custom'});s.activeConnectionId='custom';f.store.saveState(s);
  await f.request('/keys',{connectionId:'custom',apiKey:'secret'},'PUT');assert.equal((await f.request('/connections/custom',undefined,'DELETE')).status,200);assert.equal(f.store.getState().activeConnectionId,'ollama');assert.equal(f.runtime.app.locals.runtime.secrets.has('custom'),false);assert.equal((await f.request('/connections/ollama',undefined,'DELETE')).status,400);
});
test('Two full web gateways and shell share one writer; stale saves conflict and another full gateway recovers after owner closes',async t=>{
  const f=await fixture(t);await f.runtime.close();
  const one=await startWebServer({port:0,coreMode:'embedded',dataDir:f.dir}),two=await startWebServer({port:0,coreMode:'embedded',dataDir:f.dir}),shell=await startWebServer({port:0,coreMode:'embedded',dataDir:f.dir,mode:'shell'});
  t.after(async()=>{await shell.close();await two.close();await one.close();});
  const call=(gateway,body)=>fetch(`http://127.0.0.1:${gateway.port}/api/state`,{method:body?'PUT':'GET',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body?{body:JSON.stringify(body)}:{})});
  const state=await(await call(one)).json(),stale=structuredClone(state);state.personas[0].name='Один писатель';assert.equal((await call(shell,state)).status,200);assert.equal((await call(two)).status,200);assert.equal((await call(two,stale)).status,409);
  await assert.rejects(startServer({port:0,dataDir:f.dir}),/уже открыт/);
  await one.close();const recovered=await(await call(two)).json();assert.equal(recovered.personas[0].name,'Один писатель');
});
test('Remote web mode requires login and rejects foreign-origin requests',async t=>{
  const f=await fixture(t),web=await startWebServer({port:0,coreMode:'embedded',dataDir:f.dir,host:'0.0.0.0',password:'test-password'});t.after(()=>web.close());
  const url=`http://127.0.0.1:${web.port}`;assert.equal((await fetch(url+'/api/state')).status,401);
  const login=await fetch(url+'/auth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password=test-password',redirect:'manual'});assert.equal(login.status,302);
  const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(url+'/api/state',{headers:{cookie}})).status,200);assert.equal((await fetch(url+'/api/state',{headers:{cookie,Origin:'https://evil.example'}})).status,403);
});
test('Standalone core process stays alive when one GUI closes and exits after the last GUI',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-features-worker-'));
  const one=await startWebServer({port:0,dataDir:dir,coreIdleMs:1000}),two=await startWebServer({port:0,dataDir:dir,coreIdleMs:1000});
  t.after(async()=>{await one.close();await two.close();await until(()=>!readCore(dir));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-features-worker-'));await fs.rm(dir,{recursive:true,force:true});});
  const descriptor=readCore(dir);assert.notEqual(descriptor.pid,process.pid);
  await one.close();assert.equal((await fetch(`http://127.0.0.1:${two.port}/api/health`)).status,200);assert.equal(readCore(dir).pid,descriptor.pid);
  await two.close();await until(()=>!readCore(dir));
});
test('Guests cannot enter without a persona; room prompt excludes solo memory',async t=>{
  const f=await fixture(t),s=f.store.getState();s.chats[0].summary='PRIVATE_SOLO_MEMORY';f.store.saveState(s);
  assert.equal((await f.request('/multiplayer/start',{port:0})).status,400);
  const room=await(await f.request('/multiplayer/start',{port:0,personaId:s.personas[0].id})).json();
  const socket=new WebSocket(`ws://127.0.0.1:${room.port}/ws`);t.after(()=>socket.terminate());await once(socket,'open');
  const missing=once(socket,'message');socket.send(JSON.stringify({type:'join',code:room.code,name:'Guest'}));assert.match(JSON.parse((await missing)[0]).error,/персон/);
  const joined=once(socket,'message');socket.send(JSON.stringify({type:'join',code:room.code,name:'Guest',persona:{id:'p',name:'Гость',description:'Медные крылья'}}));assert.equal(JSON.parse((await joined)[0]).type,'state');
  await f.request('/multiplayer/generate',{chatId:'chat-first'});const prompt=JSON.stringify(f.calls.find(c=>c.path==='/v1/chat/completions').body);assert.doesNotMatch(prompt,/PRIVATE_SOLO_MEMORY/);assert.match(prompt,/Медные крылья/);
});
