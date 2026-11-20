# SlapRF Bluetooth Hub link (BLE) protocol

Applies to the dedicated Bluetooth Hub firmware image `slaprf-xiao-c5-ble.bin` built from
`firmware/slaprf_ble/`. The USB firmware (`firmware/slaprf/`, `slaprf-xiao-c5.bin`) is unchanged.

## Summary

The BLE link carries **exactly the same byte stream as the Hub's USB serial port**:

- host -> hub: newline-terminated console commands (`STATUS?\n`, `SLAPRF?\n`, `LIVE 1\n`,
  `NETCHANNELS ...\n`, `SCAN ...\n`, ...).
- hub -> host: `@{json}\n` reply / status lines and binary Hub frame records
  `0x1E <len> <frame bytes>` (HELLO `0xC5 0x5A`, WINDOW `0xC5 0x60`, SINGLE `0xC5 0x61`), plus the
  raw 160-byte `SLAPRF02` block in reply to `SLAPRF?`.

Host code must treat the link as an ordered byte stream (like a serial port). Records and lines
may be split across notifications or several may share one notification.

## GATT

| Item | UUID | Properties |
|---|---|---|
| Service "SlapRF Hub" | `5d1a0001-5a7e-4c0b-9e5f-534c41505246` | primary, advertised |
| RX (host -> hub commands) | `5d1a0002-5a7e-4c0b-9e5f-534c41505246` | Write, Write Without Response |
| TX (hub -> host stream) | `5d1a0003-5a7e-4c0b-9e5f-534c41505246` | Notify |

- The host must enable notifications on TX (write `0x0001` to its CCCD) **before** sending the first
  command. The first command (normally `STATUS?`) marks the host as attached, which starts Hub frame
  streaming, exactly like USB.
- Writes may be any length up to `ATT_MTU - 3`; the hub reassembles lines across writes.
- One central at a time. The hub resumes advertising after a disconnect.

## Advertising

- Complete local name: `SlapRF <timer label>` (truncated to fit), e.g. `SlapRF H1`.
- 128-bit service UUID above in the advertising data (filter on it when scanning).
- Manufacturer specific data (scan response, 12 bytes): company ID `0xFFFF`, then
  `'S' 'R' <fingerprint u32 LE> <role u8 (1 = Hub)> <fw major> <fw minor> <fw patch>`.

## Link parameters (requested by the hub, final values chosen by the central)

- LE 2M PHY preferred, Data Length Extension 251 bytes, ATT MTU up to 247 (host should request
  `requestMtu(247)` on Android).
- Connection interval **10 ms** (8 x 1.25 ms) preferred, requested by the hub right after connect via
  an L2CAP connection parameter update; if the central picks something that is not a multiple of
  10 ms, the hub asks again for 20 ms, then 30 ms. Every multiple of 10 ms lines up with the 100 Hz
  sweep schedule, so the hub can park connection events in the gap between sweeps. Latency 0.
  Supervision timeout 4 s.
- Hosts must **not** force their own interval. In particular Android hosts must **not** call
  `requestConnectionPriority(CONNECTION_PRIORITY_HIGH)` (it forces 11.25-15 ms, which cannot be
  aligned with the sweeps).
- For about 1.5 s after a host subscribes, the hub keeps its radio on 2.4 GHz (window frames carry
  "no reading" codes) while it measures the connection-event phase, then sweeping resumes.

## STATUS? additions (BLE image only)

The status JSON carries an extra object:

```json
"image":"ble","transport":"ble",
"ble":{"connected":true,"intervalUs":10000,"mtu":247,"phy":2,"rssi":-58,"txNotifies":1234,
       "txBytes":56789,"txDrops":0,"rxWrites":12,"nocp":900,"connects":1,
       "sync":true,"syncLocked":true,"phaseUs":9310}
```

`transport` is `"usb"` when the BLE image is being talked to over its USB port. `phaseUs` is where
connection events end, measured from the start of a sweep (target 9300, sweeps occupy 0..7000).
Console command `BLESYNC 1|0` turns the sweep phase lock on or off (for A/B bench tests).

## Port naming on hosts

- Go / Android: a BLE hub is exposed as a port path `ble:<FINGERPRINT 8 hex>` (e.g. `ble:BE7C0001`),
  with a description like `SlapRF H1 (Bluetooth)`.
