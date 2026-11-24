import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {readGguf} from './gguf.mjs';

const stage='Подготовка совместимой копии Qwen3.5';
const ollamaRefusal='Этот GGUF Qwen3.5 собран для Ollama в варианте, который SAS не может безопасно преобразовать. Исходный файл не изменён. Выберите GGUF, сконвертированный llama.cpp (обычно он есть в исходном репозитории модели).';
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const text=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const int=(item,n)=>{const b=Buffer.alloc(4);item===4?b.writeUInt32LE(n):b.writeInt32LE(n);return b;};
const widths={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};

// Full header walk for rewriting: every key/value keeps its raw bytes so it can be
// re-emitted unchanged. Only small integer arrays and scalars are decoded.
export function parseGgufHeader(buffer){
  let position=0;
  const need=n=>{if(!Number.isSafeInteger(n)||n<0||position+n>buffer.length)throw new Error('Неполный заголовок GGUF.');};
  const read32=()=>{need(4);const v=buffer.readUInt32LE(position);position+=4;return v;};
  const read64=()=>{need(8);const v=Number(buffer.readBigUInt64LE(position));position+=8;return v;};
  const string=()=>{const n=read64();need(n);const s=buffer.toString('utf8',position,position+n);position+=n;return s;};
  const value=type=>{
    if(type===8){string();return;}
    if(type===9){
      const item=read32(),count=read64();
      if(item===8){for(let i=0;i<count;i++)string();return {item};}
      if(!widths[item])throw new Error('Неполный заголовок GGUF.');
      const at=position;need(widths[item]*count);position+=widths[item]*count;
      return {item,values:[4,5].includes(item)&&count<=4096?Array.from({length:count},(_,i)=>item===4?buffer.readUInt32LE(at+i*4):buffer.readInt32LE(at+i*4)):undefined};
    }
    if(!widths[type])throw new Error('Неполный заголовок GGUF.');
    const at=position;need(widths[type]);position+=widths[type];
    return type===7?buffer[at]!==0:type===4?buffer.readUInt32LE(at):type===5?buffer.readInt32LE(at):undefined;
  };
  if(buffer.toString('latin1',0,4)!=='GGUF')throw new Error('Неполный заголовок GGUF.');
  position=4;const version=read32(),tensorCount=read64(),keyCount=read64(),entries=[],tensors=[];
  for(let i=0;i<keyCount;i++){const start=position,key=string(),type=read32(),parsed=value(type);entries.push({key,type,value:parsed,raw:buffer.subarray(start,position)});}
  for(let i=0;i<tensorCount;i++){const name=string(),count=read32();if(count>8)throw new Error('Неполный заголовок GGUF.');const dims=[];for(let j=0;j<count;j++)dims.push(read64());const type=read32(),offset=read64();tensors.push({name,dims,type,offset});}
  return {version,entries,tensors,end:position};
}

// The upstream Qwen3.5 loader requires four MRoPE sections; this layout wrote
// [temporal, height, width]. A zero fourth section is the canonical form.
function mropePlan(info,header,size){
  const layout=info.ropeSectionsLayout,end=layout.offset+layout.bytes;
  const fixed=Buffer.concat([header.subarray(0,end),Buffer.alloc(4),header.subarray(end)]);
  fixed.writeBigUInt64LE(4n,layout.offset+4);
  const dataStart=Math.ceil(fixed.length/info.alignment)*info.alignment;
  return {header:Buffer.concat([fixed,Buffer.alloc(dataStart-fixed.length)]),ranges:[[info.dataStart,size]],expectedSize:dataStart+size-info.dataStart,parameters:info.parameterCount};
}

