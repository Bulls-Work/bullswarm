// Subscription quota cost model and per-pool calibration ledger.
//
// Subscription debits are a separate fact from API token pricing.  A meter
// delta is a measurement when both snapshots belong to the same quota window;
// when a meter is unavailable, a small, explicitly-labelled calibration
// ledger can turn API dollars into an estimate.  Missing facts stay null.

import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DAYS_PER_MONTH, planPriceFor, priceFor } from './prices.js';
import { meterHistoryIntervals } from '../meters/registry.js';

export const CALIBRATION_SCHEMA = 'bullswarm.calibration.v1';
export const MIN_CALIBRATION_SAMPLES = 3;
export const MAX_CALIBRATION_SAMPLES = 500;

function finite(value) {
  if (value == null || typeof value === 'boolean' || Array.isArray(value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function homeFor(home) {
  return text(home) ?? process.env.BULLSWARM_HOME?.trim() ?? join(homedir(), '.bullswarm');
}

function ledgerPath(pool, home) {
  return join(homeFor(home), 'calibration', `${String(pool ?? '').trim()}.json`);
}

function timestamp(value, fallback = new Date().toISOString()) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : value == null ? NaN : Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeWindow(value) {
  const name = text(value)?.toLowerCase();
  return name === '5h' || name === 'weekly' || name === 'monthly' ? name : null;
}

// Meter-history intervals use the provider-facing `five_hour` key while
// subscription records use the compact `5h` name. Keep the comparison
// canonical without changing the durable interval value we received.
function ledgerWindow(value) {
  const name = text(value)?.toLowerCase();
  if (name === '5h' || name === 'five_hour' || name === 'five-hour') return '5h';
  if (name === 'weekly' || name === 'seven_day' || name === 'seven-day') return 'weekly';
  if (name === 'monthly') return 'monthly';
  return null;
}

function previousUtcMonth(resetMs) {
  const reset = new Date(resetMs);
  const year = reset.getUTCFullYear();
  const month = reset.getUTCMonth();
  const day = reset.getUTCDate();
  const previousMonthIndex = month - 1;
  const previousYear = year + Math.floor(previousMonthIndex / 12);
  const previousMonth = ((previousMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(previousYear, previousMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    previousYear,
    previousMonth,
    Math.min(day, lastDay),
    reset.getUTCHours(),
    reset.getUTCMinutes(),
    reset.getUTCSeconds(),
    reset.getUTCMilliseconds(),
  );
}

/** Number of days represented by one supported subscription window. */
export function windowDays(window, resetsAt = null) {
  const name = normalizeWindow(window);
  if (name === '5h') return 5 / 24;
  if (name === 'weekly') return 7;
  if (name !== 'monthly') return null;
  const resetMs = resetsAt instanceof Date
    ? resetsAt.getTime()
    : typeof resetsAt === 'number'
      ? resetsAt
      : Date.parse(String(resetsAt ?? ''));
  if (!Number.isFinite(resetMs)) return null;
  const startMs = previousUtcMonth(resetMs);
  const days = (resetMs - startMs) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Price one quota window from a monthly plan price. The denominator is the
 * one exported month length (prices.js DAYS_PER_MONTH), never a local one.
 */
export function windowPriceUsd(monthlyPriceUsd, window, resetsAt = null) {
  const monthly = nonNegative(monthlyPriceUsd);
  const days = windowDays(window, resetsAt);
  if (monthly == null || days == null) return null;
  return monthly * days / DAYS_PER_MONTH;
}

/** Convert a measured/estimated percentage of a window into dollars. */
export function subscriptionUsdFromPct(pct, windowPrice) {
  const percent = nonNegative(pct);
  const price = nonNegative(windowPrice);
  if (percent == null || price == null) return null;
  return price * percent / 100;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function eligibleSample(sample) {
  // Calibration must be grounded in a positive, conserved observation. A
  // below-resolution row is evidence that the meter did not move visibly,
  // not a zero-cost sample that can drag the rate card toward zero.
  if (sample?.conserved === false) return false;
  if (sample?.conservedDeltaPct != null && !(positive(sample.conservedDeltaPct) != null)) return false;
  if (sample?.basis && !['observed:meter-delta', 'observed:meter-ledger'].includes(sample.basis)) {
    return false;
  }
  const apiUsd = nonNegative(sample?.apiUsd ?? sample?.api?.usd);
  const deltaPct = positive(sample?.deltaPct);
  return apiUsd != null && deltaPct != null;
}

function derive(samples) {
  const eligible = samples.filter(eligibleSample);
  if (eligible.length < MIN_CALIBRATION_SAMPLES) {
    return { usdPerPct: null, sampleCount: eligible.length };
  }
  const apiUsd = eligible.reduce((sum, sample) => sum + Number(sample.apiUsd), 0);
  const deltaPct = eligible.reduce((sum, sample) => sum + Number(sample.deltaPct), 0);
  const usdPerPct = deltaPct > 0 ? apiUsd / deltaPct : null;
  return {
    usdPerPct: Number.isFinite(usdPerPct) ? usdPerPct : null,
    sampleCount: eligible.length,
  };
}

function normalizeLedger(value, pool = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== CALIBRATION_SCHEMA) return null;
  const samples = Array.isArray(value.samples)
    ? value.samples.filter((sample) => sample && typeof sample === 'object')
      .map((sample) => ({
        at: timestamp(sample.at),
        apiUsd: nonNegative(sample.apiUsd),
        deltaPct: positive(sample.deltaPct),
        ...(text(sample.runId) ? { runId: text(sample.runId) } : {}),
        ...(text(sample.attemptId) ? { attemptId: text(sample.attemptId) } : {}),
      }))
    : [];
  const derived = derive(samples);
  return {
    schema: CALIBRATION_SCHEMA,
    pool: text(value.pool) ?? text(pool),
    window: normalizeWindow(value.window),
    samples,
    usdPerPct: derived.usdPerPct,
    sampleCount: derived.sampleCount,
    updatedAt: timestamp(value.updatedAt, new Date(0).toISOString()),
  };
}

/** Read a pool's calibration ledger, or null when it is missing/corrupt. */
export function readCalibration(pool, { home = null } = {}) {
  const raw = readJson(ledgerPath(pool, home));
  return normalizeLedger(raw, pool);
}

function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Append one eligible calibration sample.  A changed window kind starts a
 * fresh ledger, and only the newest 500 samples are retained.
 */
export function appendCalibration(pool, sample, { home = null } = {}) {
  if (!eligibleSample(sample)) return readCalibration(pool, { home });
  const name = text(pool) ?? String(pool ?? '');
  const nextWindow = normalizeWindow(sample.window ?? sample.quotaWindow);
  const existing = readCalibration(name, { home });
  const base = existing && existing.window === nextWindow
    ? existing
    : {
      schema: CALIBRATION_SCHEMA,
      pool: name,
      window: nextWindow,
      samples: [],
      usdPerPct: null,
      sampleCount: 0,
      updatedAt: null,
    };
  const nextSample = {
    at: timestamp(sample.at),
    apiUsd: nonNegative(sample.apiUsd ?? sample.api?.usd),
    deltaPct: positive(sample.deltaPct),
    ...(text(sample.runId) ? { runId: text(sample.runId) } : {}),
    ...(text(sample.attemptId) ? { attemptId: text(sample.attemptId) } : {}),
  };
  const samples = [...base.samples, nextSample]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_CALIBRATION_SAMPLES);
  const derived = derive(samples);
  const ledger = {
    schema: CALIBRATION_SCHEMA,
    pool: name,
    window: nextWindow,
    samples,
    usdPerPct: derived.usdPerPct,
    sampleCount: derived.sampleCount,
    updatedAt: nextSample.at,
  };
  writeJsonAtomic(ledgerPath(name, home), ledger);
  return ledger;
}

/**
 * Persist a subscription result as calibration only when it is a positive,
 * conserved observation. This keeps below-resolution and unknown results out
 * of the rate ledger even when a caller forwards the complete result object.
 */
export function appendCalibrationFromResult(pool, result, {
  home = null, apiUsd = undefined, runId = null, attemptId = null,
} = {}) {
  const basis = text(result?.basis);
  const deltaPct = positive(result?.deltaPct);
  const conservedDeltaPct = positive(result?.conservedDeltaPct ?? result?.deltaPct);
  if (!['observed:meter-delta', 'observed:meter-ledger'].includes(basis)
    || deltaPct == null || conservedDeltaPct == null) {
    return readCalibration(pool, { home });
  }
  return appendCalibration(pool, {
    at: result?.at ?? result?.finishedAt ?? new Date().toISOString(),
    apiUsd: apiUsd ?? result?.apiUsd ?? result?.api?.usd,
    deltaPct,
    conservedDeltaPct,
    basis,
    window: result?.window ?? result?.quotaWindow,
    runId: runId ?? result?.runId,
    attemptId: attemptId ?? result?.attemptId,
  }, { home });
}

function snapshotValue(value) {
  if (!value || typeof value !== 'object') return null;
  const at = timestamp(value.at, '');
  const usedPct = nonNegative(value.usedPct);
  if (!at || usedPct == null) return null;
  return {
    at,
    usedPct,
    resetsAt: text(value.resetsAt) ?? null,
    window: normalizeWindow(value.window),
    ...(text(value.source) ? { source: text(value.source) } : {}),
  };
}

function publicSnapshot(value) {
  if (!value) return null;
  return {
    at: value.at,
    usedPct: value.usedPct,
    resetsAt: value.resetsAt,
    ...(text(value.source) ? { source: value.source } : {}),
  };
}

function meterDelta(start, end) {
  const a = snapshotValue(start);
  const b = snapshotValue(end);
  if (!a || !b) return { deltaPct: null, reason: 'missing-snapshot' };
  if (finite(start?.ageMs) != null && finite(start.ageMs) > 60_000) {
    return { deltaPct: null, reason: 'stale-start' };
  }
  if (a.window && b.window && a.window !== b.window) {
    return { deltaPct: null, reason: 'window-changed' };
  }
  if (a.resetsAt && b.resetsAt && a.resetsAt !== b.resetsAt) {
    return { deltaPct: null, reason: 'reset-between-snapshots' };
  }
  if (b.usedPct < a.usedPct) return { deltaPct: null, reason: 'counter-decreased' };
  return { deltaPct: Math.round((b.usedPct - a.usedPct) * 1e8) / 1e8, reason: null };
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null || String(value).trim() === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPct(value) {
  return Math.round(value * 1e8) / 1e8;
}

function intervalDelta(interval) {
  const delta = finite(interval?.deltaPct ?? interval?.delta_pct);
  return delta == null ? null : roundPct(delta);
}

function intervalAt(interval) {
  return timeMs(interval?.at ?? interval?.to ?? interval?.captured_at);
}

function attemptIdentifier(attempt, fallback = null) {
  return text(attempt?.attemptId ?? attempt?.id ?? attempt?.attempt_id) ?? fallback;
}

function attemptApiUsd(attempt) {
  return apiAmount(
    attempt?.api
      ?? attempt?.usage?.api
      ?? attempt?.usage?.apiUsd
      ?? attempt?.usage?.cost?.estimatedUsd,
    attempt?.apiUsd ?? attempt?.api_usd,
  );
}

function attemptStartedAt(attempt) {
  return timeMs(attempt?.startedAt ?? attempt?.started_at ?? attempt?.start);
}

function attemptFinishedAt(attempt) {
  return timeMs(attempt?.finishedAt ?? attempt?.finished_at ?? attempt?.end);
}

function intervalRowsFromHistory(history, window) {
  if (!Array.isArray(history)) return [];
  const rows = [...history]
    .filter((entry) => entry && typeof entry === 'object')
    .sort((a, b) => (timeMs(a.captured_at ?? a.at) ?? 0) - (timeMs(b.captured_at ?? b.at) ?? 0));
  const values = (entry) => {
    const value = entry?.[window === '5h' ? 'five_hour' : window === 'weekly' ? 'weekly' : 'monthly']
      ?? entry?.[window === 'weekly' ? 'seven_day' : window];
    if (!value || typeof value !== 'object') return null;
    const usedPct = finite(value.usedPct ?? value.used_pct ?? value.utilization);
    return usedPct == null ? null : {
      usedPct,
      resetsAt: value.resetsAt ?? value.resets_at ?? null,
      resolutionPct: finite(value.resolutionPct ?? value.resolution_pct),
    };
  };
  const intervals = [];
  for (let i = 1; i < rows.length; i += 1) {
    const previous = values(rows[i - 1]);
    const current = values(rows[i]);
    if (!previous || !current) continue;
    const previousReset = previous.resetsAt == null ? null : String(previous.resetsAt);
    const currentReset = current.resetsAt == null ? null : String(current.resetsAt);
    let reason = null;
    if (previousReset !== currentReset && (previousReset != null || currentReset != null)) {
      reason = 'reset-between-readings';
    } else if (current.usedPct < previous.usedPct) {
      reason = 'counter-decreased';
    }
    intervals.push({
      window,
      from: rows[i - 1].captured_at ?? rows[i - 1].at ?? null,
      at: rows[i].captured_at ?? rows[i].at ?? null,
      deltaPct: reason ? null : roundPct(current.usedPct - previous.usedPct),
      resolutionPct: current.resolutionPct ?? 1,
      reason,
      row: i,
    });
  }
  return intervals;
}

/**
 * Attribute a continuous meter ledger to one attempt.  A meter interval is
 * observed at its ending row; every attempt active at that observation shares
 * the positive delta in proportion to its API-rate dollars.  The returned
 * rows are durable evidence and make the conservation calculation auditable.
 *
 * This helper is intentionally pure. Callers may pass `meterHistoryIntervals`
 * output directly, or raw history rows through `history`/`meterHistory`.
 */
export function meterLedgerAttribution({
  intervals = null,
  ledgerIntervals = null,
  meterIntervals = null,
  history = null,
  meterHistory = null,
  ledger = null,
  meterLedger = null,
  attempts = null,
  activeAttempts = null,
  attempt = null,
  attemptId = null,
  startedAt = null,
  finishedAt = null,
  apiUsd = undefined,
  api = null,
  window = null,
} = {}) {
  const supplied = intervals ?? ledgerIntervals ?? meterIntervals
    ?? ledger?.intervals ?? meterLedger?.intervals;
  const source = Array.isArray(supplied)
    ? supplied
    : intervalRowsFromHistory(history ?? meterHistory, window);
  const current = {
    ...(attempt && typeof attempt === 'object' ? attempt : {}),
    ...(attemptId != null ? { attemptId } : {}),
    ...(startedAt != null ? { startedAt } : {}),
    ...(finishedAt != null ? { finishedAt } : {}),
    ...(apiUsd !== undefined ? { apiUsd } : {}),
    ...(api != null ? { api } : {}),
  };
  const currentId = attemptIdentifier(current, attemptId);
  const poolAttempts = Array.isArray(attempts) ? attempts
    : Array.isArray(activeAttempts) ? activeAttempts : [];
  const allAttempts = poolAttempts.some((entry) => attemptIdentifier(entry) === currentId)
    ? poolAttempts
    : [...poolAttempts, current];
  const ownStart = attemptStartedAt(current);
  const ownEnd = attemptFinishedAt(current);
  const resolvedWindow = normalizeWindow(window);
  const callerPassedWindow = window !== null && window !== undefined;
  const usable = source.filter((interval) => {
    const intervalWindowValue = interval?.window;
    const intervalHasWindow = intervalWindowValue !== null
      && intervalWindowValue !== undefined
      && String(intervalWindowValue).trim() !== '';
    const intervalWindow = ledgerWindow(intervalWindowValue);
    // A caller that resolved a window must never consume a row from another
    // meter window. Conversely, a legacy interval with no window metadata is
    // usable only when the caller also left the window unresolved.
    if (callerPassedWindow) {
      if (resolvedWindow == null || !intervalHasWindow || intervalWindow !== resolvedWindow) return false;
    } else if (intervalHasWindow) {
      return false;
    }
    const at = intervalAt(interval);
    if (at == null) return false;
    if (ownStart != null && at < ownStart) return false;
    if (ownEnd != null && at > ownEnd) return false;
    return true;
  });
  const rows = [];
  let deltaPct = 0;
  let conservedDeltaPct = 0;
  let resolutionPct = null;
  let hadPositive = false;
  let hadZero = false;
  let hadAttributionGap = false;
  for (const interval of usable) {
    const delta = intervalDelta(interval);
    const resolution = positive(interval.resolutionPct ?? interval.resolution_pct);
    if (resolution != null) resolutionPct = resolutionPct == null
      ? resolution : Math.max(resolutionPct, resolution);
    if (delta === 0) {
      hadZero = true;
      rows.push({
        window: interval.window ?? resolvedWindow ?? null,
        at: interval.at ?? interval.to ?? interval.captured_at ?? null,
        from: interval.from ?? interval.fromAt ?? null,
        row: interval.row ?? interval.index ?? null,
        deltaPct: 0,
        sharePct: 0,
        resolutionPct: resolution ?? null,
        activeAttemptIds: [],
      });
    }
    if (delta == null || delta <= 0 || text(interval.reason)) continue;
    hadPositive = true;
    const at = intervalAt(interval);
    const active = allAttempts.filter((candidate) => {
      const start = attemptStartedAt(candidate);
      const end = attemptFinishedAt(candidate);
      return (start == null || start <= at) && (end == null || end >= at);
    });
    const weighted = active.map((candidate) => ({
      candidate,
      amount: attemptApiUsd(candidate),
    })).filter(({ amount }) => amount != null && amount > 0);
    const total = weighted.reduce((sum, entry) => sum + entry.amount, 0);
    const currentEntry = weighted.find(({ candidate }) =>
      attemptIdentifier(candidate, currentId) === currentId);
    if (!currentEntry || !(total > 0)) {
      hadAttributionGap = true;
      continue;
    }
    const share = roundPct(delta * currentEntry.amount / total);
    deltaPct = roundPct(deltaPct + share);
    conservedDeltaPct = roundPct(conservedDeltaPct + delta);
    rows.push({
      window: interval.window ?? resolvedWindow ?? null,
      at: interval.at ?? interval.to ?? interval.captured_at ?? null,
      from: interval.from ?? interval.fromAt ?? null,
      row: interval.row ?? interval.index ?? null,
      deltaPct: delta,
      sharePct: share,
      resolutionPct: resolution ?? null,
      activeAttemptIds: active.map((entry) => attemptIdentifier(entry)).filter(Boolean),
    });
  }
  if (resolutionPct == null && usable.length) resolutionPct = 1;
  if (hadAttributionGap && !rows.length) {
    return {
      deltaPct: null,
      conservedDeltaPct: conservedDeltaPct || null,
      resolutionPct,
      basis: 'unknown:no-cost',
      ledgerRows: rows,
      ledgerIntervals: rows,
    };
  }
  if (hadPositive && rows.length) {
    return {
      deltaPct,
      conservedDeltaPct,
      resolutionPct,
      basis: 'observed:meter-ledger',
      ledgerRows: rows,
      ledgerIntervals: rows,
    };
  }
  if (hadZero || usable.length) {
    return {
      deltaPct: 0,
      conservedDeltaPct: 0,
      resolutionPct,
      basis: 'unknown:below-resolution',
      ledgerRows: rows,
      ledgerIntervals: rows,
    };
  }
  return null;
}

function apiAmount(api, fallback = null) {
  if (api && typeof api === 'object') return nonNegative(api.usd ?? api.estimatedUsd);
  return nonNegative(api ?? fallback);
}

function poolNameOf(pool) {
  return text(typeof pool === 'string' ? pool : pool?.name ?? pool?.pool);
}

function detectedPlanOf(subscription, pool) {
  return subscription?.plan
    ?? subscription?.planName
    ?? subscription?.plan_name
    ?? subscription?.detectedPlan
    ?? pool?.plan
    ?? pool?.planName
    ?? pool?.plan_name
    ?? pool?.plan_type
    ?? pool?.meterSnapshot?.plan_name
    ?? pool?.meterSnapshot?.plan_type
    ?? pool?.meterSnapshot?.plan
    ?? pool?.meterSnapshot?.planName
    ?? null;
}

function resolvePlanPrice({ pool = null, subscription = null, monthlyPriceUsd = undefined,
  subscriptions = {}, priceFile = null } = {}) {
  if (monthlyPriceUsd !== undefined) return nonNegative(monthlyPriceUsd);
  const detected = detectedPlanOf(subscription, pool);
  const declaredValue = subscription?.monthlyPriceUsd ?? pool?.subscription?.monthlyPriceUsd
    ?? pool?.connector?.subscription?.monthlyPriceUsd;
  const declared = nonNegative(declaredValue);
  const hasDeclaredMonthly = Object.hasOwn(subscription ?? {}, 'monthlyPriceUsd')
    || Object.hasOwn(pool?.subscription ?? {}, 'monthlyPriceUsd')
    || Object.hasOwn(pool?.connector?.subscription ?? {}, 'monthlyPriceUsd');
  if (declared != null) return declared;
  const name = poolNameOf(pool) ?? text(subscription?.pool);
  if (name) {
    const direct = priceFor(name, { subscriptions, file: priceFile });
    if (direct?.monthlyPriceUsd != null) return direct.monthlyPriceUsd;
  }
  // A connector's packaged `monthlyPriceUsd: null` is a placeholder, not a
  // declaration that suppresses a provider-reported plan. Preserve explicit
  // null-as-unknown for calls without a detected plan, while allowing a meter
  // plan such as Codex's `prolite` to resolve through the published table.
  if (hasDeclaredMonthly && !detected) return null;
  const provider = text(subscription?.provider)
    ?? text(pool?.provider)
    ?? (name ? name.split(':', 1)[0] : null);
  return provider && detected ? planPriceFor(provider, detected, { file: priceFile })?.monthlyPriceUsd ?? null : null;
}

function resolveWindow({ subscription = null, pool = null, startSnapshot = null, endSnapshot = null } = {}) {
  return normalizeWindow(subscription?.window
    ?? subscription?.quotaWindow
    ?? pool?.subscription?.quotaWindow
    ?? pool?.connector?.subscription?.quotaWindow
    ?? endSnapshot?.window
    ?? startSnapshot?.window);
}

/**
 * Resolve the observed/calibrated/unknown subscription cost for one attempt.
 * This function has no side effects; callers append observed samples after
 * persisting the attempt record.
 */
export function subscriptionCost({
  pool = null,
  poolName = null,
  subscription = null,
  window = null,
  quotaWindow = null,
  api = null,
  apiUsd = undefined,
  startSnapshot = null,
  endSnapshot = null,
  start = null,
  end = null,
  snapshots = null,
  // Continuous meter-ledger inputs. `ledgerIntervals` is the preferred
  // production shape (from meterHistoryIntervals); the aliases keep replay
  // and fixture callers source-compatible while the feature rolls out.
  ledgerIntervals = null,
  meterIntervals = null,
  meterHistory = null,
  history = null,
  ledger = null,
  meterLedger = null,
  attempts = null,
  activeAttempts = null,
  ledgerAttempt = null,
  startedAt = null,
  finishedAt = null,
  home = null,
  monthlyPriceUsd = undefined,
  subscriptions = {},
  priceFile = null,
  runId = null,
  attemptId = null,
  now = Date.now(),
} = {}) {
  const name = text(poolName) ?? poolNameOf(pool) ?? text(subscription?.pool);
  const startReading = startSnapshot ?? start ?? snapshots?.start ?? null;
  const endReading = endSnapshot ?? end ?? snapshots?.end ?? null;
  const selectedWindow = normalizeWindow(window)
    ?? normalizeWindow(quotaWindow)
    ?? resolveWindow({ subscription, pool, startSnapshot: startReading, endSnapshot: endReading });
  const monthly = resolvePlanPrice({
    pool: pool ?? name,
    subscription,
    monthlyPriceUsd,
    subscriptions,
    priceFile,
  });
  const delta = meterDelta(startReading, endReading);
  const hasDelta = delta.reason == null && delta.deltaPct != null;
  const resetAt = endReading?.resetsAt ?? startReading?.resetsAt ?? null;
  const days = windowDays(selectedWindow, resetAt);
  const windowPrice = windowPriceUsd(monthly, selectedWindow, resetAt);
  const amount = apiAmount(api, apiUsd);
  let resolvedLedgerIntervals = ledgerIntervals ?? meterIntervals
    ?? ledger?.intervals ?? meterLedger?.intervals ?? null;
  // A caller that supplies an explicit relocated home can use the production
  // history reader without having to duplicate its cursor plumbing. Never
  // fall back to the live user home here: task/replay callers must opt into a
  // home, and the normal watch path already has one.
  if (!Array.isArray(resolvedLedgerIntervals) && !history && !meterHistory
    && name && text(home)) {
    try {
      const untilMs = timeMs(endReading?.at ?? finishedAt) ?? null;
      if (untilMs != null) {
        resolvedLedgerIntervals = meterHistoryIntervals(name, {
          dir: join(home, 'meters'),
          untilMs,
        });
      }
    } catch { /* ledger history is optional; snapshot accounting remains */ }
  }
  const ledgerResult = meterLedgerAttribution({
    intervals: resolvedLedgerIntervals,
    history: history ?? meterHistory,
    ledger,
    meterLedger,
    attempts: attempts ?? activeAttempts ?? ledger?.attempts ?? meterLedger?.attempts,
    attempt: ledgerAttempt,
    attemptId,
    startedAt: startedAt ?? startReading?.at,
    finishedAt: finishedAt ?? endReading?.at,
    api,
    apiUsd: apiUsd !== undefined ? apiUsd : amount,
    window: selectedWindow,
  });
  const base = {
    pool: name,
    window: selectedWindow,
    deltaPct: hasDelta ? delta.deltaPct : null,
    usd: null,
    monthlyPriceUsd: monthly,
    windowDays: days,
    basis: 'unknown:no-meter',
    snapshots: {
      start: publicSnapshot(snapshotValue(startReading)),
      end: publicSnapshot(snapshotValue(endReading)),
    },
  };

  // Ledger metadata is useful even when a plan price is not known. Keep the
  // dollar side null in that case, matching the legacy unknown/no-price
  // contract rather than converting quota percentages into guessed dollars.
  const withLedger = ledgerResult
    ? {
      ...base,
      deltaPct: ledgerResult.deltaPct,
      ...(ledgerResult.resolutionPct != null ? { resolutionPct: ledgerResult.resolutionPct } : {}),
      conservedDeltaPct: ledgerResult.conservedDeltaPct ?? null,
      ledgerRows: ledgerResult.ledgerRows,
      ledgerIntervals: ledgerResult.ledgerIntervals,
    }
    : null;

  // A ledger observation remains an observation even when its plan price is
  // unknown. Preserve that basis and keep only the dollar side null.
  if (monthly == null) {
    if (ledgerResult?.basis) return { ...withLedger, basis: ledgerResult.basis, usd: null };
    return { ...base, basis: 'unknown:no-price' };
  }
  if (ledgerResult?.basis === 'observed:meter-ledger') {
    return {
      ...withLedger,
      usd: subscriptionUsdFromPct(ledgerResult.deltaPct, windowPrice),
      basis: 'observed:meter-ledger',
    };
  }
  if (ledgerResult?.basis === 'unknown:below-resolution') {
    return { ...withLedger, basis: 'unknown:below-resolution', usd: null };
  }
  if (ledgerResult?.basis === 'unknown:no-cost') {
    return { ...withLedger, basis: 'unknown:no-cost', usd: null };
  }
  if (hasDelta && windowPrice != null) {
    return {
      ...base,
      usd: subscriptionUsdFromPct(delta.deltaPct, windowPrice),
      basis: 'observed:meter-delta',
    };
  }
  if (amount == null) return { ...base, basis: 'unknown:no-cost' };

  const calibrationLedger = name ? readCalibration(name, { home }) : null;
  const compatible = calibrationLedger?.window === selectedWindow
    && Number.isFinite(calibrationLedger?.usdPerPct)
    && calibrationLedger.usdPerPct > 0
    && Number(calibrationLedger.sampleCount) >= MIN_CALIBRATION_SAMPLES;
  if (compatible && windowPrice != null) {
    const estimatedPct = amount / calibrationLedger.usdPerPct;
    return {
      ...base,
      deltaPct: estimatedPct,
      usd: subscriptionUsdFromPct(estimatedPct, windowPrice),
      basis: 'calibrated:usd-per-pct',
    };
  }
  return { ...base, basis: 'unknown:no-meter' };
}

export default subscriptionCost;
