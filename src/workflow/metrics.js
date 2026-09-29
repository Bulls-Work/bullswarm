// All metric arithmetic, in one place.
//
// Metrics are captured once, per step attempt: its interval, worker minutes,
// tokens with their source, and money with its basis. A step, a run, a
// project, a day and a pool are only aggregations of attempt records, and
// every page (Stats, Budget, History, Home, Run, Step) and the rollup writer
// aggregate through the functions below. No page computes its own totals.
//
// Doctrine:
//   M1. Unknown stays unknown. A figure with no source is null, never 0:
//       `Number(null)` is 0, so every numeric read goes through finite() and
//       every running sum starts at null.
//   M2. Money keeps its coverage. A whole-scope amount (`apiUsd`,
//       `subscriptionUsd`) exists only when every attempt in the scope was
//       priced; the sum over the priced ones is the named subtotal
//       (`apiKnownSubtotalUsd`), and the counts travel with it.
//   M3. Active minutes are the union of attempt intervals. One attempt whose
//       interval cannot be resolved makes the union unknown rather than
//       quietly shorter. An attempt's interval ends at its recorded finish;
//       an attempt still running ends at `now`; an attempt that recorded no
//       finish ends at its start plus its measured wall seconds, and one that
//       recorded no start began its wall seconds before its finish.
//   M4. Worker minutes are the wall seconds each attempt measured, summed.
//   M5. "Today" is the day a record finished; a record with no finish is
//       placed on the day it started.
//   M6. Old records (rollups written before per-attempt metrics, pre-v2
//       pools, legacy runs, single-run log entries) reach these functions
//       through the legacy reader (metrics-legacy.js), marked `legacy`.

import { isCountedRetry } from './step-vocabulary.js';

// ------------------------------------------------------------------ numbers

export function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function finiteNonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}

export function round(value, places) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Adds into a null accumulator: null + nothing stays null (M1). */
export function addNullable(total, value) {
  return value == null ? total : (total ?? 0) + value;
}

export function parseIso(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const MINUTE_MS = 60_000;

// ---------------------------------------------------- token source and basis

export const TOKEN_SOURCE_RANK = Object.freeze({
  unknown: 0,
  'estimated:utf8-bytes/4': 1,
  'transcript-summed': 2,
  'provider-reported': 3,
});

export const SUBSCRIPTION_BASIS_RANK = Object.freeze({
  'unknown:no-price': 0,
  'unknown:no-meter': 1,
  'unknown:below-resolution': 2,
  'unknown:no-cost': 3,
  'calibrated:usd-per-pct': 4,
  'observed:meter-delta': 5,
  'observed:meter-ledger': 6,
});

export const MEASURED_TOKEN_SOURCES = Object.freeze(['provider-reported', 'transcript-summed']);

/**
 * A recorded token source, or the one a pre-basis amount implies: rollups
 * written before sources existed carried only `costUsd`, and those dollars
 * were the bytes/4 estimate.
 */
export function tokenSourceOf(value, cost = null) {
  if (Object.hasOwn(TOKEN_SOURCE_RANK, value)) return value;
  return cost != null ? 'estimated:utf8-bytes/4' : 'unknown';
}

export function worstTokenSource(current, candidate) {
  const next = tokenSourceOf(candidate);
  if (current == null) return next;
  return TOKEN_SOURCE_RANK[next] < TOKEN_SOURCE_RANK[current] ? next : current;
}

export function subscriptionBasisOf(value) {
  return Object.hasOwn(SUBSCRIPTION_BASIS_RANK, value) ? value : 'unknown:no-meter';
}

export function worstSubscriptionBasis(current, candidate) {
  const next = subscriptionBasisOf(candidate);
  if (current == null) return next;
  return SUBSCRIPTION_BASIS_RANK[next] < SUBSCRIPTION_BASIS_RANK[current] ? next : current;
}

/** How many of `attempts` were measured, given the scope's token source. */
export function measuredAttemptCount(source, attempts) {
  if (!MEASURED_TOKEN_SOURCES.includes(source)) return 0;
  return Math.max(0, Math.trunc(Number(attempts) || 0));
}

// ------------------------------------------------------------- one attempt

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const direct = finite(tokens.totalKnown);
  if (direct != null) return direct;
  const fields = ['standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output', 'reasoning'];
  let total = null;
  for (const field of fields) total = addNullable(total, finite(tokens[field]));
  return total;
}

function cacheWriteOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const direct = finite(tokens.cacheWrite);
  if (direct != null) return direct;
  const five = finite(tokens.cacheWrite5m);
  const one = finite(tokens.cacheWrite1h);
  return five != null && one != null ? five + one : null;
}

/** The API amount one attempt recorded, or null. */
export function attemptApiUsd(attempt) {
  return finiteNonNegative(
    attempt?.usage?.api?.usd
      ?? attempt?.usage?.cost?.estimatedUsd
      ?? attempt?.usage?.apiUsd,
  );
}

/**
 * One attempt's usage as the canonical fields every aggregate reads.
 * `canonical` says whether the attempt carries the v2 api/subscription shape.
 */
export function attemptUsage(attempt) {
  const usage = attempt?.usage && typeof attempt.usage === 'object' ? attempt.usage : null;
  const tokens = usage?.tokens && typeof usage.tokens === 'object' ? usage.tokens : null;
  return {
    canonical: Boolean(usage && (usage.api !== undefined || usage.subscription !== undefined)),
    apiUsd: finite(usage?.api?.usd ?? usage?.cost?.estimatedUsd),
    subscriptionUsd: finite(usage?.subscription?.usd),
    tokenSource: tokenSourceOf(usage?.tokenSource),
    subscriptionBasis: subscriptionBasisOf(usage?.subscription?.basis),
    subscriptionDeltaPct: finite(usage?.subscription?.deltaPct),
    subscriptionWindow: typeof usage?.subscription?.window === 'string' ? usage.subscription.window : null,
    tokens: tokenTotal(tokens),
    cacheRead: finite(tokens?.cacheRead),
    cacheWrite: cacheWriteOf(tokens),
    reasoning: finite(tokens?.reasoning),
  };
}

/**
 * The wall seconds one attempt measured: `wallSec`, or the single-run
 * ledger's `durationMs`. Null when neither was recorded.
 */
export function attemptWallSec(attempt) {
  const durationMs = finite(attempt?.durationMs);
  if (durationMs != null && durationMs >= 0) return durationMs / 1000;
  const wallSec = finite(attempt?.wallSec);
  return wallSec != null && wallSec >= 0 ? wallSec : null;
}

/**
 * M4. The wall minutes one attempt measured, or null.
 *
 * A page showing a live run passes `nowMs`: an attempt that has not measured
 * its wall seconds yet (still running, or an old record) then counts the
 * length of its interval, open through `nowMs`.
 */
export function attemptWorkerMinutes(attempt, { nowMs = null } = {}) {
  const wallSec = attemptWallSec(attempt);
  if (wallSec != null) return wallSec / 60;
  if (nowMs == null) return null;
  const interval = attemptInterval(attempt, { nowMs });
  return interval.unknown ? null : (interval.end - interval.start) / MINUTE_MS;
}

// ---------------------------------------------------- money over attempts

/**
 * M2 for a list of per-attempt amounts: the whole sum only when every amount
 * is known, the subtotal of the known ones always (null when none is).
 */
export function coverageSum(values) {
  const list = Array.isArray(values) ? values : [];
  const known = list.map(finite).filter((value) => value != null);
  const subtotal = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  return { whole: list.length && known.length === list.length ? subtotal : null, subtotal, known: known.length, count: list.length };
}

function emptyUsageAggregate() {
  return {
    attempts: 0,
    minutes: null,
    tokens: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    apiUsd: null,
    apiKnownSubtotalUsd: null,
    subscriptionUsd: null,
    subscriptionKnownSubtotalUsd: null,
    measuredAttempts: 0,
    pricedAttempts: 0,
    subscriptionPricedAttempts: 0,
    // Unset while walking so the first real attempt's source and basis are
    // kept: starting from the lowest rank would make every aggregate unknown.
    tokenSource: null,
    subscriptionBasis: null,
    subscriptionDeltaPct: null,
    subscriptionWindow: null,
    subscriptionWindows: {},
  };
}

