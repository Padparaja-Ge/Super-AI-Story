import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createFanficImages,buildFanficImageContext,fanficImageSourceHash} from '../server/fanfic-images.mjs';
import {createComfyRouter} from '../server/comfy.mjs';
import {createTasks} from '../server/tasks.mjs';

const connection={id:'sas-local',baseUrl:'http://127.0.0.1:1/v1',model:'local',contextWindow:8192,promptFormat:'alpaca'};
const project=()=>({id:'work',settings:{connectionId:'sas-local',audience:'18+ · взрослая аудитория'},characters:[{id:'lira',name:'Лира',appearance:'Взрослая женщина, чёрные волосы, зелёные глаза, серебряная брошь.'}],personas:[],lorebooks:[],episodes:[]});
const episode=()=>({id:'chapter',revision:3,season:2,number:9,title:'Архив',content:'Лира подняла фонарь перед дверью архива.'});
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('fanfic image context ranks relevant identities beyond the first eight cards and isolates selected prose',()=>{
  const p=project(),e=episode();p.characters.unshift(...Array.from({length:12},(_,i)=>({id:'other'+i,name:'Герой'+i,appearance:'UNUSED_TRAIT_'+i})));
  p.lorebooks=[{id:'book',name:'Архив',entries:[{id:'room',name:'Зал архива',keys:['архива'],content:'Окно с витражом, дубовая дверь.'}]}];
  e.content='OLD_SCENE_MARKER'.repeat(500)+'\n\n'+e.content;
  const sceneExcerpt='Лира подняла фонарь перед дверью архива.';
  const prepared=buildFanficImageContext({project:p,episode:e,connection,request:'Крупный план',sceneExcerpt});
  assert.deepEqual(prepared.castNames,['Лира']);assert.equal(prepared.scope,'selection');
  assert.equal(prepared.context.recent[0].content,sceneExcerpt);assert.match(prepared.context.cast[0].appearance,/зелёные глаза/);
  assert.match(prepared.context.lore[0].content,/витраж/);assert.equal(prepared.context.audience,p.settings.audience);
  assert.doesNotMatch(JSON.stringify(prepared.context),/OLD_SCENE_MARKER|UNUSED_TRAIT/);
});

test('fanfic image context preserves the latest scene and complete JSON within small local windows',()=>{
  const p=project(),e=episode();e.content='Ранние события. '.repeat(3000)+'Лира стоит у двери нового архива.';
  p.characters[0].appearance='Чёрные волосы. '.repeat(2500);p.characters[0].description='НЕВИЗУАЛЬНАЯ БИОГРАФИЯ. '.repeat(1000);
  for(const contextWindow of [1024,2048,4096,8192]){
    const prepared=buildFanficImageContext({project:p,episode:e,connection:{...connection,contextWindow},request:'Встреча у архива. '.repeat(110)});
    assert.ok(prepared.tokens+prepared.maxTokens+180<=contextWindow,`${contextWindow}: ${prepared.tokens}`);
    assert.match(prepared.context.recent[0].content,/нового архива/);assert.doesNotThrow(()=>JSON.parse(JSON.stringify(prepared.context)));
    assert.ok(prepared.warnings.length);assert.ok(prepared.context.recent[0].content.length<=6500);
  }
});

