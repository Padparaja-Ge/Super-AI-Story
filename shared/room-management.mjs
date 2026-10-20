export function correctionRequest(kind,value,room,session){
  const reason=String(value.reason||'').trim();
  if(!reason||reason.length>1000)throw new Error('Укажите причину исправления (до 1000 символов).');
  if(kind==='event'){
    const text=String(value.text||'').trim();if(!value.eventId||!text||text.length>8000)throw new Error('Выберите событие и укажите текст (до 8000 символов).');
    return {kind,reason,eventId:value.eventId,text};
  }
  if(kind==='dice'){
    const message=(session?.messages||[]).find(item=>item.id===value.messageId&&item.kind==='dice'&&item.dice),number=Number(value.value);
    if(!message||!Number.isInteger(number)||number<1||number>message.dice.sides)throw new Error('Выберите бросок и значение в пределах граней кубика.');
    return {kind,reason,messageId:message.id,value:number};
  }
  const actor=room?.tactical?.actors?.find(item=>item.id===value.actorId);
  if(!actor)throw new Error('Выберите участника.');
  if(kind==='turn'){
    if(!room.tactical.order?.includes(actor.id)||actor.hp<=0||actor.online===false)throw new Error('Выберите живого участника текущей очереди.');
    return {kind,reason,actorId:actor.id};
  }
  if(kind==='actor'){
    let patch;
    if(value.field==='position'){
      const x=Number(value.x),y=Number(value.y);if(value.x===''||value.y===''||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0)throw new Error('Координаты клетки — целые числа, начиная с нуля.');patch={x,y};
    }else if(value.field==='grappledBy')patch={grappledBy:String(value.value||'')};
    else{
      if(!['hp','slots','actions','fastActions','move','armor'].includes(value.field))throw new Error('Неизвестный параметр участника.');
      const number=Number(value.value),scale=value.field==='armor'?2:1;if(value.value===''||!Number.isInteger(number*scale)||number<0)throw new Error(value.field==='armor'?'КД должен быть неотрицательным, с шагом 0,5.':'Значение должно быть целым неотрицательным числом.');patch={[value.field]:number};
    }
    return {kind,reason,actorId:actor.id,patch};
  }
  throw new Error('Неизвестное исправление.');
}

export function roomManagementAccess(room,session,isHost){
  const pending=!isHost&&session?.admission==='pending';
  return {pending,connected:isHost?session?.running===true:session?.connected===true,canRead:!pending,canCorrect:isHost&&session?.running===true&&!session?.generating&&room?.narration?.status!=='incomplete',canRestore:isHost&&!session?.running&&!session?.generating};
}
