// bullswarm meters — live subscription usage per pool.
//
// Doctrine:
//   M1. Numbers come from the PROVIDER, never from session logs or
//       declarations when a reader exists. Declared meters are the last
//       resort and are labeled as such.
//   M2. elapsed% derives from the provider's resets_at minus the window
//       length — never from a locally assumed window start. A provider that
//       reports usage but no reset (the Relay wallets since 2026-09-03) may
//       be paced from a reset the OPERATOR declared (`strategy
//       set-subscription <pool> --resets-at`), rolled forward one window at
//       a time once it passes; that pacing is labeled `declared-reset`
//       wherever it shows (declaredResetPacing below).
//   M3. Weekly/monthly windows pace routing; 5h windows are gates only
//       (they never pace): a 100% reading blocks dispatch outright and
//       >= FIVE_HOUR_NEAR_LIMIT_PCT is a soft last-mile ordering penalty while
//       another eligible pool is behind pace. WHICH of weekly/monthly paces one pool
//       is the pool's own subscription window (`quotaWindow`), not a global
//       preference: command-code buys a monthly credit allocation and only
//       rate-limits weekly, so pacing it by its weekly window sends work to a
//       pool whose real budget is already overspent.
//   M4. Readers fail closed: an unreadable response is an error, not a
//       zero. A stale cached reading is shown with its age.
//   M5. Auth tokens are read from each CLI's native store; refresh
//       write-back is best-effort so the CLI keeps working.

// One strict numeric coercion for the whole codebase (src/lib/num.js): a
// missing measurement stays null instead of becoming a confident zero.
import { finiteOrNull as numberOrNull } from '../lib/num.js';

