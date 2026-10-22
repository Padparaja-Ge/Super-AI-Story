import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {createMultiplayerClient} from '../server/multiplayer-client.mjs';
import {sanitizeState} from '../server/store.mjs';
import {createAdventureGame,adventureActor} from '../server/adventure-engine.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {beginInitiative} from '../server/initiative.mjs';
import {fitNarrationPrompt,continuationInstruction,publicNarration,createNarrationContinuationJoiner,narrationContextHash} from '../server/room-narration.mjs';
import {roomChat} from '../server/room-memory.mjs';
import {messageTokens,buildPrompt} from '../server/prompt.mjs';
const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
const persona={id:'srp',name:'Рей',avatar:'R',kind:'srp',className:'Воин',abilities:defaultAbilities()};
test('Narration removes malformed service round headings without removing story text or dialogue',async()=>{
 const {cleanNarration}=await import('../server/room-narration.mjs');assert.equal(cleanNarration('*Раунд 3 · Рассказчик**\nСтраж открыл дверь.'),'Страж открыл дверь.');assert.equal(cleanNarration('**Раунд 12 · Ведущий**\r\nГерои услышали шум.'),'Герои услышали шум.');assert.equal(cleanNarration('— Раунд 3 · Рассказчик, — прочёл он.'),'— Раунд 3 · Рассказчик, — прочёл он.');
});
test('Narration removes standalone round completion banners, preserving dialogue and prose',async()=>{
 const {cleanNarration,narrationStops}=await import('../server/room-narration.mjs');
 assert.equal(cleanNarration('Страж открывает дверь.\n\n**Раунд 2 завершён.**'),'Страж открывает дверь.');
 assert.equal(cleanNarration('Конец раунда\nСтраж ждёт у двери.'),'Страж ждёт у двери.');
 assert.equal(cleanNarration('— Раунд завершён, — сказал судья.'),'— Раунд завершён, — сказал судья.');
 assert.ok(narrationStops(2).includes('\nРаунд 2 заверш'));
});
async function fixture(t,reply,{mode='dnd',npc=false,npcDecision}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-narration-')),calls=[];
  const provider=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);
    if(body.messages[0].content.includes('You control only this NPC')){const context=JSON.parse(body.messages[1].content),actor=context.actor;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(npcDecision?npcDecision(context):{x:actor.x,y:actor.y,action:'pass',targetId:'',skillId:''})},finish_reason:'stop'}]}));return;}
    const next=await reply(body,calls),event={choices:[{delta:{content:next.text},...(next.reason?{finish_reason:next.reason}:{})}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify(event)+'\n\n'+(next.eof?'':'data: [DONE]\n\n'));
  });await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  let state=sanitizeState(structuredClone(seed));state.personas.push(persona);state.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;state.connections[0].model='mock';state.connections[0].contextWindow=8192;state.connections[0].maxTokens=150;state.activeConnectionId=state.connections[0].id;state.plugins=[];
  const g=mode==='roleplay'?undefined:createAdventureGame(mode);if(g){g.actors=[adventureActor('host',persona,g.rules)];g.order=['host'];g.phase='gm';}
  if(npc){g.actors.push({...adventureActor('npc',{...persona,id:'npc',name:'Страж'},g.rules),player:false,x:1,y:1});g.inCombat=true;g.actors[0].abilities.dexterity=12;g.actors[1].abilities.dexterity=8;}
  state.multiplayer={id:'room-own',name:'Наша игра',mode,connectionId:state.connections[0].id,chatId:seed.chats[0].id,messages:[{id:'player',role:'user',name:'Рей',content:'Входим в таверну.',createdAt:new Date().toISOString()}],memory:[],summary:'',memorySettings:{autoSummary:false,vectorMemory:false},scene:{autoUpdate:false,location:'Площадь'},personas:{},tactical:g};
  const opts={getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',dataDir:dir,tasks:{busy:()=>true}};
  let room=createMultiplayer(opts);await room.start({port:0,personaId:persona.id});
  // The reopened GM phase must remain unchanged.
  if(g)assert.equal(state.multiplayer.tactical.phase,'gm');
  t.after(async()=>{await room.stop();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {get state(){return state;},save:s=>state=structuredClone(s),get room(){return room;},calls,async reopen(){await room.stop();room=createMultiplayer(opts);await room.start({port:0,personaId:persona.id});}};
}
test('D&D prompts use persona names, keep all requests once and sanitize old nickname summaries and regeneration',async t=>{
 const f=await fixture(t,()=>({text:'Страж указывает на дорогу.',reason:'stop'})),s=f.state;
 s.settings.userName='Морвен';s.personas.find(p=>p.id===persona.id).name='Бог';s.multiplayer.tactical.actors[0].name='Бог';
 s.multiplayer.personas.host={...persona,name:'Бог'};s.multiplayer.summary='Морвен нашёл ключ от ворот.';
 s.multiplayer.messages=[{id:'first',role:'user',userId:'host',name:'Морвен',personaName:'Бог',content:'Где хранится единственная печать 7139?',createdAt:new Date().toISOString()}];f.save(s);await f.reopen();
 assert.equal(f.room.status().participants[0].name,'Морвен','Account name remains available in the lobby');
 const first=await f.room.generate();const prompt=JSON.stringify(f.calls.at(-1).messages);
 assert.doesNotMatch(prompt,/Морвен/);assert.match(prompt,/Бог/);assert.equal(prompt.split('Где хранится единственная печать 7139?').length-1,1);
 assert.match(prompt,/Бог нашёл ключ/);assert.ok(f.calls.at(-1).stop.includes('\nРаунд 1 заверш'));
 assert.ok(f.state.multiplayer.contextReport.performance.totalMs>=0);
 await f.room.generate({regenerateMessageId:first.message.id});assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages),/Морвен/);
});

