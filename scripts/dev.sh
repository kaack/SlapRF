#!/usr/bin/env bash
# Builds the latest WebAssembly engine + web assets and starts the local SlapRF dev server on http://localhost:8090
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] Building WebAssembly simulation engine & web bundle..."
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

echo "[2/2] Starting SlapRF server on http://localhost:8090 ..."
go run -ldflags="-s -w" ./cmd/slaprf -web ./web -http :8090
