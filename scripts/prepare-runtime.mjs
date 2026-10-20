import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

// Windows may provide an 8.3 alias; cleanup compares physical parent paths.
const root=await fs.realpath(path.resolve(import.meta.dirname,'..'));
const at=process.argv.indexOf('--archive'),filename=at>=0?process.argv[at+1]:null;
if(!filename)throw new Error('Usage: npm run prepare:runtime -- --archive <SAS-Windows-version.zip>. No downloads are performed.');
const file=path.resolve(filename),stat=await fs.stat(file);
if(!stat.isFile()||stat.size>=2**31)throw new Error('Invalid runtime archive size.');
const zip=new AdmZip(file),payload=zip.getEntry('.sas-payload.json');
if(!payload||payload.header.size>5_000_000)throw new Error('Missing runtime manifest.');
const manifest=JSON.parse(payload.getData().toString('utf8'));
if(manifest.format!==2||manifest.repository!=='Padparaja-Ge/Super-AI-Story'||!Array.isArray(manifest.files)||manifest.files.length>20000)throw new Error('Unsupported runtime manifest.');
const files=manifest.files.filter(item=>item.path.startsWith('engines/'));
if(!files.length)throw new Error('No engines in archive.');
const names=new Set();
const relative=value=>{
 if(typeof value!=='string'||!value.startsWith('engines/')||value.includes('\\')||/[:\x00-\x1f]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe runtime path.');
 return value.slice('engines/'.length);
};
for(const item of files){relative(item.path);if(names.has(item.path.toLowerCase())||!Number.isSafeInteger(item.size)||item.size<0||item.size>2**31||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('Invalid runtime entry.');names.add(item.path.toLowerCase());}
const entries=zip.getEntries().filter(item=>!item.isDirectory&&item.entryName.startsWith('engines/'));
if(entries.length!==files.length||new Set(entries.map(item=>item.entryName.toLowerCase())).size!==entries.length)throw new Error('Unexpected or duplicate engine entries.');
const stage=path.join(root,'.runtime-prepare-'+crypto.randomUUID()),target=path.join(root,'runtime');
async function rejectLinks(folder){
 let current=path.parse(path.resolve(folder)).root;
 for(const part of path.resolve(folder).slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const info=await fs.lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(info?.isSymbolicLink())throw new Error('Runtime destination must not contain links.');
 }
}
await rejectLinks(target);await fs.mkdir(stage);
try{
 let index=0;
 for(const item of files){
  const entry=zip.getEntry(item.path);if(!entry||entry.header.size!==item.size)throw new Error('Runtime size mismatch: '+item.path);
  const data=entry.getData();if(crypto.createHash('sha256').update(data).digest('hex')!==item.sha256)throw new Error('Runtime checksum mismatch: '+item.path);
  const output=path.resolve(stage,relative(item.path));if(!output.startsWith(stage+path.sep))throw new Error('Runtime path outside staging.');
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,data);
  if(++index%250===0)console.log('Verified '+index+'/'+files.length+' runtime files');
 }
 // Check every existing destination component before copying; do not follow links.
 for(const item of files)await rejectLinks(path.join(target,relative(item.path)));
 await fs.cp(stage,target,{recursive:true,force:true});
 console.log(JSON.stringify({runtime:target,sourceVersion:manifest.version,verifiedFiles:files.length}));
}finally{
 const resolved=await fs.realpath(stage);
 if(path.dirname(resolved).toLowerCase()!==root.toLowerCase()||!path.basename(resolved).startsWith('.runtime-prepare-'))throw new Error('Unsafe staging cleanup.');
 await fs.rm(resolved,{recursive:true,force:true,maxRetries:3});
}
