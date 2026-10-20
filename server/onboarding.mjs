import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {guidePreferences} from '../shared/onboarding.mjs';

export function createGuidePreferences(dataDir){
 const file=path.join(dataDir,'beginner-guide.json');let queue=Promise.resolve();
 const read=async()=>{await queue;try{return guidePreferences(JSON.parse(await fs.readFile(file,'utf8')));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const write=input=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||['enabled','welcomed','completed'].some(key=>input[key]!==undefined&&typeof input[key]!=='boolean')||input.step!==undefined&&!Number.isInteger(input.step))throw Object.assign(new Error('Неверная настройка обучения.'),{status:400});
  const next=guidePreferences(input),work=queue.then(async()=>{await fs.mkdir(dataDir,{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(next),{flag:'wx'});for(let i=0;;i++){try{await fs.rename(temporary,file);break;}catch(error){if(!['EPERM','EBUSY'].includes(error.code)||i===5)throw error;await new Promise(resolve=>setTimeout(resolve,20*2**i));}}}finally{await fs.unlink(temporary).catch(()=>{});}return next;});queue=work.catch(()=>{});return work;
 };return {read,write};
}
