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

**CI (normal path):** [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) builds every profile with ESP-IDF v5.5 and merges each into one flash image, `slaprf-xiao-c5-<profile>.bin` (bootloader + partition table + app). The Pages and Release workflows run it first and drop the images into `web/firmware/`. From there the web flasher serves them, the Go binary embeds them, and they are attached to each GitHub release.

**Locally** (ESP-IDF v5.5+ installed and exported):

```sh
cd firmware/open-ground
idf.py set-target esp32c5
idf.py build
cd build
python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-open-ground.bin @flash_args
```

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

## 5.8 GHz sensing on the C5 (status: placeholder)

`components/slaprf_radio/slaprf_rf58.c` currently returns the noise floor. Everything around it (sweeps, windows, TDMA, Hub bridge, laptop ingest) builds and runs, so the whole pipeline can be exercised.

How it can be done:

- **Undocumented raw-IQ debug path.** Espressif's Wi-Fi modems have a test path that exposes raw baseband I/Q from the receiver ADC, bypassing the 802.11 decoders. It was found by the ESPARGOS team ([esp-sdr](https://github.com/ESPARGOS/esp-sdr), [espargos.net](https://espargos.net)) and independently by h0m3us3r. On the ESP32-C5 the synthesizer tunes across roughly 4.8–6.0 GHz, which covers every analog FPV band, including Raceband R8 at 5917 MHz, above the Wi-Fi channel plan.
- **How FPVGate uses it.** [FPVGateC5MK](https://github.com/LouisHitchcock/FPVGateC5MK) (multi-pilot) and [FPVGateC5RX](https://github.com/LouisHitchcock/FPVGateC5RX) (RX5808 drop-in) by Louis Hitchcock retune the local oscillator to each pilot's frequency, capture a short I/Q burst, and compute band power over about 10 MHz around the carrier. They hop up to 8 pilots at about 1 kHz each and hardware-timestamp every reading.

Porting plan: implement `esp_sdr_measure_5g_channel_dbm()` with that tune → capture → band-power routine. Check the source project's license before reusing code.

> **Single-radio caveat.** The C5 has one radio. While it is parked on 5.8 GHz it can't hear or send on 2.4 GHz, so sweeps and ESP-NOW have to be time-sliced (the profile's TDMA slots). A Hub that also holds a Wi-Fi station association will miss AP beacons while sweeping. FPVGate avoids this by pairing the C5, as a pure receiver, with an ESP32-S3 over UART that owns Wi-Fi and the UI. If time-slicing proves unreliable, that split is the fallback here too.