test('Multiplayer RP applies the local instruction template and disables thinking just like standalone RP',async t=>{
 const f=await fixture(t,()=>({text:'Ирис указывает на дверь таверны.',reason:'stop'}),{mode:'roleplay'}),s=f.state;
 const id=s.connections[0].id;s.connections[0].id='sas-local';s.connections[0].promptFormat='alpaca';s.activeConnectionId='sas-local';s.multiplayer.connectionId='sas-local';
 for(const chat of s.chats)if(chat.connectionId===id)chat.connectionId='sas-local';f.save(s);
 await f.room.generate();const request=f.calls.findLast(c=>c.stream===true);
 assert.ok(request);assert.ok(request.messages.every(m=>m.role!=='system'));assert.equal(request.chat_template_kwargs.enable_thinking,false);
 assert.ok(request.stop.includes('### Instruction:'));assert.ok(request.messages.some(m=>m.content.includes('Входим в таверну.')));
});
test('Unique actions in a long post survive deduplication when the model context can hold the post',async t=>{
 const f=await fixture(t,()=>({text:'Страж отвечает на вопросы.',reason:'stop'})),s=f.state;
 const actions=Array.from({length:60},(_,i)=>`Проверяю отдельную нишу ${i} и спрашиваю о печати КОД${i}.`);
 s.multiplayer.messages[0].content=actions.join(' ');f.save(s);await f.room.generate();
 const prompt=JSON.stringify(f.calls.at(-1).messages);for(const action of actions)assert.equal(prompt.split(action).length-1,1,action);
});

test('Custom NRI NPC spends two configured slow actions, and a finished narration does not replay them',async t=>{
 const f=await fixture(t,()=>({text:'Страж дважды атаковал; результат рассчитан движком.',reason:'stop'}),{mode:'custom',npc:true,npcDecision:({actor})=>({x:actor.x,y:actor.y,action:'skill',targetId:'host',skillId:'unarmed'})});
 const state=f.state,g=state.multiplayer.tactical;g.rules.slowActions=2;g.rules.physicalAccuracy=30;g.map={width:12,height:12,tiles:Array(144).fill(0),doors:[],start:[]};Object.assign(g.actors[0],{x:1,y:2,hp:100,maxHp:100,baseMaxHp:100});Object.assign(g.actors[1],{x:1,y:1,actions:2});f.save(state);
 const result=await f.room.generate();assert.equal(result.incomplete,false);
 assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,2);
 const attacks=f.state.multiplayer.tactical.eventArchive.filter(e=>e.calculation?.kind==='attack');assert.equal(attacks.length,2);assert.ok(attacks.every(e=>e.calculation.hit));
 assert.equal(f.state.multiplayer.tactical.round,2);
});

test('D&D length finish automatically completes one message and advances the round once',async t=>{
  let step=0;const f=await fixture(t,()=>++step===1?{text:'Отряд вошёл в ',reason:'length'}:{text:'таверну. Страж кивнул.',reason:'stop'},{npc:true});
  const result=await f.room.generate();assert.equal(result.incomplete,false);assert.equal(result.message.content,'Отряд вошёл в таверну. Страж кивнул.');assert.equal(f.state.multiplayer.messages.filter(m=>m.role==='assistant').length,1);assert.equal(f.state.multiplayer.tactical.round,2);assert.equal(f.state.multiplayer.tactical.phase,'players');
  assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,1);assert.ok(f.calls.at(-1).messages.some(m=>m.content===continuationInstruction));assert.equal(f.state.multiplayer.narration,undefined);
});

test('Regenerating GM prose preserves all combat results and round state, rejects later turns, and keeps snapshots private',async t=>{
 let prose=0;const f=await fixture(t,()=>({text:++prose===1?'*Раунд 1 · Рассказчик**\nСтраж отступил.':'Страж пятится к двери, придерживая рану.',reason:'stop'}),{npc:true});
 const first=await f.room.generate();assert.equal(first.message.content,'Страж отступил.');const game=structuredClone(f.state.multiplayer.tactical),beforeMessages=f.state.multiplayer.messages.length,npcCalls=f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length;
 assert.equal(f.room.status().room.regeneration.canRegenerate,true);assert.equal(f.room.status().room.lastNarration,undefined);
 const second=await f.room.generate({regenerateMessageId:first.message.id});assert.equal(second.message.id,first.message.id);assert.match(second.message.content,/пятится/);assert.deepEqual(f.state.multiplayer.tactical,game);assert.equal(f.state.multiplayer.messages.length,beforeMessages);assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,npcCalls);
 f.room.hostMessage('Осматриваю дверь.');await assert.rejects(f.room.generate({regenerateMessageId:first.message.id}),/новых сообщений/);assert.deepEqual(f.state.multiplayer.tactical,game);
});

