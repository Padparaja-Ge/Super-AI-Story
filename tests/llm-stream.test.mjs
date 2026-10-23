import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {streamCompletion,countCompletionTokens} from '../server/llm.mjs';
import {gmJsonGrammar} from '../server/gm-json-grammar.mjs';

async function fixture(t,wire){
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(wire);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return {model:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
}
const delta=text=>'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';
test('Streaming EOF without a terminal marker preserves partial prose and reports interruption',async t=>{
 const connection=await fixture(t,delta('Сцена начинается. ')+delta('Дверь открылась'));
 let saved='';await assert.rejects(async()=>{for await(const chunk of streamCompletion(connection,'',[{role:'user',content:'continue'}]))saved+=chunk;},e=>e.code==='STREAM_INCOMPLETE');
 assert.equal(saved,'Сцена начинается. Дверь открылась');
});
test('Final DONE without newline is a complete streaming response',async t=>{
 const connection=await fixture(t,delta('Завершённая сцена.')+'data: [DONE]');let text='';
 for await(const chunk of streamCompletion(connection,'',[{role:'user',content:'write'}]))text+=chunk;
 assert.equal(text,'Завершённая сцена.');
});
test('Providers that end SSE with finish_reason instead of DONE remain compatible',async t=>{
 const finish='data: '+JSON.stringify({choices:[{delta:{content:'Последняя фраза.'},finish_reason:'length'}]});
 const connection=await fixture(t,finish);let reason,text='';
 for await(const chunk of streamCompletion(connection,'',[{role:'user',content:'write'}],{onFinish:value=>{reason=value;}}))text+=chunk;
 assert.equal(text,'Последняя фраза.');assert.equal(reason,'length');
});
test('Local token budget measures the same adapted template, preserving backend-only auth',async()=>{
 const calls=[],connection={id:'sas-local',baseUrl:'http://127.0.0.1:9011/v1',promptFormat:'alpaca'};
 const count=await countCompletionTokens(connection,'test-secret',[{role:'system',content:'Canon requirements'},{role:'user',content:'Continue the episode'}],{adaptInstruction:true,disableThinking:true,fetcher:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body,auth:options.headers.Authorization});
  return Response.json(url.endsWith('/apply-template')?{prompt:'### Instruction:\nCanon requirements\n\nContinue the episode\n### Response:'}:{tokens:[1,2,3,4,5]});
 }});
 assert.equal(count,5);assert.equal(calls[0].url,'http://127.0.0.1:9011/apply-template');
 assert.deepEqual(calls[0].body.messages,[{role:'user',content:'Canon requirements\n\nContinue the episode'}]);assert.equal(calls[0].body.chat_template_kwargs.enable_thinking,false);
 assert.equal(calls[1].url,'http://127.0.0.1:9011/tokenize');assert.equal(calls[1].body.add_special,true);assert.equal(calls[1].body.content,'### Instruction:\nCanon requirements\n\nContinue the episode\n### Response:');
 assert.ok(calls.every(c=>c.auth==='Bearer test-secret'));
});
test('External providers do not receive optional llama tokenizer calls; unavailable tokenizer falls back',async()=>{
 let called=0;const fetcher=async()=>{called++;return new Response('',{status:404});};
 assert.equal(await countCompletionTokens({id:'openrouter',baseUrl:'https://api.example/v1'},'',[],{fetcher}),null);assert.equal(called,0);
 assert.equal(await countCompletionTokens({id:'sas-local',baseUrl:'http://127.0.0.1:9011/v1'},'',[],{fetcher}),null);assert.equal(called,1);
});

test('Local streamed reasoning is removed before rendering; explicit final prose is preserved',async t=>{
 const connection={...await fixture(t,delta('<thi')+delta('nk>private analysis</th')+delta('ink>Новый ответ.')+'data: [DONE]'),id:'sas-local'};
 let text='';for await(const chunk of streamCompletion(connection,'',[{role:'user',content:'Reply'}],{adaptInstruction:true}))text+=chunk;
 assert.equal(text,'Новый ответ.');
});
test('Local repetition guard also protects non-Alpaca stories, while external APIs remain unchanged',async t=>{
 const block='Повторяющаяся фраза: страж стоит у двери и ждёт следующего вопроса. ';
 const connection=await fixture(t,Array.from({length:8},()=>delta(block)).join('')+'data: [DONE]');let text='';
 await assert.rejects(async()=>{for await(const chunk of streamCompletion({...connection,id:'sas-local',promptFormat:'single-system'},'',[],{}))text+=chunk;},e=>e.code==='RESPONSE_REPETITION');
 assert.ok(text.length>0&&text.length<block.length*8);
 let external='';for await(const chunk of streamCompletion(connection,'',[],{}))external+=chunk;
 assert.equal(external,block.repeat(8));
 await assert.rejects(async()=>{for await(const _chunk of streamCompletion(connection,'',[],{guardRepetition:true})){};},e=>e.code==='RESPONSE_REPETITION');
});

test('External providers returning reasoning inside content cannot expose it in the visible answer',async t=>{
 const connection=await fixture(t,delta('<think>private provider scratchpad</think>Visible answer.')+'data: [DONE]');let text='';
 for await(const chunk of streamCompletion(connection,'',[],{}))text+=chunk;
 assert.equal(text,'Visible answer.');
});

test('Native JSON grammar reaches llama.cpp without response_format and preserves the source prompt',async t=>{
 const received=[],prose='Страж стоит у двери и ждёт следующего вопроса. '.repeat(10),json=JSON.stringify({thinking:'PRIVATE_PLAN',action_required:'none',action_params:{},narrative_text:prose});
 const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;received.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(delta(json)+'data: [DONE]');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const connection={id:'sas-local',model:'gemma-qa',baseUrl:`http://127.0.0.1:${server.address().port}/v1`},messages=[{role:'system',content:'ORIGINAL SYSTEM PROMPT'},{role:'user',content:'Герой ждёт.'}];let text='';
 for await(const chunk of streamCompletion(connection,'',messages,{grammar:gmJsonGrammar,disableThinking:true}))text+=chunk;
 assert.equal(text,json);assert.equal(received[0].grammar,gmJsonGrammar);assert.equal(received[0].response_format,undefined);assert.deepEqual(received[0].messages,messages);assert.equal(received[0].chat_template_kwargs.enable_thinking,false);
 for(const [c,options]of [[{...connection,id:'external'},{grammar:gmJsonGrammar}],[connection,{grammar:gmJsonGrammar,responseFormat:{type:'json_object'}}]])await assert.rejects(async()=>{for await(const _chunk of streamCompletion(c,'',messages,options)){};},/Грамматика/);
 assert.equal(received.length,1);
});
