import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredNarration} from '../server/gm-structured-narration.mjs';
const connection={id:'mock',model:'same-model',contextWindow:8192,maxTokens:200},messages=[{role:'system',content:'ORIGINAL SYSTEM PROMPT'},{role:'user',content:'Герой ждёт у двери.'}];
const envelope=(patch={})=>JSON.stringify({thinking:'PRIVATE_PLAN',action_required:'none',action_params:{},narrative_text:'Страж отвечает герою.',...patch});
const action=envelope({action_required:'roll_dice',action_params:{formula:'1d20',target:'task'},narrative_text:'Преждевременный предполагаемый успех.'});
function completion(answers,calls=[]){return async(c,s,m,o)=>{calls.push({connection:c,secret:s,messages:structuredClone(m),options:o});const next=answers[calls.length-1];if(next instanceof Error)throw next;if(next&&typeof next==='object'){o.onFinish(next.reason);return next.text;}o.onFinish?.('stop');return next;};}
test('A narrative-only JSON response buffers privately and leaves the original system prompt unchanged',async()=>{
 const calls=[],before=structuredClone(messages),done=await generateStructuredNarration({connection,secret:'secret',messages,complete:completion([envelope()],calls)});assert.deepEqual(done,{text:'Страж отвечает герою.',utilityCalls:1});assert.doesNotMatch(JSON.stringify(done),/PRIVATE_PLAN|thinking|secret/);assert.deepEqual(messages,before);assert.deepEqual(calls[0].messages,before);assert.equal(calls[0].options.responseFormat.type,'json_schema');assert.equal(calls[0].connection.model,'same-model');
});
test('One action uses two calls to the same model, passes only authoritative public engine data and executes once',async()=>{
 const calls=[];let rolls=0;const done=await generateStructuredNarration({connection,secret:'secret',messages,engine:{rollDice(){rolls++;return {roll:7,outcome:'failure',thinking:'ENGINE_PRIVATE'};}},complete:completion([action,envelope({narrative_text:'Страж не смог открыть дверь.'})],calls)});
 assert.equal(rolls,1);assert.equal(done.utilityCalls,2);assert.equal(done.text,'Страж не смог открыть дверь.');assert.equal(done.actionResult.result.roll,7);assert.deepEqual(calls[1].messages.slice(0,messages.length),messages);assert.equal(calls[1].connection.model,'same-model');assert.doesNotMatch(JSON.stringify(calls[1].messages),/PRIVATE_PLAN|ENGINE_PRIVATE|thinking|Преждевременный/);
 const result=JSON.parse(calls[1].messages.at(-1).content);assert.equal(result.kind,'SAS_ENGINE_ACTION_RESULT');assert.equal(result.authoritative,true);assert.equal(result.result.outcome,'failure');assert.doesNotMatch(JSON.stringify(done),/PRIVATE/);
});
test('Model errors, malformed JSON and length termination never execute even a complete-looking action',async()=>{
 for(const answer of [new Error('provider error PRIVATE_PLAN'),'{"thinking":"PRIVATE_PLAN","action_required":',{text:action,reason:'length'}]){let calls=0;await assert.rejects(()=>generateStructuredNarration({connection,messages,engine:{rollDice(){calls++;}},complete:completion([answer])}),error=>error.code==='GM_STRUCTURED_RESPONSE'&&!/PRIVATE_PLAN/.test(error.message));assert.equal(calls,0);}
});
test('Regeneration or continuation with actions disabled cannot mutate mechanics',async()=>{for(const engine of [undefined,{rollDice(){throw new Error('Must never run');}}])await assert.rejects(()=>generateStructuredNarration({connection,messages,engine,actionsAllowed:false,complete:completion([action])}),error=>error.code==='GM_STRUCTURED_ACTION');});
test('Unsupported format retries once without format, retaining connection and exact prompt',async()=>{
 const calls=[],unsupported=Object.assign(new Error('unsupported response_format'),{status:400});const done=await generateStructuredNarration({connection,messages,complete:completion([unsupported,envelope()],calls)});assert.equal(done.utilityCalls,2);assert.equal(calls[1].options.responseFormat,undefined);assert.deepEqual(calls[1].messages,calls[0].messages);assert.equal(calls[1].connection.model,'same-model');
 const local=[];await generateStructuredNarration({connection:{...connection,id:'sas-local'},messages,complete:completion([envelope()],local)});assert.equal(local[0].options.responseFormat,undefined);assert.match(local[0].options.grammar,/^root ::= /);assert.deepEqual(local[0].messages,messages);
});
test('A failed action is reported to the second call instead of publishing the model premature success',async()=>{
 const calls=[],done=await generateStructuredNarration({connection,messages,engine:{rollDice(){throw new Error('Проверка уже завершена.');}},complete:completion([action,envelope({narrative_text:'Страж остаётся у закрытой двери.'})],calls)});assert.equal(done.actionResult.success,false);assert.equal(done.text,'Страж остаётся у закрытой двери.');assert.equal(JSON.parse(calls[1].messages.at(-1).content).success,false);assert.doesNotMatch(calls[1].messages.at(-2).content,/предполагаемый успех/);
});
test('Action chains are rejected after the first action and oversized results cannot reach another model call',async()=>{
 let count=0;await assert.rejects(()=>generateStructuredNarration({connection,messages,engine:{rollDice(){count++;return {roll:7};}},complete:completion([action,action])}),error=>error.code==='GM_STRUCTURED_ACTION');assert.equal(count,1);
 const calls=[];await assert.rejects(()=>generateStructuredNarration({connection,messages,engine:{rollDice(){return 'x'.repeat(13000);}},complete:completion([action],calls)}),/слишком велик/);assert.equal(calls.length,1);
});
test('Followup budget and cancellation are enforced without extra utility requests',async()=>{
 const calls=[];await assert.rejects(()=>generateStructuredNarration({connection:{...connection,contextWindow:700},messages,engine:{rollDice(){return '🌍'.repeat(800);}},complete:completion([action],calls)}),/не помещаются/);assert.equal(calls.length,1);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>generateStructuredNarration({connection,messages,signal:controller.signal,complete:completion([],[])}),error=>error.name==='AbortError');
});
test('Action result is pinned exactly once before a failed followup, without a private plan or premature narrative',async()=>{
 const calls=[],pinned=[];let applied=0;
 await assert.rejects(()=>generateStructuredNarration({connection,messages,engine:{rollDice(){applied++;return {roll:7,thinking:'PRIVATE_ENGINE'};}},onActionResult:async payload=>{assert.equal(calls.length,1);pinned.push(structuredClone(payload));},complete:completion([action,new Error('PRIVATE_UPSTREAM')],calls)}),error=>error.code==='GM_STRUCTURED_RESPONSE'&&!/PRIVATE/.test(error.message));
 assert.equal(applied,1);assert.equal(pinned.length,1);assert.equal(pinned[0].action_required,'roll_dice');assert.equal(pinned[0].result.roll,7);assert.doesNotMatch(JSON.stringify(pinned),/thinking|PRIVATE|narrative_text|предполагаемый/);
});
test('A failing pin callback stops followup safely after the one applied action',async()=>{
 const calls=[];let applied=0;await assert.rejects(()=>generateStructuredNarration({connection,messages,engine:{rollDice(){applied++;return 7;}},onActionResult:()=>{throw new Error('PRIVATE_DISK');},complete:completion([action],calls)}),error=>error.code==='GM_STRUCTURED_ACTION'&&!/PRIVATE/.test(error.message));assert.equal(applied,1);assert.equal(calls.length,1);
});
test('Injected native token counts protect both unchanged prompts and the result followup',async()=>{
 const calls=[],counts=[];await assert.rejects(()=>generateStructuredNarration({connection:{...connection,id:'sas-local',contextWindow:1000},messages,engine:{rollDice(){return {roll:7};}},countTokens:async(c,s,input)=>{counts.push(structuredClone(input));return input.length>messages.length?900:200;},complete:completion([action],calls)}),/не помещаются/);assert.equal(calls.length,1);assert.equal(counts.length,2);assert.deepEqual(counts[0],messages);assert.deepEqual(counts[1].slice(0,messages.length),messages);
});
test('Structured narration respects an explicitly requested output budget above 2048',async()=>{
 const calls=[];await generateStructuredNarration({connection:{...connection,contextWindow:8192},messages,maxTokens:3000,complete:completion([envelope()],calls)});
 assert.equal(calls[0].connection.maxTokens,3000);
});

test('Native grammar limits action kinds to server capabilities and forces narrative-only followup',async()=>{
 const c={...connection,id:'sas-local'},calls=[];
 const done=await generateStructuredNarration({connection:c,messages,allowedActions:['roll_dice'],engine:{rollDice(){return {roll:7};}},complete:completion([action,envelope()],calls)});
 assert.equal(done.utilityCalls,2);assert.equal(calls[0].options.grammar.match(/^decision ::= .*$/m)[0],'decision ::= none-decision | roll-decision');assert.equal(calls[1].options.grammar.match(/^decision ::= .*$/m)[0],'decision ::= none-decision');
 const locked=[];await generateStructuredNarration({connection:c,messages,allowedActions:[],engine:{rollDice(){assert.fail('No capability');}},complete:completion([envelope()],locked)});assert.equal(locked[0].options.grammar.match(/^decision ::= .*$/m)[0],'decision ::= none-decision');
 await assert.rejects(()=>generateStructuredNarration({connection:c,messages,allowedActions:[],engine:{rollDice(){assert.fail('No capability');}},complete:completion([action])}),error=>error.code==='GM_STRUCTURED_ACTION');
});
