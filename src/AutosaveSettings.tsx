import {useEffect,useRef,useState} from 'react';
import {api,downloadJSON} from './api';
import {Button,Field,Toggle} from './UI';
const publishStatus=(value:any)=>{window.dispatchEvent(new CustomEvent('sas:autosave-status',{detail:value}));return value;};
export function AutosaveSettings({flush,notify,task}:any){
 const [value,setValue]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void api('/autosave').then(setValue).catch(e=>setError(e.message));},[]);
 const disabled=busy||task?.status==='running';
 const apply=async(patch:any)=>{setBusy(true);try{await flush();setValue(publishStatus(await api('/autosave',patch,'PUT')));setError('');notify('Режим сохранения изменён.');}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 const save=async()=>{setBusy(true);try{await flush();setValue(publishStatus(await api('/autosave/save',{})));setError('');notify('Сессия сохранена на диск.');}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 return <section><h3>Автосохранение сессии</h3>{error&&<p className="error-box" role="alert">{error}</p>}{value&&<>
  <Field label="Автоматически записывать изменения на диск"><Toggle disabled={disabled} label="Автосохранение сессии" checked={value.enabled} onChange={enabled=>void apply({enabled})}/></Field>
  <p className="muted small">{value.enabled?'Изменения записываются по выбранному расписанию.':'Изменения остаются только в памяти работающего SAS до ручного сохранения. Автоматические резервы партий также приостановлены.'}</p>
  <fieldset disabled={disabled||!value.enabled}>
   <Field label="Интервал, секунд · 0 — сразу"><input type="number" min={0} max={3600} value={value.intervalSeconds} onChange={e=>setValue({...value,intervalSeconds:Number(e.target.value)})}/></Field>
   <Field label="Сохранять после завершения генерации"><Toggle label="Сохранение после генерации" checked={value.onTaskComplete} onChange={onTaskComplete=>setValue({...value,onTaskComplete})}/></Field>
   <Field label="Сохранять при штатном закрытии"><Toggle label="Сохранение при закрытии" checked={value.onClose} onChange={onClose=>setValue({...value,onClose})}/></Field>
   <Button onClick={()=>void apply(value)}>Применить расписание</Button>
  </fieldset>
  <Field label="Файл рабочего состояния"><input readOnly value={value.file}/></Field>
  <p className="muted small">Последнее сохранение: {value.lastSavedAt?new Date(value.lastSavedAt).toLocaleString():'ещё не создавалось'}{value.dirty?' · есть изменения в памяти':''}</p>
  <div className="row"><Button primary disabled={disabled} onClick={()=>void save()}>Сохранить вручную</Button><Button disabled={disabled} onClick={async()=>{try{await flush();downloadJSON(await api('/autosave/export'),'SAS-session.json');}catch(e:any){setError(e.message);}}}>Скачать копию сессии</Button></div>
 </>}</section>;
}
export function AutosaveIndicator({flush,notify}:any){
 const [value,setValue]=useState<any>(null),[busy,setBusy]=useState(false);
 const statusRef=useRef<any>(null);
 const accept=(next:any)=>{statusRef.current=next;setValue(next);};
 useEffect(()=>{let stopped=false,version=0;const load=()=>{const requestVersion=version;void api('/autosave').then(next=>{if(!stopped&&requestVersion===version)accept(next);}).catch(()=>{});};const changed=(event:Event)=>{version++;accept((event as CustomEvent).detail);};window.addEventListener('sas:autosave-status',changed);load();const timer=setInterval(load,2000);return()=>{stopped=true;clearInterval(timer);window.removeEventListener('sas:autosave-status',changed);};},[]);
 useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{let rendererDirty=false;window.dispatchEvent(new CustomEvent('sas:renderer-dirty',{detail:{resolve:(dirty:boolean)=>{rendererDirty=dirty;}}}));if(rendererDirty||statusRef.current?.dirty&&statusRef.current?.enabled!==true){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[]);
 if(!value)return null;
 return <button className={'btn autosave-status '+(value.dirty?'unsaved':'')} disabled={busy} title={value.enabled?'Сохранить все текущие изменения':'Автосохранение выключено. Записать текущую сессию на диск.'} onClick={async()=>{setBusy(true);try{await flush();const next=await api('/autosave/save',{});accept(next);publishStatus(next);notify('Сессия сохранена на диск.');}catch(e:any){notify(e.message,true);}finally{setBusy(false);}}}>{busy?'Сохраняется…':value.dirty?'Сохранить вручную':value.enabled?'На диске':'Авто выкл. · сохранить'}</button>;
}
