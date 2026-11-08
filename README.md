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

- **Hub timer**: Connects to your laptop over Wi-Fi or a mobile hotspot. It measures 5.8 GHz RSSI at its own gate and receives data from all Spoke timers.
- **Spoke timers**: Measure 5.8 GHz RSSI at other gates on the track and send their readings to the Hub timer over ESP-NOW. Spoke timers do not need Wi-Fi credentials.

```mermaid
flowchart LR
    subgraph Track["FPV Track (5.8 GHz VTX Signal)"]
        T2["Gate 2: Spoke Timer (T2)"]
        T3["Gate 3: Spoke Timer (T3)"]
        T4["Gate 4: Spoke Timer (T4)"]
        T1["Start Gate: Hub Timer (T1)"]
    end

    subgraph Laptop["Field Laptop"]
        Server["SlapRF Server"]
        UI["Web UI (:8090) - Section Splits S1-S4"]
        LiveTime["MultiGP LiveTime (:5403 LapRF TCP)"]
    end

    T2 -- "ESP-NOW" --> T1
    T3 -- "ESP-NOW" --> T1
    T4 -- "ESP-NOW" --> T1
    T1 -- "Wi-Fi (UDP)" --> Server
    Server --> UI
    Server -. "Optional Start Gate Passings" .-> LiveTime
```

You flash and configure the timers from Chrome, Edge, or Brave over USB. No compiler, driver installation, or command-line tool is required.

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

```text
[ 3S–6S LiPo Battery ] -> (XT60) -> [ LIPO to USB-C Adapter ] -> (USB-C) -> [ Seeed XIAO ESP32-C5 ]
```

1. Attach the included U.FL antenna to the antenna connector on the XIAO ESP32-C5.
2. Connect the XIAO ESP32-C5 to your laptop with a USB-C cable.
3. Open **System > Flasher** in the SlapRF web interface. Flash one timer as **Hub** and the remaining timers as **Spoke**.
4. At the field, connect each XIAO ESP32-C5 to a LIPO to USB-C Adapter and a LiPo battery. Place one timer at each gate.
5. Open **System > Track** and drag each timer (`T1`, `T2`, `T3`, `T4`) onto the track line in the order pilots fly the course. Click the checkered flag icon below a gate to set the start gate.

## Running the Server

Build and start the server from the project directory:

```powershell
go build -o fpvtimer.exe ./cmd/fpvtimer
.\fpvtimer.exe
```

Open `http://localhost:8090` in Chrome, Edge, or Brave.
