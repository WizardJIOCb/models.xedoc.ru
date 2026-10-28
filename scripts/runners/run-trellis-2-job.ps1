param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [Parameter(Mandatory = $true)]
  [string]$JobFile,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir
)

throw "TRELLIS.2 local runner is disabled on this Windows RTX 4070 Ti 12GB workstation. Official TRELLIS.2 runtime requires Linux and at least 24GB VRAM."
