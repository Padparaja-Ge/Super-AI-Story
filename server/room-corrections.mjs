import crypto from 'node:crypto';
import {logGame} from './tactical.mjs';

const fail=text=>Object.assign(new Error(text),{status:400});
export function correctRoom(room,request={}){
  const reason=String(request.reason||'').trim();if(!reason||reason.length>1000)throw fail('Укажите причину исправления: от 1 до 1000 символов.');
  const kind=request.kind,g=room.tactical;let before,after,message;
  if(kind==='event'){
    if(!g)throw fail('Журнал доступен в D&D/НРИ.');const entries=[...(g.eventArchive||[]),...(g.log||[])].filter(e=>e.id===request.eventId);if(!entries.length)throw fail('Событие не найдено.');
    const text=String(request.text||'').trim();if(!text||text.length>8000)throw fail('Текст события: от 1 до 8000 символов.');before=structuredClone(entries[0]);
    for(const entry of entries){entry.text=text;entry.correctedAt=new Date().toISOString();entry.correctionReason=reason;entry.calculation={...(entry.calculation||{}),annotationOnly:true};}
    after=structuredClone(entries[0]);
  }else if(kind==='dice'){
    message=(room.messages||[]).find(m=>m.id===request.messageId&&m.kind==='dice'&&m.dice);if(!message)throw fail('Сообщение с броском не найдено.');
    if(message.dice.eventId)throw fail('Этот бросок уже определил исход действия в движке. Назначьте новую попытку или отдельно исправьте состояние участника; изменение свободного кубика не пересчитывает действие.');
    if(!Number.isInteger(request.value)||request.value<1||request.value>message.dice.sides)throw fail('Результат должен укладываться в грани кубика.');
    before=structuredClone(message);message.dice={...message.dice,value:request.value,corrected:true};message.content=`Бросок d${message.dice.sides}: ${request.value} · исправлено мастером`;message.editedAt=new Date().toISOString();after=structuredClone(message);
  }else if(kind==='actor'){
    if(!g)throw fail('Игровой стол отсутствует.');const a=g.actors.find(a=>a.id===request.actorId);if(!a)throw fail('Участник не найден.');
    const patch=request.patch;if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!['hp','slots','actions','fastActions','move','armor','x','y','grappledBy'].includes(k)))throw fail('Можно исправить HP, ячейки, действия, движение, КД, позицию и захват.');
    const next={...a,...patch};for(const [key,max] of [['hp',a.maxHp],['slots',a.maxSlots??a.maxMana??1000],['actions',g.rules?.slowActions??10],['fastActions',g.rules?.fastActions??10],['move',Math.max(100,g.rules?.move??0)],['armor',g.rules?.armorCap??19]])if(patch[key]!==undefined&&(!Number.isFinite(next[key])||!Number.isInteger(next[key]*(key==='armor'?2:1))||next[key]<0||next[key]>max))throw fail('Недопустимое значение: '+key+'.');
    if(patch.x!==undefined||patch.y!==undefined){const m=g.map;if(!m||!Number.isInteger(next.x)||!Number.isInteger(next.y)||next.x<0||next.y<0||next.x>=m.width||next.y>=m.height||m.tiles[next.y*m.width+next.x]!==0||g.actors.some(other=>other.id!==a.id&&other.online!==false&&other.hp>0&&other.x===next.x&&other.y===next.y))throw fail('Позиция должна быть свободной проходимой клеткой.');}
    if(patch.grappledBy!==undefined&&(typeof patch.grappledBy!=='string'||patch.grappledBy&&(!g.actors.some(other=>other.id===patch.grappledBy&&other.id!==a.id&&other.hp>0))))throw fail('Источник захвата не найден.');
    before=Object.fromEntries(Object.keys(patch).map(key=>[key,a[key]]));Object.assign(a,patch);a.mana=a.slots;a.bonusActions=a.fastActions;after=Object.fromEntries(Object.keys(patch).map(key=>[key,a[key]]));
  }else if(kind==='turn'){
    if(!g||!g.order?.length)throw fail('Нет активной очереди.');const turn=g.order.indexOf(request.actorId);if(turn<0||!g.actors.some(a=>a.id===request.actorId&&a.hp>0&&a.online!==false))throw fail('Выберите живого участника текущей очереди.');
    before={turn:g.turn,phase:g.phase,gmPendingNext:g.gmPendingNext};g.turn=turn;g.gmPendingNext=false;g.phase=g.actors.find(a=>a.id===request.actorId).player?'players':'gm';after={turn:g.turn,phase:g.phase,gmPendingNext:g.gmPendingNext};
  }else throw fail('Неизвестный вид исправления.');
  const audit={id:crypto.randomUUID(),at:new Date().toISOString(),by:'host',kind,reason,targetId:request.eventId||request.messageId||request.actorId,before,after,mechanicsReapplied:false};room.corrections||=[];room.corrections.push(audit);
  if(g)logGame(g,'Мастер исправил '+({event:'запись журнала',dice:'бросок',actor:'состояние участника',turn:'очередь хода'}[kind])+': '+reason+'. Повторного применения урона или броска нет.',{kind:'host-correction',correctionId:audit.id,targetId:audit.targetId,mechanicsReapplied:false});
  return {audit,message};
}
