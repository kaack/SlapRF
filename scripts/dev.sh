#!/usr/bin/env bash
# Starts the DEV-ONLY local web server on http://localhost:8090 (TypeScript bundle and WASM engine built on the fly)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting SlapRF dev server on http://localhost:8090 ..."
go run -ldflags="-s -w" ./cmd/devserver -web ./web