function finalizeUsageAggregate(aggregate) {
  const complete = aggregate.attempts > 0 && aggregate.pricedAttempts === aggregate.attempts;
  const subscriptionComplete = aggregate.attempts > 0
    && aggregate.subscriptionPricedAttempts === aggregate.attempts;
  aggregate.apiUsd = complete ? round(aggregate.apiKnownSubtotalUsd, 6) : null;
  aggregate.apiKnownSubtotalUsd = round(aggregate.apiKnownSubtotalUsd, 6);
  aggregate.subscriptionUsd = subscriptionComplete ? round(aggregate.subscriptionKnownSubtotalUsd, 6) : null;
  aggregate.subscriptionKnownSubtotalUsd = round(aggregate.subscriptionKnownSubtotalUsd, 6);
  aggregate.minutes = round(aggregate.minutes, 2);
  for (const field of ['tokens', 'cacheRead', 'cacheWrite', 'reasoning']) {
    aggregate[field] = aggregate[field] == null ? null : Math.round(aggregate[field]);
  }
  aggregate.tokenSource ??= 'unknown';
  aggregate.subscriptionBasis ??= 'unknown:no-meter';
  const windows = Object.entries(aggregate.subscriptionWindows ?? {});
  if (windows.length === 1) {
    aggregate.subscriptionWindow = windows[0][0];
    aggregate.subscriptionDeltaPct = round(windows[0][1], 6);
  }
  return aggregate;
}

/**
 * Aggregate attempt usage with strict completeness (M2).
 *
 * `apiUsd` and `subscriptionUsd` are whole-scope totals only when every
 * attempt has the corresponding amount. The named `*KnownSubtotalUsd` fields
 * retain partial sums, while all token classes stay null until at least one
 * attempt reports that class.
 */
export function aggregateAttemptUsage(attempts) {
  const aggregate = emptyUsageAggregate();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || typeof attempt !== 'object') continue;
    aggregate.attempts += 1;
    aggregate.minutes = addNullable(aggregate.minutes, attemptWorkerMinutes(attempt));
    const usage = attemptUsage(attempt);
    aggregate.tokens = addNullable(aggregate.tokens, usage.tokens);
    aggregate.cacheRead = addNullable(aggregate.cacheRead, usage.cacheRead);
    aggregate.cacheWrite = addNullable(aggregate.cacheWrite, usage.cacheWrite);
    aggregate.reasoning = addNullable(aggregate.reasoning, usage.reasoning);
    aggregate.tokenSource = worstTokenSource(aggregate.tokenSource, usage.tokenSource);
    aggregate.subscriptionBasis = worstSubscriptionBasis(aggregate.subscriptionBasis, usage.subscriptionBasis);
    if (usage.subscriptionDeltaPct != null && usage.subscriptionWindow) {
      aggregate.subscriptionWindows[usage.subscriptionWindow] =
        (aggregate.subscriptionWindows[usage.subscriptionWindow] ?? 0) + usage.subscriptionDeltaPct;
    }
    if (usage.apiUsd != null) {
      aggregate.apiKnownSubtotalUsd = addNullable(aggregate.apiKnownSubtotalUsd, usage.apiUsd);
      aggregate.pricedAttempts += 1;
    }
    if (usage.subscriptionUsd != null) {
      aggregate.subscriptionKnownSubtotalUsd = addNullable(aggregate.subscriptionKnownSubtotalUsd, usage.subscriptionUsd);
      aggregate.subscriptionPricedAttempts += 1;
    }
    if (MEASURED_TOKEN_SOURCES.includes(usage.tokenSource)) aggregate.measuredAttempts += 1;
  }
  return finalizeUsageAggregate(aggregate);
}

// -------------------------------------------------- the rollup's stored maps

// Attempts carry their pool, model, wall seconds, and whatever usage the
// dispatcher recorded. `null` pool/model keys land under 'unknown', which is
// what src/workflow/v2-runtime.js addUsage() already does for pool totals.
/**
 * The per-pool and per-model maps a rollup stores beside its attempt records,
 * for the readers that predate them. A run with any canonical v2 usage gets
 * the strict aggregate per pool; an older run keeps the pre-v2 `costUsd`
 * shape its readers and fixtures load.
 */
