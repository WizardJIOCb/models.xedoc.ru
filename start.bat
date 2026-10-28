@echo off
setlocal EnableExtensions
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Local.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. Read the error above and the logs in .runtime.
  pause
  exit /b 1
)

endlocal
