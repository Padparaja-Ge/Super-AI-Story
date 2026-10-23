import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { calculateTokenBudget } from '../server/rag/tokens.mjs';
import { chunkLorebook, semanticChunkLorebook, chunkLorebookAsync,extractMetadata } from '../server/rag/chunking.mjs';

function assertLossless(source, chunks, limit, counter = calculateTokenBudget) {
  let covered = 0, rebuilt = '';
  for (const chunk of chunks) {
    const { start, end } = chunk.metadata;
    assert.equal(chunk.content, source.slice(start, end));
    assert.ok(start <= covered, `gap at ${covered}: next chunk starts at ${start}`);
    assert.ok(end > covered, 'each chunk adds new source content');
    rebuilt += source.slice(covered, end);
    covered = end;
    assert.ok(counter(chunk.content) <= limit, `token cap exceeded: ${counter(chunk.content)} > ${limit}`);
    assert.doesNotMatch(chunk.content, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u, 'never split surrogate pairs');
  }
  assert.equal(covered, source.length);
  assert.equal(rebuilt, source);
}

test('real cl100k token counts include Cyrillic and literal special tokens', () => {
  assert.equal(calculateTokenBudget(''), 0);
  assert.equal(calculateTokenBudget('hello world'), 2);
  assert.equal(calculateTokenBudget('Привет, мир!'), 7);
  assert.equal(calculateTokenBudget('<|endoftext|>'), 7);
  assert.equal(calculateTokenBudget('Привет, мир!'), 7, 'cache leaves count unchanged');
  assert.throws(() => calculateTokenBudget(null), TypeError);
});
test('Metadata recognizes conservative entity headings, names and lexical tags without a model',()=>{
 const merchant=extractMetadata('Арвин — торговец картами. Торговец продаёт карты и дорожные припасы.','');
 assert.equal(merchant.type,'npc');assert.equal(merchant.name,'Арвин');assert.ok(merchant.tags.includes('торговец'));
 assert.equal(extractMetadata('Торговец Арвин продаёт карты.','').name,'Арвин');
 assert.equal(extractMetadata('Заклинание: Огненный шар\nШар причиняет огненный урон.','').type,'spell');
 assert.equal(extractMetadata('City: Silver Harbor\nA harbor near the forest.','').name,'Silver Harbor');
 assert.equal(extractMetadata('Quest: The Silent Bell\nReward: 10 gold.','quest').type,'quest');
 assert.equal(extractMetadata('История старого мира.','').type,'lore');
 assert.throws(()=>extractMetadata(null,''),TypeError);
});
test('A paragraph that fits alone starts a new chunk rather than splitting to fill the previous one',()=>{
 const first='Alpha one. Alpha two.',second='Bravo one. Charlie two. Delta three. Echo four.';
 const counter=text=>(text.match(/\S+/g)||[]).length;
 const source=first+'\n\n'+second,chunks=chunkLorebook(source,{maxTokens:10,overlap:0,countTokens:counter});
 assertLossless(source,chunks,10,counter);assert.equal(chunks.length,2);assert.equal(chunks[1].content,second);
});

test('Cyrillic lore preserves source, UTF16 offsets, hash and scoped stable identity', () => {
  const source = 'NPC: Арвин\nТеги: торговец, карты\nАрвин хранит старую карту. Он ждёт путников.\r\n\r\nГавань скрыта туманом. ';
  const options = { maxTokens: 32, source: 'world', documentId: 'npc-arvin', scope: 'room:one' };
  const chunks = chunkLorebook(source, options);
  assert.ok(chunks.length > 1);
  assertLossless(source, chunks, 32);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.metadata.type, 'npc');
    assert.equal(chunk.metadata.name, 'Арвин');
    assert.equal(chunk.metadata.scope, 'room:one');
    assert.equal(chunk.metadata.documentId, 'npc-arvin');
    assert.equal(chunk.metadata.sourceHash, sourceHash);
    assert.equal(chunk.metadata.index, index);
    assert.ok(chunk.metadata.tags.includes('торговец'));
  }
  assert.deepEqual(chunkLorebook(source, options), chunks);
  assert.equal(semanticChunkLorebook, chunkLorebook);
  assert.notEqual(chunkLorebook(source, { ...options, scope: 'room:two' })[0].id, chunks[0].id);
  assert.equal(chunkLorebook(source + 'Конец.', options)[0].id, chunks[0].id, 'unchanged early chunk keeps identity after append');
  assert.notEqual(chunkLorebook(source.replace('Арвин', 'Арвен'), options)[0].id, chunks[0].id);
});

