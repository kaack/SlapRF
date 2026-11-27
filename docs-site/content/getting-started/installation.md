---
title: Installation
weight: 2
---

Download the latest native SlapRF release from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest). Each build is self-contained and requires no external runtime or database server.

> [!NOTE]
> The online preview at `https://slaprf.app` runs a simulated track for exploring the interface. Because web browsers throttle background tabs and audio, install the native Android app, sideloaded iOS/iPadOS app, or desktop binary below to time real flights.

## Verified Platforms

| Platform / Device | Bluetooth Hub | USB-C Hub | USB Flasher | LAN Timers | Verified Environment & Notes |
| :--- | :---: | :---: | :---: | :---: | :--- |
| Android (`ARM64` Phone / Tablet) | {{< yes >}} | {{< yes >}} | {{< yes >}} | {{< yes >}} | Verified on Android (`arm64-v8a` APK); use a USB-C OTG data cable for USB Hub and in-app Flasher. |
| iOS / iPadOS (`ARM64` iPhone / iPad) | {{< yes >}} | {{< no >}} | {{< no >}} | {{< yes >}} | Verified on iPad (`A16`, iPadOS); free sideload (`slaprf-ios-arm64.ipa` on iOS/iPadOS 16.0+ via Sideloadly, SideStore, or Xcode). |
| Windows 11 (`x86_64`) | {{< yes >}} | {{< yes >}} | {{< yes >}} | {{< yes >}} | Verified on Windows 11 (`slaprf-windows-amd64.exe`, `WinRT` Bluetooth LE and `COM` serial). |
| macOS (`Apple Silicon`) | {{< yes >}} | {{< yes >}} | {{< yes >}} | {{< yes >}} | Verified on Apple Silicon (`slaprf-macos-arm64`, `CoreBluetooth` and `/dev/cu.usbmodem*`); Intel (`amd64`) binary also built in CI. |
| Linux Desktop (`x86_64`) | {{< yes >}} | {{< yes >}} | {{< yes >}} | {{< yes >}} | Verified on Ubuntu `x86_64` (`slaprf-linux-amd64`, `BlueZ` and `/dev/ttyACM*`). |
| Raspberry Pi 4 (`ARM64`) | {{< yes >}} | {{< yes >}} | {{< yes >}} | {{< yes >}} | Verified on Raspberry Pi 4 Model B (`Raspberry Pi OS 64-bit`); requires `5 GHz` Wi-Fi or Ethernet for Bluetooth Hub. |

<div class="doc-status-legend not-prose" aria-label="Platform support legend">
  <span class="doc-status-legend-item">{{< yes >}} <span>Verified on physical hardware</span></span>
  <span class="doc-status-legend-item">{{< no >}} <span>Not supported</span></span>
</div>

## Platform Setup

