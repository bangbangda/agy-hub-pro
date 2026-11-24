#!/usr/bin/env bash
# ==============================================================================
# agy-hud-pro / install.sh
#
# 一键权限设置、配置合并安装（带自动备份）与全链路模拟测试脚本
# 用法:
#   ./install.sh --test       # 仅赋予可执行权限并运行全链路模拟测试（不修改真实 settings.json）
#   ./install.sh --preview    # 预览将写入 settings.json 与 hooks.json 的配置内容
#   ./install.sh --install    # 备份原配置并写入 ~/.gemini/antigravity-cli/settings.json + 安装插件/钩子
#   ./install.sh              # 默认执行 --test 并展示安装指引
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE_SCRIPT="${SCRIPT_DIR}/statusline.mjs"
COLLECTOR_SCRIPT="${SCRIPT_DIR}/collector.mjs"
SETTINGS_FILE="${HOME}/.gemini/antigravity-cli/settings.json"
SETTINGS_BACKUP="${HOME}/.gemini/antigravity-cli/settings.json.bak"
GLOBAL_HOOKS_FILE="${HOME}/.gemini/config/hooks.json"
GLOBAL_HOOKS_BACKUP="${HOME}/.gemini/config/hooks.json.bak"

BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

log_header() {
  printf "\n${BOLD}${CYAN}▶ %s${RESET}\n" "$1"
}

log_ok() {
  printf "${GREEN}✓${RESET} %s\n" "$1"
}

log_warn() {
  printf "${YELLOW}!${RESET} %s\n" "$1"
}

ensure_executable() {
  log_header "1. 赋予脚本可执行权限"
  chmod +x "${STATUSLINE_SCRIPT}" "${COLLECTOR_SCRIPT}" "${SCRIPT_DIR}/install.sh"
  log_ok "chmod +x: statusline.mjs, collector.mjs, install.sh"
}

preview_config() {
  log_header "配置预览：~/.gemini/antigravity-cli/settings.json (statusLine 合并片段)"
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

  log_header "配置预览：插件根目录 hooks.json（或合并至 ~/.gemini/config/hooks.json）"
  cat "${SCRIPT_DIR}/hooks.json"
}

