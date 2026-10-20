import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {extensionPackage} from '../server/extensions.mjs';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw new Error('node scripts/package-extension.mjs <папка> <выходной.zip>');
const root=path.resolve(source),target=path.resolve(output),zip=new AdmZip();
async function visit(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const name=path.join(folder,entry.name),rel=path.relative(root,name).replaceAll('\\','/');if(entry.isSymbolicLink())throw new Error('Ссылка в расширении: '+rel);if(entry.isDirectory())await visit(name);else if(name!==target)zip.addFile(rel,await fs.readFile(name));}}
await visit(root);const bytes=zip.toBuffer();extensionPackage({zip:bytes.toString('base64')});await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);console.log(target+' · '+bytes.length+' bytes');
