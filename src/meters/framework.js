// bullswarm meters — live subscription usage per pool.
//
// Doctrine:
//   M1. Numbers come from the PROVIDER, never from session logs or
//       declarations when a reader exists. Declared meters are the last
//       resort and are labeled as such.
//   M2. elapsed% derives from the provider's resets_at minus the window
//       length — never from a locally assumed window start.
//   M3. Weekly/monthly windows pace routing; 5h windows are burst gates
//       only (block dispatch near exhaustion, never pace by them).
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
 */
export const BURST_BLOCK_PCT = 90;

export function paceSnapshot(snapshot, nowMs = Date.now()) {
  if (!snapshot) return { pacing: null, burstGate: false, windows: {} };

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
  const burstGate =
    Number.isFinite(fiveHourUsed) && fiveHourUsed >= BURST_BLOCK_PCT;

  return { pacing, burstGate, windows };
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

/** How old a cached reading may be before we re-poll (project-n cadence). */
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
