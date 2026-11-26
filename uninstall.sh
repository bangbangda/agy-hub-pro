#!/usr/bin/env bash
# ==============================================================================
# agy-hub-pro / uninstall.sh
#
# Cleanly removes AGY Hub Pro's statusLine and lifecycle hook registrations
# while strictly preserving all other user settings (mcpServers, permissions,
# trustedWorkspaces, model, etc.) and creating timestamped backups.
#
# Usage:
#   ./uninstall.sh           # Remove statusLine, hooks, and runtime cache
#   ./uninstall.sh --purge   # Also remove ~/.gemini/plugins/agy-hub-pro directory
#
# Remote one-liner:
#   curl -fsSL https://raw.githubusercontent.com/bangbangda/agy-hub-pro/main/uninstall.sh | bash
# ==============================================================================
set -euo pipefail

DEFAULT_INSTALL_DIR="${AGY_HUB_INSTALL_DIR:-${HOME}/.gemini/plugins/agy-hub-pro}"

BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[1;31m'
RESET=$'\033[0m'

log_header() { printf "\n${BOLD}${CYAN}▶ %s${RESET}\n" "$1"; }
log_ok()     { printf "${GREEN}✓${RESET} %s\n" "$1"; }
log_warn()   { printf "${YELLOW}!${RESET} %s\n" "$1"; }
log_err()    { printf "${RED}✗${RESET} %s\n" "$1" >&2; }

if ! command -v node >/dev/null 2>&1; then
  log_err "Node.js is required to safely edit JSON config files."
  exit 1
fi

PURGE=0
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=1 ;;
    --help|-h)
      echo "Usage: $0 [--purge]"
      exit 0
      ;;
    *)
      log_err "Unknown option: ${arg}"
      exit 1
      ;;
  esac
done

TS="$(date +%Y%m%d%H%M%S)"
log_header "Uninstalling AGY Hub Pro (preserving all other user configurations)"

node - "${TS}" <<'NODE_EOF'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ts = process.argv[2];
const home = os.homedir();
const explicitSettings = process.env.AGY_HUB_SETTINGS_FILE || '';
const settingsCandidates = explicitSettings
  ? [explicitSettings]
  : [
      path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
      path.join(home, '.gemini', 'settings.json'),
    ];

const seenReal = new Set();
let touchedSettings = 0;

for (const candidate of settingsCandidates) {
  if (!fs.existsSync(candidate)) continue;
  let realPath = candidate;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    continue;
  }
  if (seenReal.has(realPath)) continue;
  seenReal.add(realPath);

  let cfg;
  let fileMode = 0o644;
  try {
    fileMode = fs.statSync(realPath).mode & 0o777;
    cfg = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  } catch (err) {
    console.error(`WARN: Skipping invalid JSON in ${realPath}: ${err.message}`);
    continue;
  }

  const cmd = String(cfg?.statusLine?.command || '');
  if (cfg?.statusLine && /(agy-hu[bd]-pro|statusline\.mjs)/i.test(cmd)) {
    const backup = `${realPath}.bak.${ts}`;
    fs.copyFileSync(realPath, backup);
    delete cfg.statusLine;
    const tmp = `${realPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: fileMode });
    fs.renameSync(tmp, realPath);
    console.log(`✓ Removed statusLine from ${candidate} (backup: ${backup})`);
    touchedSettings++;
  } else if (cfg?.statusLine) {
    console.log(`! Preserved non-AGY-Hub-Pro statusLine in ${candidate}`);
  }
}

if (touchedSettings === 0) {
  console.log('• No AGY Hub Pro statusLine entry found in settings.json');
}

const hooksFile =
  process.env.AGY_HUB_HOOKS_FILE || path.join(home, '.gemini', 'config', 'hooks.json');
if (fs.existsSync(hooksFile)) {
  let realHooks = hooksFile;
  try {
    realHooks = fs.realpathSync(hooksFile);
  } catch {
    // ignore
  }
  try {
    const fileMode = fs.statSync(realHooks).mode & 0o777;
    const hooks = JSON.parse(fs.readFileSync(realHooks, 'utf8'));
    if (hooks && (hooks['agy-hub-pro'] || hooks['agy-hud-pro'])) {
      const backup = `${realHooks}.bak.${ts}`;
      fs.copyFileSync(realHooks, backup);
      delete hooks['agy-hub-pro'];
      delete hooks['agy-hud-pro'];
      const tmp = `${realHooks}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(hooks, null, 2)}\n`, { encoding: 'utf8', mode: fileMode });
      fs.renameSync(tmp, realHooks);
      console.log(`✓ Removed lifecycle hooks from ${hooksFile} (backup: ${backup})`);
    }
  } catch (err) {
    console.error(`WARN: Skipping invalid JSON in ${realHooks}: ${err.message}`);
  }
}
NODE_EOF

if [[ "${AGY_HUB_SKIP_AGY_CLI:-0}" != "1" ]] && command -v agy >/dev/null 2>&1; then
  agy plugin uninstall agy-hub-pro >/dev/null 2>&1 && log_ok "Uninstalled native plugin: agy-hub-pro" || true
  agy plugin uninstall agy-hud-pro >/dev/null 2>&1 && log_ok "Uninstalled legacy plugin: agy-hud-pro" || true
fi

DATA_DIR="${AGY_HUB_DATA_DIR:-${HOME}/.gemini/plugins/agy-hub-pro/data}"
if [[ -d "${DATA_DIR}" ]]; then
  rm -rf "${DATA_DIR}"
  log_ok "Removed runtime data directory: ${DATA_DIR}"
fi
rm -rf "/tmp/agy-hub-pro-data" "/tmp/agy-hud-last-stdin.json" 2>/dev/null || true

if [[ "${PURGE}" -eq 1 && -d "${DEFAULT_INSTALL_DIR}" ]]; then
  cwd_real="$(cd "$(pwd)" && pwd -P)"
  install_real="$(cd "${DEFAULT_INSTALL_DIR}" && pwd -P)"
  if [[ "${cwd_real}" != "${install_real}" ]]; then
    rm -rf "${DEFAULT_INSTALL_DIR}"
    log_ok "Purged plugin directory: ${DEFAULT_INSTALL_DIR}"
  else
    log_warn "Skipped purging ${DEFAULT_INSTALL_DIR} (current working directory)"
  fi
fi

printf "\n${BOLD}${GREEN}✔ AGY Hub Pro uninstalled cleanly.${RESET}\n"