// Ollama's single-file Qwen3.5 build. Its text weights are byte-identical to the
// llama.cpp conversion (checked tensor by tensor against
// HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive Q4_K_M), but it packs vision
// (v.*) and MTP (mtp.*) tensors into the same file, names the SSM dt bias without
// ".bias", lists KV heads per layer and adds Ollama-only keys. The copy keeps text
// tensor bytes as they are; anything outside this exact layout is refused.
const canonicalTensor=/^(?:token_embd\.weight|output_norm\.weight|output\.weight|blk\.\d+\.(?:attn_(?:gate|norm|qkv|k|k_norm|q|q_norm|v|output)\.weight|ffn_(?:down|gate|up)\.weight|post_attention_norm\.weight|ssm_a|ssm_dt\.bias|ssm_(?:alpha|beta|conv1d|norm|out)\.weight))$/;
function ollamaPlan(info,header,size){
  const fail=()=>{throw new Error(ollamaRefusal);};
  const arch=info.architecture,layers=info.layers;
  // v_head_reordered=true marks the V-head order llama.cpp expects; without it the bytes are not known to match.
  if(arch!=='qwen35'||info.splitCount!==1||!info.ollamaLayout.vHeadReordered||!(layers>0))fail();
  const parsed=parseGgufHeader(header),find=key=>parsed.entries.find(e=>e.key===arch+'.'+key);
  const interval=find('full_attention_interval')?.value;
  if(!Number.isInteger(interval)||interval<1||!find('rope.dimension_sections'))fail();
  const ollamaOnly=key=>key.startsWith(arch+'.vision.')||['general.parameter_count',...['mrope_sections','rope.mrope_section','rope.mrope_interleaved','ssm.v_head_reordered','image_token_id','vision_start_token_id','vision_end_token_id'].map(k=>arch+'.'+k)].includes(key);
  const entries=[];
  for(const entry of parsed.entries){
    if(ollamaOnly(entry.key))continue;
    const item=entry.value?.item,values=entry.value?.values;
    if(entry.key===arch+'.rope.dimension_sections'){
      if(entry.type!==9||!values||!(values.length===3||values.length===4&&values[3]===0)||!values.every(n=>Number.isInteger(n)&&n>=0)||!values.some(n=>n>0))fail();
      entries.push(Buffer.concat([text(entry.key),u32(9),u32(item),u64(4),...[...values.slice(0,3),0].map(n=>int(item,n))]));continue;
    }
    if(entry.key===arch+'.attention.head_count_kv'&&entry.type===9){
      // llama.cpp writes one KV head count; Ollama repeats it per layer with zeros for recurrent layers.
      const heads=values?.find(n=>n>0);
      if(!values||values.length!==layers||!heads||values.some((n,i)=>n!==((i+1)%interval===0?heads:0)))fail();
      entries.push(Buffer.concat([text(entry.key),u32(item),int(item,heads)]));continue;
    }
    entries.push(entry.raw);
  }
  const data=size-info.dataStart,ordered=[...parsed.tensors].sort((a,b)=>a.offset-b.offset);
  ordered.forEach((t,i)=>{t.bytes=(i+1<ordered.length?ordered[i+1].offset:data)-t.offset;if(t.offset%info.alignment||t.bytes<=0)fail();});
  const kept=[];
  for(const t of parsed.tensors){
    if(t.name.startsWith('v.')||t.name.startsWith('mtp.'))continue;
    const name=/^blk\.\d+\.ssm_dt$/.test(t.name)?t.name+'.bias':t.name,layer=name.match(/^blk\.(\d+)\./);
    if(!canonicalTensor.test(name)||layer&&Number(layer[1])>=layers)fail();
    kept.push({...t,name});
  }
  if(!kept.length||new Set(kept.map(t=>t.name)).size!==kept.length)fail();
  let next=0;const ranges=[];
  for(const t of [...kept].sort((a,b)=>a.offset-b.offset)){
    t.target=next;next+=t.bytes;
    const start=info.dataStart+t.offset,last=ranges.at(-1);
    if(last&&last[1]===start)last[1]+=t.bytes;else ranges.push([start,start+t.bytes]);
  }
  const body=Buffer.concat([Buffer.from('GGUF'),u32(parsed.version),u64(kept.length),u64(entries.length),...entries,...kept.map(t=>Buffer.concat([text(t.name),u32(t.dims.length),...t.dims.map(u64),u32(t.type),u64(t.target)]))]);
  const dataStart=Math.ceil(body.length/info.alignment)*info.alignment;
  return {header:Buffer.concat([body,Buffer.alloc(dataStart-body.length)]),ranges,expectedSize:dataStart+next,parameters:kept.reduce((sum,t)=>sum+t.dims.reduce((a,b)=>a*b,1),0)};
}