export function poolAndModelMaps(attempts) {
  const list = (Array.isArray(attempts) ? attempts : []).filter((attempt) => attempt && typeof attempt === 'object');
  const pools = {};
  const models = {};
  const poolAttempts = new Map();
  const canonical = list.some((attempt) => attemptUsage(attempt).canonical);
  for (const attempt of list) {
    const poolKey = attempt.pool ?? 'unknown';
    const modelKey = attempt.model ?? 'unknown';
    const pool = poolAttempts.get(poolKey) ?? [];
    pool.push(attempt);
    poolAttempts.set(poolKey, pool);
    const minutes = attemptWorkerMinutes(attempt);
    const model = models[modelKey] ??= { attempts: 0, minutes: null };
    model.attempts += 1;
    if (minutes != null) model.minutes = (model.minutes ?? 0) + minutes;
  }
  if (canonical) {
    for (const [poolKey, grouped] of poolAttempts) {
      const aggregate = aggregateAttemptUsage(grouped);
      pools[poolKey] = {
        ...aggregate,
        // `costUsd` is the pre-v2 alias. It follows the strict whole-scope
        // amount; partial sums live only in the explicitly named subtotal.
        costUsd: aggregate.apiUsd,
      };
    }
  } else {
    // Historical records only carried costUsd and token classes. Preserve
    // their enumerable shape so older readers and fixtures continue to load.
    for (const attempt of list) {
      const poolKey = attempt.pool ?? 'unknown';
      const pool = pools[poolKey] ??= {
        attempts: 0, minutes: null, costUsd: null, tokens: null,
        cacheRead: null, cacheWrite: null, tokenSource: null,
      };
      const minutes = attemptWorkerMinutes(attempt);
      const costUsd = finite(attempt.usage?.cost?.estimatedUsd);
      const tokens = finite(attempt.usage?.tokens?.totalKnown);
      const cacheRead = finite(attempt.usage?.tokens?.cacheRead);
      const explicitCacheWrite = finite(attempt.usage?.tokens?.cacheWrite);
      const cacheWrite5m = finite(attempt.usage?.tokens?.cacheWrite5m);
      const cacheWrite1h = finite(attempt.usage?.tokens?.cacheWrite1h);
      const cacheWrite = explicitCacheWrite ?? (cacheWrite5m != null || cacheWrite1h != null
        ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
        : null);
      const tokenSource = tokenSourceOf(attempt.usage?.tokenSource);
      pool.attempts += 1;
      pool.tokenSource = worstTokenSource(pool.tokenSource, tokenSource);
      if (minutes != null) pool.minutes = (pool.minutes ?? 0) + minutes;
      if (costUsd != null) pool.costUsd = (pool.costUsd ?? 0) + costUsd;
      if (tokens != null) pool.tokens = (pool.tokens ?? 0) + tokens;
      if (cacheRead != null) pool.cacheRead = (pool.cacheRead ?? 0) + cacheRead;
      if (cacheWrite != null) pool.cacheWrite = (pool.cacheWrite ?? 0) + cacheWrite;
    }
    for (const pool of Object.values(pools)) {
      pool.minutes = round(pool.minutes, 2);
      pool.costUsd = round(pool.costUsd, 6);
      pool.tokens = pool.tokens == null ? null : Math.round(pool.tokens);
      pool.cacheRead = pool.cacheRead == null ? null : Math.round(pool.cacheRead);
      pool.cacheWrite = pool.cacheWrite == null ? null : Math.round(pool.cacheWrite);
      pool.tokenSource ??= 'unknown';
    }
  }
  for (const model of Object.values(models)) model.minutes = round(model.minutes, 2);
  return { pools, models, canonical };
}

// ------------------------------------------------------ attempt intervals

const OPEN_STATUSES = new Set(['started', 'start', 'running', 'in_progress', 'in-progress']);

/** Whether an attempt says it is still running. */
export function attemptIsOpen(attempt) {
  return OPEN_STATUSES.has(String(attempt?.status ?? '').toLowerCase());
}

/**
 * The interval one attempt occupied (M3), in epoch milliseconds.
 *
 * `running` says the container (the run) is still going, so an attempt with
 * no finish of any kind is open through `nowMs` rather than unknown.
 *
 * @returns {{start: number, end: number, open: boolean, spanKnown: boolean, attempt: object}
 *          |{unknown: true, attempt: object}}
 */
export function attemptInterval(attempt, { nowMs = Date.now(), running = false } = {}) {
  const unknown = { unknown: true, attempt };
  const recordedEnd = parseIso(attempt?.finishedAt) ?? parseIso(attempt?.endedAt);
  const wallSec = attemptWallSec(attempt);
  // An old record may name its finish and its measured wall seconds but no
  // start: the interval is still two measurements, never a guess.
  const start = parseIso(attempt?.startedAt)
    ?? (recordedEnd != null && wallSec != null && wallSec >= 0 ? recordedEnd - wallSec * 1000 : null);
  if (start == null) return unknown;
  if (recordedEnd != null) {
    return recordedEnd >= start ? { start, end: recordedEnd, open: false, spanKnown: true, attempt } : unknown;
  }
  const now = parseIso(nowMs) ?? Date.now();
  if (attemptIsOpen(attempt)) return now >= start ? { start, end: now, open: true, spanKnown: false, attempt } : unknown;
  if (wallSec != null && wallSec >= 0) return { start, end: start + wallSec * 1000, open: false, spanKnown: false, attempt };
  if (running) return now >= start ? { start, end: now, open: true, spanKnown: false, attempt } : unknown;
  return unknown;
}

