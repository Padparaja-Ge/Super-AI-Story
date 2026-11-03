import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('Web installer reads the final status when a reused process exits between polls',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-web-status-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));
 const installer=path.resolve('distribution/Install-SAS.ps1').replaceAll("'","''");
 const script=`$ErrorActionPreference='Stop'
. '${installer}'
function Read-SasManifest { return @{} }
function Test-SasReady { return $true }
$script:scenario='ready'
function Start-Process {
 param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
 [IO.File]::WriteAllText($env:SAS_STARTUP_FILE,'{"progress":10,"complete":false}')
 $process=New-Object PSObject
 $process | Add-Member -MemberType ScriptProperty -Name HasExited -Value {
  $last=if($script:scenario -eq 'ready'){'{"progress":100,"complete":true,"url":"http://127.0.0.1:3212","alreadyRunning":true}'}elseif($script:scenario -eq 'failure'){'{"progress":25,"complete":true,"error":"EXPECTED_STARTUP_FAILURE"}'}else{'{"progress":10,"complete":false}'}
  [IO.File]::WriteAllText($env:SAS_STARTUP_FILE,$last)
  return $true
 }
 return $process
}
$result=Invoke-SasInstaller '${dir.replaceAll("'","''")}' 'Web'
if($result.url -cne 'http://127.0.0.1:3212' -or -not $result.alreadyRunning){throw 'Final ready status was lost'}
$script:scenario='failure';$failed=$false
try{Invoke-SasInstaller '${dir.replaceAll("'","''")}' 'Web'}catch{if($_.Exception.Message -cne 'EXPECTED_STARTUP_FAILURE'){throw};$failed=$true}
if(-not $failed){throw 'Final error status was ignored'}
$script:scenario='missing';$failed=$false
try{Invoke-SasInstaller '${dir.replaceAll("'","''")}' 'Web'}catch{if($_.Exception.Message -cne 'SAS stopped before reporting readiness.'){throw};$failed=$true}
if(-not $failed){throw 'Incomplete status was accepted'}
Write-Output 'STATUS_RACE_OK'
`;
 const file=path.join(dir,'check.ps1');await fs.writeFile(file,script);
 const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',windowsHide:true,timeout:process.env.CI?90000:15000});
 assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));assert.match(result.stdout,/STATUS_RACE_OK/);
});
