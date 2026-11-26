#!/usr/bin/env bash
# ==============================================================================
# agy-hub-pro / install.sh
#
# Zero-dependency installer, safe deep-merge config manager, uninstaller,
# diagnostics runner, and end-to-end simulation test suite.
#
# One-line remote install:
#   curl -fsSL https://raw.githubusercontent.com/bangbangda/agy-hub-pro/main/install.sh | bash
#
# Local usage:
#   ./install.sh --install     # Backup + deep-merge settings.json & register hooks
#   ./install.sh --uninstall   # Cleanly remove statusLine & hooks (preserves all other config)
#   ./install.sh --doctor      # Run built-in environment & mount diagnostics
#   ./install.sh --test        # Run full simulation & deep-merge/uninstall test suite
#   ./install.sh --preview     # Preview config merge snippets without modifying files
#   ./install.sh --help        # Show usage
# ==============================================================================
set -euo pipefail

REPO_URL="${AGY_HUB_REPO_URL:-https://github.com/bangbangda/agy-hub-pro.git}"
REPO_BRANCH="${AGY_HUB_BRANCH:-main}"
DEFAULT_INSTALL_DIR="${AGY_HUB_INSTALL_DIR:-${HOME}/.gemini/plugins/agy-hub-pro}"

BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[1;31m'
DIM=$'\033[2m'
RESET=$'\033[0m'

log_header() { printf "\n${BOLD}${CYAN}▶ %s${RESET}\n" "$1"; }
log_ok()     { printf "${GREEN}✓${RESET} %s\n" "$1"; }
log_warn()   { printf "${YELLOW}!${RESET} %s\n" "$1"; }
log_err()    { printf "${RED}✗${RESET} %s\n" "$1" >&2; }

# Detect whether running from a local repository checkout or piped via curl | bash
REMOTE_MODE=0
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -z "${SCRIPT_DIR}" || ! -f "${SCRIPT_DIR}/statusline.mjs" || ! -f "${SCRIPT_DIR}/collector.mjs" ]]; then
  REMOTE_MODE=1
  SCRIPT_DIR="${DEFAULT_INSTALL_DIR}"
fi

STATUSLINE_SCRIPT="${SCRIPT_DIR}/statusline.mjs"
COLLECTOR_SCRIPT="${SCRIPT_DIR}/collector.mjs"

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    log_err "Node.js is required (>= 18.0.0) but was not found in PATH."
    log_err "Please install Node.js from https://nodejs.org/ and retry."
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 18 )); then
    log_err "Node.js v18+ is required (detected: $(node -v))."
    exit 1
  fi
}

bootstrap_remote_repo() {
  log_header "Downloading agy-hub-pro to ${SCRIPT_DIR}"
  mkdir -p "$(dirname "${SCRIPT_DIR}")"

  if command -v git >/dev/null 2>&1; then
    if [[ -d "${SCRIPT_DIR}/.git" ]]; then
      log_ok "Existing installation found at ${SCRIPT_DIR}; pulling latest updates..."
      if git -C "${SCRIPT_DIR}" pull --ff-only origin "${REPO_BRANCH}" >/dev/null 2>&1; then
        log_ok "Updated ${SCRIPT_DIR} to latest ${REPO_BRANCH}."
      else
        log_warn "Could not fast-forward ${SCRIPT_DIR}; continuing with existing files."
      fi
    else
      if [[ -d "${SCRIPT_DIR}" && -n "$(ls -A "${SCRIPT_DIR}" 2>/dev/null || true)" ]]; then
        local backup_dir="${SCRIPT_DIR}.bak.$(date +%Y%m%d%H%M%S)"
        mv "${SCRIPT_DIR}" "${backup_dir}"
        log_warn "Moved existing non-git directory to ${backup_dir}"
      fi
      git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SCRIPT_DIR}"
      log_ok "Cloned agy-hub-pro into ${SCRIPT_DIR}"
    fi
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    local archive_url="https://github.com/bangbangda/agy-hub-pro/archive/refs/heads/${REPO_BRANCH}.tar.gz"
    local tmp_extract
    tmp_extract="$(mktemp -d)"
    curl -fsSL "${archive_url}" | tar -xz -C "${tmp_extract}"
    mkdir -p "${SCRIPT_DIR}"
    cp -R "${tmp_extract}"/agy-hub-pro-*/* "${SCRIPT_DIR}/"
    rm -rf "${tmp_extract}"
    log_ok "Downloaded and extracted agy-hub-pro to ${SCRIPT_DIR}"
  else
    log_err "Neither git nor curl+tar is available to download agy-hub-pro."
    exit 1
  fi

  STATUSLINE_SCRIPT="${SCRIPT_DIR}/statusline.mjs"
  COLLECTOR_SCRIPT="${SCRIPT_DIR}/collector.mjs"
}

ensure_executable() {
  log_header "1. Setting executable permissions"
  chmod +x "${STATUSLINE_SCRIPT}" "${COLLECTOR_SCRIPT}"
  [[ -f "${SCRIPT_DIR}/install.sh" ]] && chmod +x "${SCRIPT_DIR}/install.sh"
  [[ -f "${SCRIPT_DIR}/uninstall.sh" ]] && chmod +x "${SCRIPT_DIR}/uninstall.sh"
  log_ok "chmod +x applied to scripts in ${SCRIPT_DIR}"
}

detect_settings_file() {
  node - <<'NODE_EOF'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const explicit = process.env.AGY_HUB_SETTINGS_FILE || '';
const home = os.homedir();
const primary = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
const secondary = path.join(home, '.gemini', 'settings.json');
const candidates = explicit ? [explicit] : [primary, secondary];

function inspect(p) {
  try {
    const lstat = fs.lstatSync(p);
    const isSymlink = lstat.isSymbolicLink();
    let realPath = p;
    if (isSymlink) {
      try { realPath = fs.realpathSync(p); } catch { /* broken symlink */ }
    }
    return { path: p, exists: true, isSymlink, realPath };
  } catch {
    return { path: p, exists: false, isSymlink: false, realPath: p };
  }
}