/**
 * The union of resolved intervals (M3).
 *
 * `activeMs` is the merged length; it is null when any interval is unknown
 * or there is none. `spanMs` is first start to last end, and only when the
 * container is terminal, nothing is open, and every end was recorded.
 */
export function unionIntervals(intervals, { terminal = true } = {}) {
  const list = Array.isArray(intervals) ? intervals : [];
  const unknown = list.some((entry) => entry?.unknown === true);
  const known = list
    .filter((entry) => Number.isFinite(entry?.start) && Number.isFinite(entry?.end) && entry.end >= entry.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const open = known.some((entry) => entry.open === true);
  const startMs = known.length ? known[0].start : null;
  const endMs = known.length ? Math.max(...known.map((entry) => entry.end)) : null;
  if (unknown || !known.length) {
    return { activeMs: null, spanMs: null, startMs, endMs, open, unknown, spanKnown: false, intervals: known };
  }
  const merged = [];
  for (const interval of known) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  const activeMs = merged.reduce((total, interval) => total + interval.end - interval.start, 0);
  const spanKnown = known.every((entry) => entry.spanKnown === true);
  const spanMs = terminal && !open && spanKnown ? endMs - startMs : null;
  return { activeMs, spanMs, startMs, endMs, open, unknown, spanKnown, intervals: known };
}

/**
 * Active minutes and the span of a set of attempts.
 *
 * @param {Array<object>} attempts
 * @param {{now?: number, terminal?: boolean, running?: boolean}} [options]
 *        `terminal` gates the span; a container that is not terminal keeps
 *        its attempts with no finish open through `now`.
 */
export function attemptsUnion(attempts, { now = Date.now(), terminal = true, running = !terminal } = {}) {
  const nowMs = parseIso(now) ?? Date.now();
  const list = (Array.isArray(attempts) ? attempts : []).filter((attempt) => attempt && typeof attempt === 'object');
  const union = unionIntervals(list.map((attempt) => attemptInterval(attempt, { nowMs, running })), { terminal });
  return {
    ...union,
    activeMinutes: union.activeMs == null ? null : union.activeMs / MINUTE_MS,
    spanMinutes: union.spanMs == null ? null : union.spanMs / MINUTE_MS,
  };
}

/** The rollup's rounded pair: `{active, span}` minutes (M3). */
export function intervalMinutes(attempts, { now = Date.now(), terminal = false } = {}) {
  const union = attemptsUnion(attempts, { now, terminal });
  return { active: round(union.activeMinutes, 2), span: round(union.spanMinutes, 2) };
}

// ------------------------------------------ subscription ledger intervals

function attemptLedgerIntervals(attempt) {
  const attribution = attempt?.usage?.subscription?.attribution;
  const subscription = attempt?.usage?.subscription;
  const intervals = attribution?.intervals
    ?? attribution?.ledgerIntervals
    ?? subscription?.ledgerIntervals
    ?? subscription?.attribution?.intervals;
  return Array.isArray(intervals) ? intervals : [];
}

function ledgerIntervalKey(interval) {
  return [
    interval?.pool ?? '', interval?.window ?? '', interval?.from ?? '',
    interval?.at ?? interval?.to ?? interval?.captured_at ?? '',
    interval?.row ?? interval?.index ?? '', interval?.deltaPct ?? '',
    interval?.reason ?? '',
  ].join('|');
}

/** The distinct meter-ledger intervals a set of attempts observed, oldest first. */
export function unionLedgerIntervals(attempts) {
  const unique = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    for (const interval of attemptLedgerIntervals(attempt)) {
      if (!interval || typeof interval !== 'object') continue;
      unique.set(ledgerIntervalKey(interval), interval);
    }
  }
  return [...unique.values()].sort((a, b) => {
    const left = Date.parse(a?.at ?? a?.to ?? a?.captured_at ?? '') || 0;
    const right = Date.parse(b?.at ?? b?.to ?? b?.captured_at ?? '') || 0;
    return left - right;
  });
}

