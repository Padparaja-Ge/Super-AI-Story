const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// A separate entry point inside the production EXE: no BrowserWindow and no
// external Node installation. The GUI and web frontend lease the same core.
async function runWebRuntime({app, dialog, stopOnly=false, shell=false,startup}) {
  startup?.report(10,'Запуск веб-сервера');
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const config = path.resolve(process.env.SAS_WEB_CONFIG || path.join(base, 'web-server.json'));
  process.env.SAS_WEB_CONFIG = config;
  process.env.SAS_DATA_DIR ||= path.join(app.getPath('userData'), 'data');
  const key = crypto.createHash('sha256').update(config.toLowerCase()).digest('hex').slice(0,16);
  const stateDir = path.join(app.getPath('userData'), 'web-runtime');
  fs.mkdirSync(stateDir, {recursive:true});
  const descriptor = path.join(stateDir, key+'.json');
  const logPath = path.join(stateDir, key+'.log');
  const log = message => {
    // Do not log config contents, access keys, prompts or API headers.
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024*1024)
      fs.renameSync(logPath, logPath+'.previous');
    fs.appendFileSync(logPath, new Date().toISOString()+' '+message+'\n');
  };
  const read = () => {try { return JSON.parse(fs.readFileSync(descriptor,'utf8')); } catch {return null;} };
  const control = async (state, action) => {
    if (!state || !Number.isInteger(state.port) || state.port<1 || state.port>65535 || !/^[a-f0-9]{64}$/.test(state.token)) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
        method:'POST', headers:{'Authorization':'Bearer '+state.token}, signal:AbortSignal.timeout(4000)
      });
      return response.ok;
    } catch {return false;}
  };
  if (stopOnly) {
    const state=read();
    if (state && !await control(state,'stop')) {
      startup?.fail(new Error('Веб-сервер не ответил на остановку.'));
      if(!process.env.SAS_STARTUP_FILE)dialog.showErrorBox('SAS Web', 'Веб-сервер не ответил. Проверьте журнал: '+logPath);
      app.exit(1); return;
    }
    startup?.finish();app.quit(); return;
  }
  if (await control(read(),'status')) {
    startup?.finish({url:read().url,alreadyRunning:true});
    app.quit(); return;
  }
  // A config-scoped lock does not contend with the desktop GUI's lock.
  app.setPath('userData', path.join(app.getPath('userData'), 'web-lock-'+key));
  if (!app.requestSingleInstanceLock()) {startup?.fail(new Error('Веб-сервер ещё запускается. Дождитесь его готовности.'));app.quit(); return;}
  let runtime, listener, ending=false;
  const stop = async () => {
    if (ending) return; ending=true;
    const timer=setTimeout(()=>app.exit(1),10000);
    try {
      await runtime?.close();
      if (read()?.pid===process.pid) fs.rmSync(descriptor,{force:true});
      listener?.close(); log('stopped'); clearTimeout(timer); app.exit(0);
    } catch {log('stop failed'); clearTimeout(timer); app.exit(1);}
  };
  app.on('before-quit',event=>{if(runtime&&!ending){event.preventDefault();void stop();}});
  process.once('SIGINT',()=>void stop()); process.once('SIGTERM',()=>void stop());
  try {
    startup?.report(25,'Подготавливаем ядро приложения');
    const {startWebServer} = await import(pathToFileURL(path.join(app.getAppPath(),'server','web.mjs')).href);
    runtime=await startWebServer({mode:shell?'shell':'full',dataDir:process.env.SAS_DATA_DIR,networkFile:config,onProgress:(progress,phase)=>startup?.report(progress,phase)});
    const token=crypto.randomBytes(32).toString('hex');
    listener=http.createServer((req,res)=>{
      if(req.method!=='POST'||req.headers.origin||req.headers.authorization!=='Bearer '+token){res.writeHead(403).end();return;}
      if(req.url==='/status'){res.writeHead(200).end('running');return;}
      if(req.url==='/stop'){res.writeHead(200).end('stopping');setImmediate(()=>void stop());return;}
      res.writeHead(404).end();
    });
    listener.requestTimeout=5000; listener.headersTimeout=5000;
    await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    const state={pid:process.pid,port:listener.address().port,token,mode:shell?'shell':'full',url:`http://${runtime.host==='0.0.0.0'?'127.0.0.1':runtime.host==='::'?'[::1]':runtime.host}:${runtime.port}`};
    fs.writeFileSync(descriptor,JSON.stringify(state),{mode:0o600});
    log('started mode='+state.mode+' url='+state.url);
    startup?.finish({url:state.url});
  } catch(error) {
    startup?.fail(error);
    // Known startup messages contain no user prompts or secrets.
    log('startup failed code='+(error.code||'START_FAILED'));
    await runtime?.close().catch(()=>{}); listener?.close();
    if(!process.env.SAS_STARTUP_FILE)dialog.showErrorBox('Не удалось запустить SAS Web',error.message+'\nЖурнал: '+logPath);
    app.exit(1);
  }
}
module.exports={runWebRuntime};
