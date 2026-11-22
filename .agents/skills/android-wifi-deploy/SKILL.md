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

### Option B: Fixed TCP Port (`5555`) via Brief USB Plug-In
Query the phone's Wi-Fi IPv4 address **before** calling `adb tcpip 5555` (because `adb tcpip 5555` restarts `adbd` on the phone and can briefly drop the USB transport into `unauthorized` until the user checks **"Always allow from this computer"** and taps **Allow**):
```bash
PHONE_IP=$(adb shell ip -4 addr | awk '/inet (10\.|192\.168\.|172\.)/ {split($2,a,"/"); print a[1]; exit}')
adb tcpip 5555
sleep 2
adb connect "${PHONE_IP}:5555"
# Unplug USB cable; verify wireless target shows 'device' (not 'unauthorized'):
adb devices -l
```
- **Troubleshooting `unauthorized` After `adb tcpip 5555`**: If `adb devices -l` shows `unauthorized`, remind the user to check **"Always allow from this computer"** and tap **Allow** on the phone screen, then run `adb reconnect` and `adb connect "${PHONE_IP}:5555"`. If `adb tcpip 5555` was already run before reading `PHONE_IP`, scan the local `/24` subnet for open TCP port `5555` to locate the phone's Wi-Fi IP.

*(Tip: On Linux user-space installs via `dev-setup`, `adb` is located at `~/.slaprf/android-toolchain/sdk/platform-tools/adb` or symlinked to `~/.local/bin/adb`. If connecting over USB on Ubuntu/Debian and `adb devices` shows `no permissions`, add `SUBSYSTEM=="usb", ATTR{idVendor}=="<VENDOR_HEX>", MODE="0666", GROUP="plugdev", TAG+="uaccess"` under `/etc/udev/rules.d/51-android.rules` or use Option A Wireless Debugging directly over Wi-Fi with zero udev setup. When multiple devices are listed in `adb devices`, pass `-s <SERIAL_OR_IP:PORT>` to every `adb` command.)*

---

## 3. Push APK, Pre-Grant Permissions & Restart `app.slaprf` Over Wi-Fi

```bash
# Install in-place (or uninstall first if switching signing keys from a different build host):
adb -s <DEVICE> install -r dist/slaprf-android-arm64.apk || (adb -s <DEVICE> uninstall app.slaprf && adb -s <DEVICE> install dist/slaprf-android-arm64.apk)

# Pre-grant Android 12+ Bluetooth & notification permissions so headless REST tests don't block on modal prompts:
for perm in android.permission.BLUETOOTH_SCAN android.permission.BLUETOOTH_CONNECT android.permission.POST_NOTIFICATIONS; do
  adb -s <DEVICE> shell pm grant app.slaprf "$perm" 2>/dev/null || true
done

# Restart the activity + foreground service:
adb -s <DEVICE> shell am force-stop app.slaprf
adb -s <DEVICE> shell am start -n app.slaprf/.SlapRFHost
```

---

## 4. Live Debugging Over Wi-Fi (`127.0.0.1:18090` Port Forward, `logcat` & WebView CDP)

### Forward the Embedded Go `/v1/*` Server (`127.0.0.1:18090`) to Workstation
`cmd/slaprf-android/main.go` (`Java_app_slaprf_SlapRFHost_nativeStartServer`) binds **`127.0.0.1:18090`** inside the Android app (falling back to `18091` only if `18090` is occupied). Forward `tcp:18090 -> tcp:18090` (NOT `tcp:8090`, which is only bound when the in-app LAN Pocket Server toggle is enabled):
```bash
adb -s <DEVICE> forward tcp:18090 tcp:18090
curl -fsS http://127.0.0.1:18090/v1/version
curl -fsS http://127.0.0.1:18090/v1/capabilities
```
Once forwarded, you can drive the entire Android timing engine, Bluetooth shim (`/v1/slaprf/bluetooth/*`), and USB OTG shim (`/v1/slaprf/usb/*`) directly over `http://127.0.0.1:18090/v1/*` from your workstation while the phone's physical USB-C port is free for a Hub timer!

### Stream Native Go, USB/BLE Shim & Process Logs
Filter by the live app PID (`--pid`) so logcat ring rotation on busy devices never hides startup messages:
```bash
PID=$(adb -s <DEVICE> shell pidof app.slaprf | tr -d '\r')
adb -s <DEVICE> logcat -d --pid="$PID"
# Or stream continuously:
adb -s <DEVICE> logcat -v time --pid="$PID"
```
On Windows PowerShell:
```powershell
$procId = (adb -s <DEVICE> shell pidof app.slaprf).Trim()
adb -s <DEVICE> logcat -v time --pid=$procId
```

### Inspect the Android WebView Over Chrome DevTools Protocol
When `WebView.setWebContentsDebuggingEnabled(true)` is enabled in `SlapRFHost.java`, forward the WebView DevTools abstract socket to localhost:
```bash
PID=$(adb -s <DEVICE> shell pidof app.slaprf | tr -d '\r')
adb -s <DEVICE> forward tcp:9223 localabstract:webview_devtools_remote_${PID}
curl -fsS http://127.0.0.1:9223/json/list
```
