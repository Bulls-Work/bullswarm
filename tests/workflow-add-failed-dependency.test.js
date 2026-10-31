// `workflow add` of a step that can never run: it behind a failed, cancelled
// or blocked step. The add is still applied; the caller is warned, in text and
// in --json `waitsOnFinished`. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { wfAdd } from '../src/workflow/cli-steps.js';

const V3 = 'bullswarm.workflow.program.v3';
const statusOf = (state, id) => state.actions.find((action) => action.id === id)?.status;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-add-wait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goal = 'Check the acme findings';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Add and wait.', program });

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch with a fake worker; `script(actionId, turn)` returns {answer?, fail?}.
function fakeDispatch(script = () => ({}), { seen = [], pools = null } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push(options.action.id);
    return dispatchV2Action({
      ...options,
      // Two pools, so a check independent of its finder has somewhere to run.
      pools: pools ?? [connector('acme-pool'), connector('initech-pool')],
      dependencies: {
        watchOnce: async (_pool, task, _targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn) ?? {};
          if (plan.sleepMs) await new Promise((done) => setTimeout(done, plan.sleepMs));
          writeFileSync(files.taskFile, task);
          const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
          if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
          writeFileSync(files.outFile, `done ${options.action.id} turn ${turn}`);
          if (plan.fail) return { ok: false, why: 'the acme worker crashed', failureKind: plan.fail, meta: { exitCode: 1, wallSec: 1 } };
          const checked = opts.outputValidator ? opts.outputValidator('') : { ok: true };
          const structured = { ok: checked.ok, errors: checked.errors ?? [], ...(checked.value !== undefined ? { value: checked.value } : {}) };
          return checked.ok
            ? { ok: true, why: 'structured output validated', structured, meta: { exitCode: 0, wallSec: 1 } }
            : { ok: false, why: `structured output invalid: ${structured.errors.join('; ')}`, failureKind: 'schema', structured, meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
      },
    });
  };
}

const deps = (dispatch) => ({ refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 });
const launch = (f, program, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {}, initialPlannerResponse: response(program), dependencies: deps(dispatch),
});
const resume = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {}, dependencies: deps(dispatch),
});

const noRelaunch = async (runId) => ({ action: 'goal-resumed', runId });

async function captured(fn) {
  const out = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => out.push(args.join(' '));
  try { return { code: await fn(), text: out.join('\n') }; } finally { console.log = log; console.error = error; }
}

// A run that ended partial: a succeeded, b failed with no retry left.
async function partialRun(t) {
  const f = fixture(t);
  const run = await launch(f, {
    schemaVersion: V3,
    steps: [
      { id: 'a', prompt: 'Do the acme part.' },
      { id: 'b', prompt: 'Do the initech part.', retry: 0 },
    ],
  }, fakeDispatch((id) => (id === 'b' ? { fail: 'process' } : {})));
  assert.equal(statusOf(run.state, 'a'), 'succeeded');
  assert.equal(statusOf(run.state, 'b'), 'failed');
  return { f, run };
}

async function add(f, run, steps, json = false) {
  const file = join(f.root, `part-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ steps }));
  return captured(() => wfAdd({ rest: [run.runId], steps: file, wait: '0', ...(json ? { json: true } : {}) }, {
    bullswarmDir: f.bullswarmDir, helpText: () => '', flagErrors: () => null, routeIssues: () => [],
    launchDetachedResume: async (_doc, runId) => ({ action: 'goal-resumed', runId }),
  }));
}

test('add of a step behind a failed step warns that it stays blocked, names the rerun command, and still applies', async (t) => {
  const { f, run } = await partialRun(t);
  const printed = await add(f, run, [{ id: 'after-b', dependsOn: ['b'], prompt: 'Follow the initech part.' }]);
  assert.equal(printed.code, 0, printed.text);
  assert.match(printed.text, /✓ added to /);
  const rerun = `bullswarm workflow step rerun ${run.shortId} b`;
  assert.ok(printed.text.split('\n').includes(`⚠ after-b waits on b, which failed: it stays blocked until you run \`${rerun}\``), printed.text);
});

test('add --json carries waitsOnFinished with step, dependency and status; exit code stays 0', async (t) => {
  const { f, run } = await partialRun(t);
  const printed = await add(f, run, [{ id: 'after-b', dependsOn: ['b'], prompt: 'Follow the initech part.' }], true);
  assert.equal(printed.code, 0, printed.text);
  const payload = JSON.parse(printed.text);
  assert.equal(payload.status, 'applied');
  assert.deepEqual(payload.waitsOnFinished, [{ step: 'after-b', dependency: 'b', status: 'failed' }]);
});

