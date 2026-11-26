---
title: App & UI Reference
weight: 1
---

Reference guide to the screens, live signal scope controls, and crossing detection parameters in the SlapRF Timing Application.

## App Screens

| Screen | Purpose |
| :--- | :--- |
| Practice | Practice session directory and workspace (`Pilots`, **Track**, `Overview`, `Laps`, `Trends`, `Signals`, `Review`, `Analytics`, and `AI Training`). Each session stores its own track layout, `.rfbin` waveform trace, and timing rules. |
| Races | Event creation, MultiGP import, per-race **Track** & timing rules editor, visual Format Canvas brackets, live Marshal / Race Control horns, and Review waveforms. |
| Pilots | Pilot directory with callsigns, phonetic TTS spellings, and default 5.8 GHz channels (`Raceband`, `Fatshark`, `Boscam`, `IMD6`). |
| Network | Timing system selector (`SlapRF (USB)`, `SlapRF (Bluetooth)`, `SlapRF (Network)`, `LapRF 8-Way (Network)`, `LapRF 8-Way (USB)`, `RotorHazard (Network)`, `RotorHazard (USB)`), connection manager, topology graph, and live RSSI monitor. |
| Flasher | Built-in wizard (on Android and desktop) for flashing Hub, Spoke, and ESP32-P4 PoE Bridge firmware, inspecting board configuration, or factory-erasing boards over USB-C. |
| Debug | Live 5.8 GHz spectrum and waterfall analyzer, raw USB/Bluetooth timer console, and RF health checks. |
| Simulator | Multi-pilot 5.8 GHz physics track simulator for testing track layouts, threshold behavior, and race brackets without hardware. |
| Settings | Datasource (Demo vs. SlapRF Server and Simulator toggle), MultiGP API key, Announcer voice & horn levels, LapRF 8-Way emulator, Authentication, `.json` database backup/restore, and `slaprf.log` diagnostic log level (`ERROR` to `TRACE`), download, and clear controls. |

On mobile, swipe left or right across the screen to move between **Races**, **Practice**, **Pilots**, **Network**, and secondary screens, or tap **More** on the right side of the bottom bar.

## Signals Controls

Available inside **Practice -> Signals** and **Race -> Signals**:

| Control | Behavior |
| :--- | :--- |
| `Prev \| Live \| Next` | Pause and scrub backward or forward through recorded RSSI history, or return to live streaming. |
| `Auto X` | Switch the horizontal scope span between `1 s`, `15 s`, `60 s`, `5 min`, `10 min`, or automatic fit. |
| `Auto Y` | Toggle automatic vertical dBm range fitting versus full dBm scale. |
| Timer Chips / Rows | Filter by `All`, `H1`, or `T1`-`T6` to inspect Enter and Exit lines. Select an individual timer (or use its row actions on mobile) to calibrate or open **Fine-tune**. |
| `Calibrate` | Appears for a selected timer once flight pass data is recorded. Computes Enter and Exit dBm levels from recent passes, with `Clear calibration` to restore defaults. |

## Crossing Detection & Rules

Each Practice session and Race **Track** tab includes a **Crossing detector** card that switches between **AI** mode and traditional **DSP** mode (see [AI Crossing Detection & Training](../../journeys/ai-crossing-detection)):
- **AI Mode**: Evaluates `5.8 GHz` RSSI waveforms with the built-in **`SlapRF Base (1P)`** neural model or a user-trained custom model from **Practice -> AI Training**, with an optional **`2L Tune`** adaptive head toggle and `Off | On` crossing beeps.
- **DSP Mode**: Runs a traditional hysteresis detector (`Enter dBm` -> peak tracking -> `Exit dBm`) with per-track, per-timer, and per-pilot-at-timer overrides in **Track** and **Signals -> Fine-tune**.

| Parameter | Role |
| :--- | :--- |
| Detector Mode (`AI` / `DSP`) | Selects neural waveform pass detection (`SlapRF Base` or custom model) or traditional `Enter` / `Exit` dBm threshold hysteresis. |
| Enter Threshold (`dBm`, DSP) | RSSI level required to open a crossing window in **DSP** mode. |
| Exit Threshold (`dBm`, DSP) | RSSI level required to close the crossing window and record the peak timestamp in **DSP** mode (`6` to `12 dBm` below Enter prevents double-counting). |
| Min Crossing Time (`s`, DSP) | Minimum duration RSSI must remain inside the **DSP** crossing window, rejecting brief single-sample RF spikes (`SHORT`). |
| Min Lap Time (`s`) | Minimum valid lap time between consecutive Start / Finish crossings for the same pilot (`SHORT`). |
| Max Lap Time (`s`) | Maximum duration before a long pause (such as landing to swap batteries) starts a fresh out-lap instead of recording a slow lap (`LONG`). |
| Beep on Crossing | Plays an immediate confirmation tone when a gate crossing registers (`Off \| On` in **AI** mode; `Off \| Enter \| Peak \| Exit` in **DSP** mode). |