test('Failed or truncated regeneration retains the last completed answer and calculated resources',async t=>{
 let prose=0;const f=await fixture(t,()=>++prose===1?{text:'Страж открыл дверь.',reason:'stop'}:{text:'Новый вариант ',reason:'length'});const first=await f.room.generate(),game=structuredClone(f.state.multiplayer.tactical);
 await assert.rejects(f.room.generate({regenerateMessageId:first.message.id}),/Предыдущий ответ сохранён/);assert.equal(f.state.multiplayer.messages.at(-1).content,first.message.content);assert.deepEqual(f.state.multiplayer.tactical,game);assert.equal(f.room.status().generating,false);
});

test('Three length replies persist one recoverable draft; host continuation never reapplies NPC turns',async t=>{
  let prose=0;const f=await fixture(t,()=>++prose<=3?{text:'Длинный рассказ ',reason:'length'}:{text:'завершён.',reason:'stop'},{npc:true});
  const first=await f.room.generate();assert.equal(first.incomplete,true);assert.equal(prose,3);assert.equal(f.state.multiplayer.tactical.round,1);assert.equal(f.room.status().room.narration.reason,'length');assert.equal(f.room.status().room.narration.canContinue,true);assert.equal(f.room.status().room.narration.promptMessages,undefined);
  assert.throws(()=>f.room.hostMessage('Новый ход'),/завершите/);assert.throws(()=>f.room.act({action:'end'}),/завершите/);await assert.rejects(f.room.generate(),/Дописать/);
  const result=await f.room.generate({continueMessageId:first.message.id});assert.equal(result.message.id,first.message.id);assert.equal(result.message.content,'Длинный рассказ '.repeat(3)+'завершён.');assert.equal(f.state.multiplayer.tactical.round,2);assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,1);
  await assert.rejects(f.room.generate({continueMessageId:first.message.id}),/не найден/);
});

test('Network EOF persists the full partial and resumes after closing and reopening the room',async t=>{
  let prose=0;const f=await fixture(t,()=>++prose===1?{text:'Страж открыл дверь и ',eof:true}:{text:'пригласил героев внутрь.',reason:'stop'},{npc:true});
  await assert.rejects(f.room.generate(),/Поток ответа прервался/);const partial=f.state.multiplayer.messages.at(-1),hp=f.state.multiplayer.tactical.actors[0].hp;
  assert.equal(partial.content,'Страж открыл дверь и ');assert.equal(partial.interrupted,true);assert.deepEqual(f.state.multiplayer.tactical.gmProcessed,['npc']);assert.equal(f.state.multiplayer.tactical.inCombat,true);assert.equal(f.room.status().room.narration.canContinue,true);assert.ok(!roomChat(f.state.multiplayer).messages.some(m=>m.id===partial.id));
  await f.reopen();assert.equal(f.state.multiplayer.tactical.inCombat,true);assert.deepEqual(f.state.multiplayer.tactical.gmProcessed,['npc']);assert.equal(f.state.multiplayer.tactical.actors[0].hp,hp);assert.equal(f.room.status().room.narration.canContinue,true);
  const done=await f.room.generate({continueMessageId:partial.id});assert.equal(done.message.content,'Страж открыл дверь и пригласил героев внутрь.');assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,1);assert.ok(roomChat(f.state.multiplayer).messages.some(m=>m.id===partial.id));
});

test('Host may finish an edited partial without a model call; stale source cannot be resumed',async t=>{
  const f=await fixture(t,()=>({text:'Страж ',eof:true}));await assert.rejects(f.room.generate());const id=f.state.multiplayer.messages.at(-1).id;
  f.room.editMessage('player','Игроки решили остаться на площади.');assert.equal(f.room.status().room.narration.canContinue,false);await assert.rejects(f.room.generate({continueMessageId:id}),/Контекст раунда изменён/);
  f.room.editMessage(id,'Страж остался на площади.');const before=f.calls.length;const result=await f.room.generate({acceptMessageId:id});assert.equal(result.accepted,true);assert.equal(f.calls.length,before);assert.equal(result.message.interrupted,false);assert.equal(f.state.multiplayer.tactical.round,2);
});

test('Old-version interrupted narrator prose can be continued without repeating NPC decisions',async t=>{
  const f=await fixture(t,()=>({text:'завершил речь.',reason:'stop'}));const s=f.state;s.multiplayer.messages.push({id:'legacy',role:'assistant',content:'Страж ',interrupted:true});s.multiplayer.gmError='Сетевой обрыв';f.save(s);
  assert.equal(f.room.status().room.narration.legacy,true);const result=await f.room.generate({continueMessageId:'legacy'});assert.equal(result.message.content,'Страж завершил речь.');assert.equal(f.state.multiplayer.tactical.round,2);
});

