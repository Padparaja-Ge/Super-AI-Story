import {statKeys as abilities,legacyDamage} from './equipment.mjs';
export const damageTypes=['physical','bludgeoning','piercing','slashing','fire','cold','lightning','acid','poison','radiant','necrotic','psychic'];
export const damageNames={physical:'Физический',bludgeoning:'Дробящий',piercing:'Колющий',slashing:'Рубящий',fire:'Огонь',cold:'Холод',lightning:'Молния',acid:'Кислота',poison:'Яд',radiant:'Свет',necrotic:'Тьма',psychic:'Психический'};
export const inventoryDefaults={arrows:20,stones:20,bandages:3,healthPotions:2,slotPotions:2};
export function levelBudget(level=1){return 63+2*(Math.max(1,Math.min(100,Math.floor(level)||1))-1);}
export function skillBudget(level=1){return 3+Math.max(1,Math.min(100,Math.floor(level)||1))-1;}
const integer=(v,min,max,name)=>{if(!Number.isInteger(v)||v<min||v>max)throw new Error(`${name}: целое число от ${min} до ${max}.`);return v;};
export function normalizeSkill(raw){
 if(!raw||typeof raw!=='object')throw new Error('Неверный навык.');
 const s={id:String(raw.id||'').slice(0,64),name:String(raw.name||'').trim().slice(0,100),kind:raw.kind||'physical',grade:raw.grade||'attack',reach:raw.reach||'melee',delivery:raw.delivery||'arrow',weapon:String(raw.weapon||raw.name||'').slice(0,100),hands:raw.hands||'one',ammo:raw.ammo||'arrows',damageType:raw.damageType||'physical',damage:raw.damage??4,range:raw.range??1,slotCost:raw.slotCost??1,points:raw.points??2,duration:raw.duration??2,hits:raw.hits??2,attribute:raw.attribute||'strength',buff:raw.buff||'attribute',action:raw.action||'heal',description:String(raw.description||'').slice(0,2000)};
 if(!s.id||!s.name||!['physical','magic'].includes(s.kind)||!['attack','defense','buff','action'].includes(s.grade)||!['melee','ranged'].includes(s.reach)||!damageTypes.includes(s.damageType))throw new Error('Заполните имя, тип и категорию навыка.');
 if(!['arrow','projectile','beam'].includes(s.delivery)||!['one','two'].includes(s.hands)||!['arrows','stones'].includes(s.ammo)||!abilities.includes(s.attribute)||!['attribute','damage'].includes(s.buff)||!['heal','restore','grapple','utility'].includes(s.action))throw new Error('Недопустимое взаимодействие навыка.');
 s.damage=legacyDamage(s.damage);s.castingAttribute=raw.castingAttribute||(['intelligence','wisdom','charisma'].includes(s.attribute)?s.attribute:'intelligence');if(!['intelligence','wisdom','charisma'].includes(s.castingAttribute))throw new Error('Магия зависит от Интеллекта, Мудрости или Харизмы.');integer(s.slotCost,1,20,'Ячейки');integer(s.points,1,30,'Сила эффекта');integer(s.duration,1,20,'Длительность');integer(s.hits,1,20,'Количество ударов');
 integer(s.range,0,s.kind==='physical'?(s.reach==='melee'?4:24):(s.reach==='melee'?1:60),'Дальность');
 if(s.kind==='physical'&&s.grade!=='attack'&&s.grade!=='action')throw new Error('Физический навык: атака или действие.');
 if(s.kind==='physical'&&s.reach==='ranged')s.hands='two';
 if(s.kind==='magic'&&s.grade==='attack'&&s.reach==='melee')s.range=1;
 return s;
}
export function normalizeSkills(value,level=1){
 if(!Array.isArray(value)||value.length>skillBudget(level))throw new Error('Превышено число навыков уровня.');
 const result=value.map(normalizeSkill);if(new Set(result.map(s=>s.id)).size!==result.length)throw new Error('Идентификаторы навыков не должны повторяться.');return result;
}
export const starterSkills=()=>[
 normalizeSkill({id:'sword',name:'Удар мечом',kind:'physical',weapon:'Меч',damage:4,range:1,description:'Короткий рубящий удар клинком.'}),
 normalizeSkill({id:'bow',name:'Выстрел из лука',kind:'physical',weapon:'Лук',reach:'ranged',damage:3,range:24,ammo:'arrows',description:'Прицельный выстрел стрелой.'}),
 normalizeSkill({id:'bandage',name:'Перевязка',kind:'physical',grade:'action',action:'heal',points:10,range:1,description:'Перевязка раны бинтом.'})];

export function npcSkills(archetype='warrior'){
 const grab=normalizeSkill({id:'grapple',name:'Захват',kind:'physical',grade:'action',action:'grapple',range:1,description:'Удерживает противника силой.'});
 const shield=normalizeSkill({id:'shield',name:'Огненная защита',kind:'magic',grade:'defense',damageType:'fire',hits:2,duration:2,slotCost:1,description:'Огненное сияние поглощает удары огня.'});
 if(archetype==='mage')return [normalizeSkill({id:'magic-arrow',name:'Огненная стрела',kind:'magic',reach:'ranged',delivery:'arrow',range:12,damage:5,damageType:'fire',slotCost:1,description:'Узкая стрела огня летит к цели.'}),normalizeSkill({id:'beam',name:'Луч холода',kind:'magic',reach:'ranged',delivery:'beam',range:10,damage:3,damageType:'cold',slotCost:2,description:'Непрерывный луч холода связывает заклинателя с целью.'}),shield];
 if(archetype==='healer')return [normalizeSkill({id:'heal',name:'Восстановление',kind:'magic',grade:'action',action:'heal',points:15,slotCost:2,description:'Тёплый свет затягивает раны при касании.'}),shield,starterSkills()[0]];
 return [starterSkills()[0],starterSkills()[1],grab];
}
