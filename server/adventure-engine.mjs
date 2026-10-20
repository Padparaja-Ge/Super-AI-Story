import {beginInitiative,activateInitiative,advanceInitiative,syncInitiative} from './initiative.mjs';
import crypto from 'node:crypto';
import {abilities,abilityNames,modifier,defaultAbilities,validateSRP} from '../shared/srp.mjs';
import {pointsOf,itemBonus} from '../shared/equipment.mjs';
import {prepareEquipment,refreshEquipment,equipmentAction,consumeFast,rollDamage,ammoCount,consumeAmmo} from './equipment-engine.mjs';
import {logGame} from './tactical.mjs';
const dice=sides=>crypto.randomInt(1,sides+1);
export {adventureRulesDefaults as adventureDefaults} from '../shared/adventure-rules.mjs';
import {normalizeAdventureRules} from '../shared/adventure-rules.mjs';
export const adventureRules=normalizeAdventureRules;
export function createAdventureGame(mode,rules={}){return {version:2,mode,rules:adventureRules(mode,rules),actors:[],map:null,log:[],inCombat:false,order:[],turn:0,round:1,phase:'players',completedQuests:[]};}
export function adventureActor(id,p,rules){
 const sheet=validateSRP(p),level=sheet.level||1;
 return prepareActor({id,personaId:p.id,name:p.name,avatar:p.avatar,player:true,className:p.className,level,abilities:sheet.abilities,spells:sheet.spells,inventory:sheet.inventory,equipmentVersion:1,baseMaxHp:rules.hp,baseMaxSlots:rules.slots,baseArmor:rules.armor,hp:rules.hp,slots:rules.slots,actions:rules.slowActions??1,fastActions:rules.fastActions,move:rules.move,effects:[],grappledBy:'',beam:null,x:0,y:0},rules);
}
export function prepareActor(a,rules){
 a.level||=1;a.effects||=[];a.hp??=rules.hp;a.slots??=rules.slots;a.actions??=rules.slowActions??1;a.armorLimit=rules.armorCap??19;a.move??=rules.move;a.abilities||=defaultAbilities();if(!a.player)a.className||=a.archetype||'NPC';a.grappledBy||='';return prepareEquipment(a,rules);
}
export function syncPlayers(game){
 if(game.initiativeVersion){syncInitiative(game);return;}
 const before=(game.order||[]).slice(0,game.turn||0),current=game.order?.[game.turn],ids=game.actors.filter(a=>a.player&&a.hp>0&&a.online!==false).map(a=>a.id);
 game.order=[...(game.order||[]).filter(id=>ids.includes(id)),...ids.filter(id=>!game.order?.includes(id))];
 if(game.phase==='players'){game.turn=current&&game.order.includes(current)?game.order.indexOf(current):before.filter(id=>game.order.includes(id)).length;if(game.turn>=game.order.length&&game.order.length)game.phase='gm';}
}
export function roundEvents(game){
 const log=game.log||[];let start=0;
 for(let i=0;i<log.length;i++)if(log[i].text===`Раунд ${game.round}: очередь игроков.`)start=i;
 return log.slice(start).filter(e=>e.round===undefined||e.round===game.round);
}
export function resetRound(game,random=dice){game.round++;game.phase='players';game.order=game.actors.filter(a=>a.player&&a.hp>0&&a.online!==false).map(a=>a.id);game.turn=0;for(const a of game.actors){prepareActor(a,game.rules);a.actions=game.rules.slowActions??1;a.fastActions=game.rules.fastActions??2;a.bonusActions=a.fastActions;a.move=Math.max(0,game.rules.move+itemBonus(a,'move'));a.effects=(a.effects||[]).map(e=>({...e,turns:e.turns-1})).filter(e=>e.turns>0&&(e.hits===undefined||e.hits>0));refreshEquipment(a,game.rules);if(a.grappledBy&&!game.actors.some(n=>n.id===a.grappledBy&&n.hp>0&&n.online!==false))a.grappledBy='';}logGame(game,`Раунд ${game.round}: очередь игроков.`);beginInitiative(game,random);}
export function effectiveAbility(a,key){return pointsOf(a,key);}
export function rollWithMode(random=dice,{advantage=false,disadvantage=false,sides=20}={}){const rolls=[random(sides)];if(advantage!==disadvantage)rolls.push(random(sides));if(rolls.some(v=>!Number.isInteger(v)||v<1||v>sides))throw new Error('Некорректный бросок.');return {rolls,value:advantage===disadvantage?rolls[0]:advantage?Math.max(...rolls):Math.min(...rolls),mode:advantage===disadvantage?'обычно':advantage?'преимущество':'помеха'};}
const dist=(a,b)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));
export function visible(map,a,b){
 if(!map)return true;
 const blocked=(x,y)=>{if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=map.width||y>=map.height)return true;const door=map.doors?.find(d=>d.x===x&&d.y===y);return door?!door.open:map.tiles[y*map.width+x]!==0;};
 let x=a.x,y=a.y,dx=Math.abs(b.x-x),dy=-Math.abs(b.y-y),sx=x<b.x?1:-1,sy=y<b.y?1:-1,err=dx+dy;
 for(let i=0;i<map.width+map.height+2;i++){
  if(blocked(x,y))return false;if(x===b.x&&y===b.y)return true;
  const e=2*err,nx=e>=dy?x+sx:x,ny=e<=dx?y+sy:y;
  if(nx!==x&&ny!==y&&(blocked(nx,y)||blocked(x,ny)))return false;
  if(e>=dy)err+=dy;if(e<=dx)err+=dx;x=nx;y=ny;
 }
 return false;
}
export function reachableCells(game,a,limit=Infinity){
 const map=game.map;if(!map)return [];
 const walk=(x,y)=>{const d=map.doors?.find(d=>d.x===x&&d.y===y);return d?d.open:map.tiles[y*map.width+x]===0;},occupied=new Set(game.actors.filter(b=>b.id!==a.id&&b.hp>0&&b.online!==false).map(b=>b.x+','+b.y));
 const directions=[[1,0],[-1,0],[0,1],[0,-1],...(game.rules.diagonalMovement?[[1,1],[1,-1],[-1,1],[-1,-1]]:[])];
 const q=[[a.x,a.y,0]],seen=new Set([a.x+','+a.y]);for(let i=0;i<q.length;i++){const [cx,cy,n]=q[i];if(n>=limit)continue;for(const [dx,dy] of directions){const xx=cx+dx,yy=cy+dy,key=xx+','+yy;if(dx&&dy&&(!walk(cx+dx,cy)||!walk(cx,cy+dy)||occupied.has((cx+dx)+','+cy)||occupied.has(cx+','+(cy+dy))))continue;if(xx>=0&&yy>=0&&xx<map.width&&yy<map.height&&walk(xx,yy)&&!seen.has(key)&&!occupied.has(key)){seen.add(key);q.push([xx,yy,n+1]);}}}return q;
}
export function pathDistance(game,a,x,y){if(!Number.isInteger(x)||!Number.isInteger(y))return Infinity;return reachableCells(game,a).find(c=>c[0]===x&&c[1]===y)?.[2]??Infinity;}
export function attackMode(game,a,target,skill){
 const ally=game.actors.some(other=>other.id!==a.id&&other.player===a.player&&other.hp>0&&other.online!==false&&dist(other,target)<=1&&game.map&&((other.x-target.x)*(a.x-target.x)<0||(other.y-target.y)*(a.y-target.y)<0));
 return {sides:game.rules.attackDie??20,advantage:!!target.grappledBy||(game.rules.flanking!==false&&ally),disadvantage:!!a.grappledBy||(game.rules.closeRangedDisadvantage!==false&&skill.reach==='ranged'&&game.map&&dist(a,target)<=1)||(game.rules.projectileDisadvantage!==false&&skill.kind==='magic'&&skill.delivery==='projectile')};
}
function applyDamage(game,a,target,amount,type){
 const shield=target.effects.find(e=>e.type==='shield'&&(e.damageType===type||e.damageType==='physical'&&['bludgeoning','piercing','slashing'].includes(type))&&e.hits>0);
 if(shield){shield.hits--;logGame(game,`${target.name}: защита поглотила ${amount} урона (${type}), осталось ударов ${shield.hits}.`);amount=0;}
 target.beam=null;
 if(amount>0){target.hp=Math.max(0,target.hp-amount);target.beam=null;}
 if(target.hp===0){target.grappledBy='';for(const other of game.actors)if(other.grappledBy===target.id)other.grappledBy='';}
 return amount;
}
function skillDamage(game,a,target,s,random,attackId){
 const buffs=itemBonus(a,'damage')+a.effects.filter(e=>e.type==='damage'&&(e.damageType===s.damageType||e.damageType==='physical'&&s.kind==='physical')).reduce((n,e)=>n+e.points,0),rolled=rollDamage(s.damage,random),raw=Math.max(0,rolled.value+buffs),before=target.hp,amount=applyDamage(game,a,target,raw,s.damageType),applied=before-target.hp;
 const expression=rolled.expression.replace('d','д'),formula=`${expression} [${rolled.rolls.join(' + ')}]${buffs>=0?' + ':' − '}${Math.abs(buffs)} = ${rolled.value+buffs}${rolled.value+buffs<0?' → 0 (урон не бывает отрицательным)':''}`;
 logGame(game,`${a.name} → ${target.name}: ${s.name}. Урон: ${formula} (${s.damageType}); ${amount===0&&raw>0?'защита поглотила урон; ':''}потеря HP ${applied}, HP ${before} → ${target.hp}/${target.maxHp}.`,{kind:'damage',attackId,actorId:a.id,targetId:target.id,skill:s.name,expression:rolled.expression,rolls:rolled.rolls,diceTotal:rolled.value,bonus:buffs,raw,applied,hpBefore:before,hpAfter:target.hp,damageType:s.damageType,blocked:amount===0&&raw>0});
}
function releaseBeam(a){a.beam=null;}
function consumeSlow(a){if(a.actions<1)throw new Error('Медленное действие уже использовано.');a.actions--;releaseBeam(a);}
function assertTurn(game,a,{host}){if(a.online===false)throw new Error('Игрок отключён от комнаты.');if(a.hp<=0)throw new Error('Участник выведен из боя.');if(a.player){if(game.phase!=='players'||game.order[game.turn]!==a.id)throw new Error('Сейчас ход другого участника.');}else if(!host||game.phase!=='gm'||game.initiativeVersion&&game.order[game.turn]!==a.id)throw new Error('NPC действует только в ход ведущего.');}
export function adventureAction(game,request,userId,{host=false,random=dice}={}){
 const actor=game.actors.find(a=>a.id===(request.actorId||userId));if(!actor||(!host&&actor.id!==userId))throw new Error('Можно управлять только своим игроком.');for(const a of game.actors)prepareActor(a,game.rules);
 if(['start','stop','set','quest'].includes(request.action)){
  if(!host)throw new Error('Действие доступно только хосту.');
  if(request.action==='quest'){
   const id=String(request.questId||'').trim().slice(0,100);if(!id||game.completedQuests.includes(id))throw new Error('Укажите ещё не награждённое задание.');
   for(const a of game.actors.filter(a=>a.player)){if(a.level>=100)continue;a.level++;logGame(game,`${a.name}: уровень ${a.level}, +2 очка характеристик и +1 место заклинания. Задание: ${id}`);}game.completedQuests.push(id);return;
  }
  if(request.action==='set'){for(const k of ['hp','slots','armor'])if(request[k]!==undefined){const max=k==='hp'?actor.maxHp:k==='slots'?actor.maxSlots:(game.rules.armorCap??19);if(!Number.isInteger(request[k])||request[k]<(k==='armor'?1:0)||request[k]>max)throw new Error('Недопустимый ресурс.');}for(const k of ['hp','slots'])if(request[k]!==undefined)actor[k]=request[k];if(request.armor!==undefined)actor.baseArmor=request.armor;refreshEquipment(actor,game.rules);logGame(game,`${actor.name}: хост обновил ресурсы, HP ${actor.hp}, ячейки ${actor.slots}, КД ${actor.armor}.`);return;}
  if(request.action==='start'&&!game.map)throw new Error('Сначала создайте карту.');game.inCombat=request.action==='start';if(game.inCombat){for(const a of game.actors){a.slots=a.maxSlots;a.beam=null;a.grappledBy='';a.effects=[];}}resetRound(game,random);logGame(game,game.inCombat?'Бой начат. Ячейки заклинаний восстановлены.':'Бой завершён.');return;
 }
 if(equipmentAction(game,actor,request,{assertTurn:()=>assertTurn(game,actor,{host}),visible,dist,random,rollWithMode:(random,mode)=>rollWithMode(random,{...mode,sides:game.rules.checkDie??20})}))return;
 assertTurn(game,actor,{host});
 if(request.action==='end'){if(!actor.player)throw new Error('NPC завершает ведущий.');if(game.initiativeVersion)advanceInitiative(game,random);else {game.turn++;if(game.turn>=game.order.length)game.phase='gm';}return;}
 if(actor.grappledBy&&!['escape','skill','check'].includes(request.action))throw new Error('Вы в захвате: попытайтесь выбраться либо атакуйте захватившего с помехой.');
 if(request.action==='move'){const steps=pathDistance(game,actor,request.x,request.y);if(!Number.isFinite(steps)||steps<1||steps>actor.move)throw new Error('Клетка недоступна или недостаточно перемещения.');consumeFast(game,actor,game.rules.movementFastCost??1);actor.x=request.x;actor.y=request.y;actor.move-=steps;logGame(game,`${actor.name}: перемещение на ${steps} клеток (${actor.x}, ${actor.y}), осталось ${actor.fastActions} быстрых действий.`);return;}
 if(request.action==='door'){const door=game.map?.doors?.find(d=>d.id===request.doorId);if(!door||dist(actor,door)>1)throw new Error('Дверь должна быть рядом.');if(!door.open){consumeFast(game,actor,game.rules.doorFastCost??1);door.open=true;for(const paired of game.map.doors.filter(d=>Math.abs(d.x-door.x)+Math.abs(d.y-door.y)===1))paired.open=true;logGame(game,actor.name+': дверь открыта.');}return;}
 if(request.action==='rest'){if(game.inCombat)throw new Error('Нельзя отдыхать во время боя.');consumeSlow(actor);if(game.rules.restSlots!==false)actor.slots=actor.maxSlots;if(game.rules.restHp===true)actor.hp=actor.maxHp;logGame(game,actor.name+': отдых, HP '+actor.hp+'/'+actor.maxHp+', ячейки '+actor.slots+'/'+actor.maxSlots+'.');return;}
 if(request.action==='check'){if(!abilities.includes(request.ability))throw new Error('Неизвестная характеристика.');const roll=rollWithMode(random,{disadvantage:!!actor.grappledBy,sides:game.rules.checkDie??20}),value=modifier(effectiveAbility(actor,request.ability));logGame(game,`${actor.name}: ${abilityNames[request.ability]}, ${roll.mode} [${roll.rolls}] + модификатор ${value} = ${roll.value+value}.`);return;}
 if(request.action==='escape'){const captor=game.actors.find(a=>a.id===actor.grappledBy&&a.hp>0);if(!captor)throw new Error('Захвата нет.');consumeSlow(actor);const roll=random(game.rules.checkDie??20),value=modifier(effectiveAbility(actor,'strength')),against=modifier(effectiveAbility(captor,'strength')),success=roll+value>against;if(success)actor.grappledBy='';logGame(game,`${actor.name}: выход из захвата, d${game.rules.checkDie??20}(${roll}) + сила ${value} против силы ${against} — ${success?'успех':'неудача'}.`);return;}
 if(request.action==='channel'){const beam=actor.beam,s=actor.skills.find(s=>s.id===beam?.skillId),target=game.actors.find(a=>a.id===beam?.targetId&&a.hp>0&&a.online!==false);if(!s||!target||game.map&&(dist(actor,target)>s.range||!visible(game.map,actor,target)))throw new Error('Луч потерян.');if(actor.actions<1)throw new Error('Медленное действие уже использовано.');actor.actions--;skillDamage(game,actor,target,s,random);return;}
 if(request.action!=='skill')throw new Error('Неизвестное действие.');
 const s=actor.skills.find(s=>s.id===request.skillId),target=game.actors.find(a=>a.id===request.targetId);if(!s||!target||target.hp<=0||target.online===false)throw new Error('Выберите собственный навык и живую цель.');
 if(actor.grappledBy&&(s.grade!=='attack'||target.id!==actor.grappledBy))throw new Error('В захвате можно атаковать только захватившего с помехой.');
 if(s.grade==='attack'&&target.id===actor.id)throw new Error('Нельзя атаковать себя.');
 if(game.map&&(dist(actor,target)>s.range||!visible(game.map,actor,target)&&!(game.rules.projectilesIgnoreWalls===true&&s.kind==='magic'&&s.delivery==='projectile')))throw new Error('Цель вне дистанции или за стеной.');
 if(actor.actions<1)throw new Error('Медленное действие уже использовано.');
 if(s.kind==='magic'&&actor.slots<s.slotCost)throw new Error('Не хватает ячеек заклинаний.');
 const weapon=s.itemId?actor.inventory.find(i=>i.id===s.itemId)?.weapon:null;
 if(weapon?.reach==='ranged'&&ammoCount(actor,weapon.ammoTag)<weapon.ammoPerShot)throw new Error('Боеприпасы закончились.');
 if(s.action==='grapple'&&s.grade==='action'&&(actor.id===target.id||game.map&&dist(actor,target)>1))throw new Error('Захват только соседнего участника.');
 consumeSlow(actor);if(s.kind==='magic')actor.slots-=s.slotCost;logGame(game,`${actor.name} применяет «${s.name}»: ${s.description||s.grade}.`);
 if(s.grade==='defense'){target.effects.push({type:'shield',damageType:s.damageType,hits:s.hits,turns:s.duration+1});return;}
 if(s.grade==='buff'){target.effects.push({type:s.buff,attribute:s.attribute,damageType:s.damageType,points:s.points,turns:s.duration+1});refreshEquipment(target,game.rules);return;}
 if(s.grade==='action'){
  if(s.action==='grapple'){if(game.map&&dist(actor,target)>1)throw new Error('Захват только рядом.');const roll=random(game.rules.checkDie??20),value=modifier(effectiveAbility(actor,'strength')),against=modifier(effectiveAbility(target,'constitution')),success=roll+value>against;if(success){target.grappledBy=actor.id;target.beam=null;}logGame(game,`${actor.name}: захват ${target.name}, d${game.rules.checkDie??20}(${roll}) + сила ${value} против телосложения ${against} — ${success?'успех':'неудача'}.`);}
  else if(s.action==='heal'){target.hp=Math.min(target.maxHp,target.hp+s.points);logGame(game,`${target.name}: лечение +${s.points}, HP ${target.hp}/${target.maxHp}.`);}
  else if(s.action==='restore'){target.slots=Math.min(target.maxSlots,target.slots+s.points);logGame(game,`${target.name}: восстановлено до ${s.points} ячеек.`);}
  else logGame(game,actor.name+': сюжетное действие выполнено (без автоматического изменения ресурсов).');return;
 }
 if(weapon?.reach==='ranged')consumeAmmo(actor,weapon.ammoTag,weapon.ammoPerShot);
 const roll=rollWithMode(random,attackMode(game,actor,target,s)),attribute=s.kind==='magic'?s.castingAttribute:s.reach==='ranged'?'dexterity':'strength',points=effectiveAbility(actor,attribute),stat=modifier(points),base=s.kind==='magic'?(s.reach==='ranged'&&s.delivery==='arrow'?(game.rules.magicArrowAccuracy??2):0):(game.rules.physicalAccuracy??2),accuracy=stat+base,total=roll.value+accuracy,hit=total>=target.armor;
 const attack=logGame(game,`${actor.name} → ${target.name}: ${s.name}. Попадание: 1д${game.rules.attackDie??20} [${roll.rolls.join(', ')}; ${roll.mode}, выбран ${roll.value}] ${stat>=0?'+':'−'} ${abilityNames[attribute]} ${Math.abs(stat)} (${points} очк.) + бонус ${base} = ${total} против КД ${target.armor}: ${hit?'попадание':'промах; урон не бросается'}.`,{kind:'attack',actorId:actor.id,targetId:target.id,skill:s.name,attribute,points,modifier:stat,bonus:base,rolls:roll.rolls,roll:roll.value,mode:roll.mode,total,armor:target.armor,hit});
 if(hit){skillDamage(game,actor,target,s,random,attack.id);if(s.kind==='magic'&&s.grade==='attack'&&s.reach==='ranged'&&s.delivery==='beam'&&target.hp>0)actor.beam={skillId:s.id,targetId:target.id};}
}
