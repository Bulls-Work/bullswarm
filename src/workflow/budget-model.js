// The Budget page's arithmetic: one licence meter per pool, the workflows /
// rest split, the money, and how many more runs the remaining licence allows.
//
// Maths only — no rendering, no ANSI, no terminal.
//
// Doctrine:
//   B1. There are exactly two kinds of money here and both say what they are.
//       `apiEquivalentUsd` is the API-equivalent estimate the runs actually
//       recorded. `subscription` is money at a DECLARED subscription rate and
//       is null unless priceFor() returned one. There is no third kind, and
//       neither is ever derived from the other.
//   B2. A per-run licence draw may only be `ratePerMinute × worker-minutes`,
//       carrying the rate's own source and sample count, and is null when the
//       rate is null. `normalizedQuota.estimatedPercent` is null on all 877
//       recorded attempts, so there is no measured per-run percentage.
//   B3. The share bar is `workflows / rest`. There is no `you, interactive`
//       term: the CLI has no source for it, and inventing one would put a
//       number on screen that nothing measured.
//   B4. The reset is an absolute date and time in the reader's own resolved
//       zone, named. No hard-coded zone anywhere in this file.
//   B5. Every figure with no source is null, never 0, and the model says
//       which ones are null.

import { priceFor, subscriptionCostUsd } from '../lib/prices.js';
import { formatDashboardValue } from './dash-kit.js';
import { periodRange } from './stats-model.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// The lengths of the windows a pool can be paced by (src/meters/framework.js
// normalizePacingWindow resolves to exactly these two, or null).
const WINDOW_MS = { weekly: 7 * DAY_MS, monthly: 30 * DAY_MS };

// The same ±15pp thresholds src/workflow/usage-view.js paceWord() uses, so
// the Budget page and the pool rows never disagree about whether a pool is
// hot. The word only; the colour belongs to the view.
const PACE_THRESHOLD_PP = 15;

// ---------------------------------------------------------------- primitives

// Number(null) is 0. A missing price, a missing rate and a missing estimate
// all have to stay null (B5).
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

