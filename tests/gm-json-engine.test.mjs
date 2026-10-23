import test from 'node:test';
import assert from 'node:assert/strict';
import {createGMJsonEngine} from '../server/gm-json-engine.mjs';
import {parseLLMResponse,executeAction} from '../server/rag/response.mjs';
import {createAdventureGame,adventureActor} from '../server/adventure-engine.mjs';
import {upsertChallenge} from '../server/ability-checks.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {publicNarration} from '../server/room-narration.mjs';
const persona={id:'sheet',name:'Страж',kind:'srp',className:'Воин',abilities:defaultAbilities()};
function fixture(){let state={multiplayer:{id:'room',mode:'dnd',scene:{notes:'Старое'},tactical:createAdventureGame('dnd')}};const game=state.multiplayer.tactical;game.actors=[{...adventureActor('npc',persona,game.rules),player:false},adventureActor('host',{...persona,name:'Герой'},game.rules)];game.phase='gm';game.order=['npc'];const task=upsertChallenge(game,{id:'task',name:'Осмотреть зал',actorId:'npc',ability:'wisdom',dc:15});let saves=0;
 const opts={getState:()=>structuredClone(state),saveState:value=>{saves++;state=structuredClone(value);},roomId:'room',requestId:'server-operation',context:{round:1,phase:'gm',turn:0,actorId:'npc',allowedChallengeIds:[task.id],allowSceneUpdates:true}};
 return {opts,get state(){return state;},set(value){state=structuredClone(value);},get saves(){return saves;}};
}
const response=(action_required,action_params)=>parseLLMResponse(JSON.stringify({thinking:'PRIVATE',action_required,action_params,narrative_text:'Страж ждёт.'}));
test('A server-authorized NPC challenge rolls through the existing engine once and duplicates reuse its event',()=>{const f=fixture(),engine=createGMJsonEngine(f.opts),parsed=response('roll_dice',{formula:'1d20',target:'task'}),first=executeAction(parsed,engine),again=executeAction(parsed,engine);assert.equal(first.success,true);assert.ok(first.result.eventId);assert.ok(first.result.calculation.roll>=1&&first.result.calculation.roll<=20);assert.equal(first.result.calculation.dc,15);assert.deepEqual(again.result,first.result);assert.equal(f.saves,1);assert.equal(f.state.multiplayer.tactical.log.filter(e=>e.calculation?.kind==='check').length,1);assert.doesNotMatch(JSON.stringify(f.state),/PRIVATE|thinking/);});
test('Player checks, ungranted or resolved tasks and repeated NPC turns are never bypassed with host privileges',()=>{
 for(const alter of [f=>{f.opts.context.allowedChallengeIds=[];},f=>{const s=f.state;s.multiplayer.tactical.challenges[0].actorId='host';f.set(s);},f=>{const s=f.state;s.multiplayer.tactical.challenges[0].lastResultId='done';f.set(s);},f=>{const s=f.state;s.multiplayer.tactical.gmProcessed=['npc'];f.set(s);}]){const f=fixture();alter(f);const done=executeAction(response('roll_dice',{formula:'1d20',target:'task'}),createGMJsonEngine(f.opts));assert.equal(done.success,false);assert.equal(f.saves,0);assert.equal(f.state.multiplayer.tactical.log.length,0);}
});
test('Arbitrary HP, inventory, initiative and field-path edits are rejected; explicitly permitted scene text can change',()=>{
 for(const field of ['hp','inventory','turn','location','actors.0.hp','__proto__']){const f=fixture(),done=executeAction(response('update_state',{field,value:'999'}),createGMJsonEngine(f.opts));assert.equal(done.success,false);assert.equal(f.saves,0);assert.equal(f.state.multiplayer.tactical.actors[0].hp,40);}
 const f=fixture(),engine=createGMJsonEngine({...f.opts,validateSceneUpdate:({field,value})=>field==='notes'&&value==='Туман.'}),parsed=response('update_state',{field:'notes',value:'Туман.'});assert.equal(executeAction(parsed,engine).success,true);assert.equal(f.state.multiplayer.scene.notes,'Туман.');assert.equal(f.state.multiplayer.tactical.actors[0].hp,40);assert.equal(executeAction(parsed,engine).success,true);assert.equal(f.saves,1);
});
test('Scene validation refusal, stale scene/turn/phase/room and changed duplicate parameters do not mutate state',()=>{
 const f=fixture(),engine=createGMJsonEngine({...f.opts,validateSceneUpdate:()=>false});assert.equal(executeAction(response('update_state',{field:'notes',value:'Нельзя'}),engine).success,false);assert.equal(f.saves,0);
 for(const alter of [room=>{room.scene.notes='Обновлено другим процессом';},room=>{room.tactical.turn=1;},room=>{room.tactical.phase='players';},room=>{room.id='other';}]){const g=fixture(),before=createGMJsonEngine(g.opts),s=g.state;alter(s.multiplayer);g.set(s);assert.equal(executeAction(response('update_state',{field:'notes',value:'Туман'}),before).success,false);assert.equal(g.saves,0);}
 const g=fixture(),once=createGMJsonEngine(g.opts);assert.equal(executeAction(response('update_state',{field:'notes',value:'Первое'}),once).success,true);assert.equal(executeAction(response('update_state',{field:'notes',value:'Второе'}),once).success,false);assert.equal(g.state.multiplayer.scene.notes,'Первое');assert.equal(g.saves,1);
});
test('Formula bonuses and damage dice cannot replace the check die; client-shaped extra params are rejected even on direct calls',()=>{for(const params of [{formula:'2d20',target:'task'},{formula:'1d20+99',target:'task'},{formula:'1d8',target:'task'},{formula:'1d20',target:'task',roll:20}]){const f=fixture(),engine=createGMJsonEngine(f.opts);assert.throws(()=>engine.rollDice(params));assert.equal(f.saves,0);}});
test('An action and its safe continuation source commit together even before a public message exists',()=>{
 const f=fixture(),state=f.state;state.multiplayer.messages=[];state.multiplayer.narration={messageId:'narrative',status:'writing',structuredNarration:true,promptMessages:[{role:'system',content:'Original prompt'}]};f.set(state);
 const done=executeAction(response('update_state',{field:'notes',value:'Туман.'}),createGMJsonEngine({...f.opts,requestId:'narrative:json:0'}));
 assert.equal(done.success,true);assert.equal(f.saves,1);assert.equal(f.state.multiplayer.messages.length,0);
 assert.equal(f.state.multiplayer.narration.structuredActionRecorded,true);
 assert.match(JSON.stringify(f.state.multiplayer.narration.promptMessages),/SAS_ENGINE_ACTION_RESULT/);
 assert.doesNotMatch(JSON.stringify(f.state),/PRIVATE|thinking/);
 assert.equal(publicNarration(f.state.multiplayer,f.state).canContinue,true);
});
