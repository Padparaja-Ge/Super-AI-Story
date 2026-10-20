import {createHash} from 'node:crypto';
import {fanficEvidenceBlocks,eligibleCanonFacts,canonFactReference} from './fanfic-canon.mjs';
import {fanficEpisodeOrder,fanficEpisodeLabel} from '../shared/fanfic.mjs';
import {resolveFanficStageProfile} from '../shared/fanfic-profiles.mjs';
import {messageTokens} from './prompt.mjs';
import {countCompletionTokens} from './llm.mjs';
import {structuredCompletion,parseObject} from './services/structuredCompletion.js';

const hash=value=>createHash('sha256').update(String(value||'')).digest('hex');
const strings={type:'array',items:{type:'string'},maxItems:8};
export const fanficReviewSchema={type:'object',additionalProperties:false,properties:{issues:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['knowledge','location','item','relationship','promise','number','continuity']},severity:{type:'string',enum:['warning','error']},message:{type:'string'},evidenceIndices:{type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:3},factIds:strings,suggestion:{type:'string'}},required:['type','severity','message','evidenceIndices','factIds','suggestion']}}},required:['issues']};
export const fanficReviewInstructions='Ты редактор связности SAS Fanfic. Проверь только нумерованные предложения проверяемого текста на явные противоречия предоставленным источникам канона. Не придумывай канон, не используй авторское задание как произошедший факт. Новое событие и намеренная перемена не являются ошибкой сами по себе. Нельзя утверждать, что герой не может знать тайну, если источники этого не устанавливают. Сохраняй точные имена, числа и коды. Верни JSON {"issues":[]}, если противоречий нет. Для каждого возможного противоречия: type knowledge/location/item/relationship/promise/number/continuity, severity warning/error, краткие message и suggestion на русском, evidenceIndices 1–3 существующих номера предложений проверяемого текста, factIds только IDs приложенных источников. Не переписывай текст. Не выдавай жанровые вкусы, стиль и новые сюжетные решения за противоречия. Не добавляй выдуманные цитаты.';
const clip=(s,n)=>String(s||'').slice(0,n);
export function validateFanficReview(raw,{prose,sourceOffset=0,references=[]}={}){
 if(!Number.isInteger(sourceOffset)||sourceOffset<0)throw new Error('Неверная позиция проверяемого текста.');
 const value=typeof raw==='string'?parseObject(raw):raw;
 if(!Array.isArray(value?.issues)||value.issues.length>8)throw new Error('Проверка должна вернуть список issues не длиннее восьми записей.');
 const blocks=fanficEvidenceBlocks(prose),ids=new Set(references.map(r=>r.id));
 return value.issues.map((issue,index)=>{
  if(!['knowledge','location','item','relationship','promise','number','continuity'].includes(issue?.type)||!['warning','error'].includes(issue?.severity)||typeof issue.message!=='string'||!issue.message.trim()||issue.message.length>1200||typeof issue.suggestion!=='string'||issue.suggestion.length>1600)throw new Error('Неверный формат замечания связности.');
  if(!Array.isArray(issue.evidenceIndices)||!issue.evidenceIndices.length||issue.evidenceIndices.length>3||issue.evidenceIndices.some(i=>!Number.isInteger(i)||i<1||i>blocks.length))throw new Error('Замечание ссылается на отсутствующее предложение.');
  if(!Array.isArray(issue.factIds)||issue.factIds.length>8||issue.factIds.some(id=>typeof id!=='string'||!ids.has(id)))throw new Error('Замечание ссылается на отсутствующий источник канона.');
  // A bare opinion without a provided canon source is not a supported conflict.
  if(!issue.factIds.length)throw new Error('Для противоречия нужен приложенный источник канона.');
  const evidence=[...new Set(issue.evidenceIndices)].map(i=>{const b=blocks[i-1],lead=b.text.length-b.text.trimStart().length,trail=b.text.length-b.text.trimEnd().length;return {quote:b.text.trim(),start:sourceOffset+b.start+lead,end:sourceOffset+b.end-trail};});
  return {id:hash(JSON.stringify([issue.type,issue.message,evidence,issue.factIds])).slice(0,24),type:issue.type,severity:issue.severity,message:issue.message.trim(),evidence:evidence.map(e=>e.quote),sourceEvidence:evidence,factIds:[...new Set(issue.factIds)],suggestion:issue.suggestion.trim(),modelAssessment:true};
 });
}
// Already normalized adapter output is still untrusted: reconstruct sentence IDs
// from exact server-issued quotes and offsets, then stamp IDs/evidence again.
export function normalizeFanficReviewResult(result,options){
 if(!Array.isArray(result))return validateFanficReview(result,options);
 if(result.length>8)throw new Error('Проверка должна вернуть не более восьми замечаний.');
 const blocks=fanficEvidenceBlocks(options.prose),offset=options.sourceOffset||0;
 const expected=blocks.map(b=>{const lead=b.text.length-b.text.trimStart().length,trail=b.text.length-b.text.trimEnd().length;return {index:b.id,quote:b.text.trim(),start:offset+b.start+lead,end:offset+b.end-trail};});
 const issues=result.map(issue=>{
  if(!Array.isArray(issue?.sourceEvidence)||!issue.sourceEvidence.length||issue.sourceEvidence.length>3||!Array.isArray(issue.evidence)||issue.evidence.length!==issue.sourceEvidence.length)throw new Error('Готовое замечание не содержит проверяемые цитаты и позиции.');
  const evidenceIndices=issue.sourceEvidence.map((e,index)=>{
   if(!e||typeof e.quote!=='string'||!Number.isInteger(e.start)||!Number.isInteger(e.end)||issue.evidence[index]!==e.quote)throw new Error('Цитата готового замечания не совпадает с доказательством.');
   const source=expected.find(b=>b.quote===e.quote&&b.start===e.start&&b.end===e.end);
   if(!source)throw new Error('Цитата или позиция готового замечания устарела.');
   return source.index;
  });
  return {...issue,evidenceIndices};
 });
 return validateFanficReview({issues},options);
}

