import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {physicalFaces,valueFromFaces,visualRollFromEvent,collectNewRolls,symmetryRotation,applyMatrix,parseDiceExpression} from '../shared/dice-visual.mjs';
import {resolveD20Outcome} from '../server/ability-checks.mjs';
import {normalizeAdventureRules,adventureRulesDefaults} from '../shared/adventure-rules.mjs';
import {createAdventureGame,adventureAction,prepareActor} from '../server/adventure-engine.mjs';

const faces=JSON.parse(fs.readFileSync(new URL('../public/dnd-visuals/dice/dice-faces.json',import.meta.url),'utf8'));
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

test('Blender face map: every die has each value exactly once and unit axes',()=>{
 const expected={d4:[1,2,3,4],d6:[1,2,3,4,5,6],d8:[1,2,3,4,5,6,7,8],d10:[1,2,3,4,5,6,7,8,9,10],d10t:[0,10,20,30,40,50,60,70,80,90],d12:Array.from({length:12},(_,i)=>i+1),d20:Array.from({length:20},(_,i)=>i+1)};
 for(const [kind,values] of Object.entries(expected)){
  const die=faces.dice[kind];assert.ok(die,kind);
  assert.deepEqual(die.faces.map(f=>f.value).sort((a,b)=>a-b),values,kind);
  for(const f of die.faces){assert.ok(Math.abs(Math.hypot(...f.axis)-1)<1e-4,kind+' axis length');if(die.readMode==='face')assert.ok(Math.abs(dot(f.axis,f.up))<1e-4,kind+' up lies in face');}
 }
 assert.equal(faces.dice.d4.readMode,'vertex');
});

test('Blender face map: opposite faces follow standard sums',()=>{
 for(const kind of ['d6','d8','d12','d20']){const die=faces.dice[kind],n=Number(kind.slice(1));for(const f of die.faces){const opp=die.faces.reduce((best,g)=>dot(g.axis,f.axis)<dot(best.axis,f.axis)?g:best);assert.equal(f.value+opp.value,n+1,kind);}}
 for(const kind of ['d10','d10t']){const die=faces.dice[kind];for(const f of die.faces){const opp=die.faces.reduce((best,g)=>dot(g.axis,f.axis)<dot(best.axis,f.axis)?g:best);assert.equal(Number(f.label[0])+Number(opp.label[0]),9,kind);}}
});

test('symmetry remap exists for every (requested, landed) face pair and preserves the hull',()=>{
 for(const [kind,die] of Object.entries(faces.dice)){
  const axes=die.faces.map(f=>f.axis);
  for(let from=0;from<axes.length;from++)for(let to=0;to<axes.length;to++){
   const m=symmetryRotation(axes,from,to);
   assert.ok(dot(applyMatrix(m,axes[from]),axes[to])>0.9999,`${kind} ${from}->${to}`);
   const det=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
   assert.ok(Math.abs(det-1)<1e-6,'proper rotation, never a mirror');
  }
 }
});

test('physical faces map engine values to labels and back, including percentile',()=>{
 for(const sides of [4,6,8,10,12,20,100])for(let v=1;v<=sides;v++){const pf=physicalFaces(sides,v);assert.equal(valueFromFaces(sides,pf),v);for(const f of pf)assert.ok(faces.dice[f.model].faces.some(face=>face.label===f.label),`${sides}:${v} ${f.model}/${f.label}`);}
 assert.deepEqual(physicalFaces(100,100),[{model:'d10t',label:'00'},{model:'d10',label:'0'}]);
 assert.deepEqual(physicalFaces(100,7),[{model:'d10t',label:'00'},{model:'d10',label:'7'}]);
 assert.deepEqual(physicalFaces(100,40),[{model:'d10t',label:'40'},{model:'d10',label:'0'}]);
 assert.throws(()=>physicalFaces(20,21));assert.throws(()=>physicalFaces(20,0));
 assert.deepEqual(physicalFaces(7,3),[]);
 assert.deepEqual(parseDiceExpression('2d6'),{count:2,sides:6});assert.deepEqual(parseDiceExpression('д8'),{count:1,sides:8});assert.equal(parseDiceExpression('2d6+3'),null);
});

