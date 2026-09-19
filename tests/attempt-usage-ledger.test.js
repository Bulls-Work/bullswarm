import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOnce } from '../src/lib/watch.js';

const BASE = Date.now() - 10_000;
const START = new Date(BASE).toISOString();
const END = new Date(BASE + 8_000).toISOString();

function paths(home, name) {
  return {
    taskFile: join(home, `${name}.task.md`),
    outFile: join(home, `${name}.out.md`),
  };
}

function connector() {
  return {
    name: 'codex:ledger-fixture',
    model: 'ledger-model',
    spawn: {
      cmd: [process.execPath, '-e', "console.log('Implemented and verified the ledger fixture. output_tokens: 20 input_tokens: 10')"],
    },
    modelProfiles: [{
      match: '^ledger-model$',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      pricingSource: 'fixture:ledger-model',
      pricingUpdatedAt: '2026-09-20',
    }],
    subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
  };
}

function snapshot(at, usedPct, index, ageMs = 0) {
  const value = { at, window: 'weekly', usedPct, resetsAt: '2026-09-27T00:00:00.000Z', ageMs, source: 'cache' };
  Object.defineProperty(value, 'historyCursor', {
    value: { at, window: 'weekly', index, source: 'live', providerAt: at },
    enumerable: false,
  });
  return value;
}

const intervals = [
  { pool: 'codex:ledger-fixture', window: 'weekly', row: 2, from: new Date(BASE + 1_000).toISOString(), at: new Date(BASE + 2_000).toISOString(), deltaPct: 1, resolutionPct: 1, reason: null },
  { pool: 'codex:ledger-fixture', window: 'weekly', row: 3, from: new Date(BASE + 2_000).toISOString(), at: new Date(BASE + 4_000).toISOString(), deltaPct: 1, resolutionPct: 1, reason: null },
  { pool: 'codex:ledger-fixture', window: 'weekly', row: 4, from: new Date(BASE + 4_000).toISOString(), at: new Date(BASE + 6_000).toISOString(), deltaPct: 1, resolutionPct: 1, reason: null },
];

test('watchOnce brackets a delegate and conserves an overlapping meter ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-attempt-ledger-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  try {
    const verdict = await watchOnce(
      connector(),
      'Implement the ledger fixture.',
      home,
      paths(home, 'overlap'),
      {
        bullswarmDir: home,
        home,
        poolName: 'codex:ledger-fixture',
        runId: 'wf-ledger-fixture',
        attemptId: 'ledger-2',
        startedAt: START,
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        snapshotPool: async (_pool, { now }) => now === Date.parse(START)
          ? snapshot(START, 40, 1)
          : snapshot(END, 43, 4),
        meterHistoryIntervals: () => intervals,
        attempts: [{
          id: 'ledger-1', attemptId: 'ledger-1', pool: 'codex:ledger-fixture',
          startedAt: new Date(BASE - 1_000).toISOString(), finishedAt: END, apiUsd: 1,
        }],
        outputValidator: () => ({ ok: true }),
      },
    );
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.usage.api.basis, 'rate-card:complete');
    assert.ok(verdict.meta.usage.api.usd != null);
    const subscription = verdict.meta.usage.subscription;
    assert.equal(subscription.basis, 'observed:meter-ledger');
    const oneShare = Math.round((verdict.meta.usage.api.usd / (1 + verdict.meta.usage.api.usd)) * 1e8) / 1e8;
    const expectedShare = Math.round(oneShare * 3 * 1e8) / 1e8;
    assert.equal(subscription.deltaPct, expectedShare);
    assert.ok(subscription.deltaPct > 0 && subscription.deltaPct < 3);
    assert.equal(subscription.conservedDeltaPct, 3);
    assert.equal(subscription.ledgerRows.length, 3);
    assert.deepEqual(subscription.attribution.startCursor, {
      at: START, window: 'weekly', index: 1, source: 'live', providerAt: START,
    });
    assert.deepEqual(subscription.attribution.endCursor, {
      at: END, window: 'weekly', index: 4, source: 'live', providerAt: END,
    });
    assert.equal(subscription.attribution.ledgerRows.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchOnce does not turn a stale end cache into a fabricated zero', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-attempt-ledger-stale-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  try {
    let refreshes = 0;
    const verdict = await watchOnce(
      connector(),
      'Implement the stale-cache fixture.',
      home,
      paths(home, 'stale'),
      {
        bullswarmDir: home,
        home,
        poolName: 'codex:ledger-fixture',
        attemptId: 'ledger-stale',
        startedAt: START,
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        snapshotPool: async () => snapshot(START, 40, 1, 120_000),
        getMeterReading: async () => { refreshes += 1; return { source: 'stale' }; },
        outputValidator: () => ({ ok: true }),
      },
    );
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(refreshes, 2);
    assert.equal(verdict.meta.usage.subscription.usd, null);
    assert.equal(verdict.meta.usage.subscription.basis, 'unknown:no-meter');
    assert.equal(verdict.meta.usage.subscription.snapshots.end, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
