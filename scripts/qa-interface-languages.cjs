const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),output=path.join(root,'qa-artifacts','interface-languages');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-breakpad');
app.on('window-all-closed',()=>{});
let runtime,window,dataDir;
const errors=[];
async function evaluate(code){return window.webContents.executeJavaScript(code);}
async function until(code,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,80));}throw Error('UI timeout: '+label);}
async function screenshot(name){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,250));await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());}
async function choose(language){
 await until(`!!document.querySelector('select[name="interfaceLanguage"]:not(:disabled)')`,'language selector');
 await evaluate(`(()=>{const select=document.querySelector('select[name="interfaceLanguage"]:not(:disabled)');select.value=${JSON.stringify(language)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until(`document.documentElement.lang===${JSON.stringify(language)}&&!document.querySelector('select[name="interfaceLanguage"]:disabled')`,'language '+language);
 const saved=await fetch('http://127.0.0.1:'+runtime.port+'/api/interface-language').then(r=>r.json());assert.equal(saved.language,language);
}
async function newWindow(width=1200,height=850){
 window=new BrowserWindow({show:false,width,height,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message.slice(0,500));});
 await window.loadURL('http://127.0.0.1:'+runtime.port);await until(`!!document.querySelector('.sidebar')`,'studio load');
}
app.whenReady().then(async()=>{
 try{
  await fs.mkdir(output,{recursive:true});dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-languages-ui-'));await fs.writeFile(path.join(output,'test-data-path.txt'),dataDir);app.setPath('userData',path.join(dataDir,'profile'));
  const {startServer}=await import(pathToFileURL(path.join(root,'server/index.mjs')).href);runtime=await startServer({port:0,dataDir});
  const before=await fetch('http://127.0.0.1:'+runtime.port+'/api/state').then(r=>r.json());
  await newWindow();await until(`!!document.querySelector('.beginner-welcome select[name="interfaceLanguage"]')`,'first-run language selector');
  assert.equal(await evaluate(`document.querySelector('select[name="interfaceLanguage"]').options.length`),5);
  await choose('en');assert.ok(await evaluate(`document.querySelector('.sidebar').innerText.includes('Stories')`));
  await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(button=>button.textContent.trim()==='Settings').click()`);
  await until(`!!document.querySelector('.settings-panel select[name="interfaceLanguage"]')`,'settings selector');
  await screenshot('settings-en');
  for(const [language,title] of [['ja','設定'],['zh-CN','设置'],['ko','설정'],['ru','Настройки']]){
   await choose(language);assert.ok(await evaluate(`document.querySelector('.section-heading h1').textContent.includes(${JSON.stringify(title)})`));
   await screenshot('settings-'+language);
  }
  await choose('ko');
  await evaluate(`document.querySelector('.topbar-guide').click()`);await until(`!!document.querySelector('.beginner-tour select[name="interfaceLanguage"]')`,'tutorial selector');
  assert.ok(await evaluate(`document.querySelector('.beginner-step h3').textContent.includes('모델')`));await screenshot('tutorial-ko');
  const after=await fetch('http://127.0.0.1:'+runtime.port+'/api/state').then(r=>r.json());assert.deepEqual(after,before,'locale changes must not alter any story, card, prompt or generation setting');
  window.destroy();await runtime.close();runtime=await startServer({port:0,dataDir});await newWindow(390,844);
  await until(`document.documentElement.lang==='ko'`,'locale across restart and new origin');
  await screenshot('mobile-ko');
  window.destroy();
  const host=runtime.app.locals.runtime,hostState=host.store.getState();
  hostState.personas.push({id:'locale-host',name:'Host hero',kind:'srp',className:'Fighter',abilities:{strength:10,dexterity:10,constitution:10,intelligence:10,wisdom:10,charisma:10},inventory:[],spells:[]});host.store.saveState(hostState);
  const opened=await host.multiplayer.start({port:0,mode:'dnd',personaId:'locale-host',newHistory:true,lobby:false}),guestUrl=new URL(opened.url);guestUrl.hostname='127.0.0.1';
  window=new BrowserWindow({show:false,width:600,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message.slice(0,500));});
  await window.loadURL(guestUrl.href);await until(`document.querySelector('select[name="interfaceLanguage"]')?.options.length===5`,'guest languages');
  await evaluate(`(()=>{document.getElementById('personaName').value='Харизма';document.getElementById('personaKind').value='srp';document.getElementById('srp-class').value='Fighter';document.getElementById('savePersona').click();document.getElementById('content').value='PLAYER_DRAFT не переводить';})()`);
  const personaId=await evaluate(`document.getElementById('persona').value`);assert.ok(personaId);
  for(const locale of ['en','ja','zh-CN','ko']){
   await evaluate(`(()=>{const select=document.querySelector('[name="interfaceLanguage"]');select.value=${JSON.stringify(locale)};select.dispatchEvent(new Event('change'));})()`);
   await until(`document.documentElement.lang===${JSON.stringify(locale)}&&!document.querySelector('[name="interfaceLanguage"]').disabled`,'guest '+locale);
   assert.equal(await evaluate(`document.getElementById('persona').value`),personaId);assert.equal(await evaluate(`document.getElementById('persona').selectedOptions[0].textContent`),'Харизма');assert.equal(await evaluate(`document.getElementById('content').value`),'PLAYER_DRAFT не переводить');
  }
  await screenshot('guest-ko');
  await evaluate(`document.getElementById('name').value='Locale guest';document.getElementById('connect').click()`);
  await until(`document.getElementById('room').style.display==='block'`,'guest joined');await until(`document.getElementById('status').textContent==='방에 있음'`,'guest localized status');
  await screenshot('guest-game-ko');
  await host.multiplayer.stop();
  assert.deepEqual(errors,[]);
  const report={success:true,languages:['ru','en','ja','zh-CN','ko'],firstRunChoice:true,settingsChoice:true,tutorialChoice:true,restartOnNewOrigin:true,storyStateUnchanged:true,guestLanguages:true,guestPersonaAndDraftUnchanged:true,guestDndJoin:true,consoleErrors:errors};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){console.error(error.stack);process.exitCode=1;}
 finally{window?.destroy();try{await runtime?.close();}finally{app.exit(process.exitCode||0);}}
});