test('visual roll copies engine results; cinematic only for an engine-confirmed d20 critical',()=>{
 const attack={id:'e1',text:'atk',calculation:{kind:'attack',die:20,roll:20,rolls:[7,20],mode:'преимущество',modifier:3,bonus:2,total:25,dc:15,critical:'success',naturalCritical:'success',outcome:'success',success:true,hit:true}};
 const r=visualRollFromEvent(attack);
 assert.deepEqual(r.dice,[{sides:20,value:7,kept:false},{sides:20,value:20,kept:true}]);
 assert.equal(r.modifier,5);assert.equal(r.total,25);assert.equal(r.cinematic,'divine-blessing');
 const fail=visualRollFromEvent({id:'e2',calculation:{kind:'check',die:20,roll:1,rolls:[1],modifier:4,total:5,dc:10,critical:'failure',naturalCritical:'failure',outcome:'failure',success:false}});
 assert.equal(fail.cinematic,'deaths-judgment');
 // House rule off: the engine reports no critical, so no cinematic either.
 const off=visualRollFromEvent({id:'e3',calculation:{kind:'check',die:20,roll:20,rolls:[20],modifier:0,total:20,dc:25,critical:null,naturalCritical:'success',outcome:'failure',success:false}});
 assert.equal(off.cinematic,null);assert.equal(off.naturalCritical,'success');
 // A d20 natural 20 on a damage roll is never a critical scene.
 const dmg=visualRollFromEvent({id:'e4',calculation:{kind:'damage',attackId:'e1',expression:'2d6',rolls:[3,6],diceTotal:9,bonus:3,raw:12,applied:12}});
 assert.deepEqual(dmg.dice.map(d=>d.value),[3,6]);assert.equal(dmg.total,12);assert.equal(dmg.modifier,3);assert.equal(dmg.cinematic,null);
 assert.equal(visualRollFromEvent({id:'x',text:'Раунд 2'}),null);
});

test('collectNewRolls never replays an already seen event',()=>{
 const seen=new Set(['old']);const log=[{id:'old',calculation:{kind:'check',die:20,roll:20,rolls:[20],total:20,critical:'success'}},{id:'n1',calculation:{kind:'check',die:20,roll:4,rolls:[4],total:6,modifier:2}},{id:'n2',text:'plain'}];
 assert.deepEqual(collectNewRolls(log,seen).map(r=>r.eventId),['n1']);
 assert.deepEqual(collectNewRolls(log,seen),[]);
});

test('critical house rules: defaults keep natural 20/1 automatic, disabled category uses the total',()=>{
 assert.equal(adventureRulesDefaults.critAttacks,true);assert.equal(adventureRulesDefaults.critChecks,true);assert.equal(adventureRulesDefaults.critContests,true);
 assert.equal(resolveD20Outcome({roll:20,modifier:0,dc:25}).success,true);
 const off=resolveD20Outcome({roll:20,modifier:0,dc:25,criticals:false});
 assert.equal(off.success,false);assert.equal(off.critical,null);assert.equal(off.naturalCritical,'success');
 assert.equal(resolveD20Outcome({roll:1,modifier:30,dc:10,criticals:false}).success,true);
 const dnd=normalizeAdventureRules('dnd',{critChecks:false,hp:999});
 assert.equal(dnd.critChecks,false);assert.equal(dnd.hp,adventureRulesDefaults.hp,'other D&D rules stay fixed');
 assert.throws(()=>normalizeAdventureRules('dnd',{critAttacks:'no'}));
});

test('engine applies the attack critical rule from campaign settings',()=>{
 const game=createAdventureGame('dnd',{critAttacks:false});
 const rules=game.rules;
 const a=prepareActor({id:'p',name:'A',player:true,abilities:{strength:10,dexterity:10,constitution:10,intelligence:10,wisdom:10,charisma:10},inventory:[],spells:[],x:0,y:0},rules);
 const b=prepareActor({id:'n',name:'B',player:false,abilities:{strength:10,dexterity:10,constitution:10,intelligence:10,wisdom:10,charisma:10},inventory:[],spells:[],x:1,y:0},rules);
 game.actors=[a,b];game.order=['p'];game.turn=0;game.phase='players';
 const skill=a.skills.find(s=>s.grade==='attack');assert.ok(skill,'default unarmed/weapon attack exists');
 b.baseArmor=1;
 // Natural 1 against a trivial armour class: with critAttacks off it still hits.
 adventureAction(game,{action:'skill',skillId:skill.id,targetId:'n'},'p',{random:()=>1});
 const atk=game.log.find(e=>e.calculation?.kind==='attack').calculation;
 assert.ok(atk.armor<=atk.total,'total beats armour');
 assert.equal(atk.naturalCritical,'failure');assert.equal(atk.critical,null);assert.equal(atk.hit,true);
 assert.equal(visualRollFromEvent({id:'a',calculation:atk}).cinematic,null);
});
