# Compiled firmware images

CI (`.github/workflows/firmware.yml`) builds every `firmware/<profile>/` ESP-IDF project and drops the merged flash images here as `slaprf-xiao-c5-<profile>.bin` before building the web app and the release binaries.

- The web flasher fetches `./firmware/slaprf-xiao-c5-<profile>.bin` and patches the `SLAPRF02` config block in the browser.
- The Go server patches the same files for `/api/firmware/xiao-c5.bin`.
- If an image is missing (for example a local dev checkout without ESP-IDF), both fall back to a placeholder image that flashes but doesn't run.

The `.bin` files are build outputs and are ignored by git.
