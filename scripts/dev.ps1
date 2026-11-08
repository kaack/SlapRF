# Builds the latest WebAssembly engine + web assets and starts the local SlapRF dev server on http://localhost:8090
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "[1/2] Building WebAssembly simulation engine & web bundle..." -ForegroundColor Cyan
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

Write-Host "[2/2] Starting SlapRF server on http://localhost:8090 ..." -ForegroundColor Green
go run -ldflags="-s -w" ./cmd/slaprf -web ./web -http :8090
