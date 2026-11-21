---
title: Multi-Gate Section Splits
linkTitle: Multi-Gate Splits
weight: 2
---

A single gate measures total lap time, while adding wireless Spoke timers (`T1` through `T6`) around the course breaks every lap into section splits (`S1`, `S2`, `S3`) so you can see exactly where time is gained or lost.

## How Splits Work

When timers sit at sequential gates along the flight path, SlapRF measures each interval independently before closing the full lap at Start / Finish:

| Track Segment | Recorded Split |
| :--- | :--- |
| Start / Finish -> Gate 2 | Section 1 (`S1`) |
| Gate 2 -> Gate 3 | Section 2 (`S2`) |
| Last Gate -> Start / Finish | Final section + completed lap time |

Every Spoke streams its 5.8 GHz RSSI sweeps to `H1` over 2.4 GHz ESP-NOW while `H1` continuously aligns each Spoke's clock.

## Course Setup

{{% steps %}}

### Flash Spokes

Use the [Firmware Flasher](../hardware/flashing) on a desktop computer to assign each Spoke board a unique slot (`T1` through `T6`) on the same firmware version as `H1`.

### Place Timers

In Bluetooth Hub mode, place `H1` at Start / Finish and place Spokes (`T1`, `T2`, ...) at split gates around the track. In USB Hub mode, keep `H1` plugged into your laptop or phone at the bench, place `T1` at Start / Finish, and place `T2`, `T3`, ... at split gates. Raising a bench Hub onto a table or crate off damp grass improves long-range 2.4 GHz reception.

### Set Gate Order

Open **Network** to confirm `H1` and all powered Spokes report `Online`. Open **Track**, drag your active timers onto the loop in exact flight order, and click the checkered flag on your Start / Finish gate.

### Calibrate All

Start a **Practice** session and fly 2 to 3 complete laps through every gate. Open **Signals**, keep `All timers` selected, and tap **Calibrate all** so SlapRF computes tailored Enter and Exit thresholds for each gate at once.

{{% /steps %}}

## Reading Split Data

After flying a pack, open the **Laps** and **Trends** tabs in Practice to review performance across the track:

| View | What It Shows |
| :--- | :--- |
| Lap Table | Side-by-side `S1`, `S2`, `S3` splits for every lap alongside your Theoretical Best Lap (sum of your fastest individual splits). |
| Section Consistency | Per-section variance charts highlighting which obstacle or turn costs the most time across a pack. |
| Per-Gate Fine-Tune | Select an individual timer chip (such as `T2`) in **Signals** to adjust one tight or high-speed gate without changing the rest of the course. |
