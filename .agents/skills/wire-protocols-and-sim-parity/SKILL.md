---
name: wire-protocols-and-sim-parity
description: >-
  Maintain byte-level parity across SlapRF ESP-NOW / USB / BLE firmware wire frames (WIRE_PROTO_VER=2,
  0xC5 packets, SLAPRF02 config block), Go ingest decoders, Android USB/BLE shims, external timer
  protocols (RotorHazard, LapRF :5403), and the in-app hardware simulator. Activate when modifying
  firmware packets, serial/BLE protocols, hardware links, or simulated hardware behavior.
---

# Wire Protocols, Hardware Links & Simulator Parity

SlapRF's simulator runs its simulated Hub and Spoke timers through the **exact same binary `HubFrameDecoder` (`internal/ingest/hub_frames.go`) and serial JSON console parser (`web/src/services/timer_console.ts`)** as physical hardware. Any protocol change must keep firmware, host decoders, mobile shims, and simulators aligned byte-for-byte.

## 1. SlapRF Binary Wire Protocol (`WIRE_PROTO_VER = 2`)

### Frame Types (`0xC5` Magic Byte 0, XOR CRC8 in Final Byte)
Defined across C (`firmware/components/slaprf_radio/` & `firmware/components_ble/slaprf_ble_link/`) and Go (`internal/ingest/hub_frames.go`, `internal/firmware/`):

- `0xC5 0x5A` **HELLO (`36` bytes)**: `[magic0, magic1, slot, role, fp_u32_le, rsv, sweep_hz, label[24], rsv, crc8]`
- `0xC5 0x5B` **JOIN (`34` bytes, `spoke_join_frame_t`)**: Spoke join request over 2.4 GHz ESP-NOW
- `0xC5 0x5C` **ASSIGN**: Hub TDMA slot assignment to Spoke
- `0xC5 0x5D` **SYNC BEACON**: Hub 2.4 GHz TDMA timing beacon
- `0xC5 0x5E` **CHANNELS (`19` bytes)**: `[0xC5, 0x5E, 8 x uint16_le MHz (0 = disabled), crc8]`
- `0xC5 0x60` **WINDOW (`7 + 9*N + 1` bytes)**: Sliding-window `0.5 dB` sweep recorder frame (`slot`, `sample_count`, `batt_mv`, `noise_floor`, `N x [seq_u8, rssi_half_dbm[8]]`, `crc8`)
- `0xC5 0x61` **SINGLE (`16` bytes)**: Single-sweep `0.5 dB` frame
- **USB Stream Framing**: Binary Hub packets multiplexed on USB CDC alongside ASCII console lines are prefixed with `0x1E <pkt_len_u8>`.

### Packed Struct & Size Invariants
- Always mark wire structs `__attribute__((packed))` in C and add `_Static_assert(sizeof(...) == EXPECTED_LEN, ...)` in C plus matching length constants and unit tests in `internal/ingest/hub_frames_test.go`. A 1-byte struct padding mismatch silently drops every frame at `validCRC8()`!

---

## 2. `SLAPRF02` 160-Byte Flash Configuration Block

Shared by `firmware/`, `internal/firmware/image.go` (`PatchImage`, `RepairAppImage`), and `web/src/services/esp_flasher.ts` (`buildOrPatchFirmwareBin`, `parseSlaprfConfigBlock`):
- Offsets, XOR CRC byte (`[159]`), ESP-IDF image segment checksum, and trailing 32-byte SHA-256 digest calculation **must remain identical** in Go and TypeScript.
- Run both `go test ./internal/firmware/...` and `go test ./web/...` after any config block change.

---

## 3. Bluetooth LE Hub GATT & Android Shims

When changing BLE Hub GATT characteristics, MTU framing, Claim-on-Pair `AUTH`, or USB serial control lines:
- **Firmware**: `firmware/components_ble/slaprf_ble_link/` & `docs/ble-hub-protocol.md`
- **Desktop Go BLE**: `internal/usb/ble_port.go` & `internal/usb/ports_ble_desktop.go`
- **Android Shims**: `android/java/app/slaprf/SlapRFBleShim.java` & `SlapRFUsbShim.java` + `cmd/slaprf-android/`
- **UI & Console**: `web/src/services/timer_console.ts` (`ble:<FINGERPRINT>` port handles)

---

## 4. Mandatory Simulator Parity Checklist

Whenever you add or alter a firmware console command (`STATUS?`, `LIVE`, `SCAN`, `CHANNELS MASK`, `IDENTIFY`, etc.), Hub binary frame, RotorHazard Socket.IO/USB message, or LapRF `:5403` record:
1. Update the Go track simulator (`internal/ingest/simulator.go`) and/or simulated serial/hardware links (`web/src/services/sim_serial_port.ts`, `rh_hardware_link.ts`, `laprf_hardware_link.ts`).
2. Verify in Demo/Simulator mode before testing on physical hardware so automated tests (`web/src/__tests__/slaprf_ble.test.ts`, `rotorhazard.test.ts`, `internal/laprf/server_test.go`) guard the behavior permanently.
