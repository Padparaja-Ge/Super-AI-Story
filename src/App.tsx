import {FanficView} from './Fanfic';
import {StorybooksView} from './Storybooks';
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, UsersRound, BookOpen, Brain, Cpu, Puzzle, Radio, Settings2, Plus, Search, Orbit, PanelLeftClose, PanelLeftOpen, Check, AlertCircle, X, ChevronRight, ExternalLink } from 'lucide-react';
import { api } from './api';
import { type AppState, type View, type StudioProps, uid } from './types';
import { Avatar, Button, IconButton, Spinner } from './UI';
import {WizardView} from './Wizard';
import { PersonasView } from './Personas';
import { AppearanceView, applyAppearance } from './Appearance';
import { type GenerationTask } from './types';
import { ChatView } from './Chat';
import { CharactersView, LoreView, MemoryView, SettingsView } from './Studio';
import { ModelsView } from './Models';
import { PluginsView } from './Plugins';
import { TechnicalSettings } from './TechnicalSettings';
import { MultiplayerView } from './Multiplayer';

import {ExtensionPage,ExtensionSlot,extensionRuntime,useExtensions} from './extensionRuntime';
import './extensions.css';
import {BeginnerGuide,openBeginnerGuide,flushGuidePreferences} from './BeginnerGuide';
import {CircleHelp} from 'lucide-react';
import {useFrontendDiagnostics} from './Diagnostics';
import {AutosaveIndicator} from './AutosaveSettings';
const navigation = [{id:'fanfic',label:'Фанфик',icon:BookOpen},{id:'chat',label:'Истории',icon:MessageSquare},{id:'characters',label:'Персонажи',icon:UsersRound},{id:'personas',label:'Персоны',icon:UsersRound},{id:'wizard',label:'AI-мастер',icon:Orbit},{id:'lore',label:'Лорбуки',icon:BookOpen},{id:'storybooks',label:'Story books',icon:BookOpen},{id:'memory',label:'Память',icon:Brain},{id:'plugins',label:'Расширения',icon:Puzzle},{id:'multiplayer',label:'Мультиплеер',icon:Radio},{id:'technical',label:'Настройки',icon:Settings2}] as const;