export const WINDOW_MS = {
  '5h': 5 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

/** Compute pace for one window from a provider reading. */
export function windowPace({ usedPct, resetsAtMs, windowMs, nowMs = Date.now() }) {
  if (![usedPct, resetsAtMs, windowMs].every(Number.isFinite) || windowMs <= 0) {
    return null;
  }
  const startMs = resetsAtMs - windowMs;
  const elapsedPct = Math.max(0, Math.min(100, ((nowMs - startMs) / windowMs) * 100));
  const used = Math.max(0, Math.min(100, usedPct));
  return {
    usedPct: Math.round(used * 10) / 10,
    elapsedPct: Math.round(elapsedPct * 10) / 10,
    // surplus = elapsed − used; higher = more quota expiring unspent.
    surplus: Math.round((elapsedPct - used) * 10) / 10,
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}

/** The two windows that may pace a pool. 5h is never one of them (M3). */
export const PACING_WINDOWS = ['weekly', 'monthly'];

/**
 * A quota-window label as pacing understands it, or null.
 *
 * Labels are free text on disk — `strategy set-subscription --quota-window`
 * has always written whatever it was handed, and connectors describe meters
 * with strings like "weekly+monthly+5h". Anything that is not exactly one
 * pacing window is null: unknown, so pacing keeps its default order rather
 * than guessing which window an operator meant.
 */
export function normalizePacingWindow(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return PACING_WINDOWS.includes(name) ? name : null;
}

/**
 * The window a pool's quota actually lives in: the operator's stored
 * subscription first (`state.strategy.subscriptions[pool].quotaWindow`), then
 * the connector's declaration (`connector.subscription.quotaWindow`).
 *
 * Precedence is by VALUE, not by validity: a stored label the operator set
 * wins over the connector's even when it is unrecognised, and an unrecognised
 * label resolves to null (today's default order) rather than silently falling
 * through to a window the operator did not choose. `strategy set-subscription`
 * now rejects labels that are neither, so only pre-0.28.1 state can hold one.
 *
 * @param {{connector?: object|null, subscription?: object|null}} [pool]
 * @returns {'weekly'|'monthly'|null}
 */
export function pacingWindowFor({ connector = null, subscription = null } = {}) {
  const declared = subscription?.quotaWindow ?? connector?.subscription?.quotaWindow ?? null;
  return normalizePacingWindow(declared);
}

/**
 * Pace a snapshot per doctrine M3:
 *   - pacing window = the pool's own subscription window when it declares one
 *     ('monthly' → monthly ?? weekly, 'weekly' → weekly ?? monthly), else the
 *     default order weekly ?? monthly ?? none. Never 5h.
 *   - burst gate = the 5h window at its limit (atLimit) blocks dispatch;
 *     windowSpent applies the same rule to the weekly and monthly windows
 *   - near limit  = 5h utilization >= FIVE_HOUR_NEAR_LIMIT_PCT: still
 *     dispatchable; routing applies a soft last-mile ordering penalty when
 *     another eligible pool is behind pace
 *
 * `pacingWindow` on the result names the window the numbers actually came
 * from ('weekly' | 'monthly' | null) — which is the requested one only when
 * the provider reported it.
 *
 * @param {object|null} snapshot
 * @param {number} [nowMs]
 * @param {{pacingWindow?: string|null}} [opts]
 */
/** A metered window is at its limit at the wall, not before it. */
export const BURST_BLOCK_PCT = 100;
/** 5h utilization at/above which routing treats a pool as near its limit. */
export const FIVE_HOUR_NEAR_LIMIT_PCT = 75;

/**
 * Is one metered window at its limit? At/above BURST_BLOCK_PCT until its
 * reset: a reading whose reset has passed belongs to a window that is over,
 * and one that names no reset counts until the next reading replaces it.
 */
function atLimit(usedPct, resetsAt, nowMs) {
  const used = numberOrNull(usedPct);
  if (used == null || used < BURST_BLOCK_PCT) return false;
  const resetMs = resetMsOf(resetsAt);
  return !Number.isFinite(resetMs) || resetMs > nowMs;
}

/** Epoch ms of a reset given as ms or as an ISO string; NaN when absent. */
function resetMsOf(value) {
  return typeof value === 'number' ? value : Date.parse(String(value ?? ''));
}

/**
 * Is a quota-refusal marker's reset one somebody named or measured? The
 * marker (meters/registry.js) is the 100% window a forced meter read leaves
 * behind when it fails after a usage limit. Its reset is `named` (the
 * provider's notice said when), `measured` (a meter reading of that window
 * said when), or `guessed` (the last reading rolled forward, or a whole
 * window from now). A marker written before this was recorded says nothing,
 * and counts as guessed.
 */
export function refusalResetKnown(marker) {
  const source = marker?.reset_source ?? marker?.resetSource ?? null;
  return source === 'named' || source === 'measured';
}

/**
 * A window the refusal marker filled in with a guessed reset: it is not a
 * reading, and it never keeps a pool out. Without this a pool with no meter
 * reader was shut out for up to 7 days (or a month) after one limit notice
 * that named no reset, with nothing that could lift it.
 */
export function guessedRefusalWindow(entry) {
  return entry?.source === 'quota-refusal' && !refusalResetKnown(entry);
}

/**
 * The metered window a pool is at its limit on, or null: any window — 5-hour,
 * weekly or monthly — at its limit (atLimit) keeps the pool from being picked
 * until that window resets. The one rule every routing gate reads. Reads a
 * pool view as config.js builds it: `fiveHourUsedPct`/`fiveHourResetsAt` (a
 * hand-built view may set only `burstGate`), the pacing window's
 * `usedPct`/`paceResetsAt` under its `pacingWindow`, and `meterSnapshot` for
 * the rest. A declared meter is the operator's figure, not a reading, and
 * never counts; nor does a refusal marker's window whose reset was guessed
 * (guessedRefusalWindow). With several at their limit the one that resets
 * last is named, since the pool is back only then; one whose reset is
 * unknown outlasts any known reset.
 *
 * @returns {{window: '5-hour'|'weekly'|'monthly', resetsAt: string|null}|null}
 */
export function windowSpent(pool, nowMs = Date.now()) {
  if (!pool || typeof pool !== 'object') return null;
  const snapshot = pool.meterSnapshot && typeof pool.meterSnapshot === 'object' ? pool.meterSnapshot : {};
  const counts = (key) => !guessedRefusalWindow(snapshot[key]);
  const fiveHourUsed = pool.fiveHourUsedPct ?? snapshot.five_hour?.utilization
    ?? (pool.burstGate === true ? BURST_BLOCK_PCT : null);
  const readings = [
    ...(counts('five_hour') ? [['5-hour', fiveHourUsed, pool.fiveHourResetsAt ?? snapshot.five_hour?.resets_at]] : []),
    ...(counts('seven_day') ? [['weekly', snapshot.seven_day?.utilization, snapshot.seven_day?.resets_at]] : []),
    ...(counts('monthly') ? [['monthly', snapshot.monthly?.utilization, snapshot.monthly?.resets_at]] : []),
  ];
  const pacing = normalizePacingWindow(pool.pacingWindow);
  if (pacing && pool.meterSource !== 'declared' && counts(pacing === 'monthly' ? 'monthly' : 'seven_day')) {
    readings.push([pacing, pool.usedPct, pool.paceResetsAt]);
  }
  let spent = null;
  for (const [window, usedPct, resetsAt] of readings) {
    if (!atLimit(usedPct, resetsAt, nowMs)) continue;
    const resetMs = resetMsOf(resetsAt);
    const at = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;
    if (!spent || (spent.resetsAt && (!at || at > spent.resetsAt))) spent = { window, resetsAt: at };
  }
  return spent;
}

export function paceSnapshot(snapshot, nowMs = Date.now(), opts = {}) {
  if (!snapshot) {
    return {
      pacing: null,
      pacingWindow: null,
      burstGate: false,
      windows: {},
      fiveHourUsedPct: null,
      fiveHourResetsAt: null,
      nearFiveHourLimit: false,
    };
  }

  // A refusal marker's window with a guessed reset is not a reading: the pool
  // is paced and gated as if that window had not been read at all.
  const windows = {};
  for (const kind of ['five_hour', 'seven_day', 'monthly']) {
    const w = snapshot[kind];
    if (!w || w.utilization == null || guessedRefusalWindow(w)) continue;
    const resetsAtMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
    const windowMs =
      kind === 'five_hour' ? WINDOW_MS['5h']
      : kind === 'monthly' ? monthlyWindowMs(resetsAtMs)
      : WINDOW_MS.weekly;
    windows[kind] = windowPace({
      usedPct: w.utilization,
      resetsAtMs,
      windowMs,
      nowMs,
    });
  }

  const chosen = pickPacingWindow(windows, opts.pacingWindow);
  const fiveHour = guessedRefusalWindow(snapshot.five_hour) ? null : snapshot.five_hour;
  const fiveHourUsed = fiveHour?.utilization;
  const fiveHourUsedPct = Number.isFinite(fiveHourUsed) ? fiveHourUsed : null;
  // resets_at is reported straight from the snapshot (M2): no reading, no
  // deadline — never a locally assumed one.
  const fiveHourResetsMs = fiveHour?.resets_at
    ? Date.parse(fiveHour.resets_at)
    : NaN;
  const burstGate = atLimit(fiveHourUsedPct, fiveHourResetsMs, nowMs);

  return {
    pacing: chosen.pacing,
    pacingWindow: chosen.window,
    burstGate,
    windows,
    fiveHourUsedPct,
    fiveHourResetsAt: Number.isFinite(fiveHourResetsMs)
      ? new Date(fiveHourResetsMs).toISOString()
      : null,
    nearFiveHourLimit:
      fiveHourUsedPct != null && fiveHourUsedPct >= FIVE_HOUR_NEAR_LIMIT_PCT,
  };
}

/**
 * The order windows are tried for pacing: the pool's declared window first,
 * the other one as fallback. Each entry is [snapshot key, window name].
 */
function pacingOrder(requested) {
  return normalizePacingWindow(requested) === 'monthly'
    ? [['monthly', 'monthly'], ['seven_day', 'weekly']]
    : [['seven_day', 'weekly'], ['monthly', 'monthly']];
}

/**
 * The paced window out of a `windows` map, honouring the pool's declared
 * window and falling back to the other one when the provider did not report
 * the declared one (a reading with only a weekly window still paces).
 *
 * @param {{seven_day?: object|null, monthly?: object|null}} windows
 * @param {string|null} [requested]
 * @returns {{pacing: object|null, window: 'weekly'|'monthly'|null}}
 */
export function pickPacingWindow(windows = {}, requested = null) {
  for (const [key, name] of pacingOrder(requested)) {
    const pacing = windows?.[key] ?? null;
    if (pacing) return { pacing, window: name };
  }
  return { pacing: null, window: null };
}

/**
 * Window names the spend model works in, mapped to where each one lives.
 *   - `snapshot`: the key a provider reading uses (`seven_day` for weekly)
 *   - `history`:  the key a history line uses (`weekly`)
 *   - `windowMs`: the window length, for deriving its start from resets_at
 *     (M2) — null for the monthly window, whose length is the calendar month
 *     ending at the provider's resets_at (monthlyWindowMs), not a constant.
 */
export const WINDOW_KEYS = {
  fiveHour: { snapshot: 'five_hour', history: 'five_hour', windowMs: WINDOW_MS['5h'] },
  weekly: { snapshot: 'seven_day', history: 'weekly', windowMs: WINDOW_MS.weekly },
  monthly: { snapshot: 'monthly', history: 'monthly', windowMs: null },
};

/**
 * Provider meter precision observed by the live readers.  The provider APIs
 * return JSON numbers, so notation such as `19.0` is lost by the time it
 * reaches the cache; keep the known provider quantisation here rather than
 * guessing that a parsed integer was an integer-percent meter.
 */
export const METER_RESOLUTION_PCT = Object.freeze({
  codex: 1,
  'claude-code': 0.1,
  grok: 0.1,
});

function providerNameOf(pool) {
  if (typeof pool !== 'string') return null;
  return pool.trim().toLowerCase().split(':', 1)[0] || null;
}

function decimalResolution(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = String(value).toLowerCase();
  if (text.includes('e-')) {
    const exponent = Number(text.split('e-')[1]);
    return Number.isFinite(exponent) ? 10 ** -exponent : null;
  }
  const dot = text.indexOf('.');
  if (dot < 0) return 1;
  return 10 ** -(text.length - dot - 1);
}

/**
 * Resolve the observed percentage-point resolution for one meter window.
 * Explicit metadata wins, then the provider evidence, then the precision
 * visible in the numeric reading.  Unknown precision is conservatively one
 * percentage point (the historical integer-meter default).
 */
export function meterResolutionPct({ pool = null, window = null, value = null, snapshot = null } = {}) {
  const windowName = typeof window === 'string'
    ? window
    : window?.name ?? window?.key ?? null;
  const metadata = window && typeof window === 'object'
    ? (window.resolution_pct ?? window.resolutionPct ?? window.resolution)
    : null;
  const snapshotMetadata = snapshot && typeof snapshot === 'object'
    ? (typeof snapshot.resolution_pct === 'object'
      ? snapshot.resolution_pct?.[windowName ?? '']
      : snapshot.resolution_pct
        ?? snapshot.resolutionPct)
    : null;
  const explicit = Number(metadata ?? snapshotMetadata);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const provider = providerNameOf(pool ?? snapshot?.pool);
  if (provider && Number.isFinite(METER_RESOLUTION_PCT[provider])) {
    return METER_RESOLUTION_PCT[provider];
  }
  return decimalResolution(value) ?? 1;
}

function resetIdentity(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(Math.floor(parsed / 1000) * 1000).toISOString();
}

/**
 * Compare consecutive readings from the same window without turning a reset,
 * missing poll, or counter decrease into spend.  The result is deliberately
 * small so it can be persisted in every history row and reused by ledger
 * attribution code.
 */
export function monotonicIntervalDelta(previous, current) {
  if (!previous || !current) return { deltaPct: null, reason: 'missing-reading' };
  const previousUsed = Number(previous.usedPct ?? previous.utilization);
  const currentUsed = Number(current.usedPct ?? current.utilization);
  if (!Number.isFinite(previousUsed) || !Number.isFinite(currentUsed)) {
    return { deltaPct: null, reason: 'missing-reading' };
  }
  const previousReset = resetIdentity(previous.resetsAt ?? previous.resets_at);
  const currentReset = resetIdentity(current.resetsAt ?? current.resets_at);
  if (previousReset !== currentReset
    && (previousReset != null || currentReset != null)) {
    return { deltaPct: null, reason: 'reset-between-readings' };
  }
  if (currentUsed < previousUsed) return { deltaPct: null, reason: 'counter-decreased' };
  return {
    deltaPct: Math.round((currentUsed - previousUsed) * 1e8) / 1e8,
    reason: null,
  };
}

// Names used by callers that describe the same operation in ledger terms.
export const meterIntervalDelta = monotonicIntervalDelta;
export const monotonicDelta = monotonicIntervalDelta;

/**
 * Forecast one window: where utilization lands once the work already running
 * (and, optionally, the assignment being routed) finishes at the measured
 * spend rate.
 *
 *   addedPct     = ratePerMinute × (inflightRemainingMinutes + candidateMinutes)
 *   projectedPct = clamp(usedPct + addedPct, 0, 100)
 *
 * Returns null when there is nothing real to project from: no utilization
 * reading at all, or minutes to charge but no measured rate to charge them at.
 * With zero minutes the forecast IS the reading — that is a measurement, not
 * an invention, so it is returned even when no rate is known.
 */
export function projectedUtilization({
  usedPct,
  ratePerMinute = null,
  inflightRemainingMinutes = 0,
  candidateMinutes = 0,
} = {}) {
  const used = numberOrNull(usedPct);
  if (used == null) return null;
  const minutes = Math.max(0, (numberOrNull(inflightRemainingMinutes) ?? 0)
    + (numberOrNull(candidateMinutes) ?? 0));
  const clampPct = (v) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
  if (minutes === 0) return { projectedPct: clampPct(used), addedPct: 0 };
  const rate = numberOrNull(ratePerMinute);
  if (rate == null || rate < 0) return null;
  return {
    projectedPct: clampPct(used + rate * minutes),
    addedPct: clampPct(rate * minutes),
  };
}

/** UTC calendar month ending at resetsAt (Copilot/cmd period-end semantics). */
export function monthlyWindowMs(resetsAtMs) {
  if (!Number.isFinite(resetsAtMs)) return NaN;
  const reset = new Date(resetsAtMs);
  const start = new Date(reset);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return Math.max(3600_000, reset.getTime() - start.getTime());
}

/** `date` moved by whole UTC calendar months, day-of-month clamped. */
function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  );
}

