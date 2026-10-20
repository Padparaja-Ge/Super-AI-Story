import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { YandexProvider } from '../server/providers/yandex.js';
import { DeepLProvider } from '../server/providers/deepl.js';
import { GoogleProvider } from '../server/providers/google.js';
import { TranslationService, createTranslationService } from '../server/services/translationService.js';
import { TranslationError } from '../server/services/translationErrors.js';
import { TranslationCache } from '../server/cache/translationCache.js';
import { splitTranslation } from '../server/services/translationChunks.js';
import { TranslationRateLimit } from '../server/services/translationRateLimit.js';
import { createTranslationRouter } from '../server/routes/translation.js';
import { translationConfig } from '../server/config/translation.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const endpoint = 'https://translator.example/translate';
const definitions = [
  ['yandex', YandexProvider, { text: ['Привет, ', 'мир!'], code: 200 }, {}],
  ['deepl', DeepLProvider, { data: 'Привет, мир!', code: 200 }, { mode: 'deeplx' }],
  ['google', GoogleProvider, [[['Привет, ', 'Hello, '], ['мир!', 'world!']]], { mode: 'web' }],
];
for (const [id, Provider, response, extra] of definitions) {
  test(`${id}: translates through backend adapter without a user key`, async () => {
    const calls = [];
    const p = new Provider({ endpoint, ...extra, fetchImpl: async (url, options) => { calls.push({ url, options }); return json(response); } });
    assert.equal(await p.translate('Hello, world!', 'en', 'ru'), 'Привет, мир!');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers?.Authorization, undefined);
    if (id === 'yandex') {
      assert.equal(calls[0].url.searchParams.get('srv'), 'android');
      assert.equal(calls[0].url.searchParams.get('format'), 'text');
      assert.match(calls[0].url.searchParams.get('ucid'), /^[a-f\d]{32}$/);
      assert.equal(calls[0].options.body.get('lang'), 'en-ru');
      assert.equal(calls[0].options.body.get('text'), 'Hello, world!');
    } else if (id === 'deepl') assert.deepEqual(JSON.parse(calls[0].options.body), { text: 'Hello, world!', source_lang: 'EN', target_lang: 'RU' });
    else {
      assert.equal(calls[0].url.searchParams.get('q'), 'Hello, world!');
      assert.equal(calls[0].url.searchParams.get('sl'), 'en');
      assert.equal(calls[0].url.searchParams.get('tl'), 'ru');
    }
  });
  test(`${id}: rejects empty text and invalid languages before calling endpoint`, async () => {
    let calls = 0; const p = new Provider({ endpoint, ...extra, fetchImpl: async () => { calls++; return json(response); } });
    for (const text of ['', ' \n ']) await assert.rejects(p.translate(text, 'en', 'ru'), { code: 'INVALID_REQUEST', status: 400 });
    for (const [source, target] of [['not-a-language', 'ru'], ['en', 'auto'], ['en', 'bad_language']]) await assert.rejects(p.translate('Hello', source, target), { code: 'INVALID_REQUEST' });
    assert.equal(calls, 0);
  });
  test(`${id}: normalizes endpoint errors without exposing response or secrets`, async () => {
    const p = new Provider({ endpoint, ...extra, fetchImpl: async () => json({ error: 'SECRET user text and key' }, 403) });
    await assert.rejects(p.translate('Hello', 'en', 'ru'), error => error.provider === id && error.status === 502 && !error.message.includes('SECRET'));
    p.fetchImpl = async () => { throw new Error('SECRET network URL'); };
    await assert.rejects(p.translate('Hello', 'en', 'ru'), { code: 'NETWORK_ERROR', status: 502 });
    p.fetchImpl = async () => json({}, 429);
    await assert.rejects(p.translate('Hello', 'en', 'ru'), { code: 'RATE_LIMITED', status: 429 });
  });
  test(`${id}: timeout and malformed responses are normalized`, async () => {
    const p = new Provider({ endpoint, ...extra, timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json(response)), 500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
    await assert.rejects(p.translate('Hello', 'en', 'ru'), { code: 'TIMEOUT', status: 502 });
    p.fetchImpl = async () => new Response('<html>SECRET</html>');
    await assert.rejects(p.translate('Hello', 'en', 'ru'), { code: 'INVALID_RESPONSE', status: 502 });
  });
}
test('Yandex: automatic source detection and unsupported-language response', async () => {
  const p = new YandexProvider({ endpoint, fetchImpl: async (url, options) => { assert.equal(options.body.get('lang'), 'ru'); return json({ code: 501 }); } });
  await assert.rejects(p.translate('Hello', 'auto', 'ru'), { status: 400, code: 'UNSUPPORTED_LANGUAGE' });
});
test('Google default batch adapter parses RPC response through configurable backend endpoint', async () => {
  const payload = [null, [[['Привет, мир!', null, null, null, null, [['Привет, мир!']]]], null, null, 'en']];
  const raw = ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MkEWBc', JSON.stringify(payload), null, null, '0']]) + '\n';
  const calls = [], p = new GoogleProvider({ endpoint, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(raw); } });
  assert.equal(await p.translate('Hello world', 'en', 'ru'), 'Привет, мир!');
  assert.equal(calls[0].url.origin, 'https://translator.example');
  assert.equal(calls[0].url.searchParams.get('rpcids'), 'MkEWBc');
  assert.equal(calls[0].options.method, 'POST');
  const request = JSON.parse(new URLSearchParams(calls[0].options.body).get('f.req'));
  assert.deepEqual(JSON.parse(request[0][0][1])[0], ['Hello world', 'en', 'ru', false]);
  p.fetchImpl = async () => json({}, 429);
  await assert.rejects(p.translate('Hello', 'en', 'ru'), { status: 429, code: 'RATE_LIMITED' });
  p.fetchImpl = async () => new Response('invalid RPC payload');
  await assert.rejects(p.translate('Hello', 'en', 'ru'), { status: 502, code: 'INVALID_RESPONSE' });
  p.timeoutMs = 10;
  p.fetchImpl = async (url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(raw)), 500);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(p.translate('Hello', 'en', 'ru'), { status: 502, code: 'TIMEOUT' });
});
test('DeepL API and Google Cloud use server credentials and the configured endpoints', async () => {
  const calls = [], fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); return json({ translations: [{ text: 'Hi' }], data: { translations: [{ translatedText: 'Hi' }] } }); };
  const d = new DeepLProvider({ endpoint, apiKey: 'SERVER_SECRET', mode: 'api', fetchImpl });
  const g = new GoogleProvider({ endpoint, apiKey: 'SERVER_SECRET', mode: 'api', fetchImpl });
  assert.equal(await d.translate('Привет', 'auto', 'en-us'), 'Hi');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: ['Привет'], target_lang: 'EN-US' });
  assert.equal(calls[0].options.headers.Authorization, 'DeepL-Auth-Key SERVER_SECRET');
  assert.equal(await g.translate('Привет', 'ru', 'en'), 'Hi');
  assert.equal(calls[1].options.headers['X-Goog-Api-Key'], 'SERVER_SECRET');
  assert.equal(calls[0].url, endpoint); assert.equal(calls[1].url, endpoint);
});
test('DeepL official endpoint without a key fails clearly; keyless proxy remains usable', async () => {
  const d = new DeepLProvider({ endpoint: 'https://api.deepl.com/v2/translate', mode: 'api', fetchImpl: () => { throw new Error('Must not call'); } });
  await assert.rejects(d.translate('Hi', 'en', 'ru'), { code: 'PROVIDER_UNAVAILABLE', status: 502 });
});

