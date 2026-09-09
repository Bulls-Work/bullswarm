// bullswarm meters — live subscription usage per pool.
//
// Doctrine:
//   M1. Numbers come from the PROVIDER, never from session logs or
//       declarations when a reader exists. Declared meters are the last
//       resort and are labeled as such.
//   M2. elapsed% derives from the provider's resets_at minus the window
//       length — never from a locally assumed window start.
//   M3. Weekly/monthly windows pace routing; 5h windows are gates only
//       (they never pace): >= BURST_BLOCK_PCT blocks dispatch outright and
//       >= FIVE_HOUR_NEAR_LIMIT_PCT deprioritizes the pool while any pool
//       with 5h headroom is eligible. WHICH of weekly/monthly paces one pool
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
 *   - burst gate = 5h utilization >= BURST_BLOCK_PCT blocks dispatch
 *   - near limit  = 5h utilization >= FIVE_HOUR_NEAR_LIMIT_PCT: still
 *     dispatchable, but routing prefers any pool with 5h headroom
 *
 * `pacingWindow` on the result names the window the numbers actually came
 * from ('weekly' | 'monthly' | null) — which is the requested one only when
 * the provider reported it.
 *
 * @param {object|null} snapshot
 * @param {number} [nowMs]
 * @param {{pacingWindow?: string|null}} [opts]
 */
export const BURST_BLOCK_PCT = 90;
/** 5h utilization at/above which routing treats a pool as near its limit. */
export const FIVE_HOUR_NEAR_LIMIT_PCT = 75;

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

  const windows = {};
  for (const kind of ['five_hour', 'seven_day', 'monthly']) {
    const w = snapshot[kind];
    if (!w || w.utilization == null) continue;
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
  const fiveHourUsed = snapshot.five_hour?.utilization;
  const fiveHourUsedPct = Number.isFinite(fiveHourUsed) ? fiveHourUsed : null;
  const burstGate = fiveHourUsedPct != null && fiveHourUsedPct >= BURST_BLOCK_PCT;
  // resets_at is reported straight from the snapshot (M2): no reading, no
  // deadline — never a locally assumed one.
  const fiveHourResetsMs = snapshot.five_hour?.resets_at
    ? Date.parse(snapshot.five_hour.resets_at)
    : NaN;

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
 * The paced window out of a `windows` map, honouring the pool's declared
 * window and falling back to the other one when the provider did not report
 * the declared one (a reading with only a weekly window still paces).
 *
 * @param {{seven_day?: object|null, monthly?: object|null}} windows
 * @param {string|null} [requested]
 * @returns {{pacing: object|null, window: 'weekly'|'monthly'|null}}
 */
export function pickPacingWindow(windows = {}, requested = null) {
  const order = normalizePacingWindow(requested) === 'monthly'
    ? [['monthly', 'monthly'], ['seven_day', 'weekly']]
    : [['seven_day', 'weekly'], ['monthly', 'monthly']];
  for (const [key, name] of order) {
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

// --- snapshot cache ---------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** How old a cached reading may be before we re-poll (fleetlens cadence). */
export const FRESH_MS = 5 * 60_000;
/** Beyond this age the reading is labeled stale in output. */
export const STALE_MS = 60 * 60_000;

export class MeterCache {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(pool) {
    return join(this.dir, `${pool}.json`);
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
