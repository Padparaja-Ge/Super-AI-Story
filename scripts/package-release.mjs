import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {releaseNetworkConfig} from './release-config.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const output=path.join(root,'release',version),runtime=path.join(output,'windows'),repo=path.join(output,'installer');
const files=['LICENSE','NOTICE','README.md','COPYRIGHT.md','THIRD-PARTY.md','Install-SAS.ps1','web-server.json','Start-SAS.cmd','Start-SAS-Web.cmd','Start-SAS-Web-Shell.cmd','Stop-SAS-Web.cmd','Repair-SAS.cmd','release-manifest.json'];
await fs.mkdir(repo,{recursive:true});
await fs.writeFile(path.join(root,'distribution/web-server.json'),await releaseNetworkConfig());
for(const [name,action] of Object.entries({'Start-SAS':'Desktop','Start-SAS-Web':'Web','Start-SAS-Web-Shell':'Shell','Stop-SAS-Web':'Stop','Repair-SAS':'Repair'}))await fs.writeFile(path.join(root,'distribution',name+'.cmd'),['@echo off','setlocal','cd /d "%~dp0"','"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-SAS.ps1" -Action '+action+(['Web','Shell'].includes(action)?' -KeepConsole':''),'if errorlevel 1 (','  echo.','  pause','  exit /b 1',')','endlocal',''].join('\r\n'),'ascii');
const digest=async file=>{const h=createHash('sha256');for await(const block of createReadStream(file))h.update(block);return h.digest('hex');};
const payload=[];
async function visit(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Unexpected release link');if(e.isDirectory())await visit(p);else{const rel=path.relative(runtime,p).replaceAll('\\','/');if(!/^(SAS\.exe|app\/|engines\/)/.test(rel))continue;payload.push({path:rel,size:(await fs.stat(p)).size,sha256:await digest(p),critical:rel==='SAS.exe'||rel==='app/SAS.exe'||rel==='app/resources/app.asar'||/^app\/[^/]+\.dll$/.test(rel)||/llama-server\.exe$|silero-cpu\/python\.exe$|models\/silero\/.*\.pt$/.test(rel)});}}}
await visit(runtime);payload.sort((a,b)=>a.path.localeCompare(b.path));
if(payload.some(f=>/kokoro|node_modules\/onnxruntime|espeak|phonemes\.mjs/i.test(f.path)))throw Error('Unexpected optional speech components in bundled runtime');
const base={format:2,repository:'Padparaja-Ge/Super-AI-Story',version,files:payload};
await fs.writeFile(path.join(runtime,'.sas-payload.json'),JSON.stringify(base)+'\n');
for(const file of files.filter(f=>f!=='release-manifest.json'))await fs.copyFile(path.join(root,'distribution',file),path.join(runtime,file));
const archiver=require('archiver');
async function zip(name,folder,selected){const file=path.join(output,name),stream=createWriteStream(file),a=archiver('zip',{zlib:{level:6}});const done=new Promise((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject);a.once('error',reject);});a.pipe(stream);if(selected)for(const f of selected)a.file(path.join(folder,f),{name:f});else a.directory(folder,false);await a.finalize();await done;const size=(await fs.stat(file)).size;if(size>=2**31)throw Error('GitHub asset exceeds 2 GiB');return {name,path:file,size,sha256:await digest(file)};}
const full=await zip('SAS-Windows-'+version+'.zip',runtime);
const manifest={...base,asset:full.name,size:full.size,sha256:full.sha256};
await fs.writeFile(path.join(root,'distribution/release-manifest.json'),JSON.stringify(manifest)+'\n');
for(const file of files)await fs.copyFile(path.join(root,'distribution',file),path.join(repo,file));
const extra=(await fs.readdir(repo)).filter(f=>f!=='.git'&&!files.includes(f));if(extra.length)throw Error('Unexpected installer files '+extra);
const starter=await zip('SAS-Start-'+version+'.zip',repo,files);
const webLauncher=await zip('SAS-Web-Launcher.zip',repo,['Install-SAS.ps1','Start-SAS-Web.cmd','Start-SAS-Web-Shell.cmd']);
const manifestFile=path.join(repo,'release-manifest.json');
const assets=[full,starter,webLauncher,{name:'release-manifest.json',path:manifestFile,size:(await fs.stat(manifestFile)).size,sha256:await digest(manifestFile)}];
for(const name of ['SAS-Web-'+version+'.zip','SAS-Campaign-Notes-1.0.0.zip']){const file=path.join(output,name),info=await fs.stat(file).catch(()=>null);if(info?.isFile())assets.push({name,path:file,size:info.size,sha256:await digest(file)});}
const sums=path.join(output,'SHA256SUMS.txt');await fs.writeFile(sums,assets.map(a=>a.sha256+'  '+a.name).join('\n')+'\n');assets.push({name:'SHA256SUMS.txt',path:sums,size:(await fs.stat(sums)).size,sha256:await digest(sums)});
await fs.writeFile(path.join(output,'publication-input.json'),JSON.stringify({repository:base.repository,version,installerFiles:files,assets},null,2));
console.log(JSON.stringify({version,installedBytes:payload.reduce((sum,f)=>sum+f.size,0),installedFiles:payload.length,assets:assets.map(({path,...a})=>a)},null,2));
