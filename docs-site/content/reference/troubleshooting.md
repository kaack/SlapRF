---
title: Troubleshooting
weight: 3
---

Quick diagnostics and fixes for USB flashing, wireless connectivity, power supplies, and gate detection.

## USB & Flashing

### USB Port Missing

If the XIAO ESP32-C5 does not appear in the browser serial port chooser:

1. Swap to a known USB-C data cable (many bundled cables are charge-only with no data wires).
2. Plug directly into your Android phone (using the SlapRF app) or a computer USB port rather than an unpowered hub or dock (use desktop Chrome, Edge, or Opera if flashing from a web browser).
3. On Linux, confirm your user is in the `dialout` or `uucp` group so `/dev/ttyACM0` can be opened.
4. If a board is unresponsive, hold the tiny `BOOT` button (`B`, bottom-right of the XIAO) while plugging in USB-C, release `BOOT`, and click **Flash to USB**:

{{< themed-image light="/images/xiao-c5-boot.jpg" dark="/images/xiao-c5-boot-dark.jpg" alt="Seeed Studio XIAO ESP32-C5 BOOT Button Location" >}}

### Interrupted Flash

If flashing halts partway through or boards reset randomly on USB, unplug any extra XIAO boards so only one board is connected at a time. Multiple ESP32-C5 radios calibrating on 2.4 GHz simultaneously can droop a shared laptop `5 V` rail.

## Bluetooth & Spokes

### Hub Not Found

If your phone or laptop does not discover the Bluetooth Hub in **Network**:

1. Verify the board was flashed with the Bluetooth Hub image (`slaprf-xiao-c5-ble.bin`) and shows either the fast double-blink (Pairing Mode) or `1 Hz` slow blink.
2. Open **Network** and confirm the **Timing system** dropdown is set to **SlapRF (Bluetooth)** (if another timer is active, click **Disconnect** first to unlock the dropdown).
3. Disconnect any other phone or browser tab already linked to the Hub (BLE advertising pauses while an active host is connected). To switch the Hub to a new phone, computer, or Raspberry Pi, click **Forget Device** in **Network** while connected on the old device, or hold `BOOT` on the Hub for `3.0 s` until the rapid LED burst clears the previous bond.
4. On Linux, SlapRF powers on the default BlueZ adapter automatically. If your host has more than one Bluetooth controller, run `bluetoothctl list` and set `SLAPRF_BLE_ADAPTER=hci1` (or your active adapter name) if needed.

### Raspberry Pi Bluetooth Fails to Connect or Drops

On Raspberry Pi 4 (`CYW43455`, and other Raspberry Pi models with a shared wireless chip), `2.4 GHz` Wi-Fi and Bluetooth LE share a single onboard `2.4 GHz` radio and unshielded PCB antenna. Both `2.4 GHz` Wi-Fi traffic and close-range RF overload block Bluetooth Hub (`slaprf_ble`) connections (`le-connection-abort-by-local`):

1. **Do not use `2.4 GHz` Wi-Fi on the Raspberry Pi.** Connect the Pi to **`5 GHz` Wi-Fi or wired Ethernet** and disable `2.4 GHz` Wi-Fi autoconnect so live browser traffic does not preempt Bluetooth LE packets:
   ```bash
   # Check active Wi-Fi frequency (~5xxx MHz = 5 GHz, ~24xx MHz = 2.4 GHz)
   nmcli -f IN-USE,SSID,CHAN,FREQ dev wifi
   # Disable autoconnect on a 2.4 GHz network profile
   sudo nmcli connection modify "<2.4GHz-SSID>" connection.autoconnect no
   ```
   If only `2.4 GHz` Wi-Fi is available at your track, flash the USB Hub image (`slaprf-xiao-c5.bin`) and connect the Hub (`H1`) to the Raspberry Pi with a USB-C data cable instead of Bluetooth.
2. **Move the Hub `30 cm` to `1 m` (`1` to `3 ft`) away from the Raspberry Pi.** Setting the XIAO ESP32-C5 whip antenna within a few inches of the Raspberry Pi drives `2.4 GHz` RSSI above `-30 dBm`, saturating the Pi's receiver and dropping GATT handshakes.
3. **Use a dedicated `5 V / 3 A` USB-C power supply.** Do not power both a Raspberry Pi and XIAO ESP32-C5 timers from the same computer USB hub, as `2.4 GHz` radio calibration bursts can droop a shared `5 V` rail.

### Spoke Stays Offline

If a Spoke (`T1`-`T6`) blinks slowly at `1 Hz` and stays offline in **Network**:

1. Power on the Hub (`H1`) first and verify it is online.
2. Re-flash the Hub and all Spokes from the same SlapRF release so their ESP-NOW packet versions match.
3. Check that the snap-on U.FL antenna is firmly seated on both boards and that no two Spokes share the same slot ID (`T1`-`T6`):

{{< themed-image light="/images/xiao-c5-antenna.jpg" dark="/images/xiao-c5-antenna-dark.jpg" alt="XIAO ESP32-C5 U.FL Antenna Socket" >}}

### Power Bank Shutoff

Because a XIAO ESP32-C5 draws under `100 mA`, some phone power banks assume nothing is connected and shut off after 30 to 60 seconds. Power gate timers from a 3S-6S LiPo pack with an XT60-to-USB-C `5 V` BEC (which never auto-sleeps), or enable trickle-charge mode on your power bank.

## Gate Detection

### False Adjacent Laps

If flying on a nearby lane triggers laps on an adjacent gate:

1. Fly 2 to 3 clean passes through the gate and click **Calibrate**, or open **Fine-tune** and raise the Enter threshold closer to `0 dBm` (for example, `-58 dBm` to `-50 dBm`).
2. Set **Min Lap Time** just below your fastest realistic lap on the course.
3. On tight tracks, set the XIAO inside a shallow open-top metal cup or foil-lined tray under the gate to block side-lobe RF from neighboring lanes.

### Missed Fast Passes

If high-speed passes through a gate do not register:

1. Confirm the pilot's channel in **Pilots** matches the exact VTX band and frequency (and that Pit Mode is off).
2. Remove inactive pilot slots from the session so timers sweep fewer frequencies and sample each active pilot faster.
3. Open **Fine-tune** on that gate timer and lower the Enter threshold slightly (for example, `-48 dBm` to `-55 dBm`).

## Diagnostic Logs

On desktop (`SlapRF Portable`) and Android, SlapRF writes server, storage, and hardware link events to a rolling `slaprf.log` file alongside the app (and to Android `logcat` under tag `SlapRFGo`):

1. Open **Settings** and scroll to **Diagnostic logs** under **Data & Backup**.
2. Change the log level from `INFO (default)` to `DEBUG` or `TRACE` before reproducing an issue.
3. Click **Download** to save `slaprf-YYYY-MM-DD.log` for inspection or bug reports, then switch the level back to `INFO (default)`.
