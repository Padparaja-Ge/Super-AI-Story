import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {safeCampaign} from './room-backups.mjs';

export function guestCampaign(session,messages){
  if(!session.room?.id||session.admission==='pending')throw new Error('Сначала получите допуск хоста в комнату.');
  const room=safeCampaign({...session.room,messages,personas:{},memory:[],weights:{}});delete room.media;delete room.connectionId;delete room.aiSettings;
  for(const participant of session.participants||[])room.personas[participant.id]={id:participant.id,name:participant.personaName||participant.name,avatar:participant.avatar||'✧',description:''};
  return {spec:'sas_campaign_backup_v1',source:'guest',createdAt:new Date().toISOString(),incompleteArchive:session.archiveComplete!==true,missing:['private-host-memory','full-lorebooks','private-connections'],room,lorebooks:[],...(room.mode==='roleplay'?{narrator:{id:room.character?.id||'guest-narrator',name:room.character?.name||'Ведущий',description:'Ведущий восстановлен из последней доступной гостю копии. Исходная карточка не передавалась гостям.',blocks:[],lorebookIds:[]}}:{})};
}
export function createGuestRecovery({dataDir,snapshot,canAutoSave=()=>true}){
  const folder=dataDir?path.join(dataDir,'room-last-known'):null;let timer,pending,serial=Promise.resolve(),error='';
  async function write(bundle){if(!folder)return;const file=path.join(folder,crypto.createHash('sha256').update(bundle.room.id).digest('hex')+'.json');await fs.mkdir(folder,{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(bundle),{mode:0o600});for(let i=0;;i++)try{await fs.rename(tmp,file);break;}catch(e){if(!['EPERM','EBUSY'].includes(e.code)||i===5)throw e;await new Promise(r=>setTimeout(r,20*2**i));}}finally{await fs.unlink(tmp).catch(()=>{});}}
  function flush(manual=false){clearTimeout(timer);timer=undefined;if(!pending)return serial;if(!manual&&!canAutoSave()){pending=undefined;return serial;}const bundle=pending;pending=undefined;serial=serial.catch(()=>{}).then(()=>manual||canAutoSave()?write(bundle):undefined).then(()=>{error='';},e=>{error='Не удалось сохранить последнюю копию комнаты: '+e.message;});return serial;}
  function checkpoint(){if(!canAutoSave()){clearTimeout(timer);timer=undefined;pending=undefined;return;}try{pending=snapshot();}catch{return;}if(!timer){timer=setTimeout(()=>{void flush();},500);timer.unref();}}
  async function manual(){const bundle=snapshot();pending=bundle;await flush(true);return bundle;}
  async function list(){await flush();const out=[];for(const name of await fs.readdir(folder||'').catch(()=>[])){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;try{const file=path.join(folder,name),size=(await fs.stat(file)).size;if(size>64*1024*1024)continue;const b=JSON.parse(await fs.readFile(file,'utf8'));out.push({id:name,roomId:b.room.id,name:b.room.name,mode:b.room.mode,createdAt:b.createdAt,messageCount:b.room.messages.length,incompleteArchive:!!b.incompleteArchive});}catch{}}return {backups:out,error};}
  async function read(id){if(!folder||!/^[a-f0-9]{64}\.json$/.test(id))throw new Error('Некорректная копия комнаты.');await flush();const file=path.join(folder,id);if((await fs.stat(file)).size>64*1024*1024)throw new Error('Копия комнаты слишком большая.');return JSON.parse(await fs.readFile(file,'utf8'));}
  return {checkpoint,flush,manual,list,read,error:()=>error,cancel:()=>{clearTimeout(timer);timer=undefined;pending=undefined;}};
}
