import test from 'node:test';
import assert from 'node:assert/strict';
import {commitPlayerCheck,planPlayerCheck,compactCheckSubjects,checkPreparationContext} from '../server/gm-checks.mjs';
import {createAdventureGame,adventureActor,adventureAction} from '../server/adventure-engine.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {roomChat} from '../server/room-memory.mjs';

const persona={id:'sheet',name:'Герой',kind:'srp',className:'Воин',abilities:defaultAbilities()};
function table(){const game=createAdventureGame('dnd');game.actors=[adventureActor('host',persona,game.rules)];game.order=['host'];return game;}
function plan(index,{scope='map|Локация '+index,name='Валун '+index,kind='environment',dc=15}={}){return {attempt:{intent:'Пробую сдвинуть '+name,actorId:'host',targetId:'',checkType:'strength',messageId:'post-'+index},ability:'strength',scope,decision:{name:'Препятствие '+index,subjectName:name,subjectKind:kind,targetId:'',dc,impossible:false,impossibleReason:'',reason:'Сохраняемая сложность препятствия.'}};}
const perform=(game,task)=>adventureAction(game,{action:'check',challengeId:task.id},'host',{random:()=>15});

test('Six hundred subjects survive long play, save restoration and archived exact-scope DC reuse',()=>{
 let game=table(),firstSubject;
 for(let i=0;i<600;i++){const task=commitPlayerCheck(game,plan(i,{dc:i===0?19:7+i%12}));firstSubject||=task.subjectId;perform(game,task);assert.ok(game.checkSubjects.length<=300);if(i%100===99)game=JSON.parse(JSON.stringify(game));}
 assert.equal(game.checkSubjects.length,300);assert.equal(game.checkSubjectArchive.length,300);assert.equal(game.checkSubjectArchive.find(s=>s.id===firstSubject).checkDifficulties.strength.dc,19);
 const restored=commitPlayerCheck(game,plan('return',{scope:'map|Локация 0',name:'Валун 0',dc:1}));assert.equal(restored.subjectId,firstSubject);assert.equal(restored.dc,19);assert.equal(game.checkSubjects.length,300);assert.ok(!game.checkSubjectArchive.some(s=>s.id===firstSubject));assert.equal(perform(game,restored).calculation.success,false);
 const otherScope=commitPlayerCheck(game,plan('different-place',{scope:'map|Другая локация',name:'Валун 0',dc:7}));assert.notEqual(otherScope.subjectId,firstSubject);assert.equal(otherScope.dc,7);
 const otherKind=commitPlayerCheck(game,plan('other-kind',{scope:'map|Локация 0',name:'Валун 0',kind:'npc',dc:12}));assert.notEqual(otherKind.subjectId,firstSubject);assert.equal(otherKind.dc,12);
 const otherName=commitPlayerCheck(game,plan('other-name',{scope:'map|Локация 0',name:'Валун 00',dc:11}));assert.notEqual(otherName.subjectId,firstSubject);assert.equal(otherName.dc,11);
});
test('Pending subject references are retained while other completed locations are archived first',()=>{
 const game=table(),pendingTask=commitPlayerCheck(game,plan('pending',{scope:'old-map|Старое место',name:'Важная дверь'})),pendingSubject=pendingTask.subjectId;
 for(let i=0;i<550;i++){const task=commitPlayerCheck(game,plan(i));perform(game,task);}
 assert.ok(game.challenges.some(c=>c.id===pendingTask.id&&c.active!==false&&!c.lastResultId));assert.ok(game.checkSubjects.some(s=>s.id===pendingSubject));assert.ok(!game.checkSubjectArchive.some(s=>s.id===pendingSubject));assert.ok(game.checkSubjects.length<=300);
 const stale={id:'stale',name:'Старый объект',kind:'environment',scope:'old',checkDifficulties:{}},current=Array.from({length:300},(_,i)=>({id:'current-'+i,name:'Текущий '+i,kind:'environment',scope:'current',checkDifficulties:{}}));game.checkSubjects=[...current,stale];game.challenges=[];compactCheckSubjects(game,{scope:'current',keepId:'current-299'});assert.ok(!game.checkSubjects.some(s=>s.id==='stale'));assert.equal(game.checkSubjects.length,300);
});
test('Legacy imports above the soft bound retain every unresolved subject and a full pending table rejects without inserting a new subject',()=>{
 const game=table();game.checkSubjects=Array.from({length:350},(_,i)=>({id:'protected-'+i,name:'Защищённый '+i,kind:'environment',scope:'legacy',checkDifficulties:{}}));game.challenges=game.checkSubjects.map((s,i)=>({id:'pending-'+i,subjectId:s.id,active:true,name:'Задача',actorId:'host',ability:'strength',dc:10}));
 compactCheckSubjects(game,{scope:'new'});assert.equal(game.checkSubjects.length,350);assert.equal(game.checkSubjectArchive,undefined);
 assert.throws(()=>commitPlayerCheck(game,plan('blocked')),/300 нерешённых/);assert.equal(game.checkSubjects.length,350);assert.equal(game.challenges.length,350);
});
test('Subject archive is bounded and restoration never replaces the stored object with a fresh DC',()=>{
 const game=table();game.checkSubjectArchive=Array.from({length:2000},(_,i)=>({id:'historic-'+i,name:'Исторический '+i,kind:'npc',scope:'historic',checkDifficulties:{strength:{ability:'strength',dc:19,impossible:false,impossibleReason:''}}}));game.checkSubjects=Array.from({length:300},(_,i)=>({id:'live-'+i,name:'Живой '+i,kind:'npc',scope:'live',checkDifficulties:{}}));
 const task=commitPlayerCheck(game,plan('restore',{scope:'historic',name:'Исторический 1999',kind:'npc',dc:1}));assert.equal(task.dc,19);assert.equal(task.subjectId,'historic-1999');assert.equal(game.checkSubjects.length,300);assert.ok(game.checkSubjectArchive.length<=2000);assert.ok(!game.checkSubjectArchive.some(s=>s.id===task.subjectId));assert.ok(game.checkSubjectArchive.some(s=>s.id==='live-0'));
});
test('Preparation selects at most thirty relevant subjects and keeps the selected target, all ordinary players and named NPCs',async()=>{
 const game=table();for(let i=0;i<3;i++)game.actors.push({...structuredClone(game.actors[0]),id:'player-'+i,name:'Игрок '+i});for(let i=0;i<120;i++)game.actors.push({...structuredClone(game.actors[0]),id:'npc-'+i,name:'NPC '+i,player:false});
 game.checkSubjects=Array.from({length:300},(_,i)=>({id:'subject-'+i,name:'Камень '+i,kind:'environment',scope:'map|Текущая',checkDifficulties:{strength:{ability:'strength',dc:10,impossible:false}}}));game.checkSubjectArchive=Array.from({length:400},(_,i)=>({id:'arch-'+i,name:'Архив '+i,kind:'npc',scope:'map|Другая',checkDifficulties:{strength:{ability:'strength',dc:19,impossible:false}}}));
 const room={id:'room',mode:'dnd',tactical:game,scene:{location:'Текущая'},messages:[{id:'last',role:'assistant',content:'NPC 119 стоит у камня.'},{id:'post',role:'user',userId:'host',content:'Спрашиваю NPC 118 об Архив 399, затем двигаю Камень 299.'}]};room.tactical.map={id:'map'};
 let captured;await planPlayerCheck({state:{lorebooks:[]},chat:roomChat(room),room,actor:game.actors[0],request:{checkType:'strength',targetId:'npc-117'},getSecret:()=>'',completion:async options=>{captured=options.context;return options.parse(JSON.stringify({requiresCheck:true,checkType:'strength',name:'Попытка',subjectName:'NPC 117',subjectKind:'npc',targetId:'npc-117',dc:15,impossible:false,impossibleReason:'',reason:'Обычное препятствие.'}));}});
 assert.equal(captured.actors.length,30);assert.ok(captured.omittedActors>0);for(const id of ['host','player-0','player-1','player-2','npc-117','npc-118','npc-119'])assert.ok(captured.actors.some(a=>a.id===id),id);
 assert.ok(captured.subjects.length<=30);assert.ok(captured.subjects.some(s=>s.id==='subject-299'));assert.ok(captured.subjects.some(s=>s.id==='arch-399'));assert.ok(!captured.subjects.some(s=>s.id==='arch-0'));
 const direct=checkPreparationContext(room,game.actors[0],{intent:'NPC 119',targetId:'npc-117',checkType:'strength'},[]);assert.ok(direct.actors.some(a=>a.id==='npc-119'));
});
