$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
pnpm install --frozen-lockfile
pnpm build
