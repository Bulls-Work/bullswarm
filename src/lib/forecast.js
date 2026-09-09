// Forecast attachment — the one seam where the in-flight ledger and the spend
// model meet a pool list before routing reads it.
//
// Three pieces were built separately and only mean something together:
//   - src/lib/assignments.js knows WHAT is running right now (cross-process).
//   - src/lib/spend.js knows HOW FAST a pool burns its window and HOW LONG an
//     assignment on a lane/effort pair usually runs.
//   - src/lib/route.js (R8) routes on the forecast those two produce.
//
// Every pick site (`bullswarm run`, the V1 runtime, the V2 dispatcher,
// `bullswarm pools`, the strategy preview) calls attachForecast on its pool
// list immediately before pickPool, so the numbers routing sees are the
// numbers the ledger holds at that instant — not the ones the throttled meter
// refresh happened to capture up to 15 seconds earlier.
//
// Doctrine:
//   F1. Attachment is a read, never a write. It registers nothing, logs
//       nothing, and polls no provider, so a preview (`run --dry-run`,
//       `bullswarm pools`) can show the same forecast a real dispatch routes
//       on without leaving a trace.
//   F2. Attachment never fails a dispatch. An unreadable ledger or an
//       unusable history log costs load visibility, not the user's work: the
//       pools come back with whatever could be attached, and routing degrades
//       to exactly its pre-forecast behaviour.
//   F3. The candidate's expected duration and the ledger record's
//       expectedMinutes are the SAME number from the SAME call. Routing must
//       book the assignment for the duration the ledger will then advertise
//       to every other process.

import { join } from 'node:path';
import { attachInflight, withLedger } from './assignments.js';
import { attachSpend } from './spend.js';
import { DEFAULT_INFLIGHT_PENALTY_PCT } from './route.js';

/**
 * The meters directory for a home — `<BULLSWARM_HOME>/meters`.
 *
 * This is what spend.js's `historyDir` option wants: it is handed straight to
 * registry.js `readMeterHistory({dir})`, which appends `history/<pool>.jsonl`
 * itself. Passing the history directory here would look for the log one level
 * too deep and silently read an empty series — every rate would quietly
 * degrade to bootstrap. Resolved from the caller's bullswarmDir rather than
 * the default env lookup, because the V2 kernel is handed its home explicitly.
 */
export function poolMetersDir(bullswarmDir) {
  return join(bullswarmDir, 'meters');
}

/**
 * Stamp `inflight`, `spend` and `projected*Pct` onto pool views in place.
 *
 * @param {Array<object>} pools        buildPools/buildPoolsLive views (mutated)
 * @param {string} bullswarmDir        BULLSWARM_HOME
 * @param {{now?: number, decisionLog?: Array<object>}} [opts]
 * @returns {Array<object>} the same pools
 */
export function attachForecast(pools, bullswarmDir, opts = {}) {
  const list = Array.isArray(pools) ? pools : [];
  if (!list.length || typeof bullswarmDir !== 'string' || !bullswarmDir) return list;
  const now = opts.now ?? Date.now();
  const decisionLog = Array.isArray(opts.decisionLog) ? opts.decisionLog : [];
  // F2: each half is independently best-effort. A broken ledger still leaves
  // real spend rates attached, and a broken history log still leaves real
  // in-flight counts.
  withLedger(() => attachInflight(list, bullswarmDir, { now }));
  try {
    attachSpend(list, {
      historyDir: poolMetersDir(bullswarmDir),
      decisionLog,
      nowMs: now,
    });
  } catch { /* F2: a forecast is an optimization, never a precondition */ }
  return list;
}

/**
 * The flat surplus points charged per in-flight agent when no spend rate is
 * known for the pool's pacing window, from core state when an operator
 * configured one.
 * `config.inflightPenaltyPct: 0` disables the tie-breaker entirely; anything
 * unusable falls back to route.js's documented default.
 */
export function inflightPenaltyFrom(state) {
  const raw = state?.config?.inflightPenaltyPct;
  if (raw == null || raw === '' || typeof raw === 'boolean') return DEFAULT_INFLIGHT_PENALTY_PCT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INFLIGHT_PENALTY_PCT;
}

/**
 * The forecast a pick was actually made on, for the decision log and the
 * attempt record. Read back off the winning candidate row so the recorded
 * numbers are the ones pickPool compared, never a second computation that
 * could disagree with them.
 *
 * @param {object} route      pickPool result
 * @param {string} poolName   the pool that won
 * @returns {{inflight: number, projectedFiveHourPct: number|null,
 *            forecastFiveHourPct: number|null, ratePerMinute: number|null,
 *            estimateSource: string|null, expectedMinutes: number|null}}
 */
export function forecastRecord(route, poolName) {
  const row = (route?.candidates ?? []).find((c) => c.pool === poolName) ?? null;
  return {
    inflight: row?.inflight ?? 0,
    projectedFiveHourPct: row?.projectedFiveHourPct ?? null,
    forecastFiveHourPct: row?.forecastFiveHourPct ?? null,
    ratePerMinute: row?.ratePerMinute ?? null,
    estimateSource: row?.estimateSource ?? null,
    expectedMinutes: route?.forecast?.candidateMinutes ?? null,
  };
}
