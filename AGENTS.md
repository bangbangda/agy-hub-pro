# AGENTS.md — AGY Hub Pro (`agy-hub-pro`)

## 1. Project Overview

**`agy-hub-pro`** is a lightweight, zero-dependency **Antigravity CLI (`agy`)** two-line StatusLine dashboard and lifecycle hooks plugin built on native Node.js ESM.

### Architecture & Key Files
- `plugin.json` — Native Antigravity plugin manifest (validated via `agy plugin validate`).
- `hooks.json` — Lifecycle hooks registered at plugin root (`SessionStart`, `PreInvocation`, `Stop`).
- `assets/logo.svg` — Vector plugin icon referenced by `plugin.json`.
- `statusline.mjs` — Millisecond synchronous StatusLine renderer & built-in diagnostics CLI (`--test`, `--doctor`, `--version`, `--help`):
  - Dynamically resolves plugin root via `import.meta.url` and stores runtime files in `~/.gemini/plugins/agy-hub-pro/data/` (falling back to OS temp dir if unwritable).
  - Reads live `agy` JSON telemetry from `stdin` (dumps snapshot to `data/last-stdin.json` for field sniffing).
  - Renders a compact 2-line ANSI dashboard with responsive `terminal_width` trimming.
  - Auto-syncs incremental cross-session token usage into local `data/state.json` (atomic writes).
  - Runs `git --no-optional-locks status --porcelain=v1 -b` with a strict timeout and `.git/HEAD` fallback.
- `collector.mjs` — Lifecycle hook dispatcher & detached background quota/ledger worker (`SessionStart`, `Stop`/`AfterAgent`, `PreInvocation`/`UserPromptSubmit`, `--refresh`).
- `install.sh` — Remote (`curl | bash`) & local installer with auto-detection of active `settings.json` (symlink-aware), timestamped backup (`*.bak.YYYYMMDDHHMMSS`), safe JSON deep merge, and end-to-end simulation test suite (`--test`).
- `uninstall.sh` — Standalone & remote clean uninstaller removing only `agy-hub-pro` entries while preserving all other user configurations.
- `README.md` / `README_CN.md` — English and Simplified Chinese documentation.
- `.github/workflows/ci.yml` — Automated GitHub Actions CI pipeline validating syntax, manifests, `--test`, and simulation tests on every PR and push to `main`.

### Engineering Constraints
- **Zero external npm dependencies**: Use Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:os`, `node:url`) only to guarantee millisecond startup.
- **Never crash `agy`**: Both `statusline.mjs` and `collector.mjs` must degrade gracefully, catch I/O or JSON errors, and always emit valid stdout with exit code `0`.
- **Keep hooks non-blocking**: Any slow/background work must be spawned detached (`detached: true`, `stdio: 'ignore'`, `child.unref()`).
- **No secrets or runtime state in Git**: Never commit `data/`, `state.json`, `collector.lock`, `last-stdin.json`, `*.bak*`, `*.tmp`, personal paths/emails, or OAuth credentials.
- **Sync with active plugin directory**: If the plugin is installed at `~/.gemini/plugins/agy-hub-pro/`, keep runtime updates aligned only after changes are verified.

---

## 2. Branching & Development Workflow (Mandatory)

### Branch-First Rule (Strictly Before Any Edits)
- **Always create and switch to a new branch BEFORE modifying any file.**
- Editing code, scripts, manifests, or documentation directly on `main` (even temporarily before branching) is **strictly prohibited**.
- Direct commits or direct pushes to `main` are **prohibited** for all feature updates, bug fixes, refactors, docs, and workflow changes.
- Before starting any development task, run the branch setup steps below and verify `git branch --show-current` is **not** `main`. If branch creation fails (e.g., due to environment/permission restrictions), resolve it **first** before making any file changes.

### Branch Naming Convention
Always create a fresh branch from an up-to-date `main`:
- `feat/<short-description>` — New features or display enhancements
- `fix/<short-description>` — Bug fixes
- `refactor/<short-description>` — Engineering or structural refactors
- `docs/<short-description>` — Documentation updates (`README*.md`, `AGENTS.md`)
- `chore/<short-description>` — CI, tooling, or maintenance changes

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/<short-description>
git branch --show-current   # Must NOT be "main" before editing any file
```

### Commit Message Convention
Follow **Conventional Commits**:
- `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `chore: ...`

---

## 3. Pre-Merge Testing & Verification Gate (Mandatory)

Before opening or merging any Pull Request, **all** of the following local checks must pass with exit code `0`:

1. **JavaScript ESM & Shell Syntax Check**:
   ```bash
   node --check statusline.mjs && node --check collector.mjs && bash -n install.sh && bash -n uninstall.sh
   ```
2. **Manifest & Hook JSON Validation**:
   ```bash
   node -e 'for (const f of ["plugin.json","hooks.json"]) JSON.parse(require("fs").readFileSync(f,"utf8"))'
   ```
3. **Built-in CLI Preview & Full Simulation Suite**:
   ```bash
   node statusline.mjs --test && ./install.sh --test
   ```
   This verifies:
   - Executable bits on `statusline.mjs`, `collector.mjs`, `install.sh`, and `uninstall.sh`
   - `agy plugin validate .` (when `agy` CLI is available)
   - Built-in `--test` preview and `--doctor` diagnostics (against isolated mounted symlinked config)
   - `SessionStart`, `Stop` (including 7-day ledger pruning), and `PreInvocation` / `UserPromptSubmit` low-quota warning injection
   - All 3 threshold color tiers (`≤80%` green, `>80%` yellow, `>90%` red), Git dirty/clean states, non-Git fallback, and responsive output
   - Safe JSON deep merge, symlink preservation, timestamped backup creation, and clean uninstall
4. **Clean Working Tree & Secret Check**:
   - Confirm `git status` contains no untracked runtime files (`data/`, `state.json`, `collector.lock`, `node_modules/`) or personal PII/credentials.

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
   - After merging to `main`, sync updated files to `~/.gemini/plugins/agy-hub-pro/` (or re-run `./install.sh --install`).
