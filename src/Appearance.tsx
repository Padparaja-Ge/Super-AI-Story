import {useState} from 'react';
import {Palette,RotateCcw,Download} from 'lucide-react';
import {type StudioProps} from './types';
import {Button,Field,ImportButton,SectionHeader} from './UI';
import {downloadJSON} from './api';
import palette from './palette.json';

export function applyAppearance(appearance?:{fontScale:number;colors:Record<string,string>}){
  const root=document.documentElement;
  root.style.setProperty('--font-scale',String(Math.max(.8,Math.min(1.6,Number(appearance?.fontScale)||1))));
  for(const color of palette){const value=appearance?.colors?.[color.id];if(value&&/^#[\da-f]{3,8}$/i.test(value))root.style.setProperty('--'+color.id,value);else root.style.removeProperty('--'+color.id);}
}
export function AppearanceView({state,update,notify,onBack}:StudioProps & {onBack:()=>void}){
  const [search,setSearch]=useState(''),[advanced,setAdvanced]=useState(false);
  const appearance=state.settings.appearance;
  const primary=palette.filter(p=>p.primary);
  const visible=(advanced?palette:primary).filter(p=>(p.label+' '+p.value).toLowerCase().includes(search.toLowerCase()));
  return <div className="page"><Button onClick={onBack}>← Назад в настройки</Button><SectionHeader eyebrow="ВАШЕ ПРОСТРАНСТВО" title="Внешний вид" description="Размер текста и полная палитра интерфейса. Изменения применяются сразу в настольной и веб-версии." actions={<Button onClick={()=>update(s=>{s.settings.appearance={fontScale:1,colors:{}};})}><RotateCcw size={16}/>Сбросить</Button>}/><section className="panel"><h3><Palette size={20}/>Текст и цвета</h3><Field label={`Размер шрифта · ${Math.round(appearance.fontScale*100)}%`}><input aria-label="Размер шрифта" type="range" min=".8" max="1.6" step=".05" value={appearance.fontScale} onChange={e=>update(s=>{s.settings.appearance.fontScale=Number(e.target.value);})}/></Field><div className="row"><Button onClick={()=>setAdvanced(!advanced)}>{advanced?'Основные цвета':'Все цвета элементов'}</Button><Button onClick={()=>downloadJSON(appearance,'SAS-theme.json')}><Download size={16}/>Экспорт темы</Button><ImportButton label="Импорт темы" onFile={async file=>{try{const theme=JSON.parse(await file.text());if(!theme.colors||typeof theme.colors!=='object')throw new Error('Неверный файл темы.');update(s=>{s.settings.appearance={fontScale:Math.max(.8,Math.min(1.6,Number(theme.fontScale)||1)),colors:Object.fromEntries(Object.entries(theme.colors).filter(([k,v])=>palette.some(p=>p.id===k)&&typeof v==='string'&&/^#[\da-f]{6}$/i.test(v))) as Record<string,string>};});}catch(e:any){notify(e.message,true);}}}/></div>{advanced&&<Field label="Найти элемент или цвет"><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Кнопки, фон, #…"/></Field>}<div className="palette-grid">{visible.map(color=><label className="palette-item" key={color.id}><input aria-label={color.label} type="color" value={appearance.colors[color.id]||color.value} onChange={e=>update(s=>{s.settings.appearance.colors[color.id]=e.target.value;})}/><span><strong>{color.label}</strong><small>{appearance.colors[color.id]||color.value}</small></span><button title="Исходный цвет" onClick={e=>{e.preventDefault();update(s=>{delete s.settings.appearance.colors[color.id];});}}>↺</button></label>)}</div></section></div>;
}
