import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { classifyV2DispatchFailure, dispatchV2Action, trackedDiffStatForTests } from '../src/workflow/v2-dispatch.js';
import { handoffBlock } from '../src/workflow/v2-runtime.js';
import { loadState, saveState } from '../src/lib/state.js';
import { listAssignments } from '../src/lib/assignments.js';
import {
  createV2GoalDocument, createV2DurableState, deserializeV2DurableState,
} from '../src/workflow/v2-state.js';

const action = { id: 'do-work', lane: 'build', effort: 'low' };
const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
  ...extra,
});

function harness(verdicts, coreOverrides = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [], ...coreOverrides };
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

test('a decision append never overwrites a state change made while the worker ran (D5)', async () => {
  // No loadState/saveState injection: this exercises the REAL locked
  // read-modify-write against a real state.json, which is where the
  // last-writer-wins bug lived.
  const home = mkdtempSync(join(tmpdir(), 'bs-v2-dispatch-state-'));
  try {
    saveState(home, {
      version: 1, config: { depthLimit: 2 },
      pools: { 'luna-1': { enabled: true }, beta: { enabled: true } },
      incumbents: {}, decisionLog: [],
    });
    const result = await dispatchV2Action({
      action, taskText: 'do it', targetDir: home, paths, pools: [connector('luna-1')],
      bullswarmDir: home,
      dependencies: {
        watchOnce: async () => {
          // The operator command, run while the worker is "in flight".
          const live = loadState(home);
          live.pools.beta.enabled = false;
          saveState(home, live);
          return good;
        },
      },
    });
    assert.equal(result.ok, true);
    const state = loadState(home);
    assert.equal(state.pools.beta.enabled, false, 'the concurrent write survived the append');
    assert.equal(state.decisionLog.length, 1, 'and the append itself landed');
    assert.equal(state.decisionLog[0].picked, 'luna-1');
    assert.equal(state.decisionLog[0].source, 'workflow-v2');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a quarantine written with a decision append lands on the live file, not a stale copy (D5)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-v2-dispatch-quarantine-'));
  try {
    saveState(home, {
      version: 1, config: { depthLimit: 2 },
      pools: { 'luna-1': { enabled: true }, beta: { enabled: true } },
      incumbents: { build: 'luna-1' }, decisionLog: [],
    });
    await dispatchV2Action({
      action, taskText: 'do it', targetDir: home, paths, pools: [connector('luna-1')],
      bullswarmDir: home,
      dependencies: {
        watchOnce: async () => {
          writeFileSync(join(home, 'marker'), 'worker ran');
          const live = loadState(home);
          live.pools.beta.enabled = false;
          saveState(home, live);
          return { ok: false, why: 'usage limit reached', failureKind: 'quota', quarantineHint: true, meta: { exitCode: 1 } };
        },
      },
    });
    assert.equal(readFileSync(join(home, 'marker'), 'utf8'), 'worker ran');
    const state = loadState(home);
    assert.equal(state.pools.beta.enabled, false, 'the concurrent write survived');
    assert.equal(state.pools['luna-1'].quarantine.kind, 'quota', 'the quarantine still landed');
    assert.equal(state.incumbents.build, undefined, 'and a quarantined pool loses incumbency');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('failure classification does not invent a process crash when exit metadata is absent', () => {
  assert.equal(classifyV2DispatchFailure({ ok: false, why: 'content rejected' }), 'semantic');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'schema' }), 'schema');
  assert.equal(classifyV2DispatchFailure({ ok: false, meta: { exitCode: 2 } }), 'process');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'provider' }), 'provider');
});

test('literal empty output from a free pool is a provider failure, not semantic work', () => {
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'empty output', meta: { exitCode: 1 } },
    { free: true },
  ), 'provider');
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'empty output', meta: { exitCode: 1 } },
    { free: false },
  ), 'process');
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'announcement without substance', meta: { exitCode: 0 } },
    { free: true },
  ), 'semantic');
});

test('a free pool derives its silence clock from the trusted rung median', async () => {
  let observedSilence = null;
  const h = harness([
    ({ opts }) => { observedSilence = opts.silenceTimeoutSec; return good; },
  ], {
    decisionLog: [
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 7 * 60, ts: '2026-08-31T00:10:00Z' },
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 8 * 60, ts: '2026-08-31T00:20:00Z' },
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 9 * 60, ts: '2026-08-31T00:30:00Z' },
    ],
  });
  const pool = connector('free-rung', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', tier: 'medium', free: true }],
    strategyAssignments: { low: { pool: 'free-rung', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [pool], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(observedSilence, 8 * 60);
});

test('the worker silence environment override still controls a free-pool probe', async () => {
  let observedSilence = null;
  const h = harness([
    ({ opts }) => { observedSilence = opts.silenceTimeoutSec; return good; },
  ]);
  const pool = connector('free-env', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', tier: 'medium', free: true }],
    strategyAssignments: { low: { pool: 'free-env', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [pool], bullswarmDir: '/tmp/bs', parentEnv: { BULLSWARM_WORKER_SILENCE_SEC: '7' },
    dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(observedSilence, 7);
});

test('a usage limit is classified quota, never process, semantic or auth', () => {
  // The real shape: non-zero exit AND a quarantine hint, both of which used to
  // win over the usage limit itself.
  assert.equal(classifyV2DispatchFailure({
    ok: false, failureKind: 'quota', quarantineHint: true, meta: { exitCode: 1 },
  }), 'quota');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'quota' }), 'quota');
  assert.equal(classifyV2DispatchFailure({ ok: false, quarantineHint: true }), 'auth');
});

test('auth failure quarantines and immediately replaces the pool', async () => {
  const h = harness([{ ok: false, why: 'quota', quarantineHint: true, meta: { exitCode: 1 } }, good]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].status, 'interrupted');
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

test('a free stall does not spend the mechanical retry and falls through to the next pool', async () => {
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([stalled, good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    }), connector('paid')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 0, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['free', 'paid']);
  assert.equal(result.attempts[0].willRetry, true);
  assert.match(result.attempts[1].routeWhy, /^fallback from free after stall 300s/);
});

test('a free empty-output provider failure also leaves the mechanical retry untouched', async () => {
  const h = harness([
    { ok: false, why: 'empty output', meta: { exitCode: 1, wallSec: 0.1 } },
    good,
  ]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    }), connector('paid')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 0, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['free', 'paid']);
  assert.equal(result.attempts[0].failureKind, 'provider');
  assert.equal(result.attempts[0].willRetry, true);
});

