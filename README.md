# SlapRF

SlapRF is a multi-gate 5.8 GHz sector timing system for FPV drone racing.

A standard lap timer measures only total lap time at the start gate. SlapRF places additional timers at gates around the track to measure split times for each track section (`S1`, `S2`, `S3`, `S4`). Pilots can compare section times across laps to see where they gained or lost time.

Each timer uses off-the-shelf parts that plug together without soldering.

## Intended Use: LiveTime Companion or Standalone Practice

SlapRF does not replace official race timing systems such as **MultiGP LiveTime** or **ImmersionRC LapRF**.

You can use SlapRF in two ways:

1. **Companion to MultiGP LiveTime**: SlapRF emulates an ImmersionRC LapRF 8-way timer over TCP on port `5403`. When you connect LiveTime to `localhost:5403`, SlapRF receives the pilot callsigns and 5.8 GHz frequencies from LiveTime. When a pilot crosses the start gate, SlapRF sends that crossing to LiveTime for official lap scoring and records the intermediate section splits (`S1`, `S2`, `S3`, `S4`) in the SlapRF web interface.
2. **Standalone practice timer**: You can run SlapRF on a laptop at the field with 1 to 6 timers. The web interface provides spoken lap times, live 5.8 GHz RSSI graphs, threshold calibration, and lap comparisons. You can also enable the built-in simulator to test the software without hardware.

## How It Works

A SlapRF setup uses one **Hub timer** and up to 5 **Spoke timers** (up to 6 timers total):

- **Hub timer**: Connects to your laptop over Wi-Fi or a mobile hotspot. It measures 5.8 GHz RSSI at its own gate and receives data from all Spoke timers.
- **Spoke timers**: Measure 5.8 GHz RSSI at other gates on the track and send their readings to the Hub timer over ESP-NOW. Spoke timers do not need Wi-Fi credentials.

You flash and configure the timers from Chrome, Edge, or Brave over USB. No compiler, driver installation, or command-line tool is required.

## Parts List and Cost

Each gate timer uses four off-the-shelf parts. One XIAO ESP32-C5 draws less than `100 mA` at `5 V` (`0.5 W`), so a standard 4S or 6S FPV LiPo battery powers a timer for more than 24 hours.

| Part | Purpose | Product Links | Est. Cost (USD) |
| :--- | :--- | :--- | :--- |
| **Seeed Studio XIAO ESP32-C5** (includes external 2.4 / 5 GHz U.FL antenna) | Measures 5.8 GHz VTX signal strength and sends data over ESP-NOW and Wi-Fi. | <ul><li>[Seeed Studio XIAO ESP32-C5](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-p-6609.html)</li></ul> | $5.90 |
| **XT60-to-USB-C 5V BEC adapter** | Converts 3S to 6S LiPo battery power to `5 V` USB-C output. | <ul><li>[SpeedyBee Goggles BEC](https://www.google.com/search?tbm=shop&q=SpeedyBee+Goggles+BEC)</li><li>[AOKoda XT60 to USB Converter](https://www.google.com/search?tbm=shop&q=AOKoda+XT60+to+USB+Converter)</li></ul> | $4.00 – $17.00 |
| **Short USB-C to USB-C cable (straight plugs)** | Connects the 5V BEC adapter to the XIAO ESP32-C5. Also used to flash firmware from a laptop. | <ul><li>[Adafruit 6" USB-C to USB-C Cable](https://www.adafruit.com/product/4198)</li><li>[SparkFun USB-C to USB-C 0.3m Flexible Silicone Cable](https://www.sparkfun.com/usb-c-to-usb-c-cable-03m-flexible-silicone.html)</li></ul> | $2.50 – $5.00 |
| **3S–6S FPV LiPo battery (XT60)** | Powers the timer in the field. | <ul><li>[Tattu R-Line 1300mAh 6S XT60](https://genstattu.com/tattu-le-r-line-6-0-1300-6s-160c-lipo-xt60/)</li></ul> | $0 (spare pack) or $25.00+ new |

### Estimated Total Cost

- **1 timer**: $12 to $16 (using an existing LiPo battery)
- **4-gate track (`1 Hub + 3 Spokes`)**: $48 to $64 total

## Hardware Assembly

No soldering is required.

```text
[ 2S–6S LiPo Battery ] -> (XT60) -> [ XT60-to-USB 5V BEC ] -> (USB-C) -> [ Seeed XIAO ESP32-C5 ]
```

1. Attach the included U.FL antenna to the antenna connector on the XIAO ESP32-C5.
2. Connect the XIAO ESP32-C5 to your laptop with a USB-C cable.
3. Open **System > Flasher** in the SlapRF web interface. Flash one timer as **Hub** and the remaining timers as **Spoke**.
4. At the field, connect each XIAO ESP32-C5 to a 5V BEC adapter and a LiPo battery. Place one timer at each gate.
5. Open **System > Track** and drag each timer (`T1`, `T2`, `T3`, `T4`) onto the track line in the order pilots fly the course. Click the checkered flag icon below a gate to set the start gate.

## Running the Server

Build and start the server from the project directory:

```powershell
go build -o fpvtimer.exe ./cmd/fpvtimer
.\fpvtimer.exe
```

Open `http://localhost:8090` in Chrome, Edge, or Brave.
