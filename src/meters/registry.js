// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import {
  MeterCache, paceSnapshot, FRESH_MS, STALE_MS, WINDOW_MS,
  normalizePacingWindow, meterResolutionPct, monotonicIntervalDelta, refusalResetKnown,
} from './framework.js';
import { loadProviders, providerFor } from '../lib/providers.js';
import { migratePoolNameHome } from '../lib/state.js';

export const METERS_DIR = () =>
  process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');

/**
 * Directory of meter snapshots written by an external sampler (meterd), from
 * env BULLSWARM_METER_SNAPSHOT_DIR. One JSON file per pool:
 * `<dir>/<pool>.json`, the shape `readUsage` returns (`captured_at`,
 * `five_hour`, `seven_day`, `monthly`) plus the sampler's `error`/`state`.
 * A file younger than SNAPSHOT_FRESH_MS answers an unforced read without a
 * provider call; a missing, undated or older file falls back to the
 * cache-first live path, whose provider call is single-flight per pool.
 */
export const SNAPSHOT_FRESH_MS = 10 * 60_000;

export function meterSnapshotDir() {
  const raw = process.env.BULLSWARM_METER_SNAPSHOT_DIR;
  const dir = typeof raw === 'string' ? raw.trim() : '';
  return dir || null;
}

function readSnapshotFile(dir, pool) {
  try {
    const snapshot = JSON.parse(readFileSync(join(dir, `${pool}.json`), 'utf8'));
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

const SNAPSHOT_WINDOWS = ['five_hour', 'seven_day', 'monthly'];

function windowUsable(window, nowMs) {
  if (!window || typeof window !== 'object') return false;
  const reset = Date.parse(window.resets_at ?? '');
  return Number.isFinite(Number(window.utilization)) && Number.isFinite(reset) && reset > nowMs;
}

/**
 * A reading from a sampler file, or null when the file cannot answer (absent,
 * undated, older than SNAPSHOT_FRESH_MS, or older than a quota refusal this
 * home recorded, which stays the stronger evidence). A status-line sample can
 * omit a window the pool has (seen: `seven_day` missing for some sessions);
 * dropping it would make a weekly seat look 5h-only, so a window the file
 * lacks is taken from this home's cache while that window has not reset.
 */
function snapshotReading(external, cached, nowMs) {
  if (!external) return null;
  const capturedMs = Date.parse(external.captured_at ?? '');
  if (!Number.isFinite(capturedMs)) return null;
  const ageMs = nowMs - capturedMs;
  if (ageMs > SNAPSHOT_FRESH_MS) return null;
  const refusal = quotaRefusalOf(cached);
  if (refusal && Date.parse(refusal.refusedAt ?? '') > capturedMs) return null;
  const snapshot = { ...external };
  const filled = [];
  for (const key of SNAPSHOT_WINDOWS) {
    if (snapshot[key] && typeof snapshot[key] === 'object') continue;
    if (windowUsable(cached?.[key], nowMs)) {
      snapshot[key] = { ...cached[key], source: 'cache' };
      filled.push(key);
    }
  }
  if (filled.length) snapshot.filled_from_cache = filled;
  const meterError = typeof external.error === 'string' && external.error.trim()
    ? external.error.trim()
    : null;
  return {
    snapshot,
    source: 'snapshot',
    ageMs: Math.max(0, ageMs),
    ...(meterError ? { meterError } : {}),
    ...(meterError && /^401\b|sign-in/i.test(meterError) ? { signInFailed: true } : {}),
    ...paceSnapshot(snapshot, nowMs),
  };
}

// --- single-flight provider reads -----------------------------------------

/** A lock older than this, or held by a dead pid, is taken over. */
const FETCH_LOCK_STALE_MS = 90_000;
/** How long a caller waits for another process's provider read. */
const FETCH_LOCK_WAIT_MS = 60_000;
const FETCH_LOCK_POLL_MS = 150;
/** A forced read accepts a reading another process took this recently. */
export const FORCED_SHARE_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Take `<meters>/<pool>.fetch.lock` (O_EXCL). Returns { waited, release }:
 * `waited` is true when another process held it first, so the caller should
 * look for that process's reading before calling the provider itself.
 * `timedOut` means the holder never finished; the caller then reads without
 * the lock rather than hang.
 */
async function acquireFetchLock(dir, pool) {
  const path = join(dir, `${pool}.fetch.lock`);
  const started = Date.now();
  let waited = false;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return { waited, release() { try { unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { waited, release() {} };
    }
    let holder = null;
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
      holder = JSON.parse(readFileSync(path, 'utf8'));
    } catch { /* removed or half-written: look again */ }
    if (ageMs > FETCH_LOCK_STALE_MS || (holder && !pidAlive(Number(holder.pid)))) {
      try { unlinkSync(path); } catch { /* someone else took it over */ }
      continue;
    }
    if (Date.now() - started > FETCH_LOCK_WAIT_MS) return { waited: true, timedOut: true, release() {} };
    waited = true;
    await sleep(FETCH_LOCK_POLL_MS);
  }
}

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

/**
 * Whether a failed meter read says the pool's sign-in is dead: an HTTP 401,
 * or an error its provider marked `signInFailed` (a 403 whose body or code is
 * an auth error, in the provider's own wording). A 429 or a network error is
 * not one.
 */
export function meterSignInFailed(error) {
  return error?.signInFailed === true || Number(error?.status) === 401;
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
  if (hold?.sign_in_failed === true || error.status === 401) error.signInFailed = true;
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
    ...(meterSignInFailed(error) ? { sign_in_failed: true } : {}),
  };
}

function decorateError(error, hold, holdUntil) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error.holdUntil = holdUntil;
    error.meterError = typeof hold?.reason === 'string' ? hold.reason : meterErrorText(error);
    if (hold?.sign_in_failed === true) error.signInFailed = true;
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
    // named | measured | guessed; a marker written before this was recorded
    // has none, and routing reads it as guessed (framework.js refusalResetKnown).
    resetSource: typeof marker.reset_source === 'string' ? marker.reset_source : null,
    window,
    reason: typeof marker.reason === 'string' ? marker.reason : null,
  };
}

