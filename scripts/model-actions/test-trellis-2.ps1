param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir
)

$ErrorActionPreference = "Stop"
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\TRELLIS.2-4B"

if (-not (Test-Path -LiteralPath $repoPath)) {
  throw "TRELLIS.2 repo was not found at $repoPath. Run Install first."
}

if (-not (Test-Path -LiteralPath $pretrainedPath)) {
  throw "TRELLIS.2 weights were not found at $pretrainedPath. Run Install first."
}

throw "TRELLIS.2 runtime is not supported on this Windows RTX 4070 Ti 12GB workstation. Official TRELLIS.2 requirements: Linux and at least 24GB VRAM."
