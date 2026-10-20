export const statKeys=['strength','dexterity','constitution','intelligence','wisdom','charisma'];
export const abilityModifier=value=>Math.floor((value-10)/2);
export const armorNames={light:'Лёгкий',medium:'Средний',heavy:'Тяжёлый'};
export const armorSlots={head:'Голова',chest:'Грудь',legs:'Ноги'};
export const armorValues={light:{head:.5,chest:1,legs:.5},medium:{head:1,chest:2,legs:1},heavy:{head:2,chest:4,legs:2}};
export const armorHelp={light:'Лёгкие доспехи, изготовленные из лёгких и тонких материалов, предпочитают ловкие искатели приключений, поскольку те предоставляют защиту и при этом не ограничивают подвижность. Если вы носите лёгкий доспех, вы при определении Класса Доспеха добавляете модификатор Ловкости к базовому числу, предоставленному доспехом.',medium:'Средние доспехи предлагают лучшую защиту, чем лёгкие, но немного ограничивают перемещение. Если вы носите средний доспех, вы при определении Класса Доспеха к базовому числу, предоставленному доспехом, добавляете модификатор Ловкости, но не более +2.',heavy:'Из всех видов доспехов тяжёлые доспехи предоставляют лучшую защиту. Эти комплекты доспехов покрывают всё тело и созданы для защиты от самых разных атак. Их вес и нагрузку могут выдержать только самые тренированные воители. Тяжёлый доспех не позволяет добавлять к Классу Доспеха модификатор Ловкости, но и не даёт штраф, если модификатор Ловкости отрицательный.'};
export const checkSkills=[['acrobatics','Акробатика','dexterity'],['animalHandling','Уход за животными','wisdom'],['arcana','Магия','intelligence'],['athletics','Атлетика','strength'],['deception','Обман','charisma'],['history','История','intelligence'],['insight','Проницательность','wisdom'],['intimidation','Запугивание','charisma'],['investigation','Расследование','intelligence'],['medicine','Медицина','wisdom'],['nature','Природа','intelligence'],['perception','Восприятие','wisdom'],['performance','Выступление','charisma'],['persuasion','Убеждение','charisma'],['religion','Религия','intelligence'],['sleightOfHand','Ловкость рук','dexterity'],['stealth','Скрытность','dexterity'],['survival','Выживание','wisdom']];
export const physicalTypes=['bludgeoning','piercing','slashing'];
export const weightNames={light:'Лёгкое',medium:'Среднее',heavy:'Тяжёлое'};
export const weightPenalties={light:0,medium:.5,heavy:1};
export function initiativeOf(actor){
 const dexterity=abilityModifier(pointsOf(actor,'dexterity'));
 const equipment=(actor.inventory||[]).filter(i=>i.quantity>0&&i.equipped).flatMap(i=>[
  ...(i.armor?[{id:i.id,name:i.name,kind:'armor',weight:i.armor.kind,penalty:weightPenalties[i.armor.kind]??0}]:[]),
  ...(i.weapon?[{id:i.id,name:i.name,kind:'weapon',weight:i.weapon.weight||'light',penalty:weightPenalties[i.weapon.weight]??0}]:[])
 ]);
 const penalty=equipment.reduce((n,i)=>n+i.penalty,0);
 return {value:dexterity-penalty,dexterity,penalty,equipment};
}
export function diceExpression(value){
 const match=String(value).trim().toLowerCase().replace(/д/g,'d').match(/^(\d{1,2})d(\d{1,3})$/);
 if(!match||+match[1]<1||+match[1]>20||+match[2]<2||+match[2]>100)throw new Error('Урон: от 1 до 20 кубиков с 2–100 гранями, например 1д12 или 2д6.');
 return `${+match[1]}d${+match[2]}`;
}
const n=(value,min,max,name)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name}: целое число ${min}–${max}.`);return value;};
export const legacyDamage=value=>typeof value==='number'?diceExpression(`1d${Math.max(2,Math.min(100,Math.round(value*2)))}`):diceExpression(value??'1d6');
export function normalizeItem(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Неверный предмет.');
 const item={id:String(raw.id||'').slice(0,64),name:String(raw.name||'').trim().slice(0,100),quantity:n(raw.quantity??1,0,9999,'Количество'),equipped:raw.equipped===true,appearance:String(raw.appearance||'').slice(0,2000),description:String(raw.description||'').slice(0,2000),notes:String(raw.notes||'').slice(0,1000),buffs:{},ammoTag:String(raw.ammoTag||'').trim().toLowerCase().slice(0,80)};
 if(!item.id||!item.name)throw new Error('У предмета должны быть имя и ID.');
 for(const [key,value] of Object.entries(raw.buffs||{})){if(![...statKeys,'armor','damage','move','hp','slots'].includes(key))throw new Error('Неизвестный параметр усиления.');n(value,-30,30,'Усиление');if(value)item.buffs[key]=value;}
 if(raw.weapon){const w=raw.weapon;item.weapon={damage:diceExpression(w.damage??'1d6'),reach:w.reach||'melee',hands:w.hands||'one',range:n(w.range??1,1,w.reach==='ranged'?24:4,'Дальность оружия'),damageType:w.damageType||'slashing',ammoTag:String(w.ammoTag||'').trim().toLowerCase().slice(0,80),ammoPerShot:n(w.ammoPerShot??1,1,100,'Снарядов за выстрел')};if(!['melee','ranged'].includes(item.weapon.reach)||!['one','two'].includes(item.weapon.hands)||!physicalTypes.includes(item.weapon.damageType))throw new Error('Неверные свойства оружия.');if(item.weapon.reach==='ranged'&&!item.weapon.ammoTag)throw new Error('Укажите название боеприпаса дальнего оружия.');}
 if(raw.armor){const a=raw.armor;if(!armorNames[a.kind]||!armorSlots[a.slot])throw new Error('Выберите тип и часть доспеха.');item.armor={kind:a.kind,slot:a.slot};}
 if(raw.consumable){const c=raw.consumable;if(!['heal','restore','bandage'].includes(c.effect))throw new Error('Неверное действие расходника.');item.consumable={effect:c.effect,points:n(c.points??10,1,1000,'Величина восстановления')};}
 if(raw.artifact){const a=raw.artifact;if(!['active','passive'].includes(a.kind))throw new Error('Неизвестный тип артефакта.');item.artifact={kind:a.kind,effect:a.effect||'heal',points:n(a.points??10,1,1000,'Сила артефакта'),slotCost:n(a.slotCost??0,0,100,'Стоимость ячеек'),hpCost:n(a.hpCost??0,0,10000,'Стоимость HP'),halfHp:a.halfHp===true,range:n(a.range??1,0,60,'Дальность артефакта')};if(!['heal','restore','revive','utility'].includes(item.artifact.effect))throw new Error('Неизвестное действие артефакта.');}
 if(!item.quantity)item.equipped=false;
 if(item.weapon){item.weapon.weight=raw.weapon.weight||'light';if(!Object.hasOwn(weightPenalties,item.weapon.weight))throw new Error('Вес оружия: лёгкое, среднее или тяжёлое.');}
 return item;
}
export function normalizeInventory(raw){
 if(!Array.isArray(raw)||raw.length>200)throw new Error('Инвентарь: список до 200 предметов.');
 const items=raw.map(normalizeItem);if(new Set(items.map(i=>i.id)).size!==items.length)throw new Error('ID предметов не должны повторяться.');
 if(items.filter(i=>i.equipped&&i.weapon).reduce((n,i)=>n+(i.weapon.hands==='two'?2:1),0)>2)throw new Error('Для экипированного оружия доступны две руки. Сначала снимите прежнее оружие.');
 for(const slot of Object.keys(armorSlots))if(items.filter(i=>i.equipped&&i.armor?.slot===slot).length>1)throw new Error('На каждую часть тела можно надеть один доспех.');
 return items;
}
export const starterInventory=()=>[
 normalizeItem({id:'sword',name:'Меч',equipped:true,weapon:{damage:'1d8',range:1,hands:'one',damageType:'slashing'},description:'Рубящий удар клинком.'}),
 normalizeItem({id:'bow',name:'Лук',weapon:{damage:'1d6',range:24,reach:'ranged',hands:'two',damageType:'piercing',ammoTag:'стрелы'},description:'Прицельный выстрел.'}),
 normalizeItem({id:'arrows',name:'Стрелы',quantity:20,ammoTag:'стрелы'}),normalizeItem({id:'stones',name:'Камни',quantity:20,ammoTag:'камни'}),
 normalizeItem({id:'bandages',name:'Бинты',quantity:3,consumable:{effect:'bandage',points:10}}),normalizeItem({id:'healthPotions',name:'Зелье лечения',quantity:2,consumable:{effect:'heal',points:20}}),normalizeItem({id:'slotPotions',name:'Зелье ячеек',quantity:2,consumable:{effect:'restore',points:2}})
];
export function migrateInventory(value,skills=[]){
 if(Array.isArray(value))return normalizeInventory(value);
 const items=starterInventory();for(const item of items)if(value&&Number.isInteger(value[item.id]))item.quantity=Math.max(0,value[item.id]);
 const physical=skills.filter(s=>s.kind==='physical'&&s.grade==='attack'&&!['unarmed','grapple'].includes(s.id));
 if(physical.length){const weapons=physical.map((s,i)=>normalizeItem({id:s.id,name:s.weapon||s.name,equipped:i===0,description:s.description,weapon:{damage:legacyDamage(s.damage),reach:s.reach,hands:s.hands,range:s.range,damageType:s.reach==='ranged'?'piercing':'slashing',ammoTag:s.reach==='ranged'?(s.ammo==='stones'?'камни':'стрелы'):''}}));return normalizeInventory([...weapons,...items.filter(i=>!i.weapon)]);}
 return normalizeInventory(items);
}
export const itemActive=item=>item.quantity>0&&(item.artifact?.kind==='passive'||item.equipped);
export const itemBonus=(actor,key)=>(actor.inventory||[]).filter(itemActive).reduce((n,item)=>n+(item.buffs?.[key]||0),0);
export function pointsOf(actor,key){return (actor.abilities?.[key]??10)+itemBonus(actor,key)+(actor.effects||[]).filter(e=>e.type==='attribute'&&e.attribute===key).reduce((n,e)=>n+e.points,0);}
export function armorOf(actor){
 const pieces=(actor.inventory||[]).filter(i=>i.quantity>0&&i.equipped&&i.armor),rank={light:1,medium:2,heavy:3},kind=pieces.reduce((kind,i)=>rank[i.armor.kind]>rank[kind]?i.armor.kind:kind,'light'),dex=abilityModifier(pointsOf(actor,'dexterity')),con=abilityModifier(pointsOf(actor,'constitution'));
 const equipment=pieces.reduce((n,i)=>n+armorValues[i.armor.kind][i.armor.slot],0),dexterity=kind==='heavy'?0:kind==='medium'?Math.min(2,dex):dex,buff=itemBonus(actor,'armor'),base=actor.baseArmor??10;
 return {value:Math.max(1,Math.min(actor.armorLimit??19,base+equipment+dexterity+con+buff)),base,equipment,dexterity,constitution:con,buff,kind};
}
