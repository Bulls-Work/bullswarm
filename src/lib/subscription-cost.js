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
import { planPriceFor, priceFor } from './prices.js';

export const CALIBRATION_SCHEMA = 'bullswarm.calibration.v1';
export const MIN_CALIBRATION_SAMPLES = 3;
export const MAX_CALIBRATION_SAMPLES = 500;
export const MONTH_DAYS = 30.4375;

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

/** Price one quota window from a monthly plan price. */
export function windowPriceUsd(monthlyPriceUsd, window, resetsAt = null) {
  const monthly = nonNegative(monthlyPriceUsd);
  const days = windowDays(window, resetsAt);
  if (monthly == null || days == null) return null;
  return monthly * days / MONTH_DAYS;
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
  };
}

function publicSnapshot(value) {
  if (!value) return null;
  return { at: value.at, usedPct: value.usedPct, resetsAt: value.resetsAt };
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
    ?? pool?.meterSnapshot?.plan_name
    ?? pool?.meterSnapshot?.plan_type
    ?? null;
}

function resolvePlanPrice({ pool = null, subscription = null, monthlyPriceUsd = undefined,
  subscriptions = {}, priceFile = null } = {}) {
  if (monthlyPriceUsd !== undefined) return nonNegative(monthlyPriceUsd);
  const declaredValue = subscription?.monthlyPriceUsd ?? pool?.subscription?.monthlyPriceUsd
    ?? pool?.connector?.subscription?.monthlyPriceUsd;
  const declared = nonNegative(declaredValue);
  if (declared != null
    || Object.hasOwn(subscription ?? {}, 'monthlyPriceUsd')
    || Object.hasOwn(pool?.subscription ?? {}, 'monthlyPriceUsd')
    || Object.hasOwn(pool?.connector?.subscription ?? {}, 'monthlyPriceUsd')) return declared;
  const name = poolNameOf(pool) ?? text(subscription?.pool);
  if (name) {
    const direct = priceFor(name, { subscriptions, file: priceFile });
    if (direct?.monthlyPriceUsd != null) return direct.monthlyPriceUsd;
  }
  const provider = text(subscription?.provider)
    ?? text(pool?.provider)
    ?? (name ? name.split(':', 1)[0] : null);
  const detected = detectedPlanOf(subscription, pool);
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

  // The operator can still see a measured quota delta even when its plan
  // price is not known.  It must never be turned into a guessed dollar value.
  if (monthly == null) {
    return { ...base, basis: 'unknown:no-price' };
  }
  if (hasDelta && windowPrice != null) {
    return {
      ...base,
      usd: subscriptionUsdFromPct(delta.deltaPct, windowPrice),
      basis: 'observed:meter-delta',
    };
  }
  if (amount == null) return { ...base, basis: 'unknown:no-cost' };

  const ledger = name ? readCalibration(name, { home }) : null;
  const compatible = ledger?.window === selectedWindow
    && Number.isFinite(ledger?.usdPerPct)
    && ledger.usdPerPct > 0
    && Number(ledger.sampleCount) >= MIN_CALIBRATION_SAMPLES;
  if (compatible && windowPrice != null) {
    const estimatedPct = amount / ledger.usdPerPct;
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
