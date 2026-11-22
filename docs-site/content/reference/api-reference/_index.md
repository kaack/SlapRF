---
title: API Reference
weight: 2
sidebar:
  open: true
---

SlapRF Portable and the SlapRF Android LAN host expose a versioned HTTP REST API (`/v1/...`) and real-time WebSocket streams (`/v1/ws/...`) on port `8090` for building custom OBS stream overlays, LED gate controllers, race scoreboards, and automation scripts.

## REST API (OpenAPI 3.1.0)

Resource-oriented `/v1/*` endpoints across system state, pilots, track gates, practice sessions, race sessions, hardware links, simulator controls, and storage.

- **Interactive Reference**: [Browse REST API Docs](/docs/reference/api-reference/rest/)
- **OpenAPI Specification**: [Download openapi.yaml](/docs/specs/openapi.yaml)

## Stream API (AsyncAPI 3.0.0)

Real-time WebSocket streams (`/v1/ws/*`) delivering JSON event envelopes (`crossing`, `lap`, `filtered`, `race`, `practice`, `config`) and 50 Hz binary RSSI telemetry batches.

- **Interactive Reference**: [Browse Stream API Docs](/docs/reference/api-reference/async/)
- **AsyncAPI Specification**: [Download asyncapi.yaml](/docs/specs/asyncapi.yaml)

## Server Base URL & Authentication

By default, SlapRF Portable binds to `http://127.0.0.1:8090`. To allow external devices on the same Wi-Fi or Ethernet LAN (such as an OBS streaming PC or field scoreboard) to access the `/v1` REST and WebSocket endpoints, start SlapRF with `-lan`:

```bash
./slaprf -lan -addr 0.0.0.0:8090
```

If Basic Auth is enabled under **Settings -> Authentication**, pass a standard `Authorization: Basic <base64(user:pass)>` header on REST requests (or create an authenticated session check via `POST /v1/auth/sessions`).

## Quick-Start REST Examples

Fetch active state and print pilot callsigns and best laps:

```bash
curl -s http://localhost:8090/v1/state | jq '.summaries[] | {callsign, totalLaps, bestLapSec}'
```

Create a new pilot (`201 Created` + `Location` header):

```bash
curl -i -X POST http://localhost:8090/v1/pilots \
  -H "Content-Type: application/json" \
  -d '{"callsign":"VORTEX","phoneticName":"vor-teks"}'
```

Start the currently staged heat in the active race session:

```bash
curl -s -X POST http://localhost:8090/v1/race/sessions/current/heats/current:control \
  -H "Content-Type: application/json" \
  -d '{"action":"start","preemptOngoing":true}'
```

## WebSocket Binary Telemetry Wire Format (`/v1/ws/stream`)

While all JSON event envelopes (`crossing`, `lap`, `filtered`, `race`, `practice`, `config`, `usbStatus`) are documented interactively in the [WebSocket API (AsyncAPI 3.0)](/docs/reference/api-reference/async/) reference page, `/v1/ws/stream` also multiplexes high-rate `5.8 GHz` RSSI telemetry batches at `50 Hz` (`20 ms`) as compact little-endian **WebSocket Binary Frames** (`application/octet-stream`).

### 50 Hz Binary Telemetry Frame Layout

Each binary WebSocket message begins with a 4-byte little-endian header followed by `count` packed frame records (`20 + 4 * rssiCount` bytes per record; `52` bytes per record when `rssiCount == 8`):

| Byte Offset | Type (Little-Endian) | Field | Description |
| :--- | :--- | :--- | :--- |
| `0` | `uint8` | `version` | Wire format version (always `1`). |
| `1` | `uint8` | `rssiCount` | Number of RSSI channel floats per record (typically `8`). |
| `2..3` | `uint16` | `count` | Number of packed telemetry records in this batch. |
| `4 + i*stride + 0` | `uint8` | `timerId` | Physical timer ID (`1` = Hub `H1`, `2..7` = Spokes `T1..T6`). |
| `4 + i*stride + 1` | `uint8` | `reserved` | Always `0`. |
| `4 + i*stride + 2..3` | `uint16` | `batteryMv` | Timer supply voltage in millivolts (for example, `4120`). |
| `4 + i*stride + 4..7` | `uint32` | `seqNum` | Monotonic sweep sequence counter from the timer. |
| `4 + i*stride + 8..15` | `float64` | `timestampUs` | Microsecond timestamp in server timebase. |
| `4 + i*stride + 16..19` | `float32` | `noiseFloorDbm` | Estimated 5.8 GHz noise floor in `dBm` (for example, `-94.5`). |
| `4 + i*stride + 20..` | `float32[rssiCount]` | `rssi` | Per-slot smoothed RSSI values in `dBm`. |

### JavaScript / TypeScript WebSocket Client Example

```javascript
const ws = new WebSocket("ws://localhost:8090/v1/ws/stream");
ws.binaryType = "arraybuffer";

ws.addEventListener("message", (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.type === "lap") {
      const { lap } = msg.payload;
      console.log(`[LAP] ${lap.callsign} Lap ${lap.lapNumber}: ${lap.lapTimeSec.toFixed(3)}s`);
    } else if (msg.type === "crossing") {
      const c = msg.payload;
      console.log(`[GATE] ${c.callsign} -> ${c.gateName} (${c.peakRssiDbm.toFixed(1)} dBm)`);
    }
    return;
  }

  // Decode 50 Hz binary RSSI telemetry batch
  const view = new DataView(event.data);
  if (view.byteLength < 4 || view.getUint8(0) !== 1) return;
  const rssiCount = view.getUint8(1);
  const count = view.getUint16(2, true);
  const stride = 20 + 4 * rssiCount;

  for (let i = 0; i < count; i++) {
    const base = 4 + i * stride;
    const timerId = view.getUint8(base);
    const batteryMv = view.getUint16(base + 2, true);
    const seqNum = view.getUint32(base + 4, true);
    const timestampUs = view.getFloat64(base + 8, true);
    const noiseFloorDbm = view.getFloat32(base + 16, true);
    const rssi = [];
    for (let ch = 0; ch < rssiCount; ch++) {
      rssi.push(view.getFloat32(base + 20 + ch * 4, true));
    }
    // Use { timerId, batteryMv, seqNum, timestampUs, noiseFloorDbm, rssi }
  }
});
```