export default function App() {
  useFrontendDiagnostics();
  const [state, setState] = useState<AppState|null>(null), stateRef = useRef<AppState|null>(null);
  const [view,setView] = useState<View>(window.location.hash.startsWith('#join-room=')?'multiplayer':'chat'), [chatId,setChatId] = useState('chat-first');
  const [toast,setToast] = useState<{message:string;error:boolean}|null>(null), [saveStatus,setSaveStatus] = useState('Сохранено локально');
  const [loadError,setLoadError] = useState(''), [collapsed,setCollapsed] = useState(window.innerWidth<800), [query,setQuery] = useState('');
  const extensions=useExtensions();
  useEffect(()=>state?extensionRuntime.start():undefined,[!!state]);
  const [cardId,setCardId]=useState('');
  const [task,setTask]=useState<GenerationTask|null>(null);
  const taskRef=useRef<GenerationTask|null>(null), saving=useRef(0), seenTask=useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>|null>(null), queue = useRef(Promise.resolve()), dirty = useRef(false);
  const notify = (message:string,error=false) => setToast({message,error});
  const refresh = async () => {const next = await api<AppState>('/state'); if(!stateRef.current||next.revision>=stateRef.current.revision){stateRef.current=next; setState(next);}};
  useEffect(() => {refresh().catch(e=>setLoadError(e.message));},[]);
  useEffect(()=>{const accept=(event:Event)=>{const next=(event as CustomEvent<GenerationTask>).detail;taskRef.current=next;setTask(next);};window.addEventListener('sas-task',accept);return()=>window.removeEventListener('sas-task',accept);},[]);
  useEffect(()=>{applyAppearance(state?.settings.appearance);},[state?.settings.appearance]);
  useEffect(()=>{
    let cancelled=false,timeout:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{
      const data=await api('/tasks/current'); if(cancelled)return;
      taskRef.current=data.task;setTask(data.task);
      if(data.task && data.task.status!=='running' && seenTask.current!==data.task.id){
        seenTask.current=data.task.id;
        if(data.task.kind==='chat'&&!data.task.inputSaved&&data.task.userContent&&data.task.chatId){const key='sas-draft-'+data.task.chatId;if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,data.task.userContent);window.dispatchEvent(new CustomEvent('sas-draft',{detail:data.task.chatId}));}}
        if(data.task.status==='error')notify(data.task.error,true);
        else if(data.task.status==='stopped')notify('Генерация остановлена. Полученный текст сохранён.');
        if(data.task.warnings?.length)notify(data.task.warnings.join(' '),true);
      }
      if(!dirty.current&&!saving.current&&stateRef.current?.revision!==data.revision)await refresh();
    }catch{}finally{if(!cancelled)timeout=setTimeout(poll,650);}};
    void poll();return()=>{cancelled=true;clearTimeout(timeout);};
  },[]);
  useEffect(() => {if(toast){const t=setTimeout(()=>setToast(null),6500);return ()=>clearTimeout(t);}},[toast]);
  const flush = async () => {
    if(timer.current) clearTimeout(timer.current);
    if(dirty.current && stateRef.current){
      const snapshot = structuredClone(stateRef.current); dirty.current=false;
      saving.current++;
      queue.current = queue.current.catch(()=>{}).then(async()=>{
        snapshot.revision=stateRef.current?.revision || snapshot.revision;
        const saved=await api<AppState>('/state',snapshot,'PUT');
        if(stateRef.current){stateRef.current.revision=saved.revision;}
        setSaveStatus('Сохранено локально');
      }).catch(async e=>{dirty.current=false;setSaveStatus('Правка не сохранена');notify(e.message,true);await refresh();throw e;}).finally(()=>{saving.current--;});
    }
    await queue.current;
  };
  useEffect(()=>{
    const prepare=(event:Event)=>{const callbacks=(event as CustomEvent<{resolve:()=>void;reject:(reason:Error)=>void}>).detail;if(callbacks&&typeof callbacks.resolve==='function'&&typeof callbacks.reject==='function')void flush().then(()=>flushGuidePreferences()).then(callbacks.resolve,callbacks.reject);};
    window.addEventListener('sas:prepare-close',prepare);
    return()=>window.removeEventListener('sas:prepare-close',prepare);
  },[]);
  useEffect(()=>{
    const query=(event:Event)=>{const resolve=(event as CustomEvent<{resolve:(value:boolean)=>void}>).detail?.resolve;if(typeof resolve==='function')resolve(dirty.current||saving.current>0);};
    window.addEventListener('sas:renderer-dirty',query);
    return()=>window.removeEventListener('sas:renderer-dirty',query);
  },[]);
  const update: StudioProps['update'] = (fn) => {
    if(taskRef.current?.status==='running'){notify('Дождитесь генерации или остановите её перед изменением настроек.');return;}
    if(!stateRef.current) return;
    const next = structuredClone(stateRef.current); fn(next); stateRef.current=next;setState(next);dirty.current=true;setSaveStatus('Сохраняем…');
    if(timer.current)clearTimeout(timer.current); timer.current=setTimeout(()=>{flush().catch(()=>{});},450);
  };
  const navigate = (v:View,characterId?:string) => {if(v==='characters')setCardId(characterId||'');setView(v); if(window.innerWidth<800)setCollapsed(true);};
  useEffect(()=>{extensionRuntime.bind({view,chatId,task,update,flush,navigate,notify});},[view,chatId,task]);
  useEffect(()=>{if(state)extensionRuntime.emit('stateChanged',{revision:state.revision});},[state?.revision]);
  const newChat = (characterId?:string) => {
    if(taskRef.current?.status==='running'){notify('Сначала дождитесь текущей генерации.');return;}
    if(!state) return; const character=state.characters.find(c=>c.id===characterId)||state.characters[0];
    if(!character){navigate('characters');return;}
    const id=uid();update(s=>{s.chats.unshift({id,title:character.name,characterId:character.id,personaId:String(character.personaId||''),scene:{location:'',time:'',weather:'',notes:'',stats:[],autoUpdate:true},memorySettings:{memoryMode:state.settings.memoryMode,historyLimit:state.settings.historyLimit,loreBudget:state.settings.loreBudget,scanDepth:state.settings.scanDepth},messages:character.firstMessage?[{id:uid(),role:'assistant',content:character.firstMessage,createdAt:new Date().toISOString()}]:[],summary:'',memory:[],createdAt:new Date().toISOString()});});setChatId(id);navigate('chat');
  };
  if(!state) return <div className="boot"><Orbit size={46}/><h1>Super AI Story</h1>{loadError?<><p>{loadError}</p><Button primary onClick={()=>{setLoadError('');refresh().catch(e=>setLoadError(e.message));}}>Повторить подключение</Button></>:<><Spinner/><p>Открываем вашу студию…</p></>}</div>;
  const props: StudioProps={state,update,refresh,flush,notify,task};
  const activeConnection=state.connections.find(c=>c.id===state.activeConnectionId);
  const roomTask=!!task&&['multiplayer','room-summary','battlemap'].includes(task.kind);
  const chat=state.chats.find(c=>c.id===chatId)||state.chats[0];
  const character=state.characters.find(c=>c.id===chat?.characterId);
  return <div className={`app ${collapsed?'sidebar-collapsed':''}`}>
    {!collapsed&&<button className="sidebar-backdrop" aria-label="Закрыть меню" onClick={()=>setCollapsed(true)}/>}
    <aside className="sidebar" onKeyDown={e=>{if(e.key==='Escape')setCollapsed(true);}}>
      <button className="brand" onClick={()=>navigate('chat')}><span className="brand-icon"><img src="/brand/sas-symbol.png" alt="Логотип SAS"/></span><span className="brand-copy"><strong>SAS<span className="brand-dot">.</span></strong><small>SUPER AI STORY</small></span><span className="version">α</span></button>
      <Button primary className="new-story" onClick={()=>newChat()}><Plus size={18}/><span>Новая история</span></Button>
      <div className="nav-caption">ВАША СТУДИЯ</div>
      <nav>{navigation.map(item=><button title={item.label} key={item.id} className={`nav-item ${view===item.id||item.id==='technical'&&['models','appearance'].includes(view)?'active':''}`} onClick={()=>navigate(item.id)}><item.icon size={19}/><span>{item.label}</span>{item.id==='multiplayer'&&<span className="nav-badge">LAN</span>}</button>)}{extensions.pages.map(page=><button title={page.title} key={page.key} className={'nav-item '+(view==='extension:'+page.key?'active':'')} onClick={()=>navigate(('extension:'+page.key) as View)}><Puzzle size={19}/><span>{page.title}</span></button>)}</nav><ExtensionSlot name="sidebar"/>
      <div className="recent-header"><span>НЕДАВНИЕ ИСТОРИИ</span><span>{state.chats.length}</span></div>
      <label className="sidebar-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Найти историю…" aria-label="Найти историю"/></label>
      <div className="recent-list">{state.chats.filter(c=>c.title.toLowerCase().includes(query.toLowerCase())).map(c=><button key={c.id} className={`recent-item ${view==='chat'&&c.id===chat?.id?'selected':''}`} onClick={()=>{setChatId(c.id);navigate('chat');}}><span className="recent-dot"/><span>{c.title}</span></button>)}</div>
      <div className="sidebar-bottom"><button className={`nav-item ${view==='settings'?'active':''}`} onClick={()=>navigate('settings')}><Settings2 size={18}/><span>Настройки студии</span></button><div className="user-card"><div className="user-monogram">{state.settings.userName.charAt(0)}</div><div><strong>{state.settings.userName}</strong><small><span className="status-dot"/>Локальное пространство</small></div><IconButton title="Свернуть меню" onClick={()=>setCollapsed(true)}><PanelLeftClose size={17}/></IconButton></div></div>
    </aside>
    <div className="main-area"><header className="topbar"><div className="breadcrumb">{collapsed&&<IconButton title="Открыть меню" onClick={()=>setCollapsed(false)}><PanelLeftOpen size={20}/></IconButton>}<span>Студия</span><ChevronRight size={14}/><strong>{view==='settings'?'Настройки студии':view==='models'?'Модели и API':view==='appearance'?'Внешний вид':navigation.find(n=>n.id===view)?.label||extensions.pages.find(p=>'extension:'+p.key===view)?.title}</strong></div><div className="topbar-right"><button type="button" className="topbar-guide" title="Первые шаги в SAS" aria-label="Открыть обучение" onClick={openBeginnerGuide}><CircleHelp size={18}/></button><ExtensionSlot name="topbar"/><AutosaveIndicator flush={flush} notify={notify}/>{saveStatus==='Правка не сохранена'&&<span className="save-status error-text" role="status">{saveStatus}</span>}<button className="connection-pill" onClick={()=>navigate('models')}><span className={`status-dot ${activeConnection?.model?'configured':'offline'}`}/><span>{activeConnection?.model?activeConnection.model:'Модель не выбрана'}</span><ChevronRight size={14}/></button></div></header>
    <ExtensionSlot name="workspace-top"/>{view.startsWith('extension:')&&<ExtensionPage view={view}/>}
    {task?.status==='running'&&<div className="generation-bar" role="status"><Spinner/><button onClick={()=>{if(task.fanficProjectId){localStorage.setItem('sas-fanfic-project',task.fanficProjectId);localStorage.setItem('sas-fanfic-episode',task.episodeId||'');navigate('fanfic');window.dispatchEvent(new CustomEvent('sas-fanfic-open',{detail:{projectId:task.fanficProjectId,episodeId:task.episodeId}}));}else if(task.kind==='wizard')navigate('wizard');else if(roomTask)navigate('multiplayer');else if(task.chatId){setChatId(task.chatId);navigate('chat');}}}>{task.stage} · {state.fanficProjects.find(p=>p.id===task.fanficProjectId)?.title||state.chats.find(c=>c.id===task.chatId)?.title||(roomTask?'Мультиплеер':'Студия')}</button><span>Генерация продолжается при смене вкладки</span><Button onClick={()=>api('/tasks/stop',{}).catch(e=>notify(e.message,true))}>Остановить</Button></div>}
    {view==='fanfic'&&<FanficView {...props}/>}
    {view==='wizard'&&<WizardView {...props}/>}
    {view==='chat'&&<ChatView {...props} chat={chat} character={character} onNewChat={newChat} onSelectChat={setChatId} navigate={navigate}/>}
    {view==='characters'&&<CharactersView {...props} key={cardId} initialCharacterId={cardId} onStart={newChat}/>}
    {view==='personas'&&<PersonasView {...props}/>}
    {view==='appearance'&&<AppearanceView {...props} onBack={()=>navigate('technical')}/>}
    {view==='lore'&&<LoreView {...props}/>}
    {view==='memory'&&<MemoryView {...props} chat={chat} onSelectChat={setChatId}/>}
    {view==='models'&&<ModelsView {...props} onBack={()=>navigate('technical')}/>}
    {view==='plugins'&&<PluginsView {...props}/>}
    {view==='storybooks'&&<StorybooksView {...props}/>}{view==='multiplayer'&&<MultiplayerView {...props}/>}
    {view==='technical'&&<TechnicalSettings {...props} navigate={navigate}/>}
    {view==='settings'&&<SettingsView {...props} chat={chat} onSelectChat={setChatId}/>}{['settings','technical'].includes(view)&&<ExtensionSlot name="settings"/>}<ExtensionSlot name="workspace-bottom"/>
    </div>
    {toast&&<div className={`toast ${toast.error?'toast-error':''}`} role="status">{toast.error?<AlertCircle size={19}/>:<Check size={19}/>}<span>{toast.message}</span><IconButton title="Скрыть уведомление" onClick={()=>setToast(null)}><X size={16}/></IconButton></div>}
    <BeginnerGuide busy={task?.status==='running'} navigate={navigate}/>
  </div>;
}
