// The run's usage totals (state.usage, state.budget): each finished attempt
// is added once (addUsage), and at the durable finish point the subscription
// meter ledger is reconciled over every same-pool attempt
// (reconcileSubscriptionLedger). metrics.js holds the arithmetic both share.

import { subscriptionCostUsd } from '../lib/prices.js';
import { meterLedgerAttribution, subscriptionUsdFromPct } from '../lib/subscription-cost.js';
import {
  SUBSCRIPTION_BASIS_RANK, TOKEN_SOURCE_RANK, attemptApiUsd, finiteNonNegative, positiveIntervalTotal,
  unionLedgerIntervals,
} from './metrics.js';

// A running basis: an unrecorded value leaves it as it was (metrics.js holds
// the ranks).
function worstBasis(current, next, rank) {
  if (!next || !Object.hasOwn(rank, next)) return current ?? null;
  if (!current || !Object.hasOwn(rank, current)) return next;
  return rank[next] < rank[current] ? next : current;
}

export function addUsage(state, attempt) {
  state.usage ??= { total: 0, byPool: {} };
  state.usage.byPool ??= {};
  const usage = attempt?.usage ?? null;
  const tokens = Number(usage?.tokens?.totalKnown);
  if (Number.isFinite(tokens) && tokens >= 0) {
    state.usage.total = Number(state.usage.total ?? 0) + tokens;
    const pool = attempt.pool ?? 'unknown';
    state.usage.byPool[pool] = Number(state.usage.byPool[pool] ?? 0) + tokens;
  }
  // The explicit subtotals retain partial knowledge while the public fields
  // stay null unless every relevant attempt has a priced amount. This keeps a
  // missing value from becoming a misleading `$0.00` in result summaries.
  // The state-level cost counters are opt-in because pre-v2 result envelopes
  // reject unknown enumerable keys. The attempt record is always full-fidelity;
  // once the integrator widens state.usage, this block carries the paired
  // dollar totals without another runtime change.
  const tracksCosts = Object.hasOwn(state.usage, 'apiUsd')
    || Object.hasOwn(state.usage, 'subscriptionUsd')
    || Object.hasOwn(state.usage, 'apiKnownSubtotalUsd');
  if (tracksCosts) {
    const apiUsd = finiteNonNegative(usage?.api?.usd ?? usage?.cost?.estimatedUsd);
    const subscriptionUsd = finiteNonNegative(usage?.subscription?.usd);
    if (apiUsd != null) {
      state.usage.apiKnownSubtotalUsd = Number(state.usage.apiKnownSubtotalUsd ?? 0) + apiUsd;
      state.usage.pricedAttempts = Number(state.usage.pricedAttempts ?? 0) + 1;
    } else {
      state.usage.apiMissingAttempts = Number(state.usage.apiMissingAttempts ?? 0) + 1;
    }
    if (subscriptionUsd != null) {
      state.usage.subscriptionKnownSubtotalUsd = Number(state.usage.subscriptionKnownSubtotalUsd ?? 0) + subscriptionUsd;
      state.usage.subscriptionPricedAttempts = Number(state.usage.subscriptionPricedAttempts ?? 0) + 1;
    } else {
      state.usage.subscriptionMissingAttempts = Number(state.usage.subscriptionMissingAttempts ?? 0) + 1;
    }
    const measured = usage?.tokenSource === 'provider-reported' || usage?.tokenSource === 'transcript-summed';
    if (measured) state.usage.measuredAttempts = Number(state.usage.measuredAttempts ?? 0) + 1;
    state.usage.attempts = Number(state.usage.attempts ?? 0) + 1;
    state.usage.apiUsd = state.usage.apiMissingAttempts
      ? null : state.usage.apiKnownSubtotalUsd ?? null;
    state.usage.subscriptionUsd = state.usage.subscriptionMissingAttempts
      ? null : state.usage.subscriptionKnownSubtotalUsd ?? null;
    state.usage.tokenSource = worstBasis(
      state.usage.tokenSource,
      usage?.tokenSource,
      TOKEN_SOURCE_RANK,
    ) ?? 'unknown';
    state.usage.subscriptionBasis = worstBasis(
      state.usage.subscriptionBasis,
      usage?.subscription?.basis,
      SUBSCRIPTION_BASIS_RANK,
    ) ?? 'unknown:no-meter';
  }
  // A widened v2 state may opt into the conserved subscription ledger. Keep
  // this incremental path deliberately small: finish-time reconciliation
  // replaces it with the authoritative observed/assigned/unassigned totals.
  if (Object.hasOwn(state.usage, 'subscriptionLedgerByPool')) {
    state.usage.subscriptionLedgerByPool ??= {};
    const pool = attempt?.pool ?? 'unknown';
    const subscription = usage?.subscription;
    const deltaPct = finiteNonNegative(subscription?.deltaPct);
    if (subscription && deltaPct != null) {
      const current = state.usage.subscriptionLedgerByPool[pool] ?? {
        observedPct: 0, assignedPct: 0, unassignedPct: 0,
        basis: subscription.basis ?? 'unknown:no-meter',
      };
      current.assignedPct = Number(current.assignedPct ?? 0) + deltaPct;
      current.basis = worstBasis(current.basis, subscription.basis, SUBSCRIPTION_BASIS_RANK);
      state.usage.subscriptionLedgerByPool[pool] = current;
    }
  }
  state.budget.agents += 1;
  const wall = Number(attempt?.wallSec ?? 0);
  if (Number.isFinite(wall) && wall > 0) state.budget.seconds += wall;
}

