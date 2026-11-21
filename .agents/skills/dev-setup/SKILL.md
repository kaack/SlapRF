---
name: dev-setup
description: >-
  Install, configure, and verify local development dependencies for SlapRF across Windows, macOS,
  and Linux: Go 1.25+, Hugo Extended 0.170.1, Chromium/Playwright for UI and E2E tests, GitHub CLI
  (gh), Python pyserial/esptool for USB bench tools, Android SDK/NDK/JDK 17 (adb), and ESP-IDF
  v5.5.1 for Seeed Studio XIAO ESP32-C5 firmware. Activate when setting up a machine or diagnosing
  missing build/test tools.
---

# SlapRF Development Environment Setup

SlapRF uses a pure-Go build pipeline (`cmd/build-*` + embedded `github.com/evanw/esbuild`), so **no `npm install` or `node_modules` directory is needed** to build or test the web SPA. Install only the toolchains needed for the targets you are working on.

## 1. Core Toolchain (Required for Web, Server & Unit Tests)

### Go (`1.25.0+`)
Check `go.mod` for the exact minimum version (`go 1.25.0`):
```bash
go version
```
- **Windows**: `winget install GoLang.Go`
- **macOS**: `brew install go`
- **Linux**: Install official tarball from `https://go.dev/dl/` into `/usr/local/go`.

### Chrome / Edge (Required for `go test ./web/...`)
The frontend test suite (`slaprf/web`) executes inside a headless Chromium/Chrome/Edge instance discovered automatically from standard OS paths (`CHROME_BIN` overrides discovery if needed).

### Hugo Extended (`0.170.1`, Required for `docs-site` & full `cmd/build-web`)
Must be the **Extended** edition (SCSS/PostCSS support for Hextra):
```bash
hugo version   # Verify "+extended" appears in output
```
- **Windows**: `winget install Hugo.Hugo.Extended --version 0.170.1`
- **macOS**: `brew install hugo`
- **Linux**: Download `hugo_extended_0.170.1_linux-amd64.tar.gz` from `https://github.com/gohugoio/hugo/releases/tag/v0.170.1`.
- *(Tip: If Hugo is not installed and you only need the web app, pass `-skip-docs` to `cmd/build-web`.)*

### GitHub CLI (`gh`)
Used to trigger workflows, watch CI runs, and download firmware/E2E artifacts:
```bash
gh --version && gh auth status
```
- **Windows**: `winget install GitHub.cli`
- **macOS**: `brew install gh`

---

## 2. Playwright E2E Verification Dependencies (`e2e/`)

`e2e/` uses `playwright-go` (`v0.5700.1`, Playwright `1.57.0`) and requires a `node` binary on `PATH` plus Playwright's Chromium build:
```bash
go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
# On Linux CI/servers, include OS shared libraries:
go run github.com/playwright-community/playwright-go/cmd/playwright install --with-deps chromium
```

---

## 3. Android APK & Wireless `adb` Toolchain (`cmd/build-android`)

`cmd/build-android` compiles `libslaprf.so` + Java shims and signs an APK **without Gradle**. `discoverToolchain()` in `cmd/build-android/main.go` searches environment variables first, then standard SDK locations (`%LOCALAPPDATA%\Android\Sdk`, `~/Library/Android/sdk`, `~/Android/Sdk`), and finally `~/.slaprf/android-toolchain/`:

1. **JDK 17+** (`javac` and `keytool`):
   - `JAVA_HOME` or `~/.slaprf/android-toolchain/jdk-17`
   - Windows: `winget install EclipseAdoptium.Temurin.17.JDK`
   - macOS: `brew install --cask temurin@17`
2. **Android SDK + Platform Tools (`adb`) + NDK**:
   - Required packages via `sdkmanager`:
     ```bash
     sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"
     ```
   - Ensure `platform-tools` (`adb`) is on `PATH`:
     ```bash
     adb version
     ```
   - Signing keystore: Auto-generated on first build at `~/.slaprf/android-debug.keystore` unless overridden by `SLAPRF_ANDROID_KEYSTORE`, `SLAPRF_ANDROID_KS_PASS`, `SLAPRF_ANDROID_KEY_ALIAS`, and `SLAPRF_ANDROID_KEY_PASS`.

---

## 4. ESP32-C5 Firmware & USB Bench Toolchain (`firmware/`)

### Python Bench Utilities (`pyserial` + `esptool`)
Required for `firmware/tools/console_check.py`, `noise_stats.py`, `serial_capture.py`, and standalone flashing:
```bash
python -m pip install pyserial esptool
```

### Linux USB Serial & Bluetooth LE Prerequisites
- **USB Serial (`/dev/ttyACM*`)**: On Raspberry Pi OS, the default user is already in `dialout`. On Ubuntu/Debian/Arch desktops, add your user to `dialout` (or `uucp` on Arch) and install a `uaccess` udev rule using `ENV{ID_VENDOR_ID}` / `ENV{ID_MODEL_ID}` (which reliably matches `SUBSYSTEM=="tty"` events on Linux) for immediate access to XIAO ESP32-C5 (`303a:1001`) without logging out:
  ```bash
  sudo usermod -aG dialout "$USER"
  echo 'SUBSYSTEM=="tty", ENV{ID_VENDOR_ID}=="303a", ENV{ID_MODEL_ID}=="1001", MODE="0660", GROUP="dialout", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-slaprf-esp32c5.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
  ```
- **Bluetooth LE (BlueZ over D-Bus)**: SlapRF automatically powers on BlueZ (`org.bluez.Adapter1.Powered = true`) over D-Bus when needed (such as fresh Raspberry Pi OS Lite boots) and discovers non-`hci0` adapters; set `SLAPRF_BLE_ADAPTER=hci1` to pin a specific controller on multi-adapter hosts.
- **Raspberry Pi + Bluetooth Hub (`slaprf_ble`) Coexistence**: Raspberry Pi `CYW43455` radios share one `2.4 GHz` transceiver and PCB antenna between `2.4 GHz` Wi-Fi and BLE. Do **not** run `2.4 GHz` Wi-Fi on the Pi while using `slaprf_ble` (connect the Pi via `5 GHz` Wi-Fi or Ethernet), and keep at least `30 cm` (`1 ft`) between the Pi and the XIAO ESP32-C5 Hub so near-field RF (`> -30 dBm`) does not saturate the Pi receiver.

### ESP-IDF `v5.5.1` (`esp32c5` Target)
Required only when compiling C firmware locally (otherwise download CI artifacts via `gh run download`):

- **Windows** (`C:\esp`, expected by `firmware\tools\build_local.ps1` and `build_local_ble.ps1`):
  ```powershell
  git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git C:\esp\esp-idf
  $env:IDF_TOOLS_PATH = "C:\esp\tools"
  C:\esp\esp-idf\install.bat esp32c5
  ```
- **macOS / Linux** (`~/esp/esp-idf`):
  ```bash
  mkdir -p ~/esp
  git clone -b v5.5.1 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git ~/esp/esp-idf
  ~/esp/esp-idf/install.sh esp32c5
  . ~/esp/esp-idf/export.sh
  ```

## Quick Verification Checklist
Run from the repository root to verify core readiness:
```bash
go version
hugo version
go test ./internal/domain ./web/...
```