test('a metered stall still spends the mechanical retry allowance', async () => {
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([stalled, good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('metered')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['metered', 'metered']);
  assert.equal(result.attempts[0].willRetry, true);
});

test('a free stall still falls through after an earlier schema correction spends the retry budget', async () => {
  const schema = {
    ok: false, failureKind: 'schema', why: 'invalid evidence', structured: { errors: ['bad'] }, meta: { exitCode: 0 },
  };
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([schema, schema, stalled, good]);
  const free = connector('free', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', free: true }],
    strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('answerer'), free, connector('metered')],
    evidence: { writerPools: ['free', 'metered'] },
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1,
    correctionTask: () => 'correct it', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['answerer', 'answerer', 'free', 'metered']);
  assert.equal(result.attempts[2].willRetry, true);
});

test('willRetry is false when a free stall is the last eligible pool', async () => {
  const h = harness([{ ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null } }]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    })],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1, dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
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
  assert.equal(result.attempts[0].status, 'interrupted');
  assert.deepEqual(seen, [{ sessionId: 'session-fixed', resume: false }, { sessionId: 'session-fixed', resume: true }]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.session.sessionId, 'session-fixed');
});

test('a strict pool pin dispatches only to that pool while other pools are eligible', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action: { ...action, lane: 'analyze' },
    taskText: 'inspect',
    targetDir: '/tmp',
    paths,
    // unrelated-luna first and no preferredPool: only the strict pin can keep dispatch off it.
    pools: [connector('unrelated-luna'), connector('pinned-luna')],
    strictPool: 'pinned-luna',
    bullswarmDir: '/tmp/bs',
    dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'pinned-luna');
});

test('provider-qualified model pins cannot run under another credential pool label', async () => {
  const h = harness([good]);
  const primary = connector('relay', {
    profile: { providerId: 'a' },
    spawn: { cmd: ['fake', '--model', 'a/gpt-5.6-luna'] },
  });
  const second = connector('relay:b', {
    profile: { providerId: 'b' },
    spawn: { cmd: ['fake', '--model', 'b/gpt-5.6-luna'] },
  });
  const result = await dispatchV2Action({
    action: { ...action, lane: 'analyze' }, taskText: 'inspect', targetDir: '/tmp', paths,
    // relay:b first: with nothing pinning the model, dispatch would pick it.
    pools: [second, primary],
    preferredModel: 'a/gpt-5.6-luna', bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'relay');
  assert.equal(result.attempts[0].model, 'a/gpt-5.6-luna');
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

test('defensive analyze fallback is medium rather than silently escalating to high', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action: { id: 'inspect-work', lane: 'analyze' },
    taskText: 'inspect it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].routing.effort, 'medium');
});

test('workflow dispatch honors the interactive strategy model allow-list', async () => {
  const h = harness([good]);
  const blocked = connector('luna-1', {
    strategyAssignments: {}, strategyConfiguredTiers: ['low'], strategyModelTiers: {},
  });
  const selected = connector('luna-2', {
    strategyAssignments: {}, strategyConfiguredTiers: ['low'],
    strategyModelTiers: { 'luna-2': { 'gpt-5.6-luna': ['low'] } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [blocked, selected], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'luna-2');
  assert.equal(result.attempts[0].model, 'gpt-5.6-luna');
});

test('burst-gated pools are not waited on or dispatched', async () => {
  const h = harness([]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1', { burstGate: true })], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.failureKind, 'unavailable');
  assert.equal(result.attempts.length, 0);
});

// --- usage-limit recovery (requirement 1) --------------------------------

const QUOTA_RESET = Date.parse('2026-08-31T02:20:00Z');
const quotaVerdict = () => ({
  ok: false,
  failureKind: 'quota',
  quarantineHint: true,
  quarantineUntil: QUOTA_RESET,
  quarantineSource: 'message',
  why: `usage limit: "You've hit your session limit · resets 10:20am (Asia/Hong_Kong)" `
    + `· pool paused until ${new Date(QUOTA_RESET).toISOString()}`,
  meta: { exitCode: 1, wallSec: 0.2 },
});

test('a quota failure quarantines until the announced reset and replaces the pool', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1', { fiveHourUsedPct: 12 }), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-2']);
  assert.equal(result.attempts[0].failureKind, 'quota');
  assert.equal(result.attempts[0].status, 'interrupted');
  assert.equal(result.attempts[0].why, quotaVerdict().why);
  assert.equal(result.attempts[0].routing.fiveHourUsedPct, 12);
  assert.equal(result.attempts[1].routing.fiveHourUsedPct, null);

  const quarantine = h.core.pools['luna-1'].quarantine;
  assert.equal(quarantine.until, QUOTA_RESET, 'the announced reset, not a flat 10 minutes');
  assert.equal(quarantine.kind, 'quota');
  assert.equal(quarantine.reason, quotaVerdict().why);
  assert.equal(h.core.pools['luna-2']?.quarantine, undefined);
});

test('a quota failure on the only pool is never retried on that same pool', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, 'failed');
  assert.equal(h.core.pools['luna-1'].quarantine.until, QUOTA_RESET);
});