const info = candidates.map(inspect);
const existing = info.filter((i) => i.exists);
let selected;
let note = '';

if (existing.length === 0) {
  selected = info[0];
  note = 'new';
} else if (existing.length === 1) {
  selected = existing[0];
  note = selected.isSymlink ? `symlink->${selected.realPath}` : 'existing';
} else {
  selected = existing[0];
  if (existing[0].realPath === existing[1].realPath) {
    note = `shared-symlink->${selected.realPath}`;
  } else {
    note = `multi-distinct(primary=${existing[0].path},secondary=${existing[1].path})`;
  }
}

process.stdout.write(JSON.stringify({ ...selected, note }));
NODE_EOF
}

preview_config() {
  check_node
  local detected target_path
  detected="$(detect_settings_file)"
  target_path="$(node -e 'console.log(JSON.parse(process.argv[1]).path)' "${detected}")"

  log_header "Config preview: ${target_path} (deep-merged statusLine block)"
  cat <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "node ${STATUSLINE_SCRIPT}",
    "enabled": true,
    "padding": 0,
    "stack_with_default": false
  }
}
EOF

  log_header "Config preview: plugin root hooks.json (auto-loaded by agy plugin install)"
  cat "${SCRIPT_DIR}/hooks.json"
}

install_config() {
  check_node
  if [[ "${REMOTE_MODE}" -eq 1 ]]; then
    bootstrap_remote_repo
  fi

  ensure_executable

  local ts detected target_path real_path note
  ts="$(date +%Y%m%d%H%M%S)"
  detected="$(detect_settings_file)"
  target_path="$(node -e 'console.log(JSON.parse(process.argv[1]).path)' "${detected}")"
  real_path="$(node -e 'console.log(JSON.parse(process.argv[1]).realPath)' "${detected}")"
  note="$(node -e 'console.log(JSON.parse(process.argv[1]).note)' "${detected}")"

  log_header "2. Auto-detect & safely deep-merge settings.json"
  printf "  ${DIM}Detected active config: %s (%s)${RESET}\n" "${target_path}" "${note}"

  node - "${target_path}" "${real_path}" "${STATUSLINE_SCRIPT}" "${ts}" <<'NODE_EOF'
const fs = require('node:fs');
const path = require('node:path');

const [targetPath, realPath, statuslineScript, ts] = process.argv.slice(2);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const writeTarget = realPath || targetPath;
fs.mkdirSync(path.dirname(writeTarget), { recursive: true });

let existing = {};
let fileMode = 0o644;
if (fs.existsSync(writeTarget)) {
  const stat = fs.statSync(writeTarget);
  fileMode = stat.mode & 0o777;
  const raw = fs.readFileSync(writeTarget, 'utf8');
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        throw new Error('Root JSON value must be an object');
      }
      existing = parsed;
    } catch (err) {
      console.error(`ERROR: Existing settings file has invalid JSON (${writeTarget}): ${err.message}`);
      console.error('Refusing to overwrite to prevent data loss. Fix the JSON syntax and retry.');
      process.exit(2);
    }
  }
  const backupPath = `${writeTarget}.bak.${ts}`;
  fs.copyFileSync(writeTarget, backupPath);
  console.log(`BACKUP:${backupPath}`);
}

const patch = {
  statusLine: {
    type: 'command',
    command: `node ${statuslineScript}`,
    enabled: true,
    padding: 0,
    stack_with_default: false,
  },
};

