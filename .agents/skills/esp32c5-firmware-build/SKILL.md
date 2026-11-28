---
name: esp32c5-firmware-build
description: >-
  Compile, verify, and stage SlapRF ESP-IDF v5.5.1 firmware images locally for every supported
  board (see Supported Boards). Always build and verify firmware locally before pushing to
  GitHub. Activate when modifying C firmware under firmware/ or updating web/firmware/*.bin.
---

# Building SlapRF Firmware Locally

SlapRF maintains three ESP-IDF `v5.5.1` firmware projects under `firmware/`. **Always compile and verify firmware locally before pushing to GitHub** (if `~/esp/esp-idf` is not yet installed on a machine, follow the zero-`sudo` user-space setup in `dev-setup` first).

## Supported Boards

| Board | `-Board` / `SLAPRF_BOARD` | Images (project → `web/firmware/`) | Notes |
| --- | --- | --- | --- |
| Seeed Studio XIAO ESP32-C5 (**default**) | `xiao-c5` | `slaprf-xiao-c5.bin`, `slaprf-xiao-c5-ble.bin` | Every Spoke timer (`T1`..`T6`) and USB-C Hub (`H1`). Yellow active-low LED on GPIO27. Built by CI and embedded in the web flasher / desktop / Android / iOS clients. |
| Waveshare ESP32-C5-Zero (local build/flash variant) | `c5-zero` | `slaprf-c5-zero.bin`, `slaprf-c5-zero-ble.bin` | Not yet built by CI or embedded in the web flasher. WS2812 on GPIO27 (RMT-driven, green = on), antenna switch on GPIO26 (onboard ceramic default; IPEX-1 optional), BOOT on GPIO28. Needs a solid 5 V / 500 mA USB source. |
| Waveshare ESP32-P4-POE-ETH | — (`esp32p4` project) | `slaprf-p4-poe-bridge.bin` | PoE Ethernet serial bridge only (USB-Serial/JTAG Host → `TCP/UDP :5480`, `IP101GRI` RMII). Does **not** use a `SLAPRF02` config block (flashed raw at offset `0x0`). |

Both ESP32-C5 boards run the same chip, so the 5.8 GHz capture engine, 2.4 GHz link, USB console, and `SLAPRF02` config block are identical. The board differences live in `firmware/components/slaprf_board/`, selected with the CMake variable `SLAPRF_BOARD` (set by the build scripts' `-Board` flag); each board builds in its own build directory with its own `sdkconfig`.

## Firmware Images

1. **USB Hub & Spoke** (`firmware/slaprf/`, target `esp32c5`):
   Runs on every Spoke timer and wired USB-C Hub. Uses `firmware/components/slaprf_radio/` (2.4 GHz ESP-NOW link, USB bridge, 5.8 GHz sensing) plus `firmware/components/slaprf_board/`.
2. **Bluetooth Hub** (`firmware/slaprf_ble/`, target `esp32c5`):
   Dedicated wireless Hub image (`H1`) using NimBLE (`2M PHY`, `MTU 247`, phase-locked `10 ms` intervals) plus 2.4 GHz ESP-NOW Spoke collection (`firmware/components_ble/slaprf_ble_link/`). Hub-only: a flashed board always identifies as a Hub.
3. **PoE Ethernet Serial Bridge** (`firmware/slaprf_p4_poe_bridge/`, target `esp32p4`):
   Generic USB-Serial/JTAG Host to `TCP/UDP :5480` bridge (see Supported Boards).

## Critical Hardware & Linker Constraints

- **Reserved 128 KiB SRAM IQ Capture Bank (`0x40820000`..`0x4083FFFF`)**:
  `slaprf_rf58.c` captures raw 80 MS/s 10-bit ADC IQ samples via `adctrig` into `0x40830000`. Static `_bss_end` in the compiled ELF **must stay strictly below `0x40820000`**! Both `build_local*.ps1` and `firmware/tools/check_image.sh` enforce this automatically.
- **160-Byte `SLAPRF02` Flash Config Block**:
  Every merged `.bin` must contain the `SLAPRF02` magic block so `internal/firmware.PatchImage` and `web/src/services/esp_flasher.ts` can stamp board role, 32-bit fingerprint, channel frequencies, and label at flash time and recompute the ESP-IDF segment XOR checksum + trailing SHA-256 digest.
- **Wire Protocol Compatibility**:
  Keep Hub and Spokes on matching `WIRE_PROTO_VER` (`2`, verified during Spoke `JOIN`).

---

## 1. Local Build on Windows (`C:\esp` ESP-IDF v5.5.1)

The PowerShell helper scripts configure Ninja, CMake, RISC-V GCC, and `ccache` directly (skipping slow `export.bat`), verify `_bss_end < 0x40820000`, and merge bootloader + partition table + app into `web/firmware/`:

```powershell
# Default board (XIAO): USB Hub & Spoke + Bluetooth Hub images
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local_ble.ps1

# Waveshare ESP32-C5-Zero variants (own build dirs build-c5-zero)
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local.ps1 -Board c5-zero
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local_ble.ps1 -Board c5-zero
```
*(To also flash a connected board while preserving its existing `SLAPRF02` identity, append `-FlashPort COM3`, plus `-Board c5-zero` for that board; see the `usb-timer-debug-and-flash` skill.)*

---

## 2. Local Build on macOS / Linux (`~/esp/esp-idf`)

If `~/esp/esp-idf` is not yet installed, bootstrap it once in user space (zero `sudo` or Docker needed; see `dev-setup` skill):
```bash
mkdir -p ~/esp
git clone -b v5.5.6 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git ~/esp/esp-idf
~/esp/esp-idf/install.sh esp32c5,esp32p4
. ~/esp/esp-idf/export.sh
python -m pip install cmake ninja pyserial
```

With ESP-IDF `v5.5.1` exported (`. ~/esp/esp-idf/export.sh`):

```bash
# 1. USB Hub & Spoke image (esp32c5; XIAO name shown — for the C5-Zero, configure with
#    idf.py -DSLAPRF_BOARD=c5-zero -B build-c5-zero and output slaprf-c5-zero.bin)
cd firmware/slaprf
idf.py build
bash ../tools/check_image.sh
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args)

# 2. Bluetooth Hub image (esp32c5)
cd ../../firmware/slaprf_ble
idf.py build
bash ../tools/check_image.sh
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-ble.bin @flash_args)

# 3. Waveshare ESP32-P4 PoE Ethernet Bridge image (esp32p4) — or run: bash firmware/tools/build_local_p4.sh [/dev/ttyACM0]
cd ../../firmware/slaprf_p4_poe_bridge
idf.py set-target esp32p4
idf.py build
(cd build && python -m esptool --chip esp32p4 merge_bin -o ../../../web/firmware/slaprf-p4-poe-bridge.bin @flash_args)
```

---

## 3. Fetching CI Artifacts (Only After Local Verification or for Release Comparison)

If ESP-IDF `v5.5.1` is not installed locally, push your branch or trigger `.github/workflows/firmware.yml` and download the verified artifacts straight into `web/firmware/`:

```bash
# Trigger CI build on current branch (after pushing)
gh workflow run firmware.yml --ref $(git branch --show-current)

# Watch until green, then download both merged .bin images
gh run list --workflow=firmware.yml --limit 3
gh run watch <RUN_ID> --exit-status
gh run download <RUN_ID> -n firmware -D web/firmware
gh run download <RUN_ID> -n firmware-ble -D web/firmware
```
*(CI builds the default XIAO images only — see Supported Boards.)*

Note that `web/firmware/*.bin` is ignored by `.gitignore`, while `web/firmware/slaprf-xiao-c5.bin` is force-tracked. When intentionally updating the tracked USB image in git, stage with `git add -f web/firmware/slaprf-xiao-c5.bin` and run `go test ./internal/firmware/...` to verify `SLAPRF02` patching and SHA-256 repair.
