<div align="center">
  <a href="https://slaprf.app#gh-dark-mode-only">
    <img src="docs-site/static/images/logo-dark.svg#gh-dark-mode-only" width="64" height="64" alt="SlapRF Logo" />
  </a>
  <a href="https://slaprf.app#gh-light-mode-only">
    <img src="docs-site/static/images/logo-light.svg#gh-light-mode-only" width="64" height="64" alt="SlapRF Logo" />
  </a>

  <h1>SlapRF</h1>

  <p>
    <strong>Open-source lap timing, section splits, and race control for 5.8 GHz FPV drones.</strong><br />
    Slap together ~$25 wireless field timers with a <a href="https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-p-6609.html">Seeed XIAO ESP32-C5</a>, zero soldering, and no custom PCBs.
  </p>

  <p>
    <a href="https://github.com/kaack/SlapRF/releases/latest"><img src="https://img.shields.io/github/v/release/kaack/SlapRF?label=release&amp;color=2ea44f" alt="Latest Release" /></a>
    <a href="https://github.com/kaack/SlapRF/actions/workflows/release.yml"><img src="https://github.com/kaack/SlapRF/actions/workflows/release.yml/badge.svg" alt="Release CI" /></a>
    <a href="https://github.com/kaack/SlapRF/actions/workflows/firmware.yml"><img src="https://github.com/kaack/SlapRF/actions/workflows/firmware.yml/badge.svg" alt="Firmware CI" /></a>
    <a href="https://slaprf.app/docs/"><img src="https://img.shields.io/badge/docs-slaprf.app%2Fdocs-2563eb" alt="Documentation" /></a>
    <a href="https://discord.gg/zNrV3auRss"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&amp;logoColor=white" alt="Discord" /></a>
  </p>

  <p>
    <a href="https://slaprf.app"><strong>Browser Demo</strong></a> ·
    <a href="https://github.com/kaack/SlapRF/releases/latest"><strong>Downloads</strong></a> ·
    <a href="https://slaprf.app/docs/"><strong>Documentation</strong></a> ·
    <a href="https://slaprf.app/docs/hardware/flashing/"><strong>Firmware Flasher</strong></a> ·
    <a href="https://slaprf.app/docs/reference/api-reference/"><strong>API Reference</strong></a> ·
    <a href="https://discord.gg/zNrV3auRss"><strong>Discord</strong></a>
  </p>
</div>

<div align="center">
  <a href="docs/slaprf-practice-2x-dark.png?raw=1#gh-dark-mode-only">
    <img src="docs/slaprf-practice-2x-dark.png#gh-dark-mode-only" alt="SlapRF Practice and Section Splits" />
  </a>
  <a href="docs/slaprf-practice-2x-light.png?raw=1#gh-light-mode-only">
    <img src="docs/slaprf-practice-2x-light.png#gh-light-mode-only" alt="SlapRF Practice and Section Splits" />
  </a>
</div>

---

## Overview

SlapRF has two parts. You can use them together or separately:

1. **SlapRF App**: Timing and race control software for Android, Windows, macOS, and Linux. It runs as a single file and needs no external runtime or database. Connect it to SlapRF DIY timers, RotorHazard timers, or ImmersionRC LapRF 8-Way timers.
2. **SlapRF DIY Timers (~$25 per field timer)**: Wireless `5.8 GHz` timers built on the Seeed Studio XIAO ESP32-C5 with no soldering. Place one Hub (`H1`) at the Start/Finish gate to time laps. Add up to 6 battery-powered Spokes (`T1`-`T6`) on the track to record `S1`, `S2`, and `S3` section splits over `2.4 GHz` ESP-NOW.

## Quick Start

