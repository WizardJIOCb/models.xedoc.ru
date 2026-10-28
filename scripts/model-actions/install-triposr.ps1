param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$EnvName = "triposr",
  [string]$RepoUrl = "https://github.com/VAST-AI-Research/TripoSR.git"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:PIP_NO_INPUT = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found in PATH."
  }
}

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

function Invoke-CheckedWithOfflineRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  try {
    Invoke-Checked $FilePath @Arguments
  } catch {
    Write-Host "Online command failed, retrying with conda --offline cache."
    $offlineArguments = @("--offline") + $Arguments
    Invoke-Checked $FilePath @offlineArguments
  }
}

Assert-Command git
$conda = Resolve-Conda

$targetPath = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Target)
$repoPath = Join-Path $targetPath "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\TripoSR"

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

# Build torchmcubes against CPU PyTorch first. On Windows, CUDA PyTorch makes
# torchmcubes require a full CUDA Visual Studio toolset during compilation.
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --force-reinstall torch==2.5.1+cpu torchvision==0.20.1+cpu --index-url https://download.pytorch.org/whl/cpu
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --timeout 120 --retries 10 -r (Join-Path $repoPath "requirements.txt")
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade onnxruntime

# Restore GPU PyTorch for TripoSR inference after CPU extensions are built.
Invoke-Checked $conda run -n $EnvName python -m pip uninstall -y torch torchvision
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --force-reinstall torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124
Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --force-reinstall "numpy==1.26.4" "Pillow==10.1.0" "MarkupSafe==2.1.5"
Invoke-Checked $conda run -n $EnvName python -c "import torch, torchmcubes, rembg, xatlas; raise SystemExit(0 if torch.cuda.is_available() else 'CUDA is not available in the TripoSR environment')"

Push-Location $repoPath
try {
  Invoke-Checked $conda run -n $EnvName python -c "from huggingface_hub import snapshot_download, hf_hub_download; snapshot_download('stabilityai/TripoSR', local_dir=r'$pretrainedPath', ignore_patterns=['model.ckpt']); hf_hub_download('stabilityai/TripoSR', 'model.ckpt', local_dir=r'$pretrainedPath')"
  Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$pretrainedPath')/'model.ckpt'; size=p.stat().st_size; print(f'model.ckpt size: {size}'); raise SystemExit(0 if size > 1000000000 else 'Downloaded model.ckpt is too small')"
} finally {
  Pop-Location
}

$marker = Join-Path $targetPath "install.json"
$metadata = [ordered]@{
  provider = "triposr"
  repoPath = $repoPath
  envName = $EnvName
  pretrainedPath = $pretrainedPath
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $marker -Encoding UTF8

Write-Host "TripoSR installed at $repoPath"
