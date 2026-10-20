import catalog from '../server/tts/silero-catalog.json' with {type:'json'};
// Only versioned, allow-listed official Silero packages can be installed.
export const sileroModels=Object.freeze(catalog.map(model=>Object.freeze({...model,voices:Object.freeze([...model.voices]),sampleRates:Object.freeze([...model.sampleRates]),file:Object.freeze({...model.file,mirrors:Object.freeze([...(model.file.mirrors||[])])})})));
export function sileroModel(id){return sileroModels.find(model=>model.id===id);}
export function sileroModelsForLanguage(language){return sileroModels.filter(model=>model.language===language);}
