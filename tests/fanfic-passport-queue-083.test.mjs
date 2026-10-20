import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createComfyRouter} from '../server/comfy.mjs';
import {createFanficImages,normalizeFanficFramePassport,fanficImageSourceHash} from '../server/fanfic-images.mjs';
import {createTasks} from '../server/tasks.mjs';
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sas-passport-queue-')),calls=[];
 const project={id:'work',settings:{connectionId:'api'},characters:[{id:'lira',name:'Лира',appearance:'Чёрные волосы.'}],personas:[],lorebooks:[],episodes:[{id:'chapter',revision:3,content:'Лира стоит у северных ворот.'}]};
 const connection={id:'api',model:'fixture',baseUrl:'http://127.0.0.1:1/v1',contextWindow:4096};
 const state={connections:[connection],settings:{comfy:{baseUrl:'',positivePrefix:'high quality',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'old'}}},positiveNode:'1',positiveInput:'text'}},fanficProjects:[project,{id:'foreign',episodes:[]}],images:[]};
 const mock=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};calls.push({path:req.url,body});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/prompt'?{prompt_id:'image-'+calls.length,node_errors:{}}:{}));});
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));state.settings.comfy.baseUrl=`http://127.0.0.1:${mock.address().port}`;
 const tasks=createTasks(),getState=()=>structuredClone(state),saveState=value=>Object.assign(state,value);
 const comfy=createComfyRouter({getState,saveState,getSecret:()=>'',tasks,dataDir:directory});
 const images=createFanficImages({getState,saveState,getSecret:()=>'',tasks,comfyRouter:comfy,countTokens:async()=>null,structured:async opts=>opts.parse('{"tags":["wrong place","red coat","cafe"],"framePassport":{"subjects":[],"moment":"","action":"","location":"cafe","camera":"","lighting":""}}')});
 const app=express();app.use(express.json());app.use('/api/fanfic',images);app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await comfy.close();await close(server);await close(mock);assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'sas-passport-queue-'));await fs.rm(directory,{recursive:true,force:true});});
 const api=async(action,body,method='POST')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/fanfic/projects/work/episodes/chapter/${action}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 return {state,project,episode:project.episodes[0],comfy,calls,api};
}
const manual=()=>({subjects:[{characterId:'lira',name:'Лира',appearance:'black hair',outfit:'blue coat'}],moment:'standing at the north gates',action:'Держит фонарь.',location:'north gates',camera:'medium shot',lighting:'lantern light'});

test('Validated Fanfic passport literal anchors survive the real queueImage and workflow path',async t=>{
 const f=await fixture(t),saved=await f.api('frame-passport',{passport:manual(),expectedRevision:3},'PUT');assert.equal(saved.status,200);
 const generated=await f.api('image-prompt',{usePassport:true,expectedRevision:3});assert.equal(generated.status,200);assert.match(generated.body.prompt,/Лира/);assert.match(generated.body.prompt,/blue coat/);assert.match(generated.body.prompt,/north gates/);assert.doesNotMatch(generated.body.prompt,/cafe|red coat/);
 const image=await f.api('images',{prompt:generated.body.prompt,sourceHash:generated.body.sourceHash,expectedRevision:3,framePassport:generated.body.framePassport});assert.equal(image.status,202);
 const submission=f.calls.find(c=>c.path==='/prompt');assert.equal(submission.body.prompt['1'].inputs.text,generated.body.prompt);assert.equal(f.state.images[0].framePassport.subjects[0].name,'Лира');assert.equal(f.state.images[0].fanficProjectId,'work');assert.equal(f.state.images[0].chatId,'');assert.equal(f.state.images[0].roomId,undefined);
});

test('Literal passport exception cannot be used by ordinary RP or DnD image queues',async t=>{
 const f=await fixture(t),bound=normalizeFanficFramePassport(manual(),{project:f.project,episode:f.episode});
 for(const fields of [{chatId:'rp'},{roomId:'dnd'},{}])await assert.rejects(f.comfy.queueImage({...fields,prompt:'Лира, северные ворота',framePassport:bound}),error=>error.status===400);
 for(const fields of [{chatId:'rp'},{roomId:'dnd'}])await assert.rejects(f.comfy.queueImage({...fields,prompt:'Лира, северные ворота'}),/английских визуальных тегов/);
 assert.equal(f.calls.filter(c=>c.path==='/prompt').length,0);
});

test('Passport queue rejects stale/foreign provenance and oversized/control prompt before submitting',async t=>{
 const f=await fixture(t),bound=normalizeFanficFramePassport(manual(),{project:f.project,episode:f.episode});
 for(const invalid of [{...bound,projectId:'foreign'},{...bound,episodeId:'wrong'},{...bound,sourceRevision:1},{...bound,sourceHash:'old'}])await assert.rejects(f.comfy.queueImage({fanficProjectId:'work',episodeId:'chapter',prompt:'Лира, north gates',framePassport:invalid}),error=>error.status===409);
 for(const prompt of ['','x'.repeat(12001),'Lira,\u0000north gates'])await assert.rejects(f.comfy.queueImage({fanficProjectId:'work',episodeId:'chapter',prompt,framePassport:bound}),error=>error.status===400);
 await assert.rejects(f.comfy.queueImage({fanficProjectId:'work',episodeId:'chapter',roomId:'dnd',prompt:'Lira, north gates',framePassport:bound}),error=>error.status===400);
 assert.equal(f.calls.filter(c=>c.path==='/prompt').length,0);assert.deepEqual(f.state.images,[]);
});

test('Long author visual anchor is preserved for Fanfic while legacy unbound validation remains strict',async t=>{
 const f=await fixture(t),outfit='blue coat '+ 'silver embroidery '.repeat(45),bound=normalizeFanficFramePassport({...manual(),subjects:[{characterId:'lira',name:'Лира',appearance:'black hair',outfit}]},{project:f.project,episode:f.episode});
 const prompt='Лира, black hair, '+outfit+', north gates';
 const image=await f.comfy.queueImage({fanficProjectId:'work',episodeId:'chapter',sourceHash:fanficImageSourceHash(f.episode.content),sourceRevision:3,prompt,framePassport:bound});assert.ok(image.prompt.includes(outfit));assert.equal(f.calls.find(c=>c.path==='/prompt').body.prompt['1'].inputs.text,image.prompt);
 await assert.rejects(f.comfy.queueImage({fanficProjectId:'work',episodeId:'chapter',prompt}),/английских визуальных тегов/);
});
