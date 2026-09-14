// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MeterCache, paceSnapshot, FRESH_MS, STALE_MS } from './framework.js';
import { loadProviders, providerFor } from '../lib/providers.js';

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

/**
 * Get a usable meter reading for a pool:
 *   1. fresh cache hit (<= FRESH_MS old) → use it
 *   2. live poll → cache + use
 *   3. poll failed → stale cache labeled stale, else the error
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
  const cache = new MeterCache(join(METERS_DIR(), 'meters'));
  const cached = cache.get(pool);

  if (!force && cached && nowMs - Date.parse(cached.captured_at) <= FRESH_MS) {
    return { snapshot: cached, source: 'cache', ...paceSnapshot(cached, nowMs) };
  }

  const reader = opts.reader ?? readerFor(pool, {
    bullswarmDir: opts.bullswarmDir,
    providers: opts.providers,
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
      if (Number.isFinite(ageMs) && ageMs <= STALE_MS) {
        return {
          snapshot: cached,
          source: ageMs <= FRESH_MS ? 'cache' : 'stale',
          ageMs,
          ...paceSnapshot(cached, nowMs),
        };
      }
    }
    return { snapshot: null, source: 'none', pacing: null, burstGate: false, windows: {} };
  }

  try {
    const snapshot = await reader();
    cache.put(pool, snapshot);
    // The cache keeps only the latest reading; the spend model needs the
    // series, so every LIVE reading is also appended to the history log.
    appendMeterHistory(pool, snapshot, { dir: cache.dir });
    return { snapshot, source: 'live', ...paceSnapshot(snapshot, nowMs) };
  } catch (err) {
    if (cached) {
      const ageMs = nowMs - Date.parse(cached.captured_at);
      if (ageMs <= STALE_MS) {
        return {
          snapshot: cached,
          source: 'stale',
          error: err,
          ageMs,
          ...paceSnapshot(cached, nowMs),
        };
      }
    }
    throw err;
  }
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
        out[p] = { snapshot: null, source: 'error', error: err, pacing: null, burstGate: false, windows: {} };
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
export function meterHistoryEntry(snapshot) {
  if (!snapshot?.captured_at) return null;
  const entry = { captured_at: snapshot.captured_at };
  for (const [key, source] of HISTORY_WINDOWS) {
    const window = snapshot[source];
    const raw = window?.utilization;
    // M4: a window the provider did not report is absent from the line, never
    // a zero — Number(null) is 0 and that zero would read as "spent nothing".
    if (raw == null || raw === '' || typeof raw === 'boolean') continue;
    const utilization = Number(raw);
    if (!Number.isFinite(utilization)) continue;
    entry[key] = { utilization, resets_at: window.resets_at ?? null };
  }
  return Object.keys(entry).length > 1 ? entry : null;
}

/**
 * Append one reading to the pool's history log, capping the file.
 * Returns the appended entry, or null when nothing was recorded (unusable
 * snapshot, duplicate capture time, or an I/O failure).
 */
export function appendMeterHistory(pool, snapshot, opts = {}) {
  const entry = meterHistoryEntry(snapshot);
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

/**
 * Read a pool's recorded readings, oldest first. Unparseable or undated lines
 * are skipped rather than throwing — a truncated write must not blind routing.
 *
 * @param {string} pool
 * @param {{dir?: string, sinceMs?: number|null}} [opts]
 * @returns {Array<{captured_at: string, capturedAtMs: number}>}
 */
export function readMeterHistory(pool, opts = {}) {
  const { dir = metersDir(), sinceMs = null } = opts;
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
    out.push({ ...entry, capturedAtMs });
  }
  out.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  return out;
}

export { FRESH_MS, STALE_MS };
