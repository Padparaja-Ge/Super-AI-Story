import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionRequest,roomManagementAccess} from '../shared/room-management.mjs';

const room={tactical:{order:['hero','npc'],actors:[{id:'hero',hp:10,online:true},{id:'npc',hp:4,online:true},{id:'dead',hp:0,online:true}]}};
const session={running:true,messages:[{id:'roll',kind:'dice',dice:{sides:12,value:4}}]};
test('Room management never exposes game controls to pending players',()=>{
  const access=roomManagementAccess(room,{connected:true,admission:'pending'},false);
  assert.equal(access.pending,true);assert.equal(access.canRead,false);assert.equal(access.canCorrect,false);
  assert.equal(roomManagementAccess(room,{running:true},true).canRestore,false);
  assert.equal(roomManagementAccess(room,{running:false},true).canRestore,true);
  assert.equal(roomManagementAccess({...room,narration:{status:'incomplete'}},session,true).canCorrect,false);
});
test('Host correction sends only requested numeric field and reason, without implicit resources',()=>{
  assert.deepEqual(correctionRequest('actor',{reason:' Ошибка HP ',actorId:'hero',field:'hp',value:'7'},room,session),{kind:'actor',reason:'Ошибка HP',actorId:'hero',patch:{hp:7}});
  assert.deepEqual(correctionRequest('actor',{reason:'Позиция',actorId:'hero',field:'position',x:'0',y:'3'},room,session).patch,{x:0,y:3});
  assert.deepEqual(correctionRequest('actor',{reason:'Снять захват',actorId:'hero',field:'grappledBy',value:''},room,session).patch,{grappledBy:''});
  for(const value of ['',-1,0.5,'NaN'])assert.throws(()=>correctionRequest('actor',{reason:'test',actorId:'hero',field:'hp',value},room,session));
  assert.throws(()=>correctionRequest('actor',{reason:'test',actorId:'hero',field:'apiKey',value:5},room,session));
  assert.deepEqual(correctionRequest('actor',{reason:'Броня',actorId:'hero',field:'armor',value:'10.5'},room,session).patch,{armor:10.5});
  assert.throws(()=>correctionRequest('actor',{reason:'Броня',actorId:'hero',field:'armor',value:'10.25'},room,session));
});
test('Dice correction respects sides and turn correction requires active living actor',()=>{
  assert.deepEqual(correctionRequest('dice',{reason:'Проверка кубика',messageId:'roll',value:'12'},room,session),{kind:'dice',reason:'Проверка кубика',messageId:'roll',value:12});
  for(const value of [0,13,1.2])assert.throws(()=>correctionRequest('dice',{reason:'test',messageId:'roll',value},room,session));
  assert.equal(correctionRequest('turn',{reason:'Очередь',actorId:'npc'},room,session).actorId,'npc');
  assert.throws(()=>correctionRequest('turn',{reason:'Очередь',actorId:'dead'},room,session));
  assert.throws(()=>correctionRequest('event',{reason:'',eventId:'1',text:'Правка'},room,session));
});
