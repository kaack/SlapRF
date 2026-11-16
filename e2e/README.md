# SlapRF E2E Verification Suite (`e2e/`)

Pure-Go end-to-end verification & regression harness covering **84 tests** (**22 in-browser WASM HTTP API & E2E race format tests** + **52 single-component UI unit tests** + **10 full-stack workflow scenarios**) using `github.com/playwright-community/playwright-go` (`v0.5700.1`, zero Node.js / npm dependencies).

Runs automatically in GitHub Actions ([`.github/workflows/verify.yml`](../.github/workflows/verify.yml)) on pushes/PRs to `main` and as a mandatory release gate in [`.github/workflows/release.yml`](../.github/workflows/release.yml) and [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) before any Portable binary or GitHub Pages update (`slaprf.app`) is published.

## Architecture

1. **Fresh Build & Ephemeral Server (`TestMain`):**
   - Automatically builds `_site/` (`TypeScript` bundle + Go `slaprf.wasm` engine via `go run ./cmd/build-web`) unless `-SkipBuild` / `SLAPRF_E2E_SKIP_BUILD=1` is passed.
   - Ensures all deterministic JSON snapshot fixtures exist in `e2e/testdata/*.json` (or regenerates them when `-RegenSnapshots` / `SLAPRF_E2E_REGEN_SNAPSHOTS=1` is passed).
   - Starts an in-process `portable.Server` on `127.0.0.1:0` (plus `GET /__e2e_seed` for fast same-origin IndexedDB + `localStorage` seeding before WASM boots).
2. **In-Browser HTTP / Curl Bridge (`window.slaprfCurl` + `h.Curl` / `h.APIState`):**
   - Exposes `window.slaprfCurl(reqOrSpec, bodyOrOpts?)` inside the live Chromium runtime (`web/src/services/test_curl.ts`), usable from Playwright (`h.Curl`, `h.CurlSpec`, `h.APIGet`, `h.APIPost`, `h.APIExpectStatus`, `h.APIState`) or Chrome DevTools Protocol (CDP):
     ```js
     // Shorthand CLI-style or structured request directly against slaprf.wasm in-browser:
     await window.slaprfCurl("GET /api/version");
     await window.slaprfCurl("POST /api/pilots/add", { callsign: "ViperFPV" });
     await window.slaprfCurl({ method: "GET", url: "/api/race/export.csv?raceId=race-1" });
     ```
   - Automatically routes Portable host endpoints (`/api/capabilities`, `/api/laprf-discover`, `/api/mgp/*`) to `window.fetch` and all engine `/api/*` endpoints directly to `window.slaprfWasm.request(method, url, body, headers)` running inside WebAssembly, returning `{ ok, status, headers, body, durationMs, target }` and keeping the live UI store + IndexedDB synchronized so `video.webm` visually records every API-driven state transition!
   - UI component tests verify both **DOM visual state**, **persisted IndexedDB snapshot state**, and **live WASM `/api/state` & `/api/rules` responses**.
