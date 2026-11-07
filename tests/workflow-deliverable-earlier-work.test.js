// Earlier work (D19) as the runtime computes it, through the real resume,
// step rerun and add paths of a v3 run: which earlier attempts count as
// produced, when "unknown" survives, and why an isolated dispatch only trusts
// integrated work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { reopenV2RunForRetry } from '../src/workflow/run-control.js';
import { acceptCallerPlannerResponse } from '../src/workflow/caller-planner.js';
import { rerunV2Step } from '../src/workflow/cli-step-verbs.js';
import { addV3Steps } from '../src/workflow/cli-steps.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { STAGE3_RUN_FEATURES, withProgramFormat } from '../src/workflow/run-features.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { removeSettled } from './fixtures/settled-cleanup.mjs';

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

const step = (fields) => ({ prompt: `Implement ${fields.id}.`, lane: 'build', ...fields });
const writeStep = () => step({ id: 'write', files: ['write.txt'], effort: 'low' });
const genStep = () => step({
  id: 'gen', files: ['gen.js', 'out/data.json'],
  prompt: 'Fix gen.js and run it to regenerate out/data.json.',
  deliverable: { type: 'data', paths: ['out/data.json'] },
});

const attempt = (fields) => ({
  pool: 'codex', model: 'gpt-5.6-luna', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:05:00.000Z',
  failureKind: null, why: null, ...fields,
});
// The kernel died before the snapshot; reconcileResume marked it.
const interrupted = (actionId, ordinal, extra = {}) => attempt({
  id: `${actionId}-${ordinal}`, actionId, ordinal, status: 'interrupted', failureKind: 'interrupted',
  why: 'runner stopped before the attempt reached a durable terminal state', ...extra,
});
const partial = { status: 'partial', finishedAt: '2026-09-24T10:06:00.000Z' };
const unavailable = { status: 'failed', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:06:00.000Z', lastFailure: { kind: 'unavailable', message: 'no eligible pool' } };

// Build a v3 program run on disk, let `reopen` change it the way a caller would,
// then resume the kernel with the real dispatcher and a worker that changes
// nothing unless `worker` says otherwise.
async function scenario(t, {
  runId, actions, attempts = [], runtime = {}, lifecycle = { status: 'running' }, workspaceMode = 'shared',
  committed = {}, onDisk = {}, reopen = null, worker = null,
}) {
  const root = mkdtempSync(join(tmpdir(), 'bs-earlier-'));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  // The kernel of an isolated run starts a detached `home prune --auto` that
  // writes into the home after the run returns; removeSettled outlasts it.
  t.after(() => {
    try { execFileSync('git', ['-C', workspace, 'worktree', 'prune']); } catch { /* not a repo */ }
    removeSettled(root);
  });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bullswarmDir, { recursive: true });
  const put = (files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(workspace, path, '..'), { recursive: true });
      writeFileSync(join(workspace, path), body);
    }
  };
  execFileSync('git', ['init', '-q', workspace]);
  put({ 'README.md': 'acme\n', ...committed });
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-qm', 'seed']);
  put(onDisk);
  const goal = 'Deliver the requested files';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode, scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const runDir = join(bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  let state = createV2State(goalDocument, { runId, shortId: runId.slice(3, 9) });
  state = acceptCallerPlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Deliver.',
    program: { schemaVersion: 'bullswarm.workflow.program.v3', steps: actions },
  }, { boundary: 'initial', runDir }).state;
  state.attempts = attempts;
  for (const action of state.actions) {
    const count = attempts.filter((item) => item.actionId === action.id).length;
    Object.assign(action, count ? { status: 'running', attempts: count, startedAt: '2026-09-24T10:00:00.000Z' } : {}, runtime[action.id] ?? {});
  }
  Object.assign(state.lifecycle, lifecycle);
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(goalDocument));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(runDir, 'features.json'), JSON.stringify(withProgramFormat(STAGE3_RUN_FEATURES, { v3: true })));
  const ctx = { bullswarmDir, runId, runDir, workspace };
  if (reopen) await reopen(ctx);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const seen = [];
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: (options) => {
        seen.push({ id: options.action.id, earlierWork: options.earlierWork, targetDir: options.targetDir });
        return dispatchV2Action({
          ...options,
          pools: [connector('codex')],
          dependencies: {
            watchOnce: async (_pool, task, targetDir, files) => {
              writeFileSync(files.taskFile, task);
              worker?.(targetDir, options.action);
              writeFileSync(files.outFile, 'The work is already on disk; nothing to change.');
              return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
            },
            loadState: () => structuredClone(core),
            saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
            now: () => Date.now(),
            uuid: () => 'session-fixed',
          },
        });
      },
    },
  });
  const lastOf = (id) => run.state.attempts.filter((item) => item.actionId === id).at(-1);
  const earlierOf = (id) => seen.find((entry) => entry.id === id)?.earlierWork;
  return { ...ctx, run, seen, lastOf, earlierOf };
}

