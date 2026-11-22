---
name: ci-and-release
description: >-
  Trigger, monitor, and debug SlapRF GitHub Actions workflows (verify.yml, firmware.yml, docs.yml,
  pages.yml, release.yml, pr-report.yml) with the gh CLI, author structured release notes in
  docs/releases/vX.Y.Z.md, and publish vX.Y.Z releases. Activate when working with CI pipelines,
  GitHub Pages deployments, or versioned releases.
---

# GitHub Actions CI & Release Workflows

SlapRF uses six workflows in `.github/workflows/`:

| Workflow File | Trigger | Purpose |
| :--- | :--- | :--- |
| `verify.yml` | PRs, `workflow_dispatch`, called by `pages` & `release` | Runs `scripts/test.sh` (Go + Chromium unit tests), builds `_site` + `cmd/build-portable`, and runs Playwright E2E (`scripts/test-e2e.sh`). Uploads `slaprf-e2e-report` (`test-results/latest.html` + videos + traces). |
| `firmware.yml` | Push/PR touching `firmware/**`, `workflow_dispatch`, called by `pages` & `release` | Compiles `slaprf-xiao-c5.bin` (artifact `firmware`) and `slaprf-xiao-c5-ble.bin` (artifact `firmware-ble`) with ESP-IDF `v5.5.1`. |
| `docs.yml` | Push to `main` touching `docs-site/**`, `workflow_dispatch` | Fast (~35s) docs-only build (`cmd/build-docs`) updating only `/docs/docs/` on the `github-page` branch (`https://slaprf.app/docs/`). |
| `pages.yml` | Push to `main`, `v*` tags, `workflow_dispatch` | Full gated deployment (`verify` + `firmware` -> `cmd/build-web`) to the `github-page` branch (`https://slaprf.app` + `/docs/`). |
| `release.yml` | Push `v*` tag, `workflow_dispatch` | Runs `verify` + `firmware` + `web_bundle`, builds 5 SlapRF Portable binaries (`ubuntu-latest` `CGO_ENABLED=0` for Windows/Linux; `macos-latest` `CGO_ENABLED=1` with `CoreBluetooth` + `otool` verification for `darwin/arm64` & `darwin/amd64`) + signed `slaprf-android-arm64.apk`, and publishes the GitHub Release using `docs/releases/<tag>.md`. |
| `release-notes.yml` | Push to `main` touching `docs/releases/v*.md`, `workflow_dispatch` | Fast (~10s) sync that updates the body of an already-published GitHub Release whenever `docs/releases/vX.Y.Z.md` is edited on `main`, without rebuilding any binaries. |
| `pr-report.yml` | Completion of `Verify` on PRs | Posts/updates the Playwright E2E summary comment on pull requests. |

---

## 1. Triggering & Monitoring Workflows (`gh`)

```bash
# List recent workflow runs across the repo
gh run list --limit 10

# Manually dispatch a workflow on main (or --ref <branch>)
gh workflow run docs.yml
gh workflow run pages.yml
gh workflow run firmware.yml
gh workflow run verify.yml

# Watch a run live and exit non-zero if any job fails
gh run watch <RUN_ID> --exit-status

# Inspect failed step logs immediately
gh run view <RUN_ID> --log-failed

# Download E2E failure videos & Playwright traces
gh run download <RUN_ID> -n slaprf-e2e-report -D ./ci-e2e-report
```

---

## 2. Authoring Release Notes (`docs/releases/vX.Y.Z.md`)