3. **Pre-Seeded JSON Snapshots (`e2e/testdata/*.json` + `BootWithSnapshot`):**
   - Component tests do **not** create data from scratch through the UI. Instead, `h.BootWithSnapshot(snapshotName, "#/target/route", localStorageMap)` writes a pre-built `SimSnapshotBundle` directly into SlapRF's `IndexedDB` (`"slaprf"` v1 -> `"kv"` -> `"sim.state"`) on `/__e2e_seed` before `index.html` loads, then navigates straight to the component's route (`#/live/...`, `#/pilot/...`, `#/races/...`, `#/setup/...`, etc.).
   - Edge-case tests use `h.BootWithMutatedSnapshot(...)` to tweak an existing JSON snapshot in Go memory right before seeding.
   - Canonical JSON fixtures in `e2e/testdata/`:
     - `practice_populated.json` — 3 practice sessions (`Evening Lap Lab` active with 24 multi-sector laps across 4 pilots, purple section records, bottleneck variance, crossings, and filtered detections; `Warmup Pack` stopped; `Hover Check` 0-lap untagged).
     - `race_active_control.json` — 14 global pilots (`> 10` for searchable popovers), active Double Elimination tournament `Friday Night Brawl` (`W1-1` confirmed with 10 Hz `rssiTrace` waveform, manual splits/penalties, `W1-2` ready in Control), plus 2-stage draft `Sunday Qualifier`.
     - `race_completed_podium.json` — Completed Single Elimination tournament `Winter Finals` with crowned podium + populated Practice session for Analytics scope switching.
     - `multigp_seeded.json` — Imported MultiGP event (`#501`) with `Heat 1` confirmed locally and pending upload to MultiGP.
     - `laprf_mode_seeded.json` — `LapRF 8-way` hardware mode with 3 simulated pucks (`L1`–`L3`) and per-pilot attenuation/threshold settings.
4. **Mandatory End-to-End Video, Trace & Screenshot Recording (`test-results/`):**
   - Every single test (`TestComponent_*`, `TestAPI_*`, and workflow tests) unconditionally records `video.webm`, `trace.zip`, `final.png`, and `step-NN-*.png` milestone screenshots, failing automatically on any uncaught `pageerror`, unexpected `console.error`, or missing/empty `video.webm`.
   - Generates a self-contained dark HTML dashboard at `test-results/<YYYYMMDD-HHMMSS>/index.html` and `test-results/latest.html` with interactive filters (**All**, **Component Tests**, **Workflow Tests**, **WASM API Tests**, **Failed**) and live search.

## Running the Suite

### Windows (PowerShell)
```powershell
# Run all 84 tests (22 In-Browser WASM API + 52 Component UI + 10 Workflow E2E)
.\scripts\test-e2e.ps1

# Run only the 22 in-browser WASM HTTP API & E2E race format tests
.\scripts\test-e2e.ps1 -ApiOnly -SkipBuild

# Run only the 52 pre-seeded single-component UI unit tests
.\scripts\test-e2e.ps1 -ComponentOnly -SkipBuild

# Run only the 10 end-to-end workflow tests
.\scripts\test-e2e.ps1 -WorkflowOnly -SkipBuild

# Run a single test by name
.\scripts\test-e2e.ps1 -Run TestAPI_RaceE2E_DoubleEliminationWinnersRedemptionAndChaseTheAceFinals -SkipBuild

# Regenerate e2e/testdata/*.json snapshot fixtures from Go domain builders
.\scripts\test-e2e.ps1 -RegenSnapshots -Run TestComponent_LiveStandingsRankingGapsSparklinesAndRowClick -SkipBuild
```

### Linux / macOS
```bash
./scripts/test-e2e.sh
./scripts/test-e2e.sh --api-only --skip-build
./scripts/test-e2e.sh --component-only --skip-build
./scripts/test-e2e.sh --workflow-only --skip-build
./scripts/test-e2e.sh --run TestAPI_MultiGPE2E_ControlledScheduleImportScoreSyncPlanCaptureAndMarkSynced --skip-build
```

### Inspecting a Playwright Trace
```powershell
go run github.com/playwright-community/playwright-go/cmd/playwright@v0.5700.1 show-trace .\test-results\<run-id>\<TestName>\trace.zip
```

## Covered Tests (84 Total)

