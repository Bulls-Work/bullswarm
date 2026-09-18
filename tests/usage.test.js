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
    standardRead: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null,
    cacheWrite: null, output: 1, totalKnown: 3,
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

test('usage takes the final cumulative provider counters across a stream', () => {
  const reported = parseReportedUsage([
    '{"input_tokens":100,"output_tokens":4}',
    '{"input_tokens":50,"output_tokens":6}',
  ].join('\n'));
  assert.deepEqual(reported, {
    standardReadTokens: 50,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: 6,
  });
});

test('text fallback reads one final counter instead of triple-counting nested aliases', () => {
  const reported = parseReportedUsage(
    '{"usage":{"input_tokens":2,"output_tokens":176,"cache_creation_input_tokens":30253},'
      + '"usage":{"iterations":[{"input_tokens":2,"output_tokens":176,"cache_creation_input_tokens":30253}]},'
      + '"modelUsage":{"input_tokens":2,"output_tokens":176,"cache_creation_input_tokens":30253}}',
  );
  assert.deepEqual(reported, {
    standardReadTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: 30253,
    outputTokens: 176,
  });
});

test('structured provider usage wins over text and keeps billed cost/session/cache tiers', () => {
  const usage = estimateInvocationUsage({
    taskText: 'ignored',
    outputText: '{"input_tokens":999999,"output_tokens":999999}',
    connector: {
      modelProfiles: [{
        match: '^fixture-pro$',
        pricing: {
          inputUsdPerMillion: 2,
          cacheReadUsdPerMillion: 0.2,
          cacheWrite5mUsdPerMillion: 3,
          cacheWrite1hUsdPerMillion: 4,
          outputUsdPerMillion: 10,
        },
      }],
    },
    model: 'fixture-pro',
    reportedUsage: {
      standardRead: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, output: 6,
      costUsd: 0.61388, sessionId: 'session-1',
    },
  });
  assert.equal(usage.tokenSource, 'provider-reported');
  assert.equal(usage.costSource, 'provider-billed');
  assert.equal(usage.sessionId, 'session-1');
  assert.equal(usage.tokens.totalKnown, 20);
  assert.equal(usage.tokens.cacheWrite, 9);
  assert.equal(usage.cost.estimatedUsd, 0.61388);
  assert.equal(usage.cost.breakdown.cacheWriteUsd, 0.000032);
  assert.deepEqual(usage.pricedFields, ['standardRead', 'cacheRead', 'cacheWrite', 'output']);
});

test('unknown pricing and subscription values stay explicitly unknown', () => {
  const usage = estimateInvocationUsage({ taskText: 'hello', outputText: 'world', connector: {}, model: 'mystery' });
  assert.equal(usage.cost.estimatedUsd, null);
  assert.match(usage.cost.basis, /unknown/);
  assert.equal(usage.normalizedQuota.estimatedPercent, null);
});