const merged = deepMerge(existing, patch);
const tmpPath = `${writeTarget}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: fileMode });
fs.renameSync(tmpPath, writeTarget);
console.log(`WRITTEN:${writeTarget}`);
NODE_EOF

  log_ok "Deep-merged statusLine into ${target_path} (all existing settings preserved)"

  log_header "3. Register lifecycle hooks (SessionStart / PreInvocation / Stop)"
  local global_hooks_file="${AGY_HUB_HOOKS_FILE:-${HOME}/.gemini/config/hooks.json}"
  local plugin_installed=0

  if [[ "${AGY_HUB_SKIP_AGY_CLI:-0}" != "1" ]] && command -v agy >/dev/null 2>&1; then
    printf "  ${DIM}Running: agy plugin install %s${RESET}\n" "${SCRIPT_DIR}"
    if agy plugin install "${SCRIPT_DIR}"; then
      log_ok "Registered native Antigravity plugin via agy plugin install"
      plugin_installed=1
    else
      log_warn "agy plugin install returned non-zero; falling back to global hooks.json deep merge..."
    fi
  else
    log_warn "Skipping agy plugin install; merging lifecycle hooks into ${global_hooks_file}..."
  fi

  node - "${global_hooks_file}" "${COLLECTOR_SCRIPT}" "${ts}" "${plugin_installed}" <<'NODE_EOF'
const fs = require('node:fs');
const path = require('node:path');

const [hooksPath, collectorScript, ts, pluginInstalledFlag] = process.argv.slice(2);
const pluginInstalled = pluginInstalledFlag === '1';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

let realHooksPath = hooksPath;
if (fs.existsSync(hooksPath)) {
  try { realHooksPath = fs.realpathSync(hooksPath); } catch { /* ignore */ }
}

let existing = {};
let hadFile = fs.existsSync(realHooksPath);
if (hadFile) {
  const raw = fs.readFileSync(realHooksPath, 'utf8');
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('Root JSON value must be an object');
      existing = parsed;
    } catch (err) {
      console.error(`ERROR: Existing hooks.json has invalid JSON (${realHooksPath}): ${err.message}`);
      process.exit(2);
    }
  }
}

if (pluginInstalled) {
  if (existing['agy-hud-pro'] || existing['agy-hub-pro']) {
    const backupPath = `${realHooksPath}.bak.${ts}`;
    fs.copyFileSync(realHooksPath, backupPath);
    delete existing['agy-hud-pro'];
    delete existing['agy-hub-pro'];
    const tmp = `${realHooksPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, realHooksPath);
    console.log(`CLEANED_DUPLICATE_GLOBAL_HOOKS:${realHooksPath}`);
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(realHooksPath), { recursive: true });
if (hadFile) {
  const backupPath = `${realHooksPath}.bak.${ts}`;
  fs.copyFileSync(realHooksPath, backupPath);
  console.log(`BACKUP:${backupPath}`);
}

delete existing['agy-hud-pro'];

const merged = {
  ...existing,
  'agy-hub-pro': {
    enabled: true,
    SessionStart: [
      { type: 'command', command: `node ${collectorScript} --event SessionStart`, timeout: 5 },
    ],
    PreInvocation: [
      { type: 'command', command: `node ${collectorScript} --event PreInvocation`, timeout: 5 },
    ],
    Stop: [
      { type: 'command', command: `node ${collectorScript} --event Stop`, timeout: 5 },
    ],
  },
};

const tmp = `${realHooksPath}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, realHooksPath);
console.log(`WRITTEN:${realHooksPath}`);
NODE_EOF

  if [[ "${plugin_installed}" -eq 0 ]]; then
    log_ok "Deep-merged lifecycle hooks into ${global_hooks_file}"
  fi

  local data_dir="${AGY_HUB_DATA_DIR:-${HOME}/.gemini/plugins/agy-hub-pro/data}"
  mkdir -p "${data_dir}" 2>/dev/null || true

  printf "\n${BOLD}${GREEN}✔ AGY Hub Pro installed successfully!${RESET}\n"
  printf "  ${DIM}• Preview HUD:     node %s --test${RESET}\n" "${STATUSLINE_SCRIPT}"
  printf "  ${DIM}• Run diagnostics: node %s --doctor${RESET}\n" "${STATUSLINE_SCRIPT}"
  printf "  ${DIM}• Enable now in agy: /statusline node %s${RESET}\n\n" "${STATUSLINE_SCRIPT}"
}

uninstall_config() {
  check_node
  local purge=0
  for arg in "$@"; do
    [[ "${arg}" == "--purge" ]] && purge=1
  done

  if [[ -x "${SCRIPT_DIR}/uninstall.sh" && "${AGY_HUB_INTERNAL_UNINSTALL:-0}" != "1" ]]; then
    if [[ "${purge}" -eq 1 ]]; then
      exec "${SCRIPT_DIR}/uninstall.sh" --purge
    else
      exec "${SCRIPT_DIR}/uninstall.sh"
    fi
  fi

  local ts
  ts="$(date +%Y%m%d%H%M%S)"
  log_header "Uninstalling AGY Hub Pro (clean config restore)"

  node - "${ts}" <<'NODE_EOF'
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
for (const candidate of settingsCandidates) {
  if (!fs.existsSync(candidate)) continue;
  let realPath = candidate;
  try { realPath = fs.realpathSync(candidate); } catch { /* ignore */ }
  if (seenReal.has(realPath)) continue;
  seenReal.add(realPath);

  let cfg;
  try {
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
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, realPath);
    console.log(`REMOVED_STATUSLINE:${realPath} (backup: ${backup})`);
  }
}

const hooksFile = process.env.AGY_HUB_HOOKS_FILE || path.join(home, '.gemini', 'config', 'hooks.json');
if (fs.existsSync(hooksFile)) {
  let realHooks = hooksFile;
  try { realHooks = fs.realpathSync(hooksFile); } catch { /* ignore */ }
  try {
    const hooks = JSON.parse(fs.readFileSync(realHooks, 'utf8'));
    if (hooks && (hooks['agy-hub-pro'] || hooks['agy-hud-pro'])) {
      const backup = `${realHooks}.bak.${ts}`;
      fs.copyFileSync(realHooks, backup);
      delete hooks['agy-hub-pro'];
      delete hooks['agy-hud-pro'];
      const tmp = `${realHooks}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, realHooks);
      console.log(`REMOVED_HOOKS:${realHooks} (backup: ${backup})`);
    }
  } catch (err) {
    console.error(`WARN: Skipping invalid JSON in ${realHooks}: ${err.message}`);
  }
}
NODE_EOF

  if [[ "${AGY_HUB_SKIP_AGY_CLI:-0}" != "1" ]] && command -v agy >/dev/null 2>&1; then
    agy plugin uninstall agy-hub-pro >/dev/null 2>&1 && log_ok "Removed native plugin: agy-hub-pro" || true
    agy plugin uninstall agy-hud-pro >/dev/null 2>&1 && log_ok "Removed legacy plugin: agy-hud-pro" || true
  fi

  local data_dir="${AGY_HUB_DATA_DIR:-${HOME}/.gemini/plugins/agy-hub-pro/data}"
  if [[ -d "${data_dir}" ]]; then
    rm -rf "${data_dir}"
    log_ok "Cleaned runtime cache directory: ${data_dir}"
  fi
  rm -rf "/tmp/agy-hub-pro-data" "/tmp/agy-hud-last-stdin.json" 2>/dev/null || true

  if [[ "${purge}" -eq 1 && -d "${DEFAULT_INSTALL_DIR}" ]]; then
    local cwd_real install_real
    cwd_real="$(cd "$(pwd)" && pwd -P)"
    install_real="$(cd "${DEFAULT_INSTALL_DIR}" && pwd -P)"
    if [[ "${cwd_real}" != "${install_real}" ]]; then
      rm -rf "${DEFAULT_INSTALL_DIR}"
      log_ok "Purged plugin directory: ${DEFAULT_INSTALL_DIR}"
    else
      log_warn "Skipped purging ${DEFAULT_INSTALL_DIR} because it is your current working directory."
    fi
  fi

  printf "\n${BOLD}${GREEN}✔ AGY Hub Pro uninstalled cleanly. All other settings remain untouched.${RESET}\n"
}

