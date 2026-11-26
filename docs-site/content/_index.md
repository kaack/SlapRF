---
title: SlapRF Documentation
linkTitle: Overview
type: docs
cascade:
  type: docs
---

SlapRF is an open-source 5.8 GHz FPV drone timing and race management system built for solo practice, club sessions, and organized race events.

SlapRF consists of two parts that you can use together or separately:

| Component | Summary |
| :--- | :--- |
| SlapRF App | Native timing and race control app for Android, Windows, macOS, and Linux. |
| SlapRF Hardware | DIY 5.8 GHz gate timers built from Seeed Studio XIAO ESP32-C5 boards with zero soldering or custom PCBs. |

> [!IMPORTANT]
> The SlapRF Timing Application and SlapRF Gate Hardware are tuned to work together, especially for wireless multi-gate section split timing. Support for RotorHazard and ImmersionRC LapRF 8-Way is included for pilots and clubs who already own those systems.

## Documentation Guides

{{< cards >}}
  {{< card link="getting-started/installation" title="Install the App" icon="download" subtitle="Download and run SlapRF on Android, Windows, macOS, or Linux." >}}
  {{< card link="hardware/parts-and-assembly" title="Build SlapRF Hardware" icon="chip" subtitle="Assemble battery-powered XIAO ESP32-C5 gate timers with zero soldering." >}}
  {{< card link="hardware/flashing" title="Flash Firmware" icon="lightning-bolt" subtitle="Flash Bluetooth Hub, USB Hub, and Spoke boards directly from your browser." >}}
  {{< card link="hardware/status-leds" title="Status LED Patterns" icon="sparkles" subtitle="View live blinking animations and timing strips for every XIAO LED pattern." >}}
  {{< card link="journeys/practice" title="Solo & Club Practice" icon="play" subtitle="Connect your timer and fly immediately with SlapRF Base AI or calibrated DSP thresholds." >}}
  {{< card link="journeys/multi-gate-splits" title="Multi-Gate Splits" icon="chart-bar" subtitle="Place Spoke timers around the course to measure S1, S2, and S3 section splits." >}}
  {{< card link="journeys/ai-crossing-detection" title="AI Detection & Training" icon="sparkles" subtitle="Fly out of the box with SlapRF Base, fine-tune custom models, or use DSP thresholds." >}}
  {{< card link="journeys/race-events" title="Run a Race Event" icon="flag" subtitle="Manage brackets, heats, horns, Marshal Review waveforms, and MultiGP sync." >}}
  {{< card link="journeys/external-timers" title="RotorHazard & LapRF" icon="server" subtitle="Connect the SlapRF software to existing RotorHazard or LapRF 8-Way timers." >}}
  {{< card link="reference/troubleshooting" title="Troubleshooting" icon="support" subtitle="Fix USB flashing, Bluetooth pairing, calibration, and power issues." >}}
{{< /cards >}}

## Supported Hardware

| Timing System | Bluetooth | USB | LAN | Notes |
| :--- | :---: | :---: | :---: | :--- |
| SlapRF Hardware | {{< yes >}} | {{< yes >}} | {{< no >}} | Recommended. Seeed Studio XIAO ESP32-C5 Bluetooth or USB-C Hub with up to 6 wireless gates, section splits, and browser flasher. |
| RotorHazard | {{< no >}} | {{< yes >}} | {{< yes >}} | Connects to RotorHazard servers over Wi-Fi / Ethernet (`HTTP` / `Socket.IO` `:5000`) or standalone RotorHazard USB serial nodes (`115200` / `921600` baud). |
| LapRF 8-Way | {{< no >}} | {{< yes >}} | {{< yes >}} | Connects to ImmersionRC LapRF 8-Way pucks over Ethernet LAN (`TCP :5403`) or USB CDC serial (`115200` baud). |
