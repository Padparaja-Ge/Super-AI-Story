import {speechSettings,speechSentences,speechText} from '../shared/speech.mjs';
type Progress={key:string;phase:string;index:number;count:number};
let progress:Progress={key:'',phase:'idle',index:0,count:0},controller:AbortController|null=null,source:AudioBufferSourceNode|null=null,context:AudioContext|null=null,sessionId='',epoch=0;
const listeners=new Set<()=>void>();
const report=(next:Progress)=>{progress=next;listeners.forEach(fn=>fn());};
export const speechSubscribe=(fn:()=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);};
export const speechSnapshot=()=>progress;
export function stopSpeech(){epoch++;controller?.abort();controller=null;source?.stop();source=null;window.speechSynthesis?.cancel();if(sessionId){void fetch('/api/speech/sessions/'+sessionId,{method:'DELETE',headers:{'X-SAS-Client':'desktop'}}).catch(()=>{});sessionId='';}report({key:'',phase:'idle',index:0,count:0});}
async function api(path:string,body:unknown,signal:AbortSignal){const r=await fetch('/api/speech'+path,{method:'POST',headers:{'Content-Type':'application/json','X-SAS-Client':'desktop'},body:JSON.stringify(body),signal});const d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка озвучки.');return d;}
export async function playSpeech(key:string,text:string,value:Record<string,any>|undefined){
 if(progress.key===key&&progress.phase!=='idle'){stopSpeech();return;}
 stopSpeech();const settings=speechSettings(value),token=epoch,abort=new AbortController();controller=abort;
 const check=()=>{abort.signal.throwIfAborted();if(token!==epoch)throw new DOMException('Stopped','AbortError');};
 report({key,phase:'preparing',index:0,count:0});
 try{
  if(settings.provider==='system'){
   if(!('speechSynthesis' in window))throw new Error('Системная озвучка недоступна.');const sentences=speechSentences(speechText(text,settings.pronunciations),settings.maxSentenceChars,settings.language);
   for(let i=0;i<sentences.length;i++){check();report({key,phase:'playing',index:i+1,count:sentences.length});await new Promise<void>((resolve,reject)=>{const utterance=new SpeechSynthesisUtterance(sentences[i]);utterance.lang=settings.language==='auto'?(/[А-Яа-яЁё]/.test(sentences[i])?'ru-RU':'en-US'):settings.language;utterance.rate=settings.custom.speed;utterance.volume=settings.volume;utterance.onend=()=>{abort.signal.removeEventListener('abort',cancel);resolve();};utterance.onerror=()=>{abort.signal.removeEventListener('abort',cancel);reject(new Error('Системный голос не смог озвучить текст.'));};const cancel=()=>reject(new DOMException('Stopped','AbortError'));abort.signal.addEventListener('abort',cancel,{once:true});window.speechSynthesis.speak(utterance);});}
  }else{
   // Resume during the click gesture, before network waits (mobile autoplay).
   context||=new AudioContext();await context.resume();check();const requestedId=globalThis.crypto.randomUUID?.()||'speech-'+Date.now()+'-'+Math.random().toString(36).slice(2);sessionId=requestedId;const session=await api('/sessions',{id:requestedId,text,settings},abort.signal);if(token!==epoch||abort.signal.aborted){void fetch('/api/speech/sessions/'+session.id,{method:'DELETE',headers:{'X-SAS-Client':'desktop'}}).catch(()=>{});check();}sessionId=session.id;
   const phrase=async(index:number)=>{try{const r=await fetch(`/api/speech/sessions/${session.id}/${index}`,{signal:abort.signal});if(!r.ok){const data=await r.json();throw new Error(data.error||'Ошибка генерации голоса.');}return {bytes:await r.arrayBuffer()};}catch(error){return {error};}};
   let pending=phrase(0);
   for(let i=0;i<session.count;i++){
    report({key,phase:'preparing',index:i+1,count:session.count});const result=await pending;check();if('error' in result)throw result.error;
    // Exactly one future phrase: no unbounded synthesis of an entire novel.
    if(i+1<session.count)pending=phrase(i+1);
    const buffer=await context.decodeAudioData(result.bytes!);check();const audio=context.createBufferSource(),gain=context.createGain();gain.gain.value=settings.volume;audio.buffer=buffer;audio.connect(gain);gain.connect(context.destination);source=audio;
    report({key,phase:'playing',index:i+1,count:session.count});await new Promise<void>((resolve,reject)=>{const cancel=()=>{audio.stop();reject(new DOMException('Stopped','AbortError'));};abort.signal.addEventListener('abort',cancel,{once:true});audio.onended=()=>{abort.signal.removeEventListener('abort',cancel);audio.disconnect();gain.disconnect();resolve();};audio.start();});source=null;check();
    if(settings.pauseMs&&i+1<session.count)await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));},timer=setTimeout(()=>{abort.signal.removeEventListener('abort',cancel);resolve();},settings.pauseMs);abort.signal.addEventListener('abort',cancel,{once:true});});
   }
  }
 }catch(error:any){if(!abort.signal.aborted&&token===epoch)throw error;}
 finally{if(token===epoch)stopSpeech();}
}
