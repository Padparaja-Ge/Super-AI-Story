import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createIntegrationRouter, modelDestination, validateModelFile, validateRepo } from '../server/integrations.mjs';
import { applyRegex, convertCharacter, convertLorebook, convertPlugin, convertPreset, convertRegexRules, exportCharacter, exportLorebook, parsePngCard } from '../server/formats.mjs';

test('Character Cards preserve foreign extensions while edits export as v2 fields', () => {
  const source = {spec:'chara_card_v2', spec_version:'2.0', data:{name:'Ирис', description:'Описание', first_mes:'Привет', mes_example:'Диалог', creator_notes:'Заметки', alternate_greetings:['Вечер'], tags:['Фэнтези'], extensions:{thirdParty:{nested:42}, sas:{appearance:'Плащ', blocks:[{name:'Секрет', content:'Звёзды', enabled:true}]}}, foreignField:'preserved'}};
  const character = convertCharacter(source);
  assert.equal(character.firstMessage, 'Привет');
  assert.equal(character.appearance, 'Плащ');
  character.description = 'Изменено';
  const exported = exportCharacter(character);
  assert.equal(exported.spec, 'chara_card_v2');
  assert.equal(exported.data.description, 'Изменено');
  assert.equal(exported.data.extensions.thirdParty.nested, 42);
  assert.equal(exported.data.foreignField, 'preserved');
  assert.equal(exported.data.extensions.sas.blocks[0].content, 'Звёзды');
  assert.deepEqual(exported.data.alternate_greetings, ['Вечер']);
  assert.throws(() => convertCharacter({description:'Без имени'}), /имя/);
});

function pngChunk(type, payload) {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4);
  payload.copy(chunk, 8);
  return chunk;
}
test('PNG cards read chara metadata and reject truncated or non-card images', () => {
  const source = {spec:'chara_card_v2', data:{name:'PNG-персонаж'}};
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const meta = Buffer.from('chara\0' + Buffer.from(JSON.stringify(source)).toString('base64'));
  const png = Buffer.concat([signature, pngChunk('tEXt', meta), pngChunk('IEND', Buffer.alloc(0))]);
  assert.deepEqual(parsePngCard(png.toString('base64')), source);
  assert.deepEqual(parsePngCard('data:image/png;base64,' + png.toString('base64')), source);
  assert.throws(() => parsePngCard(png.subarray(0, 25).toString('base64')), /структура/);
  assert.throws(() => parsePngCard(Buffer.concat([signature,pngChunk('IEND', Buffer.alloc(0))]).toString('base64')), /нет карточки/);
  assert.throws(() => parsePngCard(Buffer.from('not png').toString('base64')), /PNG/);
});

test('World Info supports object and array entries, preserving extra export fields', () => {
  const book = convertLorebook({name:'Архив', extensions:{custom:true}, entries:{0:{key:['звезда'], keysecondary:['ночь'], comment:'Небо', content:'Светится', order:17, disable:true, constant:true, probability:40}}});
  assert.deepEqual(book.entries[0].keys, ['звезда']);
  assert.equal(book.entries[0].priority, 17);
  assert.equal(book.entries[0].enabled, false);
  const exported = exportLorebook(book);
  assert.equal(exported.entries['0'].probability, 40);
  assert.equal(exported.extensions.custom, true);
  assert.ok(Array.isArray(exportLorebook(book, true).entries));
  assert.throws(() => convertLorebook({name:'missing'}), /entries/);
});

test('Preset adapter normalizes real sampler fields and preserves prompt order', () => {
  const preset = convertPreset({temperature:0.7, openai_max_tokens:4096, top_p:0.95, prompts:[{identifier:'main', role:'system', content:'Ты {{char}}'}], prompt_order:[{character_id:100001,order:[{identifier:'main',enabled:true}]}]}, 'Приключение.json');
  assert.equal(preset.name, 'Приключение');
  assert.equal(preset.maxTokens, 4096);
  assert.equal(preset.prompts[0].content, 'Ты {{char}}');
  assert.equal(preset.promptOrder[0].order[0].enabled, true);
});

test('Native plugins import inactive and reject JavaScript extension manifests', () => {
  const plugin = convertPlugin({format:'sas-plugin-v1', name:'Narrator', version:'1.0', prompt:'Опиши атмосферу.'});
  assert.equal(plugin.enabled, false);
  assert.deepEqual(plugin.capabilities, ['prompt']);
  assert.throws(() => convertPlugin({display_name:'ST Extension', js:'index.js'}), error => error.supported === false);
  assert.throws(() => convertPlugin({name:'Wrong',version:'1',main:'plugin.js',prompt:'x'}), /JavaScript/);
});

