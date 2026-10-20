import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('Public web launcher opens the ready URL, keeps its result visible and tolerates a missing browser',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-web-result-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const installer=path.resolve('distribution/Install-SAS.ps1').replaceAll("'","''");
 const script=`$ErrorActionPreference='Stop'
. '${installer}'
$script:opened=@();$script:prompts=0;$script:browserFails=$false
Remove-Item Env:SAS_WEB_NO_BROWSER -ErrorAction SilentlyContinue
Remove-Item Env:SAS_WEB_NO_PAUSE -ErrorAction SilentlyContinue
function Start-Process { [CmdletBinding()]param([string]$FilePath)
 if($script:browserFails){throw 'No default browser'};$script:opened+=,$FilePath
}
function Read-Host { param([string]$Prompt) $script:prompts++;return '' }
Show-SasWebResult 'http://127.0.0.1:3212/' -WaitForEnter
if($script:opened.Count -ne 1 -or $script:opened[0] -cne 'http://127.0.0.1:3212/' -or $script:prompts -ne 1){throw 'Ready URL or console prompt missing'}
$script:browserFails=$true
Show-SasWebResult 'http://127.0.0.1:3212/' -WaitForEnter
if($script:prompts -ne 2){throw 'Browser failure hid the ready result'}
$script:browserFails=$false
$env:SAS_WEB_NO_BROWSER='1';$env:SAS_WEB_NO_PAUSE='1'
Show-SasWebResult 'http://127.0.0.1:3212/' -WaitForEnter
if($script:opened.Count -ne 1 -or $script:prompts -ne 2){throw 'Noninteractive switches were ignored'}
foreach($url in @('file:///C:/Windows/System32/calc.exe','https://example.com/','http://user:password@127.0.0.1:3212/','not a URL')){
 $rejected=$false;try{Show-SasWebResult $url}catch{$rejected=$true}
 if(-not $rejected){throw 'Invalid browser address was accepted'}
}
Write-Output 'WEB_RESULT_OK'
`;
 const file=path.join(dir,'check.ps1');await fs.writeFile(file,script);
 const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/WEB_RESULT_OK/);
 for(const name of ['Start-SAS-Web.cmd','Start-SAS-Web-Shell.cmd'])assert.match(await fs.readFile(path.join('distribution',name),'utf8'),/-KeepConsole/);
});