function acceptedReviewMemories(project,episode){
 const result=[];let blocked=false;
 for(const source of [...(project.episodes||[])].sort(fanficEpisodeOrder)){
  if(fanficEpisodeOrder(source,episode)>=0||source.status!=='approved')continue;
  if(source.needsReview||source.memory?.sourceHash!==hash(source.content)||!String(source.memory?.summary||'').trim()){blocked=true;continue;}
  if(blocked)continue;
  const chunks=source.memory.chunks?.length?source.memory.chunks:[source.memory];
  chunks.forEach((chunk,index)=>result.push({id:source.id+':'+index,episodeId:source.id,title:fanficEpisodeLabel(source),summary:clip(chunk.summary,900),location:clip(chunk.location,240),relationships:(Array.isArray(chunk.relationships)?chunk.relationships:[]).filter(v=>typeof v==='string').slice(0,6).map(v=>clip(v,180)),openThreads:(Array.isArray(chunk.openThreads)?chunk.openThreads:[]).filter(v=>typeof v==='string').slice(0,6).map(v=>clip(v,180)),chronology:result.length}));
 }
 return result;
}
export function fanficReviewReferences({project,episode,context={}}){
 const refs=[],seen=new Set(),warnings=[];
 const add=(ref,score=0)=>{if(!ref.id||seen.has(ref.id))return;seen.add(ref.id);refs.push({...ref,retrievalScore:Number.isFinite(score)?score:0,order:refs.length});};
 const eligible=new Map(eligibleCanonFacts(project,episode).map(f=>[f.id,f]));
 for(const selected of context.facts||[]){
  const fact=eligible.get(selected.id);if(!fact){warnings.push('Неподтверждённый или устаревший источник факта исключён.');continue;}
  add({...canonFactReference(fact),kind:'fact'},selected.retrievalScore);
 }
 const accepted=acceptedReviewMemories(project,episode),memories=new Map(accepted.map(m=>[m.id,m]));
 const requested=context.memories?.length?context.memories:accepted.slice(-8).reverse();
 for(const selected of requested){
  const memory=memories.get(selected.id);if(!memory){warnings.push('Сводка вне принятой хронологии исключена.');continue;}
  add({id:'memory:'+memory.id,kind:'accepted-summary',episodeId:memory.episodeId,title:memory.title,summary:memory.summary,location:memory.location,relationships:memory.relationships,openThreads:memory.openThreads},selected.retrievalScore??(selected.recent?.5:0));
 }
 if(project.canon?.trim())add({id:'project-canon',kind:'author-canon',text:clip(project.canon,1400)},.25);
 for(const card of [...(project.characters||[]),...(project.personas||[])].slice(0,20))add({id:'cast:'+card.id,kind:'card',name:card.name,description:clip(card.description,300),appearance:clip(card.appearance,300)},0);
 const availableLore=new Map();
 for(const book of project.lorebooks||[])for(const entry of book.entries||[])if(entry.enabled!==false&&entry.content?.trim())availableLore.set(book.id+':'+entry.id,{id:book.id+':'+entry.id,content:entry.content,name:entry.name});
 for(const selected of context.lore||[]){const lore=availableLore.get(selected.id);if(lore)add({id:'lore:'+lore.id,kind:'lore',name:lore.name,text:clip(lore.content,600)},selected.retrievalScore??selected.score??0);else warnings.push('Лор вне снимков произведения исключён.');}
 refs.sort((a,b)=>b.retrievalScore-a.retrievalScore||a.order-b.order);
 if(!refs.length)warnings.push('Нет приложенных источников канона: проверка не может подтвердить противоречия прошлым событиям.');
 return {references:refs.map(({retrievalScore,order,...ref})=>ref),warnings:[...new Set(warnings)]};
}

