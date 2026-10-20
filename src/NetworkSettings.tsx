import {useEffect,useState} from 'react';
import {api} from './api';
import {Button,Field,Spinner} from './UI';
export function NetworkSettings({notify}:{notify:(message:string,error?:boolean)=>void}){
  const [data,setData]=useState<any>(null),[draft,setDraft]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[relocated,setRelocated]=useState(false);
  const toDraft=(next:any)=>({...next.config,mode:next.config.mode||'allowlist',allowlist:next.config.allowlist.join('\n'),blocklist:next.config.blocklist.join('\n')});
  useEffect(()=>{if(relocated)return;let live=true;const read=async()=>{try{const next=await api('/network');if(live){setData(next);setDraft((old:any)=>old||toDraft(next));setError('');}}catch(e:any){if(live)setError(e.message);}};void read();const timer=setInterval(read,5000);return()=>{live=false;clearInterval(timer);};},[relocated]);
  if(!draft)return <>{error?<p className="error-text">{error}</p>:<Spinner/>}</>;
  const patch=(key:string,value:any)=>setDraft({...draft,[key]:value});
  return <><h3>Веб-сервер и сеть</h3>
    {(error||data.error)&&<p className="error-text">{error||data.error}</p>}
    <div className="form-grid"><Field label="Адрес прослушивания"><input value={draft.host} onChange={e=>patch('host',e.target.value)} list="network-bind-addresses"/><datalist id="network-bind-addresses"><option value="0.0.0.0"/><option value="127.0.0.1"/>{data.interfaces?.filter((a:any)=>a.address.includes('.')).map((a:any)=><option key={a.name+a.address} value={a.address}>{a.name}</option>)}</datalist></Field><Field label="Порт HTTP"><input type="number" min={1} max={65535} value={draft.port} onChange={e=>patch('port',Number(e.target.value))}/></Field></div>
    <Field label="Ключ доступа" hint="Пустое поле — вход без ключа."><input type="password" autoComplete="new-password" maxLength={256} value={draft.accessKey||''} onChange={e=>patch('accessKey',e.target.value)}/></Field>
    <Field label="Режим доступа"><select value={draft.mode} onChange={e=>patch('mode',e.target.value)}><option value="allowlist">Белый список</option><option value="blocklist">Чёрный список</option></select></Field>
    <Field label={draft.mode==='allowlist'?'Белый список':'Чёрный список'}><textarea rows={6} placeholder={'127.0.0.1\n192.168.1.0/24'} value={draft[draft.mode]} onChange={e=>patch(draft.mode,e.target.value)}/></Field>
    <Button primary disabled={busy} onClick={async()=>{setBusy(true);setError('');try{
      const next=await api('/network',{...draft,allowlist:draft.allowlist.split(/\r?\n/).map((s:string)=>s.trim()).filter(Boolean),blocklist:draft.blocklist.split(/\r?\n/).map((s:string)=>s.trim()).filter(Boolean)},'PUT');
      setData(next);setDraft(toDraft(next));if(!next.runtime?.desktop&&(String(next.runtime?.port)!==(location.port||'80')||!['0.0.0.0','::','localhost',location.hostname].includes(next.runtime?.host)))setRelocated(true);
      notify(next.runtime?.desktop?'Настройки сохранены для отдельного веб-сервера.':'Настройки применены к работающему веб-серверу.');
    }catch(e:any){setError(e.message);}finally{setBusy(false);}}}>{busy?<Spinner/>:null}Сохранить и применить</Button>
    {relocated&&<p>Адрес сервера изменён. Откройте один из адресов ниже.</p>}
    {data.runtime?.desktop?<p className="muted small">Это настольное окно. Отдельный веб-сервер запускается файлом Start-SAS-Web.cmd; путь его конфигурации должен совпадать с указанным ниже.</p>:data.runtime&&<><h3>Веб-сервер работает</h3><p>{data.runtime.host}:{data.runtime.port}</p><div className="network-addresses">{data.runtime.urls?.map((a:any)=><p key={a.name+a.url}><span>{a.name} — </span><a href={a.url} target="_blank" rel="noreferrer">{a.url}</a></p>)}</div></>}
    <Field label="Файл настроек"><input readOnly value={data.file}/></Field>
    <h3>Подключения к веб-серверу</h3><div className="network-addresses"><table><thead><tr><th>IP</th><th>Доступ</th><th>Последний запрос</th></tr></thead><tbody>{data.clients.map((c:any)=><tr key={c.ip}><td>{c.ip}</td><td>{c.allowed?'Разрешён':'Запрещён'}</td><td>{new Date(c.lastSeen).toLocaleString()}</td></tr>)}</tbody></table></div>
  </>;
}
