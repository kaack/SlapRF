# Builds the static SPA (_site), syncs web/wasm/slaprf.wasm, and compiles the standalone native binary
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "[1/2] Building static SPA & WebAssembly engine (./_site and ./web/wasm)..." -ForegroundColor Cyan
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

$outBin = if ($IsWindows -or $env:OS -eq "Windows_NT") { "slaprf.exe" } else { "slaprf" }
Write-Host "[2/2] Compiling standalone native binary ($outBin)..." -ForegroundColor Cyan
go build -ldflags="-s -w" -o $outBin ./cmd/slaprf

Write-Host "Build complete: ./$outBin and ./_site" -ForegroundColor Green