/** The observed meter drop over ledger intervals, excluding refused ones. */
export function positiveIntervalTotal(intervals) {
  return intervals.reduce((total, interval) => {
    const delta = finiteNonNegative(interval?.deltaPct ?? interval?.delta_pct);
    return delta != null && !interval?.reason ? total + delta : total;
  }, 0);
}

// ------------------------------------------------- attempt metric records

/** The provider a pool belongs to: the pool name before any `:account`. */
export function providerOfPool(pool) {
  if (typeof pool !== 'string' || !pool.trim()) return null;
  return pool.trim().toLowerCase().split(':', 1)[0] || null;
}

/**
 * The one metrics record an attempt leaves: what the rollup stores per
 * attempt and every aggregate reads. Pure.
 *
 * @param {object} attempt  a durable attempt (worker, planner or scout)
 * @param {{role?: string}} [options]
 */
export function attemptMetric(attempt, { role = 'worker' } = {}) {
  const usage = attemptUsage(attempt);
  const pool = typeof attempt?.pool === 'string' && attempt.pool ? attempt.pool : null;
  const ordinal = finite(attempt?.ordinal ?? attempt?.attemptNumber);
  const retryHow = typeof attempt?.retryOf?.how === 'string' ? attempt.retryOf.how : null;
  return {
    role,
    actionId: typeof attempt?.actionId === 'string' ? attempt.actionId : null,
    // An automatic retry is the dispatcher's retryOf fact. The ordinal is
    // run-wide per step, so loop rounds and caller reruns raise it too.
    retry: isCountedRetry(attempt) ? 1 : 0,
    retryHow,
    ordinal,
    pool,
    model: typeof attempt?.model === 'string' && attempt.model ? attempt.model : null,
    provider: providerOfPool(pool),
    outcome: typeof attempt?.status === 'string' ? attempt.status : null,
    startedAt: typeof attempt?.startedAt === 'string' ? attempt.startedAt : null,
    finishedAt: typeof (attempt?.finishedAt ?? attempt?.endedAt) === 'string' ? (attempt.finishedAt ?? attempt.endedAt) : null,
    wallSec: finite(attempt?.wallSec),
    tokens: usage.tokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    tokenSource: usage.tokenSource,
    apiUsd: usage.apiUsd,
    subscriptionUsd: usage.subscriptionUsd,
    subscriptionBasis: usage.subscriptionBasis,
    subscriptionDeltaPct: usage.subscriptionDeltaPct,
    subscriptionWindow: usage.subscriptionWindow,
  };
}

/**
 * Every attempt of a V2 state with its role, scout and planner first.
 * Planner and scout attempts count everywhere a worker attempt does.
 */
export function stateAttempts(state) {
  return [
    ...(state?.preflight?.scout?.attempts ?? []).map((attempt) => ({ attempt, role: 'scout' })),
    ...(state?.planner?.attempts ?? []).map((attempt) => ({ attempt, role: 'planner' })),
    ...(state?.attempts ?? []).map((attempt) => ({ attempt, role: 'worker' })),
  ].filter(({ attempt }) => attempt && typeof attempt === 'object');
}

/** An attempt metric as an entry (`attempts: 1`) the sums read. */
function metricEntry(metric, key) {
  const minutes = metric.wallSec != null && metric.wallSec >= 0 ? metric.wallSec / 60 : null;
  const tokenSource = tokenSourceOf(metric.tokenSource);
  const windows = {};
  if (metric.subscriptionDeltaPct != null && metric.subscriptionWindow) windows[metric.subscriptionWindow] = metric.subscriptionDeltaPct;
  return {
    key,
    legacy: false,
    v2: true,
    countsRecorded: true,
    attempts: 1,
    minutes,
    tokens: finite(metric.tokens),
    apiUsd: finite(metric.apiUsd),
    subscriptionUsd: finite(metric.subscriptionUsd),
    apiKnownSubtotalUsd: finite(metric.apiUsd),
    subscriptionKnownSubtotalUsd: finite(metric.subscriptionUsd),
    pricedAttempts: finite(metric.apiUsd) == null ? 0 : 1,
    subscriptionPricedAttempts: finite(metric.subscriptionUsd) == null ? 0 : 1,
    measuredAttempts: MEASURED_TOKEN_SOURCES.includes(tokenSource) ? 1 : 0,
    estimatedAttempts: tokenSource === 'estimated:utf8-bytes/4' ? 1 : 0,
    tokenSource,
    subscriptionBasis: subscriptionBasisOf(metric.subscriptionBasis),
    subscriptionWindows: windows,
  };
}

