// A build turn cut off at its output limit gets one same-session continue.
//
// opencode ends a model request with a `step_finish` event whose
// `part.reason` is `length` when the output cap was hit, `stop` otherwise.
// The connector declares that as `eventStream.stopReason`; the decoder turns
// it into `stopReason()`, watch records `meta.stopReason`, and the failure
// rule continues the same provider session once when a build or chore step
// produced no file. Every other not-produced failure keeps today's skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { pickPool } from '../src/lib/route.js';

const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };
const connector = (name, { pace, conversation = true } = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' }, medium: { pool: name, model: 'gpt-5.6-luna' } },
  ...(conversation ? { conversation: { newArgs: [], resumeArgs: ['--session', '{sessionId}'] } } : {}),
  ...(pace === undefined ? {} : { pace }),
});

// A worker verdict that reports a provider-measured session and, by default,
// the length stop. `sessionSource` is the capture fact watch writes: only
// 'provider-stream' says the provider itself minted the id.
const cutoff = ({ sessionId = 'ses-1', stopReason = 'length', sessionSource = 'provider-stream' } = {}) => ({
  ok: true,
  why: 'structured output validated',
  meta: {
    exitCode: 0,
    wallSec: 1,
    usage: { totalTokens: 10, ...(sessionId ? { sessionId } : {}) },
    ...(stopReason ? { stopReason } : {}),
    ...(sessionId ? { capture: { providerSessionId: sessionId, sessionSource } } : {}),
  },
});

function harness(verdicts) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  let session = 0;
  const calls = [];
  const picks = [];
  return {
    calls,
    picks,
    dependencies: {
      watchOnce: async (pool, task, _dir, paths, opts) => {
        calls.push({ pool: pool.name, task, opts });
        const item = verdicts[index++];
        return typeof item === 'function' ? item({ paths, opts }) : item;
      },
      pickPool: (lane, pools, opts) => {
        picks.push({ lane, pools: pools.map((pool) => pool.name), opts });
        return pickPool(lane, pools, opts);
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-11-28T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => `session-${++session}`,
    },
  };
}

function repoFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-lencut-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'tickets'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, 'tickets', 'T-1001.md'), 'Refund not received\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { repo, home };
}

const build = (extra = {}) => ({ id: 'task', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, ownedFiles: [], ...extra });
const writesTicket = (repo) => () => { writeFileSync(join(repo, 'tickets', 'T-1001.md'), 'Refund sent\n'); return good; };
const SKIP_SUFFIX = ' · retry skipped: a step that changed no file rarely does on a rerun';

async function dispatch(f, action, watches, { pools = ['sample-pool'], refreshPools = null, options = {} } = {}) {
  const h = harness(watches);
  const result = await dispatchV2Action({
    failureRule: true,
    action, taskText: 'triage the tickets', targetDir: f.repo,
    paths: (ordinal) => ({ taskFile: join(f.home, `task-${action.id}-attempt-${ordinal}.md`), outFile: join(f.home, `out-${action.id}-attempt-${ordinal}.md`) }),
    pools: pools.map((name) => (typeof name === 'string' ? connector(name) : name)),
    bullswarmDir: f.home,
    ...(refreshPools ? { refreshPools } : {}),
    ...options,
    dependencies: h.dependencies,
  });
  return { result, calls: h.calls, picks: h.picks };
}

