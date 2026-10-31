import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const action = { id: 'do-work', lane: 'build', effort: 'low' };
const paths = { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' };
const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };
const crash = { ok: false, failureKind: 'process', why: 'worker exited 1', meta: { exitCode: 1, wallSec: 1 } };
const notInPlan = (model) => ({
  ok: false, failureKind: 'model-not-in-plan', planModel: model, why: `model ${model} not in plan`, meta: { exitCode: 1, wallSec: 0.2 },
});
const FAMILIES = [
  { family: 'opus', match: '^claude-opus-[0-9]', tier: 'high', qualityRank: 5 },
  { family: 'sonnet', match: '^claude-sonnet-[0-9]', tier: 'medium', qualityRank: 4 },
  { family: 'haiku', match: '^claude-haiku-[0-9]', tier: 'low', qualityRank: 3 },
];
const pool = (name, model, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, modelFamilies: FAMILIES,
  strategyAssignments: { low: { pool: name, model } }, ...extra,
});

// A real throwaway git repo and a readable reply-only stream per attempt, so a
// refusal at start can be proved to have done no work (changedFiles empty,
// stream with no tool call); only a good verdict changes a file.
async function dispatch(verdicts, pools, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bs-failover-tiers-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  try {
    return await dispatchV2Action({
      action, taskText: 'do it', targetDir: repo,
      paths: (ordinal) => ({ taskFile: join(root, `task-${ordinal}.md`), outFile: join(root, `out-${ordinal}.md`) }),
      pools, bullswarmDir: join(root, 'bs'), ...opts,
      dependencies: {
        watchOnce: async (_connector, _task, _dir, files) => {
          const verdict = verdicts[index++];
          const streamFile = files.outFile.replace(/\.md$/, '.stream.jsonl');
          writeFileSync(streamFile, `${JSON.stringify({ seq: 1, source: 'stdout', providerType: 'result', kind: 'response', status: 'failed', summary: verdict.why })}\n`);
          if (verdict.ok) writeFileSync(join(repo, 'owned.txt'), `done ${index}\n`);
          return { ...verdict, meta: { ...verdict.meta, streamFile } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: (() => { let value = Date.parse('2026-08-31T01:00:00Z'); return () => (value += 1000); })(),
        uuid: () => 'session-fixed',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const pickedPools = (result) => result.attempts.map((attempt) => attempt.pool);

test('retry after an opus crash does not run opus on a pool whose plan excludes opus', async () => {
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('a', 'claude-sonnet-5'),
    pool('b', 'claude-opus-5-5', { strategyExcludedModels: ['claude-opus-5-5'], pace: 50 }),
    pool('c', 'claude-haiku-5'),
  ];
  const result = await dispatch([crash, good], pools, { preferredPool: 'p0' });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].model, 'claude-opus-5-5');
  const retry = result.attempts[1];
  assert.ok(!(retry.pool === 'b' && retry.model === 'claude-opus-5-5'), `retry ran ${retry.model} on ${retry.pool}`);
  assert.deepEqual([retry.pool, retry.model], ['a', 'claude-sonnet-5'], 'preparePools drops b before the tiers see it');
});

test('retry lands on the family pool when the same-model pools are spent', async () => {
  const spent = { fiveHourUsedPct: 100 };
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('o1', 'claude-opus-5-5', spent),
    pool('o2', 'claude-opus-5-5', spent),
    pool('fam', 'claude-opus-5'),
    pool('other', 'claude-sonnet-5', { pace: 80 }),
  ];
  const result = await dispatch([crash, good], pools, { preferredPool: 'p0' });
  assert.equal(result.ok, true);
  assert.deepEqual(pickedPools(result), ['p0', 'fam']);
  assert.match(result.attempts[1].routeWhy, /the same model family as the failed attempt/);
});

test('every tier spent (5-hour window full): the retry falls back to the whole list instead of failing the step', async () => {
  const spent = { fiveHourUsedPct: 100 };
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('o1', 'claude-opus-5-5', spent),
    pool('fam', 'claude-opus-5', spent),
    pool('other', 'claude-sonnet-5'),
  ];
  const result = await dispatch([crash, good], pools, { preferredPool: 'p0' });
  assert.equal(result.ok, true);
  assert.deepEqual(pickedPools(result), ['p0', 'other']);
  assert.doesNotMatch(result.attempts[1].routeWhy, /retry kept to/);
});

test('a refusal at start (model-not-in-plan) is not re-picked onto a pool that excludes that model', async () => {
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('x', 'claude-opus-5-5', { strategyExcludedModels: ['claude-opus-5-5'], pace: 60 }),
    pool('y', 'claude-sonnet-5'),
  ];
  const result = await dispatch([notInPlan('claude-opus-5-5'), good], pools, { preferredPool: 'p0' });
  assert.equal(result.attempts.length, 2);
  const next = result.attempts[1];
  assert.ok(!(next.model === 'claude-opus-5-5'), `re-pick ran ${next.model} on ${next.pool}`);
  assert.notEqual(next.pool, 'p0');
});

test('a refusal at start does not use the step\'s one retry: a later crash still gets one more attempt', async () => {
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('y', 'claude-sonnet-5', { pace: 60 }),
    pool('z', 'claude-haiku-5'),
  ];
  const result = await dispatch([notInPlan('claude-opus-5-5'), crash, good], pools, { preferredPool: 'p0' });
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 3, 'refusal re-pick, then the crash, then the retry');
  assert.equal(pickedPools(result)[0], 'p0');
  assert.ok(result.attempts.slice(1).every((attempt) => attempt.model !== 'claude-opus-5-5' || attempt.pool !== 'p0'));
  assert.equal(result.attempts[0].refusedAtStart, true, 'the first attempt is recorded as a refusal at start');
  assert.match(result.attempts[1].routeWhy ?? '', /refused at start/);
});

test('retry prefers a healthy same-model pool over a family pool and a better-paced other pool', async () => {
  const pools = [
    pool('p0', 'claude-opus-5-5'),
    pool('same', 'claude-opus-5-5'),
    pool('fam', 'claude-opus-5', { pace: 90 }),
    pool('other', 'claude-sonnet-5', { pace: 90 }),
  ];
  const result = await dispatch([crash, good], pools, { preferredPool: 'p0' });
  assert.equal(result.ok, true);
  assert.deepEqual(pickedPools(result), ['p0', 'same']);
  assert.equal(result.attempts[1].model, 'claude-opus-5-5');
});
