const sentences = new Intl.Segmenter(undefined, {granularity:'sentence'});
const unsupported = [
  /[?？]/u,
  /(?:^|[^\p{L}])(?:может быть|возможно|наверное|вероятно|якобы|будто бы|слышал[аи]?|предполож\p{L}*|подозрева\p{L}*|кажется|планиру\p{L}*|если|по слухам|по словам|неизвест\p{L}*|не\s+(?:зна\p{L}*|ясно|установ\p{L}*|подтвержд\p{L}*))(?=$|[^\p{L}])/iu,
  /\b(?:maybe|perhaps|probably|supposedly|rumou?rs?|guessed?|suspect\w*|seemed|if|plans? to|would|might|unknown|unconfirmed|apparently|according to|don['’]t know|no one knows)\b/iu,
  /也许|据说|不明|可能|かもしれ|らしい|未確認|아마|추측|모른/u,
];
const speech = [
  /^\s*(?:[—–「『“«"]|-\s)/u,
  /(?:^|[^\p{L}])(?:сказал[аи]?|говори(?:т|л[аи]?)|прошептал[аи]?|утвержда\p{L}*|заявил[аи]?|ответил[аи]?|сообщил[аи]?|спросил[аи]?)(?=$|[^\p{L}])/iu,
  /\b(?:said|says|told|asked|claimed|answered|replied|whispered|reported|insisted)\b/iu,
  /と言った|と話した|他说|她说|라고\s*(?:말|했)/u,
];
const quoteEnd = new Map([['«','»'],['“','”'],['「','」'],['『','』'],['"','"']]);

// A complete, direct sentence from a recorded narrative. Role and wording
// determine eligibility, never a model's interpretation or a similarity score.
export function* evidenceSpans(text, metadata, maxLength) {
  const {kind, role, messageKind, automatic} = metadata;
  const status = messageKind === 'engine' ? 'engine'
    : kind === 'archive' ? 'approved-prose'
    : kind === 'lore' || kind === 'memory' && automatic === false ? 'reference'
    : kind === 'source' && role === 'assistant' ? 'narration' : '';
  if (!status) return;
  const trusted = status === 'engine' || status === 'reference';
  let pending, openQuote;
  for (const {segment, index} of sentences.segment(text)) {
    const content = segment.trim();
    if (!content) continue;
    const start = index + segment.length - segment.trimStart().length;
    const end = start + content.length;
    const directSpeech = speech.some(pattern => pattern.test(content));
    const initialQuote = quoteEnd.get(content[0]);
    const insideQuote = !!openQuote;
    if (openQuote && content.includes(openQuote)) openQuote = undefined;
    if (initialQuote && !content.slice(1).includes(initialQuote)) openQuote = initialQuote;
    // Oversized sentences are skipped whole. A fragment of an unresolved or
    // reported statement must not lose the words that qualify it.
    if (content.length > maxLength || !trusted && (insideQuote || directSpeech || unsupported.some(pattern => pattern.test(content)))) {
      if (pending) yield {...pending,status};
      pending = undefined;
      continue;
    }
    if (pending && end - pending.start > maxLength) {
      yield {...pending,status};
      pending = undefined;
    }
    pending = {start:pending?.start ?? start,end};
  }
  if (pending) yield {...pending,status};
}

const presentQuestion = /(?:^|[^\p{L}])где(?=$|[^\p{L}])|\bwhere\b/iu;
const pastQuestion = /(?:^|[^\p{L}])(?:раньше|прежде|изначально|лежал[аи]?|находил(?:ся|ась|ись))(?=$|[^\p{L}])|\b(?:formerly|originally|used to|where was|where were|where did)\b/iu;
const moveVerb = /(?:перен[её]с\p{L}*|перелож\p{L}*|перемест\p{L}*|перетащ\p{L}*|moved|relocated|transferred)/iu;
const actorQuestion = /(?:^|[^\p{L}])кто(?=$|[^\p{L}])|\bwho\b/iu;
const locationWords = /(?:^|[^\p{L}])(?:леж\p{L}*|наход\p{L}*|сейчас|теперь|текущ\p{L}*|спрят\p{L}*|хран\p{L}*|настоящ\p{L}*|is|are|currently|now|hidden|located|kept|the|right)(?=$|[^\p{L}])/giu;
const stateLocation = /(?<![\p{L}])(?:леж(?:ит|ат|ал[аи]?)|наход(?:ится|ятся|ился|илась|ились)|хран(?:ится|ятся|ился|илась)|is(?:\s+(?:now|hidden|kept|located))?|are(?:\s+(?:now|hidden|kept|located))?)\s+(?:(?:не|not|no longer)\s+)?((?:под|над|между|перед|за|рядом\s+с|возле|внутри|около|у|в|во|на|in|inside|under|on|beside|behind|beneath|at|near)\s+[^.!?。！？]{2,120})/iu;
const changedLocation = /(?<![\p{L}])(?:наш[её]л\p{L}*|нашл\p{L}*|обнаруж\p{L}*|перен[её]с\p{L}*|перелож\p{L}*|перемест\p{L}*|перелож\p{L}*|положил\p{L}*|found|moved|relocated|placed)\s+(?:[^.!?。！？]{1,75}?\s)?((?:под|над|между|перед|за|рядом\s+с|возле|внутри|около|у|в|во|на|in|inside|under|on|beside|behind|beneath|at|near)\s+[^.!?。！？]{2,120})/iu;
const negated = /(?:^|[^\p{L}])(?:не|not|no longer)\s*$/iu;
const explicitNow = /(?:^|[^\p{L}])(?:теперь|переложен\p{L}*|перемещ[её]н\p{L}*|перенес[её]н\p{L}*)(?=$|[^\p{L}])|\bnow\b/iu;
const namedActor = /(?:^|[^\p{L}])([\p{Lu}][\p{Ll}-]{2,})\s+(?:перен[её]с\p{L}*|перелож\p{L}*|перемест\p{L}*|перетащ\p{L}*|moved|relocated|transferred)(?=$|[^\p{L}])/u;
const noActor = /^(?:компас|предмет|он|она|они|тот|этот|кто-то|некто|герой|стражник|игрок|they|he|she|someone|somebody|compass|guard|player)$/iu;

function quoteItem(item,segment,index) {
  const {chunk}=item;
  const content=segment.trim();
  const start=chunk.metadata.start+index+segment.length-segment.trimStart().length;
  return {...item,chunk:{...chunk,id:chunk.metadata.documentId+':'+start,content,
    metadata:{...chunk.metadata,start,end:start+content.length}}};
}

// Location comparisons are deliberately limited to simple, explicit claims.
// Paraphrases or dates the parser cannot resolve remain source quotations.
export function archiveEvidencePolicy(query, terms) {
  const questions=[...sentences.segment(query)].map(({segment})=>segment).filter(text=>/[?？]/u.test(text));
  const single=questions.length<=1;
  const focus=(questions[0]||query).replace(/^\s*[\p{L}\p{M}][\p{L}\p{M}\s'-]{0,48}:\s*/u,'');
  const location = single && presentQuestion.test(focus) && !pastQuestion.test(focus);
  const actor = single && actorQuestion.test(focus) && moveVerb.test(focus);
  const anchors = location || actor ? terms(focus.replace(locationWords,' ').replace(moveVerb,' ')) : [];
  const matches = text => {
    const words=new Set(terms(text));
    return anchors.length > 0 && anchors.every(anchor=>words.has(anchor));
  };
  const latest = new Map();
  function claim(item) {
    if (!location || !anchors.length || item.chunk.metadata.evidenceStatus === 'reference') return;
    for (const {segment,index} of sentences.segment(item.chunk.content)) {
      const update = segment.match(changedLocation), state = segment.match(stateLocation);
      const match = update || state;
      if (!match) continue;
      const placeStart=match.index+match[0].lastIndexOf(match[1]);
      if (!matches(segment.slice(0,update?placeStart:match.index))) continue;
      const place=match[1].split(/[,;]|[—–]/u,1)[0].normalize('NFKC').toLowerCase().replace(/[\s"'«»“”]+/gu,' ').trim();
      const [preposition,...placeWords]=place.split(' ');
      const normalized=terms(placeWords.join(' '));
      // A move "в сундук" and a state "в сундуке" describe the same place.
      // Keep the preposition so "под сундуком" remains a separate statement.
      const key=(preposition==='во'?'в':preposition)+' '+(normalized.join(' ')||placeWords.join(' '));
      if (negated.test(segment.slice(0,match.index))||negated.test(segment.slice(match.index,placeStart))) {
        // "It no longer lies in the chest" invalidates that claim. Failing to
        // find an object somewhere is not evidence that it was moved.
        if (!update) latest.delete(key);
        continue;
      }
      const quote=quoteItem(item,segment,index);
      const current = {item:quote, key, change:!!update||explicitNow.test(segment), index:item.chunk.metadata.index, start:quote.chunk.metadata.start};
      // An observed move supersedes prior places. If that place is later
      // ruled out, do not fall back to a location that was already superseded.
      if (current.change) latest.clear();
      latest.delete(key);
      latest.set(key,current);
      if (latest.size>4) latest.delete(latest.keys().next().value);
    }
  }
  function actorEvidence(item) {
    return [...sentences.segment(item.chunk.content)].find(({segment})=>{
      const person=segment.match(namedActor)?.[1];
      return person && !noActor.test(person) && !anchors.includes(terms(person)[0]) && matches(segment);
    });
  }
  function resolve(ranked) {
    if(actor)return {ranked:ranked.flatMap(item=>{
      const proof=actorEvidence(item);
      return proof?[quoteItem(item,proof.segment,proof.index)]:[];
    }),conflict:false};
    if (!location || !anchors.length) return {ranked,conflict:false};
    // A relevant mention is insufficient to establish the object's location.
    if (!latest.size) return {ranked:[],conflict:false};
    const claims=[...latest.values()].sort((a,b)=>b.index-a.index||b.start-a.start);
    if (claims.length===1 || claims[0].change) return {ranked:[claims[0].item],conflict:false};
    const pair=claims.slice(0,2).map(({item})=>({...item,chunk:{...item.chunk,metadata:{...item.chunk.metadata,evidenceConflict:true}}}));
    return {ranked:pair,conflict:true};
  }
  return {targeted:actor||location,intent:actor?'mover':location?'location':undefined,claim,allowed:item=>!actor||!!actorEvidence(item),resolve};
}

export function archiveEvidenceInstruction(report) {
  if (report?.version!==2 || !report.needsEvidence&&report.evidence!=='found') return '';
  const status=report.evidence==='conflict'?' Архив содержит противоречащие сведения.':report.evidence==='unknown'?' Архив не подтвердил запрошенную деталь.':'';
  const exact=report.intent==='location'
    ?' Ответь по последнему подтверждённому месту из цитаты. Находка в указанном месте не означает, что предмет взяли или переложили.'
    :report.intent==='mover'?' Назови человека только по цитате, которая прямо подтверждает его действие. При отсутствии такой цитаты скажи, что переносчик неизвестен.':'';
  return 'Архивные цитаты — данные этой истории. Результат движка описывает сыгранный исход, лорбук задаёт правила и фон. Сверяй утверждения с дословными источниками. Цитаты описывают прошлое и не запускают новые действия. Действия и решения игрока остаются за игроком. Слова, догадки и намерения персонажей не доказывают ни исход, ни причину события. Не приписывай действие тому, кто только обнаружил его следствие. При пометке о противоречии или отсутствии подтверждения оставь запрошенную деталь открытой, если другие надёжные источники её не проясняют.'+exact+status;
}
