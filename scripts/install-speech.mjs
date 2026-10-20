import {createSpeechService} from '../server/tts/service.mjs';
import {defaultDataDir} from '../server/store.mjs';
import path from 'node:path';
const args=process.argv.slice(2),argument=(key,fallback)=>{const at=args.indexOf(key);return at>=0?args[at+1]:fallback;};
const modelsDir=argument('--models-dir',path.join(defaultDataDir,'models')),dataDir=argument('--data-dir',defaultDataDir),provider=argument('--provider','kokoro-ru');
if(!path.isAbsolute(modelsDir)||!path.isAbsolute(dataDir))throw new Error('Укажите абсолютные пути.');
const speech=createSpeechService({dataDir,getState:()=>({settings:{}}),saveState:()=>{},getModelsDir:async()=>modelsDir});
try{const job=await speech.install(provider);let previous='';for(;;){await new Promise(resolve=>setTimeout(resolve,1000));const status=await speech.status(),current=status.jobs.find(j=>j.id===job.id),line=`${current.stage}: ${Math.round(current.downloaded/1e6)}/${Math.round(current.total/1e6)} MB`;if(line!==previous){console.log(line);previous=line;}if(current.status!=='running'){if(current.status!=='complete')throw new Error(current.error||current.status);break;}}}finally{await speech.close();}
