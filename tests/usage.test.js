import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTextTokens, parseReportedUsage, estimateInvocationUsage,
} from '../src/lib/usage.js';

const connector = {
  name: 'fixture',
  modelProfiles: [{
    match: '^fixture-pro$',
    tier: 'high',
    pricing: {
      inputUsdPerMillion: 2,
      cacheReadUsdPerMillion: 0.2,
      outputUsdPerMillion: 10,
    },
    pricingSource: 'fixture',
    pricingUpdatedAt: '2026-01-01',
  }],
};

test('usage estimates text tokens without presenting them as provider reported', () => {
  assert.equal(estimateTextTokens('12345678'), 2);
  const usage = estimateInvocationUsage({
    taskText: '12345678', outputText: '1234', connector, model: 'fixture-pro',
    subscription: { includedValueUsd: 20, quotaWindow: 'monthly' },
  });
  assert.equal(usage.tokenSource, 'estimated:utf8-bytes/4');
  assert.deepEqual(usage.tokens, {
    standardRead: 2, cacheRead: null, cacheWrite: null, output: 1, totalKnown: 3,
  });
  assert.equal(usage.cost.estimatedUsd, 0.000014);
  assert.equal(usage.normalizedQuota.estimatedPercent, 0.0001);
});

test('usage prefers reported input/cache/output counters', () => {
  const reported = parseReportedUsage(
    '{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":25,"output_tokens":20}',
  );
  assert.deepEqual(reported, {
    standardReadTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: 25,
    outputTokens: 20,
  });
  const usage = estimateInvocationUsage({
    taskText: 'ignored', outputText: JSON.stringify({ input_tokens: 100, output_tokens: 20 }),
    connector, model: 'fixture-pro',
  });
  assert.equal(usage.tokenSource, 'provider-reported');
  assert.equal(usage.tokens.standardRead, 100);
  assert.equal(usage.tokens.output, 20);
});

test('unknown pricing and subscription values stay explicitly unknown', () => {
  const usage = estimateInvocationUsage({ taskText: 'hello', outputText: 'world', connector: {}, model: 'mystery' });
  assert.equal(usage.cost.estimatedUsd, null);
  assert.match(usage.cost.basis, /unknown/);
  assert.equal(usage.normalizedQuota.estimatedPercent, null);
});
