param(
    [string]$SshTarget = 'myserver',
    [int]$RemotePort = 18094,
    [int]$LocalPort = 8094
)

$stateDirectory = Join-Path $PSScriptRoot '.state'
$pidPath = Join-Path $stateDirectory 'tunnel.pid'
$runnerPath = Join-Path $PSScriptRoot 'Run-ModelsTunnel.ps1'
$running = $false

if (Test-Path -LiteralPath $pidPath) {
    $tunnelId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelId" -ErrorAction SilentlyContinue
    $running = [bool]($process -and $process.CommandLine -like "*$runnerPath*")
}

$localHttp = $false
try { $localHttp = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$LocalPort/").StatusCode -eq 200 } catch {}
$publicHttp = $false
try { $publicHttp = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 'https://models.xedoc.ru/').StatusCode -eq 200 } catch {}

[pscustomobject]@{
    TunnelProcess = $running
    LocalBackend = $localHttp
    PublicHttps = $publicHttp
    RemotePort = $RemotePort
    SshTarget = $SshTarget
} | Format-List
