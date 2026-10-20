import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';

export const ROOM_DISCOVERY_PORT=32123;
const PROTOCOL='sas-room-discovery-v1';
function parsePacket(bytes){if(bytes.length>1024)return;try{return JSON.parse(bytes.toString('utf8'));}catch{}}
export function broadcastAddresses(interfaces=os.networkInterfaces()){
  const result=new Set(['255.255.255.255','127.0.0.1']);
  for(const values of Object.values(interfaces))for(const value of values||[]){if(value.family!=='IPv4'||value.internal)continue;const address=value.address.split('.').map(Number),mask=(value.netmask||'').split('.').map(Number);if(address.length!==4||mask.length!==4||[...address,...mask].some(n=>!Number.isInteger(n)||n<0||n>255))continue;result.add(address.map((n,i)=>(n|(~mask[i]&255))&255).join('.'));}
  return [...result];
}
export function createRoomDiscovery({getRoom,port=ROOM_DISCOVERY_PORT,interfaces=os.networkInterfaces,socketFactory=()=>dgram.createSocket({type:'udp4',reuseAddr:true}),now=Date.now}={}){
  if(typeof getRoom!=='function'||!Number.isInteger(port)||port<0||port>65535)throw new Error('Неверные настройки поиска комнат.');
  let listener=null,listenPromise=null,lastError='',scanPromise=null;const scans=new Set(),windows=new Map();let globalWindow={at:0,count:0};
  const status=()=>({listening:!!listener,port:listener?.address?.().port||port,scanning:!!scanPromise,error:lastError});
  function listen(){if(listenPromise)return listenPromise;if(listener)return Promise.resolve(status());listenPromise=new Promise((resolve,reject)=>{
    const socket=socketFactory();let bound=false;
    socket.on('error',error=>{lastError='Не удалось включить обнаружение в локальной сети: '+error.code;if(!bound){try{socket.close();}catch{}reject(new Error(lastError));}else{try{socket.close();}catch{}listener=null;}});
    socket.on('message',(bytes,remote)=>{
      const packet=parsePacket(bytes);if(packet?.protocol!==PROTOCOL||packet.type!=='discover'||!/^[a-f0-9]{32}$/.test(packet.nonce||''))return;
      const room=getRoom();if(!room?.running||!Number.isInteger(room.port)||room.port<1||room.port>65535)return;
      const time=now();if(time-globalWindow.at>60000)globalWindow={at:time,count:0};if(++globalWindow.count>200)return;
      let bucket=windows.get(remote.address);if(!bucket||time-bucket.at>60000){bucket={at:time,count:0};windows.set(remote.address,bucket);}if(++bucket.count>20)return;
      if(windows.size>256)for(const [address,value] of windows)if(time-value.at>60000)windows.delete(address);
      // No invitation code, resume token, player information, chat or API address is announced.
      const reply={protocol:PROTOCOL,type:'room',nonce:packet.nonce,id:String(room.room?.id||room.id||'').slice(0,80),name:String(room.name||room.room?.name||'Комната SAS').slice(0,100),mode:['roleplay','dnd','custom'].includes(room.room?.mode||room.mode)?room.room?.mode||room.mode:'roleplay',port:room.port};
      socket.send(Buffer.from(JSON.stringify(reply)),remote.port,remote.address,()=>{});
    });
    socket.bind(port,'0.0.0.0',()=>{bound=true;listener=socket;lastError='';resolve(status());});
  }).finally(()=>{listenPromise=null;});return listenPromise;}
  function scan({timeoutMs=1200}={}){
    if(scanPromise)return scanPromise;const duration=Math.min(3000,Math.max(300,Number(timeoutMs)||1200)),nonce=crypto.randomBytes(16).toString('hex'),found=new Map();
    scanPromise=new Promise((resolve,reject)=>{
      const socket=socketFactory();scans.add(socket);let finished=false,timer;
      const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);scans.delete(socket);try{socket.close();}catch{}if(error){lastError='Поиск комнат недоступен: '+error.code;reject(new Error(lastError));}else resolve([...found.values()]);};
      socket.on('error',finish);socket.on('message',(bytes,remote)=>{if(finished)return;const data=parsePacket(bytes);if(data?.protocol!==PROTOCOL||data.type!=='room'||data.nonce!==nonce||typeof data.id!=='string'||!data.id||typeof data.name!=='string'||data.name.length>100||!Number.isInteger(data.port)||data.port<1||data.port>65535||!/^\d{1,3}(\.\d{1,3}){3}$/.test(remote.address))return;if(found.size>=64)return;const mode=['roleplay','dnd','custom'].includes(data.mode)?data.mode:'roleplay',id=data.id.slice(0,80);found.set(remote.address+'|'+id,{id,name:data.name,mode,address:remote.address,port:data.port,url:`http://${remote.address}:${data.port}/play?room=${encodeURIComponent(id)}`});});
      socket.bind(0,'0.0.0.0',()=>{try{socket.setBroadcast(true);}catch(error){finish(error);return;}timer=setTimeout(()=>finish(),duration);const packet=Buffer.from(JSON.stringify({protocol:PROTOCOL,type:'discover',nonce})),targetPort=listener?.address().port||port;for(const address of broadcastAddresses(interfaces()))socket.send(packet,targetPort,address,()=>{});});
      socket.once('close',()=>finish());
    }).finally(()=>{scanPromise=null;});return scanPromise;
  }
  async function close(){for(const socket of scans)try{socket.close();}catch{}if(listenPromise)await listenPromise.catch(()=>{});const socket=listener;listener=null;if(socket)await new Promise(resolve=>{socket.once('close',resolve);try{socket.close();}catch{resolve();}});if(scanPromise)await scanPromise.catch(()=>{});}
  return {status,listen,scan,close};
}
