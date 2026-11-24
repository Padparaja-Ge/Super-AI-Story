import {t} from './i18n';
import {useEffect,useState} from 'react';
import {Users,MessagesSquare,Play} from 'lucide-react';
import {Button,Field,Spinner} from './UI';
import {isBigRoomBook} from './Storybooks';

const MIN=2,MAX=8;

/** Cast picker shared by the room setup and the in-room editor. */
export function CastPicker({characters,ids,onChange,disabled}:{characters:any[];ids:string[];onChange:(ids:string[])=>void;disabled?:boolean}){
 const toggle=(id:string,on:boolean)=>onChange(on?[...ids,id].slice(0,MAX):ids.filter(x=>x!==id));
 return <fieldset className="bigroom-cast-picker" disabled={disabled}><legend>{t("Персонажи комнаты · {0} из {1}",[ids.length,MAX])}</legend>
  {characters.map(c=><label key={c.id} className="checkbox-row bigroom-cast-option"><input type="checkbox" checked={ids.includes(c.id)} disabled={!ids.includes(c.id)&&ids.length>=MAX} onChange={e=>toggle(c.id,e.target.checked)}/><span className="bigroom-avatar" aria-hidden="true">{String(c.avatar||'✧').startsWith('data:')?<img src={c.avatar} alt=""/>:c.avatar||'✧'}</span><span className="bigroom-identity"><span>{c.name}</span>{c.lorebookIds?.length?<small className="muted">{t(" · свои лорбуки: ")}{c.lorebookIds.length}</small>:null}</span></label>)}
  {ids.length<MIN&&<p className="muted small">{t("Выберите минимум двух персонажей. Каждый отвечает своей карточкой и своими лорбуками.")}</p>}
 </fieldset>;
}

/** Setup block for a new big room (shown instead of the single RP character picker). */
export function BigRoomSetup({state,castIds,setCastIds,storybookId,setStorybookId}:{state:any;castIds:string[];setCastIds:(v:string[])=>void;storybookId:string;setStorybookId:(v:string)=>void}){
 const books=(state.storybooks||[]).filter(isBigRoomBook);
 return <section className="panel bigroom-setup"><h3><Users size={18}/> {t("Большая комната")}</h3>
  <p className="muted small">{t("Несколько персонажей в одной сцене: они отвечают игрокам и друг другу. К каждому персонажу подключаются его лорбуки; лорбуки комнаты (ниже) действуют на всех.")}</p>
  <CastPicker characters={state.characters} ids={castIds} onChange={setCastIds}/>
  <Field label={t("Общая история · Story book (необязательно)")} hint={t("Показываются только Story book, помеченные «Большая комната». Создать: Story books → «Создать Story book для большой комнаты».")}><select value={storybookId} onChange={e=>setStorybookId(e.target.value)}><option value="">{t("Без общей истории")}</option>{books.map((b:any)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
 </section>;
}

/** In-room panel: who is present and who speaks next. */
export function BigRoomPanel({room,state,isHost,busy,generating,disabled,api,perform}:{room:any;state:any;isHost:boolean;busy:boolean;generating:boolean;disabled:boolean;api:(route:string,body?:any,method?:string)=>Promise<any>;perform:(label:string,fn:()=>Promise<void>)=>Promise<boolean>}){
 const cast:any[]=room.cast||[],[count,setCount]=useState(2),[editing,setEditing]=useState(false),[ids,setIds]=useState<string[]>(cast.map(c=>c.id));
 useEffect(()=>{if(!editing)setIds(cast.map(c=>c.id));},[room.cast,editing]);
 const off=disabled||busy||generating;
 return <section className="panel bigroom-panel" aria-label={t("Персонажи большой комнаты")}>
  <header><h3><Users size={18}/> {t("Персонажи сцены")}</h3>{room.storybook&&<span className="badge">{t("История: ")}{room.storybook.name}</span>}</header>
  <ul className="bigroom-cast">{cast.map(c=><li key={c.id} className={generating&&room.speakerId===c.id?'speaking':''}><span className="bigroom-avatar" aria-hidden="true">{String(c.avatar).startsWith('data:')?<img src={c.avatar} alt=""/>:c.avatar}</span><span><strong>{c.name}</strong>{c.subtitle&&<small className="muted bigroom-sub">{c.subtitle}</small>}{generating&&room.speakerId===c.id&&<small className="accent">{t(" · пишет…")}</small>}</span>
   {isHost&&<Button disabled={off} title={t("Пусть ответит этот персонаж")} onClick={()=>perform('generate',async()=>{await api('/multiplayer/generate',{speakerId:c.id});})}><Play size={14}/>{t("Ответ")}</Button>}</li>)}</ul>
  {isHost&&<div className="bigroom-actions">
   <Button primary disabled={off} onClick={()=>perform('generate',async()=>{await api('/multiplayer/generate',{});})}>{generating?<Spinner/>:<Play size={16}/>}{t("Следующая реплика")}</Button>
   <span className="bigroom-converse"><Button disabled={off} onClick={()=>perform('converse',async()=>{await api('/multiplayer/converse',{count});})}><MessagesSquare size={16}/>{t("Беседа персонажей")}</Button><select aria-label={t("Число реплик")} value={count} disabled={off} onChange={e=>setCount(Number(e.target.value))}>{[2,3,4,5,6].map(n=><option key={n} value={n}>{n}{t(" реплик")}</option>)}</select></span>
  </div>}
  {isHost&&<p className="muted small">{t("Следующего говорящего выбирает SAS: персонаж, к которому обратились по имени, иначе тот, кто дольше молчал. «Беседа» — персонажи отвечают друг другу несколько раз подряд.")}</p>}
  {isHost&&<details open={editing} onToggle={e=>setEditing(e.currentTarget.open)}><summary>{t("Изменить состав")}</summary><CastPicker characters={state.characters} ids={ids} onChange={setIds} disabled={off}/><Button disabled={off||ids.length<MIN} onClick={()=>perform('cast',async()=>{await api('/multiplayer/settings',{castIds:ids},'PUT');setEditing(false);})}>{t("Сохранить состав")}</Button></details>}
 </section>;
}
