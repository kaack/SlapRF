# Backwards-compatible alias for scripts/test-e2e.ps1
& (Join-Path $PSScriptRoot "test-e2e.ps1") @args
exit $LASTEXITCODE
