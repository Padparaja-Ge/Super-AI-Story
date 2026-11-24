import {t} from './i18n';
import {useState} from 'react';
import {type StudioProps,uid} from './types';
import {Button,Field,SectionHeader,ImportButton} from './UI';
import {api,readImport,downloadJSON} from './api';
// A Story book is either an adventure for D&D / НРИ rooms or a shared story for a big room.
export const isBigRoomBook=(book:any)=>book?.kind==='bigroom';
const FIELDS={
 adventure:{world:'Описание мира',start:'Стартовая локация героев',goal:'Цель героев',details:'Дополнительное описание'},
 bigroom:{world:'Мир и обстановка',start:'С чего начинается сцена',goal:'Куда должна прийти история (общая цель для всех персонажей)',details:'Роли персонажей, отношения и важные детали'},
};
export function StorybooksView({state,update,flush,refresh,notify}:StudioProps){
 const [selected,setSelected]=useState(state.storybooks[0]?.id||''),book=state.storybooks.find(b=>b.id===selected),patch=(k:string,v:string)=>update(s=>{const b=s.storybooks.find(b=>b.id===selected);if(b)b[k]=v;});
 const create=(kind:'adventure'|'bigroom')=>{const id=uid();update(s=>s.storybooks.push({id,kind,name:kind==='bigroom'?'Новая история большой комнаты':'Новое приключение',world:'',start:'',goal:'',details:'',playerCount:'2-4'}));setSelected(id);};
 const kind=isBigRoomBook(book)?'bigroom':'adventure';
 return <div className="page"><SectionHeader eyebrow={t("ПРИКЛЮЧЕНИЯ")} title="Story books" description={t("Мир, отправная точка и цель общей истории: для D&D / НРИ или для большой комнаты с несколькими персонажами.")} actions={<ImportButton label="Импорт Story book" onFile={async file=>{try{await flush();const result=await api('/import',{kind:'storybook',data:await readImport(file),fileName:file.name});await refresh();setSelected(result.imported.id);notify('Приключение добавлено.');}catch(e:any){notify(e.message,true);}}}/>}/>
  <div className="row"><Button onClick={()=>create('adventure')}>{t("Создать Story book для D&D / НРИ")}</Button><Button onClick={()=>create('bigroom')}>{t("Создать Story book для большой комнаты")}</Button></div>
  <Field label={t("Приключение")}><select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{t("Выберите книгу")}</option>{state.storybooks.map(b=><option key={b.id} value={b.id}>{b.name} · {isBigRoomBook(b)?t('большая комната'):t('D&D / НРИ')}</option>)}</select></Field>
  {book&&<section className="panel"><Button onClick={()=>downloadJSON({spec:'sas_storybook_v1',storybook:book},book.name+'.storybook.json')}>{t("Экспорт JSON")}</Button>
   <Field label={t("Назначение")} hint={kind==='bigroom'?t('Используется только в режиме «Большая комната»: общая история для всех её персонажей.'):t('Используется в режимах D&D и «НРИ · свои правила».')}><select value={kind} onChange={e=>patch('kind',e.target.value)}><option value="adventure">{t("D&D / НРИ · приключение")}</option><option value="bigroom">{t("Большая комната · общая история персонажей")}</option></select></Field>
   <Field label={t("Название")}><input value={book.name} maxLength={120} onChange={e=>patch('name',e.target.value)}/></Field>{kind==='adventure'&&<PlayerCount value={book.playerCount} onChange={v=>patch('playerCount',v)}/>}
   {Object.entries(FIELDS[kind]).map(([key,label])=><Field key={key} label={t(label)}><textarea rows={5} maxLength={8000} value={book[key]} onChange={e=>patch(key,e.target.value)}/></Field>)}</section>}</div>;
}
export function PlayerCount({value,onChange}:{value:string;onChange:(v:string)=>void}){return <Field label={t("Количество игроков")}><select value={value} onChange={e=>onChange(e.target.value)}>{['2','2-4','4-8','8-12'].map(v=><option key={v} value={v}>{v}</option>)}</select></Field>;}
export function AdventureSetup({state,value,onChange}:{state:any;value:any;onChange:(v:any)=>void}){
 const patch=(k:string,v:string)=>onChange({...value,[k]:v});
 return <section className="panel"><Field label={t("Начало приключения")}><select value={value.kind} onChange={e=>patch('kind',e.target.value)}><option value="quick">{t("Быстрое приключение")}</option><option value="book">{t("Заготовленный Story book")}</option></select></Field>{value.kind==='book'?<Field label="Story book"><select value={value.bookId||''} onChange={e=>patch('bookId',e.target.value)}><option value="">{t("Выберите книгу")}</option>{state.storybooks.filter((b:any)=>!isBigRoomBook(b)).map((b:any)=><option key={b.id} value={b.id}>{b.name} · {b.playerCount}</option>)}</select></Field>:<>{Object.entries({genre:{label:'Жанр',items:{fantasy:'Фэнтези','sci-fi':'Научная фантастика',detective:'Детектив',horror:'Хоррор',comedy:'Комедия',romance:'Романтика','dark-18':'18+ · мрачное приключение','romance-18':'18+ · взрослая романтика','horror-18':'18+ · хоррор'}},world:{label:'Мир',items:{kingdoms:'Королевства',wasteland:'Пустошь',zombies:'Зомби-апокалипсис',space:'Космос',cyberpunk:'Киберпанк',pirates:'Пираты и острова',modern:'Современный город',underwater:'Подводный мир',steampunk:'Стимпанк'}},opening:{label:'Начало',items:{dynamic:'Динамическое · погоня, бой',calm:'Спокойное · бар, таверна, встреча',tense:'Напряжённое · заложники, допрос'}}}).map(([key,group])=><Field key={key} label={t(group.label)}><select value={value[key]} onChange={e=>patch(key,e.target.value)}>{Object.entries(group.items).map(([k,name])=><option key={k} value={k}>{name}</option>)}</select></Field>)}<PlayerCount value={value.playerCount} onChange={v=>patch('playerCount',v)}/></>}</section>;
}
