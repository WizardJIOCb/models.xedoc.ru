param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [string]$EnvName = "riganything"
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

$conda = Resolve-Conda

$repoPath = Join-Path $ModelDir "repo"
$checkpoint = Join-Path $repoPath "ckpt\riganything_ckpt.pt"
$exampleMesh = Join-Path $repoPath "data_examples\spyro_the_dragon.glb"

if (-not (Test-Path -LiteralPath $repoPath)) {
  throw "RigAnything repo was not found at $repoPath. Run Install first."
}

if (-not (Test-Path -LiteralPath $checkpoint)) {
  throw "RigAnything checkpoint was not found at $checkpoint. Run Install again."
}

if (-not (Test-Path -LiteralPath $exampleMesh)) {
  throw "Example mesh was not found at $exampleMesh."
}

Push-Location $repoPath
try {
  & $conda run -n $EnvName python inference_utils/mesh_simplify.py `
    --data_path data_examples/spyro_the_dragon.glb `
    --mesh_simplify 1 `
    --simplify_count 4096 `
    --output_path outputs/spyro_the_dragon

  & $conda run -n $EnvName python inference.py `
    --config config.yaml `
    --load ckpt/riganything_ckpt.pt `
    -s inference true `
    -s inference_out_dir outputs/spyro_the_dragon `
    --mesh_path outputs/spyro_the_dragon/spyro_the_dragon_simplified.glb
} finally {
  Pop-Location
}

Write-Host "RigAnything smoke test completed."
