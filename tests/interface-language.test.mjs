import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTranslator,normalizeInterfaceLanguage,interfaceLanguages} from '../shared/ui-language.mjs';
import {createInterfaceLanguage} from '../server/interface-language.mjs';
import {localizeSource} from '../scripts/localize-ui.mjs';
test('Interface locale validates supported choices and interpolates values exactly once as plain text',()=>{
 let language='en';const t=createTranslator({en:{'Привет, {0}!':'Hello, {0}!','Сохранить':'Save'}},()=>language);
 assert.equal(t('Привет, {0}!',['<b>{1}</b>']),'Hello, <b>{1}</b>!');assert.equal(t(' Сохранить '),' Save ');
 assert.equal(t('unregistered user content'),'unregistered user content');assert.equal(t(null),null);
 language='ru';assert.equal(t('Привет, {0}!',['Анна']),'Привет, Анна!');language='../../other';assert.equal(t('Сохранить'),'Сохранить');
 assert.equal(normalizeInterfaceLanguage('ja'),'ja');assert.equal(normalizeInterfaceLanguage('zh-CN'),'zh-CN');assert.equal(normalizeInterfaceLanguage({}),'ru');assert.equal(interfaceLanguages.length,5);
});
test('UI text transformation preserves prompt data, handlers, comparison operands and option values',()=>{
 const source=`const prompt='Пример сюжета'; const x=<><button onClick={()=>send('Сохранить')}>Сохранить</button><input value="Данные" placeholder="Введите имя"/><select><option value="Игрок">Игрок</option></select><p>{ready==='Готово'?'Включено':'Выключено'}</p><h1>{character.name}</h1></>;`;
 const result=localizeSource(source,'fixture.tsx');
 assert.match(result,/prompt='Пример сюжета'/);assert.match(result,/send\('Сохранить'\)/);assert.match(result,/value="Данные"/);assert.match(result,/value="Игрок"/);assert.match(result,/ready==='Готово'/);assert.match(result,/\{character.name\}/);assert.match(result,/placeholder=\{t\("Введите имя"\)\}/);assert.match(result,/t\("Сохранить"\)/);assert.match(result,/t\('Включено'\)/);
 assert.equal(localizeSource(result,'fixture.tsx'),result);
});
test('Interface language survives server restart independently of story saves and rejects invalid input',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-ui-language-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));
 const prefs=createInterfaceLanguage(dir);assert.equal(await prefs.read(),null);assert.throws(()=>prefs.write({language:'xx'}),/Unsupported/);
 await Promise.all(['en','ja','zh-CN'].map(language=>prefs.write({language})));assert.equal(await createInterfaceLanguage(dir).read(),'zh-CN');
 assert.deepEqual(await fs.readdir(dir),['interface-language.json']);
});
test('All four bundled catalogs cover UI keys and preserve every interpolation parameter',async()=>{
 const keys=JSON.parse(await fs.readFile(new URL('../shared/locales/source.json',import.meta.url),'utf8'));
 const markers=text=>[...text.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();
 for(const language of ['en','ja','zh-CN','ko']){
  const catalog=JSON.parse(await fs.readFile(new URL(`../shared/locales/${language}.json`,import.meta.url),'utf8'));
  for(const key of keys){assert.ok(typeof catalog[key]==='string'&&catalog[key].trim(),language+': missing '+key);assert.deepEqual(markers(catalog[key]),markers(key),language+': interpolation '+key);}
  const t=createTranslator({[language]:catalog},()=>language);assert.notEqual(t('Настройки'),'Настройки');assert.notEqual(t('Язык интерфейса'),'Язык интерфейса');
 }
});
