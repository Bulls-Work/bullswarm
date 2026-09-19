import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, formatMoneyPair, formatUsageBasis } from '../src/lib/usage-basis.js';

test('usage basis keeps provider-reported dollars distinct', () => {
  assert.equal(formatUsageBasis({ tokenSource: 'provider-reported', cost: { estimatedUsd: 3.06 } }), '$ 3.06');
});

test('usage basis labels transcript sums and byte estimates', () => {
  assert.equal(formatUsageBasis({ tokenSource: 'transcript-summed', costUsd: 3.06 }), '≈ $3.06 summed');
  assert.equal(formatUsageBasis({ tokenSource: 'estimated:utf8-bytes/4', costUsd: 3.06 }), '~ $3.06 estimated');
});

test('shared money formatter keeps cents for normal amounts and precision for small ones', () => {
  assert.equal(formatMoney(0.42), '$0.42');
  assert.equal(formatMoney(0.0005564), '$0.000556');
  assert.equal(formatMoney(0.0459), '$0.0459');
  assert.equal(formatMoney(0.00418), '$0.00418');
  assert.equal(formatMoney({ usd: 0.0005564 }), '$0.000556');
  assert.equal(formatMoneyPair({
    api: { usd: 0.0005564, tokenSource: 'estimated:utf8-bytes/4' },
    subscription: { usd: 0.0459, deltaPct: 1.2, window: 'weekly', basis: 'observed:meter-delta' },
  }), '~ $0.000556 api estimated · 1.2% wk $0.0459 sub');
  assert.equal(formatMoneyPair({
    api: { usd: 0.00418, tokenSource: 'provider-reported' },
    subscription: { usd: 0.42, basis: 'observed:meter-delta' },
  }), '$0.00418 api · $0.42 sub');
});

test('money formatter distinguishes a real zero from an unpriced amount', () => {
  assert.equal(formatMoney(0, { totalKnown: 0 }), '$0');
  assert.equal(formatMoney(0, { totalKnown: 12 }), '$0.000');
  assert.equal(formatMoney(null), '-');
  assert.equal(formatMoneyPair({
    api: { usd: 0, tokenSource: 'provider-reported' },
    subscription: { usd: 0, basis: 'observed:meter-delta' },
    tokens: { totalKnown: 0 },
  }), '$0 api · $0 sub');
});

test('estimated and unknown usage never render a bare dollar sign', () => {
  assert.doesNotMatch(formatUsageBasis({ tokenSource: 'estimated:utf8-bytes/4' }), /^\$/);
  assert.equal(formatUsageBasis({ tokenSource: 'unknown', costUsd: 3.06 }), 'cost unknown');
  assert.doesNotMatch(formatUsageBasis({ tokenSource: 'unknown', costUsd: 3.06 }), /^\$/);
});

test('shared money pair uses one glyph for each API basis', () => {
  assert.equal(formatMoneyPair({
    api: { usd: 0.42, tokenSource: 'provider-reported' }, subscription: null,
  }), '$0.42 api · sub unknown (no meter/calibration)');
  assert.equal(formatMoneyPair({
    api: { usd: 0.42, tokenSource: 'transcript-summed' }, subscription: null,
  }), '≈ $0.42 api summed · sub unknown (no meter/calibration)');
  assert.equal(formatMoneyPair({
    api: { usd: 0.42, tokenSource: 'estimated:utf8-bytes/4' }, subscription: null,
  }), '~ $0.42 api estimated · sub unknown (no meter/calibration)');
  assert.equal(formatMoneyPair({
    api: { usd: null, basis: 'unknown:no-rate-card' }, subscription: null,
  }), 'api unknown · sub unknown (no meter/calibration)');
});

test('shared money pair distinguishes observed and calibrated subscription dollars', () => {
  assert.equal(formatMoneyPair({
    api: { usd: 0.42, tokenSource: 'provider-reported' },
    subscription: { deltaPct: 1.2, window: 'weekly', usd: 0.84, basis: 'observed:meter-delta' },
  }), '$0.42 api · 1.2% wk $0.84 sub');
  assert.equal(formatMoneyPair({
    api: { usd: 0.42, tokenSource: 'provider-reported' },
    subscription: { deltaPct: 1.2, window: 'weekly', usd: 0.84, basis: 'calibrated:usd-per-pct' },
  }), '$0.42 api · 1.2% wk ≈ $0.84 sub');
  assert.equal(formatMoneyPair({
    api: { usd: null },
    subscription: { usd: null, basis: 'unknown:no-price' },
  }), 'api unknown · sub unknown (no plan price)');
  assert.equal(formatMoneyPair({
    api: { usd: null },
    subscription: { pool: 'codex', usd: null, basis: 'unknown:no-price' },
  }), 'api unknown · sub unknown (declare a price: bullswarm strategy set-subscription codex --monthly-usd <amount>)');
  assert.equal(formatMoneyPair({
    api: { usd: null },
    subscription: { usd: null, basis: 'unknown:no-meter' },
  }), 'api unknown · sub unknown (no meter/calibration)');
  assert.equal(formatMoneyPair({
    api: { usd: null },
    subscription: { usd: null, basis: 'unknown:no-cost' },
  }), 'api unknown · sub unknown (no API cost)');
});
