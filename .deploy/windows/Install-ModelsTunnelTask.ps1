param(
    [string]$TaskName = 'models.xedoc.ru Kimodo tunnel'
)

$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'Start-ModelsTunnel.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the local Kimodo backend and reverse SSH tunnel for models.xedoc.ru.' -RunLevel Highest -Force | Out-Null
Write-Host "Scheduled task '$TaskName' installed."
