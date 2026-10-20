import test from 'node:test';
import assert from 'node:assert/strict';
import {initiativeOf,normalizeItem} from '../shared/equipment.mjs';
import {beginInitiative,advanceInitiative,syncInitiative} from '../server/initiative.mjs';
import {createAdventureGame,adventureActor,adventureAction} from '../server/adventure-engine.mjs';
import {generateMap,populateMap} from '../server/battlemap.mjs';
const item=(id,extra)=>normalizeItem({id,name:id,equipped:true,...extra});
const actor=(id,dex,player=true)=>({id,name:id,player,hp:40,abilities:{dexterity:dex},inventory:[]});
test('Initiative counts each equipped armor slot and weapon, preserves halves and negatives',()=>{
 const a=actor('p',14);a.inventory=['head','chest','legs'].map(slot=>item(slot,{armor:{kind:'medium',slot}}));a.inventory.push(item('axe',{weapon:{damage:'1d12',hands:'two',weight:'heavy'}}));assert.equal(initiativeOf(a).value,-.5);a.inventory.forEach(i=>i.equipped=false);assert.equal(initiativeOf(a).value,2);a.inventory[0].equipped=true;a.inventory[0].quantity=0;assert.equal(initiativeOf(a).value,2);a.inventory=[item('light',{armor:{kind:'light',slot:'chest'}})];assert.equal(initiativeOf(a).value,2);
});
test('Weapon weight migrates to light, rejects unknown weight and includes equipped buffs',()=>{assert.equal(item('old',{weapon:{}}).weapon.weight,'light');assert.throws(()=>item('bad',{weapon:{weight:'bad'}}));const a=actor('p',12);a.inventory=[item('staff',{weapon:{weight:'medium'},buffs:{dexterity:4}})];assert.equal(initiativeOf(a).value,2.5);});
test('Players and NPC are interleaved globally; ties are resolved only on reaching their group once',()=>{
 const g=createAdventureGame('dnd');g.inCombat=true;g.actors=[actor('slow',8),actor('npc',14,false),actor('p1',10),actor('p2',10)];let calls=0;const random=()=>[5,19][calls++];beginInitiative(g,random);assert.deepEqual(g.order,['npc','p1','p2','slow']);assert.equal(calls,0);advanceInitiative(g,random);assert.deepEqual(g.order,['npc','p2','p1','slow']);assert.equal(g.phase,'players');assert.equal(calls,2);syncInitiative(g,random);assert.equal(calls,2);advanceInitiative(g,random);advanceInitiative(g,random);assert.equal(g.order[g.turn],'slow');advanceInitiative(g,random);assert.equal(g.phase,'gm');
});
test('Equal dice reroll only unresolved actors with bounded stable final tie resolution',()=>{const g=createAdventureGame('dnd');g.actors=[actor('b',10),actor('a',10)];let calls=0;beginInitiative(g,()=>{calls++;return 10;});assert.equal(calls,20);assert.deepEqual(g.order,['a','b']);assert.equal(g.log.filter(e=>e.calculation?.kind==='initiative-tie').length,20);});
test('Equipment changes do not grant a second turn; dead and disconnected participants are skipped',()=>{const g=createAdventureGame('dnd');g.inCombat=true;g.actors=[actor('fast',16),actor('middle',12),actor('slow',8)];beginInitiative(g);g.actors[0].inventory=[item('axe',{weapon:{weight:'heavy'}})];g.actors[1].online=false;advanceInitiative(g);assert.equal(g.order[g.turn],'slow');assert.equal(g.initiativeScores.fast.value,3);g.actors.push(actor('late',20));syncInitiative(g);assert.ok(!g.order.includes('late'));});
test('Host cannot act for a slower NPC out of initiative order',()=>{const g=createAdventureGame('dnd');g.inCombat=true;g.actors=[actor('fastnpc',14,false),actor('slownpc',8,false),actor('host',10)];beginInitiative(g);assert.throws(()=>adventureAction(g,{action:'check',actorId:'slownpc',ability:'dexterity'},'host',{host:true}),/NPC/);});

test('Generated NPC have distinct initiative, and host can configure their equipment between combats',()=>{
 const g=createAdventureGame('dnd'),descriptor={title:'Двор',rooms:['Двор'],environment:'outdoor',entrySide:'south',npcs:[{name:'Лучник',archetype:'archer',hp:30,armor:10},{name:'Воин',archetype:'warrior',hp:40,armor:10}]};g.map=generateMap({descriptor,seed:17});populateMap(g,descriptor);const [archer,warrior]=g.actors;
 assert.equal(initiativeOf(archer).value,2);assert.equal(initiativeOf(warrior).value,0);
 assert.throws(()=>adventureAction(g,{action:'inventory',actorId:archer.id,inventory:[]},'guest'),/своим/);
 adventureAction(g,{action:'inventory',actorId:archer.id,inventory:[item('bow',{weapon:{reach:'ranged',damage:'1d12',weight:'heavy',ammoTag:'arrows'}})]},'host',{host:true});assert.equal(initiativeOf(archer).value,1);g.inCombat=true;beginInitiative(g,()=>10);assert.equal(g.order[0],archer.id);assert.throws(()=>adventureAction(g,{action:'inventory',actorId:archer.id,inventory:[]},'host',{host:true}),/между боями/);
});
