import test from 'node:test';
import assert from 'node:assert/strict';
import {finishFanficScene,parseFanficSceneEnding,validateFanficSceneEnding,fanficSceneEndingSchema,fanficSceneEndingInstructions,parseFanficCompletedFragment} from '../server/fanfic-scene-ending.mjs';
import {createTextContinuationJoiner} from '../server/text-continuation.mjs';

const connection={id:'fixture',contextWindow:4096,baseUrl:'http://127.0.0.1:1/v1'};
const options=(extra={})=>({state:{connections:[connection],chats:[{content:'PRIVATE_RP'}],rooms:[{content:'PRIVATE_DND'}],fanficProjects:[{content:'PRIVATE_OTHER_FANFIC'}]},connection,getSecret:id=>{assert.equal(id,'fixture');return 'PRIVATE_KEY';},scene:{summary:'Ирис завершает осмотр караула.',other:'PRIVATE_SCENE'},tail:'Ирис осмотрела стра',instructions:'Закончить спокойно.',maxTokens:520,temperature:.8,countTokens:async()=>100,structured:async args=>args.parse('{"ending":"жу и закрыла дверь."}'),...extra});

test('short ending preserves exact mid-word suffix and never inserts an extra space',async()=>{
 const tail='Ирис осмотрела стра',result=await finishFanficScene(options({tail}));
 assert.equal(result,'жу и закрыла дверь.');
 const joiner=createTextContinuationJoiner(tail);assert.equal(tail+joiner.push(result)+joiner.flush(),'Ирис осмотрела стражу и закрыла дверь.');
});

test('short ending preserves author boundary whitespace for an open sentence and a complete final line',async()=>{
 for(const [tail,ending] of [['Ирис осмотрела стражу и',' закрыла дверь.'],['Ирис закрыла дверь.','\n\nВ коридоре стало тихо.']]){
  const received=await finishFanficScene(options({tail,structured:async args=>args.parse(JSON.stringify({ending}))}));assert.equal(received,ending);
 }
 assert.equal(validateFanficSceneEnding('«Тихо!»',{tail:'Она прошептала: '}),'«Тихо!»');
});

test('ending JSON contract is strict, local grammar stays small without maxLength',()=>{
 assert.deepEqual(fanficSceneEndingSchema.properties.ending,{type:'string'});assert.doesNotMatch(JSON.stringify(fanficSceneEndingSchema),/maxLength/);
 for(const raw of ['',null,false,[],{},'{"ending":}',{ending:44},{ending:' Конец.',commentary:'OK'},'Вот JSON: {"ending":" Конец."}','```json\n{"ending":" Конец."}\n```'])assert.throws(()=>parseFanficSceneEnding(raw,{tail:'Она ждала'}),error=>error.code==='FANFIC_ENDING_FORMAT');
});

test('incomplete, oversized, service and repeated outputs are rejected without hiding failure',()=>{
 const tail='Ирис осмотрела стражу, закрыла окно и подошла к двери';
 for(const ending of ['','  ',' и увидела',' и увидела,','x'.repeat(900)+'.',tail+'.','Комментарий автора: всё закончено.','Сцена завершена.','Вот продолжение: она ушла.','Here is the ending: done.','<think>finish</think> Конец.','{"ending":"Конец."}.','```Конец.```'])assert.throws(()=>validateFanficSceneEnding(ending,{tail}),error=>error.code==='FANFIC_ENDING_FORMAT',ending.slice(0,70));
 const longTail='Ранняя история. '.repeat(40)+'Ирис внимательно осмотрела стражу и закрыла окно перед тем, как подошла к двери';
 assert.throws(()=>validateFanficSceneEnding(longTail.slice(-64)+'.',{tail:longTail}),/повторила/);
});

test('complete prose permits only one short concluding line of at most 25 words',()=>{
 const tail='Дверь закрылась.';
 assert.equal(validateFanficSceneEnding('\nИрис молча выдохнула.',{tail}),'\nИрис молча выдохнула.');
 assert.throws(()=>validateFanficSceneEnding('Слово '.repeat(26)+'.',{tail}),/25 слов/);
 assert.throws(()=>validateFanficSceneEnding('\nКонец.\nНовая сцена.',{tail}),/одна заключительная строка/);
});

