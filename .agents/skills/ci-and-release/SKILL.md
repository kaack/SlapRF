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

### Write & Format for Humans (Visual Breathing Room, Zero Wall of Text)
Release notes are read by pilots and race directors deciding what changed and whether to update. Make them visually inviting and effortless to scan in **15 to 20 seconds**:

1. **Visual Layout & Hierarchy**:
   - **Headline features table (`### ✨ What's New`)**: Present new features in a clean 2-column Markdown table (`| Feature | What Changed |`) so the eye scans left-to-right instead of wading through paragraphs.
   - **Horizontal dividers (`---`)**: Separate every major section with `---` to create generous vertical breathing room on GitHub's release page.
   - **Single-line bullets (`·` separator)**: Under `### 🛠️ Improvements` and `### 🩹 Bug Fixes`, format items as `- **Area** · Short plain-English update.` Keep each bullet tight (**8 to 16 words**) so it stays on **one line** on desktop without wrapping into a wall of text.
   - **Styled GitHub callout (`> [!TIP]` or `> [!IMPORTANT]`)**: Put firmware compatibility and any brief API/upgrade note inside a GitHub alert card at the bottom (use `[!IMPORTANT]` only when reflashing or manual migration is required; otherwise `[!TIP]`).
2. **Emoji Restraint (Section Headers Only)**:
   - Use **at most one emoji per `###` section header** (`### ✨ What's New`, `### 🛠️ Improvements`, `### 🩹 Bug Fixes`).
   - Put **zero emojis** inside table cells, bullet items, or callout boxes.
3. **Describe User Outcomes, Never Code Internals**:
   - **Never include** TypeScript/Go/C symbol names (`AppStore`, `DebugView`, `sync.Once`, `LOAD_NO_CACHE`), CSS breakpoints (`<= 860px`), OS/D-Bus/Mach-O plumbing (`org.bluez.Adapter1`, `__TEXT,__info_plist`, `GPU compositor translate`), repo file paths, CI workflow names (`verify.yml`), or shell brace globs (`/v1/{usb,bluetooth}/*`).
   - Explain what the user can now **do, see, or connect** using actual in-app screen and control names (**Practice**, **Races**, **Network**, **Signals**, **Simulator**, **Flasher**).
4. **Cut Noise & Redundancy**:
   - Aim for **3 to 5 table rows** and **3 to 5 bullets per list** (roll tiny related UI polish tweaks into one clean line; omit internal refactors, test/CI fixes, and routine doc edits).
   - Do **not** list attached binary filenames (`slaprf-windows-amd64.exe`, etc.); GitHub Releases already renders the **Assets** download box directly underneath the notes.
   - Follow `technical-writing-ste`: active voice, zero em-dashes (use `·`, colons, or parentheses), and zero AI marketing puffery (`seamless`, `effortless`, `robust`, `next-generation`, `under the hood`).

### Bad vs. Good Calibration
- **Bad (dense developer wall of text)**:
  > - **Android APK WebView cache**: Configured the Android `WebView` host to bypass stale HTTP disk cache entries (`LOAD_NO_CACHE`) so upgrading the APK always loads the newly embedded web bundle immediately.
  > - **Smooth Android IME keyboard drawers**: Animated mobile bottom-sheet drawers above the Android virtual keyboard using single-shot GPU compositor `translate` synchronization while keeping the bottom navigation bar fixed.
- **Good (airy, single-line human release notes)**:
  > - **Android** · App updates always load the fresh UI bundle immediately.
  > - **Mobile tab swiping** · Bottom-bar swipe order, natural flick physics, and smooth **More** drawer animations.

### How to Audit Changes Before Writing
Inspect commits since the previous tag (`${PREV}`) to understand what shipped, then translate user-visible changes into the visual template below:
```bash
PREV=$(git tag --sort=-v:refname | head -n 1)
git log "${PREV}..HEAD" --no-merges --oneline
```

### Release Notes Template
Include only sections (`### ✨ What's New`, `### 🛠️ Improvements`, `### 🩹 Bug Fixes`) that apply to the release, separated by `---`:

```markdown
### ✨ What's New

| Feature | What Changed |
| :--- | :--- |
| **Short Feature Name** | One concise plain-English sentence on what users can now do. |

---

### 🛠️ Improvements

- **Area** · Short single-line description of what is faster, clearer, or easier to use.

---

### 🩹 Bug Fixes

- **Area** · Short single-line description of the user-visible issue resolved.

---

> [!TIP]
> **No reflash needed** · Existing `v0.0.8+` XIAO ESP32-C5 timers are 100% compatible with `vX.Y.Z`.

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
