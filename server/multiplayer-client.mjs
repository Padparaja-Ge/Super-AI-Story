import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { publicPersona } from './room-rewrite.mjs';
import {createGuestRecovery,guestCampaign} from './room-client-recovery.mjs';

export function createMultiplayerClient({getState,saveState,dataDir,canAutoSave=()=>true}) {
  let socket,endpoint,invitation='',sessionToken='',selfPersona,session={connected:false,messages:[],participants:[]};
  const pending=new Map();
  const archive=new Map();let resumeTokens={};
  const tokenFile=dataDir?path.join(dataDir,'room-resume-tokens.json'):null;
  const tokenReady=tokenFile?fs.readFile(tokenFile,'utf8').then(raw=>{const data=JSON.parse(raw);if(data&&typeof data==='object'&&!Array.isArray(data))resumeTokens=data;}).catch(()=>{}):Promise.resolve();
  let tokenWrites=Promise.resolve();
  const rememberToken=(keys,token)=>{for(const key of keys)resumeTokens[key]=token;if(!tokenFile)return Promise.resolve();tokenWrites=tokenWrites.catch(()=>{}).then(async()=>{await fs.mkdir(dataDir,{recursive:true});const temporary=tokenFile+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(resumeTokens),{mode:0o600});try{for(let i=0;;i++){try{await fs.rename(temporary,tokenFile);break;}catch(e){if(!['EPERM','EBUSY'].includes(e.code)||i===5)throw e;await new Promise(r=>setTimeout(r,20*2**i));}}}finally{await fs.unlink(temporary).catch(()=>{});}});return tokenWrites;};

  const recovery=createGuestRecovery({dataDir,canAutoSave:()=>canAutoSave()&&session.room?.autosaveEnabled!==false,snapshot:()=>guestCampaign(session,[...archive.values()])});
  const status=()=>structuredClone({...session,recoveryError:recovery.error()});
  const failPending=message=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error(message));}pending.clear();};
  function leave(){recovery.cancel();const old=socket;socket=undefined;old?.close(1000,'Left room');failPending('Вы вышли из комнаты.');session={...session,connected:false};return status();}
  async function join({url,code,personaId,name}={}) {
    if(socket)throw new Error('Сначала выйдите из текущей комнаты.');
    let target;try{target=new URL(url);}catch{throw new Error('Введите ссылку приглашения или HTTP(S)-адрес комнаты.');}
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('Нужен адрес HTTP(S) без логина и пароля.');
    const persona=getState().personas.find(p=>p.id===personaId);if(!persona)throw new Error('Перед входом выберите свою персону.');
    await tokenReady;archive.clear();
    selfPersona=publicPersona(persona);endpoint=target.origin;invitation=String(code||target.searchParams.get('code')||'').trim();
    if(!invitation)throw new Error('Укажите код приглашения.');
    session={connected:false,messages:[],participants:[],room:{},persona:selfPersona};
    let roomId=target.searchParams.get('room')||'';
    // A manually entered IP can host a different campaign on the same port.
    // Resolve its public scope before selecting a private resume credential.
    try{const response=await fetch(endpoint+'/room-info',{redirect:'error',signal:AbortSignal.timeout(3000)});if(response.ok){const info=await response.json();if(info.sasRoom===1&&typeof info.id==='string'&&info.id.length<=100)roomId=info.id;}}catch{}
    const resumeKey=(roomId||endpoint)+'|'+personaId,resumeToken=resumeTokens[resumeKey]||'';sessionToken=resumeToken;
    const ws=new WebSocket(endpoint.replace(/^http/,'ws')+'/ws',{maxPayload:16*1024*1024,handshakeTimeout:10000,followRedirects:false});socket=ws;
    await new Promise((resolve,reject)=>{
      let joined=false;
      const timer=setTimeout(()=>{if(!joined){reject(new Error('Комната не ответила вовремя.'));ws.close();}},12000);
      const fail=error=>{if(!joined){clearTimeout(timer);reject(error);}};
      ws.on('open',()=>ws.send(JSON.stringify({type:'join',code:invitation,name:String(name||selfPersona.name).slice(0,40),persona:selfPersona,resumeToken})));
      ws.on('message',raw=>{
        if(socket!==ws)return;
        let data;try{data=JSON.parse(raw.toString());}catch{return;}
        if(data.type==='state'){
          const {resumeToken:token,...visible}=data;session={...session,...visible,connected:true,lastError:''};delete session.type;if(token)sessionToken=token;
          for(const message of data.messages||[])archive.set(message.id,message);
          joined=true;clearTimeout(timer);
          const finish=async()=>{
            try{
              if((data.archiveCount||0)>data.messages.length){
                const response=await fetch(endpoint+'/export?code='+encodeURIComponent(invitation),{headers:{'X-SAS-Resume':sessionToken},redirect:'error',signal:AbortSignal.timeout(60000)});
                if(!response.ok)throw Error('Не удалось получить полный архив комнаты.');
                const full=await response.json(),recent=[...archive.values()];archive.clear();for(const m of full.messages)archive.set(m.id,m);for(const m of recent)archive.set(m.id,m);
              }
              session.archiveComplete=true;
            }catch{session.archiveComplete=false;session.lastError='Полный архив недоступен; сохранены только полученные сообщения.';}
            if(session.admission!=='pending'&&canAutoSave()){recovery.checkpoint();await recovery.flush();}if(socket!==ws||!session.connected){reject(Error('Соединение закрыто во время загрузки архива.'));return;}resolve();
          };
          if(token)void rememberToken([resumeKey,(data.room.id||endpoint)+'|'+personaId],token).then(finish,()=>{session.lastError='Не удалось сохранить ключ возвращения на диск.';void finish();});else void finish();
        } else if(data.type==='participants'||data.type==='lobby-state') {
          for(const key of ['participants','room','turn','generating'])if(data[key]!==undefined)session[key]=data[key];
          if(data.admission!==undefined)session.admission=data.admission;
        } else if(data.type==='media') {
          session.room.media=data.media;
        } else if(data.type==='voice-signal') {
          session.voiceSignals=[...(session.voiceSignals||[]),{id:data.id,from:data.from,fromSession:data.fromSession,toSession:data.toSession,signal:data.signal}].slice(-128);
        } else if(data.type==='message'||data.type==='edit'){
          archive.set(data.message.id,data.message);
          const index=session.messages.findIndex(m=>m.id===data.message.id);
          if(index<0)session.messages.push(data.message);else session.messages[index]=data.message;
          session.messages=session.messages.slice(-300);
        } else if(data.type==='delta') {
          let message=session.messages.find(m=>m.id===data.id);
          if(!message){message={id:data.id,role:'assistant',name:session.room?.character?.name||'Ведущий',content:''};session.messages.push(message);}
          message.content+=String(data.text||'');archive.set(message.id,message);if(message.content.length>2000000){ws.close();return;}
        } else if(data.type==='error') {
          session.lastError=String(data.error||'Ошибка комнаты').slice(0,1000);fail(new Error(session.lastError));
          const request=pending.get(data.requestId);if(request){clearTimeout(request.timer);request.reject(Object.assign(new Error(session.lastError),{status:Number.isInteger(data.status)&&data.status>=400&&data.status<600?data.status:400}));pending.delete(data.requestId);}
        } else if(data.type==='ack') {
          const request=pending.get(data.requestId);if(request){clearTimeout(request.timer);request.resolve(status());pending.delete(data.requestId);session.lastError='';}
        } else if(data.type==='kicked') {session.lastError='Хост исключил вас из комнаты.';ws.close();}
        if(saveState&&['state','participants'].includes(data.type)&&session.room?.tactical?.version===2){const own=session.room.tactical.actors.find(a=>a.id===session.selfId),state=getState(),p=state.personas.find(p=>p.id===personaId);if(own&&p){const update={level:own.level,className:own.className,abilities:own.abilities,inventory:own.inventory,spells:own.spells};if(JSON.stringify(update)!==JSON.stringify({level:p.level,className:p.className,abilities:p.abilities,inventory:p.inventory,spells:p.spells})){Object.assign(p,update);saveState(state);}}}
        if(['message','edit','participants'].includes(data.type)&&session.admission!=='pending')recovery.checkpoint();
      });
      ws.on('error',()=>fail(new Error('Не удалось подключиться к комнате. Проверьте адрес и доступность хоста.')));
      ws.on('close',()=>{clearTimeout(timer);fail(new Error(session.lastError||'Соединение с комнатой закрыто.'));if(socket===ws){socket=undefined;session.connected=false;failPending('Соединение с комнатой закрыто.');if(session.admission!=='pending'&&canAutoSave()){recovery.checkpoint();void recovery.flush();}}});
    }).catch(error=>{if(socket===ws)socket=undefined;ws.terminate();throw error;});
    return status();
  }
  function command(type,body={}) {
    if(!session.connected||socket?.readyState!==WebSocket.OPEN)throw new Error('Подключитесь к комнате.');
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Нет подтверждения от хоста. Проверьте чат перед повторной отправкой.'));},12000);
      pending.set(requestId,{resolve,reject,timer});socket.send(JSON.stringify({...body,type,requestId}));
    });
  }
  function rewritePayload(text,connectionId) {
    if(!session.connected)throw new Error('Подключитесь к комнате.');
    return {text,connectionId,persona:selfPersona,room:{...session.room,messages:session.messages}};
  }
  async function media(id,index,res) {
    if(!session.connected||!(session.messages.some(m=>m.imageId===id)||session.room?.tactical?.map?.imageId===id)||!/^\d+$/.test(index))return res.sendStatus(404);
    const response=await fetch(`${endpoint}/media/${encodeURIComponent(id)}/${index}?code=${encodeURIComponent(invitation)}`,{headers:{'X-SAS-Resume':sessionToken},redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok||!/^image\/(png|jpeg|webp)$/.test(response.headers.get('content-type')||'')){await response.body?.cancel();return res.sendStatus(502);}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>40*1024*1024)throw new Error('Изображение слишком большое.');chunks.push(chunk);}
    res.type(response.headers.get('content-type')).send(Buffer.concat(chunks));
  }
  async function audio(id,req,res){if(!session.connected||session.admission==='pending'||!session.room?.media?.playlist?.tracks?.some(t=>t.id===id))return res.sendStatus(404);const response=await fetch(`${endpoint}/room-audio/${encodeURIComponent(id)}?code=${encodeURIComponent(invitation)}`,{headers:{'X-SAS-Resume':sessionToken,...(req.headers.range?{Range:req.headers.range}:{})},redirect:'error',signal:AbortSignal.timeout(60000)});res.status(response.status);for(const key of ['content-type','content-length','content-range','accept-ranges'])if(response.headers.has(key))res.setHeader(key,response.headers.get(key));if(!response.ok||req.method==='HEAD'){await response.body?.cancel();return res.end();}const {Readable}=await import('node:stream');Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);}
  const leaveAsync=async()=>{if(session.admission!=='pending'&&session.room?.id&&canAutoSave()){recovery.checkpoint();await recovery.flush();}return leave();};
  return {join,leave,leaveAsync,close:leaveAsync,status,command,rewritePayload,media,audio,backup:()=>recovery.manual(),recoveries:()=>recovery.list(),recovery:id=>recovery.read(id),exportChat:()=>structuredClone({room:session.room,messages:[...archive.values()],archiveComplete:session.archiveComplete})};
}
