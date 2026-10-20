import {cosine} from './embeddings.mjs';
import {macros} from './prompt.mjs';
import {eligibleCanonFacts,canonFactText} from './fanfic-canon.mjs';

const clamp=(value,fallback,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):fallback));
export const clip=(value,limit,tail=false)=>{
  value=String(value||'');limit=Math.max(0,Math.floor(limit));
  if(!limit)return '';
  if(value.length<=limit)return value;
  if(limit<24)return tail?value.slice(-limit||value.length):value.slice(0,limit);
  return tail?'…'+value.slice(-(limit-1)):value.slice(0,Math.floor(limit*.7))+'\n…\n'+value.slice(-Math.floor(limit*.3)+3);
};

// These are source excerpts from the current draft, not approved continuity.
// They are rebuilt from the exact text on every request and never saved as facts
// for a different episode. This gives long episodes a way to recall their own
// opening or a middle scene instead of presenting only the latest prose tail.
export function fanficDraftSources(project,episode,currentText=''){
  if(currentText.length<=4000)return [];
  const result=[];let start=0;
  while(start<currentText.length){
    let end=Math.min(currentText.length,start+1800);
    if(end<currentText.length){
      const prefix=currentText.slice(start,end),boundary=[...prefix.matchAll(/\n\n|[.!?]\s+/g)].at(-1);
      if(boundary&&boundary.index>900)end=start+boundary.index+boundary[0].length;
      if(/[\uD800-\uDBFF]/.test(currentText[end-1]))end--;
    }
    result.push({id:episode.id+':draft:'+start,episodeId:episode.id,start,end,content:currentText.slice(start,end)});start=end;
  }
  return result;
}
const searchWords=value=>[...new Set(String(value||'').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(word=>!['что','как','для','это','его','она','они','было','были','после','перед','сцена','эпизод','серии','продолжи','текст','который','which','with','from','that','this','their','scene','episode','continue'].includes(word)).slice(0,100);
const lexicalScore=(content,words)=>{const scan=content.toLocaleLowerCase();return words.reduce((total,word)=>total+(scan.includes(word)?1:0),0);};

// Scope comes ONLY from the saved work. Never use a global lore toggle, active
// character, ordinary chat retrieval, or another work's embedding candidates.
export function selectFanficLore(project,query='',vectorIds=[]){
  const selected=new Set(vectorIds),result=[];
  for(const book of project.lorebooks||[])for(const entry of book.entries||[]){
    if(entry.enabled===false||!String(entry.content||'').trim())continue;
    const scan=entry.caseSensitive?query:query.toLocaleLowerCase();
    const match=keys=>(keys||[]).some(key=>String(key).trim()&&scan.includes(entry.caseSensitive?String(key).trim():String(key).trim().toLocaleLowerCase()));
    const keywords=match(entry.keys)&&(!entry.selective||!entry.secondaryKeys?.length||match(entry.secondaryKeys));
    const id=book.id+':'+entry.id;
    const reason=entry.constant?'constant':selected.has(id)?'vector':keywords?'keyword':null;
    if(reason)result.push({id,book:book.name,name:entry.name,content:entry.content,reason,priority:Number(entry.priority)||0});
  }
  return result.sort((a,b)=>Number(b.reason==='constant')-Number(a.reason==='constant')||b.priority-a.priority||a.id.localeCompare(b.id));
}

export function fanficCast(project){
  const userName=(project.personas||[]).map(p=>p.name).filter(Boolean).join(', ')||'Читатель';
  const mapped=(cards,role)=>cards.map(card=>{
    const expand=value=>macros(value,card,{userName});
    return {id:card.id,role,name:card.name,description:expand(card.description),appearance:expand(card.appearance),personality:expand(card.personality),
      scenario:expand(card.scenario),styleReference:expand(card.exampleDialogue),characterInstructions:[card.systemPrompt,card.postHistoryInstructions].filter(Boolean).map(expand),
      additional:(card.blocks||[]).filter(b=>b.enabled!==false).map(b=>({name:b.name,content:expand(b.content)}))};
  });
  return [...mapped(project.characters||[],'character'),...mapped(project.personas||[],'persona')];
}

const normalizedSearch=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();
const literalMention=(query,name)=>{
  name=normalizedSearch(name);if(name.length<2)return false;
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(?:^|[^\\p{L}\\p{N}])'+escaped+'(?=$|[^\\p{L}\\p{N}])','u').test(normalizedSearch(query));
};
export function fanficQueryPlan({project,episode,instructions='',currentText='',scene,facts=[]}){
  const query=clip([clip(episode?.brief,1400),clip(instructions,2200),clip(scene?.summary,1200),currentText.slice(-1200)].filter(Boolean).join('\n'),6000);
  const terms=searchWords([instructions,scene?.summary,episode?.brief,currentText.slice(-700)].filter(Boolean).join('\n'));
  const intentText=normalizedSearch([instructions,scene?.summary,episode?.brief].filter(Boolean).join(' '));
  const intentPatterns={promise:/обещ|обязат|долг|обет|клятв|promise|obligation|\bowe/iu,item:/предмет|вещ|печать|меч|ключ|оруж|инвент|item|possess/iu,
    relationship:/отнош|друж|любов|довер|relationship/iu,injury:/травм|\bран[аыуе]|здоров|injur|wound/iu,
    secret:/парол|шифр|тайн|секрет|password|secret|\bcode/iu,knowledge:/знает|знали|знание|узнал|раскры|вспом|помнит|know|learn|remember/iu,
    location:/\bгде\b|локац|местонах|\bкуда\b|location|\bwhere/iu,event:/событ|случил|произош|event|happen/iu};
  const intents=Object.entries(intentPatterns).filter(([,pattern])=>pattern.test(intentText)).map(([type])=>type);
  const participants=[];
  // Only saved names and explicit source-backed aliases can identify a person;
  // a generic pronoun is never expanded into an arbitrary active character.
  for(const card of [...(project.characters||[]),...(project.personas||[])]){
    const aliases=[...new Set(facts.filter(f=>normalizedSearch(f.subject)===normalizedSearch(card.name)).flatMap(f=>f.aliases||[]))].slice(0,8);
    if([card.name,...aliases].some(name=>literalMention(query,name)))participants.push({id:card.id,name:card.name,aliases});
  }
  for(const fact of facts){
    if(participants.some(p=>[p.name,...p.aliases].some(name=>normalizedSearch(name)===normalizedSearch(fact.subject))))continue;
    const aliases=(fact.aliases||[]).slice(0,8);
    if([fact.subject,...aliases].some(name=>literalMention(query,name)))participants.push({id:'subject:'+fact.subject,name:fact.subject,aliases});
    if(participants.length>=12)break;
  }
  const limited=participants.slice(0,12),queries=query?[query]:[];
  if(facts.length)for(const person of limited.slice(0,3)){
    const specific=clip([person.name,...person.aliases,scene?.summary,instructions||episode?.brief].filter(Boolean).join(' · '),1200);
    if(specific&&queries.every(q=>normalizedSearch(q)!==normalizedSearch(specific)))queries.push(specific);
  }
  return {query,queries:queries.slice(0,4),participants:limited,terms,intents};
}
const factParticipant=(fact,plan)=>plan.participants.some(p=>[p.name,...p.aliases].some(name=>[fact.subject,...(fact.aliases||[])].some(subject=>normalizedSearch(subject)===normalizedSearch(name))));
function factRank(fact,plan,score,threshold,recent){
  const lexical=lexicalScore(canonFactText(fact),plan.terms),participant=factParticipant(fact,plan),semantic=Number.isFinite(score)&&score>=threshold,intent=plan.intents.includes(fact.type);
  const reasons=[];if(lexical)reasons.push('lexical');if(participant)reasons.push('participant');if(semantic)reasons.push('semantic');if(intent&&(participant||!plan.participants.length))reasons.push('intent');if(recent)reasons.push('recent');
  // Exact clues and obligations outrank general similarities. Chronology is a
  // tie-breaker, never a licence to discard an explicitly requested old fact.
  const rank=lexical*2+(participant?3:0)+(semantic?score*4:0)+(intent&&(participant||!plan.participants.length)?3:0)+(recent?.35:0);
  return {...fact,retrievalScore:rank,semanticScore:score,lexicalScore:lexical,reasons,reason:lexical?'lexical':semantic?'semantic':participant?'participant':'recent'};
}
function boundedFactCandidates(facts,plan,cap=256){
  if(facts.length<=cap)return facts;
  const ranked=facts.map(f=>({...f,priority:lexicalScore(canonFactText(f),plan.terms)*4+(factParticipant(f,plan)?2:0)+(plan.intents.includes(f.type)?3:0)})).sort((a,b)=>b.priority-a.priority||b.chronology-a.chronology);
  const ids=new Set(ranked.slice(0,Math.floor(cap*.7)).map(f=>f.id));
  for(const f of facts.slice(-Math.floor(cap*.15)))ids.add(f.id);
  const stride=Math.max(1,Math.floor(facts.length/Math.floor(cap*.15)));
  for(let i=0;i<facts.length&&ids.size<cap;i+=stride)ids.add(facts[i].id);
  for(const f of ranked)if(ids.size<cap)ids.add(f.id);
  return facts.filter(f=>ids.has(f.id)).slice(0,cap);
}
export async function resolveFanficContext({state,project,episode,memories=[],embeddings,signal,instructions='',currentText='',scene}){
  const facts=eligibleCanonFacts(project,episode),plan=fanficQueryPlan({project,episode,instructions,currentText,scene,facts}),query=plan.query;
  const vectorLore=(project.lorebooks||[]).flatMap(book=>(book.entries||[]).filter(e=>e.enabled!==false&&e.vectorized&&!e.constant&&String(e.content||'').trim())
    .map(e=>({id:book.id+':'+e.id,kind:'lore',content:[book.name,e.name,e.content].filter(Boolean).join('\n')})));
  const settings=project.settings||{},warnings=[],topK=Math.round(clamp(settings.memoryTopK,8,1,30)),threshold=clamp(settings.memoryThreshold,.3,0,1);
  const draftSources=fanficDraftSources(project,episode,currentText),words=plan.terms;
  const draftRanked=draftSources.map(d=>({...d,kind:'draft',lexicalScore:lexicalScore(d.content,words)})).sort((a,b)=>b.lexicalScore-a.lexicalScore||a.start-b.start);
  const draftCandidates=draftRanked.slice(0,24),factCandidates=boundedFactCandidates(facts,plan);
  let selectedDraft=draftRanked.filter(d=>d.lexicalScore>0).slice(0,4),draftScores=new Map();
  const recentIds=new Set([...new Set(memories.map(d=>d.episodeId))].slice(-Math.round(clamp(settings.memoryRecentEpisodes,2,1,10))));
  const recentFactIds=new Set([...new Set(facts.map(d=>d.episodeId))].slice(-Math.round(clamp(settings.memoryRecentEpisodes,2,1,10))));
  let selectedMemory=memories,vectorIds=[],vectorStatus='disabled',scores=new Map();
  const candidates=[...(settings.vectorMemory?memories.map(d=>({id:d.id,kind:'memory',content:[d.summary,d.location,...(d.relationships||[]),...(d.openThreads||[]),...(d.sourceEvidence||[])].filter(Boolean).join('\n')})):[]),...vectorLore,...(settings.vectorMemory?draftCandidates:[]),
    ...(settings.vectorMemory?factCandidates.map(d=>({id:d.id,kind:'fact',content:canonFactText(d)})):[])];
  if(candidates.length&&plan.queries.length){
    try{
      if(!embeddings?.vectors)throw new Error('Подключите embedding-модель в настройках моделей.');
      signal?.throwIfAborted();
      const queries=plan.queries,vectors=await embeddings.vectors(state,[...queries,...candidates.map(d=>d.content)],signal);
      if(vectors.length!==candidates.length+queries.length||vectors.some(v=>!Array.isArray(v)||!v.length||v.length!==vectors[0].length||v.some(n=>!Number.isFinite(n))))throw new Error('Embedding-модель вернула неверные векторы.');
      const ranked=candidates.map((d,i)=>({...d,score:Math.max(...queries.map((_,q)=>cosine(vectors[q],vectors[i+queries.length])))})).filter(d=>d.score>=threshold).sort((a,b)=>b.score-a.score);
      ranked.forEach(d=>scores.set(d.id,d.score));
      const memoryIds=new Set(ranked.filter(d=>d.kind==='memory').slice(0,topK).map(d=>d.id));
      if(settings.vectorMemory)selectedMemory=memories.filter(d=>memoryIds.has(d.id)||recentIds.has(d.episodeId));
      vectorIds=ranked.filter(d=>d.kind==='lore').slice(0,topK).map(d=>d.id);
      draftScores=new Map(ranked.filter(d=>d.kind==='draft').map(d=>[d.id,d.score]));
      selectedDraft=ranked.filter(d=>d.kind==='draft').slice(0,4);
      vectorStatus='ready';
    }catch(error){
      if(signal?.aborted)throw error;
      vectorStatus='fallback';warnings.push('Векторная память недоступна; использованы хронологические сводки, точные факты и ключи лорбука. '+error.message);
    }
  }
  const factLimit=Math.max(4,Math.min(24,topK*2)),rankedFacts=facts.map(f=>factRank(f,plan,scores.get(f.id),threshold,recentFactIds.has(f.episodeId)))
    .filter(f=>f.reasons.length).sort((a,b)=>b.retrievalScore-a.retrievalScore||b.chronology-a.chronology);
  const chosenFacts=rankedFacts.slice(0,factLimit).sort((a,b)=>a.chronology-b.chronology);
  const draftIds=new Set(selectedDraft.map(d=>d.id));
  if(draftSources.length){draftIds.add(draftSources[0].id);draftIds.add(draftSources.at(-1).id);}
  const draft=draftSources.filter(d=>draftIds.has(d.id)).map(d=>({...d,retrievalScore:draftScores.get(d.id)??(words.length?lexicalScore(d.content,words)/words.length:0),reason:draftScores.has(d.id)?'vector':d.start===0||d.end===currentText.length?'chronology':'keyword'}));
  const lore=selectFanficLore(project,query,vectorIds);
  return {memories:selectedMemory.map(d=>({...d,retrievalScore:scores.get(d.id),recent:recentIds.has(d.episodeId)})),lore,draft,facts:chosenFacts,report:{projectId:project.id,episodeId:episode.id,vectorStatus,threshold,topK,
    eligibleMemory:memories.length,eligibleFacts:facts.length,factVectorCandidates:settings.vectorMemory?factCandidates.length:0,queryPlan:{queries:plan.queries,participants:plan.participants,terms:plan.terms,intents:plan.intents},
    selectedFacts:chosenFacts.map(({id,episodeId,title,type,subject,predicate,value,reason,reasons,retrievalScore,semanticScore,evidence,authorConfirmed})=>({id,episodeId,title,type,subject,predicate,value,reason,reasons,score:retrievalScore,semanticScore,sourceEvidence:evidence,authorConfirmed})),
    selectedMemory:selectedMemory.map(d=>({id:d.id,episodeId:d.episodeId,title:d.title,reason:recentIds.has(d.episodeId)?'recent':settings.vectorMemory&&vectorStatus==='ready'?'vector':'chronology',score:scores.get(d.id)})),
    selectedLore:lore.map(({content,priority,...d})=>({...d,score:scores.get(d.id)})),selectedDraft:draft.map(({content,retrievalScore,...d})=>({...d,score:retrievalScore})),warnings}};
}

// Compact fields inside complete JSON records; never slice serialized JSON in
// half. Small contexts still retain names, chronology and source identifiers.
const canonicalReference=value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.subject==='string'&&(Array.isArray(value.sourceQuotations)||Array.isArray(value.evidence)||typeof value.authorConfirmed==='boolean');
function compact(value,limit){
  if(canonicalReference(value))return value;
  if(typeof value==='string')return clip(value,limit);
  if(Array.isArray(value))return value.map(v=>compact(v,Math.max(16,limit/Math.max(1,value.length))));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!==''&&(!Array.isArray(v)||v.length)).map(([key,v])=>[key,['id','episodeId','name','role','title','reason','book'].includes(key)?v:compact(v,limit)]));
  return value;
}
export function packReference(value,cap,{tail=false}={}){
  cap=Math.max(2,Math.floor(cap));
  // Exact canon evidence is atomic: a missing quote is safer than a changed
  // quotation that appears to support a different promise, number or secret.
  if(Array.isArray(value)&&value.some(canonicalReference)){
    const prioritized=[...value].sort((a,b)=>(b.retrievalScore??0)-(a.retrievalScore??0)),kept=new Set();
    for(const item of prioritized){const candidate=value.filter(v=>kept.has(v)||v===item);if(JSON.stringify(candidate).length<=cap)kept.add(item);}
    const result=value.filter(v=>kept.has(v));return {text:JSON.stringify(result),ids:result.map(d=>d.id).filter(Boolean)};
  }
  let chosen=value;
  if(Array.isArray(value)){
    const count=Math.max(1,Math.floor(cap/200));chosen=tail?value.slice(-count):value.slice(0,count);
    if(tail&&value.some(d=>d?.retrievalScore!==undefined)&&value.length>count){
      const ids=new Set(value.slice(-Math.min(2,count)).map(d=>d.id));
      for(const doc of [...value].sort((a,b)=>(b.retrievalScore??-1)-(a.retrievalScore??-1)))if(ids.size<count)ids.add(doc.id);
      chosen=value.filter(d=>ids.has(d.id));
    }
  }
  let result=chosen,serialized=JSON.stringify(result),size=Math.max(16,cap/Math.max(1,Array.isArray(chosen)?chosen.length:1));
  while(serialized.length>cap&&size>8){result=compact(chosen,Math.floor(size));serialized=JSON.stringify(result);size*=.7;}
  while(serialized.length>cap&&Array.isArray(result)&&result.length){result=tail?result.slice(1):result.slice(0,-1);serialized=JSON.stringify(result);}
  if(serialized.length>cap){result={};serialized='{}';}
  return {text:serialized,ids:Array.isArray(result)?result.map(d=>d.id).filter(Boolean):[]};
}
