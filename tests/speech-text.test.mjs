import test from 'node:test';
import assert from 'node:assert/strict';
import {speechSentences} from '../shared/speech.mjs';
test('Fanfic fenced prose remains complete, including one-line blocks',()=>{
 for(const source of ['```Ирис подняла фонарь. Она услышала шаги.```','```text\nИрис подняла фонарь. Она услышала шаги.\n```','~~~\nИрис подняла фонарь. Она услышала шаги.\n~~~'])assert.equal(speechSentences(source).join(' '),'Ирис подняла фонарь. Она услышала шаги.');
});
test('Formatting strips no prose after a closing fence or inline code',()=>{
 assert.equal(speechSentences('```\nНачало.\n``` Продолжение. `САПФИР-731` — пароль.').join(' '),'Начало. Продолжение. САПФИР-731 — пароль.');
 assert.equal(speechSentences('```Hello\nWorld.```',240,'en').join(' '),'Hello World.');
});
test('Long Russian episode keeps every sentence and final dialogue in order',()=>{
 const source=Array.from({length:60},(_,i)=>`Ирис записала событие ${i+1}. «Лёгкий шелест, щит и кольцо», — сказала она.`).join(' ')+' Заключительная фраза: «До встречи, Селина!»';
 for(const limit of [60,160,240]){const parts=speechSentences(source,limit,'ru');assert.ok(parts.every(p=>p.length<=limit));assert.equal(parts.join(' '),source);assert.ok(parts.at(-1).includes('Селина'));}
});
