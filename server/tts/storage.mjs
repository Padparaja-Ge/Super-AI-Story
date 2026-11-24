import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

export function speechBundleDirectory({environment=process.env,resourcesPath=process.resourcesPath,sourceRoot=path.resolve(import.meta.dirname,'../../runtime/speech'),exists=existsSync}={}){
 if(environment.SAS_SPEECH_BUNDLE_DIR)return environment.SAS_SPEECH_BUNDLE_DIR;
 const candidates=[resourcesPath&&path.join(resourcesPath,'speech'),resourcesPath&&path.resolve(resourcesPath,'../../engines/speech'),sourceRoot].filter(Boolean);
 return candidates.find(directory=>exists(directory))||sourceRoot;
}

export async function speechStorageDirectory(modelsDir,{platform=process.platform,access=fs.access}={}){
 const paths=platform==='win32'?path.win32:path;
 if(platform==='win32'){
  try{await access(paths.parse(modelsDir).root);}
  catch(error){if(!['ENOENT','ENOTDIR','ENODEV','EACCES','EPERM'].includes(error.code))throw error;throw Object.assign(new Error('Папка загрузки моделей недоступна: '+modelsDir+'. Проверьте диск и выберите существующую папку в настройках «Модели и API».'),{status:409,code:'SPEECH_STORAGE_UNAVAILABLE'});}
 }
 return paths.join(modelsDir,'sas-tts');
}
