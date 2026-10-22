import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bundleExecutable,installBundle,execute} from './llama-bundle.mjs';
import {normalizeOptions} from '../shared/local-options.mjs';
import {readGguf} from './gguf.mjs';
import {resolveRuntimeOptions} from './moe.mjs';
import {chatTemplateProblem} from '../shared/chat-template.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function parseDevices(text,backend){
  return text.split(/\r?\n/).flatMap(line=>{
    const match=line.match(/^\s*((?:CUDA|Vulkan)\d+):\s*(.*?)\s*\((\d+) MiB,\s*(\d+) MiB free\)/i);
    return match?[{id:backend+':'+match[1],device:match[1],name:match[2],backend,memoryMiB:Number(match[3]),freeMiB:Number(match[4])}]:[];
  });
}
export function recommendedDevice(devices){
  const score=d=>d.backend==='cuda'?3:d.backend==='vulkan'?(/\b(RTX|GTX|RX\s*\d+|Radeon Pro|Arc\s+[AB]\d+)\b/i.test(d.name)?2:1):0;
  return [...devices].sort((a,b)=>score(b)-score(a)||b.freeMiB-a.freeMiB)[0];
}
export const modelAlias=modelPath=>path.basename(modelPath).replaceAll(',','_').slice(0,160)||'SAS';
export function runtimeArgs({modelPath,context,gpuLayers,device,port,key,embedding=false,options={},modelInfo}){
  const layers=device.backend==='cpu'?'0':String(gpuLayers??'auto');
  const args=['-m',modelPath,'--host','127.0.0.1','--port',String(port),'--alias',modelAlias(modelPath),'--api-key',key,'-c',String(context),'--parallel','1','--device',device.device||'none','--split-mode','none','-ngl',layers==='-1'?'all':layers];
  // Encoder attention requires the whole sequence in one physical batch.
  if(embedding)return [...args,'--embedding','--batch-size',String(context),'--ubatch-size',String(context)];
  const s=normalizeOptions(options);if(s.ubatchSize>s.batchSize)throw new Error('Физическая пачка не может быть больше логической.');
  const templateProblem=chatTemplateProblem(modelInfo,s.chatTemplate);if(templateProblem)throw new Error(templateProblem);
  if(Number.isInteger(modelInfo?.layers)&&modelInfo.layers>0&&[s.cpuMoeLayers,s.cpuFfnLayers].some(n=>n>modelInfo.layers))throw new Error('Число слоёв в RAM не может превышать число слоёв выбранной модели.');
  for(const [key,flag] of Object.entries({threads:'--threads',threadsBatch:'--threads-batch',batchSize:'--batch-size',ubatchSize:'--ubatch-size',flashAttention:'--flash-attn',cacheTypeK:'--cache-type-k',cacheTypeV:'--cache-type-v',loadMode:'--load-mode',fit:'--fit',fitTarget:'--fit-target',cpuMoeLayers:'--n-cpu-moe',cpuFfnLayers:'--n-cpu-ffn'}))if(!['threads','threadsBatch','cpuMoeLayers','cpuFfnLayers'].includes(key)||s[key]>0)args.push(flag,String(s[key]));
  if(s.chatTemplate!=='gguf')args.push('--chat-template',s.chatTemplate);
  if(s.ropeScaling!=='model')args.push('--rope-scaling',s.ropeScaling);
  if(s.ropeScale)args.push('--rope-scale',String(s.ropeScale));
  if(s.yarnOrigCtx)args.push('--yarn-orig-ctx',String(s.yarnOrigCtx));
  args.push(s.opOffload==='on'?'--op-offload':'--no-op-offload',s.cachePrompt==='on'?'--cache-prompt':'--no-cache-prompt');
  if(s.kvOffload==='off')args.push('--no-kv-offload');
  if(s.cacheReuse)args.push('--cache-reuse',String(s.cacheReuse));
  args.push(s.contextShift==='on'?'--context-shift':'--no-context-shift');
  if(s.swaCache==='full')args.push('--swa-full');
  if(s.numa!=='disabled')args.push('--numa',s.numa);
  if(s.expertUsedCount){if(!modelInfo?.isMoe||s.expertUsedCount>modelInfo.experts)throw new Error('Число активных экспертов превышает число экспертов модели или модель не является MoE.');args.push('--override-kv',modelInfo.architecture+'.expert_used_count=int:'+s.expertUsedCount);}
  return args;
}
const freePort=()=>new Promise((resolve,reject)=>{const socket=net.createServer();socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(error=>error?reject(error):resolve(port));});});
const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref();});
export function createLocalRuntime({dataDir,getState,saveState,setSecret=()=>{},embedding=false,bundleRoot=process.env.SAS_LLAMA_DIR||path.join(root.endsWith('.asar')?path.dirname(root):path.join(root,'runtime'),'llama')}){
  const connectionId=embedding?'sas-embedding':'sas-local';
  const fallbackRoot=path.join(dataDir,'runtime','llama');
  let child,controller,job,working=false,hardwareCache,hardwareAt=0,probing,accessKey='',benchmarking=false;
  let status={running:false,ready:false,preparing:false,modelPath:'',logs:[],error:''};
  const executable=async backend=>await bundleExecutable(bundleRoot,backend)||await bundleExecutable(fallbackRoot,backend);
  const hardware=async(refresh=false)=>{
    if(!refresh&&hardwareCache&&Date.now()-hardwareAt<30000)return hardwareCache;
    if(probing)return probing;
    probing=(async()=>{
      const devices=[{id:'cpu',device:'none',name:os.cpus()[0]?.model||'Процессор',backend:'cpu',memoryMiB:Math.round(os.totalmem()/1048576),freeMiB:Math.round(os.freemem()/1048576)}],warnings=[];
      for(const backend of ['cuda','vulkan']){
        const file=await executable(backend);if(!file)continue;
        try{const result=await execute(file,['--list-devices'],{windowsHide:true,cwd:path.dirname(file),timeout:20000,maxBuffer:1024*1024});devices.push(...parseDevices(result.stdout+'\n'+result.stderr,backend));}
        catch{warnings.push((backend==='cuda'?'CUDA':'Vulkan')+': устройство или подходящий драйвер не доступны.');}
      }
      const installed=!!await executable('cpu');
      hardwareAt=Date.now();return hardwareCache={devices,recommendedId:recommendedDevice(devices).id,installed,supported:process.platform==='win32'&&process.arch==='x64',warnings};
    })().finally(()=>{probing=null;});return probing;
  };
  const prepare=async signal=>{
    for(const backend of ['cpu','vulkan','cuda'])if(!await executable(backend))await installBundle(fallbackRoot,backend,{signal,onProgress:p=>{status.progress=p;status.stage=p.stage||'Подготовка локальных моделей';}});
    hardwareCache=null;
  };
  const activate=(url,context,alias,modelInfo,options)=>{
    const state=getState();let connection=state.connections.find(c=>c.id===connectionId);
    if(!connection){connection={id:connectionId,name:embedding?'Векторизация SAS':'Локальная модель SAS',kind:'openai',temperature:.8,maxTokens:1024};state.connections.push(connection);}
    Object.assign(connection,{baseUrl:url,model:alias,contextWindow:context});if(embedding){connection.embeddingTokenLimit=context;state.settings.embeddings={...state.settings.embeddings,connectionId,model:alias};}else{connection.promptFormat=options?.chatTemplate&&options.chatTemplate!=='gguf'?(options.chatTemplate.startsWith('mistral-')?'single-system':''):/### Instruction:/.test(modelInfo?.chatTemplate||'')&&/### Response:/.test(modelInfo?.chatTemplate||'')?'alpaca':/\[INST\]/u.test(modelInfo?.chatTemplate||'')&&/system/u.test(modelInfo?.chatTemplate||'')?'single-system':'';state.activeConnectionId=connection.id;}saveState(state);
  };
  async function run(modelPath,settings){
    const signal=controller.signal;
    try{
      await prepare(signal);signal.throwIfAborted();const inventory=await hardware(true);
      const wanted=embedding?(settings.embeddingDevice||'cpu'):(settings.localDevice||'auto'),device=inventory.devices.find(d=>d.id===(wanted==='auto'?inventory.recommendedId:wanted));
      if(!device)throw new Error('Выбранное устройство больше не доступно. Выберите автоматический режим или другое устройство.');
      const file=await executable(device.backend);if(!file)throw new Error('Локальная модель не подготовлена для этого устройства.');
      const modelInfo=await readGguf(modelPath);
      const context=Math.min(embedding?8192:131072,...(embedding&&modelInfo.contextLength?[modelInfo.contextLength]:[]),Math.max(embedding?128:512,Math.trunc(Number(embedding?settings.embeddingContext:settings.contextSize)||(embedding?2048:8192))));
      const resolved=resolveRuntimeOptions({...settings,...(embedding?{moeAuto:false}:{})},modelInfo,device,context),options=resolved.options,recommendation=resolved.recommendation;
      const layers=settings.gpuLayers==='auto'||settings.gpuLayers===undefined?'auto':Math.min(999,Math.max(-1,Math.trunc(Number(settings.gpuLayers)||0)));
      const port=await freePort(),key=crypto.randomBytes(32).toString('hex');signal.throwIfAborted();
      const url=`http://127.0.0.1:${port}/v1`;
      child=spawn(file,runtimeArgs({modelPath,context,gpuLayers:embedding?'auto':layers,device,port,key,embedding,options,modelInfo}),{shell:false,windowsHide:true,cwd:path.dirname(file),stdio:['ignore','pipe','pipe'],env:{...process.env}});
      accessKey=key;const current=child;status={...status,running:true,preparing:false,stage:'Загрузка модели',device,url,modelPath,modelInfo,context,effectiveOptions:embedding?{batchSize:context,ubatchSize:context}:options,moeAutoApplied:!embedding&&resolved.autoApplied,recommendation:!embedding&&modelInfo.isMoe?recommendation:undefined,progress:undefined};
      const log=chunk=>{status.logs=[...status.logs,...chunk.toString('utf8').replaceAll(key,'[redacted]').split(/\r?\n/).filter(Boolean)].slice(-60).map(s=>s.slice(0,2000));};
      current.stdout.on('data',log);current.stderr.on('data',log);
      current.on('error',error=>{if(child===current){status.error=error.message;status.running=false;status.ready=false;child=null;}});
      current.on('exit',(code,reason)=>{if(child===current){child=null;accessKey='';status.running=false;status.ready=false;if(code&&!signal.aborted)status.error=`Модель завершилась с кодом ${code}. Попробуйте уменьшить контекст или число слоёв на GPU. Подробности в журнале.`;setSecret(connectionId,'');}});
      const deadline=Date.now()+300000;
      while(child===current&&Date.now()<deadline){
        signal.throwIfAborted();
        try{const response=await fetch(url+'/models',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.any([signal,AbortSignal.timeout(1500)])});if(response.ok){setSecret(connectionId,key);activate(url,context,modelAlias(modelPath),modelInfo,options);status.ready=true;status.stage='Модель готова';return;}}catch{}
        await sleep(300);
      }
      if(!status.error)throw new Error('Модель не загрузилась за 5 минут. Уменьшите контекст или выберите меньшую модель.');
    }catch(error){if(!signal.aborted)status.error=error.message;child?.kill();status.running=false;status.ready=false;}
    finally{status.preparing=false;working=false;}
  }
  return {
    status:()=>({...status,embedding}),hardware,
    async benchmark(signal){
      if(!status.ready||embedding)throw new Error('Сначала запустите чат-модель.');if(benchmarking)throw new Error('Замер уже выполняется.');benchmarking=true;
      try{
        const response=await fetch(status.url.replace(/\/v1$/,'')+'/completion',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+accessKey},body:JSON.stringify({prompt:'Write a detailed description of a quiet forest at sunrise. The morning light',n_predict:64,temperature:0,seed:1,ignore_eos:true,cache_prompt:false,stream:false}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000)});
        if(!response.ok)throw new Error('Замер скорости: HTTP '+response.status);const data=await response.json(),timings=data.timings;
        if(!Number.isFinite(timings?.predicted_per_second)||timings.predicted_per_second<=0)throw new Error('Модель не вернула измерение скорости.');
        const result={tokensPerSecond:timings.predicted_per_second,promptTokensPerSecond:timings.prompt_per_second,tokens:timings.predicted_n,context:status.context,modelPath:status.modelPath,device:status.device.name,measuredAt:new Date().toISOString(),options:status.effectiveOptions};status.benchmark=result;
        await fs.mkdir(dataDir,{recursive:true});const file=path.join(dataDir,'local-performance.json');let records=[];try{records=JSON.parse(await fs.readFile(file,'utf8'));}catch{}if(!Array.isArray(records))records=[];
        await fs.writeFile(file,JSON.stringify([...records.filter(r=>r.modelPath!==result.modelPath).slice(-99),result],null,2));return result;
      }finally{benchmarking=false;}
    },
    async whenReady(){await job;if(!status.ready)throw new Error(status.error||'Модель остановлена.');},
    start(modelPath){if(child||working||status.preparing||status.running)throw new Error('Сначала остановите текущую локальную модель.');working=true;controller=new AbortController();status={running:false,ready:false,preparing:true,stage:'Подготовка локальных моделей',modelPath,logs:[],error:''};job=run(modelPath,structuredClone(getState().settings));return {...status};},
    async stop(){controller?.abort();const current=child;current?.kill();await job;if(current&&child===current)await Promise.race([new Promise(resolve=>current.once('exit',resolve)),sleep(2500)]);if(child===current){current?.kill('SIGKILL');child=null;}status.running=false;status.ready=false;status.preparing=false;setSecret(connectionId,'');return {...status};},
  };
}
