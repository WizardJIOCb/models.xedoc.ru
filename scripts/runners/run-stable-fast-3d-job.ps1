param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [Parameter(Mandatory = $true)]
  [string]$JobFile,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [string]$EnvName = "stable-fast-3d"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

function Resolve-Conda {
  $cmd = Get-Command conda -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "$env:USERPROFILE\miniforge3\Scripts\conda.exe",
    "$env:USERPROFILE\Miniforge3\Scripts\conda.exe",
    "$env:USERPROFILE\miniconda3\Scripts\conda.exe",
    "$env:LOCALAPPDATA\miniforge3\Scripts\conda.exe",
    "$env:LOCALAPPDATA\miniconda3\Scripts\conda.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  throw "conda is required but was not found. Install Miniforge/Miniconda first."
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

$job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\stable-fast-3d"
$checkpointPath = Join-Path $pretrainedPath "model.safetensors"

if (-not $job.localReferences -or $job.localReferences.Count -lt 1) {
  throw "Stable Fast 3D is image-to-3D. Add at least one reference image before generating."
}

if (-not (Test-Path -LiteralPath $checkpointPath)) {
  throw "Stable Fast 3D weights were not found at $pretrainedPath. Run Install first."
}

$firstReference = [string]$job.localReferences[0]
$quality = [string]$job.quality
$textureResolution = switch ($quality) {
  "draft" { 512 }
  "production" { 1024 }
  default { 768 }
}
$vertexCount = if ($job.options.optimizeGameReady -and $job.options.polycountTarget) { [int]$job.options.polycountTarget } else { -1 }
$workOutput = Join-Path ([System.IO.Path]::GetTempPath()) ("stable-fast-3d-job-" + $job.id)

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Remove-Item -LiteralPath $workOutput -Recurse -Force -ErrorAction SilentlyContinue

$conda = Resolve-Conda
Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$checkpointPath'); size=p.stat().st_size; print(f'model.safetensors size: {size}'); raise SystemExit(0 if size > 1000000000 else 'model.safetensors is too small')"

Push-Location $repoPath
try {
  Invoke-Checked $conda run -n $EnvName python run.py $firstReference `
    --output-dir $workOutput `
    --pretrained-model $pretrainedPath `
    --texture-resolution $textureResolution `
    --remesh_option none `
    --target_vertex_count $vertexCount
} finally {
  Pop-Location
}

$meshPath = Join-Path $workOutput "0\mesh.glb"
if (-not (Test-Path -LiteralPath $meshPath)) {
  throw "Stable Fast 3D did not produce $meshPath."
}

Copy-Item -LiteralPath $meshPath -Destination (Join-Path $OutputDir "generated-model.glb") -Force
$inputPreview = Join-Path $workOutput "0\input.png"
if (Test-Path -LiteralPath $inputPreview) {
  Copy-Item -LiteralPath $inputPreview -Destination (Join-Path $OutputDir "processed-input.png") -Force
}

$notes = @(
  "Stable Fast 3D image-to-3D output",
  "Provider: stable-fast-3d",
  "Input: $firstReference",
  "Format: glb",
  "Quality: $quality",
  "Texture resolution: $textureResolution",
  "Target vertex count: $vertexCount",
  "",
  "Stable Fast 3D reconstructs from images. Text prompt is stored for context only:",
  $job.prompt
) -join "`n"
$notes | Set-Content -LiteralPath (Join-Path $OutputDir "generation-notes.txt") -Encoding UTF8

Write-Host "Stable Fast 3D job completed."
