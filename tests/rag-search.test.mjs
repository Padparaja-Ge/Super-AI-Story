import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridSearch,rerankResults } from '../server/rag/search.mjs';

const emptyScene = { presentNPCs: [], activeQuests: [] };
const chunk = (id, content, metadata = {}, embedding) => ({ id, content, ...(embedding === undefined ? {} : { embedding }),
  metadata: { type: 'lore', source: 'test', tags: [], scope: 'one', ...metadata } });

test('rare Cyrillic proper name is retrieved lexically despite a stronger unrelated cosine match', async () => {
  const chunks = [chunk('rare', 'Эльмирель хранит ключ от маяка.'), chunk('general', 'Городские стражники патрулируют набережную.')];
  const results = await hybridSearch('Эльмирель', emptyScene, { chunks, embed: async () => [[1, 0], [.8, .6], [1, 0]], scope: 'one' });
  assert.equal(results[0].chunk.id, 'rare');
  assert.equal(results[0].keywordScore, 1);
  assert.ok(results[0].vectorScore < results[1].vectorScore);
  assert.ok(Math.abs(results[0].finalScore - (.6 * .8 + .4)) < 1e-12);
});

test('scope and type filter before both corpus scoring and one embedding batch; missing scope is excluded', async () => {
  const chunks = [chunk('yes', 'Арвин торгует картами.', { type: 'npc' }),
    chunk('other-room', 'Арвин секрет другой комнаты.', { scope: 'two', type: 'npc' }),
    chunk('wrong-type', 'Арвин предмет.', { type: 'item' }), chunk('unscoped', 'Арвин общая запись.', { scope: undefined })];
  const batches = [];
  const results = await hybridSearch('Арвин', emptyScene, { chunks, scope: 'one', type: ['npc'],
    embed: async texts => { batches.push(texts); return texts.map(() => [1, 0]); } });
  assert.deepEqual(batches, [['Арвин', 'Арвин торгует картами.']]);
  assert.deepEqual(results.map(result => result.chunk.id), ['yes']);
  assert.equal(results[0].keywordScore, 1);
  const absent = await hybridSearch('Арвин', emptyScene, { chunks, scope: 'none', embed: async () => assert.fail('no embedding for excluded docs') });
  assert.deepEqual(absent, []);
  assert.deepEqual(await hybridSearch('Арвин', emptyScene, { chunks, type: [] }), []);
});

test('cached embeddings avoid re-encoding, lexical-only documents never enter embedding even with a cache', async () => {
  const chunks = [chunk('cached', 'Дверь закрыта.', {}, [1, 0]), chunk('new', 'За дверью стоит сундук.'),
    chunk('lexical', 'Дверь ведёт в сад.', { vectorized: false }, [1, 0])];
  const before = structuredClone(chunks);
  let calls = 0;
  const results = await hybridSearch('дверь', emptyScene, { chunks, embed: async texts => {
    calls++; assert.deepEqual(texts, ['дверь', 'За дверью стоит сундук.']); return [[1, 0], [.6, .8]];
  } });
  assert.equal(calls, 1);
  assert.equal(results.find(result => result.chunk.id === 'cached').vectorScore, 1);
  assert.equal(results.find(result => result.chunk.id === 'lexical').vectorScore, 0);
  assert.deepEqual(chunks, before, 'search is pure and does not mutate cached vectors');
});

test('BM25 top ten and cosine top ten are independent lists before union and reranking', async () => {
  const chunks = Array.from({ length: 21 }, (_, index) => chunk(`c${index}`, 'key', {}, index < 10 || index === 20 ? [0, 1] : [1, 0]));
  const results = await hybridSearch('key', emptyScene, { chunks, topK: 25, embed: async texts => { assert.deepEqual(texts, ['key']); return [[1, 0]]; } });
  assert.equal(results.length, 20);
  assert.deepEqual(new Set(results.map(result => result.chunk.id)), new Set(Array.from({ length: 20 }, (_, index) => `c${index}`)));
  assert.equal(results[0].chunk.id, 'c10');
  assert.equal(results.at(-1).chunk.id, 'c9');
});

