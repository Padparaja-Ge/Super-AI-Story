import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {roomAutosaveSettings} from '../shared/room-autosave.mjs';

const MAX_BYTES=64*1024*1024;
const denied=new Set(['__proto__','prototype','constructor','playerSessions','resumeToken','tokenHash','apiKey','api_key','password','secret','authorization','accessToken','refreshToken']);
export function safeCampaign(value){
  if(Array.isArray(value))return value.map(safeCampaign);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!denied.has(key)&&!/(?:api[_-]?key|secret|password|tokenHash)$/i.test(key)).map(([key,item])=>[key,safeCampaign(item)]));
  return value;
}
export function campaignBundle(state,{source='host'}={}){
  const room=safeCampaign(state.multiplayer||{});delete room.connectionId;delete room.aiSettings;delete room.media;
  const ids=new Set([...(room.lorebookIds||[]),...(room.rulebookIds||[])]),chat=state.chats?.find(c=>c.id===room.chatId),character=state.characters?.find(c=>c.id===chat?.characterId);
  return {spec:'sas_campaign_backup_v1',source,createdAt:new Date().toISOString(),room,lorebooks:safeCampaign((state.lorebooks||[]).filter(b=>ids.has(b.id))),...(character?{narrator:safeCampaign(character)}:{})};
}
export function validateCampaignBundle(input){
  if(!input||input.spec!=='sas_campaign_backup_v1'||!input.room||typeof input.room!=='object'||Array.isArray(input.room))throw new Error('Нужна резервная копия кампании SAS.');
  if(Buffer.byteLength(JSON.stringify(input))>MAX_BYTES)throw new Error('Резервная копия превышает 64 МБ.');
  const clean=safeCampaign(input),room=clean.room;
  if(!['roleplay','dnd','custom'].includes(room.mode||'roleplay'))throw new Error('Неизвестный режим кампании.');
  if(typeof room.id!=='string'||!room.id||room.id.length>100||!Array.isArray(room.messages)||room.messages.length>100000)throw new Error('Некорректная история кампании.');
  const seen=new Set();for(const message of room.messages){if(!message||typeof message.id!=='string'||seen.has(message.id)||!['user','assistant','system'].includes(message.role)||typeof message.content!=='string'||message.content.length>2000000)throw new Error('Некорректное сообщение в копии кампании.');seen.add(message.id);}
  if(room.mode!=='roleplay'){
    const g=room.tactical;if(!g||g.version!==2||!Array.isArray(g.actors)||g.actors.length>200||!Array.isArray(g.log||[]))throw new Error('Некорректный игровой стол кампании.');
    for(const a of g.actors)if(!a||typeof a.id!=='string'||!Number.isFinite(a.hp)||!Number.isFinite(a.maxHp)||a.maxHp<1||a.hp<0||a.hp>a.maxHp)throw new Error('Некорректные ресурсы участника кампании.');
    if(g.map){const m=g.map;if(!Number.isInteger(m.width)||!Number.isInteger(m.height)||m.width<1||m.width>100||m.height<1||m.height>100||!Array.isArray(m.tiles)||m.tiles.length!==m.width*m.height||!Array.isArray(m.start))throw new Error('Некорректная карта кампании.');}
  }
  if(clean.lorebooks&&!Array.isArray(clean.lorebooks))throw new Error('Некорректные книги кампании.');
  for(const b of clean.lorebooks||[])if(!b||typeof b.id!=='string'||typeof b.name!=='string'||!Array.isArray(b.entries)||b.entries.length>20000||b.entries.some(e=>!e||typeof e.id!=='string'||typeof e.content!=='string'||e.content.length>200000))throw new Error('Некорректный лорбук резервной копии.');
  return clean;
}
export function restoreCampaign(state,input){
  const bundle=validateCampaignBundle(input),room=structuredClone(bundle.room),id=crypto.randomUUID(),bookIds=new Map();
  for(const original of bundle.lorebooks||[]){const book={...original,id:crypto.randomUUID()};bookIds.set(original.id,book.id);state.lorebooks.push(book);}
  room.lorebookIds=(room.lorebookIds||[]).map(id=>bookIds.get(id)).filter(Boolean);room.rulebookIds=(room.rulebookIds||[]).map(id=>bookIds.get(id)).filter(Boolean);
  if(room.mode==='roleplay'&&bundle.narrator){const character={...bundle.narrator,id:crypto.randomUUID(),personaId:'',lorebookIds:room.lorebookIds};state.characters.push(character);const chat={id:crypto.randomUUID(),characterId:character.id,title:character.name,messages:[],memory:[],summary:'',createdAt:new Date().toISOString()};state.chats.push(chat);room.chatId=chat.id;}
  if(room.mode==='roleplay'&&!state.chats.some(c=>c.id===room.chatId))throw new Error('В копии отсутствует карточка ведущего. Выберите историю с доступным персонажем.');
  room.restoredFrom=room.id;room.id=id;room.name=(room.name||'Кампания')+' · восстановлено';room.createdAt=new Date().toISOString();delete room.connectionId;delete room.aiSettings;delete room.playerSessions;delete room.media;
  // Image files/audio are separate binary assets and cannot be recovered from a
  // portable JSON save. Never resolve their old IDs against another campaign.
  for(const message of room.messages)if(message.kind==='image'){delete message.imageId;delete message.imageCount;message.kind='image-unavailable';message.content=(message.content||'Изображение')+' · файл изображения не включён в резервную копию';}
  if(room.tactical?.map)delete room.tactical.map.imageId;
  room.lobby={enabled:true,phase:'waiting',startedAt:bundle.room.lobby?.startedAt||new Date().toISOString()};room.recovery={source:bundle.source||'host',partial:bundle.source==='guest',restoredAt:new Date().toISOString()};
  if(room.tactical){for(const a of room.tactical.actors)if(a.player)a.online=a.id==='host';}
  if(room.narration){room.narration.status='incomplete';room.narration.error='Кампания восстановлена. Проверьте последний ответ ведущего перед продолжением.';}
  const current=state.multiplayer;if(current?.id)state.multiplayerHistories=[...(state.multiplayerHistories||[]).filter(r=>r.id!==current.id),current];state.multiplayer=room;
  return room;
}
export function createRoomBackups({dataDir,getState,canAutoSave=()=>true}){
  const root=path.join(dataDir,'campaign-backups');let queue=Promise.resolve(),timer,pending,closed=false,lastHash='',lastRoom='',lastError='',lastSave=0,previousImportant='';
  async function atomic(file,text){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,text,{mode:0o600});for(let i=0;;i++)try{await fs.rename(tmp,file);break;}catch(e){if(!['EBUSY','EPERM'].includes(e.code)||i===5)throw e;await new Promise(r=>setTimeout(r,15*2**i));}}finally{await fs.unlink(tmp).catch(()=>{});}}
  function savePending(manual=false){clearTimeout(timer);timer=undefined;if(!pending)return queue;if(!manual&&(!canAutoSave()||!roomAutosaveSettings(pending.multiplayer?.autosaveSettings).enabled)){pending=undefined;return queue;}const bundle=campaignBundle(pending);pending=undefined;queue=queue.catch(()=>{}).then(async()=>{if(!manual&&!canAutoSave())return;const text=JSON.stringify(bundle),hash=crypto.createHash('sha256').update(JSON.stringify(bundle.room)).digest('hex');if(hash===lastHash&&lastRoom===bundle.room.id)return;const folder=path.join(root,crypto.createHash('sha256').update(bundle.room.id).digest('hex').slice(0,24));await atomic(path.join(folder,'latest.json'),text);const name=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.json';await atomic(path.join(folder,name),text);const entries=(await fs.readdir(folder)).filter(f=>f!=='latest.json'&&f.endsWith('.json')).sort(),retention=roomAutosaveSettings(bundle.room.autosaveSettings).maxSnapshots;await Promise.all(entries.slice(0,-retention).map(f=>fs.unlink(path.join(folder,f))));lastHash=hash;lastRoom=bundle.room.id;lastSave=Date.now();lastError='';}).catch(e=>{lastError='Не удалось сохранить резервную копию кампании: '+e.message;});return queue;}
  function checkpoint(state=getState()){
    if(closed||!state.multiplayer?.id)return;const room=state.multiplayer,settings=roomAutosaveSettings(room.autosaveSettings);
    if(!settings.enabled||!canAutoSave()){clearTimeout(timer);timer=undefined;pending=undefined;return;}
    const message=room.messages?.at(-1),important=JSON.stringify([room.id,message?.role==='assistant'&&!settings.includeAiReplies?'':message?.id,message?.interrupted===false,room.tactical?.round,room.tactical?.turn,room.tactical?.log?.at(-1)?.id,room.corrections?.length]);const changed=important!==previousImportant;previousImportant=important;pending=state;
    const due=lastRoom!==room.id||settings.onImportantEvents&&changed?250:Math.max(250,settings.intervalSeconds*1000-(Date.now()-lastSave));if(timer&&due>250)return;clearTimeout(timer);timer=setTimeout(()=>{void savePending();},due);timer.unref();
  }
  async function list(){await savePending();const out=[];for(const dir of await fs.readdir(root).catch(()=>[])){if(!/^[a-f0-9]{24}$/.test(dir))continue;for(const file of await fs.readdir(path.join(root,dir))){if(!/^(?:latest|[0-9TZ-]+-[a-f0-9]+)\.json$/.test(file))continue;try{const full=path.join(root,dir,file),s=await fs.stat(full);if(s.size>MAX_BYTES)continue;const data=JSON.parse(await fs.readFile(full,'utf8'));out.push({id:dir+'/'+file,roomId:data.room.id,name:data.room.name,mode:data.room.mode,createdAt:data.createdAt,messageCount:data.room.messages?.length||0,bytes:s.size,latest:file==='latest.json'});}catch{}}}return {backups:out.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),error:lastError};}
  async function read(id){if(typeof id!=='string'||!/^([a-f0-9]{24})\/(latest|[0-9TZ-]+-[a-f0-9]+)\.json$/.test(id))throw new Error('Некорректный номер резервной копии.');await savePending();const file=path.join(root,...id.split('/')),s=await fs.stat(file);if(s.size>MAX_BYTES)throw new Error('Резервная копия слишком большая.');return validateCampaignBundle(JSON.parse(await fs.readFile(file,'utf8')));}
  return {checkpoint,list,read,manual:async(state=getState())=>{pending=state;await savePending(true);return campaignBundle(state);},error:()=>lastError,flush:()=>savePending(),close:async()=>{closed=true;await savePending();}};
}
