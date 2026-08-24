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
    $allProcesses = @(Get-CimInstance Win32_Process)
    $pendingParents = @($tunnelId)
    $descendantIds = @()
    while ($pendingParents.Count) {
        $nextParents = @($allProcesses | Where-Object { $pendingParents -contains $_.ParentProcessId } | ForEach-Object ProcessId)
        $descendantIds += $nextParents
        $pendingParents = $nextParents
    }
    [array]::Reverse($descendantIds)
    foreach ($descendantId in $descendantIds) {
        Stop-Process -Id $descendantId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $tunnelId -Force
}
Remove-Item -LiteralPath $pidPath -Force
Write-Host 'models.xedoc.ru tunnel stopped.'
