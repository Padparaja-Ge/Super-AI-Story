import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
export const MAX_MODEL_BYTES=2_000_000_000;
export const FISH_SOURCE_FOLDER='fish-speech-58046eaa1a4cefb0c8cc3a3a667b34186ea02dde';
export async function safeFolder(root,...segments){
 const resolved=path.resolve(root,...segments),relative=path.relative(path.resolve(root),resolved);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Недопустимая папка озвучки.');
 await fs.mkdir(root,{recursive:true});let current=path.resolve(root);for(const segment of relative.split(path.sep).filter(Boolean)){current=path.join(current,segment);await fs.mkdir(current).catch(e=>{if(e.code!=='EEXIST')throw e;});if((await fs.lstat(current)).isSymbolicLink())throw new Error('Папка озвучки не должна быть ссылкой.');}return resolved;
}
export async function downloadFile(url,destination,{size,sha256,signal,onBytes=()=>{}}={}){
 const part=destination+'.sas-part';await fs.mkdir(path.dirname(destination),{recursive:true});
 const existing=await fs.stat(destination).catch(()=>null);if(existing){if(existing.size!==size&&size!==undefined)throw new Error('Существующий файл модели повреждён: '+path.basename(destination));if(sha256){const {createReadStream}=await import('node:fs');const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(destination))hash.update(chunk);if(hash.digest('hex')!==sha256)throw new Error('Контрольная сумма существующей модели не совпала.');}onBytes(existing.size);return;}
 const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(600000)]):AbortSignal.timeout(600000)});if(!response.ok||!response.body)throw new Error(`Загрузка: HTTP ${response.status}`);
 let bytes=0;const hash=crypto.createHash('sha256');
 try{await pipeline(response.body,new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;if(bytes>(size??MAX_MODEL_BYTES))return cb(new Error('Превышен размер файла модели.'));hash.update(chunk);onBytes(chunk.length);cb(null,chunk);}}),createWriteStream(part,{flags:'wx'}),{signal});if(size!==undefined&&bytes!==size)throw new Error('Модель скачалась не полностью.');if(sha256&&hash.digest('hex')!==sha256)throw new Error('Контрольная сумма скачанной модели не совпала.');await fs.rename(part,destination);}catch(e){await fs.unlink(part).catch(()=>{});throw e;}
}
export function run(exe,args,{signal,cwd,log}={}){return new Promise((resolve,reject)=>{signal?.throwIfAborted();const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd,signal,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PYTHONIOENCODING:'utf-8',PIP_DISABLE_PIP_VERSION_CHECK:'1'}});let tail='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{const text=String(d).replace(/https?:\/\/\S+/g,'[URL]');tail=(tail+text).slice(-8000);log?.write(text);});child.once('error',reject);child.once('close',code=>code===0?resolve(tail):reject(new Error('Установка движка не завершена: '+tail.slice(-1800))));});}
async function python(root,signal){
 for(const exe of [process.env.SAS_TTS_PYTHON,process.platform==='win32'?'C:\\python312\\python.exe':'python3','python'].filter(Boolean)){try{const out=await run(exe,['-c','import sys; assert (3,10)<=sys.version_info[:2]<=(3,12); print(sys.executable)'],{signal});return out.trim();}catch{signal?.throwIfAborted();}}
 if(process.platform!=='win32')throw new Error('Установите Python 3.10–3.12: https://www.python.org/downloads/');
 // Private portable Python, without touching Python/ComfyUI installations.
 const folder=await safeFolder(root,'python-3.11.9'),zip=path.join(root,'python-3.11.9-embed-amd64.zip');
 await downloadFile('https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',zip,{signal});
 await run(process.execPath,[path.join(import.meta.dirname,'extract.mjs'),zip,folder],{signal});
 const pth=path.join(folder,'python311._pth');let text=await fs.readFile(pth,'utf8');text=text.replace('#import site','import site');await fs.writeFile(pth,text);
 const pip=path.join(folder,'get-pip.py');await downloadFile('https://bootstrap.pypa.io/get-pip.py',pip,{signal});const exe=path.join(folder,'python.exe');await run(exe,[pip],{signal});await run(exe,['-m','pip','install','virtualenv==20.29.2'],{signal});return exe;
}
export async function installPythonRuntime(root,provider,device,job){
 const runtime=await safeFolder(root,'runtime',`${provider}-${device}`),ready=path.join(runtime,'sas-ready.json');const marker=JSON.parse(await fs.readFile(ready,'utf8').catch(()=>'null'));if(marker?.version===4){const local=path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python');try{await run(local,['-c','import torch, torchaudio, imageio_ffmpeg; '+(provider==='xtts'?'from TTS.tts.models.xtts import Xtts':'import sys; sys.path.insert(0,sys.argv[1]); from fish_speech.inference_engine import TTSInferenceEngine'),path.join(root,'fish-source',FISH_SOURCE_FOLDER)],{signal:job.controller.signal});return runtime;}catch{job.controller.signal.throwIfAborted();}}
 job.stage='Установка отдельного Python-движка';const exe=await python(root,job.controller.signal),signal=job.controller.signal;
 const log=createWriteStream(path.join(runtime,'install.log'),{flags:'a'});log.write('\n'+new Date().toISOString()+' '+provider+' '+device+'\n');
 const execute=(exe,args,options={})=>run(exe,args,{signal,log,...options});
 try {
 try{await execute(exe,['-m','venv',runtime]);}catch{signal.throwIfAborted();await execute(exe,['-m','virtualenv','--copies',runtime]);}
 const local=path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python');
 await execute(local,['-m','pip','install','--upgrade','pip','setuptools','wheel']);
 await execute(local,['-m','pip','install','imageio-ffmpeg==0.6.0']);
 const torch=provider==='fish'?'2.4.1':'2.5.1';job.stage='Установка PyTorch '+(device==='gpu'?'CUDA':'CPU');await execute(local,['-m','pip','install',`torch==${torch}`,`torchaudio==${torch}`,'--index-url',device==='gpu'?'https://download.pytorch.org/whl/cu121':'https://download.pytorch.org/whl/cpu']);
 if(provider==='xtts'){job.stage='Установка XTTS';await execute(local,['-m','pip','install','coqui-tts[ja,ko,zh]==0.27.2','transformers==4.55.4','numpy==1.26.4']);}
 else{
  job.stage='Установка Fish Speech 1.5';const source=await safeFolder(root,'fish-source'),zip=path.join(root,'fish-speech-v1.5.1.zip');await downloadFile('https://codeload.github.com/fishaudio/fish-speech/zip/58046eaa1a4cefb0c8cc3a3a667b34186ea02dde',zip,{signal,size:900152,sha256:'8f4f71c95e7f7738119eb9ad42d9137536bdf7c28accbd86123c179db92f28cf'});
  await execute(process.execPath,[path.join(import.meta.dirname,'extract.mjs'),zip,source]);
  await execute(local,['-m','pip','install','numpy==1.26.4','transformers==4.46.3','hydra-core==1.3.2','einops==0.8.1','loguru==0.7.3','librosa==0.10.2.post1','rich==13.9.4','vector_quantize_pytorch==1.14.24','einx==0.2.2','tiktoken==0.8.0','pydantic==2.9.2','soundfile==0.13.1','pyrootutils==1.0.4','cachetools==5.5.2','loralib==0.1.2','natsort==8.4.0','resampy==0.4.3','click==8.1.8','tqdm==4.67.1','lightning==2.4.0','pytorch-lightning==2.4.0','torchmetrics==1.4.3']);
 }
 await execute(local,['-c',provider==='xtts'?'from TTS.tts.models.xtts import Xtts':'import sys;sys.path.insert(0,sys.argv[1]);from fish_speech.inference_engine import TTSInferenceEngine;from fish_speech.models.vqgan.inference import load_model',path.join(root,'fish-source',FISH_SOURCE_FOLDER)]);await fs.writeFile(ready,JSON.stringify({provider,device,version:4}));return runtime;
 } finally {await new Promise(resolve=>log.end(resolve));}
}
