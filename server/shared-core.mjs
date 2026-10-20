import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const coreVersion=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

export function readCore(dataDir) {
  try {
    const data=JSON.parse(fs.readFileSync(path.join(dataDir,'core.json'),'utf8'));
    if(!Number.isInteger(data.pid)||!Number.isInteger(data.port)||data.port<1||data.port>65535)return null;
    process.kill(data.pid,0); return data;
  }catch{return null;}
}
export function lockCore(dataDir) {
  fs.mkdirSync(dataDir,{recursive:true});
  const filename=path.join(dataDir,'core.lock'), instanceId=crypto.randomUUID();
  for(let attempt=0;attempt<2;attempt++){
    try {const fd=fs.openSync(filename,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,instanceId}));fs.closeSync(fd);break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let old;try{old=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{throw new Error('Файл блокировки SAS повреждён. Проверьте, что SAS закрыт, затем переименуйте core.lock в каталоге данных.');}
      let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(alive||attempt===1)throw Object.assign(new Error('Этот каталог данных уже открыт сервером SAS. Используйте Start-SAS-Web или режим оболочки.'),{code:'SAS_BACKEND_RUNNING'});
      if(fs.readFileSync(filename,'utf8')===JSON.stringify(old))fs.unlinkSync(filename);
    }
  }
  return {
    instanceId,
    publish(port){fs.writeFileSync(path.join(dataDir,'core.json'),JSON.stringify({pid:process.pid,instanceId,port,version:coreVersion}),{mode:0o600});},
    release(){try{if(JSON.parse(fs.readFileSync(filename,'utf8')).instanceId===instanceId){fs.unlinkSync(filename);const descriptor=path.join(dataDir,'core.json');if(fs.existsSync(descriptor)&&JSON.parse(fs.readFileSync(descriptor,'utf8')).instanceId===instanceId)fs.unlinkSync(descriptor);}}catch{}},
  };
}