test('Model paths reject traversal and Windows special paths', () => {
  assert.equal(validateRepo('author/Model-GGUF'), 'author/Model-GGUF');
  assert.equal(validateModelFile('sub/model.Q4_K_M.gguf'), 'sub/model.Q4_K_M.gguf');
  const root = path.resolve('data/models');
  assert.equal(modelDestination(root, 'author/repo', 'folder/model.gguf'), path.join(root, 'author', 'repo', 'folder', 'model.gguf'));
  for (const file of ['../evil.gguf', 'sub/../../evil.gguf', '/evil.gguf', 'C:\\evil.gguf', 'model.gguf:stream.gguf', 'NUL.gguf', 'con/model.gguf', 'dir\\evil.gguf', 'model.bin', 'bad%2f.gguf']) assert.throws(() => validateModelFile(file), undefined, file);
  for (const repo of ['../repo','author/../repo','https://evil/model','a/repo?x','a/repo#x']) assert.throws(() => validateRepo(repo));
});

test('Regex adapter honors placement, flags, captures, trims, and disabled', async () => {
  const rules = convertRegexRules([{scriptName:'Style',findRegex:'/(apple)/gi', replaceString:'**{{match}}:$1**', trimStrings:['le'],placement:[2]}, {findRegex:'/app/g',replaceString:'wrong', disabled:true,placement:[2]}]);
  assert.equal(await applyRegex('apple Apple', rules, 'output'), '**app:app** **App:App**');
  assert.equal(await applyRegex('apple', rules, 'input'), 'apple');
  assert.equal(await applyRegex('apple apple', convertRegexRules({findRegex:'apple',replaceString:'pear'})), 'pear apple');
  assert.throws(() => convertRegexRules({findRegex:'/[a/g'}), /некорректное/);
});

test('Regex prompt/display separation and depth are respected', async () => {
  const rules = convertRegexRules({findRegex:'/secret/g', replaceString:'visible', placement:[2], markdownOnly:true,minDepth:1,maxDepth:2});
  assert.equal(await applyRegex('secret', rules, 'output', {mode:'prompt',depth:1}), 'secret');
  assert.equal(await applyRegex('secret', rules, 'output', {mode:'display',depth:1}), 'visible');
  assert.equal(await applyRegex('secret', rules, 'output', {mode:'display',depth:0}), 'secret');
  assert.equal(await applyRegex('secret', rules, 'output', {mode:'storage',depth:1}), 'secret');
  const macro = convertRegexRules({findRegex:'{{char}}',replaceString:'someone', substituteRegex:2});
  assert.equal(await applyRegex('A.+ B', macro, 'output', {macros:{char:'A.+'}}), 'someone B');
});

test('Catastrophic Regex is terminated without blocking the main thread', async () => {
  const rules = convertRegexRules({findRegex:'/(a+)+$/', replaceString:'x'});
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 30);
  await assert.rejects(applyRegex('a'.repeat(35) + '!', rules), /лимит|остановлен|Regex/);
  clearTimeout(timer);
  assert.equal(responsive, true);
});

test('Integration API persists imports and rejects unsafe paths without a network request', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sas-integrations-'));
  let state = {characters:[],lorebooks:[],presets:[],regexRules:[],plugins:[],settings:{}};
  const router = createIntegrationRouter({getState:() => structuredClone(state),saveState:next => {state = structuredClone(next);},dataDir});
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (route,body) => fetch(base + route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    const imported = await (await post('/import',{kind:'character',data:{name:'Тест',first_mes:'Привет'}})).json();
    assert.equal(imported.state.characters[0].firstMessage, 'Привет');
    const exported = await (await fetch(base + '/export/character/' + imported.imported.id)).json();
    assert.equal(exported.data.name,'Тест');
    const unsupported = await post('/import',{kind:'plugin',data:{display_name:'X',js:'index.js'}});
    assert.equal(unsupported.status,400);
    assert.equal((await unsupported.json()).supported,false);
    assert.equal((await post('/hf/download',{repo:'a/b',file:'../../evil.gguf'})).status,400);
    assert.deepEqual((await (await fetch(base + '/hf/downloads')).json()).downloads,[]);
    assert.equal((await post('/runtime/start',{modelPath:'C:/evil.gguf'})).status,400);
    assert.equal((await (await fetch(base + '/runtime/status')).json()).running,false);
    const file = path.join(dataDir,'existing.gguf');
    await fs.writeFile(file,Buffer.from('GGUF\x03\x00\x00\x00'));
    const models = await (await post('/local/import',{path:file})).json();
    assert.equal(models.models[0].path,await fs.realpath(file));
  } finally {
    await router.close();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sas-integrations-'));
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
