import {useState} from 'react';
import {SkillEditor} from './SkillEditor';
import {InventoryEditor} from './InventoryEditor';
import {levelBudget} from '../shared/rpg-rules.mjs';
import {abilities,abilityNames,defaultAbilities,modifier,validateSRP} from '../shared/srp.mjs';
import {checkSkills,migrateInventory,pointsOf} from '../shared/equipment.mjs';
import {Field} from './UI';
export function SRPEditor({persona,patch}:{persona:any;patch:(key:string,value:any)=>void}){
 const [tab,setTab]=useState('sheet'),level=persona.level||1,values=persona.abilities||defaultAbilities(),remaining=levelBudget(level)-abilities.reduce((n,k)=>n+values[k],0),inventory=Array.isArray(persona.inventory)?persona.inventory:migrateInventory(persona.inventory,persona.spells!==undefined?[]:persona.skills||[]),spells=persona.spells??(persona.skills||[]).filter((s:any)=>s.kind==='magic'),actor={...persona,abilities:values,inventory};
 let error='';try{validateSRP({...actor,kind:'srp',spells});}catch(e:any){error=e.message;}
 return <section className="srp-editor"><h3>SRP player · уровень {level}</h3><div className="tabs">{[['sheet','Характеристики'],['checks','Навыки'],['inventory','Инвентарь'],['magic','Магия']].map(([k,t])=><button type="button" key={k} className={tab===k?'active':''} onClick={()=>setTab(k)}>{t}</button>)}</div>
 {tab==='sheet'&&<><Field label="Класс"><input value={persona.className||''} onChange={e=>patch('className',e.target.value)} placeholder="Воин, следопыт, маг…"/></Field><p>Свободных очков: <strong>{remaining}</strong> · бюджет {levelBudget(level)}</p><div className="form-grid">{abilities.map(k=><Field key={k} label={abilityNames[k]+' · модификатор '+modifier(pointsOf(actor,k))}><input type="number" min={0} max={values[k]+remaining} value={values[k]} onChange={e=>patch('abilities',{...values,[k]:Math.max(0,Math.min(values[k]+remaining,Math.floor(Number(e.target.value))))})}/></Field>)}</div><p className="muted small">10–11 очков → 0; 12–13 → +1; 8–9 → −1. Усиления предметов добавляются к очкам.</p></>}
 {tab==='checks'&&<><p>Проверка: 1д20 + модификатор характеристики.</p><div className="form-grid">{checkSkills.map(([id,name,key])=><div className="actor-card" key={id}><strong>{name}: {modifier(pointsOf(actor,key))}</strong><small>{abilityNames[key]}</small></div>)}</div></>}
 {tab==='inventory'&&<InventoryEditor items={inventory} onChange={v=>patch('inventory',v)}/>}
 {tab==='magic'&&<SkillEditor level={level} skills={spells} onChange={v=>patch('spells',v)}/>} {error&&<p className="error-box" role="alert">{error}</p>}</section>;
}
