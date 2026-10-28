param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$EnvName = "stable-fast-3d",
  [string]$RepoUrl = "https://github.com/Stability-AI/stable-fast-3d.git"
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

function Resolve-VsDevCmd {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find "Common7\Tools\VsDevCmd.bat" | Select-Object -First 1
    if ($found -and (Test-Path -LiteralPath $found)) { return $found }
  }

  $candidates = @(
    "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  throw "Stable Fast 3D on Windows needs Visual Studio 2022 Build Tools with C++ workload. Install it, then retry: winget install Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""
}

function Resolve-CudaHome {
  if ($env:CUDA_PATH -and (Test-Path -LiteralPath $env:CUDA_PATH)) { return $env:CUDA_PATH }
  $roots = Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
  if ($roots.Count -gt 0) { return $roots[0].FullName }
  throw "CUDA Toolkit was not found. Stable Fast 3D needs CUDA Toolkit for its Windows extensions."
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

function Invoke-CheckedVs {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VsDevCmd,

    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  $escapedArgs = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join " "
  $cmdLine = '"' + $VsDevCmd + '" -arch=x64 -host_arch=x64 >nul && set DISTUTILS_USE_SDK=1 && "' + $FilePath + '" ' + $escapedArgs
  & cmd.exe /s /c $cmdLine
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

Assert-Command git
$conda = Resolve-Conda
$vsDevCmd = Resolve-VsDevCmd
$cudaHome = Resolve-CudaHome
$env:CUDA_HOME = $cudaHome
$env:CUDA_PATH = $cudaHome

$targetPath = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Target)
$repoPath = Join-Path $targetPath "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\stable-fast-3d"

if (-not (Test-Path -LiteralPath $repoPath)) {
  Invoke-Checked git clone $RepoUrl $repoPath
} else {
  Invoke-Checked git -C $repoPath pull --ff-only
}

$envList = & $conda env list | Out-String
if ($envList -notmatch "(?m)^$([regex]::Escape($EnvName))\s") {
  Invoke-Checked $conda create -n $EnvName -y python=3.10
}

Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip "setuptools==69.5.1" wheel ninja
$torchReady = $false
& $conda run -n $EnvName python -c "import torch; raise SystemExit(0 if torch.cuda.is_available() and torch.version.cuda and torch.version.cuda.startswith('12.8') else 1)" 2>$null
if ($LASTEXITCODE -eq 0) {
  $torchReady = $true
}

if (-not $torchReady) {
  Invoke-Checked $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-cache-dir torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128
}

Push-Location $repoPath
try {
  Invoke-CheckedVs $vsDevCmd $conda run -n $EnvName python -m pip install --disable-pip-version-check --no-build-isolation --no-cache-dir --progress-bar on --timeout 120 --retries 10 -r requirements.txt
  Invoke-Checked $conda run -n $EnvName python -c "import torch, rembg, texture_baker, uv_unwrapper; raise SystemExit(0 if torch.cuda.is_available() else 'CUDA is not available in the Stable Fast 3D environment')"
  $downloadScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "stable-fast-3d-download-weights.py"
  $downloadScript = @"
from huggingface_hub import snapshot_download

try:
    snapshot_download('stabilityai/stable-fast-3d', local_dir=r'$pretrainedPath')
except Exception as exc:
    raise SystemExit(
        'Stable Fast 3D weights are gated on Hugging Face. '
        'Open https://huggingface.co/stabilityai/stable-fast-3d, request/accept access, '
        'then run: conda run -n $EnvName huggingface-cli login. '
        f'Original error: {type(exc).__name__}: {exc}'
    )
"@
  Set-Content -LiteralPath $downloadScriptPath -Value $downloadScript -Encoding UTF8
  Invoke-Checked $conda run -n $EnvName python $downloadScriptPath
  Invoke-Checked $conda run -n $EnvName python -c "from pathlib import Path; p=Path(r'$pretrainedPath')/'model.safetensors'; size=p.stat().st_size; print(f'model.safetensors size: {size}'); raise SystemExit(0 if size > 1000000000 else 'Downloaded model.safetensors is too small. Check Hugging Face access for stabilityai/stable-fast-3d.')"
} finally {
  Pop-Location
}

$marker = Join-Path $targetPath "install.json"
$metadata = [ordered]@{
  provider = "stable-fast-3d"
  repoPath = $repoPath
  envName = $EnvName
  pretrainedPath = $pretrainedPath
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $marker -Encoding UTF8

Write-Host "Stable Fast 3D installed at $repoPath"
