---
name: ios-device-deploy
description: >-
  Build, deploy, and agentically verify the SlapRF native iOS & iPadOS app (cmd/build-ios) directly
  on a MacBook or remotely from a Linux workstation over SSH (ssh mac-lan): sign with a free Apple ID
  Personal Team, unlock hidden Developer Mode, install/launch/screenshot physical iPads and iPhones
  via xcrun devicectl, drive the live engine and CoreBluetooth/PoE hardware links remotely over Wi-Fi
  Pocket LAN (:8090), verify locked-screen background keep-alive, and run headless Simulator QA.
  Activate whenever building, deploying, testing, or debugging the iOS / iPadOS app.
---

# SlapRF iOS / iPadOS Agentic Build, Remote macOS Bridge & Hardware QA

SlapRF's native iOS and iPadOS app (`ios/` + `cmd/slaprf-ios`) embeds the Go timing engine (`libslaprf.a`, `DisableUSB: true`), `CoreBluetooth` GATT shim (`SlapRFBleShim.swift`), and `AVAudioEngine` / `AVSpeechSynthesizer` audio mixer inside a full-screen `WKWebView`.

Supported hardware links on iPhone and iPad:
- **SlapRF Bluetooth Hub** (`slaprf-xiao-c5-ble.bin`, `ble:<FP8HEX>`) via native `CoreBluetooth` (`2M PHY`, `MTU 247`, `30 ms` GATT interval, `50.0 Hz`).
- **SlapRF ESP32-P4 PoE Bridge** (`:5480`), **LapRF 8-Way** (`:5403`), and **RotorHazard** over Wi-Fi or a plug-and-play USB-C Ethernet adapter.
- Direct USB-C serial (`CDC-ACM`) is omitted (`nativeUsb: false`).

---

## 1. Remote Linux -> MacBook -> Physical iPad Topology (`ssh mac-lan`)

When working on a Linux workstation paired with a MacBook on the same Wi-Fi LAN:
- **MacBook SSH Host**: `ssh mac-lan` (checkout at `~/Documents/slaprf`). Always wrap multi-line commands in `bash -lc` (macOS login shell `zsh` aborts on unmatched globs via `NOMATCH`) and prepend Go's user-space path:
  ```bash
  ssh mac-lan 'bash -lc '\''
  export PATH="$HOME/sdk/go/bin:/usr/local/go/bin:/opt/homebrew/bin:$PATH"
  cd ~/Documents/slaprf
  git pull --ff-only origin main
  '\'''
  ```
- **Xcode 27.2+ Simulator GUI Path**: Standalone `Simulator.app` moved to `/Applications/Xcode.app/Contents/Applications/DeviceHub.app` (already handled automatically by `cmd/build-ios`).
- **Xcode 27.2+ `devicectl` Gotcha**: `xcrun devicectl list devices` lists **both** physical devices (`reality: "physical"`) AND Simulators (`reality: "simulated"`, `SimulatorCoreDevicePlugin`, `pairingState: "paired"`). `cmd/build-ios -device auto` filters out `simulated` entries automatically; in ad-hoc scripts, always check `Reality == physical` (and note that `devicectl` commands accept either the CoreDevice UUID `Identifier` or hardware `UDID`).

---

## 2. Build Modes (`cmd/build-ios` on macOS)

Run from the repository root on the Mac (locally or via `ssh mac-lan`):

```bash
# 1. Unsigned / ad-hoc signed sideloadable .ipa (for Sideloadly, SideStore, AltStore, and CI)
go run ./cmd/build-ios -out dist/slaprf-ios-arm64.ipa

# Fast rebuild when web/ assets have NOT changed:
go run ./cmd/build-ios -skip-web -out dist/slaprf-ios-arm64.ipa

# 2. Boot iPad / iPhone Simulator, install SlapRF.app, and stream console logs (zero signing needed)
go run ./cmd/build-ios -simulator -run

# 3. Sign with a FREE Apple ID Personal Team & deploy to a paired physical iPad / iPhone
go run ./cmd/build-ios -skip-web -device auto -team <10_CHAR_TEAM_ID> -bundle-id app.slaprf.<yourname> -run
```

Always revert timestamp-only `version.json` diffs after web builds:
```bash
git checkout -- internal/api/generated/version.json
```

