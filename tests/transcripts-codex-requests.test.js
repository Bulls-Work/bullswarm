// Codex per-request records and OpenAI long-context pricing.
//
// A codex rollout's `token_count` rows carry the session's running total and
// the request's own `last_token_usage`. When the requests add up to the
// window's total, each is priced on its own, and a request with more than
// 272K input tokens takes the row's `longContext` rates. The shapes below are
// the ones in real rollouts (codex 2026-10-01: rollout-…-01a0f4e9-….jsonl).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTranscriptUsage } from '../src/lib/transcripts/codex.js';
import { estimateInvocationUsage } from '../src/lib/usage.js';

const SESSION = '01a0f4e9-b499-7852-a183-a8500525beb8';
const connector = JSON.parse(readFileSync(new URL('../src/providers/codex/connector.json', import.meta.url), 'utf8'));

function usage(input, cached, output) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
}

function rollout(requests, { lastOnlyEvery = 1 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-codex-req-'));
  const dir = join(home, '.codex', 'sessions', '2026', '10', '01');
  mkdirSync(dir, { recursive: true });
  const rows = [
    { timestamp: '2026-10-01T00:42:31.000Z', type: 'session_meta', payload: { id: SESSION, cwd: '/w' } },
    { timestamp: '2026-10-01T00:42:32.000Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-5.6-sol' } },
  ];
  const total = usage(0, 0, 0);
  requests.forEach(([input, cached, output], index) => {
    for (const [key, value] of Object.entries(usage(input, cached, output))) total[key] += value;
    const info = { total_token_usage: { ...total }, model_context_window: 353400 };
    // An older rollout logs only some requests' own usage.
    if (index % lastOnlyEvery === 0) info.last_token_usage = usage(input, cached, output);
    rows.push({ timestamp: `2026-10-01T00:43:${String(10 + index).padStart(2, '0')}.000Z`, type: 'event_msg', payload: { type: 'token_count', info } });
  });
  writeFileSync(join(dir, `rollout-2026-10-01T08-42-31-${SESSION}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function price(record) {
  return estimateInvocationUsage({
    connector,
    model: 'gpt-5.6-sol',
    reportedUsage: { ...record.tokens, outputIsExclusive: true, requests: record.requests, tokenSource: 'transcript-summed' },
    forceTokenSource: 'transcript-summed',
    requests: record.requests,
  }).api;
}

test('each codex request is its own record, and one past 272K input is priced at the long-context rates', () => {
  const fixture = rollout([[100_000, 80_000, 1_000], [300_000, 200_000, 2_000], [50_000, 40_000, 500]]);
  try {
    const record = readTranscriptUsage({ sessionId: SESSION, home: fixture.home });
    assert.deepEqual(record.requests.map((request) => request.contextTier), ['short', 'long', 'short']);
    const api = price(record);
    // Short: (20k × $4 + 80k × $0.40 + 1k × $20) + (10k × $4 + 40k × $0.40 + 500 × $20), per million.
    // Long:  100k × $8 + 200k × $0.80 + 2k × $30, per million.
    const expected = (20_000 * 4 + 80_000 * 0.4 + 1_000 * 20 + 10_000 * 4 + 40_000 * 0.4 + 500 * 20 + 100_000 * 8 + 200_000 * 0.8 + 2_000 * 30) / 1e6;
    assert.equal(api.basis, 'rate-card:complete');
    assert.ok(Math.abs(api.usd - expected) < 1e-9, `${api.usd} vs ${expected}`);
  } finally {
    fixture.cleanup();
  }
});

test('a rollout whose requests do not add up to its total keeps one combined record', () => {
  const fixture = rollout([[100_000, 80_000, 1_000], [300_000, 200_000, 2_000], [50_000, 40_000, 500]], { lastOnlyEvery: 2 });
  try {
    const record = readTranscriptUsage({ sessionId: SESSION, home: fixture.home });
    assert.equal(record.requests.length, 1);
    assert.equal(record.requests[0].contextTier, undefined, 'no tier is claimed without per-request counts');
    assert.equal(record.tokens.standardRead, 450_000 - 320_000);
  } finally {
    fixture.cleanup();
  }
});
