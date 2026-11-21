---
title: Flashing Firmware
weight: 2
---

Configure and flash Hub (`H1`) and Spoke (`T1` through `T6`) firmware onto Seeed Studio XIAO ESP32-C5 boards directly from your desktop browser below, or from the built-in **Flasher** screen inside the SlapRF Android and desktop apps over USB-C. No ESP-IDF toolchain, Python install, or serial driver is needed.

## Browser Flasher

Connect your XIAO ESP32-C5 with a USB-C data cable in Chrome, Edge, or Opera to flash directly from this page, or flash from the **Flasher** screen inside the SlapRF Android or desktop app:

{{< web-flasher >}}

> [!WARNING]
> Connect only one XIAO ESP32-C5 board at a time while flashing. During 2.4 GHz radio calibration bursts, each ESP32-C5 draws up to `320 mA`, and plugging multiple boards into shared USB ports can cause `5 V` sag and interrupted writes.

## Before Flashing

| Requirement | Details |
| :--- | :--- |
| Supported Host | Built-in **Flasher** in the SlapRF Android or desktop app (over USB-C / OTG), or desktop Chrome, Edge, or Opera for the browser flasher above. |
| USB-C Data Cable | Plug directly into your phone or computer port (avoid charge-only cables and unpowered hubs). |
| Matching Versions | When updating SlapRF firmware, re-flash both the Hub (`H1`) and all Spokes (`T1`-`T6`) so their ESP-NOW protocol matches. |

## Flashing Steps

{{% steps %}}

### Open Flasher

Click **Open Firmware Flasher** above to launch the 3-step firmware wizard.

### Choose Role

In Step 1, pick **Hub** (`H1`, one per course) or **Spoke** (wireless split gates). In Step 2, choose **Bluetooth** (`slaprf-xiao-c5-ble.bin`) or **USB cable** (`slaprf-xiao-c5.bin`) for a Hub, or pick timer slot `T1` through `T6` for a Spoke.

### Flash via USB

In Step 3, click **Flash H1 to USB** (or `T1`-`T6`), select the `USB JTAG / serial debug unit` port in the browser chooser, and click **Connect**. Erasing, writing, and verification finish in about 20 seconds without holding the `BOOT` button.

{{% /steps %}}

## LED Quick Reference

After flashing, the onboard yellow LED (`GPIO27`) indicates board status. See [Status LED Patterns](status-leds) for live animations and millisecond timing charts.

| Board State | Blink Pattern | Meaning |
| :--- | :--- | :--- |
| Hub Ready | Single `70 ms` blip every `2.0 s` | USB Hub active, or Bluetooth Hub connected to your paired host. |
| Spoke Synced | Double `70 ms` blip every `2.0 s` | Spoke (`T1`-`T6`) paired with the Hub over ESP-NOW and sweeping. |
| BLE Pairing Mode | Fast double-blink every `1.0 s` | Unclaimed Bluetooth Hub ready to pair with a phone or laptop. |
| Searching / Waiting | Steady `1 Hz` (`500 ms` ON / `500 ms` OFF) | Spoke searching for Hub, or paired BLE Hub waiting to reconnect. |
| Identify | `3` quick flashes + pause (`600 ms` cycle) | Identify mode triggered from the SlapRF UI. |
| Radio Fault | Continuous `10 Hz` strobe (`50 ms` ON / `50 ms` OFF) | 5.8 GHz radio check failed; power-cycle or re-flash the board. |