test('sentence overlap is bounded to 50 tokens and contains complete sentences', () => {
  const source = Array.from({ length: 22 }, (_, index) => `The gate number ${index} is sealed. `).join('');
  const chunks = chunkLorebook(source, { maxTokens: 90, overlap: 500 });
  assertLossless(source, chunks, 90);
  let overlaps = 0;
  for (let index = 1; index < chunks.length; index++) {
    const overlap = source.slice(chunks[index].metadata.start, chunks[index - 1].metadata.end);
    if (overlap) {
      overlaps++;
      assert.ok(calculateTokenBudget(overlap) <= 50);
      assert.match(overlap, /^The gate number /u);
      assert.match(overlap, /sealed\. $/u);
    }
  }
  assert.ok(overlaps > 0);
});

test('oversized sentence explicitly falls back to words without dropping Unicode or punctuation', () => {
  const source = 'Локация: Старая гавань\n' + Array.from({ length: 60 }, (_, index) => `путник${index} шагает по берегу`).join(', ') + '!';
  const chunks = chunkLorebook(source, { maxTokens: 23, modelTokenLimit: 17, overlap: 50 });
  assertLossless(source, chunks, 17);
  assert.ok(chunks.some(chunk => chunk.metadata.segmentation === 'word'));
  assert.equal(chunks.at(-1).content.at(-1), '!');
  assert.equal(chunks[0].metadata.type, 'location');
  assert.equal(chunks[0].metadata.name, 'Старая гавань');
});

test('one very long word uses codepoint fallback and a model limit too small for a codepoint fails explicitly', () => {
  const source = '🗝️дверь'.repeat(200);
  const chunks = chunkLorebook(source, { maxTokens: 12, overlap: 0 });
  assertLossless(source, chunks, 12);
  assert.ok(chunks.every(chunk => chunk.metadata.segmentation === 'codepoint'));
  assert.throws(() => chunkLorebook('🔮', { maxTokens: 1 }), /Unicode code point/u);
});

test('caller metadata has priority, inputs are not mutated, and the hard cap is 512', () => {
  const metadata = Object.freeze({ type: 'quest', name: 'Ключ маяка', tags: Object.freeze(['важное']), vectorized: false });
  const source = ('Item: Crystal\nA guarded crystal waits by the old gate. ').repeat(240);
  const chunks = chunkLorebook(source, { metadata, maxTokens: 2000 });
  assertLossless(source, chunks, 512);
  assert.ok(chunks.every(chunk => chunk.metadata.type === 'quest' && chunk.metadata.name === 'Ключ маяка' && chunk.metadata.vectorized === false));
  assert.deepEqual(metadata.tags, ['важное']);
  assert.deepEqual(chunkLorebook(' \n\t'), []);
  assert.throws(() => chunkLorebook('abc', { maxTokens: 0 }), RangeError);
  assert.throws(() => chunkLorebook('abc', { countTokens: () => NaN }), TypeError);
});

test('async native tokenizer uses the same semantic policy, validates results and propagates abort', async () => {
  const source = 'Арвин ждёт у ворот. Дверь открыта. Герои входят. '.repeat(12);
  const counter = text => Array.from(text).length;
  const options = { maxTokens: 50, overlap: 12, countTokens: counter };
  const expected = chunkLorebook(source, options);
  let calls = 0;
  const result = await chunkLorebookAsync(source, { ...options, countTokens: async text => { calls++; return counter(text); } });
  assert.deepEqual(result, expected);
  assertLossless(source, result, 50, counter);
  assert.ok(calls > 1);
  const controller = new AbortController();
  await assert.rejects(chunkLorebookAsync(source, { maxTokens: 30, signal: controller.signal,
    countTokens: async () => { controller.abort(new Error('stop native tokenizer')); return 1; } }), /stop native tokenizer/u);
  await assert.rejects(chunkLorebookAsync(source, { countTokens: async () => -1 }), TypeError);
});
