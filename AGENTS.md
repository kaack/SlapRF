# SlapRF Agent Engineering Guide

Technical architecture, build entrypoints, and repository guardrails for AI coding agents working on SlapRF.

## Architecture Map

SlapRF shares a single Go timing engine and TypeScript web UI across desktop, mobile, browser-only demo, and ESP32-C5 hardware targets:

- `internal/`: Core Go packages (`domain`, `dsp`, `tracker`, `race`, `ingest`, `firmware`, `usb`, `laprf`, `rotorhazard`, `multigp`, `api`, `storage`, `portable`, `devbundle`).
- `web/`: Zero-framework TypeScript SPA (`web/src/`), styles (`web/styles/`), firmware asset staging (`web/firmware/`), and Chromium unit tests (`web/src/__tests__/`). Bundled directly by Go via `github.com/evanw/esbuild` (no `npm install` or `node_modules` required for web builds).
- `docs-site/`: Hugo Extended (`0.170.1`, Hextra) documentation site served under `/docs/`, including an embedded WebSerial flasher (`cmd/build-docs`).
- `cmd/devserver/`: Local development server (`127.0.0.1:8090`) that compiles TypeScript and WASM on the fly with `Cache-Control: no-store`.
- `cmd/slaprf/`: Single-file cross-platform native Go server ("SlapRF Portable") embedding the compiled web UI (`cmd/slaprf/site/`).
- `cmd/slaprf-wasm/`: Standalone browser demo engine compiled to `GOOS=js GOARCH=wasm` (`slaprf.wasm`) for `https://slaprf.app`.
- `cmd/slaprf-android/` & `android/`: Native Android host (`libslaprf.so` + Java USB/BLE/WebView shims) packaged into a signed APK without Gradle by `cmd/build-android`.
- `firmware/`: ESP-IDF `v5.5.1` C projects for Seeed Studio XIAO ESP32-C5 (`firmware/slaprf` for USB Hub/Spokes and `firmware/slaprf_ble` for Bluetooth Hub) plus Python/PowerShell bench utilities in `firmware/tools/`.
- `e2e/`: Playwright-Go end-to-end verification suite (`-tags=e2e`) covering REST/WASM API parity, UI components, and full race workflows.

## Repository Guardrails

1. **Protected Tracked Assets**:
   - `web/firmware/slaprf-xiao-c5.bin` is force-tracked in git even though `web/firmware/*.bin` is in `.gitignore`. Never delete it or overwrite it with a synthetic placeholder image.
   - `cmd/slaprf/site/.keep` and `cmd/slaprf-android/site/.keep` are required so `//go:embed all:site` compiles on a clean checkout. Always preserve them.
2. **Generated Version Stamp**:
   - Running `cmd/build-web` updates the build timestamp in `internal/api/generated/version.json`. Before committing source changes, revert timestamp-only diffs with `git checkout -- internal/api/generated/version.json`.
3. **Windows Directory Locks on `_site`**:
   - `cmd/build-web` runs `os.RemoveAll("./_site")`. Never start a static file server with `./_site` as its current working directory on Windows; serve from the repo root (for example `python -m http.server 8099 --bind 127.0.0.1 -d ./_site`).
4. **Evidence-First UI Debugging**:
   - When diagnosing live browser UI, canvas, WebSerial, or WASM bugs, inspect runtime state over Chrome DevTools Protocol (`live-chrome-cdp` skill) before guessing from static code, and verify the fix in the live browser.
5. **Git Checkpointing, Conventional Commits & Rebase Hygiene**:
   - Commit locally early and often at logical, tested milestones using **Conventional Commits** (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `ci: ...`, `test: ...`, `chore: ...`) so work-in-progress is never lost, even when holding `git push` for user preview.
   - Stage explicit file paths (never blind `git add -A`), and rebase/autosquash noisy unpushed fixup commits onto `origin/main` before pushing (`git-and-github-hygiene` skill).

## On-Demand AI SDLC Skills (`.agents/skills/`)

