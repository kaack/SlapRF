---
name: usb-timer-debug-and-flash
description: >-
  Discover physical Seeed Studio XIAO ESP32-C5 timers over USB, avoid serial port contention and
  Windows usbser.sys boot-mode latches, flash or patch SLAPRF02 firmware images, and run live USB
  debug console commands and 5.8 GHz RF diagnostics (STATUS?, SLAPRF?, BOOTLOG?, LIVE, SCAN,
  console_check.py, noise_stats.py, serial_capture.py). Activate whenever flashing, probing, or
  troubleshooting physical timers over USB.
---

# USB Timer Flashing & Live Bench Debugging

Physical SlapRF timers run on the **Seeed Studio XIAO ESP32-C5** using its built-in **USB-Serial-JTAG / CDC** controller (`115200` baud for console, `460800` baud for `esptool`).

## 1. Port Discovery & Contention Rules

### Identify Connected XIAO ESP32-C5 Ports (`VID 0x303A`, `PID 0x1001`)
- **Windows (PowerShell)**:
  ```powershell
  Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -match "VID_303A&PID_1001" } | Select-Object Name, DeviceID
  ```
- **macOS**: `ls /dev/cu.usbmodem*`
- **Linux**: `ls -l /dev/serial/by-id/*Espressif* /dev/ttyACM*`

### Release Port Locks First
Only **one** process can hold a serial port open at a time. Before running `esptool`, `build_local*.ps1 -FlashPort`, or Python bench scripts:
1. Ensure neither `cmd/slaprf` nor `cmd/devserver` (in Portable mode) is holding the port open (disconnect via UI `/v1/usb/disconnect` or stop the server).
2. Ensure Chrome WebSerial (`#/debug`, `#/network`, `#/flasher`) is disconnected from that port.

### Critical ESP32-C5 DTR/RTS Pitfall (Do Not Reset into Download Mode Accidentally!)
Opening an ESP32-C5 USB-Serial-JTAG port with default `pyserial` settings glitches `DTR`/`RTS` and can latch the chip into ROM bootloader (`waiting for download`).
- Always set `s.dtr = False` and `s.rts = False` **before** calling `s.open()`.
- On Linux `/dev/ttyACM*` (`cdc_acm`), `pyserial` leaves `termios.HUPCL` set by default, causing `s.close()` to drop DTR/RTS and reset the ESP32-C5. Clear `HUPCL` right after `s.open()` in ad-hoc Python scripts (`go.bug.st/serial` in Go already handles this cleanly):
  ```python
  import termios
  attrs = termios.tcgetattr(s.fd); attrs[2] &= ~termios.HUPCL
  termios.tcsetattr(s.fd, termios.TCSANOW, attrs)
  ```
- On Windows `usbser.sys`, if a board was left in `(1,1)` download-mode latch, disarm it after opening:
  ```python
  s.rts = False; s.dtr = True; s.rts = False; time.sleep(0.05)
  s.dtr = False; s.rts = False; time.sleep(0.2)
  ```

---

## 2. Flashing & `SLAPRF02` Provisioning

### A. Build & In-Place Flash (Preserving Board Identity)
Reads the existing 160-byte `SLAPRF02` block via `SLAPRF?`, stamps it into the new app image (recomputing XOR checksum + SHA-256), and flashes at `0x10000`:
```powershell
# USB Hub / Spoke timer
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local.ps1 -FlashPort COM3

# Bluetooth Hub timer
powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\tools\build_local_ble.ps1 -FlashPort COM6
```

### B. Full Merged Image Flash (`0x0`) or Blank/Stuck Board Recovery
Merged images (`web/firmware/slaprf-xiao-c5.bin` and `slaprf-xiao-c5-ble.bin`) contain bootloader + partition table + app and flash at offset **`0x0`**:
```bash
python -m esptool --chip esp32c5 -p COM3 -b 460800 --before default_reset --after hard_reset write_flash 0x0 web/firmware/slaprf-xiao-c5.bin
```
- **ROM Bootloader Recovery**: If firmware crashed in a tight loop and USB stops enumerating, hold **BOOT** on the XIAO ESP32-C5, tap **RESET** (or plug in USB-C while holding **BOOT**), release **BOOT**, verify the new `COM` / `usbmodem` port, and run `erase_flash` followed by `write_flash 0x0 ...`.

### C. Custom `SLAPRF02` Stamping (`internal/firmware.PatchImage`)
To stamp a specific role (`RoleHubTimer = 1` or `RoleSpokeTimer = 2`), 32-bit fingerprint, timer label (`H1`, `T1`..`T6`), or custom bench frequencies into a merged `.bin` before flashing, see `internal/firmware/image.go` and the reference snippet in `firmware/tools/benchpatch/main.go.txt` (or use the UI `#/flasher` / `/docs/hardware/flashing/`).

---

## 3. USB Debug Console Protocol (`115200 8N1`, `\n`-terminated)

Structured replies begin with `@{...}` JSON on a single line (so firmware log lines and binary Hub frames `0x1E <len> 0xC5 ...` can coexist on the same stream):