{{< tabs >}}
  {{< tab name="Android" >}}
  ### Android

  1. Open [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest) on your phone or tablet and download `slaprf-android-arm64.apk`.
  2. Tap the downloaded `.apk` file to install it, allowing installation from your browser or file manager if prompted.
  3. Open **SlapRF**. The app runs the Go timing engine locally on your device with offline storage, spoken callouts, Bluetooth LE, and USB OTG serial support.

  > [!TIP]
  > You can flash XIAO ESP32-C5 boards directly from your Android phone or tablet using the built-in **Flasher** screen in the SlapRF app over a USB-C data cable.
  {{< /tab >}}
  {{< tab name="iOS / iPadOS" >}}
  ### iOS and iPadOS (Free Sideload)

  SlapRF ships `slaprf-ios-arm64.ipa` for iPhones and iPads running iOS or iPadOS `16.0` and newer. You can install it with a free Apple ID (no paid developer account required).

  #### Option A: Sideloadly (Recommended for Windows and macOS)
  1. Install [Sideloadly](https://sideloadly.io/) on your Windows PC or Mac, then connect your iPhone or iPad over USB once and tap **Trust This Computer**.
  2. Download `slaprf-ios-arm64.ipa` from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest) (or click **Install via Sideloadly** in **Settings -> Datasource** on `https://slaprf.app`), enter your Apple ID in Sideloadly, and click **Start**.
  3. On your iPhone or iPad, enable **Settings -> Privacy & Security -> Developer Mode** (appears at the bottom under **Security** after your first sideload install), restart when prompted, then open **Settings -> General -> VPN & Device Management**, select your Apple ID profile, and tap **Trust**.
  4. Keep Sideloadly running in the background on your computer with **Wi-Fi auto-refresh** enabled so the 7-day free signature renews automatically over your home Wi-Fi without plugging in a cable.

  #### Option B: SideStore or AltStore (On-Device Updates)
  Add the SlapRF source URL in SideStore or AltStore for 1-tap installations and updates:
  ```text
  https://slaprf.app/altstore-source.json
  ```

  #### Supported Hardware on iPhone and iPad
  - **SlapRF Bluetooth Hub (`slaprf-xiao-c5-ble.bin`)**: Open **Network**, select **SlapRF (Bluetooth)**, tap **Connect**, and allow Bluetooth access when prompted.
  - **SlapRF PoE Ethernet Bridge (`:5480`)**: Connect your iPhone or iPad to the same Wi-Fi LAN (or plug in a USB-C Ethernet adapter), select **SlapRF (Network)**, and tap **Connect**.
  - **Direct USB-C Serial**: iOS omits generic `CDC-ACM` serial drivers, so direct USB Hub links and USB firmware flashing are hidden in the iOS app. Flash boards once from Chrome, Edge, Opera, or Android before pairing on iOS.
  {{< /tab >}}
  {{< tab name="Windows" >}}
  ### Windows

  1. Download `slaprf-windows-amd64.exe` from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest).
  2. Move the executable into a dedicated folder, clear the download flag, and launch it in PowerShell (or move and double-click it in File Explorer):
     ```powershell
     New-Item -ItemType Directory -Force -Path "$HOME\SlapRF" | Out-Null
     Move-Item -Force "$HOME\Downloads\slaprf-windows-amd64.exe" "$HOME\SlapRF\slaprf.exe"
     Unblock-File "$HOME\SlapRF\slaprf.exe"
     Set-Location "$HOME\SlapRF"
     .\slaprf.exe
     ```
  3. SlapRF creates `slaprf.db` in that folder, starts on `http://127.0.0.1:8090`, and opens your default browser automatically.
  {{< /tab >}}
  {{< tab name="macOS" >}}
  ### macOS

  1. Download `slaprf-macos-arm64` (Apple Silicon) or `slaprf-macos-amd64` (Intel) from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest).
  2. Move the binary into a dedicated folder, clear the macOS quarantine attribute, and run it:
     ```bash
     mkdir -p ~/SlapRF && mv ~/Downloads/slaprf-macos-* ~/SlapRF/slaprf
     cd ~/SlapRF
     xattr -d com.apple.quarantine ./slaprf 2>/dev/null || true
     chmod +x ./slaprf
     ./slaprf
     ```
  3. SlapRF starts on `http://127.0.0.1:8090` and opens your browser. When connecting to a SlapRF Bluetooth Hub for the first time, allow Bluetooth access for your terminal application if macOS prompts you. Use Chrome, Edge, or Opera when flashing firmware over USB in **Flasher**.
  {{< /tab >}}
  {{< tab name="Linux" >}}
  ### Linux (`x86_64` Desktop)

  1. Download `slaprf-linux-amd64` from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest).
  2. Move the binary into a dedicated folder, mark it executable, and run it:
     ```bash
     mkdir -p ~/SlapRF && mv ~/Downloads/slaprf-linux-amd64 ~/SlapRF/slaprf
     cd ~/SlapRF
     chmod +x ./slaprf
     ./slaprf
     ```
     SlapRF starts on `http://127.0.0.1:8090` and opens your default browser.
  3. For USB Serial timers (`/dev/ttyACM*`), add your user to `dialout` (Ubuntu/Debian) or `uucp` (Arch) and log out and back in once:
     ```bash
     sudo usermod -aG dialout $USER
     ```
     To grant immediate access on XIAO ESP32-C5 (`303a:1001`) without logging out, add a `udev` rule ordered before `73-seat-late.rules`:
     ```bash
     echo 'SUBSYSTEM=="tty", ENV{ID_VENDOR_ID}=="303a", ENV{ID_MODEL_ID}=="1001", MODE="0660", GROUP="dialout", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-slaprf-esp32c5.rules
     sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
     ```
  4. For Bluetooth Hub (`slaprf_ble`) mode, SlapRF powers on BlueZ automatically and selects the first active adapter. If your PC has multiple Bluetooth controllers (such as motherboard Bluetooth plus a USB dongle), set `SLAPRF_BLE_ADAPTER=hci1` to pick a specific adapter.
  {{< /tab >}}
  {{< tab name="Raspberry Pi" >}}
  ### Raspberry Pi (`ARM64`)

  > [!NOTE]
  > Hardware testing is verified on **Raspberry Pi 4 Model B** running **Raspberry Pi OS (64-bit)**. Use a 64-bit (`aarch64`) OS image; 32-bit (`armhf`) Raspberry Pi OS is not supported.

  1. Connect the Raspberry Pi to **`5 GHz` Wi-Fi or wired Ethernet**, then download `slaprf-linux-arm64` from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest) onto the Pi:
     ```bash
     mkdir -p ~/SlapRF && cd ~/SlapRF
     curl -fLO https://github.com/kaack/SlapRF/releases/latest/download/slaprf-linux-arm64
     chmod +x ./slaprf-linux-arm64
     ./slaprf-linux-arm64
     ```
  2. On a headless SSH or `systemd` session (no desktop display), SlapRF automatically enables LAN mode (`0.0.0.0:8090`) and prints its browser URL (such as `http://raspberrypi.local:8090`).
  3. For USB Hub (`slaprf`) mode, Raspberry Pi OS includes your user in the `dialout` group by default, so `/dev/ttyACM0` works immediately with no extra rules.

  > [!IMPORTANT]
  > **Raspberry Pi 4 + Bluetooth Hub (`slaprf_ble`) Requirements:**
  > - **Do not enable `2.4 GHz` Wi-Fi on the Pi.** The Raspberry Pi 4 shares one `CYW43455` radio and PCB antenna between `2.4 GHz` Wi-Fi and Bluetooth LE. Connect the Pi via **`5 GHz` Wi-Fi or Ethernet** (or connect the Hub over USB-C with `slaprf-xiao-c5.bin` if only `2.4 GHz` Wi-Fi is available).
  > - **Keep `30 cm` to `1 m` (`1` to `3 ft`) between the Pi and the Hub.** Placing the Hub antenna right beside the unshielded Raspberry Pi board saturates its `2.4 GHz` receiver and prevents Bluetooth connections.
  > - **Power the Pi from a dedicated `5 V / 3 A` USB-C supply.** Do not power the Pi and XIAO timers from the same USB hub.
  {{< /tab >}}
{{< /tabs >}}

