const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { existsSync } = require('node:fs');
const { isIP } = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {requestPermission,checkPermission}=require('./permissions.cjs');
const {confirmManualClose}=require('./close-policy.cjs');

app.setName('Super AI Story');
if(process.platform==='win32')app.setAppUserModelId('local.superaistory.sas');
let mainWindow;
let backend;
let appOrigin = '';
let shuttingDown = false;
let closeApproved=false;
let closeDecision;
const webCommand=process.argv.some(arg=>['--sas-web','--sas-web-shell','--sas-web-stop'].includes(arg));
const startup=require('./startup.cjs').createStartup({app,BrowserWindow,ipcMain,web:webCommand});

async function approveClose(){
  if(closeApproved||!backend)return true;
  if(closeDecision)return closeDecision;
  closeDecision=(async()=>{
    try{
      if(mainWindow&&!mainWindow.webContents.isDestroyed()&&!mainWindow.webContents.isLoadingMainFrame()){
        await mainWindow.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Интерфейс не подтвердил отправку последних изменений. Повторите закрытие.')),6000);window.dispatchEvent(new CustomEvent('sas:prepare-close',{detail:{resolve:()=>{clearTimeout(timer);resolve(true);},reject:error=>{clearTimeout(timer);reject(new Error(error?.message||'Последние изменения не отправлены.'));}}}));})`,true);
      }
      const request=async(route,method='GET')=>{
        const response=await fetch(appOrigin+'/api'+route,{method,headers:{'X-SAS-Client':'desktop'},signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('Не удалось проверить или сохранить изменения: HTTP '+response.status);
        return response.json();
      };
      const approved=await confirmManualClose({getStatus:()=>request('/autosave'),save:()=>request('/autosave/save','POST'),choose:async()=>{
        const options={type:'question',title:'Сохранить изменения SAS?',message:'Есть несохранённые изменения',detail:'Автосохранение выключено. Сохраните текущие истории и настройки перед выходом или выйдите без сохранения.',buttons:['Сохранить и выйти','Выйти без сохранения','Отмена'],defaultId:0,cancelId:2,noLink:true};
        const {response}=mainWindow?await dialog.showMessageBox(mainWindow,options):await dialog.showMessageBox(options);
        return ['save','discard','cancel'][response]||'cancel';
      }});
      if(approved)closeApproved=true;
      return approved;
    }catch(error){dialog.showErrorBox('SAS: выход отменён',error.message);return false;}
    finally{closeDecision=null;}
  })();
  return closeDecision;
}

function isPrivateAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
  }
  return isIP(host) === 6 && (/^f[cd]/.test(host) || /^fe[89ab]/.test(host));
}

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isPrivateAddress(url.hostname))) return url.href;
  } catch {}
  return null;
}

function isApplicationUrl(value) {
  try { return new URL(value).origin === appOrigin; } catch { return false; }
}

ipcMain.on('sas:open-external', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  if (!isApplicationUrl(event.senderFrame.url)) return;
  const url = externalUrl(value);
  if (url) void shell.openExternal(url).catch(error => console.error('Не удалось открыть браузер:', error.message));
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    title: 'SAS · Super AI Story',
    icon: path.join(app.getAppPath(), 'assets', 'sas.png'),
    backgroundColor: '#0d0f18',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      autoplayPolicy: 'user-gesture-required',
    },
  });
  if(process.platform==='win32')mainWindow.setAppDetails({
    appId:'local.superaistory.sas',
    appIconPath:process.execPath,
    appIconIndex:0,
  });
  mainWindow.removeMenu();
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { Menu } = require('electron');
    const items = params.dictionarySuggestions.map(label => ({label, click:()=>mainWindow?.webContents.replaceMisspelling(label)}));
    if(params.misspelledWord) items.push({label:'Добавить в словарь',click:()=>mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)});
    if(params.isEditable) items.push({type:'separator'},{role:'undo',label:'Отменить'},{role:'cut',label:'Вырезать'},{role:'copy',label:'Копировать'},{role:'paste',label:'Вставить'},{role:'selectAll',label:'Выбрать всё'});
    if(items.length) Menu.buildFromTemplate(items).popup({window:mainWindow});
  });
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(requestPermission(contents,permission,details,mainWindow?.webContents,appOrigin));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => {
    return checkPermission(contents,permission,origin,details,mainWindow?.webContents,appOrigin);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-prevent-unload',event=>{
    // The native Save / Discard / Cancel decision already covers unsaved data.
    // Keep normal browser protection until the user has approved closing.
    if(closeApproved||shuttingDown)event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isApplicationUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isApplicationUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (!isApplicationUrl(event.url)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => {mainWindow?.show();startup.finish({url:appOrigin});});
  mainWindow.on('close',event=>{
    if(shuttingDown||closeApproved||!backend)return;
    event.preventDefault();
    void approveClose().then(approved=>{if(approved)mainWindow?.close();});
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(appOrigin).catch(error => {
    startup.fail(error);
    dialog.showErrorBox('SAS: интерфейс не загрузился', error.message);
    app.quit();
  });
}

const singleInstance = webCommand || app.requestSingleInstanceLock();
if (webCommand) {
  app.whenReady().then(()=>require('./web-runtime.cjs').runWebRuntime({app,dialog,
    shell:process.argv.includes('--sas-web-shell'),stopOnly:process.argv.includes('--sas-web-stop'),startup
  })).catch(error=>{startup.fail(error);if(!process.env.SAS_STARTUP_FILE)dialog.showErrorBox('SAS Web',error.message);app.exit(1);});
} else if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    startup.show();startup.report(10,'Открываем студию');
    await new Promise(resolve=>setTimeout(resolve,30));
    if (!existsSync(path.join(app.getAppPath(), 'dist', 'index.html'))) {
      throw new Error('Интерфейс ещё не собран. В папке проекта выполните npm run build или запустите Start-SAS.cmd.');
    }
    process.env.SAS_DATA_DIR ||= path.join(app.getPath('userData'), 'data');
    startup.report(25,'Подготавливаем ядро приложения');
    const { startWebServer } = await import(pathToFileURL(path.join(app.getAppPath(), 'server', 'web.mjs')).href);
    backend = await startWebServer({ port: 0, dataDir: process.env.SAS_DATA_DIR, host: '127.0.0.1', password:'', upstream:'', mode:'full', desktop:true,onProgress:(progress,phase)=>startup.report(progress,phase) });
    appOrigin = `http://127.0.0.1:${backend.port}`;
    startup.report(90,'Загружаем интерфейс');
    createWindow();
  }).catch(error => {
    startup.fail(error);
    dialog.showErrorBox('Не удалось запустить SAS', error.message);
    app.quit();
  });
  app.on('activate', () => { if (!mainWindow && backend && !shuttingDown) createWindow(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!backend) return;
    event.preventDefault();
    if (shuttingDown) return;
    void approveClose().then(approved=>{
      if(!approved||shuttingDown)return;
      shuttingDown=true;
      const timer=setTimeout(()=>app.exit(0),5000);
      Promise.resolve().then(()=>backend.close()).catch(error=>console.error('Ошибка завершения SAS:',error.message)).finally(()=>{clearTimeout(timer);app.exit(0);});
    });
  });
}
