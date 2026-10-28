param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [string]$EnvName = "hunyuan3d-2.1"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"

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
  if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with code $LASTEXITCODE" }
}

$conda = Resolve-Conda
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\Hunyuan3D-2.1"
$scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "hunyuan3d-2.1-test.py"
$script = @"
import sys
from pathlib import Path
repo = Path(r'$repoPath')
pretrained = Path(r'$pretrainedPath')
sys.path.insert(0, str(repo / 'hy3dshape'))
import torch
from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
if not (pretrained / 'hunyuan3d-dit-v2-1').exists():
    raise SystemExit('Missing hunyuan3d-dit-v2-1 weights')
if not (pretrained / 'hunyuan3d-vae-v2-1').exists():
    raise SystemExit('Missing hunyuan3d-vae-v2-1 weights')
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.version.cuda)
print('Hunyuan3D 2.1 smoke test completed.')
"@
Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
Invoke-Checked $conda run -n $EnvName python $scriptPath
