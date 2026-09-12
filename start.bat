@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-MusicWorker.ps1"
if errorlevel 1 (
  echo.
  echo Music worker startup failed. See the message above.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Studio.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the message above and .runtime logs.
  pause
  exit /b 1
)
endlocal