test('a build turn cut off at its output limit continues the same session once', async (t) => {
  const f = repoFixture(t);
  const h = harness([cutoff(), writesTicket(f.repo)]);
  const inner = h.dependencies.watchOnce;
  const tasks = [];
  const refreshCalls = [];
  const result = await dispatchV2Action({
    failureRule: true,
    action: build(), taskText: 'triage the tickets', targetDir: f.repo,
    paths: (ordinal) => ({ taskFile: join(f.home, `task-task-attempt-${ordinal}.md`), outFile: join(f.home, `out-task-attempt-${ordinal}.md`) }),
    pools: [connector('sample-pool')],
    bullswarmDir: f.home,
    refreshPools: async (opts) => { refreshCalls.push(opts); return [connector('sample-pool')]; },
    dependencies: {
      ...h.dependencies,
      watchOnce: async (pool, task, dir, paths, opts) => { tasks.push(task); return inner(pool, task, dir, paths, opts); },
    },
  });

  assert.equal(result.ok, true, result.attempts.at(-1)?.why);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(h.calls.map((call) => call.pool), ['sample-pool', 'sample-pool']);
  const [first, second] = result.attempts;
  assert.equal(first.failureKind, 'not-produced');
  assert.equal(first.status, 'failed');
  assert.equal(first.willRetry, true);
  assert.ok(!first.why.includes('retry skipped'), first.why);
  // The provider-measured id is the durable session, not the generated uuid.
  assert.equal(first.session.sessionId, 'ses-1');
  assert.equal(first.continued, false);
  assert.deepEqual(second.retryOf, { attempt: 'task-1', how: 'same-pool' });
  assert.equal(second.continued, true);
  assert.equal(second.session.sessionId, 'ses-1');
  // The retry asks the connector to resume the measured provider session.
  assert.deepEqual(h.calls[1].opts.conversation, { sessionId: 'ses-1', resume: true });
  // The retry task carries the handoff and the continue instruction.
  assert.match(tasks[1], /## Prior attempt on this step/);
  assert.match(tasks[1], /continue the same conversation/i);
  assert.deepEqual(refreshCalls, [{ force: false }, { force: true }]);
  // Both picks ran, and the retry was forced onto the same pool.
  assert.equal(h.picks.length, 2);
  assert.deepEqual(h.picks.map((pick) => pick.opts.strictPool), [null, 'sample-pool']);
});

test('no measured session id: one attempt, to the caller with the existing skip reason', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [cutoff({ sessionId: null }), good]);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'not-produced');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('a clean stop is not a cutoff: one attempt with the skip reason', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [cutoff({ stopReason: 'stop' }), good]);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].willRetry, false);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('an act step is never continued, even with a measured length cutoff', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build({ role: 'act' }), [cutoff(), good]);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
});

test('no retry budget: one attempt, no continue', async (t) => {
  const f = repoFixture(t);
  const cases = [
    ['retry 0', build(), { maxMechanicalRetries: 0 }],
    ['budget spent', build(), { retriesAlready: 1 }],
  ];
  for (const [label, action, options] of cases) {
    const h = harness([cutoff(), good]);
    const result = await dispatchV2Action({
      failureRule: true,
      action, taskText: 'triage the tickets', targetDir: f.repo,
      paths: { taskFile: join(f.home, `task-${label}.md`), outFile: join(f.home, `out-${label}.md`) },
      pools: [connector('sample-pool')], bullswarmDir: f.home,
      ...options,
      dependencies: h.dependencies,
    });
    assert.equal(h.calls.length, 1, label);
    assert.equal(result.ok, false, label);
    assert.equal(result.attempts[0].willRetry, false, label);
  }
});

test('a second length cutoff goes to the caller even when the budget allows another retry', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [cutoff(), cutoff(), good], {
    options: { maxMechanicalRetries: 2 },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'not-produced');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].willRetry, true);
  assert.deepEqual(result.attempts[1].retryOf, { attempt: 'task-1', how: 'same-pool' });
  assert.equal(result.attempts[1].willRetry, false);
  assert.ok(result.attempts[1].why.endsWith(SKIP_SUFFIX), result.attempts[1].why);
});

