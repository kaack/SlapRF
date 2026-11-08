# SlapRF

SlapRF is a multi-gate 5.8 GHz sector timing system for FPV drone racing.

The name **SlapRF** comes from how you build it: you slap four off-the-shelf parts together with no soldering, no custom PCBs, and no wiring harness.

A standard lap timer measures only total lap time at the start gate. SlapRF places additional timers at gates around the track to measure split times for each track section (`S1`, `S2`, `S3`, `S4`). Pilots can compare section times across laps to see where they gained or lost time.

## Intended Use: LiveTime Companion or Standalone Practice

SlapRF does not replace official race timing systems such as **MultiGP LiveTime** or **ImmersionRC LapRF**.

You can use SlapRF in two ways:

1. **Companion to MultiGP LiveTime**: SlapRF emulates an ImmersionRC LapRF 8-way timer over TCP on port `5403`. When you connect LiveTime to `localhost:5403`, SlapRF receives the pilot callsigns and 5.8 GHz frequencies from LiveTime. When a pilot crosses the start gate, SlapRF sends that crossing to LiveTime for official lap scoring and records the intermediate section splits (`S1`, `S2`, `S3`, `S4`) in the SlapRF web interface.
2. **Standalone practice timer**: You can run SlapRF on a laptop at the field with 1 to 6 timers. The web interface provides spoken lap times, live 5.8 GHz RSSI graphs, threshold calibration, and lap comparisons. You can also enable the built-in simulator to test the software without hardware.

## How It Works

A SlapRF setup uses one **Hub timer** and up to 5 **Spoke timers** (up to 6 timers total):

- **Hub timer**: Connects to your laptop over Wi-Fi or a mobile hotspot. It measures 5.8 GHz RSSI at its own gate, broadcasts a 25 Hz timing sync beacon, and receives 4-sample sliding-window telemetry frames from all Spoke timers over **Espressif 2.4 GHz Long Range (`WIFI_PROTOCOL_LR`)**.
- **Spoke timers**: Pure 5.8 GHz recording devices placed at other gates on the track. They perform zero on-board peak detection or lap math—every 20 ms (50 Hz) they record the 8 pilot channels into a 4-sample ring buffer and burst the sliding window (`2×` overlap FEC) to the Hub in staggered 3.5 ms TDMA slots over 2.4 GHz LR (`-102 dBm` sensitivity, `+20 dBm` TX power on Channel 1). Even if 50% of packets are lost to wet grass or 2.4 GHz ELRS interference, 100% of the 50 Hz RSSI stream arrives intact at the laptop.

```mermaid
flowchart LR
    subgraph Track["FPV Track (5.8 GHz VTX Signal)"]
        T2["Gate 2: Spoke Timer (T2)"]
        T3["Gate 3: Spoke Timer (T3)"]
        T4["Gate 4: Spoke Timer (T4)"]
        T1["Start Gate: Hub Timer (T1)"]
    end

    subgraph Laptop["Field Laptop"]
        Server["SlapRF Server (DSP & Timing Engine)"]
        UI["Web UI (:8090) - Section Splits S1-S4"]
        LiveTime["MultiGP LiveTime (:5403 LapRF TCP)"]
    end

    T2 -- "2.4 GHz LR + 4-Sample FEC" --> T1
    T3 -- "2.4 GHz LR + 4-Sample FEC" --> T1
    T4 -- "2.4 GHz LR + 4-Sample FEC" --> T1
    T1 -- "Wi-Fi UDP (:5404)" --> Server
    Server --> UI
    Server -. "Optional Start Gate Passings" .-> LiveTime
```

