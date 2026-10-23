import {normalizeSkill,normalizeSkills,npcSkills} from '../shared/rpg-rules.mjs';
import {validateSRP} from '../shared/srp.mjs';
import {migrateInventory,normalizeInventory,itemBonus,armorOf,diceExpression} from '../shared/equipment.mjs';
import {logGame} from './tactical.mjs';
export function combatSkills(a){
 const weapons=a.inventory.filter(i=>i.equipped&&i.quantity&&i.weapon).map(i=>({...normalizeSkill({id:i.id,name:i.name,kind:'physical',...i.weapon,description:[i.appearance,i.description].filter(Boolean).join(' · ')}),itemId:i.id}));
 return [...weapons,...a.spells,normalizeSkill({id:'unarmed',name:'Безоружный удар',damage:'1d4',damageType:'bludgeoning',range:1}),normalizeSkill({id:'grapple',name:'Захват',grade:'action',action:'grapple',range:1})];
}
export function refreshEquipment(a,rules){
 a.maxHp=Math.max(1,a.baseMaxHp+(rules.hpPerLevel??0)*Math.max(0,(a.level||1)-1)+itemBonus(a,'hp'));a.maxSlots=Math.max(0,a.baseMaxSlots+(rules.slotsPerLevel??0)*Math.max(0,(a.level||1)-1)+itemBonus(a,'slots'));a.hp=Math.min(a.hp,a.maxHp);a.slots=Math.min(a.slots,a.maxSlots);a.mana=a.slots;a.maxMana=a.maxSlots;a.armorBreakdown=armorOf(a);a.armor=a.armorBreakdown.value;a.skills=combatSkills(a);return a;
}
export function prepareEquipment(a,rules){
 if(a.equipmentVersion!==1){const old=a.skills||npcSkills(a.archetype);a.inventory=migrateInventory(a.inventory,old);a.spells=normalizeSkills(old.filter(s=>s.kind==='magic'),a.level);a.baseArmor=Math.max(1,Math.min(19,a.armor??rules.armor));a.baseMaxHp=a.maxHp??rules.hp;a.baseMaxSlots=a.maxSlots??rules.slots;a.equipmentVersion=1;}
 a.inventory=normalizeInventory(a.inventory);a.spells=normalizeSkills(a.spells||[],a.level);a.fastActions??=rules.fastActions??2;a.bonusActions=a.fastActions;return refreshEquipment(a,rules);
}
export function consumeFast(game,a,cost=1){if(!Number.isInteger(cost)||cost<0)throw new Error('Неверная цена действия.');if(!game.inCombat)return;if(a.fastActions<cost)throw new Error('Быстрые действия закончились.');a.fastActions-=cost;a.bonusActions=a.fastActions;}
const slow=a=>{if(a.actions<1)throw new Error('Медленное действие уже использовано.');a.actions--;a.beam=null;};
export function rollDamage(expression,random){const normalized=diceExpression(expression),[count,sides]=normalized.split('d').map(Number),rolls=Array.from({length:count},()=>random(sides));if(rolls.some(v=>!Number.isInteger(v)||v<1||v>sides))throw new Error('Некорректный результат кубика.');return {expression:normalized,rolls,value:rolls.reduce((n,v)=>n+v,0)};}
export const ammoCount=(a,tag)=>a.inventory.filter(i=>i.ammoTag===tag).reduce((n,i)=>n+i.quantity,0);
export function consumeAmmo(a,tag,count){for(const i of a.inventory.filter(i=>i.ammoTag===tag)){const spent=Math.min(count,i.quantity);i.quantity-=spent;count-=spent;if(!count)break;}}
export function equipmentAction(game,a,r,options){
 const {assertTurn,visible,dist,random,rollWithMode}=options;
 if(['sheet','inventory'].includes(r.action)){
  if(game.inCombat)throw new Error('Лист и состав инвентаря изменяются между боями; в бою используйте экипировку.');
  const next=validateSRP({...a,kind:'srp',className:r.className??a.className,abilities:r.abilities??a.abilities,inventory:r.inventory??a.inventory,spells:r.spells??a.spells});Object.assign(a,{className:next.className,abilities:next.abilities,inventory:next.inventory,spells:next.spells});refreshEquipment(a,game.rules);logGame(game,a.name+': лист и инвентарь обновлены.');return true;
 }
 if(r.action==='equip'){
  const item=a.inventory.find(i=>i.id===r.itemId);if(!item||!item.quantity||!item.weapon&&!item.armor&&!Object.keys(item.buffs).length)throw new Error('Этот предмет нельзя экипировать.');if(typeof r.equipped!=='boolean')throw new Error('Укажите экипировать или снять.');if(item.equipped===r.equipped)return true;
  if(game.inCombat){assertTurn();if(a.grappledBy)throw new Error('Нельзя менять экипировку в захвате.');}
  const next=normalizeInventory(a.inventory.map(i=>i.id===item.id?{...i,equipped:r.equipped}:i));consumeFast(game,a,game.rules.equipFastCost??1);a.inventory=next;refreshEquipment(a,game.rules);logGame(game,`${a.name}: ${r.equipped?'экипировал':'снял'} «${item.name}». КД ${a.armor}; быстрых действий ${a.fastActions}.`);return true;
 }
 if(!['potion','useItem','artifact'].includes(r.action))return false;
 assertTurn();if(a.grappledBy)throw new Error('Нельзя использовать предмет в захвате.');const id=r.itemId||(r.kind==='health'?'healthPotions':'slotPotions'),item=a.inventory.find(i=>i.id===id&&i.quantity>0),target=game.actors.find(b=>b.id===(r.targetId||a.id));if(!item||!target)throw new Error('Предмет или цель недоступны.');
 if(item.artifact?.kind==='active'){
  const effect=item.artifact;if(game.map&&(dist(a,target)>effect.range||!visible(game.map,a,target)))throw new Error('Цель артефакта недоступна.');if(effect.effect==='revive'&&target.player!==a.player)throw new Error('Воскрешение доступно только для союзника.');if(effect.effect==='revive'?target.hp!==0:target.hp<=0)throw new Error('Неверное состояние цели.');const cost=effect.hpCost+(effect.halfHp?Math.ceil(a.hp/2):0);if(a.slots<effect.slotCost||a.hp<=cost)throw new Error('Недостаточно HP или ячеек для артефакта.');slow(a);a.slots-=effect.slotCost;a.hp-=cost;if(effect.effect==='heal')target.hp=Math.min(target.maxHp,target.hp+effect.points);if(effect.effect==='restore')target.slots=Math.min(target.maxSlots,target.slots+effect.points);if(effect.effect==='revive')target.hp=Math.min(target.maxHp,effect.points);logGame(game,`${a.name}: артефакт «${item.name}» → ${target.name}, ${item.appearance} ${item.description}; цена ${cost} HP и ${effect.slotCost} ячеек. Результат: HP ${target.hp}/${target.maxHp}, ячейки ${target.slots}/${target.maxSlots}.`);return true;
 }
 const effect=item.consumable,points=item.id==='healthPotions'?(game.rules.potionHealing??effect?.points):item.id==='slotPotions'?(game.rules.potionSlots??effect?.points):effect?.points;if(!effect||target.hp<=0||effect.effect!=='bandage'&&target.id!==a.id||game.map&&(dist(a,target)>1||!visible(game.map,a,target)))throw new Error('Предмет нельзя применить к этой цели.');if(effect.effect==='bandage')slow(a);else consumeFast(game,a);item.quantity--;if(effect.effect==='restore')target.slots=Math.min(target.maxSlots,target.slots+points);else target.hp=Math.min(target.maxHp,target.hp+points);logGame(game,`${a.name}: «${item.name}» → ${target.name}, ${item.description}; HP ${target.hp}/${target.maxHp}, ячейки ${target.slots}/${target.maxSlots}; осталось ${item.quantity}.`);return true;
}