test('D&D uses separate rules, lore and narrator configuration, excluding all solo and fanfic state',async t=>{
  const f=await fixture(t,()=>({text:'Отряд вошёл в таверну.',reason:'stop'}));const s=f.state;
  s.settings.narrative={instructions:'SOLO_NARRATIVE_SECRET',mode:'writer',length:'long',perspective:'first'};s.activePresetId='solo-preset';s.presets.push({id:'solo-preset',systemPrompt:'SOLO_PRESET_SECRET'});s.plugins=[{id:'custom',enabled:true,prompt:'SOLO_PLUGIN_SECRET'}];s.chats[0].summary='SOLO_MEMORY_SECRET';s.chats[0].memory=[{id:'s',content:'SOLO_MEMORY_SECRET'}];s.fanficProjects=[{id:'f',canon:[{content:'FANFIC_SECRET'}]}];s.multiplayerHistories=[{id:'another',summary:'FOREIGN_ROOM_SECRET',messages:[]}];
  s.lorebooks=[{id:'world',name:'Мир',entries:[{id:'w',name:'Город',content:'WORLD_SOURCE_731',enabled:true,constant:true}]},{id:'rules',name:'Правила проверок',entries:[{id:'r',name:'Проверка',content:'RULE_SOURCE_937',enabled:true,keys:['NEVER_MATCH']}]},{id:'foreign',name:'Чужое',entries:[{id:'f',content:'FOREIGN_LORE_SECRET',constant:true}]}];f.save(s);f.room.configure({lorebookIds:['world'],rulebookIds:['rules']});
  const c=f.room.context();assert.equal(c.chat.presetId,undefined);assert.equal(c.chat.summary,'');assert.equal(c.chat.memory.length,0);assert.equal(c.state.activePresetId,'');assert.equal(c.state.settings.narrative.instructions,'');assert.deepEqual(c.chat.lorebookIds,['world']);const prompt=buildPrompt(c.state,c.chat.id,'',{extraInstructions:c.extraInstructions});const text=JSON.stringify(prompt.messages);
  assert.match(text,/РУЛБУКИ — ПРАВИЛА/);assert.match(text,/Рулбук «Правила проверок»/);assert.match(text,/Лорбук «Мир»/);assert.match(text,/RULE_SOURCE_937/);assert.match(text,/WORLD_SOURCE_731/);assert.doesNotMatch(text,/SOLO_.*SECRET|FANFIC_SECRET|FOREIGN_.*SECRET/);
});

test('Continuation prompt uses actual token count, retains the unfinished ending and never mutates its snapshot',async()=>{
  const source=[{role:'system',content:'Rules '.repeat(1500)},{role:'user',content:'PLAYER_ACTION_731 '+('scene '.repeat(900))}],before=structuredClone(source),text='draft '.repeat(2500)+'UNFINISHED_TAIL';let count=0;
  const fitted=await fitNarrationPrompt({id:'sas-local',contextWindow:2048,maxTokens:400},'',source,{text,maxTokens:400,countTokens:async(c,k,m)=>{count++;return messageTokens(m)*2;}});
  assert.ok(fitted.actualTokens<=2048-400-32);assert.match(fitted.messages.at(-2).content,/UNFINISHED_TAIL$/);assert.equal(fitted.messages.at(-1).content,continuationInstruction);assert.deepEqual(source,before);assert.ok(count>1);
});


test('Changed selected rulebook invalidates a saved narration, unrelated book changes do not',async t=>{
  const f=await fixture(t,()=>({text:'Страж начал рассказывать ',eof:true}));const s=f.state;s.lorebooks=[{id:'rules',name:'Правила',entries:[{id:'r',content:'RULE_ALPHA',constant:true}]},{id:'other',name:'Другой мир',entries:[{id:'o',content:'FOREIGN_ALPHA',constant:true}]}];f.save(s);f.room.configure({rulebookIds:['rules'],lorebookIds:[]});await assert.rejects(f.room.generate());const partial=f.state.multiplayer.messages.at(-1);
  const foreign=f.state;foreign.lorebooks.find(b=>b.id==='other').entries[0].content='FOREIGN_BETA';f.save(foreign);assert.equal(f.room.status().room.narration.canContinue,true);
  const own=f.state;own.lorebooks.find(b=>b.id==='rules').entries[0].content='RULE_BETA';f.save(own);assert.equal(f.room.status().room.narration.canContinue,false);await assert.rejects(f.room.generate({continueMessageId:partial.id}),/Контекст раунда изменён/);
});

test('Resume honors the newly configured output limit without replaying the engine',async t=>{
  let calls=0;const f=await fixture(t,()=>++calls<=3?{text:'Страж продолжает ',reason:'length'}:{text:'и завершает рассказ.',reason:'stop'});const first=await f.room.generate();assert.equal(f.calls[0].max_tokens,150);const s=f.state;s.connections[0].maxTokens=600;f.save(s);await f.room.generate({continueMessageId:first.message.id});assert.equal(f.calls.at(-1).max_tokens,600);assert.equal(f.state.multiplayer.tactical.round,2);
});