### Single-Component UI Unit Tests (`TestComponent_*` · 52 Tests)
- **`component_layout_core_test.go` (9 tests)** — BootLoader progress & ready transition, Sidebar collapse/expand persistence, TopBar breadcrumbs & mobile overflow menu, TopBar announcer quick-mute, `CustomSelect` open/select/Escape/outside-click, Section Anchor scroll-spy & deep link, responsive Settings intro `See more`/`See less`, `TableScrollShell` horizontal scroll arrows & scroll preservation, Multi-tab ownership conflict & `Use Here` takeover.
- **`component_modals_tags_toast_test.go` (6 tests)** — `TagPillEditor` keyboard navigation/add/remove/commit/cancel (+ `/api/state` check), `ConfirmModal` Escape/backdrop/danger confirm, `ConfirmPreemptModal` cancel & confirm, `Toast` error deduplication (`×2`) & dismiss, `CanvasSelect` searchable popover (`>10` options + `/api/state` seat check), `UsbPortPickerDialog` selection & cancel.
- **`component_practice_widgets_test.go` (7 tests)** — Practice directory search/status/tag filters, inline session rename (+ `/api/state` check), `PilotPickerChips` (`All` + per-pilot filter), `PracticePilotAssignmentPopover` (`×` clear + assign + `/api/state` check), `LiveStandings` ranking/gaps/sparklines/row selection, `SectionRecordsMatrix` purple overall records & deltas, `LapTimesCard` section tabs & legend filtering.
- **`component_analytics_widgets_test.go` (6 tests)** — Analytics TopBar Practice/Race scope switcher, `PilotPillBar` switch/add (`+ Compare`)/remove, `LapPicker` SVG bars & `Best vs Median` / `Best vs Latest` presets, `LapComparison` section delta table & coaching takeaway, `SectionStats` CV%/IQR consistency & `OPPORTUNITY` badge, `PracticeRecommendation` target lap & `<3 laps` empty state.
- **`component_pilots_track_settings_test.go` (8 tests)** — `PilotSlotsEditor` search/duplicate-channel guard/remove (+ `/api/state` check), hardware-mode columns (`Gain`/`Threshold` in LapRF mode vs hidden in SlapRF mode + `/api/state` check), `TrackEditor` `Make start` flag cycle (+ `/api/state` check), `TrackEditor` drag-off to unassigned tray & drag-back onto course (+ `/api/state` check), `TimingRulesEditor` global edit/inline reset/per-gate override (+ `/api/rules` & `/api/state` check), `AnnouncerSettings` voice toggles/sliders/reset, `DataSourceCard` JSON backup download & two-step `Wipe` modal, `AboutView` version info & OSS license switcher.
- **`component_races_canvas_modals_test.go` (10 tests)** — Races directory filters/tags/inline rename (+ `/api/state` check), `FormatDiagram` stage cards/zoom/settings modal, `WireDropMenu` contextual `+` stage creation on wire drop (+ `/api/state` check), `BracketDiagram` `Templates` modal apply (+ `/api/state` check), `BracketDiagram` `+ Heat` & camera HUD (`−`/`+`/`Fit`), `Control` cockpit panel toggles & `Reset layout`, `Control` manual `+ Lap`/`− Lap` & marshal penalty/disqualify, `Review` completed heat list & detail table, `HeatLapEditorModal` RSSI waveform SVG/crossings/manual split/penalty, `MultiGP` Import preview & `Sync MultiGP` upload modal (+ `/api/mgp-sync/plan` check).
- **`component_hardware_sim_views_test.go` (6 tests)** — `NetworkView` star topology SVG & slot inspector, `FlasherView` firmware patch checkboxes & serial reader panel, `DebugView` self-test/live signal/spectrum scan tabs, `LiveTimeView` host copy pills & enable toggle, `SimView` speed walker (`1×`/`20×`) & pilot flight commands, `SimView` MultiGP Race Admin inline round/heat/pilot roster editor.

