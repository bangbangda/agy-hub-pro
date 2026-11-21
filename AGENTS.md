# AGENTS.md — AGY HUD Pro (`agy-hub-pro`)

## 1. Project Overview

**`agy-hub-pro`** is a lightweight, zero-dependency **Antigravity CLI (`agy`)** two-line StatusLine dashboard and lifecycle hooks plugin built on native Node.js ESM.

### Architecture & Key Files
- `plugin.json` — Native Antigravity plugin manifest (validated via `agy plugin validate --strict`).
- `hooks.json` — Lifecycle hooks registered at plugin root (`SessionStart`, `PreInvocation`, `Stop`).
- `statusline.mjs` — Millisecond synchronous StatusLine renderer:
  - Reads live `agy` JSON telemetry from `stdin` (dumps snapshot to `/tmp/agy-hud-last-stdin.json` for field sniffing).
  - Renders a compact 2-line ANSI dashboard with responsive `terminal_width` trimming.
  - Auto-syncs incremental cross-session token usage into local `state.json` (atomic writes).
  - Runs `git --no-optional-locks status --porcelain=v1 -b` with a strict timeout and `.git/HEAD` fallback.
- `collector.mjs` — Lifecycle hook dispatcher & detached background quota/ledger worker (`SessionStart`, `Stop`/`AfterAgent`, `PreInvocation`/`UserPromptSubmit`, `--refresh`).
- `install.sh` — Permission setup, backup-and-merge installer (`~/.gemini/antigravity-cli/settings.json`), and end-to-end simulation test runner (`--test`).
- `.github/workflows/ci.yml` — Automated GitHub Actions CI pipeline validating syntax, manifests, and simulation tests on every PR and push to `main`.

### Engineering Constraints
- **Zero external npm dependencies**: Use Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:os`, `node:url`) only to guarantee millisecond startup.
- **Never crash `agy`**: Both `statusline.mjs` and `collector.mjs` must degrade gracefully, catch I/O or JSON errors, and always emit valid stdout with exit code `0`.
- **Keep hooks non-blocking**: Any slow/background work must be spawned detached (`detached: true`, `stdio: 'ignore'`, `child.unref()`).
- **No secrets or runtime state in Git**: Never commit `state.json`, `collector.lock`, `*.bak`, `*.tmp`, personal emails, or OAuth credentials.
- **Sync with active plugin directory**: If the plugin is installed at `~/.gemini/plugins/agy-hud-pro/`, keep runtime updates aligned only after changes are verified.

---

## 2. Branching & Development Workflow (Mandatory)

Direct commits or direct pushes to `main` are **prohibited** for all feature updates, bug fixes, refactors, and workflow changes.

### Branch Naming Convention
Always create a fresh branch from an up-to-date `main`:
- `feat/<short-description>` — New features or display enhancements
- `fix/<short-description>` — Bug fixes
- `docs/<short-description>` — Documentation updates (`README*.md`, `AGENTS.md`)
- `chore/<short-description>` — CI, tooling, or maintenance changes

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/<short-description>
```

### Commit Message Convention
Follow **Conventional Commits**:
- `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `chore: ...`

---

## 3. Pre-Merge Testing & Verification Gate (Mandatory)

Before opening or merging any Pull Request, **all** of the following local checks must pass with exit code `0`:

1. **JavaScript ESM Syntax Check**:
   ```bash
   node --check statusline.mjs && node --check collector.mjs
   ```
2. **Manifest & Hook JSON Validation**:
   ```bash
   node -e 'for (const f of ["plugin.json","hooks.json"]) JSON.parse(require("fs").readFileSync(f,"utf8"))'
   ```
3. **Full Simulation & Plugin Validation Suite**:
   ```bash
   ./install.sh --test
   ```
   This verifies:
   - Executable bits on `statusline.mjs`, `collector.mjs`, and `install.sh`
   - `agy plugin validate --strict .` (when `agy` CLI is available)
   - `SessionStart`, `Stop` (including 7-day ledger pruning), and `PreInvocation` / `UserPromptSubmit` low-quota warning injection
   - All 3 threshold color tiers (`≤80%` green, `>80%` yellow, `>90%` red), Git dirty/clean states, non-Git fallback, and responsive output
4. **Clean Working Tree & Secret Check**:
   - Confirm `git status` contains no untracked runtime files (`state.json`, `collector.lock`) or personal PII/credentials.

---

## 4. Pull Request & Merge Workflow (GitHub)

All changes must enter `main` through a GitHub Pull Request validated by GitHub Actions CI:

1. **Push the feature branch**:
   ```bash
   git push -u origin <branch-name>
   ```
2. **Open a Pull Request against `main`**:
   ```bash
   gh pr create --base main --title "<conventional title>" --body "<summary and test results>"
   ```
3. **Wait for GitHub Actions CI (`.github/workflows/ci.yml`)**:
   - Confirm all CI checks pass (`gh pr checks --watch`).
   - Do **not** merge if any CI check is failing or pending.
4. **Merge & Clean Up**:
   - Merge only after local tests + GitHub Actions CI are green (prefer squash merge to keep `main` history clean):
     ```bash
     gh pr merge --squash --delete-branch
     ```
   - Sync local `main` immediately after merge:
     ```bash
     git checkout main && git pull --ff-only origin main
     ```
5. **Update Local Installed Plugin (if applicable)**:
   - After merging to `main`, sync updated files to `~/.gemini/plugins/agy-hud-pro/` (or re-run `./install.sh --install`).
