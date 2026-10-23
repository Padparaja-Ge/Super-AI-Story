import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewGameNarration} from '../server/gm-review.mjs';
import {createAdventureGame,adventureActor,adventureAction} from '../server/adventure-engine.mjs';
import {upsertChallenge} from '../server/ability-checks.mjs';
import {defaultAbilities} from '../shared/srp.mjs';

function fixture({roll=2,mode='dnd',bound=true,kind='check'}={}){
 const persona={id:'hero',name:'Бог',kind:'srp',className:'Воин',abilities:defaultAbilities()},game=createAdventureGame(mode==='custom'?'custom':'dnd');
 game.actors=[adventureActor('host',persona,game.rules)];game.order=['host'];
 const challenge=upsertChallenge(game,{name:'Выторговать скидку',ability:'charisma',checkType:'persuasion',dc:15,actorId:'host',intent:'Прошу снизить цену меча до восьми монет.',messageId:'current',actionId:'price-only'});
 const result=adventureAction(game,{action:'check',challengeId:challenge.id},'host',{random:()=>roll});result.calculation.kind=kind;if(!bound)result.calculation.unbound=true;
 const room={id:'review-room',mode,tactical:game,connectionId:'room-model',scene:{location:'Лавка Арвина',time:'День'},personas:{host:persona},messages:[
  {id:'archive',role:'assistant',content:'ARCHIVE_ONLY_FULL_CAN'},
  {id:'old-player',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Подхожу к прилавку.'},
  {id:'recent-one',role:'assistant',content:'Арвин спрашивает, какой меч нужен.'},
  {id:'recent-two',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Показываю на меч, ничего не беру.'},
  {id:'recent-three',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Банка совершенно пуста.'},
  {id:'recent-four',role:'assistant',content:'AccountNickname видит Арвина. Цена десять; при удачном торге он согласен на восемь. Банка пуста.'},
  {id:'current',role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Прошу снизить цену меча до восьми монет.'},
  {id:'candidate',role:'assistant',content:'TEMPORARY_CANDIDATE',interrupted:true}
 ]};
 const state={activeConnectionId:'solo-model',connections:[{id:'solo-model',baseUrl:'http://127.0.0.1:1/v1',model:'private-solo'},{id:'room-model',baseUrl:'http://127.0.0.1:2/v1',model:'room-model',maxTokens:400,contextWindow:8192}],settings:{},chats:[],characters:[],lorebooks:[]};
 return {state,room,chat:{connectionId:'room-model'},getSecret:()=>''};
}
function mockCompletion(answers,calls=[]){return async options=>{calls.push(options);const answer=answers[calls.length-1];if(answer instanceof Error)throw answer;return options.parse(typeof answer==='string'?answer:JSON.stringify(answer));};}
const snapshot=input=>structuredClone({state:input.state,room:input.room,chat:input.chat});
const valid={valid:true,violations:[]};
const violation=(evidence,kind='outcome',note='Провал проверки не даёт скидку.')=>({valid:false,violations:[{kind,evidence,note}]});

test('Correct low-roll refusal needs one short audit, scoped room model and no archive or account nickname',async()=>{
 const input=fixture(),before=snapshot(input),calls=[],text='Арвин качает головой: «Цена остаётся десять монет». Банка пуста.';
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([valid],calls)});
 assert.deepEqual(result,{text,reviewed:true,repaired:false});assert.equal(calls.length,1);assert.equal(calls[0].maxTokens,350);assert.equal(calls[0].adaptInstruction,true);assert.equal(calls[0].chat.connectionId,'room-model');
 const context=calls[0].context;assert.equal(context.recent.length,4);assert.equal(context.current[0].id,'current');assert.equal(context.outcomes[0].outcome,'failure');assert.equal(context.outcomes[0].dc,15);
 assert.match(JSON.stringify(context),/Банка пуста|Банка совершенно пуста/);assert.doesNotMatch(JSON.stringify(context),/ARCHIVE_ONLY_FULL_CAN|AccountNickname|TEMPORARY_CANDIDATE|private-solo/);assert.deepEqual(snapshot(input),before);
});

test('A low-roll success contradiction is repaired once and must pass an independent second audit',async()=>{
 const input=fixture(),before=snapshot(input),calls=[],text='Арвин согласился продать меч за восемь монет.',fixed='Арвин отказывается снижать цену: «Десять монет».',answer=violation('согласился продать меч за восемь монет');
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([answer,{text:fixed},valid],calls)});
 assert.equal(result.text,fixed);assert.equal(result.repaired,true);assert.equal(calls.length,3);assert.deepEqual(calls.map(call=>call.name),['gm_narration_audit','gm_narration_repair','gm_narration_audit']);
 assert.equal(calls[1].maxTokens,400);assert.equal(calls[2].context.candidate,fixed);assert.equal(calls[1].context.violations[0].evidence,answer.violations[0].evidence);assert.deepEqual(snapshot(input),before);
});