| Command | Purpose |
| :--- | :--- |
| `STATUS?` | Returns `@{"t":"status",...}` with `role` (`1`=Hub, `2`=Spoke), `slot`, `label`, `fp`, `fw`, `sweepHz`, `freqs`, `chanMask`, `rf` (`enabled`, `floorDb`), `heap`, `reset`, `emergencyMode`, `spokes`, and `ble` (on BLE Hub). |
| `SLAPRF?` | Dumps the raw 160-byte `SLAPRF02` flash configuration block. |
| `BOOTLOG?` / `LASTLOG?` | Returns `@{"t":"bootlog","boots":...,"reset":...,"text":...}` from persistent RTC/flash log ring (essential for diagnosing panics, watchdogs, or brownouts). |
| `LIVE 0\|1\|2` | Streams 8-channel 5.8 GHz sweeps as `@{"t":"live","n":...,"us":...,"dbm":[...],"pk":[...],"floor":[...],"hits":[...]}` (`0`=off, `1`=~10 Hz, `2`=50 Hz every sweep). Always send `LIVE 0` when finished! |
| `SCAN 5180 5917 5` | Runs one 5.8 GHz spectrum sweep (`@{"t":"scan","start":5180,"step":5,"dbm":[...]}`). |
| `SCAN LIVE 5180 5917 5` / `SCAN STOP` | Starts/stops continuous spectrum sweeping (pauses normal pilot channel sweeps while active). |
| `RF 0\|1` | Disables or enables the 5.8 GHz ADC receiver (leave `RF 1` enabled when done so lap detection works!). |
| `CHANNELS <f1..f8>` / `CHANNELS RESET` | Temporarily overrides the 8 monitored MHz channels (`5180`..`5917`) or restores saved channels. |
| `CHANNELS MASK <0..255>` | Bitmask of active channels (`0xFF` = all 8 channels). |
| `NETCHANNELS <f1..f8>` | Persists & broadcasts the active pilot channel table from Hub to Spokes. |
| `IDENTIFY [FP] 1\|0` | Blinks the status LED rapidly on the local timer or a target Spoke fingerprint. |
| `BLEPAIR CLEAR` | (BLE Hub firmware only) Clears saved Claim-on-Pair `AUTH` key and returns the BLE Hub to `pairingMode: true` (equivalent to holding physical **BOOT** for 3 seconds). |
| `BLESYNC 0\|1` | (BLE Hub firmware only) Toggles BLE connection-event sweep phase lock (`1` = enabled). |
| `LOG 0\|1` | Mirrors ESP-IDF firmware log lines over USB. |
| `REBOOT` | Cleanly reboots the timer (`ESP_RST_SW`). |

### Bluetooth LE Bench Testing Notes (macOS & Linux)
- **Claim-on-Pair `AUTH` Lock**: On BLE Hub firmware (`slaprf-xiao-c5-ble.bin`), the first command over GATT RX must be `AUTH <32-hex-key>\n` (handled automatically by `usb.Manager`). Unauthenticated GATT peers are disconnected. Send `BLEPAIR CLEAR` over USB (or hold **BOOT** for 3 seconds) before pairing with a different host DB.
- **Linux BlueZ Non-`hci0` Adapters**: `tinygo.org/x/bluetooth`'s `DefaultAdapter` hardcodes `hci0`, so `internal/usb/ble_adapter_linux.go` enumerates `org.bluez.Adapter1` over D-Bus (preferring the first `Powered: true` adapter in natural `hciN` order, with sysfs fallback). Set `SLAPRF_BLE_ADAPTER=hci1` to override adapter selection. Inspect controllers with `bluetoothctl list` and `busctl tree org.bluez`.
- **Linux API Bench Order**: `PUT /v1/hardware/mode` updates whichever engine is currently active (Simulator vs Real). When driving a fresh server over REST for real hardware tests, stop the simulator (`PATCH /v1/sim` `{"running":false}`) **before** calling `PUT /v1/hardware/mode` `{"mode":"slaprf_ble"}` so `SetBLEScanEnabled(true)` activates on the real engine.
- **macOS SSH TCC Caveat**: Running a BLE scan directly inside a headless `sshd` session checks TCC permissions against `sshd-keygen-wrapper` (`bluetooth is not authorized for this app`). On macOS, launch `slaprf` from a GUI user context (`Terminal.app` or via `open -n` on a signed `.app` bundle with `NSBluetoothAlwaysUsageDescription`) so macOS displays the Bluetooth permission prompt.

---

## 4. Ready-Made Bench Python Scripts (`firmware/tools/`)

```bash
# 1. Full console protocol & RF sweep smoke check (STATUS?, LIVE 1, SCAN, LOG 1, SLAPRF?, BOOTLOG?, CHANNELS)
python firmware/tools/console_check.py COM3

# 2. Capture boot banner after clean RTS reset (or read live output without resetting)
python firmware/tools/serial_capture.py COM3 8
python firmware/tools/serial_capture.py COM3 4 --no-reset --send "STATUS?\n"

# 3. 50 Hz per-channel RF noise floor, standard deviation, and false-trigger statistics over 15 seconds
python firmware/tools/noise_stats.py COM3 15
```
