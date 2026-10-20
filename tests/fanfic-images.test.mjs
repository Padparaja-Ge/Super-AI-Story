import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createFanficImages,fanficImageSourceHash} from '../server/fanfic-images.mjs';
import {createTasks} from '../server/tasks.mjs';

test('fanfic illustration uses episode and cast snapshots, never ordinary chat',async()=>{
  const state={connections:[{id:'local',baseUrl:'http://127.0.0.1:1/v1',contextWindow:8192}],settings:{comfy:{positivePrefix:'high quality'}},characters:[{name:'UNRELATED LIBRARY'}],chats:[{messages:[{content:'PRIVATE CHAT'}]}],fanficProjects:[{id:'p',settings:{connectionId:'local'},characters:[{name:'Лира',appearance:'Чёрные волосы'}],personas:[],episodes:[{id:'e',revision:1,content:'Лира подняла фонарь перед дверью архива.'}]}]};
  let context,queued,metadata;
  const tasks=createTasks(),run=tasks.run;
  tasks.run=(meta,work)=>{metadata=meta;return run(meta,work);};
  const router=createFanficImages({getState:()=>structuredClone(state),getSecret:()=>'',tasks,structured:async options=>{context=options.context;return options.parse('{"tags":["Lira","black hair","holding a lantern","archive door"]}');},comfyRouter:{queueImage:async data=>{queued=data;return {id:'image',...data};}}});
  const app=express();app.use(express.json());app.use('/api/fanfic',router);app.use((error,req,res,next)=>res.status(error.status||400).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const post=async(path,body={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/fanfic`+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  try{
    const result=await post('/projects/p/episodes/e/image-prompt',{instructions:'Крупный план'});
    assert.equal(result.status,200);assert.match(result.body.prompt,/high quality, Lira/);
    assert.equal(context.cast[0].name,'Лира');assert.equal(context.recent[0].content,state.fanficProjects[0].episodes[0].content);assert.doesNotMatch(JSON.stringify(context),/PRIVATE CHAT|UNRELATED LIBRARY/);
    assert.equal(metadata.fanficProjectId,'p');assert.equal(metadata.episodeId,'e');
    const image=await post('/projects/p/episodes/e/images',{prompt:result.body.prompt});assert.equal(image.status,202);assert.deepEqual(queued,{fanficProjectId:'p',episodeId:'e',prompt:result.body.prompt,sourceHash:fanficImageSourceHash(state.fanficProjects[0].episodes[0].content),sourceRevision:1});assert.equal(queued.chatId,undefined);
    assert.equal((await post('/projects/unknown/episodes/e/image-prompt')).status,404);
    state.fanficProjects[0].episodes[0].content='';assert.equal((await post('/projects/p/episodes/e/image-prompt')).status,400);
  }finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});}
});
