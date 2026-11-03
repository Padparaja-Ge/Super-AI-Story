import {useSyncExternalStore} from 'react';
import {createTranslator,interfaceLanguages,languageStorageKey,normalizeInterfaceLanguage,type InterfaceLanguage} from '../shared/ui-language.mjs';
import {api} from './api';
export {interfaceLanguages};
let language:InterfaceLanguage='ru';
let preferred:InterfaceLanguage='ru';
try{preferred=normalizeInterfaceLanguage(localStorage.getItem(languageStorageKey));}catch{}
const listeners=new Set<()=>void>();
const catalogs:Record<string,Record<string,string>>={};
const loaders={en:()=>import('../shared/locales/en.json'),ja:()=>import('../shared/locales/ja.json'),'zh-CN':()=>import('../shared/locales/zh-CN.json'),ko:()=>import('../shared/locales/ko.json')};
async function prepare(value:InterfaceLanguage){if(value!=='ru'&&!catalogs[value])catalogs[value]=(await loaders[value]()).default;}
export const t=createTranslator(catalogs,()=>language);
export const uiLocale=()=>interfaceLanguages.find(item=>item.id===language)!.locale;
export const getInterfaceLanguage=()=>language;
const changed=()=>{document.documentElement.lang=language;for(const listener of listeners)listener();};
let pending:Promise<unknown>=Promise.resolve(),initializing:Promise<void>|undefined,revision=0;
function apply(value:unknown){language=normalizeInterfaceLanguage(value);try{localStorage.setItem(languageStorageKey,language);}catch{}changed();}
export function initializeInterfaceLanguage(){return initializing||=(async()=>{const started=revision;let selected=preferred;try{const saved=await api('/interface-language');if(saved.language)selected=normalizeInterfaceLanguage(saved.language);}catch{/* Keep device preference when server is offline. */}try{await prepare(selected);if(revision===started)apply(selected);}catch{/* Russian remains usable if a distribution file is missing. */}changed();})();}
export async function setInterfaceLanguage(value:InterfaceLanguage){
 const request=++revision;value=normalizeInterfaceLanguage(value);await prepare(value);if(request!==revision)return;apply(value);
 const snapshot=language;
 const work=pending.catch(()=>{}).then(()=>api('/interface-language',{language:snapshot},'PUT'));
 pending=work;await work;
}
export async function flushInterfaceLanguage(){await pending;}
export function useInterfaceLanguage(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>language);}
