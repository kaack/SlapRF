---
name: tutorial-videos
description: >-
  Generate, narrate, and update SlapRF tutorial walkthrough videos (< 5 minutes each) from the
  declarative manifest in web/src/data/tutorials.json using Playwright-Go, edge-tts neural voice
  synthesis, and ffmpeg, then sync the embedded YouTube catalog in #/tutorials and /docs/tutorials/.
  Activate whenever adding, re-recording, or updating tutorial videos or YouTube channel assets.
---

# Generating SlapRF Tutorial Videos (`cmd/build-tutorials`)

SlapRF keeps every tutorial video's description, ordered steps, UI selectors, and spoken voiceover script in a single declarative manifest so any video can be regenerated whenever UI workflows change.

## 1. Source of Truth Architecture

- **Canonical Manifest (`web/src/data/tutorials.json`)**:
  - Defines channel metadata (`name`, `handle`, `url`), general-purpose catalog `categories` (`getting-started`, `practice`, `qualifying`, `race-setup`, `hardware`), and `videos[]`.
  - Every entry in `videos[]` defines:
    - `id`, `title`, `category`, `categoryLabel`, `summary`, `tryHash`, `youtubeVideoId`, `outputFile`
    - `maxDurationSec: 300` (hard 5-minute ceiling enforced by `cmd/build-tutorials`)
    - `voice` (`en-US-AndrewNeural`) and `voiceRate` (`+4%`)
    - `steps[]`: `id`, `startSec`, `badge`, `caption`, `narration` (synthesized into speech), and `actions[]` (Playwright UI steps).
- **Hugo Mirror (`docs-site/data/tutorials.json`)**:
  - Automatically synced by both `cmd/build-tutorials -update-timestamps` and `cmd/build-docs`, powering `{{< tutorial-catalog >}}` on `/docs/tutorials/`.
- **In-App Catalog (`web/src/views/TutorialsView.ts`)**:
  - Served at `#/tutorials` (and `#/tutorials/<video-id>`), embedding `youtube-nocookie.com/embed/<youtubeVideoId>` with clickable step timestamps.

---

## 2. Prerequisites

Verify that the local environment provides:
1. **Playwright Chromium** (same browser used by `e2e/` tests)
2. **`ffmpeg` & `ffprobe`** (`ffmpeg -version`)
3. **`edge-tts`** (either installed directly or invoked automatically via `~/.local/bin/uvx edge-tts`)

---

## 3. Authoring or Updating a Tutorial

1. **Follow `technical-writing-ste` in `summary`, `caption`, and `narration`**:
   - Keep `narration` concise (1 to 2 short active-voice sentences per step, zero em-dashes, no filler words).
   - Keep total runtime strictly **under 5 minutes (`< 300s`)**; aim for **60 to 150 seconds** per focused workflow.
2. **Supported Declarative Step Actions (`steps[].actions[]`)**:
   - `{"type": "goto", "url": "/#/races"}`: Navigate within the isolated server.
   - `{"type": "fill", "selector": "...", "value": "..."}`: Fill an input field.
   - `{"type": "click", "selector": "...", "pauseBeforeMs": 300, "pauseAfterMs": 550}`: Smoothly move the highlighted cursor ring to `selector` and click.
   - `{"type": "clickIfVisible", "selector": "...", "pauseAfterMs": 350}`: Click an optional modal/button if visible within 900 ms.
   - `{"type": "openTemplates"}`: Open the Race Setup template picker modal (expanding board controls if collapsed).
   - `{"type": "wireDrop", "fromSelector": "...", "optionId": "finals", "dx": 36, "dy": -190}`: Drag a round output port wire onto the graph canvas and pick a `WireDropMenu` item.
   - `{"type": "runHeatFast", "minElapsedMs": 2200, "confirm": true}`: Start the active heat at accelerated simulation speed, wait for simulated laps, finish, and optionally confirm results.
   - `{"type": "wait", "ms": 1000}`: Hold on the current screen.

---

## 4. Recording & Verifying Videos Locally

```bash
# Render all tutorials into ./_tutorials and write measured durations + step timestamps back to tutorials.json:
go run ./cmd/build-tutorials -out ./_tutorials -update-timestamps

# Or re-record a single tutorial by ID:
go run ./cmd/build-tutorials -id open-qualifier -out ./_tutorials -update-timestamps

# Verify video + AAC audio streams and < 300s duration:
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -show_entries format=duration -of compact ./_tutorials/*.mp4
```

After uploading new or updated `.mp4` files to the official `@SlapRF` YouTube channel:
1. Set each video's `"youtubeVideoId"` in `web/src/data/tutorials.json`.
2. Rebuild docs (`go run ./cmd/build-docs -web ./web -docs ./docs-site -out ./_site/docs -base-url /docs/ -skip-firmware`) so `docs-site/data/tutorials.json` stays identical.
3. Run `go test ./...` before committing.
