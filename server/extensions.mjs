import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import AdmZip from 'adm-zip';
import {inflateRawSync} from 'node:zlib';

const MODES=['roleplay','multiplayer-roleplay','dnd','custom','fanfic'];
const fail=(text,status=400)=>Object.assign(new Error(text),{status});
const deadline=async(promise,ms,message,controller)=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(fail(message,504));},ms);})]);}finally{clearTimeout(timer);}
};
const idPattern=/^[a-z][a-z0-9-]{2,63}$/;
const validPath=name=>typeof name==='string'&&name.length<180&&!name.includes('\\')&&!name.includes(':')&&!name.startsWith('/')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
const textTypes={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.txt':'text/plain','.md':'text/plain','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
// These are full trust declarations, not a sandbox for arbitrary JavaScript.
function permissions(manifest){
 const required=[...(manifest.frontend?['studio:full-access']:[]),...(manifest.backend?['node:full-access']:[])];
 const declared=manifest.permissions??required;
 if(!Array.isArray(declared)||declared.length>2||declared.some(p=>!required.includes(p))||new Set(declared).size!==declared.length||required.some(p=>!declared.includes(p)))throw fail('permissions должны явно разрешать studio:full-access для frontend и node:full-access для backend.');
 return required;
}
export function extensionDigest(pkg){
 const hash=crypto.createHash('sha256');hash.update(JSON.stringify(pkg.manifest));
 for(const [name,data] of [...pkg.files].sort(([a],[b])=>a<b?-1:a>b?1:0))hash.update(JSON.stringify([name,data.length])).update(data);
 return hash.digest('hex');
}
export function extensionPackage(input){
 let manifest,files;
 if(typeof input?.zip==='string'){
  if(input.zip.length>14_000_000)throw fail('Архив расширения больше 10 МБ.');
  const zip=new AdmZip(Buffer.from(input.zip,'base64')),entries=zip.getEntries();files={};let total=0;
  if(entries.length>120)throw fail('В расширении больше 120 файлов.');
  for(const entry of entries){
   if(entry.isDirectory)continue;
   const name=entry.entryName;
   if(!validPath(name)||((entry.header.attr>>>16)&0o170000)===0o120000||Object.hasOwn(files,name))throw fail('Недопустимый путь или ссылка в расширении.');
   total+=entry.header.size;if(total>10_000_000||entry.header.size>4_000_000)throw fail('Распакованное расширение слишком большое.');
   const method=entry.header.method,compressed=entry.getCompressedData();
   if(![0,8].includes(method))throw fail('Поддерживаются ZIP store/deflate.');
   const data=method===0?compressed:inflateRawSync(compressed,{maxOutputLength:4_000_000});
   if(data.length!==entry.header.size)throw fail('Неверный размер файла ZIP.');
   // getData performs the archive CRC check; decompression has already been
   // bounded above, including archives with a false uncompressed-size header.
   if(!entry.getData().equals(data))throw fail('Повреждён ZIP расширения.');
   files[name]=data;
  }
  try{manifest=JSON.parse(files['manifest.json']?.toString('utf8'));}catch{throw fail('В корне ZIP нужен manifest.json.');}
  delete files['manifest.json'];
 }else{manifest=input?.manifest;files=input?.files;}
 if(!manifest||manifest.apiVersion!==2||!idPattern.test(manifest.id||'')||['regex','rpg','tts'].includes(manifest.id))throw fail('Нужен manifest SAS API v2 с уникальным id.');
 for(const key of ['name','version','description'])if(typeof manifest[key]!=='string'||!manifest[key].trim()||manifest[key].length>(key==='description'?1500:120))throw fail('Заполните '+key+' расширения.');
 const m={apiVersion:2,id:manifest.id,name:manifest.name,version:manifest.version,description:manifest.description,
  frontend:manifest.frontend||'',backend:manifest.backend||'',styles:manifest.styles||[],modes:manifest.modes||[],permissions:permissions(manifest)};
 if(!Array.isArray(m.styles)||m.styles.length>8||!Array.isArray(m.modes)||m.modes.some(v=>!MODES.includes(v)))throw fail('Неверные styles/modes расширения.');
 if(!m.frontend&&!m.backend)throw fail('Укажите frontend или backend модуль.');
 if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>120)throw fail('Нужны файлы расширения.');
 const normalized=new Map();let bytes=0;
 for(const [name,value] of Object.entries(files)){
  if(!validPath(name)||['manifest.json','package.json'].includes(name)||!textTypes[path.extname(name).toLowerCase()])throw fail('Недопустимый файл расширения: '+name);
  if(typeof value!=='string'&&!Buffer.isBuffer(value))throw fail('Файл должен быть текстом либо содержимым ZIP.');
  const data=Buffer.from(value);bytes+=data.length;if(data.length>4_000_000||bytes>10_000_000)throw fail('Расширение слишком большое.');normalized.set(name,data);
 }
 for(const name of [m.frontend,m.backend,...m.styles].filter(Boolean))if(!validPath(name)||!normalized.has(name))throw fail('Не найден файл из manifest: '+name);
 if(m.frontend&&!/\.m?js$/.test(m.frontend)||m.backend&&!/\.m?js$/.test(m.backend)||m.styles.some(s=>!s.endsWith('.css')))throw fail('Модули должны быть JS/MJS, стили — CSS.');
 return {manifest:m,files:normalized};
}

