# SlapRF timer firmware

Each profile directory is a complete ESP-IDF project for the Seeed XIAO ESP32-C5, tuned for one situation: a track type plus where the timers sit on the gates.

| Directory | Track | Timer placement |
|---|---|---|
| [`open-ground/`](open-ground/) | Open field | On the grass at the gate base (default) |
| [`open-elevated/`](open-elevated/) | Open field | On top of the gate or a pole |
| [`indoor/`](indoor/) | Gym / warehouse | Any |
| [`obstructed/`](obstructed/) | Woods, bando, technical | Behind or under obstacles |

```
firmware/
  <profile>/
    CMakeLists.txt        ESP-IDF project (pulls in ../components)
    sdkconfig.defaults    target esp32c5, 1 kHz FreeRTOS tick, console on UART0
    profile.json          manifest: id, code, name, track, mount, link, sweepHz, summary
    main/main.c           the timing design for this profile
  components/
    slaprf_radio/         hardware layer shared by all profiles (2.4 GHz link, Hub bridge,
                          sweep pacing, USB config readback, 5.8 GHz sensing)
  embed.go                embeds every */profile.json for the Go builder and the web app
```

Profiles own the timing design: sweep rate, window size, link rate, TX power, filters, recovery behaviour. Each `main/main.c` is deliberately self-contained, so profiles can change without affecting each other. The hardware layer is shared because it describes the board, not the situation.

## Building

**CI (normal path):** [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) builds every profile with ESP-IDF **v5.5.1** (pinned: the PHY test libraries differ between 5.5.x releases; 5.5.0 fails to link) and merges each into one flash image, `slaprf-xiao-c5-<profile>.bin` (bootloader + partition table + app). The Pages and Release workflows run it first and drop the images into `web/firmware/`. From there the web flasher serves them, the Go binary embeds them, and they are attached to each GitHub release.

**Locally on Windows** (no WSL needed). One-time install of ESP-IDF v5.5.1 into `C:\esp`:

```bat
git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git C:\esp\esp-idf
set IDF_TOOLS_PATH=C:\esp\tools
C:\esp\esp-idf\install.bat esp32c5
```

Then build one, several, or all profiles. Each merged image lands in `web/firmware/`, where the local server and flasher pick it up:

```bat
firmware\tools\build_local.bat               & rem every profile
firmware\tools\build_local.bat open-ground   & rem just one
```

On Linux or macOS, with ESP-IDF exported: `cd firmware/<profile> && idf.py build && cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-<profile>.bin @flash_args`.

Both CI and `tools/check_image.sh` check that static code and data end below the capture bank at `0x40820000` (open-ground leaves about 19 KB), that the PHY entry points are linked, and that the `SLAPRF02` block is present.

Without a compiled image, the flasher falls back to a placeholder image. It flashes, but it doesn't run anything.

**Per-board settings are patched, not compiled.** The flasher (Go `internal/firmware.PatchImage` or browser `esp_flasher.ts`) finds the `SLAPRF02` block in the compiled image and writes role, profile code, fingerprint, channel table, Hub Wi-Fi and timer name into it. It then recomputes the ESP-IDF segment checksum and the appended SHA-256 so the bootloader still accepts the image.

## Adding a profile

1. Copy an existing profile directory to `firmware/<new-id>/` and rename the `project()` in its `CMakeLists.txt`.
2. Give it a unique `code` in `profile.json`, with `id` matching the directory name, and set the same `SLAPRF_PROFILE_CODE` and `SWEEP_HZ` in `main/main.c`.
3. Run `go test -ldflags="-s -w" ./internal/firmware/`. It checks every `main.c` against its manifest. CI picks the new directory up automatically.

## Shared wire protocol (keep in sync in every `main.c`)

- `SLAPRF02` 160-byte config block: layout in `internal/firmware/image.go` and `web/src/services/esp_flasher.ts`.
- ESP-NOW / UDP frames: window `0xC5 0x59` (up to 6 sweeps), Hello `0xC5 0x5A`, Join `0x5B`, Assign `0x5C`, Hub beacon `0x5D` (inside `slaprf_radio`). Laptop side in `internal/ingest/wifi_udp.go`.
- USB: the running firmware answers `SLAPRF?\n` with its raw config block, so the flasher can keep a board's fingerprint when reflashing.

