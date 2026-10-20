import {levelBudget,normalizeSkill,normalizeSkills,starterSkills} from './rpg-rules.mjs';
import {migrateInventory,abilityModifier} from './equipment.mjs';
export const abilities=['strength','dexterity','constitution','intelligence','wisdom','charisma'];
export const abilityNames={strength:'Сила',dexterity:'Ловкость',constitution:'Телосложение',intelligence:'Интеллект',wisdom:'Мудрость',charisma:'Харизма'};
export const defaultAbilities=()=>Object.fromEntries(abilities.map(k=>[k,10]));
export const modifier=abilityModifier;
export function validateSRP(value){
 if(value?.kind!=='srp'||!String(value.className||'').trim())throw new Error('Для D&D/НРИ нужен SRP player с указанным классом.');
 const level=value.level??1;if(!Number.isInteger(level)||level<1||level>100)throw new Error('Уровень: от 1 до 100.');const budget=levelBudget(level);
 const stats=value.abilities;if(!stats||abilities.some(k=>!Number.isInteger(stats[k])||stats[k]<0||stats[k]>budget)||abilities.reduce((n,k)=>n+stats[k],0)>budget)throw new Error('Характеристики SRP: целые числа от 0, сумма не больше '+budget+'.');
 // Earlier guests saved derived combat actions instead of the editable sheet.
 // Built-in actions are not items; only magic consumes the spell budget now.
 const old=(value.spells!==undefined?[]:value.skills||starterSkills()).filter(s=>!['unarmed','grapple'].includes(s.id)).map(normalizeSkill),spells=normalizeSkills(value.spells??old.filter(s=>s.kind==='magic'),level);if(spells.some(s=>s.kind!=='magic'))throw new Error('Раздел заклинаний содержит только магию.');
 const inventory=migrateInventory(value.inventory,old),ids=[...inventory.filter(i=>i.weapon).map(i=>i.id),...spells.map(s=>s.id),'unarmed','grapple'];if(new Set(ids).size!==ids.length)throw new Error('Идентификаторы оружия и заклинаний должны различаться; unarmed и grapple зарезервированы.');
 return {level,spells,inventory,skills:old,kind:'srp',className:String(value.className).trim().slice(0,100),abilities:Object.fromEntries(abilities.map(k=>[k,stats[k]]))};
}