**Every release must include human-readable release notes in `docs/releases/vX.Y.Z.md` committed before creating the `vX.Y.Z` tag.** (GitHub's automatic `generate_release_notes` only lists merged PRs and produces empty release bodies when commits land directly on `main`.)

### Write for Pilots & Race Directors, Not Compilers
Release notes are read by humans deciding what changed and whether to update. A reader should be able to scan the entire release in **20 seconds**.

1. **Describe User Outcomes, Never Code Internals**:
   - **Never include** TypeScript/Go/C symbol names (`AppStore`, `DebugView`, `sync.Once`, `LOAD_NO_CACHE`), CSS breakpoints (`<= 860px`), OS/D-Bus/Mach-O plumbing (`org.bluez.Adapter1`, `__TEXT,__info_plist`, `GPU compositor translate`), repo file paths, CI workflow names (`verify.yml`), or shell brace globs (`/v1/{usb,bluetooth}/*`).
   - Explain what the user can now **do, see, or connect** in plain English using actual in-app screen and button names (**Practice**, **Races**, **Network**, **Signals**, **Simulator**, **Flasher**).
2. **One Idea Per Bullet, Short & Scannable**:
   - Keep each bullet to **1 short sentence (roughly 12 to 22 words)**.
   - Never cram 3 or 4 sub-changes into a single 50-word compound bullet. Group tiny related UI polish tweaks into one clean summary sentence instead of listing every micro-commit.
   - Aim for **5 to 12 bullets total** across the entire release.
3. **Cut Noise & Redundancy**:
   - Omit internal refactors, test/CI fixes, agent skill edits, and routine doc tweaks that require zero user action.
   - Do **not** list attached binary filenames (`slaprf-windows-amd64.exe`, etc.); GitHub Releases already renders the **Assets** download table directly underneath the notes.
   - Follow `technical-writing-ste`: active voice, zero em-dashes, and zero AI marketing puffery (`seamless`, `effortless`, `robust`, `next-generation`, `under the hood`).

### Bad vs. Good Calibration
- **Bad (developer commit dump)**:
  > - **Android APK WebView cache**: Configured the Android `WebView` host to bypass stale HTTP disk cache entries (`LOAD_NO_CACHE`) so upgrading the APK always loads the newly embedded web bundle immediately.
  > - **Smooth Android IME keyboard drawers**: Animated mobile bottom-sheet drawers above the Android virtual keyboard using single-shot GPU compositor `translate` synchronization while keeping the bottom navigation bar fixed.
- **Good (human release notes)**:
  > - **Android app updates**: Updating the Android APK now loads the new UI immediately instead of serving cached files from the previous version.
  > - **Smoother mobile navigation & drawers**: Swipe across tabs in bottom-bar order with natural flick physics, smooth drawer animations, and clean keyboard handling.

### How to Audit Changes Before Writing
Inspect commits since the previous tag (`${PREV}`) to understand what shipped, then translate user-visible changes into plain English:
```bash
PREV=$(git tag --sort=-v:refname | head -n 1)
git log "${PREV}..HEAD" --no-merges --oneline
```
Check upgrade impact so you can add a 1-line callout at the bottom when needed:
- **Firmware compatibility**: State in one line whether existing XIAO ESP32-C5 timers work as-is or need reflashing.
- **Breaking changes (CLI / storage / REST API)**: Only add a short 1-sentence note if external scripts, saved data, or startup flags require user action.

### Release Notes Template
Include only sections (`### What's New`, `### Improvements`, `### Fixes`) that have items in the release:

```markdown
One plain-English sentence summarizing the most noticeable updates in this version.

### What's New
- **Short title**: Plain-English sentence describing what users can now do.

### Improvements
- **Short title**: Plain-English sentence describing what is faster, clearer, or easier to use.

### Fixes
- **Short title**: Plain-English sentence describing the user-visible problem that was fixed.

> **Firmware compatibility**: Existing `v0.0.8` or newer XIAO ESP32-C5 timers work without reflashing.

**Full Changelog**: https://github.com/kaack/SlapRF/compare/vX.Y.W...vX.Y.Z
```

---

## 3. Step-by-Step Release Checklist (`vX.Y.Z`)

1. **Inspect Commits Since Previous Tag**:
   ```bash
   PREV=$(git tag --sort=-v:refname | head -n 1)
   git log "${PREV}..HEAD" --oneline
   ```
2. **Write & Commit `docs/releases/vX.Y.Z.md`**:
   - Draft `docs/releases/vX.Y.Z.md` from the commits in `${PREV}..HEAD`.
   - Reset any timestamp-only `version.json` diff (`git checkout -- internal/api/generated/version.json`) and run `go test ./...`.
   - Commit `docs/releases/vX.Y.Z.md` using Conventional Commits:
     ```bash
     git add docs/releases/vX.Y.Z.md
     git commit -m "docs(release): add vX.Y.Z release notes"
     ```
3. **Push `main`, Tag `vX.Y.Z`, and Push Tag**:
   ```bash
   git push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. **Verify Published Release Body & All 8 Assets**:
   Monitor `release.yml` until green, then verify that both the release notes body and all 8 binary assets are live on GitHub Releases:
   ```bash
   gh release view vX.Y.Z
   gh release view vX.Y.Z --json assets --jq '.assets[].name'
   ```
   *(If you ever need to amend release notes on an already-published release without re-running builds, edit `docs/releases/vX.Y.Z.md` and push to `main`: `release-notes.yml` updates the live GitHub Release body automatically in ~10s.)*
