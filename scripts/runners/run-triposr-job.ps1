param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [Parameter(Mandatory = $true)]
  [string]$JobFile,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [string]$EnvName = "triposr"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"

function Resolve-Conda {
  $cmd = Get-Command conda -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $candidates = @(
    "$env:USERPROFILE\miniforge3\Scripts\conda.exe",
    "$env:USERPROFILE\Miniforge3\Scripts\conda.exe",
    "$env:USERPROFILE\miniconda3\Scripts\conda.exe",
    "$env:LOCALAPPDATA\miniforge3\Scripts\conda.exe",
    "$env:LOCALAPPDATA\miniconda3\Scripts\conda.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
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
$pretrainedPath = Join-Path $repoPath "pretrained\TripoSR"
$checkpointPath = Join-Path $pretrainedPath "model.ckpt"

if (-not $job.localReferences -or $job.localReferences.Count -lt 1) {
  throw "TripoSR is image-to-3D. Add at least one reference image before generating."
}

if (-not (Test-Path -LiteralPath $checkpointPath)) {
  throw "TripoSR weights were not found at $pretrainedPath. Run Install first."
}

$firstReference = [string]$job.localReferences[0]
$format = if ($job.targetFormats -contains "glb") { "glb" } else { "obj" }
$quality = [string]$job.quality
$mcResolution = switch ($quality) {
  "draft" { 128 }
  "production" { 320 }
  default { 256 }
}
$chunkSize = if ($quality -eq "production") { 8192 } else { 4096 }
$workOutput = Join-Path ([System.IO.Path]::GetTempPath()) ("triposr-job-" + $job.id)

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Remove-Item -LiteralPath $workOutput -Recurse -Force -ErrorAction SilentlyContinue

$conda = Resolve-Conda
Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$checkpointPath'); size=p.stat().st_size; print(f'model.ckpt size: {size}'); raise SystemExit(0 if size > 1000000000 else 'model.ckpt is too small')"
Push-Location $repoPath
try {
  Invoke-Checked $conda run -n $EnvName python run.py $firstReference `
    --output-dir $workOutput `
    --model-save-format $format `
    --pretrained-model-name-or-path $pretrainedPath `
    --mc-resolution $mcResolution `
    --chunk-size $chunkSize
} finally {
  Pop-Location
}

$meshPath = Join-Path $workOutput "0\mesh.$format"
if (-not (Test-Path -LiteralPath $meshPath)) {
  throw "TripoSR did not produce $meshPath."
}

Copy-Item -LiteralPath $meshPath -Destination (Join-Path $OutputDir "generated-model.$format") -Force
$inputPreview = Join-Path $workOutput "0\input.png"
if (Test-Path -LiteralPath $inputPreview) {
  Copy-Item -LiteralPath $inputPreview -Destination (Join-Path $OutputDir "processed-input.png") -Force
}

$notes = @(
  "TripoSR image-to-3D output",
  "Provider: triposr",
  "Input: $firstReference",
  "Format: $format",
  "Quality: $quality",
  "Marching cubes resolution: $mcResolution",
  "",
  "TripoSR reconstructs from images. Text prompt is stored for context only:"
  $job.prompt
) -join "`n"
$notes | Set-Content -LiteralPath (Join-Path $OutputDir "generation-notes.txt") -Encoding UTF8

Write-Host "TripoSR job completed."
