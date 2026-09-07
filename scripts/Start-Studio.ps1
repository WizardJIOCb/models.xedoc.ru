param([switch]$NoBrowser, [switch]$LocalOnly)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path $PSScriptRoot -Parent
$studioRuntime = Join-Path $studioRoot '.runtime'
$studioPython = 'C:\Projects\comfy\ComfyUI\.venv\Scripts\python.exe'
$studioComfyStart = 'C:\Projects\comfy\scripts\start-comfy.ps1'
$studioKimodoRoot = 'C:\Users\Rodion\Documents\Codex\2026-08-24\https-x-com-stefan-3d-ai\outputs\kimodo-local'
$studioKimodoModels = 'C:\Projects\models-studio-models\Kimodo'
$studioKimodoStart = Join-Path $PSScriptRoot 'Start-Kimodo.ps1'
$studioServer = Join-Path $studioRoot 'studio\server.py'
$studioTunnelRunner = Join-Path $PSScriptRoot 'Run-StudioTunnel.ps1'
$studioBlender = if ($env:STUDIO_BLENDER) { $env:STUDIO_BLENDER } else { 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe' }
$studioHealth = 'http://127.0.0.1:8095/api/model-studio/health'
$studioPublicHealth = 'https://models.xedoc.ru/api/model-studio/health'
$studioLocalUrl = 'http://127.0.0.1:8095/generate-model'
$studioPublicUrl = 'https://models.xedoc.ru/generate-model'

function Get-StudioHealth {
    param([string]$Uri = $studioHealth, [int]$TimeoutSeconds = 5)
    try {
        $result = Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSeconds -Headers @{ 'Cache-Control' = 'no-cache' }
        if ($result.online -eq $true -and $result.service -eq 'model-studio') { return $result }
    } catch {}
    return $null
}

function Test-StudioDependencies {
    param($Status)
    return $Status -and $Status.comfy.online -and $Status.comfy.modelsReady -and
        $Status.kimodo.online -and $Status.capabilities.motionGeneration -and $Status.capabilities.humanoidRigging
}

# Serialize repeated launches, including processes without a PID file yet.
$studioMutex = [System.Threading.Mutex]::new($false, 'Local\ModelsXedocStudioStartup')
$studioOwnMutex = $false
try {
    try { $studioOwnMutex = $studioMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $studioOwnMutex = $true }
    if (-not $studioOwnMutex) {
        Write-Host 'Studio startup is already in progress in another launcher.'
        return
    }
    New-Item -ItemType Directory -Path $studioRuntime -Force | Out-Null
    $studioRequiredFiles = @(
        $studioPython, $studioComfyStart, $studioBlender, $studioServer,
        $studioKimodoStart,
        (Join-Path $studioKimodoRoot 'bin\kimodo-demo.exe'),
        (Join-Path $studioKimodoRoot 'bin\kmd-generate.exe'),
        (Join-Path $studioKimodoModels 'models\kimodo-smplx-rp-v1-f32.gguf'),
        (Join-Path $studioRoot 'apps\studio-web\dist\index.html'),
        (Join-Path $studioRoot 'config\pixal3d-api.json'),
        (Join-Path $studioRoot 'scripts\pixal_pipeline.py'),
        (Join-Path $studioRoot 'scripts\rig_humanoid.py'),
        (Join-Path $studioRoot 'scripts\pose_rig.py'),
        (Join-Path $studioRoot 'scripts\detect_pose.py'),
        'C:\Projects\models-studio-tools\pose\.venv\Scripts\python.exe',
        'C:\Projects\models-studio-models\Pose\pose_landmarker_heavy.task',
        (Join-Path $studioRoot 'scripts\retarget_motion.py')
    )
    if (-not $LocalOnly) {
        $studioRequiredFiles += $studioTunnelRunner
        Get-Command ssh.exe -ErrorAction Stop | Out-Null
    }
    foreach ($studioRequired in $studioRequiredFiles) {
        if (-not (Test-Path -LiteralPath $studioRequired -PathType Leaf)) { throw "Required file not found: $studioRequired" }
    }
    $studioTextBundle = Join-Path $studioKimodoModels 'generated\llm2vec-text-bundle'
    $studioTextFiles = @('embedding.gguf', 'final-norm.gguf', 'tokenizer.gguf') + @(0..31 | ForEach-Object { 'layer-{0:d2}.gguf' -f $_ })
    foreach ($studioTextFile in $studioTextFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $studioTextBundle $studioTextFile) -PathType Leaf)) {
            throw "Kimodo text encoder file is missing: $studioTextFile in $studioTextBundle"
        }
    }
    & $studioPython -c 'import aiohttp; from PIL import Image'
    if ($LASTEXITCODE -ne 0) { throw 'The ComfyUI Python environment requires aiohttp and Pillow. See the import error above.' }

    Write-Host 'Starting local ComfyUI...'
    & $studioComfyStart
    Write-Host 'Starting local Kimodo...'
    $studioMotionReady = $false
    try { $studioMotionReady = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8094/api/models' -TimeoutSec 3).StatusCode -eq 200 } catch {}
    if (-not $studioMotionReady) { & $studioKimodoStart -BundleRoot $studioKimodoRoot -ModelRoot $studioKimodoModels -NoBrowser }

    $studioStatus = Get-StudioHealth
    if (-not $studioStatus) {
        if (Get-NetTCPConnection -LocalPort 8095 -State Listen -ErrorAction SilentlyContinue) {
            throw 'Port 8095 is occupied, but it does not return a Model Studio health response. Inspect that process before restarting it.'
        }
        $studioArgs = @(('"' + $studioServer + '"'), '--port', '8095')
        $studioProcess = Start-Process -FilePath $studioPython -ArgumentList $studioArgs -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $studioRuntime 'server.stdout.log') -RedirectStandardError (Join-Path $studioRuntime 'server.stderr.log') -PassThru
        Set-Content -LiteralPath (Join-Path $studioRuntime 'server.pid') -Value $studioProcess.Id
        $studioStartupTimer = [System.Diagnostics.Stopwatch]::StartNew()
        while ($studioStartupTimer.Elapsed.TotalSeconds -lt 60) {
            $studioProcess.Refresh()
            if ($studioProcess.HasExited) { throw 'Studio exited during startup. See .runtime/server.stderr.log.' }
            $studioStatus = Get-StudioHealth
            if ($studioStatus) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $studioStatus) { throw 'Studio did not become ready. Its process may still be starting; see .runtime/server.stderr.log.' }
    }
    # Dependency health is cached briefly; wait for a refreshed result.
    $studioDependencyTimer = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-StudioDependencies $studioStatus) -and $studioDependencyTimer.Elapsed.TotalSeconds -lt 25) {
        Start-Sleep -Seconds 1
        $studioStatus = Get-StudioHealth
    }
    if (-not (Test-StudioDependencies $studioStatus)) {
        throw "Studio API is running, but dependencies are not ready. Comfy models: $($studioStatus.comfy.modelsReady); Kimodo: $($studioStatus.kimodo.online); motion model: $($studioStatus.capabilities.motionGeneration); Blender: $($studioStatus.capabilities.humanoidRigging)."
    }
    Write-Host 'Local Studio is ready: ComfyUI, Pixal3D weights, Kimodo and Blender are available.'
    $studioOpenUrl = $studioLocalUrl

    if (-not $LocalOnly) {
        $studioExistingTask = Get-ScheduledTask -TaskName 'models.xedoc.ru Kimodo tunnel' -ErrorAction SilentlyContinue
        if ($studioExistingTask -and $studioExistingTask.State -ne 'Running') { Start-ScheduledTask -InputObject $studioExistingTask }
        $studioTunnelPidFile = Join-Path $studioRuntime 'tunnel.pid'
        $studioTunnelRunning = $false
        if (Test-Path -LiteralPath $studioTunnelPidFile) {
            $studioTunnelPid = 0
            $studioPidText = Get-Content -LiteralPath $studioTunnelPidFile -Raw -ErrorAction SilentlyContinue
            if ([int]::TryParse(([string]$studioPidText).Trim(), [ref]$studioTunnelPid) -and $studioTunnelPid -gt 0) {
                $studioExistingTunnel = Get-CimInstance Win32_Process -Filter "ProcessId=$studioTunnelPid" -ErrorAction SilentlyContinue
                $studioTunnelRunning = $studioExistingTunnel -and $studioExistingTunnel.CommandLine -and $studioExistingTunnel.CommandLine.Contains($studioTunnelRunner)
            }
        }
        if (-not $studioTunnelRunning) {
            $studioTunnelArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $studioTunnelRunner + '"'))
            $studioTunnel = Start-Process -FilePath 'powershell.exe' -ArgumentList $studioTunnelArgs -WorkingDirectory $studioRoot -WindowStyle Hidden -PassThru
            Set-Content -LiteralPath $studioTunnelPidFile -Value $studioTunnel.Id
        }
        $studioPublicReady = $false
        $studioPublicTimer = [System.Diagnostics.Stopwatch]::StartNew()
        while ($studioPublicTimer.Elapsed.TotalSeconds -lt 15) {
            $studioSecondsRemaining = [math]::Max(1, [math]::Min(4, [math]::Floor(15 - $studioPublicTimer.Elapsed.TotalSeconds)))
            if (Get-StudioHealth -Uri $studioPublicHealth -TimeoutSeconds $studioSecondsRemaining) {
                $studioPublicReady = $true
                break
            }
            Start-Sleep -Milliseconds 500
        }
        if ($studioPublicReady) {
            $studioOpenUrl = $studioPublicUrl
            Write-Host 'Public HTTPS connection is ready.'
        } else {
            Write-Warning 'The local Studio is ready, but its public HTTPS route is not reachable yet. The SSH tunnel retries automatically. See .runtime/tunnel.log; the local page will open now.'
        }
    }
    Write-Host $studioOpenUrl
    if (-not $NoBrowser) { Start-Process $studioOpenUrl }
} finally {
    if ($studioOwnMutex) { $studioMutex.ReleaseMutex() }
    $studioMutex.Dispose()
}
