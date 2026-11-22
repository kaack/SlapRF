---
name: doc-screenshots
description: >-
  Generate high-DPI 2x Retina dark-mode and light-mode application screenshots for README.md and
  Hugo documentation using Playwright-Go against a seeded SlapRF showcase server. Activate whenever
  capturing, updating, or replacing product screenshots in docs/ or docs-site/static/images/.
---

# High-DPI (`2x` Retina) Documentation & README Screenshots

SlapRF uses paired `2x` Retina (`DeviceScaleFactor: 2.0`, `2880 px` wide) Dark and Light screenshots in `README.md` (`docs/slaprf-*-2x-{dark,light}.png`) and `docs-site/static/images/`.

Use [capture_retina.go](./scripts/capture_retina.go) (`//go:build ignore`) so screenshots are always reproducible, crisp, seeded with live demo telemetry, and clipped to identical dimensions across Dark and Light themes.

## 1. Prerequisites

Ensure Playwright's Chromium binary is installed once (see `dev-setup` skill):
```bash
go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
```

## 2. Regenerate All 6 `README.md` Showcase Screenshots

Run from the repository root:
```bash
go run .agents/skills/doc-screenshots/scripts/capture_retina.go
```
What this script automates:
1. Builds the latest web UI into a temporary directory (and resets `internal/api/generated/version.json`).
2. Starts an isolated `portable.NewServer`, restores the showcase dataset (`POST /v1/storage:restoreDemo`), connects simulated USB Hub `H1` (`PUT /v1/sim/slaprf/hub-usb`), and starts live 50 Hz telemetry (`PATCH /v1/sim`).
3. Opens Chromium at `1440px` CSS width with `DeviceScaleFactor: 2.0` (`2880 px` Retina output), waits for `document.fonts.ready` + live lap sparklines/RSSI bars, blurs active focus rings, and parks the cursor at `(5, 5)` so no hover tooltips appear.
4. Captures matched `-dark.png` and `-light.png` pairs with identical clip heights:
   - `docs/slaprf-practice-2x-{dark,light}.png` (`#/practice/open-track-practice`, tight bottom clip)
   - `docs/slaprf-bracket-2x-{dark,light}.png` (`#/races/bay-area-championship/format/stage-1` after clicking `Fit view`, `2880x1668`)
   - `docs/slaprf-cockpit-2x-{dark,light}.png` (`#/races/bay-area-championship/control` with unclipped workspace tab bar, `2880x1668`)

## 3. Capture Custom Routes for `docs-site` or PRs

Pass `-route`, `-out`, and `-selector` to capture any route as a matched `<out>-dark.png` + `<out>-light.png` pair:
```bash
go run .agents/skills/doc-screenshots/scripts/capture_retina.go \
  -route "#/network" \
  -out docs-site/static/images/network-overview-2x \
  -selector ".card, .panel" \
  -width 1440 \
  -height 900
```
If you already built a WASM-free site directory, pass `-site <dir>` to skip rebuilding.

## 4. Embedding Theme-Aware Pairs in Markdown

### In `README.md` (GitHub `#gh-dark-mode-only` / `#gh-light-mode-only`)
```html
<a href="docs/slaprf-practice-2x-dark.png?raw=1#gh-dark-mode-only">
  <img src="docs/slaprf-practice-2x-dark.png#gh-dark-mode-only" alt="SlapRF Practice and Section Splits" />
</a>
<a href="docs/slaprf-practice-2x-light.png?raw=1#gh-light-mode-only">
  <img src="docs/slaprf-practice-2x-light.png#gh-light-mode-only" alt="SlapRF Practice and Section Splits" />
</a>
```

## 5. Visual Quality Verification
Always inspect every generated PNG (`read_file` on the image) before committing to confirm:
- No loading spinners, disconnected banners, focus outlines, or stray hover tooltips.
- Workspace tab bars and bracket nodes are unclipped (`Fit view` applied on bracket canvases).
- Dark and Light pairs have identical pixel dimensions so theme switching never shifts page layout.
