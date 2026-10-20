import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {mapPNG} from './battlemap.mjs';
import {battlemapPreset,battlemapWorkflow,mapComfyConfig} from '../shared/battlemap-preset.mjs';
import {installBattlemapAssets} from './battlemap-assets.mjs';
import { serviceUrl, requestJSON } from './language.mjs';

export {prepareWorkflow} from './comfy-workflow.mjs';
import {prepareWorkflow} from './comfy-workflow.mjs';
import {makeSceneImagePrompt,positivePrompt,visualTags} from './services/imagePromptService.js';
import {normalizeFanficFramePassport} from './fanfic-images.mjs';
const comfyUrl=(base,suffix)=>serviceUrl(/^[a-z]+:\/\//i.test(base)?base:'http://'+base,suffix);

export function mapPrompt(map){
  if(map.environment==='interior'&&map.rooms.length===1){
    // The procedural topology takes precedence over architectural guesses in the LLM tags.
    const decor=map.visualPrompt.split(',').filter(tag=>!/\b(staircase|stairs|door|walls?|partitions?|rooms?)\b/i.test(tag)).join(',');
    return `Battlemap, Dungeon, top-down bird eye view, one rectangular room with an open center, furniture around the outer perimeter, spacious unobstructed central floor, ${decor}, preserve the single room outline from the guide, no interior partitions, no characters, no grid, no text`;
  }
  return `Battlemap, ${map.environment==='outdoor'?'Outdoor':'Dungeon'}, ${map.visualPrompt}, orthographic overhead view, ${map.rooms.length} connected areas, readable clear floors, keep all corridors and entrances from the guide, no characters, no grid, no text`;
}
export function assertMapGuides(workflow,slots){
  const links=v=>Array.isArray(v)&&v.length===2&&typeof v[0]==='string'&&Number.isInteger(v[1])?[v[0]]:[];
  const ancestors=(id,seen=new Set())=>{if(seen.has(id)||!workflow[id])return seen;seen.add(id);for(const input of Object.values(workflow[id].inputs||{}))for(const next of links(input))ancestors(next,seen);return seen;};
  const samplers=Object.values(workflow).filter(n=>/Sampler/.test(n.class_type));
  const conditioning=new Set(samplers.flatMap(n=>[...links(n.inputs.positive),...links(n.inputs.negative)]).flatMap(id=>[...ancestors(id)]));
  for(const kind of ['depth','normal']){
    const ids=new Set(slots[kind].map(s=>s.id));
    const active=[...conditioning].some(id=>{const n=workflow[id];return /ControlNetApply/.test(n.class_type)&&Number(n.inputs.strength)>0&&links(n.inputs.image).some(next=>[...ancestors(next)].some(source=>ids.has(source)));});
    if(!active)throw new Error('Направляющая '+kind+' должна быть подключена к активному ControlNet и conditioning семплера.');
  }
}
export function maskMapOutputs(workflow){
  const result=structuredClone(workflow);let next=Math.max(0,...Object.keys(result).map(Number).filter(Number.isFinite))+1;
  const add=node=>{const id=String(next++);result[id]=node;return [id,0];};
  let load=Object.entries(result).find(([,n])=>n.class_type==='LoadImage'&&(n._meta?.title==='SAS_WALL_MASK'||n.inputs.image==='{{SAS_WALL_MASK}}'))?.[0];
  if(!load)load=add({class_type:'LoadImage',inputs:{image:'{{SAS_WALL_MASK}}'},_meta:{title:'SAS_WALL_MASK'}})[0];
  const outputs=Object.values(result).filter(n=>n.class_type==='SaveImage');if(!outputs.length)throw new Error('Workflow карты должен сохранять изображение через SaveImage.');
  const mask=add({class_type:'ImageToMask',inputs:{image:[load,0],channel:'red'}}),black=add({class_type:'EmptyImage',inputs:{width:1024,height:1024,batch_size:1,color:0}});
  for(const output of outputs)output.inputs.images=add({class_type:'ImageCompositeMasked',inputs:{destination:output.inputs.images,source:black,mask,x:0,y:0,resize_source:true},_meta:{title:'SAS_BLACK_WALLS'}});
  return result;
}

export function createComfyRouter({getState,saveState,getSecret,tasks,dataDir,onRoomImage=()=>{}}) {
  const router=express.Router(), folder=path.join(dataDir,'images');fs.mkdirSync(folder,{recursive:true});
  const serviceFor=(config,kind)=>kind==='battlemap'&&(getSecret('comfy-map')||comfyUrl(config.baseUrl,'/').toString()!==comfyUrl(getState().settings.comfy.baseUrl,'/').toString())?'comfy-map':'comfy';
  const headers=(service='comfy')=>({'Content-Type':'application/json',...(getSecret(service)?{Authorization:`Bearer ${getSecret(service)}`}:{})});
  const imageSecrets=new Map();
  const imageHeaders=image=>{
    const service=image.service||'comfy',config=getState().settings.comfy,configured=service==='comfy-map'?mapComfyConfig(config).baseUrl:config.baseUrl;
    const same=comfyUrl(configured,'/').toString()===comfyUrl(image.baseUrl,'/').toString(),secret=same?getSecret(service):imageSecrets.get(image.id)||'';
    return {'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})};
  };
  const controllers=new Set();let checking=false,closed=false;
  const patch=(id,fn)=>{const state=getState(),image=state.images.find(i=>i.id===id);if(image){fn(image);saveState(state);if(image.roomId&&image.status==='done')onRoomImage(image);}};
  const fanficEpisode=(state,projectId,episodeId)=>state.fanficProjects?.find(p=>p.id===projectId)?.episodes?.find(e=>e.id===episodeId);
  const assertFanficTarget=(state,target)=>{
    if(!target.fanficProjectId&&!target.episodeId)return;
    const episode=fanficEpisode(state,target.fanficProjectId,target.episodeId);
    if(!episode)throw Object.assign(new Error('Произведение или эпизод иллюстрации больше не существует.'),{status:409});
    if(target.sourceHash&&crypto.createHash('sha256').update(String(episode.content||'')).digest('hex')!==target.sourceHash)throw Object.assign(new Error('Текст серии изменился. Подготовьте иллюстрацию заново.'),{status:409});
    if(target.sourceRevision!==undefined&&target.sourceRevision!==episode.revision)throw Object.assign(new Error('Серия изменена. Подготовьте иллюстрацию заново.'),{status:409});
  };
  const queuedTargetExists=image=>{
    const state=getState(),current=state.images.find(i=>i.id===image.id);
    return current?.status==='queued'&&(!image.fanficProjectId||!!fanficEpisode(state,image.fanficProjectId,image.episodeId));
  };
  router.get('/comfy/battlemap-preset',(req,res)=>res.json({preset:battlemapPreset,workflow:battlemapWorkflow}));
  router.post('/comfy/battlemap-install',(req,res)=>{
    const task=tasks.run({kind:'battlemap-install',stage:'Загрузка моделей карты'},(signal,job)=>installBattlemapAssets(req.body?.directory,{signal,onProgress:stage=>{job.stage=stage;}}));res.status(202).json(task.job);
  });
  router.get('/comfy/info',async(req,res)=>{
    if(req.query.kind&& !['scene','battlemap'].includes(req.query.kind))throw Object.assign(new Error('Неизвестный режим ComfyUI.'),{status:400});
    const baseConfig=getState().settings.comfy,config=req.query.kind==='battlemap'?mapComfyConfig(baseConfig):baseConfig;
    const info=await requestJSON(comfyUrl(config.baseUrl,'/object_info'),{headers:headers(serviceFor(config,req.query.kind))});
    const models=[];
    for(const [nodeType,node] of Object.entries(info))for(const group of [node.input?.required,node.input?.optional])for(const [input,spec] of Object.entries(group||{}))if(Array.isArray(spec?.[0])&& /ckpt_name|unet_name|model_name|diffusion_model|control_net_name/.test(input))models.push({nodeType,input,values:spec[0]});
    res.json({models,nodeTypes:Object.keys(info)});
  });
  router.makeImagePrompt=async(state,chat,instructions='')=>{
    const task=tasks.run({kind:'image-prompt',chatId:chat.id,stage:'Составляем промпт изображения'},signal=>makeSceneImagePrompt(state,chat,getSecret,signal,instructions));
    return {prompt:await task.promise};
  };
  router.queueImage=async({chatId,roomId,fanficProjectId,episodeId,prompt,workflowOverride,kind,mapId,sourceHash,sourceRevision,framePassport,configSnapshot,authentication})=>{
    tasks.assertIdle();
    const state=getState(),baseConfig=state.settings.comfy,config=configSnapshot||(kind==='battlemap'?mapComfyConfig(baseConfig):baseConfig);
    const target={fanficProjectId,episodeId,sourceHash,sourceRevision};assertFanficTarget(state,target);
    let visual;
    if(framePassport!==undefined){
      // Author-bound Fanfic passports may contain literal Russian names and
      // longer visual descriptions. This exception never applies to RP/maps.
      if(!fanficProjectId||!episodeId||chatId||roomId||kind||mapId)throw Object.assign(new Error('Паспорт кадра применяется только к отдельной иллюстрации фанфика.'),{status:400});
      const project=state.fanficProjects.find(p=>p.id===fanficProjectId),episode=project.episodes.find(e=>e.id===episodeId);
      framePassport=normalizeFanficFramePassport(framePassport,{project,episode});
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(prompt))throw Object.assign(new Error('Нужен непустой визуальный промпт до 12 000 символов без управляющих символов.'),{status:400});
      visual=prompt.trim();
    }else visual=visualTags(String(prompt||''));
    const service=authentication?.service||serviceFor(config,kind),secret=authentication?.secret??getSecret(service),requestHeaders={'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},positive=positivePrompt(config,visual);
    const workflow=workflowOverride||prepareWorkflow(config,positive);
    const result=await requestJSON(comfyUrl(config.baseUrl,'/prompt'),{method:'POST',headers:requestHeaders,body:JSON.stringify({prompt:workflow,client_id:crypto.randomUUID()})});
    if(!result.prompt_id||Object.keys(result.node_errors||{}).length)throw new Error('ComfyUI отклонил workflow: '+JSON.stringify(result.node_errors||result.error||{}).slice(0,1000));
    const current=getState();
    try{assertFanficTarget(current,target);}catch(error){
      // Only remove our own queued job; never interrupt another user's running
      // workflow when an episode was deleted during the external HTTP request.
      await requestJSON(comfyUrl(config.baseUrl,'/queue'),{method:'POST',headers:requestHeaders,body:JSON.stringify({delete:[result.prompt_id]})}).catch(()=>{});
      throw error;
    }
    const image={id:crypto.randomUUID(),chatId:chatId||'',...(roomId?{roomId}:{}),...(kind?{kind,mapId}:{}),prompt:positive,promptId:result.prompt_id,service,baseUrl:config.baseUrl,model:config.model,workflowName:kind==='battlemap'?config.mapWorkflowName:config.workflowName,status:'queued',createdAt:new Date().toISOString(),files:[]};
    if(fanficProjectId){image.fanficProjectId=fanficProjectId;image.episodeId=episodeId;if(sourceHash)image.sourceHash=sourceHash;if(sourceRevision!==undefined)image.sourceRevision=sourceRevision;if(framePassport)image.framePassport=structuredClone(framePassport);}
    imageSecrets.set(image.id,secret);current.images.push(image);saveState(current);void poll();return image;
  };
  router.queueMap=async(room)=>{
    tasks.assertIdle();const map=room.tactical?.map,config=mapComfyConfig(getState().settings.comfy),service=serviceFor(config,'battlemap'),secret=getSecret(service);if(!map)throw new Error('Сначала создайте карту.');
    const workflow=maskMapOutputs(config.mapWorkflow||battlemapWorkflow),slots={depth:[],normal:[],layout:[],wall_mask:[]};
    for(const [id,node] of Object.entries(workflow))if(node.class_type==='LoadImage')for(const kind of Object.keys(slots))if(node.inputs?.image==='{{SAS_'+kind.toUpperCase()+'}}'||node._meta?.title==='SAS_'+kind.toUpperCase())slots[kind].push({id,node});
    if(!slots.depth.length||!slots.normal.length)throw new Error('Workflow карты должен содержать LoadImage с именами SAS_DEPTH и SAS_NORMAL, подключённые к ControlNet. Импортируйте его в настройках ComfyUI.');
    assertMapGuides(workflow,slots);
    const dimensions={};
    for(const kind of Object.keys(slots).filter(k=>slots[k].length)){
      const png=mapPNG(map,kind);dimensions.width=png.readUInt32BE(16);dimensions.height=png.readUInt32BE(20);const body=new FormData();body.set('image',new Blob([png],{type:'image/png'}),`sas-${map.id}-${kind}.png`);body.set('type','input');body.set('overwrite','true');
      const response=await fetch(comfyUrl(config.baseUrl,'/upload/image'),{method:'POST',headers:secret?{Authorization:'Bearer '+secret}:{},body,signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('ComfyUI: не удалось загрузить '+kind+' (HTTP '+response.status+').');const data=await response.json();if(typeof data.name!=='string')throw new Error('ComfyUI не вернул имя направляющей.');for(const {node} of slots[kind])node.inputs.image=(data.subfolder?data.subfolder+'/':'')+data.name;
    }
    const mapConfig=mapComfyConfig(config);
    if(map.environment==='interior'&&map.rooms.length===1)mapConfig.negative+=', interior walls, partitions, extra rooms, staircase, dividing lines, symmetrical cross';
    const prompt=mapPrompt(map),prepared=prepareWorkflow({...mapConfig,...dimensions,workflow,positiveNode:'',negativeNode:'',modelNode:'',seedNode:''},prompt);
    return router.queueImage({roomId:room.id,prompt,workflowOverride:prepared,kind:'battlemap',mapId:map.id,configSnapshot:config,authentication:{service,secret}});
  };
  router.post('/chats/:id/image-prompt',async(req,res)=>{
    const state=getState(),chat=state.chats.find(c=>c.id===req.params.id);if(!chat)throw new Error('История не найдена.');
    res.json(await router.makeImagePrompt(state,chat,req.body?.instructions));
  });
  router.post('/chats/:id/images',async(req,res)=>{
    if(!getState().chats.some(c=>c.id===req.params.id))throw new Error('История не найдена.');
    res.status(202).json(await router.queueImage({chatId:req.params.id,prompt:req.body?.prompt}));
  });
  router.get('/images/:id/:index', (req,res)=>{
    const image=getState().images.find(i=>i.id===req.params.id), index=Number(req.params.index);
    if(!Number.isInteger(index)||!image?.files?.[index])return res.status(404).json({error:'Изображение не найдено.'});
    const file=image.files[index];if(!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(file))throw new Error('Некорректное имя изображения.');
    res.sendFile(path.join(folder,file));
  });
  router.post('/images/:id/cancel',async(req,res)=>{
    const image=getState().images.find(i=>i.id===req.params.id);if(!image || image.status!=='queued')throw new Error('Изображение уже завершено.');
    // Delete only this queued item; never interrupt an unrelated ComfyUI user's active job.
    await requestJSON(comfyUrl(image.baseUrl,'/queue'),{method:'POST',headers:imageHeaders(image),body:JSON.stringify({delete:[image.promptId]})});
    patch(image.id,i=>{i.status='cancelled';i.error='Отслеживание остановлено. Если ComfyUI уже исполняет эту задачу, остановите её в ComfyUI.';});imageSecrets.delete(image.id);res.json({ok:true});
  });
  async function poll(){
    if(checking||closed)return;checking=true;const pending=new Set(getState().images.filter(i=>i.status==='queued').map(i=>i.id));for(const id of imageSecrets.keys())if(!pending.has(id))imageSecrets.delete(id);
    try{for(const image of getState().images.filter(i=>i.status==='queued')){
      if(closed)break;
      if(!queuedTargetExists(image)){patch(image.id,i=>{i.status='cancelled';i.error='Эпизод иллюстрации удалён.';});continue;}
      const controller=new AbortController();controllers.add(controller);
      const files=[];let saved=false;
      try{
        const history=await requestJSON(comfyUrl(image.baseUrl,'/history/'+encodeURIComponent(image.promptId)),{headers:imageHeaders(image),signal:controller.signal});
        const entry=history[image.promptId];if(!entry)continue;
        if(entry.status?.status_str==='error'){patch(image.id,i=>{i.status='error';i.error=JSON.stringify(entry.status.messages||'Ошибка workflow').slice(0,1600);});continue;}
        const outputs=Object.values(entry.outputs||{}).flatMap(output=>output.images||[]).slice(0,16);
        if(!outputs.length){if(entry.status?.completed)patch(image.id,i=>{i.status='error';i.error='Workflow завершён без изображений. Добавьте ноду SaveImage.';});continue;}
        for(const output of outputs){
          if(!queuedTargetExists(image))throw new Error('Отслеживание иллюстрации остановлено.');
          const url=comfyUrl(image.baseUrl,'/view');url.search=new URLSearchParams({filename:output.filename,subfolder:output.subfolder||'',type:output.type||'output'}).toString();
          const response=await fetch(url,{headers:imageHeaders(image),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});if(!response.ok)throw new Error(`Изображение: HTTP ${response.status}`);
          let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>40*1024*1024)throw new Error('Изображение больше 40 МБ.');chunks.push(chunk);}
          const data=Buffer.concat(chunks),ext=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':data[0]===255&&data[1]===216?'jpg':data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'?'webp':'';
          if(!ext)throw new Error('ComfyUI вернул неподдерживаемый формат (нужен PNG, JPEG или WebP).');
          if(!queuedTargetExists(image))throw new Error('Отслеживание иллюстрации остановлено.');
          const file=crypto.randomUUID()+'.'+ext;fs.writeFileSync(path.join(folder,file),data);files.push(file);
        }
        patch(image.id,i=>{if(i.status==='queued'&&queuedTargetExists(image)){i.status='done';i.files=files;i.error='';saved=true;}});
      }catch(error){if(!closed)patch(image.id,i=>{i.error=error.message;if(Date.now()-Date.parse(i.createdAt)>24*3600000)i.status='error';});}
      finally{controllers.delete(controller);if(!saved)for(const file of files)try{fs.unlinkSync(path.join(folder,file));}catch{/* Missing temporary outputs are already cleaned up. */}}
    }}finally{checking=false;}
  }
  const timer=setInterval(()=>void poll(),2200);timer.unref();
  router.close=async()=>{closed=true;clearInterval(timer);for(const c of controllers)c.abort();imageSecrets.clear();};
  return router;
}