// Only the two precisely identified Qwen3.5 layouts above are rewritten. Never modify source weights.
export async function compatibleGguf(modelPath,cacheDir,{signal,onProgress=()=>{}}={}){
  signal?.throwIfAborted();
  const info=await readGguf(modelPath),directory=path.resolve(cacheDir);
  await pruneCompatibilityCache(directory).catch(()=>{});
  if(!['qwen35','qwen35moe'].includes(info.architecture))return {modelPath,info};
  const repair=info.ollamaLayout?'qwen35-ollama':info.ropeSections?.length===3?'qwen35-mrope-4':'';
  if(!repair)return {modelPath,info};
  if(repair==='qwen35-mrope-4'){
    if(info.splitCount!==1)throw new Error('Этот разделённый GGUF Qwen3.5 содержит устаревший MRoPE-заголовок. Выберите свежую конвертацию с четырьмя rope.dimension_sections.');
    if(!info.ropeSections.every(n=>Number.isInteger(n)&&n>=0)||!info.ropeSections.some(n=>n>0))throw new Error('Некорректные секции MRoPE Qwen3.5. Загрузите исправленную конвертацию GGUF.');
  }
  const original=await fs.stat(modelPath),handle=await fs.open(modelPath,'r');let header;
  try{header=Buffer.alloc(info.headerSize);const {bytesRead}=await handle.read(header,0,header.length,0);if(bytesRead!==header.length)throw new Error('Неполный заголовок GGUF.');}finally{await handle.close();}
  const plan=repair==='qwen35-ollama'?ollamaPlan(info,header,original.size):mropePlan(info,header,original.size);
  // The MRoPE identity is unchanged so copies made before the Ollama repair stay valid.
  const hash=crypto.createHash('sha256').update(path.resolve(modelPath)).update(String(original.size)).update(String(original.mtimeMs)).update(header);
  if(repair!=='qwen35-mrope-4')hash.update(repair);
  const identity=hash.digest('hex'),target=path.join(directory,identity+'.gguf'),receipt=target+'.json';
  try{const saved=JSON.parse(await fs.readFile(receipt,'utf8'));if(saved.identity===identity&&(await fs.stat(target)).size===plan.expectedSize){const cached=await readGguf(target),file=await fs.open(target,'r');try{const bytes=Buffer.alloc(plan.header.length),read=await file.read(bytes,0,bytes.length,0);if(read.bytesRead===plan.header.length&&bytes.equals(plan.header))return {modelPath:target,info:cached,compatibility:repair,cached:true};}finally{await file.close();}}}catch{}
  signal?.throwIfAborted();await fs.mkdir(directory,{recursive:true});
  const space=await fs.statfs(directory);if(Number(space.bavail)*Number(space.bsize)<plan.expectedSize+64*1024*1024)throw new Error('Недостаточно места для совместимой копии GGUF Qwen3.5. Исходный файл не изменён. Освободите место или выберите исправленную конвертацию.');
  const part=target+'.'+crypto.randomUUID()+'.part';
  try{
    onProgress({stage,total:plan.expectedSize,downloaded:0});
    const output=await fs.open(part,'wx');try{await output.writeFile(plan.header);}finally{await output.close();}
    let written=plan.header.length,lastProgress=0;
    for(const [start,end] of plan.ranges){
      const stream=createReadStream(modelPath,{start,end:end-1});
      stream.on('data',chunk=>{written+=chunk.length;if(Date.now()-lastProgress>250){lastProgress=Date.now();onProgress({stage,total:plan.expectedSize,downloaded:written});}});
      await pipeline(stream,createWriteStream(part,{flags:'a'}),{signal});
    }
    const after=await fs.stat(modelPath);
    if(after.size!==original.size||after.mtimeMs!==original.mtimeMs||written!==plan.expectedSize)throw new Error('GGUF изменился во время подготовки. Повторите запуск после завершения загрузки.');
    const check=await readGguf(part);
    if(check.architecture!==info.architecture||check.ollamaLayout||check.ropeSections?.length!==4||check.ropeSections.at(-1)!==0||check.parameterCount!==plan.parameters||check.size!==plan.expectedSize)throw new Error('Проверка совместимого GGUF не пройдена.');
    await fs.rename(part,target);await fs.writeFile(receipt,JSON.stringify({identity,size:plan.expectedSize,repair,source:path.resolve(modelPath),sourceSize:original.size,sourceMtimeMs:original.mtimeMs}));
    return {modelPath:target,info:check,compatibility:repair,cached:false};
  }finally{await fs.unlink(part).catch(()=>{});}
}

