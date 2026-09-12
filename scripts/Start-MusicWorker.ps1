[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'XEDOC Play YuE2 worker'
$workerScript = 'C:\Users\Rodion\Documents\Codex\2026-08-02\new-chat\work\play.xedoc.ru\worker\music-worker.ps1'
$workerConfig = 'C:\ProgramData\XEDOCPlay\music-worker.json'
$workerLogDirectory = 'C:\ProgramData\XEDOCPlay\logs'

function Find-RunningMusicWorker {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('music-worker.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        Select-Object -First 1
}

$running = Find-RunningMusicWorker
if ($running) {
    Write-Host "YuE2 music worker is already running (PID $($running.ProcessId))."
    return
}

$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($scheduledTask) {
    Start-ScheduledTask -InputObject $scheduledTask
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $running = Find-RunningMusicWorker
    } while (-not $running -and [DateTime]::UtcNow -lt $deadline)

    if ($running) {
        Write-Host "YuE2 music worker started through '$taskName' (PID $($running.ProcessId))."
        return
    }
    throw "Scheduled task '$taskName' did not start the YuE2 worker. Inspect Task Scheduler."
}

if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
    throw "YuE2 worker script was not found: $workerScript"
}
if (-not (Test-Path -LiteralPath $workerConfig -PathType Leaf)) {
    throw "YuE2 worker configuration was not found: $workerConfig"
}

New-Item -ItemType Directory -Force -Path $workerLogDirectory | Out-Null
$workerArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $workerScript + '"'))
$worker = Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArguments -WorkingDirectory (Split-Path $workerScript -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $workerLogDirectory 'music-worker.stdout.log') -RedirectStandardError (Join-Path $workerLogDirectory 'music-worker.stderr.log')
Write-Host "YuE2 music worker started directly (PID $($worker.Id))."