---

## 3. First-Time Physical iPad / iPhone Onboarding (Exact Order Matters!)

Do **not** skip or reorder these four one-time steps on a brand-new iPad/iPhone or fresh Mac:

1. **USB Trust & Inspect Device State**:
   Plug the iPad/iPhone into the MacBook via USB-C and tap **Trust** on the device. Verify visibility:
   ```bash
   ssh mac-lan 'xcrun devicectl list devices && security find-identity -v -p codesigning'
   ```
   *(If `State` says `connected (no DDI)`, Developer Mode is still disabled.)*

2. **One-Time Interactive Keychain Grant on macOS (`errSecInternalComponent`)**:
   - In `Xcode -> SlapRF -> Signing & Capabilities`, sign in with a free Apple ID, select **`Personal Team`**, and set a unique **Bundle Identifier** (for example `app.slaprf.dev`).
   - **Critical SSH Caveat**: The very first time a newly-minted `Apple Development` certificate is used, `codesign` over headless SSH fails with `errSecInternalComponent` because macOS blocks GUI Keychain popups over SSH. Have the user press **`⌘B`** once inside Xcode on the MacBook screen, enter their Mac login password, and click **Always Allow**. After that single grant, headless `ssh mac-lan` builds and `cmd/build-ios -device auto` sign unattended forever.

3. **Unhiding `Developer Mode` on Out-of-the-Box iPads / iPhones**:
   - On a brand-new iPad or iPhone, Apple **completely hides** `Settings -> Privacy & Security -> Developer Mode` until Xcode attempts to mount the Personalized Developer Disk Image!
   - Run one install attempt (`xcrun devicectl device install app --device <DEVICE_ID> <SIGNED_APP>`) or `open "devices://device/open?id=<DEVICE_ID>"` on the MacBook. Even though the first install attempt returns `0xe800011c (Developer mode is not enabled on device)`, that mount attempt immediately unhides **Developer Mode** at the bottom of **Settings -> Privacy & Security -> Security** (right next to *Lockdown Mode*).
   - Have the user switch tabs in Settings to refresh `Privacy & Security`, toggle **Developer Mode** ON, reboot, and tap **Turn On** after restart.

4. **One-Time Personal Team Profile Trust on the iPad / iPhone**:
   - Re-run `devicectl device install app`. Before first launch (which otherwise fails with `FBSOpenApplicationErrorDomain error 3 / Security`), open **Settings -> General -> VPN & Device Management -> Developer App** on the iPad/iPhone and tap **Trust**.

---

## 4. Autonomous Agentic Verification Loop on Physical iPad / iPhone

### Why Touch Injection Is Not Used on iOS
Unlike Android `adb shell input tap`, iOS/iPadOS blocks synthetic OS touch injection over USB so paired hosts cannot auto-accept **Bluetooth** and **Local Network** privacy sheets. Only those two one-time iOS system permission dialogs require a physical finger tap.

### A. Expose Pocket LAN (`:8090`) & Resolve iPad IP via mDNS
1. Toggle **More -> Settings -> Share server on Wi-Fi / Hotspot** ON once on the iPad (persists in `UserDefaults` across app restarts and reboots!).
2. Resolve the iPad's LAN IPv4 address via mDNS from the MacBook without blind subnet scanning:
   ```bash
   ssh mac-lan 'python3 -c "import socket; print(socket.gethostbyname_ex(\"<Your-iPad>.local\"))"'
   ```
   *(Filter out `169.254.x.x` link-local USB tunnel addresses and use the Wi-Fi LAN IP, e.g. `10.0.0.59`.)*