## Wi-Fi LAN Sharing

By default, the desktop binary binds to `127.0.0.1:8090` for local use on that machine. To host SlapRF on a trackside laptop or headless Raspberry Pi so pilots and spectators can view live standings over Wi-Fi, pass `-lan`:

{{< tabs >}}
  {{< tab name="Windows" >}}
  ```powershell
  .\slaprf.exe -lan
  ```
  {{< /tab >}}
  {{< tab name="macOS / Linux" >}}
  ```bash
  ./slaprf -lan
  ```
  {{< /tab >}}
{{< /tabs >}}

SlapRF listens on `0.0.0.0:8090` and prints its local network URL (such as `http://192.168.1.42:8090`). Open **Settings -> Authentication** in the UI to set an HTTP Basic Auth username and password so spectators cannot modify race settings. If you get locked out, start the binary once with `-no-auth` to clear saved credentials.

## CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `-addr` | `127.0.0.1:8090` | HTTP listen address and port. |
| `-lan` | `false` | Bind to `0.0.0.0:8090` for Wi-Fi LAN access (implies `-no-browser`). |
| `-db` | `slaprf.db` | Path to the database file storing pilots, sessions, and races. |
| `-no-browser` | `false` | Do not launch a browser window automatically on startup. |
| `-no-auth` | `false` | Clear HTTP Basic Authentication credentials on startup. |
| `-version` | `false` | Print the build version and exit. |
