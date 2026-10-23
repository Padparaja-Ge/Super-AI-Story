// This catalog drives both validation and the host editor. Every field is used
// by the engine; narrative-only house rules stay in instructions.
export const adventureRuleFields=[
 ['hp','Базовые HP','resources',40,1,10000],['slots','Ячейки магии','resources',6,0,100],['hpPerLevel','HP за уровень после первого','resources',0,0,100],['slotsPerLevel','Ячейки за уровень после первого','resources',0,0,20],
 ['armor','Базовый КД','combat',10,1,100],['armorCap','Максимальный КД','combat',19,1,100],['attackDie','Кубик попадания','combat',20,2,100],['checkDie','Кубик проверок','combat',20,2,100],['physicalAccuracy','Бонус попадания физического оружия','combat',2,-20,30],['magicArrowAccuracy','Бонус попадания магической стрелы','combat',2,-20,30],
 ['checkDc','Базовая сложность непривязанной проверки','combat',10,0,1000],
 ['slowActions','Медленных действий за ход','turns',1,1,10],['fastActions','Быстрых действий за ход','turns',2,0,20],['move','Перемещение, клеток','turns',6,0,100],['movementFastCost','Цена перемещения в быстрых действиях','turns',1,0,20],['equipFastCost','Цена экипировки в быстрых действиях','turns',1,0,20],['doorFastCost','Цена открытия двери','turns',1,0,20],
 ['flanking','Преимущество при окружении','tactics',true],['closeRangedDisadvantage','Помеха дальнему оружию вблизи','tactics',true],['projectileDisadvantage','Помеха магическому снаряду','tactics',true],['projectilesIgnoreWalls','Магический снаряд проходит через стены','tactics',false],['diagonalMovement','Разрешить диагональное перемещение','tactics',false],
 ['restSlots','Отдых восстанавливает ячейки','recovery',true],['restHp','Отдых восстанавливает HP','recovery',false],['potionHealing','Лечение стандартным зельем','recovery',20,1,1000],['potionSlots','Стандартное зелье: восстановление ячеек','recovery',2,1,100],
].map(([key,label,group,defaultValue,min,max])=>Object.freeze({key,label,group,defaultValue,min,max,type:typeof defaultValue}));
export const adventureRulesDefaults=Object.freeze({...Object.fromEntries(adventureRuleFields.map(f=>[f.key,f.defaultValue])),instructions:''});
export function normalizeAdventureRules(mode,value={}){
 if(!['dnd','custom'].includes(mode)||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Неверный режим или правила приключения.');
 const allowed=mode==='custom'?value:{fastActions:value.fastActions??2};
 const rules={...adventureRulesDefaults};
 for(const field of adventureRuleFields){const v=allowed[field.key]??field.defaultValue;if(typeof v!==field.type||field.type==='number'&&(!Number.isInteger(v)||v<field.min||v>field.max))throw new Error('Неверный параметр правил: '+field.label);rules[field.key]=v;}
 if(rules.armor>rules.armorCap)throw new Error('Базовый КД не может превышать максимальный КД.');
 if(typeof(value.instructions??'')!=='string'||String(value.instructions||'').length>12000)throw new Error('Инструкции ведущему: не больше 12 000 символов.');
 rules.instructions=value.instructions||'';
 return {...rules,actions:rules.slowActions,bonusActions:rules.fastActions,mana:rules.slots,skills:[]};
}
