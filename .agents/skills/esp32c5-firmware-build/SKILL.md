---
name: esp32c5-firmware-build
description: >-
  Compile, verify, and stage SlapRF ESP-IDF v5.5.1 firmware images for the Seeed Studio XIAO
  ESP32-C5: USB Hub & Spoke firmware (firmware/slaprf -> slaprf-xiao-c5.bin) and Bluetooth LE Hub
  firmware (firmware/slaprf_ble -> slaprf-xiao-c5-ble.bin), or pull prebuilt artifacts from GitHub
  Actions. Activate when modifying C firmware under firmware/ or updating web/firmware/*.bin.
---

# Building ESP32-C5 Timer Firmware

SlapRF maintains two ESP-IDF `v5.5.1` (`esp32c5` target) firmware projects under `firmware/`:

1. **USB Hub & Spoke Image** (`firmware/slaprf/` -> `web/firmware/slaprf-xiao-c5.bin`):
   Runs on all Spoke timers (`T1`..`T6`) and wired USB-C Hub timers (`H1`). Uses shared components in `firmware/components/slaprf_radio/`.
2. **Bluetooth Hub Image** (`firmware/slaprf_ble/` -> `web/firmware/slaprf-xiao-c5-ble.bin`):
   Dedicated wireless Hub image (`H1`) using NimBLE (`2M PHY`, `MTU 247`, phase-locked `10 ms` intervals) plus 2.4 GHz ESP-NOW Spoke collection (`firmware/components_ble/slaprf_ble_link/`).

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
# Build USB Hub & Spoke image -> web\firmware\slaprf-xiao-c5.bin
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local.ps1

# Build Bluetooth Hub image -> web\firmware\slaprf-xiao-c5-ble.bin
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local_ble.ps1
```
*(To also flash a connected board while preserving its existing `SLAPRF02` identity, append `-FlashPort COM3`; see the `usb-timer-debug-and-flash` skill.)*

---

## 2. Local Build on macOS / Linux

With ESP-IDF `v5.5.1` exported (`. ~/esp/esp-idf/export.sh`):

```bash
# 1. USB Hub & Spoke image
cd firmware/slaprf
idf.py build
bash ../tools/check_image.sh
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args)

# 2. Bluetooth Hub image
cd ../../firmware/slaprf_ble
idf.py build
bash ../tools/check_image.sh
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-ble.bin @flash_args)
```

---

## 3. Building / Fetching Firmware via GitHub Actions (No Local ESP-IDF)

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

Note that `web/firmware/*.bin` is ignored by `.gitignore`, while `web/firmware/slaprf-xiao-c5.bin` is force-tracked. When intentionally updating the tracked USB image in git, stage with `git add -f web/firmware/slaprf-xiao-c5.bin` and run `go test ./internal/firmware/...` to verify `SLAPRF02` patching and SHA-256 repair.