Activate the relevant skill below whenever a task involves environment setup, building/testing, API/protocol changes, UI performance, browser debugging, documentation/STE writing, screenshots, Android deployment, firmware, hardware bench debugging, Git hygiene, or CI/releases:

- `dev-setup` (`.agents/skills/dev-setup/SKILL.md`): Install and verify Go, Hugo Extended, Playwright Chromium, `gh`, Python `pyserial`/`esptool`, Android SDK/NDK/JDK 17, and ESP-IDF `v5.5.1`.
- `build-and-test` (`.agents/skills/build-and-test/SKILL.md`): Run `devserver`, build web/docs/portable/Android targets, and execute Go, frontend, and Playwright E2E test suites.
- `api-and-specs-sync` (`.agents/skills/api-and-specs-sync/SKILL.md`): Keep `/v1` Go REST/WS handlers, WASM bridge, IndexedDB persistence, TypeScript models, and OpenAPI 3.1 / AsyncAPI 3.0 specs in lockstep.
- `wire-protocols-and-sim-parity` (`.agents/skills/wire-protocols-and-sim-parity/SKILL.md`): Maintain byte-level parity across ESP32-C5 `0xC5` / `SLAPRF02` C structs, Go decoders, Android USB/BLE shims, RotorHazard/LapRF links, and simulators.
- `realtime-ui-and-mobile-perf` (`.agents/skills/realtime-ui-and-mobile-perf/SKILL.md`): 60 FPS canvas telemetry rules, cached view `onActivate`/`onDeactivate` lifecycle, gesture-safe audio/TTS unlock, and mobile touch UX.
- `live-chrome-cdp` (`.agents/skills/live-chrome-cdp/SKILL.md`): Attach to the user's visible Chrome session over CDP to inspect DOM, canvas, store, and WASM state in real time.
- `technical-writing-ste` (`.agents/skills/technical-writing-ste/SKILL.md`): ASD-STE100 Simplified Technical English rules and anti-AI-slop guardrails for `README.md`, `docs-site/`, API specs, and UI copy.
- `docs-site-authoring` (`.agents/skills/docs-site-authoring/SKILL.md`): Hugo + Hextra shortcodes (`themed-image`, `web-flasher`, `api-spec-viewer`), 3-way `Light`/`Auto`/`Dark` theme switcher, dark-slate diagrams, and `cmd/build-docs`.
- `doc-screenshots` (`.agents/skills/doc-screenshots/SKILL.md`): Generate crisp `2x` Retina matched Dark and Light screenshots for `README.md` and `docs-site/` via `capture_retina.go`.
- `android-wifi-deploy` (`.agents/skills/android-wifi-deploy/SKILL.md`): Build the signed Android APK, pair/connect wireless `adb` over Wi-Fi, install/launch `app.slaprf`, stream `logcat`, and attach CDP to the Android WebView.
- `esp32c5-firmware-build` (`.agents/skills/esp32c5-firmware-build/SKILL.md`): Compile `slaprf-xiao-c5.bin` (USB/Spoke) and `slaprf-xiao-c5-ble.bin` (Bluetooth Hub) locally with ESP-IDF `v5.5.1` or fetch CI build artifacts.
- `usb-timer-debug-and-flash` (`.agents/skills/usb-timer-debug-and-flash/SKILL.md`): Discover XIAO ESP32-C5 USB ports, avoid port locks and `usbser.sys` boot-latch pitfalls, flash/patch `SLAPRF02` images, and run live USB console/RF diagnostics.
- `git-and-github-hygiene` (`.agents/skills/git-and-github-hygiene/SKILL.md`): Conventional Commits conventions, frequent local checkpoint commits, staging discipline, and rebasing/autosquashing before pushing.
- `ci-and-release` (`.agents/skills/ci-and-release/SKILL.md`): Trigger and monitor GitHub Actions workflows (`verify`, `docs`, `pages`, `firmware`, `release`) and publish `vX.Y.Z` releases.
