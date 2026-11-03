import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {readGguf} from './gguf.mjs';

// The upstream Qwen3.5 loader requires four MRoPE sections; older converters
// wrote [temporal, height, width]. A zero fourth section is the canonical form.
// Only this precisely identified layout is repaired. Never modify source weights.
export async function compatibleGguf(modelPath,cacheDir,{signal,onProgress=()=>{}}={}){
  signal?.throwIfAborted();
  const info=await readGguf(modelPath);
  if(!['qwen35','qwen35moe'].includes(info.architecture)||info.ropeSections?.length!==3)return {modelPath,info};
  if(info.splitCount!==1)throw new Error('Этот разделённый GGUF Qwen3.5 содержит устаревший MRoPE-заголовок. Выберите свежую конвертацию с четырьмя rope.dimension_sections.');
  if(!info.ropeSections.every(n=>Number.isInteger(n)&&n>=0)||!info.ropeSections.some(n=>n>0))throw new Error('Некорректные секции MRoPE Qwen3.5. Загрузите исправленную конвертацию GGUF.');
  const original=await fs.stat(modelPath),handle=await fs.open(modelPath,'r');let header;
  try{header=Buffer.alloc(info.headerSize);const {bytesRead}=await handle.read(header,0,header.length,0);if(bytesRead!==header.length)throw new Error('Неполный заголовок GGUF.');}finally{await handle.close();}
  const identity=crypto.createHash('sha256').update(path.resolve(modelPath)).update(String(original.size)).update(String(original.mtimeMs)).update(header).digest('hex');
  const directory=path.resolve(cacheDir),target=path.join(directory,identity+'.gguf'),receipt=target+'.json';
  const layout=info.ropeSectionsLayout,end=layout.offset+layout.bytes;
  const fixed=Buffer.concat([header.subarray(0,end),Buffer.alloc(4),header.subarray(end)]);
  fixed.writeBigUInt64LE(4n,layout.offset+4);
  const dataStart=Math.ceil(fixed.length/info.alignment)*info.alignment,expectedSize=dataStart+original.size-info.dataStart;
  try{const saved=JSON.parse(await fs.readFile(receipt,'utf8'));if(saved.identity===identity&&(await fs.stat(target)).size===expectedSize){const cached=await readGguf(target),file=await fs.open(target,'r');try{const bytes=Buffer.alloc(fixed.length),read=await file.read(bytes,0,bytes.length,0);if(read.bytesRead===fixed.length&&bytes.equals(fixed))return {modelPath:target,info:cached,compatibility:'qwen35-mrope-4',cached:true};}finally{await file.close();}}}catch{}
  signal?.throwIfAborted();await fs.mkdir(directory,{recursive:true});
  const space=await fs.statfs(directory);if(Number(space.bavail)*Number(space.bsize)<expectedSize+64*1024*1024)throw new Error('Недостаточно места для совместимой копии GGUF Qwen3.5. Исходный файл не изменён. Освободите место или выберите исправленную конвертацию.');
  const part=target+'.'+crypto.randomUUID()+'.part';
  try{
    onProgress({stage:'Подготовка совместимой копии Qwen3.5',total:expectedSize,downloaded:0});
    const output=await fs.open(part,'wx');try{await output.writeFile(Buffer.concat([fixed,Buffer.alloc(dataStart-fixed.length)]));}finally{await output.close();}
    let written=dataStart,lastProgress=0;
    const stream=createReadStream(modelPath,{start:info.dataStart});
    stream.on('data',chunk=>{written+=chunk.length;if(Date.now()-lastProgress>250){lastProgress=Date.now();onProgress({stage:'Подготовка совместимой копии Qwen3.5',total:expectedSize,downloaded:written});}});
    await pipeline(stream,createWriteStream(part,{flags:'a'}),{signal});
    const after=await fs.stat(modelPath);
    if(after.size!==original.size||after.mtimeMs!==original.mtimeMs||written!==expectedSize)throw new Error('GGUF изменился во время подготовки. Повторите запуск после завершения загрузки.');
    const check=await readGguf(part);
    if(check.ropeSections?.length!==4||check.ropeSections.at(-1)!==0||check.parameterCount!==info.parameterCount)throw new Error('Проверка совместимого GGUF не пройдена.');
    await fs.rename(part,target);await fs.writeFile(receipt,JSON.stringify({identity,size:expectedSize,repair:'qwen35-mrope-4'}));
    return {modelPath:target,info:check,compatibility:'qwen35-mrope-4',cached:false};
  }finally{await fs.unlink(part).catch(()=>{});}
}

export async function modelCompatibilityCache(dataDir){
  let modelsDir=path.join(dataDir,'models');
  try{const storage=JSON.parse(await fs.readFile(path.join(dataDir,'model-storage.json'),'utf8'));if(typeof storage.modelsDir==='string'&&path.isAbsolute(storage.modelsDir))modelsDir=storage.modelsDir;}catch(error){if(error.code!=='ENOENT')throw new Error('Не удалось прочитать model-storage.json для подготовки совместимого GGUF.');}
  return path.join(modelsDir,'.sas-compat');
}

export function modelLoadError(logs,code){
  const text=Array.isArray(logs)?logs.join('\n'):String(logs);
  if(/rope\.dimension_sections.*(?:wrong array length|expected 4)/i.test(text))return 'Несовместимый MRoPE-заголовок GGUF Qwen3.5: движок ожидает 4 секции. Выберите исправленную конвертацию GGUF; уменьшение контекста и слоёв GPU эту ошибку не исправит. Подробности в журнале.';
  if(/unknown model architecture|unsupported (?:model |GGUF )?architecture/i.test(text))return 'Архитектура GGUF не поддерживается установленным движком llama.cpp. Требуется совместимая версия движка или модели. Подробности в журнале.';
  if(/out of memory|failed to allocate|not enough (?:device )?memory|cudaMalloc|VK_ERROR_OUT_OF_DEVICE_MEMORY/i.test(text))return 'Для загрузки модели недостаточно памяти. Уменьшите контекст или число слоёв на GPU либо выберите меньшую модель. Подробности в журнале.';
  return `Модель завершилась с кодом ${code}. Откройте журнал загрузки, чтобы узнать причину.`;
}
