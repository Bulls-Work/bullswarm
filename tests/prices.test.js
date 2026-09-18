import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planPrices, planPriceFor, priceFor, subscriptionCostUsd } from '../src/lib/prices.js';

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

test('provider plan prices resolve case-insensitively and retain provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-plan-prices-'));
  try {
    const file = join(dir, 'prices.json');
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 'bullswarm.plan-prices.v1',
      plans: {
        demo: {
          Pro: {
            monthlyPriceUsd: 42,
            source: 'https://example.test/pricing',
            quotedLine: 'Pro — $42 / month',
            checkedAt: '2026-09-18',
          },
        },
      },
    })}\n`);
    assert.deepEqual(planPriceFor('demo', 'pro', { file }), {
      monthlyPriceUsd: 42,
      includedValueUsd: null,
      source: 'https://example.test/pricing',
      updatedAt: null,
      basis: 'published demo plan price',
      quotedLine: 'Pro — $42 / month',
      checkedAt: '2026-09-18',
      plan: 'pro',
      provider: 'demo',
    });
    assert.equal(planPriceFor('demo', 'not-reported', { file }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundled vendor plan prices do not invent an ambiguous Codex Pro amount', () => {
  assert.equal(planPriceFor('codex', 'plus')?.monthlyPriceUsd, 20);
  assert.equal(planPriceFor('codex', 'pro'), null);
  assert.equal(planPriceFor('codex', 'pro200')?.monthlyPriceUsd, 200);
});

test('a team seat never falls through to its usage multiplier price', () => {
  // Observed on the owner's real home (2026-09-18): claude-code:wati reports
  // the seat plan `team`, while `default_claude_max_5x` is only its usage
  // multiplier. The latter is a different consumer product and must not be
  // used when the team plan has no sourced monthly price.
  const wati = {
    name: 'claude-code:wati',
    connector: { name: 'claude-code:wati', profile: { slug: 'wati' } },
    meterSnapshot: {
      plan_name: 'team', plan_type: 'team', subscription_type: 'team',
      rate_limit_tier: 'default_claude_max_5x',
    },
  };
  assert.equal(planPriceFor('claude-code', ['team', 'team', 'team', 'default_claude_max_5x']), null);
  assert.equal(planPriceFor(wati, wati), null);

  // A real billing plan still resolves through a per-account provider clone.
  const base = {
    name: 'claude-code:wati',
    connector: { name: 'claude-code:wati', profile: { slug: 'wati' } },
    meterSnapshot: { plan_name: 'max 20x', subscription_type: 'max', rate_limit_tier: 'default_claude_max_20x' },
  };
  assert.equal(planPriceFor(base, base)?.monthlyPriceUsd, 200);
  assert.equal(planPriceFor(base, base)?.provider, 'claude-code');

  // No plan_name or plan_type means the multiplier alone remains unknown.
  const multiplierOnly = {
    name: 'claude-code',
    connector: { name: 'claude-code', profile: { slug: null } },
    meterSnapshot: { subscription_type: 'max', rate_limit_tier: 'default_claude_max_20x' },
  };
  assert.equal(planPriceFor(multiplierOnly, multiplierOnly), null);

  const unknown = {
    name: 'claude-code:ghost',
    connector: { name: 'claude-code:ghost' },
    meterSnapshot: { subscription_type: 'enterprise-bespoke' },
  };
  assert.equal(planPriceFor(unknown, unknown), null);
});
