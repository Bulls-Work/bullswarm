import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCalibration, readCalibration, subscriptionCost, subscriptionUsdFromPct,
  windowDays, windowPriceUsd,
} from '../src/lib/subscription-cost.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function home() {
  return mkdtempSync(join(tmpdir(), 'bullswarm-subscription-'));
}

test('window math uses the exact five-hour/weekly/monthly divisors', () => {
  assert.equal(windowDays('5h'), 5 / 24);
  assert.equal(windowDays('weekly'), 7);
  assert.equal(windowDays('monthly', '2026-03-31T00:00:00.000Z'), 31);
  assert.equal(windowPriceUsd(30, 'weekly'), 30 * 7 / 30.4375);
  assert.equal(subscriptionUsdFromPct(1.2, windowPriceUsd(30, 'weekly')),
    (30 * 7 / 30.4375) * 1.2 / 100);
});

test('calibration stays unknown before three eligible samples', () => {
  const dir = home();
  try {
    appendCalibration('fixture', {
      at: '2026-09-19T00:00:00Z', window: 'weekly', apiUsd: 0.42, deltaPct: 1.2,
    }, { home: dir });
    appendCalibration('fixture', {
      at: '2026-09-20T00:00:00Z', window: 'weekly', apiUsd: 0.21, deltaPct: 0.6,
    }, { home: dir });
    const ledger = readCalibration('fixture', { home: dir });
    assert.equal(ledger.sampleCount, 2);
    assert.equal(ledger.usdPerPct, null);
    const cost = subscriptionCost({
      pool: 'fixture', home: dir, apiUsd: 0.42,
      subscription: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
    });
    assert.equal(cost.usd, null);
    assert.equal(cost.basis, 'unknown:no-meter');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observed, calibrated, and unknown decision tree keeps null distinct from zero', () => {
  const dir = home();
  try {
    const start = { at: '2026-09-19T12:00:00Z', window: 'weekly', usedPct: 10, resetsAt: '2026-09-20T00:00:00Z' };
    const end = { at: '2026-09-19T12:00:30Z', window: 'weekly', usedPct: 11.2, resetsAt: '2026-09-20T00:00:00Z' };
    const observed = subscriptionCost({
      pool: 'fixture', home: dir, apiUsd: 0.42,
      subscription: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
      startSnapshot: start, endSnapshot: end,
    });
    assert.equal(observed.deltaPct, 1.2);
    assert.equal(observed.basis, 'observed:meter-delta');
    assert.equal(observed.usd, subscriptionUsdFromPct(1.2, windowPriceUsd(30, 'weekly')));

    for (let i = 0; i < 3; i += 1) {
      appendCalibration('fixture', {
        at: `2026-09-${20 + i}T00:00:00Z`, window: 'weekly', apiUsd: 1, deltaPct: 2,
      }, { home: dir });
    }
    const calibrated = subscriptionCost({
      pool: 'fixture', home: dir, apiUsd: 3,
      subscription: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
    });
    assert.equal(calibrated.basis, 'calibrated:usd-per-pct');
    assert.equal(calibrated.deltaPct, 6);
    assert.equal(calibrated.usd, 30 * 7 / 30.4375 * 6 / 100);

    const noPrice = subscriptionCost({
      pool: 'fixture', home: dir, apiUsd: 0.42,
      subscription: { monthlyPriceUsd: null, quotaWindow: 'weekly' },
      startSnapshot: start, endSnapshot: end,
    });
    assert.equal(noPrice.deltaPct, 1.2);
    assert.equal(noPrice.usd, null);
    assert.equal(noPrice.basis, 'unknown:no-price');
    const noCost = subscriptionCost({
      pool: 'other', subscription: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
    });
    assert.equal(noCost.usd, null);
    assert.equal(noCost.basis, 'unknown:no-cost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detected meter plans resolve a published table price', () => {
  const start = {
    at: '2026-09-19T12:00:00Z', window: 'weekly', usedPct: 10,
    resetsAt: '2026-09-20T00:00:00Z', source: 'forced',
  };
  const end = {
    at: '2026-09-19T12:00:30Z', window: 'weekly', usedPct: 10.5,
    resetsAt: '2026-09-20T00:00:00Z', source: 'cache',
  };
  const cost = subscriptionCost({
    pool: { name: 'claude-code', meterSnapshot: { plan: 'max 20x' } },
    subscription: { monthlyPriceUsd: null, quotaWindow: 'weekly' },
    apiUsd: 0.1,
    startSnapshot: start,
    endSnapshot: end,
  });
  assert.equal(cost.monthlyPriceUsd, 200);
  assert.equal(cost.basis, 'observed:meter-delta');
  assert.equal(cost.deltaPct, 0.5);
  assert.equal(cost.snapshots.start.source, 'forced');
  assert.equal(cost.snapshots.end.source, 'cache');
});

test('an unlisted detected plan remains unknown rather than inferred', () => {
  const cost = subscriptionCost({
    pool: { name: 'codex', meterSnapshot: { plan: 'prolite' } },
    subscription: { monthlyPriceUsd: null, quotaWindow: 'weekly' },
    apiUsd: 0.1,
    startSnapshot: {
      at: '2026-09-19T12:00:00Z', window: 'weekly', usedPct: 10,
      resetsAt: '2026-09-20T00:00:00Z', source: 'forced',
    },
    endSnapshot: {
      at: '2026-09-19T12:00:30Z', window: 'weekly', usedPct: 10.5,
      resetsAt: '2026-09-20T00:00:00Z', source: 'cache',
    },
  });
  assert.equal(cost.monthlyPriceUsd, null);
  assert.equal(cost.deltaPct, 0.5);
  assert.equal(cost.usd, null);
  assert.equal(cost.basis, 'unknown:no-price');
});

test('ledger append caps to newest 500 samples and writes atomically', () => {
  const dir = home();
  try {
    for (let i = 0; i < 505; i += 1) {
      appendCalibration('fixture', {
        at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        window: 'weekly', apiUsd: 1, deltaPct: 1,
      }, { home: dir });
    }
    const ledger = readCalibration('fixture', { home: dir });
    assert.equal(ledger.samples.length, 500);
    assert.equal(ledger.samples[0].apiUsd, 1);
    assert.equal(ledger.sampleCount, 500);
    const raw = readFileSync(join(dir, 'calibration', 'fixture.json'), 'utf8');
    assert.match(raw, /"schema": "bullswarm\.calibration\.v1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
