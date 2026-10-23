import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
export const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const appOnly=process.argv.includes('--app-only');
if(process.platform!=='win32')throw new Error('Windows packaging requires Windows; web development is cross-platform.');
if(!appOnly)for(const file of ['runtime/llama/b10809/cpu/llama-server.exe','runtime/speech/runtime/silero-cpu/python.exe','runtime/speech/models/silero/v3_1_ru.pt','runtime/speech/models/silero/v3_en.pt'])await fs.access(path.join(root,file)).catch(()=>{throw new Error('Missing runtime: '+file+'. See docs/BUILDING.md or npm run prepare:runtime -- --archive <release.zip>.');});
const output=path.join(root,'release',version),source=path.join(output,'staging'),runtime=path.join(output,'windows');
const inside=target=>{if(!path.resolve(target).startsWith(output+path.sep))throw new Error('Build path outside release workspace');};
async function run(exe,args,env={}){await new Promise((resolve,reject)=>{const p=spawn(exe,args,{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('Build command failed: '+code)));});}
await run(process.execPath,[path.join(root,'scripts/build-rag.mjs')]);
for(const target of [source,runtime,path.join(output,'build/win-unpacked')]){
 inside(target);
 const stat=await fs.lstat(target).catch(()=>null);
 if(stat){if(stat.isSymbolicLink()||!(await fs.realpath(target)).toLowerCase().startsWith((output+path.sep).toLowerCase()))throw Error('Unsafe build output cleanup');await fs.rm(target,{recursive:true,force:true,maxRetries:5});}
}
await fs.mkdir(source,{recursive:true});await fs.mkdir(runtime,{recursive:true});
const excluded=/\.d\.mts$|(?:LICENSE-(?:espeak|kokoro|onnx)|ESPEAK-BUILD)|\.(?:zip|7z|log|pyc)$|(?:^|[/\\])__pycache__(?:[/\\]|$)|(?:kokoro-worker|phonemes|phoneme-normalize)\.mjs$/;
for(const folder of ['assets','server','electron','shared'])await fs.cp(path.join(root,folder),path.join(source,folder),{recursive:true,filter:p=>!excluded.test(p)});
for(const file of ['COPYRIGHT.md','LICENSE','NOTICE','THIRD-PARTY.md'])await fs.copyFile(path.join(root,file),path.join(source,file));
const edition=path.join(source,'shared/speech-edition.mjs');
const originalEdition=await fs.readFile(edition,'utf8');
await fs.writeFile(edition,originalEdition.replace("defaultProvider:'kokoro-ru',disabledProviders:[]","defaultProvider:'silero',disabledProviders:['kokoro','kokoro-ru']"));
const catalogFile=path.join(source,'server/tts/catalog.json');
await fs.writeFile(catalogFile,JSON.stringify(JSON.parse(await fs.readFile(catalogFile,'utf8')).filter(m=>!m.id.startsWith('kokoro')),null,2));
await fs.writeFile(path.join(source,'server/third-party/SPEECH-NOTICES.md'),'# Speech components\n\nSilero v3_1_ru and v3_en: CC BY-NC-SA 4.0; upstream https://github.com/snakers4/silero-models . Model catalog and license are included. Python is PSF; PyTorch and NumPy are BSD; their original notices remain in engines/speech/runtime/silero-cpu. Optional XTTS v2 and Fish Speech retain their own licenses. Kokoro, ONNX Runtime and eSpeak are not included in this package.\n');
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
manifest.version=version;manifest.author={name:'Padparaja-Ge and Wenzeslaus-first'};
delete manifest.build;delete manifest.scripts;delete manifest.devDependencies;
// Browser dependencies are already compiled into dist; these server modules do
// not import React, fontsource, lucide, ONNX Runtime or eSpeak.
for(const name of ['espeak-ng','onnxruntime-node','react','react-dom','lucide-react','@fontsource-variable/manrope'])delete manifest.dependencies[name];
await fs.writeFile(path.join(source,'package.json'),JSON.stringify(manifest,null,2));
const visited=new Set();
async function dependency(name,from){
 let directory=from,location;
 while(directory.startsWith(root)){
  const candidate=path.join(directory,'node_modules',name);
  if(await fs.stat(path.join(candidate,'package.json')).catch(()=>null)){location=candidate;break;}
  if(directory===root)break;directory=path.dirname(directory);
 }
 if(!location)throw new Error('Missing production dependency '+name);
 if(visited.has(location))return;visited.add(location);
 const target=path.join(source,path.relative(root,location));inside(target);
 await fs.cp(location,target,{recursive:true,filter:p=>!/(?:^|[/\\])(?:test|tests|docs|example|examples|\.github)(?:[/\\]|$)/.test(path.relative(location,p))});
 const pkg=JSON.parse(await fs.readFile(path.join(location,'package.json'),'utf8'));
 for(const dep of Object.keys(pkg.dependencies||{}))await dependency(dep,location);
 for(const dep of Object.keys(pkg.optionalDependencies||{}))try{await dependency(dep,location);}catch{}
}
for(const name of Object.keys(manifest.dependencies))await dependency(name,root);
await run(process.execPath,[require.resolve('typescript/bin/tsc'),'-b']);
await run(process.execPath,[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build'],{SAS_PUBLIC_EDITION_MODULE:edition,SAS_PUBLIC_DIST:path.join(source,'dist')});
const config={appId:'local.superaistory.sas',productName:'Super AI Story',executableName:'SAS',copyright:'Copyright 2026 Padparaja. Developers: Padparaja-Ge and Wenzeslaus-first.',directories:{app:source,output:path.join(output,'build')},files:['**/*','!**/*.test.*','!**/*.zip','!**/__pycache__/**'],extraResources:[],asarUnpack:['server/tts/python-worker.py','server/tts/silero-worker.py'],win:{icon:path.join(root,'assets/sas.ico')}};
const configFile=path.join(output,'builder.json');await fs.writeFile(configFile,JSON.stringify(config,null,2));
await run(process.execPath,[require.resolve('electron-builder/cli.js'),'--win','--dir','--config',configFile]);
await fs.cp(path.join(output,'build/win-unpacked'),path.join(runtime,'app'),{recursive:true});
if(appOnly){console.log(JSON.stringify({version,application:path.join(runtime,'app'),runtimeBundled:false}));process.exit(0);}
await fs.cp(path.join(root,'runtime/llama/b10809'),path.join(runtime,'engines/llama/b10809'),{recursive:true,filter:p=>{const rel=path.relative(path.join(root,'runtime/llama/b10809'),p);return !/\.zip$|LICENSE-(?:espeak|kokoro|onnx)|SPEECH-NOTICES/.test(rel)&&(!/\.exe$/i.test(rel)||path.basename(rel)==='llama-server.exe');}});
await fs.cp(path.join(root,'runtime/speech'),path.join(runtime,'engines/speech'),{recursive:true,filter:p=>!/(?:^|[/\\])(?:kokoro|kokoro-ru|tests|test|benchmarks|__pycache__)(?:[/\\]|$)|\.pyc$/.test(path.relative(path.join(root,'runtime/speech'),p))});
for(const file of ['LICENSE-Silero-models.txt','SILERO-NOTICE.md'])await fs.copyFile(path.join(root,'server/third-party',file),path.join(runtime,'engines/speech',file));
const compile=`$compiler=New-Object Microsoft.CSharp.CSharpCodeProvider; $parameters=New-Object System.CodeDom.Compiler.CompilerParameters; $parameters.GenerateExecutable=$true; $parameters.OutputAssembly=$env:SAS_LAUNCHER_EXE; $parameters.ReferencedAssemblies.Add('System.dll') | Out-Null; $parameters.ReferencedAssemblies.Add('System.Windows.Forms.dll') | Out-Null; $parameters.CompilerOptions='/target:winexe /win32icon:"'+$env:SAS_LAUNCHER_ICON+'"'; $result=$compiler.CompileAssemblyFromSource($parameters,[IO.File]::ReadAllText($env:SAS_LAUNCHER_SOURCE)); if($result.Errors.HasErrors){$result.Errors | ForEach-Object {Write-Error $_};exit 1}`;
// Compile an ordinary tiny launcher, not a self-extracting archive.
const launcherSource=path.join(output,'build','launcher.cs');await fs.writeFile(launcherSource,(await fs.readFile(path.join(root,'distribution/launcher.cs'),'utf8')).replace(/Assembly(File)?Version\("[0-9.]+"\)/g,(_match,file)=>'Assembly'+(file||'')+'Version("'+version+'.0")'));
const launcher=path.join(runtime,'SAS.exe');if(await fs.stat(launcher).catch(()=>null)){inside(launcher);await fs.unlink(launcher);}
await run(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',compile],{SAS_LAUNCHER_SOURCE:launcherSource,SAS_LAUNCHER_EXE:launcher,SAS_LAUNCHER_ICON:path.join(root,'assets/sas.ico')});
console.log(JSON.stringify({version,output:runtime,dependencies:visited.size,runtimeBundled:true}));
