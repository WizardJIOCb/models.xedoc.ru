param(
    [string]$KimodoRoot = 'C:\Users\Rodion\Documents\Codex\2026-08-24\https-x-com-stefan-3d-ai\outputs\kimodo-local',
    [string]$SshTarget = 'myserver',
    [int]$RemotePort = 18094,
    [int]$LocalPort = 8094
)

$ErrorActionPreference = 'Stop'
$stateDirectory = Join-Path $PSScriptRoot '.state'
$pidPath = Join-Path $stateDirectory 'tunnel.pid'
$runnerPath = Join-Path $PSScriptRoot 'Run-ModelsTunnel.ps1'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

if (Test-Path -LiteralPath $pidPath) {
    $existingId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingId" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like "*$runnerPath*") {
        Write-Host "models.xedoc.ru tunnel is already running (PID $existingId)."
        exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force
}

try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$LocalPort/"
    if ($health.StatusCode -ne 200) { throw "Unexpected HTTP status $($health.StatusCode)" }
} catch {
    $startKimodo = Join-Path $KimodoRoot 'start-kimodo.ps1'
    if (-not (Test-Path -LiteralPath $startKimodo)) { throw "Kimodo launcher was not found at $startKimodo" }
    & $startKimodo -NoBrowser
    $ready = $false
    foreach ($attempt in 1..30) {
        try {
            $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$LocalPort/"
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw "Kimodo did not become ready on port $LocalPort" }
}

$arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runnerPath`"",
    '-SshTarget', $SshTarget, '-RemotePort', $RemotePort, '-LocalPort', $LocalPort
)
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Value $process.Id
Write-Host "models.xedoc.ru tunnel started (PID $($process.Id))."
