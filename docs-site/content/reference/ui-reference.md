---
title: App & UI Reference
weight: 1
---

Reference guide to the screens, live signal scope controls, and crossing detection parameters in the SlapRF Timing Application.

## App Screens

| Screen | Purpose |
| :--- | :--- |
| Practice | Open or timed practice sessions with live lap tables, **Signals** (5.8 GHz RSSI scope and calibration), and **Trends** (progression and split consistency charts). |
| Races | Event creation, MultiGP import, visual Format Canvas brackets, live Race Control horns, and Marshal Review waveforms. |
| Pilots | Pilot directory with callsigns, phonetic TTS spellings, and default 5.8 GHz channels (`Raceband`, `Fatshark`, `Boscam`, `IMD6`). |
| Track | Visual course loop editor for ordering active gate timers (`H1`, `T1`-`T6`) and marking the Start / Finish gate. |
| Network | Connection manager and live packet-rate monitor for SlapRF Bluetooth Hub, SlapRF USB Hub, RotorHazard, and LapRF 8-Way. |
| Flasher | Desktop WebSerial wizard for flashing Hub and Spoke firmware, inspecting board configuration, or factory-erasing boards. |
| Simulator | Multi-pilot 5.8 GHz physics track simulator for testing track layouts, threshold behavior, and race brackets without hardware. |
| Settings | Hardware backend selector, Announcer voice & horn levels, MultiGP API key, HTTP Basic Auth, theme toggle, and `.json` database backup/restore. |

## Signals Controls

Available inside **Practice -> Signals** and **Race -> Signals**:

| Control | Behavior |
| :--- | :--- |
| `Prev \| Live \| Next` | Pause and scrub backward or forward through recorded RSSI history, or return to live streaming. |
| `Auto X` | Switch the horizontal scope span between `1 s`, `15 s`, `60 s`, `5 min`, `10 min`, or automatic fit. |
| `Auto Y` | Toggle automatic vertical dBm range fitting versus full dBm scale. |
| Timer Chips | Filter by `All`, `H1`, or `T1`-`T6` to view or edit Enter and Exit lines. A blue pencil icon marks chips with custom overrides. |
| `Calibrate` | Compute optimal Enter and Exit dBm levels from recent flight passes, or tap `Clear calibration` to restore defaults. |

## Crossing Rules

SlapRF runs a hysteresis detector (`Enter dBm` -> peak tracking -> `Exit dBm`) governed by global rules that can also be overridden per gate in **Fine-tune**:

| Parameter | Role |
| :--- | :--- |
| Enter Threshold (`dBm`) | RSSI level required to open a crossing window. |
| Exit Threshold (`dBm`) | RSSI level required to close the crossing window and record the peak timestamp (`6` to `12 dBm` below Enter prevents double-counting). |
| Min Crossing Time (`s`) | Minimum duration RSSI must remain inside the crossing window, rejecting brief single-sample RF noise spikes (`SPIKE`). |
| Min Lap Time (`s`) | Minimum valid lap time between consecutive Start / Finish crossings for the same pilot (`MIN_LAP`). |
| Max Lap Time (`s`) | Maximum duration before a long pause (such as landing to swap batteries) starts a fresh out-lap instead of recording a slow lap (`LAP_TOO_LONG`). |
| Beep on Cross | Plays an immediate low-latency audio tone when a crossing registers, ahead of the spoken lap callout. |
