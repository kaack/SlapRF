---
title: Status LED Patterns
weight: 3
---

Every Seeed Studio XIAO ESP32-C5 board drives its onboard yellow user LED (`GPIO27`) from an independent `10 ms` hardware timer in the SlapRF firmware, keeping blink timing exact regardless of channel sweep load.

Each card below pairs a real-time yellow LED simulation on the left with a millisecond square-wave timing strip underneath.

![Seeed Studio XIAO ESP32-C5 Status LED Location](/images/xiao-c5-led.jpg)

## Normal Operation

{{< led-pattern
  id="hub-active"
  title="Hub Ready & Active"
  roles="USB Hub · Connected Bluetooth Hub"
  summary="Single 70 ms blip every 2.0 seconds"
  timing="70 ms ON · 1930 ms OFF (2000 ms cycle)"
  window="2000"
  pulses="0-70"
>}}
The Hub (`H1`) passed its 5.8 GHz radio self-check and is ready for timing. On a USB Hub, this pattern starts immediately after boot. On a Bluetooth Hub, it appears once your paired phone or laptop connects and authenticates over Bluetooth LE.
{{< /led-pattern >}}

{{< led-pattern
  id="spoke-joined"
  title="Spoke Joined & Synced"
  roles="Spoke (T1 to T6)"
  summary="Double 70 ms blip every 2.0 seconds"
  timing="70 ms ON · 150 ms OFF · 70 ms ON · 1710 ms OFF (2000 ms cycle)"
  window="2000"
  pulses="0-70,220-290"
>}}
The wireless Spoke locked onto the Hub's 2.4 GHz ESP-NOW beacon within the last `2.5 s`, synchronized its clock, and is streaming 5.8 GHz RSSI sweeps to the Hub.
{{< /led-pattern >}}

## Pairing & Search

{{< led-pattern
  id="ble-pairing"
  title="Bluetooth Hub: Pairing Mode (Unclaimed)"
  roles="Bluetooth Hub"
  summary="Fast double-blink every 1.0 second"
  timing="80 ms ON · 100 ms OFF · 80 ms ON · 740 ms OFF (1000 ms cycle)"
  window="2000"
  pulses="0-80,180-260,1000-1080,1180-1260"
>}}
The Bluetooth Hub has no saved host bond yet and is open for Claim-on-Pair. Open **Network** in the SlapRF app and connect; the first device to connect claims the Hub so nearby spectators cannot take over your timer at the field.
{{< /led-pattern >}}

{{< led-pattern
  id="waiting-1hz"
  title="Waiting for Link (1 Hz Slow Blink)"
  roles="Spoke Searching · Paired Bluetooth Hub Disconnected"
  summary="Steady 1 Hz blink (50% duty cycle)"
  timing="500 ms ON · 500 ms OFF (1000 ms cycle)"
  window="2000"
  pulses="0-500,1000-1500"
>}}
On a Spoke (`T1`-`T6`), the board is searching for a Hub over 2.4 GHz ESP-NOW. On a claimed Bluetooth Hub (`H1`), the board is advertising over Bluetooth LE and waiting for its paired phone or laptop to reconnect.
{{< /led-pattern >}}

{{< led-pattern
  id="boot-reset"
  title="Clear Bluetooth Pairing (Hold BOOT for 3.0 s)"
  roles="Bluetooth Hub"
  summary="Solid ON while holding BOOT -> 800 ms rapid burst -> Pairing Mode"
  timing="Hold BOOT 3.0 s (Solid ON) -> 60 ms ON / 60 ms OFF burst (800 ms) -> Pairing Mode"
  window="4800"
  pulses="300-3000,3060-3120,3180-3240,3300-3360,3420-3480,3540-3600,3660-3720,3800-3880,3980-4060"
>}}
To pair a claimed Bluetooth Hub with a different phone or laptop, hold the `BOOT` button (`GPIO28`) while powered. The yellow LED stays solid ON while held, flashes a rapid `800 ms` burst at `3.0 s` when the saved host key is cleared, and enters Pairing Mode.
{{< /led-pattern >}}

![Seeed Studio XIAO ESP32-C5 BOOT Button Location](/images/xiao-c5-boot.jpg)

## Diagnostics & Faults

{{< led-pattern
  id="identify"
  title="Identify Timer (Find My Gate)"
  roles="All Boards"
  summary="3 quick 50 ms flashes followed by a 350 ms pause"
  timing="3 x (50 ms ON · 50 ms OFF) + 300 ms extra dark pause (600 ms cycle)"
  window="2000"
  pulses="0-50,100-150,200-250,600-650,700-750,800-850,1200-1250,1300-1350,1400-1450,1800-1850,1900-1950"
>}}
Triggered when you click **Identify** on a timer in the SlapRF UI to locate which physical board corresponds to `H1`, `T1`, or `T2`. The `350 ms` pause between 3-flash groups distinguishes it from the continuous `10 Hz` fault strobe.
{{< /led-pattern >}}

{{< led-pattern
  id="diag-5hz"
  title="Live Spectrum / Debug Stream Active (5 Hz)"
  roles="All Boards"
  summary="Steady 5 Hz fast blink"
  timing="100 ms ON · 100 ms OFF (200 ms cycle)"
  window="2000"
  pulses="0-100,200-300,400-500,600-700,800-900,1000-1100,1200-1300,1400-1500,1600-1700,1800-1900"
>}}
Indicates an active diagnostic `LIVE` or wideband 5.8 GHz spectrum `SCAN LIVE` stream over the serial or BLE console.
{{< /led-pattern >}}

{{< led-pattern
  id="fault-10hz"
  title="5.8 GHz Radio Self-Check Fault (10 Hz)"
  roles="All Boards"
  summary="Continuous 10 Hz rapid strobe (no pause)"
  timing="50 ms ON · 50 ms OFF continuous (100 ms cycle)"
  window="2000"
  pulses="0-50,100-150,200-250,300-350,400-450,500-550,600-650,700-750,800-850,900-950,1000-1050,1100-1150,1200-1250,1300-1350,1400-1450,1500-1550,1600-1650,1700-1750,1800-1850,1900-1950"
>}}
The ESP32-C5 5.8 GHz radio path failed its boot or runtime health check (`!rf_ok`). Unplug power for 5 seconds, verify stable `5 V` supply voltage, and re-flash the latest SlapRF firmware if the strobe continues.
{{< /led-pattern >}}