/**
 * A rollup pool (or model) map entry as an entry. Written before per-attempt
 * metrics, it is the finest grain an old record holds (M6).
 */
export function legacyMapEntry(value, key) {
  const v2 = Boolean(value && (Object.hasOwn(value, 'apiUsd')
    || Object.hasOwn(value, 'apiKnownSubtotalUsd')
    || Object.hasOwn(value, 'subscriptionUsd')
    || Object.hasOwn(value, 'subscriptionKnownSubtotalUsd')));
  const countsRecorded = Boolean(value && Object.hasOwn(value, 'pricedAttempts'));
  const attempts = Math.max(0, Math.trunc(finite(value?.attempts) ?? 0));
  const count = (field, whole) => (value && Object.hasOwn(value, field)
    ? Math.max(0, Math.trunc(finite(value[field]) ?? 0))
    // A pool written before 0.35.2 recorded one amount and no counts: its
    // attempts are the ones that amount covers, all or none.
    : whole == null ? 0 : attempts);
  const apiUsd = finite(value?.apiUsd ?? value?.costUsd);
  const subscriptionUsd = finite(value?.subscriptionUsd);
  // An amount with no recorded source is the pre-basis bytes/4 estimate.
  const tokenSource = tokenSourceOf(value?.tokenSource, apiUsd);
  return {
    key,
    legacy: true,
    v2,
    // Whether the coverage counts below were recorded or inferred.
    countsRecorded,
    attempts,
    minutes: finite(value?.minutes),
    tokens: finite(value?.tokens),
    apiUsd,
    apiKnownSubtotalUsd: finite(value?.apiKnownSubtotalUsd) ?? apiUsd,
    subscriptionUsd,
    subscriptionKnownSubtotalUsd: finite(value?.subscriptionKnownSubtotalUsd) ?? subscriptionUsd,
    pricedAttempts: count('pricedAttempts', apiUsd),
    subscriptionPricedAttempts: count('subscriptionPricedAttempts', subscriptionUsd),
    measuredAttempts: value && Object.hasOwn(value, 'measuredAttempts')
      ? Math.max(0, Math.trunc(finite(value.measuredAttempts) ?? 0))
      : measuredAttemptCount(tokenSource, attempts),
    estimatedAttempts: tokenSource === 'estimated:utf8-bytes/4' ? attempts : 0,
    tokenSource,
    subscriptionBasis: subscriptionBasisOf(value?.subscriptionBasis),
    subscriptionWindows: value?.subscriptionWindows && typeof value.subscriptionWindows === 'object'
      ? { ...value.subscriptionWindows }
      : value?.subscriptionWindow && finite(value?.subscriptionDeltaPct) != null
        ? { [value.subscriptionWindow]: finite(value.subscriptionDeltaPct) } : {},
  };
}

const GROUP_FIELDS = { pool: 'pool', model: 'model', provider: 'provider' };

/**
 * The entries one record holds, keyed for a grouping.
 *
 * A record written with per-attempt metrics answers from them, one entry per
 * attempt. An older record answers from the map its writer kept: `models`
 * for a model grouping, `pools` otherwise, with a pool's provider derived
 * from its name. `by` is 'pool', 'model', 'provider', or anything else for
 * the whole record (every entry keyed by the record itself).
 */
export function recordEntries(record, { by = 'pool' } = {}) {
  if (!record || typeof record !== 'object') return [];
  const field = GROUP_FIELDS[by] ?? null;
  const metrics = Array.isArray(record.attemptMetrics) ? record.attemptMetrics
    // A live run row carries its state rather than a rollup: its attempts are
    // measured the same way.
    : record.state && typeof record.state === 'object'
      ? stateAttempts(record.state).map(({ attempt, role }) => attemptMetric(attempt, { role }))
      : null;
  if (metrics) {
    return metrics
      .filter((metric) => metric && typeof metric === 'object')
      .map((metric) => metricEntry(metric, field ? (metric[field] ?? 'unknown') : null));
  }
  const map = by === 'model' ? record.models : record.pools;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map).map(([name, value]) => legacyMapEntry(value, by === 'provider'
    ? (providerOfPool(name) ?? 'unknown')
    : field ? name : null));
}

/** Entries grouped by their key, in first-seen order. */
export function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const list = groups.get(entry.key) ?? [];
    list.push(entry);
    groups.set(entry.key, list);
  }
  return groups;
}

