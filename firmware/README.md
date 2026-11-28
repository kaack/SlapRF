# SlapRF Timer Firmware

ESP-IDF v5.5.1 firmware for ESP32-C5 boards. Default board: Seeed Studio XIAO ESP32-C5 (`xiao-c5`); the Waveshare ESP32-C5-Zero (`c5-zero`) is supported as a local build/flash variant (not yet in CI or the web flasher).

SlapRF builds two firmware images that share the same 5.8 GHz raw ADC capture engine and `SLAPRF02` flash configuration block:

1. **`firmware/slaprf/` -> `slaprf-xiao-c5.bin` (USB Hub & Spoke timers)**:
   Used on every Spoke timer (`T1` to `T6`) and on wired USB-C Hubs (`H1`).
2. **`firmware/slaprf_ble/` -> `slaprf-xiao-c5-ble.bin` (Bluetooth Hub timer)**:
   Dedicated wireless Hub image that streams Hub and Spoke telemetry to an Android phone or laptop over Bluetooth LE (`2M PHY`, `MTU 247`, phase-locked `10 ms` intervals) while collecting Spoke frames over 2.4 GHz ESP-NOW.

Both images run 500 Hz on-chip multi-pass 5.8 GHz sweeps (5 passes per 10 ms tick combined via trimmed linear mean into 100 Hz `0.5 dB` samples) and send 4-sweep sliding windows every 20 ms over `6 Mbps` OFDM ESP-NOW at `+20 dBm`.

```text
firmware/
  slaprf/
    CMakeLists.txt        USB Hub & Spoke ESP-IDF project (uses ../components)
    sdkconfig.defaults    target esp32c5, 1 kHz FreeRTOS tick
    main/main.c           sweep pacing, window buffer, TDMA schedule, USB Hub/Spoke logic
  slaprf_ble/
    CMakeLists.txt        Bluetooth Hub ESP-IDF project (uses ../components_ble)
    sdkconfig.defaults    target esp32c5, NimBLE peripheral, flash-resident BT controller
    main/main.c           sweep pacing, BLE connection phase lock, ESP-NOW Hub collector
  components/
    slaprf_radio/         shared 5.8 GHz sensing (slaprf_rf58.c), ESP-NOW link, USB console
    slaprf_board/         board bring-up (LED, antenna switch, BOOT button) per SLAPRF_BOARD variant
  components_ble/
    slaprf_ble_link/      NimBLE GATT link, Claim-on-Pair AUTH, BLE console, ESP-NOW Hub link
  tools/                  CI and local build / flash / verification scripts
```

## Board variants

Both supported boards use the same ESP32-C5 chip, so the 5.8 GHz capture engine, 2.4 GHz link, and SLAPRF02 config block are identical. Only the board hardware differs, selected with the CMake variable `SLAPRF_BOARD` (`xiao-c5` default, or `c5-zero`):

| | XIAO ESP32-C5 (`xiao-c5`) | Waveshare ESP32-C5-Zero (`c5-zero`) |
|---|---|---|
| Status LED | GPIO27, plain yellow, active-low | GPIO27, WS2812 RGB (on = dim green) |
| Antenna | module default path (switch GPIO is a no-op TODO) | GPIO26: `0` = onboard ceramic, `1` = external IPEX-1 (selected at boot) |
| BOOT button | GPIO28 | GPIO28 (same chip boot-strap pin) |
| Flash | 4 MB | 4 MB |

Build and flash the Waveshare ESP32-C5-Zero locally on Windows (each board gets its own build directory):

```powershell
firmware\tools\build_local.ps1 -Board c5-zero                   # web\firmware\slaprf-c5-zero.bin
firmware\tools\build_local.ps1 -Board c5-zero -FlashPort COM5   # build and flash over USB
firmware\tools\build_local_ble.ps1 -Board c5-zero -FlashPort COM5 # Bluetooth Hub image
```

Notes for the `c5-zero` board:

- The single USB-C port is USB-Serial-JTAG (GPIO13/14) and carries both flashing and the USB console, like the XIAO.
- RF routes to the onboard ceramic antenna by default (works on both bands with nothing attached). To use a 5.8 GHz antenna on the IPEX-1 connector instead, drive GPIO26 high in `slaprf_board_select_external_antenna()` in `firmware/components/slaprf_board/slaprf_board.c`.
- Power: needs a solid 5 V / 500 mA USB source. Weak ports (front-panel, hubs) sag the 3.3 V rail once the radio transmits at +20 dBm and the board resets in a brownout loop (`E BOD` in the boot log, `reset: "brownout"` in STATUS?) — the firmware fails loudly on purpose; move the board to a stronger port.
- `c5-zero` images are not embedded in the web flasher or CI; flash with the scripts above or `esptool write_flash 0x10000 <bin>` directly.

