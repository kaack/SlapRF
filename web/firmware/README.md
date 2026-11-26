# Compiled firmware image

CI (`.github/workflows/firmware.yml`) builds the `firmware/slaprf/` ESP-IDF project and drops the merged flash image here as `slaprf-xiao-c5.bin` before building the web app and the release. Locally, `firmware/tools/build_local.ps1` writes the same file.

- The web flasher fetches `./firmware/slaprf-xiao-c5.bin` and patches the `SLAPRF02` config block in the browser.
- If the image is missing (for example a local dev checkout without ESP-IDF), the build falls back to a placeholder image that flashes but doesn't run.

`slaprf-xiao-c5.bin` is committed (force-added despite the `*.bin` ignore rule) so dev checkouts flash real firmware; CI overwrites it with a fresh build.
## Bluetooth Hub image (optional)

CI also builds `firmware/slaprf_ble/` into `slaprf-xiao-c5-ble.bin` (same layout and the same `SLAPRF02` block). When it is present here, the flasher offers **Hub connection: Bluetooth** for the Hub role and patches this image instead (role forced to Hub). When it is missing, the Bluetooth option is shown disabled; there is no placeholder for it.

## ESP32-P4 PoE Bridge image

CI builds `firmware/slaprf_p4_poe_bridge/` into `slaprf-p4-poe-bridge.bin` (locally built by `firmware/tools/build_local_p4.sh` and force-tracked alongside `slaprf-xiao-c5.bin` and `slaprf-xiao-c5-ble.bin` so dev checkouts and CI verification serve all three compiled images).