## 5.8 GHz sensing on the C5 (status: implemented, not yet bench-tested)

[`components/slaprf_radio/slaprf_rf58.c`](components/slaprf_radio/slaprf_rf58.c) implements the capture-engine method below. It compiles, links, and passes the SRAM-layout check, but it hasn't run on a board yet. The values to bench-verify are marked in the source: `DBM_OFFSET` calibration, the gain index, and the 2.4 GHz return path in `slaprf_rf58_leave()`.

**Time-slicing (design choice (a): one C5 per timer).** All timers share one beacon-anchored TDMA schedule, so every radio leaves 2.4 GHz for a sweep at the same moment, with the transmitter path forced off (`phy_pbus_xpd_tx_off`). Every radio then comes back for the gap, in which the Hub beacons, Spokes send in their slots, and the Hub forwards to the laptop. Sweeps start exactly one interval apart, so sample timestamps stay uniform. The schedule is described at the top of each `main/main.c`, and a compile-time assert guarantees enough slots for 6 Spokes. All timers on a course must run the same profile.

What the reference projects actually do. This is from their source and docs, not from search summaries. The key reference is [FPVGateC5MK `docs/RADIO_INTERNALS.md`](https://github.com/LouisHitchcock/FPVGateC5MK/blob/main/docs/RADIO_INTERNALS.md), measured on chip v1.0:

- **Raw capture.** The PHY has an ADC dump engine reached through `adctrig` in Espressif's `librftest.a`, which is only linked with `CONFIG_ESP_PHY_ENABLE_CERT_TEST=y`. It writes 10-bit I, 10-bit Q and the gain index per 32-bit word at 80 MS/s into SRAM at `0x40830000`, so the whole 128 KiB bank `0x40820000`–`0x4083FFFF` must be reserved from the heap.
- **Fast captures.** After one stock `adctrig`, driving the dump-control registers directly gives a 256-sample capture in about 10 µs.
- **Tuning.** `phy_set_chanfreq(5180, 1)` runs once for band calibration. Each hop then only moves the PLL (`phy_set_rf_freq_offset`): about 400 µs, or about 70 µs without its fixed delay. PLL tracking is disabled.
- **Gain.** Forced to a fixed index with `force_rx_gain`; the AGC isn't used.
- **Band power.** Set the LO 10 MHz below the pilot (the spectrum is inverted), mix down, sum Hann-windowed 8-sample blocks for the power in about 10 MHz, then apply median-of-3 and an EMA. About 121 µs per pilot visit.
- **Range.** 5180–5917 MHz verified, including Raceband R8. Boscam E7/E8 (5925/5945) are unreachable with this method.
- **Receive-only, Wi-Fi idle.** Wi-Fi runs in `WIFI_MODE_NULL` + promiscuous purely to keep the PHY powered. Nothing transmits, and the link to the host is UART or USB.

**Licensing.** [esp-sdr](https://github.com/ESPARGOS/esp-sdr) is GPL-3.0. FPVGateC5MK and FPVGateC5RX are CC BY-NC-SA 4.0 (non-commercial, with commercial licences sold separately), written clean-room from facts. Their code can't be copied into SlapRF unless SlapRF's licence is compatible. The facts themselves (register addresses, call order, timings) aren't copyrightable and can be implemented independently. This is not legal advice.

> **What's unproven.** None of the reference projects transmits on the same C5 while scanning: they keep Wi-Fi idle. The parts to verify first on a bench are that `phy_set_chanfreq(2.4 GHz)` + `phy_pbus_xpd_tx_on` really return the Wi-Fi driver to a working link after each sweep, that nothing is emitted while on 5.8 GHz (check with a spectrum analyser or a second C5 in esp-sdr), and how many Hub AP beacons are lost. If this doesn't hold up, the fallback is FPVGate's split: the C5 as a pure receiver, plus a second MCU for the link.
