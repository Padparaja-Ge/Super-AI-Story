import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {type AppState} from './types';
import {Button,Field,Spinner} from './UI';

export function LocalRoomRewrite(){
  const [state,setState]=useState<AppState|null>(null),[request,setRequest]=useState<any>(null),[connectionId,setConnectionId]=useState(''),[text,setText]=useState(''),[result,setResult]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const origin=useRef('');
  useEffect(()=>{
    api<AppState>('/state').then(s=>{setState(s);setConnectionId(s.activeConnectionId);}).catch(e=>setError(e.message));
    const receive=(event:MessageEvent)=>{
      if(event.source!==window.opener||event.data?.type!=='sas-rewrite-request'||origin.current)return;
      if(!/^https?:\/\//.test(event.origin)||typeof event.data.text!=='string'||event.data.text.length>8000)return;
      origin.current=event.origin;setRequest(event.data);setText(event.data.text);
    };
    window.addEventListener('message',receive);window.opener?.postMessage({type:'sas-rewrite-ready'},'*');
    return()=>window.removeEventListener('message',receive);
  },[]);
  return <main className="page local-rewrite-page"><section className="panel"><h1>Улучшение вашей моделью</h1><p className="muted">Запрос выполнит этот SAS через выбранное вами подключение. Ключи остаются здесь. В комнату вернётся только текст после нажатия «Вернуть в черновик».</p>{error&&<p className="error-text" role="alert">{error}</p>}{!request?<p>Ожидаем черновик из комнаты. Откройте это окно кнопкой «Улучшить моей моделью».</p>:<><p>Комната: {request.room?.name} · Персона: {request.persona?.name}</p><Field label="Ваше подключение"><select value={connectionId} disabled={busy} onChange={e=>setConnectionId(e.target.value)}>{state?.connections.filter(c=>c.id!=='sas-embedding').map(c=><option key={c.id} value={c.id}>{c.name} · {c.model||'модель не выбрана'}</option>)}</select></Field><p className="muted small">Настройте модель и ключ в основном окне вашего SAS → «Модели и API».</p><Field label="Исходный черновик"><textarea rows={5} value={text} onChange={e=>setText(e.target.value)} maxLength={8000}/></Field><Button primary disabled={busy||!text.trim()||!state} onClick={async()=>{setBusy(true);setError('');try{const data=await api('/multiplayer/rewrite-draft',{...request,text,connectionId});setResult(data.text);}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>{busy?<Spinner/>:null}Улучшить моей моделью</Button>{result&&<><Field label="Предложенный вариант"><textarea rows={9} value={result} onChange={e=>setResult(e.target.value)}/></Field><Button disabled={busy||!result.trim()||result.length>8000} onClick={()=>{window.opener?.postMessage({type:'sas-rewrite-result',nonce:request.nonce,text:result},origin.current);}}>Вернуть в черновик</Button>{result.length>8000&&<p className="error-text">Сократите вариант до 8000 символов перед вставкой.</p>}</>}</>}</section></main>;
}
