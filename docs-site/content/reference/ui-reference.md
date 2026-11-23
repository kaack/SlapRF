---
title: App & UI Reference
weight: 1
---

Reference guide to the screens, live signal scope controls, and crossing detection parameters in the SlapRF Timing Application.

## App Screens

| Screen | Purpose |
| :--- | :--- |
| Practice | Practice session directory and workspace (`Pilots`, **Track**, `Overview`, `Laps`, `Trends`, `Signals`, and `Analytics`). Each session stores its own track layout and timing rules. |
| Races | Event creation, MultiGP import, per-race **Track** & timing rules editor, visual Format Canvas brackets, live Marshal / Race Control horns, and Review waveforms. |
| Pilots | Pilot directory with callsigns, phonetic TTS spellings, and default 5.8 GHz channels (`Raceband`, `Fatshark`, `Boscam`, `IMD6`). |
| Network | Timing system selector (`SlapRF (USB)`, `SlapRF (Bluetooth)`, `LapRF 8-Way (Network)`, `LapRF 8-Way (USB)`, `RotorHazard (Network)`, `RotorHazard (USB)`), connection manager, topology graph, and live RSSI monitor. |
| Flasher | Built-in wizard (on Android and desktop) for flashing Hub and Spoke firmware, inspecting board configuration, or factory-erasing boards over USB-C. |
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

## Crossing Rules

SlapRF runs a hysteresis detector (`Enter dBm` -> peak tracking -> `Exit dBm`) governed by per-track timing rules configured in each Practice session or Race **Track** tab, with optional per-timer and per-pilot-at-timer overrides in **Track** and **Signals -> Fine-tune**:

| Parameter | Role |
| :--- | :--- |
| Enter Threshold (`dBm`) | RSSI level required to open a crossing window. |
| Exit Threshold (`dBm`) | RSSI level required to close the crossing window and record the peak timestamp (`6` to `12 dBm` below Enter prevents double-counting). |
| Min Crossing Time (`s`) | Minimum duration RSSI must remain inside the crossing window, rejecting brief single-sample RF noise spikes (`SPIKE`). |
| Min Lap Time (`s`) | Minimum valid lap time between consecutive Start / Finish crossings for the same pilot (`MIN_LAP`). |
| Max Lap Time (`s`) | Maximum duration before a long pause (such as landing to swap batteries) starts a fresh out-lap instead of recording a slow lap (`LAP_TOO_LONG`). |
| Beep on Cross | Plays an immediate low-latency audio tone when a crossing registers, ahead of the spoken lap callout. |