test('Native-budget compaction never crops protected GM rules, engine resources or current requests',async()=>{
  const priority=[{role:'system',content:'GM_FIXED_CONTRACT '+JSON.stringify({round:7,actors:[{id:'host',hp:17,slots:3,x:12,y:4},{id:'npc',hp:8,slots:0,x:13,y:4}],events:'NPC_ATTACK_ALREADY_CALCULATED'})},{role:'user',content:'PLAYER_1 asks password CODE_731. PLAYER_2 opens door. PLAYER_3 waits. PLAYER_4 asks debt 37.'}];
  const refs=[{role:'system',content:'Archived scenery '.repeat(3000)},{role:'user',content:'Decorative prose '.repeat(2000)}],before=structuredClone(priority);
  const fitted=await fitNarrationPrompt({id:'sas-local',contextWindow:2048,maxTokens:300},'',refs,{text:'An unfinished narration '.repeat(150),maxTokens:300,priorityMessages:priority,countTokens:async(c,k,m)=>messageTokens(m)*2});
  assert.deepEqual(priority,before);for(const p of priority)assert.ok(fitted.messages.some(m=>m.role===p.role&&m.content===p.content));assert.ok(fitted.actualTokens<=2048-300-32);assert.match(JSON.stringify(fitted.messages),/CODE_731|NPC_ATTACK_ALREADY_CALCULATED/);
});

test('Oversized lore does not evict engine facts or four current player requests from D&D prompt',async t=>{
  const f=await fixture(t,()=>({text:'Герои дождались ответа.',reason:'stop'})),s=f.state;s.connections[0].contextWindow=2048;s.lorebooks=[{id:'huge',name:'Длинный лор',entries:[{id:'h',name:'Украшения',constant:true,content:'Многословные украшения мира. '.repeat(1500)}]}];s.multiplayer.lorebookIds=['huge'];s.multiplayer.tactical.actors[0].hp=17;s.multiplayer.tactical.actors[0].slots=3;s.multiplayer.tactical.actors[0].x=12;s.multiplayer.tactical.actors[0].y=4;s.multiplayer.tactical.log.push({id:'calc',round:1,text:'NPC_ATTACK_ALREADY_CALCULATED: Страж промахнулся.'});s.multiplayer.messages=Array.from({length:4},(_,i)=>({id:'p'+i,role:'user',name:'PLAYER_'+i,content:'Игрок '+i+' просит напомнить CODE_'+i+'731. '+('Туман окутывает площадь. '.repeat(220))}));f.save(s);await f.room.generate();
  const prompt=f.calls.at(-1).messages,contract=prompt.find(m=>m.content.startsWith('[SAS_GM_ROUND_CONTRACT]')),requests=prompt.find(m=>m.content.startsWith('[SAS_CURRENT_PLAYER_REQUESTS]'));
  assert.ok(contract);assert.match(contract.content,/"hp":17/);assert.match(contract.content,/"slots":3/);assert.match(contract.content,/"x":12/);assert.match(contract.content,/NPC_ATTACK_ALREADY_CALCULATED/);assert.ok(requests);for(let i=0;i<4;i++)assert.match(requests.content,new RegExp('CODE_'+i+'731'));
});


test('Midword continuation joins Russian and English token replay without changing the saved prefix',()=>{
  for(const {before,chunks,expected} of [
    {before:'Ирис, Рей, Мира и Торк осматривают стра',chunks:['\n','ст','ража, оценивая обстановку.'],expected:'Ирис, Рей, Мира и Торк осматривают стража, оценивая обстановку.'},
    {before:'The group asks a ques',chunks:['\n  ques','tion about the tower.'],expected:'The group asks a question about the tower.'},
    {before:'В дверях стоял Ст',chunks:['\nст','раж.'],expected:'В дверях стоял Страж.'},
  ]){const joiner=createNarrationContinuationJoiner(before);let text=before;for(const chunk of chunks)text+=joiner.push(chunk);text+=joiner.flush();assert.equal(text,expected);assert.equal(text.slice(0,before.length),before);}
});

test('Normal boundaries and arbitrary repetitions are preserved byte for byte',()=>{
  for(const [before,chunks] of [
    ['Страж закончил речь.', ['\n\nСтража ждёт новый вопрос.']],
    ['Страж закончил речь ', ['стража слышат герои.']],
    ['Осматривают стража', ['\nстража, затем дверь.']],
    ['The group says go', [' go, go, go.']],
    ['Она стояла на', [' набережной.']],
    ['Она стояла на', ['\nнабережной.']],
    ['The speaker says no', [' nobody can enter.']],
    ['The speaker says no', ['\nnobody can enter.']],
    ['They wait for', ['\nforest guards.']],
    ['Герои осматривают стра', [' стража у ворот.']],
    ['They enter the car', ['\nA carriage waits outside.']],
    ['Герои осматривают стра', ['\nплощадь и трактир.']],
    ['A', [' another event.']],
    ['Вопрос: стра', ['\n«Стража пропустит вас?»']],
  ]){const joiner=createNarrationContinuationJoiner(before);let addition='';for(const chunk of chunks)addition+=joiner.push(chunk);addition+=joiner.flush();assert.equal(addition,chunks.join(''));assert.equal(before+addition,before+chunks.join(''));}
});