test('entity boost is exactly .04 for an exact normalized scene phrase, never a name substring', async () => {
  const chunks = [chunk('exact', 'Арвин ждёт здесь.',{name:'Арвин'}), chunk('substring', 'Арвинд ждёт здесь.',{name:'Арвинд'}),
    chunk('location', 'СЕРЕБРЯНАЯ ГАВАНЬ открыта.',{name:'Серебряная гавань'}), chunk('partial', 'Гавань открыта.'),
    chunk('quest', 'Ключ маяка найден.',{name:'Ключ маяка'}), chunk('quest-part', 'Ключ найден.')];
  const scene = { currentLocation: 'Серебряная гавань', presentNPCs: ['Арвин'], activeQuests: ['Ключ маяка'] };
  const results = await hybridSearch('unknown', scene, { chunks, embed: async texts => texts.map(() => [1, 0]) });
  for (const result of results) assert.ok(Math.abs(result.finalScore - (['exact', 'location', 'quest'].includes(result.chunk.id) ? .64 : .6)) < 1e-12);
  assert.equal(results.find(result => result.chunk.id === 'substring').finalScore, .6);
});
test('rerank merges both lists by chunk id and boosts only metadata identity, not incidental prose',()=>{
 const present=chunk('npc','Арвин ждёт.',{name:'Арвин'}),other=chunk('else','Арвин ждёт.',{name:'Стражник'});
 const out=rerankResults([{chunk:present,vectorScore:.5,keywordScore:0,finalScore:999},{chunk:other,vectorScore:.5,keywordScore:0,finalScore:0}],
   [{chunk:present,vectorScore:0,keywordScore:.8,finalScore:0},{chunk:other,vectorScore:0,keywordScore:.8,finalScore:0}],{presentNPCs:['Арвин'],activeQuests:[]});
 assert.equal(out.length,2);assert.equal(out[0].chunk.id,'npc');assert.ok(Math.abs(out[0].finalScore-.66)<1e-12);assert.ok(Math.abs(out[1].finalScore-.62)<1e-12);
 const bad=rerankResults([{chunk:other,vectorScore:NaN,keywordScore:Infinity,finalScore:NaN}],[],emptyScene);assert.equal(bad[0].finalScore,0);
});

test('embedding failure and malformed query batch fall back to lexical with diagnostics', async () => {
  const chunks = [chunk('one', 'Арвин держит карту.'), chunk('two', 'Стражник держит копьё.')];
  for (const embed of [async () => { throw new Error('encoder unavailable'); }, async () => [[NaN], [1], [1]], async () => []]) {
    const errors = [];
    const results = await hybridSearch('Арвин', emptyScene, { chunks, embed, onVectorError: error => errors.push(error) });
    assert.equal(errors.length, 1);
    assert.equal(results[0].chunk.id, 'one');
    assert.equal(results[0].vectorScore, 0);
    assert.equal(results[0].finalScore, .4);
  }
});

test('invalid, negative, zero and mismatched vectors do not produce NaN or spurious semantic matches', async () => {
  const chunks = [chunk('negative', 'negative', {}, [-1, 0]), chunk('mismatch', 'mismatch', {}, [1]),
    chunk('zero', 'zero', {}, [0, 0]), chunk('nan', 'nan', {}, [NaN, 1]),
    chunk('huge', 'huge', {}, [Number.MAX_VALUE, Number.MAX_VALUE])];
  const results = await hybridSearch('unknown', emptyScene, { chunks, embed: async texts => {
    assert.deepEqual(texts, ['unknown', 'zero', 'nan']); return [[1, 0], [0, 0], [NaN, 1]];
  } });
  assert.deepEqual(results.map(result => result.chunk.id), ['huge']);
  assert.ok(Math.abs(results[0].vectorScore - Math.SQRT1_2) < 1e-12);
  assert.ok(Number.isFinite(results[0].finalScore));
});

test('abort propagates before search and during embedding without a lexical fallback', async () => {
  const chunks = [chunk('one', 'Арвин ждёт.')];
  const controller = new AbortController();
  let diagnostics = 0;
  await assert.rejects(hybridSearch('Арвин', emptyScene, { chunks, signal: controller.signal,
    embed: async () => { controller.abort(new Error('cancel recall')); return [[1], [1]]; }, onVectorError: () => diagnostics++ }), /cancel recall/u);
  assert.equal(diagnostics, 0);
  await assert.rejects(hybridSearch('Арвин', emptyScene, { chunks, signal: controller.signal }), /cancel recall/u);
  await assert.rejects(hybridSearch('Арвин', emptyScene, { chunks,
    embed: async () => { throw new DOMException('provider cancelled', 'AbortError'); } }), { name: 'AbortError' });
});

test('vector threshold affects the vector candidate list, lexical-only search remains available', async () => {
  const chunks = [chunk('lexical', 'key', { vectorized: false }), chunk('weak', 'other', {}, [.6, .8])];
  const results = await hybridSearch('key', emptyScene, { chunks, vectorThreshold: .8, embed: async () => [[1, 0]] });
  assert.deepEqual(results.map(result => result.chunk.id), ['lexical']);
  assert.equal(results[0].keywordScore, 1);
  assert.deepEqual(await hybridSearch('none', emptyScene, { chunks, vectorTopK: 0, embed: async () => assert.fail() }), []);
});
