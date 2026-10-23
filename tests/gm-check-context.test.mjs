import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {planPlayerCheck,commitPlayerCheck} from '../server/gm-checks.mjs';
import {recentGameContext,gameCheckContract,checkNarrationInstruction} from '../server/gm-context.mjs';
import {createAdventureGame,adventureActor,adventureAction} from '../server/adventure-engine.mjs';
import {setActorCheckDifficulty} from '../server/ability-checks.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {roomChat} from '../server/room-memory.mjs';
import {narrationContextHash} from '../server/room-narration.mjs';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {createMultiplayerClient} from '../server/multiplayer-client.mjs';
import {sanitizeState} from '../server/store.mjs';

const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const persona={id:'hero-sheet',kind:'srp',name:'Бог',avatar:'B',className:'Воин',abilities:defaultAbilities()};
const decision=(overrides={})=>({requiresCheck:true,checkType:'persuasion',name:'Выторговать скидку',subjectName:'Торговец',subjectKind:'npc',targetId:'merchant',dc:15,impossible:false,impossibleReason:'',reason:'Опытный торговец тщательно считает прибыль.',...overrides});
function table(){const game=createAdventureGame('dnd');game.actors=[adventureActor('host',persona,game.rules),{...adventureActor('merchant',{...persona,id:'npc-sheet',name:'Торговец'},game.rules),player:false}];game.order=['host'];return game;}
function roomFixture(){return {id:'check-room',mode:'dnd',tactical:table(),scene:{location:'Базар',autoUpdate:false},messages:[{id:'gm-old',role:'assistant',content:'Торговец просит десять монет. Банка совершенно пуста.',createdAt:'2026-10-22T10:00:00Z'},{id:'player-post',role:'user',userId:'host',name:'Морвен',personaName:'Бог',content:'Я прошу торговца снизить цену меча.',createdAt:'2026-10-22T10:01:00Z'}],memorySettings:{vectorMemory:false},memory:[],personas:{host:persona}};}
async function plan(room,request={},reply=decision(),calls=[]){return planPlayerCheck({state:{lorebooks:[]},chat:roomChat(room),room,actor:room.tactical.actors[0],request,getSecret:()=>'',completion:async options=>{calls.push(options);return options.parse(JSON.stringify(reply));}});}
const roll=(g,challenge,value)=>adventureAction(g,{action:'check',challengeId:challenge.id},'host',{random:()=>value});
const withD20=async(value,fn)=>{const original=crypto.randomInt;crypto.randomInt=(...args)=>args[0]===1&&args[1]===21?value:original(...args);try{return await fn();}finally{crypto.randomInt=original;}};

