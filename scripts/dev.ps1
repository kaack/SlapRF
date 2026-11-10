# Starts the DEV-ONLY local web server on http://localhost:8090 (TypeScript bundle and WASM engine built on the fly)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Starting SlapRF dev server on http://localhost:8090 ..." -ForegroundColor Green
go run -ldflags="-s -w" ./cmd/devserver -web ./web