test('a workflow-assigned session id is not a measured id: one attempt with the skip reason', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [
    cutoff({ sessionId: 'session-1', sessionSource: 'bullswarm-assigned' }), good,
  ]);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('a connector with no conversation declaration is not continued: one attempt with the skip reason', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [cutoff(), good], {
    pools: [connector('sample-pool', { conversation: false })],
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'not-produced');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('a prior dispatch that already continued is not continued again', async (t) => {
  const f = repoFixture(t);
  const h = harness([cutoff(), good]);
  const result = await dispatchV2Action({
    failureRule: true,
    action: build(), taskText: 'triage the tickets', targetDir: f.repo,
    paths: { taskFile: join(f.home, 'task-task.md'), outFile: join(f.home, 'out-task.md') },
    pools: [connector('sample-pool')], bullswarmDir: f.home,
    ledgerAttempts: [{
      actionId: 'task',
      notes: [{ at: '2026-11-28T00:00:00.000Z', kind: 'length-cutoff-continue', text: 'continued once' }],
    }],
    dependencies: h.dependencies,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].willRetry, false);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('a cutoff on a pinned pool that cannot take the retry moves to another pool in a fresh session', async (t) => {
  const f = repoFixture(t);
  const launch = [connector('pool-a', { pace: 90 }), connector('pool-b', { pace: -90 })];
  const onlyB = [connector('pool-b', { pace: 90 })];
  const h = harness([cutoff(), writesTicket(f.repo)]);
  const refreshCalls = [];
  const result = await dispatchV2Action({
    failureRule: true,
    action: build(), taskText: 'triage the tickets', targetDir: f.repo,
    paths: (ordinal) => ({ taskFile: join(f.home, `task-task-attempt-${ordinal}.md`), outFile: join(f.home, `out-task-attempt-${ordinal}.md`) }),
    pools: launch, bullswarmDir: f.home,
    refreshPools: async (opts) => { refreshCalls.push(opts); return refreshCalls.length === 1 ? launch : onlyB; },
    dependencies: h.dependencies,
  });

  assert.equal(result.ok, true, result.attempts.at(-1)?.why);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(h.calls.map((call) => call.pool), ['pool-a', 'pool-b']);
  const [first, second] = result.attempts;
  assert.equal(first.pool, 'pool-a');
  assert.deepEqual(second.retryOf, { attempt: 'task-1', how: 'other-pool' });
  assert.equal(second.continued, false);
  assert.equal(second.session.pool, 'pool-b');
  assert.notEqual(second.session.sessionId, 'ses-1');
  assert.deepEqual(h.calls[1].opts.conversation, { sessionId: second.session.sessionId, resume: false });
  assert.match(second.routeWhy, /gate retry moved: pool-a cannot take work now/);
  assert.deepEqual(refreshCalls, [{ force: false }, { force: true }]);
  // Opus review (28 Nov): a fresh session gets no "continue the same
  // conversation" line, and attempt 1 records a request, not a resume.
  assert.doesNotMatch(h.calls[1].task, /Continue the same conversation/);
  const note = first.notes.find((entry) => entry.kind === 'length-cutoff-continue');
  assert.doesNotMatch(note.text, /retry resumes session/);
  assert.match(note.text, /requested/);
});

test('a continue in an earlier loop round or rerun does not use up the step\'s continue', async (t) => {
  const f = repoFixture(t);
  const h = harness([cutoff(), writesTicket(f.repo)]);
  const result = await dispatchV2Action({
    failureRule: true,
    action: build(), taskText: 'triage the tickets', targetDir: f.repo,
    paths: (ordinal) => ({ taskFile: join(f.home, `task-task-attempt-${ordinal}.md`), outFile: join(f.home, `out-task-attempt-${ordinal}.md`) }),
    pools: [connector('sample-pool')], bullswarmDir: f.home,
    ledgerAttempts: [
      { actionId: 'task', ordinal: 1, notes: [{ at: '2026-11-28T00:00:00.000Z', kind: 'length-cutoff-continue', text: 'round 1' }] },
      { actionId: 'task', ordinal: 2 },
    ],
    supersededAttempts: 2,
    dependencies: h.dependencies,
  });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].task, /Continue the same conversation/);
  assert.equal(h.calls[1].opts.conversation.resume, true);
  assert.equal(result.ok, true);
});

test('runtime: a cut-off build step succeeds on attempt 2 in the first attempt\'s provider session', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-lencut-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = 'Write the acme notes';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  const pool = {
    name: 'acme-pool', lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' },
    strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: 'acme-pool', model: 'acme-model' }])),
    conversation: { newArgs: [], resumeArgs: ['--session', '{sessionId}'] },
  };
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  let session = 0;
  const dispatch = (options) => dispatchV2Action({
    ...options,
    pools: [pool],
    dependencies: {
      watchOnce: async (_pool, task, targetDir, files) => {
        const turn = (turns.get(options.action.id) ?? 0) + 1;
        turns.set(options.action.id, turn);
        writeFileSync(files.taskFile, task);
        writeFileSync(files.outFile, `done turn ${turn}`);
        if (turn === 2) writeFileSync(join(targetDir, 'work.md'), 'done\n');
        return {
          ok: true,
          why: 'structured output validated',
          meta: {
            exitCode: 0, wallSec: 1,
            usage: { totalTokens: 10, sessionId: 'ses-1' },
            capture: { providerSessionId: 'ses-1', sessionSource: 'provider-stream' },
            ...(turn === 1 ? { stopReason: 'length' } : {}),
          },
        };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => Date.now(),
      uuid: () => `session-${++session}`,
    },
  });
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{ id: 'write', prompt: 'Write the acme notes to work.md.', lane: 'build', retry: 1 }],
  };
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'A v3 program.', program,
    },
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
  });

  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(run.state.attempts.length, 2);
  assert.equal(run.state.attempts[0].session.sessionId, 'ses-1');
  assert.equal(run.state.attempts[1].session.sessionId, 'ses-1');
  assert.equal(run.state.attempts[1].continued, true);
  assert.deepEqual(run.state.attempts[1].retryOf, { attempt: 'write-1', how: 'same-pool' });
  assert.equal(run.state.actions.find((action) => action.id === 'write').status, 'succeeded');
});
