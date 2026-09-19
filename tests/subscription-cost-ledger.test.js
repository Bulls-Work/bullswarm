import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCalibration,
  meterLedgerAttribution,
  readCalibration,
  subscriptionCost,
} from '../src/lib/subscription-cost.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attempts = [
  {
    id: 'transcripts-1', api: { usd: 0.0006984 },
    startedAt: '2026-09-19T15:27:22.413Z', finishedAt: '2026-09-19T15:47:26.954Z',
  },
  {
    id: 'provider-rules-2', api: { usd: 0.001033 },
    startedAt: '2026-09-19T15:28:46.938Z', finishedAt: '2026-09-19T15:52:53.325Z',
  },
  {
    id: 'subscription-1', api: { usd: 0.0007394 },
    startedAt: '2026-09-19T15:27:22.688Z', finishedAt: '2026-09-19T16:01:03.890Z',
  },
  {
    id: 'wiring-2', api: { usd: 0.000899 },
    startedAt: '2026-09-19T15:28:47.053Z', finishedAt: '2026-09-19T15:58:39.003Z',
  },
  {
    id: 'views-1', api: { usd: 0.0007854 },
    startedAt: '2026-09-19T15:47:27.291Z', finishedAt: '2026-09-19T16:45:30.800Z',
  },
  {
    id: 'reprice-1', api: { usd: 0.000612 },
    startedAt: '2026-09-19T15:52:53.644Z', finishedAt: '2026-09-19T16:27:48.060Z',
  },
  {
    id: 'docs-1', api: { usd: 0.000656 },
    startedAt: '2026-09-19T15:58:39.359Z', finishedAt: '2026-09-19T16:13:39.578Z',
  },
];

function interval(at, deltaPct, resolutionPct = 1, reason = null) {
  return { at, deltaPct, resolutionPct, reason };
}

test('shares the real Codex whole-percent ledger by API dollars and conserves it', () => {
  const intervals = [
    interval('2026-09-19T15:31:04.490Z', 1),
    interval('2026-09-19T15:36:06.545Z', 1),
    interval('2026-09-19T15:46:13.743Z', 1),
    interval('2026-09-19T16:06:27.285Z', 1),
    interval('2026-09-19T16:31:48.492Z', 1),
    interval('2026-09-19T16:41:50.284Z', 1),
  ];
  const total = attempts.map((attempt) => meterLedgerAttribution({
    intervals,
    attempts,
    attempt,
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    api: attempt.api,
    window: 'weekly',
  }));
  assert.ok(Math.abs(total.reduce((sum, result) => sum + (result.deltaPct ?? 0), 0) - 6) < 1e-9);
  assert.equal(total[0].basis, 'observed:meter-ledger');
  assert.equal(total[0].resolutionPct, 1);
  assert.equal(total[0].ledgerRows.length, 3);
});

test('decimal meter deltas retain 0.1-point resolution', () => {
  const result = subscriptionCost({
    pool: 'claude-code:acme',
    subscription: { monthlyPriceUsd: 200, quotaWindow: 'weekly' },
    ledgerIntervals: [
      interval('2026-09-19T18:01:27.006Z', 0.1, 0.1),
      interval('2026-09-19T18:03:27.564Z', 0.2, 0.1),
    ],
    attempts: [{ id: 'a', startedAt: '2026-09-19T18:00:00Z', finishedAt: '2026-09-19T18:04:00Z', api: { usd: 1 } }],
    attemptId: 'a', startedAt: '2026-09-19T18:00:00Z', finishedAt: '2026-09-19T18:04:00Z',
    apiUsd: 1,
  });
  assert.equal(result.deltaPct, 0.3);
  assert.equal(result.resolutionPct, 0.1);
  assert.equal(result.basis, 'observed:meter-ledger');
});

test('an observed ledger keeps its basis while an undeclared plan price stays null', () => {
  const result = subscriptionCost({
    pool: 'codex',
    subscription: { quotaWindow: 'weekly' },
    ledgerIntervals: [interval('2026-09-19T15:31:04.490Z', 1)],
    attempts: [{
      id: 'a', startedAt: '2026-09-19T15:27:22.413Z',
      finishedAt: '2026-09-19T15:47:26.954Z', api: { usd: 0.001 },
    }],
    attemptId: 'a', startedAt: '2026-09-19T15:27:22.413Z',
    finishedAt: '2026-09-19T15:47:26.954Z', apiUsd: 0.001,
  });
  assert.equal(result.deltaPct, 1);
  assert.equal(result.basis, 'observed:meter-ledger');
  assert.equal(result.usd, null);
});

test('unchanged rounded readings are below resolution, not exact zero spend', () => {
  const result = subscriptionCost({
    pool: 'codex',
    subscription: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
    ledgerIntervals: [interval('2026-09-19T18:00:00Z', 0, 1)],
    attempts: [{ id: 'a', startedAt: '2026-09-19T17:59:00Z', finishedAt: '2026-09-19T18:01:00Z', api: { usd: 1 } }],
    attemptId: 'a', startedAt: '2026-09-19T17:59:00Z', finishedAt: '2026-09-19T18:01:00Z', apiUsd: 1,
  });
  assert.equal(result.deltaPct, 0);
  assert.equal(result.usd, null);
  assert.equal(result.resolutionPct, 1);
  assert.equal(result.basis, 'unknown:below-resolution');
});

test('reset/decrease intervals are ignored without negative or double-counted spend', () => {
  const result = meterLedgerAttribution({
    intervals: [
      interval('2026-09-19T18:00:00Z', 2),
      interval('2026-09-19T18:01:00Z', null, 1, 'reset-between-readings'),
      interval('2026-09-19T18:02:00Z', 1),
      interval('2026-09-19T18:03:00Z', null, 1, 'counter-decreased'),
    ],
    attempts: [{ id: 'a', startedAt: '2026-09-19T17:59:00Z', finishedAt: '2026-09-19T18:04:00Z', api: { usd: 1 } }],
    attemptId: 'a', startedAt: '2026-09-19T17:59:00Z', finishedAt: '2026-09-19T18:04:00Z', apiUsd: 1,
  });
  assert.equal(result.deltaPct, 3);
  assert.equal(result.conservedDeltaPct, 3);
  assert.equal(result.ledgerRows.length, 2);
});

test('calibration rejects below-resolution and non-observed samples', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-subscription-ledger-'));
  try {
    appendCalibration('fixture', { window: 'weekly', apiUsd: 1, deltaPct: 0, basis: 'unknown:below-resolution' }, { home });
    appendCalibration('fixture', { window: 'weekly', apiUsd: 1, deltaPct: 1, basis: 'calibrated:usd-per-pct' }, { home });
    assert.equal(readCalibration('fixture', { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