test('Incomplete ambiguous continuation buffers flush without losing bytes on EOF',()=>{
  for(const chunks of [['\n','ст'],['\n','стра'],['\n  ']]){const joiner=createNarrationContinuationJoiner('Осматривают стра');let addition='';for(const chunk of chunks)addition+=joiner.push(chunk);addition+=joiner.flush();assert.equal(addition,chunks.join(''));assert.equal(joiner.flush(),'');}
});

test('Automatic D&D continuation fixes a midword seam while preserving one message and one round reset',async t=>{
  let step=0;const f=await fixture(t,()=>++step===1?{text:'Герои осматривают стра',reason:'length'}:{text:'\nстража, оценивая обстановку.',reason:'stop'});const result=await f.room.generate();assert.equal(result.message.content,'Герои осматривают стража, оценивая обстановку.');assert.equal(f.state.multiplayer.messages.filter(m=>m.role==='assistant').length,1);assert.equal(f.state.multiplayer.tactical.round,2);
});

test('Manual D&D continuation fixes the same midword seam after a recoverable network interruption',async t=>{
  let step=0;const f=await fixture(t,()=>++step===1?{text:'The group asks a ques',eof:true}:{text:'\nquestion about the tower.',reason:'stop'});await assert.rejects(f.room.generate());const partial=f.state.multiplayer.messages.at(-1),prefix=partial.content;assert.equal(prefix,'The group asks a ques');const result=await f.room.generate({continueMessageId:partial.id});assert.equal(result.message.content,'The group asks a question about the tower.');assert.equal(result.message.content.slice(0,prefix.length),prefix);assert.equal(result.message.id,partial.id);assert.equal(f.state.multiplayer.tactical.round,2);
});


test('Narration revision tracks engine resources, participants, rules and map geometry but ignores connection cosmetics',()=>{
  const room={id:'revision-room',mode:'dnd',personas:{host:{id:'hero',name:'Hero',description:'Warrior',avatar:'A'}},scene:{location:'Gate'},messages:[{id:'partial',role:'assistant',content:'The guard ',interrupted:true}],tactical:{round:2,phase:'gm',inCombat:true,log:[],gmProcessed:['npc'],rules:{armor:10},map:{id:'map',width:2,height:2,tiles:[0,0,0,1],imageId:'old'},actors:[{id:'host',personaId:'hero',name:'Hero',hp:20,slots:3,x:1,y:0,online:true,avatar:'A'},{id:'guest',personaId:'guest-sheet',name:'Guest',hp:15,slots:2,x:0,y:1,online:true}]}};room.narration={messageId:'partial',status:'incomplete',contextHash:narrationContextHash(room,'partial')};
  assert.equal(publicNarration(room).canContinue,true);
  const reconnect=structuredClone(room);reconnect.tactical.actors[1].online=false;reconnect.tactical.actors[0].avatar='B';reconnect.personas.host.avatar='B';reconnect.tactical.map.imageId='completed-image';assert.equal(publicNarration(reconnect).canContinue,true);
  for(const change of [r=>r.tactical.actors[0].hp=5,r=>r.tactical.actors[0].slots=0,r=>r.tactical.actors[0].x=3,r=>r.tactical.rules.armor=12,r=>r.tactical.map.tiles[0]=1,r=>r.personas.host.name='Another hero',r=>r.personas.host.description='Another character',r=>r.tactical.actors.push({id:'new',hp:30,x:0,y:0})]){const altered=structuredClone(room);change(altered);assert.equal(publicNarration(altered).canContinue,false);}
});

test('Pending room refuses a different host persona while preserving same-host reopening and the frozen guest table',async t=>{
  const f=await fixture(t,()=>({text:'Страж начал речь ',eof:true})),s=f.state;s.personas.push({...persona,id:'different',name:'Другой герой'});const guest=adventureActor('guest',{...persona,id:'guest-sheet',name:'Гость'},s.multiplayer.tactical.rules);guest.hp=13;guest.slots=2;guest.x=3;guest.y=2;s.multiplayer.tactical.actors.push(guest);s.multiplayer.personas.guest={id:'guest-sheet',name:'Гость'};f.save(s);await assert.rejects(f.room.generate());const partial=f.state.multiplayer.messages.at(-1),frozen=structuredClone(f.state.multiplayer);await f.room.stop();
  await assert.rejects(f.room.start({port:0,personaId:'different'}),e=>e.status===409&&/прежней персоной/.test(e.message));assert.equal(f.state.multiplayer.tactical.actors[0].personaId,'srp');
  await f.room.start({port:0,personaId:'srp'});const now=f.state.multiplayer;assert.deepEqual(now.tactical.actors.map(({online,avatar,...a})=>a),frozen.tactical.actors.map(({online,avatar,...a})=>a));assert.deepEqual(now.personas,frozen.personas);assert.deepEqual(now.tactical.rules,frozen.tactical.rules);assert.deepEqual(now.scene,frozen.scene);assert.equal(f.room.status().room.narration.canContinue,true);const retained=f.state.multiplayer.tactical.actors.find(a=>a.id==='guest');assert.equal(retained.hp,13);assert.equal(retained.slots,2);assert.equal(retained.x,3);assert.equal(retained.y,2);assert.equal(retained.online,false);assert.equal(f.state.multiplayer.messages.at(-1).id,partial.id);
});