test('add of a step behind a succeeded step prints no warning and no waitsOnFinished', async (t) => {
  const { f, run } = await partialRun(t);
  const printed = await add(f, run, [{ id: 'after-a', dependsOn: ['a'], prompt: 'Follow the acme part.' }]);
  assert.equal(printed.code, 0, printed.text);
  assert.doesNotMatch(printed.text, /⚠|stays blocked/);
  const json = await add(f, run, [{ id: 'after-a-2', dependsOn: ['a'], prompt: 'Follow the acme part again.' }], true);
  assert.equal(Object.hasOwn(JSON.parse(json.text), 'waitsOnFinished'), false);
});

test('an indirect dependency (new c on new d on failed b) warns for both added steps', async (t) => {
  const { f, run } = await partialRun(t);
  const printed = await add(f, run, [
    { id: 'd', dependsOn: ['b'], prompt: 'Follow the initech part.' },
    { id: 'c', dependsOn: ['d'], prompt: 'Follow d.' },
  ]);
  assert.equal(printed.code, 0, printed.text);
  const rerun = `bullswarm workflow step rerun ${run.shortId} b`;
  const lines = printed.text.split('\n').filter((line) => line.startsWith('⚠'));
  assert.deepEqual(lines, [
    `⚠ d waits on b, which failed: it stays blocked until you run \`${rerun}\``,
    `⚠ c waits on b, which failed: it stays blocked until you run \`${rerun}\``,
  ]);
  const second = await partialRun(t);
  const json = await add(second.f, second.run, [
    { id: 'd', dependsOn: ['b'], prompt: 'Follow the initech part.' },
    { id: 'c', dependsOn: ['d'], prompt: 'Follow d.' },
  ], true);
  assert.deepEqual(JSON.parse(json.text).waitsOnFinished, [
    { step: 'd', dependency: 'b', status: 'failed' },
    { step: 'c', dependency: 'b', status: 'failed' },
  ]);
});

test('a step added behind a blocked step names the failed step at the root, since rerun refuses a blocked step', async (t) => {
  const f = fixture(t);
  const run = await launch(f, {
    schemaVersion: V3,
    steps: [
      { id: 'a', prompt: 'Do the acme part.' },
      { id: 'b', prompt: 'Do the initech part.', retry: 0 },
      { id: 'c', dependsOn: ['b'], prompt: 'Follow the initech part.' },
    ],
  }, fakeDispatch((id) => (id === 'b' ? { fail: 'process' } : {})));
  assert.equal(statusOf(run.state, 'c'), 'blocked');
  const printed = await add(f, run, [{ id: 'e', dependsOn: ['c'], prompt: 'Follow c.' }]);
  assert.equal(printed.code, 0, printed.text);
  const lines = printed.text.split('\n').filter((line) => line.startsWith('⚠'));
  assert.deepEqual(lines, [
    `⚠ e waits on c, which is blocked by b (failed): it stays blocked until you run \`bullswarm workflow step rerun ${run.shortId} b\``,
  ]);
  const json = await add(f, run, [{ id: 'g', dependsOn: ['c'], prompt: 'Follow c again.' }], true);
  assert.deepEqual(JSON.parse(json.text).waitsOnFinished, [
    { step: 'g', dependency: 'c', status: 'blocked', blockedBy: { step: 'b', status: 'failed' } },
  ]);
});

test('waitsOnFinishedSteps: one entry per dead dependency, cancelled counts, a blocked step with nothing failed above it does not', async () => {
  const { waitsOnFinishedSteps } = await import('../src/workflow/add-dead-waits.js');
  const state = {
    program: { actions: [{ id: 'b' }, { id: 'c' }, { id: 'p', dependsOn: ['q'] }, { id: 'q' }] },
    actions: [{ id: 'b', status: 'failed' }, { id: 'c', status: 'cancelled' }, { id: 'p', status: 'blocked' }, { id: 'q', status: 'pending' }],
  };
  assert.deepEqual(waitsOnFinishedSteps(state, [{ id: 'x', dependsOn: ['b', 'c'] }]), [
    { step: 'x', dependency: 'b', status: 'failed' },
    { step: 'x', dependency: 'c', status: 'cancelled' },
  ]);
  assert.deepEqual(waitsOnFinishedSteps(state, [{ id: 'y', dependsOn: ['b'] }, { id: 'z', dependsOn: ['y', 'b'] }]), [
    { step: 'y', dependency: 'b', status: 'failed' },
    { step: 'z', dependency: 'b', status: 'failed' },
  ]);
  assert.deepEqual(waitsOnFinishedSteps(state, [{ id: 'w', dependsOn: ['p'] }]), []);
});

test('waitsOnFinishedSteps: a blocked step whose root was interrupted (it resumes) is not dead', async () => {
  const { waitsOnFinishedSteps } = await import('../src/workflow/add-dead-waits.js');
  const state = {
    program: { actions: [{ id: 'i' }, { id: 'b3', dependsOn: ['i'] }] },
    actions: [{ id: 'i', status: 'interrupted' }, { id: 'b3', status: 'blocked' }],
  };
  assert.deepEqual(waitsOnFinishedSteps(state, [{ id: 'x', dependsOn: ['b3'] }]), []);
});
