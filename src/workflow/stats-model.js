// The Stats page's arithmetic: Overview, Trends, Pools, Models, Projects.
//
// Everything here is maths over the rollup index (src/workflow/rollup.js) and
// the live pool list (src/lib/config.js buildPools). No rendering, no ANSI, no
// terminal — a view turns these numbers into cells.
//
// Doctrine, inherited from the rollup writer and enforced again here:
//   S1. A figure with no source is null, never 0. `Number(null)` is 0, so
//       every numeric read goes through finite() and every running sum starts
//       at null and only becomes a number when something real is added.
//   S2. Money is the recorded API-equivalent estimate and is named
//       `apiEquivalentUsd` wherever it appears. There is no other money in
//       this module.
//   S3. A median is a real median over the values that exist. A mean is never
//       presented as one.
//   S4. Where a period asks for more history than exists, the model returns
//       what exists and says so (`requestedFrom`, `truncated`); it never pads
//       the missing days with zeros and calls them measurements.
//   S5. The model reports which of its own values are null (`nulls`) so a
//       view can render a blank with a reason instead of inventing a number.
//
// Two things the recorded data cannot answer, stated once and repeated in the
// output rather than filled in:
//   * cost per model — `rollupRecord` sums `usage.cost.estimatedUsd` per
//     POOL. The `models` map carries attempts and minutes only, so every
//     model's apiEquivalentUsd is null.
//   * a run's licence draw — `normalizedQuota.estimatedPercent` is null on
//     all 877 recorded attempts, so no per-run percentage exists to total.

import { dayKey } from './history.js';
import { isDeliveredWorkflowStatus } from './status.js';

/** The period toggle, in the order the toggle shows them. */
export const PERIODS = Object.freeze(['7d', '30d', 'all']);

/** The Trends tab's metrics, in the order the tab cycles them. */
export const TREND_METRICS = Object.freeze(['runs', 'spend', 'minutes', 'verified']);

// A heat grid is capped at 53 columns so a machine with years of history
// cannot hand the view an unbounded array. Today's corpus is 15 days.
const MAX_HEAT_WEEKS = 53;
const WEEK_DAYS = 7;

// '7d' and '30d' are the toggle's own words. The rest are the aliases the
// Budget page speaks ('week'), kept here so one range function serves both.
const PERIOD_ALIASES = {
  '7d': '7d', '7': '7d', d7: '7d', week: '7d', weekly: '7d', w: '7d',
  '30d': '30d', '30': '30d', d30: '30d', month: '30d', monthly: '30d', mo: '30d',
  day: 'day', '1d': 'day', today: 'day',
  all: 'all', alltime: 'all', 'all-time': 'all', ever: 'all',
};
const PERIOD_DAYS = { day: 1, '7d': 7, '30d': 30, all: null };

// ---------------------------------------------------------------- primitives

