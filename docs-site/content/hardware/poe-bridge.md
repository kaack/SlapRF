---
title: PoE Ethernet Bridge
weight: 4
---

Place Hub `H1` directly at the Start / Finish gate up to `100 m` (`328 ft`) away using a single Ethernet cable for both power and data. A Waveshare `ESP32-P4-WIFI6-POE-ETH` board powers `H1` over USB-A with no battery needed at the gate, while optional Spoke timers (`T1` through `T6`) link wirelessly to `H1` as usual.

{{< themed-image light="/images/slaprf-setup-poe.jpg" dark="/images/slaprf-setup-poe-dark.jpg" alt="SlapRF PoE Mode" >}}

## Bill of Materials

The PoE Bridge and Hub `H1` draw under `2 W` combined, so any standard `802.3af` PoE switch or inline PoE injector powers the gate continuously all day.

| Part | Purpose | Example Source | Est. Cost |
| :--- | :--- | :--- | ---: |
| ESP32-P4-WIFI6-POE-ETH | Bridges Hub `H1` on USB-A to `100 Mbps` Ethernet with integrated onboard `802.3af` PoE power (`SKU 32832` Basic Kit). | [Waveshare](https://www.waveshare.com/esp32-p4-wifi6-poe-eth.htm?sku=32832)<br/>[Amazon](https://www.amazon.com/ESP32-P4-WIFI6-POE-ETH-ESP32-P4-ESP32-C6-Supports-Integrated/dp/B0GFJQSN9B/)<br/>[Board Docs](https://docs.waveshare.com/ESP32-P4-WIFI6-POE-ETH) | \$24.99 - \$30.00 |
| XIAO ESP32-C5 | Hub `H1` timer at the Start / Finish gate (flashed with the standard USB Hub image; includes snap-on U.FL antenna). | [Seeed Studio](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-p-6609.html) | \$6.90 |
| Short USB-A to USB-C Cable | Data cable connecting the bridge's USB-A port to the XIAO ESP32-C5 USB-C port. | [Short USB-A to USB-C](https://www.amazon.com/s?k=short+usb-a+to+usb-c+data+cable) | \$5.00 - \$8.00 |
| 802.3af PoE Switch or Injector | Supplies power and network connectivity from the pilot bench over one Ethernet cable. | [PoE Switch](https://www.amazon.com/s?k=5+port+802.3af+poe+switch)<br/>[PoE Injector](https://www.amazon.com/s?k=802.3af+poe+injector) | \$15.00 - \$28.00 |
| Cat5e or Cat6 Cable | Runs power and `100 Mbps` Ethernet between the pilot bench and the Start / Finish gate (up to `100 m`). | [Outdoor Cat6 Cable](https://www.amazon.com/s?k=outdoor+cat6+ethernet+cable) | \$10.00 - \$25.00 |

## Setup

{{% steps %}}

### Flash the PoE Bridge

Plug the **USB-C** port on your Waveshare `ESP32-P4-WIFI6-POE-ETH` into your computer using a USB-C data cable. Click **Open PoE Bridge Flasher** below, click **Flash PoE Bridge to USB**, and select the `USB Single Serial` port:

{{< web-flasher role="poe_bridge" label="Open PoE Bridge Flasher" >}}

If you have not flashed your XIAO ESP32-C5 Hub (`H1`) yet, flash it with the **Hub (`USB cable`)** option on [Flashing Firmware](flashing).

### Connect at the Gate

Unplug the USB-C programming cable from your computer. Plug Hub `H1` into the **USB-A** port on the Waveshare board with a short USB-A to USB-C data cable, then plug your PoE Ethernet cable into the **RJ45** port. Both boards power on automatically from the Ethernet cable.

### Connect in SlapRF

Connect your laptop or phone to the same network (wired Ethernet or Wi-Fi router connected to your PoE switch, or a direct cable from your laptop to a PoE injector) and open **Network** in the SlapRF desktop or Android app:

1. Set **Timing system** to **`SlapRF (Network)`**.
2. Click **Discover**, select the detected PoE Bridge, and click **Connect**.
3. Confirm Hub `H1` appears as **Active** with live RSSI bars.

{{% /steps %}}
