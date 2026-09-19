// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MeterCache, paceSnapshot, FRESH_MS, STALE_MS, WINDOW_MS,
  normalizePacingWindow, meterResolutionPct, monotonicIntervalDelta,
} from './framework.js';
import { loadProviders, providerFor } from '../lib/providers.js';
import { migratePoolNameHome } from '../lib/state.js';

export const METERS_DIR = () =>
  process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');

/** The operator-declared subscription record for one pool, or null. */
export function declaredSubscription(subscriptions, pool) {
  const record = subscriptions?.[pool];
  return record && typeof record === 'object' ? record : null;
}

/**
 * The live reader for a pool: a closure over its owning provider's
 * `readUsage(poolName, ctx)`, or null when no provider owns the pool or the
 * owner exports no readUsage (the pool then falls to a declared meter or
 * unmetered, in src/lib/config.js).
 *
 * @param {string} pool
 * @param {{
 *   bullswarmDir?: string,
 *   providers?: object[],
 *   subscription?: object|null,
 *   subscriptions?: Record<string, object>,
 * }} [readerOpts]
 *   bullswarmDir   the home providers load from (default METERS_DIR())
 *   providers      loadProviders(...).providers, to skip a second load
 *   subscription   the pool's declared subscription, else looked up in
 *   subscriptions  state.strategy.subscriptions
 */
export function readerFor(pool, readerOpts = {}) {
  const providers = readerOpts.providers
    ?? loadProviders(readerOpts.bullswarmDir ?? METERS_DIR()).providers;
  const owner = providerFor(providers, pool);
  const readUsage = owner?.module?.readUsage;
  if (typeof readUsage !== 'function') return null;
  const subscription = readerOpts.subscription !== undefined
    ? readerOpts.subscription
    : declaredSubscription(readerOpts.subscriptions, pool);
  return () => readUsage(pool, { ...owner.ctx, subscription });
}

/** A compact, safe-to-display reason for a failed meter read. */
export function meterErrorText(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) return String(Math.trunc(status));
  if (typeof error?.code === 'string' && error.code.trim()) return error.code.trim();
  const message = error?.message ? String(error.message).trim() : String(error ?? '').trim();
  if (!message) return 'error';
  return message.length > 80 ? `${message.slice(0, 77)}…` : message;
}

function holdUntilOf(hold) {
  const failedAt = Date.parse(hold?.failed_at);
  const retryAfterMs = Number(hold?.retry_after_ms);
  if (!Number.isFinite(failedAt) || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return failedAt + retryAfterMs;
}

function errorFromHold(hold) {
  const reason = typeof hold?.reason === 'string' && hold.reason ? hold.reason : 'meter poll failed';
  const error = new Error(reason);
  error.name = 'MeterError';
  // HTTP reasons are persisted as their status string, so a later process can
  // still expose the same status even though Error objects are not serializable.
  if (/^\d+$/.test(reason)) error.status = Number(reason);
  if (typeof hold?.code === 'string' && hold.code) error.code = hold.code;
  error.retryAfterMs = Number.isFinite(Number(hold?.retry_after_ms))
    ? Number(hold.retry_after_ms)
    : null;
  return error;
}

function holdForError(error, nowMs) {
  const retryAfterMs = Number(error?.retryAfterMs);
  // A zero/negative server hint is not a useful negative cache for a
  // rate-limited endpoint; retain the named freshness window rather than
  // immediately hammering it again. Positive Retry-After values are honored.
  const retry = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : FRESH_MS;
  const reason = meterErrorText(error);
  return {
    failed_at: new Date(nowMs).toISOString(),
    retry_after_ms: retry,
    reason,
  };
}

function decorateError(error, hold, holdUntil) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error.holdUntil = holdUntil;
    error.meterError = typeof hold?.reason === 'string' ? hold.reason : meterErrorText(error);
  }
  return error;
}

/**
 * A cached snapshot can be synthetic: when a provider refuses an attempt and
 * its meter endpoint is unavailable, the refusal itself is the strongest
 * evidence we have. Keep that marker on the snapshot so every process that
 * reads the cache (routing, pools, and the dashboard) sees the same fact.
 */
