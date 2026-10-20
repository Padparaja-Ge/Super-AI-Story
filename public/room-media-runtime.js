/** Shared by the desktop/web React client and the small /play guest client. */
export function microphoneUnavailableReason(scope=globalThis){
  if(!scope.isSecureContext)return 'Микрофон требует HTTPS или localhost. На HTTP-адресе локальной сети чат и музыка работают, но браузер блокирует микрофон. Откройте SAS на своём компьютере и подключитесь из него либо настройте HTTPS у хоста.';
  if(!scope.navigator?.mediaDevices?.getUserMedia||!scope.RTCPeerConnection)return 'Этот браузер не поддерживает голосовую связь. Используйте актуальный браузер или настольный SAS.';
  return '';
}
export function playlistPosition(playlist,now=Date.now(),duration=0){
  let position=Math.max(0,Number(playlist?.position)||0)+(playlist?.playing?Math.max(0,now-(Number(playlist.updatedAt)||now))/1000:0);
  if(Number.isFinite(duration)&&duration>0)position=playlist?.loop!==false?position%duration:Math.min(position,duration);
  return position;
}
export const defaultVoiceSettings={mode:'push',key:'KeyV',inputDevice:'',outputDevice:'',gain:1,sensitivity:.025,voiceVolume:1,musicVolume:.35,muted:true,echoCancellation:true,noiseSuppression:true,autoGainControl:true};
export function normalizeVoiceSettings(input={}){
  const value={...defaultVoiceSettings,...(input&&typeof input==='object'?input:{})};
  for(const [key,min,max] of [['gain',0,3],['sensitivity',.001,.3],['voiceVolume',0,1],['musicVolume',0,1]])value[key]=Number.isFinite(Number(value[key]))?Math.max(min,Math.min(max,Number(value[key]))):defaultVoiceSettings[key];
  if(!['push','voice','open'].includes(value.mode))value.mode='push';if(!['KeyV','KeyB','Space','ControlRight'].includes(value.key))value.key='KeyV';
  for(const key of ['inputDevice','outputDevice'])value[key]=typeof value[key]==='string'?value[key].slice(0,512):'';
  for(const key of ['muted','echoCancellation','noiseSuppression','autoGainControl'])value[key]=typeof value[key]==='boolean'?value[key]:defaultVoiceSettings[key];
  return value;
}
export function createRoomMediaController(options){
  let media={playlist:{tracks:[]},voice:{participants:[],iceServers:[]}},selfId=options.selfId||'',connected=true,destroyed=false,joined=false,joining=false,playbackEnabled=false,autoplayBlocked=false,error='',level=0,talking=false,held=false,settings=normalizeVoiceSettings(options.settings),stream,source,gain,analyser,audioContext,processedStream,timer,voiceEpoch=0,lastOpen=0,lastUi=0;
  const peers=new Map(),seenSignals=new Set(),music=new Audio();music.preload='metadata';let trackId='',driftTimer;
  const onChange=()=>{if(!destroyed)options.onChange?.(snapshot());};
  const report=message=>{error=String(message||'').slice(0,800);onChange();};
  const isForced=id=>(media.voice?.forcedMuted||[]).includes(id)||media.voice?.participants?.some(p=>p.id===id&&p.forcedMuted===true);
  const snapshot=()=>({joined,joining,forcedMuted:!!isForced(selfId),playbackEnabled,autoplayBlocked,error,level,talking,settings:{...settings},secureReason:microphoneUnavailableReason(),peers:[...peers].map(([id,value])=>({id,state:value.pc.connectionState,silenced:value.audio.muted})),position:music.currentTime||0,duration:Number.isFinite(music.duration)?music.duration:0});
  const send=payload=>Promise.resolve(options.sendVoice(payload));
  function safePlay(audio){const result=audio.play();result?.catch(()=>{if(destroyed)return;autoplayBlocked=true;onChange();});}
  function synchronize(){
    const playlist=media.playlist||{},track=(playlist.tracks||[]).find(t=>t.id===playlist.currentId);
    if(!track||!connected){music.pause();if(!track){music.removeAttribute('src');music.load();trackId='';}return;}
    if(trackId!==track.id){trackId=track.id;music.src=options.audioUrl(track.id);music.load();}
    music.loop=playlist.loop!==false;music.volume=Math.max(0,Math.min(1,settings.musicVolume));
    const desired=playlistPosition(playlist,Date.now(),music.duration);
    if(music.readyState>=1&&Math.abs(music.currentTime-desired)>1.5)try{music.currentTime=desired;}catch{}
    if(playbackEnabled&&playlist.playing)safePlay(music);else music.pause();
  }
  music.addEventListener('loadedmetadata',synchronize);music.addEventListener('error',()=>report('Не удалось прочитать музыку комнаты. Проверьте доступность хоста и формат файла.'));
  music.addEventListener('timeupdate',()=>{if(Date.now()-lastUi>500){lastUi=Date.now();onChange();}});
  driftTimer=setInterval(synchronize,2500);
  function setPlaybackEnabled(value){playbackEnabled=!!value;autoplayBlocked=false;error='';if(value){audioContext?.resume().catch(()=>{});for(const entry of peers.values())safePlay(entry.audio);}synchronize();onChange();}
  function setSettings(next){
    settings=normalizeVoiceSettings({...settings,...next});
    if(isForced(selfId))settings.muted=true;
    if(gain)gain.gain.value=settings.gain;
    for(const entry of peers.values()){entry.audio.volume=settings.voiceVolume;if(entry.audio.setSinkId&&next.outputDevice!==undefined)entry.audio.setSinkId(settings.outputDevice).catch(()=>report('Не удалось выбрать устройство вывода звука.'));}
    synchronize();transmit();onChange();options.onSettings?.({...settings});
  }
  function transmit(){
    const shouldTalk=joined&&!isForced(selfId)&&!settings.muted&&(settings.mode==='open'||settings.mode==='push'&&held||settings.mode==='voice'&&Date.now()-lastOpen<180);
    if(processedStream)for(const track of processedStream.getAudioTracks())track.enabled=shouldTalk;
    if(talking!==shouldTalk){talking=shouldTalk;void send({action:'muted',muted:!talking}).catch(e=>report(e.message));onChange();}
  }
  function setPushHeld(value){held=!!value&&!isForced(selfId);transmit();}
  function keyDown(event){if(event.repeat||event.code!==settings.key||event.altKey||event.ctrlKey&&event.code!=='ControlRight'||event.metaKey)return;const target=event.target;if(target?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName||''))return;event.preventDefault();setPushHeld(true);}
  function keyUp(event){if(event.code===settings.key)setPushHeld(false);}
  const blur=()=>setPushHeld(false);
  globalThis.addEventListener('keydown',keyDown);globalThis.addEventListener('keyup',keyUp);globalThis.addEventListener('blur',blur);
  const visibility=()=>{if(document.visibilityState==='hidden')setPushHeld(false);};document.addEventListener('visibilitychange',visibility);
  function closePeer(id){const entry=peers.get(id);if(!entry)return;entry.pc.ontrack=null;entry.pc.onicecandidate=null;entry.pc.onnegotiationneeded=null;entry.pc.close();entry.audio.pause();entry.audio.srcObject=null;peers.delete(id);}
  function peerFor(id){
    if(peers.has(id))return peers.get(id);
    const pc=new RTCPeerConnection({iceServers:media.voice?.iceServers||[]}),audio=new Audio();audio.autoplay=true;audio.volume=settings.voiceVolume;
    audio.muted=!!isForced(id);
    if(audio.setSinkId&&settings.outputDevice)audio.setSinkId(settings.outputDevice).catch(()=>{});
    const entry={pc,audio,makingOffer:false,ignoreOffer:false,polite:selfId.localeCompare(id)>0,pendingCandidates:[],queue:Promise.resolve()};peers.set(id,entry);
    for(const track of processedStream.getAudioTracks())pc.addTrack(track,processedStream);
    pc.ontrack=event=>{if(event.track.kind!=='audio'){event.track.stop();return;}audio.srcObject=event.streams[0]||new MediaStream([event.track]);safePlay(audio);};
    pc.onicecandidate=event=>{if(event.candidate)void send({action:'signal',target:id,signal:{candidate:event.candidate.toJSON()}}).catch(e=>report(e.message));};
    pc.onnegotiationneeded=async()=>{if(selfId.localeCompare(id)>0)return;try{entry.makingOffer=true;await pc.setLocalDescription();await send({action:'signal',target:id,signal:{description:pc.localDescription.toJSON()}});}catch(e){if(pc.signalingState!=='closed')report(e.message);}finally{entry.makingOffer=false;}};
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')report('Не удалось соединить голос участников. Для разных сетей может потребоваться TURN-сервер; проверьте также VPN и брандмауэр.');onChange();};
    return entry;
  }
  function updatePeers(){
    if(!joined)return;const ids=new Set((media.voice?.participants||[]).map(p=>p.id).filter(id=>id!==selfId));
    for(const id of peers.keys())if(!ids.has(id))closePeer(id);
    for(const id of ids){const entry=peerFor(id);entry.audio.muted=!!isForced(id);}onChange();
  }
  async function signal(event){
    if(!joined||!event||event.from===selfId||!media.voice?.participants?.some(p=>p.id===event.from))return;
    const key=event.id==null?null:String(event.id);if(key&&seenSignals.has(key))return;if(key){seenSignals.add(key);if(seenSignals.size>512)seenSignals.delete(seenSignals.values().next().value);}
    const entry=peerFor(event.from),pc=entry.pc;
    entry.queue=entry.queue.then(async()=>{
      if(pc.signalingState==='closed')return;const {description,candidate}=event.signal||{};
      if(description){
        const collision=description.type==='offer'&&(entry.makingOffer||pc.signalingState!=='stable');entry.ignoreOffer=!entry.polite&&collision;if(entry.ignoreOffer)return;
        await pc.setRemoteDescription(description);for(const queued of entry.pendingCandidates.splice(0))await pc.addIceCandidate(queued);
        if(description.type==='offer'){await pc.setLocalDescription();await send({action:'signal',target:event.from,signal:{description:pc.localDescription.toJSON()}});}
      }else if(candidate){if(!pc.remoteDescription){entry.pendingCandidates.push(candidate);return;}try{await pc.addIceCandidate(candidate);}catch(e){if(!entry.ignoreOffer)throw e;}}
    }).catch(e=>report('Голосовая связь: '+e.message));await entry.queue;
  }
  async function join(){
    if(joined||joining)return;const reason=microphoneUnavailableReason();if(reason){report(reason);return;}
    if(!connected){report('Сначала подключитесь к комнате.');return;}
    const epoch=++voiceEpoch;joining=true;error='';onChange();
    try{
      const captured=await navigator.mediaDevices.getUserMedia({audio:{deviceId:settings.inputDevice?{exact:settings.inputDevice}:undefined,echoCancellation:settings.echoCancellation,noiseSuppression:settings.noiseSuppression,autoGainControl:settings.autoGainControl},video:false});
      if(epoch!==voiceEpoch||destroyed){captured.getTracks().forEach(t=>t.stop());return;}
      stream=captured;audioContext=new (globalThis.AudioContext||globalThis.webkitAudioContext)();await audioContext.resume();
      source=audioContext.createMediaStreamSource(stream);gain=audioContext.createGain();gain.gain.value=settings.gain;analyser=audioContext.createAnalyser();analyser.fftSize=512;
      const destination=audioContext.createMediaStreamDestination();source.connect(gain);gain.connect(analyser);analyser.connect(destination);processedStream=destination.stream;
      for(const track of processedStream.getAudioTracks())track.enabled=false;settings.muted=true;held=false;
      await send({action:'join'});if(epoch!==voiceEpoch||destroyed){await send({action:'leave'}).catch(()=>{});return;}
      joined=true;autoplayBlocked=false;
      const samples=new Float32Array(analyser.fftSize);timer=setInterval(()=>{if(!analyser)return;analyser.getFloatTimeDomainData(samples);level=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);if(level>settings.sensitivity)lastOpen=Date.now();transmit();if(Date.now()-lastUi>150){lastUi=Date.now();onChange();}},60);
      updatePeers();synchronize();for(const track of stream.getTracks())track.onended=()=>{if(joined){report('Микрофон отключён. Подключите его и войдите в голосовую связь снова.');void leave();}};
    }catch(e){report(e.name==='NotAllowedError'?'Доступ к микрофону запрещён. Разрешите его в настройках сайта.':e.name==='NotFoundError'?'Микрофон не найден.':e.name==='OverconstrainedError'?'Выбранный микрофон недоступен. Выберите другое устройство.':'Не удалось включить микрофон: '+e.message);await leave();}
    finally{joining=false;onChange();}
  }
  async function leave(){
    ++voiceEpoch;const wasJoined=joined;joined=false;joining=false;held=false;talking=false;level=0;clearInterval(timer);timer=undefined;
    for(const id of peers.keys())closePeer(id);for(const track of stream?.getTracks()||[]){track.onended=null;track.stop();}for(const track of processedStream?.getTracks()||[])track.stop();
    source?.disconnect();gain?.disconnect();analyser?.disconnect();await audioContext?.close().catch(()=>{});stream=source=gain=analyser=audioContext=processedStream=undefined;seenSignals.clear();
    if(wasJoined)await send({action:'leave'}).catch(()=>{});onChange();
  }
  function update(next,{id=selfId,online=true}={}){
    if(selfId&&id!==selfId)void leave();selfId=id;connected=online;media=next||{playlist:{tracks:[]},voice:{participants:[]}};
    if(isForced(selfId)){settings.muted=true;held=false;}transmit();
    if(!online)void leave();else if(joined&&!media.voice?.participants?.some(p=>p.id===selfId)){void leave();report('Голосовая связь отключена. Войдите снова, когда будете готовы.');}
    synchronize();updatePeers();onChange();
  }
  async function devices(){try{return await navigator.mediaDevices?.enumerateDevices()||[];}catch{return [];}}
  async function diagnostics(){const results=[];for(const [id,entry] of peers){const statistics=await entry.pc.getStats();results.push({id,state:entry.pc.connectionState,audio:[...statistics.values()].filter(s=>['inbound-rtp','outbound-rtp'].includes(s.type)&&s.kind==='audio').map(s=>({type:s.type,packetsSent:s.packetsSent,packetsReceived:s.packetsReceived,bytesSent:s.bytesSent,bytesReceived:s.bytesReceived,packetsLost:s.packetsLost,jitter:s.jitter}))});}return results;}
  function destroy(){if(destroyed)return;void leave();destroyed=true;clearInterval(driftTimer);music.pause();music.removeAttribute('src');music.load();globalThis.removeEventListener('keydown',keyDown);globalThis.removeEventListener('keyup',keyUp);globalThis.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);}
  return {update,signal,join,leave,devices,setSettings,setPushHeld,setPlaybackEnabled,snapshot,diagnostics,destroy};
}
