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
- **Linux (`x86_64` / `arm64`)**: Install official tarball from `https://go.dev/dl/` into `/usr/local/go` (or `~/.local/go` if rootless) and add `bin` to `PATH`:
  ```bash
  ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  curl -fSL "https://go.dev/dl/go1.25.1.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz
  sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tar.gz && rm -f /tmp/go.tar.gz
  export PATH="/usr/local/go/bin:$PATH"
  ```

### Chrome / Edge (Required for `go test ./web/...`)
The frontend test suite (`slaprf/web`) executes inside a headless Chromium/Chrome/Edge instance discovered automatically from standard OS paths (`CHROME_BIN` overrides discovery if needed):
- **Linux (Ubuntu/Debian)**: Install Google Chrome (`google-chrome-stable`) or Chromium (`sudo apt-get install -y chromium-browser` / `chromium`).

### Hugo Extended (`0.170.1`, Required for `docs-site` & full `cmd/build-web`)
Must be the **Extended** edition (SCSS/PostCSS support for Hextra):
```bash
hugo version   # Verify "+extended" appears in output
```
- **Windows**: `winget install Hugo.Hugo.Extended --version 0.170.1`
- **macOS**: `brew install hugo`
- **Linux (`x86_64` / `arm64`, user-space `~/.local/bin/hugo`)**:
  ```bash
  ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  mkdir -p ~/.local/bin
  curl -fSL "https://github.com/gohugoio/hugo/releases/download/v0.170.1/hugo_extended_0.170.1_linux-${ARCH}.tar.gz" | tar -xz -C ~/.local/bin hugo
  ```
- *(Tip: If Hugo is not installed and you only need the web app, pass `-skip-docs` to `cmd/build-web`.)*

### GitHub CLI (`gh`)
Used to trigger workflows, watch CI runs, and download firmware/E2E artifacts:
```bash
gh --version && gh auth status
```
- **Windows**: `winget install GitHub.cli`
- **macOS**: `brew install gh`
- **Linux (Ubuntu/Debian/Raspberry Pi OS)**: `sudo apt-get update && sudo apt-get install -y gh`

---

## 2. Playwright E2E Verification Dependencies (`e2e/`)

`e2e/` uses `playwright-go` (`v0.5700.1`, Playwright `1.57.0`) and requires a `node` binary on `PATH` plus Playwright's Chromium build:
```bash
go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
# On Linux CI/servers, include OS shared libraries:
go run github.com/playwright-community/playwright-go/cmd/playwright install --with-deps chromium
```
- **Newer Ubuntu Releases (`25.x` / `26.04+`)**: If Playwright's installer prints `Playwright does not support chromium on ubuntu26.04-x64`, prefix with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`:
  ```bash
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
  ```

---

## 3. Android APK & Wireless `adb` Toolchain (`cmd/build-android`)

`cmd/build-android` compiles `libslaprf.so` + Java shims and signs an APK **without Gradle**. `discoverToolchain()` in `cmd/build-android/main.go` searches environment variables first, then standard SDK locations (`%LOCALAPPDATA%\Android\Sdk`, `~/Library/Android/sdk`, `~/Android/Sdk`), and finally `~/.slaprf/android-toolchain/`:

1. **JDK 17+** (`javac` and `keytool`):
   - `JAVA_HOME` or `~/.slaprf/android-toolchain/jdk-17`
   - **Windows**: `winget install EclipseAdoptium.Temurin.17.JDK`
   - **macOS**: `brew install --cask temurin@17`
   - **Linux (`apt`)**: `sudo apt-get install -y openjdk-17-jdk-headless` (or use the zero-`sudo` bootstrap below)
2. **Android SDK + Platform Tools (`adb`) + NDK**:
   - Required packages via `sdkmanager`:
     ```bash
     sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"
     ```
   - **Linux Zero-`sudo` User-Space Bootstrap (`~/.slaprf/android-toolchain`, `x86_64`)**:
     Installs Temurin JDK 17, `cmdline-tools`, `adb`, Android 35 SDK, Build-Tools `35.0.0`, and NDK `27.2.12479018` directly where `cmd/build-android` auto-discovers them:
     ```bash
     TC="$HOME/.slaprf/android-toolchain"
     mkdir -p "$TC/jdk-17" "$TC/sdk/cmdline-tools" ~/.local/bin
     curl -fSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" | tar -xz -C "$TC/jdk-17" --strip-components=1
     curl -fSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" -o /tmp/cmdtools.zip
     unzip -q /tmp/cmdtools.zip -d /tmp/cmdtools-extract && mv /tmp/cmdtools-extract/cmdline-tools "$TC/sdk/cmdline-tools/latest" && rm -rf /tmp/cmdtools.zip /tmp/cmdtools-extract
     export JAVA_HOME="$TC/jdk-17" ANDROID_HOME="$TC/sdk" PATH="$TC/jdk-17/bin:$TC/sdk/cmdline-tools/latest/bin:$TC/sdk/platform-tools:$PATH"
     yes | sdkmanager --sdk_root="$TC/sdk" --licenses >/dev/null || true
     sdkmanager --sdk_root="$TC/sdk" "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"
     ln -sf "$TC/sdk/platform-tools/adb" ~/.local/bin/adb
     ```
   - Verify `adb` is reachable:
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
  # Linux only: install ESP-IDF host build packages once
  sudo apt-get update && sudo apt-get install -y git wget flex bison gperf python3 python3-pip python3-venv cmake ninja-build ccache libffi-dev libssl-dev dfu-util libusb-1.0-0

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