test('ending request is isolated, capped and deterministic; no state/draft mutation',async()=>{
 const args=options({tail:'PRIVATE_LEAD'.repeat(400)+'Ирис осмотрела стра',scene:{summary:'с'.repeat(350),secret:'PRIVATE_SCENE'},instructions:'б'.repeat(600)}),before=structuredClone(args.state),counts=[];let request;
 args.countTokens=async(conn,key,messages,opts)=>{assert.equal(conn,args.connection);assert.equal(key,'PRIVATE_KEY');assert.equal(opts.adaptInstruction,true);assert.equal(opts.disableThinking,true);counts.push(messages);return 100;};
 args.structured=async opts=>{request=opts;return opts.parse('{"ending":"жу и закрыла дверь."}');};
 assert.equal(await finishFanficScene(args),'жу и закрыла дверь.');
 assert.equal(request.name,'fanfic_scene_ending');assert.equal(request.maxTokens,256);assert.equal(request.temperature,.15);assert.equal(request.adaptInstruction,true);assert.equal(request.instructions,fanficSceneEndingInstructions);
 assert.deepEqual(Object.keys(request.context),['tail','sceneSummary','authorBrief']);assert.equal(request.context.tail.length,1800);assert.equal(request.context.sceneSummary.length,300);assert.equal(request.context.authorBrief.length,500);assert.ok(request.context.tail.endsWith('Ирис осмотрела стра'));
 assert.doesNotMatch(JSON.stringify(request.context),/PRIVATE_(?:RP|DND|OTHER_FANFIC|KEY|SCENE)/);assert.deepEqual(args.state,before);assert.equal(counts.length,1);
});

test('actual tokenizer overrules a small estimate, dropping brief before shrinking prose tail',async()=>{
 const snapshots=[],args=options({connection:{...connection,contextWindow:1536},tail:'с'.repeat(1800),instructions:'б'.repeat(500)});let completion;
 args.countTokens=async(conn,key,messages)=>{const data=JSON.parse(messages[1].content);snapshots.push(data);return data.authorBrief||data.tail.length>500?2000:900;};
 args.structured=async opts=>{completion=opts;return opts.parse('{"ending":" и стихло."}');};
 await finishFanficScene(args);
 assert.equal(snapshots[0].authorBrief.length,500);assert.equal(snapshots[0].tail.length,1800);assert.equal(snapshots[1].authorBrief,'');assert.equal(snapshots[1].tail.length,1800);assert.ok(snapshots[2].tail.length<1800);assert.ok(completion.context.tail.length<=500);assert.equal(completion.context.authorBrief,'');assert.ok(snapshots.length<=16);
});

test('context and caller maxTokens bound the output; invalid small context prevents completion',async()=>{
 let request;await finishFanficScene(options({connection:{...connection,contextWindow:900},maxTokens:123,temperature:.03,structured:async args=>{request=args;return args.parse('{"ending":"жу."}');}}));
 assert.equal(request.maxTokens,123);assert.equal(request.temperature,.03);
 let called=0;for(const contextWindow of [1,100,400,NaN,Infinity,-10])await assert.rejects(finishFanficScene(options({connection:{...connection,contextWindow},structured:async()=>{called++;return ' Нельзя.';}})),error=>error.code==='FANFIC_ENDING_CONTEXT');
 await assert.rejects(finishFanficScene(options({maxTokens:0,structured:async()=>{called++;return ' Нельзя.';}})),error=>error.code==='FANFIC_ENDING_CONTEXT');assert.equal(called,0);
});

test('global output cap and temperature zero are retained, missing external tokenizer uses bounded estimation',async()=>{
 let request;await finishFanficScene(options({connection:{...connection,contextWindow:900},maxTokens:700,temperature:0,structured:async args=>{request=args;return args.parse('{"ending":"жу."}');}}));assert.equal(request.maxTokens,256);assert.equal(request.temperature,0);
 assert.equal(await finishFanficScene(options({countTokens:async()=>null})), 'жу и закрыла дверь.');
});

test('injected adapters cannot bypass ending parser validation with objects, raw JSON or parsed suffixes',async()=>{
 for(const result of [{ending:' Конец.'},'{"ending":" Конец."}',' Конец.'])assert.equal(await finishFanficScene(options({structured:async()=>result})),' Конец.');
 for(const result of [{ending:' Обрыв'},'{"ending":" Обрыв"}',' Обрыв',null,[],{replacement:' Подмена.'},{ending:' Конец.',extra:true}])await assert.rejects(finishFanficScene(options({structured:async()=>result})),error=>error.code==='FANFIC_ENDING_FORMAT');
});

test('ending errors propagate and preserve inputs for the existing resume flow',async()=>{
 const args=options({structured:async()=>{throw new Error('Endpoint unavailable');}}),before=structuredClone({state:args.state,scene:args.scene,tail:args.tail,instructions:args.instructions});
 await assert.rejects(finishFanficScene(args),/Endpoint unavailable/);assert.deepEqual({state:args.state,scene:args.scene,tail:args.tail,instructions:args.instructions},before);
 await assert.rejects(finishFanficScene(options({tail:'  '})),error=>error.code==='FANFIC_ENDING_FORMAT');
});

