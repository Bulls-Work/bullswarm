import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptMetric } from '../src/workflow/metrics.js';
import { tokensModel } from '../src/workflow/tokens-model.js';
import { statsLines, STATS_TABS as VIEW_TABS } from '../src/workflow/stats-view.js';
import { STATS_TABS } from '../src/workflow/dashboard-pages.js';

// Charlie, 27 Nov (bs-tokens-tab-1127): a Tokens tab in Stats in place of Pool,
// input vs output like Cloudflare's Workers AI chart, with tokens by pool,
// model and project; Spending drops its By Pool / By Model switch.

process.env.TZ = 'Asia/Hong_Kong';
process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-11-28T04:00:00.000Z');

const metric = (over) => ({
  role: 'worker', pool: 'cf:deepseek', model: 'cf/deepseek-v4.1-flash', outcome: 'succeeded',
  startedAt: '2026-11-27T02:00:00.000Z', finishedAt: '2026-11-27T02:10:00.000Z',
  tokenSource: 'provider-reported',
  standardRead: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 500, reasoning: 100, tokens: 10_600,
  ...over,
});

const run = (project, attemptMetrics) => ({
  schemaVersion: 'bullswarm.workflow.rollup.v1', runId: `wf-${project}-${attemptMetrics.length}`,
  project, status: 'completed', startedAt: attemptMetrics[0].startedAt, finishedAt: attemptMetrics[0].finishedAt,
  attemptMetrics,
});

const rollups = [
  run('kipwise', [
    metric({}),
    metric({ pool: 'cf:glm', model: 'cf/glm-5.3', finishedAt: '2026-11-26T05:00:00.000Z', startedAt: '2026-11-26T04:00:00.000Z', standardRead: 2_000, cacheRead: 0, cacheWrite: 0, output: 1_000, reasoning: 0, tokens: 3_000 }),
  ]),
  run('gym', [
    metric({ pool: 'claude-code:w', model: 'claude-sonnet-5-5', standardRead: 100, cacheRead: 50_000, cacheWrite: 4_000, output: 2_000, reasoning: 0, tokens: 56_100 }),
    // No token data at all: counted as not reported, never guessed.
    metric({ pool: 'grok', model: 'grok-4.7', tokenSource: 'unknown', standardRead: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, tokens: null }),
    // A byte estimate is not a reported count.
    metric({ pool: 'grok', model: 'grok-4.7', tokenSource: 'estimated:utf8-bytes/4', standardRead: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, tokens: 9_999 }),
  ]),
  // Outside 7d.
  run('old', [metric({ startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:10:00.000Z' })]),
];

test('an attempt metric carries uncached input and output, not just the total', () => {
  const m = attemptMetric({
    pool: 'cf:glm', model: 'cf/glm-5.3', status: 'succeeded',
    usage: { tokenSource: 'provider-reported', tokens: { standardRead: 49_095, cacheRead: 507_776, cacheWrite: 0, output: 15_332, reasoning: 0, totalKnown: 572_203 } },
  });
  assert.equal(m.standardRead, 49_095);
  assert.equal(m.output, 15_332);
  assert.equal(m.cacheRead, 507_776);
});

test('tokensModel totals input and output for the period and says what was not reported', () => {
  const model = tokensModel(rollups, { period: '7d', now: NOW });
  // input = uncached + cache read + cache write; output = output + reasoning
  assert.deepEqual(model.totals, {
    input: 1_000 + 9_000 + 2_000 + 100 + 50_000 + 4_000,
    uncached: 3_100, cacheRead: 59_000, cacheWrite: 4_000,
    output: 500 + 100 + 1_000 + 2_000, reasoning: 100,
    total: 10_600 + 3_000 + 56_100,
  });
  assert.deepEqual(model.attempts, { total: 5, reported: 3, estimated: 1, none: 1, unsplit: 0 });
});

test('tokensModel buckets per day and ranks tokens by pool, model and project with shares', () => {
  const model = tokensModel(rollups, { period: '7d', now: NOW });
  assert.equal(model.bucketBy, 'day');
  assert.equal(model.buckets.length, 7);
  const day27 = model.buckets.find((bucket) => bucket.key === '2026-11-27');
  const day26 = model.buckets.find((bucket) => bucket.key === '2026-11-26');
  assert.deepEqual([day27.input, day27.output], [10_000 + 54_100, 600 + 2_000]);
  assert.deepEqual([day26.input, day26.output], [2_000, 1_000]);
  assert.deepEqual(model.byPool.map((row) => row.name), ['claude-code:w', 'cf:deepseek', 'cf:glm']);
  assert.equal(model.byPool[0].total, 56_100);
  assert.ok(Math.abs(model.byPool[0].share - 56_100 / 69_700) < 1e-9);
  assert.deepEqual(model.byProject.map((row) => [row.name, row.total]), [['gym', 56_100], ['kipwise', 13_600]]);
  assert.deepEqual(model.byModel.map((row) => row.name), ['claude-sonnet-5-5', 'cf/deepseek-v4.1-flash', 'cf/glm-5.3']);
});

test('an index record from before the split counts in the total as not split', () => {
  const older = [run('kipwise', [metric({ standardRead: undefined, output: undefined, tokens: 5_000, cacheRead: 4_000 })])];
  const model = tokensModel(older, { period: '7d', now: NOW });
  assert.equal(model.totals.total, 5_000);
  assert.equal(model.attempts.unsplit, 1);
  assert.equal(model.buckets.find((bucket) => bucket.key === '2026-11-27').unsplit, 5_000);
});

test('Stats has Spending, Tokens, Model and Project; Pool is gone', () => {
  assert.deepEqual(STATS_TABS, ['spending', 'tokens', 'model', 'project']);
  assert.deepEqual(VIEW_TABS, ['spending', 'tokens', 'model', 'project']);
});

test('the Tokens tab shows input and output totals, the chart, and the three tables', () => {
  const stats = { tokens: tokensModel(rollups, { period: '7d', now: NOW }) };
  const view = statsLines(stats, { width: 140, height: 40, tab: 'tokens', period: '7d', ansi: false });
  const text = view.lines.join('\n');
  assert.match(text, /^Tokens · 7d · 30d · all/m);
  assert.match(text, /Input 66\.1K/);
  assert.match(text, /Output 3\.6K/);
  assert.match(text, /3 of 5 attempts reported tokens · 1 estimated \(not counted\) · 1 not reported/);
  assert.match(text, /Tokens per day/);
  assert.match(text, /Tokens by pool/);
  assert.match(text, /Tokens by model/);
  assert.match(text, /Tokens by project/);
  // Stats panels print a pool by its short label (claude-code:w -> w).
  assert.match(text, /\bw\s+56\.1K\s+80\.5%/);
});

test('Spending has no By Pool / By Model switch any more', () => {
  const view = statsLines({}, { width: 140, height: 40, tab: 'spending', period: '7d', ansi: false });
  const text = view.lines.join('\n');
  assert.doesNotMatch(text, /By Model/);
  assert.doesNotMatch(text, /\[By Pool\]/);
});
