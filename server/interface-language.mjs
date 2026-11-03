import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {validInterfaceLanguage} from '../shared/ui-language.mjs';

// UI preferences persist independently of story autosave and changing desktop ports.
export function createInterfaceLanguage(dataDir){
 const file=path.join(dataDir,'interface-language.json');let queue=Promise.resolve();
 const read=async()=>{await queue;try{const value=JSON.parse(await fs.readFile(file,'utf8')).language;return validInterfaceLanguage(value)?value:null;}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const write=input=>{
  if(!input||!validInterfaceLanguage(input.language))throw Object.assign(new Error('Unsupported interface language.'),{status:400});
  const language=input.language;
  const work=queue.then(async()=>{await fs.mkdir(dataDir,{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify({language}),{flag:'wx'});for(let attempt=0;;attempt++){try{await fs.rename(temp,file);break;}catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt>=8)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(500,20*2**attempt)));}}}finally{await fs.unlink(temp).catch(()=>{});}return language;});queue=work.catch(()=>{});return work;
 };
 return {read,write};
}