test('Preparation sees current scene and intent, never the engine roll or an invented success',async()=>{
 const room=roomFixture(),calls=[];room.tactical.eventArchive=[{id:'secret-roll',round:1,calculation:{roll:20,total:99},text:'SECRET_ROLL_99'}];
 const prepared=await plan(room,{checkType:'persuasion'},decision(),calls),context=calls[0].context;
 assert.match(context.attempt.intent,/снизить цену/);assert.equal(context.attempt.messageId,'player-post');assert.equal(context.attempt.ability,'charisma');assert.match(JSON.stringify(context.recent),/совершенно пуста/);assert.doesNotMatch(JSON.stringify(context),/SECRET_ROLL_99|"roll"|"total"/);
 assert.equal(room.tactical.challenges.length,0,'planning never mutates the engine');
 const challenge=commitPlayerCheck(room.tactical,prepared);assert.equal(challenge.dc,15);assert.equal(roll(room.tactical,challenge,2).calculation.outcome,'failure');
});
test('Stored NPC difficulty is reused and task-specific impossibility never poisons the next attempt',async()=>{
 const room=roomFixture(),game=room.tactical;setActorCheckDifficulty(game.actors[1],'persuasion',{dc:15});
 let prepared=await plan(room,{checkType:'persuasion'},decision({dc:7,impossible:true,impossibleReason:'Просьба отдать весь город не находится во власти торговца.'}));
 const impossible=commitPlayerCheck(game,prepared);assert.equal(impossible.dc,15);assert.equal(roll(game,impossible,20).calculation.outcome,'impossible');assert.equal(game.actors[1].checkDifficulties.persuasion.impossible,false);
 room.messages.push({id:'gm-next',role:'assistant',content:'Торговец отказывается отдавать город.'},{id:'post-next',role:'user',userId:'host',content:'Я прошу всего одну монету скидки.'});
 prepared=await plan(room,{checkType:'persuasion'},decision({dc:3}));const ordinary=commitPlayerCheck(game,prepared);assert.equal(ordinary.dc,15);assert.equal(ordinary.impossible,false);assert.equal(roll(game,ordinary,20).calculation.critical,'success');
});
test('Rephrasing the same post and retrying its automatic target cannot obtain a second roll',async()=>{
 const room=roomFixture(),calls=[],prepared=await plan(room,{autoType:true},decision(),calls),challenge=commitPlayerCheck(room.tactical,prepared);assert.equal(challenge.targetId,'merchant');assert.equal(challenge.requestedTargetId,'');roll(room.tactical,challenge,2);
 const repeated=await plan(room,{autoType:true,intent:'Я очень убедительно прошу скидку.'},decision({dc:1}),calls);assert.equal(repeated.existingId,challenge.id);assert.equal(calls.length,1);assert.throws(()=>roll(room.tactical,commitPlayerCheck(room.tactical,repeated),20),/уже выполнена/);
 const named=await plan(room,{checkType:'persuasion',targetId:'merchant'},decision(),calls);assert.equal(named.existingId,challenge.id,'selecting the same automatically identified NPC cannot obtain a new roll');
 room.tactical.actors.push({...room.tactical.actors[1],id:'another-merchant',name:'Другой торговец'});const other=await plan(room,{checkType:'persuasion',targetId:'another-merchant'},decision({targetId:'another-merchant'}),calls);assert.notEqual(other.existingId,challenge.id,'a different NPC must not inherit the first target outcome');
});
test('Environmental objects are scoped to their location and free greetings do not create tasks',async()=>{
 const room=roomFixture(),request={checkType:'athletics',intent:'Я сдвигаю валун.'},reply=decision({checkType:'athletics',subjectKind:'environment',subjectName:'Валун',targetId:'',name:'Сдвинуть валун',dc:15});
 const first=commitPlayerCheck(room.tactical,await plan(room,request,reply));assert.equal(first.dc,15);
 room.scene.location='Горная тропа';room.messages[1].id='different-post';const second=commitPlayerCheck(room.tactical,await plan(room,request,{...reply,dc:7}));assert.equal(second.dc,7);assert.notEqual(first.subjectId,second.subjectId);
 room.messages[1].id='greeting-post';room.messages[1].content='Я здороваюсь.';const free=await plan(room,{autoType:true},decision({requiresCheck:false}));assert.equal(free.free,true);assert.equal(room.tactical.challenges.length,2);
});
test('Host can edit a persisted off-map NPC or environmental difficulty without giving that authority to a player',async()=>{
 const room=roomFixture(),request={checkType:'strength',intent:'Пробую сдвинуть валун.'},reply=decision({checkType:'strength',subjectName:'Валун',subjectKind:'environment',targetId:'',dc:15});
 const task=commitPlayerCheck(room.tactical,await plan(room,request,reply)),subject=room.tactical.checkSubjects.find(s=>s.id===task.subjectId);
 const patch={action:'setCheckDifficulty',targetId:subject.id,checkType:'strength',difficulty:{ability:'strength',dc:19}};
 assert.throws(()=>adventureAction(room.tactical,patch,'host'),/только хосту/);
 adventureAction(room.tactical,patch,'host',{host:true});assert.equal(subject.checkDifficulties.strength.dc,19);assert.equal(task.dc,15,'An already assigned attempt keeps its announced difficulty');
});
test('A host-assigned task name defines the attempted action even when the optional intention field is empty',()=>{
 const room=roomFixture(),game=room.tactical,task=adventureAction(game,{action:'setChallenge',challenge:{name:'Сдвинуть валун с дороги',ability:'strength',actorId:'host',dc:15}},'host',{host:true});
 const event=roll(game,task,7),contract=gameCheckContract(game,[]);assert.equal(event.calculation.intent,'Сдвинуть валун с дороги');assert.equal(event.calculation.outcome,'failure');assert.equal(contract.outcomes[0].applicable,true);
});
test('Recent four narrative messages remain available without vectors; current posts and service messages are separate',()=>{
 const messages=[{id:'ancient',role:'assistant',content:'Старый эпизод.'},{id:'p1',role:'user',content:'Открываю банку.'},{id:'a1',role:'assistant',content:'Банка пуста.'},{id:'p2',role:'user',content:'Осматриваю прилавок.'},{id:'a2',role:'assistant',content:'Продавец ждёт, цена 15.'},{id:'noise',role:'user',kind:'dice',content:'d20:20'},{id:'current',role:'user',content:'Торгуюсь.'}];
 const recent=recentGameContext({messages,memorySettings:{vectorMemory:false}});assert.deepEqual(recent.map(m=>m.id),['p1','a1','p2','a2']);assert.match(JSON.stringify(recent),/Банка пуста/);assert.doesNotMatch(JSON.stringify(recent),/d20:20|Торгуюсь/);
});
test('Only current linked outcomes constrain narration; old, free and already narrated rolls cannot resolve a new action',async()=>{
 const room=roomFixture(),game=room.tactical,challenge=commitPlayerCheck(game,await plan(room,{checkType:'persuasion'})),event=roll(game,challenge,7),posts=room.messages.filter(m=>m.role==='user');
 let contract=gameCheckContract(game,posts);assert.equal(contract.outcomes[0].applicable,true);assert.equal(contract.outcomes[0].dc,15);assert.equal(contract.outcomes[0].outcome,'failure');assert.match(checkNarrationInstruction(game,posts),/неудачу/);
 assert.equal(gameCheckContract(game,[{id:'unrelated-post'}]).outcomes[0].applicable,false);
 game.narratedEventIds=[event.id];assert.deepEqual(gameCheckContract(game,posts).outcomes,[]);
 const before=narrationContextHash(room,'narrator');game.actors[1].checkDifficulties.persuasion.dc=7;assert.notEqual(narrationContextHash(room,'narrator'),before);
 const changed=narrationContextHash(room,'narrator');game.challenges[0].impossible=true;assert.notEqual(narrationContextHash(room,'narrator'),changed);
});

