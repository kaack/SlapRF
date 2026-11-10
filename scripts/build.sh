#!/usr/bin/env bash
# Builds the static site (./_site) for https://slaprf.app and syncs web/wasm/slaprf.wasm
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building static SPA & WebAssembly engine (./_site and ./web/wasm)..."
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

echo "Build complete: ./_site"
