// bullswarm spend model — how fast a pool burns its window, from real records.
//
// Doctrine (extends the meter doctrine in src/meters/framework.js):
//   S1. Every number here is derived from something that was recorded: two
//       meter readings and the worker-minutes dispatched between them, or a
//       decision-log attempt with a real wall time. Nothing is assumed.
//   S2. Every estimate carries its basis — `source: history | bootstrap |
//       default` plus the sample count behind it. A caller that cannot see
//       the basis cannot tell a measurement from a guess.
//   S3. No usable record means `null`, never a plausible-looking number. A
//       pool nobody measured is unknown, not cheap and not expensive.
//   S4. Utilization only rises inside a window. A drop, or a changed
//       resets_at, means the window rolled over: that pair is not a rate
//       observation and is dropped rather than smoothed.

import {
  WINDOW_KEYS,
  projectedUtilization,
} from '../meters/framework.js';
import { readMeterHistory } from '../meters/registry.js';

/**
 * Floor on any expected duration. Under-estimating an assignment's length
 * under-books the quota it will spend, which is the failure this model
 * exists to prevent; five minutes is the shortest assignment worth booking.
 */
export const MIN_EXPECTED_MINUTES = 5;

/**
 * Documented fallbacks, in minutes, when the decision log has too few
 * matching attempts to take a median. Raised to MIN_EXPECTED_MINUTES on the
 * way out, so `build/low` reports 5 rather than its table value of 4.
 */
export const DEFAULT_EXPECTED_MINUTES = {
  build: { high: 10, medium: 6, low: 4 },
  analyze: { high: 5, medium: 5, low: 5 },
  chore: { high: 5, medium: 5, low: 5 },
};

/** Matching attempts required before a median beats the documented default. */
export const MIN_DURATION_SAMPLES = 3;
/** Usable reading pairs required before a fitted rate beats the bootstrap. */
export const MIN_RATE_PAIRS = 2;

/**
 * Worker-minutes that must be attributable to a window before the utilization
 * observed over it counts as a RATE (S3).
 *
 * A rate is percentage points per worker-minute, so the denominator is the
 * dispatch that produced them. A pool can be at 26% of its 5-hour window with
 * six seconds of Bullswarm dispatch recorded against it — the quota was spent
 * by the operator's own interactive session, not by us — and 26 ÷ 0.1 is not a
 * measurement of anything: it is 260% per minute, which forecasts every pool
 * past the burst line the instant it takes its first assignment. Below this
 * floor the rate is null (unknown), so routing falls back to the flat
 * in-flight penalty instead of a number the denominator cannot support. Five
 * minutes is MIN_EXPECTED_MINUTES: one assignment's worth of real dispatch.
 */
export const MIN_RATE_MINUTES = MIN_EXPECTED_MINUTES;

// --- small helpers -----------------------------------------------------------

/** Finite number or null — a missing measurement never becomes a zero. */
function num(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pool name from a name, a pool view, or a connector. */
export function poolNameOf(pool) {
  if (typeof pool === 'string') return pool;
  return pool?.name ?? pool?.pool ?? null;
}

function laneOf(entry) {
  return entry?.lane ?? entry?.routing?.lane ?? null;
}

/**
 * `bullswarm run` logs no effort tier; the V2 dispatcher records it under
 * `routing.effort` (src/workflow/v2-dispatch.js). Accept every shape a writer
 * has used rather than silently dropping the samples.
 */
function effortOf(entry) {
  return entry?.effort ?? entry?.effortTier
    ?? entry?.routing?.effort ?? entry?.routing?.effortTier ?? null;
}

function poolOf(entry) {
  return entry?.picked ?? entry?.pool ?? entry?.poolName ?? null;
}

/**
 * The wall-clock interval one recorded attempt occupied.
 *
 * Decision-log entries carry `ts` (the moment the attempt finished) and
 * `wallSec`; attempt records carry `startedAt`/`finishedAt`. Both are
 * accepted. Token counts are deliberately ignored — they are
 * `estimated:utf8-bytes/4` in this log and would not survive S1.
 *
 * @returns {{startMs: number, endMs: number, minutes: number}|null}
 */
export function attemptWindow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const startMs = num(Date.parse(entry.startedAt ?? ''));
  const endMs = num(Date.parse(entry.finishedAt ?? entry.ts ?? ''));
  const wallSec = num(entry.wallSec);
  const durationMs = num(entry.durationMs)
    ?? (wallSec != null ? wallSec * 1000 : null)
    ?? (startMs != null && endMs != null ? endMs - startMs : null);
  if (durationMs == null || durationMs <= 0) return null;
  const start = startMs ?? (endMs != null ? endMs - durationMs : null);
  const end = endMs ?? (startMs != null ? startMs + durationMs : null);
  if (start == null || end == null || end <= start) return null;
  return { startMs: start, endMs: end, minutes: (end - start) / 60_000 };
}

