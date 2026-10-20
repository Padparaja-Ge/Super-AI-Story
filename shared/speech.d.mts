export const speechDefaults:Record<string,any>;
export function speechSettings(value?:Record<string,any>):Record<string,any>;
export function speechFor(value?:Record<string,any>,context?:{characterId?:string;gameMaster?:boolean;fanfic?:boolean}):Record<string,any>;
export function speechText(text:string,pronunciations?:{from:string;to:string}[]):string;
export function speechSentences(text:string,limit?:number,language?:string):string[];
