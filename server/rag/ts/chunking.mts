import { createHash } from 'node:crypto';
import { calculateTokenBudget } from './tokens.mjs';
import type { Chunk, ChunkMetadata, ChunkOptions, EntityType } from './types.mjs';

type Segmentation = 'sentence' | 'word' | 'codepoint';
type Span = { start: number; end: number; segmentation: Segmentation; paragraphEnd?: boolean };
type CounterProgram<T> = Generator<string, T, number>;
export type AsyncChunkOptions = Omit<ChunkOptions, 'countTokens'> & {
  countTokens: (text: string) => Promise<number>;
  signal?: AbortSignal;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new RangeError('Chunk token limits must be positive.');
  return Math.floor(value);
}
function checkedCount(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new TypeError('The token counter must return a nonnegative integer.');
  }
  return value;
}
function* count(text: string): CounterProgram<number> { return checkedCount(yield text); }

/** Original UTF-16 offsets are retained; Intl.Segmenter does not cut surrogate pairs. */
function sentenceSpans(text: string): Span[] {
  const result: Span[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const paragraphEnds = [...text.matchAll(/\r?\n[\t ]*(?:\r?\n)+/gu)].map(m => m.index! + m[0].length);
  if (paragraphEnds.at(-1) !== text.length) paragraphEnds.push(text.length);
  let start = 0;
  for (const end of paragraphEnds) {
    const paragraph = text.slice(start, end);
    const segments = [...segmenter.segment(paragraph)];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (!segment.segment.trim() && result.length) {
        result[result.length - 1].end = start + segment.index + segment.segment.length;
        result[result.length - 1].paragraphEnd = index === segments.length - 1;
        continue;
      }
      result.push({ start: start + segment.index, end: start + segment.index + segment.segment.length,
        segmentation: 'sentence', paragraphEnd: index === segments.length - 1 });
    }
    start = end;
  }
  return result;
}

