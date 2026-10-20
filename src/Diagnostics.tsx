import {useEffect,useState} from 'react';
import {api} from './api';
import {Button,Field} from './UI';
export function Diagnostics(){
 const [info,setInfo]=useState<any>(null),[entries,setEntries]=useState<any[]>([]),[error,setError]=useState('');
 const load=async()=>{try{const [settings,logs]=await Promise.all([api('/diagnostics'),api('/diagnostics/entries')]);setInfo(settings);setEntries(logs.entries);setError('');}catch(e:any){setError(e.message);}};
 useEffect(()=>{void load();},[]);
 return <section className="diagnostics"><h3>Журнал работы SAS</h3><p className="muted small">Ошибки запросов, запуск и завершение задач. Тексты историй, записи микрофона, API-ключи и коды приглашений в этот журнал не включаются.</p>{info&&<Field label="Папка журналов"><input readOnly value={info.directory}/></Field>}{error&&<p role="alert">{error}</p>}<div className="row"><Button onClick={()=>void load()}>Обновить</Button><a className="btn" href="/api/diagnostics/export" download>Скачать журнал</a></div><div className="diagnostic-entries" style={{maxHeight:360,overflow:'auto'}}>{entries.slice().reverse().map((entry,i)=><p key={i}><time>{new Date(entry.time).toLocaleString()}</time> · {entry.event}{entry.kind?' · '+entry.kind:''}{entry.status?' · HTTP '+entry.status:''}{entry.code?' · '+entry.code:''}</p>)}</div></section>;
}
export function useFrontendDiagnostics(){useEffect(()=>{let last=0;const send=(name:string)=>{if(Date.now()-last<5000)return;last=Date.now();void api('/diagnostics/frontend',{name}).catch(()=>{});};const error=(e:ErrorEvent)=>send(e.error?.name||'Error'),rejection=()=>send('UnhandledRejection');window.addEventListener('error',error);window.addEventListener('unhandledrejection',rejection);return()=>{window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',rejection);};},[]);}
