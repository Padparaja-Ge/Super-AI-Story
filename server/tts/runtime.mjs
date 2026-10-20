import {fork,spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {sileroExecutable} from './silero-engine.mjs';
export class SpeechRuntime{
 constructor(){this.pending=new Map();this.child=null;this.key='';}
 close(reason='Озвучка остановлена.'){clearTimeout(this.idle);this.child?.kill();this.child=null;this.key='';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}this.pending.clear();}
 async request(request,signal){
  signal?.throwIfAborted();const python=['xtts','fish','silero'].includes(request.provider),key=JSON.stringify([python?request.provider:'kokoro',request.folder,request.device,python?request.runtime:'']);
  if(key!==this.key||!this.child){this.close();this.key=key;
   if(python){const exe=request.provider==='silero'?sileroExecutable(request.runtime):path.join(request.runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python');await fs.access(exe).catch(()=>{throw new Error('Сначала установите движок этой модели в настройках озвучки.');});signal?.throwIfAborted();this.child=spawn(exe,[...(request.provider==='silero'?['-I','-B']:[]),'-u',path.join(import.meta.dirname.replace(/app\.asar(?=[\\/])/,'app.asar.unpacked'),request.provider==='silero'?'silero-worker.py':'python-worker.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:request.provider==='fish'?request.source:request.folder,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',PYTHONIOENCODING:'utf-8'}});const rl=readline.createInterface({input:this.child.stdout});rl.on('line',line=>{try{this.receive(JSON.parse(line));}catch{}});
   }else this.child=fork(path.join(import.meta.dirname,'kokoro-worker.mjs'),[],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
   const child=this.child;let diagnostic='';child.stderr.on('data',data=>{diagnostic=(diagnostic+String(data)).slice(-3000);});this.diagnostic=()=>diagnostic;child.stdin?.on('error',()=>{if(this.child===child)this.close('Движок озвучки закрыл соединение. Повторите запрос.');});child.on('message',message=>this.receive(message));child.once('error',e=>{if(this.child===child)this.close('Не удалось запустить движок: '+e.message);});child.once('exit',(code,signal)=>{if(this.child===child)this.close(`Движок озвучки завершился (код ${code}, сигнал ${signal||'нет'}). ${request.device==='gpu'?'Попробуйте CPU или проверьте драйвер видеокарты.':'Проверьте установку модели.'} ${diagnostic.slice(-900)}`);});
  }
  clearTimeout(this.idle);
  const id=crypto.randomUUID();
  try{return await new Promise((resolve,reject)=>{const abort=()=>this.close();signal?.addEventListener('abort',abort,{once:true});const cleanup=()=>signal?.removeEventListener('abort',abort);const timer=setTimeout(()=>this.close('Модель не завершила озвучку за 3 минуты. '+(this.diagnostic?.()||'').slice(-900)),180000);this.pending.set(id,{resolve:v=>{cleanup();resolve(v);},reject:e=>{cleanup();reject(e);},timer});if(python)this.child.stdin.write(JSON.stringify({...request,id})+'\n');else this.child.send({...request,id});});}
  finally{this.idle=setTimeout(()=>this.close(),request.idleSeconds*1000);this.idle.unref();}
 }
 receive(result){const p=this.pending.get(result.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(result.id);result.error?p.reject(new Error(result.error)):p.resolve(result);}
}