function add(total, value) {
  return value == null ? total : (total ?? 0) + value;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

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

// ------------------------------------------------------------------ the zone

// B4. Resolved at call time, so a laptop that crosses a border, or a test
// that pins TZ, gets its own zone rather than the one that was current when
// this module was first imported.
function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

/**
 * The absolute moment a licence window resets, with the zone named.
 *
 * `en-GB` fixes the field order so the text reads the same on every machine;
 * the ZONE is always the reader's own, resolved now (B4). A pool with no
 * reset time has no text — null, not "unknown".
 */
function resetsTextOf(iso) {
  const ms = parseIso(iso);
  if (ms == null) return null;
  const timeZone = localTimeZone();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

// ------------------------------------------------------------- record reads

function toRecords(rollups) {
  return (Array.isArray(rollups) ? rollups : []).filter((record) => record && typeof record === 'object');
}

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

function poolEntry(record, pool) {
  const pools = record?.pools;
  if (!pools || typeof pools !== 'object') return null;
  return pool == null ? null : pools[pool] ?? null;
}

/** Worker-minutes a record spent, on one pool or across all of them. */
function workerMinutesOf(record, pool = null) {
  if (pool != null) return finite(poolEntry(record, pool)?.minutes);
  let total = null;
  for (const entry of Object.values(record?.pools ?? {})) total = add(total, finite(entry?.minutes));
  return total;
}

/** The recorded API-equivalent estimate, on one pool or across all of them. */
function apiEquivalentOf(record, pool = null) {
  if (pool != null) return finite(poolEntry(record, pool)?.costUsd);
  let total = null;
  for (const entry of Object.values(record?.pools ?? {})) total = add(total, finite(entry?.costUsd));
  return total;
}

// ------------------------------------------------------------------- pacing

function poolName(pool) {
  if (typeof pool === 'string') return pool.trim() || null;
  const name = pool?.name ?? pool?.pool ?? null;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function pacingWindowOf(pool) {
  const window = typeof pool?.pacingWindow === 'string' ? pool.pacingWindow.trim().toLowerCase() : null;
  return window && Object.hasOwn(WINDOW_MS, window) ? window : null;
}

/** `slow` | `on track` | `hot`, or null with no elapsed mark to compare to. */
function paceWordOf(usedPct, elapsedPct) {
  if (usedPct == null || elapsedPct == null) return null;
  const pp = elapsedPct - usedPct;
  if (pp >= PACE_THRESHOLD_PP) return 'slow';
  if (pp <= -PACE_THRESHOLD_PP) return 'hot';
  return 'on track';
}

function creditsOf(pool) {
  const declared = pool?.credits;
  const quota = declared && typeof declared === 'object' ? declared : pool?.meterSnapshot?.monthly_quota ?? null;
  const used = finite(quota?.used);
  const limit = finite(quota?.limit);
  if (used == null || limit == null) return null;
  return {
    used,
    limit,
    unit: typeof quota?.unit === 'string' && quota.unit ? quota.unit : 'credits',
    remaining: round(limit - used, 4),
  };
}

/**
 * The window the pool's own meter is measuring right now: its reset time,
 * back one window length. Comparing worker-minutes against `usedPct` is only
 * honest over the window `usedPct` was measured in, so the share bar uses
 * this range and not the page's period.
 */
function licenceWindowRange(pool, now) {
  const window = pacingWindowOf(pool);
  const resetMs = parseIso(pool?.paceResetsAt);
  if (window == null || resetMs == null) return null;
  return {
    from: resetMs - WINDOW_MS[window],
    to: now,
    window,
    source: `the pool's ${window} meter window, back from its reset time`,
    stale: resetMs < now,
  };
}

function rateBlock(pool) {
  const pacing = pool?.spend?.pacing ?? null;
  return {
    ratePerMinute: finite(pacing?.ratePerMinute),
    source: pacing?.source ?? null,
    samples: finite(pacing?.samples),
    window: pacing?.window ?? pacingWindowOf(pool),
  };
}

// -------------------------------------------------------------------- price

/**
 * Resolve one pool's declared subscription economics.
 *
 * `prices` is tolerant on purpose, because three callers hold three different
 * things: nothing (resolve from the pool's own merged subscription and the
 * bundled table), a `state.strategy.subscriptions` map, a priceFor options
 * bag, or a function. It never invents a price: every path ends at priceFor,
 * which returns null without a declared `monthlyPriceUsd`.
 */
function resolvePrice(pool, prices) {
  const name = poolName(pool);
  if (!name) return null;
  if (typeof prices === 'function') return prices(pool) ?? null;
  const own = pool?.subscription && typeof pool.subscription === 'object'
    ? { [name]: pool.subscription }
    : {};
  if (prices && typeof prices === 'object') {
    if (prices.subscriptions || prices.file) {
      return priceFor(name, { subscriptions: prices.subscriptions ?? own, file: prices.file ?? null });
    }
    const fromMap = priceFor(name, { subscriptions: prices });
    if (fromMap) return fromMap;
  }
  return priceFor(name, { subscriptions: own });
}

// --------------------------------------------------------------- one pool

/**
 * One pool's Budget row.
 *
 * @param {object} pool  a pool from buildPools (usedPct, elapsedPct, pace,
 *                       paceResetsAt, resetSource, pacingWindow, spend, …)
 * @param {{rollups?: Array<object>, prices?: *, period?: string, now?: number}} [options]
 */
export function poolBudget(pool, { rollups = [], prices = null, period = 'week', now = Date.now() } = {}) {
  const at = finite(now) ?? Date.now();
  const name = poolName(pool);
  const range = periodRange(period, at);
  // A pool with no name cannot be looked up in a rollup's per-pool map, so it
  // aggregates nothing rather than silently totalling every pool's minutes.
  const records = name == null ? [] : selectRecords(toRecords(rollups), range);

  const usedPct = finite(pool?.usedPct);
  const elapsedPct = finite(pool?.elapsedPct);
  const rate = rateBlock(pool);

  // Money and the share bar are measured over different windows, and each
  // says which: money over the page's period (so it lines up with the
  // pro-rated subscription figure), the share over the meter's own window.
  let apiEquivalentUsd = null;
  let periodMinutes = null;
  let runsOnPool = 0;
  const perRunMinutes = [];
  for (const record of records) {
    const minutes = workerMinutesOf(record, name);
    const cost = apiEquivalentOf(record, name);
    if (record?.pools && Object.hasOwn(record.pools, name)) runsOnPool += 1;
    if (minutes != null) { periodMinutes = add(periodMinutes, minutes); perRunMinutes.push(minutes); }
    apiEquivalentUsd = add(apiEquivalentUsd, cost);
  }

  const meterRange = licenceWindowRange(pool, at);
  const shareRange = meterRange ?? { ...range, window: pacingWindowOf(pool), source: `the page's ${range.period} period (the pool reports no reset time)`, stale: false };
  let shareMinutes = null;
  if (name != null) {
    for (const record of selectRecords(toRecords(rollups), shareRange)) {
      shareMinutes = add(shareMinutes, workerMinutesOf(record, name));
    }
  }

  // B2/B3. The only licence arithmetic allowed: rate × measured minutes.
  const zeroRateWithWork = rate.ratePerMinute === 0 && shareMinutes != null && shareMinutes > 0;
  const rateNote = zeroRateWithWork
    ? `meter did not move during ${rate.samples != null && rate.samples > 0 ? `${Math.round(rate.samples)} measured` : 'the measured'} runs`
    : null;
  const workflowsPct = rate.ratePerMinute != null && shareMinutes != null && !zeroRateWithWork
    ? round(rate.ratePerMinute * shareMinutes, 4)
    : null;
  const restPct = workflowsPct != null && usedPct != null
    ? round(Math.max(0, usedPct - workflowsPct), 4)
    : null;

  // B2. What one median run draws, and therefore how many more fit.
  const medianRunMinutes = median(perRunMinutes);
  const drawPerRunPct = rate.ratePerMinute != null && medianRunMinutes != null && !zeroRateWithWork
    ? round(rate.ratePerMinute * medianRunMinutes, 6)
    : null;
  const remainingPct = usedPct == null ? null : round(Math.max(0, 100 - usedPct), 4);
  const fits = drawPerRunPct != null && drawPerRunPct > 0 && remainingPct != null
    ? Math.floor(remainingPct / drawPerRunPct)
    : null;

  const price = resolvePrice(pool, prices);
  const windowDays = range.days ?? null;
  const subscription = price
    ? {
      monthlyPriceUsd: price.monthlyPriceUsd,
      includedValueUsd: price.includedValueUsd ?? null,
      source: price.source ?? null,
      updatedAt: price.updatedAt ?? null,
      basis: price.basis ?? 'declared monthly subscription price',
      windowDays,
      // B1. Money at the declared subscription rate, pro-rated over the
      // window on the 30-day-month convention prices.js documents.
      windowUsd: windowDays == null ? null : subscriptionCostUsd(price, { days: windowDays }),
    }
    : null;

  const row = {
    name,
    planType: pool?.subscription?.plan ?? pool?.meterSnapshot?.plan_type ?? null,
    window: pacingWindowOf(pool) ?? (typeof pool?.pacingWindow === 'string' ? pool.pacingWindow : null),
    usedPct,
    elapsedPct,
    pace: finite(pool?.pace),
    paceWord: paceWordOf(usedPct, elapsedPct),
    resetsAt: typeof pool?.paceResetsAt === 'string' ? pool.paceResetsAt : null,
    resetSource: pool?.resetSource ?? null,
    resetsText: resetsTextOf(pool?.paceResetsAt),
    // The zone `resetsText` was rendered in, by its IANA name, so a view can
    // say which clock the reader is looking at without re-resolving it.
    timeZone: localTimeZone(),
    resetsInMinutes: parseIso(pool?.paceResetsAt) == null
      ? null
      : Math.round((parseIso(pool.paceResetsAt) - at) / MINUTE_MS),
    credits: creditsOf(pool),
    share: {
      // B3. Two terms. Measured worker-minutes, and whatever else drew on
      // the licence — never a "you, interactive" term the CLI cannot see.
      workflows: workflowsPct,
      rest: restPct,
      workflowMinutes: round(shareMinutes, 2),
      ratePerMinute: rate.ratePerMinute,
      rateSource: rate.source,
      rateSamples: rate.samples,
      from: shareRange.from,
      to: shareRange.to,
      windowSource: shareRange.source,
      stale: shareRange.stale === true,
      exceedsMeter: workflowsPct != null && usedPct != null && workflowsPct > usedPct,
      rateNote,
      basis: rateNote
        ?? (rate.ratePerMinute == null
        ? 'no measured usage rate yet'
        : `≈ ${formatDashboardValue(rate.ratePerMinute, 'rate')} × measured worker-minutes (rate source: ${rate.source ?? 'unknown'})`),
    },
    rateNote,
    subscription,
    apiEquivalentUsd: round(apiEquivalentUsd, 6),
    apiEquivalentBasis: 'recorded per-attempt API-equivalent estimates, summed over the period',
    fits,
    fitsBasis: fits == null
      ? (rateNote
        ?? (rate.ratePerMinute == null
          ? 'no measured usage rate yet'
        : medianRunMinutes == null
          ? 'not computable: no run on this pool recorded worker-minutes in the period'
          : 'not computable: the licence meter reports no used%'))
      : `≈ ${remainingPct}% licence left ÷ ${drawPerRunPct}% per median run (${round(medianRunMinutes, 2)} worker-minutes)`,
    medianRunMinutes: round(medianRunMinutes, 2),
    drawPerRunPct,
    remainingPct,
    runs: runsOnPool,
    periodMinutes: round(periodMinutes, 2),
    period: range.period,
    from: range.from,
    to: range.to,
    meterSource: pool?.meterSource ?? 'none',
    enabled: pool?.enabled !== false,
  };
  row.nulls = nullPaths({
    usedPct: row.usedPct,
    elapsedPct: row.elapsedPct,
    resetsAt: row.resetsAt,
    resetsText: row.resetsText,
    credits: row.credits,
    share: { workflows: row.share.workflows, rest: row.share.rest, ratePerMinute: row.share.ratePerMinute },
    subscription: row.subscription,
    apiEquivalentUsd: row.apiEquivalentUsd,
    fits: row.fits,
  });
  return row;
}

/**
 * Every pool as a licence meter, plus the totals the page footer carries.
 *
 * @param {Array<object>} pools  the live pool list from buildPools
 * @param {{rollups?: Array<object>, prices?: *, period?: string, now?: number}} [options]
 */
export function budgetModel(pools, { rollups = [], prices = null, period = 'week', now = Date.now() } = {}) {
  const at = finite(now) ?? Date.now();
  const range = periodRange(period, at);
  const allPools = (Array.isArray(pools) ? pools : []).filter((pool) => poolName(pool));
  const disabledPools = allPools.filter((pool) => pool?.enabled === false).map((pool) => poolName(pool));
  const list = allPools.filter((pool) => pool?.enabled !== false);
  const records = toRecords(rollups);
  const rows = list.map((pool) => poolBudget(pool, { rollups: records, prices, period, now: at }));

  const totals = {
    pools: rows.length,
    metered: rows.filter((row) => row.usedPct != null).length,
    apiEquivalentUsd: null,
    subscriptionUsd: null,
    workflowMinutes: null,
    runs: 0,
    priced: [],
    unpriced: [],
  };
  for (const row of rows) {
    totals.apiEquivalentUsd = add(totals.apiEquivalentUsd, row.apiEquivalentUsd);
    totals.workflowMinutes = add(totals.workflowMinutes, row.share.workflowMinutes);
    totals.runs += row.runs;
    // B1. The subscription total sums the pools that DECLARED a price and
    // names the ones that did not, so a partial total is never read as a
    // whole one.
    if (row.subscription?.windowUsd != null) {
      totals.subscriptionUsd = add(totals.subscriptionUsd, row.subscription.windowUsd);
      totals.priced.push(row.name);
    } else {
      totals.unpriced.push(row.name);
    }
  }
  totals.apiEquivalentUsd = round(totals.apiEquivalentUsd, 6);
  totals.subscriptionUsd = round(totals.subscriptionUsd, 6);
  totals.workflowMinutes = round(totals.workflowMinutes, 2);

  const notes = [
    'apiEquivalentUsd is the estimate the runs recorded, not an invoice',
    'subscription money is the declared monthly price pro-rated over the window on a 30-day month',
  ];
  if (totals.unpriced.length) {
    notes.push(`no declared subscription price: ${totals.unpriced.join(', ')} — set one with \`bullswarm strategy set-subscription <pool> --monthly-usd\``);
  }
  const unrated = rows.filter((row) => row.share.ratePerMinute == null).map((row) => row.name);
  if (unrated.length) {
    notes.push(`no measured usage rate yet, so the share and room are unknown: ${unrated.join(', ')}`);
  }

  const model = {
    period: range.period,
    requestedPeriod: String(period ?? 'week'),
    from: range.from,
    to: range.to,
    days: range.days,
    timeZone: localTimeZone(),
    rows,
    totals,
    notes,
    disabledPools,
  };
  model.nulls = nullPaths({
    totals: {
      apiEquivalentUsd: totals.apiEquivalentUsd,
      subscriptionUsd: totals.subscriptionUsd,
      workflowMinutes: totals.workflowMinutes,
    },
  });
  return model;
}

/**
 * The biggest workflows of the window, twice: by measured worker-minutes, and
 * by the recorded API-equivalent estimate. Each list says which it is.
 *
 * Deliberately NOT ranked by licence draw. `normalizedQuota.estimatedPercent`
 * is null on all 877 recorded attempts, so a per-run licence figure does not
 * exist to sort by (B2), and multiplying a pool-wide rate by each run's
 * minutes would just re-rank the minutes list under a money-shaped name.
 *
 * @param {Array<object>} rollups
 * @param {{pool?: string|null, period?: string, now?: number, limit?: number}} [options]
 */
export function biggestRuns(rollups, { pool = null, period = 'week', now = Date.now(), limit = 5 } = {}) {
  const at = finite(now) ?? Date.now();
  const range = periodRange(period, at);
  const name = pool == null ? null : poolName(pool);
  const take = Number.isInteger(limit) && limit > 0 ? limit : 5;

  const entries = [];
  for (const record of selectRecords(toRecords(rollups), range)) {
    if (name != null && !(record?.pools && Object.hasOwn(record.pools, name))) continue;
    entries.push({
      runId: record.runId ?? null,
      shortId: record.shortId ?? null,
      project: record.project ?? null,
      goal: record.goal ?? null,
      status: record.status ?? null,
      verified: record.verified === true,
      finishedAt: record.finishedAt ?? null,
      workerMinutes: round(workerMinutesOf(record, name), 2),
      wallMinutes: finite(record?.minutes?.wall),
      apiEquivalentUsd: round(apiEquivalentOf(record, name), 6),
    });
  }

  const byMinutes = entries
    .filter((entry) => entry.workerMinutes != null)
    .sort((a, b) => b.workerMinutes - a.workerMinutes)
    .slice(0, take);
  const byApiEquivalentUsd = entries
    .filter((entry) => entry.apiEquivalentUsd != null)
    .sort((a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd)
    .slice(0, take);

  return {
    period: range.period,
    requestedPeriod: String(period ?? 'week'),
    from: range.from,
    to: range.to,
    pool: name,
    limit: take,
    runs: entries.length,
    byMinutes,
    byMinutesBasis: name
      ? `measured worker-minutes on ${name}`
      : 'measured worker-minutes across every pool the run used',
    byApiEquivalentUsd,
    byApiEquivalentUsdBasis: name
      ? `recorded API-equivalent estimate on ${name}`
      : 'recorded API-equivalent estimate across every pool the run used',
    // How much of the window is missing from the money list, so the view can
    // say "3 of 9 runs recorded an estimate" instead of implying all of them.
    pricedRuns: byApiEquivalentUsd.length,
    unpricedRuns: entries.filter((entry) => entry.apiEquivalentUsd == null).length,
    notes: ['not ranked by licence draw: normalizedQuota.estimatedPercent is null on every recorded attempt, so no per-run licence figure exists'],
  };
}
