param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$EnvName = "trellis2",
  [string]$RepoUrl = "https://github.com/microsoft/TRELLIS.2.git"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found in PATH."
  }
}

function Resolve-Conda {
  $cmd = Get-Command conda -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = "$env:USERPROFILE\miniforge3\Scripts\conda.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
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

Assert-Command git
$conda = Resolve-Conda
$targetPath = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Target)
$repoPath = Join-Path $targetPath "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\TRELLIS.2-4B"

if (-not (Test-Path -LiteralPath $repoPath)) {
  Invoke-Checked git clone --recursive $RepoUrl $repoPath
} else {
  Invoke-Checked git -C $repoPath pull --ff-only
  Invoke-Checked git -C $repoPath submodule update --init --recursive
}

$envList = & $conda env list | Out-String
if ($envList -notmatch "(?m)^$([regex]::Escape($EnvName))\s") {
  Invoke-Checked $conda create -n $EnvName -y python=3.10
}

Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip setuptools wheel huggingface_hub

$downloadScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "trellis2-download-weights.py"
$downloadScript = @"
from huggingface_hub import snapshot_download
snapshot_download('microsoft/TRELLIS.2-4B', local_dir=r'$pretrainedPath')
"@
Set-Content -LiteralPath $downloadScriptPath -Value $downloadScript -Encoding UTF8
Invoke-Checked $conda run -n $EnvName python $downloadScriptPath

$marker = Join-Path $targetPath "install.json"
$metadata = [ordered]@{
  provider = "trellis-2"
  repoPath = $repoPath
  envName = $EnvName
  pretrainedPath = $pretrainedPath
  installedMode = "repo-and-weights-only"
  runtimeSupported = $false
  reason = "Official TRELLIS.2 runtime is Linux-only and requires at least 24GB VRAM; this workstation has 12GB VRAM on Windows."
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $marker -Encoding UTF8

throw "TRELLIS.2 repo and weights were downloaded, but local runtime is unsupported here: official README says Linux-only and >=24GB VRAM; this machine is Windows with RTX 4070 Ti 12GB."
