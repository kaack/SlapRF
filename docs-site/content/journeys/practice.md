---
title: Solo & Club Practice
weight: 1
---

Set up a single-gate practice session, calibrate RSSI thresholds for your VTX in one tap, and fly with spoken lap callouts.

## Prerequisites

Install the [SlapRF Timing Application](../getting-started/installation) on your Android phone or laptop and prepare one flashed Hub timer (`H1`, either [Bluetooth or USB](../hardware/flashing)).

## Practice Setup

{{% steps %}}

### Select & Connect Hub

Open **Network** and choose your mode in the **Timing system** dropdown:
- **SlapRF (Bluetooth)**: Power `H1` (`slaprf-xiao-c5-ble.bin`) at the Start / Finish gate, click **Pair Device** (or **Connect** for a previously paired Hub), and select your Hub.
- **SlapRF (USB)**: Plug `H1` (`slaprf-xiao-c5.bin`) into your phone or computer over USB-C (with `T1` powered at Start / Finish, or `H1` placed directly at the gate) and click **Connect USB**.

Confirm the connected timer chip shows a green live indicator.

### Add Pilots

Open **Pilots** and enter each pilot's callsign, optional phonetic spelling for text-to-speech pronunciation, and default 5.8 GHz channel (such as `R1 5658` or `F4 5800`).

### Configure Session Track

Open **Practice**, select or create a practice session, and open its **Track** tab. Confirm your active gate timer (`H1` or `T1`) sits on the track line with the checkered Start / Finish flag selected, and adjust track-wide or per-timer **Timing rules** (`Min lap time`, `Max lap time`, `Min crossing time`, and `Beep on crossing`) if needed. Each practice session stores its own track layout and timing rules independently.

### Fly & Calibrate

In your **Practice** session, open **Pilots** to assign active pilot channels, tap **Start**, and switch to **Signals**. Arm your quad, fly 2 to 3 clean passes through the Start / Finish gate at normal race speed, then tap **Calibrate**. SlapRF inspects your signal peaks and noise floor and sets the Enter and Exit dBm levels automatically.

{{% /steps %}}

## Threshold Tuning

Most setups need no manual adjustment after tapping **Calibrate**. To fine-tune a specific gate, select its timer chip in **Signals** and open **Fine-tune**:

| Parameter | Adjustment Guide |
| :--- | :--- |
| Enter Threshold (`dBm`) | Signal level that starts a crossing. Raise it (closer to `0 dBm`) if nearby lanes trigger false laps; lower it if fast passes are missed. |
| Exit Threshold (`dBm`) | Signal level that closes the crossing window (`6` to `12 dBm` below Enter prevents double-triggers). |
| Min Lap Time (`s`) | Minimum seconds between consecutive valid laps for the same pilot. |

Any timer chip or global rule with custom overrides shows a small blue pencil indicator. Tap **Clear calibration** at any time to restore default values.

## Audio Callouts

Enable **Beep on crossing** in your session's **Track** tab (or per timer in **Signals -> Fine-tune**) for an instant low-latency tone the moment a gate crossing registers. Open **Settings -> Announcer** to choose your offline voice, volume, and whether spoken callouts read pilot name plus lap time or lap time alone.
