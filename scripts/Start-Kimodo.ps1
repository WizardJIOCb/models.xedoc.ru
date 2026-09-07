param(
    [string]$BundleRoot = 'C:\Users\Rodion\Documents\Codex\2026-08-24\https-x-com-stefan-3d-ai\outputs\kimodo-local',
    [string]$ModelRoot = 'C:\Projects\models-studio-models\Kimodo',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$kimodoBin = Join-Path $BundleRoot 'bin'
$kimodoDemo = Join-Path $kimodoBin 'kimodo-demo.exe'
$kimodoGenerator = Join-Path $kimodoBin 'kmd-generate.exe'
$kimodoMotion = Join-Path $ModelRoot 'models\kimodo-smplx-rp-v1-f32.gguf'
$kimodoText = Join-Path $ModelRoot 'generated\llm2vec-text-bundle'
$kimodoOutput = Join-Path $BundleRoot 'animations'
$kimodoLogs = Join-Path $BundleRoot 'logs'
$kimodoPidFile = Join-Path $BundleRoot 'kimodo-demo.pid'
$kimodoUrl = 'http://127.0.0.1:8094'

function Test-KimodoHealth {
    try {
        $kimodoModels = Invoke-RestMethod -Uri "$kimodoUrl/api/models" -TimeoutSec 3
        return @($kimodoModels | Where-Object { $_.id -eq 'smplx-rp-v1' -and $_.available }).Count -eq 1
    } catch { return $false }
}

$kimodoMutex = [System.Threading.Mutex]::new($false, 'Local\ModelsXedocKimodoStartup')
$kimodoOwnMutex = $false
try {
    try { $kimodoOwnMutex = $kimodoMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $kimodoOwnMutex = $true }
    if (-not $kimodoOwnMutex) { Write-Host 'Kimodo startup is already in progress.'; return }
    $kimodoRequired = @($kimodoDemo, $kimodoGenerator, $kimodoMotion)
    $kimodoTextNames = @('embedding.gguf', 'final-norm.gguf', 'tokenizer.gguf') + @(0..31 | ForEach-Object { 'layer-{0:d2}.gguf' -f $_ })
    foreach ($kimodoTextName in $kimodoTextNames) { $kimodoRequired += Join-Path $kimodoText $kimodoTextName }
    foreach ($kimodoFile in $kimodoRequired) {
        if (-not (Test-Path -LiteralPath $kimodoFile -PathType Leaf) -or (Get-Item -LiteralPath $kimodoFile).Length -le 0) {
            throw "Required Kimodo file is missing or empty: $kimodoFile"
        }
    }
    if (Test-KimodoHealth) {
        Write-Host "Kimodo is already running: $kimodoUrl"
        if (-not $NoBrowser) { Start-Process $kimodoUrl }
        return
    }
    if (Get-NetTCPConnection -LocalPort 8094 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Port 8094 is occupied, but Kimodo is not healthy. Inspect that process before restarting it.'
    }
    New-Item -ItemType Directory -Path $kimodoOutput, $kimodoLogs -Force | Out-Null
    $env:PATH = "$kimodoBin;$env:PATH"
    $env:KIMODO_BACKEND = 'vulkan'
    $env:KIMODO_TEXT_LAYER_CHUNK = '4'
    $kimodoArguments = @(
        '-addr', '127.0.0.1:8094',
        '-generator', ('"' + $kimodoGenerator + '"'),
        '-motion-model', ('"' + $kimodoMotion + '"'),
        '-text-bundle', ('"' + $kimodoText + '"'),
        '-output', ('"' + $kimodoOutput + '"')
    )
    $kimodoProcess = Start-Process -FilePath $kimodoDemo -ArgumentList $kimodoArguments -WorkingDirectory $BundleRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $kimodoLogs 'kimodo-demo.out.log') -RedirectStandardError (Join-Path $kimodoLogs 'kimodo-demo.err.log')
    $kimodoTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $kimodoReady = $false
    while ($kimodoTimer.Elapsed.TotalSeconds -lt 45) {
        $kimodoProcess.Refresh()
        if ($kimodoProcess.HasExited) { break }
        if (Test-KimodoHealth) { $kimodoReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $kimodoReady) { throw "Kimodo did not become ready. See $kimodoLogs\kimodo-demo.err.log" }
    Set-Content -LiteralPath $kimodoPidFile -Value $kimodoProcess.Id -Encoding ascii
    Write-Host "Kimodo is running: $kimodoUrl"
    Write-Host "Models: $ModelRoot; Vulkan, text layer chunk 4."
    if (-not $NoBrowser) { Start-Process $kimodoUrl }
} finally {
    if ($kimodoOwnMutex) { $kimodoMutex.ReleaseMutex() }
    $kimodoMutex.Dispose()
}