run_simulation_tests() {
  check_node
  ensure_executable

  local tmp_dir
  tmp_dir="$(mktemp -d /tmp/agy-hub-pro-test.XXXXXX)"
  trap "rm -rf '${tmp_dir}'" EXIT

  local test_data_dir="${tmp_dir}/data"
  local test_state="${test_data_dir}/state.json"
  local test_lock="${test_data_dir}/collector.lock"
  local test_stdin_dump="${test_data_dir}/last-stdin.json"
  local mock_repo="${tmp_dir}/mock-repo"

  mkdir -p "${test_data_dir}" "${mock_repo}"
  git -C "${mock_repo}" init -q -b main
  git -C "${mock_repo}" config user.email "hud@local"
  git -C "${mock_repo}" config user.name "HUD"
  printf "hello\n" > "${mock_repo}/README.md"
  git -C "${mock_repo}" add README.md
  git -C "${mock_repo}" commit -q -m "init"

  log_header "2. Validate Antigravity plugin manifest & structure"
  if command -v agy >/dev/null 2>&1; then
    agy plugin validate "${SCRIPT_DIR}" && log_ok "agy plugin validate passed!" || log_warn "agy plugin validate reported notes/warnings"
  else
    log_warn "agy CLI not detected, skipping agy plugin validate"
  fi

  log_header "3. Verify built-in CLI flags (--version / --test)"
  local ver_out
  ver_out="$(node "${STATUSLINE_SCRIPT}" --version)"
  log_ok "statusline.mjs --version => ${ver_out}"
  node "${STATUSLINE_SCRIPT}" --test >/dev/null
  log_ok "statusline.mjs --test rendered all preview scenarios (exit 0)"

  log_header "4. Simulate SessionStart hook (stale lock cleanup + background init)"
  touch "${test_lock}"
  local out_ss rc_ss
  out_ss="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","cwd":"%s"}\n' "${mock_repo}" \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event SessionStart)"
  rc_ss=$?
  printf "  stdout : %s\n" "${out_ss}"
  printf "  exit   : %d\n" "${rc_ss}"

  log_header "5. Simulate Stop hook (token ledger accumulation + 7-day auto-pruning)"
  local out_stop rc_stop
  out_stop="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL","usage":{"input_tokens":850000,"output_tokens":350000}}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event Stop)"
  rc_stop=$?
  printf "  stdout : %s\n" "${out_stop}"
  printf "  exit   : %d\n" "${rc_stop}"

  node - "${test_state}" <<'NODE_EOF'
