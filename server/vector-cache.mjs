import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-vector binary persistence avoids rewriting a huge JSON cache after every
// turn and avoids re-embedding old campaign events when the RAM LRU is full.
export function createVectorCache({dataDir,maxMemoryEntries=1024}){
 const root=path.join(dataDir,'embedding-vectors'),hot=new Map();let legacy=new Map();
 const statistics={memoryHits:0,diskHits:0,legacyHits:0,misses:0,writes:0};
 const ready=(async()=>{await fs.mkdir(root,{recursive:true});if((await fs.lstat(root)).isSymbolicLink())throw new Error('Каталог векторного кэша не должен быть ссылкой.');try{const file=path.join(dataDir,'embeddings-cache.json'),stat=await fs.stat(file);if(stat.size<128_000_000){const data=JSON.parse(await fs.readFile(file,'utf8'));if(Array.isArray(data))legacy=new Map(data);}}catch(e){if(e.code!=='ENOENT'&&e.name!=='SyntaxError')throw e;}})();ready.catch(()=>{});
 const valid=v=>Array.isArray(v)&&v.length>0&&v.length<=16384&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
 const filename=key=>{if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Неверный ключ векторного кэша.');return path.join(root,key.slice(0,2),key+'.vec');};
 function remember(key,vector){hot.delete(key);hot.set(key,vector);while(hot.size>maxMemoryEntries)hot.delete(hot.keys().next().value);}
 async function parallel(values,fn){let cursor=0;await Promise.all(Array.from({length:Math.min(16,values.length)},async()=>{while(cursor<values.length){const i=cursor++;await fn(values[i]);}}));}
 async function write(key,vector,signal){
  signal?.throwIfAborted();if(!valid(vector))throw new Error('Некорректный вектор кэша.');const file=filename(key),bytes=Buffer.alloc(12+vector.length*8);bytes.write('SASVEC01');bytes.writeUInt32LE(vector.length,8);vector.forEach((v,i)=>bytes.writeDoubleLE(v,12+i*8));await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw new Error('Ссылка в векторном кэше.');const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});try{for(let i=0;;i++){try{await fs.rename(temp,file);break;}catch(e){if(!['EPERM','EBUSY'].includes(e.code)||i===6)throw e;await new Promise(r=>setTimeout(r,20*2**i));}}}finally{await fs.unlink(temp).catch(()=>{});}statistics.writes++;
 }
 async function readMany(keys,signal){
  await ready;const result=new Map(),migrate=[];
  await parallel([...new Set(keys)],async key=>{
   signal?.throwIfAborted();let vector=hot.get(key);
   if(vector){statistics.memoryHits++;remember(key,vector);result.set(key,vector);return;}
   const file=filename(key);
   try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<20||stat.size>131084)throw new Error('Повреждён векторный кэш.');const data=await fs.readFile(file),length=data.readUInt32LE(8);if(data.subarray(0,8).toString()!=='SASVEC01'||length>16384||data.length!==12+length*8)throw new Error('Неверный формат кэша.');vector=Array.from({length},(_,i)=>data.readDoubleLE(12+i*8));if(!valid(vector))throw new Error('Некорректные значения кэша.');statistics.diskHits++;}
   catch(e){if(e.code==='EACCES'||e.code==='EPERM')throw e;vector=legacy.get(key);if(valid(vector)){statistics.legacyHits++;migrate.push([key,vector]);legacy.delete(key);}else{statistics.misses++;return;}}
   result.set(key,vector);remember(key,vector);
  });
  await parallel(migrate,async([key,v])=>write(key,v,signal));return result;
 }
 async function writeMany(entries,signal){await ready;await parallel(entries,async([key,v])=>{await write(key,v,signal);remember(key,v);});}
 async function invalidate(keys){await ready;await parallel(keys,async key=>{hot.delete(key);legacy.delete(key);await fs.unlink(filename(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});});}
 return {readMany,writeMany,invalidate,stats:()=>({...statistics,memoryEntries:hot.size})};
}
