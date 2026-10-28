param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

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

$conda = Resolve-Conda
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\stable-fast-3d"
$checkpointPath = Join-Path $pretrainedPath "model.safetensors"
$exampleImage = Join-Path $repoPath "demo_files\examples\chair1.png"
$outputPath = Join-Path $repoPath "outputs\chair-smoke"

if (-not (Test-Path -LiteralPath $repoPath)) {
  throw "Stable Fast 3D repo was not found at $repoPath. Run Install first."
}

if (-not (Test-Path -LiteralPath $checkpointPath)) {
  throw "Stable Fast 3D weights were not found at $pretrainedPath. Run Install again."
}

if (-not (Test-Path -LiteralPath $exampleImage)) {
  throw "Example image was not found at $exampleImage."
}

Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$checkpointPath'); size=p.stat().st_size; print(f'model.safetensors size: {size}'); raise SystemExit(0 if size > 1000000000 else 'model.safetensors is too small')"

Push-Location $repoPath
try {
  Invoke-Checked $conda run -n $EnvName python run.py demo_files/examples/chair1.png `
    --output-dir $outputPath `
    --pretrained-model $pretrainedPath `
    --texture-resolution 512 `
    --remesh_option none `
    --target_vertex_count -1
} finally {
  Pop-Location
}

$meshPath = Join-Path $outputPath "0\mesh.glb"
if (-not (Test-Path -LiteralPath $meshPath)) {
  throw "Stable Fast 3D smoke test did not produce $meshPath."
}

Write-Host "Stable Fast 3D smoke test completed."
