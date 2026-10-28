param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

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

$conda = Resolve-Conda
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\TripoSR"
$checkpointPath = Join-Path $pretrainedPath "model.ckpt"
$exampleImage = Join-Path $repoPath "examples\chair.png"
$outputPath = Join-Path $repoPath "outputs\chair-smoke"

if (-not (Test-Path -LiteralPath $repoPath)) {
  throw "TripoSR repo was not found at $repoPath. Run Install first."
}

if (-not (Test-Path -LiteralPath $checkpointPath)) {
  throw "TripoSR weights were not found at $pretrainedPath. Run Install again."
}

if (-not (Test-Path -LiteralPath $exampleImage)) {
  throw "Example image was not found at $exampleImage."
}

Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$checkpointPath'); size=p.stat().st_size; print(f'model.ckpt size: {size}'); raise SystemExit(0 if size > 1000000000 else 'model.ckpt is too small')"

Push-Location $repoPath
try {
  Invoke-Checked $conda run -n $EnvName python run.py examples/chair.png `
    --output-dir $outputPath `
    --model-save-format glb `
    --pretrained-model-name-or-path $pretrainedPath `
    --mc-resolution 128 `
    --chunk-size 4096
} finally {
  Pop-Location
}

$meshPath = Join-Path $outputPath "0\mesh.glb"
if (-not (Test-Path -LiteralPath $meshPath)) {
  throw "TripoSR smoke test did not produce $meshPath."
}

Write-Host "TripoSR smoke test completed."