test('Natural20 price agreement does not authorize the merchant to gift money or the weapon',async()=>{
 const input=fixture({roll:20}),calls=[],text='«За восемь монет», — говорит Арвин. Он протягивает мешочек монет. «Меч твой».',fixed='Арвин соглашается: «За восемь монет». Меч остаётся на прилавке, торговец ждёт решения.';
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([violation('Он протягивает мешочек монет.','resource','Торг согласовал цену, а не подарок или оплату.'),{text:fixed},valid],calls)});
 assert.equal(result.text,fixed);assert.equal(calls[0].context.outcomes[0].critical,'success');assert.equal(calls.length,3);assert.match(calls[0].instructions,/согласование цены НЕ означает покупку/);
});

test('Still-conflicting repair raises a stable conflict error after three calls, without advancing anything',async()=>{
 const input=fixture(),before=snapshot(input),calls=[],text='Арвин даёт скидку.',audit=violation('даёт скидку');
 await assert.rejects(reviewGameNarration({...input,text,completion:mockCompletion([audit,{text},audit],calls)}),error=>error.code==='GM_NARRATION_CONFLICT'&&/Черновик сохранён/.test(error.message));
 assert.equal(calls.length,3);assert.deepEqual(snapshot(input),before);
});

test('Invented or empty evidence never authorizes a rewrite based on an ungrounded accusation',async()=>{
 for(const evidence of ['Герой получил подарок.','']){
  const input=fixture(),calls=[];
  await assert.rejects(reviewGameNarration({...input,text:'Арвин отказывается снижать цену.',completion:mockCompletion([violation(evidence)],calls)}),error=>error.code==='GM_NARRATION_CONFLICT'&&/точной цитатой/.test(error.message));
  assert.equal(calls.length,1);
 }
});

test('Malformed or internally inconsistent audit fails closed instead of silently trusting the text',async()=>{
 for(const answer of ['{broken',{valid:false,violations:[]},{valid:true,violations:[{kind:'fact',evidence:'Арвин',note:'Ошибочное имя.'}]}]){
  const calls=[];await assert.rejects(reviewGameNarration({...fixture(),text:'Арвин согласен.',completion:mockCompletion([answer],calls)}),error=>error.code==='GM_NARRATION_CONFLICT');assert.equal(calls.length,1);
 }
});

test('A malformed repair is not accepted or substituted for the original draft',async()=>{
 const calls=[],input=fixture(),before=snapshot(input),text='Арвин даёт скидку.';
 await assert.rejects(reviewGameNarration({...input,text,completion:mockCompletion([violation('даёт скидку'),'{"text":'],calls)}),error=>error.code==='GM_NARRATION_CONFLICT');assert.equal(calls.length,2);assert.deepEqual(snapshot(input),before);
});

test('No audit for a free die, unbound check, already narrated check, pure attack, RP or fanfic context',async()=>{
 const cases=[fixture({bound:false}),fixture({kind:'attack'}),fixture({mode:'roleplay'}),fixture({mode:'fanfic'}),fixture(),fixture()];cases[4].room.tactical.narratedEventIds=cases[4].room.tactical.log.map(event=>event.id);cases[5].room.tactical.log=[];cases[5].room.tactical.eventArchive=[];
 for(const input of cases){const calls=[],text='Текст без связанной проверки.';assert.deepEqual(await reviewGameNarration({...input,text,completion:mockCompletion([],calls)}),{text,reviewed:false});assert.equal(calls.length,0);}
});

test('A valid impossible result stays impossible on natural20 and a custom NRI uses the same review scope',async()=>{
 const input=fixture({mode:'custom',roll:20}),calls=[],event=input.room.tactical.log.at(-1);Object.assign(event.calculation,{outcome:'impossible',success:false,critical:null,naturalCritical:'success'});
 const text='Гора остаётся неподвижной.';assert.equal((await reviewGameNarration({...input,text,completion:mockCompletion([valid],calls)})).text,text);assert.equal(calls[0].context.outcomes[0].outcome,'impossible');assert.equal(calls.length,1);
});

