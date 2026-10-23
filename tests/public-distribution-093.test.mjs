import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {speechDefaults} from '../shared/speech.mjs';
const require=createRequire(import.meta.url),AdmZip=require('adm-zip'),root=path.resolve(import.meta.dirname,'..');
const hash=data=>createHash('sha256').update(data).digest('hex');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
test('Public commands use ready files; developer speech still includes Kokoro',async()=>{
 assert.equal(speechDefaults.provider,'kokoro-ru');
 for(const name of ['Start-SAS','Start-SAS-Web','Start-SAS-Web-Shell','Stop-SAS-Web','Repair-SAS']){
  const bytes=await fs.readFile(path.join(root,'distribution',name+'.cmd'));assert.ok(bytes.every(b=>b<128));assert.doesNotMatch(bytes.toString(),/(?<!\r)\n|npm|node |vite|tsc/i);assert.match(bytes.toString(),/Install-SAS\.ps1/);
 }
});
test('Extract-once installer supports offline checks, explicit corruption repair, failed downloads and ZIP traversal protection',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sas setup '093-"));t.after(()=>fs.rm(dir,{force:true,recursive:true,maxRetries:5}));
 const install=path.join(dir,'install');await fs.mkdir(install);
 const content={'SAS.exe':Buffer.alloc(256,1),'app/SAS.exe':Buffer.alloc(256,2),'app/resources/app.asar':Buffer.alloc(512,3)};
 const base={format:2,repository:'Padparaja-Ge/Super-AI-Story',version:'0.9.3',files:Object.entries(content).map(([name,data])=>({path:name,size:data.length,sha256:hash(data),critical:true}))};
 const zip=new AdmZip();for(const [name,data]of Object.entries(content))zip.addFile(name,data);zip.addFile('.sas-payload.json',Buffer.from(JSON.stringify(base)));zip.writeZip(path.join(dir,'good.zip'));
 const bytes=await fs.readFile(path.join(dir,'good.zip')),manifest={...base,asset:'SAS-Windows-0.9.3.zip',size:bytes.length,sha256:hash(bytes)};
 const malicious=new AdmZip();for(const[name,data]of Object.entries(content))malicious.addFile(name,data);malicious.addFile('.sas-payload.json',Buffer.from(JSON.stringify(base)));malicious.addFile('../outside.txt',Buffer.from('ESCAPE'));malicious.writeZip(path.join(dir,'evil.zip'));
 const evilBytes=await fs.readFile(path.join(dir,'evil.zip'));await fs.writeFile(path.join(dir,'evil-manifest.json'),JSON.stringify({...manifest,size:evilBytes.length,sha256:hash(evilBytes)}));
 await fs.writeFile(path.join(install,'release-manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(install,'web-server.json'),'USER_CONFIG');await fs.writeFile(path.join(install,'state.json'),'USER_HISTORY');
 const script=`$ErrorActionPreference='Stop'
. ${quote(path.join(root,'distribution/Install-SAS.ps1'))}
$dir=${quote(install)};$fixture=${quote(dir)};$script:downloads=0
function Receive-SasAsset([string]$Url,[string]$Temporary,[long]$Size){
 if($Url -cne 'https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v0.9.3/SAS-Windows-0.9.3.zip'){throw 'Unexpected URL'}
 $script:downloads++;Copy-Item -LiteralPath (Join-Path $fixture 'good.zip') -Destination $Temporary
}
Invoke-SasInstaller $dir 'Install'
Invoke-SasInstaller $dir 'Check'
if($script:downloads -ne 1){throw 'Offline check downloaded again'}
[IO.File]::WriteAllBytes((Join-Path $dir 'app/resources/app.asar'),(New-Object byte[] 512))
$m=Read-SasManifest $dir
if(Test-SasReady $dir $m -Deep){throw 'Same-size corruption was not detected'}
Invoke-SasInstaller $dir 'Repair'
if($script:downloads -ne 2){throw 'Repair did not download'}
function Receive-SasAsset([string]$Url,[string]$Temporary,[long]$Size){[IO.File]::WriteAllText($Temporary,'CORRUPTED')}
$failed=$false;try{Install-SasRuntime $dir $m}catch{$failed=$true}
if(-not $failed -or -not(Test-SasReady $dir $m -Deep)){throw 'Tampered download replaced good files'}
function Receive-SasAsset {throw 'NETWORK_OFFLINE'}
Invoke-SasInstaller $dir 'Check'
$failed=$false;try{Install-SasRuntime $dir $m}catch{$failed=$true}
if(-not $failed -or -not(Test-SasReady $dir $m -Deep)){throw 'Network error damaged installation'}
function Receive-SasAsset([string]$Url,[string]$Temporary,[long]$Size){Copy-Item -LiteralPath (Join-Path $fixture 'evil.zip') -Destination $Temporary}
$evil=Get-Content -LiteralPath (Join-Path $fixture 'evil-manifest.json') -Raw|ConvertFrom-Json
$failed=$false;try{Install-SasRuntime $dir $evil}catch{$failed=$true}
if(-not $failed -or (Test-Path -LiteralPath (Join-Path $dir 'outside.txt')) -or (Test-Path -LiteralPath (Join-Path $fixture 'outside.txt'))){throw 'ZIP escape was accepted'}
$m.files[0].path='../outside.exe';$m|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $dir 'release-manifest.json') -Encoding UTF8
$failed=$false;try{Read-SasManifest $dir|Out-Null}catch{$failed=$true};if(-not $failed){throw 'Invalid manifest accepted'}
if((Get-Content -LiteralPath (Join-Path $dir 'web-server.json') -Raw) -cne 'USER_CONFIG'){throw 'Config changed'}
if((Get-Content -LiteralPath (Join-Path $dir 'state.json') -Raw) -cne 'USER_HISTORY'){throw 'History changed'}
if(@(Get-ChildItem -LiteralPath $dir -Force -Filter '.sas-setup-*').Count){throw 'Staging folder retained'}
Write-Output 'INSTALLER_TESTS_OK'
`;
 const scriptFile=path.join(dir,'check.ps1');await fs.writeFile(scriptFile,script);
 const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];env.PATH=path.join(process.env.SystemRoot,'System32');
 const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',scriptFile],{env,encoding:'utf8',windowsHide:true,timeout:process.env.CI?90000:30000});
 assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));assert.match(result.stdout,/INSTALLER_TESTS_OK/);
});