function overlapMinutes(startMs, endMs, fromMs, toMs) {
  const overlap = Math.min(endMs, toMs) - Math.max(startMs, fromMs);
  return overlap > 0 ? overlap / 60_000 : 0;
}

/**
 * In-flight records for one pool out of whatever the ledger writer attached.
 * Tolerated shapes: an array of records, `{records: [...]}`, or a map keyed by
 * pool name holding either of those. Records carrying a pool name that is not
 * this pool are dropped; records with no pool name are kept, so a list already
 * scoped to one pool still works.
 */
export function inflightRecordsFor(pool, inflight) {
  const name = poolNameOf(pool);
  const mine = (records) => (Array.isArray(records) ? records : []).filter((r) => {
    const owner = poolOf(r);
    return owner == null || owner === name;
  });
  if (!inflight) return [];
  if (Array.isArray(inflight)) return mine(inflight);
  if (typeof inflight !== 'object') return [];
  const keyed = name != null ? inflight[name] : null;
  if (keyed) return mine(Array.isArray(keyed) ? keyed : keyed.records);
  if (Array.isArray(inflight.records)) return mine(inflight.records);
  return [];
}

/**
 * Minutes an in-flight record still has to run, or null when nobody recorded
 * enough to say. An unknown remainder is left out of a forecast rather than
 * filled in — src/lib/route.js charges those agents its own flat penalty and
 * labels it `penalty`.
 */
export function remainingMinutesOf(record, nowMs = Date.now()) {
  const recorded = num(record?.remainingMinutes);
  if (recorded != null) return Math.max(0, recorded);
  const expected = num(record?.expectedMinutes);
  const startedAt = num(Date.parse(record?.startedAt ?? ''));
  if (expected == null || startedAt == null) return null;
  return Math.max(0, expected - (nowMs - startedAt) / 60_000);
}

// --- expected duration -------------------------------------------------------

/**
 * How long an assignment on this lane and effort tier is expected to run.
 *
 * History wins when the decision log holds at least MIN_DURATION_SAMPLES
 * matching attempts with a real positive wall time: the median of those, never
 * below MIN_EXPECTED_MINUTES. Otherwise the documented default for the pair.
 *
 * @param {{lane?: string, effort?: string, effortTier?: string}} assignment
 * @param {{decisionLog?: Array<object>}} [opts]
 * @returns {{minutes: number, source: 'history'|'default', samples: number}}
 */
export function expectedMinutesFor(assignment = {}, opts = {}) {
  const lane = assignment.lane ?? null;
  const effort = assignment.effort ?? assignment.effortTier ?? null;
  const log = Array.isArray(opts.decisionLog) ? opts.decisionLog : [];

  const minutes = [];
  for (const entry of log) {
    if (laneOf(entry) !== lane) continue;
    if (effortOf(entry) !== effort) continue;
    const window = attemptWindow(entry);
    if (window) minutes.push(window.minutes);
  }

  if (minutes.length >= MIN_DURATION_SAMPLES) {
    return {
      minutes: Math.max(MIN_EXPECTED_MINUTES, round(median(minutes), 2)),
      source: 'history',
      samples: minutes.length,
    };
  }
  const fallback = DEFAULT_EXPECTED_MINUTES[lane]?.[effort] ?? MIN_EXPECTED_MINUTES;
  return {
    minutes: Math.max(MIN_EXPECTED_MINUTES, fallback),
    source: 'default',
    samples: minutes.length,
  };
}

// --- worker minutes ----------------------------------------------------------

/**
 * Worker-minutes dispatched to a pool inside [fromMs, toMs] — the denominator
 * of every spend rate. Finished attempts contribute the part of their run that
 * falls inside the interval; in-flight records contribute startedAt..now.
 *
 * @param {string|object} pool
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{decisionLog?: Array<object>, inflight?: any, nowMs?: number}} [opts]
 * @returns {number} minutes (0 when nothing overlaps)
 */