function quotaRefusalOf(snapshot) {
  const marker = snapshot?.quota_refusal;
  if (!marker || typeof marker !== 'object') return null;
  const refusedAt = typeof marker.refused_at === 'string' ? marker.refused_at : null;
  const resetsAt = typeof marker.resets_at === 'string' ? marker.resets_at : null;
  const window = typeof marker.window === 'string' ? marker.window : null;
  if (!refusedAt && !resetsAt && !window) return null;
  return {
    source: 'quota-refusal',
    refusedAt,
    resetsAt,
    window,
    reason: typeof marker.reason === 'string' ? marker.reason : null,
  };
}

function readingWithMarker(result, snapshot = result?.snapshot) {
  const marker = quotaRefusalOf(snapshot);
  return marker ? { ...result, source: 'quota-refusal', quotaRefusal: marker } : result;
}

/** Read only a persisted quota-refusal marker; never contacts a provider. */
export function cachedQuotaRefusal(pool, { bullswarmDir = METERS_DIR(), nowMs = Date.now() } = {}) {
  migratePoolNameHome(bullswarmDir);
  const cache = new MeterCache(join(bullswarmDir, 'meters'));
  const snapshot = cache.get(pool);
  const marker = quotaRefusalOf(snapshot);
  if (!marker) return null;
  return {
    snapshot,
    source: 'quota-refusal',
    quotaRefusal: marker,
    ...paceSnapshot(snapshot, nowMs),
  };
}

function staleResult(cached, nowMs, error, holdUntil, reason) {
  const capturedMs = Date.parse(cached?.captured_at);
  const ageMs = Number.isFinite(capturedMs) ? nowMs - capturedMs : null;
  const meterError = reason ?? meterErrorText(error);
  return readingWithMarker({
    snapshot: cached,
    source: 'stale',
    error,
    meterError,
    holdUntil,
    ageMs,
    ...paceSnapshot(cached, nowMs),
  }, cached);
}

/**
 * Get a usable meter reading for a pool:
 *   1. an active persisted hold (unless forced) → stale cache, no poll
 *   2. fresh cache hit (<= FRESH_MS old) → use it
 *   3. live poll → cache + use, clearing any hold
 *   4. poll failed → persist a hold and use a stale cache, else the error
 * Never fabricates numbers. Every live poll is also appended to the pool's
 * reading history (see appendMeterHistory) so spend rates have a series.
 *
 * opts.reader overrides the provider's reader — used by tests to exercise the
 * live path without touching a provider. opts.subscriptions is
 * state.strategy.subscriptions, so a pool's declared subscription reaches its
 * provider's readUsage; opts.bullswarmDir and opts.providers are passed on to
 * readerFor.
 */
