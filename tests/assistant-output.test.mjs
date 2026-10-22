import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantOutputFilter} from '../server/assistant-output.mjs';
import {repeatedReply} from '../server/roleplay.mjs';
import {buildPrompt} from '../server/prompt.mjs';
import {pendingMemory} from '../server/memory.mjs';
import fs from 'node:fs';

const filter=chunks=>{const f=createAssistantOutputFilter();return chunks.map(s=>f.push(s)).join('')+f.flush();};
test('Local reasoning never leaks, regardless of SSE marker boundaries',()=>{
 const cases=[['<think>private scratchpad</think>Visible story.','Visible story.'],['<analysis>hidden</analysis>Сцена.','Сцена.'],['<|channel>thought\nprivate reasoning\n<|channel>final\nСцена.','\nСцена.'],['<|channel|>analysis<|message|>private<|channel|>final<|message|>Story.','Story.']];
 for(const [input,expected] of cases){
  assert.equal(filter([input]),expected);
  assert.equal(filter([...input]),expected);
  for(let split=0;split<input.length;split++)assert.equal(filter([input.slice(0,split),input.slice(split)]),expected);
 }
 assert.equal(filter(['<think>','unfinished private reasoning']),'');
});
test('Gemma 4 thought channels end at <channel|>, including every streaming split',()=>{
 const input='<|channel>thought\nPrivate scratchpad.\n<channel|>Toneriko smiles.';
 assert.equal(filter([...input]),'Toneriko smiles.');
 for(let split=0;split<input.length;split++)assert.equal(filter([input.slice(0,split),input.slice(split)]),'Toneriko smiles.');
 assert.equal(filter(['<|channel>thought\nunfinished']), '');
});
test('Ordinary narrative, short repeated dialogue and JSON strings remain verbatim',()=>{
 for(const text of ['— Да. Да. Да. Да. — Она кивнула.','The assistant offers the user a notebook.','Она написала «<think>» в блокноте.','{"snippet":"<think>literal XML</think>","status":"done"}','У неё < 5 монет.'])assert.equal(filter([...text]),text);
 assert.equal(repeatedReply('Да. '.repeat(12)),false);
});
test('Long newline model-list cycles are recognized without banning model names',()=>{
 const block=['gemini','gpt-4','claude-3','mistral','phi-2','t5','bert','llama2','bert-base-uncased','gpt-3','gpt-3.5','gemini-pro','llama3-8b','claude-2','t5-small','mistral-7b','llama-2-7b','t5-base','gemini-pro-vision','mistral-7b-instruct','llama2-7b-chat','bert-large-cased','mistral-7b-instruct-v0.1','llama2-7b-chat-v1','llama2-7b','t5-large','gpt-4o','claude-3-opus','gpt-3-turbo','llama3-70b','gemini-ultra','llama3-8b-instruct','claude-3-sonnet','gemini-pro-vision-turbo','llama3'].join('\n')+'\n';
 assert.equal(repeatedReply(block.repeat(3)),true);
 assert.equal(repeatedReply(block),false);
 assert.equal(repeatedReply('В лаборатории она сравнила gemini, gpt-4 и llama3. Затем открыла окно.'),false);
});
test('Failed repetition drafts stay editable but never become the next RP prompt or automatic memory',()=>{
 const state=JSON.parse(fs.readFileSync(new URL('../shared/seed.json',import.meta.url),'utf8')),chat=state.chats[0];
 chat.messages=[{id:'good',role:'assistant',content:'Ирис ждёт в обсерватории.'},{id:'bad',role:'assistant',content:'REPEATED_DRAFT_SENTINEL',interrupted:true,interruptionReason:'repetition'}];
 const original=structuredClone(chat);const prompt=buildPrompt(state,chat.id,'Продолжай.');
 assert.doesNotMatch(JSON.stringify(prompt.messages),/REPEATED_DRAFT_SENTINEL/);
 assert.deepEqual(pendingMemory(chat).map(p=>p.id),['good']);assert.deepEqual(chat,original);
});