async function imageAPI(t,{structured,countTokens=async()=>null}={}){
  const p=project(),e=episode();p.episodes=[e];
  const state={connections:[connection],activeConnectionId:'sas-local',settings:{comfy:{positivePrefix:'high quality'}},fanficProjects:[p],chats:[{messages:[{content:'OTHER_PRIVATE_HISTORY'}]}],images:[]};
  const queued=[],calls=[];
  const router=createFanficImages({getState:()=>structuredClone(state),getSecret:()=>'',tasks:createTasks(),countTokens,comfyRouter:{queueImage:async data=>{queued.push(data);return {id:'image',...data};}},
    ...(structured?{structured:async options=>{calls.push(options);return structured(options);}}:{})});
  const app=express();app.use(express.json());app.use('/api/fanfic',router);app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>close(server));
  const post=async(path,body={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/fanfic/projects/work/episodes/chapter/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  return {state,p,e,queued,calls,post};
}

test('fanfic illustration rejects stale revisions, foreign excerpts and obsolete prepared prompts',async t=>{
  const f=await imageAPI(t,{structured:options=>options.parse('{"tags":["Lira","black hair","holding a lantern","archive door"]}')});
  for(const instructions of [{text:'wrong'},'x'.repeat(2001)])assert.equal((await f.post('image-prompt',{instructions})).status,400);
  assert.equal((await f.post('image-prompt',{sceneExcerpt:'OTHER_PRIVATE_HISTORY'})).status,409);
  assert.equal((await f.post('image-prompt',{sceneExcerpt:''})).status,400);
  assert.equal((await f.post('image-prompt',{expectedRevision:2})).status,409);
  const prepared=await f.post('image-prompt',{sceneExcerpt:f.e.content,expectedRevision:3});assert.equal(prepared.status,200);
  assert.equal(prepared.body.scope,'selection');assert.equal(prepared.body.sourceRevision,3);assert.equal(prepared.body.sourceHash,fanficImageSourceHash(f.e.content));
  assert.equal(f.calls[0].adaptInstruction,true);assert.equal(f.calls[0].temperature,.15);
  assert.doesNotMatch(JSON.stringify(f.calls[0].context),/OTHER_PRIVATE_HISTORY/);
  f.e.content+=' Лира вошла в зал.';f.e.revision++;
  assert.equal((await f.post('images',{prompt:prepared.body.prompt,sourceHash:prepared.body.sourceHash})).status,409);
  assert.equal((await f.post('images',{prompt:prepared.body.prompt,expectedRevision:3})).status,409);
  assert.equal(f.queued.length,0);
  const result=await f.post('images',{prompt:'Lira, black hair, archive interior',expectedRevision:4});assert.equal(result.status,202);
  assert.equal(f.queued[0].sourceHash,fanficImageSourceHash(f.e.content));assert.equal(f.queued[0].sourceRevision,4);
});

test('fanfic image compiler supports local Alpaca adaptation and llama grammar fallback without losing the selected frame',async t=>{
  const requests=[];
  const model=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    if(requests.length===1)return json(res,{error:{message:'Failed to initialize samplers: failed to parse grammar'}},400);
    json(res,{choices:[{message:{content:'{"tags":["Lira","black hair","holding a lantern","archive interior"]}'},finish_reason:'stop'}]});
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>close(model));
  const f=await imageAPI(t);f.state.connections[0].baseUrl=`http://127.0.0.1:${model.address().port}/v1`;
  const result=await f.post('image-prompt',{sceneExcerpt:f.e.content});assert.equal(result.status,200);assert.match(result.body.prompt,/high quality, Lira/);
  assert.equal(requests.length,2);assert.equal(requests[0].messages.length,1);assert.equal(requests[0].messages[0].role,'user');
  assert.match(requests[0].messages[0].content,/ONE visible frame/);assert.match(requests[1].messages[0].content,/Лира подняла фонарь/);
  assert.deepEqual(requests[1].response_format,{type:'json_object'});
});

