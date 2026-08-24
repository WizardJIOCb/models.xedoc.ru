param(
    [string]$SshTarget = 'myserver',
    [int]$RemotePort = 18094,
    [int]$LocalPort = 8094
)

$ErrorActionPreference = 'Continue'
$stateDirectory = Join-Path $PSScriptRoot '.state'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$logPath = Join-Path $stateDirectory 'tunnel.log'

while ($true) {
    $timestamp = Get-Date -Format o
    Add-Content -LiteralPath $logPath -Value "$timestamp connecting $SshTarget remote:$RemotePort local:$LocalPort"
    & ssh.exe -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -NT -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" $SshTarget *>> $logPath
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) tunnel disconnected; retrying in 5 seconds"
    Start-Sleep -Seconds 5
}
