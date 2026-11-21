---
name: ci-and-release
description: >-
  Trigger, monitor, and debug SlapRF GitHub Actions workflows (verify.yml, firmware.yml, docs.yml,
  pages.yml, release.yml, pr-report.yml) with the gh CLI, download Playwright E2E reports or
  firmware artifacts, and cut new vX.Y.Z releases. Activate when working with CI pipelines, GitHub
  Pages deployments, or versioned releases.
---

# GitHub Actions CI & Release Workflows

SlapRF uses six workflows in `.github/workflows/`:

| Workflow File | Trigger | Purpose |
| :--- | :--- | :--- |
| `verify.yml` | PRs, `workflow_dispatch`, called by `pages` & `release` | Runs `scripts/test.sh` (Go + Chromium unit tests), builds `_site` + `cmd/build-portable`, and runs Playwright E2E (`scripts/test-e2e.sh`). Uploads `slaprf-e2e-report` (`test-results/latest.html` + videos + traces). |
| `firmware.yml` | Push/PR touching `firmware/**`, `workflow_dispatch`, called by `pages` & `release` | Compiles `slaprf-xiao-c5.bin` (artifact `firmware`) and `slaprf-xiao-c5-ble.bin` (artifact `firmware-ble`) with ESP-IDF `v5.5.1`. |
| `docs.yml` | Push to `main` touching `docs-site/**`, `workflow_dispatch` | Fast (~35s) docs-only build (`cmd/build-docs`) updating only `/docs/docs/` on the `github-page` branch (`https://slaprf.app/docs/`). |
| `pages.yml` | Push to `main`, `v*` tags, `workflow_dispatch` | Full gated deployment (`verify` + `firmware` -> `cmd/build-web`) to the `github-page` branch (`https://slaprf.app` + `/docs/`). |
| `release.yml` | Push `v*` tag, `workflow_dispatch` | Runs `verify` + `firmware` + `web_bundle`, builds 5 SlapRF Portable binaries (`windows-amd64`, `macos-arm64`, `macos-amd64`, `linux-amd64`, `linux-arm64`) + signed `slaprf-android-arm64.apk`, and publishes the GitHub Release. |
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
```

### Downloading E2E Failure Videos & Playwright Traces
When `verify.yml` fails in CI, download `slaprf-e2e-report` to inspect `latest.html`, `.webm` recordings, and Playwright `trace.zip` archives locally:
```bash
gh run download <RUN_ID> -n slaprf-e2e-report -D ./ci-e2e-report
```

---

## 2. Cutting a New Release (`vX.Y.Z`)

Follow this checklist whenever the user requests a new release:

1. **Check Existing Tags & Clean Working Tree**:
   ```bash
   git tag --sort=-v:refname | head -n 5
   git checkout -- internal/api/generated/version.json
   git status -s
   ```
2. **Run Local Unit Verification**:
   ```bash
   go test ./...
   ```
3. **Commit & Push `main`**:
   ```bash
   git push origin main
   ```
4. **Create & Push Annotated SemVer Tag (`vX.Y.Z`)**:
   ```bash
   git tag -a v0.0.9 -m "v0.0.9"
   git push origin v0.0.9
   ```
   *(Note: Pushing `main` and `vX.Y.Z` together cancels the redundant `main` `pages.yml` run via the `github-page` concurrency group and runs both `pages.yml` and `release.yml` on `vX.Y.Z`.)*
5. **Verify Release Assets**:
   Monitor `release.yml` and confirm all 8 release assets are published:
   - `slaprf-xiao-c5.bin` & `slaprf-xiao-c5-ble.bin`
   - `slaprf-windows-amd64.exe`, `slaprf-macos-arm64`, `slaprf-macos-amd64`, `slaprf-linux-amd64`, `slaprf-linux-arm64`
   - `slaprf-android-arm64.apk`
   ```bash
   gh release view v0.0.9 --json assets --jq '.assets[].name'
   ```