/**
 * The first occurrence of a declared reset anchor still ahead of `nowMs`: the
 * anchor itself while it has not passed, else the anchor stepped forward by
 * whole windows — 7 days for weekly, one UTC calendar month for monthly.
 * Months are counted from the anchor, not from the previous step, so a
 * 31st never drifts to the 28th. NaN when the anchor or window is unusable:
 * a reset that cannot be derived is not guessed (M2).
 */
export function rollResetForward(anchorMs, window, nowMs = Date.now()) {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) return NaN;
  const name = normalizePacingWindow(window);
  if (!name) return NaN;
  if (anchorMs > nowMs) return anchorMs;
  if (name === 'weekly') {
    const steps = Math.floor((nowMs - anchorMs) / WINDOW_MS.weekly) + 1;
    return anchorMs + steps * WINDOW_MS.weekly;
  }
  const anchor = new Date(anchorMs);
  // Bounded at two centuries so a corrupt anchor still terminates.
  for (let n = 1; n <= 2400; n += 1) {
    const candidate = addUtcMonths(anchor, n);
    if (candidate > nowMs) return candidate;
  }
  return NaN;
}

/**
 * Pace a snapshot whose provider reported utilization but NO reset for the
 * window, from a reset the operator declared (`strategy set-subscription
 * <pool> --resets-at`). The used% stays the provider's; only the window's end
 * is declared, and the result says so (`resetSource: 'declared'`) so every
 * view can label it. Windows are tried in the pool's pacing order; a window
 * the provider DID date is skipped — paceSnapshot already paced it and
 * provider truth wins (M1/M2). Null when nothing applies: no snapshot, no
 * declaration, no undated utilization.
 *
 * @param {object|null} snapshot
 * @param {{pacingWindow?: string|null, resetsAt?: string|null, nowMs?: number}} [opts]
 * @returns {{pacing: object, window: 'weekly'|'monthly', resetSource: 'declared'}|null}
 */
