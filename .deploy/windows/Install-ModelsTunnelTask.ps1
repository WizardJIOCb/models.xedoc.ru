param(
    [string]$TaskName = 'models.xedoc.ru Kimodo tunnel'
)

$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'Start-ModelsTunnel.ps1'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the local Kimodo backend and reverse SSH tunnel for models.xedoc.ru.' -Force -ErrorAction Stop | Out-Null
Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
Write-Host "Scheduled task '$TaskName' installed."
