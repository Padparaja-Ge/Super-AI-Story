import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLLMResponse,executeAction,executeActionAsync,isStructuredResponse,isValidatedResponse,responseParseError,structuredResponseSchema,structuredResponseFormat} from '../server/rag/response.mjs';
const envelope=(patch={})=>JSON.stringify({thinking:'Краткий частный план.',action_required:'none',action_params:{},narrative_text:'Торговец ждёт ответа.',...patch});
test('Plain legacy prose is unchanged and never invokes a game action',()=>{const raw='  Старый текст\nс новой строкой.  ',parsed=parseLLMResponse(raw);let calls=0;const done=executeAction(parsed,{rollDice(){calls++;},updateState(){calls++;}});assert.equal(parsed.narrative_text,raw);assert.equal(done.narrative_text,raw);assert.equal(done.success,true);assert.equal(calls,0);assert.equal(parsed.thinking,'');});
test('Whole, fenced and balanced extraneous JSON preserve braces and escaped quotes inside strings',()=>{
 for(const raw of [envelope(), '```json\n'+envelope()+'\n```','Оболочка {bad} перед ответом\n'+envelope({narrative_text:'Он сказал: "{нет}" и закрыл дверь.'})+'\nКонец']){const parsed=parseLLMResponse(raw);assert.equal(isValidatedResponse(parsed),true);assert.equal(responseParseError(parsed),undefined);assert.ok(parsed.narrative_text);assert.equal(executeAction(parsed,{}).success,true);}
 assert.match(parseLLMResponse('prefix '+envelope({narrative_text:'Он сказал: "{нет}".'})+' tail').narrative_text,/{нет}/);
});
test('Private thinking is retained only on the private parsed value and excluded from every execution result',()=>{const parsed=parseLLMResponse(envelope());assert.equal(parsed.thinking,'Краткий частный план.');assert.doesNotMatch(JSON.stringify(executeAction(parsed,{})),/Краткий частный|thinking/);assert.equal(parseLLMResponse('<think>PRIVATE</think>Нарратив').narrative_text,'Нарратив');assert.equal(parseLLMResponse('<|channel>thought\nPRIVATE\n<channel|>'+envelope()).narrative_text,'Торговец ждёт ответа.');});
test('Malformed, oversized, ambiguous and wrongly shaped structured responses never become raw visible JSON or executable actions',()=>{
 for(const raw of ['{"thinking":"SECRET","action_required":','{"hp":999}','[]','['+envelope()+']',envelope()+' '+envelope(),envelope({action_required:'eval'}),envelope({thinking:'x'.repeat(513)}),envelope({narrative_text:'x'.repeat(30001)}),'x'.repeat(64001)]){const parsed=parseLLMResponse(raw);assert.equal(parsed.action_required,'none');assert.equal(parsed.narrative_text,'');assert.equal(parsed.thinking,'');assert.ok(responseParseError(parsed));assert.equal(executeAction(parsed,{}).success,false);}
 assert.equal(isStructuredResponse(envelope()),true);assert.equal(isStructuredResponse('Обычный текст'),false);assert.ok(structuredResponseSchema.properties.narrative_text);assert.equal(structuredResponseFormat.type,'json_object');
});
test('Action guards reject client dice results, paths, nested patches and prototype fields',()=>{
 const invalid=[{action_required:'roll_dice',action_params:{formula:'1d20',roll:20}},{action_required:'roll_dice',action_params:{formula:'0d20'}},{action_required:'roll_dice',action_params:{formula:'1d0'}},{action_required:'update_state',action_params:{field:'actors.0.hp',value:999}},{action_required:'update_state',action_params:{field:'hp',value:{nested:1}}},{action_required:'update_state',action_params:{field:'__proto__',value:'x'}},{action_required:'none',action_params:{field:'notes',value:'x'}}];
 for(const patch of invalid)assert.ok(responseParseError(parseLLMResponse(envelope(patch))));assert.ok(responseParseError(parseLLMResponse(envelope().replace('"action_params":{}','"action_params":{"__proto__":{}}'))));
});
test('Only parser-validated immutable responses can invoke the injected engine; engine errors are safe results',()=>{
 const parsed=parseLLMResponse(envelope({action_required:'roll_dice',action_params:{formula:'1d20',target:'task'}}));let calls=0;const engine={rollDice(params){calls++;assert.equal(params.formula,'1d20');return {roll:7};},updateState(){throw new Error('Unexpected');}};
 assert.equal(executeAction(parsed,engine).result.roll,7);assert.equal(calls,1);assert.equal(executeAction(structuredClone(parsed),engine).success,false);assert.equal(calls,1);assert.throws(()=>{parsed.action_required='none';},TypeError);assert.throws(()=>{parsed.action_params.formula='1d1';},TypeError);
 const failed=executeAction(parsed,{rollDice(){throw new Error('Проверка уже выполнена.');}});assert.equal(failed.success,false);assert.match(failed.error,/уже выполнена/);assert.equal(failed.narrative_text,'');
});
test('Async execution is explicit, catches errors and keeps the exact public narrative projection',async()=>{
 const parsed=parseLLMResponse(envelope({action_required:'update_state',action_params:{field:'notes',value:'Туман.'}})),engine={async updateState(params){return {value:params.value};}};
 assert.equal(executeAction(parsed,engine).success,false);const done=await executeActionAsync(parsed,engine);assert.equal(done.success,true);assert.equal(done.result.value,'Туман.');assert.equal(done.narrative_text,'Торговец ждёт ответа.');assert.doesNotMatch(JSON.stringify(done),/thinking|частный/);
 assert.equal((await executeActionAsync(parsed,{async updateState(){throw new Error('Отказ');}})).success,false);
});
test('Duplicate fields and a valid envelope followed by a truncated second command are rejected',()=>{
 for(const raw of [envelope().replace('"action_required":"none"','"action_required":"roll_dice","action_required":"none"'),envelope({action_required:'update_state',action_params:{field:'notes',value:'A'}}).replace('"value":"A"','"value":"B","value":"A"'),envelope()+' {"action_required":"roll_dice"'])assert.ok(responseParseError(parseLLMResponse(raw)));
 assert.equal(parseLLMResponse('<think>PRIVATE1</think><analysis>PRIVATE2</analysis>Чистый текст').narrative_text,'Чистый текст');
});
