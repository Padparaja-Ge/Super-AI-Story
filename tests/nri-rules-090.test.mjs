import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdventureGame,adventureActor,adventureAction,visible,pathDistance,resetRound} from '../server/adventure-engine.mjs';
import {normalizeAdventureRules,adventureRuleFields} from '../shared/adventure-rules.mjs';
import {normalizeRoomModels,roomEmbeddingState,roomModelState} from '../server/room-models.mjs';
import {getConnection} from '../server/llm.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {normalizeItem} from '../shared/equipment.mjs';
const persona={id:'sheet',name:'Рей',kind:'srp',className:'Воин',abilities:defaultAbilities()};
function table(rules={}){const g=createAdventureGame('custom',rules);g.map={width:12,height:12,tiles:Array(144).fill(0),doors:[],start:[]};g.actors=[adventureActor('host',persona,g.rules),adventureActor('npc',{...persona,id:'enemy',name:'NPC'},g.rules)];g.actors[1].player=false;Object.assign(g.actors[0],{x:2,y:2});Object.assign(g.actors[1],{x:3,y:2});g.order=['host','npc'];g.turn=0;g.phase='players';g.inCombat=true;return g;}
const act=(g,r,random=s=>s)=>adventureAction(g,r,'host',{host:true,random});
test('NRI has one validated catalog for every engine setting; D&D keeps fixed mechanics',()=>{
 assert.equal(new Set(adventureRuleFields.map(f=>f.key)).size,adventureRuleFields.length);assert.ok(adventureRuleFields.length>=25);
 for(const f of adventureRuleFields){assert.throws(()=>normalizeAdventureRules('custom',{[f.key]:f.type==='boolean'?'yes':f.max+1}));}
 const dnd=normalizeAdventureRules('dnd',{attackDie:6,slowActions:3,physicalAccuracy:10,fastActions:4});assert.equal(dnd.attackDie,20);assert.equal(dnd.slowActions,1);assert.equal(dnd.physicalAccuracy,2);assert.equal(dnd.fastActions,4);
 assert.throws(()=>normalizeAdventureRules('custom',{armor:30,armorCap:19}));
});
test('Custom hit die, accuracy and multiple slow actions calculate damage without global model/rule changes',()=>{
 const g=table({attackDie:6,physicalAccuracy:5,slowActions:2,armor:8}),rolls=[];const random=s=>{rolls.push(s);return s===6?3:2;};
 act(g,{action:'skill',skillId:'unarmed',targetId:'npc'},random);assert.equal(g.actors[1].hp,38);assert.equal(g.actors[0].actions,1);assert.deepEqual(rolls,[6,4]);assert.match(g.log.find(e=>e.calculation?.kind==='attack').text,/1д6/);
 act(g,{action:'skill',skillId:'unarmed',targetId:'npc'},random);assert.equal(g.actors[0].actions,0);const before=g.actors[1].hp;assert.throws(()=>act(g,{action:'skill',skillId:'unarmed',targetId:'npc'}),/Медленное/);assert.equal(g.actors[1].hp,before);
});
test('Movement/equipment costs, diagonal movement, rest and per-level resources use their configured values',()=>{
 const g=table({fastActions:3,equipFastCost:2,movementFastCost:0,diagonalMovement:true,restHp:true,restSlots:false,hpPerLevel:5,slotsPerLevel:1});const a=g.actors[0];g.actors[1].x=9;
 a.inventory=[normalizeItem({id:'hat',name:'Шлем',armor:{kind:'light',slot:'head'},equipped:false})];
 assert.equal(pathDistance(g,a,3,3),1);act(g,{action:'move',x:3,y:3});assert.equal(a.fastActions,3);act(g,{action:'equip',itemId:'hat',equipped:true});assert.equal(a.fastActions,1);assert.throws(()=>act(g,{action:'equip',itemId:'hat',equipped:false}));assert.equal(a.inventory[0].equipped,true);
 g.map.tiles[3*12+4]=1;assert.equal(pathDistance(g,a,4,4),2);g.inCombat=false;a.hp=2;a.slots=0;act(g,{action:'rest'});assert.equal(a.hp,a.maxHp);assert.equal(a.slots,0);a.level=3;act(g,{action:'check',ability:'wisdom'});assert.equal(a.maxHp,50);assert.equal(a.maxSlots,8);
});
test('Solid walls and corners block sight; projectiles cannot bypass walls unless the NRI host explicitly enables it',()=>{
 const g=table(),a=g.actors[0],b=g.actors[1];b.x=4;g.map.tiles[2*12+3]=1;assert.equal(visible(g.map,a,b),false);
 a.spells=[{id:'orb',name:'Снаряд',kind:'magic',grade:'attack',reach:'ranged',delivery:'projectile',range:10,damage:'1d4',slotCost:1}];
 assert.throws(()=>act(g,{action:'skill',skillId:'orb',targetId:'npc'}),/стеной/);assert.equal(a.actions,1);assert.equal(a.slots,6);
 g.rules.projectilesIgnoreWalls=true;act(g,{action:'skill',skillId:'orb',targetId:'npc'});assert.equal(a.slots,5);
 const corner={...g.map,tiles:Array(144).fill(0)};corner.tiles[2*12+3]=1;assert.equal(visible(corner,{x:2,y:2},{x:3,y:3}),false);
});
test('Room task models are validated and embedding selection never mutates another story settings',()=>{
 const state={connections:[{id:'gm'},{id:'embed'}],settings:{embeddings:{connectionId:'gm',model:'original'}}};
 const models=normalizeRoomModels(state,{npcConnectionId:'gm',embeddingConnectionId:'embed',embeddingModel:'bge',maxTokens:1500,temperature:.4});assert.equal(models.embeddingModel,'bge');assert.throws(()=>normalizeRoomModels(state,{npcConnectionId:'missing'}));assert.throws(()=>normalizeRoomModels(state,{maxTokens:0}));
 const scoped=roomEmbeddingState(state,{memorySettings:models});assert.equal(scoped.settings.embeddings.connectionId,'embed');assert.equal(state.settings.embeddings.connectionId,'gm');assert.equal(state.settings.embeddings.model,'original');
});
test('Room temperature and output overrides apply to llama.cpp sampling without changing the global local model',()=>{
 const state={connections:[{id:'sas-local',model:'GGUF',baseUrl:'http://127.0.0.1:8000/v1',maxTokens:1024,temperature:.8}],settings:{localSampling:{maxTokens:400,temperature:.6,topK:40}}};
 const room={connectionId:'sas-local',aiSettings:{maxTokens:700,temperature:.3}},scoped=roomModelState(state,room),connection=getConnection(scoped,room);
 assert.equal(connection.maxTokens,700);assert.equal(connection.temperature,.3);assert.equal(connection.sampling.topK,40);assert.equal(state.settings.localSampling.maxTokens,400);assert.equal(state.connections[0].maxTokens,1024);
});
