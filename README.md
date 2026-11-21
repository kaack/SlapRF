# SlapRF

[![SlapRF](docs/slaprf-hero.png)](https://slaprf.app)

SlapRF is an open-source 5.8 GHz FPV drone timing and race management project consisting of two parts that work together or independently:

1. **SlapRF Timing Application**: Native timing and race control software for Android, Windows, macOS, and Linux. Pair it with DIY SlapRF gate timers (recommended) or run it with existing RotorHazard or ImmersionRC LapRF 8-Way hardware.
2. **SlapRF Gate Hardware**: Zero-solder DIY 5.8 GHz gate timers built on the Seeed Studio XIAO ESP32-C5 (`H1` Hub + up to 6 wireless `T1`-`T6` Spokes) supporting both full-lap timing and multi-gate section splits (`S1`, `S2`, `S3`).

<p align="center">
  <a href="https://slaprf.app/docs/"><img src="https://img.shields.io/badge/Docs-slaprf.app%2Fdocs-2563eb" alt="Documentation" /></a>
  <a href="https://github.com/kaack/SlapRF/actions/workflows/release.yml"><img src="https://github.com/kaack/SlapRF/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="https://github.com/kaack/SlapRF/actions/workflows/pages.yml"><img src="https://github.com/kaack/SlapRF/actions/workflows/pages.yml/badge.svg" alt="Build &amp; Deploy GitHub Page" /></a>
  <a href="https://github.com/kaack/SlapRF/actions/workflows/firmware.yml"><img src="https://github.com/kaack/SlapRF/actions/workflows/firmware.yml/badge.svg" alt="Build XIAO ESP32-C5 Firmware" /></a>
  <a href="https://github.com/kaack/SlapRF/releases/latest"><img src="https://img.shields.io/github/v/release/kaack/SlapRF?label=release&amp;color=2ea44f" alt="Latest Release" /></a>
  <a href="https://discord.gg/zNrV3auRss"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&amp;logoColor=white" alt="Discord" /></a>
</p>

## Documentation & Live Demo

- **[Read the Documentation (`slaprf.app/docs`)](https://slaprf.app/docs/)**: Complete setup guides, hardware assembly, interactive status LED simulator, and built-in WebSerial firmware flasher.
- **[Open the Browser Demo (`slaprf.app`)](https://slaprf.app)**: Explore the interface in your browser with simulated gates, practice sessions, and race brackets (demo only; install a native release below to time live flights).
- **[Join the Discord Community (`discord.gg/zNrV3auRss`)](https://discord.gg/zNrV3auRss)**: Share gate builds, ask setup or calibration questions, and follow release updates.

## Architecture & Operating Modes

A SlapRF course uses one Hub timer (`H1`) and up to 6 wireless Spoke timers (`T1`-`T6`) communicating over 2.4 GHz ESP-NOW. You can run the Hub wirelessly at the gate over Bluetooth LE or wired to your phone/laptop over USB-C.

- **[Architecture & Modes ->](https://slaprf.app/docs/getting-started/architecture/)**: Compare Bluetooth Hub Mode vs. USB Hub Mode and see how gate timers stream 5.8 GHz RSSI sweeps to the app.

## Installation & Downloads

Download the latest self-contained build for Android (`ARM64`), Windows (`x86_64`), macOS (`Apple Silicon` / `Intel`), or Linux / Raspberry Pi (`x86_64` / `ARM64`) from **[GitHub Releases](https://github.com/kaack/SlapRF/releases/latest)**.

- **[Installation & Wi-Fi LAN Sharing ->](https://slaprf.app/docs/getting-started/installation/)**: Platform setup commands, Linux serial permissions, `-lan` multi-device hosting, and CLI flags.

## SlapRF Gate Hardware (DIY XIAO ESP32-C5)

Assemble battery-powered 5.8 GHz gate timers from off-the-shelf components with zero soldering or custom PCBs, and flash boards straight from the SlapRF app (Android or desktop) or from Chrome, Edge, or Opera over USB-C.

- **[Parts, Assembly & 3D-Printed Cases ->](https://slaprf.app/docs/hardware/parts-and-assembly/)**: Bill of materials, board pinout callouts, recommended MakerWorld enclosures, and gate placement.
- **[Browser Firmware Flasher ->](https://slaprf.app/docs/hardware/flashing/)**: Flash Bluetooth Hub, USB Hub, and Spoke (`T1`-`T6`) firmware directly from the docs page.
- **[Status LED Blink Patterns ->](https://slaprf.app/docs/hardware/status-leds/)**: Live LED blink animations and millisecond timing charts for every board state.

## User Guides & Hardware Compatibility

- **[Solo & Club Practice ->](https://slaprf.app/docs/journeys/practice/)**: Connect your Hub, add pilots, auto-calibrate thresholds in one tap, and configure spoken lap callouts.
- **[Multi-Gate Section Splits ->](https://slaprf.app/docs/journeys/multi-gate-splits/)**: Place wireless Spoke timers around the course to measure `S1`, `S2`, and `S3` section splits and consistency.
- **[Running a Race Event ->](https://slaprf.app/docs/journeys/race-events/)**: Stage brackets, automated horns, Marshal Review recorded RSSI waveforms, and MultiGP Chapter sync.
- **[RotorHazard & ImmersionRC LapRF 8-Way ->](https://slaprf.app/docs/journeys/external-timers/)**: Connect the SlapRF app to existing RotorHazard servers/nodes or LapRF 8-Way Ethernet pucks.
- **[App & UI Reference ->](https://slaprf.app/docs/reference/ui-reference/)** · **[API Reference (OpenAPI & AsyncAPI) ->](https://slaprf.app/docs/reference/api-reference/)** · **[Troubleshooting ->](https://slaprf.app/docs/reference/troubleshooting/)**

## Developer Docs & Related Projects

For building from source (`go run ./cmd/build-portable`, `go run ./cmd/build-android`, `go run ./cmd/build-docs`), architecture internals, and testing, see [docs/DEVELOPER.md](docs/DEVELOPER.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Related open-source ESP32-C5 5.8 GHz projects:
- **[C5VRX (`Twotoz/C5VRX`)](https://github.com/Twotoz/C5VRX)**: Experimental 5.8 GHz analog FPV video receiver on the ESP32-C5.
- **[ESP-SDR (`ESPARGOS/esp-sdr`)](https://github.com/ESPARGOS/esp-sdr)**: Raw I/Q SDR capture using the ESP32-C5 internal radio ADC test path.
- **[FPVGate (`LouisHitchcock/FPVGateC5MK`)](https://github.com/LouisHitchcock/FPVGateC5MK)**: ESP32-C5 5.8 GHz FPV lap timing firmware and radio internals reference.
- **[Widscan58 (`CapnBry/widscan58`)](https://github.com/CapnBry/widscan58)**: Wideband 5.8 GHz FPV spectrum scanner on the ESP32-C5.
