param(
  [Parameter(Mandatory = $true)]
  [string]$ModelDir,

  [Parameter(Mandatory = $true)]
  [string]$JobFile,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [string]$EnvName = "hunyuan3d-2.1"
)

$ErrorActionPreference = "Stop"
$env:PYTHONNOUSERSITE = "1"
$env:KMP_DUPLICATE_LIB_OK = "TRUE"
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True"

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

$job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
$repoPath = Join-Path $ModelDir "repo"
$pretrainedPath = Join-Path $repoPath "pretrained\Hunyuan3D-2.1"

if (-not $job.localReferences -or $job.localReferences.Count -lt 1) {
  throw "Hunyuan3D 2.1 local runner is configured for image-to-3D. Add at least one reference image before generating."
}

$firstReference = [string]$job.localReferences[0]
$format = if ($job.targetFormats -contains "glb") { "glb" } else { "obj" }
$quality = [string]$job.quality
$steps = switch ($quality) {
  "draft" { 20 }
  "production" { 50 }
  default { 30 }
}
$octreeResolution = switch ($quality) {
  "draft" { 256 }
  default { 384 }
}
$numChunks = if ($quality -eq "production") { 12000 } else { 8000 }
$scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ("hunyuan3d-2.1-job-" + $job.id + ".py")

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$script = @"
import json
import os
import sys
from pathlib import Path
import torch

repo = Path(r'$repoPath')
pretrained = Path(r'$pretrainedPath')
out_dir = Path(r'$OutputDir')
image_path = r'$firstReference'
fmt = '$format'

sys.path.insert(0, str(repo / 'hy3dshape'))
sys.path.insert(0, str(repo))
try:
    from torchvision_fix import apply_fix
    apply_fix()
except Exception as exc:
    print(f'torchvision_fix warning: {exc}')

from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
    str(pretrained),
    subfolder='hunyuan3d-dit-v2-1',
    dtype=torch.float16,
    device='cuda',
)

try:
    pipe.enable_model_cpu_offload()
except Exception as exc:
    print(f'cpu offload warning: {exc}')

generator = torch.Generator(device='cuda').manual_seed(1234)
mesh = pipe(
    image=image_path,
    num_inference_steps=$steps,
    guidance_scale=5.0,
    generator=generator,
    octree_resolution=$octreeResolution,
    num_chunks=$numChunks,
    output_type='trimesh',
)[0]

out_dir.mkdir(parents=True, exist_ok=True)
mesh.export(out_dir / f'generated-model.{fmt}')
(out_dir / 'generation-notes.txt').write_text(
    'Hunyuan3D 2.1 shape-only image-to-3D output\n'
    'Provider: hunyuan3d-2.1\n'
    f'Input: {image_path}\n'
    f'Format: {fmt}\n'
    'Texture/PBR step is skipped on this 12GB VRAM workstation.\n',
    encoding='utf-8'
)
print('Hunyuan3D 2.1 job completed.')
"@

Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
$conda = Resolve-Conda
Invoke-Checked $conda run -n $EnvName python $scriptPath