install_config() {
  ensure_executable

  log_header "2. 备份并合并 ~/.gemini/antigravity-cli/settings.json"
  mkdir -p "$(dirname "${SETTINGS_FILE}")"
  if [[ -f "${SETTINGS_FILE}" ]]; then
    cp "${SETTINGS_FILE}" "${SETTINGS_BACKUP}"
    log_ok "已备份原配置至: ${SETTINGS_BACKUP}"
  else
    log_warn "未检测到已有 settings.json，将新建配置文件"
  fi

  node - "${SETTINGS_FILE}" "${STATUSLINE_SCRIPT}" <<'NODE_EOF'
const fs = require('node:fs');
const [settingsPath, statuslineScript] = process.argv.slice(2);
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch {
  cfg = {};
}
cfg.statusLine = {
  type: 'command',
  command: `node ${statuslineScript}`,
  enabled: true,
  padding: 0,
  stack_with_default: false,
};
fs.writeFileSync(settingsPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
NODE_EOF
  log_ok "已写入 statusLine 配置至: ${SETTINGS_FILE}"

  log_header "3. 注册生命周期钩子（优先 agy plugin install，否则合并至 ~/.gemini/config/hooks.json）"
  if command -v agy >/dev/null 2>&1; then
    echo "${DIM}运行: agy plugin install ${SCRIPT_DIR}${RESET}"
    if agy plugin install "${SCRIPT_DIR}"; then
      log_ok "已通过 agy plugin install 注册插件与生命周期钩子！"
      return 0
    else
      log_warn "agy plugin install 返回非零退出码，回退至全局 ~/.gemini/config/hooks.json 合并写入..."
    fi
  else
    log_warn "当前 PATH 未找到 agy 命令，直接合并写入全局 ~/.gemini/config/hooks.json..."
  fi

  mkdir -p "$(dirname "${GLOBAL_HOOKS_FILE}")"
  if [[ -f "${GLOBAL_HOOKS_FILE}" ]]; then
    cp "${GLOBAL_HOOKS_FILE}" "${GLOBAL_HOOKS_BACKUP}"
    log_ok "已备份原 hooks.json 至: ${GLOBAL_HOOKS_BACKUP}"
  fi

  node - "${GLOBAL_HOOKS_FILE}" "${COLLECTOR_SCRIPT}" <<'NODE_EOF'
const fs = require('node:fs');
const [hooksPath, collectorScript] = process.argv.slice(2);
let hooks = {};
try {
  hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
} catch {
  hooks = {};
}
hooks['agy-hud-pro'] = {
  enabled: true,
  SessionStart: [
    { type: 'command', command: `node ${collectorScript} --event SessionStart`, timeout: 5 }
  ],
  PreInvocation: [
    { type: 'command', command: `node ${collectorScript} --event PreInvocation`, timeout: 5 }
  ],
  Stop: [
    { type: 'command', command: `node ${collectorScript} --event Stop`, timeout: 5 }
  ],
};
fs.writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
NODE_EOF
  log_ok "已合并生命周期钩子至: ${GLOBAL_HOOKS_FILE}"
}

run_simulation_tests() {
  ensure_executable

  local tmp_dir
  tmp_dir="$(mktemp -d /tmp/agy-hud-pro-test.XXXXXX)"
  trap "rm -rf '${tmp_dir}'" EXIT

  local test_state="${tmp_dir}/state.json"
  local test_lock="${tmp_dir}/collector.lock"
  local test_stdin_dump="/tmp/agy-hud-last-stdin.json"
  local mock_repo="${tmp_dir}/mock-repo"

  # 准备一个临时 Git 仓库（带脏状态）用于演示 git:main* 与 git:feat/auth✓
  mkdir -p "${mock_repo}"
  git -C "${mock_repo}" init -q -b main
  git -C "${mock_repo}" config user.email "hud@local"
  git -C "${mock_repo}" config user.name "HUD"
  printf "hello\n" > "${mock_repo}/README.md"
  git -C "${mock_repo}" add README.md
  git -C "${mock_repo}" commit -q -m "init"

  log_header "2. 校验 Antigravity 插件结构 (agy plugin validate)"
  if command -v agy >/dev/null 2>&1; then
    agy plugin validate --strict "${SCRIPT_DIR}" && log_ok "agy plugin validate --strict 通过！" || log_warn "agy plugin validate 存在提示"
  else
    log_warn "未检测到 agy 命令，跳过 agy plugin validate"
  fi

  log_header "3. 模拟 SessionStart 钩子（清理过期锁 + 后台初始化）"
  touch "${test_lock}"
  local out_ss rc_ss
  out_ss="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","cwd":"%s"}\n' "${mock_repo}" \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event SessionStart)"
  rc_ss=$?
  printf "  stdout : %s\n" "${out_ss}"
  printf "  exit   : %d\n" "${rc_ss}"

  log_header "4. 模拟 Stop 钩子（累加多轮本地 Token 账本：5h 与自然周统计）"
  local out_stop rc_stop
  out_stop="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL","usage":{"input_tokens":850000,"output_tokens":350000}}\n' \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event Stop)"
  rc_stop=$?
  printf "  stdout : %s\n" "${out_stop}"
  printf "  exit   : %d\n" "${rc_stop}"

  # 写入一条 2 天前的自然周记录（3.6M tok）+ 一条 9 天前的过期记录（应被自动清理）
  node - "${test_state}" <<'NODE_EOF'