test('Audit transport errors and cancellation do not masquerade as successful validation',async()=>{
 const input=fixture(),before=snapshot(input),calls=[];
 await assert.rejects(reviewGameNarration({...input,text:'Ответ.',completion:mockCompletion([new Error('API unavailable')],calls)}),error=>error.code==='GM_NARRATION_CONFLICT');assert.equal(calls.length,1);assert.deepEqual(snapshot(input),before);
 const controller=new AbortController();controller.abort();await assert.rejects(reviewGameNarration({...input,text:'Ответ.',signal:controller.signal,completion:mockCompletion([],[])}),error=>error.name==='AbortError');
});

test('Explicit chat model overrides survive the room selection and drive the bounded repair budget',async()=>{
 const input=fixture(),calls=[],text='Арвин даёт скидку.',fixed='Арвин отказывает в скидке.';
 input.state.connections.push({id:'override',baseUrl:'http://127.0.0.1:3/v1',model:'selected-override',contextWindow:8192,maxTokens:900});input.chat={connectionId:'override',customField:'keep-me'};
 const before=snapshot(input),result=await reviewGameNarration({...input,text,completion:mockCompletion([violation('даёт скидку'),{text:fixed},valid],calls)});
 assert.equal(result.text,fixed);assert.ok(calls.every(call=>call.chat.connectionId==='override'&&call.chat.customField==='keep-me'));assert.equal(calls[1].maxTokens,900);assert.deepEqual(snapshot(input),before);
});

test('Long current posts are bounded while unrelated NPCs and oversized inventories stay out of the audit',async()=>{
 const input=fixture(),calls=[];
 for(let index=0;index<9;index++)input.room.messages.splice(-1,0,{id:'long-'+index,role:'user',userId:'host',name:'AccountNickname',personaName:'Бог',content:'Я ничего не покупаю. '+('Подробное описание прилавка и окружающих вещей. '.repeat(300))+'Банка пуста.'});
 for(let index=0;index<40;index++)input.room.tactical.actors.push({...input.room.tactical.actors[0],id:'unrelated-'+index,name:'UNRELATED_NPC_'+index,player:false});
 input.room.tactical.actors[0].inventory=Array.from({length:20},(_,index)=>({name:'Предмет '+index,quantity:index+2}));
 const before=snapshot(input);await reviewGameNarration({...input,text:'Арвин отказывает в скидке.',completion:mockCompletion([valid],calls)});
 const context=calls[0].context;assert.ok(context.current.reduce((sum,message)=>sum+message.content.length,0)<=4200);assert.ok(context.recent.reduce((sum,message)=>sum+message.content.length,0)<=2400);
 assert.equal(context.current.length,10);assert.ok(context.current.some(message=>message.compacted));assert.equal(context.actors.length,1);assert.equal(context.actors[0].inventory.length,12);assert.equal(context.actors[0].inventory[0].quantity,2);assert.equal(context.actors[0].inventoryCompacted,true);assert.doesNotMatch(JSON.stringify(context),/UNRELATED_NPC/);assert.deepEqual(snapshot(input),before);
});

test('An audit that cannot cover an oversized candidate or too many posts fails closed before any model call',async()=>{
 for(const which of ['candidate','posts']){
  const input=fixture(),calls=[];if(which==='posts')for(let index=0;index<45;index++)input.room.messages.splice(-1,0,{id:'overflow-'+index,role:'user',userId:'host',content:'Жду ответа.'});
  const text=which==='candidate'?'Текст. '.repeat(5000):'Ответ мастера.';
  await assert.rejects(reviewGameNarration({...input,text,completion:mockCompletion([valid],calls)}),error=>error.code==='GM_NARRATION_CONFLICT');assert.equal(calls.length,0);
 }
});

test('A narrow price-only transaction guard catches a false-valid audit and verifies the repair independently',async()=>{
 const input=fixture({roll:20}),calls=[],text='Арвин соглашается на скидку. Арвин протягивает мешочек монет Богу. «Меч твой».',fixed='Арвин соглашается: «Восемь монет». Меч остаётся на прилавке.';
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([valid,{text:fixed},valid],calls)});
 assert.equal(result.repaired,true);assert.equal(result.text,fixed);assert.equal(calls.length,3);assert.ok(calls[1].context.violations.some(value=>value.kind==='resource'&&text.includes(value.evidence)));
 const unchanged=[],stillBad=reviewGameNarration({...input,text,completion:mockCompletion([valid,{text},valid],unchanged)});
 await assert.rejects(stillBad,error=>error.code==='GM_NARRATION_CONFLICT');assert.equal(unchanged.length,3);
});

