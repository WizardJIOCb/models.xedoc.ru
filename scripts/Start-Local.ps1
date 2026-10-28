[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $projectRoot '.runtime'
$envFile = Join-Path $projectRoot '.env'
$envExample = Join-Path $projectRoot '.env.example'
$apiHealth = 'http://127.0.0.1:3421/api/health'
$webUrl = 'http://127.0.0.1:3420'

function Test-ListeningPort {
    param([ValidateRange(1, 65535)][int]$Port)
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-ApiHealth {
    try {
        $response = Invoke-RestMethod -Uri $apiHealth -TimeoutSec 3
        return $response
    } catch {
        return $null
    }
}

function Get-ManagedProcess {
    param([string]$PidFile)
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }

    $processId = 0
    $pidText = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
    if (-not [int]::TryParse(([string]$pidText).Trim(), [ref]$processId) -or $processId -le 0) { return $null }

    return Get-Process -Id $processId -ErrorAction SilentlyContinue
}

function Start-ManagedProcess {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$PidFile,
        [Parameter(Mandatory)][string]$LogFile
    )

    $errorLog = [System.IO.Path]::ChangeExtension($LogFile, 'error.log')
    Remove-Item -LiteralPath $LogFile, $errorLog -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/d', '/s', '/c', $Command) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $errorLog `
        -PassThru
    Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
    Write-Host "Started $Name (PID $($process.Id))."
    return $process
}

function Wait-Until {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][string]$Description,
        [int]$TimeoutSeconds = 60
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Description. Check .runtime logs."
}

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

Get-Command node.exe -ErrorAction Stop | Out-Null
Get-Command pnpm.cmd -ErrorAction Stop | Out-Null

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $envExample -PathType Leaf)) {
        throw 'Neither .env nor .env.example exists.'
    }
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-Host 'Created .env from .env.example (development mock worker configuration).'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container)) {
    Write-Host 'Installing JavaScript dependencies...'
    & pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE." }
}

$apiPortTaken = Test-ListeningPort 3421
$webPortTaken = Test-ListeningPort 3420
if ($apiPortTaken -xor $webPortTaken) {
    throw 'Only one development port is occupied (3420 or 3421). Stop the incomplete previous launch before starting again.'
}

$devPidFile = Join-Path $runtime 'dev.pid'
$devLog = Join-Path $runtime 'dev.log'
$devProcess = Get-ManagedProcess $devPidFile
if ($apiPortTaken) {
    if (-not (Get-ApiHealth)) {
        throw 'Ports 3420 and 3421 are occupied, but port 3421 is not this project API. Stop the conflicting process before starting.'
    }
    Write-Host 'Web and API are already running.'
} elseif ($devProcess) {
    throw "A previous web/API launcher (PID $($devProcess.Id)) is still running without opening ports 3420 and 3421. Stop it or inspect $devLog."
} else {
    $devProcess = Start-ManagedProcess -Name 'web and API' -Command 'pnpm.cmd dev' -PidFile $devPidFile -LogFile $devLog
    Wait-Until -Description 'the API on port 3421' -Condition { Get-ApiHealth }
    Wait-Until -Description 'the web app on port 3420' -Condition { Test-ListeningPort 3420 }
}

$workerPidFile = Join-Path $runtime 'worker.pid'
$workerLog = Join-Path $runtime 'worker.log'
$workerProcess = Get-ManagedProcess $workerPidFile
if ($workerProcess) {
    Write-Host "GPU worker is already running (PID $($workerProcess.Id))."
} else {
    $workerProcess = Start-ManagedProcess -Name 'GPU worker' -Command 'pnpm.cmd dev:worker' -PidFile $workerPidFile -LogFile $workerLog
    Start-Sleep -Seconds 2
    $workerProcess.Refresh()
    if ($workerProcess.HasExited) {
        throw "GPU worker exited during startup. Check $workerLog and $([System.IO.Path]::ChangeExtension($workerLog, 'error.log'))."
    }
}

Write-Host ''
Write-Host 'models.xedoc.ru is ready:'
Write-Host "  Web:    $webUrl"
Write-Host "  API:    $apiHealth"
Write-Host "  Logs:   $runtime"
Write-Host '  Worker: local polling worker (mock mode unless .env configures a real model)'

if (-not $NoBrowser) { Start-Process $webUrl }
