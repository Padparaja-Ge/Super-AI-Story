import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';

const invalid=message=>Object.assign(new Error(message),{status:502,invalidDownload:true});
// A slow download is allowed to continue as long as bytes are arriving. The
// partial is tied to the release digest by the caller and verified before use.
export async function downloadRoomBinary({file,size,sha256,fetchResponse,signal,idleMs=90000,attempts=3,onProgress=()=>{},onRetry=()=>{}}){
 for(let attempt=0;attempt<attempts;attempt++){
  signal?.throwIfAborted();const previous=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous&&(!previous.isFile()||previous.isSymbolicLink()||previous.size>size))throw invalid('Временный файл сетевого компонента повреждён.');
  let received=previous?.size||0;onProgress(received,size);if(received===size)break;
  const idle=new AbortController(),combined=signal?AbortSignal.any([signal,idle.signal]):idle.signal;let timer,handle,reader,response;
  const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(new DOMException('Сервер загрузки долго не передаёт данные.','TimeoutError')),idleMs);};
  let abort;const aborted=new Promise((_,reject)=>{abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});});
  try{
   touch();response=await Promise.race([fetchResponse(received,combined),aborted]);
   if(response.status===206){const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(!range||Number(range[1])!==received||Number(range[3])!==size||Number(range[2])<received||Number(range[2])>=size)throw invalid('Сервер вернул неверный диапазон сетевого компонента.');}
   else if(response.status===200){received=0;onProgress(0,size);}
   else throw invalid('Не удалось загрузить сетевой компонент: HTTP '+response.status);
   if(Number(response.headers.get('content-length'))>size-received)throw invalid('Размер сетевого компонента не совпадает с релизом.');
   if(!response.body)throw new Error('Сервер не вернул файл сетевого компонента.');
   handle=await fs.open(file,received?'a':'w');reader=response.body.getReader();touch();
   for(;;){const next=await Promise.race([reader.read(),aborted]);if(next.done)break;received+=next.value.byteLength;if(received>size)throw invalid('Размер сетевого компонента не совпадает с релизом.');await handle.writeFile(next.value);onProgress(received,size);touch();}
   await handle.sync();if(received!==size)throw new Error('Загрузка сетевого компонента оборвалась.');break;
  }catch(error){
   if(error.invalidDownload){await handle?.close();handle=null;await fs.unlink(file).catch(()=>{});throw error;}
   signal?.throwIfAborted();if(attempt===attempts-1)throw Object.assign(new Error('Загрузка сетевого компонента прервана. Загруженная часть сохранена; повторите установку для продолжения.'),{status:504});onRetry(attempt+1);
  }finally{clearTimeout(timer);combined.removeEventListener('abort',abort);if(reader)await reader.cancel().catch(()=>{});else await response?.body?.cancel().catch(()=>{});await handle?.close();}
 }
 signal?.throwIfAborted();const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file)){signal?.throwIfAborted();hash.update(chunk);}
 if(hash.digest('hex')!==sha256){await fs.unlink(file).catch(()=>{});throw invalid('SHA256 cloudflared не совпала с официальным релизом. Файл не установлен.');}
}
