import crypto from 'node:crypto';
import {initiativeOf} from '../shared/equipment.mjs';
import {logGame} from './tactical.mjs';
const dice=()=>crypto.randomInt(1,21);
const eligible=(g,a)=>a.hp>0&&a.online!==false&&(a.player||g.inCombat);

// A round is a snapshot: changing equipment cannot grant a second turn.
export function beginInitiative(g,random=dice){
 g.initiativeVersion=1;g.initiativeScores={};g.initiativeTies={};g.gmPendingNext=false;g.turn=0;
 const actors=g.actors.filter(a=>eligible(g,a));
 for(const a of actors){const score=initiativeOf(a);g.initiativeScores[a.id]=score;logGame(g,`${a.name}: инициатива ${score.dexterity} (Ловкость)${score.equipment.filter(i=>i.penalty).map(i=>` − ${i.penalty} (${i.name})`).join('')} = ${score.value}.`,{kind:'initiative',actorId:a.id,...score});}
 g.order=actors.sort((a,b)=>g.initiativeScores[b.id].value-g.initiativeScores[a.id].value).map(a=>a.id);
 activateInitiative(g,random);
}
export function activateInitiative(g,random=dice){
 while(g.turn<g.order.length&&!g.actors.some(a=>a.id===g.order[g.turn]&&eligible(g,a)))g.turn++;
 const id=g.order[g.turn],value=g.initiativeScores?.[id]?.value,key=String(value);
 if(id&&!g.initiativeTies?.[key]){
  let end=g.turn+1;while(end<g.order.length&&g.initiativeScores[g.order[end]]?.value===value)end++;
  const ids=g.order.slice(g.turn,end).filter(id=>g.actors.some(a=>a.id===id&&eligible(g,a)));
  g.initiativeTies||={};g.initiativeTies[key]=true;
  if(ids.length>1){
   const totals=new Map(ids.map(id=>[id,[]]));let groups=[ids];
   for(let attempt=0;attempt<10&&groups.length;attempt++){
    const next=[];
    for(const group of groups){const byRoll=new Map();for(const actorId of group){const roll=random(20);if(!Number.isInteger(roll)||roll<1||roll>20)throw new Error('Неверный бросок инициативы.');totals.get(actorId).push(roll);const a=g.actors.find(a=>a.id===actorId);logGame(g,`${a.name}: равная инициатива, 1д20 (${roll}) + ${value} = ${roll+value}${attempt?' · переброс равенства':''}.`,{kind:'initiative-tie',actorId,roll,initiative:value,total:roll+value,attempt});byRoll.set(roll,[...(byRoll.get(roll)||[]),actorId]);}for(const tied of byRoll.values())if(tied.length>1)next.push(tied);}
    groups=next;
   }
   ids.sort((a,b)=>{const aa=totals.get(a),bb=totals.get(b);for(let i=0;i<Math.max(aa.length,bb.length);i++){const d=(bb[i]||0)-(aa[i]||0);if(d)return d;}return a.localeCompare(b);});
   if(groups.length)logGame(g,'После 10 одинаковых перебросов применяется стабильный порядок ID участников.');
   g.order.splice(g.turn,end-g.turn,...ids);
  }
 }
 const current=g.actors.find(a=>a.id===g.order[g.turn]);g.phase=g.gmPendingNext||!current||!current.player?'gm':'players';
}
export function advanceInitiative(g,random=dice){g.turn++;activateInitiative(g,random);}
export function syncInitiative(g,random=dice){
 // Retain passed positions, skip eliminated/disconnected actors on activation.
 // New arrivals enter next round in combat, preventing mid-round priority jumps.
 if(!g.inCombat){for(const a of g.actors.filter(a=>eligible(g,a)&&!g.order.includes(a.id))){g.initiativeScores[a.id]=initiativeOf(a);g.order.push(a.id);}const passed=g.order.slice(0,g.turn),remaining=g.order.slice(g.turn).sort((a,b)=>(g.initiativeScores[b]?.value??0)-(g.initiativeScores[a]?.value??0));g.order=[...passed,...remaining];}
 activateInitiative(g,random);
}
