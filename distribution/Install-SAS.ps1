param([ValidateSet('Desktop','Web','Shell','Stop','Install','Repair','Check')][string]$Action='Desktop',[switch]$KeepConsole,[switch]$NoBrowser)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:Repository='Padparaja-Ge/Super-AI-Story'

function Show-SasProgress([int]$Percent) {
    $n=[Math]::Max(0,[Math]::Min(30,[int]($Percent*30/100)))
    Write-Host -NoNewline ("`r["+('#'*$n)+('-'*(30-$n))+'] '+$Percent.ToString().PadLeft(3)+'%')
}
function Test-SasHash([string]$File,[string]$Expected) {
    $stream=[IO.File]::OpenRead($File);$sha=[Security.Cryptography.SHA256]::Create()
    try {return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() -ceq $Expected}
    finally {$stream.Dispose();$sha.Dispose()}
}
function Resolve-SasPath([string]$Directory,[string]$Relative) {
    if([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('\') -or $Relative -match '[:\x00-\x1f]' -or $Relative.StartsWith('/') -or ($Relative.Split('/') | Where-Object {$_ -in @('.','..','')})){throw 'Unsafe release path.'}
    $root=[IO.Path]::GetFullPath($Directory).TrimEnd('\')+'\'
    $target=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$Relative.Replace('/','\')))
    if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Path outside the SAS folder.'}
    return $target
}
function Read-SasManifest([string]$Directory) {
    $filename=Join-Path $Directory 'release-manifest.json'
    if(-not(Test-Path -LiteralPath $filename)){ $filename=Join-Path $Directory '.sas-payload.json' }
    $m=Get-Content -LiteralPath $filename -Raw -Encoding UTF8|ConvertFrom-Json
    if($m.format -ne 2 -or $m.repository -cne $script:Repository -or $m.version -notmatch '^\d+\.\d+\.\d+$' -or @($m.files).Count -lt 3 -or @($m.files).Count -gt 20000){throw 'Invalid SAS release manifest.'}
    $paths=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($f in $m.files){
        $null=Resolve-SasPath $Directory $f.path
        if($f.path -notmatch '^(SAS\.exe|app/.+|engines/.+)$' -or -not $paths.Add($f.path) -or $f.sha256 -notmatch '^[a-f0-9]{64}$' -or $f.size -lt 0 -or $f.size -ge 4294967296){throw 'Invalid release file entry.'}
    }
    if(-not $paths.Contains('SAS.exe') -or -not $paths.Contains('app/SAS.exe') -or -not $paths.Contains('app/resources/app.asar')){throw 'Incomplete SAS release manifest.'}
    if($m.PSObject.Properties['asset']){
        if($m.asset -cne ('SAS-Windows-'+$m.version+'.zip') -or $m.size -lt 1 -or $m.size -ge 2147483648 -or $m.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid release download.'}
    }
    return $m
}
function Test-SasReady([string]$Directory,$Manifest,[switch]$Deep) {
    $files=if($Deep){@($Manifest.files)}else{@($Manifest.files|Where-Object {$_.critical})}
    $index=0
    foreach($f in $files){
        $target=Resolve-SasPath $Directory $f.path
        if(-not(Test-Path -LiteralPath $target -PathType Leaf) -or (Get-Item -LiteralPath $target).Length -ne $f.size){return $false}
        if($Deep -and -not(Test-SasHash $target $f.sha256)){return $false}
        if($Deep){$index++;Show-SasProgress ([int](100*$index/$files.Count))}
    }
    if($Deep){Write-Host ''}
    return $true
}
function Receive-SasAsset([string]$Url,[string]$Temporary,[long]$Size) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    $client=New-Object Net.WebClient;$client.Headers.Add('User-Agent','Super-AI-Story-Installer')
    try {
        $task=$client.DownloadFileTaskAsync([Uri]$Url,$Temporary)
        while(-not $task.IsCompleted){
            if(Test-Path -LiteralPath $Temporary){Show-SasProgress ([Math]::Min(99,[int](100*(Get-Item -LiteralPath $Temporary).Length/[Math]::Max(1,$Size))))}
            Start-Sleep -Milliseconds 200
        }
        $task.GetAwaiter().GetResult();Show-SasProgress 100;Write-Host ''
    }finally{$client.Dispose()}
}
function Install-SasRuntime([string]$Directory,$Manifest) {
    # A complete ZIP also contains an offline payload manifest. Obtain the
    # detached archive digest only if a repair/download is actually necessary.
    if(-not $Manifest.PSObject.Properties['asset']){
        $temp=Join-Path $Directory ('manifest-'+[Guid]::NewGuid().ToString('N')+'.tmp')
        try {
            Receive-SasAsset ('https://github.com/'+$script:Repository+'/releases/download/v'+$Manifest.version+'/release-manifest.json') $temp 1000000
            $fresh=Get-Content -LiteralPath $temp -Raw -Encoding UTF8|ConvertFrom-Json
            if($fresh.repository -cne $script:Repository -or $fresh.version -cne $Manifest.version -or $fresh.format -ne 2){throw 'Unexpected download manifest.'}
            Move-Item -LiteralPath $temp -Destination (Join-Path $Directory 'release-manifest.json') -Force
            $Manifest=Read-SasManifest $Directory
        }finally{if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}}
    }
    # Catch an active desktop/web installation before downloading or replacing files.
    foreach($rel in @('SAS.exe','app/SAS.exe')){
        $target=Resolve-SasPath $Directory $rel
        if(Test-Path -LiteralPath $target){try{$probe=[IO.File]::Open($target,'Open','ReadWrite','None');$probe.Dispose()}catch{throw 'Close SAS and stop its web server before installing or repairing.'}}
    }
    $archive=Join-Path $Directory ($Manifest.asset+'.download')
    $stage=Join-Path $Directory ('.sas-setup-'+[Guid]::NewGuid().ToString('N'))
    try {
        Write-Host ('Installing SAS '+$Manifest.version+' (one-time extraction).')
        Receive-SasAsset ('https://github.com/'+$script:Repository+'/releases/download/v'+$Manifest.version+'/'+$Manifest.asset) $archive $Manifest.size
        if((Get-Item -LiteralPath $archive).Length -ne $Manifest.size -or -not(Test-SasHash $archive $Manifest.sha256)){throw 'Archive checksum failed. Existing files were preserved.'}
        New-Item -ItemType Directory -Path $stage|Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip=[IO.Compression.ZipFile]::OpenRead($archive)
        $expected=@{};foreach($f in $Manifest.files){$expected[$f.path]=$f}
        $helpers=@('LICENSE','NOTICE','README.md','COPYRIGHT.md','THIRD-PARTY.md','Install-SAS.ps1','web-server.json','Start-SAS.cmd','Start-SAS-Web.cmd','Start-SAS-Web-Shell.cmd','Stop-SAS-Web.cmd','Repair-SAS.cmd','.sas-payload.json')
        $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        try {
            $index=0
            foreach($entry in $zip.Entries){
                if(-not $entry.Name){continue}
                $target=Resolve-SasPath $stage $entry.FullName
                if(-not $seen.Add($entry.FullName)){throw 'Duplicate ZIP entry.'}
                if($expected.ContainsKey($entry.FullName)){if($entry.Length -ne $expected[$entry.FullName].size){throw 'ZIP file size mismatch.'}}
                elseif($entry.FullName -notin $helpers -or $entry.Length -gt 5000000){throw 'Unexpected ZIP entry.'}
                $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
                $index++;Show-SasProgress ([int](100*$index/$zip.Entries.Count))
            }
            foreach($f in $Manifest.files){if(-not $seen.Contains($f.path)){throw 'Incomplete runtime archive.'}}
        }finally{$zip.Dispose();Write-Host ''}
        # Only files owned by this release are replaced. User config, histories,
        # downloads and unrelated files are never removed or recursively moved.
        foreach($f in $Manifest.files){
            $from=Resolve-SasPath $stage $f.path;$to=Resolve-SasPath $Directory $f.path
            $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
            Copy-Item -LiteralPath $from -Destination $to -Force
        }
        Copy-Item -LiteralPath (Join-Path $stage '.sas-payload.json') -Destination (Join-Path $Directory '.sas-payload.json') -Force
        if(-not(Test-SasReady $Directory $Manifest)){throw 'Installation incomplete. Run Repair-SAS.cmd.'};Show-SasProgress 100;Write-Host ''
    }finally{
        if(Test-Path -LiteralPath $archive){Remove-Item -LiteralPath $archive -Force}
        if(Test-Path -LiteralPath $stage){
            $resolved=[IO.Path]::GetFullPath($stage);$parent=[IO.Path]::GetFullPath($Directory).TrimEnd('\')+'\'
            if(-not $resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^\.sas-setup-[a-f0-9]{32}$'){throw 'Refusing unsafe cleanup.'}
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
function Invoke-SasInstaller([string]$Directory,[string]$Mode) {
    $m=Read-SasManifest $Directory
    $lockPath=Join-Path $Directory '.sas-install.lock'
    $lock=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')
    try {
        $deep=$Mode -in @('Repair','Check')
        if($Mode -ne 'Stop' -and -not(Test-SasReady $Directory $m -Deep:$deep)){
            if($Mode -in @('Check','Stop')){throw 'SAS files are missing or damaged. Run Repair-SAS.cmd.'}
            Install-SasRuntime $Directory $m
        }
    }finally{$lock.Dispose();Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue}
    if($Mode -in @('Install','Repair','Check')){Write-Host 'SAS is ready.';return}
    $exe=Join-Path $Directory 'SAS.exe'
    $oldNode=[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Process')
    $oldStatus=[Environment]::GetEnvironmentVariable('SAS_STARTUP_FILE','Process')
    $status=Join-Path ([IO.Path]::GetTempPath()) ('sas-startup-'+[Guid]::NewGuid().ToString('N')+'.json')
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process')
    try {
        if($Mode -eq 'Desktop'){Start-Process -FilePath $exe -WorkingDirectory $Directory|Out-Null;return}
        [Environment]::SetEnvironmentVariable('SAS_STARTUP_FILE',$status,'Process')
        $flag=@{Web='--sas-web';Shell='--sas-web-shell';Stop='--sas-web-stop'}[$Mode]
        $process=Start-Process -FilePath $exe -ArgumentList $flag -WorkingDirectory $Directory -WindowStyle Hidden -PassThru
        $deadline=[DateTime]::UtcNow.AddSeconds(120);$ready=$null
        do {
            if(Test-Path -LiteralPath $status){try{$ready=Get-Content -LiteralPath $status -Raw -Encoding UTF8|ConvertFrom-Json}catch{} }
            if($ready){Show-SasProgress $ready.progress;if($ready.complete){break}}
            if($process.HasExited){throw 'SAS stopped before reporting readiness.'}
            Start-Sleep -Milliseconds 150
        }while([DateTime]::UtcNow -lt $deadline)
        Write-Host ''
        if(-not $ready -or -not $ready.complete){throw 'Startup timed out. Check SAS logs.'}
        if($ready.PSObject.Properties['error']){throw $ready.error}
        if($Mode -eq 'Stop'){Write-Host 'Web server stopped.'}else{
            Write-Host ('SAS Web: '+$ready.url)
            return [PSCustomObject]@{url=[string]$ready.url;alreadyRunning=!!$ready.PSObject.Properties['alreadyRunning']}
        }
    }finally{
        [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$oldNode,'Process')
        [Environment]::SetEnvironmentVariable('SAS_STARTUP_FILE',$oldStatus,'Process')
        if(Test-Path -LiteralPath $status){Remove-Item -LiteralPath $status -Force}
    }
}
function Show-SasWebResult([string]$Url,[switch]$WaitForEnter,[switch]$SkipBrowser) {
    $address=$null
    if(-not [Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$address) -or $address.Scheme -cne 'http' -or $address.UserInfo){throw 'Invalid SAS Web address.'}
    if(-not $SkipBrowser -and $env:SAS_WEB_NO_BROWSER -ne '1'){
        try{Start-Process -FilePath $address.AbsoluteUri -ErrorAction Stop|Out-Null}
        catch{Write-Host ('Could not open the browser. Open this address manually: '+$address.AbsoluteUri) -ForegroundColor Yellow}
    }
    Write-Host 'The server runs in the background. Use Stop-SAS-Web.cmd to stop it.'
    if($WaitForEnter -and $env:SAS_WEB_NO_PAUSE -ne '1'){
        Write-Host ''
        Write-Host 'Press Enter to close this window (the server will keep running).'
        $null=Read-Host
    }
}
if($MyInvocation.InvocationName -ne '.'){
    try{
        $result=Invoke-SasInstaller $PSScriptRoot $Action
        if($Action -in @('Web','Shell')){Show-SasWebResult $result.url -WaitForEnter:$KeepConsole -SkipBrowser:$NoBrowser}
    }catch{Write-Host ('SAS: '+$_.Exception.Message) -ForegroundColor Red;exit 1}
}