test('fanfic image prompt repacks complete references for actual local tokenizer costs before asking for generation',async t=>{
  const counted=[];
  const f=await imageAPI(t,{countTokens:async(conn,secret,messages,options)=>{
    assert.equal(conn.id,'sas-local');assert.equal(options.adaptInstruction,true);assert.equal(options.disableThinking,true);
    const context=JSON.parse(messages[1].content);counted.push(context);
    return counted.length===1?8192:Math.ceil(messages.reduce((n,m)=>n+m.content.length,0)/2);
  },structured:options=>options.parse('{"tags":["Lira","black hair","archive interior"]}')});
  f.state.connections[0]={...connection,contextWindow:2048};f.e.content='Лира идёт через зал архива. '.repeat(500);f.p.characters[0].appearance='Чёрные волосы, зелёные глаза. '.repeat(150);
  const result=await f.post('image-prompt',{instructions:'Крупный план Лиры у двери.'});
  assert.equal(result.status,200);assert.ok(counted.length>=2&&counted.length<=5);assert.equal(f.calls.length,1);
  assert.ok(JSON.stringify(counted.at(-1)).length<JSON.stringify(counted[0]).length);
  assert.equal(result.body.sourceHash,fanficImageSourceHash(f.e.content));assert.ok(result.body.warnings.some(w=>w.includes('фактической токенизации')));
  assert.match(counted.at(-1).recent[0].content,/архива/);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
async function comfyFixture(t,handler){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sas-fanfic-images-')),p=project(),e=episode();p.episodes=[e];
  const calls=[],state={fanficProjects:[p],images:[],settings:{comfy:{baseUrl:'',positivePrefix:'high quality',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'old'}}},positiveNode:'1',positiveInput:'text'}}};
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};calls.push({path:req.url,body});await handler({req,res,body,state,p,e});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));state.settings.comfy.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const router=createComfyRouter({getState:()=>structuredClone(state),saveState:value=>Object.assign(state,value),getSecret:()=>'',tasks:createTasks(),dataDir:directory});
  t.after(async()=>{await router.close();await close(server);assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-fanfic-images-'));await fs.rm(directory,{recursive:true,force:true});});
  return {router,state,p,e,calls,directory};
}

test('fanfic image queue removes only its own external job if the episode disappears during submission',async t=>{
  const f=await comfyFixture(t,({req,res,state})=>{
    if(req.url==='/prompt'){state.fanficProjects=[];return json(res,{prompt_id:'deleted-fanfic',node_errors:{}});}
    if(req.url==='/queue')return json(res,{});json(res,{});
  });
  await assert.rejects(f.router.queueImage({fanficProjectId:'work',episodeId:'chapter',sourceHash:fanficImageSourceHash(f.e.content),sourceRevision:3,prompt:'Lira, black hair, archive interior'}),error=>error.status===409);
  assert.equal(f.state.images.length,0);assert.deepEqual(f.calls.find(c=>c.path==='/queue').body,{delete:['deleted-fanfic']});assert.ok(!f.calls.some(c=>c.path==='/interrupt'));
});

test('fanfic image output stays in its original episode while the user selects another work',async t=>{
  const f=await comfyFixture(t,({req,res})=>{
    if(req.url==='/prompt')return json(res,{prompt_id:'saved-image',node_errors:{}});
    if(req.url==='/history/saved-image')return json(res,{'saved-image':{status:{completed:true},outputs:{save:{images:[{filename:'image.png',type:'output'}]}}}});
    if(req.url.startsWith('/view?')){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
    json(res,{});
  });
  f.state.fanficProjects.push({...project(),id:'another',episodes:[{...episode(),id:'another-episode',content:'OTHER_WORK_PRIVATE'}]});
  const sourceHash=fanficImageSourceHash(f.e.content);
  const image=await f.router.queueImage({fanficProjectId:'work',episodeId:'chapter',sourceHash,sourceRevision:3,prompt:'Lira, black hair, archive interior'});
  f.state.activeChatId='ordinary';f.state.activeFanficProjectId='another';
  let persisted;
  for(let attempt=0;attempt<100;attempt++){persisted=f.state.images.find(i=>i.id===image.id);if(persisted?.status==='done')break;await delay(10);}
  assert.equal(persisted.status,'done');assert.equal(persisted.fanficProjectId,'work');assert.equal(persisted.episodeId,'chapter');assert.equal(persisted.chatId,'');
  assert.equal(persisted.sourceHash,sourceHash);assert.equal(persisted.sourceRevision,3);assert.equal(persisted.files.length,1);
  assert.deepEqual(await fs.readFile(path.join(f.directory,'images',persisted.files[0])),png);
  assert.doesNotMatch(JSON.stringify(f.calls),/OTHER_WORK_PRIVATE/);
});

test('fanfic image polling cannot recreate a deleted target or leave an unowned downloaded image',async t=>{
  let release,arrived;const viewing=new Promise(resolve=>{arrived=resolve;});
  const f=await comfyFixture(t,async({req,res})=>{
    if(req.url==='/prompt')return json(res,{prompt_id:'poll-image',node_errors:{}});
    if(req.url==='/history/poll-image')return json(res,{'poll-image':{status:{completed:true},outputs:{save:{images:[{filename:'image.png',type:'output'}]}}}});
    if(req.url.startsWith('/view?')){arrived();await new Promise(resolve=>{release=resolve;});res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
    json(res,{});
  });
  const image=await f.router.queueImage({fanficProjectId:'work',episodeId:'chapter',sourceHash:fanficImageSourceHash(f.e.content),sourceRevision:3,prompt:'Lira, black hair, archive interior'});
  await viewing;
  const foreign={id:'ordinary',chatId:'private-chat',status:'done',files:['kept.png']};
  f.state.images=[foreign];f.state.fanficProjects=[];release();await delay(70);
  assert.deepEqual(f.state.images,[foreign]);assert.deepEqual(await fs.readdir(path.join(f.directory,'images')),[]);
  assert.equal(image.fanficProjectId,'work');assert.equal(image.episodeId,'chapter');
});