test('a quarantine in live core state excludes a pool whose launch-time object looks clean', async () => {
  const h = harness([good]);
  // Written by another action or another run after this dispatch got its list.
  h.core.pools['luna-1'] = {
    quarantine: { until: Date.parse('2026-08-31T03:00:00Z'), reason: 'usage limit', kind: 'quota' },
  };
  const pools = [connector('luna-1'), connector('luna-2')];
  assert.equal(pools[0].quarantine, undefined, 'the stale pool object carries no quarantine');
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths, pools,
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-2']);
});

test('an expired live quarantine does not exclude the pool', async () => {
  const h = harness([good]);
  h.core.pools['luna-1'] = {
    quarantine: { until: Date.parse('2026-08-31T00:30:00Z'), reason: 'usage limit', kind: 'quota' },
  };
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.attempts[0].pool, 'luna-1');
});

test('refreshPools runs before every pick, is forced after a quota failure, and drives the next pick', async () => {
  const h = harness([quotaVerdict(), good]);
  const calls = [];
  // luna-3 exists only in the refreshed list: picking it proves the live list
  // replaced the one captured at launch.
  const refreshed = [connector('luna-1'), connector('luna-3')];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    refreshPools: async (opts) => { calls.push(opts); return refreshed; },
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-3']);
});

test('a refresher that throws or returns nothing leaves the dispatch on its launch list', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')],
    refreshPools: async () => { throw new Error('meter reader exploded'); },
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'luna-1');

  const empty = harness([good]);
  const second = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')],
    refreshPools: async () => [],
    bullswarmDir: '/tmp/bs', dependencies: empty.dependencies,
  });
  assert.equal(second.attempts[0].pool, 'luna-1');
});

// --- reasoning ---------------------------------------------------------------
// One level is resolved PER ATTEMPT, from the connector actually picked, and it
// has to arrive in three places at once: the spawned watch options, the attempt
// record (which is what `attempt.started` carries), and the decision log.

const thinking = (name, reasoning, extra = {}) => connector(name, {
  reasoning: reasoning ?? {
    flag: '--effort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
  },
  ...extra,
});

async function dispatchWithReasoning({ pools, core = {}, ...rest } = {}) {
  const seen = [];
  const h = harness([({ opts }) => { seen.push(opts.reasoning); return good; }], core);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools, bullswarmDir: '/tmp/bs', dependencies: h.dependencies, ...rest,
  });
  return { result, seen, core: h.core };
}

test('an attempt resolves its reasoning level from the connector default for the effort tier', async () => {
  // action.effort is 'low', so the connector's low default is what runs.
  const { result, seen, core } = await dispatchWithReasoning({ pools: [thinking('luna-1')] });
  assert.equal(result.ok, true);
  const expected = { requested: 'medium', applied: 'medium', source: 'connector', clamped: false };
  assert.deepEqual(result.attempts[0].reasoning, expected);
  assert.deepEqual(seen, [expected], 'watchOnce must receive opts.reasoning');
  assert.deepEqual(core.decisionLog[0].reasoning, expected);
});

test('a strategy tier level in live core state outranks the connector default', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [thinking('luna-1')],
    core: { strategy: { reasoning: { tiers: { low: 'high' } } } },
  });
  const expected = { requested: 'high', applied: 'high', source: 'strategy-tier', clamped: false };
  assert.deepEqual(result.attempts[0].reasoning, expected);
  assert.deepEqual(seen, [expected]);
});

test('a strategy per-pool level outranks the strategy tier level', async () => {
  const { result } = await dispatchWithReasoning({
    pools: [thinking('luna-1')],
    core: { strategy: { reasoning: { tiers: { low: 'high' }, pools: { 'luna-1': { low: 'max' } } } } },
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'max', source: 'strategy-pool', clamped: false,
  });
});

test('runReasoning outranks strategy, and reasoningOverride outranks everything', async () => {
  const core = { strategy: { reasoning: { tiers: { low: 'high' }, pools: { 'luna-1': { low: 'max' } } } } };
  const run = await dispatchWithReasoning({ pools: [thinking('luna-1')], core, runReasoning: 'low' });
  assert.deepEqual(run.result.attempts[0].reasoning, {
    requested: 'low', applied: 'low', source: 'run', clamped: false,
  });
  const override = await dispatchWithReasoning({
    pools: [thinking('luna-1')], core, runReasoning: 'low', reasoningOverride: 'xhigh',
  });
  assert.deepEqual(override.result.attempts[0].reasoning, {
    requested: 'xhigh', applied: 'xhigh', source: 'action', clamped: false,
  });
  assert.deepEqual(override.seen, [{
    requested: 'xhigh', applied: 'xhigh', source: 'action', clamped: false,
  }]);
});

