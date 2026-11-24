import {setImmediate as yieldToIO} from 'node:timers/promises';
import {rerankResults} from './rag/search.mjs';
import {archiveEvidencePolicy,evidenceSpans} from './archive-evidence.mjs';

const maxExcerptChars = 650;
const maxExcerpts = 3;
const maxSemanticCandidates = 24;
const maxCandidatesPerTerm = 4;
const minimumQueryTermLength = 3;
const normalizeLine = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const ignored = new Set(('what where when which which how who that this have some could would should please again tell remind what happened ' +
  'что где когда какой какая какое какие кого кому как кто это эта этот эти ещё уже было были может можно мог могли куда было было бы ' +
  'покажи расскажи вспомни напомни посмотри спроси хочу хотим пойдём зачем почему после перед сейчас него неё они его себя нас том там здесь').split(/\s+/u));
const explicitRecall = /вспом|напомн|ранее|раньше|прежн|помни|до этого|прошл|когда-то|\b(?:remember|recall|earlier|previously|remind|before|back then)\b|覚え|以前|前回|还记得|记得|之前|回忆|기억|이전/iu;
const russianEnding = /(?:иями|ями|ами|ого|ему|ому|ыми|ими|ство|иях|иях|ией|иям|иях|ах|ях|ой|ый|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ам|ям|ов|ев|ей|ую|ям|ию|ии|ия|ою|ою|а|о|у|е|ы|и|я|ю)$/u;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function searchTerms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
  const words = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    ? [...wordSegmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment)
    : text.match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words.filter(word => !ignored.has(word) &&
    (word.length >= minimumQueryTermLength || /^\d+$/u.test(word) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u.test(word)))
    .map(word => /^[а-я]{5,}$/u.test(word) ? word.replace(russianEnding, '') : word))];
}

function rightBoundary(text, initial, start) {
  if (initial >= text.length) return text.length;
  const previous = text.slice(start, initial);
  const split = [...previous.matchAll(/[.!?。！？\n]\s*|\s+/gu)].at(-1);
  if (split && split.index >= maxExcerptChars * .6) return start + split.index + split[0].length;
  return /[\uD800-\uDBFF]/u.test(text[initial - 1]) ? initial - 1 : initial;
}

function* archiveChunks(documents, scope, excluded, verified) {
  for (const [index, doc] of documents.entries()) {
    if (!doc?.id || excluded.has(doc.id) || (doc.metadata?.scope&&doc.metadata.scope!==scope) || typeof doc.text !== 'string' || !doc.text.trim()) continue;
    if (verified) {
      for (const {start,end,status} of evidenceSpans(doc.text,doc.metadata||{},maxExcerptChars)) {
        yield {id:doc.id+':'+start,content:doc.text.slice(start,end),metadata:{
          type:'lore',source:doc.source||'',tags:[],...doc.metadata,scope,documentId:doc.id,
          index:doc.metadata?.index??index,start,end,evidenceStatus:status,
        }};
      }
      continue;
    }
    for (let start = 0; start < doc.text.length;) {
      const end = rightBoundary(doc.text, start + maxExcerptChars, start);
      const content = doc.text.slice(start, end);
      if (content.trim()) yield {
        id: doc.id + ':' + start,
        content,
        metadata: {
          type: 'lore', source: doc.source || '', tags: [], ...doc.metadata,
          documentId: doc.id, scope, index: doc.metadata?.index ?? index, start, end,
        },
      };
      if (end === doc.text.length) break;
      start = Math.max(start + 1, end - 70);
      if (/[\uDC00-\uDFFF]/u.test(doc.text[start])) start++;
    }
  }
}

