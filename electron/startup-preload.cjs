const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sasStartup',{
 subscribe(callback){ipcRenderer.on('sas:startup',(_event,status)=>callback(status));},
 close(){ipcRenderer.send('sas:startup-close');}
});
