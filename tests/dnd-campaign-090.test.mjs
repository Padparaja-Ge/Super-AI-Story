import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAdventureGame,adventureActor,adventureAction,resetRound,visible,reachableCells,prepareActor} from '../server/adventure-engine.mjs';
import {beginInitiative,advanceInitiative,syncInitiative} from '../server/initiative.mjs';
import {generateMap,populateMap,mapPNG} from '../server/battlemap.mjs';
import {normalizeItem} from '../shared/equipment.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {roomChat,sourceDocuments} from '../server/room-memory.mjs';
const persona=i=>({id:'sheet-'+i,name:['Рей','Мира','Торк'][i],kind:'srp',className:'Путешественник',abilities:{...defaultAbilities(),dexterity:10+i,constitution:10-i}});
const resources=a=>JSON.stringify({hp:a.hp,slots:a.slots,actions:a.actions,fastActions:a.fastActions,move:a.move,inventory:a.inventory.map(i=>({id:i.id,quantity:i.quantity,equipped:i.equipped}))});
function supply(a){a.inventory=[normalizeItem({id:'blade',name:'Меч',equipped:true,weapon:{reach:'melee',damage:'1d4',damageType:'slashing',range:1,hands:'one'}}),normalizeItem({id:'bow',name:'Лук',weapon:{reach:'ranged',damage:'1d4',damageType:'piercing',range:24,hands:'two',ammoTag:'arrows'}}),normalizeItem({id:'arrows',name:'Стрелы',ammoTag:'arrows',quantity:100})];a.spells=[];a.hp=a.maxHp;a.slots=a.maxSlots;}
test('1200 sequential engine rounds, 3 players, 60 generated battle maps: ownership, attacks, rejects, saves and historical calculations stay correct',{timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-campaign-090-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let game=createAdventureGame('dnd');game.actors=[0,1,2].map(i=>adventureActor('player-'+i,persona(i),game.rules));let seed=19,calls=0,hits=0,misses=0,rejected=0,turns=0,rounds=0;
 const random=sides=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%sides+1;};
 for(let encounter=0;encounter<60;encounter++){
  const descriptor={title:'Стол '+encounter,environment:encounter%2?'outdoor':'interior',entrySide:['south','north','east','west'][encounter%4],rooms:['Вход','Зал','Архив'],npcs:[{name:'Страж',archetype:'warrior',hp:500,armor:10},{name:'Лучник',archetype:'archer',hp:500,armor:12}],visualPrompt:encounter%2?'open field, grass, rocks':'stone hall, stone floor'};
  game.inCombat=false;game.map=generateMap({width:24,height:24,descriptor,seed:encounter+173});populateMap(game,descriptor);
  assert.equal(game.actors.filter(a=>a.player).length,3);assert.equal(new Set(game.actors.map(a=>a.x+','+a.y)).size,game.actors.length);
  for(const a of game.actors){prepareActor(a,game.rules);supply(a);a.baseMaxHp=500;a.hp=500;prepareActor(a,game.rules);}
  adventureAction(game,{action:'start',actorId:'player-0'},'player-0',{host:true,random});
  for(let round=0;round<20;round++){
   if(round)resetRound(game,random);rounds++;
   while(game.turn<game.order.length){
    const a=game.actors.find(a=>a.id===game.order[game.turn]);if(!a||a.hp<=0){advanceInitiative(game,random);continue;}
    const self=a.player?a.id:'player-0',host=!a.player;
    const perform=request=>adventureAction(game,{actorId:a.id,...request},self,{host,random});
    const wrong=game.actors.find(other=>other.player&&other.id!==self);const beforeWrong=resources(wrong);assert.throws(()=>adventureAction(game,{action:'check',actorId:wrong.id,ability:'strength'},self,{host:false,random}),/своим/);assert.equal(resources(wrong),beforeWrong);
    const target=game.actors.filter(b=>b.player!==a.player&&b.hp>0).sort((b,c)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)-Math.abs(a.x-c.x)-Math.abs(a.y-c.y))[0];
    if(target){
     const cells=reachableCells(game,a,a.move),best=cells.sort((b,c)=>Math.abs(b[0]-target.x)+Math.abs(b[1]-target.y)-Math.abs(c[0]-target.x)-Math.abs(c[1]-target.y))[0];
     if(best&&best[2]>0)perform({action:'move',x:best[0],y:best[1]});
     const before=resources(a),oldHp=target.hp;
     try{perform({action:'skill',skillId:'blade',targetId:target.id});calls++;const attack=game.log.findLast(e=>e.calculation?.kind==='attack').calculation;if(attack.hit){hits++;const damage=game.log.findLast(e=>e.calculation?.kind==='damage').calculation;assert.equal(oldHp-target.hp,damage.applied);assert.equal(damage.hpAfter,target.hp);assert.equal(damage.raw,damage.diceTotal+damage.bonus);}else{misses++;assert.equal(target.hp,oldHp);}assert.equal(a.actions,0);const resourceAfter=resources(a);assert.throws(()=>perform({action:'skill',skillId:'blade',targetId:target.id}));assert.equal(resources(a),resourceAfter);}
     catch(error){if(!/дистанции|стеной/.test(error.message))throw error;rejected++;assert.equal(resources(a),before);assert.equal(target.hp,oldHp);}
    }
    for(const actor of game.actors){assert.ok(Number.isFinite(actor.hp)&&actor.hp>=0&&actor.hp<=actor.maxHp);assert.ok(actor.actions>=0&&actor.fastActions>=0);assert.ok(actor.inventory.every(i=>Number.isInteger(i.quantity)&&i.quantity>=0));}
    if(a.player)perform({action:'end'});else advanceInitiative(game,random);turns++;
   }
   assert.equal(game.phase,'gm');assert.ok(game.log.length<=300);
  }
  if(encounter%15===0){const file=path.join(dir,'game.json');await fs.writeFile(file,JSON.stringify(game));game=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(game.actors.filter(a=>a.player).length,3);assert.ok(game.eventArchive.length>=game.log.length);}
  if(encounter===59){for(const layer of ['depth','normal','layout'])assert.ok(mapPNG(game.map,layer).length>1000);}
 }
 assert.equal(rounds,1200);assert.ok(turns>=5500);assert.ok(calls>1000&&hits>300&&misses>100&&rejected>100);
 assert.ok(game.eventArchive.length>10000);assert.equal(game.log.length,300);
 const room={id:'campaign',messages:[],tactical:game,memory:[]},chat=roomChat(room);assert.ok(chat.messages.some(m=>m.content.includes(game.eventArchive[0].text)));const docs=sourceDocuments(chat);assert.ok(docs.length>10000);assert.ok(!docs.some(d=>d.text.includes('FOREIGN_STORY')));
 t.diagnostic(JSON.stringify({rounds,turns,attempts:calls,hits,misses,rejected,maps:60,players:3,engineEvents:game.eventArchive.length,sourceDocuments:docs.length}));
});
