import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyV2DispatchFailure, dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { loadState, saveState } from '../src/lib/state.js';

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

test('independent evidence avoids ancestor pool when another is eligible', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({ action: { ...action, lane: 'analyze' }, taskText: 'inspect', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], avoidPools: ['luna-1'], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.attempts[0].pool, 'luna-2');
});

test('strict evidence routing reuses its pinned ancestor instead of deadlocking on unrelated pools', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action: { ...action, lane: 'analyze' },
    taskText: 'inspect',
    targetDir: '/tmp',
    paths,
    pools: [connector('pinned-luna'), connector('unrelated-luna')],
    preferredPool: 'pinned-luna',
    strictPool: 'pinned-luna',
    avoidPools: ['pinned-luna'],
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
    pools: [primary, second], avoidPools: ['relay'],
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