// The dollars one percent of an attempt's window costs: its plan price over
// the window, else its own watch-time dollars over its own share, else null.
function usdPerPct(subscription) {
  const planRate = subscriptionUsdFromPct(1, subscriptionCostUsd(
    subscription?.monthlyPriceUsd, { days: subscription?.windowDays },
  ));
  if (planRate != null) return planRate;
  const usd = finiteNonNegative(subscription?.usd);
  const delta = finiteNonNegative(subscription?.deltaPct);
  return usd != null && delta != null && delta > 0 ? usd / delta : null;
}

// One price per percent for each window of a pool: same-pool attempts share
// one plan, so a share that reconciliation moves keeps the same price.
function poolRates(poolAttempts) {
  const rates = new Map();
  for (const attempt of poolAttempts) {
    const subscription = attempt.usage?.subscription;
    const window = subscription?.window ?? null;
    if (rates.get(window) != null) continue;
    const rate = usdPerPct(subscription);
    if (rate != null) rates.set(window, rate);
  }
  return rates;
}

/**
 * Reconcile subscription meter attribution after all durable attempts exist.
 *
 * Watch-time accounting is intentionally best effort because concurrent
 * attempts may not yet be visible to the worker. At the durable finish point
 * the complete same-pool set is known, so re-run the pure ledger allocator
 * over the union of their intervals. Every positive observed interval is
 * either shared among active attempts or retained as an unassigned delta.
 */
