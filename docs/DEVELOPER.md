# SlapRF Developer Guide

This guide explains how to set up your local development environment, understand the repository layout, run the local server, build the standalone binary and static demo site, and run the test suite.

For technical details on the 5.8 GHz / 2.4 GHz radio schedule, binary wire protocols, DSP pipeline, and timing state machines, see **[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)**.

---

## Table of Contents

1. [Prerequisites & Environment Setup](#1-prerequisites--environment-setup)
2. [Repository Layout](#2-repository-layout)
3. [Quick-Start Scripts](#3-quick-start-scripts)
4. [Day-to-Day Development Workflows](#4-day-to-day-development-workflows)
5. [Static Site Build (`https://slaprf.app`) & Portable Binary](#5-static-site-build-httpsslaprfapp--portable-binary)
6. [Running the Test Suite](#6-running-the-test-suite)
7. [Hardware Firmware Development (`XIAO ESP32-C5`)](#7-hardware-firmware-development-xiao-esp32-c5)
8. [Common Gotchas & Tips](#8-common-gotchas--tips)

---

## 1. Prerequisites & Environment Setup

SlapRF uses a **single-toolchain, zero-Node.js** Go build:

- **Required**: **[Go 1.24+](https://go.dev/dl/)**
  - `cmd/build-web`, `cmd/build-portable`, and `cmd/devserver` use the pure-Go [`esbuild`](https://github.com/evanw/esbuild) library (`internal/devbundle`) to bundle `web/src/**/*.ts` into `dist/app.js` in ~15 ms.
  - You do **not** need `node`, `npm`, `pnpm`, `webpack`, or `vite` to edit TypeScript, CSS, or Go code.
- **Optional (Firmware C Source Only)**: **Espressif ESP-IDF v5.5.1** (`idf.py` with `esp32c5` target support). Only needed when editing `firmware/slaprf/` C code locally; otherwise CI (`.github/workflows/firmware.yml`) compiles `slaprf-xiao-c5.bin`. Per-board settings (role, timer label, fingerprint, 5.8 GHz channels) are patched into the `SLAPRF02` config block at flash time without recompiling C code.

### Verify Your Environment

```bash
go version
# Expected: go version go1.24.x ...
```

Clone the repository and download Go dependencies:

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
│   ├── slaprf/          # Production standalone server binary (embeds frontend, firmware, bbolt DB, USB/LAN hardware I/O)
│   ├── build-portable/  # Builds cmd/slaprf/site and compiles the standalone slaprf executable
│   ├── build-web/       # Static site & WASM demo builder (outputs ./_site)
│   ├── slaprf-wasm/     # Go -> WebAssembly entry point for the slaprf.app browser demo
│   └── devserver/       # Dev-only server (:8090): rebuilds TS and WASM on the fly
├── internal/
│   ├── api/             # /api/* HTTP/WebSocket handlers
│   ├── devbundle/       # Host-side asset builder: esbuild TS bundle, wasm_exec.js, slaprf.wasm
│   ├── domain/          # Shared data models (pilots, gates, telemetry frames, timing rules, race brackets)
│   ├── dsp/             # 8-channel 5.8 GHz EMA filter, hysteresis detector, parabolic peak fitter
│   ├── firmware/        # SLAPRF02 config patcher for XIAO ESP32-C5 images and firmware constants
│   ├── ingest/          # 50 Hz multi-gate physics/RF simulator & Hub USB frame decoder (hub_frames.go)
│   ├── laprf/           # ImmersionRC LapRF 8-Way binary protocol client & emulator (TCP :5403)
│   ├── multigp/         # MultiGP WebService API client and race sync
│   ├── portable/        # Native Go server host, WebSocket stream hub, and hardware coordinator
│   ├── race/            # Tournament bracket generator and stage/heat resolver
│   ├── rotorhazard/     # RotorHazard USB serial & LAN HTTP/Socket.IO client
│   ├── storage/         # Persistent transactional bbolt store (slaprf.db)
│   ├── tracker/         # Multi-gate timing engine, 5-stage crossing guardrails, section split math, demo showcase
│   └── usb/             # Native USB serial discovery, console transport, and ESP32-C5 ROM flasher
├── web/
│   ├── embed.go         # Embeds index.html, styles/, src/, and firmware/
│   ├── index.html       # SPA entry HTML & boot loader
│   ├── styles/          # Modular CSS (tokens.css, base.css, layout.css, components.css, views.css)
│   ├── firmware/        # slaprf-xiao-c5.bin compiled firmware image
│   └── src/             # TypeScript SPA source
│       ├── core/        # Hash router, WakeLock, custom select & table scroll helpers
│       ├── layout/      # AppShell, Sidebar, TopBar
│       ├── services/    # ApiClient, BackendHttpTransport, WasmSimTransport, TimerConsole, EnginePersistence, Announcer
│       ├── state/       # Reactive AppStore
│       ├── types/       # TypeScript interfaces matching internal/domain JSON payloads
│       ├── views/       # Races, Practice (LiveView), Analytics (PilotView), Track, Pilots, Network, Flasher, Debug, Simulator, Setup, About
│       └── widgets/     # Oscilloscope chart, lap/section charts, track editor, bracket/format diagrams, data source & persistence controls
├── e2e/                 # Playwright end-to-end verification suite (API, UI components, multi-stage workflows)
├── firmware/            # XIAO ESP32-C5 ESP-IDF firmware (slaprf/ + components/slaprf_radio/)
├── scripts/             # Helper scripts (.ps1 for Windows PowerShell, .sh for macOS/Linux)
└── docs/
    ├── ARCHITECTURE.md  # Client-server runtime, RF link, binary protocols, DSP, and state machine reference
    └── DEVELOPER.md     # This setup and workflow guide
```

---

## 3. Quick-Start Scripts

Helper scripts are included in [`scripts/`](../scripts) for **Windows (PowerShell)** and **macOS / Linux (Bash)**:

| Task | Windows (PowerShell) | macOS / Linux (Bash) | What It Does |
| :--- | :--- | :--- | :--- |
| **Start Dev Server** | `.\scripts\dev.ps1` | `./scripts/dev.sh` | Runs `go run ./cmd/devserver` on `http://localhost:8090`. |
| **Full Build** | `.\scripts\build.ps1` | `./scripts/build.sh` | Builds the static demo site (`./_site`) and updates `./web/wasm/slaprf.wasm`. |
| **Run Unit Tests** | `.\scripts\test.ps1` | `./scripts/test.sh` | Runs the Go and TypeScript unit tests (`go test -v -ldflags="-s -w" ./...`). |
| **Run E2E Verification Suite** | `.\scripts\test-e2e.ps1` | `./scripts/test-e2e.sh` | Runs the full Playwright E2E suite with video, trace, and screenshot capture (`test-results/latest.html`). |

---

## 4. Day-to-Day Development Workflows

### Workflow A: Running the Standalone Native Server (`cmd/slaprf`)

Build and run the production server binary locally:

```powershell
go run -ldflags="-s -w" ./cmd/build-portable
.\slaprf.exe -addr 127.0.0.1:8090 -no-browser
```

To test the static browser-demo mode locally (matching `https://slaprf.app` with IndexedDB and `slaprf.wasm`):

```powershell
.\slaprf.exe -browser -addr 127.0.0.1:8091 -no-browser
```

### Workflow B: Fast UI & WASM Iteration (`cmd/devserver`)

For rapid frontend editing, [`cmd/devserver`](../cmd/devserver/main.go) serves `web/` with `Cache-Control: no-store` and rebuilds generated assets on the fly:

| URL | Built From |
| :--- | :--- |
| `/dist/app.js` | `web/src/main.ts` bundled by pure-Go `esbuild` on each request |
| `/wasm/slaprf.wasm` | `./cmd/slaprf-wasm` (`GOOS=js GOARCH=wasm`), rebuilt when Go sources change |
| `/wasm/wasm_exec.js` | Local Go toolchain (`GOROOT`) |

```bash
go run -ldflags="-s -w" ./cmd/devserver
```

Edit any file under `web/src/`, `web/styles/`, `internal/`, or `cmd/`, then refresh the browser.

---

## 5. Static Site Build (`https://slaprf.app`) & Portable Binary

[`cmd/build-web`](../cmd/build-web/main.go) builds the complete static browser demo into `./_site` (`index.html`, `styles/`, `dist/app.js`, `wasm/slaprf.wasm`, `wasm/wasm_exec.js`, `firmware/slaprf-xiao-c5.bin`). [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) deploys `./_site` to `github-page` on pushes to `main`.

```bash
go run -ldflags="-s -w" ./cmd/build-web -web ./web -out ./_site
```

[`cmd/build-portable`](../cmd/build-portable/main.go) builds the embedded site into `cmd/slaprf/site` and compiles the standalone `slaprf` executable.

---

## 6. Running the Test Suite

Run all Go and TypeScript unit tests:

```bash
go test -count=1 -ldflags="-s -w" ./internal/... ./web/...
```

Run the Playwright E2E suite:

```bash
go test -v -count=1 -tags=e2e -timeout=35m ./e2e/...
```

Run a single E2E test:

```bash
go test -v -count=1 -tags=e2e -run TestClientServer_StandaloneDemoModeAndCrossOriginBackendConnect ./e2e/...
```

---

## 7. Hardware Firmware Development (`XIAO ESP32-C5`)

Hub and Spoke timers run the **same firmware image** built from [`firmware/slaprf/`](../firmware/slaprf/) (see [`firmware/README.md`](../firmware/README.md)): 100 Hz 8-channel 5.8 GHz sweeps, 4-sweep sliding windows sent every 2 sweeps (44-byte window frame at 50 Hz), and 6 Mbps OFDM ESP-NOW at `+20 dBm`.

- [`main/main.c`](../firmware/slaprf/main/main.c) defines the tuning (`SWEEP_HZ`, `WINDOW_SAMPLES`, `TX_EVERY_SWEEPS`), the TDMA schedule, and Hub/Spoke logic.
- [`firmware/components/slaprf_radio/`](../firmware/components/slaprf_radio/) implements the 2.4 GHz link, Hub USB bridge, sync beacon, USB serial console, and 5.8 GHz RSSI sensing.
- [`internal/firmware/firmware.go`](../internal/firmware/firmware.go) mirrors firmware constants in Go. `go test -ldflags="-s -w" ./internal/firmware/` verifies that `main.c` matches Go constants.

### Binary Patching (`SLAPRF02`)

`main.c` embeds a 160-byte `slaprf_flash_config_t` struct starting with magic `SLAPRF02` (see [`docs/ARCHITECTURE.md` §5.2](ARCHITECTURE.md)). When flashing or downloading a `.bin`, `internal/firmware.PatchImage` (or `web/src/services/esp_flasher.ts`) stamps the role, 32-bit board fingerprint, 8 pilot frequencies, and timer label, then recalculates the XOR checksum and SHA-256 digest.

### Building the Firmware with ESP-IDF (Optional)

CI builds the firmware automatically. To build locally on Windows after installing ESP-IDF v5.5.1 into `C:\esp`:

```powershell
firmware\tools\build_local.ps1                   # build only
firmware\tools\build_local.ps1 -FlashPort COM3   # build and reflash a board, keeping its SLAPRF02 config
```

On Linux or macOS with ESP-IDF v5.5.1 exported:

```bash
cd firmware/slaprf
idf.py set-target esp32c5
idf.py build
cd build
python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args
```

---

## 8. Common Gotchas & Tips

1. **Pass `-ldflags="-s -w"` on Windows**:
   Stripping DWARF symbols avoids slow Windows Defender scans on newly compiled test and build binaries.
2. **Stop running `slaprf.exe` before rebuilding**:
   On Windows, an active `slaprf.exe` process locks the executable file on disk. Stop it before running `go run ./cmd/build-portable`.
3. **Browser Cache Busting (`web/index.html`)**:
   Bump the `?v=...` query string on stylesheet and script tags in [`web/index.html`](../web/index.html) when shipping frontend changes so returning browsers pick up updates immediately.