## Building

**CI (default path):** [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) compiles both projects with ESP-IDF **v5.5.1** and produces `slaprf-xiao-c5.bin` and `slaprf-xiao-c5-ble.bin`. Both images are embedded into the web flasher, desktop binaries, Android APK, and GitHub Releases.

**Locally on Windows** (ESP-IDF v5.5.1 installed in `C:\esp`):

```bat
git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git C:\esp\esp-idf
set IDF_TOOLS_PATH=C:\esp\tools
C:\esp\esp-idf\install.bat esp32c5
```

Build USB/Spoke or Bluetooth Hub images:

```powershell
firmware\tools\build_local.ps1                   # build slaprf-xiao-c5.bin
firmware\tools\build_local.ps1 -FlashPort COM3   # build and flash USB/Spoke image

firmware\tools\build_local_ble.ps1               # build slaprf-xiao-c5-ble.bin
firmware\tools\build_local_ble.ps1 -FlashPort COM6 # build and flash Bluetooth Hub image
```

**Locally on Linux or macOS** (with ESP-IDF v5.5.1 exported):

```bash
cd firmware/slaprf && idf.py build && (cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args)
cd ../slaprf_ble && idf.py build && (cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-ble.bin @flash_args)
```

`tools/check_image.sh` verifies that static code and data end below the 128 KiB ADC capture bank at `0x40820000`, that the PHY capture symbols are linked, and that the `SLAPRF02` block is present.

**Per-board settings are patched at flash time.** `internal/firmware.PatchImage` and `web/src/services/esp_flasher.ts` locate the 160-byte `SLAPRF02` block in the compiled image, write the role, 32-bit fingerprint, 8 pilot frequencies, and timer label, and recompute the ESP-IDF segment checksum and trailing SHA-256 digest.

## Wire Protocol

- **Matching firmware versions:** Keep the Hub and all Spokes on matching firmware (`WIRE_PROTO_VER = 2` is checked on Spoke `JOIN`).
- **`SLAPRF02` 160-byte config block:** Defined in `internal/firmware/image.go` and `web/src/services/esp_flasher.ts`.
- **Hub & Spoke binary frames:** `0.5 dB` sliding window `0xC5 0x60`, single sweep `0xC5 0x61`, Hello `0xC5 0x5A`, Join `0xC5 0x5B`, Assign `0xC5 0x5C`, Sync Beacon `0xC5 0x5D`, and Channel Table `0xC5 0x5E`. Decoded on the host in `internal/ingest/hub_frames.go`.
- **Bluetooth Hub GATT protocol:** Documented in [`docs/ble-hub-protocol.md`](../docs/ble-hub-protocol.md).

## 5.8 GHz Sensing on the ESP32-C5

[`components/slaprf_radio/slaprf_rf58.c`](components/slaprf_radio/slaprf_rf58.c) measures 5.8 GHz VTX signal strength using the ESP32-C5 ADC capture engine (hardware facts documented in [FPVGateC5MK `docs/RADIO_INTERNALS.md`](https://github.com/LouisHitchcock/FPVGateC5MK/blob/main/docs/RADIO_INTERNALS.md)):

- **Raw ADC capture:** `adctrig` (`CONFIG_ESP_PHY_ENABLE_CERT_TEST=y`) writes 10-bit I/Q samples at 80 MS/s into SRAM at `0x40830000`. The 128 KiB SRAM bank `0x40820000` to `0x4083FFFF` is reserved from the heap.
- **Fast hops:** `phy_set_chanfreq(5180, 1)` calibrates the 5 GHz band once at boot; each channel hop moves the PLL with `phy_set_rf_freq_offset` at fixed RX gain (`force_rx_gain`).
- **Band power:** Tunes the local oscillator `10 MHz` below the pilot channel, mixes down, and integrates Hann-windowed 8-sample blocks across `5180` to `5917 MHz` (including Raceband `R8`). Boscam `E7` and `E8` (`5925` / `5945 MHz`) sit above PLL range.

**Licensing note:** [esp-sdr](https://github.com/ESPARGOS/esp-sdr) is GPL-3.0. FPVGateC5MK and FPVGateC5RX are CC BY-NC-SA 4.0. Hardware facts (register addresses, call order, timings) are implemented independently in SlapRF.
