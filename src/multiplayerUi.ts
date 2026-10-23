export type RoomPanel = 'chat'|'turn'|'map'|'settings'|'log';

export function isAdventureRoom(room:{mode?:string;tactical?:unknown}):boolean {
  return room.mode==='dnd'||room.mode==='custom'||!!room.tactical;
}

// Continue the existing narration rather than starting another game-master turn.
export function unfinishedNarration(room:any,messages:any[]):{messageId:string;reason:string;canContinue:boolean}|null {
  const narration=room.narration;
  const message=messages.find(item=>item.id===narration?.messageId);
  if((narration?.canContinue||narration?.status==='incomplete')&&message?.role==='assistant'&&message.kind!=='image')return {messageId:message.id,reason:narration.reason||'length',canContinue:narration.canContinue!==false};
  const latest=messages.filter(item=>item.role==='assistant'&&item.kind!=='image').at(-1);
  if(latest&&(latest.interrupted||latest.continuationStatus==='incomplete'))return {messageId:latest.id,reason:latest.interruptionReason||'length',canContinue:true};
  return null;
}

export function roomModeLabel(room:{mode?:string;tactical?:unknown}):string {
  if(room.mode==='custom')return 'НРИ · свои правила';
  if(isAdventureRoom(room))return 'D&D · упрощённая';
  return 'Role Play с персонажем';
}

export function narrationReason(reason:string):string {
  return reason==='validation'?'Ответ не прошёл проверку последствий действий. Исправьте текст или повторите проверку.':reason==='network'?'Соединение с моделью прервалось.':reason==='stopped'?'Генерация остановлена.':'Модель достигла лимита ответа.';
}
