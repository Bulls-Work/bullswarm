import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsageBasis } from '../src/lib/usage-basis.js';

test('usage basis keeps provider-reported dollars distinct', () => {
  assert.equal(formatUsageBasis({ tokenSource: 'provider-reported', cost: { estimatedUsd: 3.06 } }), '$ 3.06');
});

test('usage basis labels transcript sums and byte estimates', () => {
  assert.equal(formatUsageBasis({ tokenSource: 'transcript-summed', costUsd: 3.06 }), '≈ $3.06 summed');
  assert.equal(formatUsageBasis({ tokenSource: 'estimated:utf8-bytes/4', costUsd: 3.06 }), '~ $3.06 estimated');
});

test('estimated and unknown usage never render a bare dollar sign', () => {
  assert.doesNotMatch(formatUsageBasis({ tokenSource: 'estimated:utf8-bytes/4' }), /^\$/);
  assert.equal(formatUsageBasis({ tokenSource: 'unknown', costUsd: 3.06 }), 'cost unknown');
  assert.doesNotMatch(formatUsageBasis({ tokenSource: 'unknown', costUsd: 3.06 }), /^\$/);
});