const fs = require('node:fs');
const stateFile = process.argv[2];
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const now = Date.now();
st.ledger.push({ ts: now - 2 * 24 * 3600 * 1000, tokens: 3_600_000, model: 'gemini-4-neon', conversationId: 'conv-old-week', source: 'mock' });
st.ledger.push({ ts: now - 9 * 24 * 3600 * 1000, tokens: 9_999_999, model: 'gemini-4-neon', conversationId: 'conv-expired', source: 'mock-expired' });
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
NODE_EOF

  # 再触发一次 Stop 钩子让它自动清理 >7 天过期记录并重算（delta = 0 仅触发重算）
  printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL"}\n' \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LOCK_FILE="${test_lock}" AGY_HUD_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null

  log_ok "已自动清理 >7 天过期记录，当前本地账本聚合："
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("  ledger entries:", s.ledger.length, "| 5h tokens:", s.usage.tokens5h, "| week tokens:", s.usage.tokensWeek, "| est 5h%:", s.quota.remaining5h, "| est wk%:", s.quota.remainingWeek);' "${test_state}"

  log_header "5. 模拟 StatusLine 实时渲染（5圆点进度条：正常绿 ≤80% / 预警黄 >80% / 危急红 >90%）"

  # 场景 A：正常绿色（已用 ≤80%）+ 脏工作区 git:main* + 实时 stdin 配额
  printf "dirty\n" >> "${mock_repo}/README.md"
  local rendered_a rc_a ms
  local payload_a
  payload_a="$(printf '{"model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":18.5,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"quota":{"gemini-5h":{"remaining_fraction":0.78,"reset_in_seconds":11880},"gemini-weekly":{"remaining_fraction":0.91,"reset_in_seconds":468000}},"workspace":{"current_dir":"%s"},"cycle_mode":"auto","sandbox":{"enabled":false},"plan_tier":"Google AI Pro","email":"user@example.com"}\n' "${mock_repo}")"
  local t0 t1
  t0="$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000')"
  rendered_a="$(printf '%s\n' "${payload_a}" \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_a=$?
  t1="$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000')"
  ms=$((t1 - t0))
  printf "  ${DIM}[场景 A - 正常绿色 (≤80%%) / 脏仓库 / 实测耗时 %dms / exit=%d]${RESET}\n" "${ms}" "${rc_a}"
  printf "%s\n\n" "${rendered_a}" | sed 's/^/  /'

  # 场景 B：黄色预警（消耗 >80%，即 Ctx>80%、5h/Wk余量<20%）+ 干净分支 git:feat/auth✓ + camelCase 嗅探
  git -C "${mock_repo}" checkout -q -b feat/auth
  git -C "${mock_repo}" checkout -q -- README.md
  local rendered_b rc_b
  rendered_b="$(printf '{"modelName":"gemini-4-neon","contextWindow":{"usedTokens":840000,"maxTokens":1000000},"quota":{"5h":{"remaining_percentage":18},"weekly":{"remaining_percentage":15}},"cwd":"%s"}\n' "${mock_repo}" \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_b=$?
  printf "  ${DIM}[场景 B - 黄色预警 (>80%%) / 干净分支 / camelCase 嗅探 / exit=%d]${RESET}\n" "${rc_b}"
  printf "%s\n\n" "${rendered_b}" | sed 's/^/  /'

  # 场景 C：红色危急（消耗 >90%，即 Ctx>90%、5h/Wk余量<10%）+ 本地估算回退 (~前缀) + 非 Git 目录
  node - "${test_state}" <<'NODE_EOF'
const fs = require('node:fs');
const stateFile = process.argv[2];
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const now = Date.now();
st.quota.isEstimated = true;
st.quota.source = 'estimated';
// 重置为精确的 >90% 消耗账本：5h 消耗 4.6M/5M (~8% 余量)，本周消耗 37.2M/40M (~7% 余量)
st.ledger = [
  { ts: now - 10 * 60 * 1000, tokens: 4_600_000, model: 'gemini-4-neon', conversationId: 'conv-heavy-5h', source: 'mock' },
  { ts: now - 24 * 3600 * 1000, tokens: 32_600_000, model: 'gemini-4-neon', conversationId: 'conv-heavy-wk', source: 'mock' },
];
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
NODE_EOF
  # 触发一次重算以更新估算配额缓存
  printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon"}\n' \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LOCK_FILE="${test_lock}" AGY_HUD_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null

  local rendered_c rc_c
  rendered_c="$(printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":92.5},"cwd":"/tmp"}\n' \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LAST_STDIN="${test_stdin_dump}" node "${STATUSLINE_SCRIPT}")"
  rc_c=$?
  printf "  ${DIM}[场景 C - 红色危急 (>90%%) / 本地估算(~前缀) / 非 Git 优雅隐藏 / exit=%d]${RESET}\n" "${rc_c}"
  printf "%s\n" "${rendered_c}" | sed 's/^/  /'

  log_header "6. 模拟 PreInvocation / UserPromptSubmit 主动预警钩子（余量 < 15% 注入切换模型提醒）"
  local out_warn rc_warn
  out_warn="$(printf '{"conversationId":"conv-demo-001","modelName":"gemini-4-neon","lastUserInput":"重构整个后端模块"}\n' \
    | AGY_HUD_STATE_FILE="${test_state}" AGY_HUD_LOCK_FILE="${test_lock}" node "${COLLECTOR_SCRIPT}" --event UserPromptSubmit)"
  rc_warn=$?
  printf "  exit   : %d\n" "${rc_warn}"
  printf "  stdout : %s\n" "${out_warn}"

  log_header "7. 验证周配额周期对齐 (reset_time - 7d / reset_in_seconds / 过期回退)"
  local align_state="${tmp_dir}/state-align.json"
  local align_lock="${tmp_dir}/collector-align.lock"
  local align_reset_iso
  align_reset_iso="$(node -e 'console.log(new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString())')"

  # 写入跨重置周期账本：3 天前（上一周配额周期，应被排除）+ 1 天前（当前周配额周期，应被计入）
  node - "${align_state}" <<'NODE_EOF'
