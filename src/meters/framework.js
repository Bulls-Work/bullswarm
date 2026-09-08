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
//       with 5h headroom is eligible.
//   M4. Readers fail closed: an unreadable response is an error, not a
//       zero. A stale cached reading is shown with its age.
//   M5. Auth tokens are read from each CLI's native store; refresh
//       write-back is best-effort so the CLI keeps working.

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

/**
 * Pace a snapshot per doctrine M3:
 *   - pacing window = weekly ?? monthly ?? none (never 5h)
 *   - burst gate = 5h utilization >= BURST_BLOCK_PCT blocks dispatch
 *   - near limit  = 5h utilization >= FIVE_HOUR_NEAR_LIMIT_PCT: still
 *     dispatchable, but routing prefers any pool with 5h headroom
 */
export const BURST_BLOCK_PCT = 90;
/** 5h utilization at/above which routing treats a pool as near its limit. */
export const FIVE_HOUR_NEAR_LIMIT_PCT = 75;

export function paceSnapshot(snapshot, nowMs = Date.now()) {
  if (!snapshot) {
    return {
      pacing: null,
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

  const pacing = windows.seven_day ?? windows.monthly ?? null;
  const fiveHourUsed = snapshot.five_hour?.utilization;
  const fiveHourUsedPct = Number.isFinite(fiveHourUsed) ? fiveHourUsed : null;
  const burstGate = fiveHourUsedPct != null && fiveHourUsedPct >= BURST_BLOCK_PCT;
  // resets_at is reported straight from the snapshot (M2): no reading, no
  // deadline — never a locally assumed one.
  const fiveHourResetsMs = snapshot.five_hour?.resets_at
    ? Date.parse(snapshot.five_hour.resets_at)
    : NaN;

  return {
    pacing,
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