test('a program action carrying its own reasoning field is honored as the action override', async () => {
  const seen = [];
  const h = harness([({ opts }) => { seen.push(opts.reasoning); return good; }]);
  const result = await dispatchV2Action({
    action: { ...action, reasoning: 'max' }, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [thinking('luna-1')], runReasoning: 'low',
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'max', source: 'action', clamped: false,
  });
  assert.deepEqual(seen[0], result.attempts[0].reasoning);
});

test('a request the picked connector cannot express is clamped on the record it ran under', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [thinking('luna-1', {
      args: ['-c', 'model_reasoning_effort={level}'],
      levels: ['low', 'medium', 'high'],
      defaults: { high: 'high', medium: 'medium', low: 'low' },
    })],
    runReasoning: 'max',
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'high', source: 'run', clamped: true,
  });
  assert.deepEqual(seen, [{ requested: 'max', applied: 'high', source: 'run', clamped: true }]);
});

test('a connector without reasoning records unsupported instead of a level it never sent', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [connector('luna-1')], runReasoning: 'max',
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: null, source: 'unsupported', clamped: false,
  });
  assert.deepEqual(seen, [{ requested: 'max', applied: null, source: 'unsupported', clamped: false }]);
});

test('a model the connector marks as skipped records skipped-model', async () => {
  const { result } = await dispatchWithReasoning({
    pools: [thinking('luna-1', {
      flag: '--effort',
      levels: ['low', 'medium', 'high'],
      defaults: { low: 'medium' },
      skipModels: ['^gpt-5\\.6-luna$'],
    })],
  });
  // The strategy assignment pins gpt-5.6-luna as this pool's model.
  assert.equal(result.attempts[0].model, 'gpt-5.6-luna');
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'medium', applied: null, source: 'skipped-model', clamped: false,
  });
});

test('each attempt of one action resolves against the connector it actually landed on', async () => {
  const seen = [];
  const h = harness([
    ({ opts }) => { seen.push(opts.reasoning); return { ok: false, why: 'auth', quarantineHint: true, meta: { exitCode: 1 } }; },
    ({ opts }) => { seen.push(opts.reasoning); return good; },
  ]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    // luna-1 accepts the full scale; luna-2 tops out at high.
    pools: [
      thinking('luna-1'),
      thinking('luna-2', { flag: '--effort', levels: ['low', 'medium', 'high'], defaults: { low: 'low' } }),
    ],
    runReasoning: 'xhigh',
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.reasoning), [
    { requested: 'xhigh', applied: 'xhigh', source: 'run', clamped: false },
    { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
  ]);
  assert.deepEqual(seen, result.attempts.map((attempt) => attempt.reasoning));
  assert.deepEqual(h.core.decisionLog.map((entry) => entry.reasoning), result.attempts.map((a) => a.reasoning));
});

test('the attempt.started notification carries the resolved reasoning record', async () => {
  const started = [];
  const h = harness([good]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [thinking('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
    onAttempt: (phase, record) => { if (phase === 'started') started.push(record.reasoning); },
  });
  assert.deepEqual(started, [{ requested: 'medium', applied: 'medium', source: 'connector', clamped: false }]);
});

// --- routed-why provenance on the durable attempt record --------------------

test('every dispatched attempt records the router reason and candidate table', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.ok(result.attempts[0].routeWhy, 'routeWhy is the router reason string');
  assert.ok(Array.isArray(result.attempts[0].routeCandidates));
  assert.ok(result.attempts[0].routeCandidates.length >= 1);
  for (const attempt of result.attempts) {
    assert.equal(typeof attempt.routeWhy, 'string');
    for (const candidate of attempt.routeCandidates) {
      assert.equal(typeof candidate.pool, 'string');
      assert.ok('effectiveSurplus' in candidate, 'effectiveSurplus present, null preserved');
      assert.ok('urgencyState' in candidate, 'urgencyState present, null preserved');
      assert.ok('forecastPacingPct' in candidate, 'forecastPacingPct present, null preserved');
    }
    assert.ok(
      attempt.routeCandidates.some((candidate) => candidate.pool === attempt.pool),
      'the picked pool appears among the candidates',
    );
  }
  // The routed pool sits in candidate position zero when it is the best pick.
  assert.equal(result.attempts[0].routeCandidates[0].pool, result.attempts[0].pool);
});

test('a state file whose attempts lack the routing fields still loads', () => {
  const goal = createV2GoalDocument({
    goal: 'Old run without route provenance', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Do the thing' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-old', shortId: 'old123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: [], ownedFiles: [],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 1, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  // An attempt recorded before routeWhy/routeCandidates existed: no fields at all.
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'succeeded',
    pool: 'luna-1', model: 'gpt-5.6-luna', startedAt: '2026-08-31T01:00:00.000Z',
    finishedAt: '2026-08-31T01:01:00.000Z',
  }];
  assert.doesNotThrow(() => deserializeV2DurableState(JSON.stringify(state)));
});

test('the attempt.started notification carries the router reason and candidates', async () => {
  const started = [];
  const h = harness([good]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
    onAttempt: (phase, record) => { if (phase === 'started') started.push(record); },
  });
  assert.equal(typeof started[0].routeWhy, 'string');
  assert.ok(Array.isArray(started[0].routeCandidates));
});

