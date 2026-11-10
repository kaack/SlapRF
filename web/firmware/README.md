# Compiled firmware image

CI (`.github/workflows/firmware.yml`) builds the `firmware/slaprf/` ESP-IDF project and drops the merged flash image here as `slaprf-xiao-c5.bin` before building the web app and the release. Locally, `firmware/tools/build_local.ps1` writes the same file.

- The web flasher fetches `./firmware/slaprf-xiao-c5.bin` and patches the `SLAPRF02` config block in the browser.
- If the image is missing (for example a local dev checkout without ESP-IDF), the build falls back to a placeholder image that flashes but doesn't run.

`slaprf-xiao-c5.bin` is committed (force-added despite the `*.bin` ignore rule) so dev checkouts flash real firmware; CI overwrites it with a fresh build.