export function declaredResetPacing(snapshot, { pacingWindow = null, resetsAt = null, nowMs = Date.now() } = {}) {
  const anchorMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  if (!snapshot || !Number.isFinite(anchorMs)) return null;
  for (const [key, name] of pacingOrder(pacingWindow)) {
    const w = snapshot[key];
    const used = numberOrNull(w?.utilization);
    if (used == null || w?.resets_at) continue;
    const resetsAtMs = rollResetForward(anchorMs, name, nowMs);
    const windowMs = name === 'monthly' ? monthlyWindowMs(resetsAtMs) : WINDOW_MS.weekly;
    const pacing = windowPace({ usedPct: used, resetsAtMs, windowMs, nowMs });
    if (pacing) return { pacing, window: name, resetSource: 'declared' };
  }
  return null;
}

// --- snapshot cache ---------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** How old a cached reading may be before we re-poll (project-n cadence). */
export const FRESH_MS = 5 * 60_000;
/** Beyond this age the reading is labeled stale in output. */
export const STALE_MS = 60 * 60_000;

/**
 * Decode an HTTP Retry-After header into a duration. Providers pass either a
 * native Headers object or the lower-cased header map they already build.
 * A missing or malformed header is null so the meter registry can use its
 * named FRESH_MS fallback instead.
 */
