param(
    [ValidateSet('Desktop','Web','Shell','Stop','Install','Repair','Check')]
    [string]$Action = 'Desktop'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-SasManifest([string]$Directory) {
    $file = Join-Path $Directory 'release-manifest.json'
    $manifest = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 1 -or $manifest.repository -cne 'Padparaja-Ge/Super-AI-Story' -or
        $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.asset -cne 'SAS.exe' -or
        $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $manifest.size -lt 1000000 -or $manifest.size -ge 2147483648) {
        throw 'Invalid SAS release manifest. Download the launcher again from the official repository.'
    }
    return $manifest
}

function Test-SasBinary([string]$Filename, $Manifest) {
    if (-not (Test-Path -LiteralPath $Filename -PathType Leaf)) {return $false}
    if ((Get-Item -LiteralPath $Filename).Length -ne $Manifest.size) {return $false}
    Write-Host 'Checking SAS.exe (SHA-256)...'
    $stream = [IO.File]::OpenRead($Filename)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
        return $digest -ceq $Manifest.sha256
    } finally {$stream.Dispose(); $sha.Dispose()}
}

function Receive-SasAsset([string]$Url, [string]$Temporary, [long]$Size) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host ('Downloading SAS.exe (' + [Math]::Round($Size / 1MB) + ' MB).')
    Write-Host 'Do not close this window. Your VPN and system proxy settings are preserved.'
    $client = New-Object Net.WebClient
    $client.Headers.Add('User-Agent', 'Super-AI-Story-Installer')
    try {
        $task = $client.DownloadFileTaskAsync([Uri]$Url, $Temporary)
        while (-not $task.IsCompleted) {
            if (Test-Path -LiteralPath $Temporary) {
                $downloaded = (Get-Item -LiteralPath $Temporary).Length
                $percent = [Math]::Min(99, [int](100 * $downloaded / $Size))
                Write-Progress -Activity 'Downloading SAS.exe' -Status ($percent.ToString() + '%') -PercentComplete $percent
            }
            Start-Sleep -Milliseconds 250
        }
        $task.GetAwaiter().GetResult()
        Write-Progress -Activity 'Downloading SAS.exe' -Completed
    } finally {$client.Dispose()}
}

function Install-SasBinary([string]$Filename, $Manifest) {
    $temporary = $Filename + '.download'
    $backup = $Filename + '.previous'
    if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary -Force}
    # Only a pinned release in the official public repository is accepted.
    $url = 'https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v' + $Manifest.version + '/SAS.exe'
    try {
        Receive-SasAsset $url $temporary $Manifest.size
        if (-not (Test-SasBinary $temporary $Manifest)) {throw 'Downloaded file did not pass SHA-256 verification. The previous installation was preserved.'}
        # Replacement is attempted only after validation. Never remove user data.
        if (Test-Path -LiteralPath $Filename) {
            if (Test-Path -LiteralPath $backup) {throw 'SAS.exe.previous exists. Keep or rename that backup before repairing.'}
            Move-Item -LiteralPath $Filename -Destination $backup
        }
        try {Move-Item -LiteralPath $temporary -Destination $Filename}
        catch {
            if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Filename)) {Move-Item -LiteralPath $backup -Destination $Filename}
            throw
        }
        if (Test-Path -LiteralPath $backup) {Remove-Item -LiteralPath $backup -Force}
    } finally {
        if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary -Force}
    }
}

function Invoke-SasInstaller([string]$Directory, [string]$Mode) {
    $manifest = Read-SasManifest $Directory
    $executable = Join-Path $Directory 'SAS.exe'
    $lockPath = Join-Path $Directory '.sas-install.lock'
    # One verifier/installer per folder. FileShare.None releases even after a crash.
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        if (-not (Test-SasBinary $executable $manifest)) {
            if ($Mode -eq 'Check') {throw 'SAS.exe is missing or damaged. Run Repair-SAS.cmd.'}
            Install-SasBinary $executable $manifest
        }
    } finally {$lock.Dispose(); Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue}
    if ($Mode -in @('Check','Install','Repair')) {Write-Host 'SAS.exe is ready.'; return}
    # Do not inherit Electron's Node-only switch from a developer terminal.
    $nodeMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Process')
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process')
    try {
        if ($Mode -eq 'Desktop') {Start-Process -FilePath $executable -WorkingDirectory $Directory | Out-Null}
        else {
            $flag = @{Web='--sas-web'; Shell='--sas-web-shell'; Stop='--sas-web-stop'}[$Mode]
            Start-Process -FilePath $executable -ArgumentList $flag -WorkingDirectory $Directory -WindowStyle Hidden | Out-Null
            if ($Mode -eq 'Stop') {Write-Host 'Web server stop requested.'}
            else {
                Write-Host 'Web server starting. Default address: http://127.0.0.1:3212'
                Write-Host 'Settings: web-server.json. Stop: Stop-SAS-Web.cmd.'
                Write-Host 'Logs: %APPDATA%\Super AI Story\web-runtime'
            }
        }
    } finally {[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$nodeMode,'Process')}
}

# Dot sourcing is used by development tests only; it performs no installation.
if ($MyInvocation.InvocationName -ne '.') {
    try {Invoke-SasInstaller $PSScriptRoot $Action}
    catch {Write-Host ('SAS: ' + $_.Exception.Message) -ForegroundColor Red; exit 1}
}
