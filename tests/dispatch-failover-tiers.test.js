import { test } from 'node:test';
import assert from 'node:assert/strict';
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

async function dispatch(verdicts, pools, opts = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths, pools, bullswarmDir: '/tmp/bs', ...opts,
    dependencies: {
      watchOnce: async () => verdicts[index++],
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-08-31T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => 'session-fixed',
    },
  });
  return result;
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

test('retry lands on the family pool when the same-model pools are refused by the router', async () => {
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

test('today: every tier refused by the router falls back to the whole list', async () => {
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