const fs = require('node:fs');
const stateFile = process.argv[2];
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
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
NODE_EOF

  # 7a. statusline.mjs 使用 reset_time (now + 5d => 当前周期起算于 now - 2d)，账本仅计入 500K，且 5h/Wk 状态栏不再显示不准确的 tok 数
  local rendered_align
  rendered_align="$(printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":10},"quota":{"gemini-weekly":{"remaining_fraction":0.85,"reset_time":"%s"}},"cwd":"/tmp"}\n' "${align_reset_iso}" \
    | NO_COLOR=1 AGY_HUD_STATE_FILE="${align_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/align-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${align_state}" "${align_reset_iso}" "${rendered_align}" <<'NODE_EOF'
const fs = require('node:fs');
const [stateFile, expectedReset, rendered] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (st.usage.tokensWeek !== 500_000) {
  console.error(`FAIL 7a: expected tokensWeek=500000, got ${st.usage.tokensWeek}`);
  process.exit(1);
}
if (st.quota.resetWeekTime !== expectedReset) {
  console.error(`FAIL 7a: expected resetWeekTime=${expectedReset}, got ${st.quota.resetWeekTime}`);
  process.exit(1);
}
if (rendered.includes('tok ·') || /\b\d+(?:\.\d+)?[KMB]?\s*tok\b/i.test(rendered)) {
  console.error(`FAIL 7a: expected 5h/Wk rendered output to omit inaccurate tok counts, got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 7b. collector.mjs Stop 钩子保持与 statusline 一致的周周期汇总
  printf '{"conversationId":"conv-curr-cycle","modelName":"gemini-4-neon","terminationReason":"NO_TOOL_CALL"}\n' \
    | AGY_HUD_STATE_FILE="${align_state}" AGY_HUD_LOCK_FILE="${align_lock}" AGY_HUD_LAST_STDIN="${tmp_dir}/none.json" node "${COLLECTOR_SCRIPT}" --event Stop >/dev/null
  node - "${align_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.usage.tokensWeek !== 500_000) {
  console.error(`FAIL 7b: collector Stop expected tokensWeek=500000, got ${st.usage.tokensWeek}`);
  process.exit(1);
}
NODE_EOF

  # 7c. 仅提供 reset_in_seconds (6 天剩余 => 周期起算于 1 天前)，自动推导 resetWeekTime 并排除 4 天前记录
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
    | NO_COLOR=1 AGY_HUD_STATE_FILE="${align_sec_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/align-sec-stdin.json" node "${STATUSLINE_SCRIPT}" >/dev/null
  node - "${align_sec_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.usage.tokensWeek !== 300_000) {
  console.error(`FAIL 7c: reset_in_seconds-only expected tokensWeek=300000, got ${st.usage.tokensWeek}`);
  process.exit(1);
}
if (!st.quota.resetWeekTime || !Number.isFinite(Date.parse(st.quota.resetWeekTime))) {
  console.error(`FAIL 7c: expected derived ISO resetWeekTime, got ${st.quota.resetWeekTime}`);
  process.exit(1);
}
NODE_EOF

  # 7d. 过期 resetWeekTime 且无实时重置时间时安全回退至本地自然周
  node - "${align_sec_state}" <<'NODE_EOF'
const fs = require('node:fs');
const now = Date.now();
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
st.quota.resetWeekTime = new Date(now - 3600 * 1000).toISOString();
st.ledger = [
  { ts: now - 5 * 60 * 1000, tokens: 120_000, model: 'gemini-4-neon', conversationId: 'conv-fallback', source: 'mock' },
];
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  printf '{"model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":10},"cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUD_STATE_FILE="${align_sec_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/align-fb-stdin.json" node "${STATUSLINE_SCRIPT}" >/dev/null
  node - "${align_sec_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.usage.tokensWeek !== 120_000) {
  console.error(`FAIL 7d: fallback expected tokensWeek=120000, got ${st.usage.tokensWeek}`);
  process.exit(1);
}
NODE_EOF
  log_ok "周配额周期对齐校验全部通过（reset_time / collector Stop / reset_in_seconds / 过期回退）"

  log_header "8. 验证实时活跃状态、动作透出与吞吐速率 (working / tool / stall / idle / /clear / window isolation)"
  local act_state="${tmp_dir}/state-activity.json"
  local act_transcript="${tmp_dir}/transcript.jsonl"
  printf '{"step_index":1,"type":"USER_INPUT","status":"DONE","content":"hello"}\n' > "${act_transcript}"

  # 8a. 进入 working 且刚发消息 -> 显示 "● 思考中"
  local rendered_act1
  rendered_act1="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1000},"agent_state":"working","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act1}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('● 思考中')) {
  console.error(`FAIL 8a: expected "● 思考中", got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 8b. transcript 写入 tool_calls + 回拨 10s 起点 + output_tokens 增长 560 -> 显示 "● run_command 10s · ~56 t/s"
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
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act2}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('● run_command 10s · ~56 t/s')) {
  console.error(`FAIL 8b: expected "● run_command 10s · ~56 t/s", got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 8c. 超过 60s 无进展 -> 圆点变黄 (\x1b[33m●) 并显示分钟级耗时
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
    | AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act3}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('\x1b[33m●') || !rendered.includes('1m15s')) {
  console.error(`FAIL 8c: expected yellow stall dot and "1m15s", got:\n${JSON.stringify(rendered)}`);
  process.exit(1);
}
NODE_EOF

  # 8d. 切回 idle 且即使静置 2 小时后仍持续显示 "~56 t/s"（窗口生命周期内不过期）
  node - "${act_state}" <<'NODE_EOF'
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
st.windowActivity['win-main'].lastTpsAt = Date.now() - 2 * 3600 * 1000;
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
NODE_EOF
  local rendered_act4
  rendered_act4="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1560},"agent_state":"idle","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act4}" <<'NODE_EOF'
const rendered = process.argv[2];
if (rendered.includes('●') || !rendered.includes('~56 t/s')) {
  console.error(`FAIL 8d: expected persistent idle "~56 t/s" without dot, got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 8e. 同一窗口开启新一轮 working -> 不清空历史速率，持续显示 "~56 t/s"
  local rendered_act5
  rendered_act5="$(printf '{"session_id":"sess-act","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":12,"total_output_tokens":1560},"agent_state":"working","transcript_path":"%s","cwd":"/tmp"}\n' "${act_transcript}" \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act5}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('~56 t/s')) {
  console.error(`FAIL 8e: expected new working turn to preserve "~56 t/s", got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 8f. 同一窗口执行 /clear（新 session_id + total_output_tokens=0）-> 速率不归零、不消失，且输出基线正确归零
  local rendered_act6
  rendered_act6="$(printf '{"session_id":"sess-after-clear","model":{"id":"gemini-4-neon","display_name":"Gemini 4 Neon (High)","effort":"high"},"context_window":{"context_window_size":1000000,"used_percentage":0,"total_output_tokens":0},"agent_state":"idle","cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${act_state}" "${rendered_act6}" <<'NODE_EOF'
const fs = require('node:fs');
const [stateFile, rendered] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (!rendered.includes('~56 t/s')) {
  console.error(`FAIL 8f: expected /clear in same window to preserve "~56 t/s", got:\n${rendered}`);
  process.exit(1);
}
if (st.windowActivity['win-main'].lastOutTokens !== 0) {
  console.error(`FAIL 8f: expected lastOutTokens re-anchored to 0 after /clear, got ${st.windowActivity['win-main'].lastOutTokens}`);
  process.exit(1);
}
NODE_EOF

  # 8g. 新终端窗口隔离（不同 AGY_HUD_WINDOW_ID）-> 不继承旧窗口速率
  local rendered_act7
  rendered_act7="$(printf '{"session_id":"sess-other-win","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":5,"total_output_tokens":0},"agent_state":"idle","cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-other" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act7}" <<'NODE_EOF'
const rendered = process.argv[2];
if (rendered.includes('t/s')) {
  console.error(`FAIL 8g: expected new window not to inherit old window speed, got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF

  # 8h. 原生 tokens_per_second 字段优先直显（不带 ~ 前缀）
  local rendered_act8
  rendered_act8="$(printf '{"session_id":"sess-after-clear","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":12},"agent_state":"idle","tokens_per_second":84,"cwd":"/tmp"}\n' \
    | NO_COLOR=1 AGY_HUD_WINDOW_ID="win-main" AGY_HUD_STATE_FILE="${act_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/act-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_act8}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('84 t/s') || rendered.includes('~84 t/s')) {
  console.error(`FAIL 8h: expected native "84 t/s" without tilde, got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF
  log_ok "实时活跃状态、动作透出、卡顿提醒、/clear 保留与窗口级 t/s 隔离校验全部通过"

  log_header "9. 验证当前会话净消耗 Token 精确增量统计 (Ctx -> Tok -> Cache，排除 cache_read)"
  local tok_state="${tmp_dir}/state-session-tok.json"
  local tok_transcript="${tmp_dir}/transcript-session-tok.jsonl"
  printf '{"step_index":1,"type":"USER_INPUT","status":"DONE","content":"hi"}\n' > "${tok_transcript}"
  printf '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":12000,"cache_read_tokens":500000,"output_tokens":3000}\n' >> "${tok_transcript}"
  printf '{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":8000,"cache_read_tokens":600000,"output_tokens":2000}\n' >> "${tok_transcript}"

  # 9a. 首次扫描：12K+3K + 8K+2K = 25K（不含 1.1M cache_read），位置在 Ctx 后、Cache 前
  local rendered_tok1
  rendered_tok1="$(printf '{"session_id":"sess-tok","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":15,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"quota":{"gemini-5h":{"remaining_fraction":0.8,"reset_in_seconds":7200},"gemini-weekly":{"remaining_fraction":0.75,"reset_in_seconds":345600}},"transcript_path":"%s","cwd":"/tmp"}\n' "${tok_transcript}" \
    | NO_COLOR=1 AGY_HUD_STATE_FILE="${tok_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/tok-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_tok1}" <<'NODE_EOF'
const rendered = process.argv[2];
const line1 = rendered.split('\n')[0] || '';
const idxCtx = line1.indexOf('Ctx:');
const idxTok = line1.indexOf('Tok: 25K');
const idxCache = line1.indexOf('Cache: 98%');
if (idxCtx < 0 || idxTok < 0 || idxCache < 0 || !(idxCtx < idxTok && idxTok < idxCache)) {
  console.error(`FAIL 9a: expected "Ctx:" < "Tok: 25K" < "Cache: 98%", got:\n${line1}`);
  process.exit(1);
}
if (line1.includes('tok ·')) {
  console.error(`FAIL 9a: 5h/Wk should not render tok counts, got:\n${line1}`);
  process.exit(1);
}
NODE_EOF

  # 9b. 再次刷新（文件无变化）不应重复累加；追加新步骤 (+75K) 后精确增至 100K
  printf '{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":60000,"cache_read_tokens":900000,"output_tokens":15000}\n' >> "${tok_transcript}"
  local rendered_tok2
  rendered_tok2="$(printf '{"session_id":"sess-tok","model":{"id":"gemini-4-neon"},"context_window":{"context_window_size":1000000,"used_percentage":15,"current_usage":{"input_tokens":2000,"cache_read_input_tokens":98000}},"transcript_path":"%s","cwd":"/tmp"}\n' "${tok_transcript}" \
    | NO_COLOR=1 AGY_HUD_STATE_FILE="${tok_state}" AGY_HUD_LAST_STDIN="${tmp_dir}/tok-stdin.json" node "${STATUSLINE_SCRIPT}")"
  node - "${rendered_tok2}" <<'NODE_EOF'
const rendered = process.argv[2];
if (!rendered.includes('Tok: 100K')) {
  console.error(`FAIL 9b: expected incremental "Tok: 100K", got:\n${rendered}`);
  process.exit(1);
}
NODE_EOF
  log_ok "当前会话净消耗 Token 增量统计与位置顺序校验全部通过 (25K -> 100K)"

  log_header "10. 验证字段嗅探文件 (/tmp/agy-hud-last-stdin.json)"
  if [[ -f "${test_stdin_dump}" ]]; then
    log_ok "已生成 ${test_stdin_dump}（前 8 行）："
    head -n 8 "${test_stdin_dump}" | sed 's/^/  /'
  fi

  printf "\n${BOLD}${GREEN}✔ 全部模拟测试通过！${RESET}\n"
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
  "")
    run_simulation_tests
    preview_config
    ;;
  *)
    echo "用法: $0 [--test | --preview | --install]"
    exit 1
    ;;
esac
