import {extractiveProtocol,roundMessages} from './room-memory.mjs';
import {checkContext} from './ability-checks.mjs';

const narrative=m=>['user','assistant'].includes(m.role)&&!m.kind&&!m.interrupted&&m.continuationStatus!=='incomplete'&&m.content?.trim();
// Retrieval supplements the current scene; it must never replace the last NPC
// answer. In particular this context works without embeddings or auto-summary.
export function recentGameContext(chat,{maxChars=4200}={}){
 const current=new Set(roundMessages(chat).map(m=>m.id));
 const recent=chat.messages.filter(m=>!current.has(m.id)&&narrative(m)).slice(-4);
 const share=Math.max(100,Math.floor(maxChars/Math.max(1,recent.length)));
 return recent.map(m=>({id:m.id,role:m.role,content:extractiveProtocol(m.content,share)}));
}
export function gameCheckContract(game,posts=[]){
 const names=new Map(game.actors.map(a=>[a.id,a.name])),ids=new Set(posts.map(m=>m.id));
 const unique=new Map([...(game.eventArchive||[]),...(game.log||[])].map(e=>[e.id,e]));
 const narrated=new Set(game.narratedEventIds||[]);
 const outcomes=[...unique.values()].filter(e=>e.round===game.round&&!narrated.has(e.id)&&['check','attack','grapple','escape'].includes(e.calculation?.kind)).map(e=>{
  const c=e.calculation;
  return {eventId:e.id,actor:names.get(c.actorId),target:names.get(c.targetId),...c,
   applicable:c.kind!=='check'||!c.unbound&&(c.messageId?ids.has(c.messageId):!!c.intent)};
 });
 const {challenges,difficulties}=checkContext(game);
 const pending=challenges.filter(c=>!c.lastResultId&&(!c.messageId||ids.has(c.messageId)));
 return {outcomes,pending,difficulties,subjects:game.checkSubjects||[]};
}
export function checkNarrationInstruction(game,posts=[]){
 const contract=gameCheckContract(game,posts);
 return '[SAS_CHECK_OUTCOMES] '+JSON.stringify(contract.outcomes)+'\n[SAS_PENDING_CHECKS] '+JSON.stringify(contract.pending)+'\n'+
 'Итог проверки определён движком, а не красотой поста. Отыграй success как достижение ТОЛЬКО указанного намерения, failure как его неудачу; margin задаёт степень, небольшой недобор — обычная неудача без катастрофы. critical=failure — серьёзная неудача, critical=success — исключительный успех. impossible остаётся невозможным даже при натуральной 20. Это метаданные для тебя: НЕ произноси в повествовании или репликах NPC слова critical, margin, проверка, критический успех/провал и результаты кубиков. Передай исход поведением NPC и наблюдаемым результатом. Нельзя менять урон, HP, предметы или задевать союзника художественным текстом. Успешный торг разрешает только согласие NPC на запрошенную цену: покупку, отказ от предмета, передачу монет/товара и получение сдачи игрок ещё должен выбрать отдельно. Аналогично успех другого действия не означает автоматически согласие на его следующий этап. Не назначай новых бросков для уже решённой попытки. applicable=false и свободные кубики не решают другие действия. Инициатива определяет только очередь. Нерешённую сложную попытку не объявляй успешной: оставь её открытой и предложи подготовить соответствующую проверку. Старые итоги не применяй повторно к новому намерению.';
}
