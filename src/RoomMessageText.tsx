import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Button,TextContent} from './UI';
// Display translations stay in this view; canonical room messages remain intact.
const cache=new Map<string,string>();let active=0;const waiting:(()=>void)[]=[];
async function translate(key:string,payload:any){if(cache.has(key))return cache.get(key)!;if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));else active++;try{const result=await api('/translate',payload);const text=String(result.translation||result.text||'');if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(key,text);return text;}finally{if(waiting.length)waiting.shift()?.();else active--;}}
export function RoomMessageText({message,settings,automatic=false,generating=false}:{message:any;settings:any;automatic?:boolean;generating?:boolean}){
 const [translation,setTranslation]=useState(''),[original,setOriginal]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),mounted=useRef(true),autoKey=useRef('');
 const text=message.content||'',target=settings?.displayLanguage||'ru',source='auto',provider=settings?.provider||'yandex',key=JSON.stringify([provider,target,text]),canTranslate=!!text.trim()&&message.kind!=='image'&&message.kind!=='dice';
 const currentKey=useRef(key),requestId=useRef(0);currentKey.current=key;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{requestId.current++;setBusy(false);setTranslation(cache.get(key)||'');setOriginal(false);setError('');},[key]);
 const request=async()=>{if(!canTranslate||busy)return;const id=++requestId.current;setBusy(true);setError('');try{const result=await translate(key,{text,sourceLang:source,targetLang:target,provider});if(mounted.current&&currentKey.current===key&&requestId.current===id){setTranslation(result);setOriginal(false);}}catch(e:any){if(mounted.current&&currentKey.current===key&&requestId.current===id)setError(e.message);}finally{if(mounted.current&&requestId.current===id)setBusy(false);}};
 useEffect(()=>{if(!busy&&automatic&&settings?.enabled&&settings?.incoming&&message.role==='assistant'&&!generating&&canTranslate&&autoKey.current!==key){autoKey.current=key;void request();}},[key,automatic,generating,busy,settings?.enabled,settings?.incoming]);
 return <><TextContent text={translation&&!original?translation:text}/>{canTranslate&&<div className="room-translation-tools">{translation?<Button onClick={()=>setOriginal(!original)}>{original?'Перевод':'Оригинал'}</Button>:<Button disabled={busy||generating} onClick={()=>void request()}>{busy?'Переводится…':'Перевести'}</Button>}{error&&<small className="error-text" role="status">Перевод: {error}</small>}</div>}</>;
}
