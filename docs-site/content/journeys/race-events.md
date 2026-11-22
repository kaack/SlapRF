---
title: Running a Race Event
weight: 3
---

SlapRF includes a full race control workspace for club races, qualifiers, elimination brackets, and MultiGP chapter events.

## Create or Import

Open **Races** from the main navigation to start a new event:

| Option | Workflow |
| :--- | :--- |
| Built-in Templates | Start from Qualifying + Finals, Double Elimination, Single Elimination, Open Qualifier, Points Mains, Chase the Ace, or a Blank Custom Format. |
| MultiGP Import | Add your chapter API key in **Settings -> MultiGP** to pull registered pilots, VTX channels, and event rounds directly from MultiGP. |

## Track & Timing Rules

Inside an event workspace, open **Track** to configure the course for that specific race:

- Drag active timers (`H1`, `T1`-`T6`, RotorHazard, or LapRF units) onto the track line in flight order and click the checkered flag under the Start / Finish gate.
- Set track-wide **Timing rules** (`Min lap time`, `Max lap time`, `Min crossing time`, and `Beep on crossing`), or select an individual timer chip to override rules for a single gate.

Each race stores its own track and timing rules independently from practice sessions and other races. When a race is completed or scrapped, its recorded track and timing rules lock read-only.

## Format & Heats

Inside an event workspace, open **Setup** to configure stages, advancement rules, and heat lineups using either editor:

- **Format Canvas**: Drag stage nodes and connect advancement wires visually (for example, routing Top 8 from Qualifying to Championship Double Elimination and 9th-16th to Consolation).
- **Setup Table**: Edit heat counts, pilot slots, VTX channels, heat duration, and scoring format (Fastest 3 Consecutive, Single Fastest Lap, Total Laps + Time, Points, or Chase the Ace).

> [!TIP]
> Enable **Simulator** mode before race day to test custom stage progressions, advancement rules, and heat tie-breakers end to end without hardware.

## Live Race Control

Switch to the **Race** tab when pilots step up to the flight line:

1. Select the upcoming heat and confirm pilot VTX channel assignments.
2. Click **Start Heat**. SlapRF plays the staging callout, runs the configured start delay, sounds the start horn, and arms crossing detection.
3. During the heat, live standings, split deltas, and spoken lead/lap announcements update in real time. When the clock expires, the finish horn sounds while timing stays open until active pilots finish their current lap.
4. Click **Next Heat** to advance; when a stage completes, downstream brackets seed automatically.

## Marshal Review

When a pilot challenges a missed crossing or an early launch, open the completed heat's review panel in **Race Control** to inspect the recorded Start / Finish RSSI waveform alongside every crossing marker. Race directors can invalidate a false pass, insert a missed crossing at its exact waveform peak, or schedule a re-run, with standings updating immediately.

## Results & MultiGP

Open the podium view at any time to inspect overall event standings. For MultiGP chapter races, click **Upload to MultiGP** to publish completed round times and final placements back to your MultiGP event page.