const fs = require('node:fs');
const stateFile = process.argv[2];
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const now = Date.now();
st.ledger.push({ ts: now - 2 * 24 * 3600 * 1000, tokens: 3_600_000, model: 'gemini-4-neon', conversationId: 'conv-old-week', source: 'mock' });
st.ledger.push({ ts: now - 9 * 24 * 3600 * 1000, tokens: 9_999_999, model: 'gemini-4-neon', conversationId: 'conv-expired', source: 'mock-expired' });
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
NODE_EOF

  printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL"}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LOCK_FILE="${test_lock}" AGY_HUB_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null

  log_ok "Pruned >7d entries and aggregated local ledger:"
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (s.ledger.length !== 2) { console.error("Expected 2 entries after pruning, got", s.ledger.length); process.exit(1); } console.log("  ledger entries:", s.ledger.length, "| 5h tokens:", s.usage.tokens5h, "| week tokens:", s.usage.tokensWeek);' "${test_state}"

  log_header "6. Simulate live StatusLine rendering (Green ≤80% / Yellow >80% / Red >90%)"

  printf "dirty\n" >> "${mock_repo}/README.md"
  local rendered_a rc_a ms payload_a t0 t1
  payload_a="$(printf '{"model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":18.5,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"quota":{"gemini-5h":{"remaining_fraction":0.78,"reset_in_seconds":11880},"gemini-weekly":{"remaining_fraction":0.91,"reset_in_seconds":468000}},"workspace":{"current_dir":"%s"},"cycle_mode":"auto","sandbox":{"enabled":false},"plan_tier":"Google AI Pro","email":"user@example.com"}\n' "${mock_repo}")"
  t0="$(node -e 'console.log(Date.now())')"
  rendered_a="$(printf '%s\n' "${payload_a}" \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_a=$?
  t1="$(node -e 'console.log(Date.now())')"
  ms=$((t1 - t0))
  printf "  ${DIM}[Scenario A - Green ≤80%% / Dirty Git / %dms / exit=%d]${RESET}\n" "${ms}" "${rc_a}"
  printf "%s\n\n" "${rendered_a}" | sed 's/^/  /'

  git -C "${mock_repo}" checkout -q -b feat/auth
  git -C "${mock_repo}" checkout -q -- README.md
  local rendered_b rc_b
  rendered_b="$(printf '{"modelName":"gemini-4-neon","contextWindow":{"usedTokens":840000,"maxTokens":1000000},"quota":{"5h":{"remaining_percentage":18},"weekly":{"remaining_percentage":15}},"cwd":"%s"}\n' "${mock_repo}" \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_b=$?
  printf "  ${DIM}[Scenario B - Yellow >80%% / Clean Branch / camelCase / exit=%d]${RESET}\n" "${rc_b}"
  printf "%s\n\n" "${rendered_b}" | sed 's/^/  /'

  node - "${test_state}" <<'NODE_EOF'
const fs = require('node:fs');
const stateFile = process.argv[2];
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const now = Date.now();
st.quota.isEstimated = true;
st.quota.source = 'estimated';
st.ledger = [
  { ts: now - 10 * 60 * 1000, tokens: 4_600_000, model: 'gemini-4-neon', conversationId: 'conv-heavy-5h', source: 'mock' },
  { ts: now - 24 * 3600 * 1000, tokens: 32_600_000, model: 'gemini-4-neon', conversationId: 'conv-heavy-wk', source: 'mock' },
];
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
NODE_EOF
  printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon"}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LOCK_FILE="${test_lock}" AGY_HUB_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null

  local rendered_c rc_c
  rendered_c="$(printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":92.5},"cwd":"/tmp"}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_c=$?
  printf "  ${DIM}[Scenario C - Red >90%% / Local Estimate ~ / Non-Git / exit=%d]${RESET}\n" "${rc_c}"
  printf "%s\n" "${rendered_c}" | sed 's/^/  /'

  log_header "7. Simulate PreInvocation low-quota warning (<15%)"
  local out_warn rc_warn
  out_warn="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","lastUserInput":"refactor backend"}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${test_state}" AGY_HUB_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event UserPromptSubmit)"
  rc_warn=$?
  printf "  exit   : %d\n" "${rc_warn}"
  printf "  stdout : %s\n" "${out_warn}"

  log_header "8. Verify weekly quota cycle alignment (reset_time / reset_in_seconds / fallback)"
  local align_state="${tmp_dir}/state-align.json"
  local align_lock="${tmp_dir}/collector-align.lock"
  local align_reset_iso
  align_reset_iso="$(node -e 'console.log(new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString())')"

  node - "${align_state}" <<'NODE_EOF'
const fs = require('node:fs');
const now = Date.now();
const st = {
  version: 1,
  updatedAt: now,
  lastRefreshAt: 0,
  quota: { remaining5h: 100, remainingWeek: 100, reset5hSec: null, resetWeekSec: null, reset5hTime: null, resetWeekTime: null, source: 'estimated', isEstimated: true, oauthDetected: false },
  usage: { tokens5h: 0, tokensWeek: 0, budget5h: 5_000_000, budgetWeek: 40_000_000 },
  conversations: {},
  ledger: [
    { ts: now - 3 * 24 * 3600 * 1000, tokens: 2_000_000, model: 'gemini-4-neon', conversationId: 'conv-prev-cycle', source: 'mock' },
    { ts: now - 1 * 24 * 3600 * 1000, tokens: 500_000, model: 'gemini-4-neon', conversationId: 'conv-curr-cycle', source: 'mock' },
  ],
};
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF

  local rendered_align
  rendered_align="$(printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":10},"quota":{"gemini-weekly":{"remaining_fraction":0.85,"reset_time":"%s"}},"cwd":"/tmp"}\n' "${align_reset_iso}" \
    | NO_COLOR=1 AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${align_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/align-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${align_state}" "${align_reset_iso}" "${rendered_align}" <<'NODE_EOF'
