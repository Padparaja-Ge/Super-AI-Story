import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {BookOpen,Check,ChevronLeft,ChevronRight,Compass,ExternalLink,Lightbulb,Sparkles,X} from 'lucide-react';
import {GUIDE_STEPS,GUIDE_STORAGE_KEY,readGuidePreferences,writeGuidePreferences,type GuidePreferences} from '../shared/onboarding.mjs';
import {Button,IconButton,Modal,Toggle} from './UI';
import {type View} from './types';
import './beginner-guide.css';
import {api} from './api';

const deviceStorage={getItem(key:string){try{return window.localStorage.getItem(key);}catch{return null;}},setItem(key:string,value:string){try{window.localStorage.setItem(key,value);}catch{}}};
let preferences=readGuidePreferences(deviceStorage);
let ready=false,loading:Promise<void>|undefined,pending=Promise.resolve(),preferenceError='';
const listeners=new Set<()=>void>();
const changed=()=>{for(const listener of listeners)listener();};
function ensurePreferences(){return loading||=(async()=>{try{const saved=await api('/onboarding');if(saved.preferences)preferences=writeGuidePreferences(deviceStorage,saved.preferences);else await api('/onboarding',preferences,'PUT');ready=true;preferenceError='';}catch{loading=undefined;preferenceError='Не удалось прочитать настройки обучения. Проверьте подключение к SAS.';}changed();})();}
function patchPreferences(patch:Partial<GuidePreferences>){preferences=writeGuidePreferences(deviceStorage,{...preferences,...patch});const snapshot={...preferences};pending=pending.catch(()=>{}).then(async()=>{await api('/onboarding',snapshot,'PUT');preferenceError='';changed();});void pending.catch(()=>{preferenceError='Не удалось сохранить настройку обучения. Повторите изменение после восстановления соединения.';changed();});changed();}
export async function flushGuidePreferences(){await loading;await pending;}
function usePreferences(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>preferences);}
function useGuideStatus(){const status=useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>`${ready}:${preferenceError}`);useEffect(()=>{void ensurePreferences();},[]);return {ready:status.startsWith('true:'),error:status.slice(status.indexOf(':')+1)};}
export function openBeginnerGuide(){window.dispatchEvent(new Event('sas:open-beginner-guide'));}

export function BeginnerGuideSettings(){
  const prefs=usePreferences(),status=useGuideStatus();
  return <div className="beginner-settings"><div className="beginner-settings-symbol"><Compass size={30}/></div><div><h3>Первые шаги в SAS</h3><p>Шесть коротких шагов: модель, герои, память, Фанфик, совместная игра и расширения. Настройки и истории останутся на своих местах.</p></div>{status.error&&<p className="error-text" role="alert">{status.error}</p>}<label className="setting-toggle"><span>Предлагать обучение на этом устройстве</span><Toggle disabled={!status.ready} checked={prefs.enabled} label="Предлагать обучение на этом устройстве" onChange={enabled=>{if(status.ready)patchPreferences({enabled,welcomed:enabled?false:prefs.welcomed});}}/></label><div className="row"><Button primary onClick={openBeginnerGuide}><BookOpen size={16}/>{prefs.completed?'Повторить обучение':'Открыть обучение'}</Button><small className="muted">{prefs.completed?'Обучение пройдено':`Шаг ${prefs.step+1} из ${GUIDE_STEPS.length}`} · можно закрыть в любой момент</small></div></div>;
}

export function BeginnerGuide({busy,navigate}:{busy:boolean;navigate:(view:View)=>void}){
  const prefs=usePreferences(),status=useGuideStatus(),[opened,setOpened]=useState(false),[step,setStep]=useState(prefs.step);
  const [welcomeHidden,setWelcomeHidden]=useState(false),heading=useRef<HTMLHeadingElement>(null),wasOpened=useRef(false);
  useEffect(()=>{const open=async()=>{await ensurePreferences();if(!ready)return;setStep(preferences.completed?0:preferences.step);patchPreferences({welcomed:true});setOpened(true);};const storage=(event:StorageEvent)=>{if(event.key===GUIDE_STORAGE_KEY){preferences=readGuidePreferences(deviceStorage);changed();}};window.addEventListener('sas:open-beginner-guide',open);window.addEventListener('storage',storage);return()=>{window.removeEventListener('sas:open-beginner-guide',open);window.removeEventListener('storage',storage);};},[]);
  useEffect(()=>{if(opened&&wasOpened.current)heading.current?.focus();wasOpened.current=opened;},[opened,step]);
  const current=GUIDE_STEPS[step],close=()=>{patchPreferences({welcomed:true,step});setOpened(false);};
  const change=(index:number)=>{setStep(index);patchPreferences({step:index});};
  const welcome=status.ready&&!opened&&prefs.enabled&&!prefs.welcomed&&!prefs.completed&&!welcomeHidden&&!busy&&!window.location.hash.startsWith('#join-room=');
  return <>{welcome&&<aside className="beginner-welcome" aria-label="Знакомство с SAS"><div className="beginner-welcome-icon"><Sparkles size={20}/></div><div><strong>С чего начать?</strong><p>Короткое знакомство с моделями, историями и памятью.</p></div><Button primary onClick={openBeginnerGuide}>Первые шаги</Button><IconButton title="Позже — обучение останется в настройках" onClick={()=>{setWelcomeHidden(true);patchPreferences({welcomed:true});}}><X size={17}/></IconButton></aside>}
  {opened&&<Modal title="Первые шаги в SAS" onClose={close}><div className="beginner-tour"><div className="beginner-progress" aria-label="Шаги обучения">{GUIDE_STEPS.map((item,index)=><button key={item.id} aria-label={`Шаг ${index+1}: ${item.label}`} aria-current={index===step?'step':undefined} className={index===step?'active':index<step?'done':''} onClick={()=>change(index)}><span>{index<step?<Check size={14}/>:index+1}</span><small>{item.label}</small></button>)}</div><section key={current.id} className="beginner-step" aria-labelledby="beginner-step-heading"><div className="beginner-step-count">ШАГ {step+1} / {GUIDE_STEPS.length}</div><h3 ref={heading} tabIndex={-1} id="beginner-step-heading">{current.title}</h3><p>{current.description}</p><ol>{current.points.map(point=><li key={point}>{point}</li>)}</ol><div className="beginner-tip"><Lightbulb size={18}/><p>{current.tip}</p></div><Button disabled={busy} onClick={()=>{close();navigate(current.view as View);}}><ExternalLink size={15}/>{current.action}</Button>{busy&&<p className="beginner-busy" role="status">Идёт генерация. Раздел можно открыть после её окончания; обучение доступно сейчас.</p>}</section><footer className="beginner-actions"><Button disabled={step===0} onClick={()=>change(step-1)}><ChevronLeft size={16}/>Назад</Button><Button primary onClick={()=>{if(step<GUIDE_STEPS.length-1)change(step+1);else{patchPreferences({completed:true,welcomed:true,step:0});setOpened(false);}}}>{step<GUIDE_STEPS.length-1?'Дальше':'Готово'}{step<GUIDE_STEPS.length-1?<ChevronRight size={16}/>:<Check size={16}/>}</Button></footer>{status.error&&<p className="error-text" role="alert">{status.error}</p>}<label className="beginner-optout"><input type="checkbox" checked={!prefs.enabled} onChange={event=>patchPreferences({enabled:!event.target.checked,welcomed:true})}/><span>Не предлагать обучение автоматически</span></label></div></Modal>}</>;
}
