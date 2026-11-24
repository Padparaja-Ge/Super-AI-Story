import {cosine} from './embeddings.mjs';
import {archiveMemoryEnabled,archiveMemoryVersion,recallArchive} from './archive-recall.mjs';
import {archiveEncoder} from './chat-archive.mjs';
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

const loreSearch=(value,caseSensitive=false)=>{
  const text=String(value||'').normalize('NFKC').replace(/[\s\p{Pd}]+/gu,' ').trim();
  return caseSensitive?text:text.toLowerCase().replaceAll('ё','е').replaceAll('’',"'");
};
const wordCharacter=/[\p{L}\p{N}]/u;
function keyStrength(keys,scan,caseSensitive){
  let strength=0;
  for(const value of keys||[]){
    const key=loreSearch(value,caseSensitive);
    if(!key)continue;
    const shortLatinAlias=/^[a-z]{2,4}$/i.test(key);
    for(let i=scan.indexOf(key);i>=0;i=scan.indexOf(key,i+key.length)){
      const whole=!wordCharacter.test(scan[i-1]||'')&&!wordCharacter.test(scan[i+key.length]||'');
      // Legacy user-written partial keys remain valid, but lose to precise aliases.
      if(whole||!shortLatinAlias)strength=Math.max(strength,whole?1+Math.min(48,key.length)/12+(key.includes(' ')?1:0):.5);
      if(whole)break;
    }
  }
  return strength;
}

function topicalLore(entry,text){
  const scan=entry.caseSensitive?text.sensitive:text.insensitive;
  const strength=keyStrength(entry.keys,scan,entry.caseSensitive);
  if(entry.selective&&entry.secondaryKeys?.length&&!keyStrength(entry.secondaryKeys,scan,entry.caseSensitive))return 0;
  return strength;
}

function loreScans(value){return {insensitive:loreSearch(value),sensitive:loreSearch(value,true)};}

// The saved work is the only scope. The latest author request or scene beats
// aliases that happen to occur in a long opening brief.
export function selectFanficLore(project,query='',vectorIds=[],{focus=query,vectorScores=new Map()}={}){
  const selected=new Set(vectorIds),result=[],all=loreScans(query),now=loreScans(focus);
  for(const book of project.lorebooks||[])for(const entry of book.entries||[]){
    if(entry.enabled===false||!String(entry.content||'').trim())continue;
    const direct=topicalLore(entry,now),context=topicalLore(entry,all);
    const id=book.id+':'+entry.id,semantic=selected.has(id);
    const reason=entry.constant?'constant':direct?'keyword':semantic?'vector':context?'keyword':null;
    if(reason)result.push({row:{id,book:book.name,name:entry.name,content:entry.content,reason,priority:Number(entry.priority)||0},
      tier:entry.constant?3:direct?2:semantic?1:0,strength:entry.constant?0:direct||(semantic?vectorScores.get(id)||0:context)});
  }
  return result.sort((a,b)=>b.tier-a.tier||b.strength-a.strength||b.row.priority-a.row.priority||a.row.id.localeCompare(b.row.id)).map(item=>item.row);
}

export function fanficCast(project){
  const userName=(project.personas||[]).map(p=>p.name).filter(Boolean).join(', ')||'Читатель';
  const mapped=(cards,role)=>cards.map(card=>{
    const expand=value=>macros(value,card,{userName});
    return {id:card.id,role,name:card.name,description:expand(card.description),appearance:expand(card.appearance),personality:expand(card.personality),
      aliases:card.aliases,scenario:expand(card.scenario),styleReference:expand(card.exampleDialogue),characterInstructions:[card.systemPrompt,card.postHistoryInstructions].filter(Boolean).map(expand),
      additional:(card.blocks||[]).filter(b=>b.enabled!==false).map(b=>({name:b.name,content:expand(b.content)}))};
  });
  return [...mapped(project.characters||[],'character'),...mapped(project.personas||[],'persona')];
}

