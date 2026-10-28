param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$EnvName = "hunyuan3d-2.1",
  [string]$RepoUrl = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:PIP_NO_INPUT = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found in PATH."
  }
}

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

Assert-Command git
$conda = Resolve-Conda

$targetPath = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Target)
$repoPath = Join-Path $targetPath "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\Hunyuan3D-2.1"
$requirementsPath = Join-Path $targetPath "requirements-inference.txt"

if (-not (Test-Path -LiteralPath $repoPath)) {
  Invoke-Checked git clone $RepoUrl $repoPath
} else {
  Invoke-Checked git -C $repoPath pull --ff-only
}

$envList = & $conda env list | Out-String
if ($envList -notmatch "(?m)^$([regex]::Escape($EnvName))\s") {
  Invoke-Checked $conda create -n $EnvName -y python=3.10
}

Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip setuptools wheel
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124

$requirements = Get-Content -LiteralPath (Join-Path $repoPath "requirements.txt") |
  Where-Object {
    $line = $_.Trim()
    $line -and
      -not $line.StartsWith("#") -and
      $line -notmatch "^deepspeed\b" -and
      $line -notmatch "^bpy\b"
  }
$requirements | Set-Content -LiteralPath $requirementsPath -Encoding UTF8
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --timeout 120 --retries 10 -r $requirementsPath
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade onnxruntime

$downloadScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "hunyuan3d-2.1-download-weights.py"
$downloadScript = @"
from huggingface_hub import snapshot_download
snapshot_download('tencent/Hunyuan3D-2.1', local_dir=r'$pretrainedPath')
"@
Set-Content -LiteralPath $downloadScriptPath -Value $downloadScript -Encoding UTF8
Invoke-Checked $conda run -n $EnvName python $downloadScriptPath

$verifyScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "hunyuan3d-2.1-verify.py"
$verifyScript = @"
import sys
from pathlib import Path
repo = Path(r'$repoPath')
pretrained = Path(r'$pretrainedPath')
sys.path.insert(0, str(repo / 'hy3dshape'))
import torch
from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
shape = pretrained / 'hunyuan3d-dit-v2-1'
vae = pretrained / 'hunyuan3d-vae-v2-1'
if not shape.exists():
    raise SystemExit(f'Missing shape weights folder: {shape}')
if not vae.exists():
    raise SystemExit(f'Missing VAE weights folder: {vae}')
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.version.cuda)
print('Hunyuan3D shape import ok')
"@
Set-Content -LiteralPath $verifyScriptPath -Value $verifyScript -Encoding UTF8
Invoke-Checked $conda run -n $EnvName python $verifyScriptPath

$marker = Join-Path $targetPath "install.json"
$metadata = [ordered]@{
  provider = "hunyuan3d-2.1"
  repoPath = $repoPath
  envName = $EnvName
  pretrainedPath = $pretrainedPath
  installedMode = "shape-only-on-12GB-vram"
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $marker -Encoding UTF8

Write-Host "Hunyuan3D 2.1 shape pipeline installed at $repoPath"
