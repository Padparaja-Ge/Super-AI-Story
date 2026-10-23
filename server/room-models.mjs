export function normalizeRoomModels(state,value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Неверные модели комнаты.');
 const result={};
 for(const key of ['npcConnectionId','summaryConnectionId','embeddingConnectionId','mapConnectionId']){
  const id=value[key]||'';if(typeof id!=='string'||id.length>100||id&&!state.connections.some(c=>c.id===id))throw new Error('Выберите существующее подключение: '+key);result[key]=id;
 }
 if(typeof(value.embeddingModel??'')!=='string'||String(value.embeddingModel||'').length>200)throw new Error('Неверное имя embedding-модели.');
 result.embeddingModel=value.embeddingModel||'';
 for(const key of ['structuredNarration','allowNarrativeSceneUpdates'])if(value[key]!==undefined){
  if(typeof value[key]!=='boolean')throw new Error('Неверный переключатель ведущего: '+key);result[key]=value[key];
 }
 for(const [key,min,max] of [['temperature',0,2],['maxTokens',64,8192]])if(value[key]!==undefined&&value[key]!==''){
  if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<min||value[key]>max||key==='maxTokens'&&!Number.isInteger(value[key]))throw new Error('Неверный параметр ведущего: '+key);result[key]=value[key];
 }
 return result;
}
export function roomEmbeddingState(state,chat){
 const settings=chat.memorySettings||{};
 return settings.embeddingConnectionId||settings.embeddingModel?{...state,settings:{...state.settings,embeddings:{...state.settings.embeddings,...(settings.embeddingConnectionId?{connectionId:settings.embeddingConnectionId}:{}),...(settings.embeddingModel?{model:settings.embeddingModel}:{})}}}:state;
}
export function roomModelState(state,room){
 const ai=room.aiSettings||{},overrides={...(ai.temperature!==undefined?{temperature:ai.temperature}:{}),...(ai.maxTokens!==undefined?{maxTokens:ai.maxTokens}:{})};
 return {...state,connections:state.connections.map(c=>c.id===room.connectionId?{...c,...overrides}:c),settings:{...state.settings,...(room.connectionId==='sas-local'?{localSampling:{...state.settings.localSampling,...overrides}}:{})}};
}
