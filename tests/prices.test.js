import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planPrices, priceFor, subscriptionCostUsd } from '../src/lib/prices.js';

test('plan prices are parsed offline and a per-machine override wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-prices-'));
  try {
    const file = join(dir, 'prices.json');
    const table = {
      schemaVersion: 'bullswarm.plan-prices.v1',
      source: 'https://example.test/plans',
      updatedAt: '2026-09-16',
      prices: {
        demo: { monthlyPriceUsd: 30, includedValueUsd: 100 },
      },
    };
    writeFileSync(file, `${JSON.stringify(table)}\n`);
    assert.deepEqual(planPrices({ file }), table);
    assert.deepEqual(priceFor('demo', {
      file,
      subscriptions: { demo: { monthlyPriceUsd: 12, includedValueUsd: 40 } },
    }), {
      monthlyPriceUsd: 12,
      includedValueUsd: 40,
      source: 'user-declared',
      updatedAt: null,
      basis: 'state.strategy.subscriptions override',
    });
    assert.deepEqual(priceFor('demo', { file }), {
      monthlyPriceUsd: 30,
      includedValueUsd: 100,
      source: 'https://example.test/plans',
      updatedAt: '2026-09-16',
      basis: 'published plan price',
    });
    assert.equal(subscriptionCostUsd({ monthlyPriceUsd: 30 }, { days: 7 }), 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an undeclared plan yields null rather than a number', () => {
  assert.equal(priceFor('not-in-the-honest-empty-table'), null);
  assert.equal(subscriptionCostUsd(null), null);
  assert.equal(subscriptionCostUsd({ monthlyPriceUsd: null }), null);
});
