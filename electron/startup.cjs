const fs=require('node:fs');
const path=require('node:path');
function createStartup({app,BrowserWindow,ipcMain,web=false}){
 const started=Date.now(),file=process.env.SAS_STARTUP_FILE;
 let window,last={progress:0,phase:'Запуск SAS',complete:false};
 const report=(progress,phase,extra={})=>{
  if(last.complete&&!extra.error)return last;
  last={progress:Math.max(last.progress,Math.min(100,progress)),phase,complete:progress===100,elapsedMs:Date.now()-started,pid:process.pid,...extra};
  if(file)try{fs.writeFileSync(file,JSON.stringify(last));}catch{}
  if(window&&!window.isDestroyed()){
   window.webContents.send('sas:startup',last);window.setProgressBar(last.error?-1:last.progress/100);
  }
  return last;
 };
 function show(){
  if(web)return;
  window=new BrowserWindow({width:490,height:295,frame:false,resizable:false,maximizable:false,show:true,backgroundColor:'#10121d',title:'Запуск SAS',icon:path.join(app.getAppPath(),'assets/sas.png'),webPreferences:{preload:path.join(__dirname,'startup-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.once('did-finish-load',()=>{if(window&&!window.isDestroyed())window.webContents.send('sas:startup',last);});
  ipcMain.on('sas:startup-close',event=>{if(window&&!window.isDestroyed()&&event.sender===window.webContents)app.quit();});
  window.loadFile(path.join(__dirname,'startup.html'));
 }
 return {show,report,finish(extra={}){report(100,'Студия готова',extra);if(window&&!window.isDestroyed())window.destroy();},fail(error){report(last.progress,'Не удалось запустить SAS',{error:String(error.message||error),complete:true});},get state(){return last;}};
}
module.exports={createStartup};