export async function getMeterReading(pool, opts = {}) {
  const { force = false, nowMs = Date.now() } = opts;
  // A meter command may be the first command after an upgrade and can be
  // called without a preceding state load. Keep the same idempotent home
  // migration guarantee for cache/history files in that path.
  const home = opts.bullswarmDir ?? METERS_DIR();
  migratePoolNameHome(home);
  const cache = new MeterCache(join(home, 'meters'));
  const cached = cache.get(pool);

  // A persisted hold is checked before the ordinary freshness path: a failed
  // poll is a reason to say stale even if another process happened to refresh
  // the snapshot while this process was starting. `force` is the explicit
  // operator escape hatch and always reaches the reader.
  if (!force) {
    const hold = cache.getHold(pool);
    const holdUntil = holdUntilOf(hold);
    if (holdUntil != null && nowMs < holdUntil) {
      const error = decorateError(errorFromHold(hold), hold, holdUntil);
      if (cached) return staleResult(cached, nowMs, error, holdUntil, hold.reason);
      // Keep the historical no-cache contract (throw), but do not poll again;
      // getAllMeterReadings turns this into a structured `source: error` row.
      throw error;
    }
  }

  if (!force && cached && nowMs - Date.parse(cached.captured_at) <= FRESH_MS) {
    return readingWithMarker({ snapshot: cached, source: 'cache', ...paceSnapshot(cached, nowMs) }, cached);
  }

  const reader = opts.reader ?? readerFor(pool, {
    bullswarmDir: opts.bullswarmDir,
    providers: opts.providers,
    subscription: opts.subscription,
    subscriptions: opts.subscriptions,
  });
  if (!reader) {
    // No programmatic reader for this pool. A cached snapshot is still a real
    // recorded reading, so a FORCED refresh must not blank it — that call is
    // the post-quota-failure path, exactly when routing needs the 5h numbers
    // most. Same age ladder as the reader-failure branch below. With no
    // usable cache, declared meters (state.json) remain the fallback and are
    // handled by config.js; signal that here.
    if (cached) {
      const ageMs = nowMs - Date.parse(cached.captured_at);
      // A quota-refusal marker is an explicit routing wall, not an ordinary
      // stale measurement. Keep it visible until a successful live read below
      // 100% replaces it, even when the provider has been unreachable longer
      // than STALE_MS.
      if (quotaRefusalOf(cached) || (Number.isFinite(ageMs) && ageMs <= STALE_MS)) {
        return readingWithMarker({
          snapshot: cached,
          source: ageMs <= FRESH_MS ? 'cache' : 'stale',
          ageMs,
          ...paceSnapshot(cached, nowMs),
        }, cached);
      }
    }
    return { snapshot: null, source: 'none', pacing: null, burstGate: false, windows: {} };
  }

  try {
    const rawSnapshot = await reader();
    // A provider reader is authoritative. If a test adapter or an older
    // provider returns the cache object by reference, do not let the
    // synthetic refusal metadata survive a successful live read.
    const snapshot = rawSnapshot && typeof rawSnapshot === 'object'
      ? { ...rawSnapshot }
      : rawSnapshot;
    if (snapshot && typeof snapshot === 'object' && quotaRefusalOf(snapshot)) {
      delete snapshot.quota_refusal;
      if (snapshot.source === 'quota-refusal') delete snapshot.source;
    }
    cache.put(pool, snapshot);
    try { cache.clearHold(pool); } catch { /* a later live read can retry cleanup */ }
    // The cache keeps only the latest reading; the spend model needs the
    // series, so every LIVE reading is also appended to the history log.
    appendMeterHistory(pool, snapshot, {
      dir: cache.dir,
      source: force ? 'forced' : 'live',
    });
    return { snapshot, source: 'live', ...paceSnapshot(snapshot, nowMs) };
  } catch (err) {
    const hold = holdForError(err, nowMs);
    const holdUntil = nowMs + hold.retry_after_ms;
    try { cache.putHold(pool, hold); } catch { /* negative cache is best effort */ }
    decorateError(err, hold, holdUntil);
    if (cached) {
      const ageMs = nowMs - Date.parse(cached.captured_at);
      if (quotaRefusalOf(cached) || ageMs <= STALE_MS || nowMs < holdUntil) {
        return staleResult(cached, nowMs, err, holdUntil, hold.reason);
      }
    }
    throw err;
  }
}

// --- quota refusal refresh -------------------------------------------------

const QUOTA_WINDOWS = Object.freeze({
  five_hour: { name: '5h', pacing: null, ms: WINDOW_MS['5h'] },
  seven_day: { name: 'weekly', pacing: 'weekly', ms: WINDOW_MS.weekly },
  monthly: { name: 'monthly', pacing: 'monthly', ms: null },
});

function finiteMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function windowDeclaredByConnector(connector, subscription) {
  const raw = connector?.meter?.window;
  const values = typeof raw === 'string' ? raw.toLowerCase().split(/[+,_\s]+/) : [];
  if (values.includes('5h') || values.includes('five_hour') || values.includes('five-hour')) return 'five_hour';
  if (values.includes('weekly') || values.includes('7d') || values.includes('seven_day')) return 'seven_day';
  if (values.includes('monthly') || values.includes('mo')) return 'monthly';
  const pacing = normalizePacingWindow(subscription?.quotaWindow ?? connector?.subscription?.quotaWindow);
  return pacing === 'monthly' ? 'monthly' : pacing === 'weekly' ? 'seven_day' : null;
}

function windowHasData(snapshot, key) {
  const window = snapshot?.[key];
  if (!window || typeof window !== 'object') return false;
  return Number.isFinite(Number(window.utilization)) || finiteMs(window.resets_at) != null;
}

