export const roomAutosaveDefaults={enabled:true,intervalSeconds:60,maxSnapshots:20,onImportantEvents:true,includeAiReplies:true};
export function roomAutosaveSettings(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Неверные настройки резервных копий.');const out={...roomAutosaveDefaults};
  for(const key of ['enabled','onImportantEvents','includeAiReplies'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw new Error('Неверный переключатель резервных копий.');out[key]=input[key];}
  for(const [key,min,max]of [['intervalSeconds',15,3600],['maxSnapshots',3,100]])if(input[key]!==undefined){if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw new Error('Недопустимый параметр резервных копий: '+key);out[key]=input[key];}return out;
}
