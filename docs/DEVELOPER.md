# SlapRF Developer Guide

This guide explains how to set up your local development environment, understand the repository layout, run the local server, build desktop binaries, Android APKs, and static demo bundles, and run the test suite.

For architecture, RF link schedules, binary wire protocols, DSP, and timing rules, see **[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)**.

---

## Table of Contents

1. [Prerequisites & Environment Setup](#1-prerequisites--environment-setup)
2. [Repository Layout](#2-repository-layout)
3. [Quick-Start Scripts](#3-quick-start-scripts)
4. [Day-to-Day Development Workflows](#4-day-to-day-development-workflows)
5. [Building Portable Desktop Binaries, Android APK & Static Demo Site](#5-building-portable-desktop-binaries-android-apk--static-demo-site)
6. [Running the Test Suite](#6-running-the-test-suite)
7. [Hardware Firmware Development (`XIAO ESP32-C5` & `ESP32-P4`)](#7-hardware-firmware-development-xiao-esp32-c5--esp32-p4)
8. [Common Tips](#8-common-tips)

---

## 1. Prerequisites & Environment Setup

SlapRF uses a **single-toolchain Go build** with no Node.js install needed:

- **Required**: **[Go 1.25+](https://go.dev/dl/)**
  - `cmd/build-web`, `cmd/build-docs`, `cmd/build-portable`, `cmd/build-android`, and `cmd/devserver` use the Go [`esbuild`](https://github.com/evanw/esbuild) library (`internal/devbundle`) to bundle `web/src/**/*.ts` into `dist/app.js`.
  - You do not need `node`, `npm`, `pnpm`, `webpack`, or `vite` to edit TypeScript, CSS, or Go code.
- **Optional (Android APK Only)**: **JDK 17** and **Android SDK Platform 35 / Build-Tools 35.0.0 / NDK r27** (used by `cmd/build-android` without Gradle).
- **Optional (Firmware C Source Only)**: **Espressif ESP-IDF v5.5.1+** (`esp32c5` for XIAO gate timers; `esp32p4` with ESP-IDF `v5.5.6` in CI for ESP32-P4 rev v3.2 PoE Bridges). Only needed when editing `firmware/` C code locally. CI (`.github/workflows/firmware.yml`) compiles `slaprf-xiao-c5.bin`, `slaprf-xiao-c5-ble.bin`, and `slaprf-p4-poe-bridge.bin`. Per-timer settings (role, timer label, fingerprint, 5.8 GHz channels) are patched into the `SLAPRF02` config block at flash time.

### Verify Your Environment

```bash
go version
# Expected: go version go1.25.x ...
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
├── android/             # Thin Android Java host, USB OTG & Bluetooth LE GATT shims, manifest, resources
├── ios/                 # Native iOS/iPadOS Swift host (WKWebView, CoreBluetooth GATT shim, AVAudioEngine, Xcode project)
├── cmd/
│   ├── slaprf/          # Standalone desktop/Pi server binary (embeds UI, firmware, bbolt DB, USB/BLE/LAN I/O)
│   ├── slaprf-android/  # Android JNI shared library entry point (libslaprf.so loopback server)
│   ├── slaprf-ios/      # iOS/iPadOS C-archive entry point (libslaprf.a loopback server, DisableUSB=true)
│   ├── build-portable/  # Builds cmd/slaprf/site and compiles the standalone slaprf executable
│   ├── build-android/   # Builds cmd/slaprf-android/site, libslaprf.so, Java shims, and signed APK
│   ├── build-ios/       # Builds cmd/slaprf-ios/site, libslaprf.a, Swift host, and sideloadable .ipa / Simulator .app
│   ├── build-web/       # Static site & WASM demo builder (outputs ./_site)
│   ├── build-docs/      # Hugo documentation & standalone WebSerial flasher builder
│   ├── slaprf-wasm/     # Go -> WebAssembly entry point for the slaprf.app browser demo
│   └── devserver/       # Dev server (:8090) that rebuilds TS and WASM on the fly
├── internal/
│   ├── api/             # /v1/* HTTP REST and WebSocket handlers
│   ├── devbundle/       # Asset builder: esbuild TS bundle, wasm_exec.js, slaprf.wasm
│   ├── domain/          # Shared data models (pilots, gates, telemetry frames, timing rules, race brackets)
│   ├── dsp/             # 8-channel 5.8 GHz EMA filter, hysteresis detector, parabolic peak fitter
│   ├── firmware/        # SLAPRF02 config patcher for XIAO ESP32-C5 images and firmware constants
│   ├── ingest/          # Multi-gate RF simulator & Hub frame decoder (hub_frames.go)
│   ├── laprf/           # ImmersionRC LapRF 8-Way LAN TCP (:5403), USB serial (laprf/usb), & emulator
│   ├── multigp/         # MultiGP WebService API client and race sync
│   ├── portable/        # Native Go server host, WebSocket stream hub, and hardware coordinator
│   ├── race/            # Tournament bracket generator and stage/heat resolver
│   ├── rotorhazard/     # RotorHazard LAN HTTP/Socket.IO & USB serial (rotorhazard/usb) clients
│   ├── serialport/      # Shared cross-platform USB serial discovery and port transport
│   ├── slaprf/          # SlapRF USB (slaprf/usb), BLE Hub (slaprf/bluetooth), & PoE Bridge (slaprf/network) drivers
│   ├── storage/         # Persistent transactional bbolt store (slaprf.db)
│   └── tracker/         # Multi-gate timing engine, 3-tier crossing rules, section split math, demo showcase
├── web/
│   ├── embed.go         # Embeds index.html, styles/, src/, and firmware/
│   ├── index.html       # SPA entry HTML & boot loader
│   ├── styles/          # Modular CSS (tokens.css, base.css, layout.css, components.css, views.css)
│   ├── firmware/        # slaprf-xiao-c5.bin, slaprf-xiao-c5-ble.bin, & slaprf-p4-poe-bridge.bin
│   └── src/             # TypeScript SPA source
├── e2e/                 # Playwright end-to-end verification suite (API, UI components, workflows)
├── firmware/            # ESP-IDF firmware (slaprf/, slaprf_ble/, slaprf_p4_poe_bridge/, components/, tools/)
├── scripts/             # Helper scripts (.ps1 for Windows PowerShell, .sh for macOS/Linux)
└── docs/
    ├── ARCHITECTURE.md         # Architecture, transport comparison, RF link, DSP, and timing rules
    ├── ble-hub-protocol.md     # Low-level GATT protocol for the Bluetooth Hub image
    ├── poe-bridge-protocol.md  # TCP/UDP :5480 protocol & hardware reference for the ESP32-P4 PoE Bridge
    └── DEVELOPER.md            # This setup and workflow guide
```

---

## 3. Quick-Start Scripts

Helper scripts are included in [`scripts/`](../scripts) for **Windows (PowerShell)** and **macOS / Linux (Bash)**:

| Task | Windows (PowerShell) | macOS / Linux (Bash) | What It Does |
| :--- | :--- | :--- | :--- |
| **Start Dev Server** | `.\scripts\dev.ps1` | `./scripts/dev.sh` | Runs `go run ./cmd/devserver` on `http://localhost:8090`. |
| **Full Build** | `.\scripts\build.ps1` | `./scripts/build.sh` | Builds the static demo site (`./_site`) and updates `./web/wasm/slaprf.wasm`. |
| **Run Unit Tests** | `.\scripts\test.ps1` | `./scripts/test.sh` | Runs the Go and TypeScript unit tests (`go test -v -ldflags="-s -w" ./...`). |
| **Run E2E Suite** | `.\scripts\test-e2e.ps1` | `./scripts/test-e2e.sh` | Runs the Playwright E2E suite with video, trace, and screenshot capture (`test-results/latest.html`). |

---

## 4. Day-to-Day Development Workflows

### Workflow A: Running the Standalone Native Server (`cmd/slaprf`)

Build and run the production server binary locally:

```powershell
go run ./cmd/build-portable -skip-wasm
.\slaprf.exe -addr 127.0.0.1:8090 -no-browser
```

To share with phones or tablets on the local Wi-Fi network:

```powershell
.\slaprf.exe -addr 0.0.0.0:8090 -lan -no-browser
```

### Workflow B: Fast UI & WASM Iteration (`cmd/devserver`)

For frontend editing, [`cmd/devserver`](../cmd/devserver/main.go) serves `web/` with `Cache-Control: no-store` and rebuilds generated assets on each request:

```bash
go run -ldflags="-s -w" ./cmd/devserver
```

---

## 5. Building Portable Desktop Binaries, Android APK & Static Demo Site

- **Static Browser Demo (`https://slaprf.app`)**:
  ```bash
  go run ./cmd/build-web -web ./web -out ./_site
  ```
- **Standalone Desktop Binary (`slaprf` / `slaprf.exe`)**:
  ```bash
  go run ./cmd/build-portable -skip-wasm -out ./dist/slaprf
  ```
- **Signed Android APK (`dist/slaprf-android.apk`)**:
  ```bash
  go run ./cmd/build-android -arch arm64
  ```
- **iOS & iPadOS Sideload IPA / Simulator / Free Personal Team Deploy (`macOS` + Xcode)**:
  ```bash
  # Unsigned / ad-hoc signed IPA for Sideloadly, SideStore, and AltStore
  go run ./cmd/build-ios -out dist/slaprf-ios-arm64.ipa

  # Boot iPad/iPhone Simulator and launch with live console logs
  go run ./cmd/build-ios -simulator -run

  # Sign with a free Apple ID Personal Team and deploy to a paired iPad/iPhone
  go run ./cmd/build-ios -device auto -team <10_CHAR_TEAM_ID> -bundle-id app.slaprf.<yourname> -run
  ```

---

## 6. Running the Test Suite

Run all Go and TypeScript unit tests:

```bash
go test -count=1 -ldflags="-s -w" ./...
```

Run the Playwright E2E suite:

```bash
go test -v -count=1 -tags=e2e -timeout=35m ./e2e/...
```

---

## 7. Hardware Firmware Development (`XIAO ESP32-C5` & `ESP32-P4`)

SlapRF builds three ESP-IDF firmware images:

1. **USB Hub & Spoke firmware (`firmware/slaprf/` -> `web/firmware/slaprf-xiao-c5.bin`)**:
   Used by all Spoke timers (`T1` to `T6`) and wired USB or PoE-bridged Hubs (`H1`).
2. **Bluetooth Hub firmware (`firmware/slaprf_ble/` -> `web/firmware/slaprf-xiao-c5-ble.bin`)**:
   Used by wireless Bluetooth Hubs (`H1`).
3. **PoE Ethernet Bridge firmware (`firmware/slaprf_p4_poe_bridge/` -> `web/firmware/slaprf-p4-poe-bridge.bin`)**:
   Used by Waveshare `ESP32-P4-WIFI6-POE-ETH` boards (`TCP/UDP :5480`; see [`docs/poe-bridge-protocol.md`](poe-bridge-protocol.md)).

### Local Firmware Build on Windows (ESP-IDF v5.5.1+ in `C:\esp`)

```powershell
# USB Hub & Spoke image:
firmware\tools\build_local.ps1
firmware\tools\build_local.ps1 -FlashPort COM3

# Bluetooth Hub image:
firmware\tools\build_local_ble.ps1
firmware\tools\build_local_ble.ps1 -FlashPort COM6
```

### Local Firmware Build on Linux or macOS

```bash
# USB Hub & Spoke image:
cd firmware/slaprf
idf.py set-target esp32c5 && idf.py build
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5.bin @flash_args)

# Bluetooth Hub image:
cd ../../slaprf_ble
idf.py set-target esp32c5 && idf.py build
(cd build && python -m esptool --chip esp32c5 merge_bin -o ../../../web/firmware/slaprf-xiao-c5-ble.bin @flash_args)

# ESP32-P4 PoE Ethernet Bridge image (from repo root):
cd ../../..
bash ./firmware/tools/build_local_p4.sh
```

---

## 8. Common Tips

1. **Pass `-ldflags="-s -w"` on Windows**:
   Stripping DWARF debug symbols avoids slow antivirus scans on freshly compiled binaries.
2. **Stop running `slaprf.exe` before rebuilding**:
   Windows locks running `.exe` files on disk. Stop `slaprf.exe` before overwriting it with `cmd/build-portable`.
