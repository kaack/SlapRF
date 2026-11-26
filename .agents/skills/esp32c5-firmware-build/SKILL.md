---
name: esp32c5-firmware-build
description: >-
  Compile, verify, and stage SlapRF ESP-IDF v5.5.1 firmware images locally for the Seeed Studio XIAO
  ESP32-C5 (firmware/slaprf -> slaprf-xiao-c5.bin and firmware/slaprf_ble -> slaprf-xiao-c5-ble.bin)
  and Waveshare ESP32-P4 PoE Bridge (firmware/slaprf_p4_poe_bridge -> slaprf-p4-poe-bridge.bin).
  Always build and verify firmware locally before pushing to GitHub. Activate when modifying C
  firmware under firmware/ or updating web/firmware/*.bin.
---

# Building ESP32-C5 & ESP32-P4 Firmware Locally

SlapRF maintains three ESP-IDF `v5.5.1` firmware projects under `firmware/`. **Always compile and verify firmware locally before pushing to GitHub** (if `~/esp/esp-idf` is not yet installed on a machine, follow the zero-`sudo` user-space setup in `dev-setup` first):

1. **USB Hub & Spoke Image** (`firmware/slaprf/` -> `web/firmware/slaprf-xiao-c5.bin`, target `esp32c5`):
   Runs on all Spoke timers (`T1`..`T6`) and wired USB-C Hub timers (`H1`). Uses shared components in `firmware/components/slaprf_radio/`.
2. **Bluetooth Hub Image** (`firmware/slaprf_ble/` -> `web/firmware/slaprf-xiao-c5-ble.bin`, target `esp32c5`):
   Dedicated wireless Hub image (`H1`) using NimBLE (`2M PHY`, `MTU 247`, phase-locked `10 ms` intervals) plus 2.4 GHz ESP-NOW Spoke collection (`firmware/components_ble/slaprf_ble_link/`).
3. **PoE Ethernet Serial Bridge Image** (`firmware/slaprf_p4_poe_bridge/` -> `web/firmware/slaprf-p4-poe-bridge.bin`, target `esp32p4`):
   Generic USB-Serial/JTAG Host to `TCP/UDP :5480` PoE Ethernet bridge for the Waveshare `ESP32-P4-POE-ETH` (`IP101GRI` RMII + High-Speed USB-A Host). Does **not** use a `SLAPRF02` config block (flashed raw at offset `0x0`).

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
# 1. USB Hub & Spoke image (esp32c5)
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

Note that `web/firmware/*.bin` is ignored by `.gitignore`, while `web/firmware/slaprf-xiao-c5.bin` is force-tracked. When intentionally updating the tracked USB image in git, stage with `git add -f web/firmware/slaprf-xiao-c5.bin` and run `go test ./internal/firmware/...` to verify `SLAPRF02` patching and SHA-256 repair.
