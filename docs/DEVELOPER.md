# SlapRF Developer Guide

This guide explains how to set up your local development environment, understand the repository layout, run the dev-only local web server, build the static site (WebAssembly engine + TypeScript bundle), and run the test suite.

For deep technical details on the 5.8 GHz / 2.4 GHz radio schedule, binary wire protocols, DSP pipeline, and timing state machines, see **[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)**.

---

## Table of Contents

1. [Prerequisites & Environment Setup](#1-prerequisites--environment-setup)
2. [Repository Layout](#2-repository-layout)
3. [Quick-Start Scripts](#3-quick-start-scripts)
4. [Day-to-Day Development Workflows](#4-day-to-day-development-workflows)
5. [Compiling Standalone Binaries & Static GitHub Pages Build](#5-compiling-standalone-binaries--static-github-pages-build)
6. [Running the Test Suite](#6-running-the-test-suite)
7. [Hardware Firmware Development (`XIAO ESP32-C5`)](#7-hardware-firmware-development-xiao-esp32-c5)
8. [Common Gotchas & Tips](#8-common-gotchas--tips)

---

## 1. Prerequisites & Environment Setup

SlapRF is designed with a **zero-Node.js, single-toolchain** build architecture:

- **Required**: **[Go 1.24+](https://go.dev/dl/)**
  - `cmd/build-web` and `cmd/devserver` use the pure-Go [`esbuild`](https://github.com/evanw/esbuild) library (`internal/devbundle`), which compiles and bundles `web/src/**/*.ts` into `dist/app.js` in memory in ~15 ms.
  - You do **not** need `node`, `npm`, `pnpm`, `webpack`, or `vite` installed to edit TypeScript, CSS, or Go code.
- **Required for Browser USB Flashing**: **Chrome, Edge, or Brave** (desktop) for WebSerial API support (`navigator.serial`).
- **Optional (Firmware C Source Only)**: **Espressif ESP-IDF v5.5+** (`idf.py` with `esp32c5` target support) — only needed to build the `firmware/<profile>/` images locally; otherwise CI (`.github/workflows/firmware.yml`) builds them. Per-board settings (role, timer name, fingerprint, Wi-Fi credentials, 5.8 GHz channels) are binary-patched at flash time into the `SLAPRF02` config block without recompiling C code.

### Verify Your Environment

```bash
go version
# Expected: go version go1.24.x ...
```

Clone the repository and download the Go module dependencies:

```bash
git clone https://github.com/kaack/SlapRF.git
cd SlapRF
go mod download
```

---

## 2. Repository Layout

```text
SlapRF/
├── cmd/
│   ├── devserver/       # DEV-ONLY local web server (:8090), bundles TS + builds WASM on the fly
│   ├── slaprf-wasm/     # Go -> WebAssembly entry point (GOOS=js GOARCH=wasm -> slaprf.wasm)
│   ├── slaprf-relay/    # LiveTime relay: TCP :5403 <-> WebSocket 127.0.0.1:5404 byte copier (released binary)
│   └── build-web/       # Static site & WASM builder (outputs ./_site and syncs ./web/wasm/)
├── internal/
│   ├── api/             # /api/* request router used in-process by the WASM engine
│   ├── devbundle/       # Host-side asset builder: esbuild TS bundle, wasm_exec.js, slaprf.wasm (build-web, devserver)
│   ├── domain/          # Shared data models (pilots, gates, telemetry frames, timing rules, sim state)
│   ├── dsp/             # 8-channel 5.8 GHz EMA filter, hysteresis detector, parabolic peak fitter
│   ├── firmware/        # SLAPRF02 config patcher for compiled XIAO ESP32-C5 images & profile.json loader
│   ├── ingest/          # 50 Hz multi-gate physics/RF simulator & Hub Wi-Fi UDP (:5404) receiver
│   ├── laprf/           # ImmersionRC LapRF 8-Way binary protocol emulator (runs in WASM; ServeConn over any stream)
│   └── tracker/         # Multi-gate timing engine, 5-stage crossing guardrails, section split math
├── web/
│   ├── embed.go         # //go:embed directive bundling index.html, styles/, src/, and wasm/ into the binary
│   ├── index.html       # SPA entry HTML & boot loader
│   ├── styles/          # Modular CSS (tokens.css, base.css, layout.css, components.css, views.css)
│   ├── wasm/            # Compiled slaprf.wasm & wasm_exec.js served to the browser
│   ├── firmware/        # CI-built slaprf-xiao-c5-<profile>.bin images (git-ignored build outputs)
│   └── src/             # TypeScript SPA source
│       ├── core/        # Hash router, WakeLock manager, custom select & table scroll helpers
│       ├── layout/      # AppShell, Sidebar, TopBar
│       ├── services/    # ApiClient, WasmSimTransport, BrowserHubBridge, Announcer, PiperNeuralTts, EspFlasher
│       ├── state/       # Reactive AppStore
│       ├── types/       # TypeScript interfaces matching internal/domain JSON payloads
│       ├── views/       # Practice (LiveView), Analytics (PilotView), Simulator (SimView), Settings (SetupView)
│       └── widgets/     # Oscilloscope chart, lap/section charts, track editor, timing rules, flasher modal
├── firmware/
│   ├── README.md        # Profile overview & shared wire protocol
│   ├── embed.go         # //go:embed of every */profile.json (firmware profile manifests)
│   ├── open-ground/     # One ESP-IDF project per profile (main/main.c, profile.json, sdkconfig.defaults)
│   ├── open-elevated/
│   ├── indoor/
│   ├── obstructed/
│   └── components/
│       └── slaprf_radio/ # Shared ESP-IDF hardware component (2.4 GHz link, Hub bridge, 5.8 GHz sensing)
├── scripts/             # Developer helper scripts (.ps1 for Windows PowerShell, .sh for macOS/Linux)
└── docs/
    ├── ARCHITECTURE.md  # Low-level RF, protocol, DSP, and state machine reference
    └── DEVELOPER.md     # This developer setup & workflow guide
```

---

## 3. Quick-Start Scripts

Ready-to-run helper scripts are included in the [`scripts/`](../scripts) folder for both **Windows (PowerShell)** and **macOS / Linux (Bash)**:

| Task | Windows (PowerShell) | macOS / Linux (Bash) | What It Does |
| :--- | :--- | :--- | :--- |
| **Start Dev Server** | `.\scripts\dev.ps1` | `./scripts/dev.sh` | Runs the dev-only server (`go run ./cmd/devserver`) on `http://localhost:8090`. |
| **Full Build** | `.\scripts\build.ps1` | `./scripts/build.sh` | Builds the static site (`./_site`, what https://slaprf.app serves) and updates `./web/wasm/slaprf.wasm`. |
| **Run Unit Tests** | `.\scripts\test.ps1` | `./scripts/test.sh` | Runs the complete Go unit test suite (`go test -v -ldflags="-s -w" ./...`). |

---

## 4. Day-to-Day Development Workflows

There is no desktop server: the whole app (UI + Go timing engine compiled to WebAssembly) runs in the browser and talks to the Hub over WebSerial. For development, [`cmd/devserver`](../cmd/devserver/main.go) is a small **dev-only** web server (never shipped) that serves `web/` with `Cache-Control: no-store` and builds the generated assets on the fly:

| URL | Built from |
| :--- | :--- |
| `/dist/app.js` | `web/src/main.ts` bundled by pure-Go `esbuild` on **every** request |
| `/wasm/slaprf.wasm` | `./cmd/slaprf-wasm` (`GOOS=js GOARCH=wasm`), rebuilt on the next request after any `.go` file under `cmd/` or `internal/` changes |
| `/wasm/wasm_exec.js` | the local Go toolchain (`GOROOT`) |

**Windows (PowerShell):**
```powershell
go run -ldflags="-s -w" ./cmd/devserver
```

**macOS / Linux (Bash):**
```bash
go run -ldflags="-s -w" ./cmd/devserver
```

Flags:

```text
  -addr string
        listen address (default "127.0.0.1:8090")
  -web string
        path to the web/ directory (default "./web")
  -open
        open the app in the default browser
```

### Workflow A: Editing Frontend TypeScript or CSS (`web/src/**`, `web/styles/**`)

1. Open `http://localhost:8090` in Chrome, Edge, or Brave (WebSerial needs `localhost` or HTTPS).
2. Edit any file under `web/src/` or `web/styles/`.
3. **Refresh the browser (`F5` / `Cmd+R`)**: the dev server re-bundles `dist/app.js` with no manual build step.

### Workflow B: Editing Go Timing / DSP / Simulator Code (`internal/**`, `cmd/**`)

Both Simulation Mode and Real Hardware Mode run the Go engine compiled to WebAssembly. After changing Go code, just refresh the browser: the dev server notices the newer source files and recompiles `slaprf.wasm` (takes a few seconds) before serving it.

### Workflow C: MultiGP LiveTime via `slaprf-relay`

LiveTime speaks the ImmersionRC LapRF protocol over TCP `:5403`. The protocol is implemented in [`internal/laprf`](../internal/laprf/server.go) and runs **inside the WASM engine**: `laprf.Server.ServeConn` serves one session over any `net.Conn`, and [`cmd/slaprf-wasm/livetime.go`](../cmd/slaprf-wasm/livetime.go) bridges a `net.Pipe` to JS (`slaprfWasm.liveTimeOpen / liveTimeData / liveTimeClose / onLiveTimeOut`). [`cmd/slaprf-relay`](../cmd/slaprf-relay/main.go) is a separate, protocol-agnostic binary that copies bytes between LiveTime's TCP socket and a loopback WebSocket that [`web/src/services/livetime_relay.ts`](../web/src/services/livetime_relay.ts) connects to.

`	ext
LiveTime --TCP :5403--> slaprf-relay --ws://127.0.0.1:5404 (binary = raw LapRF, text = JSON events)--> tab --net.Pipe--> laprf.ServeConn
`

To try it locally: `go run ./cmd/slaprf-relay` next to the dev server, enable LiveTime in **Settings**, and point LiveTime (or any LapRF client) at `127.0.0.1:5403`. The relay accepts WebSocket upgrades only from `https://slaprf.app` and `http(s)://localhost|127.0.0.1:<any port>` (extend with `-allow-origin`). `go test ./cmd/slaprf-relay` includes an end-to-end test that runs the LapRF emulator behind the relay. Release builds for Windows/macOS/Linux are attached to each GitHub release by [`.github/workflows/release.yml`](../.github/workflows/release.yml).

---
## 5. Static Site Build (https://slaprf.app)

[`cmd/build-web`](../cmd/build-web/main.go) produces the complete static site in `./_site` (`index.html`, `styles/`, `dist/app.js`, `wasm/slaprf.wasm`, `wasm/wasm_exec.js`, `firmware/slaprf-xiao-c5-*.bin`); [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) deploys it.

```bash
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site
```

### Test the Static Output (`./_site`)

`./_site` can be hosted on any static file server with no Go backend:

```bash
# Serve ./_site on http://localhost:8000 using Python's built-in HTTP server (or any static server)
python3 -m http.server 8000 --directory ./_site
```

---

## 6. Running the Test Suite

Every core subsystem includes deterministic unit tests:

| Package | Test Files | Coverage Area |
| :--- | :--- | :--- |
| `internal/dsp` | `peak_detector_test.go` | EMA smoothing, hysteresis enter/exit thresholds, sub-frame parabolic vertex interpolation |
| `internal/tracker` | `crossing_rules_test.go`, `track_rules_test.go`, `thresholds_test.go`, `pilot_conflict_test.go`, `track_test.go` | 5-stage crossing guardrails, per-gate rule overrides, section splits (`S1`–`S4`), channel conflict resolution |
| `internal/ingest` | `simulator_test.go`, `wifi_udp_test.go` | 50 Hz physics/RF simulator state machine & `0xC5 0x59` variable-length sliding-window FEC packet reconstruction |
| `internal/laprf` | `protocol_test.go` | ImmersionRC LapRF SLIP framing, CRC-16-CCITT, `RF_SETUP` & passing record encoding |
| `internal/firmware` | `image_test.go` | `SLAPRF02` 160-byte config block round-trip for every profile, fingerprint generation, merged-image checksum & SHA-256 repair, `main.c` ↔ `profile.json` consistency |
| `internal/api` | `http_server_test.go` | `/api/*` request routing, sim/real engine isolation |
| `internal/devbundle` | `devbundle_test.go` | pure-Go esbuild TypeScript bundle |

Run all tests:

```bash
go test -v -ldflags="-s -w" ./...
```

Run tests for a single package:

```bash
go test -v -ldflags="-s -w" ./internal/tracker
```

---

## 7. Hardware Firmware Development (`XIAO ESP32-C5`)

The firmware for the Seeed Studio XIAO ESP32-C5 is split into **firmware profiles**, one ESP-IDF project per track type / timer placement (see [`firmware/README.md`](../firmware/README.md)):

| Directory | Code | Track | Timer placement |
| :--- | :--- | :--- | :--- |
| [`firmware/open-ground/`](../firmware/open-ground/) | `1` | Open field | On the grass at the gate base (default) |
| [`firmware/open-elevated/`](../firmware/open-elevated/) | `2` | Open field | On top of the gate or a pole |
| [`firmware/indoor/`](../firmware/indoor/) | `3` | Gym / warehouse | Any |
| [`firmware/obstructed/`](../firmware/obstructed/) | `4` | Woods, bando, technical | Behind or under obstacles |

- Each profile directory holds `main/main.c` (profile tuning such as `SLAPRF_PROFILE_CODE`, `SWEEP_HZ`, `WINDOW_SAMPLES`, link rate, and TX power `#define`d at the top), `profile.json` (manifest), `CMakeLists.txt`, and `sdkconfig.defaults`.
- All profiles pull in the shared hardware component [`firmware/components/slaprf_radio/`](../firmware/components/slaprf_radio/) (2.4 GHz ESP-NOW link, Hub Wi-Fi/UDP bridge, sync beacon, 5.8 GHz sensing).
- `profile.json` files are embedded by [`firmware/embed.go`](../firmware/embed.go) and loaded by [`internal/firmware/profiles.go`](../internal/firmware/profiles.go); they are the single source of truth for the flasher's **Firmware** dropdown, which lists one current build per profile (there is no version list).
- `go test -ldflags="-s -w" ./internal/firmware/` checks that every `main.c` matches its manifest.

> [!NOTE]
> 5.8 GHz band-power measurement ([`slaprf_rf58.c`](../firmware/components/slaprf_radio/slaprf_rf58.c)) is currently a **placeholder** that returns the noise floor; see its header comment for the planned raw-IQ debug-path approach.

### How Binary Patching Works (`SLAPRF02`)

Hub and Spoke timers of the same profile run the **same compiled image**. Each `main.c` embeds a 160-byte `slaprf_flash_config_t` struct starting with the magic `SLAPRF02` (layout in [`docs/ARCHITECTURE.md` §5.2](ARCHITECTURE.md)):

- When a user flashes or downloads a timer image, the browser patcher ([`web/src/services/esp_flasher.ts`](../web/src/services/esp_flasher.ts)) locates the `SLAPRF02` block, writes the role, profile code, board fingerprint, 8 pilot frequencies, Hub Wi-Fi credentials, and timer name, and updates the block's XOR crc8.
- It then repairs the ESP-IDF app image so the bootloader accepts it: the segment XOR checksum (seed `0xEF`) and, if enabled, the appended SHA-256. This works on bare app images and on merged flash images (app at `0x10000`) produced by `esptool merge_bin`.
- Every board gets a random, non-zero 32-bit **fingerprint** at flash time. When reflashing, the flasher can **keep** the board's existing fingerprint (read over USB with `SLAPRF?`) or mint a **new** one.

### Building the Firmware with ESP-IDF (Optional)

CI builds every profile, so you only need this when changing C code. With ESP-IDF v5.5+ exported in your shell:

```bash
cd firmware/open-ground            # or any firmware/<profile>
idf.py set-target esp32c5
idf.py build
# Merge bootloader + partition table + app (run from firmware/<profile>/build so @flash_args paths resolve)
cd build
python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-open-ground.bin @flash_args
```

`cmd/build-web` copies `web/firmware/slaprf-xiao-c5-<profile>.bin` into `_site/firmware/`, and the browser flasher fetches and patches them from there.

### CI Workflow & Placeholder Fallback

- [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) lists every `firmware/*/profile.json`, builds each profile in a matrix with `espressif/esp-idf-ci-action` (ESP-IDF `v5.5`, target `esp32c5`), merges the flash image, checks that it contains `SLAPRF02`, and uploads it as a `firmware-<profile>` artifact.
- `pages.yml` and `release.yml` call it first and download the artifacts into `web/firmware/` before building the site and release binaries.
- If an image is missing (e.g. a local checkout without ESP-IDF), `cmd/build-web` and the browser flasher fall back to `SyntheticBase()`: a 64 KB placeholder image with a valid header and an empty `SLAPRF02` block that flashes but does nothing.

---

## 8. Common Gotchas & Tips

1. **Always pass `-ldflags="-s -w"` on Windows**:
   - Windows Defender / antivirus heuristics frequently flag or delay unsigned Go test/build executables that contain DWARF debug symbol tables. Passing `-ldflags="-s -w"` to `go run`, `go build`, and `go test` strips DWARF symbols and prevents false positives.
2. **Go changes show up after a browser refresh**:
   - Simulation and Real Hardware Mode both run `slaprf.wasm` in the browser. `cmd/devserver` rebuilds it when Go sources change; for the static site, re-run `go run -ldflags="-s -w" ./cmd/build-web`.
3. **Browser Cache Busting (`web/index.html`)**:
   - If you deploy changes to GitHub Pages and want returning browsers to immediately pick up new CSS or JS without a hard refresh, bump the `?v=...` query string on the `<link>` and `<script>` tags in [`web/index.html`](../web/index.html).
