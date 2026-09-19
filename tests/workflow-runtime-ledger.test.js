import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, normalizeAttempt, reconcileSubscriptionLedger } from '../src/workflow/v2-runtime.js';

const intervals = [
  { pool: 'codex', window: 'weekly', from: '2026-09-19T15:25:55.935Z', at: '2026-09-19T15:31:04.490Z', deltaPct: 1, resolutionPct: 1 },
  { pool: 'codex', window: 'weekly', from: '2026-09-19T15:31:04.490Z', at: '2026-09-19T15:36:06.545Z', deltaPct: 1, resolutionPct: 1 },
  { pool: 'codex', window: 'weekly', from: '2026-09-19T15:36:06.545Z', at: '2026-09-19T15:46:13.743Z', deltaPct: 1, resolutionPct: 1 },
  { pool: 'codex', window: 'weekly', from: '2026-09-19T15:46:13.743Z', at: '2026-09-19T16:06:27.285Z', deltaPct: 1, resolutionPct: 1 },
];

function attempt(id, startedAt, finishedAt, apiUsd) {
  return {
    id, pool: 'codex', status: 'succeeded', startedAt, finishedAt,
    usage: {
      api: { usd: apiUsd },
      cost: { estimatedUsd: apiUsd },
      subscription: {
        pool: 'codex', window: 'weekly', deltaPct: 4, usd: 4,
        basis: 'observed:meter-ledger',
        attribution: { attemptId: id, intervals, ledgerRows: intervals },
      },
    },
  };
}

test('normalizeAttempt keeps the complete subscription attribution envelope and aliases', () => {
  const usage = {
    api: { usd: 0.001 },
    cost: { estimatedUsd: 0.001 },
    normalizedQuota: { deltaPct: 2, basis: 'observed:meter-ledger' },
    subscription: {
      pool: 'codex', deltaPct: 2, basis: 'observed:meter-ledger',
      attribution: { attemptId: 'a-1', intervals, ledgerRows: intervals },
    },
  };
  const result = normalizeAttempt({
    status: 'succeeded', pool: 'codex', startedAt: '2026-09-19T15:27:22.413Z',
    finishedAt: '2026-09-19T15:47:26.954Z', usage,
  }, { id: 'a-1', actionId: 'write', ordinal: 1 });
  assert.deepEqual(result.usage, usage);
  assert.equal(result.usage.cost.estimatedUsd, result.usage.api.usd);
  assert.equal(result.usage.normalizedQuota.basis, 'observed:meter-ledger');
  assert.equal(result.usage.subscription.attribution.intervals.length, 4);
});

test('durable finish reconciliation conserves a shared pool meter delta across concurrent attempts', () => {
  const first = attempt('a-1', '2026-09-19T15:27:22.413Z', '2026-09-19T15:47:26.954Z', 1);
  const second = attempt('a-2', '2026-09-19T15:28:46.938Z', '2026-09-19T16:07:00.000Z', 3);
  const state = { attempts: [first, second], usage: { total: 0, byPool: {} } };
  const totals = reconcileSubscriptionLedger(state);
  assert.equal(first.usage.subscription.basis, 'observed:meter-ledger');
  assert.equal(second.usage.subscription.basis, 'observed:meter-ledger');
  const assigned = first.usage.subscription.deltaPct + second.usage.subscription.deltaPct;
  assert.equal(assigned, 4);
  assert.equal(totals.codex.observedPct, 4);
  assert.equal(totals.codex.assignedPct, 4);
  assert.equal(totals.codex.unassignedPct, 0);
  assert.equal(first.usage.subscription.attribution.reconciled, true);
  assert.equal(second.usage.subscription.attribution.reconciled, true);
});

test('finish reconciliation retains an unassigned delta when no attempt brackets an interval', () => {
  const only = attempt('a-1', '2026-09-19T15:27:22.413Z', '2026-09-19T15:28:00.000Z', 1);
  const state = { attempts: [only], usage: { total: 0, byPool: {} } };
  const totals = reconcileSubscriptionLedger(state);
  assert.equal(totals.codex.observedPct, 4);
  assert.equal(totals.codex.assignedPct, 0);
  assert.equal(totals.codex.unassignedPct, 4);
});

test('unknown subscription dollars remain null in durable state counters', () => {
  const state = {
    usage: {
      total: 0, byPool: {}, apiUsd: null, apiKnownSubtotalUsd: null,
      subscriptionUsd: null, subscriptionKnownSubtotalUsd: null,
      measuredAttempts: 0, pricedAttempts: 0, subscriptionPricedAttempts: 0,
      attempts: 0, apiMissingAttempts: 0, subscriptionMissingAttempts: 0,
      subscriptionLedgerByPool: {},
    },
    budget: { agents: 0, seconds: 0 },
  };
  addUsage(state, {
    pool: 'codex', wallSec: 1,
    usage: {
      tokens: { totalKnown: 1 }, tokenSource: 'provider-reported',
      api: { usd: 0.001 },
      subscription: { usd: null, deltaPct: 1, basis: 'observed:meter-ledger' },
    },
  });
  assert.equal(state.usage.subscriptionUsd, null);
  assert.equal(state.usage.subscriptionKnownSubtotalUsd, null);
  assert.equal(state.usage.subscriptionPricedAttempts, 0);
  assert.equal(state.usage.subscriptionMissingAttempts, 1);
  assert.equal(state.usage.subscriptionBasis, 'observed:meter-ledger');
});
