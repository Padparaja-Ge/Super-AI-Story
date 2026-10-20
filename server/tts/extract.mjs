import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
const archive=new AdmZip(process.argv[2]),root=path.resolve(process.argv[3]),entries=archive.getEntries();
if(entries.length>20000||entries.reduce((n,e)=>n+e.header.size,0)>200000000)throw new Error('Архив движка слишком большой.');
for(const entry of entries){const name=entry.entryName.replaceAll('\\','/'),target=path.resolve(root,name),relative=path.relative(root,target);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||((entry.header.attr>>>16)&0xf000)===0xa000)throw new Error('Недопустимый путь в архиве.');if(entry.isDirectory)fs.mkdirSync(target,{recursive:true});else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.getData());}}
