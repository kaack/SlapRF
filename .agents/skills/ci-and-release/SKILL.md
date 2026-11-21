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
| `release.yml` | Push `v*` tag, `workflow_dispatch` | Runs `verify` + `firmware` + `web_bundle`, builds 5 SlapRF Portable binaries + signed `slaprf-android-arm64.apk`, and publishes the GitHub Release using `docs/releases/<tag>.md`. |
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

**Every release must include structured release notes in `docs/releases/vX.Y.Z.md` committed before creating the `vX.Y.Z` tag.** (GitHub's automatic `generate_release_notes` only lists merged PRs and produces empty release bodies when commits land directly on `main`.)

### How to Audit Changes Before Writing Notes
Do not just copy raw commit subject lines. Inspect both the commit log and the actual diffs across user-facing and integration boundaries since the previous tag (`${PREV}`):
```bash
PREV=$(git tag --sort=-v:refname | head -n 1)
git log "${PREV}..HEAD" --no-merges --oneline
git diff --stat "${PREV}..HEAD" -- internal/api/ docs-site/static/specs/ firmware/ cmd/ web/src/
```
Explicitly check all **4 Breaking-Change & Upgrade Boundaries**:
1. **Firmware compatibility (`firmware/`, `internal/firmware/`, `WIRE_PROTO_VER`)**: State clearly whether existing field timers require reflashing or remain compatible without reflashing.
2. **REST & WebSocket API (`internal/api/`, `openapi.yaml`, `asyncapi.yaml`)**: Call out any renamed/removed routes, changed payload fields, or new endpoints.
3. **Storage & backup format (`internal/storage/`, `engine_persistence.ts`)**: Note any database migrations or export/import changes.
4. **CLI flags, ports & defaults (`cmd/slaprf`, `:8080`, `:5403`)**: Flag any changed startup flags or network port defaults.

### Release Notes Template & Style
Read and follow the `technical-writing-ste` skill (active voice, concrete technical facts and units, zero AI slop, zero em-dashes). Group user-relevant changes by impact (omit internal `[skip ci]` agent-config chores unless user-facing) and include only sections that apply:

```markdown
## Highlights
One or two crisp sentences summarizing the headline changes in this release.

## Breaking Changes
- Omit this section completely when there are no breaking changes.
- When present, state what changed and the exact migration action required.

## New Features
- **Feature area**: Concrete description of what users or integrators can now do.

## Improvements
- **Subsystem**: Concrete UX, latency, build, or documentation improvements.

## Bug Fixes
- **Component**: Exact user-visible symptom resolved and affected platforms/modes.

## Downloads & Firmware Compatibility
- **App binaries**: Single-file executables for Windows, macOS (`arm64` / `amd64`), Linux (`amd64` / `arm64`), and Android (`arm64-v8a` APK).
- **XIAO ESP32-C5 firmware**: `slaprf-xiao-c5.bin` (USB Hub & Spokes) and `slaprf-xiao-c5-ble.bin` (Bluetooth Hub), wire protocol `v2` (state whether existing timers need reflashing).

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
   *(If you ever need to amend release notes on an already-published release without re-running builds, update `docs/releases/vX.Y.Z.md` and run `gh release edit vX.Y.Z --notes-file docs/releases/vX.Y.Z.md`.)*
