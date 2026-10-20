import express from 'express';
import {createNetworkPolicy,networkInterfaces} from './network.mjs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultDataDir, projectRoot } from './store.mjs';
import { readCore,coreVersion } from './shared-core.mjs';
import { startServer } from './index.mjs';

const loginPage=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · SAS</title><style>body{background:#10121b;color:#e8e3f5;font:16px system-ui;display:grid;place-items:center;min-height:95vh;margin:0}main{width:min(85vw,380px)}input,button{font:inherit;border:1px solid #544564;border-radius:12px;padding:14px;box-sizing:border-box;width:100%;margin:10px 0}input{background:#1c1e2b;color:inherit}button{background:#ac89ee;cursor:pointer}p{line-height:1.6;color:#b7adc7}</style><main><h1>Super AI Story</h1><p>Введите ключ доступа из настроек веб-сервера или файла web-server.json.</p><form method="post" action="/auth/login"><input type="password" name="password" aria-label="Ключ доступа" autocomplete="current-password" required autofocus><button>Открыть студию</button></form></main></html>`;
const loopback=host=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const equal=(a,b)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);};

export async function startWebServer({port,host,dataDir=defaultDataDir,mode='full',upstream=process.env.SAS_BACKEND_URL||'',password,coreMode='process',coreIdleMs=30000,networkFile,desktop=false,onProgress=()=>{},frontendDir=path.join(projectRoot,'dist')}={}){
  onProgress(35,'Проверяем настройки и каталог данных');
  const network=createNetworkPolicy({file:networkFile}),networkConfig=network.read();
  port ??= Number(process.env.SAS_WEB_PORT||networkConfig.port);host ||= process.env.SAS_WEB_HOST||networkConfig.host;
  let remote=!loopback(host),passwordOverride=password;
  password=desktop?'':(passwordOverride??networkConfig.accessKey);
  let sessionSecret=crypto.randomBytes(32);
  const attempts=new Map();
  const syncPassword=()=>{
    const next=desktop?'':(passwordOverride??network.read().accessKey);
    if(next!==password){password=next;sessionSecret=crypto.randomBytes(32);attempts.clear();}
  };
  let ownedCore,starting,closed=false,leaseOrigin='',spawnError='';
  const leaseId=crypto.randomUUID();
  const lease=async(origin,release=false)=>{if(!origin)return;await fetch(origin+'/api/internal/lease',{method:'POST',headers:{'Content-Type':'application/json','X-SAS-Client':'shell'},body:JSON.stringify({id:leaseId,release}),signal:AbortSignal.timeout(3000)});};
  const coreOrigin=existing=>{if(existing.version!==coreVersion)throw new Error('Запущено ядро другой версии SAS. Закройте предыдущие окна и веб-серверы, подождите 30 секунд и повторите запуск. Данные сохранятся.');return `http://127.0.0.1:${existing.port}`;};
  const ensure=()=>starting ||= (async()=>{
    if(upstream){const url=new URL(upstream);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('SAS_BACKEND_URL: укажите origin сервера без пути и ключей.');return url.origin;}
    let existing=readCore(dataDir);if(existing){onProgress(65,'Подключаем работающее ядро');return coreOrigin(existing);}
    if(mode==='shell')throw new Error('Оболочка ожидает ядро SAS. Запустите desktop или полный веб-сервер с тем же SAS_DATA_DIR.');
    try{
      if(coreMode==='embedded'){ownedCore=await startServer({port:0,dataDir});return `http://127.0.0.1:${ownedCore.port}`;}
      // Windows requires a physical working directory; Electron loads the worker from app.asar.
      const workerCwd=projectRoot.endsWith('.asar')?path.dirname(projectRoot):projectRoot;
      const child=spawn(process.execPath,[path.join(projectRoot,'server','core-worker.mjs')],{cwd:workerCwd,env:{...process.env,SAS_DATA_DIR:dataDir,SAS_CORE_IDLE_MS:String(coreIdleMs),ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:'ignore'});
      onProgress(50,'Запускаем ядро и открываем истории');
      child.on('error',error=>{spawnError=error.message;});child.unref();
      for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));existing=readCore(dataDir);if(existing)return coreOrigin(existing);if(spawnError)throw new Error(spawnError);}
      throw new Error('Ядро SAS не запустилось. Проверьте Node.js и доступ к каталогу данных.');
    }
    catch(error){if(error.code!=='SAS_BACKEND_RUNNING')throw error;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));existing=readCore(dataDir);if(existing)return coreOrigin(existing);}throw error;}
  })().finally(()=>{starting=null;});
  if(mode==='full'){leaseOrigin=await ensure();await lease(leaseOrigin);}
  const heartbeat=setInterval(async()=>{if(closed)return;try{leaseOrigin=await ensure();await lease(leaseOrigin);}catch{}},5000);heartbeat.unref();
  const app=express();app.disable('x-powered-by');
  if(!desktop)app.use(network.middleware);
  app.use((req,res,next)=>{
    syncPassword();
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    let requestHost;try{requestHost=new URL(`http://${req.headers.host}`).hostname;}catch{return res.sendStatus(403);}
    if(!remote&&!password&&!loopback(requestHost))return res.sendStatus(403);
    if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return res.status(403).json({error:'Запрос с другого сайта отклонён.'});}catch{return res.sendStatus(403);}}
    next();
  });
  const sign=value=>crypto.createHmac('sha256',sessionSecret).update(value).digest('base64url');
  const authenticated=req=>{
    if(!password)return true;
    const cookie=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('sas_session='))?.slice(12)||'';
    const [stamp,signature]=cookie.split('.');return !!stamp&&Number(stamp)>Date.now()&&Number(stamp)<Date.now()+13*3600000&&equal(signature||'',sign(stamp));
  };
  app.post('/auth/login',express.urlencoded({extended:false,limit:'8kb'}),(req,res)=>{
    const ip=req.socket.remoteAddress,now=Date.now();for(const [key,value]of attempts)if(value.until<now)attempts.delete(key);
    const record=attempts.get(ip)||{count:0,until:now+60000};record.count++;attempts.set(ip,record);
    if(record.count>20)return res.status(429).type('html').send(loginPage.replace('Введите ключ','Слишком много попыток. Подождите минуту. Введите ключ'));
    if(!equal(String(req.body.password||''),password))return res.status(401).type('html').send(loginPage.replace('Введите ключ','Неверный ключ. Введите ключ'));
    const stamp=String(now+12*3600000);res.setHeader('Set-Cookie',`sas_session=${stamp}.${sign(stamp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.socket.encrypted?'; Secure':''}`);res.redirect('/');
  });
  app.use((req,res,next)=>{if(authenticated(req))return next();if(req.path.startsWith('/api/'))return res.status(401).json({error:'Сеанс веб-версии истёк. Обновите страницу и войдите снова.'});res.status(401).type('html').send(loginPage);});
  app.use('/api/network',express.json({limit:'64kb'}));
  let server,applying=false;const servers=new Set();
  const listen=async(nextHost,nextPort)=>{
    const candidate=http.createServer(app);
    await new Promise((resolve,reject)=>{candidate.once('error',reject);candidate.listen(nextPort,nextHost,()=>{candidate.removeListener('error',reject);resolve();});});
    servers.add(candidate);candidate.once('close',()=>servers.delete(candidate));return candidate;
  };
  const runtimeInfo=()=>({authRequired:!!password,host,port:server?.address()?.port||port,desktop,urls:networkInterfaces().filter(a=>host==='0.0.0.0'?a.address.includes('.'):host==='::'?true:host==='localhost'?a.internal:a.address===host).map(a=>({name:a.name,url:`http://${a.address.includes(':')?'['+a.address+']':a.address}:${server?.address()?.port||port}`}))});
  const apply=async config=>{
    if(desktop)return {};
    if(applying)throw new Error('Сетевые настройки уже применяются.');
    if(config.host===host&&config.port===port)return {};
    applying=true;
    const previousHost=host,previousPort=port,previousServer=server;
    try{
      // Closing the listener leaves active responses (including this PUT) intact.
      if(config.port===port)previousServer.close();
      let next;
      try{next=await listen(config.host,config.port);}catch(error){
        if(config.port===port)server=await listen(previousHost,previousPort);
        throw new Error(`Не удалось применить ${config.host}:${config.port}: ${error.code||error.message}. Прежний адрес сохранён.`);
      }
      if(config.port!==port)previousServer.close();
      server=next;host=config.host;port=next.address().port;remote=!loopback(host);
      return {};
    }finally{applying=false;}
  };
  network.routes(app,{apply,getRuntime:runtimeInfo,desktop,onApplied:(_req,res)=>{passwordOverride=undefined;syncPassword();if(password){const stamp=String(Date.now()+12*3600000);res.setHeader('Set-Cookie',`sas_session=${stamp}.${sign(stamp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);}else res.setHeader('Set-Cookie','sas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}});
  app.use('/api',async(req,res)=>{
    if(req.path.startsWith('/internal/'))return res.sendStatus(404);
    try{
      const origin=await ensure();if(leaseOrigin!==origin){leaseOrigin=origin;await lease(origin);}const target=new URL(req.originalUrl,origin);
      const proxyHeaders={...req.headers,host:target.host,'x-sas-client':'web'};
      for(const key of ['origin','cookie','connection','authorization','proxy-authorization','x-forwarded-for','x-forwarded-host','x-forwarded-proto'])delete proxyHeaders[key];
      const outgoing=(target.protocol==='https:'?https:http).request(target,{method:req.method,headers:proxyHeaders},incoming=>{res.writeHead(incoming.statusCode||502,incoming.headers);incoming.pipe(res);});
      outgoing.setTimeout(660000,()=>outgoing.destroy(new Error('Сервер не ответил вовремя.')));
      outgoing.on('error',error=>{if(!res.headersSent)res.status(503).json({error:`Ядро SAS временно недоступно: ${error.message}. Повторите запрос.`});else res.end();});
      req.on('aborted',()=>outgoing.destroy());req.pipe(outgoing);
    }catch(error){res.status(503).json({error:error.message});}
  });
  app.use(express.static(frontendDir,{index:false}));
  app.get('/{*path}',(req,res)=>res.sendFile('index.html',{root:frontendDir}));
  onProgress(75,'Открываем локальный интерфейс');
  try{server=await listen(host,port);port=server.address().port;onProgress(85,'Сервер готов');}catch(error){clearInterval(heartbeat);await lease(leaseOrigin,true).catch(()=>{});await ownedCore?.close();throw error;}
  return {get port(){return port;},get host(){return host;},get authRequired(){return !!password;},get server(){return server;},close:async()=>{if(closed)return;closed=true;clearInterval(heartbeat);await lease(leaseOrigin,true).catch(()=>{});await ownedCore?.close();await Promise.all([...servers].map(s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();})));}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const mode=process.argv.includes('--shell')?'shell':'full',host=process.argv.includes('--lan')?'0.0.0.0':process.env.SAS_WEB_HOST;
  startWebServer({mode,host}).then(runtime=>{
    console.log(`SAS Web (${mode==='shell'?'оболочка':'полный режим'}): http://${runtime.host==='0.0.0.0'?'localhost':runtime.host}:${runtime.port}`);
    if(!loopback(runtime.host))for(const adapter of networkInterfaces().filter(a=>!a.internal&&a.address.includes('.')))console.log(`${adapter.name}: http://${adapter.address}:${runtime.port}`);
    console.log(runtime.authRequired?'Вход по ключу из web-server.json.':'Вход без ключа.');
    console.log(`Данные: ${defaultDataDir}\nCtrl+C — остановить веб-сервер.`);
    const stop=async()=>{await runtime.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);process.on('message',message=>{if(message?.type==='sas:shutdown')void stop();});
  }).catch(error=>{console.error('SAS Web: '+error.message);process.exitCode=1;});
}
