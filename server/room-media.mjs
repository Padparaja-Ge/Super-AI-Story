import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TRACK=16*1024*1024,MAX_ROOM=160*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const idPattern=/^[a-f0-9-]{36}$/;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
function audioType(bytes){
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'audio/wav';
  if(bytes.subarray(0,4).toString()==='OggS')return 'audio/ogg';
  if(bytes.subarray(0,4).toString()==='fLaC')return 'audio/flac';
  if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)return 'audio/mpeg';
  if(bytes.subarray(4,8).toString()==='ftyp'&&/M4A |mp42|isom/.test(bytes.subarray(8,40).toString()))return 'audio/mp4';
  return null;
}
export function normalizeIceServers(input=[]){
  if(!Array.isArray(input)||input.length>8)throw fail('Укажите не больше 8 STUN/TURN-серверов.');
  return input.map(server=>{
    if(!server||typeof server!=='object')throw fail('Неверная настройка ICE-сервера.');
    const urls=Array.isArray(server.urls)?server.urls:[server.urls];
    if(!urls.length||urls.length>8||urls.some(url=>typeof url!=='string'||url.length>512||!/^stuns?:[^\s@]+$|^turns?:[^\s@]+$/.test(url)))throw fail('Нужен STUN/TURN-адрес без пробелов и встроенного пароля.');
    return {urls,...(server.username?{username:String(server.username).slice(0,256)}:{}),...(server.credential?{credential:String(server.credential).slice(0,512)}:{})};
  });
}
export function validateVoiceSignal(signal){
  if(!signal||typeof signal!=='object'||Array.isArray(signal))throw fail('Неверный сигнал голосовой связи.');
  if(signal.description){
    const {type,sdp}=signal.description;
    if(!['offer','answer'].includes(type)||typeof sdp!=='string'||sdp.length>48000||!/\bm=audio\s/.test(sdp)||/\bm=(?:video|application)\s/.test(sdp))throw fail('Разрешена только голосовая связь без видео и передачи файлов.');
    return {description:{type,sdp}};
  }
  if(signal.candidate===null)return {candidate:null};
  const candidate=signal.candidate;
  if(!candidate||typeof candidate.candidate!=='string'||candidate.candidate.length>4096||candidate.sdpMid!=null&&typeof candidate.sdpMid!=='string'||candidate.sdpMLineIndex!=null&&(!Number.isInteger(candidate.sdpMLineIndex)||candidate.sdpMLineIndex<0||candidate.sdpMLineIndex>8))throw fail('Неверный ICE-кандидат.');
  return {candidate:{candidate:candidate.candidate,sdpMid:candidate.sdpMid??null,sdpMLineIndex:candidate.sdpMLineIndex??null,...(typeof candidate.usernameFragment==='string'?{usernameFragment:candidate.usernameFragment.slice(0,256)}:{})}};
}

