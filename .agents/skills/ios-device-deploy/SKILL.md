---
name: ios-device-deploy
description: >-
  Build the SlapRF native iOS & iPadOS sideload IPA or Simulator app (cmd/build-ios), discover USB
  and Wi-Fi paired iPads/iPhones via xcrun devicectl, sign and install directly with a free Apple ID
  Personal Team, stream live Go/Swift console logs, query /v1/logs and telemetry over Pocket LAN
  (:8090) or Simulator (127.0.0.1:18090), and inspect WKWebView via Safari Web Inspector. Activate
  whenever building, deploying, or debugging the iOS / iPadOS app on a MacBook.
---

# SlapRF iOS / iPadOS Build, Simulator & Free Personal Team Deployment

SlapRF's native iOS and iPadOS app (`bundleId="app.slaprf.timer"`, `ios/` + `cmd/slaprf-ios`) embeds the Go timing engine (`libslaprf.a`, `DisableUSB: true`) + `CoreBluetooth` GATT shim (`SlapRFBleShim.swift`) + `AVAudioEngine` / `AVSpeechSynthesizer` audio mixer inside a full-screen `WKWebView`.

Supported hardware links on iPhone and iPad:
- **SlapRF Bluetooth Hub** (`slaprf-xiao-c5-ble.bin`, `ble:<FP8HEX>`) via native `CoreBluetooth`.
- **SlapRF ESP32-P4 PoE Bridge** (`:5480`), **LapRF 8-Way** (`:5403`), and **RotorHazard** over Wi-Fi or USB-C Ethernet.
- Direct USB-C serial (`CDC-ACM`) is omitted (`nativeUsb: false`).

---

## 1. Build Modes (`cmd/build-ios` on macOS)

Run from the repository root on a Mac with Xcode installed:

```bash
# 1. Unsigned / ad-hoc signed sideloadable .ipa (for Sideloadly, SideStore, AltStore, and CI)
go run ./cmd/build-ios -out dist/slaprf-ios-arm64.ipa

# Fast rebuild when web/ assets have NOT changed:
go run ./cmd/build-ios -skip-web -out dist/slaprf-ios-arm64.ipa

# 2. Boot iPad / iPhone Simulator, install SlapRF.app, and stream console logs (no device or signing needed)
go run ./cmd/build-ios -simulator -run

# 3. Sign with your FREE Apple ID Personal Team & deploy directly to a paired iPad / iPhone (USB or Wi-Fi)
go run ./cmd/build-ios -device auto -team <YOUR_10_CHAR_TEAM_ID> -bundle-id app.slaprf.<yourname> -run
```

After building, revert any timestamp-only `version.json` diff:
```bash
git checkout -- internal/api/generated/version.json
```

---

## 2. Discover & Pair Your iPad / iPhone (`xcrun devicectl`)

1. On the iPad or iPhone (iOS/iPadOS 16+), enable **Settings -> Privacy & Security -> Developer Mode** and reboot once when prompted.
2. Plug the iPad/iPhone into the MacBook via USB-C once and tap **Trust This Computer**. (Once paired in Xcode **Window -> Devices and Simulators** with **Connect via network** checked, subsequent deploys work wirelessly over Wi-Fi!)
3. List paired devices and find your free Personal Team ID:
   ```bash
   xcrun devicectl list devices
   security find-identity -v -p codesigning
   ```
   *(Your 10-character Team ID appears in parentheses on your `"Apple Development: ..."` certificate, or in `Xcode -> Settings -> Accounts`. If you have not created a Personal Team certificate yet, open `ios/SlapRF.xcodeproj` once in Xcode, select your Apple ID under **Signing & Capabilities -> Team**, and set a unique **Bundle Identifier** such as `app.slaprf.miguel`.)*
4. Export `SLAPRF_IOS_TEAM_ID` in your shell so `-team` is picked up automatically:
   ```bash
   export SLAPRF_IOS_TEAM_ID=<YOUR_10_CHAR_TEAM_ID>
   go run ./cmd/build-ios -skip-web -device auto -bundle-id app.slaprf.<yourname> -run
   ```
   *(First install from a free Personal Team: on the iPad/iPhone open **Settings -> General -> VPN & Device Management -> Developer App** and tap **Trust** once.)*

---

## 3. Live Console Logs, `/v1` Telemetry & Safari Web Inspector

### A. Stream Native Go + Swift Stdout/Stderr Logs
`cmd/slaprf-ios` writes all `applog` lines to `stderr` AND to `Application Support/SlapRF/slaprf.log`:
```bash
# Launch (or relaunch) on physical iPad/iPhone with live terminal output:
xcrun devicectl device process launch --console --terminate-existing --device <DEVICE_ID> app.slaprf.<yourname>

# Or on iOS Simulator:
xcrun simctl launch --console-pty --terminate-running-process booted app.slaprf.timer
```

### B. Query `/v1/logs` & `/v1/*` Live Over Simulator or iPad Wi-Fi LAN
- **On Mac Simulator**: the Go engine binds `http://127.0.0.1:18090` directly on the Mac loopback interface!
  ```bash
  curl -fsS http://127.0.0.1:18090/v1/capabilities
  curl -fsS "http://127.0.0.1:18090/v1/logs?format=text&tailBytes=65536"
  ```
- **On a Physical iPad / iPhone**: toggle **Settings -> Datasource -> Share server on Wi-Fi / Hotspot** ON inside the app to expose the full `/v1/*` server on `http://<IPAD_LAN_IP>:8090`:
  ```bash
  curl -fsS "http://<IPAD_LAN_IP>:8090/v1/capabilities"
  curl -fsS "http://<IPAD_LAN_IP>:8090/v1/logs?format=text&tailBytes=65536"
  curl -fsS -X PUT "http://<IPAD_LAN_IP>:8090/v1/logs/config" \
    -H "Content-Type: application/json" -d '{"level":"debug"}'
  ```

### C. Inspect `WKWebView` Live with Safari Web Inspector
`SlapRFViewController.swift` enables `webView.isInspectable = true` on iOS/iPadOS 16.4+:
1. On the iPad/iPhone, enable **Settings -> Apps -> Safari -> Advanced -> Web Inspector**.
2. On the MacBook, open **Safari -> Settings -> Advanced** and check **Show features for web developers**.
3. Open **Safari -> Develop -> `<Your iPad / Simulator>` -> `127.0.0.1`** to inspect the live DOM, console, WebSocket frames, and canvas state.
