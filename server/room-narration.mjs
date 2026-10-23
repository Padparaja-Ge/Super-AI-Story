import crypto from 'node:crypto';
import {messageTokens} from './prompt.mjs';
import {countCompletionTokens} from './llm.mjs';
import {calculateTokenBudget} from './rag/tokens.mjs';

export const continuationInstruction='ДОПИСЫВАНИЕ НЕЗАВЕРШЁННОГО ОТВЕТА ВЕДУЩЕГО. Продолжи ровно с места обрыва последнего текста: если оборвана фраза, сначала закончи её. Не повторяй уже написанное, не начинай новый ход, не меняй уже рассчитанные действия, позиции и ресурсы. Заверши повествование этого раунда и оставь следующие решения игрокам. Выдай только недостающий художественный текст и реплики NPC.';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalActor=({online,avatar,...actor})=>actor;
const canonicalPersona=({avatar,...persona})=>persona;
const canonicalMap=map=>{if(!map)return map;const {imageId,...geometry}=map;return geometry;};
export const narrationFormatInstruction='Выдавай только художественное повествование и реплики NPC. Используй имена игровых персонажей. Не печатай служебные заголовки «Раунд N · Рассказчик», объявления «Раунд завершён», «Конец раунда», имена ролей, этапы генерации или таблицы расчётов: они уже показаны интерфейсом. Начинай сразу с событий сцены и заканчивай репликой NPC или художественным описанием.';
export const narrationStops=round=>['\nКонец раунда','\n**Конец раунда',...['','*','**'].flatMap(mark=>[`\n${mark}Раунд ${round} заверш`,`\n${mark}Раунд ${round} окончен`])];
export function cleanNarration(text){
 return String(text).replace(/^[ \t]*(?:#{1,6}[ \t]*)?[*_`]*[ \t]*Раунд[ \t]+\d+[ \t]*[·:—–-][ \t]*(?:Рассказчик|Ведущий|AI[ -]?(?:Game Master|ведущий)|GM)[ \t]*[*_`]*[ \t]*:?[ \t]*(?:\r?\n|$)/gimu,'').replace(/^[ \t]*(?:#{1,6}[ \t]*)?[*_`]*[ \t]*(?:Раунд[ \t]+\d+[ \t]+(?:заверш[её]н|окончен)|Конец[ \t]+раунда)(?:[.!:]?[*_`]*[ \t]*)?(?:\r?\n|$)/gimu,'').trim();
}
export function publicRegeneration(room,state){
 const record=room.lastNarration,last=room.messages?.filter(m=>m.kind!=='image').at(-1);
 if(!record||last?.id!==record.messageId||last.role!=='assistant'||last.interrupted||room.narration)return undefined;
 return {messageId:record.messageId,canRegenerate:record.contextHash===narrationContextHash(room,record.messageId)&&record.referencesHash===narrationReferencesHash(state,room)};
}
export function narrationContextHash(room,messageId){
  return hash({id:room.id,mode:room.mode,scene:room.scene,storybook:room.storybook,lorebookIds:room.lorebookIds,rulebookIds:room.rulebookIds,personas:Object.fromEntries(Object.entries(room.personas||{}).map(([id,p])=>[id,canonicalPersona(p)])),
    messages:(room.messages||[]).filter(m=>m.id!==messageId&&m.kind!=='image').map(m=>({id:m.id,content:m.content,role:m.role})),
    game:room.tactical&&{order:room.tactical.order,turn:room.tactical.turn,initiativeScores:room.tactical.initiativeScores,initiativeTies:room.tactical.initiativeTies,gmPendingNext:room.tactical.gmPendingNext,round:room.tactical.round,phase:room.tactical.phase,inCombat:room.tactical.inCombat,log:room.tactical.log,gmProcessed:room.tactical.gmProcessed,challenges:room.tactical.challenges,checkSubjects:room.tactical.checkSubjects,narratedEventIds:room.tactical.narratedEventIds,actors:(room.tactical.actors||[]).map(canonicalActor),rules:room.tactical.rules,map:canonicalMap(room.tactical.map)}});
}
export function narrationReferencesHash(state,room){
  const ids=new Set([...(room.lorebookIds||[]),...(room.rulebookIds||[])]),chat=state.chats?.find(c=>c.id===room.chatId);
  return hash({books:(state.lorebooks||[]).filter(b=>ids.has(b.id)),character:room.mode==='roleplay'?state.characters?.find(c=>c.id===chat?.characterId):undefined});
}
export function publicNarration(room,state){
  const n=room.narration,message=room.messages?.find(m=>m.id===n?.messageId)||(n?.structuredActionRecorded?{id:n.messageId}:undefined);
  if(!n||!message){const last=room.messages?.filter(m=>m.kind!=='image').at(-1);if(last?.role==='assistant'&&last.interrupted)return {messageId:last.id,status:'incomplete',reason:'network',canContinue:true,legacy:true,error:'',automaticContinuations:0};return undefined;}
  const incomplete=['writing','incomplete'].includes(n.status);
  return {messageId:n.messageId,status:n.status==='writing'?'incomplete':n.status,reason:n.reason||'network',canContinue:incomplete&&n.contextHash===narrationContextHash(room,n.messageId)&&(!state||!n.referencesHash||n.referencesHash===narrationReferencesHash(state,room)),error:n.error||'',automaticContinuations:n.automaticContinuations||0,legacy:false};
}
// Some models replay a partial word after a newline ("стра" + "\nстража").
// Restrict this repair to that observed seam: ordinary spaces and common complete
// function words remain verbatim. Buffer only the ambiguous initial prefix.
import {createTextContinuationJoiner} from './text-continuation.mjs';
export const createNarrationContinuationJoiner=before=>createTextContinuationJoiner(before,{capitalBoundary:true});
const crop=(text,limit)=>text.length<=limit?text:text.slice(0,Math.floor(limit*.55))+'\n[Сокращены справочные сведения]\n'+text.slice(-Math.floor(limit*.4));
// Keep the original prompt snapshot scoped to this room. Only references are
// compacted; the full generated draft remains in the persisted chat message.
export async function fitNarrationPrompt(connection,secret,source,{text='',maxTokens,signal,adaptInstruction=false,priorityMessages=[],countTokens=countCompletionTokens,instruction=continuationInstruction,gameBudget=false}={}){
  const priority=priorityMessages.filter(m=>m.content?.trim()).map(m=>({role:m.role,content:String(m.content)})),references=source.map(m=>({role:m.role,content:String(m.content||'')}));
  const messages=[...priority.filter(m=>m.role==='system'),...references,...priority.filter(m=>m.role!=='system')],protectedMessages=new Set(priority);
  const window=Math.max(256,Number(connection.contextWindow)||8192),output=Math.max(32,Math.min(Number(maxTokens)||Number(connection.maxTokens)||1024,Math.floor(window/2))),available=window-output-32;
  if(text){const lastInstruction={role:'user',content:instruction};messages.push({role:'assistant',content:text.slice(-Math.max(400,Math.floor(available*.4)*3))},lastInstruction);protectedMessages.add(lastInstruction);}
  let actual=null;
  for(let attempt=0;attempt<12;attempt++){
    signal?.throwIfAborted();const active=messages.filter(m=>m.content),estimated=gameBudget?3+active.reduce((n,m)=>n+calculateTokenBudget(m.content)+8,0):messageTokens(active);
    if(estimated<=available||gameBudget){actual=await countTokens(connection,secret,active,{signal,adaptInstruction});if((actual??estimated)<=available)return {messages:active,maxTokens:output,estimatedTokens:estimated,actualTokens:actual};}
    const size=actual??estimated,ratio=Math.max(.3,Math.min(.85,available/Math.max(1,size)*.9));
    let changed=false;
    if(gameBudget){
      // Never crop an instruction or a JSON state to fit references. Discard
      // complete lowest-ranked RAG records before considering continuation text.
      const rag=[...messages].reverse().find(m=>m.content.startsWith('[SAS_RAG_SOURCES]\n'));
      if(rag){const lines=rag.content.split('\n');lines.pop();rag.content=lines.length>1?lines.join('\n'):'';changed=true;}
      else if(text){const draft=messages.at(-2),target=Math.max(150,Math.floor(draft.content.length*ratio));if(target<draft.content.length){draft.content=draft.content.slice(-target);changed=true;}}
      actual=null;if(changed)continue;break;
    }
    for(let i=0;i<messages.length;i++){
      if(protectedMessages.has(messages[i]))continue;
      const message=messages[i],min=text&&i===messages.length-2?150:0,target=Math.max(min,Math.floor(message.content.length*ratio));
      if(target<message.content.length){message.content=text&&i===messages.length-2?message.content.slice(-target):target<80?'':crop(message.content,target);changed=true;}
    }
    actual=null;if(!changed)break;
  }
  throw Object.assign(new Error('Для дописывания ответа не хватает контекста модели. Черновик сохранён; увеличьте контекст или выберите другое подключение.'),{code:'NARRATION_CONTEXT'});
}
