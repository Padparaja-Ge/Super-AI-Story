import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {installationProgress,pipProgress} from '../shared/speech-install.mjs';
import {createSpeechService} from '../server/tts/service.mjs';
import {speechSettings} from '../shared/speech.mjs';

async function fixture(t,options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-speech-install-')),state={settings:{speech:speechSettings()},chats:[{id:'rp',summary:'RP_PRIVATE'}],multiplayer:{summary:'DND_PRIVATE'},fanficProjects:[{memory:'FANFIC_PRIVATE'}]};
 const service=createSpeechService({dataDir:dir,getState:()=>state,saveState:()=>assert.fail('Installation must not edit stories/settings'),getModelsDir:async()=>dir,bundledRoot:null,preparePresets:async()=>{},...options});
 t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5});});
 const registry=()=>fs.readFile(path.join(dir,'tts-models.json'),'utf8').then(JSON.parse);
 return {dir,state,service,registry};
}
async function until(check){for(let i=0;i<200;i++){const result=await check();if(result)return result;await pause(10);}assert.fail('Job did not reach expected state');}

test('Pip raw progress handles split chunks, package changes and malformed output',()=>{
 const job={},write=pipProgress(job);write('Downloading torch-2.4.1%2Bcu121-cp312-win_amd64.whl (2444.8 MB)\r\nPro');write('gress 512 of 2048\n');
 assert.equal(job.runtimeFile,'torch-2.4.1+cu121-cp312-win_amd64.whl');assert.equal(job.runtimeDownloaded,512);assert.equal(job.runtimeTotal,2048);
 write('Progress 4096 of 2048\nProgress 1 of 0\n');assert.equal(job.runtimeDownloaded,512);
 write('Downloading torchaudio.whl (5 MB)\n');assert.equal(job.runtimeDownloaded,0);assert.equal(job.runtimeTotal,0);
 write('Progress 1024 of 1024\nInstalling collected packages: torch, torchaudio\n');assert.equal(job.runtimeTotal,0);assert.equal(job.runtimeFile,'');
 assert.doesNotThrow(()=>write('Downloading bad%ZZ.whl (1 MB)\n'));assert.equal(job.runtimeFile,'bad%ZZ.whl');
});
test('Runtime progress never displays completed model bytes as completed CUDA installation',()=>{
 const job={downloaded:1466,total:1466,phase:'weights'};assert.equal(installationProgress(job).downloaded,1466);
 job.phase='runtime';assert.equal(installationProgress(job).total,0);job.runtimeTotal=2444;job.runtimeDownloaded=500;job.runtimeFile='torch.whl';
 assert.deepEqual(installationProgress(job),{downloaded:500,total:2444,label:'torch.whl',weightsComplete:true});
 job.phase='verify';job.runtimeTotal=0;job.runtimeDownloaded=0;assert.equal(installationProgress(job).total,0);
});
test('Restart recovers interrupted installation while preserving model locations and story memory',async t=>{
 const f=await fixture(t),before=structuredClone(f.state),record={fish:{folder:'existing-model',runtimes:{cpu:'existing-runtime'},lastInstall:{id:'old-job',provider:'fish',device:'gpu',status:'running'}}};
 await fs.writeFile(path.join(f.dir,'tts-models.json'),JSON.stringify(record));const status=await f.service.status(),saved=await f.registry();
 assert.equal(status.jobs.length,0);assert.equal(saved.fish.lastInstall.status,'interrupted');assert.match(saved.fish.lastInstall.error,/загруженные веса сохранены/);assert.equal(saved.fish.folder,record.fish.folder);assert.deepEqual(saved.fish.runtimes,record.fish.runtimes);assert.deepEqual(f.state,before);
});
test('Runtime-only installation persists running progress and completion without fetching model weights',async t=>{
 let finish,entered;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>finish=resolve);
 const f=await fixture(t,{installRuntime:async(root,provider,device,job)=>{job.runtimeTotal=200;job.runtimeDownloaded=50;job.runtimeFile='torch.whl';entered();await blocked;return path.join(root,'runtime',provider+'-'+device);}});
 const snapshot=await f.service.install('fish','gpu',{runtimeOnly:true});await started;
 assert.equal(f.service.isInstalling(),true);
 const running=await f.registry();assert.equal(running.fish.lastInstall.status,'running');assert.equal(running.fish.lastInstall.device,'gpu');
 const status=await f.service.status(),job=status.jobs.find(j=>j.id===snapshot.id);assert.equal(job.phase,'runtime');assert.equal(job.runtimeDownloaded,50);assert.equal(job.total,0);
 finish();await until(async()=>(await f.service.status()).jobs.find(j=>j.id===snapshot.id).status==='complete');assert.equal(f.service.isInstalling(),false);assert.equal((await f.registry()).fish.runtimes.gpu,path.join(f.dir,'sas-tts/runtime/fish-gpu'));await assert.rejects(fs.stat(path.join(f.dir,'sas-tts/models')),{code:'ENOENT'});
});
test('Closing during installation records cancellation and retains previously installed weights',async t=>{
 let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{installRuntime:async(root,provider,device,job)=>{entered();await new Promise((resolve,reject)=>job.controller.signal.addEventListener('abort',()=>reject(job.controller.signal.reason),{once:true}));}});
 const folder=path.join(f.dir,'sas-tts/models/fish');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'sas-installed.json'),'existing weight marker');await fs.writeFile(path.join(f.dir,'tts-models.json'),JSON.stringify({fish:{folder}}));
 await f.service.install('fish','gpu',{runtimeOnly:true});await started;await f.service.close();const saved=await f.registry();assert.equal(saved.fish.lastInstall.status,'cancelled');assert.match(saved.fish.lastInstall.error,/веса сохранены/);assert.equal(saved.fish.folder,folder);assert.equal(await fs.readFile(path.join(folder,'sas-installed.json'),'utf8'),'existing weight marker');
});
test('A runtime marker for another provider or device cannot claim CUDA readiness',async t=>{
 const f=await fixture(t),location=path.join(f.dir,'sas-tts/runtime/fish-gpu'),python=path.join(location,process.platform==='win32'?'Scripts/python.exe':'bin/python');await fs.mkdir(path.dirname(python),{recursive:true});await fs.writeFile(python,'test executable, never run');
 for(const marker of [{provider:'xtts',device:'gpu',version:4},{provider:'fish',device:'cpu',version:4},{provider:'fish',device:'gpu',version:3}]){await fs.writeFile(path.join(location,'sas-ready.json'),JSON.stringify(marker));assert.equal((await f.service.status()).models.find(m=>m.id==='fish').runtimeReady.gpu,false);}
 await fs.writeFile(path.join(location,'sas-ready.json'),JSON.stringify({provider:'fish',device:'gpu',version:4}));assert.equal((await f.service.status()).models.find(m=>m.id==='fish').runtimeReady.gpu,true);
});