// `bullswarm workflow step rerun`.
async function stepRerun({ bullswarmDir, runId }, stepId) {
  const outcome = await rerunV2Step({ bullswarmDir, token: runId, stepId, pools: [connector('codex')], waitMs: 0 });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
  return outcome;
}

// gate-0: a not-produced failure is never earlier work.
test('a step rerun of a data step that failed not-produced is judged again, even though it changed another owned file', async (t) => {
  const { earlierOf, lastOf, run, workspace } = await scenario(t, {
    runId: 'wf-rerun0-abcdef',
    actions: [genStep()],
    committed: { 'gen.js': 'console.log(1)\n', 'out/data.json': '{"stale":true}\n' },
    onDisk: { 'gen.js': 'console.log(2)\n' },
    attempts: [attempt({
      id: 'gen-1', actionId: 'gen', ordinal: 1, status: 'failed',
      failureKind: 'not-produced', why: 'declared data not written: out/data.json',
      changedFileCount: 1, changedFiles: ['gen.js'],
      deliverable: { type: 'data', gated: true, produced: false, written: [], missing: [] },
    })],
    runtime: { gen: { status: 'failed', finishedAt: '2026-09-24T10:06:00.000Z', lastFailure: { kind: 'not-produced', message: 'declared data not written: out/data.json' } } },
    lifecycle: partial,
    reopen: (ctx) => stepRerun(ctx, 'gen'),
  });
  assert.deepEqual(earlierOf('gen'), { produced: false, unknown: false });
  const [rerun, retry] = run.state.attempts.filter((item) => item.actionId === 'gen').slice(1);
  assert.equal(rerun.ordinal, 2);
  assert.equal(rerun.status, 'failed');
  assert.equal(rerun.failureKind, 'not-produced');
  assert.equal(rerun.why, 'declared data not written: out/data.json');
  assert.equal(rerun.deliverable.carried, undefined);
  // The one rule: the rerun's gate failure gets the step's one retry, on the
  // same pool, judged the same way.
  assert.deepEqual([retry.ordinal, retry.failureKind, retry.retryOf], [3, 'not-produced', { attempt: 'gen-2', how: 'same-pool' }]);
  assert.equal(lastOf('gen'), retry);
  assert.equal(run.state.actions[0].status, 'failed');
  assert.equal(readFileSync(join(workspace, 'out', 'data.json'), 'utf8'), '{"stale":true}\n');
});

test('for a path deliverable, only a success or a written path is earlier work', async (t) => {
  const stalled = (ordinal, extra) => attempt({
    id: `gen-${ordinal}`, actionId: 'gen', ordinal, status: 'failed', failureKind: 'stalled', why: 'stalled: no output', ...extra,
  });
  const common = {
    actions: [genStep()],
    committed: { 'gen.js': 'console.log(1)\n', 'out/data.json': '{"stale":true}\n' },
  };
  // A stall that only touched gen.js did not produce the data.
  const touched = await scenario(t, {
    ...common,
    runId: 'wf-stall0-abcdef',
    onDisk: { 'gen.js': 'console.log(2)\n' },
    attempts: [stalled(1, { changedFileCount: 1, changedFiles: ['gen.js'], deliverable: { type: 'data', gated: true, produced: false, written: [], missing: [] } })],
  });
  assert.deepEqual(touched.earlierOf('gen'), { produced: false, unknown: false });
  assert.equal(touched.lastOf('gen').failureKind, 'not-produced');
  // A stall that wrote the data did, so a clean retry is judged by existence.
  const wrote = await scenario(t, {
    ...common,
    runId: 'wf-stall1-abcdef',
    onDisk: { 'out/data.json': '{"rows":3}\n' },
    attempts: [stalled(1, { changedFileCount: 1, changedFiles: ['out/data.json'], deliverable: { type: 'data', gated: true, produced: true, written: ['out/data.json'], missing: [] } })],
  });
  assert.deepEqual(wrote.earlierOf('gen'), { produced: true, unknown: false });
  assert.equal(wrote.lastOf('gen').status, 'succeeded');
  assert.equal(wrote.lastOf('gen').deliverable.carried, true);
});

