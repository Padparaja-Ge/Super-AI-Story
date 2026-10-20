import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {battlemapPreset} from '../shared/battlemap-preset.mjs';

async function digest(file){const hash=crypto.createHash('sha256'),handle=await fs.open(file);try{for await(const chunk of handle.createReadStream())hash.update(chunk);return hash.digest('hex');}finally{await handle.close();}}
export async function installBattlemapAssets(directory,{signal,onProgress=()=>{},fetcher=fetch,files=battlemapPreset.files}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Укажите полный путь к папке ComfyUI на компьютере сервера SAS.');
  const root=await fs.realpath(directory);
  await fs.access(path.join(root,'main.py'));
  await fs.access(path.join(root,'models'));
  const installed=[];
  for(const asset of files){
    signal?.throwIfAborted();
    const folder=path.join(root,'models',asset.directory);await fs.mkdir(folder,{recursive:true});
    const resolved=await fs.realpath(folder);if(!resolved.startsWith(root+path.sep))throw new Error('Каталог моделей должен находиться внутри выбранного ComfyUI.');
    const destination=path.join(resolved,asset.name);
    if(path.basename(asset.name)!==asset.name)throw new Error('Некорректное имя файла модели.');
    try{await fs.lstat(destination);if(await digest(destination)===asset.sha256){installed.push(destination);onProgress(asset.name+' уже установлен');continue;}throw new Error('Файл '+asset.name+' уже существует с другим содержимым. Переименуйте его перед установкой.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=destination+'.sas-'+crypto.randomUUID()+'.part',hash=crypto.createHash('sha256');let handle;
    try{
      const response=await fetcher(asset.url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)]):AbortSignal.timeout(30*60*1000)});
      if(!response.ok)throw new Error('Загрузка '+asset.name+': HTTP '+response.status+'. Можно скачать файл по ссылке источника и поместить его в models/'+asset.directory+'.');
      handle=await fs.open(temporary,'wx');let bytes=0,last=-1;
      for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>asset.bytes+1024)throw new Error('Сервис вернул неожиданный размер '+asset.name);hash.update(chunk);await handle.writeFile(chunk);const percent=Math.floor(bytes/asset.bytes*100);if(percent!==last){onProgress(asset.name+' · '+percent+'%');last=percent;}}
      await handle.close();handle=null;
      if(bytes!==asset.bytes||hash.digest('hex')!==asset.sha256)throw new Error('Не совпала контрольная сумма '+asset.name+'. Файл не установлен.');
      // Link publishes only if the destination does not exist; never replace a user's file.
      await fs.link(temporary,destination);await fs.unlink(temporary);installed.push(destination);
    }finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return {preset:battlemapPreset.name,directory:root,files:installed};
}
