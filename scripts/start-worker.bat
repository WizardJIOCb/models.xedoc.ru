@echo off
setlocal
cd /d "%~dp0\.."
pnpm dev:worker
