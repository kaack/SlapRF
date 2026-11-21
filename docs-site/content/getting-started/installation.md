---
title: Installation
weight: 2
---

Download the latest native SlapRF release from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest). Each build is self-contained and requires no external runtime or database server.

> [!NOTE]
> The online preview at `https://slaprf.app` runs a simulated track for exploring the interface. Because web browsers throttle background tabs and audio, install the native Android app or desktop binary below to time real flights.

## Platform Setup

{{< tabs >}}
  {{< tab name="Android" >}}
  ### Android

  1. Open [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest) on your phone or tablet and download `slaprf-android-arm64.apk`.
  2. Tap the downloaded `.apk` file to install it, allowing installation from your browser or file manager if prompted.
  3. Open **SlapRF**. The app runs the Go timing engine locally on your device with offline storage, spoken callouts, Bluetooth LE, and USB OTG serial support.

  > [!TIP]
  > Android browsers and WebViews do not support WebSerial firmware flashing. Flash your XIAO ESP32-C5 boards once from Chrome, Edge, or Opera on a desktop computer, then connect to them from Android over Bluetooth or USB-C.
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
  3. SlapRF starts on `http://127.0.0.1:8090` and opens your browser. Use Chrome, Edge, or Opera if you plan to flash firmware or connect over Web Bluetooth.
  {{< /tab >}}
  {{< tab name="Linux / Pi" >}}
  ### Linux & Raspberry Pi

  1. Download `slaprf-linux-amd64` (x86_64 PC) or `slaprf-linux-arm64` (Raspberry Pi 4 / 5, 64-bit OS) from [GitHub Releases](https://github.com/kaack/SlapRF/releases/latest).
  2. Mark the binary executable and launch it:
     ```bash
     chmod +x ./slaprf-linux-*
     ./slaprf-linux-amd64
     ```
  3. For USB Hub serial access on Linux, ensure your user belongs to the serial group (`dialout` on Debian / Ubuntu / Raspberry Pi OS, or `uucp` on Arch), then log out and back in once:
     ```bash
     sudo usermod -aG dialout $USER
     ```
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

SlapRF listens on `0.0.0.0:8090` and prints its local network URL (such as `http://192.168.1.42:8090`). Open **Settings -> Security** in the UI to set an HTTP Basic Auth username and password so spectators cannot modify race settings. If you get locked out, start the binary once with `-no-auth` to clear saved credentials.

## CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `-addr` | `127.0.0.1:8090` | HTTP listen address and port. |
| `-lan` | `false` | Bind to `0.0.0.0:8090` for Wi-Fi LAN access (implies `-no-browser`). |
| `-db` | `slaprf.db` | Path to the database file storing pilots, sessions, and races. |
| `-no-browser` | `false` | Do not launch a browser window automatically on startup. |
| `-no-auth` | `false` | Clear HTTP Basic Authentication credentials on startup. |
| `-version` | `false` | Print the build version and exit. |
