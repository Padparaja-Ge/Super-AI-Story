export interface SileroModel {id:string;language:'ru'|'en';label:string;bytes:number;voices:readonly string[];sampleRates:readonly number[];bundled:boolean;file:{path:string;url:string;size:number;sha256:string;mirrors?:readonly string[]};revision:string;license:string;source:string;}
export const sileroModels:readonly SileroModel[];
export function sileroModel(id:string):SileroModel|undefined;
export function sileroModelsForLanguage(language:string):SileroModel[];
