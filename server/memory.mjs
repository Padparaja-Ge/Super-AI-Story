import crypto from 'node:crypto';
import {complete,getConnection,countCompletionTokens} from './llm.mjs';
import {messageTokens} from './prompt.mjs';

export const memoryDefaults={autoSummary:true,summaryInterval:15,vectorMemory:false,memoryBudget:1200};
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const fingerprint=m=>hash(m.role+'\n'+m.content);
export function validMemory(chat){
 const byId=new Map(chat.messages.map(m=>[m.id,m]));
 return (chat.memory||[]).filter(m=>m.enabled!==false&&m.content?.trim()&&(!m.sources||m.sources.every(s=>byId.has(s.id)&&fingerprint(byId.get(s.id))===s.hash)));
}
export function pendingMemory(chat){
 const covered=new Map();for(const block of validMemory({...chat,memory:(chat.memory||[]).map(m=>({...m,enabled:true}))}))for(const s of block.sources||[]){const ranges=covered.get(s.id)||[];ranges.push([s.start,s.end]);covered.set(s.id,ranges);}
 const result=[];
 for(const [index,m] of chat.messages.entries()){
  if(!['user','assistant'].includes(m.role)||!m.content?.trim()||m.kind==='image'||m.interrupted||m.continuationStatus==='incomplete')continue;
  let offset=0;const ranges=(covered.get(m.id)||[]).sort((a,b)=>a[0]-b[0]),parts=[];
  for(const [start,end] of ranges){if(start>offset)parts.push([offset,start]);offset=Math.max(offset,end);}
  if(offset<m.content.length)parts.push([offset,m.content.length]);
  for(const [start,end] of parts)result.push({id:m.id,index,role:m.role,hash:fingerprint(m),start,end,text:m.content.slice(start,end)});
 }
 return result;
}
export function memoryDue(chat){const pending=pendingMemory(chat);return !!chat.memorySettings?.autoSummary&&new Set(pending.map(p=>p.id)).size>=Math.max(2,Number(chat.memorySettings.summaryInterval)||15);}
export function createMemory({getState,saveState,getSecret,completion=complete,countTokens=countCompletionTokens}){
 async function summarize(chatId,{signal,onProgress=()=>{}}={}){
  const state=getState(),chat=state.chats.find(c=>c.id===chatId);if(!chat)throw new Error('История не найдена.');
  const connection=getConnection(state,chat),context=Math.max(256,Number(connection.contextWindow)||8192),maxTokens=Math.min(800,Number(connection.maxTokens)||800,Math.floor(context/4));
  const system='Сожми фрагмент истории в фактическую память на русском: ключевые события по порядку, участники, отношения, обещания, изменения состояния и незавершённые цели. Только факты из фрагмента, без выдумок. Не продолжай сцену. Кратко, до 180 слов.';
  const capacity=Math.max(30,(context-maxTokens-messageTokens([{role:'system',content:system}])-100)*3);
  const pending=pendingMemory(chat),queue=[];
  // Split even a single oversized post. Every source character remains covered.
  for(const p of pending)for(let offset=0;offset<p.text.length;offset+=Math.min(2400,capacity-20)){
   const text=p.text.slice(offset,offset+Math.min(2400,capacity-20));queue.push({...p,start:p.start+offset,end:p.start+offset+text.length,text});
  }
  const interval=Math.max(2,Math.min(100,Number(chat.memorySettings?.summaryInterval)||15));let completed=0;
  while(queue.length){
   signal?.throwIfAborted();const parts=[];let cost=0;
   while(queue.length&&parts.length<interval&&cost+queue[0].text.length+20<=capacity){const p=queue.shift();parts.push(p);cost+=p.text.length+20;}
   if(!parts.length)throw new Error('Для сводки нужен контекст модели хотя бы 512 токенов.');
   onProgress(`Сводка: сообщения ${parts[0].index+1}–${parts.at(-1).index+1} · осталось фрагментов ${queue.length}`);
   let messages;
   for(;;){
    messages=[{role:'system',content:system},{role:'user',content:parts.map(p=>`${p.role}: ${p.text}`).join('\n')}];
    const actual=await countTokens(connection,getSecret(connection.id),messages,{signal,adaptInstruction:true,disableThinking:true});
    if(actual===null||actual<=context-maxTokens-32)break;
    if(parts.length>1){queue.unshift(parts.pop());continue;}
    const part=parts[0];if(part.text.length<16)throw new Error('Для сводки недостаточно контекста модели. Увеличьте окно контекста.');
    let cut=Math.floor(part.text.length/2);if(/[\uD800-\uDBFF]/u.test(part.text[cut-1]))cut--;
    queue.unshift({...part,start:part.start+cut,text:part.text.slice(cut)});parts[0]={...part,end:part.start+cut,text:part.text.slice(0,cut)};
   }
   const summary=await completion({...connection,maxTokens,temperature:0.2},getSecret(connection.id),messages,{signal,disableThinking:true,adaptInstruction:true});
   if(!summary.trim())throw new Error('Модель вернула пустую сводку.');
   const fresh=getState(),target=fresh.chats.find(c=>c.id===chatId);if(!target)throw new Error('История удалена.');
   if(parts.some(p=>!target.messages.some(m=>m.id===p.id&&fingerprint(m)===p.hash)))throw new Error('Сообщения изменились во время сводки. Повторите запрос.');
   const block={id:crypto.randomUUID(),category:'episodes',automatic:true,enabled:true,content:summary.trim(),createdAt:new Date().toISOString(),order:parts[0].index+parts[0].start/1e7,sources:parts.map(({id,hash,start,end})=>({id,hash,start,end})),title:`События ${parts[0].index+1}–${parts.at(-1).index+1}`};
   target.memory.push(block);target.summary=summary.trim();saveState(fresh);completed++;
  }
  return {summary:getState().chats.find(c=>c.id===chatId)?.summary||'',blocks:completed};
 }
 return {summarize};
}
