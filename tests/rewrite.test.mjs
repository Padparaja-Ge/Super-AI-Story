import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteDraft, cleanRewrite } from '../server/services/rewriteService.js';

function fixture(t, answers) {
  const calls = [], chat = { id: 'story', characterId: 'character', personaId: 'player', connectionId: 'story-model', scene: { location: 'Дом Тонерико', time: 'Вечер' }, messages: [{ role: 'assistant', content: 'Оригинал', translatedContent: 'Дверь открыта.' }] };
  const state = { activeConnectionId: 'other', connections: [{ id: 'story-model', baseUrl: 'http://localhost:1234/v1', model: 'instruct', contextWindow: 8192 }], chats: [chat], characters: [{ id: 'character', name: 'Тонерико', appearance: 'Серебряные волосы' }], personas: [{ id: 'player', name: 'Игрок', description: 'Путешественник' }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body), headers: options.headers });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer?.error) return new Response(JSON.stringify({error:{message:answer.error}}),{status:answer.status||400,headers:{'Content-Type':'application/json'}});
    const content = typeof answer === 'string' ? answer : JSON.stringify(answer?.value || answer);
    return new Response(JSON.stringify({ choices: [{ message: { content }, ...(answer?.finish ? {finish_reason:answer.finish} : {}) }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { state, chat, calls };
}
test('Rewrite uses selected story model, persona, appearance and scene, leaving history intact', async t => {
  const expanded = 'Я медленно переступаю порог и задерживаюсь у входа. Оглядевшись, делаю несколько шагов вглубь дома.';
  const { state, chat, calls } = fixture(t, [expanded]), before = structuredClone(chat);
  assert.equal(await rewriteDraft(state, chat, 'я захожу в дом', () => 'session-key'), expanded);
  assert.equal(calls[0].model, 'instruct'); assert.equal(calls[0].temperature, 0.45);
  assert.match(calls[0].messages[0].content, /РАЗВЕРНУТЬ/);
  assert.equal(calls[0].messages.at(-1).content,'я захожу в дом');
  const input = JSON.parse(calls[0].messages[0].content.split('СПРАВОЧНЫЙ КОНТЕКСТ JSON (прошлые сообщения уже отправлены; их НЕ редактировать):\n')[1]);
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
  await assert.rejects(rewriteDraft(state, chat, 'я захожу в дом', () => ''), /Повторён исходный черновик.*Исходник сохранён/);
  assert.equal(calls.length, 2);
});

test('Room editor selects the new draft even after unrelated lobby posts and retries a copied old post',async t=>{
 const {rewriteRoomDraft}=await import('../server/room-rewrite.mjs');const {state,calls}=fixture(t,['Я жду у двери.','Я осторожно раскрываю книгу, придерживая потрёпанные страницы.']);
 const original=structuredClone(state),result=await rewriteRoomDraft(state,{text:'Открываю книгу.',connectionId:'story-model',persona:state.personas[0],room:{messages:[{role:'user',name:'Сосед',content:'Я жду у двери.'}]}},()=>'',new AbortController().signal);
 assert.match(result,/книгу/);assert.equal(calls.length,2);assert.ok(calls.every(call=>call.messages.at(-1).content==='Открываю книгу.'));assert.deepEqual(state,original);
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

const edit = (draft, checks = {}) => ({intent:'Действие из нового черновика игрока',draft,checks:{sameIntent:true,samePointOfView:true,sameSpeech:true,noNpcResponse:true,noAdjudication:true,...checks}});
function native(f) {
  f.state.connections[0].id = 'sas-local'; f.state.connections[0].promptFormat = 'alpaca'; f.chat.connectionId = 'sas-local';
  f.state.settings = {localSampling:{temperature:1.7,maxTokens:4096}};
  return f;
}

test('Native editor plans intent in one constrained response, adapts Alpaca and disables thinking', async t => {
  const result = 'Я осторожно подхожу к двери и пробую открыть её, придерживая ручку ладонью.';
  const f = native(fixture(t, [edit(result)])), before = structuredClone(f.state);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я пробую открыть дверь.',()=>''), result);
  assert.equal(f.calls.length,1);assert.deepEqual(f.state,before);
  const request=f.calls[0];assert.equal(request.temperature,.45);assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.equal(request.reasoning_effort,'none');
  assert.equal(request.messages.length,1);assert.equal(request.messages[0].role,'user');assert.match(request.messages[0].content,/попыткой/);assert.ok(request.messages[0].content.endsWith('Я пробую открыть дверь.'));
  assert.deepEqual(request.response_format.schema.required,['intent','draft','checks']);
});

test('A self-reported change of action gets one correction even without detectable narrator phrases', async t => {
  const good='Я держу меч перед собой и предлагаю его на продажу, неторопливо подбирая слова.';
  const f=fixture(t,[edit('Я выбираю меч для покупки.',{sameIntent:false}),edit(good)]);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я предлагаю продать меч.',()=>''),good);
  assert.equal(f.calls.length,2);assert.match(f.calls[1].messages[0].content,/Самопроверка/);
});

for (const [label, source, wrong, corrected, feedback] of [
  ['NPC response','Я пытаюсь выторговать скидку.','Я спокойно прошу скидку. Торговец согласился и снизил цену.','Я спокойно подбираю слова, пытаясь выторговать скидку.',/реакция или решение NPC/],
  ['GM role','Пробую сдвинуть валун.','Мастер: Ты сдвигаешь валун с дороги.','Я упираюсь ладонями в валун и пробую сдвинуть его, напрягая руки.',/роль мастера/],
  ['GM second-person reply','Пробую открыть дверь.','Ты видишь, как дверь распахивается.','Осторожно берусь за ручку и пробую открыть дверь.',/второго лица/],
  ['awarded check','Я пробую запугать стражника.','Я грозно смотрю на стражника. Проверка успешна.','Я стараюсь придать голосу твёрдость и пробую запугать стражника.',/присудил результат/],
  ['lost first person','Я открываю книгу.','Путешественник осторожно открывает книгу.','Я осторожно раскрываю книгу, придерживая страницы рукой.',/Первое лицо/],
  ['changed speech','Я говорю: «Скидку не прошу, ищу владельца».','Я улыбаюсь и говорю: «Прошу скидку».','Я выпрямляюсь и спокойно говорю: «Скидку не прошу, ищу владельца».',/прямая речь/],
  ['changed roll','Я пытаюсь запугать стражника. Бросок d20: 2.','Я грозно смотрю на стражника. Бросок d20: 20.','Я стараюсь говорить твёрдо, пытаясь запугать стражника. Бросок d20: 2.',/числовые значения/],
  ['invented roll','Я пробую открыть дверь.','Я осторожно берусь за ручку. Проверка ловкости: 19.','Я осторожно берусь за ручку и пробую открыть дверь.',/числовые значения/],
  ['changed language','Рагнар пытается сдвинуть валун.','Ragnar braces against the rock and tries to push it aside.','Рагнар упирается ладонями в валун и пытается сдвинуть его с места.',/язык/]
]) test('Player draft rejects '+label+' and retries only the original draft', async t => {
  const f=fixture(t,[edit(wrong),edit(corrected)]),before=structuredClone(f.state);
  assert.equal((await rewriteDraft(f.state,f.chat,source,()=>'' )).replace(/\s+/g,' '),corrected);
  assert.equal(f.calls.length,2);assert.match(f.calls[1].messages[0].content,feedback);
  assert.ok(f.calls.every(call=>call.messages.at(-1).content===source));assert.deepEqual(f.state,before);
  assert.ok(!f.calls[1].messages.some(message=>message.role==='assistant'));
});

test('Existing outcome, exact quoted dialogue and numbers are preserved without treating player speech as GM narration', async t => {
  const source='Я показываю пустую банку и говорю: «Мне удалось найти только это». Бросок d20: 4.';
  const good='Я невесело показываю пустую банку, поворачивая её в ладони, и говорю: «Мне удалось найти только это». Бросок d20: 4.';
  const f=fixture(t,[edit(good)]);
  assert.equal((await rewriteDraft(f.state,f.chat,source,()=>'' )).replace(/\s+/g,' '),good);assert.equal(f.calls.length,1);
});

test('DND rewrite uses four actual posts despite intervening dice and events, with character identities only', async t => {
  const {rewriteRoomDraft}=await import('../server/room-rewrite.mjs');
  const f=fixture(t,[edit('Я оглядываю пустую банку, поворачивая её в руке, и мрачно вздыхаю.')]);
  const room={mode:'dnd',personas:{host:{name:'Бог'},guest:{name:'Мопс'}},messages:[
    {role:'user',name:'Логин',userId:'host',content:'Слишком старый пост'},
    {role:'assistant',name:'AI Game Master',content:'Логин видит торговца у дороги.'},
    {role:'user',name:'Логин',userId:'host',content:'Жду возле лавки.'},
    {role:'assistant',name:'AI Game Master',content:'Банка оказалась пустой.'},
    {role:'user',name:'ДругЛогин',userId:'guest',content:'Оглядываю пустую банку.'},
    ...[2,3,4,5,6].map(value=>({role:'user',kind:'dice',name:'ДругЛогин',userId:'guest',content:'Бросок d20: '+value,dice:{sides:20,value}})),
    {role:'system',kind:'event',content:'Раунд 3 завершён'}
  ]};
  const before=structuredClone(room);
  const result=await rewriteRoomDraft(f.state,{text:'Я оглядываю пустую банку и вздыхаю.',connectionId:'story-model',persona:{...f.state.personas[0],name:'Мопс'},room},()=>'',new AbortController().signal);
  assert.match(result,/пустую банку/);assert.deepEqual(room,before);
  const context=JSON.parse(f.calls[0].messages[0].content.split('СПРАВОЧНЫЙ КОНТЕКСТ JSON (прошлые сообщения уже отправлены; их НЕ редактировать):\n')[1]);
  assert.equal(context.mode,'dnd');assert.equal(context.messages.length,4);assert.equal(context.recentChecks.length,4);
  assert.match(context.messages[0].content,/Бог видит торговца/);assert.match(context.messages.at(-1).content,/Мопс:/);
  assert.doesNotMatch(JSON.stringify(context),/Логин|Раунд 3 завершён|Слишком старый пост/);
});

test('Truncated structured response is regenerated once rather than offered as a partial post', async t => {
  const good='Я неторопливо раскрываю книгу и придерживаю страницы ладонью.';
  const f=fixture(t,[{value:edit('Я открываю книгу и'),finish:'length'},edit(good)]);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я открываю книгу.',()=>''),good);
  assert.equal(f.calls.length,2);assert.match(f.calls[1].messages[0].content,/оборван лимитом/);
});

test('Native malformed edits fail after two calls and leave draft, story and sampling settings untouched', async t => {
  const f=native(fixture(t,['{"intent":"открыть книгу","draft":"',edit('Я покупаю меч.',{sameIntent:false})]));
  const before=structuredClone(f.state);
  await assert.rejects(rewriteDraft(f.state,f.chat,'Я открываю книгу.',()=>''),/Исходник сохранён/);
  assert.equal(f.calls.length,2);assert.deepEqual(f.state,before);
});

test('External servers without JSON schema get at most one compatibility retry', async t => {
  const good='Я осторожно приоткрываю дверь, придерживая ручку ладонью.';
  const f=fixture(t,[{status:400,error:'response_format json_schema is not supported'},good]);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я открываю дверь.',()=>''),good);
  assert.equal(f.calls.length,2);assert.ok(f.calls[0].response_format);assert.equal(f.calls[1].response_format,undefined);
});

test('Cancelled edit never starts a model request and never changes the draft', async t => {
  const f=fixture(t,['Text']),controller=new AbortController(),before=structuredClone(f.state);controller.abort();
  await assert.rejects(rewriteDraft(f.state,f.chat,'Открываю книгу.',()=>'',controller.signal),error=>error.name==='AbortError');
  assert.equal(f.calls.length,0);assert.deepEqual(f.state,before);
});

test('SAS inserts player speech and the d20 check itself when the native model edits surrounding prose', async t => {
  const value=edit('');delete value.draft;value.parts=['Я чуть склоняю голову, пытаясь уговорить торговца снизить цену: ','.'];
  const f=native(fixture(t,[value])),source='Я пытаюсь уговорить торговца сделать скидку. Говорю: «Можно дешевле?» Проверка харизмы, d20: 2.';
  assert.equal(await rewriteDraft(f.state,f.chat,source,()=>''),'Я чуть склоняю голову, пытаясь уговорить торговца снизить цену: «Можно дешевле?»\nПроверка харизмы, d20: 2.');
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].response_format.schema.required,['intent','parts','checks']);
});

test('Native multi-quote edit preserves order, negation and literal English dialogue without regeneration', async t => {
  const value=edit('');delete value.draft;value.parts=['I lift the note and write: ',' Then I add: ','.'];
  const f=native(fixture(t,[value]));
  const source='I write: "No, I will not attack" and "hello, you are beautiful".';
  assert.equal(await rewriteDraft(f.state,f.chat,source,()=>''),'I lift the note and write: "No, I will not attack" Then I add: "hello, you are beautiful".');
  assert.equal(f.calls.length,1);assert.match(f.calls[0].messages[0].content,/OUTPUT LANGUAGE: English/);
});

test('Russian first-person verbs can be implicit; an omitted Я alone is not a role change', async t => {
  const good='Осторожно раскрываю книгу, придерживая страницы ладонью.',f=fixture(t,[edit(good)]);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я открываю книгу.',()=>''),good);assert.equal(f.calls.length,1);
});

test('The named RP character cannot replace the player as the subject of an edit', async t => {
  const good='Я осторожно приоткрываю дверь и задерживаюсь на пороге.',f=fixture(t,[edit('Тонерико осторожно приоткрывает дверь и улыбается.'),edit(good)]);
  assert.equal(await rewriteDraft(f.state,f.chat,'Я открываю дверь.',()=>''),good);assert.equal(f.calls.length,2);
  assert.match(f.calls[1].messages[0].content,/Первое лицо/);
});