// --- one dead upstream credential, three pool names -------------------------
// 2026-09-11: the OAuth pool behind a relaying reseller was invalidated at
// 12:24 UTC. Its three pools were three names for it, and the retry of a failed
// action walked from one sibling to the next, burning both attempts on the
// same dead credential and blocking every dependent action.

const RELAY_GROUP = 'relay:relay.example';
const relayPool = (name) => connector(name, { credentialGroup: RELAY_GROUP });
const upstreamAuthVerdict = () => ({
  ok: false,
  failureKind: 'auth',
  quarantineHint: true,
  why: 'upstream auth failure: "auth_unavailable" (provider stream error)',
  meta: { exitCode: 1, providerFailureType: 'error', wallSec: 0.9 },
});
const HARNESS_T0 = Date.parse('2026-08-31T01:00:00Z');

test('an upstream auth failure benches every pool on that credential and the retry leaves the group', async () => {
  const h = harness([upstreamAuthVerdict(), good]);
  const pools = [
    relayPool('relay:c'), relayPool('relay:b'), relayPool('relay'),
    connector('command-code'),
  ];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths, pools,
    // The refresher hands back the SAME, still-unquarantined pool objects: the
    // group has to stay out of service on the strength of live state alone.
    refreshPools: async () => pools,
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c', 'command-code']);
  const quarantine = (name) => h.core.pools[name]?.quarantine;
  for (const name of ['relay:c', 'relay:b', 'relay']) {
    assert.ok(quarantine(name), `${name} is benched`);
    assert.equal(quarantine(name).kind, 'auth');
  }
  // One upstream, one deadline — the siblings do not open a second window.
  assert.equal(quarantine('relay:b').until, quarantine('relay:c').until);
  assert.equal(quarantine('relay').until, quarantine('relay:c').until);
  const ahead = quarantine('relay:c').until - HARNESS_T0;
  assert.ok(ahead > 600_000 && ahead <= 630_000, `re-probe window is ${ahead}ms after t0`);
  assert.equal(
    quarantine('relay:b').reason,
    'sibling of relay:c: upstream auth failure: "auth_unavailable" (provider stream error)',
  );
  assert.equal(quarantine('command-code'), undefined, 'a pool on its own credential keeps working');
});

