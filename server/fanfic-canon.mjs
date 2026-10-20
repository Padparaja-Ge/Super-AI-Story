import {createHash} from 'node:crypto';
import {fanficEpisodeOrder,fanficEpisodeLabel} from '../shared/fanfic.mjs';
import {normalizeCanonFactDraft,fanficFactLimits} from '../shared/fanfic-canon.mjs';
export const canonFactSourceHash=value=>createHash('sha256').update(String(value||'')).digest('hex');
const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();
function explicitAlias(source,subject,alias){
  const escape=value=>normalized(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const name=escape(subject),other=escape(alias),scan=normalized(source);
  const patterns=[name+'\\s*[,—–-]?\\s*(?:также\\s+)?(?:извест[\\p{L}]*\\s+как|known\\s+as)\\s+[«"(]*'+other,
    name+'.{0,30}(?:прозвище|nickname|nicknamed|\\baka\\b|alias)\\s*[:—–-]?\\s*[«"(]*'+other,
    name+'\\s*\\([«"]?'+other+'[»"]?\\)',name+'\\s*[,—–-]?\\s*(?:также\\s+)?(?:зовут|звали|называют|called)\\s*[«"]?'+other];
  return patterns.some(pattern=>new RegExp(pattern,'u').test(scan));
}

export function fanficEvidenceBlocks(prose){
  prose=String(prose||'');let offset=0;
  return (prose.match(/[\s\S]+?(?:[.!?](?:\s+|$)|\n\n|$)/g)||[prose]).filter(Boolean).map((text,index)=>{const start=offset;offset+=text.length;return {id:index+1,text,start,end:offset};});
}
function quoteAt(block,sourceOffset){
  const lead=block.text.length-block.text.trimStart().length,trail=block.text.length-block.text.trimEnd().length;
  return {index:block.id,quote:block.text.trim(),start:sourceOffset+block.start+lead,end:sourceOffset+block.end-trail};
}
const identity=(context,fact,evidence)=>createHash('sha256').update(JSON.stringify([context.projectId,context.episodeId,context.chunkIndex||0,fact.type,fact.subject,fact.predicate,fact.value,evidence])).digest('hex').slice(0,24);
// IDs/quotes/offsets/hash are stamped by the server; model-supplied identity and
// provenance are never trusted. Copy-based values make fabricated exact clues
// fail safely instead of silently becoming persistent canon.
export function validateCanonExtraction(rawFacts,{prose='',projectId,episodeId,sourceHash,chunkIndex=0,sourceOffset=0}={}){
  if(rawFacts===undefined)return {facts:[],rejected:[]};
  if(!Array.isArray(rawFacts))return {facts:[],rejected:[{index:-1,reason:'facts must be an array'}]};
  if(!projectId||!episodeId||!sourceHash)throw new Error('Для фактов нужны идентификаторы произведения, серии и хеш исходного текста.');
  if(!Number.isInteger(chunkIndex)||chunkIndex<0||!Number.isInteger(sourceOffset)||sourceOffset<0)throw new Error('Неверная позиция исходной части памяти.');
  const blocks=fanficEvidenceBlocks(prose),facts=[],rejected=[],seen=new Set();
  for(let index=0;index<rawFacts.length;index++){
    if(index>=fanficFactLimits.perExtraction){rejected.push({index,reason:'extraction limit'});continue;}
    const value=rawFacts[index];
    try{
      const fact=normalizeCanonFactDraft(value),indices=value.sourceIndices;
      if(!Array.isArray(indices)||!indices.length||indices.length>fanficFactLimits.evidence||indices.some(i=>!Number.isInteger(i)||i<1||i>blocks.length))throw new Error('invalid source sentence IDs');
      const evidence=[...new Set(indices)].map(i=>quoteAt(blocks[i-1],sourceOffset));
      if(value.evidence!==undefined||value.quote!==undefined)throw new Error('model supplied provenance');
      const source=normalized(evidence.map(e=>e.quote).join(' '));
      if(!source.includes(normalized(fact.value)))throw new Error('value is not an exact source phrase');
      if(!source.includes(normalized(fact.subject)))throw new Error('subject is not present in evidence');
      if(!evidence.some(e=>normalized(e.quote).includes(normalized(fact.subject))&&normalized(e.quote).includes(normalized(fact.value))))throw new Error('subject and value need the same source sentence');
      fact.aliases=fact.aliases.filter(alias=>explicitAlias(source,fact.subject,alias));
      const id=identity({projectId,episodeId,chunkIndex},fact,evidence);
      if(seen.has(id))continue;seen.add(id);
      facts.push({...fact,id,projectId,episodeId,sourceHash,sourcePartHash:canonFactSourceHash(prose),chunkIndex,evidence,authorConfirmed:false});
    }catch(error){rejected.push({index,reason:error.message});}
  }
  return {facts,rejected};
}
export function confirmCanonFactDraft(value,{project,episode,chunkIndex=0,existing}={}){
  if(!project?.id||!episode?.id||!Number.isInteger(chunkIndex)||chunkIndex<0)throw new Error('Нужна текущая серия и часть памяти.');
  const fact=normalizeCanonFactDraft(value),sourceHash=canonFactSourceHash(episode.content);
  const evidence=(existing?.evidence||[]).filter(e=>Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=0&&e.end>e.start&&episode.content.slice(e.start,e.end)===e.quote).map(e=>({...e}));
  const context={projectId:project.id,episodeId:episode.id,chunkIndex};
  return {...fact,id:existing?.id||identity(context,fact,evidence),...context,sourceHash,evidence,authorConfirmed:true};
}
// Model labels are search hints, not an independently verified relation.
// Full source quotations retain negation and who owns/knows a clue.
export function canonFactReference(fact){
  const common={id:fact.id,episodeId:fact.episodeId,title:fact.title,type:fact.type,subject:fact.subject,chronology:fact.chronology,retrievalScore:fact.retrievalScore,authorConfirmed:fact.authorConfirmed===true};
  return fact.authorConfirmed===true?{...common,predicate:fact.predicate,value:fact.value}:{...common,sourceQuotations:(fact.evidence||[]).map(e=>e.quote)};
}
export function canonFactText(fact){return [fact.type,fact.subject,...(fact.aliases||[]),...(fact.authorConfirmed===true?[fact.predicate,fact.value]:(fact.evidence||[]).map(e=>e.quote))].filter(Boolean).join(' · ');}
export function eligibleCanonFacts(project,beforeEpisode){
  if(!project?.id)return [];
  const episodes=[...(project.episodes||[])].sort(fanficEpisodeOrder),result=[],seen=new Set();let blocked=false;
  for(const episode of episodes){
    if(beforeEpisode&&fanficEpisodeOrder(episode,beforeEpisode)>=0)continue;
    if(episode.status!=='approved')continue;
    const hash=canonFactSourceHash(episode.content);
    if(episode.needsReview||episode.memory?.sourceHash!==hash||!String(episode.memory?.summary||'').trim()){blocked=true;continue;}
    if(blocked)continue;
    const parts=episode.memory.chunks?.length?episode.memory.chunks:[episode.memory];
    for(let chunkIndex=0;chunkIndex<parts.length;chunkIndex++){
      for(const value of (Array.isArray(parts[chunkIndex].facts)?parts[chunkIndex].facts:[]).slice(0,fanficFactLimits.perExtraction)){
        try{
          if(!value.id||seen.has(value.id)||value.projectId!==project.id||value.episodeId!==episode.id||value.sourceHash!==hash||value.chunkIndex!==chunkIndex)continue;
          const fact=normalizeCanonFactDraft(value),evidence=value.evidence;
          if(!Array.isArray(evidence)||evidence.length>fanficFactLimits.evidence||evidence.some(e=>!Number.isInteger(e.index)||e.index<1||!Number.isInteger(e.start)||!Number.isInteger(e.end)||e.start<0||e.end<=e.start||typeof e.quote!=='string'||episode.content.slice(e.start,e.end)!==e.quote))continue;
          if(value.authorConfirmed!==true){
            const source=normalized(evidence.map(e=>e.quote).join(' '));
            if(!evidence.length||!evidence.some(e=>normalized(e.quote).includes(normalized(fact.subject))&&normalized(e.quote).includes(normalized(fact.value))))continue;
            fact.aliases=fact.aliases.filter(alias=>explicitAlias(source,fact.subject,alias));
          }
          seen.add(value.id);result.push({...fact,id:value.id,projectId:project.id,episodeId:episode.id,sourceHash:hash,chunkIndex,evidence:evidence.map(e=>({...e})),authorConfirmed:value.authorConfirmed===true,title:fanficEpisodeLabel(episode),season:episode.season,number:episode.number,chronology:result.length});
        }catch{}
      }
    }
  }
  return result;
}
export function validateCanonManualFacts(list,{prose='',projectId,episodeId,sourceHash,chunkIndex=0,sourceOffset=0,existingFacts=[]}={}){
  const fail=message=>Object.assign(new Error(message),{status:400});
  if(!projectId||!episodeId||!sourceHash||!Number.isInteger(chunkIndex)||chunkIndex<0||!Number.isInteger(sourceOffset)||sourceOffset<0)throw fail('Неверная серия или позиция исходной части памяти.');
  if(!Array.isArray(list)||list.length>fanficFactLimits.perExtraction)throw fail('Укажите не более 12 фактов для одной части памяти.');
  const blocks=fanficEvidenceBlocks(prose),seen=new Set();
  return list.map(value=>{
    let fact;try{fact=normalizeCanonFactDraft(value);}catch(error){throw fail(error.message);}
    const existing=value.id?existingFacts.find(f=>f.id===value.id&&f.projectId===projectId&&f.episodeId===episodeId&&f.sourceHash===sourceHash&&f.chunkIndex===chunkIndex):null;
    if(value.id&&!existing)throw fail('Факт больше не принадлежит текущей части памяти. Обновите список.');
    let evidence=[];
    if(existing){
      evidence=(existing.evidence||[]).map(e=>({...e}));
      if(evidence.some(e=>!Number.isInteger(e.start)||!Number.isInteger(e.end)||e.start<sourceOffset||e.end<=e.start||prose.slice(e.start-sourceOffset,e.end-sourceOffset)!==e.quote))throw fail('Исходная цитата факта устарела. Создайте память заново.');
    }else if(value.sourceIndices!==undefined){
      if(!Array.isArray(value.sourceIndices)||!value.sourceIndices.length||value.sourceIndices.length>fanficFactLimits.evidence||value.sourceIndices.some(i=>!Number.isInteger(i)||i<1||i>blocks.length))throw fail('Неверные номера исходных предложений факта.');
      evidence=[...new Set(value.sourceIndices)].map(i=>quoteAt(blocks[i-1],sourceOffset));
    }
    const id=existing?.id||identity({projectId,episodeId,chunkIndex},fact,evidence);
    if(seen.has(id))throw fail('В части памяти повторяется один и тот же факт.');seen.add(id);
    return {...fact,id,projectId,episodeId,sourceHash,sourcePartHash:canonFactSourceHash(prose),chunkIndex,evidence,authorConfirmed:true};
  });
}
