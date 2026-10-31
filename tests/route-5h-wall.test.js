// A pool whose 5h meter reads 99% or more is not dispatched to (FIVE_HOUR_WALL_PCT).
// Evidence: 12 of 12 dispatches picked at 99% failed; 4 of 10 at 95-98%.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool, isExhausted } from '../src/lib/route.js';
import { FIVE_HOUR_WALL_PCT, windowSpent } from '../src/meters/framework.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const RESET = '2026-10-31T14:30:00.000Z';
const lanes = ['analyze', 'build', 'chore'];
const routePool = (name, fiveHourUsedPct, extra = {}) => ({
  name, costRank: 4, lanes, pacingWindow: 'weekly', usedPct: 20, elapsedPct: 50, pace: 30,
  paceResetsAt: '2026-11-03T00:00:00Z', fiveHourUsedPct, fiveHourResetsAt: RESET, ...extra,
});

test('the wall is 99', () => {
  assert.equal(FIVE_HOUR_WALL_PCT, 99);
});

test('router: a pool at 99% is skipped when another eligible pool exists', () => {
  const route = pickPool('build', [routePool('wall', 99, { pace: 60 }), routePool('open', 10, { pace: 5 })], { now: NOW });
  assert.equal(route.pick.pool, 'open');
  assert.equal(route.candidates.some((c) => c.pool === 'wall'), false);
});

test('router: a pool at 99% as the only pool gives no pick', () => {
  const route = pickPool('build', [routePool('wall', 99)], { now: NOW });
  assert.equal(route.pick, null);
  assert.equal(isExhausted(routePool('wall', 99), NOW), true);
});

test('router: 98%, unknown and a passed reset behave as today', () => {
  const at98 = pickPool('build', [routePool('hot', 98, { pace: 60 }), routePool('open', 10, { pace: 5 })], { now: NOW });
  assert.equal(at98.pick.pool, 'open', 'ranked last');
  assert.equal(at98.candidates.some((c) => c.pool === 'hot'), true, 'still eligible');
  assert.equal(pickPool('build', [routePool('hot', 98)], { now: NOW }).pick.pool, 'hot');
  assert.equal(pickPool('build', [routePool('blind', null)], { now: NOW }).pick.pool, 'blind');
  const over = routePool('old', 99, { fiveHourResetsAt: '2026-10-31T11:00:00Z' });
  assert.equal(windowSpent(over, NOW), null, 'a reading whose reset has passed is over');
  assert.equal(pickPool('build', [over], { now: NOW }).pick.pool, 'old');
});

// ---- dispatch ----------------------------------------------------------

const action = { id: 'do-work', lane: 'build', effort: 'low' };
const connector = (name, extra = {}) => ({
  name, lanes, enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
  ...extra,
});
const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };

async function dispatch(pools, extra = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let t = Date.parse('2026-10-31T12:00:00Z');
  const started = [];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths: { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' },
    pools, bullswarmDir: '/tmp/bs', ...extra,
    dependencies: {
      watchOnce: async (c) => { started.push(c.name); return good; },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => (t += 1),
      sleep: async () => {},
      uuid: () => 'session-fixed',
    },
  });
  return { result, started };
}

test('dispatch: the only pool at 99% does not start and comes back at the 5h reset', async () => {
  const { result, started } = await dispatch([connector('luna-1', { fiveHourUsedPct: 99, fiveHourResetsAt: RESET })]);
  assert.deepEqual(started, []);
  assert.equal(result.attempts.length, 0);
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.retryAfter, RESET);
  assert.match(result.verdict.why, /luna-1 5h at 99%: not dispatched/);
  assert.match(result.verdict.why, new RegExp(`until ${RESET}`));
});

test('dispatch: the same pool pinned with the strict pool does not start either', async () => {
  const { result, started } = await dispatch(
    [connector('luna-1', { fiveHourUsedPct: 99, fiveHourResetsAt: RESET }), connector('luna-2')],
    { strictPool: 'luna-1' },
  );
  assert.deepEqual(started, []);
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.retryAfter, RESET);
  assert.match(result.verdict.why, /luna-1 5h at 99%: not dispatched/);
});

test('dispatch: a pool at 99% is skipped for another eligible pool', async () => {
  const { started } = await dispatch([connector('luna-1', { fiveHourUsedPct: 99, fiveHourResetsAt: RESET }), connector('luna-2')]);
  assert.deepEqual(started, ['luna-2']);
});

test('dispatch: a pool at 98% or with an unknown reading is still dispatched', async () => {
  assert.deepEqual((await dispatch([connector('luna-1', { fiveHourUsedPct: 98, fiveHourResetsAt: RESET })])).started, ['luna-1']);
  assert.deepEqual((await dispatch([connector('luna-1')])).started, ['luna-1']);
});
