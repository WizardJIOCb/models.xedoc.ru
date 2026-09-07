param(
    [string]$ToolsRoot = 'C:\Projects\models-studio-tools\pose',
    [string]$ModelRoot = 'C:\Projects\models-studio-models\Pose'
)
$ErrorActionPreference = 'Stop'
$posePython = Join-Path $ToolsRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $posePython)) {
    & uv venv --python 3.12 (Join-Path $ToolsRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the pose Python environment.' }
}
& uv pip install --python $posePython 'mediapipe==0.10.35' 'pillow==12.3.0'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the local pose detector.' }
New-Item -ItemType Directory -Path $ModelRoot -Force | Out-Null
$poseModel = Join-Path $ModelRoot 'pose_landmarker_heavy.task'
$poseHash = '64437AF838A65D18E5BA7A0D39B465540069BC8AAE8308DE3E318AAD31FCBC7B'
if (-not (Test-Path -LiteralPath $poseModel)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task' -OutFile ($poseModel + '.download')
    if ((Get-FileHash -LiteralPath ($poseModel + '.download') -Algorithm SHA256).Hash -ne $poseHash) { throw 'Pose model checksum does not match the verified version.' }
    Move-Item -LiteralPath ($poseModel + '.download') -Destination $poseModel
}
if ((Get-FileHash -LiteralPath $poseModel -Algorithm SHA256).Hash -ne $poseHash) { throw 'Installed pose model checksum does not match the verified version.' }
& $posePython -c 'import mediapipe; from PIL import Image; print("Local pose detector ready")'
if ($LASTEXITCODE -ne 0) { throw 'Pose dependency verification failed.' }
Get-Item -LiteralPath $poseModel | Select-Object FullName, Length
