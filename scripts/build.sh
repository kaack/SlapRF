#!/usr/bin/env bash
# Builds the static SPA (_site), syncs web/wasm/slaprf.wasm, and compiles the standalone native binary
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] Building static SPA & WebAssembly engine (./_site and ./web/wasm)..."
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

OUT_BIN="slaprf"
if [[ "${OS:-}" == "Windows_NT" ]]; then
  OUT_BIN="slaprf.exe"
fi

echo "[2/2] Compiling standalone native binary (${OUT_BIN})..."
go build -ldflags="-s -w" -o "${OUT_BIN}" ./cmd/slaprf

echo "Build complete: ./${OUT_BIN} and ./_site"