test('pre-aborted request makes no tokenizer/completion calls',async()=>{
 const controller=new AbortController();controller.abort(new Error('Автор остановил'));let calls=0;
 await assert.rejects(finishFanficScene(options({signal:controller.signal,countTokens:async()=>{calls++;return 1;},structured:async()=>{calls++;return ' Конец.';}})),/Автор остановил/);assert.equal(calls,0);
});

test('abort is immediate even when a tokenizer or structured adapter ignores the signal',async()=>{
 for(const stage of ['count','structured']){
  const controller=new AbortController(),args=options({signal:controller.signal}),timer=setTimeout(()=>controller.abort(new Error('Автор остановил')),15);
  if(stage==='count')args.countTokens=()=>new Promise(()=>{});else args.structured=()=>new Promise(()=>{});
  try{await assert.rejects(finishFanficScene(args),/Автор остановил/);}finally{clearTimeout(timer);}
 }
});


test('a complete English summary cannot masquerade as a suffix to unfinished Russian prose',()=>{
 const tail='Ирис посмотрела на Эльдора и тихо сказала: «Я знаю, что она';
 assert.throws(()=>validateFanficSceneEnding('Iris returned to Eldor and their journey continued.',{tail}),/на русском/);
 assert.throws(()=>validateFanficSceneEnding(' вернётся. Их связь укреплялась каждый день.',{tail}),/одно предложение/);
 assert.equal(validateFanficSceneEnding(' вернётся завтра».',{tail}),' вернётся завтра».');
 assert.throws(()=>validateFanficSceneEnding(' Она вернулась к воротам.',{tail:'Iris held the copper key and looked at the closed door. She knew she'}),/на английском/);
});


test('an unfinished quoted dialogue must close the same quote instead of silently leaving it open',()=>{
 for(const [tail,ending] of [['"Я знаю, что она',' вернётся завтра."'],['«Я знаю, что она',' вернётся завтра».']]){
  assert.equal(validateFanficSceneEnding(ending,{tail}),ending);
  assert.throws(()=>validateFanficSceneEnding(' вернётся завтра.',{tail}),/закрыть кавычку/);
 }
});


test('copy-and-complete fallback accepts only a literal original prefix and returns its validated suffix',()=>{
 const fragment='"Ирис, моя дорогая. Я знал, что вер',tail='Ранее они беседовали.\n\n'+fragment;
 assert.equal(parseFanficCompletedFragment({completedText:fragment+'нёшься."'},{fragment,tail}),'нёшься."');
 for(const value of [{completedText:'"Ирис, дорогая. Я знал, что вернёшься."'},{completedText:fragment},{completedText:fragment+'нёшься.'},{completedText:fragment+'нулась."',other:true}])assert.throws(()=>parseFanficCompletedFragment(value,{fragment,tail}),error=>error.code==='FANFIC_ENDING_FORMAT');
});

test('a rejected suffix gets one isolated copy-completion fallback without scene or author instructions',async()=>{
 const fragment='"Ирис, моя дорогая. Я знал, что вер',tail='ЧУЖОЙ_РАННИЙ_КОНТЕКСТ '+ 'Давние события. '.repeat(200)+'\n\n'+fragment,calls=[];
 const ending=await finishFanficScene(options({tail,structured:async args=>{calls.push(args);return args.name==='fanfic_scene_ending'?args.parse({ending:'нутся.'}):args.parse({completedText:args.context.text+'нёшься."'});}}));
 assert.equal(ending,'нёшься."');assert.equal(calls.length,2);assert.equal(calls[1].name,'fanfic_scene_completion');assert.equal(calls[1].context.text,fragment);assert.equal(calls[1].context.closingQuote,'"');assert.ok(calls[1].context.before.length<=300);assert.doesNotMatch(JSON.stringify(calls[1].context),/ЧУЖОЙ_РАННИЙ_КОНТЕКСТ|Закончить спокойно|Ирис завершает/);assert.equal(calls[1].maxTokens,256);
});

test('invalid copy completion never edits the source and has no unbounded recovery loop',async()=>{
 let calls=0;const tail='"Я знал, что вер';
 await assert.rejects(finishFanficScene(options({tail,structured:async args=>{calls++;return args.name==='fanfic_scene_ending'?args.parse({ending:'нуться.'}):args.parse({completedText:'"Мы начали новую историю."'});}})),/изменила исходный фрагмент/);assert.equal(calls,2);
});