function readingWithMarker(result, snapshot = result?.snapshot) {
  const marker = quotaRefusalOf(snapshot);
  return marker ? { ...result, source: 'quota-refusal', quotaRefusal: marker } : result;
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
    ...(meterSignInFailed(error) ? { signInFailed: true } : {}),
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

  // An external sampler owns the network read: a fresh file answers an
  // unforced read with no provider call. A forced read (an attempt's start
  // or end, a quota refusal, `pools --force`) still goes live below, where
  // parallel callers share one provider call.
  const snapshotDir = force ? null : meterSnapshotDir();
  if (snapshotDir) {
    const fromSnapshot = snapshotReading(readSnapshotFile(snapshotDir, pool), cached, nowMs);
    if (fromSnapshot) return fromSnapshot;
  }

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

  // Single flight: one process per pool calls the provider at a time. A
  // caller that waited takes the reading (or the hold) that process left
  // instead of calling again, and a forced read shares a reading taken in the
  // last FORCED_SHARE_MS: ten attempts starting together make one call.
  const lock = opts.singleFlight === false
    ? { waited: false, release() {} }
    : await acquireFetchLock(cache.dir, pool);
  try {
    const shared = sharedReading(cache, pool, cached, {
      force, nowMs, waited: lock.waited, shareMs: opts.shareMs ?? FORCED_SHARE_MS,
    });
    if (shared) return shared;
    try {
      let rawSnapshot;
      try {
        rawSnapshot = await reader();
        logMeterRead(cache.dir, pool, { force, ok: true });
      } catch (readErr) {
        logMeterRead(cache.dir, pool, { force, ok: false, error: meterErrorText(readErr) });
        throw readErr;
      }
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
  } finally {
    lock.release();
  }
}

/**
 * What a caller that reached the provider lock can use without a provider
 * call: a reading another process stored since this caller first looked, a
 * hold another process stored while this caller waited, or (forced) a reading
 * no older than shareMs. Null means call the provider.
 */
function sharedReading(cache, pool, cachedBefore, { force, nowMs, waited, shareMs }) {
  const after = cache.get(pool);
  const afterMs = Date.parse(after?.captured_at ?? '');
  const beforeMs = Date.parse(cachedBefore?.captured_at ?? '');
  const changed = Number.isFinite(afterMs) && (!Number.isFinite(beforeMs) || afterMs > beforeMs);
  if (waited) {
    const hold = cache.getHold(pool);
    const holdUntil = holdUntilOf(hold);
    if (holdUntil != null && nowMs < holdUntil && !changed) {
      const error = decorateError(errorFromHold(hold), hold, holdUntil);
      if (cachedBefore) return { ...staleResult(cachedBefore, nowMs, error, holdUntil, hold.reason), shared: true };
      throw error;
    }
  }
  if (!after || !Number.isFinite(afterMs)) return null;
  const ageMs = nowMs - afterMs;
  const usable = changed || (force ? shareMs > 0 && ageMs <= shareMs : ageMs <= FRESH_MS);
  if (!usable) return null;
  // A forced caller asked for a provider observation; a reading another
  // process just took is one, so it is reported as live (watch.js accepts
  // only live/forced as the attempt's start/end reading).
  return readingWithMarker({
    snapshot: after,
    source: force ? 'live' : 'cache',
    shared: true,
    ageMs: Math.max(0, ageMs),
    ...paceSnapshot(after, nowMs),
  }, after);
}

/**
 * One line per provider usage call in `<meters>/reads.jsonl`, so the load a
 * fleet puts on a usage endpoint can be counted. Kept to the last
 * READ_LOG_KEEP lines; best effort, never blocks a read.
 */
const READ_LOG_KEEP = 20_000;
export function logMeterRead(dir, pool, { force = false, ok = true, error = null } = {}) {
  try {
    const path = join(dir, 'reads.jsonl');
    const line = JSON.stringify({
      at: new Date().toISOString(), pool, pid: process.pid, force, ok, ...(error ? { error } : {}),
    });
    appendFileSync(path, `${line}\n`);
    if (Math.random() < 0.01) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      if (lines.length > READ_LOG_KEEP) writeFileSync(path, `${lines.slice(-READ_LOG_KEEP).join('\n')}\n`);
    }
  } catch { /* counting is never a precondition for reading */ }
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

/**
 * The next reset of a window nobody named, and where it came from: the last
 * reading's own reset while it is still ahead is `measured` (a reading of this
 * window said so; a marker's reset keeps the source it was written with).
 * Rolled forward from a reading whose reset passed, or a whole window from
 * now with no reading at all, it is `guessed`, and routing does not count a
 * guessed marker (framework.js windowSpent).
 */
function nextResetForWindow(windowKey, prior, nowMs) {
  const info = QUOTA_WINDOWS[windowKey] ?? QUOTA_WINDOWS.seven_day;
  const entry = prior?.[windowKey];
  let reset = finiteMs(entry?.resets_at);
  if (reset != null && reset > nowMs) {
    const known = entry?.source !== 'quota-refusal' || refusalResetKnown(entry);
    return {
      resetsAtMs: reset,
      resetSource: !known ? 'guessed' : entry?.source === 'quota-refusal' ? entry.reset_source : 'measured',
    };
  }
  if (reset != null) {
    for (let count = 0; count < 2400 && reset <= nowMs; count += 1) {
      reset = windowKey === 'monthly' ? addCalendarMonth(reset) : reset + info.ms;
    }
    if (reset > nowMs) return { resetsAtMs: reset, resetSource: 'guessed' };
  }
  return {
    resetsAtMs: windowKey === 'monthly' ? addCalendarMonth(nowMs) : nowMs + info.ms,
    resetSource: 'guessed',
  };
}

function quotaRefusalSnapshot(pool, {
  cached, connector, subscription, nowMs, resetAtMs, resetSource = 'named', reason,
} = {}) {
  const windowKey = quotaWindowFor(cached, connector, subscription);
  const info = QUOTA_WINDOWS[windowKey] ?? QUOTA_WINDOWS.seven_day;
  const knownReset = finiteMs(resetAtMs);
  const next = knownReset != null && knownReset > nowMs
    ? { resetsAtMs: knownReset, resetSource: resetSource === 'measured' ? 'measured' : 'named' }
    : nextResetForWindow(windowKey, cached, nowMs);
  const resetsAt = new Date(next.resetsAtMs).toISOString();
  const refusedAt = new Date(nowMs).toISOString();
  const snapshot = cached && typeof cached === 'object' ? { ...cached } : {};
  snapshot.pool ??= pool;
  snapshot.captured_at = refusedAt;
  snapshot.source = 'quota-refusal';
  snapshot.quota_refusal = {
    source: 'quota-refusal',
    refused_at: refusedAt,
    resets_at: resetsAt,
    reset_source: next.resetSource,
    window: info.name,
    reason: reason ? String(reason).slice(0, 300) : null,
  };
  snapshot[windowKey] = {
    ...(snapshot[windowKey] && typeof snapshot[windowKey] === 'object' ? snapshot[windowKey] : {}),
    utilization: 100,
    resets_at: resetsAt,
    source: 'quota-refusal',
    reset_source: next.resetSource,
  };
  return { snapshot, marker: quotaRefusalOf(snapshot), windowKey };
}

/**
 * Refresh a pool immediately after a quota refusal. The forced read bypasses
 * FRESH_MS. A live reading wins and naturally replaces any prior marker; when
 * the reader is absent or fails, the refusal is persisted as a synthetic 100%
 * reading for the shortest available window so stale low usage cannot route
 * another attempt back to the refused pool. `resetAtMs` is the limit's known
 * reset and `resetSource` how it is known: `named` (the provider's notice,
 * the default) or `measured` (a meter reading). With neither the marker's
 * reset is guessed, and the marker then keeps no pool out
 * (framework.js windowSpent).
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
      // A reading from before the refusal must not stand in for one after it.
      shareMs: 0,
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
    resetSource: opts.resetSource ?? 'named',
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
          ...(meterSignInFailed(err) ? { signInFailed: true } : {}),
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

function historyDayKeyFor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return historyDayKey(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return historyDayKey(value.getTime());
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? historyDayKey(parsed) : text;
}

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
