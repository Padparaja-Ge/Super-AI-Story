import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultAbilities,abilities} from '../shared/srp.mjs';
import {createAdventureGame,adventureActor,adventureAction,prepareActor,resetRound} from '../server/adventure-engine.mjs';
import {upsertChallenge,setActorCheckDifficulty,resolveD20Outcome,checkContext,validateDieResult} from '../server/ability-checks.mjs';

const persona={id:'sheet',kind:'srp',name:'Герой',className:'Воин',abilities:defaultAbilities()};
function table(mode='dnd',rules={}){const game=createAdventureGame(mode,rules);game.actors=[adventureActor('hero',persona,game.rules),{...adventureActor('merchant',{...persona,name:'Торговец'},game.rules),player:false}];game.order=['hero'];return game;}
const check=(g,r,roll)=>adventureAction(g,{action:'check',...r},'hero',{random:()=>roll});
const act=(g,r,random=()=>10)=>adventureAction(g,r,'hero',{host:true,random});

test('Every noncritical d20 result uses its actual modifier and DC, including equality',()=>{
 for(const dc of [7,15,25])for(const bonus of [-5,0,9])for(let roll=1;roll<=20;roll++){
  const result=resolveD20Outcome({roll,modifier:bonus,dc});
  assert.equal(result.total,roll+bonus);assert.equal(result.dc,dc);assert.equal(result.success,roll===20||roll!==1&&roll+bonus>=dc,`d20=${roll}, bonus=${bonus}, DC=${dc}`);
  assert.equal(result.critical,roll===1?'failure':roll===20?'success':null);
 }
 assert.equal(resolveD20Outcome({roll:15,dc:15}).success,true);
 assert.equal(resolveD20Outcome({roll:7,dc:15}).critical,null);
});
test('Critical d20 outcomes override bonuses, but never override an impossible object',()=>{
 assert.equal(resolveD20Outcome({roll:1,modifier:50,dc:7}).outcome,'failure');
 assert.equal(resolveD20Outcome({roll:20,modifier:-50,dc:100}).outcome,'success');
 const result=resolveD20Outcome({roll:20,modifier:50,dc:7,impossible:true,impossibleReason:'Сдвинуть гору нельзя силой смертного.'});
 assert.equal(result.outcome,'impossible');assert.equal(result.success,false);assert.equal(result.critical,null);assert.equal(result.naturalCritical,'success');assert.match(result.reason,/гору/);
 for(const roll of [1,6])assert.equal(resolveD20Outcome({roll,sides:6,dc:3}).critical,null);
});
test('Difficulty lives on an NPC and survives saving; weak and strong merchants produce different outcomes',()=>{
 const game=table(),npc=game.actors[1];
 setActorCheckDifficulty(npc,'persuasion',{dc:15});
 const request={ability:'charisma',checkType:'persuasion',targetId:npc.id,intent:'Прошу снизить цену на меч.'};
 const failure=check(game,request,7).calculation;assert.equal(failure.outcome,'failure');assert.equal(failure.dc,15);assert.equal(failure.unbound,false);assert.equal(failure.targetId,npc.id);assert.match(failure.intent,/снизить/);
 assert.equal(check(game,request,15).calculation.outcome,'success');
 setActorCheckDifficulty(npc,'persuasion',{dc:7});assert.equal(check(game,request,7).calculation.outcome,'success');
 const restored=JSON.parse(JSON.stringify(game));assert.equal(check(restored,request,7).calculation.dc,7);assert.equal(checkContext(restored).difficulties[0].checkDifficulties.persuasion.dc,7);
});
test('Environmental tasks use all six abilities, not just social checks against NPCs',()=>{
 for(const ability of abilities){const game=table(),challenge=upsertChallenge(game,{name:'Препятствие '+ability,ability,dc:15,intent:ability==='strength'?'Сдвигаю валун с дороги.':'Проверяю препятствие.',actionId:'action-'+ability,messageId:'post-'+ability});
  const event=check(game,{challengeId:challenge.id,ability},15),c=event.calculation;
  assert.equal(c.success,true);assert.equal(c.challengeId,challenge.id);assert.equal(c.actionId,'action-'+ability);assert.equal(c.messageId,'post-'+ability);assert.equal(c.eventId,event.id);assert.ok(c.id);assert.equal(challenge.lastResultId,event.id);
 }
 const game=table(),mountain=upsertChallenge(game,{name:'Гора',ability:'strength',dc:30,impossible:true,impossibleReason:'Гора — часть материка; это не подвижный валун.'});
 assert.equal(check(game,{challengeId:mountain.id},20).calculation.outcome,'impossible');
});
test('Host controls task difficulty; players cannot replace DC, the target, the ability, or the roll',()=>{
 const game=table();assert.throws(()=>adventureAction(game,{action:'setChallenge',challenge:{name:'Цена',ability:'charisma',dc:1}},'hero'),/хосту/);
 assert.throws(()=>adventureAction(game,{action:'setCheckDifficulty',targetId:'merchant',checkType:'persuasion',difficulty:{dc:1}},'hero'),/хосту/);
 const task=act(game,{action:'setChallenge',challenge:{name:'Запугать торговца',checkType:'intimidation',dc:15,targetId:'merchant',actorId:'hero',actionId:'turn-1'}});
 for(const forged of [{dc:0},{impossible:false},{roll:20},{total:100},{critical:'success'},{modifier:99}])assert.throws(()=>check(game,{challengeId:task.id,...forged},2),/движок/);
 assert.throws(()=>check(game,{challengeId:task.id,ability:'strength'},19),/характеристика/i);
 assert.throws(()=>check(game,{challengeId:task.id,targetId:'hero'},19),/Цель/);
 assert.throws(()=>check(game,{challengeId:task.id,actionId:'another'},19),/другому действию/);
 assert.equal(check(game,{challengeId:task.id},2).calculation.success,false);
 assert.throws(()=>check(game,{challengeId:task.id},20),/уже выполнена/);
 assert.throws(()=>upsertChallenge(game,{name:'Нечто',checkType:'madeUp',dc:1}),/тип/);
 assert.throws(()=>upsertChallenge(game,{name:'Гора',ability:'strength',dc:30,impossible:true}),/причину/);
});
test('Old saves and unbound checks remain usable but never claim to resolve another action',()=>{
 const game=table();delete game.challenges;delete game.actors[0].checkDifficulties;prepareActor(game.actors[0],game.rules);
 const event=check(game,{ability:'wisdom'},7);assert.equal(event.calculation.unbound,true);assert.equal(event.calculation.dc,10);assert.equal(event.calculation.success,false);assert.match(event.text,/не определяет исход другого действия/);
 const custom=table('custom',{checkDc:17,checkDie:6});assert.equal(check(custom,{ability:'strength'},6).calculation.success,false);assert.equal(check(custom,{ability:'strength'},1).calculation.critical,null);
});
test('Task IDs deduplicate default attempts across host edits, split archives and save restoration',()=>{
 const game=table(),task=upsertChallenge(game,{name:'Торг',checkType:'persuasion',dc:15,targetId:'merchant',messageId:'player-post'});assert.ok(task.actionId);
 check(game,{challengeId:task.id},7);const actionId=task.actionId;
 upsertChallenge(game,{id:task.id,dc:7});assert.equal(task.actionId,actionId);assert.throws(()=>check(game,{challengeId:task.id},20),/уже выполнена/);
 game.eventArchive=[];assert.throws(()=>check(game,{challengeId:task.id},20),/уже выполнена/);
 assert.throws(()=>check(game,{challengeId:task.id,messageId:'unrelated-post'},20),/другому сообщению/);
 const restored=JSON.parse(JSON.stringify(game));assert.throws(()=>check(restored,{challengeId:task.id},20),/уже выполнена/);
 restored.log=[];restored.eventArchive=[];assert.throws(()=>check(restored,{challengeId:task.id},20),/уже выполнена/);assert.equal(restored.challenges[0].results.hero.calculation.roll,7);
 upsertChallenge(game,{id:task.id,actionId:'explicit-new-attempt',messageId:'another-player-post'});assert.equal(check(game,{challengeId:task.id},15).calculation.success,true);
});
test('Natural 1 always misses, 20 hits despite low stats, and critical does not multiply damage dice',()=>{
 const game=table(),actor=game.actors[0],target=game.actors[1];actor.abilities.strength=100;let calls=[];
 act(game,{action:'skill',skillId:'sword',targetId:target.id},s=>{calls.push(s);return 1;});assert.deepEqual(calls,[20]);assert.equal(target.hp,40);assert.equal(game.log.at(-1).calculation.critical,'failure');assert.equal(actor.hp,40);
 resetRound(game,()=>10);actor.abilities.strength=0;game.rules.armorCap=100;target.baseArmor=100;calls=[];
 act(game,{action:'skill',skillId:'sword',targetId:target.id},s=>{calls.push(s);return s===20?20:2;});assert.deepEqual(calls,[20,8]);assert.equal(target.hp,38);
 const hit=game.log.findLast(e=>e.calculation?.kind==='attack').calculation;assert.equal(hit.critical,'success');assert.equal(hit.dc,100);assert.equal(hit.hit,true);assert.equal(game.log.at(-1).calculation.kind,'damage');assert.equal(game.log.at(-1).calculation.critical,undefined);
});
test('A protected target cannot be killed with an ordinary weapon by rolling 20',()=>{
 const game=table(),target=game.actors[1];setActorCheckDifficulty(target,'attack',{dc:10,impossible:true,impossibleReason:'Божество неуязвимо для обычного оружия.'});
 const calls=[];act(game,{action:'skill',skillId:'sword',targetId:target.id},s=>{calls.push(s);return s===20?20:8;});assert.deepEqual(calls,[20]);assert.equal(target.hp,40);assert.equal(game.log.at(-1).calculation.outcome,'impossible');assert.equal(game.log.at(-1).calculation.hit,false);
});
test('Grapple and escape honour DC and d20 critical results instead of comparing only positive modifiers',()=>{
 const game=table(),actor=game.actors[0],target=game.actors[1];actor.abilities.strength=100;
 act(game,{action:'skill',skillId:'grapple',targetId:target.id},()=>1);assert.equal(target.grappledBy,'');assert.equal(game.log.at(-1).calculation.critical,'failure');
 resetRound(game,()=>10);actor.abilities.strength=0;target.abilities.constitution=100;act(game,{action:'skill',skillId:'grapple',targetId:target.id},()=>20);assert.equal(target.grappledBy,actor.id);
 resetRound(game,()=>10);actor.grappledBy=target.id;actor.abilities.strength=100;act(game,{action:'escape'},()=>1);assert.equal(actor.grappledBy,target.id);assert.equal(game.log.at(-1).calculation.critical,'failure');
 resetRound(game,()=>10);actor.grappledBy=target.id;actor.abilities.strength=0;target.abilities.strength=100;act(game,{action:'escape'},()=>20);assert.equal(actor.grappledBy,'');assert.equal(game.log.at(-1).calculation.critical,'success');
});
test('Only the selected d20 determines critical status, and protected grapples do not change resources',()=>{
 const game=table(),actor=game.actors[0],target=game.actors[1];actor.grappledBy=target.id;
 const rolls=[20,2];const event=adventureAction(game,{action:'check',ability:'charisma'},actor.id,{random:()=>rolls.shift()});assert.equal(event.calculation.roll,2);assert.equal(event.calculation.critical,null);assert.equal(event.calculation.success,false);
 actor.grappledBy='';setActorCheckDifficulty(target,'grapple',{dc:10,impossible:true,impossibleReason:'Бесплотное существо невозможно удержать руками.'});
 act(game,{action:'skill',skillId:'grapple',targetId:target.id},()=>20);assert.equal(target.grappledBy,'');assert.equal(game.log.at(-1).calculation.outcome,'impossible');assert.equal(target.hp,40);
});
test('An already sustained beam cannot bypass newly established absolute protection',()=>{
 const game=table(),actor=game.actors[0],target=game.actors[1];actor.spells=[{id:'beam',name:'Луч',kind:'magic',reach:'ranged',grade:'attack',delivery:'beam',range:12,damage:'1d6',slotCost:1}];
 act(game,{action:'skill',skillId:'beam',targetId:target.id},s=>s===20?20:2);assert.ok(actor.beam);const hp=target.hp;
 resetRound(game,()=>10);setActorCheckDifficulty(target,'attack',{dc:10,impossible:true,impossibleReason:'Между существом и лучом возникла абсолютная защита.'});
 act(game,{action:'channel'},()=>{throw new Error('Запрещённый урон не должен бросаться.');});assert.equal(target.hp,hp);assert.equal(actor.beam,null);assert.equal(game.log.at(-1).calculation.outcome,'impossible');assert.equal(game.log.at(-1).calculation.roll,undefined);
});
test('Zero, out-of-range and fractional dice are rejected across checks, attack, grapple and escape',()=>{
 for(const bad of [0,-1,21,1.5,NaN]){
  assert.throws(()=>validateDieResult(bad,20),/бросок/);
  for(const action of [{action:'check',ability:'charisma'},{action:'skill',skillId:'sword',targetId:'merchant'},{action:'skill',skillId:'grapple',targetId:'merchant'},{action:'escape'}]){
   const game=table();if(action.action==='escape')game.actors[0].grappledBy='merchant';
   assert.throws(()=>act(game,action,()=>bad),/бросок/);assert.equal(game.actors[0].actions,1);assert.equal(game.actors[1].hp,40);
  }
 }
});
test('Legacy checkId uses the same trusted DC, critical rules and structured journal as every other check',()=>{
 const game=table();setActorCheckDifficulty(game.actors[1],'persuasion',{dc:15});const request={action:'check',checkId:'persuasion',targetId:'merchant'};
 assert.throws(()=>adventureAction(game,{...request,dc:1},'hero',{random:()=>20}),/движок/);assert.equal(game.log.length,0);
 game.actors[0].abilities.charisma=100;const fail=adventureAction(game,request,'hero',{random:()=>1}).calculation;assert.equal(fail.dc,15);assert.equal(fail.critical,'failure');assert.equal(fail.outcome,'failure');assert.equal(fail.kind,'check');assert.equal(fail.checkType,'persuasion');assert.equal(fail.attribute,'charisma');assert.ok(fail.eventId);
 game.actors[0].abilities.charisma=0;const success=adventureAction(game,request,'hero',{random:()=>20}).calculation;assert.equal(success.dc,15);assert.equal(success.critical,'success');assert.equal(success.outcome,'success');
 const ordinary=adventureAction(game,request,'hero',{random:()=>19}).calculation;assert.equal(ordinary.total,14);assert.equal(ordinary.outcome,'failure');assert.equal(ordinary.critical,null);
});
test('A thousand resolved campaign tasks retain NPC DCs and cannot exhaust the active task limit',()=>{
 let game=table();game.actors.push({...structuredClone(game.actors[1]),id:'merchant-2',name:'Второй торговец'},{...structuredClone(game.actors[1]),id:'merchant-3',name:'Третий торговец'});
 const targets=['merchant','merchant-2','merchant-3'];targets.forEach((id,i)=>setActorCheckDifficulty(game.actors.find(a=>a.id===id),'persuasion',{dc:[7,15,19][i]}));
 let firstId,lastId;
 for(let i=0;i<1000;i++){
  const targetId=targets[i%3],dc=game.actors.find(a=>a.id===targetId).checkDifficulties.persuasion.dc;
  const task=upsertChallenge(game,{id:'campaign-check-'+i,name:'Торг '+i,actorId:'hero',targetId,checkType:'persuasion',dc,messageId:'post-'+i});firstId||=task.id;lastId=task.id;
  const result=check(game,{challengeId:task.id},15);assert.equal(result.calculation.dc,dc);assert.equal(result.calculation.success,15>=dc);
  assert.ok(game.challenges.length<=300);if(i%100===99)game=JSON.parse(JSON.stringify(game));
 }
 assert.equal(game.challenges.length,300);assert.equal(game.challengeArchive.length,700);assert.equal(game.challenges.filter(c=>c.active!==false).length,1);
 const first=game.challengeArchive.find(c=>c.id===firstId);assert.equal(first.results.hero.calculation.roll,15);assert.equal(first.active,false);
 assert.throws(()=>check(game,{challengeId:firstId},20),/не найдено или закрыто/);assert.throws(()=>upsertChallenge(game,{id:firstId,name:'Повтор',actorId:'hero',ability:'charisma',dc:1,active:true}),/архив/);
 assert.throws(()=>check(game,{challengeId:lastId},20),/уже выполнена/);assert.deepEqual(targets.map(id=>game.actors.find(a=>a.id===id).checkDifficulties.persuasion.dc),[7,15,19]);
});
test('Compaction never drops unresolved checks and the 300-task limit counts pending checks only',()=>{
 const game=table();for(let i=0;i<300;i++)upsertChallenge(game,{id:'pending-'+i,name:'Нерешённое '+i,actorId:'hero',ability:'wisdom',dc:10});
 assert.throws(()=>upsertChallenge(game,{name:'Лишнее нерешённое',actorId:'hero',ability:'wisdom',dc:10}),/нерешённых активных/);assert.equal(game.challenges.length,300);
 upsertChallenge(game,{id:'pending-0',active:false});const next=upsertChallenge(game,{id:'next',name:'Новое',actorId:'hero',ability:'wisdom',dc:10});assert.equal(next.active,true);assert.equal(game.challenges.length,300);assert.equal(game.challengeArchive[0].id,'pending-0');for(let i=1;i<300;i++)assert.ok(game.challenges.some(c=>c.id==='pending-'+i));
});
test('Challenge archive stays bounded and an explicit new action resets only the previous attempt marker',()=>{
 const game=table();game.challengeArchive=Array.from({length:2000},(_,i)=>({id:'archived-'+i,active:false}));
 for(let i=0;i<300;i++)upsertChallenge(game,{id:'closed-'+i,name:'Закрытое '+i,actorId:'hero',ability:'strength',dc:10,active:false});
 const live=upsertChallenge(game,{id:'live',name:'Текущая',actorId:'hero',ability:'strength',dc:10});assert.equal(game.challengeArchive.length,2000);assert.equal(game.challengeArchive.at(-1).id,'closed-0');assert.equal(game.challenges.length,300);
 check(game,{challengeId:live.id},7);const oldActionId=live.actionId;upsertChallenge(game,{id:live.id,actionId:'explicit-next-attempt'});assert.notEqual(live.actionId,oldActionId);assert.equal(live.lastResultId,undefined);assert.equal(live.results.hero.calculation.roll,7);assert.equal(check(game,{challengeId:live.id},15).calculation.success,true);
});