function quotaWindowFor(snapshot, connector, subscription) {
  // The provider snapshot is the most concrete declaration. A present 5h
  // field with actual usage/reset data wins. Normalized weekly-only provider
  // snapshots still carry a null-shaped five_hour field, which is not a real
  // shorter quota and must not turn a weekly refusal into a fictitious 5h wall.
  if (windowHasData(snapshot, 'five_hour')) return 'five_hour';
  const declared = windowDeclaredByConnector(connector, subscription);
  if (declared) return declared;
  if (windowHasData(snapshot, 'seven_day')) return 'seven_day';
  if (windowHasData(snapshot, 'monthly')) return 'monthly';
  return 'seven_day';
}

function addCalendarMonth(ms) {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

function nextResetForWindow(windowKey, prior, nowMs) {
  const info = QUOTA_WINDOWS[windowKey] ?? QUOTA_WINDOWS.seven_day;
  let reset = finiteMs(prior?.[windowKey]?.resets_at);
  if (reset != null) {
    for (let count = 0; count < 2400 && reset <= nowMs; count += 1) {
      reset = windowKey === 'monthly' ? addCalendarMonth(reset) : reset + info.ms;
    }
    if (reset > nowMs) return reset;
  }
  if (windowKey === 'monthly') return addCalendarMonth(nowMs);
  return nowMs + info.ms;
}

function quotaRefusalSnapshot(pool, {
  cached, connector, subscription, nowMs, resetAtMs, reason,
} = {}) {
  const windowKey = quotaWindowFor(cached, connector, subscription);
  const info = QUOTA_WINDOWS[windowKey] ?? QUOTA_WINDOWS.seven_day;
  const namedReset = finiteMs(resetAtMs);
  const resetsAtMs = namedReset != null && namedReset > nowMs
    ? namedReset
    : nextResetForWindow(windowKey, cached, nowMs);
  const resetsAt = new Date(resetsAtMs).toISOString();
  const refusedAt = new Date(nowMs).toISOString();
  const snapshot = cached && typeof cached === 'object' ? { ...cached } : {};
  snapshot.pool ??= pool;
  snapshot.captured_at = refusedAt;
  snapshot.source = 'quota-refusal';
  snapshot.quota_refusal = {
    source: 'quota-refusal',
    refused_at: refusedAt,
    resets_at: resetsAt,
    window: info.name,
    reason: reason ? String(reason).slice(0, 300) : null,
  };
  snapshot[windowKey] = {
    ...(snapshot[windowKey] && typeof snapshot[windowKey] === 'object' ? snapshot[windowKey] : {}),
    utilization: 100,
    resets_at: resetsAt,
    source: 'quota-refusal',
  };
  return { snapshot, marker: quotaRefusalOf(snapshot), windowKey };
}

/**
 * Refresh a pool immediately after a quota refusal. The forced read bypasses
 * FRESH_MS. A live reading wins and naturally replaces any prior marker; when
 * the reader is absent or fails, the refusal is persisted as a synthetic 100%
 * reading for the shortest available window so stale low usage cannot route
 * another attempt back to the refused pool.
 */
export async function refreshMeterAfterQuota(pool, opts = {}) {
  const nowMs = finiteMs(opts.nowMs) ?? Date.now();
  const reader = opts.reader ?? opts.meterReader ?? opts.readMeter;
  let reading = null;
  try {
    reading = await getMeterReading(pool, {
      ...opts,
      reader,
      force: true,
      nowMs,
    });
  } catch {
    reading = null;
  }
  if (reading?.source === 'live') return reading;

  const home = opts.bullswarmDir ?? opts.home ?? METERS_DIR();
  migratePoolNameHome(home);
  const cache = new MeterCache(join(home, 'meters'));
  const cached = cache.get(pool);
  const marker = quotaRefusalSnapshot(pool, {
    cached,
    connector: opts.connector ?? null,
    subscription: opts.subscription ?? null,
    nowMs,
    resetAtMs: opts.resetAtMs ?? opts.resetsAt ?? null,
    reason: opts.reason ?? opts.message ?? null,
  });
  cache.put(pool, marker.snapshot);
  // A quota refusal is an authoritative routing wall. The normal meter hold
  // only controls when a provider is retried, so do not let it relabel this
  // synthetic snapshot as a generic stale HTTP error.
  try { cache.clearHold(pool); } catch { /* best effort */ }
  return {
    snapshot: marker.snapshot,
    source: 'quota-refusal',
    quotaRefusal: marker.marker,
    ...paceSnapshot(marker.snapshot, nowMs),
  };
}

/** Best-effort reading for all pools that have readers; never throws. */
export async function getAllMeterReadings(poolNames, opts = {}) {
  const out = {};
  // Load providers once for the whole batch, not once per pool.
  if (!opts.reader && !opts.providers && poolNames.length) {
    try {
      opts = { ...opts, providers: loadProviders(opts.bullswarmDir ?? METERS_DIR()).providers };
    } catch { /* each pool then reports its own error below */ }
  }
  let completed = 0;
  await Promise.all(
    poolNames.map(async (p, index) => {
      opts.onProgress?.({ stage: 'start', pool: p, index: index + 1, total: poolNames.length });
      try {
        out[p] = await getMeterReading(p, opts);
      } catch (err) {
        out[p] = {
          snapshot: null,
          source: 'error',
          error: err,
          meterError: err?.meterError ?? meterErrorText(err),
          holdUntil: Number.isFinite(err?.holdUntil) ? err.holdUntil : null,
          pacing: null,
          burstGate: false,
          windows: {},
        };
      } finally {
        completed += 1;
        opts.onProgress?.({ stage: 'complete', pool: p, completed, total: poolNames.length });
      }
    }),
  );
  return out;
}

// --- reading history --------------------------------------------------------
//
// MeterCache keeps ONE snapshot per pool, so nothing in the tree could answer
// "how fast is this pool burning its window?" — that needs two readings and
// the work dispatched between them. Every live reading is therefore also
// appended to `<meters dir>/history/<pool>.jsonl`, one JSON object per line,
// oldest first. The log is best-effort: a failure to record history never
// fails a meter read, and a rate with no series stays null rather than
// becoming an invented number.

/** Lines kept when the log is rewritten. */
export const MAX_HISTORY_LINES = 500;
/** Line count above which the log is rewritten down to MAX_HISTORY_LINES. */
export const HISTORY_REWRITE_AT = 600;

/** Snapshot window key → history window key. `weekly` is the spend-model name. */
const HISTORY_WINDOWS = [
  ['five_hour', 'five_hour'],
  ['weekly', 'seven_day'],
  ['monthly', 'monthly'],
];

// `captured_at` is stored as an ISO instant. Grouping for a dashboard is in
// the machine's local zone, matching the workflow history view rather than
// silently treating UTC midnight as the operator's day boundary.
const HISTORY_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function historyDayKey(capturedAtMs) {
  return HISTORY_DAY_FORMATTER.format(new Date(capturedAtMs));
}

/** Default meters directory — the same one MeterCache writes snapshots into. */
export function metersDir() {
  return join(METERS_DIR(), 'meters');
}

/** History log path. Pool → filename exactly as MeterCache names snapshots. */
export function meterHistoryPath(pool, dir = metersDir()) {
  return join(dir, 'history', `${pool}.jsonl`);
}

/**
 * The one history line a snapshot is worth: its capture time plus every
 * window it actually reported. A snapshot with no readable window produces
 * null — an empty line would only pad the log.
 */
export function meterHistoryEntry(snapshot, opts = {}) {
  if (!snapshot?.captured_at) return null;
  const providerAt = snapshot.provider_at ?? snapshot.provider_timestamp
    ?? snapshot.providerAt ?? snapshot.captured_at;
  const entry = {
    captured_at: snapshot.captured_at,
    provider_at: providerAt,
    providerAt,
    source: typeof opts.source === 'string' && opts.source.trim()
      ? opts.source.trim()
      : (typeof snapshot.source === 'string' && snapshot.source.trim()
        ? snapshot.source.trim() : 'live'),
  };
  let hasWindow = false;
  for (const [key, source] of HISTORY_WINDOWS) {
    const window = snapshot[source];
    const raw = window?.utilization;
    // M4: a window the provider did not report is absent from the line, never
    // a zero — Number(null) is 0 and that zero would read as "spent nothing".
    if (raw == null || raw === '' || typeof raw === 'boolean') continue;
    const utilization = Number(raw);
    if (!Number.isFinite(utilization)) continue;
    hasWindow = true;
    const resolutionPct = meterResolutionPct({
      pool: opts.pool ?? snapshot.pool,
      window,
      value: utilization,
      snapshot,
    });
    entry[key] = {
      // Keep the original fields consumed by src/lib/spend.js and older
      // history files, while adding explicit ledger vocabulary for new code.
      utilization,
      used_pct: utilization,
      usedPct: utilization,
      resets_at: window.resets_at ?? null,
      resetsAt: window.resets_at ?? null,
      window: key,
      resolution_pct: resolutionPct,
      resolutionPct,
    };
  }
  return hasWindow ? entry : null;
}

function historyWindowValue(entry, key) {
  const value = entry?.[key];
  if (!value || typeof value !== 'object') return null;
  const usedPct = Number(value.used_pct ?? value.usedPct ?? value.utilization);
  if (!Number.isFinite(usedPct)) return null;
  return {
    usedPct,
    resetsAt: value.resets_at ?? value.resetsAt ?? null,
  };
}

function annotateIntervals(entry, previous, pool = null) {
  if (!entry || typeof entry !== 'object') return entry;
  const deltas = {};
  for (const [key] of HISTORY_WINDOWS) {
    const current = historyWindowValue(entry, key);
    if (!current) continue;
    const prior = historyWindowValue(previous, key);
    const delta = monotonicIntervalDelta(prior, current);
    const resolutionPct = Number(entry[key]?.resolution_pct
      ?? entry[key]?.resolutionPct);
    const resolution = Number.isFinite(resolutionPct) && resolutionPct > 0
      ? resolutionPct
      : meterResolutionPct({ pool, window: entry[key], value: current.usedPct });
    entry[key].resolution_pct = resolution;
    entry[key].resolutionPct = resolution;
    entry[key].delta_pct = delta.deltaPct;
    entry[key].deltaPct = delta.deltaPct;
    entry[key].delta_reason = delta.reason;
    deltas[key] = {
      deltaPct: delta.deltaPct,
      resolutionPct: resolution,
      reason: delta.reason,
      from: previous?.captured_at ?? null,
      to: entry.captured_at ?? null,
    };
  }
  entry.deltas = deltas;
  return entry;
}

/**
 * Append one reading to the pool's history log, capping the file.
 * Returns the appended entry, or null when nothing was recorded (unusable
 * snapshot, duplicate capture time, or an I/O failure).
 */
export function appendMeterHistory(pool, snapshot, opts = {}) {
  const entry = meterHistoryEntry(snapshot, { ...opts, pool });
  if (!entry) return null;
  const path = meterHistoryPath(pool, opts.dir ?? metersDir());
  const line = JSON.stringify(entry);
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = raw.split('\n').filter((l) => l.trim());
    // The same snapshot can be handed to us twice (a cached reading re-put by
    // a caller); a repeated capture time is not a second observation.
    if (lines.length && capturedAtOf(lines[lines.length - 1]) === entry.captured_at) return null;
    const previous = latestHistoryEntry(lines, entry.captured_at);
    annotateIntervals(entry, previous, pool);
    if (lines.length + 1 > HISTORY_REWRITE_AT) {
      writeFileSync(path, `${[...lines, line].slice(-MAX_HISTORY_LINES).join('\n')}\n`);
    } else {
      appendFileSync(path, raw && !raw.endsWith('\n') ? `\n${line}\n` : `${line}\n`);
    }
    return entry;
  } catch {
    // History is an optimization for routing, never a precondition for it.
    return null;
  }
}

