// Per-dispatch pool refresh.
//
// A run used to dispatch from the pool list built once at launch: meters and
// quarantines observed minutes or hours earlier. A pool that hit its 5h limit
// mid-run stayed a first-class candidate, so the run kept sending work to a
// provider that could only fail. The refresher rebuilds the same list the
// launch path builds, cheaply enough to call before every dispatch:
//
//   - cache-first (registry): a reading younger than FRESH_MS costs no network
//   - throttled: an unforced rebuild inside minIntervalMs reuses the last list
//   - forced (`{ force: true }`, used right after a quota failure) polls live
//   - never throws: on any failure the last good list is returned unchanged
//
// buildPools is the sole source of the launch-time pool shape (workflow/cli.js
// `livePoolNames` returns its output verbatim), so a rebuilt list is
// interchangeable with the one the kernel received.

import { buildPoolsLive as defaultBuildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';

/** Default: rebuild at most once every 15s unless forced. */
export const DEFAULT_REFRESH_INTERVAL_MS = 15_000;

export function createPoolRefresher({
  bullswarmDir,
  initialPools = [],
  now = Date.now,
  buildPoolsLive = defaultBuildPoolsLive,
  getReadings = getAllMeterReadings,
  minIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
} = {}) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) {
    throw new TypeError('bullswarmDir is required');
  }
  let lastPools = Array.isArray(initialPools) ? initialPools : [];
  let lastAtMs = null;
  let inFlight = null;
  let inFlightForced = false;

  async function refreshPools({ force = false } = {}) {
    // Concurrent actions share one rebuild. A forced call never settles for an
    // unforced poll already in flight — it is the post-quota-failure path and
    // has to see live numbers.
    if (inFlight && (inFlightForced || !force)) return inFlight;
    const at = Number(now());
    const atMs = Number.isFinite(at) ? at : Date.now();
    if (!force && lastAtMs != null && atMs - lastAtMs < minIntervalMs) return lastPools;

    const attempt = (async () => {
      // Throttle the next rebuild whether this one succeeds or fails: a broken
      // reader must not be re-polled on every loop iteration.
      lastAtMs = atMs;
      try {
        const built = await buildPoolsLive(bullswarmDir, atMs, { force, getReadings });
        const pools = Array.isArray(built) ? built : built?.pools;
        if (Array.isArray(pools)) lastPools = pools;
      } catch {
        // A refresh failure is never fatal: the run keeps dispatching from the
        // last list that was known good.
      }
      return lastPools;
    })();
    inFlight = attempt;
    inFlightForced = force;
    try {
      return await attempt;
    } finally {
      if (inFlight === attempt) { inFlight = null; inFlightForced = false; }
    }
  }

  return refreshPools;
}