| Task | Steps |
| :--- | :--- |
| **Try the browser demo** | Open **[slaprf.app](https://slaprf.app)** to test the track simulator, practice splits, and race brackets (demo only; install the app to time live flights). |
| **Build a ~$25 field timer** | Attach the included antenna to a Seeed XIAO ESP32-C5. Connect the board over USB-C and flash Hub or Spoke firmware from the **[Web Firmware Flasher](https://slaprf.app/docs/hardware/flashing/)**. |
| **Connect RotorHazard or LapRF** | Download the app from **[GitHub Releases](https://github.com/kaack/SlapRF/releases/latest)**. Open **Network**, select RotorHazard or LapRF 8-Way (`Network` or `USB`), and connect. |

---

## Practice and Race Control

| Tournament Brackets | Race Control |
| :---: | :---: |
| <a href="docs/slaprf-bracket-2x-dark.png?raw=1#gh-dark-mode-only"><img src="docs/slaprf-bracket-2x-dark.png#gh-dark-mode-only" alt="Tournament Bracket Canvas" /></a><a href="docs/slaprf-bracket-2x-light.png?raw=1#gh-light-mode-only"><img src="docs/slaprf-bracket-2x-light.png#gh-light-mode-only" alt="Tournament Bracket Canvas" /></a> | <a href="docs/slaprf-cockpit-2x-dark.png?raw=1#gh-dark-mode-only"><img src="docs/slaprf-cockpit-2x-dark.png#gh-dark-mode-only" alt="Race Control Cockpit" /></a><a href="docs/slaprf-cockpit-2x-light.png?raw=1#gh-light-mode-only"><img src="docs/slaprf-cockpit-2x-light.png#gh-light-mode-only" alt="Race Control Cockpit" /></a> |
| Build qualifying, redemption, and finals stages on the bracket graph. | Run start horns, record holeshots and laps, and monitor 50 Hz RSSI. |

- **Practice and Section Splits**: Configure an independent track layout and timing rules per session, and record best laps, 3-lap and 5-lap averages, consistency spread, and `S1`/`S2`/`S3` section deltas with voice callouts.
- **AI and DSP Crossing Detection**: Fly out of the box with the pre-trained `SlapRF Base` neural crossing detector, train or fine-tune custom models on your own `.rfbin` practice sessions, or switch to traditional `Enter` and `Exit` dBm threshold detection.
- **Tournament Formats**: Run Controlled Qualifying, Double-Elimination brackets, Chase-the-Ace finals, and Open Qualifier (ZippyQ) queues, each with its own race track and timing rules.
- **Waveform Review**: Inspect recorded `5.8 GHz` RSSI pass curves after a heat. Add missed crossings, remove false triggers, or apply time penalties.
- **MultiGP RaceSync**: Import chapters, pilot rosters, and schedules from MultiGP. Send heat results and event standings back to MultiGP.
- **External Software and APIs**: Stream crossings over the LapRF 8-Way TCP (`:5403`) server, the **[REST API (OpenAPI 3.1)](https://slaprf.app/docs/reference/api-reference/rest/)**, and the **[WebSocket Stream API (AsyncAPI 3.0)](https://slaprf.app/docs/reference/api-reference/async/)**.

---

## DIY Timers (Seeed XIAO ESP32-C5)

Each SlapRF timer uses the `2.4 GHz` and `5 GHz` radio on a Seeed Studio XIAO ESP32-C5 to scan `5.8 GHz` Raceband channels. No custom PCB or soldering is required.

| Bluetooth Hub Mode | USB Hub Mode |
| :---: | :---: |
| <a href="docs-site/static/images/slaprf-setup-ble-dark.jpg?raw=1#gh-dark-mode-only"><img src="docs-site/static/images/slaprf-setup-ble-dark.jpg#gh-dark-mode-only" alt="SlapRF Bluetooth Mode Setup" /></a><a href="docs-site/static/images/slaprf-setup-ble.jpg?raw=1#gh-light-mode-only"><img src="docs-site/static/images/slaprf-setup-ble.jpg#gh-light-mode-only" alt="SlapRF Bluetooth Mode Setup" /></a> | <a href="docs-site/static/images/slaprf-setup-dark.jpg?raw=1#gh-dark-mode-only"><img src="docs-site/static/images/slaprf-setup-dark.jpg#gh-dark-mode-only" alt="SlapRF USB Mode Setup" /></a><a href="docs-site/static/images/slaprf-setup.jpg?raw=1#gh-light-mode-only"><img src="docs-site/static/images/slaprf-setup.jpg#gh-light-mode-only" alt="SlapRF USB Mode Setup" /></a> |
| Power `H1` from a battery at the Start/Finish gate and connect over Bluetooth LE. | Connect `H1` over USB-C at the flight line while wireless Spokes (`T1`-`T6`) stay on the track. |

<div align="center">
  <a href="docs-site/static/images/xiao-c5-board-guide-dark.jpg?raw=1#gh-dark-mode-only">
    <img src="docs-site/static/images/xiao-c5-board-guide-dark.jpg#gh-dark-mode-only" width="760" alt="Seeed Studio XIAO ESP32-C5 Board Guide" />
  </a>
  <a href="docs-site/static/images/xiao-c5-board-guide.jpg?raw=1#gh-light-mode-only">
    <img src="docs-site/static/images/xiao-c5-board-guide.jpg#gh-light-mode-only" width="760" alt="Seeed Studio XIAO ESP32-C5 Board Guide" />
  </a>
</div>

- **[Parts and Assembly](https://slaprf.app/docs/hardware/parts-and-assembly/)**: Bill of materials, antenna installation, 3D-printable cases, and track placement.
- **[Web Firmware Flasher](https://slaprf.app/docs/hardware/flashing/)**: Flash Bluetooth Hub, USB Hub, or Spoke (`T1`-`T6`) firmware from Chrome, Edge, Opera, or the SlapRF app.
- **[Status LED Guide](https://slaprf.app/docs/hardware/status-leds/)**: LED blink patterns for boot, channel scan, Bluetooth connection, and ESP-NOW link state.

---

## Downloads

Download prebuilt releases from **[GitHub Releases](https://github.com/kaack/SlapRF/releases/latest)**. Each build stores data locally in an embedded `bbolt` database and needs no external runtime.

| Platform | Release File | Notes |
| :--- | :--- | :--- |
| **Android** (`ARM64`) | `slaprf-android-arm64.apk` | USB-C serial, Bluetooth LE Hub, voice callouts, and `-lan` Wi-Fi server |
| **Windows** (`x86_64`) | `slaprf-windows-amd64.exe` | Portable executable with USB serial and Bluetooth LE support |
| **macOS** (`Apple Silicon` / `Intel`) | `slaprf-macos-arm64` / `slaprf-macos-amd64` | Single binary for Apple Silicon and Intel Macs |
| **Linux and Raspberry Pi** (`x86_64` / `ARM64`) | `slaprf-linux-amd64` / `slaprf-linux-arm64` | Desktop app or headless LAN server (`./slaprf -lan -addr 0.0.0.0:8090`) |

See **[Installation and LAN Sharing](https://slaprf.app/docs/getting-started/installation/)** for USB and Bluetooth permissions, `-lan` network access, and HTTP Basic Auth.

---

## Documentation

- **Getting Started**: [Overview](https://slaprf.app/docs/) · [Architecture and Modes](https://slaprf.app/docs/getting-started/architecture/) · [Installation and LAN Sharing](https://slaprf.app/docs/getting-started/installation/)
- **Hardware**: [Parts and Assembly](https://slaprf.app/docs/hardware/parts-and-assembly/) · [Web Firmware Flasher](https://slaprf.app/docs/hardware/flashing/) · [Status LED Guide](https://slaprf.app/docs/hardware/status-leds/)
- **Guides**: [Practice](https://slaprf.app/docs/journeys/practice/) · [Multi-Gate Section Splits](https://slaprf.app/docs/journeys/multi-gate-splits/) · [AI Detection and Training](https://slaprf.app/docs/journeys/ai-crossing-detection/) · [Race Events](https://slaprf.app/docs/journeys/race-events/) · [RotorHazard and LapRF 8-Way](https://slaprf.app/docs/journeys/external-timers/)
- **Reference**: [UI Reference](https://slaprf.app/docs/reference/ui-reference/) · [REST API (OpenAPI 3.1)](https://slaprf.app/docs/reference/api-reference/rest/) · [Stream API (AsyncAPI 3.0)](https://slaprf.app/docs/reference/api-reference/async/) · [Troubleshooting](https://slaprf.app/docs/reference/troubleshooting/)

---

## Build from Source

```bash
# Run Go and TypeScript tests
go test ./...

# Build a SlapRF Portable binary for the current OS
go run ./cmd/build-portable

# Build the browser demo and documentation site into ./_site
go run ./cmd/build-web -web ./web -out ./_site
```

See **[docs/DEVELOPER.md](docs/DEVELOPER.md)** and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for ESP-IDF firmware builds, Android APK builds, and system architecture.

### Related ESP32-C5 5.8 GHz Projects

- **[FPVGate (`LouisHitchcock/FPVGateC5MK`)](https://github.com/LouisHitchcock/FPVGateC5MK)**: ESP32-C5 `5.8 GHz` FPV lap timing firmware and radio reference.
- **[Widscan58 (`CapnBry/widscan58`)](https://github.com/CapnBry/widscan58)**: Wideband `5.8 GHz` FPV spectrum scanner on the ESP32-C5.
- **[C5VRX (`Twotoz/C5VRX`)](https://github.com/Twotoz/C5VRX)**: Experimental `5.8 GHz` analog FPV video receiver on the ESP32-C5.
- **[ESP-SDR (`ESPARGOS/esp-sdr`)](https://github.com/ESPARGOS/esp-sdr)**: Raw I/Q capture on the ESP32-C5 radio ADC test path.
