import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelProfile } from '../src/lib/usage.js';
import { compareAttemptCosts, reportedCostUsd, summarizeCostComparison } from '../src/lib/rate-card-check.js';

const claude = JSON.parse(readFileSync(new URL('../src/providers/claude-code/connector.json', import.meta.url), 'utf8'));

// Every Claude model Bullswarm dispatches has a dated price row with the
// numbers https://platform.claude.com/docs/en/about-claude/pricing published
// on 2026-10-02. claude-sonnet-5-5 had none until 0.38.8, so 34 attempts in a
// week recorded no price although the CLI reported one.
const PUBLISHED = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
};

test('every dispatched Claude model has a price row with the published rates', () => {
  for (const [model, [input, write5m, write1h, read, output]] of Object.entries(PUBLISHED)) {
    const profile = modelProfile(claude, model);
    assert.ok(profile?.pricing, `${model} has no price row`);
    assert.deepEqual(profile.pricing, {
      inputUsdPerMillion: input,
      cacheReadUsdPerMillion: read,
      cacheWrite5mUsdPerMillion: write5m,
      cacheWrite1hUsdPerMillion: write1h,
      outputUsdPerMillion: output,
    }, model);
    assert.match(profile.pricingSource, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  }
});

test('a resumed attempt is compared with its session total, as Claude Code reports it', () => {
  const state = {
    shortId: 'abc123',
    attempts: [
      { actionId: 'a', pool: 'claude-code', usage: { model: 'claude-opus-5-5', sessionId: 's1', api: { usd: 8.75 } }, streamFile: 'x' },
      { actionId: 'a', pool: 'claude-code', continued: true, usage: { model: 'claude-opus-5-5', sessionId: 's1', api: { usd: 0.61 } }, streamFile: 'y' },
      { actionId: 'b', pool: 'claude-code', usage: { model: 'claude-opus-5-5', sessionId: 's2', api: { usd: 1.0 } }, streamFile: 'z' },
    ],
  };
  const costs = { x: 8.75, y: 9.36, z: 1.3 };
  const rows = compareAttemptCosts(state, (attempt) => [{ usage: { costUsd: costs[attempt.streamFile] } }]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].session, true);
  assert.ok(Math.abs(rows[1].ratio - 1) < 1e-9, 'the session sum matches the reported total');
  const [group] = summarizeCostComparison(rows);
  assert.equal(group.pairs, 3);
  assert.equal(group.exact, 2);
  assert.equal(group.off[0].actionId, 'b', 'a real gap is still named');
});

test('an attempt with no reported cost or no rate-card price is left out', () => {
  assert.equal(reportedCostUsd([{ usage: { input: 3 } }]), null);
  const rows = compareAttemptCosts({ attempts: [
    { usage: { api: { usd: null } } },
    { usage: { api: { usd: 2 } } },
  ] }, () => [{ usage: {} }]);
  assert.deepEqual(rows, []);
});
