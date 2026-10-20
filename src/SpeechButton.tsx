import {useSyncExternalStore} from 'react';
import {Volume2,Square} from 'lucide-react';
import {IconButton} from './UI';
import {playSpeech,speechSubscribe,speechSnapshot} from './speechPlayer';
export function SpeechButton({id,text,settings,notify}:{id:string;text:string;settings?:Record<string,any>;notify:(message:string,error?:boolean)=>void}){
 const progress=useSyncExternalStore(speechSubscribe,speechSnapshot,speechSnapshot),active=progress.key===id&&progress.phase!=='idle';
 return <span className="speech-control"><IconButton title={active?'Остановить озвучку':'Озвучить текст'} onClick={()=>void playSpeech(id,text,settings).catch(e=>notify(e.message,true))}>{active?<Square size={14}/>:<Volume2 size={14}/>}</IconButton>{active&&<small role="status">{progress.phase==='preparing'?'Готовлю':'Читаю'} {progress.index}/{progress.count||'…'}</small>}</span>;
}
