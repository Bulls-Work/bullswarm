// Claude Haiku 5.5 charges by prompt length: a request whose prompt (input,
// cache reads and cache writes together) is over 100,000 tokens pays the
// row's `longContext` rates, each request on its own. Claude's transcript
// records carry no tier, so the price row's `thresholdTokens` decides it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { estimateInvocationUsage, needsPerRequestTiers } from '../src/lib/usage.js';

const connector = JSON.parse(readFileSync(new URL('../src/providers/claude-code/connector.json', import.meta.url), 'utf8'));

function request(standardRead, cacheRead, cacheWrite1h, output) {
  return { tokens: { standardRead, cacheRead, cacheWrite5m: 0, cacheWrite1h, cacheWrite: cacheWrite1h, output, reasoning: 0 } };
}

function price(requests) {
  const sum = (key) => requests.reduce((total, item) => total + item.tokens[key], 0);
  const tokens = { standardRead: sum('standardRead'), cacheRead: sum('cacheRead'), cacheWrite5m: 0, cacheWrite1h: sum('cacheWrite1h'), output: sum('output'), reasoning: 0 };
  return estimateInvocationUsage({
    connector,
    model: 'claude-haiku-5-5',
    reportedUsage: { ...tokens, outputIsExclusive: true, tokenSource: 'transcript-summed' },
    forceTokenSource: 'transcript-summed',
    requests,
  }).api;
}

test('a Haiku 5.5 request over 100,000 prompt tokens is priced at the higher line', () => {
  const api = price([request(10, 60_000, 5_000, 200), request(10, 95_000, 6_000, 300)]);
  // Short: 10 × $0.10 + 60k × $0.01 + 5k × $0.20 + 200 × $0.50, per million.
  // Long (prompt 101,010): 10 × $0.50 + 95k × $0.05 + 6k × $1 + 300 × $2.50.
  const expected = (10 * 0.1 + 60_000 * 0.01 + 5_000 * 0.2 + 200 * 0.5 + 10 * 0.5 + 95_000 * 0.05 + 6_000 * 1 + 300 * 2.5) / 1e6;
  assert.equal(api.basis, 'rate-card:complete');
  assert.ok(Math.abs(api.usd - expected) < 1e-12, `${api.usd} vs ${expected}`);
});

test('a prompt of exactly 100,000 tokens stays on the lower line', () => {
  const api = price([request(0, 100_000, 0, 0)]);
  assert.ok(Math.abs(api.usd - 100_000 * 0.01 / 1e6) < 1e-12, String(api.usd));
});

test('totals alone settle the tier only while every prompt together stays under the line', () => {
  const { pricing } = connector.modelProfiles.find((row) => row.match.includes('haiku-5-5'));
  assert.equal(needsPerRequestTiers(pricing, { standardRead: 4, cacheRead: 41_342, cacheWrite1h: 20_471, cacheWrite5m: 0 }), false);
  assert.equal(needsPerRequestTiers(pricing, { standardRead: 4, cacheRead: 141_342, cacheWrite1h: 0, cacheWrite5m: 0 }), true);
  const opus = connector.modelProfiles.find((row) => row.match.includes('opus-5-5'));
  assert.equal(needsPerRequestTiers(opus.pricing, { cacheRead: 9_000_000 }), false, 'a row with one line never needs them');
});

test('the pricing pass prices a Haiku 5.5 attempt from its totals only while they stay under the line', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rateCardCandidate } = await import('../src/workflow/reprice.js');
  const home = mkdtempSync(join(tmpdir(), 'bs-haiku-'));
  try {
    const attempt = (cacheRead) => ({
      id: 'a', pool: 'claude-code', startedAt: '2026-10-09T08:00:00Z',
      usage: {
        model: 'claude-haiku-5-5', tokenSource: 'provider-reported',
        tokens: { standardRead: 4, cacheRead, cacheWrite5m: 0, cacheWrite1h: 20_471, cacheWrite: 20_471, output: 100, reasoning: 231, totalKnown: 4 + cacheRead + 20_471 + 331 },
        api: { usd: null, basis: 'unknown:no-rate-card' },
      },
    });
    const connectors = { 'claude-code': connector };
    const small = rateCardCandidate({ attempt: attempt(41_342), state: { runId: 'r' }, connectors, home });
    const expected = (4 * 0.1 + 41_342 * 0.01 + 20_471 * 0.2 + 331 * 0.5) / 1e6;
    assert.ok(Math.abs(small.api.usd - expected) < 1e-12, `${small?.api?.usd} vs ${expected}`);
    assert.equal(rateCardCandidate({ attempt: attempt(141_342), state: { runId: 'r' }, connectors, home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