// S1. Number(null) is 0, Number('') is 0, Number(false) is 0. A recorded null
// means "not measured" and has to stay null all the way to the screen.
function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseIso(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Local-calendar arithmetic through Date, whose zone is the same system zone
// history.js resolves through Intl — so a bucket boundary and a dayKey() can
// never disagree. Adding days through setDate() survives a DST change that
// adding 86_400_000 ms would slide by an hour.
function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// history.js dayKey() resolves the zone through Intl and formats through
// Intl.DateTimeFormat.formatToParts — about 20 µs a call. Home asks for a day
// key roughly five times per run, so at 181 runs that alone was 21 ms of a
// 50 ms paint budget, measured on this machine's corpus 2026-09-16.
//
// Node's Date local methods read the same ICU default zone dayKey() resolves,
// so the components of `new Date(ms)` give the same key far more cheaply. The
// equality is checked rather than assumed: four probe instants spread over a
// year are formatted both ways, and the fast path is used only when all four
// agree. dayKey() stays the authority.
//
// The re-probe guard is `getTimezoneOffset()` (a sub-microsecond Date method)
// rather than the resolved zone name, because resolving the name means
// building an Intl.DateTimeFormat — which is the cost this whole path exists
// to avoid.
let probedOffset = null;
let fastKeyOk = false;

function componentsKey(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayKeyOf(value) {
  if (value == null) return null;
  const offset = new Date().getTimezoneOffset();
  if (offset !== probedOffset) {
    probedOffset = offset;
    const probe = Date.now();
    fastKeyOk = [0, 43_200_000, 15_768_000_000, 31_536_000_000]
      .every((back) => dayKey(probe - back) === componentsKey(probe - back));
  }
  if (!fastKeyOk) return dayKey(value);
  const ms = parseIso(value);
  return ms == null ? null : componentsKey(ms);
}

/** 0 = Monday … 6 = Sunday, so a heat column is one calendar week. */
function weekdayIndex(ms) {
  return (new Date(ms).getDay() + 6) % 7;
}

function startOfWeek(ms) {
  return addDays(startOfDay(ms), -weekdayIndex(ms));
}

/** S3. A real median: the middle value, or the mean of the middle pair. */
function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** S1. Adds into a null accumulator: null + nothing stays null. */
function add(total, value) {
  return value == null ? total : (total ?? 0) + value;
}

function share(part, whole) {
  if (part == null || whole == null || whole <= 0) return null;
  return round(part / whole, 4);
}

function normalizePeriod(period) {
  const key = String(period ?? '7d').trim().toLowerCase();
  // An unrecognised period falls back to the toggle's default rather than
  // throwing: a dashboard that repaints every second must not die of a typo.
  return PERIOD_ALIASES[key] ?? '7d';
}

/**
 * The window a period covers.
 *
 * `from` is local midnight `days - 1` days back, so '7d' is seven calendar
 * days ending today rather than a rolling 168 hours. 'all' has no lower
 * bound and reports `from: null`.
 *
 * @param {string} period  '7d' | '30d' | 'all' (also 'day', and the Budget
 *                         page's 'week'/'month' aliases)
 * @param {number} [now]
 * @returns {{period: string, from: number|null, to: number, days: number|null}}
 */
export function periodRange(period, now = Date.now()) {
  const at = finite(now) ?? Date.now();
  const key = normalizePeriod(period);
  const days = PERIOD_DAYS[key];
  return {
    period: key,
    from: days == null ? null : addDays(at, -(days - 1)),
    to: at,
    days,
  };
}

// -------------------------------------------------------------- record reads

function toRecords(rollups) {
  return (Array.isArray(rollups) ? rollups : []).filter((record) => (
    record && typeof record === 'object'
  ));
}

// The same ordering key readRollups sorts by: a run is placed on the day it
// finished, and only falls back to its start when it recorded no finish.
function recordTimeMs(record) {
  return parseIso(record?.finishedAt) ?? parseIso(record?.startedAt);
}

function inRange(record, from, to) {
  const ms = recordTimeMs(record);
  if (ms == null) return false;
  if (from != null && ms < from) return false;
  if (to != null && ms > to) return false;
  return true;
}

function selectRecords(records, { from, to }) {
  return records
    .filter((record) => inRange(record, from, to))
    .sort((a, b) => (recordTimeMs(b) ?? 0) - (recordTimeMs(a) ?? 0));
}

function mapEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
}

/** S2. The run's whole recorded estimate: null when no attempt recorded one. */
function recordCostUsd(record) {
  let total = null;
  for (const [, entry] of mapEntries(record?.pools)) total = add(total, finite(entry?.costUsd));
  return total;
}

/** Worker-minutes: the attempt wall time the run spent inside its pools. */
function recordWorkerMinutes(record) {
  let total = null;
  for (const [, entry] of mapEntries(record?.pools)) total = add(total, finite(entry?.minutes));
  return total;
}

function recordProject(record) {
  const name = record?.project;
  return typeof name === 'string' && name.trim() ? name.trim() : 'unknown';
}

// Which pool a whole-run count belongs to, when a stacked bar counts runs and
// a run is one thing. The pool that did the most worker-minutes owns the run;
// ties go to attempts, then to the name, so the answer is stable. Stated as a
// basis on the model rather than left to look exact.
function dominantPool(record) {
  let best = null;
  for (const [name, entry] of mapEntries(record?.pools)) {
    const candidate = {
      name,
      minutes: finite(entry?.minutes) ?? 0,
      attempts: finite(entry?.attempts) ?? 0,
    };
    if (!best
      || candidate.minutes > best.minutes
      || (candidate.minutes === best.minutes && candidate.attempts > best.attempts)
      || (candidate.minutes === best.minutes && candidate.attempts === best.attempts
        && candidate.name < best.name)) best = candidate;
  }
  return best?.name ?? 'unknown';
}

function dominantModel(record) {
  let best = null;
  for (const [name, entry] of mapEntries(record?.models)) {
    const candidate = { name, minutes: finite(entry?.minutes) ?? 0, attempts: finite(entry?.attempts) ?? 0 };
    if (!best
      || candidate.minutes > best.minutes
      || (candidate.minutes === best.minutes && candidate.attempts > best.attempts)
      || (candidate.minutes === best.minutes && candidate.attempts === best.attempts
        && candidate.name < best.name)) best = candidate;
  }
  return best?.name ?? 'unknown';
}

// ---------------------------------------------------------------- row tables

function newRow(name) {
  return {
    name,
    runs: 0,
    attempts: 0,
    minutes: null,
    apiEquivalentUsd: null,
    tokens: null,
    workflowsCompleted: 0,
    verified: 0,
    wallMinutes: [],
  };
}

function countRun(row, record) {
  row.runs += 1;
  if (isDeliveredWorkflowStatus(record?.status)) row.workflowsCompleted += 1;
  if (record?.verified === true) row.verified += 1;
  const wall = finite(record?.minutes?.wall);
  if (wall != null) row.wallMinutes.push(wall);
}

/**
 * One row per pool, per model, or per project.
 *
 * `kind: 'pool'` and `'model'` read the record's per-pool / per-model maps, so
 * one run contributes a row to every pool and model it touched. `'project'`
 * reads the single project the run recorded.
 */
function buildRows(records, kind) {
  const rows = new Map();
  const rowFor = (name) => {
    let row = rows.get(name);
    if (!row) { row = newRow(name); rows.set(name, row); }
    return row;
  };

  for (const record of records) {
    if (kind === 'project') {
      const row = rowFor(recordProject(record));
      countRun(row, record);
      // A project's attempts are every attempt the run made, everywhere.
      for (const [, entry] of mapEntries(record.pools)) row.attempts += finite(entry?.attempts) ?? 0;
      row.minutes = add(row.minutes, recordWorkerMinutes(record));
      row.apiEquivalentUsd = add(row.apiEquivalentUsd, recordCostUsd(record));
      for (const [, entry] of mapEntries(record.pools)) row.tokens = add(row.tokens, finite(entry?.tokens));
      continue;
    }
    for (const [name, entry] of mapEntries(record[kind === 'pool' ? 'pools' : 'models'])) {
      const row = rowFor(name);
      countRun(row, record);
      row.attempts += finite(entry?.attempts) ?? 0;
      row.minutes = add(row.minutes, finite(entry?.minutes));
      // S2. The models map has no costUsd at all, so this stays null for
      // every model — which is the honest answer, not a zero.
      row.apiEquivalentUsd = add(row.apiEquivalentUsd, finite(entry?.costUsd));
      row.tokens = add(row.tokens, finite(entry?.tokens));
    }
  }
  return [...rows.values()];
}

function finishRows(rows, { rankBy = 'attempts' } = {}) {
  let totalMinutes = null;
  for (const row of rows) totalMinutes = add(totalMinutes, row.minutes);
  const finished = rows.map((row) => ({
    name: row.name,
    runs: row.runs,
    attempts: row.attempts,
    minutes: round(row.minutes, 2),
    medianWallMinutes: round(median(row.wallMinutes), 2),
    apiEquivalentUsd: round(row.apiEquivalentUsd, 6),
    tokens: row.tokens == null ? null : Math.round(row.tokens),
    workflowsCompleted: row.workflowsCompleted,
    okShare: row.runs ? share(row.workflowsCompleted, row.runs) : null,
    verified: row.verified,
    verifiedShare: row.runs ? share(row.verified, row.runs) : null,
    minutesShare: share(row.minutes, totalMinutes),
  }));
  finished.sort((a, b) => (b[rankBy] ?? 0) - (a[rankBy] ?? 0)
    || (b.minutes ?? 0) - (a.minutes ?? 0)
    || a.name.localeCompare(b.name));
  return finished;
}

function rowTotals(rows) {
  const totals = {
    rows: rows.length, runs: 0, attempts: 0, minutes: null, apiEquivalentUsd: null, workflowsCompleted: 0,
  };
  for (const row of rows) {
    totals.runs += row.runs;
    totals.attempts += row.attempts;
    totals.minutes = add(totals.minutes, row.minutes);
    totals.apiEquivalentUsd = add(totals.apiEquivalentUsd, row.apiEquivalentUsd);
    totals.workflowsCompleted += row.workflowsCompleted;
  }
  totals.minutes = round(totals.minutes, 2);
  totals.apiEquivalentUsd = round(totals.apiEquivalentUsd, 6);
  return totals;
}

// S5. Which values in a model are null, as dotted paths, so a view can render
// the blank and name the reason instead of printing a confident 0.
function nullPaths(value, prefix = '', out = []) {
  if (value === null) { out.push(prefix); return out; }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nullPaths(entry, prefix ? `${prefix}.${index}` : String(index), out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      nullPaths(entry, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

// --------------------------------------------------------------- live pools

function poolCredits(pool) {
  const declared = pool?.credits;
  if (declared && typeof declared === 'object') {
    const used = finite(declared.used);
    const limit = finite(declared.limit);
    if (used != null && limit != null) {
      return { used, limit, unit: typeof declared.unit === 'string' && declared.unit ? declared.unit : 'credits' };
    }
  }
  const quota = pool?.meterSnapshot?.monthly_quota ?? null;
  const used = finite(quota?.used);
  const limit = finite(quota?.limit);
  if (used == null || limit == null) return null;
  return { used, limit, unit: typeof quota?.unit === 'string' && quota.unit ? quota.unit : 'credits' };
}

function liveMeter(pool) {
  return {
    usedPct: finite(pool?.usedPct),
    elapsedPct: finite(pool?.elapsedPct),
    pace: finite(pool?.pace),
    resetsAt: typeof pool?.paceResetsAt === 'string' ? pool.paceResetsAt : null,
    resetSource: pool?.resetSource ?? null,
    window: pool?.pacingWindow ?? null,
    meterSource: pool?.meterSource ?? 'none',
    credits: poolCredits(pool),
  };
}

function livePools(pools) {
  return (Array.isArray(pools) ? pools : []).filter((pool) => (
    pool && typeof pool === 'object' && typeof pool.name === 'string'
  ));
}

// ------------------------------------------------------------------- trends

const TREND_DEFAULT_SEGMENT = {
  // Money is recorded per pool, so a spend bar splits by pool exactly.
  spend: 'pool',
  // Worker-minutes are the model's own measure: per-model is the split that
  // carries the information here, and it is exactly additive.
  minutes: 'model',
  // A run is one thing; it is placed on the pool that did most of its work.
  runs: 'pool',
  verified: 'pool',
};

function normalizeMetric(metric) {
  const key = String(metric ?? 'runs').trim().toLowerCase();
  return TREND_METRICS.includes(key) ? key : 'runs';
}

function metricValue(record, metric) {
  if (metric === 'runs') return 1;
  if (metric === 'verified') return record?.verified === true ? 1 : 0;
  if (metric === 'spend') return recordCostUsd(record);
  return recordWorkerMinutes(record);
}

function metricSegments(record, metric, segmentBy) {
  if (metric === 'runs' || metric === 'verified') {
    const value = metricValue(record, metric);
    if (!value) return [];
    const name = segmentBy === 'model' ? dominantModel(record)
      : segmentBy === 'project' ? recordProject(record)
        : dominantPool(record);
    return [{ name, value }];
  }
  if (segmentBy === 'project') {
    const value = metricValue(record, metric);
    return value == null ? [] : [{ name: recordProject(record), value }];
  }
  if (metric === 'spend') {
    // Cost is recorded per pool only; there is no per-model figure to split.
    if (segmentBy === 'model') return [];
    return mapEntries(record?.pools)
      .map(([name, entry]) => ({ name, value: finite(entry?.costUsd) }))
      .filter((segment) => segment.value != null);
  }
  return mapEntries(record?.[segmentBy === 'pool' ? 'pools' : 'models'])
    .map(([name, entry]) => ({ name, value: finite(entry?.minutes) }))
    .filter((segment) => segment.value != null);
}

function segmentBasis(metric, segmentBy) {
  if (metric === 'spend' && segmentBy === 'model') {
    return 'no split: the rollup records cost per pool, not per model';
  }
  if (metric === 'runs' || metric === 'verified') {
    return segmentBy === 'project'
      ? 'the project each run recorded'
      : `the ${segmentBy} with the most worker-minutes in each run`;
  }
  if (metric === 'spend') return 'the recorded API-equivalent estimate per pool';
  return `measured worker-minutes per ${segmentBy}`;
}

/**
 * One metric bucketed over a period, with the per-pool (or per-model) split
 * of each bucket.
 *
 * '7d' and '30d' bucket by calendar day, 'all' by calendar week (Monday).
 * S4: buckets start at the oldest run on record when the period reaches
 * further back than the history does — `requestedFrom` and `truncated` say
 * when that happened so the view can label it.
 *
 * `runs` and `verified` are counts, so an empty bucket is a measured 0.
 * `spend` and `minutes` are sums of recorded figures, so an empty bucket is
 * null — never a zero-dollar day (S1).
 *
 * @param {Array<object>} rollups
 * @param {{metric?: string, period?: string, now?: number, segmentBy?: string|null}} [options]
 * @returns {{metric: string, period: string, bucketBy: 'day'|'week',
 *            from: number|null, to: number, requestedFrom: number|null,
 *            truncated: boolean, segmentBy: string, segmentBasis: string,
 *            buckets: Array<{key: string, label: string, from: number, to: number,
 *                            weekday: number|null, runs: number, value: number|null,
 *                            segments: Array<{name: string, value: number}>}>,
 *            total: number|null, cumulative: Array<number|null>, max: number|null,
 *            unit: string, nulls: string[]}}
 */
export function trendModel(rollups, { metric = 'runs', period = '7d', now = Date.now(), segmentBy = null } = {}) {
  const chosenMetric = normalizeMetric(metric);
  const range = periodRange(period, now);
  const records = toRecords(rollups);
  const inPeriod = selectRecords(records, range);
  const split = ['pool', 'model', 'project'].includes(segmentBy)
    ? segmentBy
    : TREND_DEFAULT_SEGMENT[chosenMetric];
  const bucketBy = range.period === 'all' ? 'week' : 'day';
  const isCount = chosenMetric === 'runs' || chosenMetric === 'verified';

  const times = inPeriod.map(recordTimeMs).filter((ms) => ms != null);
  const oldest = times.length ? Math.min(...times) : null;
  const startOfBucket = bucketBy === 'week' ? startOfWeek : startOfDay;
  const step = bucketBy === 'week' ? WEEK_DAYS : 1;

  const requestedFrom = range.from;
  // S4: never further back than the history that exists.
  const firstBucket = oldest == null ? null
    : startOfBucket(requestedFrom == null ? oldest : Math.max(requestedFrom, oldest));
  const lastBucket = startOfBucket(range.to);

  const buckets = [];
  if (firstBucket != null) {
    for (let at = firstBucket; at <= lastBucket; at = addDays(at, step)) {
      buckets.push({
        key: dayKeyOf(at),
        label: dayKeyOf(at),
        from: at,
        to: addDays(at, step),
        weekday: bucketBy === 'day' ? weekdayIndex(at) : null,
        runs: 0,
        value: isCount ? 0 : null,
        segments: new Map(),
      });
    }
  }

  const bucketAt = (ms) => {
    if (ms == null || !buckets.length) return null;
    const start = startOfBucket(ms);
    // Linear scan: 30 buckets at most for a day period, one per week for
    // 'all'. A map keyed by the bucket key is the same cost at this size.
    return buckets.find((bucket) => bucket.from === start) ?? null;
  };

  for (const record of inPeriod) {
    const bucket = bucketAt(recordTimeMs(record));
    if (!bucket) continue;
    bucket.runs += 1;
    const value = metricValue(record, chosenMetric);
    if (value != null) bucket.value = (bucket.value ?? 0) + value;
    for (const segment of metricSegments(record, chosenMetric, split)) {
      bucket.segments.set(segment.name, (bucket.segments.get(segment.name) ?? 0) + segment.value);
    }
  }

  let total = isCount ? 0 : null;
  let max = null;
  const cumulative = [];
  const out = buckets.map((bucket) => {
    const value = bucket.value == null ? null : round(bucket.value, chosenMetric === 'spend' ? 6 : 2);
    if (value != null) {
      total = (total ?? 0) + value;
      max = max == null ? value : Math.max(max, value);
    }
    cumulative.push(total == null ? null : round(total, chosenMetric === 'spend' ? 6 : 2));
    return {
      key: bucket.key,
      label: bucket.label,
      from: bucket.from,
      to: bucket.to,
      weekday: bucket.weekday,
      runs: bucket.runs,
      value,
      segments: [...bucket.segments.entries()]
        .map(([name, amount]) => ({ name, value: round(amount, chosenMetric === 'spend' ? 6 : 2) }))
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
    };
  });

  const model = {
    metric: chosenMetric,
    period: range.period,
    bucketBy,
    from: buckets.length ? buckets[0].from : null,
    to: range.to,
    requestedFrom,
    truncated: requestedFrom != null && buckets.length > 0 && buckets[0].from > startOfBucket(requestedFrom),
    segmentBy: split,
    segmentBasis: segmentBasis(chosenMetric, split),
    buckets: out,
    total: total == null ? null : round(total, chosenMetric === 'spend' ? 6 : 2),
    cumulative,
    max,
    unit: chosenMetric === 'spend' ? 'apiEquivalentUsd'
      : chosenMetric === 'minutes' ? 'worker-minutes' : 'runs',
  };
  model.nulls = nullPaths({ from: model.from, total: model.total, max: model.max });
  return model;
}

// ------------------------------------------------------------------ tables

/**
 * The Pools table: what ran where over the period, joined to the live meter.
 *
 * Every live pool gets a row even with no runs in the period — a pool at 94%
 * of its licence with nothing to show for it this week is exactly the row a
 * reader is looking for. A pool that only appears in history (renamed,
 * removed) keeps its row too, with `live: null`.
 */
export function poolsModel(rollups, pools, { period = '7d', now = Date.now() } = {}) {
  const range = periodRange(period, now);
  const records = selectRecords(toRecords(rollups), range);
  const rows = finishRows(buildRows(records, 'pool'), { rankBy: 'attempts' });
  const byName = new Map(rows.map((row) => [row.name, row]));
  const live = new Map(livePools(pools).map((pool) => [pool.name, pool]));

  // A live pool with no runs this period still gets a row: a pool at 94% of
  // its licence with nothing to show for it is the row a reader wants.
  for (const name of live.keys()) {
    if (!byName.has(name)) byName.set(name, finishRows([newRow(name)])[0]);
  }
  const merged = [...byName.values()].map((row) => {
    const pool = live.get(row.name) ?? null;
    return {
      ...row,
      live: pool ? liveMeter(pool) : null,
      enabled: pool ? pool.enabled !== false : null,
      lanes: pool?.lanes ?? null,
    };
  });
  merged.sort((a, b) => b.attempts - a.attempts
    || (b.minutes ?? 0) - (a.minutes ?? 0)
    || a.name.localeCompare(b.name));

  const model = {
    kind: 'pools',
    period: range.period,
    from: range.from,
    to: range.to,
    rows: merged,
    totals: rowTotals(merged),
    mostUsed: merged.find((row) => row.attempts > 0)?.name ?? null,
    notes: [],
  };
  model.nulls = nullPaths({ rows: merged.map((row) => ({ name: row.name, apiEquivalentUsd: row.apiEquivalentUsd, medianWallMinutes: row.medianWallMinutes })) });
  return model;
}

/**
 * The Models table.
 *
 * `apiEquivalentUsd` is null on every row and stays null: `rollupRecord`
 * totals `usage.cost.estimatedUsd` per pool, and the per-model map carries
 * attempts and minutes only. There is no per-model cost to show, so the model
 * says so in `notes` rather than dividing a pool total by attempts.
 */
export function modelsModel(rollups, { period = '7d', now = Date.now() } = {}) {
  const range = periodRange(period, now);
  const records = selectRecords(toRecords(rollups), range);
  const rows = finishRows(buildRows(records, 'model'), { rankBy: 'attempts' });
  const model = {
    kind: 'models',
    period: range.period,
    from: range.from,
    to: range.to,
    rows,
    totals: rowTotals(rows),
    mostUsed: rows.find((row) => row.attempts > 0)?.name ?? null,
    notes: ['apiEquivalentUsd is null for every model: the rollup record measures cost per pool, not per model'],
  };
  model.nulls = nullPaths({ rows: rows.map((row) => ({ name: row.name, apiEquivalentUsd: row.apiEquivalentUsd, medianWallMinutes: row.medianWallMinutes })) });
  return model;
}

/** The Projects table: one row per project a run recorded. */
export function projectsModel(rollups, { period = '7d', now = Date.now() } = {}) {
  const range = periodRange(period, now);
  const records = selectRecords(toRecords(rollups), range);
  const rows = finishRows(buildRows(records, 'project'), { rankBy: 'runs' });
  const model = {
    kind: 'projects',
    period: range.period,
    from: range.from,
    to: range.to,
    rows,
    totals: rowTotals(rows),
    mostUsed: rows.find((row) => row.runs > 0)?.name ?? null,
    notes: rows.some((row) => row.name === 'unknown')
      ? ['"unknown" is the runs that recorded no project — legacy runs and runs started before project identity shipped']
      : [],
  };
  model.nulls = nullPaths({ rows: rows.map((row) => ({ name: row.name, apiEquivalentUsd: row.apiEquivalentUsd, medianWallMinutes: row.medianWallMinutes })) });
  return model;
}

// ----------------------------------------------------------------- overview

function todayTiles(records, now) {
  const today = dayKeyOf(now);
  const finishedToday = records.filter((record) => dayKeyOf(record.finishedAt) === today);
  let apiEquivalentUsd = null;
  let priced = 0;
  for (const record of finishedToday) {
    const cost = recordCostUsd(record);
    if (cost != null) { apiEquivalentUsd = add(apiEquivalentUsd, cost); priced += 1; }
  }
  const verified = finishedToday.filter((record) => record.verified === true).length;
  return {
    date: today,
    started: records.filter((record) => dayKeyOf(record.startedAt) === today).length,
    finished: finishedToday.length,
    verified,
    // S1. A share of nothing is not 0%.
    verifiedShare: finishedToday.length ? share(verified, finishedToday.length) : null,
    apiEquivalentUsd: round(apiEquivalentUsd, 6),
    // How much of today's tile is actually sourced, for the view's label.
    pricedRuns: priced,
    basis: 'recorded per-attempt API-equivalent estimates, summed over the runs that finished today',
  };
}

function licenceTile(pools) {
  const list = livePools(pools);
  const metered = list
    .map((pool) => ({ name: pool.name, ...liveMeter(pool) }))
    .filter((pool) => pool.usedPct != null);
  if (!metered.length) {
    return {
      pools: [],
      metered: 0,
      total: list.length,
      maxUsedPct: null,
      maxPool: null,
      meanUsedPct: null,
      basis: 'no pool reported a licence meter',
    };
  }
  const top = metered.reduce((best, pool) => (pool.usedPct > best.usedPct ? pool : best), metered[0]);
  const mean = metered.reduce((sum, pool) => sum + pool.usedPct, 0) / metered.length;
  return {
    pools: metered,
    metered: metered.length,
    total: list.length,
    maxUsedPct: round(top.usedPct, 1),
    maxPool: top.name,
    // Each pool is measured in its own pacing window, so this is a mean of
    // per-pool percentages and nothing more. Named so it cannot be mistaken
    // for a total, and the view prints the basis beside it.
    meanUsedPct: round(mean, 1),
    basis: `live pool meters, each in its own pacing window (${metered.length} of ${list.length} pools metered)`,
  };
}

function heatCells(records, now) {
  const times = records.map(recordTimeMs).filter((ms) => ms != null);
  if (!times.length) {
    return { days: [], weeks: [], from: null, to: null, spanDays: 0, max: null, truncated: false };
  }
  const last = startOfDay(now);
  const earliest = startOfDay(Math.min(...times));
  // The grid is whole weeks so its columns line up, and it is sized to the
  // history that exists: 15 distinct days of V2 history is three columns, not
  // a months-wide field of blanks.
  const cap = addDays(startOfWeek(last), -(MAX_HEAT_WEEKS - 1) * WEEK_DAYS);
  const firstWeek = Math.max(startOfWeek(earliest), cap);

  const perDay = new Map();
  for (const record of records) {
    const ms = recordTimeMs(record);
    if (ms == null) continue;
    const key = dayKeyOf(ms);
    const cell = perDay.get(key) ?? { runs: 0, verified: 0 };
    cell.runs += 1;
    if (record.verified === true) cell.verified += 1;
    perDay.set(key, cell);
  }

  const days = [];
  for (let at = firstWeek; at <= last; at = addDays(at, 1)) {
    const key = dayKeyOf(at);
    const cell = perDay.get(key) ?? { runs: 0, verified: 0 };
    days.push({
      date: key,
      at,
      weekday: weekdayIndex(at),
      runs: cell.runs,
      verified: cell.verified,
      // Days before the first run on record are outside the history, not
      // quiet days: the view renders them blank rather than as a cold cell.
      inHistory: at >= earliest,
      value: 0,
    });
  }
  const max = days.reduce((best, day) => Math.max(best, day.runs), 0);
  for (const day of days) day.value = max > 0 ? round(day.runs / max, 4) : 0;

  const weeks = [];
  for (let index = 0; index < days.length; index += WEEK_DAYS) {
    const column = new Array(WEEK_DAYS).fill(null);
    for (const day of days.slice(index, index + WEEK_DAYS)) column[day.weekday] = day;
    weeks.push(column);
  }
  return {
    days,
    weeks,
    from: days.length ? days[0].date : null,
    to: days.length ? days[days.length - 1].date : null,
    spanDays: days.filter((day) => day.inHistory).length,
    max: max > 0 ? max : null,
    truncated: startOfWeek(earliest) < cap,
  };
}

function keyValues(records) {
  const pools = finishRows(buildRows(records, 'pool'), { rankBy: 'attempts' });
  const models = finishRows(buildRows(records, 'model'), { rankBy: 'attempts' });
  const projects = finishRows(buildRows(records, 'project'), { rankBy: 'runs' });
  const wall = records.map((record) => finite(record?.minutes?.wall)).filter((value) => value != null);
  let agent = null;
  for (const record of records) agent = add(agent, finite(record?.minutes?.agent));
  const days = new Set(records.map((record) => dayKeyOf(record.finishedAt) ?? dayKeyOf(record.startedAt)).filter(Boolean));

  const top = (rows, field) => {
    const row = rows.find((entry) => (entry[field] ?? 0) > 0);
    return row ? { name: row.name, runs: row.runs, attempts: row.attempts, minutes: row.minutes } : null;
  };
  return {
    workflows: records.length,
    activeDays: days.size,
    favouritePool: top(pools, 'attempts'),
    busiestProject: top(projects, 'runs'),
    favouriteModel: top(models, 'attempts'),
    // S3. The median run's wall clock, over the runs that recorded one.
    medianRunMinutes: round(median(wall), 2),
    longestRunMinutes: wall.length ? round(Math.max(...wall), 2) : null,
    totalAgentMinutes: round(agent, 2),
    totalWorkerMinutes: round(records.reduce((sum, record) => add(sum, recordWorkerMinutes(record)), null), 2),
  };
}

/**
 * The Home / Stats Overview model.
 *
 * Today's tiles are the runs that FINISHED today (the same attribution
 * history.js uses); the breakdown, the heat grid and the key-value block
 * cover the selected period, except the heat grid which is sized to the whole
 * history that exists.
 *
 * @param {Array<object>} rollups  rollup records, any order
 * @param {Array<object>} pools    the live pool list from buildPools
 * @param {{period?: string, now?: number}} [options]
 */
export function overviewModel(rollups, pools, { period = '7d', now = Date.now() } = {}) {
  const at = finite(now) ?? Date.now();
  const range = periodRange(period, at);
  const all = toRecords(rollups);
  const inPeriod = selectRecords(all, range);

  const model = {
    period: range.period,
    from: range.from,
    to: range.to,
    today: { ...todayTiles(all, at), licence: licenceTile(pools) },
    breakdown: {
      pools: finishRows(buildRows(inPeriod, 'pool'), { rankBy: 'attempts' }),
      models: finishRows(buildRows(inPeriod, 'model'), { rankBy: 'attempts' }),
      projects: finishRows(buildRows(inPeriod, 'project'), { rankBy: 'runs' }),
    },
    heat: heatCells(all, at),
    keys: keyValues(inPeriod),
    notes: ['model cost is not recorded per model; the breakdown by model carries attempts and minutes only'],
  };
  // S5. Every null in the tiles, the heat header and the key-value block,
  // by path, so the view blanks them deliberately.
  model.nulls = nullPaths({ today: model.today, heat: { from: model.heat.from, to: model.heat.to, max: model.heat.max }, keys: model.keys });
  return model;
}