test('All current round events survive beyond forty entries and 2500 characters with adequate context',async t=>{
  const f=await fixture(t,()=>({text:'Ведущий описал рассчитанные последствия.',reason:'stop'})),s=f.state;s.connections[0].contextWindow=30000;s.multiplayer.tactical.log=Array.from({length:55},(_,i)=>({id:'result-'+i,round:1,text:'CURRENT_RESULT_'+i+'_731: '+('Подтверждённый результат атаки. '.repeat(8))}));f.save(s);await f.room.generate();const protectedContract=f.calls.at(-1).messages.find(m=>m.content.startsWith('[SAS_GM_ROUND_CONTRACT]'));assert.ok(protectedContract);assert.ok(protectedContract.content.length>2500);for(let i=0;i<55;i++)assert.match(protectedContract.content,new RegExp('CURRENT_RESULT_'+i+'_731'));
});

test('A too-large current round fails explicitly without a final narration or resetting resources',async t=>{
  const f=await fixture(t,()=>({text:'THIS_MUST_NOT_BE_CALLED',reason:'stop'})),s=f.state;s.connections[0].contextWindow=1024;s.multiplayer.tactical.log=Array.from({length:55},(_,i)=>({id:'result-'+i,round:1,text:'CURRENT_RESULT_'+i+'_731: '+('Подтверждённый результат атаки. '.repeat(8))}));s.multiplayer.tactical.actors[0].hp=17;f.save(s);await assert.rejects(f.room.generate(),e=>e.code==='NARRATION_CONTEXT');assert.equal(f.calls.length,0);assert.equal(f.state.multiplayer.messages.filter(m=>m.role==='assistant').length,0);assert.equal(f.state.multiplayer.tactical.round,1);assert.equal(f.state.multiplayer.tactical.actors[0].hp,17);assert.equal(f.state.multiplayer.tactical.log.length,55);
});


test('Stopping a partial room with a real WebSocket guest preserves the frozen actor and allows same-host reopen',async t=>{
  let reply=0;const f=await fixture(t,()=>++reply===1?{text:'Страж начал рассказывать ',eof:true}:{text:'и завершил речь.',reason:'stop'}),client=createMultiplayerClient({getState:()=>({personas:[persona]})});t.after(()=>client.leave());const withMap=f.state;withMap.multiplayer.tactical.map={id:'test-map',width:5,height:5,tiles:Array(25).fill(0),start:[{x:0,y:0},{x:3,y:2}]};f.save(withMap);const status=f.room.status(),joined=await client.join({url:'http://127.0.0.1:'+status.port+'/play?code='+status.code,personaId:'srp',name:'Гость'}),guestId=joined.selfId;
  const s=f.state,guest=s.multiplayer.tactical.actors.find(a=>a.id===guestId);guest.hp=12;guest.slots=2;guest.x=3;guest.y=2;f.save(s);await assert.rejects(f.room.generate());const frozen=structuredClone(f.state.multiplayer.tactical.actors.find(a=>a.id===guestId));assert.equal(f.room.status().room.narration.canContinue,true);await f.room.stop();
  for(let i=0;i<100&&f.state.multiplayer.tactical.actors.find(a=>a.id===guestId)?.online!==false;i++)await new Promise(r=>setTimeout(r,10));
  const offline=f.state.multiplayer.tactical.actors.find(a=>a.id===guestId);assert.ok(offline);assert.equal(offline.online,false);const {online:oldOnline,...canonicalBefore}=frozen,{online:newOnline,...canonicalAfter}=offline;assert.deepEqual(canonicalAfter,canonicalBefore);await f.reopen();assert.equal(f.room.status().room.narration.canContinue,true);assert.equal(f.state.multiplayer.tactical.actors.find(a=>a.id===guestId).hp,12);assert.equal(f.state.multiplayer.tactical.actors.find(a=>a.id===guestId).slots,2);assert.equal(f.state.multiplayer.tactical.round,1);
  const reconnect=createMultiplayerClient({getState:()=>({personas:[persona]})});t.after(()=>reconnect.leave());const invitation=()=>{const s=f.room.status();return 'http://127.0.0.1:'+s.port+'/play?code='+s.code;},beforeJoin=structuredClone(f.state.multiplayer);
  await assert.rejects(reconnect.join({url:invitation(),personaId:'srp',name:'Гость'}),/Хост дописывает/);assert.deepEqual(f.state.multiplayer.tactical.actors,beforeJoin.tactical.actors);assert.deepEqual(f.state.multiplayer.personas,beforeJoin.personas);assert.equal(f.room.status().room.narration.canContinue,true);
  await f.room.generate({continueMessageId:f.room.status().room.narration.messageId});assert.equal(f.state.multiplayer.tactical.actors.find(a=>a.id===guestId).online,false);assert.equal(f.state.multiplayer.tactical.actors.find(a=>a.id===guestId).hp,12);assert.equal(f.state.multiplayer.tactical.order.includes(guestId),false);assert.equal(f.state.multiplayer.tactical.round,2);
  const next=await reconnect.join({url:invitation(),personaId:'srp',name:'Гость'});assert.notEqual(next.selfId,guestId);const guests=f.state.multiplayer.tactical.actors.filter(a=>a.player&&a.id!=='host'&&a.online!==false);assert.equal(guests.length,1);assert.equal(guests[0].id,next.selfId);assert.equal(guests[0].x,3);assert.equal(guests[0].y,2);assert.ok(f.state.multiplayer.tactical.order.includes(next.selfId));
});