### In-Browser WASM HTTP API & E2E Race Format Tests (`TestAPI_*` · 22 Tests)
- **`api_core_track_storage_test.go` (7 tests)** — `/api/version` + `/api/capabilities` + `/api/status` + HTTP `405`/`400` guards + `slaprfCurlHistory`; Pilots CRUD + 2 dB hysteresis clamping + `/api/pilots/reset`; Track gates CRUD + `/api/thresholds` + `/api/track/rules` + legacy `/api/gates/*` aliases; `/api/rules` clamping + `/api/timing/toggle-arm`; `/api/timers/provision|color|delete` + `/api/sim/timer-action`; Sim vs Real engine isolation via `/api/sim/toggle` + `/api/storage/export|import|reset`; `/api/hardware/mode` (`slaprf` <-> `laprf`) + `/api/sim/laprf-discover|laprf-action` + host `/api/laprf-discover`.
- **`api_practice_sim_telemetry_test.go` (4 tests)** — `/api/practice/action` full session lifecycle, pilot channel assignment, tags & `clear_session_laps`; Live `20×` RF simulator practice laps, crossings, sector summaries & `/api/session/reset`; Real-time WASM telemetry stream + `/api/sim/track-walker`; Mutual RF preemption `400` guards & `preemptOngoing: true` handoff across Practice & Multiple Races.
- **`api_races_formats_e2e_test.go` (8 tests)** — Single Elimination full live `20×` RF tournament + `GET /api/race/export.csv` (`text/csv` headers & rows); Double Elimination Winners/Redemption + Chase-the-Ace dynamic Finals spawning; Two-Stage Qualifying (`consecutive_3`) -> `Stage2MaxSeeds` Top-4 handoff via `/api/race/advance-stage` -> Mains Champion; Points Mains 3-round cumulative standings; Round-Robin dynamic `QualifyingMetric` recomputation (`best_lap`, `consecutive_2`, `consecutive_3`, `laps_in_time`, `points`); Open Qualifier Flight-Line (`open_qual_enqueue`, `open_qual_dequeue`, `open_qual_enqueue_all`) & `MaxPacksPerPilot` enforcement; Custom Multi-Stage DAG (`start_custom`, `add_stage`, `connect_stages`, `add_round`, `add_heat`, `delete_heat`, `assign_pilot_seat`, `set_seat_channel`, `connect_rounds`); Full Heat Control & Marshal suite (`start`, `cancel`, `emergency_stop`, `reset`, `add_lap`, `add_crossing`, `move_crossing`, `toggle_lap`, `delete_crossing`, `set_penalty`, `move_down`, `clear_override`, `toggle_dnf`/`dq`/`dns`, `confirm`, `unlock`, and `race_lifecycle`).
- **`api_multigp_e2e_test.go` (3 tests)** — `/api/sim/mgp-admin` CRUD + MultiGP `v1.0.4` WebService protocol & `401`/`404` guards; Controlled Schedule E2E (`race/view` -> `/api/mgp-sync/import` -> score heats -> `/api/mgp-sync/plan` -> `assignSlot` & `captureOverallRaceResult` -> `/api/mgp-sync/mark-synced`); ZippyQ Dynamic Rounds E2E (`queue-zippyq` -> `getAdditionalRounds` -> idempotent `/api/mgp-sync/append-zippyq` -> score & sync plan).

### End-to-End UI Workflow Scenarios (10 Tests)
- **`smoke_settings_test.go`** — `TestBootCleanStateAndSidebarNavigation`, `TestSettingsSectionsHardwareSwitchAndMultiGPKeyMasking`
- **`timers_track_test.go`** — `TestSlapRFHubConnectAndTrackGateTelemetry`, `TestLapRFSimulatedTimersLabelsAndControls`
- **`practice_pilots_test.go`** — `TestPilotsDirectoryAddEditAndPersist`, `TestPracticeSessionFastSimLapsAndSectors`
- **`tournaments_control_test.go`** — `TestTournamentSetupBracketGraphAndStageJumpLink`, `TestFullRaceControlExecutionAndChampion`
- **`multigp_e2e_test.go`** — `TestMultiGPControlledRaceCreateImportFlyAndUpload`, `TestMultiGPZippyQCheckInPullAndRun`
