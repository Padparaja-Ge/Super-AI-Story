import path from 'node:path';
import fs from 'node:fs/promises';
import {bundleExecutable,installBundle,llamaManifest} from '../server/llama-bundle.mjs';
const root=path.resolve(import.meta.dirname,'..','runtime','llama');
for(const backend of ['cpu','vulkan','cuda']){
  if(await bundleExecutable(root,backend)){console.log(backend+': ready');continue;}
  let last=0;
  await installBundle(root,backend,{onProgress:p=>{if(Date.now()-last>10000||p.stage){last=Date.now();console.log(`${backend}: ${p.stage||Math.round(p.downloaded/p.total*100)+'%'}`);}}});
  console.log(backend+': ready');
}
await fs.cp(path.resolve(import.meta.dirname,'..','server','third-party'),path.join(root,llamaManifest.version,'licenses'),{recursive:true});