export function reconcileSubscriptionLedger(state) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const byPool = new Map();
  for (const attempt of attempts) {
    const subscription = attempt?.usage?.subscription;
    if (!subscription || !attempt?.pool) continue;
    const pool = String(attempt.pool);
    const list = byPool.get(pool) ?? [];
    list.push(attempt);
    byPool.set(pool, list);
  }

  const totals = {};
  for (const [pool, poolAttempts] of byPool) {
    const intervals = unionLedgerIntervals(poolAttempts);
    if (!intervals.length) continue;
    const allocatorAttempts = poolAttempts.map((attempt) => ({
      id: attempt.id,
      attemptId: attempt.id,
      pool,
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      apiUsd: attemptApiUsd(attempt),
      api: { usd: attemptApiUsd(attempt) },
    }));
    const observedPct = positiveIntervalTotal(intervals);
    // Read before any attempt is rewritten below.
    const rates = poolRates(poolAttempts);
    let assignedPct = 0;
    for (const attempt of poolAttempts) {
      const usage = attempt.usage ??= {};
      const subscription = usage.subscription ??= {};
      const result = meterLedgerAttribution({
        intervals,
        attempts: allocatorAttempts,
        attempt: allocatorAttempts.find((entry) => entry.id === attempt.id),
        attemptId: attempt.id,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        apiUsd: attemptApiUsd(attempt),
        api: usage.api ?? { usd: attemptApiUsd(attempt) },
        window: subscription.window ?? null,
      });
      if (!result) continue;
      const previousDelta = finiteNonNegative(subscription.deltaPct);
      const previousUsd = finiteNonNegative(subscription.usd);
      const nextDelta = result.deltaPct;
      // A meter-observed share is priced at the pool's price per percent,
      // including a share that moved to an attempt with no watch-time
      // dollars. Other bases keep the watch-time conversion scaled to the new
      // share, and an unknown share has unknown dollars.
      const rate = usdPerPct(subscription) ?? rates.get(subscription.window ?? null) ?? null;
      const nextUsd = nextDelta == null ? null
        : result.basis === 'observed:meter-ledger' && rate != null ? rate * nextDelta
          : previousUsd != null && previousDelta != null && previousDelta > 0
            ? previousUsd * nextDelta / previousDelta
            : previousUsd;
      Object.assign(subscription, {
        deltaPct: nextDelta,
        conservedDeltaPct: result.conservedDeltaPct ?? null,
        resolutionPct: result.resolutionPct ?? subscription.resolutionPct ?? null,
        basis: result.basis ?? subscription.basis ?? null,
        ledgerRows: result.ledgerRows ?? [],
        ledgerIntervals: result.ledgerIntervals ?? [],
        ...(nextUsd != null ? { usd: Math.round(nextUsd * 1e8) / 1e8 }
          : previousUsd != null ? { usd: null } : {}),
        attribution: {
          ...(subscription.attribution && typeof subscription.attribution === 'object' ? subscription.attribution : {}),
          attemptId: attempt.id,
          intervals,
          ledgerRows: result.ledgerRows ?? [],
          deltaPct: nextDelta,
          conservedDeltaPct: result.conservedDeltaPct ?? null,
          resolutionPct: result.resolutionPct ?? null,
          basis: result.basis ?? null,
          reconciled: true,
        },
      });
      usage.normalizedQuota = {
        ...(usage.normalizedQuota && typeof usage.normalizedQuota === 'object' ? usage.normalizedQuota : {}),
        estimatedPercent: nextDelta,
        deltaPct: nextDelta,
        window: subscription.window ?? null,
        basis: result.basis ?? subscription.basis ?? null,
        resolutionPct: result.resolutionPct ?? null,
      };
      assignedPct += nextDelta ?? 0;
    }
    const unassignedPct = Math.max(0, Math.round((observedPct - assignedPct) * 1e8) / 1e8);
    totals[pool] = {
      observedPct: Math.round(observedPct * 1e8) / 1e8,
      assignedPct: Math.round(assignedPct * 1e8) / 1e8,
      unassignedPct,
      basis: poolAttempts.some((attempt) => attempt.usage?.subscription?.basis === 'observed:meter-ledger')
        ? 'observed:meter-ledger' : 'unknown:below-resolution',
    };
  }

  state.usage ??= { total: 0, byPool: {} };
  state.usage.subscriptionLedgerByPool = totals;
  if (Object.hasOwn(state.usage, 'subscriptionUsd') || Object.hasOwn(state.usage, 'subscriptionKnownSubtotalUsd')) {
    let knownSubtotal = 0;
    let priced = 0;
    let missing = 0;
    let basis = null;
    for (const attempt of attempts) {
      const subscription = attempt?.usage?.subscription;
      const usd = finiteNonNegative(subscription?.usd);
      if (usd == null) missing += 1;
      else {
        knownSubtotal += usd;
        priced += 1;
      }
      basis = worstBasis(basis, subscription?.basis, SUBSCRIPTION_BASIS_RANK);
    }
    state.usage.subscriptionKnownSubtotalUsd = priced ? knownSubtotal : null;
    state.usage.subscriptionPricedAttempts = priced;
    state.usage.subscriptionMissingAttempts = missing;
    state.usage.subscriptionUsd = missing ? null : (priced ? knownSubtotal : null);
    state.usage.subscriptionBasis = basis ?? 'unknown:no-meter';
  }
  return totals;
}
