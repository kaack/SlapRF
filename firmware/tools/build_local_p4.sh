#!/usr/bin/env bash
# Build firmware/slaprf_p4_poe_bridge locally with ESP-IDF v5.5.1 (esp32p4)
# and stage web/firmware/slaprf-p4-poe-bridge.bin.
# Optional first argument: serial port (e.g. /dev/ttyACM0) to flash immediately.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDF_EXPORT="${IDF_PATH:-$HOME/esp/esp-idf}/export.sh"

if [[ ! -f "$IDF_EXPORT" ]]; then
  echo "ERROR: ESP-IDF not found at $IDF_EXPORT" >&2
  echo "Install once with: git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git ~/esp/esp-idf && ~/esp/esp-idf/install.sh esp32c5,esp32p4" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$IDF_EXPORT" >/dev/null

PROJ_DIR="$REPO_ROOT/firmware/slaprf_p4_poe_bridge"
OUT_BIN="$REPO_ROOT/web/firmware/slaprf-p4-poe-bridge.bin"

cd "$PROJ_DIR"
if [[ ! -f build/CMakeCache.txt ]] || ! grep -q 'IDF_TARGET:STRING=esp32p4' build/CMakeCache.txt; then
  idf.py set-target esp32p4
fi
idf.py build

(
  cd build
  python -m esptool --chip esp32p4 merge_bin -o "$OUT_BIN" @flash_args
)
ls -lh "$OUT_BIN"

if [[ "${1:-}" != "" ]]; then
  PORT="$1"
  echo "Flashing $OUT_BIN to $PORT..."
  python -m esptool --chip esp32p4 --port "$PORT" --baud 460800 --before default_reset --after hard_reset write_flash -z 0x0 "$OUT_BIN"
fi
