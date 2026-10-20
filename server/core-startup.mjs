import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readCore} from './shared-core.mjs';

export function coreFailure(error={}) {
  const code=/^[A-Z_0-9]+$/.test(error.code||'')?error.code:'CORE_START_FAILED';
  const messages={SAS_BACKEND_RUNNING:'Предыдущее ядро ещё завершает работу.',EACCES:'Нет доступа к каталогу данных SAS.',EPERM:'Windows запретила доступ к файлам ядра SAS.',ENOSPC:'Недостаточно места для файлов SAS.',ENOENT:'Не найден файл запуска ядра SAS.',ERR_MODULE_NOT_FOUND:'Не найдена зависимость ядра. Выполните npm ci в папке исходников.'};
  return {code,message:messages[code]||'Ядро SAS завершилось до готовности.'};
}

export function logCoreStartup(dataDir,event,error) {
  const filename=path.join(dataDir,'logs','core-startup.jsonl');
  try {
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    if(fs.existsSync(filename)&&fs.statSync(filename).size>256*1024){fs.rmSync(filename+'.previous',{force:true});fs.renameSync(filename,filename+'.previous');}
    // Only error classes, codes and stack locations: never state, prompts or headers.
    const failure=error?coreFailure(error):undefined;
    const frames=error?.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,8).map(line=>line.replace(/https?:\/\/\S+/g,'[URL]').slice(0,500));
    fs.appendFileSync(filename,JSON.stringify({time:new Date().toISOString(),event,pid:process.pid,...failure,...(Number.isInteger(error?.exitCode)?{exitCode:error.exitCode}:{}),...(typeof error?.signal==='string'&&/^SIG[A-Z]+$/.test(error.signal)?{signal:error.signal}:{}),...(frames?{frames}:{})})+'\n',{mode:0o600});
  }catch{}
  return filename;
}

export async function launchCore({projectRoot,dataDir,idleMs=30000,timeoutMs=45000,pollMs=100,onProgress=()=>{},spawnImpl=spawn,findCore=()=>readCore(dataDir)}={}) {
  const deadline=Date.now()+timeoutMs;
  const filename=path.join(dataDir,'logs','core-startup.jsonl');
  const failed=error=>{const info=coreFailure(error);return Object.assign(new Error(`${info.message} Код: ${info.code}. Журнал: ${filename}`),{code:info.code});};
  while(Date.now()<deadline){
    const existing=findCore();if(existing)return existing;
    let failure,exited=false,exitFailure;
    let child;
    try{child=spawnImpl(process.execPath,[path.join(projectRoot,'server','core-worker.mjs')],{
      cwd:projectRoot.endsWith('.asar')?path.dirname(projectRoot):projectRoot,
      env:{...process.env,SAS_DATA_DIR:dataDir,SAS_CORE_IDLE_MS:String(idleMs),ELECTRON_RUN_AS_NODE:'1'},
      windowsHide:true,detached:true,stdio:['ignore','ignore','ignore','ipc'],
    });}catch(error){logCoreStartup(dataDir,'spawn_error',error);throw failed(error);}
    child.on('error',error=>{failure=error;});
    child.on('message',message=>{if(message?.type==='sas:core-error')failure={code:message.code};});
    child.once('exit',(exitCode,signal)=>{exited=true;exitFailure={code:'CORE_EXITED',exitCode,signal};});child.unref();child.channel?.unref();
    onProgress(50,'Запускаем ядро и открываем истории');
    logCoreStartup(dataDir,'launch');
    while(Date.now()<deadline){
      const ready=findCore();if(ready)return ready;
      if(failure||exited){
        if(failure?.code==='SAS_BACKEND_RUNNING'){
          onProgress(55,'Ждём завершения предыдущего ядра');
          await new Promise(resolve=>setTimeout(resolve,pollMs));break;
        }
        logCoreStartup(dataDir,'failed',failure||exitFailure);
        throw failed(failure||exitFailure);
      }
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
    if(Date.now()>=deadline&&!exited){
      // Only this not-yet-ready child belongs to this launch attempt.
      if(!findCore())child.kill();
    }
  }
  const error={code:'CORE_START_TIMEOUT'};logCoreStartup(dataDir,'timeout',error);
  throw Object.assign(new Error(`Ядро SAS не стало готово за ${Math.ceil(timeoutMs/1000)} секунд. Повторите запуск. Журнал: ${filename}`),error);
}