function queryTerms(query) {
  return searchTerms(query).slice(-24);
}
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const unresolvedEvidence = [
  /[?？]/u,
  /(?:^|[^\p{L}])(?:не\s+(?:зна\p{L}*|извест\p{L}*|ясно|установ\p{L}*|подтвержд\p{L}*|выясн\p{L}*)|неизвест\p{L}*|неясно)(?=$|[^\p{L}])/iu,
  /\b(?:unknown|unconfirmed|unclear|undetermined|(?:doesn['’]t|don['’]t|didn['’]t|does not|do not|did not) know)\b/iu,
  /\b(?:nobody|no one)[^.!?]{0,45}\bknow(?:s|n)?\b/iu,
  /不明|不知道|未確認|分からない|모른|몰라/u,
];
function isCovered(terms, recentEvidence, query) {
  if (terms.length < 2 || !explicitRecall.test(query)) return false;
  // Co-occurrence alone is insufficient: the same sentence may ask the
  // question or state that the answer is still unknown.
  return recentEvidence.some(text => [...sentenceSegmenter.segment(text)].some(({segment}) => {
    if (unresolvedEvidence.some(pattern => pattern.test(segment))) return false;
    const words = new Set(searchTerms(segment));
    return words.size >= terms.length + 2 && terms.every(term => words.has(term));
  }));
}
function evidenceWeight({metadata,content}) {
  if (metadata.role!=='user'||metadata.messageKind==='engine'||metadata.characterId) return 1;
  return /[?？]|напомни|вспомни|спрашивает|\b(?:remind|remember)\b/iu.test(content) ? .42 : .75;
}
function chunkTerms(chunk) {
  return new Set(searchTerms([chunk.metadata.name, chunk.content].filter(Boolean).join(' ')));
}
function normalizedCosine(left, right) {
  const leftScale = Math.max(...left.map(Math.abs)), rightScale = Math.max(...right.map(Math.abs));
  let dot=0,leftSquared=0,rightSquared=0;
  for(let index=0;index<left.length;index++){
    const a=left[index]/leftScale,b=right[index]/rightScale;
    dot+=a*b;leftSquared+=a*a;rightSquared+=b*b;
  }
  return Math.max(0,Math.min(1,dot/Math.sqrt(leftSquared*rightSquared)));
}
function validVectors(vectors, count) {
  return Array.isArray(vectors) && vectors.length === count && vectors.every(vector =>
    Array.isArray(vector) && vector.length > 0 && vector.length <= 16384 && vector.length === vectors[0].length &&
    vector.every(Number.isFinite) && vector.some(value => value !== 0));
}
const scoreOrder = (a, b) => b.keywordScore - a.keywordScore || b.chunk.metadata.index - a.chunk.metadata.index;
function retainPerTerm(index, frequencies, terms, item, order) {
  for (const term of terms) {
    frequencies.set(term, (frequencies.get(term) || 0) + 1);
    const candidates = index.get(term) || [];
    candidates.push(item);
    if (candidates.length > maxCandidatesPerTerm) candidates.sort(order).pop();
    index.set(term, candidates);
  }
}
const bestPerDocument = (ranked, limit) => {
  const result = [], seen = new Set();
  for (const item of ranked) {
    const documentId = item.chunk.metadata.documentId;
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
};
function chooseCandidates(lexical, related, sample) {
  const selected = new Map();
  const vectorized = list => list.filter(item => item.chunk.metadata.vectorized !== false);
  for (const group of [bestPerDocument(vectorized(lexical), 16), bestPerDocument(vectorized(related), 8), sample]) {
    for (const item of group) {
      if (selected.size >= maxSemanticCandidates) return [...selected.values()];
      selected.set(item.chunk.id, item);
    }
  }
  return [...selected.values()];
}
function compactQuery(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, Math.floor(limit * .6)) + ' … ' + text.slice(-Math.floor(limit * .4) + 3);
}

export function archiveMemoryVersion(settings) {
  return settings?.archiveMemoryVersion===2 ? 2 : 1;
}

export function archiveMemoryEnabled(settings) {
  return settings?.archiveMemory === true && settings?.vectorMemory === true;
}

/**
 * The caller supplies documents and recent confirmed evidence from exactly one
 * history. This never passes an entire archive to the generation model or asks
 * another generation model to prepare a search. Only a bounded shortlist can
 * reach the existing embedding connection. The lexical scan covers every
 * original chunk, including stretches with no saved summary.
 */
export async function recallArchive({ scope, query, relatedQuery = '', recentEvidence = [], documents = [], exclude = [], scene = {}, embed, threshold = .35, version = 1, signal }) {
  signal?.throwIfAborted();
  if (typeof scope !== 'string' || !scope.trim()) throw new Error('Поиск по архиву требует выбранной истории.');
  const primary = compactQuery(String(query || '').trim(), 1050);
  const anchors = queryTerms(primary);
  const alternative = compactQuery(String(relatedQuery || '').trim(), 850);
  const relatedTerms = embed ? queryTerms(alternative).filter(term => !anchors.includes(term)) : [];
  threshold=Number.isFinite(threshold)?Math.max(0,Math.min(1,threshold)):.35;
  const report = { scope, stage: 'no-query', scanned: 0, candidates: 0, embeddingPasses: 0, vectorStatus: 'disabled', warnings: [] };
  const verified=version===2;
  const policy=verified?archiveEvidencePolicy(primary,searchTerms):null;
  if (verified) Object.assign(report,{version:2,passes:[],intent:policy.intent,needsEvidence:!!primary&&(policy.targeted||explicitRecall.test(primary)||/[?？]/u.test(primary))});
  if (!primary) return { results: [], report };
  const confirmedRecent=verified ? recentEvidence.flatMap(text=>
    [...evidenceSpans(text,{kind:'source',role:'assistant'},maxExcerptChars)].map(({start,end})=>text.slice(start,end))) : recentEvidence;
  if (!policy?.targeted && isCovered(anchors, confirmedRecent, primary)) return { results: [], report: { ...report, stage: 'recent' } };

  const excluded = new Set(exclude), lexical = [], related = [], sample = [];
  const relatedOrder = (a, b) => b.relatedScore - a.relatedScore || scoreOrder(a, b);
  let sampleStride = 1, previous;
  const reserve=[];
  const frequencies = new Map(), byTerm = new Map(), relatedFrequencies = new Map(), relatedByTerm = new Map();
  const normalizedRequest=normalizeLine(primary);
  for (const chunk of archiveChunks(documents, scope, excluded,verified)) {
    signal?.throwIfAborted();
    const position = report.scanned++;
    if (position>0 && position%256===0) await yieldToIO(undefined,{signal});
    if(evidenceWeight(chunk)<.5 && normalizeLine(chunk.content)===normalizedRequest)continue;
    const words = chunkTerms(chunk), weight = evidenceWeight(chunk);
    const matched = anchors.filter(term => words.has(term));
    const item = { chunk, keywordScore:matched.length * weight / Math.max(1, anchors.length), vectorScore: 0, finalScore: 0, position };
    if(verified){
      if(!policy.allowed(item))continue;
      policy.claim(item);
      // Keep a separate spread through the archive and links to immediate
      // eligible neighbours. Neighbours store no links of their own.
      const link={...item};
      if(previous){
        item.before=previous.link;
        previous.item.after=link;
      }
      previous={item,link};
      if(chunk.metadata.vectorized!==false){
        const priority=(Math.imul(position+1,0x9e3779b1)>>>0);
        reserve.push({item,priority});
        if(reserve.length>64)reserve.sort((a,b)=>a.priority-b.priority).pop();
      }
    }
    if (matched.length) {
      lexical.push(item);
      if (lexical.length > 96) lexical.sort(scoreOrder).splice(48);
      // Preserve rare anchors until their frequency across the whole archive is known.
      retainPerTerm(byTerm, frequencies, matched, item, scoreOrder);
    }
    if (chunk.metadata.vectorized !== false && relatedTerms.length) {
      const contextMatches = relatedTerms.filter(term => words.has(term));
      if (contextMatches.length) {
        item.relatedScore = contextMatches.length * weight;
        related.push(item);
        if (related.length > 48) related.sort(relatedOrder).splice(24);
        retainPerTerm(relatedByTerm, relatedFrequencies, contextMatches, item, relatedOrder);
      }
    }
    if (chunk.metadata.vectorized !== false && position % sampleStride === 0) {
      sample.push(item);
      if (sample.length > maxSemanticCandidates) {
        sampleStride *= 2;
        for (let i = sample.length - 1; i >= 0; i--) if (sample[i].position % sampleStride !== 0) sample.splice(i, 1);
      }
    }
  }
  if (!report.scanned) return { results: [], report: { ...report, stage: 'empty', ...(verified?{evidence:'unknown'}:{}) } };
  const rarity = (counts, term) => {
    const count = counts.get(term) || 0;
    return Math.log(1 + (report.scanned - count + .5) / (count + .5));
  };
  const maxRarity = Math.max(1, ...anchors.map(term => rarity(frequencies, term)));
  const preserved = [...new Set([...lexical, ...[...byTerm.values()].flat()])];
  const contextCandidates = [...new Set([...related, ...[...relatedByTerm.values()].flat()])];
  for (const item of new Set([...preserved, ...sample, ...contextCandidates])) {
    if (item.keywordScore === 0 && !item.relatedScore) continue;
    const words = chunkTerms(item.chunk), weight = evidenceWeight(item.chunk);
    if (item.keywordScore > 0) {
      const weighted = anchors.reduce((sum, term) => sum + (words.has(term) ? rarity(frequencies, term) : 0), 0);
      item.keywordScore = .6 * item.keywordScore + .4 * weighted * weight / (Math.max(1, anchors.length) * maxRarity);
    }
    if (item.relatedScore) {
      item.relatedScore = relatedTerms.reduce((sum, term) => sum + (words.has(term) ? rarity(relatedFrequencies, term) : 0), 0) * weight;
    }
  }
  preserved.sort(scoreOrder);
  contextCandidates.sort(relatedOrder);
  if(verified){
    return recallVerifiedArchive({policy,report,primary,alternative,preserved,contextCandidates,sample,
      reserve:reserve.sort((a,b)=>a.priority-b.priority).map(entry=>entry.item),embed,threshold,signal,scene});
  }
  const candidates = chooseCandidates(preserved, contextCandidates, sample);
  report.stage = 'keyword';
  report.candidates = candidates.length;
  if (embed && candidates.length) {
    try {
      const texts = candidates.map(item => item.chunk.content);
      report.embeddingPasses++;
      const vectors = await embed([primary, ...texts], signal);
      signal?.throwIfAborted();
      if (!validVectors(vectors, texts.length + 1)) throw new Error('Embedding-модель вернула неверные векторы.');
      const scoreWith = vector => candidates.forEach((item, index) => {
        const score = normalizedCosine(vector, vectors[index + 1]) * evidenceWeight(item.chunk);
        if (score >= threshold) item.vectorScore = Math.max(item.vectorScore, score);
      });
      scoreWith(vectors[0]);
      report.vectorStatus = 'ready';
      report.stage = 'semantic';
      // Keep the second pass query-only. Document vectors have already been
      // computed, and there is no reason to repeat work for confident matches.
      if (alternative && alternative !== primary && !candidates.some(item => item.vectorScore >= Math.max(.55, threshold + .14) || item.keywordScore >= .55)) {
        report.embeddingPasses++;
        const extra = await embed([alternative], signal);
        signal?.throwIfAborted();
        if (!validVectors(extra, 1) || extra[0].length !== vectors[0].length) throw new Error('Embedding-модель вернула неверный вектор уточнения.');
        scoreWith(extra[0]);
        report.stage = 'refined';
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError' || error?.name === 'CanceledError') throw error;
      if (report.vectorStatus === 'ready') report.refinementFailed = true;
      else {
        report.warnings.push('Векторный поиск архива недоступен. Использованы найденные по словам выдержки.');
        report.vectorStatus = 'fallback';
        report.stage = 'keyword';
      }
    }
  } else if (!embed) {
    report.vectorStatus = 'fallback';
    report.warnings.push('Для векторного поиска архива выберите подключение embeddings.');
  }
  const highestSimilarity = Math.max(0, ...candidates.map(item => item.vectorScore));
  // Drop weak semantic-only neighbours when the encoder found a much closer passage.
  const acceptedSimilarity = Math.max(threshold, highestSimilarity - .16);
  const topical = new Map();
  for (const item of [...candidates, ...preserved]) {
    if (item.keywordScore <= 0 && (item.vectorScore <= 0 || item.vectorScore < acceptedSimilarity)) continue;
    const previous = topical.get(item.chunk.id);
    if (!previous || previous.vectorScore < item.vectorScore) topical.set(item.chunk.id, item);
  }
  const ranked = rerankResults([...topical.values()], [], scene).sort((a, b) => b.finalScore - a.finalScore || scoreOrder(a, b));
  return { results: bestPerDocument(ranked, maxExcerpts), report };
}



async function recallVerifiedArchive({policy,report,primary,alternative,preserved,contextCandidates,sample,reserve,embed,threshold,signal,scene}) {
  const attempted=new Set(), attemptedText=new Set(), evaluated=[];
  let primaryVector;
  const distinct=(rows,limit,perDocument)=>{
    const batch=[], seen=new Set(attemptedText), docs=new Map();
    for(const item of rows){
      const {documentId,vectorized}=item.chunk.metadata;
      const key=normalizeLine(item.chunk.content), count=docs.get(documentId)||0;
      if(attempted.has(item.chunk.id)||seen.has(key)||vectorized===false||count>=perDocument)continue;
      batch.push({item,key});
      seen.add(key);
      docs.set(documentId,count+1);
      if(batch.length>=limit)break;
    }
    return batch;
  };
  async function run(stage,rows,limit){
    const batch=distinct(rows,limit,stage==='deep'?3:2);
    if(!batch.length)return;
    const search=stage==='context'&&alternative&&alternative!==primary?alternative:null;
    const queries=primaryVector?(search?[search]:[]):[primary];
    report.embeddingPasses++;
    report.passes.push({stage,candidates:batch.length});
    for(const {item,key} of batch){attempted.add(item.chunk.id);attemptedText.add(key);}
    const vectors=await embed([...queries,...batch.map(({item})=>item.chunk.content)],signal);
    signal?.throwIfAborted();
    if(!validVectors(vectors,queries.length+batch.length)||(primaryVector&&primaryVector.length!==vectors[0].length))throw new Error('Embedding-модель вернула неверные векторы.');
    primaryVector??=vectors[0];
    batch.forEach(({item},index)=>{
      const vector=vectors[queries.length+index];
      const focus=normalizedCosine(primaryVector,vector);
      const contextual=search?normalizedCosine(vectors[0],vector)*.90:0;
      item.vectorScore=Math.max(focus,contextual);
      evaluated.push(item);
    });
    report.vectorStatus='ready';
    report.stage=stage;
  }
  function confident() {
    return evaluated.some(item=>item.vectorScore>=Math.max(.72,threshold+.16) ||
      item.vectorScore>=Math.max(.52,threshold)&&item.keywordScore>=.65);
  }
  report.stage='keyword';
  if(embed){
    try{
      await run('semantic',[...preserved.slice(0,8),...sample,...preserved],12);
      if(!confident())await run('context',[...contextCandidates,...preserved,...reserve],16);
      if(!confident()){
        const nearby=[...evaluated].sort((a,b)=>b.vectorScore-a.vectorScore).slice(0,6)
          .flatMap(item=>[item.before,item.after].filter(Boolean));
        await run('deep',[...nearby,...reserve,...contextCandidates,...preserved],20);
      }
    }catch(error){
      signal?.throwIfAborted();
      if(error?.name==='AbortError'||error?.name==='CanceledError')throw error;
      if(report.vectorStatus==='ready'){
        report.refinementFailed=true;
        report.warnings.push('Дополнительный поиск архива недоступен. Использованы результаты завершённых этапов.');
      }else{
        report.vectorStatus='fallback';
        report.warnings.push('Векторный поиск архива недоступен. Использованы найденные по словам выдержки.');
      }
    }
  }else{
    report.vectorStatus='fallback';
    report.warnings.push('Для векторного поиска архива выберите подключение embeddings.');
  }
  report.candidates=attempted.size;
  const bestVector=Math.max(0,...evaluated.map(item=>item.vectorScore));
  const minimum=Math.max(threshold,.42,bestVector-.18);
  const byId=new Map([...preserved,...evaluated].map(item=>[item.chunk.id,item]));
  const relevant=[...byId.values()].filter(item=>item.keywordScore>=.38||item.vectorScore>=minimum);
  const ranked=rerankResults(relevant,[],scene).sort((a,b)=>b.finalScore-a.finalScore||scoreOrder(a,b));
  const resolved=policy.resolve(ranked);
  const seenText=new Set();
  const unique=resolved.ranked.filter(item=>{
    const key=normalizeLine(item.chunk.content);
    if(seenText.has(key))return false;
    seenText.add(key);
    return true;
  });
  // A contradiction can involve two sentences from the same source document.
  const results=resolved.conflict?unique.slice(0,2):bestPerDocument(unique,maxExcerpts);
  report.evidence=resolved.conflict?'conflict':results.length?'found':'unknown';
  return {results,report};
}

