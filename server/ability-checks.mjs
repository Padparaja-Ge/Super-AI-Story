import crypto from 'node:crypto';
import {abilities,abilityNames,modifier} from '../shared/srp.mjs';
import {checkSkills,pointsOf} from '../shared/equipment.mjs';
import {logGame} from './tactical.mjs';

// Stable keys are shared by NPC defences, narrative tasks and their roll events.
export const checkTypes=Object.freeze([...abilities,...checkSkills.map(([key])=>key),'attack','grapple','escape']);
const knownTypes=new Set(checkTypes);
const typeAbility=new Map([...abilities.map(key=>[key,key]),...checkSkills.map(([key,,ability])=>[key,ability]),['grapple','strength'],['escape','strength']]);
const clean=(value,max=160)=>String(value??'').trim().slice(0,max);
export const checkActionLink=raw=>({actionId:clean(raw.actionId,100),messageId:clean(raw.messageId,100),intent:clean(raw.intent,1200)});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validDc=value=>Number.isInteger(value)&&value>=0&&value<=1000;
const unresolved=challenge=>challenge.active!==false&&!challenge.lastResultId;
// Keep the interactive table bounded without ever discarding an unresolved
// check. Full roll events also remain in the campaign's engine event archive.
export function compactChallenges(game,{keepId=''}={}){
 const live=game.challenges||[],excess=Math.max(0,live.length-300);if(!excess)return;
 const moved=[];game.challenges=live.filter(challenge=>{if(moved.length<excess&&challenge.id!==keepId&&!unresolved(challenge)){challenge.active=false;moved.push(challenge);return false;}return true;});
 if(moved.length){const archive=new Map([...(game.challengeArchive||[]),...moved].map(c=>[c.id,c]));game.challengeArchive=[...archive.values()].slice(-2000);}
}
export function validateDieResult(value,sides=20){if(!Number.isInteger(sides)||sides<2||sides>100||!Number.isInteger(value)||value<1||value>sides)throw new Error('Некорректный бросок: кубик выдаёт только целые значения от 1 до числа граней.');return value;}
export function resolveD20Outcome({roll,sides=20,modifier:bonus=0,dc,impossible=false,impossibleReason=''}){
 validateDieResult(roll,sides);if(!Number.isFinite(bonus)||!validDc(dc))throw new Error('Неверный модификатор или сложность проверки.');
 const total=roll+bonus,naturalCritical=sides===20?(roll===1?'failure':roll===20?'success':null):null;
 if(impossible)return {die:sides,roll,total,dc,margin:total-dc,critical:null,naturalCritical,outcome:'impossible',success:false,reason:clean(impossibleReason,600)||'Действие невозможно в установленных условиях; результат кубика этого не меняет.'};
 const success=naturalCritical==='success'||naturalCritical!=='failure'&&total>=dc;
 return {die:sides,roll,total,dc,margin:total-dc,critical:naturalCritical,naturalCritical,outcome:success?'success':'failure',success,reason:naturalCritical==='success'?'Натуральная 20: критический успех.':naturalCritical==='failure'?'Натуральная 1: критический провал.':`${total} ${success?'≥':'<'} ${dc}: ${success?'успех':'неудача'}.`};
}
export function normalizeCheckDifficulty(raw,{checkType='',defaultAbility=''}={}){
 if(!plain(raw))throw new Error('Неверные параметры сложности.');
 if(checkType&&!knownTypes.has(checkType))throw new Error('Неизвестный тип проверки.');
 const ability=raw.ability||typeAbility.get(checkType)||defaultAbility;
 if(ability&&!abilities.includes(ability))throw new Error('Неизвестная характеристика проверки.');
 if(!validDc(raw.dc))throw new Error('Сложность проверки: целое число от 0 до 1000.');
 if(raw.impossible!==undefined&&typeof raw.impossible!=='boolean')throw new Error('Неверный признак невозможного действия.');
 const impossible=raw.impossible===true,impossibleReason=clean(raw.impossibleReason,600);
 if(impossible&&!impossibleReason)throw new Error('Для невозможного действия укажите причину, связанную с объектом или условиями мира.');
 return {ability,dc:raw.dc,impossible,impossibleReason};
}
export function setActorCheckDifficulty(actor,checkType,raw){
 if(!plain(actor))throw new Error('Цель проверки не найдена.');
 if(!knownTypes.has(checkType))throw new Error('Неизвестный тип проверки.');
 const value=normalizeCheckDifficulty(raw,{checkType});
 if(!actor.checkDifficulties||!plain(actor.checkDifficulties))actor.checkDifficulties={};
 actor.checkDifficulties[checkType]=value;return value;
}
export function actorCheckDifficulty(actor,checkType){
 const raw=actor?.checkDifficulties?.[checkType];return raw?normalizeCheckDifficulty(raw,{checkType}):null;
}
export function upsertChallenge(game,raw){
 if(!plain(raw))throw new Error('Неверное задание проверки.');
 const id=clean(raw.id,100)||crypto.randomUUID(),existing=(game.challenges||[]).find(c=>c.id===id),merged={...existing,...raw};
 if((game.challengeArchive||[]).some(c=>c.id===id))throw new Error('Это задание уже закрыто и перенесено в архив. Для новой попытки создайте новое задание.');
 const checkType=clean(merged.checkType,40)||merged.ability;if(!knownTypes.has(checkType)||checkType==='attack')throw new Error('Выберите тип сюжетной проверки.');
 const difficulty=normalizeCheckDifficulty(merged,{checkType});if(!difficulty.ability)throw new Error('Укажите характеристику задания.');
 const name=clean(merged.name,120);if(!name)throw new Error('Укажите название задания.');
 const targetId=clean(merged.targetId,100),actorId=clean(merged.actorId,100);
 if(targetId&&!game.actors.some(a=>a.id===targetId))throw new Error('Цель задания не найдена.');
 if(actorId&&!game.actors.some(a=>a.id===actorId))throw new Error('Участник задания не найден.');
 if(merged.active!==undefined&&typeof merged.active!=='boolean')throw new Error('Неверный статус задания проверки.');
 const actionId=clean(merged.actionId,100)||existing?.actionId||crypto.randomUUID();
 const challenge={id,name,description:clean(merged.description,1200),...difficulty,checkType,targetId,actorId,...checkActionLink({...merged,intent:clean(merged.intent,1200)||name}),actionId,active:merged.active!==false};
 const newAttempt=!!existing&&existing.actionId!==actionId,willBePending=challenge.active&&!(!newAttempt&&existing?.lastResultId);
 game.challenges||=[];if(willBePending&&game.challenges.filter(c=>c.id!==id&&unresolved(c)).length>=300)throw new Error('Не больше 300 нерешённых активных проверок. Завершите или закройте одно из текущих заданий.');
 if(existing){if(newAttempt){delete existing.lastResultId;delete existing.lastActorId;delete existing.lastActionId;}Object.assign(existing,challenge);}
 else{if(actorId&&challenge.active)for(const previous of game.challenges)if(previous.actorId===actorId&&previous.lastResultId)previous.active=false;game.challenges.push(challenge);}
 compactChallenges(game,{keepId:id});return existing||challenge;
}
export function resolveCheckTarget(game,actor,request){
 const challengeId=clean(request.challengeId,100),challenge=challengeId?(game.challenges||[]).find(c=>c.id===challengeId&&c.active!==false):null;
 if(challengeId&&!challenge)throw new Error('Задание проверки не найдено или закрыто.');
 if(challenge?.actorId&&challenge.actorId!==actor.id)throw new Error('Эта проверка назначена другому участнику.');
 if(challenge?.actionId&&request.actionId&&challenge.actionId!==request.actionId)throw new Error('Проверка относится к другому действию.');
 if(challenge?.messageId&&request.messageId&&challenge.messageId!==request.messageId)throw new Error('Проверка относится к другому сообщению.');
 const checkType=challenge?.checkType||clean(request.checkType||request.checkId,40)||request.ability;
 if(!knownTypes.has(checkType)||['attack','grapple','escape'].includes(checkType))throw new Error('Выберите характеристику или навык проверки.');
 const targetId=challenge?.targetId||clean(request.targetId,100),target=targetId?game.actors.find(a=>a.id===targetId):null;
 if(targetId&&!target)throw new Error('Цель проверки не найдена.');
 const configured=challenge||actorCheckDifficulty(target,checkType),ability=configured?.ability||typeAbility.get(checkType)||request.ability;
 if(!abilities.includes(ability))throw new Error('Неизвестная характеристика.');
 if(request.ability&&request.ability!==ability)throw new Error('Характеристика не соответствует выбранной проверке.');
 if(challenge&&request.targetId&&challenge.targetId!==request.targetId)throw new Error('Цель не соответствует заданию проверки.');
 return {challenge,target,ability,checkType,dc:configured?.dc??game.rules.checkDc??10,impossible:configured?.impossible===true,impossibleReason:configured?.impossibleReason||'',unbound:!configured,actionId:challenge?.actionId||clean(request.actionId,100),messageId:challenge?.messageId||clean(request.messageId,100),intent:challenge?.intent||challenge?.name||clean(request.intent,1200)};
}
export function resolveAbilityCheck(game,actor,request,{random,rollWithMode}){
 // A player selects an engine-owned task, never its result or its difficulty.
 if(['dc','impossible','impossibleReason','roll','total','critical','outcome','modifier'].some(key=>Object.hasOwn(request,key)))throw new Error('Сложность задаёт ведущий; результат броска рассчитывает движок.');
 const context=resolveCheckTarget(game,actor,request),{challenge,target,ability,checkType,actionId,messageId,intent}=context;
 const stored=challenge?.results?.[actor.id]?.calculation,alreadyStored=stored?.actionId===actionId&&stored?.checkType===checkType||challenge?.lastActorId===actor.id&&challenge?.lastActionId===actionId&&!!challenge?.lastResultId;
 if(actionId&&(alreadyStored||[...(game.eventArchive||[]),...(game.log||[])].some(e=>e.calculation?.kind==='check'&&e.calculation.actorId===actor.id&&e.calculation.actionId===actionId&&e.calculation.checkType===checkType&&e.calculation.challengeId===(challenge?.id||''))))throw new Error('Проверка этого действия уже выполнена; ведущий должен назначить новую попытку.');
 const roll=rollWithMode(random,{disadvantage:!!actor.grappledBy,sides:game.rules.checkDie??20}),points=pointsOf(actor,ability),bonus=modifier(points),result=resolveD20Outcome({roll:roll.value,sides:game.rules.checkDie??20,modifier:bonus,...context});
 const calculation={kind:'check',id:crypto.randomUUID(),actorId:actor.id,targetId:target?.id||'',challengeId:challenge?.id||'',checkType,attribute:ability,points,modifier:bonus,bonus:0,rolls:roll.rolls,mode:roll.mode,...result,unbound:context.unbound,actionId,messageId,intent};
 const label=challenge?.name||checkSkills.find(([key])=>key===checkType)?.[1]||abilityNames[ability];
 const text=`${actor.name}${target?' → '+target.name:''}: ${label}. 1д${result.die} [${roll.rolls.join(', ')}; ${roll.mode}, выбран ${roll.value}] ${bonus>=0?'+':'−'} ${abilityNames[ability]} ${Math.abs(bonus)} = ${result.total} против сложности ${result.dc}: ${result.reason}${context.unbound?' Обычная непривязанная проверка; не определяет исход другого действия.':''}`;
 const event=logGame(game,text,calculation);calculation.eventId=event.id;
 if(challenge){challenge.lastResultId=event.id;challenge.lastActorId=actor.id;challenge.lastActionId=actionId;challenge.results={...(challenge.results||{}),[actor.id]:{id:event.id,text:event.text,round:event.round,at:event.at,calculation:{...calculation}}};}
 return event;
}
export function checkContext(game){
 return {challenges:(game.challenges||[]).filter(c=>c.active!==false).map(c=>({...c})),difficulties:(game.actors||[]).filter(a=>Object.keys(a.checkDifficulties||{}).length).map(a=>({id:a.id,name:a.name,checkDifficulties:structuredClone(a.checkDifficulties)}))};
}