export function workerMinutesForPool(pool, fromMs, toMs, opts = {}) {
  const name = poolNameOf(pool);
  const from = num(fromMs);
  const to = num(toMs);
  if (name == null || from == null || to == null || to <= from) return 0;
  const { decisionLog = [], inflight = null, nowMs = Date.now() } = opts;

  let minutes = 0;
  for (const entry of Array.isArray(decisionLog) ? decisionLog : []) {
    if (poolOf(entry) !== name) continue;
    const window = attemptWindow(entry);
    if (!window) continue;
    minutes += overlapMinutes(window.startMs, window.endMs, from, to);
  }
  for (const record of inflightRecordsFor(name, inflight)) {
    const startedAt = num(Date.parse(record?.startedAt ?? ''));
    if (startedAt == null) continue;
    minutes += overlapMinutes(startedAt, nowMs, from, to);
  }
  return round(minutes, 4);
}

// --- spend rate --------------------------------------------------------------

/** One window's readings out of a history log, oldest first. */
function seriesFor(history, meta) {
  const out = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const window = entry?.[meta.history] ?? entry?.[meta.snapshot];
    const usedPct = num(window?.utilization);
    if (usedPct == null) continue;
    const capturedAtMs = num(entry.capturedAtMs) ?? num(Date.parse(entry.captured_at ?? ''));
    if (capturedAtMs == null) continue;
    out.push({ capturedAtMs, usedPct, resetsAt: window.resets_at ?? null });
  }
  out.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  return out;
}

/** The current reading for one window out of a live snapshot. */
function currentFor(snapshot, meta, nowMs) {
  const window = snapshot?.[meta.snapshot] ?? snapshot?.[meta.history];
  const usedPct = num(window?.utilization);
  if (usedPct == null) return null;
  return {
    capturedAtMs: num(Date.parse(snapshot?.captured_at ?? '')) ?? nowMs,
    usedPct,
    resetsAt: window.resets_at ?? null,
  };
}

function rateForWindow(meta, { history, snapshot, workerMinutesBetween, nowMs }) {
  const series = seriesFor(history, meta);
  const current = currentFor(snapshot, meta, nowMs);
  // The live reading is normally already the last history line; add it only
  // when it is genuinely newer, so it is never counted twice.
  if (current && (!series.length || current.capturedAtMs > series[series.length - 1].capturedAtMs)) {
    series.push(current);
  }
  const latest = current ?? series[series.length - 1] ?? null;
  const windowUsedPct = latest?.usedPct ?? null;
  const minutesBetween = typeof workerMinutesBetween === 'function' ? workerMinutesBetween : null;

  // 1. Fitted rate: utilization gained per worker-minute, pooled over every
  //    usable consecutive pair. Pooling (Σdelta / Σminutes) rather than
  //    averaging per-pair rates keeps long observations weighted as such.
  let deltaPct = 0;
  let workerMinutes = 0;
  let pairs = 0;
  for (let i = 1; i < series.length; i += 1) {
    const from = series[i - 1];
    const to = series[i];
    if (from.resetsAt !== to.resetsAt) continue; // S4: the window rolled over
    if (to.usedPct < from.usedPct) continue; // S4: utilization only rises
    const minutes = minutesBetween ? num(minutesBetween(from.capturedAtMs, to.capturedAtMs)) : null;
    if (minutes == null || minutes <= 0) continue; // nothing was dispatched
    deltaPct += to.usedPct - from.usedPct;
    workerMinutes += minutes;
    pairs += 1;
  }
  if (pairs >= MIN_RATE_PAIRS && workerMinutes >= MIN_RATE_MINUTES) {
    return {
      ratePerMinute: round(deltaPct / workerMinutes, 6),
      source: 'history',
      samples: pairs,
      windowUsedPct,
    };
  }

  // 2. Bootstrap: the whole window so far — current utilization over the
  //    worker-minutes dispatched since the window opened (M2: the start comes
  //    from the provider's resets_at, never from a locally assumed start).
  const resetsAtMs = num(Date.parse(latest?.resetsAt ?? ''));
  if (latest && resetsAtMs != null && latest.usedPct > 0 && minutesBetween) {
    const minutes = num(minutesBetween(resetsAtMs - meta.windowMs, nowMs));
    if (minutes != null && minutes >= MIN_RATE_MINUTES) {
      return {
        ratePerMinute: round(latest.usedPct / minutes, 6),
        source: 'bootstrap',
        samples: 1,
        windowUsedPct,
      };
    }
  }

  // 3. Nothing usable was recorded (S3).
  return { ratePerMinute: null, source: null, samples: pairs, windowUsedPct };
}

