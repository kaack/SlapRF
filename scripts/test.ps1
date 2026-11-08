# Runs the full SlapRF Go unit test suite
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Running SlapRF unit tests..." -ForegroundColor Cyan
go test -v -ldflags="-s -w" ./...
