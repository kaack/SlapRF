# SlapRF timer firmware

One ESP-IDF project for the Seeed XIAO ESP32-C5, with one tuned configuration. Every timer (Hub or Spoke) runs the same image; the role and per-board settings are patched in at flash time.

The design: 100 Hz 8-channel 5.8 GHz sweeps, 4-sweep windows sent every 2 sweeps (every 20 ms, so every sample arrives twice) over 6 Mbps OFDM ESP-NOW at +20 dBm. The Hub is a USB collector dongle; when the app places it on a gate it also sweeps and streams its own readings after every sweep.

Link rate and TX power can be changed only from the USB serial console (`LINKRATE`, `TXPOWER`, `LINKRESET`); the values are saved in NVS and survive reflashing.

```
firmware/
  slaprf/
    CMakeLists.txt        ESP-IDF project (pulls in ../components)
    sdkconfig.defaults    target esp32c5, 1 kHz FreeRTOS tick, console on UART0
    main/main.c           timing design: sweep rate, window size, TDMA schedule, Hub/Spoke logic
  components/
    slaprf_radio/         hardware layer (2.4 GHz link, Hub bridge, sweep pacing,
                          USB config readback and serial console, 5.8 GHz sensing)
  tools/                  local build / flash / bench scripts
```

## Building

**CI (normal path):** [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) builds `firmware/slaprf` with ESP-IDF **v5.5.1** (pinned: the PHY test libraries differ between 5.5.x releases; 5.5.0 fails to link) and merges it into one flash image, `slaprf-xiao-c5.bin` (bootloader + partition table + app). The Pages and Release workflows run it first and drop the image into `web/firmware/`. From there the web flasher serves it, and it is attached to each GitHub release.

**Locally on Windows** (no WSL needed). One-time install of ESP-IDF v5.5.1 into `C:\esp`:

```bat
git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git C:\esp\esp-idf
set IDF_TOOLS_PATH=C:\esp\tools
C:\esp\esp-idf\install.bat esp32c5
```

Then build. The merged image lands in `web/firmware/slaprf-xiao-c5.bin`, where the local server and flasher pick it up:

```powershell
firmware\tools\build_local.ps1                   # build only
firmware\tools\build_local.ps1 -FlashPort COM3   # build and reflash a connected board, keeping its SLAPRF02 config
```

(`firmware\tools\build_local.bat` does the same build through `export.bat`.)

On Linux or macOS, with ESP-IDF exported: `cd firmware/slaprf && idf.py build && cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args`.

Both CI and `tools/check_image.sh` check that static code and data end below the capture bank at `0x40820000`, that the PHY entry points are linked, and that the `SLAPRF02` block is present.

Without a compiled image, the flasher falls back to a placeholder image. It flashes, but it doesn't run anything.

**Per-board settings are patched, not compiled.** The flasher (Go `internal/firmware.PatchImage` or browser `esp_flasher.ts`) finds the `SLAPRF02` block in the compiled image and writes role, fingerprint, channel table, and timer name into it. It then recomputes the ESP-IDF segment checksum and the appended SHA-256 so the bootloader still accepts the image.

## Wire protocol (keep in sync with the Go and TypeScript sides)

- `SLAPRF02` 160-byte config block: layout in `internal/firmware/image.go` and `web/src/services/esp_flasher.ts`.
- ESP-NOW frames: window `0xC5 0x59` (up to 6 sweeps), Hello `0xC5 0x5A`, Join `0x5B`, Assign `0x5C`, Hub beacon `0x5D` (inside `slaprf_radio`). Laptop side in `internal/ingest/hub_frames.go`.
- USB: the running firmware answers `SLAPRF?\n` with its raw config block (so the flasher can keep a board's fingerprint when reflashing) and provides an interactive line-based diagnostic console (`STATUS?`, `LIVE 1/2/0`, `SCAN`, `SCAN LIVE`, `SCAN STOP`, `CHANNELS`, `CHANNELS MASK`, `CHANNELS RESET`, `RF 1/0`, `EMERGENCY 1/0`, `HUBGATE 1/0`, `LINKRATE`, `TXPOWER`, `LINKRESET`, `LOG 1/0`, `BOOTLOG?`, `LASTLOG?`, `REBOOT`, `HELP`) used by the WebApp's Network and Debug pages.

## 5.8 GHz sensing on the C5

[`components/slaprf_radio/slaprf_rf58.c`](components/slaprf_radio/slaprf_rf58.c) implements the capture-engine method below:

**Time-slicing (one C5 per timer).** All timers share one beacon-anchored TDMA schedule, so every radio leaves 2.4 GHz for a sweep at the same moment, with the transmitter path forced off (`phy_pbus_xpd_tx_off`). Every radio then comes back for the gap, in which the Hub beacons, Spokes send in their slots, and the Hub forwards to the laptop over USB serial. Sweeps start one interval apart so sample timestamps stay uniform. The schedule is described at the top of `slaprf/main/main.c`, and a compile-time assert guarantees enough slots for 6 Spokes.

The key hardware reference is [FPVGateC5MK `docs/RADIO_INTERNALS.md`](https://github.com/LouisHitchcock/FPVGateC5MK/blob/main/docs/RADIO_INTERNALS.md), measured on chip v1.0:

- **Raw capture.** The PHY has an ADC dump engine reached through `adctrig` in Espressif's `librftest.a`, which is only linked with `CONFIG_ESP_PHY_ENABLE_CERT_TEST=y`. It writes 10-bit I, 10-bit Q and the gain index per 32-bit word at 80 MS/s into SRAM at `0x40830000`, so the whole 128 KiB bank `0x40820000`–`0x4083FFFF` must be reserved from the heap.
- **Fast captures.** After one stock `adctrig`, driving the dump-control registers directly gives a 256-sample capture in about 10 µs.
- **Tuning.** `phy_set_chanfreq(5180, 1)` runs once for band calibration. Each hop then only moves the PLL (`phy_set_rf_freq_offset`): about 400 µs, or about 70 µs without its fixed delay. PLL tracking is disabled.
- **Gain.** Forced to a fixed index with `force_rx_gain`; the AGC isn't used.
- **Band power.** Set the LO 10 MHz below the pilot (the spectrum is inverted), mix down, sum Hann-windowed 8-sample blocks for the power in about 10 MHz, then apply median-of-3 and an EMA. About 121 µs per pilot visit.
- **Range.** 5180–5917 MHz verified, including Raceband R8. Boscam E7/E8 (5925/5945) are unreachable with this method.

**Licensing.** [esp-sdr](https://github.com/ESPARGOS/esp-sdr) is GPL-3.0. FPVGateC5MK and FPVGateC5RX are CC BY-NC-SA 4.0 (non-commercial, with commercial licences sold separately), written clean-room from facts. Their code can't be copied into SlapRF unless SlapRF's licence is compatible. The facts themselves (register addresses, call order, timings) aren't copyrightable and can be implemented independently. This is not legal advice.