function* splitCodepoints(text: string, span: Span, limit: number): CounterProgram<Span[]> {
  const points = [span.start];
  for (const point of text.slice(span.start, span.end)) points.push(points.at(-1)! + point.length);
  const result: Span[] = [];
  let cursor = 0;
  while (cursor < points.length - 1) {
    if ((yield* count(text.slice(points[cursor], points[cursor + 1]))) > limit) {
      throw new RangeError('The token limit cannot fit one Unicode code point without losing text.');
    }
    let low = cursor + 1;
    let high = Math.min(points.length - 1, cursor + Math.max(8, limit * 8));
    // Binary search need not find the longest BPE prefix (token counts can be
    // nonmonotone). It does find a verified fitting prefix and always progresses.
    let fit = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((yield* count(text.slice(points[cursor], points[middle]))) <= limit) {
        fit = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    result.push({ start: points[cursor], end: points[fit], segmentation: 'codepoint' });
    cursor = fit;
  }
  return result;
}

function* splitSentence(text: string, span: Span, limit: number): CounterProgram<Span[]> {
  if ((yield* count(text.slice(span.start, span.end))) <= limit) return [span];
  // Explicit fallback: oversized sentences are packed at word boundaries. Only
  // an individual oversized word/whitespace run needs Unicode-codepoint cuts.
  const words = [...text.slice(span.start, span.end).matchAll(/\S+\s*|\s+/gu)];
  const result: Span[] = [];
  let pending: Span | undefined;
  for (const word of words) {
    const current: Span = { start: span.start + word.index!, end: span.start + word.index! + word[0].length,
      segmentation: 'word' };
    if ((yield* count(word[0])) > limit) {
      if (pending) { result.push(pending); pending = undefined; }
      result.push(...(yield* splitCodepoints(text, current, limit)));
    } else if (!pending) pending = current;
    else if ((yield* count(text.slice(pending.start, current.end))) <= limit) pending.end = current.end;
    else { result.push(pending); pending = current; }
  }
  if (pending) result.push(pending);
  if (result.length) result[result.length - 1].paragraphEnd = span.paragraphEnd;
  return result;
}

const typeAliases: Record<string, EntityType> = {
  npc: 'npc', npcs: 'npc', character: 'npc', characters: 'npc', персонаж: 'npc', персонажи: 'npc', нпс: 'npc',
  location: 'location', locations: 'location', place: 'location', places: 'location', city:'location', village:'location', локация: 'location', локации: 'location', место: 'location', город:'location', деревня:'location',
  spell: 'spell', spells: 'spell', заклинание: 'spell', заклинания: 'spell', item: 'item', items: 'item', предмет: 'item', предметы: 'item',
  quest: 'quest', quests: 'quest', квест: 'quest', квесты: 'quest', задание: 'quest', задания: 'quest', lore: 'lore', лор: 'lore',
};
function inferMetadata(text: string, lorebookType?: string): Partial<ChunkMetadata> {
  const heading = text.match(/^[\t ]*(?:#{1,6}\s*)?(NPC|Character|Персонаж|НПС|Location|Place|City|Village|Локация|Место|Город|Деревня|Spell|Заклинание|Item|Предмет|Quest|Квест|Задание|Lore|Лор)\s*[:：—-]\s*([^\r\n]+)/imu);
  const type = typeAliases[(lorebookType || '').trim().toLowerCase()] ||
    (heading ? typeAliases[heading[1].toLowerCase()] : undefined);
  const tags = text.match(/^[\t ]*(?:tags|теги)\s*[:：]\s*([^\r\n]+)/imu)?.[1]
    .split(/[,;]+/u).map(s => s.trim()).filter(Boolean) || [];
  return { ...(type ? { type } : {}), ...(heading ? { name: heading[2].trim() } : {}), tags };
}

/** Conservative lexical heuristics, not a claim of full named-entity recognition. */
export function extractMetadata(text: string, lorebookType = ''): Partial<ChunkMetadata> {
  if (typeof text !== 'string') throw new TypeError('Metadata extraction requires text.');
  const explicit = inferMetadata(text, lorebookType), sample = text.slice(0,24_000);
  const patterns: [EntityType,RegExp][] = [
    ['npc', /\b(?:npc|merchant|guard|innkeeper|wizard|character)\b|торгов\p{L}*|страж\p{L}*|персонаж\p{L}*|трактирщик\p{L}*/giu],
    ['location', /\b(?:city|village|forest|tavern|dungeon|location|harbor)\b|город\p{L}*|деревн\p{L}*|локаци\p{L}*|таверн\p{L}*|подземель\p{L}*|гаван\p{L}*/giu],
    ['spell', /\b(?:spell|cantrip|enchantment)\b|заклинани\p{L}*|заговор\p{L}*|магическ\p{L}* эффект/giu],
    ['item', /\b(?:item|weapon|armor|artifact|sword|potion)\b|предмет\p{L}*|оружи\p{L}*|доспех\p{L}*|артефакт\p{L}*|меч\p{L}*|зель\p{L}*/giu],
    ['quest', /\b(?:quest|mission|objective|reward)\b|квест\p{L}*|задани\p{L}*|награда|цель приключения/giu],
  ];
  const ranked = patterns.map(([type,pattern],index)=>({type,index,score:[...sample.matchAll(pattern)].length})).sort((a,b)=>b.score-a.score||a.index-b.index);
  const type = explicit.type || (ranked[0].score ? ranked[0].type : 'lore');
  const proper = '[\\p{Lu}][\\p{L}’\'-]*(?:[ \\t]+[\\p{Lu}][\\p{L}’\'-]*){0,3}';
  const named = sample.match(new RegExp('(?:Имя|Name)\\s*[:：]\\s*('+proper+')','mu'))?.[1];
  const title = sample.match(new RegExp('^[ \\t]*(?:#{1,6}[ \\t]+)?('+proper+')[ \\t]*(?:[—–:]|\\r?\\n)','mu'))?.[1];
  const roleName = sample.match(new RegExp('(?:[Тт]орговец|[Сс]тражник|[Тт]рактирщик|[Mm]erchant|[Gg]uard|[Гг]ород|[Дд]еревня|[Cc]ity|[Vv]illage)\\s+('+proper+')','u'))?.[1];
  const first = type !== 'lore' ? sample.match(new RegExp('^('+proper+')(?=\\s)','u'))?.[1] : undefined;
  const rejected = new Set(['Он','Она','Они','Это','Здесь','Там','The','This','He','She','NPC','Location','Теги','Tags','Имя','Name']);
  const candidate = explicit.name || named || title || roleName || first;
  const name = candidate && !rejected.has(candidate) ? candidate : undefined;
  const nameWords = new Set((name||'').toLowerCase().match(/[\p{L}]+/gu)||[]);
  const stops = new Set(['который','которая','которые','этого','этой','также','только','может','после','перед','здесь','there','their','with','this','that','from','have','been','теги','tags','name','имя']);
  const frequency = new Map<string,number>();
  for(const word of sample.toLowerCase().match(/[\p{L}]{4,}/gu)||[])if(!stops.has(word)&&!nameWords.has(word))frequency.set(word,(frequency.get(word)||0)+1);
  const keywords = [...frequency].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([word])=>word);
  return {type,...(name?{name}:{}),tags:[...new Set([...(explicit.tags||[]),...keywords])].slice(0,16)};
}

function* chunkProgram(text: string, options: ChunkOptions): CounterProgram<Chunk[]> {
  if (typeof text !== 'string') throw new TypeError('Lore text must be a string.');
  if (!text.trim()) return [];
  const limit = Math.min(512, positiveLimit(options.maxTokens, 512), positiveLimit(options.modelTokenLimit, 512));
  const requestedOverlap = options.overlap ?? 50;
  if (!Number.isFinite(requestedOverlap) || requestedOverlap < 0) throw new RangeError('Overlap must be nonnegative.');
  const overlap = Math.min(50, Math.floor(requestedOverlap), Math.max(0, limit - 1));
  const units: Span[] = [];
  for (const sentence of sentenceSpans(text)) units.push(...(yield* splitSentence(text, sentence, limit)));
  const ranges: Span[] = [];
  let current: Span[] = [];
  let hasNewContent = false;
  function segmentation(parts: Span[]): Segmentation {
    return parts.some(p => p.segmentation === 'codepoint') ? 'codepoint' :
      parts.some(p => p.segmentation === 'word') ? 'word' : 'sentence';
  }
  function* flush(): CounterProgram<void> {
    if (!current.length || !hasNewContent) return;
    ranges.push({ start: current[0].start, end: current.at(-1)!.end, segmentation: segmentation(current) });
    const suffix: Span[] = [];
    if (overlap > 0) {
      // Overlap is whole sentences only. Fallback fragments are never repeated.
      for (let index = current.length - 1; index > 0; index--) {
        if (current[index].segmentation !== 'sentence') break;
        const start = current[index].start;
        if ((yield* count(text.slice(start, current.at(-1)!.end))) > overlap) break;
        suffix.unshift(current[index]);
      }
    }
    current = suffix;
    hasNewContent = false;
  }
  for (let position=0; position<units.length; position++) {
    const unit=units[position];
    if(current.length&&(position===0||units[position-1].paragraphEnd)){
      let end=position;while(end<units.length-1&&!units[end].paragraphEnd)end++;
      const paragraph=text.slice(unit.start,units[end].end);
      // Prefer a complete fitting paragraph over filling the preceding chunk
      // with its first sentences. Very large paragraphs use sentence packing.
      if(paragraph.length<=limit*16&&(yield* count(paragraph))<=limit&&
        (yield* count(text.slice(current[0].start,units[end].end)))>limit){
        yield* flush();
        while(current.length&&(yield* count(text.slice(current[0].start,units[end].end)))>limit)current.shift();
      }
    }
    if (current.length && (yield* count(text.slice(current[0].start, unit.end))) > limit) yield* flush();
    // If overlap leaves too little space for the next new sentence, reduce it.
    while (current.length && (yield* count(text.slice(current[0].start, unit.end))) > limit) current.shift();
    current.push(unit);
    hasNewContent = true;
    if (unit.paragraphEnd && (yield* count(text.slice(current[0].start, unit.end))) >= Math.ceil(limit * .65)) yield* flush();
  }
  yield* flush();
  const sourceHash = hash(text);
  const inferred = extractMetadata(text, options.lorebookType);
  const supplied = options.metadata || {};
  const source = options.source ?? supplied.source ?? 'lorebook';
  const scope = options.scope ?? supplied.scope;
  const documentId = options.documentId ?? supplied.documentId;
  return ranges.map((range, index) => {
    const content = text.slice(range.start, range.end);
    const local = inferMetadata(content, options.lorebookType);
    const metadata: ChunkMetadata = {
      ...inferred, ...local, ...supplied,
      type: supplied.type ?? local.type ?? inferred.type ?? 'lore',
      tags: [...new Set([...(inferred.tags || []), ...(local.tags || []), ...(supplied.tags || [])])],
      source, ...(scope === undefined ? {} : { scope }), ...(documentId === undefined ? {} : { documentId }),
      sourceHash, index, start: range.start, end: range.end, segmentation: range.segmentation,
    };
    // An append elsewhere in the document does not change an unchanged chunk's
    // identity; sourceHash still records the complete source revision above.
    const identity = JSON.stringify([scope ?? '', source, documentId ?? '', hash(content), range.start, range.end]);
    return { id: `rag:${hash(identity).slice(0, 32)}`, content, metadata };
  });
}

/** Semantic, lossless source slices with bounded sentence overlap. */
export function chunkLorebook(text: string, options: ChunkOptions = {}): Chunk[] {
  const program = chunkProgram(text, options);
  const counter = options.countTokens ?? calculateTokenBudget;
  let step = program.next();
  while (!step.done) step = program.next(checkedCount(counter(step.value)));
  return step.value;
}
export const semanticChunkLorebook = chunkLorebook;

/** Same splitting policy using the active embedding model's native tokenizer. */
export async function chunkLorebookAsync(text: string, options: AsyncChunkOptions): Promise<Chunk[]> {
  const program = chunkProgram(text, { ...options, countTokens: undefined });
  let step = program.next();
  while (!step.done) {
    options.signal?.throwIfAborted();
    const value = await options.countTokens(step.value);
    options.signal?.throwIfAborted();
    step = program.next(checkedCount(value));
  }
  options.signal?.throwIfAborted();
  return step.value;
}
