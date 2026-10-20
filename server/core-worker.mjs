import path from 'node:path';
import {coreFailure,logCoreStartup} from './core-startup.mjs';

let runtime;
try {
  const {startServer}=await import('./index.mjs');
  const {defaultDataDir}=await import('./store.mjs');
  runtime=await startServer({port:0,dataDir:defaultDataDir});
  logCoreStartup(defaultDataDir,'ready');
}catch(error){
  const dataDir=process.env.SAS_DATA_DIR||path.join(process.env.APPDATA||process.cwd(),'Super AI Story','data');
  logCoreStartup(dataDir,'startup_error',error);
  if(process.send&&process.connected)await new Promise(resolve=>process.send({type:'sas:core-error',...coreFailure(error)},()=>resolve()));
  if(process.connected)process.disconnect();process.exit(1);
}
if(process.connected)process.disconnect();
process.on('uncaughtExceptionMonitor',error=>runtime.app.locals.runtime.diagnostics?.fatal(error));
const idleMs=Math.max(1000,Number(process.env.SAS_CORE_IDLE_MS)||30000);
let closing=false;
let lastInstallationActivity=0;
const shutdown=async()=>{if(closing)return;closing=true;clearInterval(timer);await runtime.close();process.exit(0);};
const timer=setInterval(()=>{
  const leases=runtime.app.locals.runtime.leases;
  const last=runtime.app.locals.runtime.lastLease();
  // A window can close/reopen while multi-GB Python dependencies are installing.
  // Keep the owning core alive until installation completes or is cancelled.
  if(runtime.app.locals.runtime.speech.isInstalling()||runtime.app.locals.runtime.roomNetwork.isInstalling())lastInstallationActivity=Date.now();
  if(!leases.size&&Date.now()-Math.max(last,lastInstallationActivity)>idleMs)void shutdown();
},Math.min(5000,idleMs));
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
