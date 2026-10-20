import {startServer} from './index.mjs';
import {defaultDataDir} from './store.mjs';

const runtime=await startServer({port:0,dataDir:defaultDataDir});
process.on('uncaughtExceptionMonitor',error=>runtime.app.locals.runtime.diagnostics?.fatal(error));
const idleMs=Math.max(1000,Number(process.env.SAS_CORE_IDLE_MS)||30000);
let closing=false;
const shutdown=async()=>{if(closing)return;closing=true;clearInterval(timer);await runtime.close();process.exit(0);};
const timer=setInterval(()=>{
  const leases=runtime.app.locals.runtime.leases;
  const last=runtime.app.locals.runtime.lastLease();
  if(!leases.size&&Date.now()-last>idleMs)void shutdown();
},Math.min(5000,idleMs));
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
