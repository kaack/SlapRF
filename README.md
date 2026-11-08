# SlapRF

**Multi-Gate FPV Drone Racing Sector Timer & Practice Analytics — Built from Off-the-Shelf Parts with Zero Soldering.**

Most FPV lap timers only tell you your total lap time at the start/finish gate. When you drop half a second on a lap, you're left guessing whether you lost it in the sweeper, the split-S, or the corkscrew.

**SlapRF** places lightweight 5.8 GHz timers at multiple gates around your track so you get **Formula-1-style sector splits (`S1`, `S2`, `S3`, `S4`), section records, theoretical best laps, and lap-to-lap consistency analytics** — using off-the-shelf, plug-and-play components you can assemble in 30 seconds with **no soldering** and **no command-line tools**.

---

## Companion to Official Race Systems — Or Standalone for Practice

> **Note:** SlapRF is **not** intended to replace mature, race-proven official timing systems like **MultiGP LiveTime** or **ImmersionRC LapRF** used at sanctioned events.

Instead, SlapRF is built to be used in two ways:

1. **As an Analytics Companion to MultiGP LiveTime**
   - SlapRF includes a built-in **ImmersionRC LapRF 8-Way TCP bridge (`:5403`)**.
   - Point LiveTime at SlapRF (`localhost:5403`), and SlapRF will automatically sync your heat's pilot callsigns and 5.8 GHz VTX channels from LiveTime.
   - Whenever a pilot crosses your designated **Start gate**, SlapRF forwards the official start/finish detection to LiveTime while simultaneously recording every intermediate gate crossing (`S1`, `S2`, `S3`, `S4`) inside SlapRF. Race directors keep their familiar LiveTime workflow, and pilots get deep sector-by-sector telemetry.
2. **Standalone for Practice Sessions**
   - Toss a few timers in your flight bag, drop them at key features around a practice track, and open SlapRF on your laptop.
   - Get spoken lap callouts, real-time 8-channel 5.8 GHz RSSI traces, automatic threshold calibration, and instant per-section comparisons against your personal best.
   - No hardware on hand yet? Turn on the built-in **Track Simulator** to test the full dashboard right away.

---

## Core Principles

- **Zero Soldering, 100% Plug-and-Play**: Every timer is assembled by plugging three off-the-shelf parts together — a **Seeed Studio XIAO ESP32-C5**, a **USB-C cable**, and an **XT60-to-USB 5V BEC adapter** powered by any spare 2S–6S FPV LiPo battery from your flight bag.
- **Zero-Install Browser USB Flashing**: Plug a XIAO ESP32-C5 into your laptop and click **Flash to USB** directly inside the SlapRF web app (Chrome, Edge, or Brave). No Arduino IDE, no ESP-IDF toolchain, and no CLI commands required.
- **Hub + Spoke Wireless Mesh (Only One Wi-Fi Connection)**:
  - **1× Hub Timer**: Connects to your laptop's Wi-Fi or hotspot and relays readings from the entire track.
  - **N× Spoke Timers**: Sit out on the course at sector gates and burst readings directly to the Hub over connectionless **ESP-NOW** — spoke timers never need Wi-Fi passwords or router coverage.
- **Interactive Track Timeline (`---O---O---O---O---`)**: Drag discovered timers (`T1`, `T2`, `T3`, `T4`) onto the visual track line in the order pilots fly them to define your track sections (`S1`–`S4`), and click the checkered flag beneath any gate to set the start gate.

---

## Bill of Materials & Estimated Cost

Every gate timer uses the exact same four off-the-shelf items. Because a XIAO ESP32-C5 draws less than **0.5 W (`<100 mA` at 5V)**, even an old retired 4S or 6S flight pack from your bag will power a timer on the field for **24+ hours**.

### Per-Timer Hardware Breakdown

| Component | What It Does | Manufacturer Links | Est. Cost (USD) |
| :--- | :--- | :--- | :--- |
| **Seeed Studio XIAO ESP32-C5** *(includes external dual-band 2.4 / 5 GHz U.FL antenna in the box)* | Thumb-sized RISC-V microcontroller with native **5 GHz radio** used to measure 5.8 GHz VTX signal strength and stream telemetry over ESP-NOW / Wi-Fi. | [Seeed Studio Product Page](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-p-6609.html) · [Seeed Wiki](https://wiki.seeedstudio.com/xiao_esp32c5_getting_started/) | **~$5.90** |
| **XT60-to-USB 5V BEC Adapter** | Steps down any 2S–6S (`7.4V–25.2V`) XT60 LiPo battery to a regulated 5V USB output with zero soldering. | [SpeedyBee](https://www.speedybee.com) · [iFlight](https://shop.iflight.com) · [ToolkitRC](https://www.toolkitrc.com) · [Matek Systems](https://www.mateksys.com) | **~$4.00 – $8.00** |
| **USB-C Cable** *(USB-A to USB-C or USB-C to USB-C)* | Connects the XT60 5V USB BEC to the XIAO ESP32-C5 (and plugs into your laptop once for initial browser flashing). | [Seeed Studio Cables](https://www.seeedstudio.com) | **~$2.00** |
| **2S–6S FPV LiPo Battery (XT60)** | Field power for the timer. Any retired or spare flight pack works. | [Tattu / Gens ace](https://www.genstattu.com) · [CNHL](https://chinahobbyline.com) · [GNB](https://www.gaoneng.shop) | **$0** *(using spare flight packs)* or **~$12.00** new |

### Total Cost Estimate

- **Single Gate Timer (`1× Timer`)**: **~$12 – $16** *(using a spare flight LiPo)*
- **Full 4-Gate Sector Timing Course (`1× Hub + 3× Spokes`)**: **~$48 – $64 total** *(compared to $400–$1,200+ for traditional multi-gate commercial timing hardware)*

---

## How Each Timer Goes Together (No Soldering)

```text
[ 2S–6S FPV LiPo ] ──(XT60)──> [ XT60-to-USB 5V BEC ] ──(USB-C)──> [ Seeed XIAO ESP32-C5 + Included 5GHz Antenna ]
```

1. Snap the included U.FL whip antenna onto the **Seeed Studio XIAO ESP32-C5** connector.
2. Plug the XIAO ESP32-C5 into your laptop with a USB-C cable and open **System → Flasher** in SlapRF to flash **1× Hub** and **N× Spokes**.
3. On the field, plug each XIAO ESP32-C5 into an **XT60-to-USB 5V BEC** and a **LiPo battery**, and set it next to its gate.

---

## Quick Start

```powershell
go build -o fpvtimer.exe ./cmd/fpvtimer
.\fpvtimer.exe
```

Then open **`http://localhost:8090`** in Chrome, Edge, or Brave.