// gate-1: an isolated dispatch starts from the main tree, where failed work never landed.
test('an isolated dispatch ignores earlier work that was never integrated', async (t) => {
  const { earlierOf, lastOf, run, seen, workspace } = await scenario(t, {
    runId: 'wf-isolat-abcdef',
    workspaceMode: 'isolated',
    actions: [step({ id: 'write', files: ['write.txt'], prompt: 'Write write.txt.' })],
    committed: { 'write.txt': 'base\n' },
    attempts: [
      attempt({
        id: 'write-1', actionId: 'write', ordinal: 1, status: 'failed', failureKind: 'stalled', why: 'stalled: no output',
        changedFileCount: 1, changedFiles: ['write.txt'], deliverable: { type: 'files', gated: true, produced: true },
      }),
      interrupted('write', 2, { startedAt: '2026-09-24T10:07:00.000Z' }),
    ],
  });
  assert.notEqual(seen[0].targetDir, workspace);
  assert.deepEqual(earlierOf('write'), { produced: false, unknown: false });
  assert.equal(lastOf('write').status, 'failed');
  assert.equal(lastOf('write').failureKind, 'not-produced');
  assert.equal(run.state.actions[0].status, 'failed');
  assert.equal(readFileSync(join(workspace, 'write.txt'), 'utf8'), 'base\n');
});

test('an isolated rerun of a step that succeeded carries its integrated work', async (t) => {
  const { earlierOf, lastOf, runDir, seen, workspace } = await scenario(t, {
    runId: 'wf-isook0-abcdef',
    workspaceMode: 'isolated',
    actions: [step({ id: 'write', files: ['write.txt'], prompt: 'Write write.txt.' })],
    committed: { 'write.txt': 'written\n' },
    attempts: [attempt({
      id: 'write-1', actionId: 'write', ordinal: 1, status: 'succeeded',
      changedFileCount: 1, changedFiles: ['write.txt'], deliverable: { type: 'files', gated: true, produced: true },
    })],
    runtime: { write: { status: 'succeeded', finishedAt: '2026-09-24T10:06:00.000Z' } },
    lifecycle: { status: 'completed', finishedAt: '2026-09-24T10:06:00.000Z' },
    reopen: (ctx) => stepRerun(ctx, 'write'),
  });
  assert.notEqual(seen[0].targetDir, workspace);
  assert.deepEqual(earlierOf('write'), { produced: true, unknown: false });
  assert.equal(lastOf('write').status, 'succeeded');
  assert.deepEqual(lastOf('write').deliverable, { type: 'files', gated: false, produced: null, carried: true });
  const finished = readEvents(runDir).filter((event) => event.type === 'action.finished' && event.payload.actionId === 'write');
  assert.equal(finished.at(-1).payload.carried, true, 'the finish event says the work was carried');
});

// kernel-0: resume, step rerun and add keep the step's definition (a v3 run
// has no amendment: a step, once added, is never changed).
const crashed = {
  actions: [writeStep()],
  onDisk: { 'write.txt': 'already written\n' },
  attempts: [interrupted('write', 1)],
};

test('workflow resume keeps an interrupted attempt of the same definition unknown', async (t) => {
  const { earlierOf, lastOf, run } = await scenario(t, {
    ...crashed,
    runId: 'wf-resume-abcdef',
    runtime: { write: unavailable },
    lifecycle: partial,
    reopen: ({ bullswarmDir, runId }) => assert.equal(reopenV2RunForRetry({ bullswarmDir, runId }).status, 'reopened'),
  });
  assert.equal(run.state.actions[0].supersededAttempts, 1);
  assert.deepEqual(earlierOf('write'), { produced: false, unknown: true });
  assert.equal(lastOf('write').status, 'succeeded');
  assert.equal(run.state.actions[0].status, 'succeeded');
});

test('step rerun keeps an interrupted attempt of the same definition unknown', async (t) => {
  const { earlierOf, lastOf, run } = await scenario(t, {
    ...crashed,
    runId: 'wf-rerunk-abcdef',
    runtime: { write: unavailable },
    lifecycle: partial,
    reopen: (ctx) => stepRerun(ctx, 'write'),
  });
  assert.equal(run.state.actions[0].supersededAttempts, 1);
  assert.deepEqual(earlierOf('write'), { produced: false, unknown: true });
  assert.equal(lastOf('write').status, 'succeeded');
});

test('an add that reopens a cancelled step keeps its interrupted attempt unknown', async (t) => {
  const { earlierOf, lastOf, run } = await scenario(t, {
    ...crashed,
    runId: 'wf-cancel-abcdef',
    runtime: { write: { status: 'cancelled', finishedAt: '2026-09-24T10:06:00.000Z' } },
    lifecycle: { status: 'cancelled', finishedAt: '2026-09-24T10:06:00.000Z' },
    reopen: async ({ bullswarmDir, runId }) => {
      const added = await addV3Steps({
        bullswarmDir, token: runId, fragment: { steps: [{ id: 'survey', lane: 'analyze', effort: 'low', prompt: 'Survey the repository.' }] },
        waitMs: 0, relaunch: async () => null,
      });
      assert.equal(added.status, 'applied', JSON.stringify(added));
    },
  });
  const write = run.state.actions.find((action) => action.id === 'write');
  assert.equal(write.supersededAttempts, 1);
  assert.deepEqual(earlierOf('write'), { produced: false, unknown: true });
  assert.equal(lastOf('write').status, 'succeeded');
  assert.equal(write.status, 'succeeded');
});