test('Finishing a partial keeps active WebSocket guests while rejecting new roster members',async t=>{
  let reply=0;const f=await fixture(t,()=>++reply===1?{text:'Страж начал речь ',eof:true}:{text:'и ответил героям.',reason:'stop'}),client=createMultiplayerClient({getState:()=>({personas:[persona]})}),newcomer=createMultiplayerClient({getState:()=>({personas:[persona]})});t.after(()=>{client.leave();newcomer.leave();});const status=f.room.status(),url='http://127.0.0.1:'+status.port+'/play?code='+status.code,joined=await client.join({url,personaId:'srp',name:'Первый гость'});await assert.rejects(f.room.generate());const before=f.state.multiplayer.tactical.actors.length;
  await assert.rejects(newcomer.join({url,personaId:'srp',name:'Новый гость'}),/Хост дописывает/);assert.equal(f.state.multiplayer.tactical.actors.length,before);assert.equal(f.room.status().room.narration.canContinue,true);await f.room.generate({continueMessageId:f.room.status().room.narration.messageId});assert.ok(f.state.multiplayer.tactical.actors.some(a=>a.id===joined.selfId));assert.ok(f.state.multiplayer.tactical.order.includes(joined.selfId));assert.equal(client.status().connected,true);
});

test('A new capitalized subject at a continuation seam gets a word boundary without modifying the saved prefix',()=>{
 const before='Страж кивает';const joiner=createNarrationContinuationJoiner(before);let text=before;for(const chunk of ['Р','ей осматривает дверь.'])text+=joiner.push(chunk);text+=joiner.flush();assert.equal(text,'Страж кивает Рей осматривает дверь.');assert.ok(text.startsWith(before));
 const word=createNarrationContinuationJoiner('Она открывает две');assert.equal('Она открывает две'+word.push('рь.')+word.flush(),'Она открывает дверь.');
});


test('Initiative alternates player and NPC segments without resetting the round; guest chat is gated by that order',async t=>{
 const f=await fixture(t,()=>({text:'Страж закончил свой ход.',reason:'stop'}),{npc:true}),client=createMultiplayerClient({getState:()=>({personas:[persona]})});t.after(()=>client.leave());const state=f.state;state.multiplayer.tactical.map={id:'test-map',width:5,height:5,tiles:Array(25).fill(0),start:[{x:0,y:0},{x:3,y:2}]};f.save(state);
 const status=f.room.status(),joined=await client.join({url:'http://127.0.0.1:'+status.port+'/play?code='+status.code,personaId:'srp',name:'Гость'}),guestId=joined.selfId;
 const s=f.state,g=s.multiplayer.tactical;g.actors.find(a=>a.id==='host').abilities.dexterity=14;g.actors.find(a=>a.id==='npc').abilities.dexterity=12;g.actors.find(a=>a.id===guestId).abilities.dexterity=8;beginInitiative(g);f.save(s);
 assert.deepEqual(g.order,['host','npc',guestId]);await assert.rejects(client.command('message',{content:'Рано!'}),/ход/);f.room.hostMessage('Мой первый ход.');f.room.act({action:'end'});assert.equal(f.state.multiplayer.tactical.phase,'gm');
 await f.room.generate();const middle=f.state.multiplayer.tactical;assert.equal(middle.round,1);assert.equal(middle.phase,'players');assert.equal(middle.order[middle.turn],guestId);assert.equal(middle.actors.find(a=>a.id==='host').actions,1);
 await client.command('message',{content:'Теперь мой ход.'});await client.command('game',{action:'end'});await f.room.generate();assert.equal(f.state.multiplayer.tactical.round,2);assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,1);assert.equal(f.state.multiplayer.tactical.order[0],'host');
});

test('Interrupted NPC segment resumes its prose without repeating NPC actions or skipping the next player',async t=>{
 let reply=0;const f=await fixture(t,()=>++reply===1?{text:'Страж начал ',eof:true}:{text:'и завершил ход.',reason:'stop'},{npc:true});const s=f.state,g=s.multiplayer.tactical;g.actors.find(a=>a.id==='npc').abilities.dexterity=14;g.actors.find(a=>a.id==='host').abilities.dexterity=8;beginInitiative(g);f.save(s);assert.equal(g.phase,'gm');await assert.rejects(f.room.generate());assert.equal(f.state.multiplayer.tactical.turn,1);assert.equal(f.state.multiplayer.tactical.round,1);const pending=f.room.status().room.narration;assert.equal(pending.canContinue,true);await f.room.generate({continueMessageId:pending.messageId});assert.equal(f.calls.filter(c=>c.messages[0].content.includes('You control only this NPC')).length,1);assert.equal(f.state.multiplayer.tactical.phase,'players');assert.equal(f.state.multiplayer.tactical.order[f.state.multiplayer.tactical.turn],'host');assert.equal(f.state.multiplayer.tactical.round,1);
});