### B. Drive 100% of SlapRF Remotely Over Wi-Fi (`http://<IPAD_IP>:8090`)
Once Pocket LAN `:8090` is enabled, any workstation on the Wi-Fi LAN can drive hardware modes, Bluetooth scans/pairing, PoE Bridge connections, race workflows, log levels, and live WebSocket streams directly (and the iPad's `WKWebView` updates in real time):

```bash
IPAD="http://10.0.0.59:8090"

# 1. Inspect capabilities, state, and logs (escalate to debug/trace when diagnosing wire frames)
curl -fsS "$IPAD/v1/capabilities"
curl -fsS -X PUT "$IPAD/v1/logs/config" -H "Content-Type: application/json" -d '{"level":"trace"}'
curl -fsS "$IPAD/v1/logs?format=text&tailBytes=16384" | tail -n 30

# 2. Switch workspace to real hardware & select Bluetooth Hub mode (triggers iOS BLE prompt on first scan)
curl -fsS -X PATCH "$IPAD/v1/sim" -H "Content-Type: application/json" -d '{"running":false}'
curl -fsS -X PUT "$IPAD/v1/hardware/mode" -H "Content-Type: application/json" -d '{"mode":"slaprf_ble"}'
curl -fsS "$IPAD/v1/slaprf/bluetooth/ports"

# 3. Pair / connect to discovered SlapRF Bluetooth Hub (note field name is "portName", NOT "port"!)
curl -i -sS -m 20 -X PUT "$IPAD/v1/slaprf/bluetooth/connections/0" \
  -H "Content-Type: application/json" \
  -d '{"portName":"ble:EFE44224"}'
curl -fsS "$IPAD/v1/slaprf/bluetooth/connections"

# 4. Restore INFO log level when finished so slaprf.log stays compact
curl -fsS -X PUT "$IPAD/v1/logs/config" -H "Content-Type: application/json" -d '{"level":"info"}'
```

### C. Capture Live Physical Retina Screenshots, Console Logs & Lock State Over USB (`devicectl`)
Run on the MacBook (`ssh mac-lan`) while the iPad is connected over USB or paired Wi-Fi CoreDevice tunnel:

```bash
DEV="0D834A11-3A98-5929-BF28-400FAAC56528" # CoreDevice Identifier or UDID from `devicectl list devices`

# 1. Capture crisp native Retina screenshot (e.g. 1640x2360 on iPad A16, including iOS system permission modals!)
ssh mac-lan "xcrun devicectl device capture screenshot --device $DEV --destination /tmp/ipad.png"
scp mac-lan:/tmp/ipad.png ./ipad-live.png

# 2. Relaunch app in background while streaming Go/Swift stdout+stderr to a file (never block foreground SSH!)
ssh mac-lan "nohup xcrun devicectl device process launch --console --terminate-existing --device $DEV app.slaprf.dev > /tmp/ipad_console.log 2>&1 < /dev/null &"

# 3. Verify screen-lock background keep-alive (`UIBackgroundModes`: `bluetooth-central` + `audio`)
# Have the user lock the iPad screen for 15+ s, confirm lock state via devicectl, and measure sweep delta over :8090:
ssh mac-lan "xcrun devicectl device info lockState --device $DEV"
```

---

## 5. Simulator Automation & Safari Web Inspector Recipes

- **Never Use `simctl openurl` for Headless JS Bridging**: Calling `xcrun simctl openurl booted slaprf://...` pops a blocking iOS `"Open in 'SlapRF'?"` system confirmation modal on Simulator.
- **Simulator Loopback Port**: On macOS Simulator, the Go engine inside `SlapRF.app` shares the Mac's network namespace and binds `http://127.0.0.1:18090` directly on the MacBook!
- **Simulator Screenshot & `UserDefaults` Inspection**:
  ```bash
  UDID="9D8F7A30-FE7E-4C33-88CB-4C9F57412463"
  xcrun simctl io "$UDID" screenshot /tmp/sim.png
  xcrun simctl spawn "$UDID" defaults read app.slaprf.timer
  xcrun simctl spawn "$UDID" log show --last 5m --predicate 'process == "SlapRF" AND subsystem != "com.apple.WebKit"' --style compact
  ```
  *(Note: On cold Simulator boot, `UIDocumentPickerViewController` launches `com.apple.DocumentManager.Service` over XPC in `~2.2 s`; wait `2.5–3.0 s` before screenshotting file-export sheets.)*
- **Live Safari Web Inspector (`WKWebView` DOM / Canvas / Console)**:
  `SlapRFViewController.swift` sets `webView.isInspectable = true` on iOS/iPadOS 16.4+. Enable **Settings -> Apps -> Safari -> Advanced -> Web Inspector** on the iPad, check **Safari -> Settings -> Advanced -> Show features for web developers** on the MacBook, and attach via **Safari -> Develop -> `<Your iPad / Simulator>` -> `127.0.0.1`**.
