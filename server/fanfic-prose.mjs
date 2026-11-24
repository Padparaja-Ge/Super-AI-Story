import {createTextContinuationJoiner} from './text-continuation.mjs';
import {cleanAssistantOutput} from './services/structuredCompletion.js';

// Delimiters are scoped to literary scene requests; ordinary RP stays intact.
export const fanficStops=['[SAS_SCENE_END]','\nСцена завершена.','\n\n---\n\nThis text','\n\nThis text is a continuation'];
export function cleanFanficProse(value){
  let text=cleanAssistantOutput(value);
  for(const marker of ['[SAS_SCENE_END]',...fanficStops.slice(1)]){
    const index=text.indexOf(marker);if(index>=0)text=text.slice(0,index);
  }
  // Some OpenAI adapters ignore stop sequences; remove only explicit standalone
  // editorial postscripts, never a character's dialogue or an ordinary divider.
  text=text.replace(/\n(?:\s*---\s*\n)?\s*(?:This (?:text|narrative) is (?:a continuation|written|intended)|The narrative is intentionally|Сцена завершена\.|Комментарий (?:автора|редактора):)[\s\S]*$/i,'');
  return text.trim();
}

const sentenceSegmenter=new Intl.Segmenter(undefined,{granularity:'sentence'});
const terminalPunctuation=/[.!?…。！？]["'»”’\)\]]*\s*$/u;
const closingQuote=new Map([['«','»'],['“','”'],['„','“'],['"','"']]);
function closedSentenceOffsets(text){
  const offsets=[],expected=[];
  for(const {segment,index} of sentenceSegmenter.segment(text)){
    for(const {0:mark} of segment.matchAll(/["«»„“”]/gu)){
      if(expected.at(-1)===mark)expected.pop();
      else if(closingQuote.has(mark))expected.push(closingQuote.get(mark));
    }
    if(!expected.length&&/[\p{L}\p{N}]/u.test(segment)&&terminalPunctuation.test(segment))offsets.push(index+segment.trimEnd().length);
  }
  return offsets;
}

const sentenceCounts=new Map([
  ['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],
  ['одно',1],['два',2],['две',2],['три',3],['четыре',4],['пять',5],['шесть',6]
]);
const shortParagraph=/(?:^|[.!?…]\s+|(?:напиши|оформи|верни|остановись после)\s+)(?:в\s+)?(?:один|1)\s+(?:короткий\s+)?абзац(?:\P{L}|$)|(?:^|[.!?…]\s+|(?:write|return)\s+)(?:in\s+)?(?:a single|one|1)\s+(?:short\s+)?paragraph\b/iu;
const shortSentences=/(?:^|[.!?…]\s+|(?:через|не более|не больше|ровно|уложись в|write|in|at most|no more than)\s+)([1-6]|одно|две|два|три|четыре|пять|шесть|one|two|three|four|five|six)(?:\s*(?:[-–—]|to)\s*([1-6]|одно|две|два|три|четыре|пять|шесть|one|two|three|four|five|six))?\s+(?:(?:коротк(?:ое|ие|их)|short)\s+)?(?:предложени[еяй]|фраз[аы]?|sentences?)(?:\P{L}|$)/iu;

export function fanficProseLimit(instructions){
  const paragraph=shortParagraph.test(instructions),range=instructions.match(shortSentences);
  if(!paragraph&&!range)return null;
  const count=value=>sentenceCounts.get(value.toLowerCase())||Number(value);
  const min=range?count(range[1]):0,max=range&&range[2]?count(range[2]):min;
  return {paragraph,min,max:Math.max(min,max)};
}

export function completeFanficProse(text) {
  const end=closedSentenceOffsets(text).at(-1);
  return end===undefined?'':text.slice(0,end);
}

export function boundedFanficProse(text,limit,interrupted){
  const paragraphBreak=limit.paragraph?/\n[^\S\n]*\n/.exec(text):null;
  const candidate=paragraphBreak?text.slice(0,paragraphBreak.index):text;
  const offsets=closedSentenceOffsets(candidate);
  if(!offsets.length)return null;
  const tooManySentences=limit.max>0&&offsets.length>limit.max;
  const reachedRequestedLength=limit.paragraph||limit.min>0&&offsets.length>=limit.min;
  if(paragraphBreak||tooManySentences||interrupted&&reachedRequestedLength){
    return candidate.slice(0,offsets[Math.min(offsets.length,limit.max||offsets.length)-1]);
  }
  return null;
}

const fullAdjective=/[а-яё]{3,}(?:ый|ий|ая|яя|ое|ее|ые|ие|ую|юю|ыми|ими|ого|ему|ому)$/iu;
const separateWord=/^(?:в|на|к|до|от|из|по|об|без|за|над|под|при|для|и|но|или|с|со|перед|через)$/iu;
const unfinishedRelative=/(?:^|[^\p{L}])(?:который|которая|которое|которые|who|which|that),[^.!?…\n]{1,70},\s*$/iu;

// Buffer the beginning of a response at a risky seam. Preserve exact word
// suffixes. A visible restart may replace only an incomplete final sentence.
export function createFanficProseJoiner(before){
  const exact=createTextContinuationJoiner(before);
  const punctuation=/[,;:]\s*$/u.test(before);
  const adjective=!punctuation&&fullAdjective.test(before);
  const tail=before.slice(-600);
  const lastClosed=closedSentenceOffsets(tail).at(-1)??0;
  const incomplete=tail.slice(lastClosed).trimStart();
  const replay=incomplete.length>=16&&incomplete.length<=220&&/^(?:["“«])?\p{Lu}/u.test(incomplete)&&!terminalPunctuation.test(incomplete)?incomplete:'';
  let decided=!punctuation&&!adjective&&!replay,pending='',prefix=before;
  function resolve(final){
    if(!pending)return '';
    const next=pending.trimStart();
    if(replay&&!final&&replay.startsWith(next))return '';
    if(replay&&next.startsWith(replay)){
      pending='';decided=true;
      return exact.push(next.slice(replay.length));
    }
    const word=/^(\s*)(?:[«"“—–]\s*)?([\p{L}\p{M}]+)/u.exec(pending);
    if(!final&&pending.length<160&&(!word||word[0].length===pending.length))return '';
    const buffered=pending;
    pending='';decided=true;
    if(punctuation&&word){
      const upper=/^\p{Lu}/u.test(word[2]),newParagraph=/\n[^\S\n]*\n/u.test(word[1]);
      const startsOver=upper&&(newParagraph||unfinishedRelative.test(before));
      if(startsOver){
        const end=closedSentenceOffsets(before).at(-1);
        if(end){
          prefix=before.slice(0,end)+(newParagraph?'\n\n':' ');
          return exact.push(buffered.trimStart());
        }
      }
      const quoteAfterColon=/:\s*$/u.test(before)&&/^[«"“—–]/u.test(buffered);
      if(startsOver||upper&&!word[1]&&!/\s$/u.test(before)&&!quoteAfterColon){
        throw new Error('Не удалось состыковать оборванную сцену. Черновик сохранён. Нажмите «Возобновить».');
      }
      if(!word[1]&&!/\s$/u.test(before))return exact.push(' '+buffered);
    }
    if(adjective&&word&&!word[1]&&separateWord.test(word[2]))return exact.push(' '+buffered);
    return exact.push(buffered);
  }
  return {
    get prefix(){return prefix;},
    push(chunk){if(decided)return exact.push(chunk);pending+=chunk;return resolve(false);},
    flush(){return resolve(true)+exact.flush();}
  };
}