const normalizedSearch=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();
function literalMentionPosition(query,name){
  name=normalizedSearch(name);if(name.length<2)return Infinity;
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=new RegExp('(?:^|[^\\p{L}\\p{N}])'+escaped+'(?=$|[^\\p{L}\\p{N}])','u').exec(normalizedSearch(query));
  return match?.index??Infinity;
}
const literalMention=(query,name)=>Number.isFinite(literalMentionPosition(query,name));
const russianNameEndings={а:['ы','и','е','у','ой','ою'],я:['и','е','ю','ей','ею'],ь:['я','ю','ем','е'],й:['я','ю','ем','е']};
function cardMentionPosition(query,name){
  const key=normalizedSearch(name),positions=[literalMentionPosition(query,key)];
  if(!/^[а-яё]{4,}$/u.test(key))return positions[0];
  const endings=russianNameEndings[key.at(-1)];
  if(endings)positions.push(...endings.map(ending=>literalMentionPosition(query,key.slice(0,-1)+ending)));
  else if(/[бвгджзклмнпрстфхцчшщ]$/u.test(key))positions.push(...['а','у','ом','е'].map(ending=>literalMentionPosition(query,key+ending)));
  return Math.min(...positions);
}
const cardMention=(query,name)=>Number.isFinite(cardMentionPosition(query,name));
export function rankFanficCast(project,focus,context){
  return fanficCast(project).map(card=>{
    const names=[card.name,...(card.aliases||[])];
    return {card,persona:Number(card.role==='persona'),
      position:Math.min(...names.map(name=>cardMentionPosition(focus,name))),
      contextRank:Number(names.some(name=>cardMention(context,name)))};
  }).sort((a,b)=>b.persona-a.persona
    || (a.position!==b.position?a.position-b.position:0) || b.contextRank-a.contextRank).map(item=>item.card);
}

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
    const aliases=[...new Set([...(card.aliases||[]),...facts.filter(f=>normalizedSearch(f.subject)===normalizedSearch(card.name)).flatMap(f=>f.aliases||[])])].slice(0,12);
    if([card.name,...aliases].some(name=>cardMention(query,name)))participants.push({id:card.id,name:card.name,aliases});
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
  signal?.throwIfAborted();
  const facts=eligibleCanonFacts(project,episode),plan=fanficQueryPlan({project,episode,instructions,currentText,scene,facts}),query=plan.query;
  const settings=project.settings||{},warnings=[],topK=Math.round(clamp(settings.memoryTopK,8,1,30)),threshold=clamp(settings.memoryThreshold,.3,0,1);
  const focus=[instructions,scene?.summary,currentText.slice(-450),episode.brief].find(value=>searchWords(value).length)||query;
  const encode=archiveEncoder(state,embeddings);
  const vectorLore=(project.lorebooks||[]).flatMap(book=>(book.entries||[]).filter(entry=>entry.enabled!==false&&!entry.constant&&String(entry.content||'').trim()&&
    (entry.vectorized||settings.vectorMemory&&entry.vectorWhenMemory))
    .map(entry=>({id:book.id+':'+entry.id,kind:'lore',name:entry.name,source:book.name,content:[book.name,entry.name,entry.content].filter(Boolean).join('\n')})));
  const draftSources=fanficDraftSources(project,episode,currentText),words=plan.terms;
  const draftRanked=draftSources.map(d=>({...d,kind:'draft',lexicalScore:lexicalScore(d.content,words)})).sort((a,b)=>b.lexicalScore-a.lexicalScore||a.start-b.start);
  const draftCandidates=draftRanked.slice(0,24),factCandidates=boundedFactCandidates(facts,plan);
  let selectedDraft=draftRanked.filter(d=>d.lexicalScore>0).slice(0,4),draftScores=new Map();
  const recentIds=new Set([...new Set(memories.map(d=>d.episodeId))].slice(-Math.round(clamp(settings.memoryRecentEpisodes,2,1,10))));
  const recentFactIds=new Set([...new Set(facts.map(d=>d.episodeId))].slice(-Math.round(clamp(settings.memoryRecentEpisodes,2,1,10))));
  let selectedMemory=memories,vectorIds=[],vectorStatus='disabled',scores=new Map();
  const candidates=[...(settings.vectorMemory?memories.map(d=>({id:d.id,kind:'memory',content:[d.summary,d.location,...(d.relationships||[]),...(d.openThreads||[]),...(d.sourceEvidence||[])].filter(Boolean).join('\n')})):[]),...vectorLore,...(settings.vectorMemory?draftCandidates:[]),
    ...(settings.vectorMemory?factCandidates.map(d=>({id:d.id,kind:'fact',content:canonFactText(d)})):[])];
  let archive=[],archiveRecall;
  if(archiveMemoryEnabled(settings)){
    const version=archiveMemoryVersion(settings);
    // The supplied memory list has already checked chronological approval and
    // source hashes. Exclude current/future episodes and any episode that needs
    // review after an edit to its source or to preceding continuity.
    const approvedEpisodes=new Map(memories.map(memory=>[memory.episodeId,memory.title]));
    const documents=(project.episodes||[]).filter(old=>approvedEpisodes.has(old.id)&&old.id!==episode.id)
      .map(old=>({id:'episode:'+old.id,text:old.content,metadata:{kind:'archive',episodeId:old.id,name:approvedEpisodes.get(old.id),...(version===2?{source:approvedEpisodes.get(old.id),season:old.season,number:old.number,index:old.season*10000+old.number}:{})}}));
    const directLore=new Set(selectFanficLore(project,focus).map(entry=>entry.id));
    const vectorLoreIds=new Set(vectorLore.map(candidate=>candidate.id));
    const contextDocuments=version===2
      ? (project.lorebooks||[]).flatMap(book=>(book.entries||[]).filter(entry=>!directLore.has(book.id+':'+entry.id)&&
          vectorLoreIds.has(book.id+':'+entry.id)).map(entry=>({
        id:'lore:'+book.id+':'+entry.id,text:entry.content,metadata:{kind:'lore',referenceId:book.id+':'+entry.id,name:entry.name,source:book.name}
      })))
      : candidates.filter(candidate=>candidate.kind!=='lore'||!directLore.has(candidate.id)).map(candidate=>({
        id:candidate.kind+':'+candidate.id,text:candidate.content,metadata:{kind:candidate.kind,referenceId:candidate.id,name:candidate.name,source:candidate.source}
      }));
    const relatedQuery=[...new Set([episode.brief,currentText.slice(-450),scene?.summary,plan.queries[1],focus].filter(Boolean))].join('\n');
    const staged=await recallArchive({scope:'fanfic:'+project.id,query:focus,relatedQuery,
      recentEvidence:version===2?[]:[currentText.slice(-750),...memories.filter(memory=>recentIds.has(memory.episodeId)).slice(-3).map(memory=>memory.summary)],version,
      documents:[...documents,...contextDocuments],embed:encode,threshold,signal});
    archiveRecall=staged.report;
    if(version===2&&archiveRecall.intent)selectedMemory=[];
    for(const {chunk,finalScore,vectorScore,keywordScore} of staged.results){
      const {kind,referenceId,episodeId,name,start,end}=chunk.metadata;
      if(kind==='archive')archive.push({id:chunk.id,episodeId,title:name,excerpt:chunk.content,start,end,retrievalScore:finalScore,reason:keywordScore?'keyword':'semantic',...(version===2?{evidenceStatus:chunk.metadata.evidenceStatus,evidenceConflict:chunk.metadata.evidenceConflict,season:chunk.metadata.season,number:chunk.metadata.number}:{})});
      else if(kind==='lore'&&vectorScore>=threshold&&vectorScore>0){vectorIds.push(referenceId);scores.set(referenceId,vectorScore);}
      else if(kind==='draft'){
        const source=draftCandidates.find(item=>item.id===referenceId);
        if(source&&!selectedDraft.some(item=>item.id===source.id)){selectedDraft=[source,...selectedDraft].slice(0,4);if(vectorScore)draftScores.set(source.id,vectorScore);}
      }else if(referenceId&&vectorScore)scores.set(referenceId,vectorScore);
    }
    vectorStatus=archiveRecall.vectorStatus;
    warnings.push(...archiveRecall.warnings);
  }else if(candidates.length&&plan.queries.length){
    try{
      if(!encode)throw new Error('Выберите отдельное подключение embeddings в настройках моделей.');
      signal?.throwIfAborted();
      const queries=plan.queries,vectors=await encode([...queries,...candidates.map(d=>d.content)],signal);
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
  const factLimit=Math.max(4,Math.min(24,topK*2)),rankedFacts=facts.filter(fact=>!archiveRecall?.intent||fact.authorConfirmed).map(f=>factRank(f,plan,scores.get(f.id),threshold,recentFactIds.has(f.episodeId)))
    .filter(f=>f.reasons.length).sort((a,b)=>b.retrievalScore-a.retrievalScore||b.chronology-a.chronology);
  const chosenFacts=rankedFacts.slice(0,factLimit).sort((a,b)=>a.chronology-b.chronology);
  const draftIds=new Set(selectedDraft.map(d=>d.id));
  if(draftSources.length){draftIds.add(draftSources[0].id);draftIds.add(draftSources.at(-1).id);}
  const draft=draftSources.filter(d=>draftIds.has(d.id)).map(d=>({...d,retrievalScore:draftScores.get(d.id)??(words.length?lexicalScore(d.content,words)/words.length:0),reason:draftScores.has(d.id)?'vector':d.start===0||d.end===currentText.length?'chronology':'keyword'}));
  const lore=selectFanficLore(project,query,vectorIds,{focus,vectorScores:scores});
  return {archiveEvidence:archiveRecall?.version===2?archiveRecall:undefined,memories:selectedMemory.map(d=>({...d,retrievalScore:scores.get(d.id),recent:recentIds.has(d.episodeId)})),lore,draft,archive,facts:chosenFacts,report:{projectId:project.id,episodeId:episode.id,vectorStatus,threshold,topK,...(archiveRecall?{archiveRecall,selectedArchive:archive.map(({excerpt,...reference})=>reference)}:{}),
    eligibleMemory:memories.length,eligibleFacts:facts.length,factVectorCandidates:settings.vectorMemory?factCandidates.length:0,queryPlan:{queries:plan.queries,participants:plan.participants,terms:plan.terms,intents:plan.intents},
    selectedFacts:chosenFacts.map(({id,episodeId,title,type,subject,predicate,value,reason,reasons,retrievalScore,semanticScore,evidence,authorConfirmed})=>({id,episodeId,title,type,subject,predicate,value,reason,reasons,score:retrievalScore,semanticScore,sourceEvidence:evidence,authorConfirmed})),
    selectedMemory:selectedMemory.map(d=>({id:d.id,episodeId:d.episodeId,title:d.title,reason:recentIds.has(d.episodeId)?'recent':settings.vectorMemory&&vectorStatus==='ready'?'vector':'chronology',score:scores.get(d.id)})),
    selectedLore:lore.map(({content,priority,...d})=>({...d,score:scores.get(d.id)})),selectedDraft:draft.map(({content,retrievalScore,...d})=>({...d,score:retrievalScore})),warnings}};
}

// Compact fields inside complete JSON records; never slice serialized JSON in
// half. Small contexts still retain names, chronology and source identifiers.
const canonicalReference=value=>value&&typeof value==='object'&&!Array.isArray(value)&&(
  value.evidenceStatus==='approved-prose'&&typeof value.excerpt==='string'||
  typeof value.subject==='string'&&(Array.isArray(value.sourceQuotations)||Array.isArray(value.evidence)||typeof value.authorConfirmed==='boolean')
);
function compact(value,limit){
  if(canonicalReference(value))return value;
  if(typeof value==='string')return clip(value,limit);
  if(Array.isArray(value))return value.map(v=>compact(v,Math.max(16,limit/Math.max(1,value.length))));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!==''&&(!Array.isArray(v)||v.length)).map(([key,v])=>[key,['id','episodeId','name','role','title','reason','book'].includes(key)?v:compact(v,limit)]));
  return value;
}
const loreSentences=new Intl.Segmenter('ru',{granularity:'sentence'});
const briefLoreRow=({id,name,content})=>({id,name,content});
function fitLoreRow(row,limit){
  if(JSON.stringify(row).length<=limit)return row;
  let content='';
  for(const {index,segment} of loreSentences.segment(row.content)){
    const next=row.content.slice(0,index+segment.length).trimEnd();
    if(JSON.stringify({...row,content:next}).length>limit)break;
    content=next;
  }
  return content ? {...row,content}:null;
}
function packLoreReferences(entries,cap){
  const firstTopic=entries.findIndex(entry=>entry.reason!=='constant');
  const order=firstTopic>0?[entries[0],entries[firstTopic],...entries.slice(1,firstTopic),...entries.slice(firstTopic+1)]:entries;
  const selected=[];
  let rows=order;
  if(firstTopic>0){
    const firstSentences=values=>values.slice(0,2).map(row=>({...row,content:loreSentences.segment(row.content).containing(0)?.segment.trimEnd()||row.content}));
    let pair=firstSentences(rows);
    if(JSON.stringify(pair).length>cap){rows=order.map(briefLoreRow);pair=firstSentences(rows);}
    if(JSON.stringify(pair).length<=cap){
      selected.push(...pair);
      // Spend extra room on the precise topical entry before expanding the opening rule.
      for(const index of [1,0]){
        const limit=cap-JSON.stringify(selected).length+JSON.stringify(selected[index]).length;
        selected[index]=fitLoreRow(rows[index],limit)||selected[index];
      }
    }
  }
  for(const row of rows.slice(selected.length)){
    const limit=cap-JSON.stringify(selected).length-(selected.length?1:0);
    const packed=fitLoreRow(row,limit);
    if(packed)selected.push(packed);
  }
  return {text:JSON.stringify(selected),ids:selected.map(row=>row.id).filter(Boolean)};
}
export function packReference(value,cap,{tail=false}={}){
  cap=Math.max(2,Math.floor(cap));
  if(!tail&&Array.isArray(value)&&value.length&&value.every(entry=>typeof entry?.book==='string'&&typeof entry?.content==='string'))return packLoreReferences(value,cap);
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

export function packFanficEditorReferences({lore=[],facts=[],archive=[],continuity=[],cast=[]},cap=1500){
  const fields=[['lore',lore,6],['facts',facts,5],['archive',archive,4],['continuity',continuity,2],['cast',cast,2]].filter(([,items])=>items.length);
  const scaffold=Object.fromEntries(fields.map(([key])=>[key,[]]));
  const available=cap-JSON.stringify(scaffold).length;
  if(available<0||!fields.length)return {};
  const totalWeight=fields.reduce((sum,[,,weight])=>sum+weight,0);
  const references={};
  let unused=0;
  const shares=fields.map(([key,items,weight])=>{
    const share=2+Math.floor(available*weight/totalWeight),full=JSON.stringify(items).length;
    unused+=Math.max(0,share-full);
    return {key,items,share,full};
  });
  const hungry=shares.filter(part=>part.full>part.share).length;
  for(const {key,items,share,full} of shares){
    const packed=JSON.parse(packReference(items,share+(full>share?Math.floor(unused/Math.max(1,hungry)):0),{tail:key==='continuity'}).text);
    if(packed.length)references[key]=packed;
  }
  if(Object.keys(references).length)return references;
  for(const [key,items] of fields){
    const share=cap-JSON.stringify({[key]:[]}).length+2;
    const packed=JSON.parse(packReference(items,share,{tail:key==='continuity'}).text);
    if(packed.length)return {[key]:packed};
  }
  return {};
}
