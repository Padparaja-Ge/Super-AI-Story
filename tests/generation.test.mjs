import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeneration,chatResumeInstruction} from '../server/generation.mjs';
import {createTasks} from '../server/tasks.mjs';
function fixture(replies){
 let state={activeConnectionId:'test',activePresetId:'rp',connections:[{id:'test',baseUrl:'http://127.0.0.1',model:'mock',contextWindow:4096}],presets:[{id:'rp',maxTokens:32}],settings:{translation:{enabled:false}},chats:[{id:'one',messages:[],scene:{autoUpdate:false},memory:[],memorySettings:{}},{id:'foreign',messages:[{id:'secret',content:'FOREIGN'}],memory:[{content:'FOREIGN'}]}]};const calls=[],foreign=structuredClone(state.chats[1]);let summaries=0;
 const tasks=createTasks(),saveState=s=>{state=s;};
 const generator=createGeneration({getState:()=>structuredClone(state),saveState,getSecret:()=>'',tasks,preparePrompt:async(_s,_id,content,options)=>({messages:[{role:'system',content:'RP only'},{role:'user',content:content||'Continue'}],budget:{maxTokens:state.presets[0].maxTokens},warnings:[],options}),memory:{summarize:async()=>{summaries++;}},memoryDue:()=>true,fit:async(_c,_k,m,options)=>{calls.push({fit:options});return {messages:[...m,{role:'assistant',content:options.text},{role:'user',content:options.instruction}],maxTokens:options.maxTokens};},stream:async function*(_c,_k,m,options){calls.push({messages:m,options});const reply=replies.shift();if(!reply)throw Error('Unexpected extra call');for(const chunk of reply.chunks||[reply.text||''])yield chunk;if(reply.error)throw Error(reply.error);options.onFinish?.(reply.reason||'stop');}});
 return {generator,tasks,calls,get state(){return state;},get summaries(){return summaries;},foreign,save:s=>{state=s;}};
}
test('RP token limits auto-continue one message, then expose a resumable draft without summarizing partial prose',async()=>{
 const f=fixture([{text:'Селина кивает',reason:'length'},{text:'Мире и ',reason:'length'},{text:'говорит',reason:'length'},{text:' о долге.',reason:'stop'}]);
 const first=await f.generator.start({chatId:'one',content:'Напомни долг.'}).promise;
 assert.equal(first.incomplete,true);assert.equal(f.state.chats[0].messages.length,2);let message=f.state.chats[0].messages.at(-1);assert.equal(message.content,'Селина кивает Мире и говорит');assert.equal(message.interruptionReason,'length');assert.equal(f.summaries,0);
 const old=structuredClone(message),s=f.state;s.presets[0].maxTokens=600;f.save(s);
 const resumed=await f.generator.start({chatId:'one',resumeMessageId:old.id}).promise;message=f.state.chats[0].messages.at(-1);
 assert.equal(resumed.incomplete,false);assert.equal(message.id,old.id);assert.equal(message.content,old.content+' о долге.');assert.equal(message.interrupted,false);assert.equal(f.state.chats[0].messages.length,2);assert.equal(f.summaries,1);assert.deepEqual(f.state.chats[1],f.foreign);
 assert.equal(f.calls.at(-1).options.preset.maxTokens,600);assert.equal(f.calls.at(-1).options.adaptInstruction,true);assert.equal(f.calls.at(-1).messages.at(-1).content,chatResumeInstruction);
});
test('RP automatically finishes a limited reply and updates memory only after completion',async()=>{
 const f=fixture([{text:'Она открывает две',reason:'length'},{chunks:['р','ь.'],reason:'stop'}]);const result=await f.generator.start({chatId:'one',content:'Постучи.'}).promise;
 assert.equal(result.incomplete,false);assert.equal(f.state.chats[0].messages.at(-1).content,'Она открывает дверь.');assert.equal(f.summaries,1);assert.equal(f.state.chats[0].messages.length,2);
});
test('Network failure during RP resume preserves the complete saved prefix and new streamed text',async()=>{
 const f=fixture([{text:'Селина: ',error:'broken stream'},{chunks:['Помню ', 'долг'],error:'broken stream again'}]);
 await assert.rejects(f.generator.start({chatId:'one',content:'Долг?'}).promise,/broken stream/);const message=f.state.chats[0].messages.at(-1);assert.equal(message.interrupted,true);
 await assert.rejects(f.generator.start({chatId:'one',resumeMessageId:message.id}).promise,/broken stream again/);assert.equal(f.state.chats[0].messages.at(-1).content,'Селина: Помню долг');assert.equal(f.state.chats[0].messages.at(-1).id,message.id);assert.equal(f.summaries,0);
});
test('RP resume rejects a foreign, old or complete message and incompatible generation actions',async()=>{
 const f=fixture([{text:'Готово.'}]);await f.generator.start({chatId:'one',content:'Пост.'}).promise;const s=f.state;s.chats[0].messages.unshift({id:'old',role:'assistant',content:'draft',interrupted:true});f.save(s);
 for(const value of [{resumeMessageId:'secret'},{resumeMessageId:'old'},{resumeMessageId:s.chats[0].messages.at(-1).id}])assert.throws(()=>f.generator.start({chatId:'one',...value}),/последний незавершённый/);
 const latest=f.state;latest.chats[0].messages.at(-1).interrupted=true;f.save(latest);assert.throws(()=>f.generator.start({chatId:'one',resumeMessageId:latest.chats[0].messages.at(-1).id,continue:true}),/отдельным запросом/);
});

