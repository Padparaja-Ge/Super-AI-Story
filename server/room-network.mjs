import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const RELEASE_API='https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const MAX_BINARY=100*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const fallback='Если прямое подключение не работает, используйте одну сеть или Radmin VPN: https://www.radmin-vpn.com/ . Укажите IP адаптера VPN в приглашении и проверьте брандмауэр. SAS не устанавливает VPN-драйвер и не эмулирует Ethernet.';
async function rename(from,to){for(let attempt=0;;attempt++)try{await fs.rename(from,to);return;}catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt===5)throw error;await new Promise(resolve=>setTimeout(resolve,30*2**attempt));}}
function officialURL(value){let url;try{url=new URL(value);}catch{throw fail('Некорректный адрес загрузки cloudflared.');}if(url.protocol!=='https:'||url.username||url.password||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw fail('Загрузка разрешена только из официального релиза Cloudflare на GitHub.');return url;}
async function limitedBody(response,limit){const chunks=[];let bytes=0;for await(const chunk of response.body||[]){bytes+=chunk.byteLength;if(bytes>limit){await response.body?.cancel().catch(()=>{});throw fail('Ответ сервера превышает допустимый размер.',502);}chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}

export function createRoomNetwork({dataDir,getRoom,diagnostics=()=>{},fetchImpl=globalThis.fetch,spawnImpl=spawn,platform=process.platform,arch=process.arch,startTimeoutMs=45000,roomCheckMs=1000}={}){
  if(!dataDir||typeof getRoom!=='function')throw new Error('Неверные настройки сети комнаты.');
  const directory=path.join(dataDir,'network'),manifestFile=path.join(directory,'cloudflared.json');
  let installation=null,installing=false,downloadBytes=0,downloadTotal=0,installAbort,installPromise,child=null,roomWatch,childExit,startingPromise,stoppingPromise,startCancel,startEpoch=0,closed=false;
  let tunnel={state:'stopped',url:'',roomId:'',error:''};
  const log=(event,details={})=>{try{diagnostics({scope:'room-network',event,...details});}catch{}};
  const ready=fs.readFile(manifestFile,'utf8').then(raw=>{if(raw.length>8192)return;const parsed=JSON.parse(raw);if(parsed.platform===platform&&parsed.arch===arch&&/^cloudflared-[A-Za-z0-9_.-]+(?:\.exe)?$/.test(parsed.file||'')&&/^[a-f0-9]{64}$/.test(parsed.sha256||'')&&Number.isSafeInteger(parsed.bytes)&&parsed.bytes>0&&parsed.bytes<=MAX_BINARY)installation=parsed;}).catch(()=>{});
  const status=()=>({installed:!!installation,version:installation?.version||'',supported:platform==='win32'&&['x64','arm64'].includes(arch),installing,downloadBytes,downloadTotal,tunnel:{...tunnel},fallback});
  async function officialFetch(value,signal){let url=officialURL(value);for(let count=0;count<6;count++){
    const response=await fetchImpl(url.href,{redirect:'manual',signal,headers:{'User-Agent':'SAS-Room-Network','Accept':url.hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'}});
    if([301,302,303,307,308].includes(response.status)){const target=response.headers.get('location');await response.body?.cancel().catch(()=>{});if(!target)throw fail('Некорректное перенаправление загрузки.',502);url=officialURL(new URL(target,url).href);continue;}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw fail('Не удалось загрузить cloudflared: HTTP '+response.status,502);}return response;
  }throw fail('Слишком много перенаправлений загрузки.',502);}
  function install(){if(installPromise)return installPromise;installPromise=(async()=>{
    await ready;if(closed)throw fail('Сетевой менеджер закрыт.');if(child||startingPromise)throw fail('Сначала остановите интернет-ссылку.',409);if(platform!=='win32'||!['x64','arm64'].includes(arch))throw fail('Установка из SAS доступна для Windows x64/ARM64. В других системах используйте локальную сеть или внешнюю настройку туннеля.');
    installing=true;downloadBytes=0;downloadTotal=0;installAbort=new AbortController();const signal=AbortSignal.any([installAbort.signal,AbortSignal.timeout(120000)]);let temporary;
    try{
      const response=await officialFetch(RELEASE_API,signal),release=JSON.parse((await limitedBody(response,2*1024*1024)).toString('utf8')),assetName='cloudflared-windows-'+(arch==='x64'?'amd64':'arm64')+'.exe';
      const asset=release.assets?.find(asset=>asset.name===assetName&&!asset.state?.includes('open'));
      if(!asset||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_BINARY||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw fail('В официальном релизе нет подходящего файла с проверяемой SHA256. Автоматическая установка отменена.',502);
      if(typeof release.tag_name!=='string'||!/^[-A-Za-z0-9_.]{1,40}$/.test(release.tag_name))throw fail('Некорректная версия cloudflared.',502);
      const download=officialURL(asset.browser_download_url);if(download.hostname!=='github.com'||!download.pathname.startsWith('/cloudflare/cloudflared/releases/download/'))throw fail('Файл не относится к официальному релизу Cloudflare.',502);
      await fs.mkdir(directory,{recursive:true});temporary=path.join(directory,'download-'+crypto.randomUUID()+'.tmp');const file=await fs.open(temporary,'wx');downloadTotal=asset.size;const hash=crypto.createHash('sha256');
      try{const binary=await officialFetch(download.href,signal);if(Number(binary.headers.get('content-length'))>MAX_BINARY){await binary.body?.cancel().catch(()=>{});throw fail('Файл cloudflared превышает 100 МБ.',502);}for await(const chunk of binary.body||[]){signal.throwIfAborted();downloadBytes+=chunk.byteLength;if(downloadBytes>MAX_BINARY||downloadBytes>asset.size)throw fail('Размер cloudflared не совпадает с релизом.',502);hash.update(chunk);await file.writeFile(chunk);}await file.sync();}finally{await file.close();}
      if(downloadBytes!==asset.size||hash.digest('hex')!==asset.digest.slice(7))throw fail('SHA256 cloudflared не совпала с официальным релизом. Файл не установлен.',502);
      const filename=`cloudflared-${platform}-${arch}-${release.tag_name}.exe`,destination=path.join(directory,filename);await rename(temporary,destination);temporary=null;
      const record={file:filename,version:release.tag_name,sha256:asset.digest.slice(7),bytes:asset.size,platform,arch,installedAt:new Date().toISOString()},manifestTemporary=manifestFile+'.'+crypto.randomUUID()+'.tmp';
      try{await fs.writeFile(manifestTemporary,JSON.stringify(record,null,2),{flag:'wx'});await rename(manifestTemporary,manifestFile);}finally{await fs.unlink(manifestTemporary).catch(()=>{});}installation=record;log('installed',{version:record.version,bytes:record.bytes});return status();
    }catch(error){log('installation-failed',{code:error.code||error.name});throw error;}finally{installing=false;installAbort=null;if(temporary)await fs.unlink(temporary).catch(()=>{});}
  })().finally(()=>{installPromise=null;});return installPromise;}
  async function verifiedExecutable(){
    await ready;if(!installation)throw fail('Сначала установите cloudflared кнопкой в SAS.');const filename=path.join(directory,installation.file),stat=await fs.lstat(filename).catch(()=>null);
    if(!stat?.isFile()||stat.isSymbolicLink()||stat.size!==installation.bytes)throw fail('Установка cloudflared повреждена. Переустановите её из SAS.');
    const [realDirectory,realFile]=await Promise.all([fs.realpath(directory),fs.realpath(filename)]);if(path.dirname(realFile)!==realDirectory)throw fail('Недопустимый путь cloudflared.');
    const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(realFile))hash.update(chunk);if(hash.digest('hex')!==installation.sha256)throw fail('Проверка cloudflared не пройдена. Файл изменён; переустановите его из SAS.');return realFile;
  }
  function start(){if(startingPromise)return startingPromise;if(stoppingPromise)return stoppingPromise.then(()=>start());if(child&&tunnel.state==='running')return Promise.resolve(status());const epoch=++startEpoch;
    startingPromise=(async()=>{
      await ready;if(closed)throw fail('Сетевой менеджер закрыт.');if(installing)throw fail('Дождитесь установки cloudflared.',409);if(child)await terminateChild(child);const room=getRoom(),roomId=room?.room?.id||room?.id;
      if(!room?.running||!roomId||!Number.isInteger(room.port)||room.port<1||room.port>65535)throw fail('Сначала откройте комнату. Интернет-ссылка публикует только её сервер.');
      tunnel={state:'starting',url:'',roomId,error:''};const executable=await verifiedExecutable().catch(error=>{installation=null;throw error;});if(epoch!==startEpoch||closed)throw fail('Запуск интернет-ссылки отменён.');
      const origin=`http://127.0.0.1:${room.port}`,config=path.join(directory,'quick-tunnel.yml');await fs.writeFile(config,'{}\n');
      if(epoch!==startEpoch||closed)throw fail('Запуск интернет-ссылки отменён.');
      const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^TUNNEL_|^CLOUDFLARED_/i.test(key)));
      const processHandle=spawnImpl(executable,['tunnel','--config',config,'--no-autoupdate','--url',origin,'--protocol','http2','--metrics','127.0.0.1:0','--management-diagnostics=false'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child=processHandle;log('starting',{roomId});
      childExit=new Promise(resolve=>{processHandle.once('exit',resolve);processHandle.once('error',resolve);});
      return await new Promise((resolve,reject)=>{
        let settled=false,output='',timer;
        const finish=(error,url)=>{if(settled)return;settled=true;clearTimeout(timer);startCancel=null;if(error){tunnel={state:'error',url:'',roomId,error:error.message};reject(error);void terminateChild(processHandle);}else{tunnel={state:'running',url,roomId,error:''};log('started',{roomId});roomWatch=setInterval(()=>{const current=getRoom();if(!current?.running||(current.room?.id||current.id)!==roomId||current.port!==room.port)void stop();},roomCheckMs);roomWatch.unref?.();resolve(status());}};
        startCancel=()=>finish(fail('Запуск интернет-ссылки отменён.'));
        const receive=chunk=>{output=(output+String(chunk)).slice(-8192);const match=output.match(/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/);if(match)finish(null,match[0]);};
        processHandle.stdout?.on('data',receive);processHandle.stderr?.on('data',receive);processHandle.once('error',()=>finish(fail('Не удалось запустить cloudflared. Переустановите компонент.',502)));processHandle.once('exit',(code)=>{if(!settled)finish(fail('cloudflared завершился до подключения. Проверьте интернет и брандмауэр.',502));else if(child===processHandle){child=null;clearInterval(roomWatch);tunnel={state:code===0?'stopped':'error',url:'',roomId:'',error:code===0?'':'Интернет-соединение cloudflared завершилось. Запустите ссылку снова.'};}});
        timer=setTimeout(()=>finish(fail('Интернет-ссылка не открылась вовремя. Проверьте соединение или используйте Radmin VPN.',504)),Math.max(100,startTimeoutMs));
      });
    })().catch(error=>{if(tunnel.state==='starting')tunnel={state:'error',url:'',roomId:'',error:error.message};throw error;}).finally(()=>{startingPromise=null;});return startingPromise;
  }
  async function terminateChild(processHandle){if(!processHandle)return;try{processHandle.kill();}catch{}let timer;await Promise.race([childExit||Promise.resolve(),new Promise(resolve=>timer=setTimeout(resolve,2500))]);clearTimeout(timer);if(processHandle.exitCode==null)try{processHandle.kill('SIGKILL');}catch{}if(child===processHandle)child=null;}
  function stop(){if(stoppingPromise)return stoppingPromise;stoppingPromise=(async()=>{++startEpoch;clearInterval(roomWatch);roomWatch=null;startCancel?.();await terminateChild(child);tunnel={state:'stopped',url:'',roomId:'',error:''};log('stopped');return status();})().finally(()=>{stoppingPromise=null;});return stoppingPromise;}
  async function diagnose(input){
    let target;try{target=new URL(typeof input==='string'?input:input?.url);}catch{throw fail('Введите HTTP(S)-адрес комнаты.');}
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw fail('Нужен HTTP(S)-адрес без логина и пароля.');
    const endpoint=new URL('/room-info',target.origin);try{const response=await fetchImpl(endpoint.href,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});if(!response.ok)throw fail('HTTP '+response.status);const info=JSON.parse((await limitedBody(response,16384)).toString('utf8'));if(info.sasRoom!==1||typeof info.id!=='string')throw fail('По этому адресу нет комнаты SAS.');return {reachable:true,room:{id:info.id.slice(0,80),name:String(info.name||'Комната').slice(0,100),mode:['roleplay','dnd','custom'].includes(info.mode)?info.mode:'roleplay',lobby:!!info.lobby},hint:target.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(target.hostname)?'Чат и музыка доступны. Для микрофона в браузере нужен HTTPS или настольный SAS.':''};}catch{return {reachable:false,error:'Комната недоступна или адрес не является сервером комнаты SAS.',hint:fallback};}
  }
  async function close(){closed=true;installAbort?.abort();await installPromise?.catch(()=>{});await stop();await ready;}
  return {ready,status,install,start,stop,diagnose,close};
}
