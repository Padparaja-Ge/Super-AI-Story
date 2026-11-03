export const interfaceLanguages=Object.freeze([
 {id:'ru',label:'Русский',locale:'ru-RU'},
 {id:'en',label:'English',locale:'en-US'},
 {id:'ja',label:'日本語',locale:'ja-JP'},
 {id:'zh-CN',label:'简体中文',locale:'zh-CN'},
 {id:'ko',label:'한국어',locale:'ko-KR'},
]);
export const languageStorageKey='sas-interface-language-v1';
export const validInterfaceLanguage=value=>interfaceLanguages.some(language=>language.id===value);
export const normalizeInterfaceLanguage=value=>validInterfaceLanguage(value)?value:'ru';

export function createTranslator(catalogs,getLanguage){
 return function translate(text,values=[]){
  if(typeof text!=='string')return text;
  const language=normalizeInterfaceLanguage(getLanguage()),key=text.trim();
  const translation=language==='ru'?undefined:catalogs[language]?.[key];
  const source=typeof translation==='string'?text.slice(0,text.indexOf(key))+translation+text.slice(text.indexOf(key)+key.length):text;
  // Values are inserted once, as plain text; no HTML, eval or recursive replacement.
  return source.replace(/\{(\d+)\}/g,(match,index)=>Number(index)<values.length?String(values[Number(index)]):match);
 };
}
