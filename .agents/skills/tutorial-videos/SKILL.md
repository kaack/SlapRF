---
name: tutorial-videos
description: >-
  Generate, narrate, and update SlapRF 1080p 60 FPS tutorial walkthrough videos (< 5 minutes each)
  from the declarative manifest in web/src/data/tutorials.json using an isolated Xvfb virtual X11
  display, GPU-accelerated headed Chrome, 120 Hz libXtst OS cursor motion, edge-tts neural voice
  synthesis, and anti-banded ffmpeg H.264 mastering, then sync #/tutorials and /docs/tutorials/.
  Activate whenever adding, re-recording, or updating tutorial videos or YouTube channel assets.
---

# Generating SlapRF Tutorial Videos (`cmd/build-tutorials`)

SlapRF keeps every tutorial video's description, ordered steps, phrase-level (`beats[]`) voiceover scripts, and UI selectors in a single declarative manifest (`web/src/data/tutorials.json`), alongside tracked YouTube branding assets in `assets/youtube/`.

## 1. Source of Truth Architecture

- **Canonical Video Manifest (`web/src/data/tutorials.json`)**:
  - Defines channel metadata (`name`, `handle`, `url`), general-purpose catalog `categories` (`getting-started`, `practice`, `qualifying`, `race-setup`, `hardware`), and `videos[]`.
  - Each `videos[]` entry defines:
    - `id`, `title`, `category`, `categoryLabel`, `summary`, `tryHash`, `youtubeVideoId`, `outputFile`
    - `maxDurationSec: 300` (hard 5-minute ceiling enforced by `cmd/build-tutorials`)
    - `voice` (`en-US-AndrewNeural`), `voiceRate` (`+2%`), and `simSpeedMultiplier` (`8`)
    - `steps[]`: `id`, `startSec`, `badge`, `caption`, `narration` (step summary shown in the UI catalog), and `beats[]` (phrase-level narration + synchronized cursor actions).
- **YouTube Channel Branding Assets (`assets/youtube/` & `cmd/build-youtube-assets`)**:
  - Tracks `banner-waves-source.jpg`, `slaprf-youtube-avatar.png` (`1024x1024`), `slaprf-youtube-banner.png` (`2560x1440` with C1 wing taper and TPDF dithering), safe-zone crop previews, and channel copy in `assets/youtube/README.md`.
- **Hugo Mirror (`docs-site/data/tutorials.json`) & In-App View (`web/src/views/TutorialsView.ts`)**:
  - Synced automatically by `cmd/build-tutorials -update-timestamps` and `cmd/build-docs`.

---

## 2. Why `Xvfb` + Headed GPU Chrome + `x11grab` (`60 FPS`) Is Used

Never use headless Playwright `RecordVideo` for tutorial screencasts:
1. Headless `RecordVideo` samples variable-rate CDP frames (`~4-12 FPS`) and hides the OS cursor, producing choppy slideshow-like output and audio drift.
2. `cmd/build-tutorials` spins up an isolated `1920x1080` `Xvfb` display (`DISPLAY=:92..`), runs real headed Chrome in `--kiosk` mode with hardware GPU Skia dithering (`--ozone-platform=x11 --enable-gpu-rasterization --ignore-gpu-blocklist`), drives the native OS cursor (`DMZ-White`, `36px`) along `120 Hz` minimum-jerk human trajectories via `libXtst`, and records constant-60-FPS video via `ffmpeg -f x11grab -framerate 60 -draw_mouse 1`.
3. Final MP4 muxing applies `gradfun=strength=1.35:radius=16,noise=c0s=1:allf=t` and `-x264-params aq-mode=3:aq-strength=1.2:deblock=-1,-1` (`-crf 17`) so dark UI gradients remain free of 8-bit `yuv420p` banding.

---

## 3. Authoring Phrase-Synced `beats[]`

To keep voiceover and mouse motion naturally locked together without frozen pauses:
1. Split each step into **1 to 3 short spoken beats (`2.5s - 4.2s` each)** in `steps[].beats[]`.
2. Pair each beat with only the **1 or 2 UI actions** spoken in that sentence:
   - `{"type": "fill", "selector": "...", "value": "...", "typeDelayMs": 48}`: Glides to the input, clicks, and types character-by-character.
   - `{"type": "click", "selector": "...", "pauseBeforeMs": 180, "pauseAfterMs": 400}`: Glides along a curved minimum-jerk arc, hovers briefly so `:hover` highlights appear, and clicks.
   - `{"type": "hover", "selector": "...", "pauseAfterMs": 550}`: Glides the OS cursor onto a control to point it out visually.
   - `{"type": "clickIfVisible", "selector": "...", "pauseAfterMs": 300}`: Clicks an optional modal/button if visible.
   - `{"type": "openTemplates"}`: Opens the Race Setup template picker modal.
   - `{"type": "wireDrop", "fromSelector": "...", "optionId": "finals", "dx": 130, "dy": -175}`: Smoothly drags an output wire across the graph canvas and picks a `WireDropMenu` item.
   - `{"type": "runHeatFast", "minElapsedMs": 3000, "confirm": true}`: Starts the heat at `8x` simulation speed so live laps tick up visibly, then confirms results.

---

## 4. Recording & Reviewing Locally Before Uploading

```bash
# 1. Rebuild YouTube channel branding assets (optional, if banner/icon changed):
go run ./cmd/build-youtube-assets

# 2. Record all 1080p 60 FPS tutorials into ./_tutorials and update step timestamps:
go run ./cmd/build-tutorials -out ./_tutorials -update-timestamps

# 3. Verify 1920x1080 @ 60 FPS H.264 + AAC streams and < 300s duration:
for f in ./_tutorials/*.mp4; do
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of compact "$f"
done
```

Always have the user review the local `.mp4` files in `./_tutorials/` before uploading to YouTube. Once approved and uploaded, set each `"youtubeVideoId"` in `web/src/data/tutorials.json`, run `cmd/build-docs`, and run `go test ./...`.
