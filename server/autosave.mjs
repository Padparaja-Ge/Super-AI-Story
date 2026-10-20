export const autosaveDefaults={enabled:true,intervalSeconds:0,onTaskComplete:true,onClose:true};
export function validateAutosave(value={}){
 const result={...autosaveDefaults};for(const key of ['enabled','onTaskComplete','onClose'])if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw Error('Неверный переключатель автосохранения.');result[key]=value[key];}
 if(value.intervalSeconds!==undefined){if(!Number.isInteger(value.intervalSeconds)||value.intervalSeconds<0||value.intervalSeconds>3600)throw Error('Интервал автосохранения: 0–3600 секунд.');result.intervalSeconds=value.intervalSeconds;}
 return result;
}
