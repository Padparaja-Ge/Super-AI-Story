import crypto from 'node:crypto';
import {emptyScene} from '../shared/defaults.mjs';
import {roomMemoryDefaults} from './room-memory.mjs';

export function roomHistories(state){
  const histories=[state.multiplayer,...(state.multiplayerHistories||[])].filter(h=>h?.id);
  return [...new Map(histories.map(h=>[h.id,h])).values()];
}
export function historySummaries(state){return roomHistories(state).map(h=>({id:h.id,name:h.name||'Без названия',mode:h.mode||'roleplay',chatId:h.chatId,messageCount:h.messages?.length||0,createdAt:h.createdAt,updatedAt:h.messages?.at(-1)?.createdAt||h.createdAt,current:h.id===state.multiplayer?.id,hostPersonaId:h.personas?.host?.id}));}
export function selectRoomHistory(state,{historyId,newHistory=false,name,chatId,mode='roleplay'}={}){
  const all=roomHistories(state);let selected;
  if(newHistory){
    if(mode==='roleplay'&&!state.chats.some(c=>c.id===chatId))throw new Error('Выберите персонажа ведущего для новой истории.');
    selected={id:crypto.randomUUID(),mode,name:String(name||'Наша история').trim().slice(0,100),chatId,createdAt:new Date().toISOString(),messages:[],memory:[],memorySettings:{...roomMemoryDefaults,vectorMemory:!!state.settings.localEmbeddings||!!state.settings.embeddings?.model},summary:'',scene:emptyScene(),personas:{},weights:{}};
  }else if(historyId){selected=all.find(h=>h.id===historyId);if(!selected)throw new Error('История мультиплеера не найдена.');}
  else selected=state.multiplayer?.id?state.multiplayer:{...state.multiplayer,id:crypto.randomUUID(),createdAt:new Date().toISOString()};
  state.multiplayerHistories=all.filter(h=>h.id!==selected.id);state.multiplayer=structuredClone(selected);return state.multiplayer;
}
export function deleteRoomHistory(state,id){
  if(!roomHistories(state).some(h=>h.id===id))throw new Error('История не найдена.');
  state.multiplayerHistories=(state.multiplayerHistories||[]).filter(h=>h.id!==id);
  if(state.multiplayer?.id===id)state.multiplayer={};
  state.images=(state.images||[]).filter(i=>i.roomId!==id);
}