test('Regeneration and resume preserve independent interruption states of alternate replies',async()=>{
 const f=fixture([{text:'Первый ответ.'},{text:'Второй ',reason:'length'},{text:'ответ ',reason:'length'},{text:'оборван',reason:'length'},{text:' и завершён.',reason:'stop'}]);await f.generator.start({chatId:'one',content:'Пост'}).promise;
 await f.generator.start({chatId:'one',regenerate:true}).promise;let message=f.state.chats[0].messages.at(-1);assert.equal(message.swipes.length,2);assert.deepEqual(message.swipeStates.map(s=>s.interrupted),[false,true]);const id=message.id;
 await f.generator.start({chatId:'one',resumeMessageId:id}).promise;message=f.state.chats[0].messages.at(-1);assert.equal(message.swipes[0],'Первый ответ.');assert.equal(message.swipes[1],'Второй ответ оборван и завершён.');assert.deepEqual(message.swipeStates.map(s=>s.interrupted),[false,false]);assert.equal(message.id,id);
});

test('Alpaca loop is stopped, preserved as a draft, excluded from summaries and cannot be blindly resumed',async()=>{
 const sentence='Мира смотрит на длинную деревянную стойку и ждёт нового ответа Селины. ';
 const f=fixture([{chunks:Array(6).fill(sentence)}]),s=f.state;s.connections[0].id='sas-local';s.connections[0].promptFormat='alpaca';s.activeConnectionId='sas-local';f.save(s);
 await assert.rejects(f.generator.start({chatId:'one',content:'Напомни долг.'}).promise,/повторять/);
 const m=f.state.chats[0].messages.at(-1);assert.equal(m.interruptionReason,'repetition');assert.equal(m.interrupted,true);assert.ok(m.content.length<sentence.length*6);assert.equal(f.summaries,0);assert.deepEqual(f.state.chats[1],f.foreign);assert.throws(()=>f.generator.start({chatId:'one',resumeMessageId:m.id}),/Перегенерируйте/);
});

test('A non-Alpaca local repetition is interrupted and never summarized as a valid story event',async()=>{
 const sentence='Тонерико смотрит на посетителя и нервно теребит свой блокнот. ';
 const f=fixture([{chunks:Array(6).fill(sentence)}]),s=f.state;s.connections[0].id='sas-local';s.connections[0].promptFormat='single-system';s.activeConnectionId='sas-local';f.save(s);
 await assert.rejects(f.generator.start({chatId:'one',content:'Привет.'}).promise,/повторять/);
 assert.equal(f.state.chats[0].messages.at(-1).interruptionReason,'repetition');assert.equal(f.summaries,0);assert.deepEqual(f.state.chats[1],f.foreign);
});
test('RP coordinator applies handoff stops only to the enabled local Alpaca adapter',async()=>{
 for(const [id,format,enabled,expected]of [['sas-local','alpaca',true,true],['sas-local','single-system',true,false],['sas-local','alpaca',false,false],['test','alpaca',true,false]]){
  const f=fixture([{text:'Селина назвала пароль и ждёт.'}]),s=f.state;s.connections[0].id=id;s.connections[0].promptFormat=format;s.activeConnectionId=id;s.settings.localRpAdaptive=enabled;f.save(s);
  await f.generator.start({chatId:'one',content:'Напомни пароль.'}).promise;const options=f.calls.find(c=>c.options)?.options;
  assert.equal(Array.isArray(options.stop),expected);if(expected)assert.ok(options.stop.includes('\n\n---\n\nВот ваш следующий ход:'));assert.equal(f.state.chats[0].messages.at(-1).content,'Селина назвала пароль и ждёт.');assert.deepEqual(f.state.chats[1],f.foreign);
 }
});
test('Recognized RP handoff tails stop streaming and never enter saved history or summaries',async()=>{
 for(const tail of ['\n\n---\n\nВот ваш следующий ход: управляйте игроком.','\n\n### End of Turn: Toneriko\n\nИгроку: управляйте игроком.']){
  const f=fixture([{chunks:[...'Селина назвала пароль.'].concat([...tail]),reason:'length'}]),s=f.state;s.connections[0].id='sas-local';s.connections[0].promptFormat='alpaca';s.activeConnectionId='sas-local';f.save(s);
  const result=await f.generator.start({chatId:'one',content:'Напомни пароль.'}).promise;assert.equal(result.incomplete,false);assert.equal(f.state.chats[0].messages.at(-1).content,'Селина назвала пароль.');assert.equal(f.summaries,1);assert.equal(f.calls.length,1);assert.deepEqual(f.state.chats[1],f.foreign);assert.doesNotMatch(JSON.stringify(f.state.chats[0]),/управляйте|End of Turn|следующий ход/);
 }
});
