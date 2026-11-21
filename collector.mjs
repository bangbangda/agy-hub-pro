#!/usr/bin/env node
/**
 * agy-hud-pro / collector.mjs
 *
 * Lifecycle Hook Handler & Background Quota / Token Ledger Collector.
 * Zero external dependencies (macOS native Node.js ESM).
 *
 * Supported invocations:
 *   node collector.mjs --event SessionStart
 *   node collector.mjs --event Stop            (alias: AfterAgent)
 *   node collector.mjs --event PreInvocation   (alias: UserPromptSubmit)
 *   node collector.mjs --refresh               (detached background refresh)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.dirname(__filename);

const STATE_FILE = process.env.AGY_HUD_STATE_FILE || path.join(PLUGIN_DIR, 'state.json');
const LOCK_FILE = process.env.AGY_HUD_LOCK_FILE || path.join(PLUGIN_DIR, 'collector.lock');
const LAST_STDIN_FILE = process.env.AGY_HUD_LAST_STDIN || '/tmp/agy-hud-last-stdin.json';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 30 * 1000;
const MIN_REFRESH_INTERVAL_MS = 15 * 1000;
const LOW_QUOTA_THRESHOLD = Number(process.env.AGY_HUD_WARN_THRESHOLD || 15);

// Fallback local budget assumptions when live cloud quota cannot be read locally.
const DEFAULT_5H_BUDGET = Number(process.env.AGY_HUD_5H_BUDGET || 5_000_000);
const DEFAULT_WEEK_BUDGET = Number(process.env.AGY_HUD_WEEK_BUDGET || 40_000_000);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function clampPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function formatTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return `${Math.round(v)}`;
}

function getWeekStartMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diffToMonday);
  return d.getTime();
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStaleLock() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    const content = safeReadJson(LOCK_FILE);
    const pid = content?.pid;
    if (ageMs > STALE_LOCK_MS || (pid && !isProcessAlive(pid))) {
      fs.unlinkSync(LOCK_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function acquireLock() {
  cleanStaleLock();
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// State schema & ledger aggregation
// ---------------------------------------------------------------------------

function createDefaultState(now = Date.now()) {
  return {
    version: 1,
    updatedAt: now,
    lastRefreshAt: 0,
    quota: {
      remaining5h: 100,
      remainingWeek: 100,
      reset5hSec: null,
      resetWeekSec: null,
      source: 'estimated',
      isEstimated: true,
      oauthDetected: false,
    },
    usage: {
      tokens5h: 0,
      tokensWeek: 0,
      budget5h: DEFAULT_5H_BUDGET,
      budgetWeek: DEFAULT_WEEK_BUDGET,
    },
    conversations: {},
    ledger: [],
  };
}

function loadState() {
  const existing = safeReadJson(STATE_FILE);
  if (!existing || typeof existing !== 'object') {
    return createDefaultState();
  }
  const base = createDefaultState();
  return {
    ...base,
    ...existing,
    quota: { ...base.quota, ...(existing.quota || {}) },
    usage: { ...base.usage, ...(existing.usage || {}) },
    conversations: existing.conversations && typeof existing.conversations === 'object'
      ? existing.conversations
      : {},
    ledger: Array.isArray(existing.ledger) ? existing.ledger : [],
  };
}

function recomputeAggregates(state, now = Date.now()) {
  const cutoff7d = now - SEVEN_DAYS_MS;
  const cutoff5h = now - FIVE_HOURS_MS;
  const weekStart = getWeekStartMs(now);

  // Prune ledger entries older than 7 days
  state.ledger = state.ledger.filter(
    (entry) => entry && typeof entry.ts === 'number' && entry.ts >= cutoff7d && entry.tokens > 0
  );

  // Keep only recent conversation high-water marks (last 7 days)
  for (const [convId, meta] of Object.entries(state.conversations)) {
    if (!meta || typeof meta.updatedAt !== 'number' || meta.updatedAt < cutoff7d) {
      delete state.conversations[convId];
    }
  }

  let tokens5h = 0;
  let tokensWeek = 0;
  for (const entry of state.ledger) {
    if (entry.ts >= cutoff5h) tokens5h += entry.tokens;
    if (entry.ts >= weekStart) tokensWeek += entry.tokens;
  }

  state.usage.tokens5h = Math.round(tokens5h);
  state.usage.tokensWeek = Math.round(tokensWeek);
  state.usage.budget5h = state.usage.budget5h || DEFAULT_5H_BUDGET;
  state.usage.budgetWeek = state.usage.budgetWeek || DEFAULT_WEEK_BUDGET;

  // If quota is estimated (no live cloud reading), derive remaining % from local token ledger
  if (state.quota.isEstimated) {
    const pct5h = clampPct((1 - state.usage.tokens5h / state.usage.budget5h) * 100);
    const pctWk = clampPct((1 - state.usage.tokensWeek / state.usage.budgetWeek) * 100);
    state.quota.remaining5h = pct5h ?? 100;
    state.quota.remainingWeek = pctWk ?? 100;
  }

  state.updatedAt = now;
  return state;
}

// ---------------------------------------------------------------------------
// Quota probing (live stdin snapshot / local agy caches / OAuth status)
// ---------------------------------------------------------------------------

function isThirdPartyModel(obj) {
  const modelStr = String(
    obj?.model?.id ||
    obj?.model?.display_name ||
    obj?.model?.displayName ||
    obj?.modelName ||
    (typeof obj?.model === 'string' ? obj.model : '')
  ).toLowerCase();
  return /(claude|sonnet|opus|haiku|gpt|openai|\bo1\b|\bo3\b|\bo4\b|\b3p\b)/i.test(modelStr);
}

function extractQuotaFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const q = obj.quota && typeof obj.quota === 'object' ? obj.quota : obj;

  let rem5h = null;
  let remWk = null;
  let reset5hSec = null;
  let resetWeekSec = null;

  const pickPct = (node) => {
    if (node == null) return null;
    if (typeof node === 'number') return node <= 1 ? clampPct(node * 100) : clampPct(node);
    if (typeof node !== 'object') return null;
    if (typeof node.remaining_fraction === 'number') return clampPct(node.remaining_fraction * 100);
    if (typeof node.remainingFraction === 'number') return clampPct(node.remainingFraction * 100);
    if (typeof node.remaining_percentage === 'number') return clampPct(node.remaining_percentage);
    if (typeof node.remainingPercentage === 'number') return clampPct(node.remainingPercentage);
    if (typeof node.remaining === 'number') {
      return node.remaining <= 1 ? clampPct(node.remaining * 100) : clampPct(node.remaining);
    }
    if (typeof node.used_percentage === 'number') return clampPct(100 - node.used_percentage);
    if (typeof node.usedPercentage === 'number') return clampPct(100 - node.usedPercentage);
    return null;
  };

  const is3p = isThirdPartyModel(obj);
  const preferred5h = is3p
    ? ['3p-5h', '3p_5h', 'gemini-5h', '5h', 'five_hour']
    : ['gemini-5h', 'gemini_5h', '5h', 'five_hour'];
  const preferredWk = is3p
    ? ['3p-weekly', '3p_weekly', 'gemini-weekly', 'weekly', '7d']
    : ['gemini-weekly', 'gemini_weekly', 'weekly', '7d'];

  for (const k of preferred5h) {
    if (Object.prototype.hasOwnProperty.call(q, k)) {
      const pct = pickPct(q[k]);
      if (pct !== null) {
        rem5h = pct;
        reset5hSec = q[k]?.reset_in_seconds ?? q[k]?.resetInSeconds ?? null;
        break;
      }
    }
  }
  for (const k of preferredWk) {
    if (Object.prototype.hasOwnProperty.call(q, k)) {
      const pct = pickPct(q[k]);
      if (pct !== null) {
        remWk = pct;
        resetWeekSec = q[k]?.reset_in_seconds ?? q[k]?.resetInSeconds ?? null;
        break;
      }
    }
  }

  // Fuzzy fallback: skip 3p-* and *-wtu-* buckets for Gemini models
  for (const [key, val] of Object.entries(q)) {
    const lk = key.toLowerCase();
    if (!is3p && (lk.startsWith('3p-') || lk.startsWith('3p_') || lk.includes('wtu'))) continue;
    if (rem5h === null && (lk.includes('5h') || lk.includes('five_hour') || lk.includes('short') || lk.includes('rolling'))) {
      const pct = pickPct(val);
      if (pct !== null) {
        rem5h = pct;
        reset5hSec = val?.reset_in_seconds ?? val?.resetInSeconds ?? null;
      }
    } else if (remWk === null && (lk.includes('week') || lk.includes('7d') || lk.includes('wk'))) {
      const pct = pickPct(val);
      if (pct !== null) {
        remWk = pct;
        resetWeekSec = val?.reset_in_seconds ?? val?.resetInSeconds ?? null;
      }
    }
  }

  // Also check flat fields directly on quota object
  if (rem5h === null && typeof q.remaining5h === 'number') rem5h = clampPct(q.remaining5h);
  if (remWk === null && typeof q.remainingWeek === 'number') remWk = clampPct(q.remainingWeek);

  if (rem5h === null && remWk === null) return null;
  return { remaining5h: rem5h, remainingWeek: remWk, reset5hSec, resetWeekSec };
}

function probeLocalQuotaSources() {
  const home = os.homedir();
  const agyDir = path.join(home, '.gemini', 'antigravity-cli');
  const geminiDir = path.join(home, '.gemini');

  let oauthDetected = false;
  const oauthCandidates = [
    path.join(agyDir, 'oauth_creds.json'),
    path.join(agyDir, 'credentials.json'),
    path.join(agyDir, 'auth.json'),
    path.join(geminiDir, 'oauth_creds.json'),
    path.join(geminiDir, 'google_accounts.json'),
  ];
  for (const p of oauthCandidates) {
    try {
      if (fs.existsSync(p)) {
        oauthDetected = true;
        break;
      }
    } catch {
      // ignore permission errors
    }
  }

  // 1. Check latest statusline stdin snapshot (often contains live agy quota telemetry)
  const lastStdin = safeReadJson(LAST_STDIN_FILE);
  if (lastStdin) {
    const extracted = extractQuotaFromObject(lastStdin);
    if (extracted) {
      return { ...extracted, source: 'agy-stdin', oauthDetected };
    }
  }

  // 2. Check known local cache files (read-only, never leaks credentials)
  const cacheCandidates = [
    path.join(agyDir, 'quota_cache.json'),
    path.join(agyDir, 'quota.json'),
    path.join(agyDir, 'usage_cache.json'),
    path.join(agyDir, 'cache', 'quota.json'),
    path.join(geminiDir, 'quota_cache.json'),
  ];
  for (const candidate of cacheCandidates) {
    const data = safeReadJson(candidate);
    if (!data) continue;
    const extracted = extractQuotaFromObject(data);
    if (extracted) {
      return { ...extracted, source: `local:${path.basename(candidate)}`, oauthDetected };
    }
  }

  return { remaining5h: null, remainingWeek: null, reset5hSec: null, resetWeekSec: null, source: 'estimated', oauthDetected };
}

// ---------------------------------------------------------------------------
// Token delta extraction for Stop / AfterAgent hooks
// ---------------------------------------------------------------------------

function extractTurnTokens(payload, state) {
  const convId = payload.conversationId || payload.session_id || payload.sessionId || 'default';
  const model =
    payload.model?.id ||
    payload.model?.display_name ||
    payload.modelName ||
    (typeof payload.model === 'string' ? payload.model : 'unknown');

  // 1. Explicit incremental / turn usage fields in hook payload
  const usage = payload.usage || payload.tokenUsage || payload.turnUsage || payload.metrics || null;
  if (usage && typeof usage === 'object') {
    const explicitTotal =
      Number(usage.total_tokens ?? usage.totalTokens ?? usage.delta_tokens ?? usage.deltaTokens ?? 0);
    if (explicitTotal > 0) {
      return { deltaTokens: Math.round(explicitTotal), model, convId, source: 'hook-usage' };
    }
    const sumParts =
      Number(usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0) +
      Number(usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens ?? 0) +
      Number(usage.cached_tokens ?? usage.cachedTokens ?? 0);
    if (sumParts > 0) {
      return { deltaTokens: Math.round(sumParts), model, convId, source: 'hook-usage-parts' };
    }
  }

  if (typeof payload.deltaTokens === 'number' && payload.deltaTokens > 0) {
    return { deltaTokens: Math.round(payload.deltaTokens), model, convId, source: 'hook-delta' };
  }

  // 2. Compare cumulative session/context_window tokens from payload or /tmp/agy-hud-last-stdin.json
  const ctxObj = payload.context_window || payload.contextWindow || safeReadJson(LAST_STDIN_FILE)?.context_window || null;
  if (ctxObj && typeof ctxObj === 'object') {
    const inTot = Number(ctxObj.total_input_tokens ?? ctxObj.totalInputTokens ?? 0);
    const outTot = Number(ctxObj.total_output_tokens ?? ctxObj.totalOutputTokens ?? 0);
    let cumulative = inTot + outTot;
    if (!cumulative) {
      cumulative = Number(ctxObj.used_tokens ?? ctxObj.usedTokens ?? 0);
    }
    if (!cumulative) {
      const size = Number(ctxObj.context_window_size ?? ctxObj.max_tokens ?? ctxObj.maxTokens ?? 0);
      const pct = Number(ctxObj.used_percentage ?? ctxObj.usedPercentage ?? 0);
      if (size > 0 && pct > 0) {
        cumulative = Math.round((size * pct) / 100);
      }
    }
    if (cumulative > 0) {
      const prevMeta = state.conversations[convId] || {};
      const prev = Math.max(Number(prevMeta.lastSessionTokens || 0), Number(prevMeta.lastContextTokens || 0));
      const delta = cumulative >= prev ? cumulative - prev : cumulative;
      state.conversations[convId] = {
        ...prevMeta,
        lastSessionTokens: cumulative,
        lastContextTokens: inTot || cumulative,
        model,
        updatedAt: Date.now(),
      };
      if (delta > 0) {
        return { deltaTokens: Math.round(delta), model, convId, source: 'context-diff' };
      }
    }
  }

  // 3. Fallback: estimate lightweight delta from transcriptPath tail if accessible
  if (typeof payload.transcriptPath === 'string' && payload.transcriptPath) {
    try {
      const stat = fs.statSync(payload.transcriptPath);
      const prevSize = state.conversations[convId]?.lastTranscriptBytes || 0;
      if (stat.size > prevSize) {
        const deltaBytes = stat.size - prevSize;
        state.conversations[convId] = {
          ...(state.conversations[convId] || {}),
          lastTranscriptBytes: stat.size,
          model,
          updatedAt: Date.now(),
        };
        // Rough ~4 bytes/token heuristic when no explicit token counts are exposed
        const estTokens = Math.max(50, Math.round(deltaBytes / 4));
        return { deltaTokens: estTokens, model, convId, source: 'transcript-est' };
      }
    } catch {
      // transcript may not be readable in restricted environments
    }
  }

  return { deltaTokens: 0, model, convId, source: 'none' };
}

// ---------------------------------------------------------------------------
// Detached background refresh launcher (non-blocking)
// ---------------------------------------------------------------------------

function spawnBackgroundRefresh() {
  try {
    const child = spawn(process.execPath, [__filename, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    // never crash a lifecycle hook
  }
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

function handleSessionStart() {
  cleanStaleLock();
  const state = recomputeAggregates(loadState());
  try {
    atomicWriteJson(STATE_FILE, state);
  } catch {
    // ignore
  }
  spawnBackgroundRefresh();
  process.stdout.write('{}\n');
}

function handleStop(payload) {
  const now = Date.now();
  const state = loadState();

  // Apply any live quota carried directly in payload
  const payloadQuota = extractQuotaFromObject(payload);
  if (payloadQuota) {
    if (payloadQuota.remaining5h !== null) state.quota.remaining5h = payloadQuota.remaining5h;
    if (payloadQuota.remainingWeek !== null) state.quota.remainingWeek = payloadQuota.remainingWeek;
    if (payloadQuota.reset5hSec !== null) state.quota.reset5hSec = payloadQuota.reset5hSec;
    if (payloadQuota.resetWeekSec !== null) state.quota.resetWeekSec = payloadQuota.resetWeekSec;
    state.quota.isEstimated = false;
    state.quota.source = 'hook-payload';
  }

  // Record incremental turn tokens into rolling ledger
  const { deltaTokens, model, convId, source } = extractTurnTokens(payload, state);
  if (deltaTokens > 0) {
    state.ledger.push({
      ts: now,
      tokens: deltaTokens,
      model,
      conversationId: convId,
      source,
    });
  }

  recomputeAggregates(state, now);

  try {
    atomicWriteJson(STATE_FILE, state);
  } catch {
    // ignore
  }

  if (now - (state.lastRefreshAt || 0) >= MIN_REFRESH_INTERVAL_MS) {
    spawnBackgroundRefresh();
  }

  // Antigravity Stop contract: any decision other than "continue" allows stopping
  process.stdout.write(`${JSON.stringify({ decision: 'allow' })}\n`);
}

function handlePreInvocation(payload) {
  const state = recomputeAggregates(loadState());

  const rem5h = state.quota?.remaining5h;
  const remWk = state.quota?.remainingWeek;
  const prefix = state.quota?.isEstimated ? '~' : '';

  const currentModel = String(
    payload.modelName || payload.model?.id || payload.model?.display_name || ''
  ).toLowerCase();

  const alreadyHydrogen = currentModel.includes('hydrogen');
  const low5h = typeof rem5h === 'number' && rem5h < LOW_QUOTA_THRESHOLD;
  const lowWk = typeof remWk === 'number' && remWk < LOW_QUOTA_THRESHOLD;

  if ((low5h || lowWk) && !alreadyHydrogen) {
    const reasons = [];
    if (low5h) reasons.push(`5h 余量 ${prefix}${rem5h}% (${formatTokens(state.usage.tokens5h)} tok)`);
    if (lowWk) reasons.push(`周余量 ${prefix}${remWk}% (${formatTokens(state.usage.tokensWeek)} tok)`);

    const notice =
      `[AGY HUD 配额预警] ${reasons.join('，')}，已低于 ${LOW_QUOTA_THRESHOLD}% 预警阈值。` +
      `建议立即切换至高性价比模型 \`gemini-4-hydrogen\`（可在终端输入 \`/model gemini-4-hydrogen\`）以避免触及限流。`;

    // Antigravity PreInvocation contract
    const output = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: notice,
          },
        },
      ],
      terminationBehavior: '',
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write('{}\n');
}

function handleRefresh() {
  if (!acquireLock()) return;
  try {
    const now = Date.now();
    const state = loadState();
    const probed = probeLocalQuotaSources();

    state.quota.oauthDetected = probed.oauthDetected;

    if (probed.remaining5h !== null || probed.remainingWeek !== null) {
      if (probed.remaining5h !== null) state.quota.remaining5h = probed.remaining5h;
      if (probed.remainingWeek !== null) state.quota.remainingWeek = probed.remainingWeek;
      if (probed.reset5hSec !== null) state.quota.reset5hSec = probed.reset5hSec;
      if (probed.resetWeekSec !== null) state.quota.resetWeekSec = probed.resetWeekSec;
      state.quota.source = probed.source;
      state.quota.isEstimated = false;
    } else if (state.quota.source === 'estimated') {
      state.quota.isEstimated = true;
    }

    state.lastRefreshAt = now;
    recomputeAggregates(state, now);
    atomicWriteJson(STATE_FILE, state);
  } catch {
    // never crash background worker
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let event = null;
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event' && argv[i + 1]) {
      event = argv[++i];
    } else if (argv[i] === '--refresh') {
      refresh = true;
    }
  }
  return { event, refresh };
}

function main() {
  const { event, refresh } = parseArgs(process.argv.slice(2));
  if (refresh) {
    handleRefresh();
    return;
  }

  const payload = readStdinJson();
  const resolvedEvent = (event || payload.hookEventName || payload.hook_event_name || '').trim();

  switch (resolvedEvent) {
    case 'SessionStart':
      handleSessionStart();
      break;
    case 'Stop':
    case 'AfterAgent':
      handleStop(payload);
      break;
    case 'PreInvocation':
    case 'UserPromptSubmit':
      handlePreInvocation(payload);
      break;
    default:
      // Default to safe no-op JSON so unknown invocations never block agy
      process.stdout.write('{}\n');
      break;
  }
}

try {
  main();
} catch {
  process.stdout.write('{}\n');
  process.exit(0);
}
