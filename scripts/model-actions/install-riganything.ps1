param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$EnvName = "riganything",
  [string]$RepoUrl = "https://github.com/Isabella98Liu/RigAnything.git",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu126",
  [string]$TorchVersion = "conda:pytorch-cuda=12.4",
  [string]$TorchvisionVersion = "conda"
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

Assert-Command git
$conda = Resolve-Conda

$targetPath = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Target)
$repoPath = Join-Path $targetPath "repo"

if (-not (Test-Path -LiteralPath $repoPath)) {
  git clone $RepoUrl $repoPath
} else {
  git -C $repoPath pull --ff-only
}

$envList = & $conda env list | Out-String
if ($envList -notmatch "(?m)^$([regex]::Escape($EnvName))\s") {
  & $conda create -n $EnvName -y python=3.11
}

& $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip
& $conda install -n $EnvName -y pytorch torchvision pytorch-cuda=12.4 -c pytorch -c nvidia
& $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --timeout 120 --retries 10 -r (Join-Path $repoPath "requirements.txt")
& $conda install -n $EnvName -y pytorch torchvision pytorch-cuda=12.4 -c pytorch -c nvidia
& $conda install -n $EnvName -y "numpy<2"
& $conda run -n $EnvName python -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 'CUDA is not available in the RigAnything environment')"
& $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --timeout 120 --retries 10 --upgrade "huggingface_hub[cli]"

Push-Location $repoPath
try {
  & $conda run -n $EnvName hf download Isabellaliu/RigAnything --local-dir ckpt/
} finally {
  Pop-Location
}

$marker = Join-Path $targetPath "install.json"
$metadata = [ordered]@{
  provider = "riganything"
  repoPath = $repoPath
  envName = $EnvName
  torchIndexUrl = $TorchIndexUrl
  torchVersion = $TorchVersion
  torchvisionVersion = $TorchvisionVersion
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $marker -Encoding UTF8

Write-Host "RigAnything installed at $repoPath"
