param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$')][string]$SshTarget = 'myserver',
    [ValidateRange(1, 65535)][int]$RemotePort = 18095,
    [ValidateRange(1, 65535)][int]$LocalPort = 8095
)
$ErrorActionPreference = 'Continue'
$studioRoot = Split-Path $PSScriptRoot -Parent
$studioRuntime = Join-Path $studioRoot '.runtime'
New-Item -ItemType Directory -Path $studioRuntime -Force | Out-Null
$studioLog = Join-Path $studioRuntime 'tunnel.log'
Get-Command ssh.exe -ErrorAction Stop | Out-Null
while ($true) {
    Add-Content -LiteralPath $studioLog -Value "$(Get-Date -Format o) connecting $SshTarget port $RemotePort"
    & ssh.exe -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -NT -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" $SshTarget *>> $studioLog
    Add-Content -LiteralPath $studioLog -Value "$(Get-Date -Format o) disconnected; retry in 5 seconds"
    Start-Sleep -Seconds 5
}