const fs = require('node:fs');
const [stateFile, expectedReset, rendered] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (st.usage.tokensWeek !== 500_000) { console.error(`FAIL 8a: tokensWeek=${st.usage.tokensWeek}`); process.exit(1); }
if (st.quota.resetWeekTime !== expectedReset) { console.error(`FAIL 8a: resetWeekTime=${st.quota.resetWeekTime}`); process.exit(1); }
if (rendered.includes('tok ·') || /\b\d+(?:\.\d+)?[KMB]?\s*tok\b/i.test(rendered)) {
  console.error(`FAIL 8a: expected 5h/Wk output to omit inaccurate tok counts, got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  printf '{"conversationId":"conv-curr-cycle","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL"}\n' \
    | AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${align_state}" AGY_HUB_LOCK_FILE="${align_lock}" AGY_HUB_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null
  node - "${align_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.usage.tokensWeek !== 500_000) { console.error(`FAIL 8b: collector Stop tokensWeek=${st.usage.tokensWeek}`); process.exit(1); }
NODE_EOF

  local align_sec_state="${tmp_dir}/state-align-sec.json"
  node - "${align_sec_state}" <<'NODE_EOF'
const fs = require('node:fs');
const now = Date.now();
const st = {
  version: 1,
  updatedAt: now,
  lastRefreshAt: 0,
  quota: { remaining5h: 100, remainingWeek: 100, reset5hSec: null, resetWeekSec: null, reset5hTime: null, resetWeekTime: null, source: 'estimated', isEstimated: true, oauthDetected: false },
  usage: { tokens5h: 0, tokensWeek: 0, budget5h: 5_000_000, budgetWeek: 40_000_000 },
  conversations: {},
  ledger: [
    { ts: now - 4 * 24 * 3600 * 1000, tokens: 1_500_000, model: 'gemini-4-neon', conversationId: 'conv-prev-sec', source: 'mock' },
    { ts: now - 12 * 3600 * 1000, tokens: 300_000, model: 'gemini-4-neon', conversationId: 'conv-curr-sec', source: 'mock' },
  ],
};
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":10},"quota":{"gemini-weekly":{"remaining_fraction":0.9,"reset_in_seconds":518400}},"cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUB_DATA_DIR="${test_data_dir}" AGY_HUB_STATE_FILE="${align_sec_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/align-sec-stdin.json" node "${STATUSLINE_SCRIPT}" >/dev/null
  node - "${align_sec_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.usage.tokensWeek !== 300_000) { console.error(`FAIL 8c: tokensWeek=${st.usage.tokensWeek}`); process.exit(1); }
if (!st.quota.resetWeekTime || !Number.isFinite(Date.parse(st.quota.resetWeekTime))) { console.error(`FAIL 8c: missing resetWeekTime`); process.exit(1); }
NODE_EOF
  log_ok "Weekly quota cycle alignment verified"

  log_header "9. Verify live activity, tool action, stall warning, /clear persistence & window isolation"
  local act_state="${tmp_dir}/state-activity.json"
  local act_transcript="${tmp_dir}/transcript.jsonl"
  printf '{"step_index":1,"type":"USER_INPUT","status":"DONE","content":"hello"}\n' > "${act_transcript}"

  local rendered_act1
  rendered_act1="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1000},"agent_state":"working","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act1}" <<'NODE_EOF'
if (!process.argv[2].includes('● 思考中')) { console.error(`FAIL 9a: expected "● 思考中", got:\n${process.argv[2]}`); process.exit(1); }
NODE_EOF

  printf '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command"}]}\n' >> "${act_transcript}"
  node - "${act_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t10 = Date.now() - 10_000;
const act = st.windowActivity['win-main'];
act.workStartAt = t10;
act.lastOutAt = t10;
act.lastProgressAt = t10;
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  local rendered_act2
  rendered_act2="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1560},"agent_state":"working","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act2}" <<'NODE_EOF'
if (!process.argv[2].includes('● run_command 10s · ~56 t/s')) { console.error(`FAIL 9b: expected "● run_command 10s · ~56 t/s", got:\n${process.argv[2]}`); process.exit(1); }
NODE_EOF

  node - "${act_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t75 = Date.now() - 75_000;
const act = st.windowActivity['win-main'];
act.workStartAt = t75;
act.lastProgressAt = t75;
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  local rendered_act3
  rendered_act3="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1560},"agent_state":"working","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act3}" <<'NODE_EOF'
if (!process.argv[2].includes('\x1b[33m●') || !process.argv[2].includes('1m15s')) { console.error(`FAIL 9c: expected yellow stall dot & 1m15s`); process.exit(1); }
NODE_EOF

  node - "${act_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
st.windowActivity['win-main'].lastTpsAt = Date.now() - 2 * 3600 * 1000;
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  local rendered_act4
  rendered_act4="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1560},"agent_state":"idle","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act4}" <<'NODE_EOF'
if (process.argv[2].includes('●') || !process.argv[2].includes('~56 t/s')) { console.error(`FAIL 9d: expected persistent idle "~56 t/s"`); process.exit(1); }
NODE_EOF

  local rendered_act6
  rendered_act6="$(printf '{"session_id":"sess-after-clear","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":0,"total_output_tokens":0},"agent_state":"idle","cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${act_state}" "${rendered_act6}" <<'NODE_EOF'
const fs = require('node:fs');
const [stateFile, rendered] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (!rendered.includes('~56 t/s') || st.windowActivity['win-main'].lastOutTokens !== 0) { console.error(`FAIL 9e: /clear persistence check failed`); process.exit(1); }
NODE_EOF

  local rendered_act7
  rendered_act7="$(printf '{"session_id":"sess-other-win","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":5,"total_output_tokens":0},"agent_state":"idle","cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-other" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act7}" <<'NODE_EOF'
if (process.argv[2].includes('t/s')) { console.error(`FAIL 9f: window isolation failed`); process.exit(1); }
NODE_EOF

  local rendered_act8
  rendered_act8="$(printf '{"session_id":"sess-after-clear","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":12},"agent_state":"idle","tokens_per_second":84,"cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUB_WINDOW_ID="win-main" AGY_HUB_STATE_FILE="${act_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act8}" <<'NODE_EOF'
if (!process.argv[2].includes('84 t/s') || process.argv[2].includes('~84 t/s')) { console.error(`FAIL 9g: native t/s check failed`); process.exit(1); }
NODE_EOF
  log_ok "Live activity, stall detection, /clear persistence & window isolation verified"

  log_header "10. Verify exact incremental session net tokens (Ctx -> Tok -> Cache, excluding cache_read)"
  local tok_state="${tmp_dir}/state-session-tok.json"
  local tok_transcript="${tmp_dir}/transcript-session-tok.jsonl"
  printf '{"step_index":1,"type":"USER_INPUT","status":"DONE","content":"hi"}\n' > "${tok_transcript}"
  printf '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":12000,"cache_read_tokens":500000,"output_tokens":3000}\n' >> "${tok_transcript}"
  printf '{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":8000,"cache_read_tokens":600000,"output_tokens":2000}\n' >> "${tok_transcript}"

  local rendered_tok1
  rendered_tok1="$(printf '{"session_id":"sess-tok","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":15,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"quota":{"gemini-5h":{"remaining_fraction":0.8,"reset_in_seconds":7200},"gemini-weekly":{"remaining_fraction":0.75,"reset_in_seconds":345600}},"transcript_path":"%s","cwd":"/tmp"}\n' "${tok_transcript}" \
    | NO_COLOR=1 AGY_HUB_STATE_FILE="${tok_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/tok-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_tok1}" <<'NODE_EOF'
const line1 = (process.argv[2].split('\n')[0] || '');
const idxCtx = line1.indexOf('Ctx:');
const idxTok = line1.indexOf('Tok: 25K');
const idxCache = line1.indexOf('Cache: 98%');
if (idxCtx < 0 || idxTok < 0 || idxCache < 0 || !(idxCtx < idxTok && idxTok < idxCache)) {
  console.error(`FAIL 10a: expected Ctx < Tok: 25K < Cache: 98%, got:\n${line1}`);
  process.exit(1);
}
NODE_EOF

  printf '{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":60000,"cache_read_tokens":900000,"output_tokens":15000}\n' >> "${tok_transcript}"
  local rendered_tok2
  rendered_tok2="$(printf '{"session_id":"sess-tok","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":15,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"transcript_path":"%s","cwd":"/tmp"}\n' "${tok_transcript}" \
    | NO_COLOR=1 AGY_HUB_STATE_FILE="${tok_state}" AGY_HUB_LAST_STDIN="${tmp_dir}/tok-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_tok2}" <<'NODE_EOF'
if (!process.argv[2].includes('Tok: 100K')) { console.error(`FAIL 10b: expected Tok: 100K`); process.exit(1); }
NODE_EOF
  log_ok "Exact session net token tracking verified (25K -> 100K)"

  log_header "11. Verify safe Deep Merge, Symlink preservation, --doctor PASS, & Clean Uninstall"
  local mock_cfg_dir="${tmp_dir}/cfg"
  local real_settings="${mock_cfg_dir}/real-settings.json"
  local link_settings="${mock_cfg_dir}/settings.json"
  local mock_hooks="${mock_cfg_dir}/hooks.json"
  local mock_data="${tmp_dir}/isolated-data"
  mkdir -p "${mock_cfg_dir}" "${mock_data}"

  cat > "${real_settings}" <<'EOF'
{
  "model": "gemini-4-neon",
  "altScreenMode": "always",
  "mcpServers": {
    "my-custom-mcp": { "command": "npx", "args": ["-y", "example-mcp"] }
  },
  "trustedWorkspaces": ["/Users/example/project"],
  "permissions": { "allow": ["Read", "Grep"] }
}
EOF
  ln -s "${real_settings}" "${link_settings}"

  cat > "${mock_hooks}" <<'EOF'
{
  "user-custom-hook": {
    "enabled": true,
    "Stop": [{ "type": "command", "command": "echo keep-me" }]
  },
  "agy-hud-pro": {
    "enabled": true
  }
}
EOF

  AGY_HUB_SETTINGS_FILE="${link_settings}" \
  AGY_HUB_HOOKS_FILE="${mock_hooks}" \
  AGY_HUB_DATA_DIR="${mock_data}" \
  AGY_HUB_SKIP_AGY_CLI=1 \
    bash "${SCRIPT_DIR}/install.sh" --install >/dev/null

  node - "${link_settings}" "${real_settings}" "${mock_hooks}" "${STATUSLINE_SCRIPT}" <<'NODE_EOF'
const fs = require('node:fs');
const path = require('node:path');
const [linkSettings, realSettings, hooksPath, statuslineScript] = process.argv.slice(2);

if (!fs.lstatSync(linkSettings).isSymbolicLink()) { console.error('FAIL 11a: Symlink destroyed'); process.exit(1); }
const backups = fs.readdirSync(path.dirname(realSettings)).filter((f) => /^real-settings\.json\.bak\.\d{14}$/.test(f));
if (backups.length < 1) { console.error('FAIL 11b: Missing timestamped backup'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(realSettings, 'utf8'));
if (cfg.model !== 'gemini-4-neon' || cfg.mcpServers?.['my-custom-mcp']?.command !== 'npx' || cfg.trustedWorkspaces?.[0] !== '/Users/example/project' || cfg.permissions?.allow?.[0] !== 'Read') {
  console.error('FAIL 11c: Existing user settings not preserved');
  process.exit(1);
}
if (!cfg.statusLine || cfg.statusLine.command !== `node ${statuslineScript}` || cfg.statusLine.enabled !== true) {
  console.error('FAIL 11d: statusLine merge failed');
  process.exit(1);
}
const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
if (!hooks['user-custom-hook'] || !hooks['agy-hub-pro'] || hooks['agy-hud-pro']) {
  console.error('FAIL 11e: hooks.json merge / legacy cleanup failed');
  process.exit(1);
}
NODE_EOF
  log_ok "Deep merge preserved mcpServers/trustedWorkspaces/permissions/model, kept symlink & created timestamped backup"

  AGY_HUB_SETTINGS_FILE="${link_settings}" \
  AGY_HUB_HOOKS_FILE="${mock_hooks}" \
  AGY_HUB_DATA_DIR="${mock_data}" \
    node "${STATUSLINE_SCRIPT}" --doctor --json | node -e '
      const res = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (!res.ok || res.failures !== 0) { console.error("FAIL 11f: --doctor reported failures:", res); process.exit(1); }
    '
  log_ok "statusline.mjs --doctor passed with 0 failures against mounted symlinked config"

  AGY_HUB_SETTINGS_FILE="${link_settings}" \
  AGY_HUB_HOOKS_FILE="${mock_hooks}" \
  AGY_HUB_DATA_DIR="${mock_data}" \
  AGY_HUB_SKIP_AGY_CLI=1 \
    bash "${SCRIPT_DIR}/uninstall.sh" >/dev/null

  node - "${real_settings}" "${mock_hooks}" <<'NODE_EOF'
const fs = require('node:fs');
const [realSettings, hooksPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(realSettings, 'utf8'));
if (cfg.statusLine !== undefined) { console.error('FAIL 11g: statusLine not removed'); process.exit(1); }
if (cfg.model !== 'gemini-4-neon' || cfg.mcpServers?.['my-custom-mcp']?.command !== 'npx' || cfg.permissions?.allow?.[0] !== 'Read') {
  console.error('FAIL 11h: User settings damaged during uninstall');
  process.exit(1);
}
const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
if (!hooks['user-custom-hook'] || hooks['agy-hub-pro'] || hooks['agy-hud-pro']) {
  console.error('FAIL 11i: hooks.json uninstall failed');
  process.exit(1);
}
NODE_EOF
  log_ok "Clean uninstall removed only agy-hub-pro entries and preserved all user configs"

  log_header "12. Verify stdin field sniffing snapshot"
  if [[ -f "${test_stdin_dump}" ]]; then
    log_ok "Generated ${test_stdin_dump} (first 6 lines):"
    head -n 6 "${test_stdin_dump}" | sed 's/^/  /'
  fi

  printf "\n${BOLD}${GREEN}✔ All simulation, activity, token, deep-merge, doctor, and uninstall tests passed!${RESET}\n"
}

print_usage() {
  cat <<EOF
AGY Hub Pro — Installer & Test Runner

Usage:
  ./install.sh --install               Backup & deep-merge settings.json + register hooks
  ./install.sh --uninstall [--purge]   Cleanly remove statusLine & hooks (preserves all other settings)
  ./install.sh --doctor                Run environment, config mount, and cache permission diagnostics
  ./install.sh --test                  Run full simulation, deep-merge, and uninstall test suite
  ./install.sh --preview               Preview JSON merge snippets without modifying files
  ./install.sh --help                  Show this help message

Remote one-liner:
  curl -fsSL https://raw.githubusercontent.com/bangbangda/agy-hub-pro/main/install.sh | bash
EOF
}

case "${1:-}" in
  --test)
    run_simulation_tests
    ;;
  --preview)
    preview_config
    ;;
  --install)
    install_config
    ;;
  --uninstall)
    shift || true
    uninstall_config "$@"
    ;;
  --doctor)
    check_node
    shift || true
    node "${STATUSLINE_SCRIPT}" --doctor "$@"
    ;;
  --help|-h)
    print_usage
    ;;
  "")
    if [[ "${REMOTE_MODE}" -eq 1 ]]; then
      install_config
    else
      run_simulation_tests
      preview_config
    fi
    ;;
  *)
    log_err "Unknown option: $1"
    print_usage
    exit 1
    ;;
esac
