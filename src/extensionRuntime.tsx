import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useSyncExternalStore} from 'react';
import {api} from './api';

type Contribution={key:string;owner:string;title?:string;label?:string;slot?:string;mount?:(el:HTMLElement,context:any)=>void|(()=>void);run?:(context:any)=>any};
type Instance={revision:string;active:boolean;cleanups:(()=>void)[];error?:string};
let bridge:any={},context:any={},snapshot={pages:[] as Contribution[],slots:[] as Contribution[],commands:[] as Contribution[],errors:{} as Record<string,string>};
const subscribers=new Set<()=>void>(),events=new Map<string,Set<(value:any)=>void>>(),instances=new Map<string,Instance>();
let consumers=0,poll:ReturnType<typeof setTimeout>|undefined,epoch=0;
function publish(){snapshot={...snapshot,pages:[...snapshot.pages],slots:[...snapshot.slots],commands:[...snapshot.commands],errors:{...snapshot.errors}};for(const fn of subscribers)fn();}
function emit(name:string,value:any){for(const fn of events.get(name)||[])try{fn(structuredClone(value));}catch(error){console.error('Extension event failed:',name,String(error));}}
function dispose(id:string){const instance=instances.get(id);if(!instance)return;instance.active=false;instances.delete(id);for(const fn of instance.cleanups.reverse())try{fn();}catch{}for(const key of ['pages','slots','commands'] as const)snapshot[key]=snapshot[key].filter(c=>c.owner!==id);delete snapshot.errors[id];publish();}
const validKey=(value:string)=>/^[a-z][a-z0-9-]{0,63}$/.test(value);
async function load(record:any,version:number){
 const id=record.id,instance:Instance={revision:record.revision,active:true,cleanups:[]};instances.set(id,instance);
 const base=`/api/extensions/${id}/${record.revision}/files/`;
 const track=(fn:()=>void)=>{if(instance.active)instance.cleanups.push(fn);else fn();return fn;};
 function register(kind:'pages'|'slots'|'commands',value:any){
  if(!instance.active)throw new Error('Расширение уже выключено.');
  if(!validKey(value.id)||typeof (kind==='commands'?value.run:value.mount)!=='function')throw new Error('Неверная регистрация расширения.');
  const key=id+'/'+value.id;if(snapshot[kind].some(c=>c.key===key))throw new Error('Повторный id дополнения: '+key);
  const entry={...value,key,owner:id};snapshot[kind].push(entry);publish();
  return track(()=>{snapshot[kind]=snapshot[kind].filter(c=>c!==entry);publish();});
 }
 const sdk={apiVersion:2,id,ui:{React,createRoot},getContext:()=>structuredClone(context),
  asset:(name:string)=>{if(name.startsWith('/')||name.includes('..')||name.includes('\\'))throw new Error('Неверный путь ресурса.');return base+name;},
  request:api,state:{read:()=>api('/state'),update:async(fn:(state:any)=>void)=>{if(bridge.task?.status==='running')throw new Error('Дождитесь окончания генерации.');bridge.update(fn);await bridge.flush();return api('/state');}},
  navigate:(view:string)=>bridge.navigate(view),notify:(text:string,error=false)=>bridge.notify(String(text),error),
  registerPage:(page:any)=>register('pages',page),registerSlot:(slot:any)=>{if(!['sidebar','topbar','workspace-top','workspace-bottom','message-actions','settings'].includes(slot.slot))throw new Error('Неизвестный слот.');return register('slots',slot);},
  registerCommand:(command:any)=>register('commands',{slot:'topbar',...command}),
  on:(name:string,fn:(v:any)=>void)=>{if(typeof fn!=='function')throw new Error('Нужен обработчик события.');if(!events.has(name))events.set(name,new Set());events.get(name)!.add(fn);return track(()=>events.get(name)?.delete(fn));},
  onDispose:track,
  storage:{read:()=>api('/extensions/'+id+'/storage'),write:(value:any,revision:number)=>api('/extensions/'+id+'/storage',{value,revision},'PUT'),
   update:async(fn:(value:any)=>void)=>{for(let n=0;n<3;n++){const previous=await api('/extensions/'+id+'/storage'),value=structuredClone(previous.value);fn(value);try{return await api('/extensions/'+id+'/storage',{value,revision:previous.revision},'PUT');}catch(error){if(n===2)throw error;}}}},
 };
 try{
  for(const style of record.styles||[]){const link=document.createElement('link');link.rel='stylesheet';link.href=base+style;link.dataset.sasExtension=id;document.head.append(link);track(()=>link.remove());}
  if(record.frontend){const module=await import(/* @vite-ignore */ base+record.frontend);if(version!==epoch||!instance.active)return;if(typeof module.activate!=='function')throw new Error('Frontend должен экспортировать activate(sas).');const cleanup=await module.activate(Object.freeze(sdk));if(typeof cleanup==='function'){if(instance.active)track(cleanup);else cleanup();}}
  if(version!==epoch||!instance.active)return;
 }catch(error:any){if(instance.active){const message=String(error.message||error);dispose(id);instances.set(id,{revision:record.revision,active:false,cleanups:[],error:message});snapshot.errors[id]=message;publish();}}
}
async function reload(){
 const version=epoch;
 try{const result=await api('/extensions');if(version!==epoch||!consumers)return;const wanted=result.extensions.filter((r:any)=>r.enabled&&r.status==='active');for(const [id,instance] of instances)if(!wanted.some((r:any)=>r.id===id&&r.revision===instance.revision))dispose(id);for(const r of wanted)if(!instances.has(r.id))await load(r,version);}catch(error){if(consumers)console.error('SAS extensions:',String(error));}
}
export const extensionRuntime={reload,emit,
 start(){consumers++;if(consumers===1){const generation=++epoch;const tick=async()=>{await reload();if(consumers&&generation===epoch)poll=setTimeout(tick,4000);};void tick();}return ()=>{consumers--;if(consumers)return;epoch++;clearTimeout(poll);for(const id of [...instances.keys()])dispose(id);};},
 bind(next:any){bridge=next;const old=context;context={view:next.view,chatId:next.chatId,task:next.task};if(old.view!==context.view||old.chatId!==context.chatId)emit('viewChanged',context);if(old.task?.id!==context.task?.id||old.task?.status!==context.task?.status)emit('taskChanged',context.task||null);},
 getContext:()=>structuredClone(context),
};
export const useExtensions=()=>useSyncExternalStore(fn=>{subscribers.add(fn);return ()=>subscribers.delete(fn);},()=>snapshot);
function Mounted({item,data}:{item:Contribution;data?:any}){
 const ref=useRef<HTMLDivElement>(null),[error,setError]=React.useState('');
 useEffect(()=>{if(!ref.current)return;let cleanup:any;try{cleanup=item.mount?.(ref.current,{...extensionRuntime.getContext(),...data});}catch(e:any){setError(e.message);}return()=>{if(typeof cleanup==='function')try{cleanup();}catch{}ref.current?.replaceChildren();};},[item]);
 useEffect(()=>{ref.current?.dispatchEvent(new CustomEvent('sas:context',{detail:{...extensionRuntime.getContext(),...data}}));},[data]);
 return <div className="extension-mount" data-extension={item.owner} ref={ref}>{error&&<p role="alert" className="error-text">{error}</p>}</div>;
}
export function ExtensionSlot({name,data}:{name:string;data?:any}){const state=useExtensions();return <div className={'extension-slot extension-slot-'+name}>{state.slots.filter(c=>c.slot===name).map(item=><Mounted key={item.key} item={item} data={data}/>)}{state.commands.filter(c=>c.slot===name).map(item=><button className="btn" key={item.key} onClick={()=>Promise.resolve().then(()=>item.run?.({...extensionRuntime.getContext(),...data})).catch(e=>bridge.notify(e.message,true))}>{item.title||item.label||item.key}</button>)}</div>;}
export function ExtensionPage({view}:{view:string}){const state=useExtensions(),page=state.pages.find(p=>'extension:'+p.key===view);return <div className="page">{page?<><h1>{page.title}</h1><Mounted key={page.key} item={page}/></>:<p>Страница расширения недоступна. Включите его в разделе «Расширения».</p>}</div>;}
