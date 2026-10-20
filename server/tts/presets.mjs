import fs from 'node:fs/promises';
import path from 'node:path';
import {downloadFile,safeFolder} from './installer.mjs';
import {convertReference} from './audio.mjs';
export const presets=JSON.parse(await fs.readFile(new URL('./presets.json',import.meta.url),'utf8'));
export async function restoreVoicePresets(storage,referenceDir){
 await fs.mkdir(referenceDir,{recursive:true});
 for(const p of presets)for(const suffix of ['.wav','.json'])await fs.copyFile(path.join(storage,'voice-presets',p.id+suffix),path.join(referenceDir,p.id+suffix),1).catch(e=>{if(!['EEXIST','ENOENT'].includes(e.code))throw e;});
}
export async function installVoicePresets(storage,referenceDir,runtime,signal){
 const folder=await safeFolder(storage,'voice-presets');await fs.mkdir(referenceDir,{recursive:true});
 for(const p of presets){
  const destination=path.join(folder,p.gender+'.mp3');await downloadFile(p.url,destination,{...p,signal});
  const target=path.join(folder,p.id+'.wav');if(!await fs.stat(target).catch(()=>null)){const audio=await convertReference(await fs.readFile(destination),{runtimes:[runtime]});await fs.writeFile(target,audio.bytes);await fs.writeFile(path.join(folder,p.id+'.json'),JSON.stringify({...p,preset:true,duration:audio.duration},null,2));}
 }
 await restoreVoicePresets(storage,referenceDir);
}