async function multiplayerFixture(t,{reply=decision(),messages,delay,audit=()=>({valid:true,violations:[]}),repair=()=>({text:'Торговец качает головой: «Нет, скидки не будет». Банка остаётся пустой.'}),narration='Торговец качает головой: «Нет, скидки не будет». Банка остаётся пустой.'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-gm-check-')),calls=[];
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
  if(body.messages.some(m=>m.content.includes('[SAS_PREPARE_CHECK]'))){if(delay)await delay();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(typeof reply==='function'?reply(body):reply)},finish_reason:'stop'}]}));return;}
  if(body.messages.some(m=>m.content.includes('[SAS_REVIEW_GAME_NARRATION]')||m.content.includes('[SAS_REPAIR_GAME_NARRATION]'))){const result=body.messages[0].content.includes('[SAS_REVIEW_GAME_NARRATION]')?await audit(body):await repair(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:typeof result==='string'?result:JSON.stringify(result)},finish_reason:'stop'}]}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:narration},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 let state=sanitizeState(structuredClone(seed));state.personas.push(persona);state.plugins=[];state.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;state.connections[0].model='mock';state.connections[0].contextWindow=16384;state.connections[0].maxTokens=150;state.activeConnectionId=state.connections[0].id;
 state.multiplayer={...roomFixture(),name:'Проверки',connectionId:state.connections[0].id,chatId:seed.chats[0].id,messages:messages||roomFixture().messages,summary:'',memorySettings:{autoSummary:false,vectorMemory:false},personas:{host:persona}};
 const room=createMultiplayer({getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',dataDir:dir,tasks:{busy:()=>true}});await room.start({port:0,personaId:persona.id});
 t.after(async()=>{await room.stop();await new Promise(resolve=>{provider.close(resolve);provider.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {room,calls,get state(){return state;},save:value=>{state=structuredClone(value);}};
}
test('Host chat d20 prepares a context-bound check before rolling, preserves the actual die and sends failure/DC to narration',async t=>{
 const f=await multiplayerFixture(t),result=await withD20(2,()=>f.room.dice(20)),game=f.state.multiplayer.tactical,check=game.log.find(e=>e.calculation?.kind==='check');
 assert.equal(result.message.dice.value,2);assert.equal(result.message.dice.eventId,check.id);assert.equal(check.calculation.dc,15);assert.equal(check.calculation.outcome,'failure');assert.equal(check.calculation.messageId,'player-post');
 const request=JSON.parse(f.calls[0].messages.find(m=>m.role==='user').content);assert.doesNotMatch(JSON.stringify(request),/"roll"|"total"/);assert.equal(request.attempt.ability,undefined,'auto selection is resolved by the preparer');
 await assert.rejects(()=>f.room.dice(20),/уже выполнена/);assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,1);
 await f.room.act({action:'end'});const generated=await f.room.generate(),prompt=JSON.stringify(f.calls.findLast(c=>c.stream&&!c.response_format).messages);assert.match(prompt,/SAS_CHECK_OUTCOMES/);assert.match(prompt,/"dc":15|\\"dc\\":15/);assert.match(prompt,/failure/);assert.match(prompt,/Банка совершенно пуста/);assert.ok(f.state.multiplayer.tactical.narratedEventIds.includes(check.id));assert.ok(generated.message.content);
 await f.room.generate({regenerateMessageId:generated.message.id});assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,1);assert.equal(f.calls.filter(c=>c.messages.some(m=>m.content.includes('[SAS_PREPARE_CHECK]'))).length,1);assert.match(JSON.stringify(f.calls.findLast(c=>c.stream&&!c.response_format).messages),/failure/);
 const audits=f.calls.filter(c=>c.messages.some(m=>m.content.includes('[SAS_REVIEW_GAME_NARRATION]')));assert.equal(audits.length,2,'Regeneration validates the same original result without a new roll');for(const request of audits)assert.equal(JSON.parse(request.messages[1].content).outcomes[0].outcome,'failure');
});
test('A conflicting GM answer stays incomplete; retry repairs the same draft without another stream or roll',async t=>{
 let allow=false;const wrong='Торговец даёт скидку.',f=await multiplayerFixture(t,{narration:wrong,audit:body=>{
  const candidate=JSON.parse(body.messages[1].content).candidate;
  return allow&&!candidate.includes('даёт скидку')?{valid:true,violations:[]}:{valid:false,violations:[{kind:'outcome',evidence:allow?'даёт скидку':candidate,note:'Провал проверки не даёт запрошенную скидку.'}]};
 },repair:()=>({text:allow?'Торговец отказывается снижать цену. Банка остаётся пустой.':wrong})});
 await withD20(2,()=>f.room.dice(20));await f.room.act({action:'end'});const round=f.state.multiplayer.tactical.round,rollCount=f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length;
 await assert.rejects(()=>f.room.generate(),error=>error.code==='GM_NARRATION_CONFLICT');
 const partial=f.state.multiplayer.messages.at(-1),pending=f.room.status().room.narration;assert.equal(partial.content,wrong);assert.equal(partial.interrupted,true);assert.equal(pending.reason,'validation');assert.equal(pending.canContinue,true);assert.equal(f.state.multiplayer.tactical.round,round);assert.equal(f.state.multiplayer.tactical.phase,'gm');assert.throws(()=>f.room.hostMessage('Новый ход'),/завершите/);
 const streams=f.calls.filter(c=>c.stream&&!c.response_format).length;allow=true;const result=await f.room.generate({continueMessageId:partial.id});assert.match(result.message.content,/отказывается/);assert.equal(result.message.id,partial.id);assert.equal(result.incomplete,false);assert.equal(f.calls.filter(c=>c.stream&&!c.response_format).length,streams);assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,rollCount);assert.equal(f.state.multiplayer.tactical.round,round+1);assert.equal(f.state.multiplayer.contextReport.narrationReview.repaired,true);
});
test('An unverified regeneration keeps the previously accepted answer and its mechanical state',async t=>{
 let reject=false;const f=await multiplayerFixture(t,{audit:body=>reject?{valid:false,violations:[{kind:'fact',evidence:JSON.parse(body.messages[1].content).candidate,note:'Неподтверждённый вариант.'}]}:{valid:true,violations:[]}});
 await withD20(2,()=>f.room.dice(20));await f.room.act({action:'end'});const first=await f.room.generate(),game=structuredClone(f.state.multiplayer.tactical);reject=true;
 await assert.rejects(()=>f.room.generate({regenerateMessageId:first.message.id}),/Предыдущий ответ сохранён/);assert.equal(f.state.multiplayer.messages.at(-1).content,first.message.content);assert.deepEqual(f.state.multiplayer.tactical,game);
});
test('Cancellation during review preserves the review stage and retries without continuing the completed prose',async t=>{
 let started,release,count=0;const ready=new Promise(r=>started=r),waiting=new Promise(r=>release=r),f=await multiplayerFixture(t,{audit:async()=>{if(++count===1){started();await waiting;}return {valid:true,violations:[]};}});
 await withD20(2,()=>f.room.dice(20));await f.room.act({action:'end'});const controller=new AbortController(),pending=assert.rejects(f.room.generate({signal:controller.signal}),error=>error.name==='AbortError');await ready;controller.abort();release();await pending;
 const partial=f.state.multiplayer.messages.at(-1),state=f.room.status().room.narration;assert.equal(state.reason,'validation');assert.equal(state.canContinue,true);assert.equal(partial.interrupted,true);const streams=f.calls.filter(c=>c.stream&&!c.response_format).length;
 const retried=await f.room.generate({continueMessageId:partial.id});assert.equal(retried.message.id,partial.id);assert.equal(retried.incomplete,false);assert.equal(f.calls.filter(c=>c.stream&&!c.response_format).length,streams);assert.equal(f.state.multiplayer.tactical.round,2);
});
test('Regeneration review uses the pinned resources that the original narration received',async t=>{
 const f=await multiplayerFixture(t);await withD20(2,()=>f.room.dice(20));await f.room.act({action:'end'});const first=await f.room.generate(),saved=f.state;
 assert.equal(saved.multiplayer.lastNarration.reviewActors.find(a=>a.id==='host').slots,6);
 // Model a resource change performed by a round transition, while retaining
 // its recorded revision; the private snapshot remains the narration source.
 saved.multiplayer.tactical.actors[0].slots=2;saved.multiplayer.lastNarration.contextHash=narrationContextHash(saved.multiplayer,first.message.id);f.save(saved);
 await f.room.generate({regenerateMessageId:first.message.id});const audits=f.calls.filter(c=>c.messages[0].content.includes('[SAS_REVIEW_GAME_NARRATION]'));
 assert.equal(JSON.parse(audits.at(-1).messages[1].content).actors.find(a=>a.name==='Бог').slots,6);assert.equal(f.state.multiplayer.tactical.actors[0].slots,2,'Text-only retry cannot restore spent resources');
});
test('A host can manually accept a reviewed draft even after the model connection was removed',async t=>{
 const f=await multiplayerFixture(t,{audit:()=>'{broken'});await withD20(2,()=>f.room.dice(20));await f.room.act({action:'end'});await assert.rejects(()=>f.room.generate(),error=>error.code==='GM_NARRATION_CONFLICT');
 const state=f.state,message=state.multiplayer.messages.at(-1);state.connections=[];state.activeConnectionId='';f.save(state);const calls=f.calls.length;
 const accepted=await f.room.generate({acceptMessageId:message.id});assert.equal(accepted.accepted,true);assert.equal(accepted.message.id,message.id);assert.equal(accepted.message.interrupted,false);assert.equal(f.state.multiplayer.tactical.round,2);assert.equal(f.calls.length,calls);
});
test('Preparing a task writes its difficulty without rolling; an explicit task roll uses that same stored DC',async t=>{
 const f=await multiplayerFixture(t),prepared=await f.room.act({action:'prepareCheck',checkType:'persuasion'});assert.ok(prepared.challenge.id);assert.equal(prepared.challenge.dc,15);assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,0);
 await withD20(1,()=>f.room.act({action:'check',challengeId:prepared.challenge.id}));const result=f.state.multiplayer.tactical.log.findLast(e=>e.calculation?.kind==='check').calculation;assert.equal(result.dc,15);assert.equal(result.roll,1);assert.equal(result.critical,'failure');assert.equal(result.outcome,'failure');assert.equal(f.calls.length,1);
});
test('Free chat d20 greeting remains a free die; explicit forged outcomes fail before model preparation',async t=>{
 const f=await multiplayerFixture(t,{reply:decision({requiresCheck:false}),messages:[{id:'greet',role:'user',userId:'host',name:'Морвен',personaName:'Бог',content:'Приветствую торговца.'}]}),result=await withD20(20,()=>f.room.dice(20));
 assert.equal(result.message.dice.value,20);assert.match(result.message.content,/не проверка действия/);assert.equal(f.state.multiplayer.tactical.challenges.length,0);assert.ok(!f.state.multiplayer.tactical.log.some(e=>e.calculation?.kind==='check'));
 await assert.rejects(()=>f.room.act({action:'check',checkType:'persuasion',dc:1}),/ведущий и движок/);assert.equal(f.calls.length,1);
});
test('Preparation cannot commit after a player post changes while the model is working',async t=>{
 let release,started;const ready=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve),f=await multiplayerFixture(t,{delay:()=>{started();return wait;}});
 const pending=f.room.act({action:'check',checkType:'persuasion'});await ready;const state=f.state;state.multiplayer.messages.at(-1).content='Я передумал и отхожу от прилавка.';f.save(state);release();
 await assert.rejects(()=>pending,/Ситуация изменилась/);assert.equal(f.state.multiplayer.tactical.challenges.length,0);assert.ok(!f.state.multiplayer.tactical.log.some(e=>e.calculation?.kind==='check'));
});
test('A desktop guest can prepare and roll only its own post over the real WebSocket protocol',async t=>{
 const guestPersona={...persona,id:'guest-sheet',name:'Мира'},f=await multiplayerFixture(t,{reply:decision({targetId:'merchant'})});let guestState={personas:[guestPersona]};
 const client=createMultiplayerClient({getState:()=>structuredClone(guestState),saveState:s=>{guestState=structuredClone(s);},canAutoSave:()=>false});t.after(()=>client.leave());const host=f.room.status();await client.join({url:`http://127.0.0.1:${host.port}`,code:host.code,personaId:guestPersona.id,name:'TestAccount'});
 const state=f.state,id=client.status().selfId;state.multiplayer.tactical.order=[id,'host'];state.multiplayer.tactical.turn=0;state.multiplayer.tactical.phase='players';f.save(state);
 await client.command('message',{content:'Прошу торговца снизить цену.'});await withD20(20,()=>client.command('dice',{sides:20}));
 const event=f.state.multiplayer.tactical.log.findLast(e=>e.calculation?.kind==='check');assert.equal(event.calculation.actorId,id);assert.equal(event.calculation.roll,20);assert.equal(event.calculation.critical,'success');assert.equal(event.calculation.outcome,'success');
 await assert.rejects(()=>client.command('game',{action:'check',actorId:'host',checkType:'persuasion'}),/своим игроком/);assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,1);
});
test('A rulebook edit during preparation invalidates the old decision without rolling or persisting a stale difficulty',async t=>{
 let release,started;const ready=new Promise(r=>started=r),waiting=new Promise(r=>release=r),f=await multiplayerFixture(t,{reply:decision({checkType:'strength',targetId:'',subjectKind:'environment',subjectName:'Валун'}),delay:()=>{started();return waiting;}}),state=f.state;
 state.lorebooks.push({id:'current-rules',name:'Правила',entries:[{id:'effect',enabled:true,content:'Обычный валун требует силы.'}]});state.multiplayer.rulebookIds=['current-rules'];f.save(state);
 const pending=f.room.act({action:'prepareCheck',checkType:'strength',intent:'Сдвинуть валун.'});await ready;const changed=f.state;changed.lorebooks.find(b=>b.id==='current-rules').entries[0].content='Этот валун закреплён неразрушимой магической печатью.';f.save(changed);release();
 await assert.rejects(()=>pending,/Ситуация изменилась/);assert.equal(f.state.multiplayer.tactical.challenges.length,0);assert.ok(!f.state.multiplayer.tactical.log.some(e=>e.calculation?.kind==='check'));
});
