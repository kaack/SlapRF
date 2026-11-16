param(
    [string]$Run = "",
    [switch]$ComponentOnly,
    [switch]$WorkflowOnly,
    [switch]$ApiOnly,
    [switch]$RegenSnapshots,
    [switch]$Headed,
    [switch]$SkipBuild,
    [int]$SlowMo = 0
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot

try {
    if ($Headed) {
        $env:SLAPRF_E2E_HEADED = "1"
    } else {
        Remove-Item Env:\SLAPRF_E2E_HEADED -ErrorAction SilentlyContinue
    }

    if ($SkipBuild) {
        $env:SLAPRF_E2E_SKIP_BUILD = "1"
    } else {
        Remove-Item Env:\SLAPRF_E2E_SKIP_BUILD -ErrorAction SilentlyContinue
    }

    if ($RegenSnapshots) {
        $env:SLAPRF_E2E_REGEN_SNAPSHOTS = "1"
    } else {
        Remove-Item Env:\SLAPRF_E2E_REGEN_SNAPSHOTS -ErrorAction SilentlyContinue
    }

    if ($SlowMo -gt 0) {
        $env:SLAPRF_E2E_SLOWMO = "$SlowMo"
    } else {
        Remove-Item Env:\SLAPRF_E2E_SLOWMO -ErrorAction SilentlyContinue
    }

    $goArgs = @("test", "-v", "-count=1", "-tags=e2e", "-timeout=35m")
    if ($Run -ne "") {
        $goArgs += @("-run", $Run)
    } elseif ($ComponentOnly) {
        $goArgs += @("-run", "^TestComponent_")
    } elseif ($ApiOnly) {
        $goArgs += @("-run", "^TestAPI_")
    } elseif ($WorkflowOnly) {
        $goArgs += @("-skip", "^(TestComponent_|TestAPI_)")
    }
    $goArgs += "./e2e/..."

    Write-Host "==> Running SlapRF E2E Verification Suite (WASM API + Component UI + Workflows)..." -ForegroundColor Gray
    & go @goArgs
    $exitCode = $LASTEXITCODE

    $latestReport = Join-Path $RepoRoot "test-results\latest.html"
    if (Test-Path $latestReport) {
        Write-Host ""
        Write-Host "==> E2E Verification Report (Videos + Traces + Screenshots): $latestReport" -ForegroundColor Gray
    }

    exit $exitCode
} finally {
    Pop-Location
}