// Copies are keyed by source path, size and mtime, so a moved, replaced or deleted
// model would otherwise leave an orphan the size of the model. Receipts without a
// source (written before this was tracked) are left alone, as are sources on a
// drive that is not currently attached. A .part untouched for hours was abandoned
// by a killed process; an active copy rewrites its .part continuously.
export async function pruneCompatibilityCache(directory,now=Date.now()){
  const names=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;}),removed=[];
  for(const name of names){
    const file=path.join(directory,name);
    if(name.endsWith('.part')){const stat=await fs.stat(file).catch(()=>null);if(stat?.isFile()&&now-stat.mtimeMs>6*3600000&&await fs.unlink(file).then(()=>true,()=>false))removed.push(name);continue;}
    if(!name.endsWith('.gguf.json'))continue;
    let saved;try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
    if(typeof saved?.source!=='string'||!path.isAbsolute(saved.source))continue;
    if(!await fs.stat(path.parse(saved.source).root).then(()=>true,()=>false))continue;
    const source=await fs.stat(saved.source).catch(error=>['ENOENT','ENOTDIR'].includes(error.code)?null:undefined);
    if(source===undefined||source&&source.size===saved.sourceSize&&source.mtimeMs===saved.sourceMtimeMs)continue;
    // A copy still opened by a running engine cannot be removed on Windows; keep its receipt for the next pass.
    if(await fs.unlink(file.slice(0,-5)).then(()=>true,error=>error.code==='ENOENT')){await fs.unlink(file).catch(()=>{});removed.push(name.slice(0,-5));}
  }
  return removed;
}

export async function modelCompatibilityCache(dataDir){
  let modelsDir=path.join(dataDir,'models');
  try{const storage=JSON.parse(await fs.readFile(path.join(dataDir,'model-storage.json'),'utf8'));if(typeof storage.modelsDir==='string'&&path.isAbsolute(storage.modelsDir))modelsDir=storage.modelsDir;}catch(error){if(error.code!=='ENOENT')throw new Error('Не удалось прочитать model-storage.json для подготовки совместимого GGUF.');}
  return path.join(modelsDir,'.sas-compat');
}

export function modelLoadError(logs,code){
  const text=Array.isArray(logs)?logs.join('\n'):String(logs);
  if(/rope\.dimension_sections.*(?:wrong array length|expected 4)/i.test(text))return 'Несовместимый MRoPE-заголовок GGUF Qwen3.5: движок ожидает 4 секции. Выберите исправленную конвертацию GGUF; уменьшение контекста и слоёв GPU эту ошибку не исправит. Подробности в журнале.';
  if(/check_tensor_dims: tensor '[^']*' (?:not found|has wrong shape)|wrong number of tensors|missing tensor '/i.test(text))return 'Набор тензоров GGUF не совпадает с тем, что ожидает движок llama.cpp: файл собран другим конвертером (например, для Ollama) или для другой версии движка. Уменьшение контекста и слоёв GPU это не исправит. Выберите GGUF, сконвертированный llama.cpp. Подробности в журнале.';
  if(/unknown model architecture|unsupported (?:model |GGUF )?architecture/i.test(text))return 'Архитектура GGUF не поддерживается установленным движком llama.cpp. Требуется совместимая версия движка или модели. Подробности в журнале.';
  if(/out of memory|failed to allocate|not enough (?:device )?memory|cudaMalloc|VK_ERROR_OUT_OF_DEVICE_MEMORY/i.test(text))return 'Для загрузки модели недостаточно памяти. Уменьшите контекст или число слоёв на GPU либо выберите меньшую модель. Подробности в журнале.';
  return `Модель завершилась с кодом ${code}. Откройте журнал загрузки, чтобы узнать причину.`;
}
