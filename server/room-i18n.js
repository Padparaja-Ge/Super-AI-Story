import {createTranslator,interfaceLanguages,languageStorageKey,normalizeInterfaceLanguage} from './ui-language.mjs';
const catalogs={};let language='ru';
export const getInterfaceLanguage=()=>language;
export const t=createTranslator(catalogs,getInterfaceLanguage);
const texts=new Map(),attributes=new Map();
// This guest UI uses imperative DOM, not React. Register only freshly constructed
// interface markup, before any game/user content is inserted. Never scan messages.
export function registerStaticUI(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){
  const node=walker.currentNode;
  if(node.parentElement?.closest('script,style,pre,code,#messages,[data-user-content]'))continue;
  if(/[А-Яа-яЁё]/u.test(node.nodeValue)){const source=node.nodeValue;texts.set(node,{source,rendered:source});}
 }
 for(const element of [root,...root.querySelectorAll('*')])if(element.getAttribute)for(const name of ['title','placeholder','aria-label']){
  const source=element.getAttribute(name);if(source&&/[А-Яа-яЁё]/u.test(source)){const records=attributes.get(element)||[];if(!records.some(record=>record.name===name))records.push({element,name,source,rendered:source});attributes.set(element,records);}
 }
 applyStaticUI();
}
function applyStaticUI(){
 for(const [node,record] of texts){if(!node.isConnected||node.nodeValue!==record.rendered){texts.delete(node);continue;}record.rendered=t(record.source);node.nodeValue=record.rendered;}
 for(const [element,records] of attributes){if(!element.isConnected){attributes.delete(element);continue;}for(const record of records){if(element.getAttribute(record.name)!==record.rendered)continue;record.rendered=t(record.source);element.setAttribute(record.name,record.rendered);}}
}
export async function selectInterfaceLanguage(value){
 const next=normalizeInterfaceLanguage(value);
 if(next!=='ru'&&!catalogs[next]){const response=await fetch('/room-locales/'+next+'.json',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Language file unavailable');catalogs[next]=await response.json();}
 language=next;try{localStorage.setItem(languageStorageKey,next);}catch{}
 document.documentElement.lang=language;applyStaticUI();window.dispatchEvent(new Event('sas:interface-language'));
}
export async function mountInterfaceLanguage(){
 const select=document.querySelector('[name="interfaceLanguage"]');
 if(select){select.replaceChildren(...interfaceLanguages.map(item=>new Option(item.label,item.id)));select.onchange=async()=>{select.disabled=true;try{await selectInterfaceLanguage(select.value);}catch{select.value=language;}finally{select.disabled=false;}};}
 let saved;try{saved=localStorage.getItem(languageStorageKey);}catch{}
 await selectInterfaceLanguage(saved).catch(()=>{});registerStaticUI(document.body);if(select)select.value=language;
}