/** Media is deliberately separate from chat, prompts, memory and game calculations. */
export function createRoomMedia({getRoom,saveRoom,broadcast=()=>{},deliver=()=>{},participants=()=>[],dataDir,now=Date.now}){
  const voice=new Map(),signalsByActor=new Map(),rates=new Map(),forcedMuted=new Set();let sequence=0,activeRoom='',serial=Promise.resolve();
  const room=()=>getRoom()||{};
  function resetScope(){if(activeRoom!==room().id){activeRoom=room().id;voice.clear();signalsByActor.clear();rates.clear();forcedMuted.clear();}}
  function state(){resetScope();const current=room().media||{};return {tracks:Array.isArray(current.tracks)?current.tracks:[],currentId:current.currentId||'',playing:!!current.playing,position:Number(current.position)||0,updatedAt:Number(current.updatedAt)||now(),loop:current.loop!==false,iceServers:current.iceServers||[]};}
  function publicState(){const current=state();return {playlist:{tracks:current.tracks.map(({id,name,mime,bytes})=>({id,name,mime,bytes})),currentId:current.currentId,playing:current.playing,position:current.position,updatedAt:current.updatedAt,loop:current.loop},voice:{participants:[...voice.values()].map(({id,name,muted})=>({id,name,muted:!!muted||forcedMuted.has(id),forcedMuted:forcedMuted.has(id)})),forcedMuted:[...forcedMuted],iceServers:current.iceServers}};}
  const notify=()=>broadcast({type:'media',media:publicState()});
  const persist=current=>{const value={...current};saveRoom(value);notify();return publicState();};
  const root=()=>{if(!idPattern.test(room().id||''))throw fail('Откройте комнату перед загрузкой музыки.');return path.join(dataDir,'room-media',room().id);};
  function hostCommand(payload={}){const run=async()=>{
    const current=state(),action=payload.action;
    if(action==='upload'){
      if(current.tracks.length>=40)throw fail('В плейлисте может быть не больше 40 файлов.');
      if(typeof payload.data!=='string'||payload.data.length%4!==0||payload.data.length>Math.ceil(MAX_TRACK*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw fail('Аудиофайл должен быть до 16 МБ.');
      const bytes=Buffer.from(payload.data,'base64'),mime=audioType(bytes);
      if(bytes.length<44||bytes.length>MAX_TRACK||!mime)throw fail('Поддерживаются аудиофайлы MP3, WAV, OGG, FLAC и M4A до 16 МБ.');
      if(current.tracks.reduce((sum,t)=>sum+t.bytes,0)+bytes.length>MAX_ROOM)throw fail('Музыка комнаты занимает больше 160 МБ. Удалите ненужные треки.');
      const id=crypto.randomUUID(),directory=root();await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,id),bytes,{flag:'wx'});
      const name=String(payload.name||'Атмосфера').replace(/[\x00-\x1f\x7f]/g,'').slice(0,120)||'Атмосфера';
      return persist({...current,tracks:[...current.tracks,{id,name,mime,bytes:bytes.length}],currentId:current.currentId||id});
    }
    if(action==='settings')return persist({...current,iceServers:normalizeIceServers(payload.iceServers),loop:payload.loop===undefined?current.loop:!!payload.loop});
    const track=current.tracks.find(t=>t.id===(payload.id||current.currentId));
    if(action==='remove'){
      if(!track)throw fail('Трек не найден.',404);
      const next={...current,tracks:current.tracks.filter(t=>t.id!==track.id)};
      if(current.currentId===track.id)Object.assign(next,{currentId:next.tracks[0]?.id||'',position:0,playing:false,updatedAt:now()});
      const result=persist(next);await fs.unlink(path.join(root(),track.id)).catch(()=>{});return result;
    }
    if(!track)throw fail('Сначала выберите аудиофайл.');
    if(!['select','play','pause','seek'].includes(action))throw fail('Неизвестная команда плейлиста.');
    let position=current.position+(current.playing?(now()-current.updatedAt)/1000:0);
    if(action==='select')position=0;
    if(action==='seek'){if(!Number.isFinite(payload.position)||payload.position<0||payload.position>86400)throw fail('Неверная позиция трека.');position=payload.position;}
    return persist({...current,currentId:track.id,position:clamp(position,0,86400),playing:action==='play'?true:action==='pause'||action==='select'?false:current.playing,updatedAt:now()});
  };const result=serial.then(run);serial=result.catch(()=>{});return result;}
  function member(id){return participants().find(p=>p.id===id);}
  function signals(actorId,afterId=0){resetScope();return (signalsByActor.get(actorId)||[]).filter(event=>event.id>afterId);}
  function command(peer,payload={}){
    resetScope();const participant=member(peer?.id);if(!participant)throw fail('Вход в голосовую связь доступен только допущенным участникам.',403);
    for(const [id,bucket]of rates)if(now()-bucket.at>10000)rates.delete(id);
    const bucket=rates.get(peer.id)||{at:now(),count:0};if(++bucket.count>160)throw fail('Слишком много голосовых сигналов.',429);rates.set(peer.id,bucket);
    if(payload.action==='moderate'){
      if(peer.id!=='host')throw fail('Только ведущий может управлять микрофонами участников.',403);
      if(typeof payload.target!=='string'||payload.target==='host'||!member(payload.target))throw fail('Выберите допущенного участника комнаты.',404);
      if(typeof payload.muted!=='boolean')throw fail('Укажите, заблокирован ли микрофон.');
      if(payload.muted)forcedMuted.add(payload.target);else forcedMuted.delete(payload.target);
      // Releasing a host mute never turns a microphone on without its owner.
      const target=voice.get(payload.target);if(target)target.muted=true;
      notify();return publicState();
    }
    if(payload.action==='join'){
      if(voice.size>=12&&!voice.has(peer.id))throw fail('В голосовой связи могут участвовать до 12 человек.');
      voice.set(peer.id,{id:peer.id,name:participant.name||peer.name||'Участник',muted:true});notify();return publicState();
    }
    if(payload.action==='leave'){disconnected(peer);return publicState();}
    const own=voice.get(peer.id);if(!own)throw fail('Сначала включите голосовую связь.');
    if(payload.action==='muted'){if(payload.muted===false&&forcedMuted.has(peer.id))throw fail('Ведущий отключил ваш микрофон.',403);own.muted=payload.muted!==false;notify();return publicState();}
    if(payload.action!=='signal')throw fail('Неизвестная команда голосовой связи.');
    if(payload.target===peer.id||!voice.has(payload.target)||!member(payload.target))throw fail('Участник не подключён к голосовой связи.',404);
    const signal=validateVoiceSignal(payload.signal),event={type:'voice-signal',id:++sequence,from:peer.id,signal};
    const events=signalsByActor.get(payload.target)||[];events.push(event);signalsByActor.set(payload.target,events.slice(-128));deliver(payload.target,event);return {ok:true};
  }
  function disconnected(peer){if(voice.delete(peer.id)){signalsByActor.delete(peer.id);notify();}}
  async function handleHttp(req,res,url,{authorized=false}={}){
    const pathname=typeof url==='string'?new URL(url,'http://localhost').pathname:url.pathname;
    const match=pathname.match(/\/(?:room-audio|audio)\/([a-f0-9-]{36})$/);if(!match||!['GET','HEAD'].includes(req.method))return false;
    if(!authorized){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'});res.end('Доступ к музыке комнаты запрещён.');return true;}
    const track=state().tracks.find(t=>t.id===match[1]);if(!track){res.writeHead(404);res.end();return true;}
    let stat;const file=path.join(root(),track.id);try{stat=await fs.stat(file);if(!stat.isFile()||stat.size!==track.bytes)throw Error();}catch{res.writeHead(404);res.end();return true;}
    const headers={'Content-Type':track.mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};let start=0,end=stat.size-1,status=200;
    if(req.headers.range){const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!range||!range[1]&&!range[2]){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return true;}if(range[1]){start=Number(range[1]);end=range[2]?Number(range[2]):end;}else start=Math.max(0,stat.size-Number(range[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return true;}end=Math.min(end,stat.size-1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
    headers['Content-Length']=end-start+1;res.writeHead(status,headers);if(req.method==='HEAD')res.end();else{const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}return true;
  }
  async function close(){await serial;voice.clear();signalsByActor.clear();rates.clear();forcedMuted.clear();}
  return {publicState,hostCommand,command,disconnected,handleHttp,signals,close};
}
