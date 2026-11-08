# SlapRF Developer Guide

This guide explains how to set up your local development environment, understand the repository layout, run the live development server, compile the WebAssembly simulation engine and standalone native binaries, and run the test suite.

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
  - The Go backend embeds the pure-Go [`esbuild`](https://github.com/evanw/esbuild) library (`internal/api/bundler_native.go`), which compiles and bundles `web/src/**/*.ts` into `dist/app.js` in memory in ~15 ms.
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
│   ├── slaprf/          # Main native server entry point (HTTP :8090, LapRF TCP :5403, Wi-Fi UDP :5404)
│   ├── slaprf-wasm/     # Go -> WebAssembly entry point (GOOS=js GOARCH=wasm -> slaprf.wasm)
│   └── build-web/       # Static site & WASM builder (outputs ./_site and syncs ./web/wasm/)
├── internal/
│   ├── api/             # REST + 50 Hz SSE server, pure-Go esbuild TS bundler, OS Wi-Fi scanner
│   ├── domain/          # Shared data models (pilots, gates, telemetry frames, timing rules, sim state)
│   ├── dsp/             # 8-channel 5.8 GHz EMA filter, hysteresis detector, parabolic peak fitter
│   ├── firmware/        # SLAPRF02 config patcher for compiled XIAO ESP32-C5 images & profile.json loader
│   ├── ingest/          # 50 Hz multi-gate physics/RF simulator & Hub Wi-Fi UDP (:5404) receiver
│   ├── laprf/           # ImmersionRC LapRF 8-Way SLIP binary protocol emulator (TCP :5403)
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
│       ├── services/    # ApiClient, WasmSimTransport, HttpRealTransport, Announcer, PiperNeuralTts, EspFlasher
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
| **Start Dev Server** | `.\scripts\dev.ps1` | `./scripts/dev.sh` | Rebuilds `slaprf.wasm` + `_site`, then launches the local server on `http://localhost:8090`. |
| **Full Build** | `.\scripts\build.ps1` | `./scripts/build.sh` | Builds the static SPA (`./_site`), updates `./web/wasm/slaprf.wasm`, and compiles `./slaprf` (`./slaprf.exe`). |
| **Run Unit Tests** | `.\scripts\test.ps1` | `./scripts/test.sh` | Runs the complete Go unit test suite (`go test -v -ldflags="-s -w" ./...`). |

---

## 4. Day-to-Day Development Workflows

### Workflow A: Editing Frontend TypeScript or CSS (`web/src/**`, `web/styles/**`)

When running the server with `-web ./web`, the Go HTTP server compiles `web/src/main.ts` on the fly using `esbuild` whenever `/dist/app.js` is requested and serves `web/styles/*.css` directly from disk:

**Windows (PowerShell):**
```powershell
go run -ldflags="-s -w" ./cmd/slaprf -web ./web -open=false
```

**macOS / Linux (Bash):**
```bash
go run -ldflags="-s -w" ./cmd/slaprf -web ./web -open=false
```

1. Open `http://localhost:8090` in your browser.
2. Edit any file under `web/src/` or `web/styles/`.
3. **Simply refresh the browser (`F5` / `Cmd+R`)** — the Go server re-bundles `dist/app.js` in ~15 ms with no manual build step.

---

### Workflow B: Editing Go Timing / DSP / Simulator Code (`internal/**`, `cmd/**`)

Because the web UI's **Simulation Mode** runs the Go timing and physics engine compiled to WebAssembly (`web/wasm/slaprf.wasm`) right inside the browser, any changes to `internal/domain`, `internal/dsp`, `internal/tracker`, `internal/ingest`, or `cmd/slaprf-wasm` must be compiled into `web/wasm/slaprf.wasm` before they take effect in Simulation Mode:

**Windows (PowerShell):**
```powershell
# Recompile WASM engine + static bundle, then start the server
.\scripts\dev.ps1
```

**macOS / Linux (Bash):**
```bash
# Recompile WASM engine + static bundle, then start the server
./scripts/dev.sh
```

Or if you only want to recompile `web/wasm/slaprf.wasm` directly while the server is already running:

**Windows (PowerShell):**
```powershell
$env:GOOS="js"; $env:GOARCH="wasm"
go build -ldflags="-s -w" -o web/wasm/slaprf.wasm ./cmd/slaprf-wasm
Remove-Item Env:\GOOS; Remove-Item Env:\GOARCH
```

**macOS / Linux (Bash):**
```bash
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/wasm/slaprf.wasm ./cmd/slaprf-wasm
```

---

### Workflow C: Server Flags (`cmd/slaprf`)

You can customize ports and startup behavior when running `./slaprf` or `go run ./cmd/slaprf`:

```text
  -http string
        HTTP address for the TypeScript Sector & Telemetry SPA (default ":8090")
  -laprf string
        TCP address for MultiGP LiveTime (ImmersionRC LapRF 8-Way protocol) (default ":5403")
  -udp string
        UDP address for Hub Timer 2.4 GHz LR sliding-window telemetry (default ":5404")
  -web string
        Path to the web SPA directory (default "./web")
  -open
        Automatically open the web UI in the default browser on startup (default true)
```

---

## 5. Compiling Standalone Binaries & Static GitHub Pages Build

The standalone `slaprf` binary embeds `web/index.html`, `web/styles/*`, `web/src/**`, and `web/wasm/*` via Go's `//go:embed` (`web/embed.go`). Therefore, **always run `cmd/build-web` before `go build ./cmd/slaprf`** so the embedded `web/wasm/slaprf.wasm` is up to date.

### Build for Your Current OS

**Windows (PowerShell):**
```powershell
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site
go build -ldflags="-s -w" -o slaprf.exe ./cmd/slaprf
```

**macOS / Linux (Bash):**
```bash
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site
go build -ldflags="-s -w" -o slaprf ./cmd/slaprf
```

### Test the Static GitHub Pages Output (`./_site`)

After running `cmd/build-web`, `./_site` contains the complete static SPA (including `dist/app.js`, `wasm/slaprf.wasm`, `wasm/wasm_exec.js`, and `firmware/slaprf-xiao-c5-*.bin`) that can be hosted on any static file server with no Go backend:

```bash
# Serve ./_site on http://localhost:8000 using Python's built-in HTTP server (or any static server)
python3 -m http.server 8000 --directory ./_site
```

### Cross-Compiling Release Binaries (All Platforms)

```bash
# 1. Refresh embedded WASM & static site first
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site

# 2. Cross-compile standalone binaries
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/slaprf-windows-amd64.exe ./cmd/slaprf
GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/slaprf-macos-arm64       ./cmd/slaprf
GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/slaprf-macos-amd64       ./cmd/slaprf
GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/slaprf-linux-amd64       ./cmd/slaprf
GOOS=linux   GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/slaprf-linux-arm64       ./cmd/slaprf
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
| `internal/api` | `http_server_test.go`, `sse_hub_test.go`, `wifi_test.go` | REST endpoints, SSE broadcast fan-out, TypeScript bundler, Wi-Fi SSID parser |

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

- When a user flashes or downloads a timer image, either the Go backend ([`internal/firmware/image.go`](../internal/firmware/image.go) `PatchImage`) or the browser patcher ([`web/src/services/esp_flasher.ts`](../web/src/services/esp_flasher.ts)) locates the `SLAPRF02` block, writes the role, profile code, board fingerprint, 8 pilot frequencies, Hub Wi-Fi credentials, and timer name, and updates the block's XOR crc8.
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

`cmd/build-web` copies `web/firmware/slaprf-xiao-c5-<profile>.bin` into `_site/firmware/`, and the Go server patches the same files for `/api/firmware/xiao-c5.bin`.

### CI Workflow & Placeholder Fallback

- [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) lists every `firmware/*/profile.json`, builds each profile in a matrix with `espressif/esp-idf-ci-action` (ESP-IDF `v5.5`, target `esp32c5`), merges the flash image, checks that it contains `SLAPRF02`, and uploads it as a `firmware-<profile>` artifact.
- `pages.yml` and `release.yml` call it first and download the artifacts into `web/firmware/` before building the site and release binaries.
- If an image is missing (e.g. a local checkout without ESP-IDF), `cmd/build-web`, the Go server, and the browser flasher fall back to `SyntheticBase()`: a 64 KB placeholder image with a valid header and an empty `SLAPRF02` block that flashes but does nothing.

---

## 8. Common Gotchas & Tips

1. **Always pass `-ldflags="-s -w"` on Windows**:
   - Windows Defender / antivirus heuristics frequently flag or delay unsigned Go test/build executables that contain DWARF debug symbol tables. Passing `-ldflags="-s -w"` to `go run`, `go build`, and `go test` strips DWARF symbols and prevents false positives.
2. **Simulation Mode uses `web/wasm/slaprf.wasm` (even on `localhost:8090`)**:
   - In the web UI, **Simulation Mode** (`WasmSimTransport`) runs in-browser via `web/wasm/slaprf.wasm`, while **Real Hardware Mode** (`HttpRealTransport`) talks to the native Go server over `/api/*` and `/api/stream`.
   - If you change Go code under `internal/` and want to see it in **Simulation Mode**, remember to run `.\scripts\dev.ps1` (or `go run -ldflags="-s -w" ./cmd/build-web`) so `web/wasm/slaprf.wasm` is recompiled.
3. **Browser Cache Busting (`web/index.html`)**:
   - If you deploy changes to GitHub Pages and want returning browsers to immediately pick up new CSS or JS without a hard refresh, bump the `?v=...` query string on the `<link>` and `<script>` tags in [`web/index.html`](../web/index.html).
