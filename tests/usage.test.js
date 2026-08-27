import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTextTokens, parseReportedUsage, estimateInvocationUsage, aggregateUsage,
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

test('aggregate usage totals known fields without inventing missing cache counts', () => {
  const a = estimateInvocationUsage({ taskText: '1234', outputText: '1234', connector, model: 'fixture-pro' });
  const b = estimateInvocationUsage({ taskText: '12345678', outputText: '1234', connector, model: 'fixture-pro' });
  const total = aggregateUsage([{ usage: a }, { usage: b }]);
  assert.equal(total.attempts, 2);
  assert.equal(total.tokens.standardRead, 3);
  assert.equal(total.tokens.cacheRead, null);
  assert.equal(total.tokens.output, 2);
  assert.equal(total.cost.estimatedUsd, 0.000026);
  assert.equal(total.cost.complete, true);
});

test('aggregate usage exposes a known subtotal without misreporting it as a complete total', () => {
  const known = estimateInvocationUsage({ taskText: '1234', outputText: '1234', connector, model: 'fixture-pro' });
  const unknown = estimateInvocationUsage({ taskText: '1234', outputText: '1234', connector: {}, model: null });
  const total = aggregateUsage([{ usage: known }, { usage: unknown }]);
  assert.equal(total.cost.estimatedUsd, null);
  assert.equal(total.cost.knownSubtotalUsd, known.cost.estimatedUsd);
  assert.equal(total.cost.complete, false);
  assert.match(total.cost.basis, /partial/);
  assert.equal(unknown.normalizedQuota.basis, 'unknown: invocation cost is unavailable');
});

test('aggregate usage counts attempts missing evidence and marks totals partial', () => {
  const known = estimateInvocationUsage({ taskText: '1234', outputText: '1234', connector, model: 'fixture-pro' });
  const total = aggregateUsage([
    { status: 'succeeded', usage: known },
    { status: 'abandoned', usage: null },
  ]);
  assert.equal(total.attempts, 2);
  assert.equal(total.attemptsWithUsage, 1);
  assert.equal(total.attemptsMissingUsage, 1);
  assert.equal(total.cost.complete, false);
  assert.equal(total.cost.estimatedUsd, null);
  assert.equal(total.cost.knownSubtotalUsd, known.cost.estimatedUsd);
  assert.match(total.cost.basis, /without usage evidence/);
});
