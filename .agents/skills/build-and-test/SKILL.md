---
name: build-and-test
description: >-
  Build, serve, and test all SlapRF targets: live devserver (Portable Go backend mode and Pure
  Browser WASM Demo mode), static GitHub Pages bundle (cmd/build-web), Hugo docs (cmd/build-docs),
  cross-platform SlapRF Portable binaries (cmd/build-portable), unit tests (go test ./...), and
  Playwright E2E suites (scripts/test-e2e.*). Activate before building artifacts or running tests.
---

# Building, Serving & Testing SlapRF

Always run commands from the repository root. No `npm` build step is required; Go compiles TypeScript directly via `github.com/evanw/esbuild`.

## 1. Local Development Servers

### SlapRF Dev Server (`cmd/devserver`, Port `8090`)
Rebuilds `/dist/app.js` and `/wasm/slaprf.wasm` on the fly with `Cache-Control: no-store` (no Service Worker caching issues):

```bash
# Default: Portable Go Server Mode (/v1/* REST + WebSocket backend enabled)
go run -ldflags="-s -w" ./cmd/devserver -web ./web -addr 127.0.0.1:8090

# Pure Browser Demo Mode (disables Go /v1/* routes to match https://slaprf.app WASM + IndexedDB)
go run -ldflags="-s -w" ./cmd/devserver -web ./web -addr 127.0.0.1:8090 -browser
```

### Hugo Documentation Live Server (`docs-site`, Port `1313`)
First build the embedded docs WebSerial flasher assets once (`cmd/build-docs`), then run Hugo:
```bash
go run ./cmd/build-docs -web ./web -docs ./docs-site -out ./_site/docs -base-url /docs/ -skip-firmware
cd docs-site && hugo server -D --port 1313 --bind 127.0.0.1 --baseURL http://127.0.0.1:1313/docs/ --disableFastRender
```

---

## 2. Production & Static Bundle Builds

### Static Site + WASM Demo + Docs (`./_site`)
Builds the exact static bundle deployed to `https://slaprf.app`:
```bash
go run ./cmd/build-web -web ./web -out ./_site
git checkout -- internal/api/generated/version.json
```
Useful flags:
- `-skip-docs`: Skip Hugo docs build into `_site/docs` (faster UI-only iteration).
- `-skip-wasm`: Omit `wasm/slaprf.wasm` (used when embedding into native Go server or Android APK).

**Windows Pitfall (Directory Lock on `./_site`)**:
`cmd/build-web` deletes `./_site` via `os.RemoveAll`. Never `cd _site` before starting `python -m http.server` on Windows, or `os.RemoveAll` will fail with `The process cannot access the file because it is being used by another process`. Instead, serve from the repo root with `-d`:
```bash
python -m http.server 8099 --bind 127.0.0.1 -d ./_site
```

### Docs-Only Build (`./_site/docs`)
```bash
go run ./cmd/build-docs -web ./web -docs ./docs-site -out ./_site/docs -base-url /docs/ -skip-firmware
```

### SlapRF Portable Single-File Server (`cmd/build-portable`)
Builds the web assets into `cmd/slaprf/site/` (preserving `.keep`) and compiles `./cmd/slaprf`:
```bash
# Host OS/arch binary
go run ./cmd/build-portable -out ./dist/slaprf -version dev

# Cross-compile Linux / Windows from any OS (CGO_ENABLED=0; WinRT & BlueZ D-Bus BLE are pure Go)
go run ./cmd/build-portable -goos linux -goarch arm64 -out ./dist/slaprf-linux-arm64 -version v0.0.11

# Build macOS arm64 & amd64 ON a macOS host (enables CGO_ENABLED=1 + CoreBluetooth BLE)
go run ./cmd/build-portable -skip-web -goos darwin -goarch arm64 -out ./dist/slaprf-macos-arm64 -version v0.0.11
go run ./cmd/build-portable -skip-web -goos darwin -goarch amd64 -out ./dist/slaprf-macos-amd64 -version v0.0.11
```
- **Platform BLE / Cgo Rule**:
  - **Windows & Linux**: Compiled with `CGO_ENABLED=0` (`tinygo.org/x/bluetooth` uses WinRT and BlueZ over D-Bus in pure Go).
  - **macOS (`darwin/arm64` & `darwin/amd64`)**: Must be built on a **macOS host** (`runtime.GOOS == "darwin"`). `cmd/build-portable` automatically sets `CGO_ENABLED=1`, `MACOSX_DEPLOYMENT_TARGET=13.0`, embeds `cmd/slaprf/macos-info.plist` (`-Wl,-sectcreate,__TEXT,__info_plist,...` with `NSBluetoothAlwaysUsageDescription`), passes `CC="clang -arch x86_64"` when cross-building `amd64` on Apple Silicon, and runs `codesign -s - --force`. Cross-compiling `darwin` from Windows or Linux falls back to `ports_ble_stub.go` (no Bluetooth LE support).
- Flags: `-skip-web` (reuse existing `cmd/slaprf/site`), `-skip-wasm` (omit pure-browser fallback WASM).

---

## 3. Running Tests

### Fast Unit Suite (Go Packages + Headless Chromium Frontend Tests)
```bash
go test ./...
```
- `go test ./web/...` bundles `web/src/__tests__/*.test.ts` and runs all frontend unit tests inside headless Chrome/Edge in ~4 seconds.
- **Frontend Test Isolation Note**: All `web/src/__tests__/` specs run in a single browser page session. Chromium throttles `history.pushState`/`replaceState` after 100 calls per 10 seconds; always use router helpers (`pushAppHash`, `replaceAppHash`, and `resetTestEnvironment()` in `web/src/__tests__/harness.ts`) so URL hash changes fall back cleanly when rate-limited.

### Playwright End-to-End Verification Suite (`e2e/`)
Runs full browser + WASM + Portable API parity, component tests, and multi-heat tournament workflows, outputting an HTML report with videos and Playwright traces at `test-results/latest.html`:

**Windows (PowerShell)**:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1 -Run "TestWorkflow_Race" -SkipBuild
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1 -ComponentOnly -SkipBuild
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1 -ApiOnly -SkipBuild
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1 -Headed -SlowMo 150 -Run "TestComponent_"
```

**macOS / Linux**:
```bash
bash ./scripts/test-e2e.sh
bash ./scripts/test-e2e.sh --run "TestWorkflow_Race" --skip-build
bash ./scripts/test-e2e.sh --component-only --skip-build
bash ./scripts/test-e2e.sh --api-only --skip-build
```

## 4. Pre-Commit Hygiene Check
Before staging and committing:
1. Revert timestamp-only edits to `internal/api/generated/version.json`:
   ```bash
   git checkout -- internal/api/generated/version.json
   ```
2. Confirm `web/firmware/slaprf-xiao-c5.bin`, `cmd/slaprf/site/.keep`, and `cmd/slaprf-android/site/.keep` are intact (`git status -s`).