for(const text of [
 'Арвин не передаёт меч Богу: сначала нужна оплата.',
 '«После оплаты меч твой», — говорит Арвин.',
 '«Меч не твой, пока не заплатишь», — говорит Арвин.',
 '«Меч твой за восемь монет», — предлагает Арвин.',
 'Арвин протягивает руку к мечу и ждёт ответа.',
 'Арвин протягивает меч на осмотр, не отдавая его покупателю.',
 'The merchant does not hand you the sword.',
 'The sword is yours after you pay.'
])test('Price guard permits a negation, conditional offer or inspection: '+text,async()=>{
 const calls=[],result=await reviewGameNarration({...fixture({roll:20}),text,completion:mockCompletion([valid],calls)});
 assert.equal(result.repaired,false);assert.equal(calls.length,1);
});

test('The transaction guard does not reinterpret a separately declared purchase as a price-only request',async()=>{
 const input=fixture({roll:20}),calls=[];input.room.messages.splice(-1,0,{id:'payment',role:'user',userId:'host',content:'Покупаю меч и плачу восемь монет.'});
 const text='Арвин передаёт меч Богу. «Меч твой».';
 assert.equal((await reviewGameNarration({...input,text,completion:mockCompletion([valid],calls)})).repaired,false);assert.equal(calls.length,1);
});

for(const text of ['Арвин протягивает мешочек монет Богу.','Арвин передал Богу деньги.','The merchant hands you a bag of coins.'])test('Unrequested money transfers are blocked even without an ownership catchphrase: '+text,async()=>{
 const calls=[],fixed='Арвин соглашается на цену восемь монет и ждёт ответа.';
 assert.equal((await reviewGameNarration({...fixture({roll:20}),text,completion:mockCompletion([valid,{text:fixed},valid],calls)})).repaired,true);assert.equal(calls.length,3);
});

test('Another player buying bread cannot authorize gifts to the player who only negotiated a discount',async()=>{
 const input=fixture({roll:20}),calls=[];input.room.messages.splice(-1,0,{id:'other-buy',role:'user',userId:'other-player',name:'AccountOther',personaName:'Лира',content:'Покупаю хлеб и плачу две монеты.'});
 const text='Меч переходит к Богу.',fixed='Арвин соглашается на восемь монет. Меч остаётся на прилавке.';
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([valid,{text:fixed},valid],calls)});
 assert.equal(result.repaired,true);assert.equal(calls.length,3);assert.equal(calls[0].context.transactionLimits[0].scope,'price_offer_only');
});

test('Explicitly not buying never disables the price-only guard for either the intent or its linked post',async()=>{
 for(const location of ['intent','post']){
  const input=fixture({roll:20}),calls=[],line='Прошу скидку, но не покупаю и не оплачиваю меч.';
  if(location==='post')input.room.messages.find(message=>message.id==='current').content=line;
  else for(const entry of [input.room.tactical.log,input.room.tactical.eventArchive])for(const event of entry||[])if(event.calculation?.kind==='check')event.calculation.intent=line;
  const result=await reviewGameNarration({...input,text:'Меч переходит к Богу.',completion:mockCompletion([valid,{text:'Арвин соглашается на восемь монет и ждёт решения.'},valid],calls)});
  assert.equal(result.repaired,true);assert.equal(calls.length,3);assert.equal(calls[0].context.transactionLimits[0].scope,'price_offer_only');
 }
});

for(const text of ['За восемь монет Арвин передал меч Рагнару.','Арвин передал Лире мешочек монет.','За восемь монет меч переходит к Лире.'])test('Mentioning the offered price does not authorize actual delivery to any named hero: '+text,async()=>{
 const input=fixture({roll:20}),calls=[],fixed='Арвин соглашается на цену восемь монет. Меч остаётся на прилавке.';
 const result=await reviewGameNarration({...input,text,completion:mockCompletion([valid,{text:fixed},valid],calls)});
 assert.equal(result.repaired,true);assert.equal(calls.length,3);
});