/**
 * How many of the entries' attempts were both priced and measured: the count
 * `runSpendFacts` reads as `measuredAttempts` (estimated = priced minus it).
 * An entry's `measuredAttempts` counts measured tokens whether or not a price
 * was found, so the two are taken per entry: exact for a one-attempt entry,
 * and for a map entry, whose attempts share one token source.
 */
export function pricedMeasuredAttemptCount(entries) {
  let count = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    count += Math.max(0, Math.min(entry.pricedAttempts ?? 0, entry.measuredAttempts ?? 0));
  }
  return count;
}

/**
 * The sum of a set of entries, with coverage (M1, M2).
 *
 * `apiUsd` is the whole amount only when every attempt was priced, and the
 * same for `subscriptionUsd`; the subtotals always carry what was priced.
 */
export function sumEntries(entries) {
  const total = {
    attempts: 0,
    minutes: null,
    tokens: null,
    apiUsd: null,
    apiKnownSubtotalUsd: null,
    subscriptionUsd: null,
    subscriptionKnownSubtotalUsd: null,
    pricedAttempts: 0,
    subscriptionPricedAttempts: 0,
    measuredAttempts: 0,
    estimatedAttempts: 0,
    tokenSource: null,
    subscriptionBasis: null,
    subscriptionWindows: {},
    legacy: false,
    v2: false,
    countsRecorded: true,
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    total.attempts += entry.attempts;
    total.minutes = addNullable(total.minutes, entry.minutes);
    total.tokens = addNullable(total.tokens, entry.tokens);
    total.apiKnownSubtotalUsd = addNullable(total.apiKnownSubtotalUsd, entry.apiKnownSubtotalUsd);
    total.subscriptionKnownSubtotalUsd = addNullable(total.subscriptionKnownSubtotalUsd, entry.subscriptionKnownSubtotalUsd);
    total.pricedAttempts += entry.pricedAttempts;
    total.subscriptionPricedAttempts += entry.subscriptionPricedAttempts;
    total.measuredAttempts += entry.measuredAttempts;
    total.estimatedAttempts += entry.estimatedAttempts;
    total.tokenSource = worstTokenSource(total.tokenSource, entry.tokenSource);
    total.subscriptionBasis = worstSubscriptionBasis(total.subscriptionBasis, entry.subscriptionBasis);
    for (const [window, delta] of Object.entries(entry.subscriptionWindows ?? {})) {
      const value = finite(delta);
      if (value != null) total.subscriptionWindows[window] = (total.subscriptionWindows[window] ?? 0) + value;
    }
    total.legacy ||= entry.legacy === true;
    total.v2 ||= entry.v2 === true;
    if (entry.countsRecorded === false) total.countsRecorded = false;
  }
  // M2: a whole amount only when every entry had one.
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const whole = (field) => (list.length && list.every((entry) => entry[field] != null)
    ? list.reduce((sum, entry) => sum + entry[field], 0) : null);
  total.apiUsd = whole('apiUsd');
  total.subscriptionUsd = whole('subscriptionUsd');
  return total;
}

/** A record's money and minutes over all its attempts. */
export function recordTotals(record) {
  return sumEntries(recordEntries(record, { by: 'record' }));
}

/**
 * A set of records summed over all their attempts, the one sum a period, a
 * day or a table total is. A run that recorded no attempts (a legacy run)
 * adds no attempts and no money, and makes the set's usage basis unknown.
 * `pricedRuns` counts the records whose own whole amount is known.
 */
export function sumRecords(records) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && typeof record === 'object');
  const perRecord = list.map((record) => recordEntries(record, { by: 'record' }));
  const total = sumEntries(perRecord.flat());
  if (perRecord.some((entries) => entries.length === 0)) {
    total.tokenSource = worstTokenSource(total.tokenSource, 'unknown');
    total.subscriptionBasis = worstSubscriptionBasis(total.subscriptionBasis, 'unknown:no-meter');
  }
  total.runs = list.length;
  total.pricedRuns = perRecord.filter((entries) => sumEntries(entries).apiUsd != null).length;
  return total;
}

/** M4. The worker minutes a record spent, on one pool or across all of them. */
export function recordWorkerMinutes(record, pool = null) {
  const entries = recordEntries(record, { by: 'pool' });
  return sumEntries(pool == null ? entries : entries.filter((entry) => entry.key === pool)).minutes;
}

// ------------------------------------------------------------------- days

/** M5. The instant a record is placed at: its finish, else its start. */
export function recordTimeMs(record) {
  return parseIso(record?.finishedAt) ?? parseIso(record?.startedAt);
}
