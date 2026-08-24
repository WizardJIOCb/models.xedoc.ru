$ErrorActionPreference = 'Stop'
$stateDirectory = Join-Path $PSScriptRoot '.state'
$pidPath = Join-Path $stateDirectory 'tunnel.pid'
$runnerPath = Join-Path $PSScriptRoot 'Run-ModelsTunnel.ps1'

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host 'models.xedoc.ru tunnel is not running.'
    exit 0
}

$tunnelId = [int](Get-Content -LiteralPath $pidPath -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelId" -ErrorAction SilentlyContinue
if ($process -and $process.CommandLine -like "*$runnerPath*") {
    Stop-Process -Id $tunnelId -Force
}
Remove-Item -LiteralPath $pidPath -Force
Write-Host 'models.xedoc.ru tunnel stopped.'
