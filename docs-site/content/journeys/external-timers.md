---
title: RotorHazard & LapRF 8-Way
linkTitle: RotorHazard & LapRF
weight: 4
---

Connect the SlapRF App to existing RotorHazard or ImmersionRC LapRF 8-Way hardware over LAN or USB without building new timers.

## Choose Your Mode

Open **Network** in the native SlapRF desktop or Android app and select your hardware from the **Timing system** dropdown:

| Dropdown Option | Connection | Hardware & When to Choose It |
| :--- | :--- | :--- |
| **LapRF 8-Way (Network)** | Ethernet LAN (`TCP :5403`) | ImmersionRC LapRF 8-Way puck plugged into a field router or network switch. |
| **LapRF 8-Way (USB)** | USB CDC serial (`115200` baud) | ImmersionRC LapRF 8-Way puck plugged directly into your phone or computer over USB (no router or IP setup). |
| **RotorHazard (Network)** | Wi-Fi or Ethernet (`HTTP` / `Socket.IO` `:5000`) | Complete RotorHazard server (Raspberry Pi + RX5808 shield) on the local network. |
| **RotorHazard (USB)** | USB serial (`115200` or `921600` baud, `API 36`) | Standalone RotorHazard RX5808 node board (ESP32-C5, STM32, Arduino, or RP2040) plugged directly into USB with no Raspberry Pi. |

> [!NOTE]
> While a timer is connected (or connecting), the **Timing system** dropdown on **Network** locks to prevent accidental mode switches mid-session. Click **Disconnect** next to the dropdown to unlock it and switch to a different timing system.

## RotorHazard Setup

{{< tabs >}}
  {{< tab name="RotorHazard (Network)" >}}
  ### RotorHazard (Network)

  Use **RotorHazard (Network)** when your RotorHazard timer runs a Raspberry Pi host on Wi-Fi or Ethernet.

  1. Open **Network** and select **RotorHazard (Network)** in **Timing system**.
  2. Click **Connect** next to the dropdown to scan the LAN for RotorHazard servers on port `5000`, or enter the server IP and port manually (for example, `192.168.1.101` and `5000`).
  3. When prompted by the sign-in dialog, enter the RotorHazard admin username and password (default `admin` / `rotorhazard`) and click **Sign in & Connect**.
  4. Verify the device card reports `Admin`, live `0`-`255` node RSSI bars, and clock sync. Assign pilot VTX channels in **Pilots** (or in a **Race** heat) and fly **Practice** or **Races**.
  {{< /tab >}}
  {{< tab name="RotorHazard (USB)" >}}
  ### RotorHazard (USB)

  Use **RotorHazard (USB)** when plugging a standalone RotorHazard serial node board (binary serial `API 36`, 1 to 8 RX5808 seats) directly into your computer or Android phone over USB-C.

  1. Plug the RotorHazard node board into your host with a USB data cable.
  2. Open **Network** and select **RotorHazard (USB)** in **Timing system**.
  3. Click **Connect USB** next to the dropdown, leave **Baud Rate** on `Auto (115200 / 921600)` (or select `115200` / `921600`), and select the serial port.
  4. Confirm the device card reports `Connected`, node count, serial RTT, and live `0`-`255` RSSI bars. You can also run `5180`-`5945 MHz` spectrum sweeps and waterfall plots on **Debug**.
  {{< /tab >}}
{{< /tabs >}}

## LapRF 8-Way Setup

{{< tabs >}}
  {{< tab name="LapRF 8-Way (Network)" >}}
  ### LapRF 8-Way (Network)

  Use **LapRF 8-Way (Network)** when your LapRF 8-Way puck connects to the same Wi-Fi router or Ethernet switch as your laptop, Raspberry Pi, or phone.

  1. Open **Network** and select **LapRF 8-Way (Network)** in **Timing system**.
  2. Click **Connect** next to the dropdown to discover powered-on pucks on `TCP :5403`, or enter the IP address (default `192.168.1.2`) and port (`5403`) manually.
  3. Confirm the timer card shows supply voltage, `Synced` clock offset, and live `300`-`3500` RSSI bars across the 8 receiver slots. SlapRF pushes pilot frequencies and thresholds automatically when a session or heat starts.
  {{< /tab >}}
  {{< tab name="LapRF 8-Way (USB)" >}}
  ### LapRF 8-Way (USB)

  Use **LapRF 8-Way (USB)** when plugging a LapRF 8-Way puck directly into your laptop, Raspberry Pi, or Android phone over USB (`115200` baud CDC serial). Note that the LapRF 8-Way still requires external `10 V`-`25 V` DC pack power on its XT60 input to power its `5.8 GHz` RF receivers.

  1. Power the LapRF 8-Way from a LiPo battery via XT60 and connect its USB port to your host device.
  2. Open **Network** and select **LapRF 8-Way (USB)** in **Timing system**.
  3. Click **Connect USB** next to the dropdown and select the LapRF serial port.
  4. Confirm the timer card reports supply voltage, `Synced` clock offset, and live 8-slot RSSI readings.
  {{< /tab >}}
{{< /tabs >}}

## Multi-Unit Courses & Section Splits

Most clubs place one 8-channel RotorHazard or LapRF 8-Way timer at the Start / Finish gate. If you connect two or more RotorHazard or LapRF timers at once, open your **Practice** session or **Race** workspace, select the **Track** tab, and drag each unit onto the track line in flight order to record `S1`, `S2`, and `S3` section splits. For cable-free split gates across a field without running LAN cables or Raspberry Pis to each gate, use battery-powered [SlapRF DIY Timers](../hardware/parts-and-assembly).

## LapRF 8-Way Emulator

When timing with SlapRF DIY hardware or RotorHazard on Windows, macOS, Linux, or Android, open **Settings -> LapRF 8-Way emulator** to host a local ImmersionRC LapRF 8-Way `TCP :5403` server. External LapRF-compatible race software (such as LiveTime) and broadcast overlays can connect to port `5403` to receive live crossings from SlapRF in real time. (The emulator hides automatically while **LapRF 8-Way (Network)** or **LapRF 8-Way (USB)** is active so port `5403` never loops back into itself.)
