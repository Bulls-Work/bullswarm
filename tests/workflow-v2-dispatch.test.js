import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyV2DispatchFailure, dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const action = { id: 'do-work', lane: 'build', effort: 'low' };
const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
  ...extra,
});

function harness(verdicts) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  return {
    dependencies: {
      watchOnce: async (_connector, _task, _dir, paths, opts) => {
        const item = verdicts[index++];
        return typeof item === 'function' ? item({ paths, opts }) : item;
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-08-31T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => 'session-fixed',
    },
    core,
  };
}

const paths = { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' };
const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };

test('failure classification does not invent a process crash when exit metadata is absent', () => {
  assert.equal(classifyV2DispatchFailure({ ok: false, why: 'content rejected' }), 'semantic');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'schema' }), 'schema');
  assert.equal(classifyV2DispatchFailure({ ok: false, meta: { exitCode: 2 } }), 'process');
});

test('auth failure quarantines and immediately replaces the pool', async () => {
  const h = harness([{ ok: false, why: 'quota', quarantineHint: true, meta: { exitCode: 1 } }, good]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[1].wallSec, 1);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-2']);
  assert.ok(h.core.pools['luna-1'].quarantine);
  assert.equal(h.core.decisionLog.length, 2);
});

test('semantic rejection is observed once and never retried', async () => {
  const h = harness([{ ok: false, why: 'content lacks evidence', meta: { exitCode: 0 } }, good]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.failureKind, 'semantic');
  assert.equal(result.attempts.length, 1);
});

test('schema correction is bounded and resumes one physical planner session', async () => {
  const seen = [];
  const pool = connector('luna-1', { conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] } });
  const h = harness([
    ({ opts }) => { seen.push(opts.conversation); return { ok: false, why: 'invalid', failureKind: 'schema', structured: { errors: ['bad'] }, meta: { exitCode: 0 } }; },
    ({ opts }) => { seen.push(opts.conversation); return good; },
  ]);
  const result = await dispatchV2Action({ action, taskText: 'plan', targetDir: '/tmp', paths, pools: [pool], bullswarmDir: '/tmp/bs', outputValidator: () => ({ ok: true }), correctionTask: () => 'correct it', currentSession: null, dependencies: h.dependencies });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ sessionId: 'session-fixed', resume: false }, { sessionId: 'session-fixed', resume: true }]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.session.sessionId, 'session-fixed');
});

test('independent evidence avoids ancestor pool when another is eligible', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({ action: { ...action, lane: 'analyze' }, taskText: 'inspect', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], avoidPools: ['luna-1'], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.attempts[0].pool, 'luna-2');
});

test('persisted effort assignment wins while its pool remains eligible', async () => {
  const h = harness([good]);
  const first = connector('luna-1');
  const assigned = connector('luna-2');
  first.strategyAssignments.low = { pool: 'luna-2', model: 'gpt-5.6-luna' };
  assigned.strategyAssignments.low = { pool: 'luna-2', model: 'gpt-5.6-luna' };
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [first, assigned], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.attempts[0].pool, 'luna-2');
});

test('burst-gated pools are not waited on or dispatched', async () => {
  const h = harness([]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1', { burstGate: true })], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.failureKind, 'unavailable');
  assert.equal(result.attempts.length, 0);
});
