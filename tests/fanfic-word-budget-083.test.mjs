import test from 'node:test';
import assert from 'node:assert/strict';
import {measureFanficWordBudget,fanficSceneWordLimit} from '../server/fanfic-word-budget.mjs';
test('Word budget uses native tokenizer difference including adapted template and narrows fine-grained Russian vocabularies',async()=>{
 const calls=[];const native=ratio=>async(_c,_s,messages,opts)=>{calls.push({messages,opts});const sample=JSON.parse(messages[1].content).sample;return 20+(sample?sample.match(/[\p{L}\p{N}]+/gu).length*ratio:0);};
 const local={id:'sas-local'},a=await measureFanficWordBudget(local,'','Русский текст',{countTokens:native(3)}),b=await measureFanficWordBudget(local,'','Русский текст',{countTokens:native(8)});
 assert.equal(a.tokenizer,'model');assert.equal(b.tokensPerWord,8);assert.ok(fanficSceneWordLimit(520,b.tokensPerWord)<fanficSceneWordLimit(520,a.tokensPerWord));assert.ok(calls.every(call=>call.opts.adaptInstruction&&call.opts.disableThinking));
});
test('Remote or unavailable native tokenization uses a conservative finite budget and does not perform text generation',async()=>{
 let calls=0;const countTokens=async()=>{calls++;return null;};
 const remote=await measureFanficWordBudget({id:'remote'},'','Проза',{countTokens});assert.equal(calls,0);assert.equal(remote.tokenizer,'estimate');assert.equal(remote.tokensPerWord,8);
 const local=await measureFanficWordBudget({id:'sas-local'},'','Проза',{countTokens});assert.equal(local.tokenizer,'estimate');assert.equal(calls,2);assert.ok(fanficSceneWordLimit(128,8)<20);
});
test('Measurement propagates abort rather than silently falling back after cancellation',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(measureFanficWordBudget({id:'sas-local'},'','Текст',{signal:controller.signal}),/abort/i);
});
