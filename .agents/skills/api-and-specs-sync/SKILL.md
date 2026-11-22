---
name: api-and-specs-sync
description: >-
  Keep SlapRF's /v1 REST API, /v1/ws/stream WebSocket envelopes, in-browser Go WASM bridge,
  IndexedDB persistence, TypeScript client models, and OpenAPI 3.1 / AsyncAPI 3.0 specifications
  in 100% parity. Activate whenever adding, renaming, or modifying any HTTP endpoint, stream event,
  or persisted engine state field.
---

# `/v1` API, WASM Bridge & OpenAPI/AsyncAPI Synchronization

SlapRF exposes the exact same `/v1/*` REST and real-time stream contract in **Native Go Server mode** (`cmd/slaprf`, `cmd/slaprf-android`, `cmd/devserver`) and **Browser WASM Demo mode** (`cmd/slaprf-wasm` via `httptest` + `onStream` / `onTelemetry`).

Whenever you add, rename, or modify an endpoint, request/response field, stream event, or persisted state struct, update **all four layers** in the same change:

## Layer 1: Go Domain, Persistence & HTTP/WS Server
- **Domain & Engine State**: `internal/domain/` and `internal/tracker/` (`PersistedEngineState`, `ExportState`, `RestoreState`), plus `bbolt` storage in `internal/storage/` if persisted.
- **Core REST & WebSocket Handlers**: `internal/api/http_server.go` (`StatusResponse`, `FullStateResponse`, `/v1/*` routes, `/v1/ws/stream` envelopes, and `/v1/status?lite=1` lightweight polling).
- **Physical Hardware Transport Routes (`internal/portable/`)**:
  - SlapRF USB & Bluetooth: `/v1/slaprf/usb/*`, `/v1/ws/slaprf/usb`, `/v1/ws/slaprf/usb-raw`, `/v1/slaprf/bluetooth/*`, `/v1/ws/slaprf/bluetooth`, and `/v1/slaprf/known-timers/{fp}` (`internal/portable/{usb_handlers.go,bluetooth_handlers.go}`, backed by `internal/slaprf/{usb,bluetooth}`).
  - External Timers: `/v1/laprf/{network/devices,usb/ports,connections}` + `/v1/laprf:sync` (`internal/portable/laprf_manager.go`) and `/v1/rotorhazard/{network/devices,usb/ports,connections}` + `/v1/rotorhazard:sync` (`internal/portable/rh_manager.go`).
- **Binary Telemetry Encoding**: If `TimerTelemetryFrame` wire fields change, update both `api.EncodeTelemetryBatch` (`internal/api/`) and `decodeTelemetryBatch` (`web/src/services/wasm_transport.ts`).

## Layer 2: Browser WASM Bridge & IndexedDB Persistence
- **WASM Entrypoint**: `cmd/slaprf-wasm/main.go` routes `window.slaprfWasm.request(method, url, body, headers)` directly through `api.NewServer(...).Handler()`, so standard `/v1/*` HTTP handlers work automatically in WASM unless hardware-specific hooks (`ServerHooks`) are required.
- **IndexedDB Mirror**: If `PersistedEngineState` gains or renames top-level fields, update `PersistedEngineStateJson`, `RealConfigDoc`, `splitRealState()`, and `assembleRealState()` in `web/src/services/engine_persistence.ts` so browser reload state never drops the new field!

## Layer 3: TypeScript Models, Store & `ApiClient`
- `web/src/types/models.ts`: Keep TypeScript interfaces aligned with Go JSON tags.
- `web/src/services/api_client.ts` & `web/src/state/store.ts`: Normalize incoming arrays/nullables defensively (`hydrate`, `applyStatus`, `connectStream`) so older persisted snapshots or partial `?lite=1` responses never throw at runtime.

## Layer 4: Interactive API Specs & Parity Tests
1. **Update Published Specs**:
   - REST endpoints & schemas: `docs-site/static/specs/openapi.yaml` (OpenAPI `3.1.0`)
   - `/v1/ws/stream` messages & schemas: `docs-site/static/specs/asyncapi.yaml` (AsyncAPI `3.0.0`)
2. **Run Parity & Unit Verification**:
   ```bash
   go test ./internal/api/... ./internal/tracker/... ./internal/storage/... ./web/...
   ```
   When changing route contracts or stream semantics, also run the E2E API parity suite (`e2e/api_*_test.go`):
   - **macOS / Linux**:
     ```bash
     bash ./scripts/test-e2e.sh --api-only
     ```
   - **Windows (PowerShell)**:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-e2e.ps1 -ApiOnly
     ```
