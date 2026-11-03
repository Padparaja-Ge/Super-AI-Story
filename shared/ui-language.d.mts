export type InterfaceLanguage='ru'|'en'|'ja'|'zh-CN'|'ko';
export const interfaceLanguages:readonly {id:InterfaceLanguage;label:string;locale:string}[];
export const languageStorageKey:string;
export function validInterfaceLanguage(value:unknown):value is InterfaceLanguage;
export function normalizeInterfaceLanguage(value:unknown):InterfaceLanguage;
export function createTranslator(catalogs:Record<string,Record<string,string>>,getLanguage:()=>string):<T>(text:T,values?:unknown[])=>T;