/**
 * Spend rate per window for one pool, in percent of the window per
 * worker-minute, with the basis that produced it.
 *
 * @param {string|object} pool
 * @param {{history?: Array<object>,
 *          workerMinutesBetween?: (fromMs: number, toMs: number) => number,
 *          nowMs?: number, snapshot?: object|null}} [opts]
 * @returns {{fiveHour: object, weekly: object}} each
 *   `{ratePerMinute, source: 'history'|'bootstrap'|null, samples, windowUsedPct}`
 */
export function spendRateFor(pool, opts = {}) {
  const {
    history = [],
    workerMinutesBetween = null,
    nowMs = Date.now(),
    snapshot = null,
  } = opts;
  const out = {};
  for (const [key, meta] of Object.entries(WINDOW_KEYS)) {
    out[key] = rateForWindow(meta, { history, snapshot, workerMinutesBetween, nowMs });
  }
  return out;
}

// --- attaching to pool views -------------------------------------------------

function historyResolver({ history = null, readHistory = null, historyFor = null, historyDir = null }) {
  const reader = [readHistory, historyFor, typeof history === 'function' ? history : null]
    .find((fn) => typeof fn === 'function') ?? null;
  return (name) => {
    if (name == null) return [];
    if (reader) return reader(name) ?? [];
    if (history && typeof history === 'object' && !Array.isArray(history)) return history[name] ?? [];
    if (Array.isArray(history)) return history;
    try {
      return readMeterHistory(name, historyDir ? { dir: historyDir } : {});
    } catch {
      return [];
    }
  };
}

/** Current utilization for one window of a pool view. */
function currentUsedPct(pool, key, rate) {
  if (key === 'fiveHour') return num(pool?.fiveHourUsedPct) ?? rate.windowUsedPct ?? null;
  return num(pool?.weeklyUsedPct) ?? rate.windowUsedPct ?? null;
}

/**
 * Attach the spend model to pool views in place:
 *
 *   pool.spend.fiveHour / pool.spend.weekly = {ratePerMinute, source, samples}
 *   pool.projectedFiveHourPct / pool.projectedWeeklyPct
 *       = current utilization + rate × the remaining minutes of the pool's
 *         in-flight work (this candidate is NOT included — src/lib/route.js
 *         adds the assignment being routed on top).
 *
 * A pool with nothing in flight projects exactly its current reading. A pool
 * with work in flight and no measured rate projects null: unknown, not zero.
 *
 * @param {Array<object>} pools
 * @param {{history?: object|Function, readHistory?: Function, historyFor?: Function,
 *          historyDir?: string, decisionLog?: Array<object>, inflight?: any,
 *          nowMs?: number}} [opts]
 * @returns {Array<object>} the same pools
 */
export function attachSpend(pools, opts = {}) {
  const list = Array.isArray(pools) ? pools : [];
  const { decisionLog = [], inflight = null, nowMs = Date.now() } = opts;
  const historyOf = historyResolver(opts);

  for (const pool of list) {
    const name = poolNameOf(pool);
    // Ledger-attached records win; the caller-supplied ledger is the fallback,
    // so this never double-counts one agent. The same resolved list feeds both
    // the denominator (minutes already burned) and the forecast (minutes left).
    const attached = Array.isArray(pool?.inflight?.records) ? pool.inflight.records : null;
    const records = attached ?? inflightRecordsFor(name, inflight);

    const rates = spendRateFor(name, {
      history: historyOf(name),
      workerMinutesBetween: (fromMs, toMs) =>
        workerMinutesForPool(name, fromMs, toMs, { decisionLog, inflight: records, nowMs }),
      nowMs,
      snapshot: pool?.meterSnapshot ?? pool?.snapshot ?? null,
    });

    let remainingMinutes = 0;
    for (const record of records) {
      remainingMinutes += remainingMinutesOf(record, nowMs) ?? 0;
    }

    pool.spend = {
      fiveHour: {
        ratePerMinute: rates.fiveHour.ratePerMinute,
        source: rates.fiveHour.source,
        samples: rates.fiveHour.samples,
      },
      weekly: {
        ratePerMinute: rates.weekly.ratePerMinute,
        source: rates.weekly.source,
        samples: rates.weekly.samples,
      },
    };

    for (const [key, field] of [['fiveHour', 'projectedFiveHourPct'], ['weekly', 'projectedWeeklyPct']]) {
      const projection = projectedUtilization({
        usedPct: currentUsedPct(pool, key, rates[key]),
        ratePerMinute: rates[key].ratePerMinute,
        inflightRemainingMinutes: remainingMinutes,
        candidateMinutes: 0,
      });
      pool[field] = projection?.projectedPct ?? null;
    }
  }
  return list;
}
