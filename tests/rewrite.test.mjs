import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteDraft, cleanRewrite } from '../server/services/rewriteService.js';

function fixture(t, answers) {
  const calls = [], chat = { id: 'story', characterId: 'character', personaId: 'player', connectionId: 'story-model', scene: { location: 'Дом Тонерико', time: 'Вечер' }, messages: [{ role: 'assistant', content: 'Оригинал', translatedContent: 'Дверь открыта.' }] };
  const state = { activeConnectionId: 'other', connections: [{ id: 'story-model', baseUrl: 'http://localhost:1234/v1', model: 'instruct', contextWindow: 8192 }], chats: [chat], characters: [{ id: 'character', name: 'Тонерико', appearance: 'Серебряные волосы' }], personas: [{ id: 'player', name: 'Игрок', description: 'Путешественник' }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body), headers: options.headers });
    const content = answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { state, chat, calls };
}
test('Rewrite uses selected story model, persona, appearance and scene, leaving history intact', async t => {
  const expanded = 'Я медленно переступаю порог и задерживаюсь у входа. Оглядевшись, делаю несколько шагов вглубь дома.';
  const { state, chat, calls } = fixture(t, [expanded]), before = structuredClone(chat);
  assert.equal(await rewriteDraft(state, chat, 'я захожу в дом', () => 'session-key'), expanded);
  assert.equal(calls[0].model, 'instruct'); assert.equal(calls[0].temperature, 0.75);
  assert.match(calls[0].messages[0].content, /РАЗВЕРНУТЬ/);
  const input = JSON.parse(calls[0].messages[1].content);
  assert.equal(input.persona.description, 'Путешественник'); assert.equal(input.character.appearance, 'Серебряные волосы');
  assert.equal(input.scene.location, 'Дом Тонерико'); assert.equal(input.messages[0].content, 'Дверь открыта.');
  assert.deepEqual(chat, before);
});
test('Echoed draft triggers one expansion retry, not a false successful edit', async t => {
  const expanded = 'Я осторожно переступаю порог, на мгновение задержавшись у входа.';
  const { state, chat, calls } = fixture(t, ['Я захожу в дом.', expanded]);
  assert.equal(await rewriteDraft(state, chat, 'я захожу в дом', () => ''), expanded);
  assert.equal(calls.length, 2); assert.match(calls[1].messages[0].content, /Предыдущая попытка/);
});
test('Repeated echo reports a useful error after exactly two attempts', async t => {
  const { state, chat, calls } = fixture(t, ['Я захожу в дом.']);
  await assert.rejects(rewriteDraft(state, chat, 'я захожу в дом', () => ''), /дважды повторила/);
  assert.equal(calls.length, 2);
});
test('Reasoning/fences are removed; incomplete reasoning is not offered as an edit', () => {
  assert.equal(cleanRewrite('<think>Some reasoning</think>\n```text\nИгровой пост.\n```'), 'Игровой пост.');
  assert.throws(() => cleanRewrite('<think>Incomplete'), /рассуждениях/);
  assert.throws(() => cleanRewrite('<think>Only reasoning</think>'), /не вернула/);
});
test('Oversized draft and missing model fail before requesting generation', async t => {
  const { state, chat, calls } = fixture(t, ['Text']);
  await assert.rejects(rewriteDraft(state, chat, 'x'.repeat(20001), () => ''), /20 000/);
  state.connections[0].model = '';
  await assert.rejects(rewriteDraft(state, chat, 'Hello', () => ''), /Выберите текстовую модель/);
  assert.equal(calls.length, 0);
});
