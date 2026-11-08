# SlapRF timer firmware

Each directory here is a complete, self-contained firmware for one situation: a track type plus where the timers sit on the gates. They share a wire protocol but not code. Each one is copied on purpose so it can change without affecting the others.

| Directory | Track | Timer placement |
|---|---|---|
| [`open-ground/`](open-ground/) | Open field | On the grass at the gate base (default) |
| [`open-elevated/`](open-elevated/) | Open field | On top of the gate or a pole |
| [`indoor/`](indoor/) | Gym / warehouse | Any |
| [`obstructed/`](obstructed/) | Woods, bando, technical | Behind or under obstacles |

Every profile is rebuilt on each release, so the flasher's **Firmware** dropdown only ever offers the current build of each design.

## What's in a profile directory

- `main.c`: the firmware. Profile tuning (`SLAPRF_PROFILE_CODE`, `SWEEP_HZ`, `WINDOW_SAMPLES`, link rate, TX power, …) is `#define`d at the top, and any profile-specific logic lives only in that file.
- `profile.json`: the manifest (`id`, `code`, `name`, `track`, `mount`, `link`, `sweepHz`, `summary`). It's the single source of truth for the flasher dropdown, the Go image builder (`internal/firmware`), and the web app, which gets it injected into the TypeScript bundle at build time.

## Adding a profile

1. Copy an existing directory to `firmware/<new-id>/`.
2. Give it a unique `code` in `profile.json`, with `id` matching the directory name, and set the same `SLAPRF_PROFILE_CODE` and `SWEEP_HZ` in `main.c`.
3. Run `go test -ldflags="-s -w" ./internal/firmware/`. It checks that every `main.c` matches its manifest.

## Shared wire protocol (keep in sync in every `main.c`)

- `SLAPRF02` 160-byte config block, patched at flash time: role, profile code, board fingerprint, 5.8 GHz channel table, Hub Wi-Fi credentials, timer name. Mirrored in `internal/firmware/image.go` and `web/src/services/esp_flasher.ts`.
- Frames: window `0xC5 0x59` (up to 6 sweeps), Hello `0xC5 0x5A`, Join `0xC5 0x5B`, Assign `0xC5 0x5C`. Mirrored in `internal/ingest/wifi_udp.go`.