function split(value,size){const parts=[];let start=0;while(start<value.length){let end=Math.min(value.length,start+size);if(end<value.length){const scan=value.slice(start,end),boundary=[...scan.matchAll(/\n\n|[.!?]\s+/g)].at(-1);if(boundary&&boundary.index>size*.5)end=start+boundary.index+boundary[0].length;if(/[\uD800-\uDBFF]/.test(value[end-1]))end--;if(end<=start)end=Math.min(value.length,start+2);}parts.push({text:value.slice(start,end),start});start=end;}return parts;}
export function fanficNumericCandidates(prose,references){
 const amounts=text=>[...String(text).matchAll(/(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s+((?:(?:серебр|золот|медн)\p{L}*\s+)?монет\p{L}*|рубл\p{L}*|доллар\p{L}*|(?:silver |gold |copper )?coins?)(?!\p{L})/giu)].map(m=>({value:Number(m[1].replace(',','.')),unit:m[2].toLocaleLowerCase().replace(/серебр\p{L}*/gu,'серебро').replace(/золот\p{L}*/gu,'золото').replace(/медн\p{L}*/gu,'медь').replace(/монет\p{L}*/gu,'монеты').replace(/рубл\p{L}*/gu,'рубли').replace(/доллар\p{L}*/gu,'доллары').replace(/coins?/gu,'coins')}));
 const blocks=fanficEvidenceBlocks(prose),result=[],seen=new Set();
 for(const reference of references.filter(r=>r.kind==='fact'&&r.subject&&r.sourceQuotations?.length)){
  // These are source-backed candidates for a focused model review, never
  // deterministic verdicts: repayment/new purchases can legitimately change a sum.
  if(!prose.toLocaleLowerCase().includes(reference.subject.toLocaleLowerCase()))continue;
  for(const old of amounts(reference.sourceQuotations.join('\n')))for(const block of blocks)for(const current of amounts(block.text)){
   const key=reference.id+':'+block.id+':'+old.value+':'+current.value;
   if(old.unit!==current.unit||old.value===current.value||seen.has(key))continue;
   seen.add(key);result.push({factId:reference.id,evidenceIndex:block.id,sourceAmount:old.value,currentAmount:current.value,unit:old.unit});if(result.length===8)return result;
  }
 }
 return result;
}
export async function reviewFanficProse({state,project,episode,connection,content=episode.content,range,getSecret,signal,context,structured=structuredCompletion,countTokens=countCompletionTokens,onProgress=()=>{}}){
 const limit=Number(connection.contextWindow)||8192,profile=resolveFanficStageProfile(project.settings,'review',{contextWindow:limit}),maxTokens=Math.min(profile.maxTokens,Math.floor(limit/3));
 const start=range?.start??0,end=range?.end??content.length;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>content.length)throw new Error('Для проверки нужен непустой существующий фрагмент.');
 const source=content.slice(start,end),initial=split(source,Math.max(300,Math.min(6500,Math.floor((limit-maxTokens-700)*1.4)))),parts=[];
 const scoped=fanficReviewReferences({project,episode,context}),allRefs=scoped.references;
 const prepare=async part=>{
  signal?.throwIfAborted();let references=allRefs.slice(0,36),data,messages,actual;
  for(let attempt=0;attempt<40;attempt++){
   data={episode:{season:episode.season,number:episode.number},references,prose:fanficEvidenceBlocks(part.text).map(({id,text})=>({id,text}))};messages=[{role:'system',content:fanficReviewInstructions},{role:'user',content:JSON.stringify(data)}];
   if(messageTokens(messages)+maxTokens+260<=limit){actual=await countTokens(connection,getSecret(connection.id),messages,{signal,adaptInstruction:true,disableThinking:true});if((actual??messageTokens(messages)*1.4)+maxTokens+260<=limit)return [{...part,data,actualTokens:actual,references}];}
   if(references.length>1){references=references.slice(0,-1);continue;}
   if(part.text.length<2)throw new Error('Формат проверки не помещается в контекст модели.');
   const smaller=split(part.text,Math.max(1,Math.floor(part.text.length/2))),ready=[];if(smaller.length===1&&smaller[0].text.length>=part.text.length)throw new Error('Формат проверки с источником канона не помещается в контекст модели.');for(const half of smaller)ready.push(...await prepare({text:half.text,start:part.start+half.start}));return ready;
  }
  throw new Error('Не удалось подобрать контекст проверки связности.');
 };
 for(const part of initial)parts.push(...await prepare(part));
 const issues=[],referenceIds=new Set();let checkedCharacters=0;
 for(let i=0;i<parts.length;i++){
  signal?.throwIfAborted();onProgress(`Проверка связности: ${i+1}/${parts.length}`);
  const part=parts[i],parse=raw=>validateFanficReview(raw,{prose:part.text,sourceOffset:start+part.start,references:part.references});
  const result=await structured({state,chat:{connectionId:connection.id},getSecret,signal,name:'fanfic_review',schema:fanficReviewSchema,maxTokens,temperature:profile.temperature,adaptInstruction:true,instructions:fanficReviewInstructions,context:part.data,parse});
  // Injected adapters must meet the same contract as the production JSON path.
  const normalized=normalizeFanficReviewResult(result,{prose:part.text,sourceOffset:start+part.start,references:part.references});
  for(const issue of normalized)if(!issues.some(e=>e.id===issue.id))issues.push(issue);
  const candidates=fanficNumericCandidates(part.text,part.references).filter(c=>!normalized.some(issue=>issue.type==='number'&&issue.factIds.includes(c.factId)));
  if(candidates.length){
   const ids=new Set(candidates.map(c=>c.factId)),indices=new Set(candidates.map(c=>c.evidenceIndex)),references=part.references.filter(r=>ids.has(r.id)),data={...part.data,references,prose:part.data.prose.filter(b=>indices.has(b.id)),numericCandidates:candidates};
   const instructions=fanficReviewInstructions+' Дополнительная адресная проверка чисел: numericCandidates — пары разных сумм одинаковой валюты из цитат, а не готовые вердикты. Сравни текущую сумму с sourceQuotations указанного factId. Проверь, объяснена ли разница возвратом долга, новой покупкой или иным событием. Если говорится о том же прежнем долге без объяснения перемены, укажи возможное числовое противоречие со ссылкой на цитату и factId. Если смена обоснована или принадлежит другому человеку, верни пустой список. Не изменяй текст и не утверждай ошибку только из-за разных чисел.';
   const messages=[{role:'system',content:instructions},{role:'user',content:JSON.stringify(data)}],actual=await countTokens(connection,getSecret(connection.id),messages,{signal,adaptInstruction:true,disableThinking:true});
   if((actual??messageTokens(messages)*1.4)+maxTokens+260<=limit){
    onProgress(`Проверка числовых расхождений: ${i+1}/${parts.length}`);
    const assessed=await structured({state,chat:{connectionId:connection.id},getSecret,signal,name:'fanfic_review_numbers',schema:fanficReviewSchema,maxTokens,temperature:profile.temperature,adaptInstruction:true,instructions,context:data,parse:raw=>validateFanficReview(raw,{prose:part.text,sourceOffset:start+part.start,references})});
    for(const issue of normalizeFanficReviewResult(assessed,{prose:part.text,sourceOffset:start+part.start,references}))if(!issues.some(e=>e.id===issue.id))issues.push(issue);
   }else scoped.warnings.push('Адресная проверка числовых расхождений не поместилась в окно модели. Проверьте суммы вручную.');
  }
  checkedCharacters+=part.text.length;part.references.forEach(r=>referenceIds.add(r.id));
 }
 return {status:'ready',sourceHash:hash(content),scope:range?'selection':'episode',range:{start,end},issues:issues.slice(0,80),checkedCharacters,totalCharacters:content.length,complete:start===0&&end===content.length,parts:parts.length,referenceIds:[...referenceIds],profile,warnings:scoped.warnings,createdAt:new Date().toISOString()};
}