test('a group sibling is unreachable for the next attempt even without a refresher', async () => {
  // Two attempts, both auth: with the group benched there is nowhere left to
  // go, and the action must fail instead of burning the second attempt on
  // another name for the same credential.
  const h = harness([upstreamAuthVerdict(), upstreamAuthVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [relayPool('relay:c'), relayPool('relay:b'), relayPool('relay')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'auth');
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c']);
  assert.equal(result.attempts[0].status, 'failed', 'no recovery was promised that the group could not deliver');
});

test('a usage limit benches only the pool that hit it, never its upstream siblings', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [relayPool('relay:c'), relayPool('relay:b'), relayPool('relay')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c', 'relay:b']);
  assert.equal(h.core.pools['relay:c'].quarantine.kind, 'quota');
  assert.equal(h.core.pools['relay:b']?.quarantine, undefined, 'a sibling window is its own');
  assert.equal(h.core.pools.relay?.quarantine, undefined);
});

test('an auth failure on a pool with no upstream group benches nothing else', async () => {
  const h = harness([upstreamAuthVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('claude-code:alt'), connector('claude-code')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.ok(h.core.pools['claude-code:alt'].quarantine);
  assert.equal(h.core.pools['claude-code']?.quarantine, undefined, 'a separate seat is a separate credential');
});

test('a free stall keeps partial output, falls back, releases the ledger, and benches on the second strike', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-free-stall-dispatch-'));
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  const fixturePool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  const staller = fixturePool('staller', stallerWorker, 'zen/union-free', { free: true });
  const answerer = fixturePool('answerer', answererWorker, 'paid/answerer');
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  const pathsFor = (prefix) => (ordinal) => ({
    taskFile: join(home, `${prefix}-task-${ordinal}.md`),
    outFile: join(home, `${prefix}-out-${ordinal}.md`),
  });
  const runOnce = (prefix) => dispatchV2Action({
    action: { id: `stall-fallback-${prefix}`, lane: 'build', effort: 'low' },
    taskText: 'perform the bounded fixture dispatch',
    targetDir: home,
    paths: pathsFor(prefix),
    pools: [staller, answerer],
    bullswarmDir: home,
    silenceTimeoutSec: 2,
    maxMechanicalRetries: 1,
  });
  try {
    const first = await runOnce('first');
    assert.equal(first.ok, true);
    assert.deepEqual(first.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    assert.equal(first.attempts[0].failureKind, 'stalled');
    assert.equal(first.attempts[0].stalled, true);
    assert.equal(first.attempts[0].silentSec, 2);
    assert.equal(first.attempts[0].routeWhy.startsWith('fallback from'), false);
    assert.ok(existsSync(first.attempts[0].partialOutput));
    assert.match(readFileSync(first.attempts[0].partialOutput, 'utf8'), /## Partial/);
    assert.match(first.attempts[1].routeWhy, /^fallback from staller after stall 2s · /);
    assert.deepEqual(listAssignments(home), []);
    assert.equal(loadState(home).pools.staller.bench.count, 1);
    assert.equal(loadState(home).pools.staller.bench.until, null);

    const second = await runOnce('second');
    assert.equal(second.ok, true);
    assert.deepEqual(second.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    assert.equal(second.attempts[0].failureKind, 'stalled');
    const bench = loadState(home).pools.staller.bench;
    assert.equal(bench.reason, 'stall');
    assert.equal(bench.count, 2);
    assert.ok(Number.isFinite(bench.until) && bench.until > Date.now());
    assert.deepEqual(listAssignments(home), []);

    const third = await runOnce('third');
    assert.equal(third.ok, true);
    assert.deepEqual(third.attempts.map((attempt) => attempt.pool), ['answerer']);
    assert.match(third.attempts[0].routeWhy, /benched \(stall, back at /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stalled attempt survives the durable-state validator with its partial output', () => {
  const goal = createV2GoalDocument({
    goal: 'Free pool stalls', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Do the thing' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-stall', shortId: 'stl123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: [], ownedFiles: [],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 2, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  // The attempt the free pool stalled on, exactly as normalizeAttempt writes it:
  // `stalled`, the partial file kept on disk, and the threshold that ended it.
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'interrupted',
    pool: 'staller', model: 'zen/union-free', startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z', failureKind: 'stalled',
    why: 'stalled: the worker wrote nothing for 8 s and was stopped',
    stalled: true, partialOutput: '/tmp/out-do-work-attempt-1.md', silentSec: 8,
  }, {
    id: 'do-work-2', actionId: 'do-work', ordinal: 2, status: 'succeeded',
    pool: 'answerer', model: 'paid/answerer', startedAt: '2026-09-17T02:30:29.000Z',
    finishedAt: '2026-09-17T02:30:30.000Z',
  }];
  const loaded = deserializeV2DurableState(JSON.stringify(state));
  assert.equal(loaded.attempts[0].stalled, true);
  assert.equal(loaded.attempts[0].partialOutput, '/tmp/out-do-work-attempt-1.md');
  assert.equal(loaded.attempts[0].silentSec, 8);
  // An attempt recorded before the stall clock existed carries none of them.
  assert.equal(loaded.attempts[1].stalled, undefined);
});

test('the tracked diff stat keeps every row exactly as git printed it, leading space included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-diffstat-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    writeFileSync(join(dir, 'doomed.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, 'owned.txt'), 'one\n');
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'seed');
    writeFileSync(join(dir, 'doomed.txt'), 'one\n');
    writeFileSync(join(dir, 'owned.txt'), 'one\ntwo\n');
    const stat = trackedDiffStatForTests(dir, ['doomed.txt', 'owned.txt'], execFileSync);
    const rows = stat.split('\n');
    assert.equal(rows.length, 3, stat);
    // git indents every file row and the summary row by one space; the first
    // row used to lose it to a .trim() and sit misaligned against the rest.
    for (const row of rows) assert.match(row, /^ /, JSON.stringify(row));
    assert.match(rows[0], /^ doomed\.txt\s+\|\s+1 -$/);
    assert.match(rows[1], /^ owned\.txt\s+\|\s+1 \+$/);
    assert.match(rows[2], /^ 2 files changed, 1 insertion\(\+\), 1 deletion\(-\)$/);
    assert.doesNotMatch(stat, /\n$/, 'no trailing newline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoffBlock is a pure template over on-disk facts', () => {
  const block = handoffBlock({
    pool: 'staller',
    model: 'zen/union-free',
    startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'stalled',
    why: 'stalled: the worker wrote nothing for 8 s and was stopped',
    diffStatText: ' owned.txt | 1 +\n 1 file changed, 1 insertion(+)',
    diffFile: '/tmp/run/diff-do-work-attempt-1.txt',
    changedFiles: ['owned.txt'],
    outputFile: '/tmp/run/out-do-work-attempt-1.md',
    outputBytes: 88,
    streamFile: null,
    lastEvents: [
      { at: '2026-09-17T02:30:21.000Z', kind: 'response', summary: 'reading owned.txt' },
      { at: '2026-09-17T02:30:22.000Z', kind: 'response', summary: 'editing owned.txt' },
      { at: '2026-09-17T02:30:23.000Z', kind: 'response', summary: 'going quiet' },
    ],
  });
  assert.match(block, /^## Prior attempt on this step\n/);
  assert.match(block, /^- Pool: staller$/m);
  assert.match(block, /^- Model: zen\/union-free$/m);
  assert.match(block, /^- Duration: 8s$/m);
  assert.match(block, /^- Failure: stalled — stalled: the worker wrote nothing for 8 s and was stopped$/m);
  assert.match(block, /owned\.txt/);
  assert.match(block, /out-do-work-attempt-1\.md \(88 bytes\)/);
  assert.match(block, /Stream file: no stream recorded/);
  assert.match(block, /2026-09-17T02:30:23\.000Z: going quiet/);
  assert.match(block, /Those edits are unverified\. You decide whether to keep, fix or revert them, and you must report which\./);
  assert.doesNotMatch(block, /inlined stream/i);
});

test('handoffBlock identifies connector-default models without guessing a model name', () => {
  assert.match(handoffBlock({ pool: 'codex', model: null }), /^- Model: codex connector default$/m);
  assert.match(handoffBlock({ pool: 'claude-code:acme', model: null }), /^- Model: claude-code:acme connector default$/m);
  assert.match(handoffBlock({ pool: null, model: null }), /^- Model: unknown$/m);
});

test('handoffBlock says why no response events were decoded for a pool without an eventStream', () => {
  const block = handoffBlock({
    pool: 'plain-cli', model: null, startedAt: '2026-09-17T02:30:20.000Z', finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'provider', why: 'provider stream reported error', diffStatText: '', changedFiles: [],
    streamFile: '/tmp/run/stdout-do-work-attempt-1.log', hasEventStream: false, lastEvents: [],
  });
  assert.match(block, /^- Last response events: none decoded \(the plain-cli connector declares no eventStream; see the stream file\)$/m);
  // A pool that does declare one and simply said nothing gets no such line.
  const quiet = handoffBlock({ pool: 'codex', hasEventStream: true, lastEvents: [] });
  assert.doesNotMatch(quiet, /Last response events/);
});

test('a multi-line response stays one list item so it cannot break out of the block', () => {
  const block = handoffBlock({
    pool: 'staller',
    model: 'zen/union-free',
    startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'stalled',
    why: 'stalled',
    diffStatText: '',
    changedFiles: [],
    streamFile: '/tmp/run/stream-do-work-attempt-1.jsonl',
    lastEvents: [
      { at: '2026-09-17T02:30:23.000Z', kind: 'response', summary: '## Partial\n\nEnumerated 3 files\nbefore going quiet.' },
    ],
  });
  const lines = block.split('\n');
  const heading = lines.filter((line) => line.startsWith('## '));
  assert.deepEqual(heading, ['## Prior attempt on this step'], 'a response heading must not become a block heading');
  assert.ok(lines.includes('  - 2026-09-17T02:30:23.000Z: ## Partial Enumerated 3 files before going quiet.'));
  // The closing sentence is still the last line, not orphaned by a spill.
  assert.match(lines.at(-1), /^- Those edits are unverified\./);
});

test('schema correction keeps its own block and does not append the prior-attempt handoff', async () => {
  const tasks = [];
  const pool = connector('luna-1', { conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] } });
  const h = harness([
    () => ({ ok: false, why: 'invalid', failureKind: 'schema', structured: { errors: ['bad'] }, meta: { exitCode: 0 } }),
    good,
  ]);
  const inner = h.dependencies.watchOnce;
  h.dependencies.watchOnce = async (c, task, dir, paths, opts) => {
    tasks.push(task);
    return inner(c, task, dir, paths, opts);
  };
  const result = await dispatchV2Action({
    action, taskText: 'plan', targetDir: '/tmp', paths, pools: [pool],
    bullswarmDir: '/tmp/bs', outputValidator: () => ({ ok: true }),
    correctionTask: () => 'correct it', currentSession: null, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(tasks, ['plan', 'correct it']);
  assert.doesNotMatch(tasks[1], /## Prior attempt on this step/);
});

test('a mechanical fallback appends the prior-attempt handoff to the next task', async () => {
  const tasks = [];
  const h = harness([
    { ok: false, failureKind: 'provider', why: 'empty output', meta: { exitCode: 1 } },
    good,
  ]);
  const inner = h.dependencies.watchOnce;
  h.dependencies.watchOnce = async (c, task, dir, paths, opts) => {
    tasks.push(task);
    return inner(c, task, dir, paths, opts);
  };
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(tasks[0], 'do it');
  assert.match(tasks[1], /## Prior attempt on this step/);
  assert.match(tasks[1], /Pool: luna-1/);
  assert.match(tasks[1], /Failure: provider — empty output/);
  assert.match(tasks[1], /Stream file: no stream recorded/);
  assert.match(tasks[1], /Those edits are unverified/);
  assert.equal(result.attempts[1].handoff.from, 'do-work-1');
  assert.ok(result.attempts[1].handoff.bytes > 0);
  assert.equal(result.attempts[1].handoff.bytes, Buffer.byteLength(tasks[1].slice(tasks[1].indexOf('## Prior attempt on this step')), 'utf8'));
});

test('a free stall falls back with a frozen diff snapshot of the prior attempt', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-handoff-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  const fixturePool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  try {
    const result = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'perform the bounded fixture dispatch',
      targetDir: repo,
      paths: (ordinal) => ({
        taskFile: join(home, `task-do-work-attempt-${ordinal}.md`),
        outFile: join(home, `out-do-work-attempt-${ordinal}.md`),
      }),
      pools: [
        fixturePool('staller', stallerWorker, 'zen/union-free', { free: true }),
        fixturePool('answerer', answererWorker, 'paid/answerer'),
      ],
      bullswarmDir: home,
      silenceTimeoutSec: 2,
      maxMechanicalRetries: 1,
      onAttempt: (stage, record) => {
        if (stage === 'finished' && record.ordinal === 1) {
          writeFileSync(join(repo, 'owned.txt'), `${readFileSync(join(repo, 'owned.txt'), 'utf8')}SIBLING EDIT AFTER ATTEMPT END\n`);
          writeFileSync(join(repo, 'later.txt'), 'later sibling\n');
        }
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    const task2 = readFileSync(join(home, 'task-do-work-attempt-2.md'), 'utf8');
    assert.match(task2, /## Prior attempt on this step/);
    assert.match(task2, /Pool: staller/);
    assert.match(task2, /owned\.txt/);
    assert.match(task2, /out-do-work-attempt-1\.md/);
    assert.match(task2, /Those edits are unverified/);
    assert.doesNotMatch(task2, /SIBLING EDIT AFTER ATTEMPT END/);
    assert.doesNotMatch(task2, /later\.txt/);
    assert.doesNotMatch(task2, /Your prior final structured output failed/);
    const diff1 = readFileSync(join(home, 'diff-do-work-attempt-1.txt'), 'utf8');
    assert.match(diff1, /owned\.txt/);
    assert.doesNotMatch(diff1, /later\.txt/);
    assert.doesNotMatch(diff1, /SIBLING EDIT AFTER ATTEMPT END/);
    assert.equal(result.attempts[0].diffFile, join(home, 'diff-do-work-attempt-1.txt'));
    assert.ok(result.attempts[0].outputBytes > 0);
    assert.equal(result.attempts[0].outputFile, join(home, 'out-do-work-attempt-1.md'));
    assert.equal(result.attempts[1].handoff.from, 'do-work-1');
    assert.ok(result.attempts[1].handoff.bytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff attribution compares bytes, including new, pre-dirty, staged and deleted files, but not outside files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-diff-attribution-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const tracked = ['owned.txt', 'deleted.txt', 'outside.txt'];
  for (const file of tracked) writeFileSync(join(repo, file), `${file} base\n`);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'add', ...tracked]);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);

  // This is deliberately dirty before dispatch. The attempt must still be
  // credited for the bytes it adds, rather than subtracting the whole path.
  writeFileSync(join(repo, 'owned.txt'), 'owned.txt base\npre-dirty\n');
  const h = harness([
    ({ paths }) => {
      writeFileSync(join(repo, 'owned.txt'), 'owned.txt base\npre-dirty\nduring-attempt\n');
      // Staging must not hide the byte change from the snapshot.
      execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
      writeFileSync(join(repo, 'new-owned.txt'), 'line one\nline two\n');
      rmSync(join(repo, 'deleted.txt'));
      writeFileSync(join(repo, 'outside.txt'), 'outside changed\n');
      // The stub still returns a normal failed worker verdict; output paths
      // are irrelevant to this diff-only assertion.
      return { ok: false, failureKind: 'provider', why: 'empty output', meta: { exitCode: 1 } };
    },
    good,
  ]);
  try {
    const result = await dispatchV2Action({
      action: {
        id: 'diff-work', lane: 'build', effort: 'low',
        ownedFiles: ['owned.txt', 'new-owned.txt', 'deleted.txt'],
      },
      taskText: 'attribute the attempt',
      targetDir: repo,
      paths: {
        taskFile: join(home, 'task-diff-work.md'),
        outFile: join(home, 'out-diff-work.md'),
      },
      pools: [connector('luna-1'), connector('luna-2')],
      bullswarmDir: home,
      dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].changedFileCount, 3);
    const diff = readFileSync(result.attempts[0].diffFile, 'utf8');
    assert.match(diff, /owned\.txt/);
    assert.match(diff, /deleted\.txt/);
    assert.match(diff, /new-owned\.txt \| \+2 lines \(new\)/);
    assert.doesNotMatch(diff, /outside\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The two halves as one feature: the sink writes the per-attempt stream, the
// dispatcher records its path, and the handoff block's last-three responses are
// read back out of that same file rather than out of kernel memory.
test('the persisted stream feeds the handoff block on a real fixture fallback', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-handoff-stream-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  // The codex line shape, verbatim from the shipped manifest: the fixture
  // workers speak it under BULLSWARM_FIXTURE_EVENTS=jsonl.
  const eventStream = JSON.parse(readFileSync(
    new URL('../src/providers/codex/connector.json', import.meta.url), 'utf8',
  )).eventStream;
  const streamingPool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'event-stream' },
    eventStream: { ...eventStream, args: [] },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  try {
    const result = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'perform the bounded fixture dispatch',
      targetDir: repo,
      paths: (ordinal) => ({
        taskFile: join(home, `task-do-work-attempt-${ordinal}.md`),
        outFile: join(home, `out-do-work-attempt-${ordinal}.md`),
      }),
      pools: [
        streamingPool('staller', stallerWorker, 'zen/union-free', { free: true }),
        streamingPool('answerer', answererWorker, 'paid/answerer'),
      ],
      bullswarmDir: home,
      parentEnv: { ...process.env, BULLSWARM_FIXTURE_EVENTS: 'jsonl' },
      silenceTimeoutSec: 2,
      maxMechanicalRetries: 1,
    });
    assert.equal(result.ok, true);
    const streamFile = join(home, 'stream-do-work-attempt-1.jsonl');
    assert.equal(result.attempts[0].streamFile, streamFile, 'the dispatcher records the file the sink wrote');
    const rows = readFileSync(streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) {
      for (const key of ['seq', 'at', 'source', 'providerType', 'kind', 'status', 'summary']) {
        assert.ok(Object.hasOwn(row, key), `stream row missing ${key}`);
      }
      assert.match(row.at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    const responses = rows.filter((row) => row.kind === 'response');
    assert.ok(responses.length >= 3, 'the fixture speaks at least three responses');
    assert.equal(result.attempts[0].lastResponse, responses.at(-1).summary);

    const task2 = readFileSync(join(home, 'task-do-work-attempt-2.md'), 'utf8');
    assert.match(task2, new RegExp(`- Stream file: ${streamFile.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}$`, 'm'));
    // Every one of the last three responses is in the block, on its own line,
    // with the timestamp the sink stamped.
    for (const row of responses.slice(-3)) {
      assert.ok(
        task2.includes(`  - ${row.at}: ${row.summary.replace(/\s+/g, ' ').trim()}`),
        `block is missing the response at ${row.at}`,
      );
    }
    // The stream is referenced by path, never inlined.
    assert.ok(!task2.includes('"providerType"'), 'the stream must not be inlined into the task');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
