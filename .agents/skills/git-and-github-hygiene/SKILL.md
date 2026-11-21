---
name: git-and-github-hygiene
description: >-
  Enforce Git and GitHub workflow hygiene in SlapRF: Conventional Commits formatting, committing
  locally at frequent incremental checkpoints to preserve history and prevent lost work, staging
  discipline, rebasing/cleaning up local commits before pushing to origin, and PR/branch hygiene.
  Activate whenever committing, rebasing, managing branches, or pushing to GitHub.
---

# Git & GitHub Hygiene

Follow these practices throughout development so work is never lost, commit history stays bisectable and readable, and remote pushes are clean.

## 1. Commit Early & Often Locally (Incremental Checkpoints)

- **Checkpoint at every working milestone**: Whenever a logical unit compiles and passes relevant tests (a bug fix, a refactor step, a new endpoint, a test addition), create a **local commit** immediately rather than accumulating large, multi-topic uncommitted diffs.
- **Local commit != remote push**: Even when the user asks to preview changes locally before pushing to GitHub, you should still make clean local commits at milestones so every intermediate state is recoverable in `git reflog` / `git log`. Hold `git push` until approval.

---

## 2. Conventional Commits Format

Every commit message must follow **Conventional Commits**:

```text
<type>(<optional-scope>): <imperative summary in lowercase, <= 72 chars>

<optional concise body explaining "why" and key root causes when non-trivial>
```

### Standard Types & Scopes in SlapRF
- **Types**:
  - `feat`: User-facing feature or API capability
  - `fix`: Bug fix (UI, timing engine, firmware, transport)
  - `perf`: Latency, allocation, or frame-rate improvement
  - `refactor`: Internal restructuring with no behavior change
  - `test`: Adding or tightening unit / E2E tests
  - `docs`: Documentation (`README.md`, `docs-site/`, API specs)
  - `ci`: GitHub Actions workflows (`.github/workflows/`)
  - `build`: Build tools (`cmd/build-*`, `scripts/`, toolchains)
  - `chore`: Repo maintenance, `.agents/` skills/configs
- **Common Scopes**: `web`, `api`, `tracker`, `race`, `ingest`, `dsp`, `firmware`, `ble`, `usb`, `android`, `docs`, `readme`, `e2e`, `agents`.
- **Skipping Redundant Deploys**: Append `[skip ci]` to `chore(agents): ...` or non-shipped repo metadata commits on `main` when a full `pages.yml` rebuild is unnecessary.

---

## 3. Staging Discipline (Never Blindly `git add -A`)

Before every commit:
1. Reset generated timestamp noise if `cmd/build-web` ran:
   ```bash
   git checkout -- internal/api/generated/version.json
   ```
2. Inspect the working tree:
   ```bash
   git status -s
   git diff --stat
   ```
3. Stage **explicit paths** (`git add path/to/file1 path/to/file2`) instead of `git add .` or `git add -A`:
   - Never stage untracked user scratch files, local `.db` databases, temporary debug scripts, or unintended edits to `web/firmware/slaprf-xiao-c5.bin`.
   - Ensure `cmd/slaprf/site/.keep` and `cmd/slaprf-android/site/.keep` remain tracked and intact.

---

## 4. Rebasing & Cleaning History Before Pushing

Before pushing local commits to `origin`:

1. **Fetch & Rebase onto Latest Upstream**:
   Keep history linear (avoid unnecessary merge commits on `main` or feature branches):
   ```bash
   git fetch origin
   git log --oneline origin/main..HEAD
   git rebase origin/main
   ```
2. **Squash / Fixup Noisy Local Checkpoints When Appropriate**:
   - Keep distinct logical commits separate (for example `fix(web): unlock announcer autoplay on first gesture` followed by `fix(web): stabilize debug Auto X signal window`).
   - If your unpushed local history has follow-up fixups (`fixup! ...`, typo fixes, or trial-and-error tweaks to an earlier unpushed commit), fold them cleanly before pushing:
     ```bash
     # Commit a fixup targeting an unpushed commit <SHA>:
     git commit --fixup=<SHA>
     # Non-interactively autosquash unpushed commits onto origin/main:
     GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main
     ```
3. **Re-Verify After Rebasing**:
   Run `go test ./...` if the rebase resolved any conflicts or combined commits.
4. **Safety Rule on Shared History**:
   Never `rebase` or `push --force` commits that are already published on `origin/main` or referenced by a release tag unless the user explicitly asks for it. On feature/PR branches where rebasing is expected, always use `git push --force-with-lease`.
