# Builds the static site (./_site) for https://slaprf.app and syncs web/wasm/slaprf.wasm
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Building static SPA & WebAssembly engine (./_site and ./web/wasm)..." -ForegroundColor Cyan
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

Write-Host "Build complete: ./_site" -ForegroundColor Green
