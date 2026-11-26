#!/usr/bin/env node
/**
 * agy-hub-pro / statusline.mjs
 *
 * Millisecond synchronous StatusLine renderer & diagnostics CLI for Antigravity CLI (agy).
 * Zero external dependencies (native Node.js ESM).
 *
 * Usage:
 *   <json> | node statusline.mjs       # Render 2-line ANSI HUD from agy stdin payload
 *   node statusline.mjs --test         # Preview rendered ANSI output using simulated session JSON
 *   node statusline.mjs --doctor       # Run environment, config mount, and cache health diagnostics
 *   node statusline.mjs --version      # Print plugin version
 *   node statusline.mjs --help         # Show CLI help
 *
 * Renders compact 2-line ANSI dashboard:
 *   Line 1: agy-hub-pro (git:main✓) │ Ctx: ◉○○○○ 14.8% (155K/1M) │ Tok: 1.4M │ Cache: 98% │ 5h: ◉◉◉◉○ 83% (3h18m) │ Wk: ◉◉◉◉○ 74% (5d9h)
 *   Line 2: [Gemini 4 Neon · High] │ User: user@example.com │ Plan: Google AI Pro │ Mode: auto │ Sandbox: OFF │ ● run_command 18s · ~56 t/s
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.dirname(__filename);

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'plugins', 'agy-hub-pro', 'data');
const FALLBACK_DATA_DIR = path.join(os.tmpdir(), 'agy-hub-pro-data');

function resolveDataDir() {
  const envDir = process.env.AGY_HUB_DATA_DIR || process.env.AGY_HUD_DATA_DIR;
  const candidates = envDir ? [envDir, FALLBACK_DATA_DIR] : [DEFAULT_DATA_DIR, FALLBACK_DATA_DIR];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      return { dir, isFallback: !envDir && dir === FALLBACK_DATA_DIR };
    } catch {
      // Try next writable location
    }
  }
  return { dir: FALLBACK_DATA_DIR, isFallback: true };
}

const RESOLVED_DATA = resolveDataDir();
const DATA_DIR = RESOLVED_DATA.dir;
const EXPLICIT_STATE_FILE = process.env.AGY_HUB_STATE_FILE || process.env.AGY_HUD_STATE_FILE || '';
const STATE_FILE = EXPLICIT_STATE_FILE || path.join(DATA_DIR, 'state.json');
const LOCK_FILE =
  process.env.AGY_HUB_LOCK_FILE ||
  process.env.AGY_HUD_LOCK_FILE ||
  path.join(DATA_DIR, 'collector.lock');
const LAST_STDIN_FILE =
  process.env.AGY_HUB_LAST_STDIN ||
  process.env.AGY_HUD_LAST_STDIN ||
  path.join(DATA_DIR, 'last-stdin.json');
const GIT_TIMEOUT_MS = Number(
  process.env.AGY_HUB_GIT_TIMEOUT_MS || process.env.AGY_HUD_GIT_TIMEOUT_MS || 150
);
const STALL_WARN_MS =
  Math.max(5, Number(process.env.AGY_HUB_STALL_SEC || process.env.AGY_HUD_STALL_SEC || 60)) * 1000;
const SHOW_NON_GIT =
  (process.env.AGY_HUB_SHOW_NON_GIT || process.env.AGY_HUD_SHOW_NON_GIT) === '1';
const TRANSCRIPT_TAIL_BYTES = 16384;
const MAX_TRACKED_WINDOWS = 16;
const MAX_SESSION_TOKEN_CACHE = 32;

const USE_COLOR = !process.env.NO_COLOR;
const ANSI = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  gray: USE_COLOR ? '\x1b[90m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  red: USE_COLOR ? '\x1b[1;31m' : '',
  magenta: USE_COLOR ? '\x1b[35m' : '',
  blue: USE_COLOR ? '\x1b[34m' : '',
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DOT_COUNT = 5;

const DOT_STYLES = {
  bullseye: { filled: '◉', empty: '○', sep: '' },
  pill: { filled: '▰', empty: '▱', sep: '' },
  small: { filled: '•', empty: '◦', sep: '' },
  square: { filled: '▪', empty: '▫', sep: '' },
  diamond: { filled: '◆', empty: '◇', sep: '' },
  classic: { filled: '●', empty: '○', sep: '' },
};
const ACTIVE_DOT_STYLE_NAME = (
  process.env.AGY_HUB_DOT_STYLE ||
  process.env.AGY_HUD_DOT_STYLE ||
  'bullseye'
).toLowerCase();
const ACTIVE_DOT_STYLE = DOT_STYLES[ACTIVE_DOT_STYLE_NAME] || DOT_STYLES.bullseye;

function colorByUsage(usedPct) {
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) return ANSI.dim;
  if (usedPct > 90) return ANSI.red;
  if (usedPct > 80) return ANSI.yellow;
  return ANSI.green;
}

function renderDots(displayPct, color) {
  const { filled: filledGlyph, empty: emptyGlyph, sep } = ACTIVE_DOT_STYLE;
  const clamped = Math.max(0, Math.min(100, Number(displayPct) || 0));
  const filled = Math.round((clamped / 100) * DOT_COUNT);
  const empty = DOT_COUNT - filled;
  const parts = [];
  if (filled > 0) {
    parts.push(`${color}${Array(filled).fill(filledGlyph).join(sep)}${ANSI.reset}`);
  }
  if (empty > 0) {
    const emptyColor = filled === 0 && color !== ANSI.green ? color : ANSI.gray;
    parts.push(`${emptyColor}${Array(empty).fill(emptyGlyph).join(sep)}${ANSI.reset}`);
  }
  return parts.join(sep);
}

function formatCompactTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) {
    const k = v / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${Math.round(v)}`;
}

function formatWindowSize(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 990_000 && v <= 1_060_000) return '1M';
  if (v >= 1_980_000 && v <= 2_120_000) return '2M';
  return formatCompactTokens(v);
}

function formatPct(pct, decimals = 1) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '--';
  const clamped = Math.max(0, Math.min(100, pct));
  return decimals === 0
    ? `${Math.round(clamped)}%`
    : `${clamped.toFixed(decimals).replace(/\.0$/, '')}%`;
}

const EFFORT_META = {
  none: { label: 'Off', color: ANSI.dim },
  minimal: { label: 'Min', color: ANSI.dim },
  low: { label: 'Low', color: ANSI.green },
  medium: { label: 'Medium', color: ANSI.blue },
  high: { label: 'High', color: ANSI.magenta },
  xhigh: { label: 'XHigh', color: ANSI.yellow },
  max: { label: 'Max', color: ANSI.red },
};

function normalizeModelName(raw) {
  if (!raw || typeof raw !== 'string') return 'AGY';
  return (
    raw
      .trim()
      .replace(/^models\//i, '')
      .replace(/\s*\((?:none|minimal|low|medium|high|xhigh|max)\)\s*$/i, '')
      .trim() || raw.trim()
  );
}

function formatEffort(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (EFFORT_META[key]) return EFFORT_META[key];
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return { label, color: ANSI.magenta };
}

// ---------------------------------------------------------------------------
// Stdin reading, sniffing & multi-schema extraction
// ---------------------------------------------------------------------------

async function readAndSniffStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { _raw: raw };
    }

    try {
      const debugFlag = process.env.AGY_HUB_DEBUG || process.env.AGY_HUD_DEBUG;
      const sniffFlag = process.env.AGY_HUB_SNIFF ?? process.env.AGY_HUD_SNIFF;
      const shouldDump =
        debugFlag === '1' || sniffFlag !== '0' || !fs.existsSync(LAST_STDIN_FILE);
      if (shouldDump) {
        fs.mkdirSync(path.dirname(LAST_STDIN_FILE), { recursive: true });
        fs.writeFileSync(LAST_STDIN_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      }
    } catch {
      // Never break status line on snapshot write error
    }

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractModelInfo(payload) {
  const nameCandidates = [
    payload.model?.display_name,
    payload.model?.displayName,
    payload.model?.name,
    payload.model?.id,
    typeof payload.model === 'string' ? payload.model : null,
    payload.modelName,
    payload.model_name,
    payload.model_id,
  ];
  let rawName = '';
  for (const c of nameCandidates) {
    if (typeof c === 'string' && c.trim()) {
      rawName = c.trim();
      break;
    }
  }

  const effortCandidates = [
    payload.model?.effort,
    payload.model?.reasoning_effort,
    payload.model?.reasoningEffort,
    payload.model?.thinking_effort,
    payload.model?.thinkingEffort,
    payload.effort,
    payload.reasoning_effort,
    payload.reasoningEffort,
    payload.thinking_effort,
    payload.thinkingEffort,
  ];
  let rawEffort = '';
  for (const e of effortCandidates) {
    if (typeof e === 'string' && e.trim()) {
      rawEffort = e.trim();
      break;
    }
  }

  if (!rawEffort && rawName) {
    const m = rawName.match(/\((none|minimal|low|medium|high|xhigh|max)\)\s*$/i);
    if (m) rawEffort = m[1];
  }

  return {
    name: normalizeModelName(rawName),
    effort: formatEffort(rawEffort),
  };
}

function extractContextWindow(payload) {
  const cw =
    payload.context_window ||
    payload.contextWindow ||
    payload.context ||
    payload.usage ||
    {};

  const rawMax =
    cw.context_window_size ??
    cw.contextWindowSize ??
    cw.max_tokens ??
    cw.maxTokens ??
    cw.total_tokens ??
    cw.totalTokens ??
    cw.limit ??
    payload.max_tokens ??
    payload.maxTokens ??
    1_000_000;
  const maxTokens = Number(rawMax) > 0 ? Number(rawMax) : 1_000_000;

  let usedTokens = null;
  const directUsed =
    cw.used_tokens ??
    cw.usedTokens ??
    cw.tokens_used ??
    cw.tokensUsed ??
    cw.total_input_tokens ??
    cw.input_tokens ??
    cw.inputTokens ??
    payload.used_tokens ??
    payload.usedTokens;

  if (directUsed != null && Number.isFinite(Number(directUsed))) {
    usedTokens = Math.max(0, Number(directUsed));
  } else if (cw.current_usage && typeof cw.current_usage === 'object') {
    const cu = cw.current_usage;
    const sum =
      Number(cu.input_tokens ?? cu.inputTokens ?? 0) +
      Number(cu.cache_creation_input_tokens ?? 0) +
      Number(cu.cache_read_input_tokens ?? 0) +
      Number(cu.output_tokens ?? cu.outputTokens ?? 0);
    if (sum > 0) usedTokens = sum;
  }

  let usedPct = null;
  const directPct =
    cw.used_percentage ??
    cw.usedPercentage ??
    cw.percent ??
    cw.percentage ??
    payload.used_percentage ??
    payload.usedPercentage;

  if (directPct != null && Number.isFinite(Number(directPct))) {
    usedPct = Number(directPct);
  } else if (
    cw.remaining_percentage != null &&
    Number.isFinite(Number(cw.remaining_percentage))
  ) {
    usedPct = 100 - Number(cw.remaining_percentage);
  } else if (
    cw.remainingPercentage != null &&
    Number.isFinite(Number(cw.remainingPercentage))
  ) {
    usedPct = 100 - Number(cw.remainingPercentage);
  } else if (usedTokens != null && maxTokens > 0) {
    usedPct = (usedTokens / maxTokens) * 100;
  }

  if (usedTokens == null && usedPct != null) {
    usedTokens = Math.round((maxTokens * usedPct) / 100);
  }

  return {
    usedPct: usedPct != null ? Math.max(0, Math.min(100, usedPct)) : 0,
    usedTokens: usedTokens ?? 0,
    maxTokens,
  };
}

function isThirdPartyModel(payload) {
  const modelStr = String(
    payload?.model?.id ||
    payload?.model?.display_name ||
    payload?.model?.displayName ||
    payload?.modelName ||
    (typeof payload?.model === 'string' ? payload.model : '')
  ).toLowerCase();
  return /(claude|sonnet|opus|haiku|gpt|openai|\bo1\b|\bo3\b|\bo4\b|\b3p\b)/i.test(modelStr);
}

function extractLiveQuotaFromStdin(payload) {
  const q = payload.quota;
  if (!q || typeof q !== 'object') {
    return {
      rem5h: null,
      remWk: null,
      reset5hTime: null,
      reset5hSec: null,
      resetWkTime: null,
      resetWkSec: null,
    };
  }

  const pickPct = (node) => {
    if (node == null) return null;
    if (typeof node === 'number') return node <= 1 ? node * 100 : node;
    if (typeof node !== 'object') return null;
    if (typeof node.remaining_fraction === 'number') return node.remaining_fraction * 100;
    if (typeof node.remainingFraction === 'number') return node.remainingFraction * 100;
    if (typeof node.remaining_percentage === 'number') return node.remaining_percentage;
    if (typeof node.remainingPercentage === 'number') return node.remainingPercentage;
    if (typeof node.used_percentage === 'number') return 100 - node.used_percentage;
    return null;
  };

  const pickNode = (node) => {
    const pct = pickPct(node);
    if (pct === null) return null;
    const resetTime =
      typeof node === 'object' ? (node.reset_time ?? node.resetTime ?? null) : null;
    const resetSec =
      typeof node === 'object'
        ? (node.reset_in_seconds ?? node.resetInSeconds ?? null)
        : null;
    return { pct, resetTime, resetSec };
  };

  const is3p = isThirdPartyModel(payload);
  const preferred5h = is3p
    ? ['3p-5h', '3p_5h', 'gemini-5h', '5h', 'five_hour']
    : ['gemini-5h', 'gemini_5h', '5h', 'five_hour'];
  const preferredWk = is3p
    ? ['3p-weekly', '3p_weekly', 'gemini-weekly', 'weekly', '7d']
    : ['gemini-weekly', 'gemini_weekly', 'weekly', '7d'];

  const pickByKeys = (keys) => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(q, k)) {
        const res = pickNode(q[k]);
        if (res !== null) return res;
      }
    }
    return null;
  };

  let info5h = pickByKeys(preferred5h);
  let infoWk = pickByKeys(preferredWk);

  for (const [k, v] of Object.entries(q)) {
    const lk = k.toLowerCase();
    if (!is3p && (lk.startsWith('3p-') || lk.startsWith('3p_') || lk.includes('wtu'))) continue;
    if (info5h === null && (lk.includes('5h') || lk.includes('five_hour') || lk.includes('rolling'))) {
      const res = pickNode(v);
      if (res !== null) info5h = res;
    } else if (infoWk === null && (lk.includes('week') || lk.includes('7d') || lk.includes('wk'))) {
      const res = pickNode(v);
      if (res !== null) infoWk = res;
    }
  }

  return {
    rem5h: info5h?.pct ?? null,
    remWk: infoWk?.pct ?? null,
    reset5hTime: info5h?.resetTime ?? null,
    reset5hSec: info5h?.resetSec ?? null,
    resetWkTime: infoWk?.resetTime ?? null,
    resetWkSec: infoWk?.resetSec ?? null,
  };
}

function formatResetCountdown(resetTime, resetSec) {
  let secLeft =
    typeof resetSec === 'number' && Number.isFinite(resetSec) && resetSec >= 0
      ? Math.round(resetSec)
      : null;

  if (secLeft === null) {
    let targetMs = null;
    if (typeof resetTime === 'string' && resetTime.trim()) {
      const parsed = Date.parse(resetTime);
      if (Number.isFinite(parsed)) targetMs = parsed;
    } else if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
      targetMs = resetTime > 1e12 ? resetTime : resetTime * 1000;
    }
    if (targetMs !== null) {
      secLeft = Math.max(0, Math.round((targetMs - Date.now()) / 1000));
    }
  }

  if (secLeft === null) return null;
  if (secLeft < 60) return '<1m';

  const totalMin = Math.round(secLeft / 60);
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours >= 24) {
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }

  const m = totalMin % 60;
  return totalHours > 0 ? (m > 0 ? `${totalHours}h${m}m` : `${totalHours}h`) : `${m}m`;
}

function extractSessionTotalTokens(payload) {
  const cw = payload.context_window || payload.contextWindow || {};
  const inTok = Number(cw.total_input_tokens ?? cw.totalInputTokens ?? 0);
  const outTok = Number(cw.total_output_tokens ?? cw.totalOutputTokens ?? 0);
  const sum = (Number.isFinite(inTok) ? inTok : 0) + (Number.isFinite(outTok) ? outTok : 0);
  return sum > 0 ? Math.round(sum) : 0;
}

function extractSessionOutputTokens(payload) {
  const cw = payload.context_window || payload.contextWindow || {};
  const outTok = Number(
    cw.total_output_tokens ?? cw.totalOutputTokens ?? payload.total_output_tokens ?? 0
  );
  return Number.isFinite(outTok) && outTok > 0 ? Math.round(outTok) : 0;
}

function extractAgentWorking(payload) {
  const raw =
    payload.agent_state ??
    payload.agentState ??
    payload.state ??
    payload.status ??
    '';
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toLowerCase();
  return (
    s === 'working' ||
    s === 'running' ||
    s === 'thinking' ||
    s === 'streaming' ||
    s === 'executing' ||
    s === 'in_progress' ||
    s === 'busy'
  );
}

function extractNativeTokensPerSec(payload) {
  const candidates = [
    payload.tokens_per_second,
    payload.tokensPerSecond,
    payload.output_tokens_per_second,
    payload.outputTokensPerSecond,
    payload.context_window?.tokens_per_second,
    payload.contextWindow?.tokensPerSecond,
    payload.usage?.tokens_per_second,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (c != null && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function resolveTranscriptPath(payload) {
  const raw = payload.transcript_path || payload.transcriptPath || '';
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (fs.existsSync(trimmed)) return trimmed;
  if (trimmed.includes('/.gemini/antigravity/brain/')) {
    const alt = trimmed.replace('/.gemini/antigravity/brain/', '/.gemini/antigravity-cli/brain/');
    if (fs.existsSync(alt)) return alt;
  }
  return null;
}

function normalizeToolLabel(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  let name = rawName.trim().replace(/^(?:default_api:|functions\.)/i, '');
  if (name.length > 20) name = `${name.slice(0, 19)}…`;
  return name;
}

function readLatestTranscriptAction(payload) {
  if (payload._mockTranscriptAction) return payload._mockTranscriptAction;
  const filePath = resolveTranscriptPath(payload);
  if (!filePath) return { label: '思考中', stepKey: null };

  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { label: '思考中', stepKey: null };

    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const startPos = stat.size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, readLen, startPos);
    const text = buf.subarray(0, bytesRead).toString('utf8');

    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { label: '思考中', stepKey: `size:${stat.size}` };
      }

      const stepIdx = entry.step_index ?? entry.stepIndex ?? '';
      const type = String(entry.type || '').toUpperCase();
      const toolCalls = Array.isArray(entry.tool_calls)
        ? entry.tool_calls
        : Array.isArray(entry.toolCalls)
          ? entry.toolCalls
          : [];

      if (type === 'PLANNER_RESPONSE' && toolCalls.length > 0) {
        const names = toolCalls
          .map((tc) => normalizeToolLabel(tc?.name || tc?.function?.name || tc?.tool_name || ''))
          .filter(Boolean);
        if (names.length > 0) {
          const lastName = names[names.length - 1];
          const allSame = names.length > 1 && names.every((n) => n === lastName);
          const label = allSame ? `${lastName}×${names.length}` : lastName;
          return { label, stepKey: `${stepIdx}:${label}` };
        }
      }

      return { label: '思考中', stepKey: `${stepIdx}:${type || 'thinking'}` };
    }
  } catch {
    // Never fail statusline on transcript I/O error
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  return { label: '思考中', stepKey: null };
}

function formatElapsedCompact(ms) {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 1) return '';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

function formatTokensPerSec(tps, isEstimated) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return '';
  const val = tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1).replace(/\.0$/, '');
  return `${isEstimated ? '~' : ''}${val} t/s`;
}

function resolveWindowId() {
  const candidates = [
    process.env.AGY_HUB_WINDOW_ID,
    process.env.AGY_HUD_WINDOW_ID,
    process.env.TMUX_PANE,
    process.env.ITERM_SESSION_ID,
    process.env.TERM_SESSION_ID,
    process.env.WEZTERM_PANE,
    process.env.KITTY_WINDOW_ID,
    process.env.WT_SESSION,
    process.env.ALACRITTY_WINDOW_ID,
    process.env.VSCODE_PID,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '_default';
}

function formatActivitySegment(activity, isWorking, nativeTps, transcriptAction, now) {
  const isEstimated = nativeTps === null;
  const activeTps =
    nativeTps !== null
      ? nativeTps
      : typeof activity?.lastTps === 'number' &&
          Number.isFinite(activity.lastTps) &&
          activity.lastTps > 0
        ? activity.lastTps
        : null;
  const tpsLabel = activeTps !== null ? formatTokensPerSec(activeTps, isEstimated) : '';

  if (isWorking) {
    const startAt = activity?.workStartAt || now;
    const progressAt = activity?.lastProgressAt || startAt;
    const elapsedStr = formatElapsedCompact(now - startAt);
    const isStalled = now - progressAt >= STALL_WARN_MS;

    const dotColor = isStalled ? ANSI.yellow : ANSI.green;
    const actionLabel = transcriptAction?.label || '思考中';
    const actionColor = actionLabel === '思考中' ? ANSI.dim : ANSI.cyan;
    const elapsedColor = isStalled ? ANSI.yellow : ANSI.dim;

    let text = `${dotColor}●${ANSI.reset} ${actionColor}${actionLabel}${ANSI.reset}`;
    if (elapsedStr) text += ` ${elapsedColor}${elapsedStr}${ANSI.reset}`;
    if (tpsLabel) {
      text += ` ${ANSI.dim}·${ANSI.reset} ${ANSI.cyan}${tpsLabel}${ANSI.reset}`;
    }
    return { priority: 5, text };
  }

  if (tpsLabel) {
    return { priority: 3, text: `${ANSI.dim}${tpsLabel}${ANSI.reset}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// State cache reader & live incremental ledger sync (pure local, zero network)
// ---------------------------------------------------------------------------

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_DRIFT_TOLERANCE_MS = 5 * 60 * 1000;

function getWeekStartMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = d.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diffToMonday);
  return d.getTime();
}

function parseResetTimeMs(rawTime) {
  if (typeof rawTime === 'string' && rawTime.trim()) {
    const parsed = Date.parse(rawTime);
    if (Number.isFinite(parsed)) return parsed;
  } else if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    return rawTime > 1e12 ? rawTime : rawTime * 1000;
  }
  return null;
}

function isValidFutureReset(resetMs, windowMs, now) {
  return resetMs !== null && resetMs > now && resetMs - now <= windowMs + WINDOW_DRIFT_TOLERANCE_MS;
}

function resolveWindowStartMs({ liveTime, liveSec, cachedTime, windowMs, fallbackStartMs, now }) {
  const liveMs = parseResetTimeMs(liveTime);
  if (isValidFutureReset(liveMs, windowMs, now)) {
    return liveMs - windowMs;
  }
  if (typeof liveSec === 'number' && Number.isFinite(liveSec) && liveSec > 0) {
    const fromSecMs = now + liveSec * 1000;
    if (isValidFutureReset(fromSecMs, windowMs, now)) {
      return fromSecMs - windowMs;
    }
  }
  const cachedMs = parseResetTimeMs(cachedTime);
  if (isValidFutureReset(cachedMs, windowMs, now)) {
    return cachedMs - windowMs;
  }
  return fallbackStartMs;
}

function syncCachedResetTime(quotaState, field, liveTime, liveSec, windowMs, now) {
  if (liveTime) {
    if (quotaState[field] !== liveTime) {
      quotaState[field] = liveTime;
      return true;
    }
    return false;
  }
  if (typeof liveSec === 'number' && Number.isFinite(liveSec) && liveSec > 0) {
    const derivedMs = now + liveSec * 1000;
    if (isValidFutureReset(derivedMs, windowMs, now)) {
      const prevMs = parseResetTimeMs(quotaState[field]);
      if (prevMs === null || prevMs <= now || Math.abs(derivedMs - prevMs) > 60_000) {
        quotaState[field] = new Date(derivedMs).toISOString();
        return true;
      }
    }
  }
  return false;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readStateCache() {
  const direct = safeReadJson(STATE_FILE);
  if (direct) return direct;
  if (!EXPLICIT_STATE_FILE) {
    const legacyCandidates = [
      path.join(PLUGIN_DIR, 'state.json'),
      path.join(os.homedir(), '.gemini', 'plugins', 'agy-hud-pro', 'state.json'),
    ];
    for (const legacyPath of legacyCandidates) {
      if (legacyPath !== STATE_FILE) {
        const legacy = safeReadJson(legacyPath);
        if (legacy) return legacy;
      }
    }
  }
  return null;
}

function atomicWriteState(data) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // Never break status line on write failure
  }
}

function resolveWindow5hStartMs(liveQuota, state, now = Date.now()) {
  return resolveWindowStartMs({
    liveTime: liveQuota?.reset5hTime,
    liveSec: liveQuota?.reset5hSec,
    cachedTime: state?.quota?.reset5hTime,
    windowMs: FIVE_HOURS_MS,
    fallbackStartMs: now - FIVE_HOURS_MS,
    now,
  });
}

function resolveWindowWeekStartMs(liveQuota, state, now = Date.now()) {
  return resolveWindowStartMs({
    liveTime: liveQuota?.resetWkTime,
    liveSec: liveQuota?.resetWkSec,
    cachedTime: state?.quota?.resetWeekTime,
    windowMs: SEVEN_DAYS_MS,
    fallbackStartMs: getWeekStartMs(now),
    now,
  });
}

function syncActivityState(state, payload, now, windowId, isWorking, outTok, nativeTps, transcriptAction) {
  const sessionId = payload.conversation_id || payload.session_id || payload.conversationId || '_default';
  if (!state.windowActivity || typeof state.windowActivity !== 'object') {
    state.windowActivity = {};
  }

  let prev =
    state.windowActivity[windowId] && typeof state.windowActivity[windowId] === 'object'
      ? state.windowActivity[windowId]
      : null;

  if (!prev && state.activity && typeof state.activity === 'object') {
    const legacyWin = state.activity.windowId || '_default';
    if (legacyWin === windowId) {
      prev = state.activity;
    }
  }

  const sameWindow = Boolean(prev);
  const sameSession = Boolean(prev && prev.sessionId === sessionId);

  let dirty = false;
  const preservedTps =
    sameWindow && typeof prev.lastTps === 'number' && Number.isFinite(prev.lastTps) && prev.lastTps > 0
      ? prev.lastTps
      : null;
  const preservedTpsAt = preservedTps !== null ? (prev.lastTpsAt || 0) : 0;

  const act = sameSession
    ? { ...prev, windowId }
    : {
        windowId,
        sessionId,
        isWorking: false,
        workStartAt: null,
        lastProgressAt: null,
        lastOutTokens: outTok,
        lastOutAt: now,
        lastTps: preservedTps,
        lastTpsAt: preservedTpsAt,
        lastStepKey: null,
        updatedAt: now,
      };

  if (!sameSession && (isWorking || outTok > 0 || preservedTps !== null)) {
    dirty = true;
  }

  const wasWorking = Boolean(act.isWorking);

  if (act.lastOutTokens > 0 && outTok < act.lastOutTokens) {
    act.lastOutTokens = outTok;
    act.lastOutAt = now;
    dirty = true;
  } else if (outTok > (act.lastOutTokens || 0)) {
    const deltaOut = outTok - (act.lastOutTokens || 0);
    const refTime = act.lastOutAt || act.workStartAt || 0;
    const dtMs = refTime > 0 ? now - refTime : 0;

    if (sameSession && dtMs >= 200 && dtMs <= 120_000) {
      const rawTps = deltaOut / (dtMs / 1000);
      if (rawTps >= 0.5 && rawTps <= 5000) {
        const smoothed =
          typeof act.lastTps === 'number' &&
          Number.isFinite(act.lastTps) &&
          act.lastTpsAt > 0 &&
          now - act.lastTpsAt < 30_000
            ? act.lastTps * 0.35 + rawTps * 0.65
            : rawTps;
        act.lastTps = Math.round(smoothed * 10) / 10;
        act.lastTpsAt = now;
      }
    }
    act.lastOutTokens = outTok;
    act.lastOutAt = now;
    act.lastProgressAt = now;
    dirty = true;
  } else if (outTok > 0 && !act.lastOutTokens) {
    act.lastOutTokens = outTok;
    act.lastOutAt = now;
    dirty = true;
  }

  if (nativeTps !== null) {
    const roundedNative = Math.round(nativeTps * 10) / 10;
    if (act.lastTps !== roundedNative || now - (act.lastTpsAt || 0) > 5_000) {
      act.lastTps = roundedNative;
      act.lastTpsAt = now;
      dirty = true;
    }
  }

  if (isWorking && !wasWorking) {
    act.isWorking = true;
    act.workStartAt = now;
    act.lastProgressAt = now;
    if (act.lastOutAt !== now) {
      act.lastOutAt = now;
      act.lastOutTokens = outTok;
    }
    act.lastStepKey = transcriptAction?.stepKey || null;
    dirty = true;
  } else if (isWorking && wasWorking) {
    if (!act.workStartAt) {
      act.workStartAt = now;
      dirty = true;
    }
    if (!act.lastProgressAt) {
      act.lastProgressAt = act.workStartAt;
      dirty = true;
    }
    if (transcriptAction?.stepKey && transcriptAction.stepKey !== act.lastStepKey) {
      act.lastStepKey = transcriptAction.stepKey;
      act.lastProgressAt = now;
      dirty = true;
    }
  } else if (!isWorking && wasWorking) {
    act.isWorking = false;
    act.workStartAt = null;
    act.lastStepKey = null;
    dirty = true;
  }

  if (dirty) {
    act.updatedAt = now;
  }
  state.windowActivity[windowId] = act;

  const winKeys = Object.keys(state.windowActivity);
  if (winKeys.length > MAX_TRACKED_WINDOWS) {
    winKeys
      .sort((a, b) => (state.windowActivity[b]?.updatedAt || 0) - (state.windowActivity[a]?.updatedAt || 0))
      .slice(MAX_TRACKED_WINDOWS)
      .forEach((k) => {
        delete state.windowActivity[k];
      });
    dirty = true;
  }

  state.activity = act;
  return { activity: act, dirty };
}

function syncSessionNetTokens(state, payload, now) {
  if (typeof payload._mockSessionNetTokens === 'number') {
    return { netTokens: payload._mockSessionNetTokens, dirty: false };
  }
  const filePath = resolveTranscriptPath(payload);
  if (!filePath) return { netTokens: null, dirty: false };

  const sessionId =
    payload.conversation_id || payload.session_id || payload.conversationId || filePath;
  if (!state.sessionTokens || typeof state.sessionTokens !== 'object') {
    state.sessionTokens = {};
  }

  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { netTokens: null, dirty: false };

    const prev =
      state.sessionTokens[sessionId] && typeof state.sessionTokens[sessionId] === 'object'
        ? state.sessionTokens[sessionId]
        : null;

    const validPrev =
      prev &&
      prev.filePath === filePath &&
      typeof prev.offset === 'number' &&
      prev.offset >= 0 &&
      prev.offset <= stat.size;

    const entry = validPrev
      ? { ...prev }
      : {
          filePath,
          offset: 0,
          inputTokens: 0,
          outputTokens: 0,
          updatedAt: now,
        };

    let dirty = !validPrev && stat.size > 0;

    if (stat.size > entry.offset) {
      const deltaLen = stat.size - entry.offset;
      const buf = Buffer.allocUnsafe(deltaLen);
      fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, deltaLen, entry.offset);
      const chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(0x0a);

      if (lastNl >= 0) {
        const completeText = chunk.subarray(0, lastNl).toString('utf8');
        for (const rawLine of completeText.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          const inTok = Number(rec.input_tokens ?? rec.inputTokens ?? rec.usage?.input_tokens ?? 0);
          const outTok = Number(rec.output_tokens ?? rec.outputTokens ?? rec.usage?.output_tokens ?? 0);
          if (Number.isFinite(inTok) && inTok > 0) entry.inputTokens += inTok;
          if (Number.isFinite(outTok) && outTok > 0) entry.outputTokens += outTok;
        }
        entry.offset += lastNl + 1;
        entry.updatedAt = now;
        dirty = true;
      }
    }

    if (dirty) {
      state.sessionTokens[sessionId] = entry;
      const keys = Object.keys(state.sessionTokens);
      if (keys.length > MAX_SESSION_TOKEN_CACHE) {
        keys
          .sort((a, b) => (state.sessionTokens[b]?.updatedAt || 0) - (state.sessionTokens[a]?.updatedAt || 0))
          .slice(MAX_SESSION_TOKEN_CACHE)
          .forEach((k) => {
            delete state.sessionTokens[k];
          });
      }
    }

    const total = Math.round((entry.inputTokens || 0) + (entry.outputTokens || 0));
    return { netTokens: total > 0 ? total : null, dirty };
  } catch {
    return { netTokens: null, dirty: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function formatSessionTokensSegment(netTokens) {
  if (typeof netTokens !== 'number' || !Number.isFinite(netTokens) || netTokens <= 0) {
    return null;
  }
  return `${ANSI.dim}Tok:${ANSI.reset} ${ANSI.cyan}${formatCompactTokens(netTokens)}${ANSI.reset}`;
}

function syncLiveState(payload, existing, liveQuota, sessionTok, ctxUsedTokens, modelName, activityInput, persist = true) {
  const now = Date.now();
  const state =
    existing && typeof existing === 'object'
      ? existing
      : {
          version: 1,
          updatedAt: now,
          lastRefreshAt: 0,
          quota: {
            remaining5h: 100,
            remainingWeek: 100,
            reset5hSec: null,
            resetWeekSec: null,
            reset5hTime: null,
            resetWeekTime: null,
            source: 'estimated',
            isEstimated: true,
            oauthDetected: false,
          },
          usage: {
            tokens5h: 0,
            tokensWeek: 0,
            budget5h: 5_000_000,
            budgetWeek: 40_000_000,
          },
          conversations: {},
          ledger: [],
        };

  if (!state.quota) state.quota = {};
  if (!state.usage) state.usage = { tokens5h: 0, tokensWeek: 0 };
  if (!state.conversations) state.conversations = {};
  if (!Array.isArray(state.ledger)) state.ledger = [];

  let dirty = !existing && Boolean(payload.session_id || payload.conversation_id);

  // 0. Live working state, elapsed timer & output tokens/sec tracker
  if (activityInput) {
    const actRes = syncActivityState(
      state,
      payload,
      now,
      activityInput.windowId,
      activityInput.isWorking,
      activityInput.outTok,
      activityInput.nativeTps,
      activityInput.transcriptAction
    );
    if (actRes.dirty) dirty = true;
  }

  // 0b. Accurate incremental net token count for the current session (from transcript.jsonl)
  const sessionNetRes = syncSessionNetTokens(state, payload, now);
  if (sessionNetRes.dirty) dirty = true;

  // 1. Live cross-session token ledger sync (no hook dependency required)
  const sessionId = payload.conversation_id || payload.session_id || payload.conversationId || '';
  if (sessionId && sessionTok > 0) {
    const prevMeta = state.conversations[sessionId] || {};
    const prevTotal = Number(prevMeta.lastSessionTokens ?? prevMeta.lastContextTokens ?? 0);
    const delta = sessionTok > prevTotal ? sessionTok - prevTotal : 0;

    if (delta > 0) {
      const lastEntry = state.ledger[state.ledger.length - 1];
      if (
        lastEntry &&
        lastEntry.conversationId === sessionId &&
        now - lastEntry.ts < 60_000
      ) {
        lastEntry.tokens += delta;
        lastEntry.ts = now;
      } else {
        state.ledger.push({
          ts: now,
          tokens: delta,
          model: modelName || 'unknown',
          conversationId: sessionId,
          source: 'statusline-live',
        });
      }
      state.conversations[sessionId] = {
        ...prevMeta,
        lastSessionTokens: sessionTok,
        lastContextTokens: ctxUsedTokens,
        model: modelName || prevMeta.model || 'unknown',
        updatedAt: now,
      };
      dirty = true;
    }
  }

  // 2. Keep cached quota synced with live stdin telemetry
  if (liveQuota.rem5h !== null) {
    const rounded5h = Math.round(liveQuota.rem5h * 10) / 10;
    if (state.quota.isEstimated || Math.abs((state.quota.remaining5h ?? -1) - rounded5h) >= 0.5) {
      state.quota.remaining5h = rounded5h;
      state.quota.isEstimated = false;
      state.quota.source = 'agy-stdin';
      dirty = true;
    }
    if (syncCachedResetTime(state.quota, 'reset5hTime', liveQuota.reset5hTime, liveQuota.reset5hSec, FIVE_HOURS_MS, now)) {
      dirty = true;
    }
    if (liveQuota.reset5hSec !== null) state.quota.reset5hSec = liveQuota.reset5hSec;
  }
  if (liveQuota.remWk !== null) {
    const roundedWk = Math.round(liveQuota.remWk * 10) / 10;
    if (state.quota.isEstimated || Math.abs((state.quota.remainingWeek ?? -1) - roundedWk) >= 0.5) {
      state.quota.remainingWeek = roundedWk;
      state.quota.isEstimated = false;
      state.quota.source = 'agy-stdin';
      dirty = true;
    }
    if (syncCachedResetTime(state.quota, 'resetWeekTime', liveQuota.resetWkTime, liveQuota.resetWkSec, SEVEN_DAYS_MS, now)) {
      dirty = true;
    }
    if (liveQuota.resetWkSec !== null) state.quota.resetWkSec = liveQuota.resetWkSec;
  }

  // Always recompute 5h & weekly sums aligned to their active cloud quota cycles
  const cutoff7d = now - SEVEN_DAYS_MS;
  const cutoff5h = resolveWindow5hStartMs(liveQuota, state, now);
  const weekStart = resolveWindowWeekStartMs(liveQuota, state, now);

  const prevLen = state.ledger.length;
  state.ledger = state.ledger.filter(
    (e) => e && typeof e.ts === 'number' && e.ts >= cutoff7d && e.tokens > 0
  );
  if (state.ledger.length !== prevLen) dirty = true;

  if (state.ledger.length > 0 || prevLen > 0) {
    let t5h = 0;
    let tWk = 0;
    for (const e of state.ledger) {
      if (e.ts >= cutoff5h) t5h += e.tokens;
      if (e.ts >= weekStart) tWk += e.tokens;
    }
    const next5h = Math.round(t5h);
    const nextWk = Math.round(tWk);
    if (state.usage.tokens5h !== next5h || state.usage.tokensWeek !== nextWk) {
      state.usage.tokens5h = next5h;
      state.usage.tokensWeek = nextWk;
      dirty = true;
    }
  }

  if (dirty && persist) {
    state.updatedAt = now;
    atomicWriteState(state);
  }

  return { state, sessionNetTokens: sessionNetRes.netTokens };
}

// ---------------------------------------------------------------------------
// Fast Git branch & uncommitted status (--no-optional-locks + .git/HEAD fallback)
// ---------------------------------------------------------------------------

function resolveWorkspaceDir(payload) {
  const candidates = [
    payload.workspace?.current_dir,
    payload.workspace?.currentDir,
    payload.workspace?.project_dir,
    payload.cwd,
    Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : null,
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (typeof dir === 'string' && dir.trim()) return dir;
  }
  return process.cwd();
}

function readBranchFromGitHead(startDir) {
  try {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 20; i++) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        const stat = fs.statSync(dotGit);
        if (stat.isFile()) {
          const ptr = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/im);
          if (ptr) gitDir = path.resolve(dir, ptr[1].trim());
        }
        const headPath = path.join(gitDir, 'HEAD');
        const head = fs.readFileSync(headPath, 'utf8').trim();
        const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        if (refMatch) return refMatch[1].trim();
        if (/^[0-9a-f]{7,40}$/i.test(head)) return `HEAD@${head.slice(0, 7)}`;
        return 'HEAD';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return null;
}

function getGitInfo(payload) {
  if (payload._mockGit !== undefined) return payload._mockGit;
  const cwd = resolveWorkspaceDir(payload);

  try {
    const out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-b'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    const header = lines[0];
    let branch = '';
    let ahead = 0;
    let behind = 0;

    if (header.startsWith('## ')) {
      const rest = header.slice(3).trim();
      const unbornMatch =
        rest.match(/^No commits yet on (.+)$/i) || rest.match(/^Initial commit on (.+)$/i);
      if (unbornMatch) {
        branch = unbornMatch[1].trim();
      } else if (rest.startsWith('HEAD (no branch)')) {
        branch = readBranchFromGitHead(cwd) || 'HEAD';
      } else {
        branch = rest.split('...')[0].split(' ')[0].trim();
      }

      const aheadMatch = rest.match(/\bahead (\d+)\b/);
      const behindMatch = rest.match(/\bbehind (\d+)\b/);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
    }

    if (!branch) return null;

    let staged = 0;
    let modified = 0;
    let untracked = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') {
        untracked++;
      } else {
        if (x && x !== ' ' && x !== '!') staged++;
        if (y && y !== ' ' && y !== '!') modified++;
      }
    }

    const totalChanges = staged + modified + untracked;
    return {
      branch,
      dirty: totalChanges > 0,
      staged,
      modified,
      untracked,
      ahead,
      behind,
      timedOut: false,
    };
  } catch {
    const vcsBranch = payload.vcs?.branch;
    if (typeof vcsBranch === 'string' && vcsBranch.trim()) {
      return {
        branch: vcsBranch.trim(),
        dirty: Boolean(payload.vcs?.dirty),
        staged: 0,
        modified: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
        timedOut: false,
      };
    }
    const headBranch = readBranchFromGitHead(cwd);
    if (headBranch) {
      return {
        branch: headBranch,
        dirty: false,
        staged: 0,
        modified: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
        timedOut: true,
      };
    }
    return null;
  }
}

function formatGitSegment(git) {
  const branchColor = git.dirty ? ANSI.yellow : ANSI.green;
  let seg = `${ANSI.dim}git:${ANSI.reset}${branchColor}${git.branch}${ANSI.reset}`;

  const syncParts = [];
  if (git.ahead > 0) syncParts.push(`${ANSI.cyan}↑${git.ahead}${ANSI.reset}`);
  if (git.behind > 0) syncParts.push(`${ANSI.magenta}↓${git.behind}${ANSI.reset}`);
  if (syncParts.length > 0) seg += ` ${syncParts.join('')}`;

  if (git.timedOut) {
    seg += `${ANSI.dim}…${ANSI.reset}`;
  } else if (git.dirty) {
    seg += `${ANSI.yellow}*${ANSI.reset}`;
    const details = [];
    if (git.staged > 0) details.push(`${ANSI.green}+${git.staged}${ANSI.reset}`);
    if (git.modified > 0) details.push(`${ANSI.yellow}~${git.modified}${ANSI.reset}`);
    if (git.untracked > 0) details.push(`${ANSI.dim}?${git.untracked}${ANSI.reset}`);
    if (details.length > 0) {
      seg += ` ${ANSI.dim}(${ANSI.reset}${details.join(' ')}${ANSI.dim})${ANSI.reset}`;
    }
  } else {
    seg += `${ANSI.green}✓${ANSI.reset}`;
  }

  return seg;
}

// ---------------------------------------------------------------------------
// Runtime telemetry helpers (Cache hit rate, Mode, Sandbox, Pace, Width)
// ---------------------------------------------------------------------------

function extractCacheHitPct(payload) {
  const cu =
    payload.context_window?.current_usage ||
    payload.contextWindow?.currentUsage ||
    payload.current_usage ||
    null;
  if (!cu || typeof cu !== 'object') return null;

  const cacheRead = Number(cu.cache_read_input_tokens ?? cu.cacheReadInputTokens ?? 0);
  const directIn = Number(cu.input_tokens ?? cu.inputTokens ?? 0);
  const cacheCreate = Number(cu.cache_creation_input_tokens ?? cu.cacheCreationInputTokens ?? 0);
  const totalIn = cacheRead + directIn + cacheCreate;
  if (!Number.isFinite(totalIn) || totalIn <= 0) return null;
  return Math.max(0, Math.min(100, (cacheRead / totalIn) * 100));
}

function isBurning5hFast(rem5h, reset5hSec) {
  if (typeof rem5h !== 'number' || typeof reset5hSec !== 'number') return false;
  if (rem5h >= 70) return false;
  const windowSec = 5 * 3600;
  const elapsedFrac = Math.max(0, Math.min(1, (windowSec - reset5hSec) / windowSec));
  if (elapsedFrac < 0.08) return false;
  const usedFrac = (100 - rem5h) / 100;
  return usedFrac > elapsedFrac * 1.25;
}

function extractProjectName(payload) {
  const dir = resolveWorkspaceDir(payload);
  if (!dir || dir === '/' || dir === '/tmp') return '';
  return path.basename(dir);
}

function formatModeSegment(payload) {
  const raw =
    payload.cycle_mode ||
    payload.cycleMode ||
    payload.mode ||
    payload.execution_mode ||
    '';
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const mode = raw.trim();
  const lm = mode.toLowerCase();
  let color = ANSI.green;
  if (lm.includes('plan')) color = ANSI.cyan;
  else if (lm.includes('accept')) color = ANSI.yellow;
  return `${ANSI.dim}Mode:${ANSI.reset} ${color}${mode}${ANSI.reset}`;
}

function formatSandboxSegment(payload) {
  if (!payload.sandbox || typeof payload.sandbox !== 'object') return null;
  if (typeof payload.sandbox.enabled !== 'boolean') return null;
  const on = payload.sandbox.enabled;
  const label = on ? `${ANSI.green}ON${ANSI.reset}` : `${ANSI.yellow}OFF${ANSI.reset}`;
  return `${ANSI.dim}Sandbox:${ANSI.reset} ${label}`;
}

function formatCacheSegment(payload) {
  const pct = extractCacheHitPct(payload);
  if (pct === null) return null;
  let color = ANSI.green;
  if (pct < 40) color = ANSI.red;
  else if (pct < 70) color = ANSI.yellow;
  return `${ANSI.dim}Cache:${ANSI.reset} ${color}${Math.round(pct)}%${ANSI.reset}`;
}

function formatWorkspaceGitSegment(payload, git) {
  const project = extractProjectName(payload);
  if (project && git) {
    return `${ANSI.bold}${project}${ANSI.reset} ${ANSI.dim}(${ANSI.reset}${formatGitSegment(git)}${ANSI.dim})${ANSI.reset}`;
  }
  if (git) return formatGitSegment(git);
  if (project && SHOW_NON_GIT) {
    return `${ANSI.bold}${project}${ANSI.reset} ${ANSI.dim}(git:-)${ANSI.reset}`;
  }
  if (project) return `${ANSI.bold}${project}${ANSI.reset}`;
  return null;
}

function visibleWidth(str) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) || 0;
    w += code >= 0x2e80 && code <= 0x9fff ? 2 : 1;
  }
  return w;
}

function resolveTerminalWidth(payload) {
  const w = Number(payload.terminal_width ?? payload.terminalWidth ?? process.stdout.columns ?? 0);
  return Number.isFinite(w) && w >= 40 ? w : 180;
}

// ---------------------------------------------------------------------------
// Account & subscription plan extraction (Line 2)
// ---------------------------------------------------------------------------

function extractAccountInfo(payload) {
  const userCandidates = [
    payload.email,
    payload.user?.email,
    payload.user?.name,
    payload.user?.username,
    payload.account?.email,
    payload.account?.name,
    payload.account?.username,
    payload.username,
    payload.user_email,
    payload.userEmail,
  ];
  let user = '';
  for (const c of userCandidates) {
    if (typeof c === 'string' && c.trim()) {
      user = c.trim();
      break;
    }
  }

  const planCandidates = [
    payload.plan_tier,
    payload.planTier,
    payload.subscription?.tier,
    payload.subscription?.name,
    payload.plan?.name,
    typeof payload.plan === 'string' ? payload.plan : null,
    payload.tier,
  ];
  let plan = '';
  for (const c of planCandidates) {
    if (typeof c === 'string' && c.trim()) {
      plan = c.trim();
      break;
    }
  }

  return { user, plan };
}

function colorByPlan(plan) {
  const lp = plan.toLowerCase();
  if (lp.includes('ultra') || lp.includes('max') || lp.includes('enterprise')) return ANSI.yellow;
  if (lp.includes('pro') || lp.includes('plus') || lp.includes('team')) return ANSI.cyan;
  if (lp.includes('free') || lp.includes('basic')) return ANSI.gray;
  return ANSI.green;
}

function buildLine2(payload, modelBadge, activityItem, sep, maxWidth) {
  const account = extractAccountInfo(payload);

  const items = [];
  if (modelBadge) items.push({ priority: 6, text: modelBadge });

  if (account.user) {
    items.push({
      priority: 1,
      text: `${ANSI.dim}User:${ANSI.reset} ${ANSI.bold}${account.user}${ANSI.reset}`,
    });
  }

  if (account.plan) {
    const planColor = colorByPlan(account.plan);
    items.push({
      priority: 4,
      text: `${ANSI.dim}Plan:${ANSI.reset} ${ANSI.bold}${planColor}${account.plan}${ANSI.reset}`,
    });
  }
  const modeSeg = formatModeSegment(payload);
  if (modeSeg) items.push({ priority: 5, text: modeSeg });

  const sandboxSeg = formatSandboxSegment(payload);
  if (sandboxSeg) items.push({ priority: 2, text: sandboxSeg });

  if (activityItem) items.push(activityItem);

  if (items.length === 0) return null;

  const active = [...items];
  while (active.length > 1 && visibleWidth(active.map((i) => i.text).join(sep)) > maxWidth) {
    let minIdx = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i].priority < active[minIdx].priority) minIdx = i;
    }
    active.splice(minIdx, 1);
  }

  return active.map((i) => i.text).join(sep);
}

// ---------------------------------------------------------------------------
// Core render function (shared by stdin runtime & --test preview)
// ---------------------------------------------------------------------------

function renderDashboard(payload, existingState, { persist = true } = {}) {
  const maxWidth = resolveTerminalWidth(payload);
  const sep = ` ${ANSI.dim}│${ANSI.reset} `;

  const modelInfo = extractModelInfo(payload);
  const modelBadge = modelInfo.effort
    ? `${ANSI.bold}${ANSI.cyan}[${modelInfo.name}${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.bold}${modelInfo.effort.color}${modelInfo.effort.label}${ANSI.reset}${ANSI.bold}${ANSI.cyan}]${ANSI.reset}`
    : `${ANSI.bold}${ANSI.cyan}[${modelInfo.name}]${ANSI.reset}`;

  const git = getGitInfo(payload);
  const wsGitSeg = formatWorkspaceGitSegment(payload, git);

  const ctx = extractContextWindow(payload);
  const ctxColor = colorByUsage(ctx.usedPct);
  const ctxDots = renderDots(ctx.usedPct, ctxColor);
  const ctxDetail = `${formatCompactTokens(ctx.usedTokens)}/${formatWindowSize(ctx.maxTokens)}`;

  const segCtx =
    `${ANSI.dim}Ctx:${ANSI.reset} ${ctxDots} ${ctxColor}${formatPct(ctx.usedPct, 1)}${ANSI.reset} ` +
    `${ANSI.dim}(${ctxDetail})${ANSI.reset}`;

  const liveQuota = extractLiveQuotaFromStdin(payload);
  const sessionTok = extractSessionTotalTokens(payload);
  const windowId = resolveWindowId();
  const isWorking = extractAgentWorking(payload);
  const outTok = extractSessionOutputTokens(payload);
  const nativeTps = extractNativeTokensPerSec(payload);
  const transcriptAction = isWorking ? readLatestTranscriptAction(payload) : null;
  const { state, sessionNetTokens } = syncLiveState(
    payload,
    existingState,
    liveQuota,
    sessionTok,
    ctx.usedTokens,
    modelInfo.name,
    {
      windowId,
      isWorking,
      outTok,
      nativeTps,
      transcriptAction,
    },
    persist
  );
  const stateEstimated = state ? Boolean(state.quota?.isEstimated) : true;

  const rem5h = liveQuota.rem5h ?? state?.quota?.remaining5h ?? 100;
  const remWk = liveQuota.remWk ?? state?.quota?.remainingWeek ?? 100;
  const prefix5h = liveQuota.rem5h != null ? '' : stateEstimated ? '~' : '';
  const prefixWk = liveQuota.remWk != null ? '' : stateEstimated ? '~' : '';

  const color5h = colorByUsage(100 - rem5h);
  const colorWk = colorByUsage(100 - remWk);
  const dots5h = renderDots(rem5h, color5h);
  const dotsWk = renderDots(remWk, colorWk);

  const nowMs = Date.now();
  const cached5hMs = parseResetTimeMs(state?.quota?.reset5hTime);
  const cachedWkMs = parseResetTimeMs(state?.quota?.resetWeekTime);
  const cached5hTime = cached5hMs !== null && cached5hMs > nowMs ? state.quota.reset5hTime : null;
  const cachedWkTime = cachedWkMs !== null && cachedWkMs > nowMs ? state.quota.resetWeekTime : null;

  const reset5hTime = liveQuota.reset5hTime ?? cached5hTime;
  const reset5hSec = liveQuota.reset5hSec ?? (reset5hTime ? null : state?.quota?.reset5hSec ?? null);
  const reset5hLabel = formatResetCountdown(reset5hTime, reset5hSec);
  const fastPaceSec =
    liveQuota.reset5hSec ??
    (reset5hTime ? Math.max(0, Math.round((parseResetTimeMs(reset5hTime) - nowMs) / 1000)) : state?.quota?.reset5hSec ?? null);
  const fastPace = isBurning5hFast(rem5h, fastPaceSec);
  const paceTag = fastPace ? ` ${ANSI.yellow}⚡快${ANSI.reset}${ANSI.dim}` : '';

  const resetWkTime = liveQuota.resetWkTime ?? cachedWkTime;
  const resetWkSec = liveQuota.resetWkSec ?? (resetWkTime ? null : state?.quota?.resetWeekSec ?? null);
  const resetWkLabel = formatResetCountdown(resetWkTime, resetWkSec);

  const tokSeg = formatSessionTokensSegment(sessionNetTokens);
  const cacheSeg = formatCacheSegment(payload);

  const makeLine1 = ({ includeReset = true, includeCache = true, includeTok = true } = {}) => {
    const m5h = includeReset ? (reset5hLabel ? `${reset5hLabel}${paceTag}` : paceTag.trim()) : '';
    const mWk = includeReset ? (resetWkLabel || '') : '';
    const s5h =
      `${ANSI.dim}5h:${ANSI.reset} ${dots5h} ${color5h}${prefix5h}${formatPct(rem5h, 0)}${ANSI.reset}` +
      (m5h ? ` ${ANSI.dim}(${m5h})${ANSI.reset}` : '');
    const sWk =
      `${ANSI.dim}Wk:${ANSI.reset} ${dotsWk} ${colorWk}${prefixWk}${formatPct(remWk, 0)}${ANSI.reset}` +
      (mWk ? ` ${ANSI.dim}(${mWk})${ANSI.reset}` : '');
    const segs = [];
    if (wsGitSeg) segs.push(wsGitSeg);
    segs.push(segCtx);
    if (includeTok && tokSeg) segs.push(tokSeg);
    if (includeCache && cacheSeg) segs.push(cacheSeg);
    segs.push(s5h, sWk);
    return segs.join(sep);
  };

  let line1 = makeLine1({ includeReset: true, includeCache: true, includeTok: true });
  if (visibleWidth(line1) > maxWidth && cacheSeg) {
    line1 = makeLine1({ includeReset: true, includeCache: false, includeTok: true });
  }
  if (visibleWidth(line1) > maxWidth && tokSeg) {
    line1 = makeLine1({ includeReset: true, includeCache: false, includeTok: false });
  }
  if (visibleWidth(line1) > maxWidth) {
    line1 = makeLine1({ includeReset: false, includeCache: false, includeTok: false });
  }

  const lines = [line1];
  const windowActivity = state?.windowActivity?.[windowId] ?? state?.activity;
  const activityItem = formatActivitySegment(windowActivity, isWorking, nativeTps, transcriptAction, nowMs);
  const line2 = buildLine2(payload, modelBadge, activityItem, sep, maxWidth);
  if (line2) lines.push(line2);

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Built-in CLI Commands: --test, --doctor, --version, --help
// ---------------------------------------------------------------------------

function readPluginVersion() {
  const manifest = safeReadJson(path.join(PLUGIN_DIR, 'plugin.json'));
  return manifest?.version || '1.0.0';
}

function runTestPreview() {
  const now = Date.now();
  const winId = resolveWindowId();
  const version = readPluginVersion();
  const hr = `${ANSI.dim}${'─'.repeat(72)}${ANSI.reset}`;

  process.stdout.write(
    `\n${ANSI.bold}${ANSI.cyan}AGY Hub Pro v${version} — StatusLine Live Preview (--test)${ANSI.reset}\n` +
      `${ANSI.dim}Dot style: ${ACTIVE_DOT_STYLE_NAME} │ ANSI color: ${USE_COLOR ? 'ON' : 'OFF (NO_COLOR)'} │ Zero disk writes${ANSI.reset}\n${hr}\n`
  );

  const scenarios = [
    {
      title: '1. Healthy (≤80% · Green · Clean Git · Session Tok · Live Working)',
      payload: {
        session_id: 'demo-healthy',
        terminal_width: 170,
        model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', effort: 'high' },
        context_window: {
          context_window_size: 1_000_000,
          used_tokens: 174_000,
          used_percentage: 17.4,
          current_usage: { input_tokens: 1_800, cache_read_input_tokens: 172_200 },
        },
        quota: {
          'gemini-5h': { remaining_fraction: 0.79, reset_in_seconds: 11_880 },
          'gemini-weekly': { remaining_fraction: 0.73, reset_in_seconds: 457_200 },
        },
        agent_state: 'working',
        workspace: { current_dir: '/workspace/agy-hub-pro' },
        _mockGit: { branch: 'main', dirty: false, staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0, timedOut: false },
        _mockSessionNetTokens: 1_400_000,
        _mockTranscriptAction: { label: 'run_command', stepKey: '12:run_command' },
        email: 'dev@example.com',
        plan_tier: 'Google AI Pro',
        cycle_mode: 'auto',
        sandbox: { enabled: false },
      },
      state: {
        version: 1,
        quota: { remaining5h: 79, remainingWeek: 73, isEstimated: false, source: 'agy-stdin' },
        usage: { tokens5h: 284_000, tokensWeek: 1_420_000 },
        windowActivity: {
          [winId]: {
            windowId: winId,
            sessionId: 'demo-healthy',
            isWorking: true,
            workStartAt: now - 18_000,
            lastProgressAt: now - 2_000,
            lastOutTokens: 4200,
            lastOutAt: now - 2_000,
            lastTps: 56,
            lastTpsAt: now - 2_000,
            lastStepKey: '12:run_command',
            updatedAt: now,
          },
        },
        conversations: {},
        ledger: [],
      },
    },
    {
      title: '2. Warning (>80% · Yellow · Dirty Git + Sync · Fast Burn ⚡快)',
      payload: {
        session_id: 'demo-warn',
        terminal_width: 170,
        model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', effort: 'xhigh' },
        context_window: {
          context_window_size: 1_000_000,
          used_tokens: 842_000,
          used_percentage: 84.2,
          current_usage: { input_tokens: 353_600, cache_read_input_tokens: 488_400 },
        },
        quota: {
          'gemini-5h': { remaining_fraction: 0.18, reset_in_seconds: 12_600 },
          'gemini-weekly': { remaining_fraction: 0.16, reset_in_seconds: 172_800 },
        },
        agent_state: 'idle',
        tokens_per_second: 84,
        workspace: { current_dir: '/workspace/agy-hub-pro' },
        _mockGit: { branch: 'feat/hud-v2', dirty: true, staged: 2, modified: 3, untracked: 1, ahead: 2, behind: 0, timedOut: false },
        _mockSessionNetTokens: 312_000,
        email: 'dev@example.com',
        plan_tier: 'Google AI Ultra',
        cycle_mode: 'accept-edits',
        sandbox: { enabled: true },
      },
      state: {
        version: 1,
        quota: { remaining5h: 18, remainingWeek: 16, isEstimated: false, source: 'agy-stdin' },
        usage: { tokens5h: 4_120_000, tokensWeek: 33_600_000 },
        conversations: {},
        ledger: [],
      },
    },
    {
      title: '3. Critical (>90% · Red · Local Estimate ~ · Narrow Width=92)',
      payload: {
        session_id: 'demo-crit',
        terminal_width: 92,
        model: { id: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen', effort: 'low' },
        context_window: {
          context_window_size: 1_000_000,
          used_tokens: 935_000,
          used_percentage: 93.5,
          current_usage: { input_tokens: 701_250, cache_read_input_tokens: 233_750 },
        },
        workspace: { current_dir: '/tmp' },
        _mockGit: null,
        _mockSessionNetTokens: 980_000,
        email: 'dev@example.com',
        plan_tier: 'Google AI Pro',
        cycle_mode: 'plan',
        sandbox: { enabled: true },
      },
      state: {
        version: 1,
        quota: { remaining5h: 7, remainingWeek: 6, isEstimated: true, source: 'estimated' },
        usage: { tokens5h: 4_650_000, tokensWeek: 37_600_000 },
        conversations: {},
        ledger: [],
      },
    },
  ];

  const t0 = performance.now();
  for (const sc of scenarios) {
    const out = renderDashboard(sc.payload, sc.state, { persist: false });
    process.stdout.write(`\n${ANSI.bold}${sc.title}${ANSI.reset}\n`);
    for (const line of out.trimEnd().split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
  }
  const elapsedMs = (performance.now() - t0).toFixed(1);

  process.stdout.write(
    `\n${hr}\n${ANSI.green}✓${ANSI.reset} Rendered ${scenarios.length} preview scenarios in ${ANSI.bold}${elapsedMs}ms${ANSI.reset} (exit 0).\n\n`
  );
}

function inspectPathSafe(filePath) {
  try {
    const lstat = fs.lstatSync(filePath);
    const isSymlink = lstat.isSymbolicLink();
    let realPath = filePath;
    let brokenSymlink = false;
    if (isSymlink) {
      try {
        realPath = fs.realpathSync(filePath);
      } catch {
        brokenSymlink = true;
      }
    }
    return { exists: true, accessible: true, isSymlink, realPath, brokenSymlink, errorCode: null };
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      return { exists: false, accessible: false, isSymlink: false, realPath: filePath, brokenSymlink: false, errorCode: err.code };
    }
    return { exists: false, accessible: true, isSymlink: false, realPath: filePath, brokenSymlink: false, errorCode: err?.code || 'ENOENT' };
  }
}

function runDoctor(asJson = false) {
  const version = readPluginVersion();
  const checks = [];
  const addCheck = (id, name, status, detail, fix = null) => {
    checks.push({ id, name, status, detail, fix });
  };

  // 1. Node.js Runtime Version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 18) {
    addCheck('node', 'Node.js Runtime', 'pass', `${process.version} (${process.execPath})`);
  } else {
    addCheck(
      'node',
      'Node.js Runtime',
      'fail',
      `${process.version} is below minimum required v18.0.0`,
      'Upgrade Node.js to v18+ (recommended: v20/v22 LTS).'
    );
  }

  // 2. Self-Contained Plugin Integrity & Permissions
  const requiredFiles = ['plugin.json', 'hooks.json', 'statusline.mjs', 'collector.mjs'];
  const missingFiles = requiredFiles.filter((f) => !fs.existsSync(path.join(PLUGIN_DIR, f)));
  const nonExecScripts = ['statusline.mjs', 'collector.mjs'].filter((f) => {
    try {
      fs.accessSync(path.join(PLUGIN_DIR, f), fs.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  let manifestError = null;
  for (const jf of ['plugin.json', 'hooks.json']) {
    try {
      JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, jf), 'utf8'));
    } catch (e) {
      manifestError = `${jf}: ${e.message}`;
    }
  }
  const hasNodeModules = fs.existsSync(path.join(PLUGIN_DIR, 'node_modules'));

  if (missingFiles.length > 0 || manifestError) {
    addCheck(
      'plugin_files',
      'Plugin Integrity',
      'fail',
      missingFiles.length > 0
        ? `Missing files in ${PLUGIN_DIR}: ${missingFiles.join(', ')}`
        : `Invalid JSON in ${manifestError}`,
      'Re-clone or reinstall agy-hub-pro from GitHub.'
    );
  } else if (nonExecScripts.length > 0) {
    addCheck(
      'plugin_files',
      'Plugin Integrity',
      'warn',
      `Scripts missing +x bit: ${nonExecScripts.join(', ')} (root: ${PLUGIN_DIR})`,
      `Run: chmod +x "${path.join(PLUGIN_DIR, 'statusline.mjs')}" "${path.join(PLUGIN_DIR, 'collector.mjs')}"`
    );
  } else {
    addCheck(
      'plugin_files',
      'Plugin Integrity',
      'pass',
      `Self-contained zero-dependency ESM in ${PLUGIN_DIR}${hasNodeModules ? ' (note: unused node_modules/ present)' : ''}`
    );
  }

  // 3. Git Availability
  try {
    const t0 = performance.now();
    const gitVer = execFileSync('git', ['--version'], {
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ms = Math.round(performance.now() - t0);
    addCheck('git', 'Git Command', 'pass', `${gitVer} (${ms}ms)`);
  } catch {
    addCheck(
      'git',
      'Git Command',
      'warn',
      'git binary not found in PATH (StatusLine will fall back to reading .git/HEAD directly)',
      'Install Git (e.g. xcode-select --install on macOS or apt install git on Linux).'
    );
  }

  // 4. Antigravity CLI (agy)
  try {
    const agyVer = execFileSync('agy', ['--version'], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split(/\r?\n/)[0];
    addCheck('agy_cli', 'Antigravity CLI (agy)', 'pass', agyVer || 'Detected in PATH');
  } catch {
    addCheck(
      'agy_cli',
      'Antigravity CLI (agy)',
      'warn',
      'agy command not found in PATH',
      'Install Antigravity CLI or ensure it is on your PATH before running agy plugin install.'
    );
  }

  // 5. Active Settings File Detection & StatusLine Mount Check
  const home = os.homedir();
  const explicitSettings = process.env.AGY_HUB_SETTINGS_FILE || '';
  const settingsCandidates = explicitSettings
    ? [explicitSettings]
    : [
        path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
        path.join(home, '.gemini', 'settings.json'),
      ];

  const inspected = settingsCandidates.map((p) => ({ path: p, ...inspectPathSafe(p) }));
  const existingSettings = inspected.filter((i) => i.exists);
  const blockedSettings = inspected.filter((i) => !i.accessible);

  if (existingSettings.length === 0) {
    if (blockedSettings.length > 0) {
      addCheck(
        'settings_mount',
        'Settings & StatusLine Mount',
        'warn',
        `Cannot inspect ${blockedSettings.map((b) => b.path).join(', ')} (${blockedSettings[0].errorCode}: restricted environment)`,
        'Run `node statusline.mjs --doctor` outside a restricted sandbox to verify ~/.gemini/antigravity-cli/settings.json.'
      );
    } else {
      addCheck(
        'settings_mount',
        'Settings & StatusLine Mount',
        'fail',
        `No settings.json found at ${settingsCandidates.join(' or ')}`,
        `Run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` to safely create and configure settings.json.`
      );
    }
  } else {
    const primary = existingSettings[0];
    const multiDistinct =
      existingSettings.length > 1 &&
      existingSettings[0].realPath !== existingSettings[1].realPath;

    if (primary.brokenSymlink) {
      addCheck(
        'settings_mount',
        'Settings & StatusLine Mount',
        'fail',
        `Broken symlink detected at ${primary.path}`,
        `Fix or remove the broken symlink at ${primary.path}, then re-run ./install.sh --install.`
      );
    } else {
      try {
        const cfg = JSON.parse(fs.readFileSync(primary.realPath, 'utf8'));
        const sl = cfg?.statusLine;
        const linkNote = primary.isSymlink ? ` -> ${primary.realPath}` : '';
        const multiNote = multiDistinct
          ? ` (also found ${existingSettings[1].path}; primary is active for agy CLI)`
          : '';

        if (!sl || typeof sl !== 'object' || !sl.command) {
          addCheck(
            'settings_mount',
            'Settings & StatusLine Mount',
            'fail',
            `statusLine is not configured in ${primary.path}${linkNote}${multiNote}`,
            `Run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` or inside agy run: /statusline node ${__filename}`
          );
        } else if (sl.enabled === false) {
          addCheck(
            'settings_mount',
            'Settings & StatusLine Mount',
            'warn',
            `statusLine is configured in ${primary.path}${linkNote} but "enabled": false`,
            'Set "statusLine.enabled": true or run `/statusline enable` inside agy.'
          );
        } else {
          const cmd = String(sl.command);
          const scriptMatch = cmd.match(/([^\s"']*statusline\.mjs)/);
          const mountedScript = scriptMatch
            ? scriptMatch[1].replace(/^~(?=\/)/, home)
            : null;
          if (!mountedScript) {
            addCheck(
              'settings_mount',
              'Settings & StatusLine Mount',
              'warn',
              `statusLine in ${primary.path}${linkNote} points to another command: ${cmd}`,
              `Run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` if you want to switch to agy-hub-pro.`
            );
          } else if (!fs.existsSync(mountedScript)) {
            addCheck(
              'settings_mount',
              'Settings & StatusLine Mount',
              'fail',
              `statusLine in ${primary.path}${linkNote} points to missing file: ${mountedScript}`,
              `Re-run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` to repair the path.`
            );
          } else {
            const realMounted = fs.realpathSync(mountedScript);
            const realSelf = fs.realpathSync(__filename);
            const sameTarget = realMounted === realSelf;
            addCheck(
              'settings_mount',
              'Settings & StatusLine Mount',
              sameTarget ? 'pass' : 'warn',
              sameTarget
                ? `Mounted in ${primary.path}${linkNote}${multiNote}`
                : `Mounted in ${primary.path}${linkNote} -> ${mountedScript} (differs from current checkout ${__filename})`,
              sameTarget
                ? null
                : `Run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` to point settings.json to this directory.`
            );
          }
        }
      } catch (err) {
        addCheck(
          'settings_mount',
          'Settings & StatusLine Mount',
          'fail',
          `Failed to parse ${primary.path}: ${err.message}`,
          `Fix the JSON syntax error in ${primary.realPath} before running ./install.sh --install.`
        );
      }
    }
  }

  // 6. Lifecycle Hooks Registration Check
  const globalHooksPath =
    process.env.AGY_HUB_HOOKS_FILE || path.join(home, '.gemini', 'config', 'hooks.json');
  const globalHooksInfo = inspectPathSafe(globalHooksPath);
  const installedPluginHooks = path.join(home, '.gemini', 'plugins', 'agy-hub-pro', 'hooks.json');
  const pluginHooksInfo = inspectPathSafe(installedPluginHooks);

  let hooksRegistered = false;
  let hooksDetail = '';
  if (globalHooksInfo.exists) {
    const gh = safeReadJson(globalHooksInfo.realPath);
    if (gh && (gh['agy-hub-pro'] || gh['agy-hud-pro'])) {
      hooksRegistered = true;
      const key = gh['agy-hub-pro'] ? 'agy-hub-pro' : 'agy-hud-pro';
      hooksDetail = `Registered under "${key}" in ${globalHooksPath}`;
      if (gh['agy-hub-pro'] && gh['agy-hud-pro']) {
        addCheck(
          'hooks',
          'Lifecycle Hooks',
          'warn',
          `Both "agy-hub-pro" and legacy "agy-hud-pro" exist in ${globalHooksPath} (duplicate hooks)`,
          `Run \`${path.join(PLUGIN_DIR, 'install.sh')} --install\` to clean up the legacy entry.`
        );
        hooksRegistered = null;
      }
    }
  }
  if (hooksRegistered === false && pluginHooksInfo.exists) {
    hooksRegistered = true;
    hooksDetail = `Native plugin hooks present at ${installedPluginHooks}`;
  }
  if (hooksRegistered === true) {
    addCheck('hooks', 'Lifecycle Hooks', 'pass', hooksDetail);
  } else if (hooksRegistered === false) {
    const blocked = !globalHooksInfo.accessible || !pluginHooksInfo.accessible;
    addCheck(
      'hooks',
      'Lifecycle Hooks',
      'warn',
      blocked
        ? 'Could not inspect global hooks directory (restricted sandbox)'
        : 'Not registered in ~/.gemini/config/hooks.json or ~/.gemini/plugins/agy-hub-pro/hooks.json',
      'Run `agy plugin install bangbangda/agy-hub-pro` or `./install.sh --install` to enable SessionStart/Stop/PreInvocation hooks.'
    );
  }

  // 7. Data & Cache Directory Read/Write Permissions + State/Lock Health
  const probeFile = path.join(DATA_DIR, `.doctor-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(probeFile, 'ok\n', 'utf8');
    const content = fs.readFileSync(probeFile, 'utf8').trim();
    fs.unlinkSync(probeFile);
    if (content !== 'ok') throw new Error('Readback mismatch');

    const extra = RESOLVED_DATA.isFallback
      ? ` (fallback tmpdir; ${DEFAULT_DATA_DIR} not writable)`
      : '';
    if (fs.existsSync(STATE_FILE)) {
      const st = safeReadJson(STATE_FILE);
      if (!st) {
        addCheck(
          'data_dir',
          'Data & Cache Directory',
          'warn',
          `Writable (${DATA_DIR}), but ${STATE_FILE} contains invalid JSON`,
          `Remove corrupted cache: rm -f "${STATE_FILE}"`
        );
      } else {
        const entries = Array.isArray(st.ledger) ? st.ledger.length : 0;
        addCheck(
          'data_dir',
          'Data & Cache Directory',
          RESOLVED_DATA.isFallback ? 'warn' : 'pass',
          `Read/Write OK: ${DATA_DIR}${extra} (state.json: ${entries} ledger entries)`,
          RESOLVED_DATA.isFallback
            ? `Ensure ${DEFAULT_DATA_DIR} is writable so state persists across reboots.`
            : null
        );
      }
    } else {
      addCheck(
        'data_dir',
        'Data & Cache Directory',
        RESOLVED_DATA.isFallback ? 'warn' : 'pass',
        `Read/Write OK: ${DATA_DIR}${extra} (state.json will initialize on first run)`,
        RESOLVED_DATA.isFallback
          ? `Ensure ${DEFAULT_DATA_DIR} is writable so state persists across reboots.`
          : null
      );
    }
  } catch (err) {
    addCheck(
      'data_dir',
      'Data & Cache Directory',
      'fail',
      `Cannot write to ${DATA_DIR}: ${err.message}`,
      `Fix permissions: mkdir -p "${DEFAULT_DATA_DIR}" && chmod 755 "${DEFAULT_DATA_DIR}"`
    );
  }

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const ageSec = Math.round((Date.now() - fs.statSync(LOCK_FILE).mtimeMs) / 1000);
      if (ageSec > 60) {
        addCheck(
          'lock_file',
          'Collector Lock',
          'warn',
          `Stale lock file detected (${LOCK_FILE}, age ${ageSec}s)`,
          `Remove stale lock: rm -f "${LOCK_FILE}"`
        );
      }
    } catch {
      // ignore
    }
  }

  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version,
          pluginDir: PLUGIN_DIR,
          dataDir: DATA_DIR,
          ok: fails.length === 0,
          passed: checks.filter((c) => c.status === 'pass').length,
          warnings: warns.length,
          failures: fails.length,
          checks,
        },
        null,
        2
      )}\n`
    );
    process.exit(fails.length > 0 ? 1 : 0);
  }

  const hr = `${ANSI.dim}${'─'.repeat(72)}${ANSI.reset}`;
  process.stdout.write(
    `\n${ANSI.bold}${ANSI.cyan}AGY Hub Pro v${version} — Diagnostics (--doctor)${ANSI.reset}\n${hr}\n`
  );

  for (const c of checks) {
    let badge;
    if (c.status === 'pass') badge = `${ANSI.green}✓ PASS${ANSI.reset}`;
    else if (c.status === 'warn') badge = `${ANSI.yellow}⚠ WARN${ANSI.reset}`;
    else badge = `${ANSI.red}✗ FAIL${ANSI.reset}`;
    process.stdout.write(`  ${badge}  ${ANSI.bold}${c.name}${ANSI.reset}: ${c.detail}\n`);
    if (c.fix) {
      process.stdout.write(`          ${ANSI.dim}↳ Fix: ${c.fix}${ANSI.reset}\n`);
    }
  }

  process.stdout.write(`${hr}\n`);
  if (fails.length === 0 && warns.length === 0) {
    process.stdout.write(`${ANSI.green}${ANSI.bold}All checks passed! AGY Hub Pro is ready.${ANSI.reset}\n\n`);
  } else if (fails.length === 0) {
    process.stdout.write(
      `${ANSI.yellow}${ANSI.bold}Checks completed with ${warns.length} warning(s) and 0 failure(s).${ANSI.reset}\n\n`
    );
  } else {
    process.stdout.write(
      `${ANSI.red}${ANSI.bold}${fails.length} check(s) failed, ${warns.length} warning(s). Follow the Fix hints above.${ANSI.reset}\n\n`
    );
  }

  process.exit(fails.length > 0 ? 1 : 0);
}

function printHelp() {
  const version = readPluginVersion();
  process.stdout.write(
    `AGY Hub Pro v${version} — Zero-Dependency Antigravity CLI StatusLine\n\n` +
      `Usage:\n` +
      `  <json> | node statusline.mjs         Render live 2-line ANSI HUD from agy stdin\n` +
      `  node statusline.mjs --test           Preview ANSI HUD layout with simulated session JSON\n` +
      `  node statusline.mjs --doctor         Diagnose Node, Git, config mounts, and cache permissions\n` +
      `  node statusline.mjs --doctor --json  Output diagnostics as machine-readable JSON\n` +
      `  node statusline.mjs --version        Print plugin version\n` +
      `  node statusline.mjs --help           Show this help message\n\n` +
      `Environment Variables:\n` +
      `  AGY_HUB_DOT_STYLE       bullseye | pill | small | square | diamond | classic\n` +
      `  AGY_HUB_DATA_DIR        Override data directory (default: ~/.gemini/plugins/agy-hub-pro/data)\n` +
      `  AGY_HUB_GIT_TIMEOUT_MS  Git status timeout in ms (default: 150)\n` +
      `  AGY_HUB_STALL_SEC       Seconds without progress before live dot turns yellow (default: 60)\n` +
      `  AGY_HUB_SHOW_NON_GIT    Set to 1 to show git:- outside Git repositories\n` +
      `  NO_COLOR                Set to any non-empty value to disable ANSI colors\n`
  );
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`agy-hub-pro v${readPluginVersion()}\n`);
    return;
  }
  if (args.includes('--test')) {
    runTestPreview();
    return;
  }
  if (args.includes('--doctor')) {
    runDoctor(args.includes('--json'));
    return;
  }

  const payload = await readAndSniffStdin();
  const existingState = readStateCache();
  const rendered = renderDashboard(payload, existingState, { persist: true });
  process.stdout.write(rendered);
}

main().catch(() => {
  // Never fail statusline rendering
  process.stdout.write(`[AGY] Ctx: -- │ 5h: -- │ Wk: --\n`);
  process.exit(0);
});