export function retryAfterMsFromHeaders(headers, nowMs = Date.now()) {
  if (!headers) return null;
  let raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : headers['retry-after'] ?? headers['Retry-After'];
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && Number.isFinite(nowMs)
    ? Math.max(0, retryAt - nowMs)
    : null;
}

export class MeterCache {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(pool) {
    return join(this.dir, `${pool}.json`);
  }

  #holdPath(pool) {
    return join(this.dir, `${pool}.hold.json`);
  }

  get(pool) {
    const p = this.#path(pool);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  put(pool, snapshot) {
    writeFileSync(this.#path(pool), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  /** The persisted negative-cache hold for a pool, or null when absent. */
  getHold(pool) {
    const p = this.#holdPath(pool);
    if (!existsSync(p)) return null;
    try {
      const hold = JSON.parse(readFileSync(p, 'utf8'));
      if (!hold || typeof hold !== 'object') return null;
      return hold;
    } catch {
      return null;
    }
  }

  /** Persist a failed poll's hold beside the latest snapshot. */
  putHold(pool, hold) {
    writeFileSync(this.#holdPath(pool), `${JSON.stringify(hold, null, 2)}\n`);
  }

  /** A successful live read releases any previous negative-cache hold. */
  clearHold(pool) {
    try {
      unlinkSync(this.#holdPath(pool));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Fresh reading or null. A reading is fresh if its captured_at is within
   * FRESH_MS of now — otherwise callers should re-poll (and fall back to
   * showing the stale value with its age on failure).
   */
  fresh(pool, nowMs = Date.now()) {
    const s = this.get(pool);
    if (!s?.captured_at) return null;
    const ms = Date.parse(s.captured_at);
    if (!Number.isFinite(ms)) return null;
    return nowMs - ms <= FRESH_MS ? s : null;
  }
}