You flash and configure the timers directly from Chrome, Edge, or Brave over USB-C (even from the static [GitHub Pages app](https://kaack.github.io/SlapRF/) with no backend installed). No compiler, driver installation, or command-line tool is required.

## Low-Level Architecture & Protocol Reference

For a detailed technical breakdown with sequence diagrams, state machines, and byte-level packet layouts, see **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**:

- **[End-to-End Data Flow & Design Principles](docs/ARCHITECTURE.md#1-system-overview--design-principles)** — Why Spokes are pure recording sensors with all DSP centralized on the laptop.
- **[XIAO ESP32-C5 5.8 GHz SDR & Time-Division Schedule](docs/ARCHITECTURE.md#3-xiao-esp32-c5-58-ghz-sdr--time-division-radio-schedule)** — Single-synthesizer 5.8 GHz / 2.4 GHz multiplexing and the 40 ms superframe schedule.
- **[Ground-Interference Mitigation & 2.4 GHz LR Protocol](docs/ARCHITECTURE.md#4-ground-interference-mitigation--24-ghz-lr-protocol)** — Two-ray grass path-loss physics, `+11 dB` DSSS coding gain, 3.5 ms TDMA slots, and 4-sample sliding-window recovery under 50% packet loss.
- **[Binary Wire Formats (`0xC5 0x59` & `SLAPRF01`)](docs/ARCHITECTURE.md#5-binary-wire-formats-0xc5-0x59-sliding-window--slaprf01)** — Byte-by-byte layouts of the 44-byte sliding-window frame and 128-byte flash config block.
- **[DSP Pipeline & Parabolic Peak Interpolation](docs/ARCHITECTURE.md#6-dsp-pipeline--sub-frame-parabolic-peak-interpolation)** — Zero-phase EMA smoothing, hysteresis state machine, and `< 2 ms` sub-frame parabolic vertex fitting.
- **[Multi-Gate Timing Rules & Section Analytics Engine](docs/ARCHITECTURE.md#7-multi-gate-timing-rules--section-analytics-engine)** — The 5-stage guardrail pipeline (cool-down, stale progress, min section, previous-gate echo, min/max lap) and bottleneck math.
- **[Browser-Native WebSerial ROM Flasher & Version Tracking](docs/ARCHITECTURE.md#8-browser-native-webserial-rom-flasher--version-tracking)** — Client-side `.bin` patching, SLIP ROM bootloader protocol, and firmware version detection.
- **[ImmersionRC LapRF 8-Way Emulation & WebAssembly Simulator](docs/ARCHITECTURE.md#9-immersionrc-laprf-8-way-emulation-tcp-5403)** — TCP `:5403` LiveTime bridge and `ApiTransport` dual-mode architecture.

## Parts List and Cost

Each gate timer uses four off-the-shelf parts. One XIAO ESP32-C5 draws less than `100 mA` at `5 V` (`0.5 W`), so a `650 mAh` 3S LiPo battery powers a timer for about 8 hours.

| Part | Purpose | Product Links | Est. Cost (USD) |
| :--- | :--- | :--- | :--- |
| **Seeed Studio XIAO ESP32-C5** (includes external 2.4 / 5 GHz U.FL antenna) | Measures 5.8 GHz VTX signal strength and sends data over ESP-NOW and Wi-Fi. | <ul><li>[Seeed Studio XIAO ESP32-C5](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-p-6609.html)</li></ul> | $6.90 |
| **LIPO to USB-C Adapter** | Converts 3S to 6S LiPo battery power to `5 V` USB-C output. | <ul><li>[SpeedyBee Goggles BEC](https://www.google.com/search?tbm=shop&q=SpeedyBee+Goggles+BEC)</li><li>[AOKoda XT60 to USB Converter](https://www.google.com/search?tbm=shop&q=AOKoda+XT60+to+USB+Converter)</li></ul> | $8.00 – $20.00 |
| **Short USB-C to USB-C cable (straight plugs)** | Connects the LIPO to USB-C Adapter to the XIAO ESP32-C5. Also used to flash firmware from a laptop. | <ul><li>[Adafruit 6" USB-C to USB-C Cable](https://www.adafruit.com/product/4198)</li></ul> | $8.50 |
| **Small 3S LiPo battery (XT60)** | Powers the timer in the field. A minimum of `650 mAh` provides about 8 hours of runtime (or use any retired 3S–6S flight pack). | <ul><li>[Tattu 850mAh 3S XT60 LiPo](https://www.google.com/search?tbm=shop&q=Tattu+850mAh+3S+XT60+LiPo)</li></ul> | $15.00 (or $0 with a spare pack) |

### Estimated Total Cost

- **1 timer**: $23 to $35 (using an existing LiPo battery) or $38 to $50 (with a new 3S LiPo)
- **4-gate track (`1 Hub + 3 Spokes`)**: $92 to $140 total (using existing LiPo batteries)

## Hardware Assembly

No soldering is required.

```mermaid
flowchart LR
    LiPo["3S-6S LiPo Battery"] -- "XT60 Plug" --> Adapter["LIPO to USB-C Adapter (5V Out)"]
    Adapter -- "6-inch USB-C Cable" --> XIAO["Seeed Studio XIAO ESP32-C5"]
    Antenna["Included 2.4 / 5 GHz Antenna"] -- "Snap-on U.FL" --> XIAO
```

1. Attach the included U.FL antenna to the antenna connector on the XIAO ESP32-C5.
2. Connect the XIAO ESP32-C5 to your laptop with a USB-C cable.
3. Open **System > Flasher** in the SlapRF web interface. Flash one timer as **Hub** and the remaining timers as **Spoke**.
4. At the field, connect each XIAO ESP32-C5 to a LIPO to USB-C Adapter and a LiPo battery. Place one timer at each gate.
5. Open **System > Track** and drag each timer (`T1`, `T2`, `T3`, `T4`) onto the track line in the order pilots fly the course. Click the checkered flag icon below a gate to set the start gate.

## Download and Run

Download the latest standalone binary for your operating system from the [Releases page](https://github.com/kaack/SlapRF/releases/latest):

| Operating System | Download |
| :--- | :--- |
| **Windows (x64)** | [`slaprf-windows-amd64.exe`](https://github.com/kaack/SlapRF/releases/latest/download/slaprf-windows-amd64.exe) |
| **macOS (Apple Silicon)** | [`slaprf-macos-arm64`](https://github.com/kaack/SlapRF/releases/latest/download/slaprf-macos-arm64) |
| **macOS (Intel)** | [`slaprf-macos-amd64`](https://github.com/kaack/SlapRF/releases/latest/download/slaprf-macos-amd64) |
| **Linux (x64)** | [`slaprf-linux-amd64`](https://github.com/kaack/SlapRF/releases/latest/download/slaprf-linux-amd64) |
| **Linux (ARM64)** | [`slaprf-linux-arm64`](https://github.com/kaack/SlapRF/releases/latest/download/slaprf-linux-arm64) |

1. **Windows**: Double-click `slaprf-windows-amd64.exe`. It starts the server and opens `http://localhost:8090` in your browser automatically.
2. **macOS and Linux**: Run `chmod +x slaprf-* && ./slaprf-*` in a terminal to start the server and open `http://localhost:8090`.
3. For USB timer flashing (`System > Flasher`), open `http://localhost:8090` in Chrome, Edge, or Brave.
