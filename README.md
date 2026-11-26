# agy-hub-pro (AGY Hub Pro)

[![Release](https://img.shields.io/github/v/release/bangbangda/agy-hub-pro?style=flat-square&color=blue)](https://github.com/bangbangda/agy-hub-pro/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/bangbangda/agy-hub-pro/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/bangbangda/agy-hub-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#privacy--security)
[![Node.js >= 18 ESM](https://img.shields.io/badge/node-%3E%3D18%20ESM-339933?style=flat-square&logo=node.js&logoColor=white)](#10-second-quick-install)

**English** | [简体中文](./README_CN.md)

A lightweight, **zero-dependency**, self-contained **Antigravity CLI (`agy`)** two-line StatusLine HUD and lifecycle hooks plugin built purely on native Node.js ESM (`node:*`). Millisecond synchronous rendering, safe non-destructive config merging, and zero terminal input lag.

![AGY Hub Pro Terminal Preview](./assets/preview.png)

```text
agy-hub-pro (git:main✓) │ Ctx: ◉○○○○ 17.4% (174K/1M) │ Tok: 1.4M │ Cache: 99% │ 5h: ◉◉◉◉○ 79% (3h18m) │ Wk: ◉◉◉◉○ 73% (5d7h)
[Gemini 4 Neon · High] │ User: dev@example.com │ Plan: Google AI Pro │ Mode: auto │ Sandbox: OFF │ ● run_command 18s · ~56 t/s
```

---

## 10-Second Quick Install

No `npm install`, no `pnpm install`, no build step. Works immediately on macOS & Linux with Node.js `>= 18`.

### Option 1: One-Line Installer (Recommended — Full HUD + Hooks)

Auto-clones to `~/.gemini/plugins/agy-hub-pro`, detects your active config (`~/.gemini/antigravity-cli/settings.json` or `~/.gemini/settings.json`, symlink-aware), creates a timestamped backup (`settings.json.bak.YYYYMMDDHHMMSS`), deep-merges `statusLine` without touching your existing `mcpServers` / `trustedWorkspaces` / `permissions` / `model`, and registers lifecycle hooks:

```bash
curl -fsSL https://raw.githubusercontent.com/bangbangda/agy-hub-pro/main/install.sh | bash
```

### Option 2: Native `agy plugin install`

Install directly as a native Antigravity plugin (automatically loads `plugin.json` and root `hooks.json`):

```bash
agy plugin install bangbangda/agy-hub-pro
```

Then enable the StatusLine inside an active `agy` session (or run `./install.sh --install` inside the installed plugin directory):

```text
/statusline node ~/.gemini/plugins/agy-hub-pro/statusline.mjs
```

### Option 3: Local Clone & Preview First

```bash
git clone https://github.com/bangbangda/agy-hub-pro.git ~/.gemini/plugins/agy-hub-pro
cd ~/.gemini/plugins/agy-hub-pro

node statusline.mjs --test      # Instant ANSI preview (zero disk writes)
./install.sh --install          # Backup + safe deep-merge settings.json & hooks
node statusline.mjs --doctor    # Verify everything is green
```

### Optional: Pin Input & Two-Line HUD to the Bottom

Run `/settings` inside `agy` and set **Alt Screen Mode** to `always` (or add `"altScreenMode": "always"` to `~/.gemini/antigravity-cli/settings.json`) to keep the prompt composer and HUD pinned to the bottom of your terminal.

### Clean Uninstall

Removes **only** AGY Hub Pro's `statusLine` and lifecycle hook entries (creates a timestamped backup and leaves all your other settings untouched):

```bash
# Local
~/.gemini/plugins/agy-hub-pro/uninstall.sh          # Remove config hooks & cache
~/.gemini/plugins/agy-hub-pro/uninstall.sh --purge  # Also delete plugin directory

# Or remotely via curl
curl -fsSL https://raw.githubusercontent.com/bangbangda/agy-hub-pro/main/uninstall.sh | bash
```

---

## Complete Field & Icon Reference

AGY Hub Pro renders two compact lines that automatically trim lower-priority fields when `terminal_width` narrows so split panes never wrap awkwardly.

### Line 1 — Workspace, Git, Context, Net Tokens, Cache & Quota

| Segment | Example | Meaning |
| :--- | :--- | :--- |
| **Workspace + Git** | `agy-hub-pro (git:main✓)` | Active directory basename + Git branch. `✓` (green) = clean working tree; `*` (yellow) = dirty. |
| **Git Sync Arrows** | `↑2↓1` | Commits ahead (`↑` cyan) / behind (`↓` magenta) upstream tracking branch. |
| **Git Dirty Breakdown** | `(+2 ~3 ?1)` | `+N` staged (green), `~N` modified (yellow), `?N` untracked (dim). Shows `…` if `git status` timed out and fell back to direct `.git/HEAD` read. |
| **Context Window** | `Ctx: ◉○○○○ 17.4% (174K/1M)` | 5-dot progress bar + used percentage + compact `used/max` tokens. |
| **Session Net Tokens** | `Tok: 1.4M` | Exact incremental current-session `input + output` tokens from `transcript.jsonl` (excludes cache reads). |
| **Prompt Cache** | `Cache: 99%` | Prompt cache read hit ratio. Green `≥70%`, Yellow `40–69%`, Red `<40%`. |
| **5-Hour Quota** | `5h: ◉◉◉◉○ 79% (3h18m)` | Remaining 5h quota % + reset countdown. |
| **Fast-Burn Warning** | `⚡快` | Shown inside `5h` when remaining `<70%` and burn rate exceeds `1.25×` elapsed time in the 5h window. |
| **Weekly Quota** | `Wk: ◉◉◉◉○ 73% (5d7h)` | Remaining weekly quota % + reset countdown. |
| **Local Estimate Prefix** | `~92%` | Tilde `~` indicates quota is estimated locally from the 7-day token ledger when live cloud quota is absent. |

### Line 2 — Model, Account, Plan, Mode, Sandbox & Live Activity

| Segment | Example | Meaning |
| :--- | :--- | :--- |
| **Model & Reasoning Effort** | `[Gemini 4 Neon · High]` | Active model display name + effort badge (`Off`/`Min`/`Low`/`Medium`/`High`/`XHigh`/`Max`). |
| **Account** | `User: dev@example.com` | Active `agy` account email/username (trimmed first on narrow terminals). |
| **Plan Tier** | `Plan: Google AI Pro` | Subscription tier colored by level (Ultra/Max yellow, Pro/Team cyan, Free gray). |
| **Execution Mode** | `Mode: auto` | Active execution mode (`auto` green, `plan` cyan, `accept-edits` yellow). |
| **Sandbox** | `Sandbox: OFF` | Terminal sandbox status (`ON` green, `OFF` yellow). |
| **Live Activity & Speed** | `● run_command 18s · ~56 t/s` | Active status dot (green while progressing, yellow after `60s` stall), current tool/thinking label, elapsed timer, and output throughput (`~t/s` persists per terminal window across `/clear`). |

### 5-Dot Threshold Colors & Styles

| Consumed Usage | Color | Applies To |
| :--- | :--- | :--- |
| `≤ 80%` | Green | `Ctx` used `≤80%`, `5h`/`Wk` remaining `≥20%` |
| `> 80%` | Yellow | `Ctx` used `>80%`, `5h`/`Wk` remaining `<20%` |
| `> 90%` | Red | `Ctx` used `>90%`, `5h`/`Wk` remaining `<10%` |

Switch progress bar glyphs via `AGY_HUB_DOT_STYLE`:
- `bullseye` (default): `◉◉◉○○`
- `pill`: `▰▰▰▱▱`
- `small`: `•••◦◦`
- `square`: `▪▪▪▫▫`
- `diamond`: `◆◆◆◇◇`
- `classic`: `●●●○○`

### Lifecycle Hooks (`hooks.json`)

- **`SessionStart`**: Cleans stale `collector.lock` and triggers a non-blocking detached background refresh.
- **`Stop`**: Accumulates incremental per-turn tokens into the 7-day rolling ledger and auto-prunes expired entries.
- **`PreInvocation`**: Injects a concise system notice recommending `/model gemini-4-hydrogen` when 5h or weekly remaining quota drops below `15%`.

---

## Privacy & Security

- **100% Local Execution**: Every script runs purely on your local machine using Node.js built-in modules (`node:fs`, `node:os`, `node:path`, `node:child_process`, `node:url`).
- **Zero Telemetry & Zero Network Calls**: `statusline.mjs` and `collector.mjs` make **zero** outbound HTTP requests and report **zero** analytics, prompts, or code.
- **Zero External Dependencies**: No `node_modules`, no third-party npm packages, no supply-chain bloat.
- **Credentials Untouched**: OAuth tokens and API keys are never read, copied, logged, or transmitted.
- **Contained Local Storage**: Runtime state (`state.json`, `collector.lock`, `last-stdin.json`) is stored strictly inside `~/.gemini/plugins/agy-hub-pro/data/` (falling back to OS temp dir if unwritable), written atomically, and auto-pruned beyond 7 days.

---

## Diagnostics & Troubleshooting (`--doctor` / `--test`)

Run the built-in diagnostics and preview commands anytime:

```bash
# Preview all 3 color tiers & responsive width trimming in your terminal
node ~/.gemini/plugins/agy-hub-pro/statusline.mjs --test

# Run full environment, config mount, symlink & cache permission diagnostics
node ~/.gemini/plugins/agy-hub-pro/statusline.mjs --doctor

# Machine-readable JSON output for scripts / CI
node ~/.gemini/plugins/agy-hub-pro/statusline.mjs --doctor --json
```

### What `--doctor` Checks & Common Fixes

| Check | What It Verifies | Quick Fix if `WARN` / `FAIL` |
| :--- | :--- | :--- |
| **Node.js Runtime** | Node.js `>= 18.0.0` | Upgrade Node.js (`brew install node` or `nvm install 22`). |
| **Plugin Integrity** | Manifests parse cleanly, scripts exist & have `+x` | Run `chmod +x statusline.mjs collector.mjs install.sh uninstall.sh`. |
| **Git Command** | `git` binary availability & response speed | Install Git (`xcode-select --install` / `apt install git`). HUD gracefully falls back to `.git/HEAD` if absent. |
| **Settings & StatusLine Mount** | Auto-detects `~/.gemini/antigravity-cli/settings.json` & `~/.gemini/settings.json` (including symlinks), validates JSON, checks `statusLine.command` target | Run `~/.gemini/plugins/agy-hub-pro/install.sh --install` or inside `agy` run `/statusline node ~/.gemini/plugins/agy-hub-pro/statusline.mjs`. |
| **Lifecycle Hooks** | Checks native plugin hooks or `~/.gemini/config/hooks.json` & warns on duplicate legacy `agy-hud-pro` keys | Re-run `./install.sh --install` to deduplicate and migrate legacy entries. |
| **Data & Cache Directory** | Performs live read/write/delete probe in `~/.gemini/plugins/agy-hub-pro/data/`, checks `state.json` & stale locks | Ensure directory is writable (`mkdir -p ~/.gemini/plugins/agy-hub-pro/data && chmod 755 ~/.gemini/plugins/agy-hub-pro/data`). |

> **Tip**: If `agy` ever pauses a custom statusline after repeated transient errors (`⚠ Statusline disabled after 30 consecutive failures`), fix the issue shown by `--doctor` and run `/statusline enable` inside `agy`.

---

## Environment Variables

All `AGY_HUB_*` variables also accept legacy `AGY_HUD_*` aliases for backward compatibility.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGY_HUB_DOT_STYLE` | `bullseye` | Glyph style: `bullseye` / `pill` / `small` / `square` / `diamond` / `classic` |
| `AGY_HUB_DATA_DIR` | `~/.gemini/plugins/agy-hub-pro/data` | Override local state, lock & stdin snapshot directory |
| `AGY_HUB_GIT_TIMEOUT_MS` | `150` | Timeout in ms for `git status` (falls back to `.git/HEAD` read on timeout) |
| `AGY_HUB_STALL_SEC` | `60` | Seconds without token or transcript step progress before live indicator turns yellow |
| `AGY_HUB_SHOW_NON_GIT` | `0` | Set to `1` to display `(git:-)` outside Git repositories |
| `AGY_HUB_WARN_THRESHOLD` | `15` | Remaining quota % threshold for `PreInvocation` low-quota warnings |
| `AGY_HUB_5H_BUDGET` | `5000000` | Fallback 5-hour token budget for local estimation (`~` prefix) |
| `AGY_HUB_WEEK_BUDGET` | `40000000` | Fallback weekly token budget for local estimation (`~` prefix) |
| `AGY_HUB_SNIFF` | `1` | Set to `0` to disable dumping latest `stdin` payload to `data/last-stdin.json` |
| `NO_COLOR` | unset | Set to any non-empty value to disable ANSI escape colors |

---

## Project Structure

```text
agy-hub-pro/
├── plugin.json       # Native Antigravity plugin manifest
├── hooks.json        # Root lifecycle hooks (SessionStart / PreInvocation / Stop)
├── assets/
│   ├── logo.svg      # Vector plugin icon
│   └── preview.png   # Terminal statusline preview image
├── statusline.mjs    # Millisecond two-line ANSI StatusLine renderer + --test / --doctor CLI
├── collector.mjs     # Detached background quota prober & 7-day token ledger maintainer
├── install.sh        # Remote/local installer with safe deep-merge, backup & test suite
├── uninstall.sh      # Clean uninstaller preserving all other user configurations
├── LICENSE           # MIT License
├── README.md         # English documentation
└── README_CN.md      # Chinese documentation
```

## License

This project is licensed under the [MIT License](./LICENSE).
