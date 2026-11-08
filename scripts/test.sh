#!/usr/bin/env bash
# Runs the full SlapRF Go unit test suite
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running SlapRF unit tests..."
go test -v -ldflags="-s -w" ./...
