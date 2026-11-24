#!/usr/bin/env node
/**
 * agy-hud-pro / statusline.mjs
 *
 * Millisecond synchronous StatusLine renderer for Antigravity CLI (agy).
 * Zero external dependencies (macOS native Node.js ESM).
 *
 * Renders compact 2-line ANSI dashboard:
 *   Line 1: agy-hub-pro (git:main✓) │ Ctx: ◉○○○○ 14.8% (155K/1M) │ Tok: 1.4M │ Cache: 98% │ 5h: ◉◉◉◉○ 83% (3h18m) │ Wk: ◉◉◉◉○ 74% (5d9h)
 *   Line 2: [Gemini 4 Neon · High] │ User: user@example.com │ Plan: Google AI Pro │ Mode: auto │ Sandbox: OFF │ ● run_command 18s · ~56 t/s
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.dirname(__filename);

const STATE_FILE = process.env.AGY_HUD_STATE_FILE || path.join(PLUGIN_DIR, 'state.json');
const LAST_STDIN_FILE = process.env.AGY_HUD_LAST_STDIN || '/tmp/agy-hud-last-stdin.json';
const GIT_TIMEOUT_MS = Number(process.env.AGY_HUD_GIT_TIMEOUT_MS || 150);
const STALL_WARN_MS = Math.max(5, Number(process.env.AGY_HUD_STALL_SEC || 60)) * 1000;
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
const ACTIVE_DOT_STYLE =
  DOT_STYLES[(process.env.AGY_HUD_DOT_STYLE || 'bullseye').toLowerCase()] || DOT_STYLES.bullseye;

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
  // Treat 1,048,576 (1 MiB) and 1,000,000 as clean "1M"
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
      // Strip trailing effort suffix like "(High)" so it isn't duplicated next to the effort tag
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

    // Field sniffing dump: save on first run, debug mode, or latest snapshot
    try {
      const shouldDump =
        process.env.AGY_HUD_DEBUG === '1' ||
        process.env.AGY_HUD_SNIFF !== '0' ||
        !fs.existsSync(LAST_STDIN_FILE);
      if (shouldDump) {
        fs.writeFileSync(LAST_STDIN_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      }
    } catch {
      // Never break status line on /tmp write error
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

  // Fallback: extract effort from parenthetical suffix in model display_name e.g. "Gemini 4 Neon (High)"
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

  // 1. Resolve window max size
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

  // 2. Resolve used tokens (supports nested current_usage / camelCase / snake_case)
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

  // 3. Resolve used percentage
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

  // Back-calculate usedTokens when only used_percentage + context_window_size are provided
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

  // Fuzzy fallback: skip 3p-* and *-wtu-* buckets unless active model is 3p
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
  const durStr = totalHours > 0 ? (m > 0 ? `${totalHours}h${m}m` : `${totalHours}h`) : `${m}m`;
  return durStr;
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
  // Fallback: agy stdin may report ~/.gemini/antigravity/brain/... while CLI stores under antigravity-cli
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
        // Last line exceeded TRANSCRIPT_TAIL_BYTES; degrade safely and use file size as progress signal
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
  // Token throughput stays valid for the entire lifecycle of the current terminal window
  // (persisted across turns, idle periods, and /clear).
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

function readStateCache() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  // Align 5h token tally to the active quota cycle (reset_time - 5h) when known
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
  // Align weekly token tally to the active cloud quota cycle (reset_time - 7d) when known,
  // falling back to local calendar week (Monday 00:00) only when no reset anchor exists.
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

  // Backward compatibility: adopt legacy top-level state.activity when matching window or default
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
        // Preserve last measured t/s across /clear or session switches within the same terminal window
        lastTps: preservedTps,
        lastTpsAt: preservedTpsAt,
        lastStepKey: null,
        updatedAt: now,
      };

  if (!sameSession && (isWorking || outTok > 0 || preservedTps !== null)) {
    dirty = true;
  }

  const wasWorking = Boolean(act.isWorking);

  // Detect output token growth -> estimate tokens/sec
  if (act.lastOutTokens > 0 && outTok < act.lastOutTokens) {
    // In-place /clear, session compaction, or counter reset: re-anchor baseline without resetting lastTps
    act.lastOutTokens = outTok;
    act.lastOutAt = now;
    dirty = true;
  } else if (outTok > (act.lastOutTokens || 0)) {
    const deltaOut = outTok - (act.lastOutTokens || 0);
    const refTime = act.lastOutAt || act.workStartAt || 0;
    const dtMs = refTime > 0 ? now - refTime : 0;

    // Only compute speed when we have a prior anchor within a sane interval (200ms .. 2min)
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

  // Handle working / idle transitions (never clear lastTps within the same window lifecycle)
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

  // Keep windowActivity bounded so state.json stays compact across long-term use
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
          // Net session tokens: non-cached input + output (excludes cache_read_tokens)
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

function syncLiveState(payload, existing, liveQuota, sessionTok, ctxUsedTokens, modelName, activityInput) {
  const now = Date.now();
  const state = existing && typeof existing === 'object'
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
    if (liveQuota.resetWkSec !== null) state.quota.resetWeekSec = liveQuota.resetWkSec;
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

  if (dirty) {
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

    const header = lines[0]; // e.g. "## main...origin/main [ahead 1, behind 2]" or "## No commits yet on main"
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
    // Fallback 1: stdin vcs metadata if provided by agy
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
    // Fallback 2: ultra-fast .git/HEAD read if git status timed out on a huge repo
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

  // Remote sync arrows if ahead/behind
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
  if (rem5h >= 70) return false; // plenty left, don't nag early
  const windowSec = 5 * 3600;
  const elapsedFrac = Math.max(0, Math.min(1, (windowSec - reset5hSec) / windowSec));
  if (elapsedFrac < 0.08) return false; // wait at least ~24m into window for stable pace
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
  if (project && process.env.AGY_HUD_SHOW_NON_GIT === '1') {
    return `${ANSI.bold}${project}${ANSI.reset} ${ANSI.dim}(git:-)${ANSI.reset}`;
  }
  if (project) return `${ANSI.bold}${project}${ANSI.reset}`;
  return null;
}

function visibleWidth(str) {
  // Strip ANSI escape sequences and estimate CJK double-width characters
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

  // Assign priority (higher = kept longer on narrow terminals)
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

  // Trim lowest-priority segments only when exceeding terminal_width
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
// Main render pipeline
// ---------------------------------------------------------------------------

async function main() {
  const payload = await readAndSniffStdin();
  const existingState = readStateCache();
  const maxWidth = resolveTerminalWidth(payload);
  const sep = ` ${ANSI.dim}│${ANSI.reset} `;

  // Model Name + Reasoning Effort badge (placed at start of Line 2)
  const modelInfo = extractModelInfo(payload);
  const modelBadge = modelInfo.effort
    ? `${ANSI.bold}${ANSI.cyan}[${modelInfo.name}${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.bold}${modelInfo.effort.color}${modelInfo.effort.label}${ANSI.reset}${ANSI.bold}${ANSI.cyan}]${ANSI.reset}`
    : `${ANSI.bold}${ANSI.cyan}[${modelInfo.name}]${ANSI.reset}`;

  // Workspace + Git segment (placed at start of Line 1)
  const git = getGitInfo(payload);
  const wsGitSeg = formatWorkspaceGitSegment(payload, git);

  // 1. Context Window (displayed as used %, >80% yellow, >90% red)
  const ctx = extractContextWindow(payload);
  const ctxColor = colorByUsage(ctx.usedPct);
  const ctxDots = renderDots(ctx.usedPct, ctxColor);
  const ctxDetail = `${formatCompactTokens(ctx.usedTokens)}/${formatWindowSize(ctx.maxTokens)}`;

  const segCtx =
    `${ANSI.dim}Ctx:${ANSI.reset} ${ctxDots} ${ctxColor}${formatPct(ctx.usedPct, 1)}${ANSI.reset} ` +
    `${ANSI.dim}(${ctxDetail})${ANSI.reset}`;

  // 2 & 3. 5h Window & Weekly Quota + Consumed Tokens + Reset Countdowns + Live Activity
  // Displayed as remaining %; color follows consumed % (100 - remaining): >80% yellow, >90% red
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
    }
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

  // Line 2: [Model · Effort] + User + Plan + Mode + Sandbox + Live Activity / Speed
  const windowActivity = state?.windowActivity?.[windowId] ?? state?.activity;
  const activityItem = formatActivitySegment(windowActivity, isWorking, nativeTps, transcriptAction, nowMs);
  const line2 = buildLine2(payload, modelBadge, activityItem, sep, maxWidth);
  if (line2) lines.push(line2);

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch(() => {
  // Never fail statusline rendering
  process.stdout.write(`[AGY] Ctx: -- │ 5h: -- │ Wk: --\n`);
  process.exit(0);
});