function capturedAtOf(line) {
  try {
    return JSON.parse(line)?.captured_at ?? null;
  } catch {
    return null;
  }
}

function latestHistoryEntry(lines, beforeCapturedAt = null) {
  const beforeMs = beforeCapturedAt == null ? Infinity : Date.parse(beforeCapturedAt);
  let latest = null;
  let latestMs = -Infinity;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      const at = Date.parse(value?.captured_at ?? '');
      if (!Number.isFinite(at) || at >= beforeMs || at < latestMs) continue;
      latest = value;
      latestMs = at;
    } catch { /* torn rows are skipped */ }
  }
  return latest;
}

/**
 * Read a pool's recorded readings, oldest first. Unparseable or undated lines
 * are skipped rather than throwing — a truncated write must not blind routing.
 *
 * @param {string} pool
 * @param {{dir?: string, sinceMs?: number|null}} [opts]
 * @returns {Array<{captured_at: string, capturedAtMs: number}>}
 */
export function readMeterHistory(pool, opts = {}) {
  const {
    dir = metersDir(), sinceMs = null, untilMs = null,
    day = null, date = null,
  } = opts;
  const wantedDay = day ?? date;
  let raw;
  try {
    raw = readFileSync(meterHistoryPath(pool, dir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const capturedAtMs = Date.parse(entry.captured_at);
    if (!Number.isFinite(capturedAtMs)) continue;
    if (sinceMs != null && capturedAtMs < sinceMs) continue;
    if (untilMs != null && capturedAtMs > untilMs) continue;
    if (wantedDay != null && historyDayKey(capturedAtMs) !== historyDayKeyFor(wantedDay)) continue;
    out.push({ ...entry, capturedAtMs });
  }
  out.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  let previous = null;
  for (const entry of out) {
    // Older rows predate the ledger metadata. Enrich them in memory so a
    // caller can replay the complete series without rewriting user files.
    if (entry.source == null) entry.source = 'legacy';
    if (entry.provider_at == null) entry.provider_at = entry.captured_at;
    if (entry.providerAt == null) entry.providerAt = entry.provider_at;
    annotateIntervals(entry, previous, pool);
    previous = entry;
  }
  return out;
}

/**
 * Turn retained readings into consecutive, monotonic meter intervals. Missing
 * windows simply have no interval; a reset/decrease is represented with a
 * null delta and reason rather than a negative spend observation. Zero deltas
 * remain measurable rows and carry the meter resolution so callers can label
 * them as below-resolution instead of treating them as exact zero spend.
 */
export function meterHistoryIntervals(pool, opts = {}) {
  const history = readMeterHistory(pool, opts);
  const intervals = [];
  for (let i = 1; i < history.length; i += 1) {
    const previous = history[i - 1];
    const current = history[i];
    for (const [window] of HISTORY_WINDOWS) {
      const from = historyWindowValue(previous, window);
      const to = historyWindowValue(current, window);
      if (!from || !to) continue;
      const delta = monotonicIntervalDelta(from, to);
      const resolutionPct = Number(to.resolution_pct ?? to.resolutionPct)
        || meterResolutionPct({ pool, window: to, value: to.usedPct });
      intervals.push({
        pool,
        window,
        from: previous.captured_at,
        at: current.captured_at,
        providerAt: current.provider_at ?? current.captured_at,
        source: current.source ?? 'legacy',
        fromUsedPct: from.usedPct,
        usedPct: to.usedPct,
        resetsAt: to.resetsAt ?? null,
        deltaPct: delta.deltaPct,
        resolutionPct,
        reason: delta.reason,
        row: i,
      });
    }
  }
  return intervals;
}

export const readMeterHistoryIntervals = meterHistoryIntervals;
export const meterLedgerIntervals = meterHistoryIntervals;

function historyDayKeyFor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return historyDayKey(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return historyDayKey(value.getTime());
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? historyDayKey(parsed) : text;
}

/**
 * Read one pool's history for a local calendar day. This is deliberately a
 * thin filter over readMeterHistory, so missing files, torn JSONL lines and
 * undated entries have exactly the same tolerant behavior as the base reader.
 *
 * @param {string} pool
 * @param {string|number|Date} day YYYY-MM-DD, an epoch instant, or a Date
 * @param {{dir?: string, sinceMs?: number|null, untilMs?: number|null}} [opts]
 */
export function readMeterHistoryByDay(pool, day, opts = {}) {
  if (day && typeof day === 'object' && !(day instanceof Date)) {
    return readMeterHistory(pool, day);
  }
  return readMeterHistory(pool, { ...opts, day });
}

/** Alias used by callers that name the result rather than the operation. */
export const meterHistoryForDay = readMeterHistoryByDay;
export const readMeterHistoryForDay = readMeterHistoryByDay;

/**
 * Group a pool's retained readings by local day. The returned object only has
 * days present in the capped log; it never fabricates older empty days.
 */
export function readMeterHistoryDays(pool, opts = {}) {
  const grouped = {};
  for (const entry of readMeterHistory(pool, opts)) {
    const day = historyDayKey(entry.capturedAtMs);
    (grouped[day] ??= []).push(entry);
  }
  return grouped;
}

export { FRESH_MS, STALE_MS };
