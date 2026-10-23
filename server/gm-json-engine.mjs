import crypto from 'node:crypto';
import {adventureAction} from './adventure-engine.mjs';
import {logGame} from './tactical.mjs';
import {narrationContextHash,narrationReferencesHash} from './room-narration.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'GM_ACTION_REJECTED'});};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sceneFields=new Set(['notes','weather','time','description']);
const signature=(room,ids)=>hash({round:room.tactical?.round,phase:room.tactical?.phase,turn:room.tactical?.turn,order:room.tactical?.order,map:room.tactical?.map?.id,rules:room.tactical?.rules,actors:room.tactical?.actors,scene:room.scene,challenges:(room.tactical?.challenges||[]).filter(c=>ids.has(c.id))});
// This factory is called only by the server coordinator. Neither capabilities
// nor request IDs may come from a model's action_params or a client packet.
export function createGMJsonEngine({getState,saveState,roomId,requestId,context={},validateSceneUpdate}={}){
 if(typeof getState!=='function'||typeof saveState!=='function'||typeof roomId!=='string'||!roomId||typeof requestId!=='string'||!requestId||requestId.length>160)fail('Нужны серверные идентификаторы комнаты и операции.');
 const initial=getState(),original=initial.multiplayer;if(original?.id!==roomId)fail('Комната изменилась.');
 const ids=new Set(context.allowedChallengeIds||[]),expected={round:context.round??original.tactical?.round,phase:context.phase??'gm',turn:context.turn??original.tactical?.turn},snapshot=signature(original,ids);
 function transact(kind,params,work){
  if(!plain(params)||Object.keys(params).some(key=>!['formula','target','reason','field','value'].includes(key)))fail('Недопустимые параметры действия модели.');
  const state=structuredClone(getState()),room=state.multiplayer;if(room?.id!==roomId||!['dnd','custom'].includes(room.mode)||room.tactical?.version!==2)fail('Действие доступно только в текущей комнате D&D/НРИ.');
  const digest=hash({kind,params}),previous=(room.jsonActionExecutions||[]).find(item=>item.requestId===requestId);
  if(previous){if(previous.digest!==digest)fail('Эта операция уже выполнена с другими параметрами.');return structuredClone(previous.result);}
  const game=room.tactical;if(expected.phase!=='gm'||game.phase!=='gm'||game.round!==expected.round||game.turn!==expected.turn||signature(room,ids)!==snapshot)fail('Игровая ситуация изменилась; действие модели не применено.');
  const value=work(state,room,game);if(value&&typeof value.then==='function')fail('Обработчик игрового действия должен быть синхронным.');
  room.jsonActionExecutions=[...(room.jsonActionExecutions||[]),{requestId,digest,kind,result:structuredClone(value),at:new Date().toISOString()}].slice(-1000);
  const pending=room.narration;
  if(pending?.messageId&&requestId===pending.messageId+':json:0'){
    // Commit mechanics and its continuation source together. An abrupt process
    // exit before the coordinator hook must not leave an invisible completed action.
    pending.promptMessages=[...(pending.promptMessages||[]),{role:'user',content:JSON.stringify({kind:'SAS_ENGINE_ACTION_RESULT',authoritative:true,success:true,result:value})}];
    pending.structuredActionRecorded=true;
    if(value?.eventId)pending.reviewEventIds=[...new Set([...(pending.reviewEventIds||[]),value.eventId])];
    pending.contextHash=narrationContextHash(room,pending.messageId);pending.referencesHash=narrationReferencesHash(state,room);
  }
  saveState(state);return structuredClone(value);
 }
 return {
  rollDice(params){return transact('roll_dice',params,(_state,_room,game)=>{
   if(Object.keys(params).some(key=>!['formula','target','reason'].includes(key))||typeof params.target!=='string'||!ids.has(params.target))fail('Модель может бросать только явно разрешённую сервером нерешённую проверку.');
   const challenge=game.challenges?.find(c=>c.id===params.target&&c.active!==false);if(!challenge||challenge.lastResultId)fail('Проверка уже решена, закрыта или отсутствует.');
   if(params.formula!==undefined&&String(params.formula).toLowerCase().replace('д','d')!==`1d${game.rules.checkDie??20}`)fail('Кубик и модификатор проверки определяет движок.');
   const actor=game.actors.find(a=>a.id===challenge.actorId);if(!actor)fail('Проверка должна быть назначена конкретному NPC.');
   if(actor.player)fail('Для проверки игрока требуется отдельное ожидание его броска; ход игрока не переигрывается.');
   if(context.actorId&&context.actorId!==actor.id)fail('Модель не может управлять другим NPC.');
   if(game.gmProcessed?.includes(actor.id))fail('Ход этого NPC уже выполнен движком.');
   const event=adventureAction(game,{action:'check',actorId:actor.id,challengeId:challenge.id},'host',{host:true});return {eventId:event.id,calculation:event.calculation};
  });},
  updateState(params){return transact('update_state',params,(_state,room,game)=>{
   if(context.allowSceneUpdates!==true||Object.keys(params).some(key=>!['field','value','reason'].includes(key))||!sceneFields.has(params.field)||typeof params.value!=='string'||params.value.length>2000)fail('Модели разрешены только явно включённые текстовые поля сцены.');
   if(validateSceneUpdate){const accepted=validateSceneUpdate({room:structuredClone(room),field:params.field,value:params.value,requestId});if(accepted!==true)fail('Изменение сцены не прошло серверную проверку.');}
   const before=room.scene?.[params.field]??'';room.scene={...room.scene,[params.field]:params.value};const event=logGame(game,'Мастер обновил текстовое поле сцены: '+params.field+'.',{kind:'scene-update',field:params.field,requestId});return {eventId:event.id,field:params.field,before,value:params.value};
  });},
 };
}