export function createExtensions({dataDir,getState,saveState,tasks}){
 const root=path.resolve(dataDir,'extensions'),registryFile=path.join(root,'registry.json'),instances=new Map(),storageQueues=new Map();
 const safeMode=process.env.SAS_DISABLE_EXTENSIONS==='1';let registry=[],serial=Promise.resolve(),closed=false;
 const locked=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
 async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2));try{for(let n=0;;n++){try{await fs.rename(tmp,file);break;}catch(e){if(!['EPERM','EBUSY'].includes(e.code)||n>=6)throw e;await new Promise(r=>setTimeout(r,20*2**n));}}}finally{await fs.unlink(tmp).catch(()=>{});}}
 async function noLinks(file){let current=path.parse(root).root;for(const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current);if(s.isSymbolicLink())throw fail('Ссылки в файлах расширений запрещены.');}}
 const record=id=>{if(!idPattern.test(id||''))throw fail('Неверный id расширения.');const r=registry.find(p=>p.manifest.id===id);if(!r)throw fail('Расширение не найдено.',404);return r;};
 const folder=r=>{if(!/^[a-f0-9-]{36}$/.test(r.revision))throw fail('Повреждена версия расширения.');return path.join(root,'packages',r.manifest.id,r.revision);};
 const publicRecord=r=>({...r.manifest,revision:r.revision,digest:r.digest||'',enabled:!!r.enabled,error:r.error||'',status:safeMode?'safe-mode':r.enabled?instances.has(r.manifest.id)?'active':'error':'disabled'});
 async function verifiedPackage(r){
  const base=folder(r),files={};let total=0;
  await noLinks(base);
  async function visit(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name),name=path.relative(base,file).replaceAll('\\','/');
   if(entry.isSymbolicLink()||!validPath(name))throw fail('Недопустимый файл расширения.');
   if(entry.isDirectory()){await visit(file);continue;}
   if(!entry.isFile())throw fail('Недопустимый файл расширения.');
   const size=(await fs.stat(file)).size;if(size>4_000_000)throw fail('Расширение слишком большое.');
   const data=await fs.readFile(file);
   if(name==='package.json'){if(data.toString()!=='{"type":"module"}')throw fail('Изменён package.json расширения.');continue;}
   total+=data.length;if(total>10_000_000||Object.keys(files).length>=120)throw fail('Расширение слишком большое.');
   files[name]=data;
  }}
  await visit(base);const pkg=extensionPackage({manifest:r.manifest,files});
  if(extensionDigest(pkg)!==r.digest)throw fail('Файлы расширения изменились. Установите пакет заново и подтвердите права.',409);
  return pkg;
 }
 async function readStorage(id){record(id);const file=path.join(root,'storage',id+'.json');try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {revision:0,value:{}};throw e;}}
 async function writeStorage(id,value,revision){const next=(storageQueues.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{const previous=await readStorage(id);if(revision!==previous.revision)throw fail('Хранилище расширения изменилось. Перечитайте его.',409);if(value===undefined||JSON.stringify(value).length>100000)throw fail('Хранилище ограничено 100 КБ.');const result={revision:previous.revision+1,value:JSON.parse(JSON.stringify(value))};await atomic(path.join(root,'storage',id+'.json'),result);return result;});storageQueues.set(id,next);return next;}
 async function dispose(id){const instance=instances.get(id);if(!instance)return;instances.delete(id);instance.disposed=true;for(const cleanup of instance.cleanups.reverse())try{await deadline(Promise.resolve().then(cleanup),2000,'Extension cleanup timeout');}catch{}instance.hooks.length=0;}
 async function activate(r){
  if(!r.enabled||safeMode||closed)return;
  const instance={router:express.Router(),hooks:[],cleanups:[],disposed:false},controller=new AbortController();
  try{
   if(!r.approval||r.approval.revision!==r.revision||r.approval.digest!==r.digest)throw fail('Подтвердите права этой версии расширения заново.',409);
   await verifiedPackage(r);
   if(r.manifest.backend){
    const filename=path.join(folder(r),r.manifest.backend);await noLinks(filename);
    const module=await deadline(import(pathToFileURL(filename).href),5000,'Backend import timeout',controller);
    if(typeof module.activate!=='function')throw fail('Backend должен экспортировать activate(sas).');
    const sdk={apiVersion:2,id:r.manifest.id,signal:controller.signal,getState:()=>structuredClone(getState()),saveState:state=>{if(instance.disposed)throw fail('Расширение выключено.');tasks.assertIdle();return saveState(state);},tasks,
     storage:{read:()=>readStorage(r.manifest.id),write:(value,revision)=>writeStorage(r.manifest.id,value,revision)},
     route(method,url,handler){if(!['get','post','put','patch','delete'].includes(method)||typeof url!=='string'||!/^\/[a-zA-Z0-9_:/-]*$/.test(url)||typeof handler!=='function')throw fail('Неверный маршрут расширения.');instance.router[method](url,async(req,res,next)=>{try{await handler(req,res);}catch(e){next(e);}});},
     onPrompt(handler,{modes=r.manifest.modes}={}){if(typeof handler!=='function'||!Array.isArray(modes)||!modes.length||modes.some(m=>!r.manifest.modes.includes(m)))throw fail('Объявите modes для prompt hook.');const hook={handler,modes};instance.hooks.push(hook);return ()=>{instance.hooks=instance.hooks.filter(h=>h!==hook);};},
     onDispose(fn){if(typeof fn==='function'){if(instance.disposed)void Promise.resolve().then(fn).catch(()=>{});else instance.cleanups.push(fn);}}};
    const activation=Promise.resolve().then(()=>module.activate(Object.freeze(sdk))).then(cleanup=>{if(typeof cleanup==='function'){if(instance.disposed)void Promise.resolve().then(cleanup).catch(()=>{});else instance.cleanups.push(cleanup);}});
    await deadline(activation,5000,'Backend activate timeout',controller);
   }
   instances.set(r.manifest.id,instance);r.error='';
  }catch(e){instance.disposed=true;controller.abort();for(const cleanup of instance.cleanups.reverse())try{await deadline(Promise.resolve().then(cleanup),2000,'Extension cleanup timeout');}catch{}r.error=String(e.message||e).slice(0,1000);r.enabled=false;}
 }
 const ready=(async()=>{await fs.mkdir(root,{recursive:true});await noLinks(root);try{registry=JSON.parse(await fs.readFile(registryFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}if(!Array.isArray(registry))throw fail('Повреждён registry расширений. Запустите безопасный режим.');for(const r of registry){if(!idPattern.test(r.manifest?.id||''))throw fail('Повреждён id расширения.');r.manifest.permissions=permissions(r.manifest);if(!r.digest){r.enabled=false;r.error='Установите пакет заново для проверки прав и файлов.';}await activate(r);}await atomic(registryFile,registry);})();
 ready.catch(()=>{});
 const router=express.Router();router.use(async(_req,_res,next)=>{try{await ready;next();}catch(e){next(e);}});
 router.get('/',(_req,res)=>res.json({apiVersion:2,safeMode,extensions:registry.map(publicRecord)}));
 router.post('/install',async(req,res)=>{
  tasks.assertIdle();const pkg=extensionPackage(req.body),id=pkg.manifest.id;
  await locked(async()=>{const old=registry.find(p=>p.manifest.id===id),revision=crypto.randomUUID(),r={manifest:pkg.manifest,revision,digest:extensionDigest(pkg),enabled:false,error:''};const destination=folder(r);await fs.mkdir(destination,{recursive:true});await noLinks(destination);for(const [name,data] of pkg.files){const file=path.join(destination,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data,{flag:'wx'});}await fs.writeFile(path.join(destination,'package.json'),'{"type":"module"}');await dispose(id);registry=registry.filter(p=>p.manifest.id!==id);registry.push(r);await atomic(registryFile,registry);res.status(old?200:201).json(publicRecord(r));});
 });
 router.put('/:id/enabled',async(req,res)=>{tasks.assertIdle();await locked(async()=>{const r=record(req.params.id);if(typeof req.body?.enabled!=='boolean')throw fail('enabled должен быть boolean.');if(req.body.enabled){if(safeMode||req.body.trusted!==true)throw fail(safeMode?'Активен безопасный режим.':'Подтвердите доверие исполняемому коду расширения.');if(req.body.revision!==r.revision||req.body.digest!==r.digest)throw fail('Пакет изменился. Перечитайте список и подтвердите права текущей версии.',409);await verifiedPackage(r);}await dispose(r.manifest.id);r.enabled=req.body.enabled;r.approval=r.enabled?{revision:r.revision,digest:r.digest}:null;if(r.enabled)await activate(r);await atomic(registryFile,registry);res.json(publicRecord(r));});});
 router.delete('/:id',async(req,res)=>{tasks.assertIdle();await locked(async()=>{const r=record(req.params.id);await dispose(r.manifest.id);registry=registry.filter(p=>p!==r);await atomic(registryFile,registry);res.json({ok:true,storageRetained:true});});});
 router.get('/:id/storage',async(req,res)=>res.json(await readStorage(req.params.id)));
 router.put('/:id/storage',async(req,res)=>res.json(await writeStorage(req.params.id,req.body?.value,req.body?.revision)));
 router.use('/:id/actions',async(req,res,next)=>{try{const r=record(req.params.id),instance=instances.get(r.manifest.id);if(!r.enabled||!instance)throw fail('Расширение выключено.',409);instance.router(req,res,next);}catch(e){next(e);}});
 router.get(['/:id/files/{*file}','/:id/:revision/files/{*file}'],async(req,res)=>{
  const r=record(req.params.id),name=[req.params.file].flat().join('/');
  if(req.params.revision&&req.params.revision!==r.revision)throw fail('Версия расширения устарела.',409);
  if(!r.enabled||safeMode||!instances.has(r.manifest.id))throw fail('Расширение выключено.',409);
  let pkg;try{pkg=await verifiedPackage(r);}catch(e){await dispose(r.manifest.id);r.enabled=false;r.approval=null;r.error=e.message;await atomic(registryFile,registry);throw e;}
  if(!validPath(name)||name===r.manifest.backend||!textTypes[path.extname(name).toLowerCase()])throw fail('Недопустимый файл.',404);
  if(!pkg.files.has(name))throw fail('Файл не найден.',404);
  res.type(textTypes[path.extname(name).toLowerCase()]).set('Cache-Control','no-store').send(pkg.files.get(name));
 });
 async function prompt(mode,context){await ready;if(!MODES.includes(mode))return '';const parts=[];for(const [id,instance] of instances){for(const hook of instance.hooks.filter(h=>h.modes.includes(mode))){const controller=new AbortController();try{const value=await deadline(Promise.resolve().then(()=>hook.handler({...structuredClone({mode,...context}),signal:controller.signal})),4000,'Prompt hook timeout',controller);if(value!==undefined&&value!==null&&typeof value!=='string')throw fail('Prompt hook должен вернуть строку.');if(value){if(value.length>4000)throw fail('Блок расширения больше 4000 символов.');parts.push(`[SAS extension ${id}]\n${value}`);}}catch(e){const r=record(id);r.error=String(e.message||e).slice(0,1000);}finally{controller.abort();}}}const text=parts.join('\n\n');if(text.length>12000)throw fail('Слишком много инструкций расширений. Отключите часть расширений.');return text;}
 return {router,ready,prompt,close:async()=>{await ready.catch(()=>{});closed=true;for(const id of [...instances.keys()])await dispose(id);await serial;}};
}
