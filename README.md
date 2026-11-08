# SlapRF

Multi-gate FPV drone racing sector timer & practice analytics companion for **MultiGP LiveTime**, powered by **Seeed Studio XIAO ESP32-C5** timers (`Hub` + `Spoke` over ESP-NOW / Wi-Fi) and a single-binary **Go + TypeScript** server.

## Architecture

- **Hardware Timers (`firmware/xiao_c5_timer`)**:
  - **Hub Timer**: Connects to your laptop's Wi-Fi / hotspot and relays RSSI frames from itself and all Spoke timers over UDP (`:9001`).
  - **Spoke Timers**: Stream RSSI samples to the Hub over low-latency ESP-NOW (no Wi-Fi configuration required).
- **Go Backend (`cmd/fpvtimer`, `internal/`)**:
  - Multi-gate signal processor (`internal/tracker`) with dynamic per-timer noise-floor tracking, parabolic peak interpolation, hysteresis, and flying-loop sector timing (`S1`..`SN`).
  - **ImmersionRC LapRF 8-Way TCP Emulation (`:5403`)**: Exposes the designated **Start gate** to MultiGP LiveTime so LiveTime records official laps while SlapRF tracks full per-section splits (`S1`, `S2`, `S3`, `S4`).
  - **Zero-Node Frontend Bundler (`internal/api`)**: Compiles `web/src/main.ts` in-memory using `esbuild` and serves the web UI on `http://localhost:8090`.
  - **WebSerial USB Timer Flasher (`internal/firmware`)**: Stitches and patches custom firmware images in memory so users can read and flash Hub/Spoke timers directly from Chrome/Edge over USB.

## Quick Start

```powershell
go build -o fpvtimer.exe ./cmd/fpvtimer
.\fpvtimer.exe
```

Then open `http://localhost:8090` in Chrome or Edge.
