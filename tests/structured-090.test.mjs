import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {structuredCompletion} from '../server/services/structuredCompletion.js';
test('Local Alpaca JSON tasks adapt the instruction and retry a truncated object as a shorter complete object',async t=>{
 const calls=[],server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:calls.length===1?'{"world":"Оборванный текст':'{"world":"Прибрежное королевство"}'},finish_reason:calls.length===1?'length':'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const state={activeConnectionId:'sas-local',settings:{localSampling:{}},connections:[{id:'sas-local',model:'local-qa',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,promptFormat:'alpaca',contextWindow:8192}]};
 const output=await structuredCompletion({state,getSecret:()=>'',schema:{type:'object',properties:{world:{type:'string',maxLength:1400}},required:['world']},name:'storybook',maxTokens:800,adaptInstruction:true,instructions:'SAS_STORYBOOK_TASK: Return world as concise JSON.',context:{request:'Создай мир для приключения'}});
 assert.equal(output.world,'Прибрежное королевство');assert.equal(calls.length,2);assert.equal(calls[0].messages[0].role,'user');assert.match(calls[0].messages[0].content,/SAS_STORYBOOK_TASK/);assert.match(calls[1].messages[0].content,/much shorter COMPLETE JSON/);assert.equal(calls[1].response_format.schema.properties.world.maxLength,undefined);assert.equal(calls[0].max_tokens,800);
});
