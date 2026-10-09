import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelProfile } from '../src/lib/usage.js';
import { compareAttemptCosts, reportedCostUsd, summarizeCostComparison } from '../src/lib/rate-card-check.js';

const claude = JSON.parse(readFileSync(new URL('../src/providers/claude-code/connector.json', import.meta.url), 'utf8'));

// Every Claude model Bullswarm dispatches has a dated price row with the
// numbers https://platform.claude.com/docs/en/about-claude/pricing published
// (re-read 2026-10-09). claude-sonnet-5-5 had none until 0.38.8, so 34 attempts in a
// week recorded no price although the CLI reported one.
const PUBLISHED = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  // Cache hits at 0.05x input ($0.10): the page's footnote 2, read 2026-10-09.
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
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

// Haiku 5.5 is priced by prompt length (re-read 2026-10-09): a request whose
// prompt is over 100,000 tokens pays the second line of rates.
test('Claude Haiku 5.5 carries both lines of its published rates', () => {
  const profile = modelProfile(claude, 'claude-haiku-5-5');
  assert.deepEqual(profile.pricing, {
    inputUsdPerMillion: 0.1,
    cacheReadUsdPerMillion: 0.01,
    cacheWrite5mUsdPerMillion: 0.125,
    cacheWrite1hUsdPerMillion: 0.2,
    outputUsdPerMillion: 0.5,
    longContext: {
      thresholdTokens: 100000,
      inputUsdPerMillion: 0.5,
      cacheReadUsdPerMillion: 0.05,
      cacheWrite5mUsdPerMillion: 0.625,
      cacheWrite1hUsdPerMillion: 1,
      outputUsdPerMillion: 2.5,
    },
  });
  assert.match(profile.pricingSource, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
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

const connectorFile = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const codex = connectorFile('../src/providers/codex/connector.json');
const grok = connectorFile('../src/providers/grok/connector.json');
const commandCode = connectorFile('../providers/contrib/command-code/connector.json');

// https://developers.openai.com/api/docs/pricing, read 2026-10-09:
// [input, cached input, cache write, output] and, where the page lists one,
// the same four for a request with more than 272K input tokens.
const OPENAI = {
  'gpt-6-astra': [[10, 1, 12.5, 50], [20, 2, 25, 75]],
  'gpt-6.1-sol': [[2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
  'gpt-6-sol': [[2, 0.2, 2.5, 10], null],
  'gpt-6-luna': [[0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  'gpt-5.6-sol': [[4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  'gpt-5.6-terra': [[2, 0.2, 2.5, 12], null],
  'gpt-5.6-luna': [[0.2, 0.02, 0.25, 1.2], null],
};

const fourRates = ([input, read, write, output]) => ({
  inputUsdPerMillion: input, cacheReadUsdPerMillion: read, cacheWriteUsdPerMillion: write, outputUsdPerMillion: output,
});

test('every codex model has the rates OpenAI publishes, long context included', () => {
  for (const [model, [short, long]] of Object.entries(OPENAI)) {
    const pricing = modelProfile(codex, model)?.pricing;
    assert.ok(pricing, `${model} has no price row`);
    const { longContext, ...rest } = pricing;
    assert.deepEqual(rest, fourRates(short), model);
    if (long) assert.deepEqual(longContext, { thresholdTokens: 272000, ...fourRates(long) }, `${model} long context`);
    else assert.equal(longContext, undefined, `${model} has no published long-context price`);
  }
});

// https://docs.x.ai/docs/models, read 2026-10-09: under / at or above 200K.
test('every grok model has the rates xAI publishes', () => {
  const XAI = { 'grok-4.7': [2, 0.5, 6], 'grok-4.6': [2, 0.5, 6], 'grok-4.5': [2, 0.3, 6] };
  for (const [model, [input, read, output]] of Object.entries(XAI)) {
    assert.deepEqual(modelProfile(grok, model)?.pricing, {
      inputUsdPerMillion: input,
      cacheReadUsdPerMillion: read,
      outputUsdPerMillion: output,
      longContext: { thresholdTokens: 200000, inputUsdPerMillion: input * 2, cacheReadUsdPerMillion: read * 2, outputUsdPerMillion: output * 2 },
    }, model);
  }
});

// https://commandcode.ai/docs/resources/pricing-limits, read 2026-10-09.
test('command-code prices the OpenAI and Anthropic models it runs at its published rates', () => {
  assert.deepEqual(modelProfile(commandCode, 'gpt-6-luna')?.pricing, fourRates([0.1, 0.01, 0.125, 0.5]));
  assert.deepEqual(modelProfile(commandCode, 'claude-sonnet-5-5')?.pricing, fourRates([2, 0.2, 2.5, 10]));
});
