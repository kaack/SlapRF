#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUN_PATTERN=""
SKIP_PATTERN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -run|--run)
      RUN_PATTERN="${2:-}"
      shift 2
      ;;
    --component-only)
      RUN_PATTERN="^TestComponent_"
      shift
      ;;
    --api-only)
      RUN_PATTERN="^TestAPI_"
      shift
      ;;
    --workflow-only)
      SKIP_PATTERN="^(TestComponent_|TestAPI_)"
      shift
      ;;
    --regen-snapshots)
      export SLAPRF_E2E_REGEN_SNAPSHOTS=1
      shift
      ;;
    --headed)
      export SLAPRF_E2E_HEADED=1
      shift
      ;;
    --skip-build)
      export SLAPRF_E2E_SKIP_BUILD=1
      shift
      ;;
    --slowmo)
      export SLAPRF_E2E_SLOWMO="${2:-0}"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

GO_ARGS=(test -v -count=1 -tags=e2e -timeout=35m)
if [[ -n "$RUN_PATTERN" ]]; then
  GO_ARGS+=(-run "$RUN_PATTERN")
elif [[ -n "$SKIP_PATTERN" ]]; then
  GO_ARGS+=(-skip "$SKIP_PATTERN")
fi
GO_ARGS+=(./e2e/...)

echo "==> Running SlapRF E2E Verification Suite (WASM API + Component UI + Workflows)..."
go "${GO_ARGS[@]}"

if [[ -f "$REPO_ROOT/test-results/latest.html" ]]; then
  echo ""
  echo "==> E2E Verification Report (Videos + Traces + Screenshots): $REPO_ROOT/test-results/latest.html"
fi
