---
name: android-wifi-deploy
description: >-
  Build the signed SlapRF Android APK (cmd/build-android), pair and connect wireless adb over Wi-Fi,
  push and launch app.slaprf/.SlapRFHost, stream Go/Java/WebView logcat logs, and forward the
  Android WebView DevTools socket for live CDP inspection. Activate whenever building, deploying, or
  debugging the Android app.
---

# SlapRF Android Build & Wireless Wi-Fi Deployment

SlapRF's Android app (`package="app.slaprf"`, activity `.SlapRFHost`, foreground service `.SlapRFHost$EngineService`) embeds the native Go server (`libslaprf.so`, 16 KB ELF page-aligned) + USB CDC (`usb-serial-for-android`) + Bluetooth LE GATT shims inside an Android WebView, packaged directly by `cmd/build-android` without Gradle.

## 1. Build the Signed APK

Run from the repository root:
```bash
# Full build (compiles WASM-free web UI + Go arm64 shared library + Java shims + signs APK)
go run ./cmd/build-android -arch arm64 -out dist/slaprf-android-arm64.apk

# Fast incremental rebuild when web/ assets have NOT changed
go run ./cmd/build-android -skip-web -arch arm64 -out dist/slaprf-android-arm64.apk
```
- Revert any timestamp-only `version.json` change after building:
  ```bash
  git checkout -- internal/api/generated/version.json
  ```
- **Consistent Signing Key**: Local builds automatically create and reuse `~/.slaprf/android-debug.keystore`, so `adb install -r` upgrades cleanly over Wi-Fi without uninstalling or wiping app `bbolt` data. (If switching from a GitHub Release APK signed with a different key, uninstall once with `adb uninstall app.slaprf`.)

---

## 2. Pair & Connect Wireless `adb` Over Wi-Fi

### Option A: Android 11+ Native Wireless Debugging (No USB Cable Needed)
1. On the Android phone/tablet, enable **Developer options -> Wireless debugging** (must be on the same Wi-Fi LAN).
2. Tap **Pair device with pairing code** (needed only once per workstation) and run:
   ```bash
   adb pair <PHONE_IP>:<PAIRING_PORT> <6_DIGIT_CODE>
   ```
3. Connect to the main **IP address & Port** shown on the **Wireless debugging** screen (note: the connection port differs from the one-time pairing port):
   ```bash
   adb connect <PHONE_IP>:<CONNECT_PORT>
   adb devices -l
   ```

### Option B: Android 10 or Fixed TCP Port (`5555`) via Brief USB Plug-In
```bash
adb tcpip 5555
adb connect <PHONE_IP>:5555
# Unplug USB cable; verify wireless target:
adb devices -l
```

*(Tip: If both USB and Wi-Fi or multiple devices are listed in `adb devices`, pass `-s <PHONE_IP>:<PORT>` to every `adb` command.)*

---

## 3. Push APK & Restart `app.slaprf` Over Wi-Fi

```bash
# Install in-place (preserving local race/practice database) and restart the activity + service
adb -s <DEVICE> install -r dist/slaprf-android-arm64.apk
adb -s <DEVICE> shell am force-stop app.slaprf
adb -s <DEVICE> shell am start -n app.slaprf/.SlapRFHost
```

---

## 4. Live Debugging Over Wi-Fi (`logcat` & Remote WebView CDP)

### Stream Native Go, USB/BLE Shim & WebView Console Logs
```bash
# Clear stale buffer then stream live SlapRF + Go + Chromium logs
adb -s <DEVICE> logcat -c
adb -s <DEVICE> logcat -v time | grep -E "SlapRF|GoLog|chromium|AndroidRuntime"
```
On Windows PowerShell:
```powershell
adb -s <DEVICE> logcat -c
adb -s <DEVICE> logcat -v time | Select-String "SlapRF|GoLog|chromium|AndroidRuntime"
```

### Forward Android WebView or Go HTTP Port to Workstation
1. **Inspect the Android WebView over Chrome DevTools Protocol**:
   Find the app PID and forward its WebView DevTools abstract socket to localhost:
   ```bash
   PID=$(adb -s <DEVICE> shell pidof app.slaprf | tr -d '\r')
   adb -s <DEVICE> forward tcp:9223 localabstract:webview_devtools_remote_${PID}
   ```
   You can now query `http://127.0.0.1:9223/json/list` or open `chrome://inspect/#devices` on your desktop to inspect the live Android DOM, console, and network streams.
2. **Test the Embedded Go `/v1/*` Server Directly**:
   Check `logcat` for the local loopback port bound by `libslaprf.so`, then forward it with `adb forward tcp:18090 tcp:<APP_PORT>` to hit `http://127.0.0.1:18090/v1/status` directly from your workstation.
