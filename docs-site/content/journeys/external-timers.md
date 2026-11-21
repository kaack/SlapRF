---
title: RotorHazard & LapRF 8-Way
linkTitle: RotorHazard & LapRF
weight: 4
---

Pilots and clubs who already own a RotorHazard timer or an ImmersionRC LapRF 8-Way puck can run the SlapRF Timing Application as a modern practice and race control interface without building new hardware.

> [!NOTE]
> RotorHazard and LapRF 8-Way operate as single Start / Finish multi-pilot receivers for up to 8 simultaneous channels. Multi-gate section split timing (`S1`, `S2`, `S3`) requires DIY SlapRF Gate Hardware.

## RotorHazard Setup

SlapRF connects to an existing RotorHazard server over Wi-Fi or Ethernet (`HTTP` / `Socket.IO`) or directly to RotorHazard serial nodes over USB.

{{% steps %}}

### Select RotorHazard

Launch the native SlapRF desktop binary or Android app, open **Settings -> Hardware**, and select **RotorHazard**.

### Connect Server

Open **Network** and click **Scan LAN** to discover RotorHazard servers on port `5000`, or enter the server address manually (such as `192.168.1.50:5000`) and click **Connect**.

### Sync & Fly

Assign pilot VTX channels in **Pilots** (or inside a **Race** heat), click **Sync** on the RotorHazard card if needed, and run **Practice** or **Race Control** as usual.

{{% /steps %}}

## LapRF 8-Way Setup

SlapRF communicates natively with the ImmersionRC LapRF 8-Way puck over Ethernet or Wi-Fi LAN using the binary LapRF TCP protocol (`port 5403`).

{{% steps %}}

### Select LapRF

Open **Settings -> Hardware** in the native SlapRF app and choose **ImmersionRC LapRF 8-Way**.

### Connect via LAN

Connect your LapRF 8-Way to the same router or switch as your host device. Open **Network**, click **Scan LAN** to find pucks on TCP port `5403` (or enter `192.168.1.20:5403` manually), and click **Connect**.

### Sync Slots

Confirm all 8 receiver slots report online status and pack voltage. SlapRF pushes active pilot frequencies and gain/threshold settings automatically whenever a Practice session or Race heat starts.

{{% /steps %}}

## LapRF 8-Way Emulator

When running on Windows, macOS, or Linux, SlapRF can also expose a local ImmersionRC LapRF 8-Way `:5403` TCP emulator so any external LapRF-compatible timing client or broadcast overlay can ingest live gate crossings from SlapRF in real time.
