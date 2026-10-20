import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {isIP,BlockList} from 'node:net';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const networkFile=process.env.SAS_WEB_CONFIG||path.join(process.env.PORTABLE_EXECUTABLE_DIR||(root.endsWith('.asar')?path.dirname(process.execPath):root),'web-server.json');
export const networkDefaults={host:'127.0.0.1',port:3212,accessKey:'',mode:'allowlist',allowlist:['localhost','127.0.0.1'],blocklist:[]};
export const networkInterfaces=()=>Object.entries(os.networkInterfaces()).flatMap(([name,addresses])=>(addresses||[]).filter(a=>a.family==='IPv4'||a.family==='IPv6').map(a=>({name,address:a.address,cidr:a.cidr,internal:a.internal})));
export const normalizeIP=value=>String(value||'').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i,'$1').replace(/^\[|\]$/g,'');
function compile(entries){
  const list=new BlockList();
  for(const entry of entries){
    if(entry==='localhost'){list.addAddress('127.0.0.1');list.addAddress('::1','ipv6');continue;}
    const [address,prefix,...rest]=entry.split('/'),ip=normalizeIP(address),family=isIP(ip);
    if(!family||rest.length||prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)>(family===4?32:128)))throw new Error('Укажите точный IPv4/IPv6, localhost или подсеть CIDR: '+entry);
    if(prefix!==undefined)list.addSubnet(ip,Number(prefix),family===4?'ipv4':'ipv6');else list.addAddress(ip,family===4?'ipv4':'ipv6');
  }
  return list;
}
export function validateNetwork(value){
  if(!value||!['localhost','0.0.0.0','::'].includes(value.host)&&!isIP(value.host))throw new Error('Неверный адрес прослушивания веб-сервера.');
  if(!Number.isInteger(value.port)||value.port<1||value.port>65535)throw new Error('Порт: от 1 до 65535.');
  for(const key of ['allowlist','blocklist'])if(!Array.isArray(value[key])||value[key].length>256||value[key].some(v=>typeof v!=='string'||v.length>100))throw new Error('Некорректный список адресов.');
  const mode=value.mode??'allowlist';
  if(!['allowlist','blocklist'].includes(mode))throw new Error('Выберите режим списка доступа.');
  const accessKey=value.accessKey??'';
  if(typeof accessKey!=='string'||accessKey.length>256||/[\x00-\x1f\x7f]/.test(accessKey))throw new Error('Ключ доступа: до 256 символов без переводов строк.');
  const result={host:value.host,port:value.port,accessKey,mode,allowlist:[...new Set(value.allowlist.map(v=>v.trim()).filter(Boolean))],blocklist:[...new Set(value.blocklist.map(v=>v.trim()).filter(Boolean))]};
  compile(result.allowlist);compile(result.blocklist);return result;
}
export function isAddressAllowed(config,address){
  const ip=normalizeIP(address),family=isIP(ip);if(!family)return false;
  const mode=config.mode??'allowlist',matched=compile(config[mode]).check(ip,family===4?'ipv4':'ipv6');
  return mode==='blocklist'?!matched:matched;
}
export function createNetworkPolicy({file=networkFile}={}){
  let config=structuredClone(networkDefaults),stamp='',error='';const clients=new Map();
  const read=()=>{
    try {const stat=fs.statSync(file),current=stat.mtimeMs+':'+stat.size;if(current!==stamp){config=validateNetwork(JSON.parse(fs.readFileSync(file,'utf8')));stamp=current;error='';}}
    catch(e){if(e.code!=='ENOENT')error='Ошибка web-server.json: '+e.message;else {config=structuredClone(networkDefaults);stamp='';error='';}}
    return config;
  };
  const allowed=ip=>{read();return !error&&isAddressAllowed(config,ip);};
  const snapshot=()=>({config:read(),file,error,interfaces:networkInterfaces(),clients:[...clients.values()].sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen))});
  const middleware=(req,res,next)=>{
    const ip=normalizeIP(req.socket.remoteAddress),ok=allowed(ip),previous=clients.get(ip);
    if(!previous&&clients.size>=256)clients.delete(clients.keys().next().value);
    clients.set(ip,{ip,allowed:ok,lastSeen:new Date().toISOString(),requests:(previous?.requests||0)+1});
    if(!ok)return res.status(403).json({error:'Доступ с этого IP запрещён настройками веб-сервера.'});next();
  };
  const save=(value,currentIP)=>{
    const next=validateNetwork(value);
    if(currentIP&&!isAddressAllowed(next,currentIP))throw new Error('Эти правила отключат ваш текущий IP от настроек. Измените список или сохраните такое ограничение непосредственно в файле.');
    fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);stamp='';return snapshot();
  };
  const routes=(app,{apply,getRuntime=()=>null,desktop=false,onApplied=()=>{}}={})=>{
    app.get('/api/network',(req,res)=>res.json({...snapshot(),runtime:getRuntime()}));
    app.put('/api/network',async(req,res)=>{
      if(!req.headers['x-sas-client'])return res.status(403).json({error:'Требуется клиент SAS.'});
      const currentIP=desktop?null:normalizeIP(req.socket.remoteAddress),previous=read();
      try{
        const next=validateNetwork(req.body);
        if(currentIP&&!isAddressAllowed(next,currentIP))throw new Error('Эти правила отключат ваш текущий IP от настроек. Измените список или сохраните такое ограничение непосредственно в файле.');
        const extra=await apply?.(next);
        try{save(next,currentIP);}catch(e){await apply?.(previous);throw e;}
        onApplied(req,res);
        res.json({...snapshot(),runtime:getRuntime(),...extra});
      }catch(e){res.status(400).json({error:e.message});}
    });
  };
  return {read,allowed,snapshot,middleware,save,routes};
}
