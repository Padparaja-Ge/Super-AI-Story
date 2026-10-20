import {mountRoomMedia} from './room-media-client.js';
import {createBrowserRecovery} from './room-recovery.js';
import {validateSRP} from './srp.mjs';
import {renderGame} from './room-game.js';
const $=id=>document.getElementById(id);
let admission='pending',activeToken='',roomCacheId=new URLSearchParams(location.search).get('room')||'';
let socket,joined=false,selfId='',currentPersona,room={},participants=[],turn={free:true,eligible:[]},generating=false,popup,localOrigin='',nonce='',rewriteSource='';
let archiveReady=Promise.resolve(),archiveComplete=true;
const archive=new Map(),messages=new Map(),boxes=new Map(),pending=new Map();
const error=text=>{$('error').textContent=text||'';};
$('code').value=new URLSearchParams(location.search).get('code')||'';
let personas=[];try{personas=JSON.parse(localStorage.getItem('sas-guest-personas')||'[]');if(!Array.isArray(personas))personas=[];}catch{}
function listPersonas(){const select=$('persona');select.replaceChildren(new Option('Выберите персону',''));for(const p of personas)select.add(new Option(p.name,p.id));}listPersonas();
function avatarElement(value){const el=document.createElement('span');el.className='persona-avatar';if(typeof value==='string'&&value.length<=64000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)){const img=document.createElement('img');img.src=value;img.alt='Аватар персоны';el.append(img);}else el.textContent=typeof value==='string'&&value.length<=32?value:'✧';return el;}
function savePersona(p){p=p?.persona||p?.data||p;if(!p?.name?.trim())return error('Укажите имя персоны.');const persona={id:globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random(),...(p.kind==='srp'?validateSRP(p):{}),avatar:p.avatar||'✧',name:String(p.name).slice(0,40),description:String(p.description||'').slice(0,6000),appearance:String(p.appearance||'').slice(0,3000),personality:String(p.personality||'').slice(0,3000)};personas.push(persona);try{localStorage.setItem('sas-guest-personas',JSON.stringify(personas));}catch{}listPersonas();$('persona').value=persona.id;error('');}
$('personaKind').onchange=()=>{$('srp-fields').hidden=$('personaKind').value!=='srp';};
$('savePersona').onclick=()=>{const srp=$('personaKind').value==='srp',keys=['strength','dexterity','constitution','intelligence','wisdom','charisma'],abilities=Object.fromEntries(keys.map(k=>[k,Number($('srp-'+k).value)]));if(srp&&(Object.values(abilities).some(n=>!Number.isInteger(n)||n<0)||Object.values(abilities).reduce((a,b)=>a+b,0)>63||!$('srp-class').value.trim()))return error('SRP: укажите класс и распределите не больше 63 очков.');savePersona({name:$('personaName').value,description:$('personaDescription').value,...(srp?{kind:'srp',className:$('srp-class').value,abilities}:{})});};
$('importPersona').onchange=async e=>{try{const file=e.target.files[0];if(!file||file.size>200000)throw new Error('Файл персоны: до 200 КБ.');savePersona(JSON.parse(await file.text()));}catch(err){error(err.message);}};
function addMessage(m){
  const container=$('messages'),follow=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  archive.set(m.id,m);messages.set(m.id,m);let box=boxes.get(m.id);
  if(!box){box=document.createElement('article');box.className='message';const who=document.createElement('b'),text=document.createElement('span');text.className='message-content';box.append(who,text);boxes.set(m.id,box);$('messages').append(box);}
  box.querySelector('b').replaceChildren(avatarElement(room.avatars?.[m.userId]),document.createTextNode((m.name||'Ведущий')+(m.editedAt?' · изменено хостом':'')));box.querySelector('.message-content').textContent=m.content||'';
  if(m.kind==='image'&&!box.querySelector(':scope > img'))for(let i=0;i<Math.min(16,m.imageCount||0);i++){const image=document.createElement('img');image.src='/media/'+encodeURIComponent(m.imageId)+'/'+i+'?code='+encodeURIComponent($('code').value.trim());image.alt='Изображение сцены от хоста';image.loading='lazy';box.append(image);}
  if(m.content?.trim()&&!box.querySelector('.room-translate')){const translate=document.createElement('button');translate.type='button';translate.className='secondary room-translate';translate.textContent='Перевести';translate.onclick=async()=>{translate.disabled=true;try{const response=await fetch('/translate?code='+encodeURIComponent($('code').value.trim()),{method:'POST',headers:{'Content-Type':'application/json','X-SAS-Resume':activeToken},body:JSON.stringify({messageId:m.id,targetLang:$('translation-language').value||'ru'})}),result=await response.json();if(!response.ok)throw Error(result.error||'Перевод недоступен.');let translated=box.querySelector('.room-translation');if(!translated){translated=document.createElement('p');translated.className='room-translation';box.append(translated);}translated.textContent=result.translation;}catch(e){error(e.message);}finally{translate.disabled=false;}};box.append(translate);}
  while(messages.size>300){const id=messages.keys().next().value;messages.delete(id);boxes.get(id)?.remove();boxes.delete(id);}
  if(follow)container.scrollTop=container.scrollHeight;
}
const browserRecovery=createBrowserRecovery();
const roomMedia=mountRoomMedia($('room-media'),{sendVoice:body=>{if(socket?.readyState===WebSocket.OPEN&&admission==='approved')socket.send(JSON.stringify({type:'voice',...body}));},audioUrl:id=>'/room-audio/'+encodeURIComponent(id)+'?code='+encodeURIComponent($('code').value.trim())});
function downloadBundle(bundle,name){const href=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);}
function recoveryBundle(){const roomCopy=structuredClone(room);delete roomCopy.media;delete roomCopy.aiSettings;delete roomCopy.connectionId;return {spec:'sas_campaign_backup_v1',source:'guest',createdAt:new Date().toISOString(),incompleteArchive:!archiveComplete,missing:['private-host-memory','full-lorebooks','private-connections'],room:{...roomCopy,messages:[...archive.values()],personas:Object.fromEntries(participants.map(p=>[p.id,{id:p.id,name:p.personaName||p.name,avatar:p.avatar||'✧',description:''}]))},lorebooks:[],...(room.mode==='roleplay'?{narrator:{id:room.character?.id||'guest-narrator',name:room.character?.name||'Ведущий',description:'Ведущий восстановлен из доступной гостю копии.',blocks:[],lorebookIds:[]}}:{})};}
$('recovery-enabled').checked=browserRecovery.enabled();$('recovery-enabled').onchange=()=>browserRecovery.setEnabled($('recovery-enabled').checked);
$('recover-last').onclick=async()=>{try{const bundle=await browserRecovery.latest();if(!bundle)throw Error('Сохранённых копий пока нет.');downloadBundle(bundle,'SAS-campaign-recovered.json');}catch(e){error(e.message||'Не удалось открыть копию.');}};
$('backup').onclick=async()=>{try{await archiveReady;if(admission!=='approved')throw Error('Сначала получите допуск хоста.');downloadBundle(recoveryBundle(),'SAS-campaign-guest.json');}catch(e){error(e.message);}};
$('lobby-ready').onclick=()=>{const own=room.lobby?.players?.find(p=>p.id===selfId);command('lobby-ready',{ready:!own?.ready});};
$('lobby-leave').onclick=()=>{$('leave').click();};
function renderLobby(){const waiting=joined&&(admission==='pending'||room.lobby?.enabled&&room.lobby.phase!=='playing');$('lobby').hidden=!waiting;$('game-panels').classList.toggle('lobby-hidden',waiting);$('game-layout').classList.toggle('lobby-hidden',waiting);$('room-media').hidden=admission!=='approved';$('lobby-status').textContent=admission==='pending'?'Заявка отправлена. Ожидаем допуска хоста.':'Вы допущены. Подтвердите готовность и дождитесь начала игры.';const own=room.lobby?.players?.find(p=>p.id===selfId);$('lobby-ready').hidden=admission!=='approved';$('lobby-ready').textContent=own?.ready?'Не готов':'Я готов';$('lobby-players').replaceChildren(...(room.lobby?.players||[]).map(p=>{const item=document.createElement('li');item.textContent=p.name+' · '+p.personaName+' · '+(p.status==='pending'?'ожидает допуска':p.ready?'готов':'не готов');return item;}));}
function renderMetadata(){
  browserRecovery.setAllowed(room.autosaveEnabled!==false);
  $('title').textContent=room.name||'Комната';$('character').textContent=room.tactical?'AI Game Master · ведущий всех NPC':'RP-персонаж: '+(room.character?.name||'Не выбран');
  $('lore').textContent='Мир · Лорбук: '+((room.lorebooks||[]).map(b=>b.name).join(', ')||'не выбраны')+(room.tactical?' · Правила · Rule book: '+((room.rulebooks||[]).map(b=>b.name).join(', ')||'не выбраны'):'');
  const names=ids=>ids.map(id=>id==='narrator'?'Ведущий':participants.find(p=>p.id===id)?.name||'Игрок').join(', ');
  $('turn').textContent=room.tactical?.version===2?`Раунд ${room.tactical.round} · ${room.tactical.phase==='gm'?'AI-ведущий':room.tactical.actors.find(a=>a.id===room.tactical.order[room.tactical.turn])?.name||'Ожидание'}`:room.tactical?(room.tactical.inCombat?`Раунд ${room.tactical.round} · ход ${room.tactical.actors.find(a=>a.id===room.tactical.order[room.tactical.turn])?.name||'—'}`:'Свободная сцена · бой не начат'):turn.free?'Свободный порядок ходов':`Раунд ${turn.round}. Сейчас: ${names(turn.eligible||[])}. Очередь: ${(turn.order||[]).map(p=>names([p.id])+' ('+p.weight+')').join(' → ')}`;
  $('participants').replaceChildren(...participants.map(p=>{const el=document.createElement('span');el.className='participant';el.textContent=p.name+' · '+p.personaName+(p.host?' · хост':'')+(p.muted?' · запись запрещена':'');el.prepend(avatarElement(p.avatar));return el;}));
  const incomplete=room.narration?.status==='incomplete';
  $('narration-status').hidden=!incomplete||generating;
  $('narration-status').textContent=incomplete?'Ответ AI-ведущего не закончен. Хост может дописать его в том же сообщении или завершить вручную. Рассчитанные действия повторно не выполняются.':'';
  for(const [id,box] of boxes){const message=messages.get(id),partial=!generating&&(incomplete&&room.narration.messageId===id||message?.interrupted);let hint=box.querySelector('.message-incomplete-status');if(partial&&!hint){hint=document.createElement('small');hint.className='message-incomplete-status';box.append(hint);}if(hint){if(partial)hint.textContent='Ответ не закончен · ожидаем продолжения от хоста';else hint.remove();}}
  const canWrite=joined&&admission==='approved'&&(!room.lobby?.enabled||room.lobby.phase==='playing')&&!generating&&!incomplete&&!participants.find(p=>p.id===selfId)?.muted&&(room.tactical?.version===2?room.tactical.phase==='players'&&room.tactical.order[room.tactical.turn]===selfId:turn.free||turn.eligible?.includes(selfId));
  $('send').disabled=!canWrite||pending.size>0;$('dice').disabled=!canWrite||pending.size>0;
  const own=room.tactical?.actors.find(a=>a.id===selfId);if(own&&currentPersona&&room.tactical.version===2){Object.assign(currentPersona,{level:own.level,className:own.className,abilities:own.abilities,inventory:own.inventory,spells:own.spells});try{localStorage.setItem('sas-guest-personas',JSON.stringify(personas));}catch{}}
  renderGame(room,selfId,command,$('code').value.trim(),!joined||generating||incomplete||pending.size>0||participants.find(p=>p.id===selfId)?.muted);
  renderLobby();roomMedia.update(room.media,{id:selfId,online:joined&&admission==='approved'});
  $('status').textContent=generating?'Ведущий пишет…':incomplete?'Ожидаем завершения ответа':joined?'В комнате':'Соединение закрыто';
}
function command(type,body={}){
  if(!joined||socket?.readyState!==WebSocket.OPEN)return error('Нет соединения с комнатой.');
  const requestId=String(Date.now())+Math.random();pending.set(requestId,{type,content:$('content').value});socket.send(JSON.stringify({...body,type,requestId}));renderMetadata();
  setTimeout(()=>{if(pending.delete(requestId)){error('Нет подтверждения от хоста. Проверьте чат перед повторной отправкой.');renderMetadata();}},12000);
}
$('connect').onclick=async()=>{
  error('');if(!$('name').value.trim()||!$('code').value.trim())return error('Введите имя и код комнаты.');currentPersona=personas.find(p=>p.id===$('persona').value);if(!currentPersona)return error('Выберите свою персону.');
  if(currentPersona.kind==='srp')try{Object.assign(currentPersona,validateSRP(currentPersona));}catch(err){return error(err.message);}
  try{const response=await fetch('/room-info',{cache:'no-store',signal:AbortSignal.timeout(3000)}),info=await response.json();if(info.sasRoom===1&&typeof info.id==='string'&&info.id.length<=100)roomCacheId=info.id;}catch{}
  socket?.close();const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');socket=ws;
  ws.onopen=()=>ws.send(JSON.stringify({type:'join',code:$('code').value.trim(),name:$('name').value.trim(),persona:currentPersona,resumeToken:(()=>{try{return localStorage.getItem('sas-resume:'+(roomCacheId||location.origin)+':'+currentPersona.id)||'';}catch{return '';}})()}));
  ws.onmessage=event=>{
    if(socket!==ws)return;let data;try{data=JSON.parse(event.data);}catch{return;}
    if(data.room)room=data.room;
    if(data.type==='state'){joined=true;selfId=data.selfId;admission=data.admission||'approved';activeToken=data.resumeToken||activeToken;if(data.resumeToken)try{localStorage.setItem('sas-resume:'+(data.room.id||location.origin)+':'+currentPersona.id,data.resumeToken);localStorage.setItem('sas-resume:'+((new URLSearchParams(location.search).get('room'))||location.origin)+':'+currentPersona.id,data.resumeToken);}catch{}archive.clear();messages.clear();boxes.clear();$('messages').replaceChildren();data.messages.forEach(addMessage);archiveComplete=(data.archiveCount||0)<=data.messages.length;
      archiveReady=(async()=>{if(admission==='approved'&&activeToken){const auth=await fetch('/admit-auth?code='+encodeURIComponent($('code').value.trim()),{method:'POST',headers:{'X-SAS-Resume':activeToken}});if(!auth.ok)throw Error('Не удалось подтвердить допуск комнаты.');for(const image of $('messages').querySelectorAll('img'))if(image.complete&&!image.naturalWidth)image.src=image.src;}if(archiveComplete)return;const response=await fetch('/export?code='+encodeURIComponent($('code').value.trim()),{headers:{'X-SAS-Resume':activeToken},cache:'no-store'});if(!response.ok)throw Error('Не удалось загрузить полный архив.');const full=await response.json(),recent=[...archive.values()];archive.clear();for(const m of full.messages)archive.set(m.id,m);for(const m of recent)archive.set(m.id,m);archiveComplete=true;})().then(()=>{if(admission==='approved'&&room.id)browserRecovery.checkpoint(recoveryBundle());}).catch(e=>error(e.message));$('join').style.display='none';$('room').style.display='block';}
    if(data.admission)admission=data.admission;
    if(data.type==='voice-signal')void roomMedia.signal(data);
    if(data.type==='media')room.media=data.media;
    if(data.room)room=data.room;if(data.participants)participants=data.participants;if(data.turn)turn=data.turn;if(data.generating!==undefined)generating=data.generating;
    if(data.type==='message'||data.type==='edit')addMessage(data.message);
    if(data.type==='delta'){const m=messages.get(data.id)||{id:data.id,role:'assistant',name:room.character?.name||'Ведущий',content:''};addMessage({...m,content:m.content+data.text});}
    if(data.type==='ack'){const p=pending.get(data.requestId);if(p?.type==='message'&&p.content===$('content').value)$('content').value='';pending.delete(data.requestId);}
    if(data.type==='error'){pending.delete(data.requestId);error(data.error);}
    if(data.type==='kicked'){error('Хост исключил вас из комнаты.');ws.close();}
    renderMetadata();if(['message','edit','participants'].includes(data.type)&&admission==='approved'&&room.id)browserRecovery.checkpoint(recoveryBundle());
  };
  ws.onerror=()=>error('Не удалось подключиться. Проверьте адрес, код и брандмауэр. Для подключения через интернет можно использовать Radmin VPN или другую VPN-сеть.');
  ws.onclose=()=>{if(socket!==ws)return;joined=false;pending.clear();void browserRecovery.flush().catch(()=>{});$('join').style.display='block';renderMetadata();};
};
$('compose').onsubmit=e=>{e.preventDefault();error('');const content=$('content').value.trim();if(content)command('message',{content});};
$('dice').onclick=()=>{error('');command('dice',{sides:Number($('sides').value)});};
$('leave').onclick=()=>{void browserRecovery.flush().catch(()=>{});socket?.close(1000,'Left room');joined=false;pending.clear();$('room').style.display='none';$('join').style.display='block';renderMetadata();};
$('export').onclick=async()=>{await archiveReady;if(!archiveComplete){error('Полный архив недоступен. Переподключитесь к хосту перед экспортом.');return;}const href=URL.createObjectURL(new Blob([JSON.stringify({room,messages:[...archive.values()]},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=href;a.download='SAS-multiplayer.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);};
$('improve').onclick=()=>{
  error('');if(!$('content').value.trim())return error('Введите черновик.');
  let local;try{local=new URL($('localSas').value);if(!['http:','https:'].includes(local.protocol)||local.username||local.password)throw new Error();}catch{return error('Укажите HTTP(S)-адрес вашего SAS.');}
  localOrigin=local.origin;nonce=String(Date.now())+Math.random();rewriteSource=$('content').value;
  popup=window.open(localOrigin+'/#room-rewrite','sas-local-rewrite');if(!popup)error('Разрешите открытие окна вашего SAS.');
};
window.addEventListener('message',event=>{
  if(event.source!==popup||event.origin!==localOrigin)return;
  if(event.data?.type==='sas-rewrite-ready')popup.postMessage({type:'sas-rewrite-request',nonce,text:rewriteSource,persona:currentPersona,room:{...room,messages:[...messages.values()].slice(-4)}},localOrigin);
  if(event.data?.type==='sas-rewrite-result'&&event.data.nonce===nonce&&typeof event.data.text==='string'){
    if($('content').value===rewriteSource)$('content').value=event.data.text.slice(0,8000);else error('Черновик изменился. Скопируйте вариант из окна вашего SAS.');
  }
});
