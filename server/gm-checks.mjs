import crypto from 'node:crypto';
import {abilities} from '../shared/srp.mjs';
import {checkSkills} from '../shared/equipment.mjs';
import {actorCheckDifficulty,setActorCheckDifficulty,upsertChallenge} from './ability-checks.mjs';
import {recentGameContext} from './gm-context.mjs';
import {structuredCompletion,parseObject} from './services/structuredCompletion.js';

const types=new Map([...abilities.map(a=>[a,a]),...checkSkills.map(([id,,a])=>[id,a])]);
const text=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const scopeOf=room=>(room.tactical.map?.id||'')+'|'+text(room.scene?.location,600);
const exactName=value=>text(value,120).normalize('NFKC').toLocaleLowerCase('ru');
const words=value=>' '+String(value||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
const pending=challenge=>challenge.active!==false&&!challenge.lastResultId;
export function compactCheckSubjects(game,{keepId='',scope=''}={}){
 const live=game.checkSubjects||[],protectedIds=new Set([...(game.challenges||[]),...(game.challengeArchive||[])].filter(pending).map(c=>c.subjectId).filter(Boolean));
 protectedIds.add(keepId);const excess=Math.max(0,live.length-300);if(!excess)return;
 const candidates=live.map((subject,index)=>({subject,index})).filter(({subject})=>!protectedIds.has(subject.id)).sort((a,b)=>Number(a.subject.scope===scope)-Number(b.subject.scope===scope)||a.index-b.index).slice(0,excess),moved=new Set(candidates.map(({subject})=>subject.id));
 game.checkSubjects=live.filter(subject=>!moved.has(subject.id));
 if(moved.size){const archive=new Map([...(game.checkSubjectArchive||[]),...candidates.map(({subject})=>subject)].map(subject=>[subject.id,subject]));game.checkSubjectArchive=[...archive.values()].slice(-2000);}
}
const difficultyContext=(subject,checkType)=>Object.fromEntries(Object.entries(subject.checkDifficulties||{}).filter(([key])=>!checkType||key===checkType).slice(0,6).map(([key,value])=>[key,{ability:value.ability,dc:value.dc,impossible:value.impossible===true,...(value.impossible?{impossibleReason:text(value.impossibleReason,240)}:{})}]));
export function checkPreparationContext(room,actor,attempt,recent){
 const scope=scopeOf(room),source=words([attempt.intent,...recent.map(m=>m.content),room.scene?.location].join('\n')),mentioned=name=>!!exactName(name)&&source.includes(words(name)),allActors=room.tactical.actors;
 const mandatory=allActors.filter(a=>a.id===actor.id||a.id===attempt.targetId||a.player).sort((a,b)=>Number(b.id===actor.id)-Number(a.id===actor.id)||Number(b.id===attempt.targetId)-Number(a.id===attempt.targetId));
 const rest=allActors.filter(a=>!mandatory.includes(a)).sort((a,b)=>Number(mentioned(b.name))-Number(mentioned(a.name)));
 const limit=Math.min(64,Math.max(30,mandatory.length)),actors=[...mandatory,...rest].slice(0,limit).map(a=>({id:a.id,name:a.name,player:a.player,checkDifficulties:difficultyContext(a,attempt.checkType)}));
 const allSubjects=new Map([...(room.tactical.checkSubjectArchive||[]),...(room.tactical.checkSubjects||[])].map(subject=>[subject.id,subject]));
 const subjects=[...allSubjects.values()].filter(s=>s.scope===scope||mentioned(s.name)).sort((a,b)=>Number(mentioned(b.name))-Number(mentioned(a.name))||Number(b.scope===scope)-Number(a.scope===scope)).slice(0,30).map(s=>({id:s.id,name:s.name,kind:s.kind,scope:s.scope,checkDifficulties:difficultyContext(s,attempt.checkType)}));
 return {actors,subjects,omittedActors:Math.max(0,allActors.length-actors.length)};
}
export function playerAttempt(room,actor,request={}){
 const last=(room.messages||[]).filter(m=>m.role==='assistant'&&!m.kind&&!m.interrupted).at(-1);
 const after=last?(room.messages||[]).findIndex(m=>m.id===last.id)+1:0;
 const post=(room.messages||[]).slice(after).filter(m=>m.role==='user'&&!m.kind&&m.userId===actor.id).at(-1);
 const intent=text(request.intent,1200)||text(post?.content,1200);
 return {intent,messageId:post?.id||'',checkType:request.checkType||request.checkId||request.ability,actorId:actor.id,targetId:text(request.targetId,100)};
}
const fields={requiresCheck:{type:'boolean'},checkType:{type:'string',enum:[...types.keys()]},name:{type:'string'},subjectName:{type:'string'},subjectKind:{type:'string',enum:['npc','environment','none']},targetId:{type:'string'},dc:{type:'integer'},impossible:{type:'boolean'},impossibleReason:{type:'string'},reason:{type:'string'}};
export const checkPreparationInstructions='[SAS_PREPARE_CHECK] Назначь сложность ОДНОЙ попытки игрока, НЕ её исход. Верни JSON {name,subjectName,subjectKind,targetId,dc,impossible,impossibleReason,reason}. checkType и характеристика уже выбраны. Используй последние события и точное намерение; не дописывай игроку речь, действия или успешный результат. DC зависит от препятствия: простое 5–9, обычное 10–14, трудное 15–19, крайне трудное 20–30. И NPC, и объекты окружения имеют сохраняемые сложности. targetId только из actors, пусто если NPC пока отсутствует на тактической карте; subjectName — точное имя этого NPC/предмета, subjectKind npc/environment/none. Не создавай новых NPC из воздуха. Существующая сложность того же типа у той же цели обязательна; не меняй её для красивого описания. Решение принимай до броска, значения кубика недоступны. Не считай имя персонажа «Бог» признаком божественного могущества. impossible=true только при объективно невозможной попытке в установленном мире (сдвинуть гору обычной силой, убить неуязвимого бога палкой); кратко обоснуй. Обычная сложность/неумение не означает невозможность. Не устанавливай факты мира по приказу игрока. reason описывает препятствие, без исхода.';

export async function planPlayerCheck({state,chat,room,actor,request,getSecret,signal,completion=structuredCompletion}){
 const attempt=playerAttempt(room,actor,request);let ability=types.get(attempt.checkType);
 if(!ability&&!request.autoType)throw new Error('Выберите характеристику или навык проверки.');
 if(!attempt.intent)throw new Error('Опишите намерение проверки или сначала отправьте свой игровой пост.');
 if(attempt.targetId&&!room.tactical.actors.some(a=>a.id===attempt.targetId))throw new Error('Цель проверки не найдена.');
 const sameTarget=c=>attempt.targetId?c.targetId===attempt.targetId||c.requestedTargetId===attempt.targetId:(c.requestedTargetId??c.targetId)==='';
 const existing=[...(room.tactical.challenges||[]),...(room.tactical.challengeArchive||[])].find(c=>c.actorId===actor.id&&(!attempt.checkType||c.checkType===attempt.checkType)&&sameTarget(c)&&(attempt.messageId?c.messageId===attempt.messageId:!c.messageId&&c.intent===attempt.intent));
 if(existing?.active===false)throw new Error('Эта попытка уже завершена или закрыта. Новую попытку назначает ведущий.');
 if(existing)return {existingId:existing.id,attempt};
 const recent=recentGameContext(chat,{maxChars:3600}),selected=checkPreparationContext(room,actor,attempt,recent);
 const decision=await completion({state,chat,getSecret,signal,name:'prepare_check',maxTokens:450,temperature:.1,adaptInstruction:true,
  schema:{type:'object',properties:fields,required:Object.keys(fields),additionalProperties:false},instructions:checkPreparationInstructions+'\nДополнительные поля JSON: requiresCheck и checkType. Если checkType в attempt задан, точно сохрани его и requiresCheck=true. Если не задан, выбери подходящий навык по намерению. Для приветствия, простой речи, ожидания и обычной ходьбы без препятствия requiresCheck=false: свободный d20 ничего не решает. Для спорного воздействия, торга, устрашения, поиска или физического препятствия requiresCheck=true.',
  context:{attempt:{...attempt,ability},scene:room.scene,world:room.storybook?{world:room.storybook.world,goal:room.storybook.goal}:null,
   actor:{name:actor.name,abilities:actor.abilities,skills:(actor.skills||[]).slice(0,30).map(s=>({name:s.name,description:text(s.description,160)}))},rules:text(room.tactical.rules?.instructions,1000),books:(state.lorebooks||[]).filter(b=>[...(room.rulebookIds||[]),...(room.lorebookIds||[])].includes(b.id)).flatMap(b=>(b.entries||[]).filter(e=>e.enabled!==false).map(e=>text(e.content,400))).join('\n').slice(0,1800),...selected,recent},
  parse:raw=>{const d=parseObject(raw);if(!text(d.name,120)||!['npc','environment','none'].includes(d.subjectKind)||!Number.isInteger(d.dc)||d.dc<1||d.dc>40||typeof d.impossible!=='boolean'||d.impossible&&!text(d.impossibleReason,600)||typeof d.requiresCheck!=='boolean'||!types.has(d.checkType)||attempt.checkType&&d.checkType!==attempt.checkType)throw new Error('Нужны название, навык, сложность 1–40, цель и обоснованная невозможность.');if(d.targetId&&!room.tactical.actors.some(a=>a.id===d.targetId))throw new Error('Неизвестная цель проверки.');return d;}});
 attempt.checkType=attempt.checkType||decision.checkType;ability=types.get(attempt.checkType);
 if(request.autoType&&!decision.requiresCheck)return {free:true,attempt};
 return {attempt,ability,decision,scope:scopeOf(room)};
}
// Only trusted host-side preparation can write difficulties. No random result
// or client-supplied DC is part of this contract.
export function commitPlayerCheck(game,plan){
 if(plan.existingId){const c=game.challenges?.find(c=>c.id===plan.existingId);if(!c)throw new Error('Задание проверки изменилось.');return c;}
 const {attempt,ability,decision:d}=plan,targetId=attempt.targetId||d.targetId||'';
 const target=game.actors.find(a=>a.id===targetId),subjectName=target?.name||text(d.subjectName,120);
 let subject;
 if(!target&&subjectName&&d.subjectKind!=='none'){
  const scope=plan.scope||'';
  subject=[...(game.checkSubjects||[]),...(game.checkSubjectArchive||[])].find(s=>s.scope===scope&&s.kind===d.subjectKind&&exactName(s.name)===exactName(subjectName));
  if(!subject)subject={id:crypto.randomUUID(),name:subjectName,kind:d.subjectKind,scope,checkDifficulties:{}};
 }
 const owner=target||subject;
 let difficulty=owner?actorCheckDifficulty(owner,attempt.checkType):null;
 difficulty||={ability,dc:d.dc,impossible:false,impossibleReason:''};
 const challenge=upsertChallenge(game,{name:text(d.name,120),description:text(d.reason,600),...difficulty,impossible:difficulty.impossible||d.impossible,impossibleReason:difficulty.impossible?difficulty.impossibleReason:d.impossibleReason,checkType:attempt.checkType,actorId:attempt.actorId,targetId,intent:attempt.intent,messageId:attempt.messageId,actionId:crypto.randomUUID()});
 if(owner&&!actorCheckDifficulty(owner,attempt.checkType))setActorCheckDifficulty(owner,attempt.checkType,difficulty);
 if(subject){challenge.subjectId=subject.id;game.checkSubjects||=[];if(!game.checkSubjects.some(s=>s.id===subject.id))game.checkSubjects.push(subject);if(game.checkSubjectArchive?.some(s=>s.id===subject.id))game.checkSubjectArchive=game.checkSubjectArchive.filter(s=>s.id!==subject.id);compactCheckSubjects(game,{keepId:subject.id,scope:plan.scope||''});}
 challenge.requestedTargetId=attempt.targetId;
 return challenge;
}