function mockService(options = {}) {
  const calls = [];
  const providers = Object.fromEntries(['yandex', 'deepl', 'google'].map(id => [id, { maxChars: 4500, async translate(text, source, target) { calls.push({ id, text, source, target }); return `${id}:${target}:${text}`; } }]));
  return { calls, providers, service: new TranslationService({ providers, ...options }) };
}
test('Service selects each provider, validates unknown providers and keeps equivalent languages local', async () => {
  const { service, calls } = mockService();
  for (const provider of ['yandex', 'deepl', 'google']) assert.deepEqual(await service.translate('Hello', 'en', 'ru', provider), { translation: `${provider}:ru:Hello`, provider });
  for (const id of ['missing', '__proto__', 'constructor', {}, null]) await assert.rejects(service.translate('Hi', 'en', 'ru', id), { status: 400, code: 'UNKNOWN_PROVIDER' });
  assert.equal((await service.translate('Hello', 'EN', 'en', 'google')).translation, 'Hello');
  assert.equal(calls.length, 3);
  await assert.rejects(service.translate('x'.repeat(100001), 'en', 'ru', 'yandex'), { status: 400 });
});
test('Cache: identical request hits once; provider, languages, and text isolate entries', async () => {
  const { service, calls } = mockService();
  await service.translate('Hello', 'en', 'ru', 'yandex');
  await service.translate('Hello', 'EN', 'RU', 'yandex');
  assert.equal(calls.length, 1);
  await service.translate('Hello', 'en', 'ru', 'google');
  await service.translate('Hello', 'auto', 'ru', 'yandex');
  await service.translate('Hello', 'en', 'de', 'yandex');
  await service.translate('Another', 'en', 'ru', 'yandex');
  assert.equal(calls.length, 5);
});
test('Cache evicts old entries and respects TTL and memory budget', () => {
  let now = 0; const c = new TranslationCache({ maxEntries: 2, maxBytes: 10, ttlMs: 50, now: () => now });
  c.set('a', '1234'); c.set('b', '1234'); c.set('c', '1234'); assert.equal(c.get('a'), undefined); assert.equal(c.bytes, 8);
  now = 51; assert.equal(c.get('c'), undefined);
  c.set('big', 'x'.repeat(20)); assert.equal(c.get('big'), undefined);
});
test('Chunks preserve sentences, whitespace, Unicode and output order', async () => {
  const input = '  First sentence. Second sentence!\n\n' + '🧙'.repeat(30) + '\n Last word.  ';
  const chunks = splitTranslation(input, 24);
  assert.equal(chunks.join(''), input); assert.ok(chunks.every(c => c.length <= 24 && c.isWellFormed()));
  assert.equal(chunks[0], '  First sentence. ');
  const seen = [], translator = { maxChars: 24, async translate(text) { seen.push(text); return text; } };
  const s = new TranslationService({ providers: { yandex: translator } });
  assert.equal((await s.translate(input, 'en', 'ru', 'yandex')).translation, input);
  assert.equal(seen.join('|'), chunks.filter(c => c.trim()).map(c => c.trim()).join('|'));
});
test('Retry uses bounded delays, failures are not cached, and 429 is not retried', async () => {
  const delays = [], { service, providers } = mockService({ sleep: async ms => { delays.push(ms); } }); let calls = 0;
  providers.yandex.translate = async () => { calls++; if (calls < 3) throw new TranslationError('yandex', 'NETWORK_ERROR', 'Offline', 502); return 'Привет'; };
  assert.equal((await service.translate('Hello', 'en', 'ru', 'yandex')).translation, 'Привет');
  assert.deepEqual(delays, [500, 1500]); assert.equal(calls, 3);
  providers.yandex.translate = async () => { calls++; throw new TranslationError('yandex', 'RATE_LIMITED', 'Limited', 429); };
  await assert.rejects(service.translate('Another', 'en', 'ru', 'yandex'), { status: 429 }); assert.equal(calls, 4);
  providers.yandex.translate = async () => 'Works again';
  assert.equal((await service.translate('Another', 'en', 'ru', 'yandex')).translation, 'Works again');
});
test('Fallback is opt-in, reports actual provider, and never caches fallback under primary', async () => {
  const { service, providers, calls } = mockService({ retryDelays: [] });
  providers.yandex.translate = async () => { throw new TranslationError('yandex', 'PROVIDER_UNAVAILABLE', 'Offline', 502); };
  await assert.rejects(service.translate('Hello', 'en', 'ru', 'yandex'), { status: 502 }); assert.equal(calls.length, 0);
  assert.equal((await service.translate('Hello', 'en', 'ru', 'yandex', { fallback: true })).provider, 'google');
  providers.yandex.translate = async () => 'Primary recovered';
  assert.equal((await service.translate('Hello', 'en', 'ru', 'yandex')).translation, 'Primary recovered');
});
test('Service enforces a shared external-call budget even for automatic translation', async () => {
  const { service, calls } = mockService({ limiter: new TranslationRateLimit({ limit: 1 }) });
  await service.translate('A', 'en', 'ru', 'yandex');
  await service.translate('A', 'en', 'ru', 'yandex');
  await assert.rejects(service.translate('B', 'en', 'ru', 'google'), { status: 429 }); assert.equal(calls.length, 1);
});
test('Cancelled translation neither retries nor triggers fallback', async () => {
  const controller = new AbortController(), { service, providers, calls } = mockService();
  providers.yandex.translate = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(service.translate('Hello', 'en', 'ru', 'yandex', { fallback: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0); assert.equal(service.active, 0);
});
test('Debug logging contains metadata only', async () => {
  const logs = [], { service, providers } = mockService({ debug: true, logger: { debug: line => logs.push(line) }, retryDelays: [] });
  await service.translate('SENSITIVE_CONTENT', 'en', 'ru', 'yandex');
  providers.google.translate = async () => { throw new Error('SECRET URL or body'); };
  await assert.rejects(service.translate('SENSITIVE_CONTENT', 'en', 'ru', 'google'));
  assert.match(logs.join('\n'), /provider=yandex source=en target=ru/);
  assert.match(logs.join('\n'), /failed provider=google status=502/);
  assert.doesNotMatch(logs.join('\n'), /SENSITIVE|SECRET/);
});
test('Backend configuration supplies endpoints centrally and API keys never become settings', () => {
  const config = translationConfig({ DEEPL_API_KEY: 'SERVER_KEY', GOOGLE_API_KEY: 'OTHER_KEY', YANDEX_TRANSLATE_ENDPOINT: endpoint });
  const service = createTranslationService({ config });
  assert.equal(service.providers.yandex.endpoint, endpoint);
  assert.equal(service.providers.deepl.mode, 'api'); assert.equal(service.providers.google.mode, 'api');
  assert.equal(translationConfig({}).deepl.mode, 'deeplx');
});

async function routeFixture(t, options = {}) {
  const { service, providers, calls } = mockService({ retryDelays: [] });
  const app = express(); app.use('/api/translate', createTranslationRouter({ translationService: service, getSettings: () => ({ provider: 'yandex', sourceLanguage: 'en', displayLanguage: 'ru', translationFallback: false }), ...options }));
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { service.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); });
  const request = body => fetch(`http://127.0.0.1:${server.address().port}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { request, providers, calls };
}
test('POST /api/translate: public contract, cache, legacy request and validation', async t => {
  const f = await routeFixture(t);
  const body = { text: 'Hello', sourceLang: 'en', targetLang: 'ru', provider: 'google' };
  const response = await f.request(body); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translation: 'google:ru:Hello', provider: 'google', text: 'google:ru:Hello' });
  await f.request(body); assert.equal(f.calls.length, 1);
  assert.equal((await f.request({ text: 'Hi', source: 'en', target: 'ru' })).status, 200);
  for (const invalid of [{ ...body, text: '' }, { ...body, provider: 'unknown' }, { ...body, targetLang: 'auto' }, { ...body, text: 'x'.repeat(100001) }, '{bad json', ' '.repeat(600000)]) assert.equal((await f.request(invalid)).status, 400);
});
test('POST /api/translate: 502, 500, 429 with safe response and Retry-After', async t => {
  const f = await routeFixture(t, { limiter: new TranslationRateLimit({ limit: 3 }) });
  f.providers.yandex.translate = async () => { throw new TranslationError('yandex', 'PROVIDER_UNAVAILABLE', 'Переводчик недоступен.', 502); };
  let response = await f.request({ text: 'Hi' }); assert.equal(response.status, 502); assert.equal((await response.json()).provider, 'yandex');
  f.providers.yandex.translate = async () => { throw new Error('SECRET body'); };
  response = await f.request({ text: 'Hi' }); assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SECRET/);
  await f.request({ text: 'Hi' }); response = await f.request({ text: 'Hi' });
  assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
});
