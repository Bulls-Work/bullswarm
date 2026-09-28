// `workflow add` and `workflow wait`, wave C of 0.37.0 (design sections 5
// and 9): an append-only v3 revision that never changes what a run has, and
// a read-only wait that returns each named step's, gate's or loop's facts and
// checked answer. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2DurableState, createV2GoalDocument, validateV2DurableState } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { implicitV3Requirements, normaliseProgramV3 } from '../src/workflow/program-v3.js';
import { appendedActionsV3, appendedProgramV3 } from '../src/workflow/revision-v3.js';
import { exportV2Plan, planV2Revision } from '../src/workflow/v2-revision.js';
import { v2LiveProgramRuntime } from '../src/workflow/v2-state.js';
import { addV3Steps, waitV3Nodes } from '../src/workflow/cli-steps.js';
import { v2V3Fixtures } from './fixtures/program-v3-fixtures.mjs';

const cli = resolve('bin/bullswarm.js');
const V3 = 'bullswarm.workflow.program.v3';
const readState = (run) => JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
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
function fakeDispatch(script = () => ({}), { seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push(options.action.id);
    return dispatchV2Action({
      ...options,
      // Two pools, so a check independent of its finder has somewhere to run.
      pools: [connector('acme-pool'), connector('initech-pool')],
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

const findingsAnswer = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', required: ['id', 'claim'], properties: { id: { type: 'string' }, claim: { type: 'string' } } } } },
};
const confirmAnswer = { type: 'object', required: ['confirmed'], properties: { confirmed: { type: 'boolean' } } };

// Workflow 1 of the design: find, a gate, then the caller adds one check per finding.
const findProgram = () => ({
  schemaVersion: V3,
  steps: [
    { id: 'find', prompt: 'Find claims in the acme notes.', answer: findingsAnswer },
    { id: 'report', dependsOn: ['review'], prompt: 'Report on the acme findings.' },
  ],
  gates: [{ id: 'review', dependsOn: ['find'], note: 'Add one check per finding, then continue' }],
});
const findings = { findings: [{ id: 'f1', claim: 'acme ships widgets' }, { id: 'f2', claim: 'initech buys widgets' }] };
const checkFragment = (ids = ['f1', 'f2']) => ({
  steps: ids.map((id) => ({
    id: `check-${id}`, dependsOn: ['find'], route: { independentOf: ['find'] },
    prompt: `Check finding ${id}.`, answer: confirmAnswer,
  })),
});
const script = (id) => (id === 'find' ? { answer: findings } : id.startsWith('check-') ? { answer: { confirmed: true } } : {});
const noRelaunch = async (runId) => ({ action: 'goal-resumed', runId });

// --- workflow add ----------------------------------------------------------------

test('add appends checks to a parked run: nothing the run has changes, the checks run on resume, the run parks again', async (t) => {
  const f = fixture(t);
  const seen = [];
  const run = await launch(f, findProgram(), fakeDispatch(script, { seen }));
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['review']);
  const before = readState(run);
  const relaunched = [];
  const added = await addV3Steps({
    bullswarmDir: f.bullswarmDir, token: run.shortId, fragment: checkFragment(), waitMs: 0,
    relaunch: async (runId) => { relaunched.push(runId); return { action: 'goal-resumed', runId }; },
  });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  assert.equal(added.code, 0);
  assert.equal(added.appliedBy, 'offline');
  assert.deepEqual(added.steps, ['check-f1', 'check-f2']);
  assert.deepEqual(added.control, []);
  assert.deepEqual(relaunched, [run.runId]);
  const after = readState(run);
  assert.equal(validateV2DurableState(structuredClone(after)), true);
  assert.deepEqual(after.program.actions.slice(0, 2), before.program.actions, 'the existing steps are byte-identical');
  assert.deepEqual(after.program.control, before.program.control);
  assert.deepEqual(after.actions.slice(0, 2), before.actions, 'their runtime records are untouched');
  const record = after.revisions.at(-1);
  assert.equal(record.source, 'workflow-add');
  assert.deepEqual(record.changes, { added: ['check-f1', 'check-f2'], amended: [], restored: [], removed: [], rerun: [], invalidated: [] });
  assert.deepEqual(after.program.actions.slice(2).map((action) => [action.id, action.dependsOn, action.route]),
    [['check-f1', ['find'], { independentOf: ['find'] }], ['check-f2', ['find'], { independentOf: ['find'] }]]);

  const again = await resume(f, run.runId, fakeDispatch(script, { seen }));
  assert.deepEqual(again.waiting.map((entry) => entry.id), ['review'], 'the gate still waits for the caller');
  assert.deepEqual(seen, ['find', 'check-f1', 'check-f2']);
  assert.equal(statusOf(again.state, 'check-f1'), 'succeeded');
  const finder = again.state.attempts.find((attempt) => attempt.actionId === 'find').pool;
  assert.ok(again.state.attempts.filter((attempt) => attempt.actionId.startsWith('check-')).every((attempt) => attempt.pool !== finder), 'each check ran away from its finder');
  assert.deepEqual(again.state.actions.find((action) => action.id === 'check-f2').answer.value, { confirmed: true });
});

test('add to a running run is applied by its live kernel, and the added step runs in the same run', async (t) => {
  const f = fixture(t);
  const program = { schemaVersion: V3, steps: [{ id: 'slow', prompt: 'Take a while on the acme notes.' }] };
  const seen = [];
  const running = launch(f, program, fakeDispatch((id) => (id === 'slow' ? { sleepMs: 600 } : {}), { seen }));
  let token = null;
  for (let i = 0; i < 100 && !token; i += 1) {
    await new Promise((done) => setTimeout(done, 20));
    try {
      const dir = join(f.bullswarmDir, 'workflows');
      const [name] = readdirSync(dir);
      const state = JSON.parse(readFileSync(join(dir, name, 'state.json'), 'utf8'));
      if (state.actions.some((action) => action.status === 'running')) token = state.runId;
    } catch { /* not written yet */ }
  }
  assert.ok(token, 'the run started');
  const added = await addV3Steps({
    bullswarmDir: f.bullswarmDir, token, fragment: { steps: [{ id: 'tail', dependsOn: ['slow'], prompt: 'Summarise the acme notes.' }] },
    waitMs: 5000, pollMs: 20, relaunch: async () => { throw new Error('a live kernel is never relaunched'); },
  });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  assert.equal(added.appliedBy, 'kernel');
  assert.equal(added.relaunch, null);
  const run = await running;
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen, ['slow', 'tail']);
});

test('add refuses what would change the run, and says so in the fragment\'s words', async (t) => {
  const f = fixture(t);
  const run = await launch(f, findProgram(), fakeDispatch(script));
  const before = readFileSync(join(run.runDir, 'state.json'), 'utf8');
  const refused = async (fragment, pattern) => {
    const result = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.shortId, fragment, waitMs: 0, relaunch: noRelaunch });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.code, 2);
    assert.ok(result.issues.some((issue) => pattern.test(issue)), JSON.stringify(result.issues));
  };
  await refused({ steps: [{ id: 'find', prompt: 'Find again.' }] }, /fragment steps\[0\] uses the id "find", which the run already has/);
  await refused({ gates: [{ id: 'review', dependsOn: ['find'] }] }, /fragment gates\[0\] uses the id "review"/);
  await refused({ steps: [{ id: 'fix', prompt: 'Fix it.' }], loops: [{ id: 'again', steps: ['find', 'fix'], until: { step: 'find', field: 'x' }, maxRounds: 2 }] },
    /fragment loops\[0\] names the existing step find/);
  await refused({ steps: [{ id: 'late', prompt: 'Late.', dependsOn: ['nowhere'] }] }, /late\.dependsOn references unknown step, gate or loop "nowhere"/);
  await refused({ steps: [{ id: 'late', prompt: 'Late.', kind: 'check' }] }, /^fragment steps\[0\]\.kind is not a v3 field$/);
  await refused({ steps: [{ id: 'late', prompt: 'Late.', route: { independentOf: ['report'] } }] }, /independentOf/);
  await refused({ steps: [] }, /the fragment adds nothing/);
  await refused({ steps: [{ id: 'late', prompt: 'Late.' }], defaults: { lane: 'build' } }, /fragment\.defaults is not allowed/);
  await refused([], /a fragment must be a JSON object/);
  assert.equal(readFileSync(join(run.runDir, 'state.json'), 'utf8'), before, 'a refusal leaves the run as it was');
});

test('add adds a gate and a loop to a finished run: it reopens, the loop runs to its condition, and the state validates', async (t) => {
  const f = fixture(t);
  const program = { schemaVersion: V3, steps: [{ id: 'draft', prompt: 'Draft the acme brief.' }] };
  const run = await launch(f, program, fakeDispatch());
  assert.equal(run.result.status, 'completed');
  const passed = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };
  const fragment = {
    steps: [
      { id: 'fix', dependsOn: ['draft'], prompt: 'Fix the acme brief.' },
      { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme brief.', answer: passed },
      { id: 'post', dependsOn: ['approve'], prompt: 'Post the acme brief.' },
    ],
    loops: [{ id: 'polish', steps: ['fix', 'check'], until: { step: 'check', field: 'passed' }, maxRounds: 3 }],
    gates: [{ id: 'approve', dependsOn: ['polish'], note: 'Read the brief' }],
  };
  const added = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.runId, fragment, waitMs: 0, relaunch: noRelaunch });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  assert.equal(added.reopened.previousStatus, 'completed');
  assert.deepEqual(added.control, ['approve', 'polish']);
  const state = readState(run);
  assert.equal(state.lifecycle.status, 'running');
  assert.deepEqual(state.program.control.loops.map((loop) => loop.id), ['polish']);
  assert.deepEqual(state.revisions.at(-1).changes.addedControl, ['approve', 'polish']);
  const rounds = new Map();
  const next = await resume(f, run.runId, fakeDispatch((id) => {
    if (id !== 'check') return {};
    rounds.set(id, (rounds.get(id) ?? 0) + 1);
    return { answer: { passed: rounds.get(id) >= 2 } };
  }));
  assert.deepEqual(next.waiting.map((entry) => entry.id), ['approve']);
  assert.equal(next.state.controlNodes.find((record) => record.id === 'polish').status, 'passed');
  assert.equal(next.state.controlNodes.find((record) => record.id === 'polish').round, 2);
  assert.equal(validateV2DurableState(next.state), true);
});

test('add --from-answer appends the fragment a step answered with; an answer that is not a fragment is refused', async (t) => {
  const f = fixture(t);
  const planAnswer = { type: 'object', required: ['steps'], properties: { steps: { type: 'array' } } };
  const program = {
    schemaVersion: V3,
    steps: [{ id: 'plan', prompt: 'Plan the acme checks as a fragment.', answer: planAnswer }, { id: 'bad', prompt: 'Answer badly.', answer: planAnswer }],
    gates: [{ id: 'hold', dependsOn: ['plan', 'bad'] }],
  };
  const run = await launch(f, program, fakeDispatch((id) => ({
    answer: id === 'plan'
      ? { steps: [{ id: 'check-a', dependsOn: ['plan'], prompt: 'Check a.' }] }
      : { steps: [{ id: 'check-b', prompt: 'Check b.', owner: 'acme' }] },
  })));
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['hold']);
  const bad = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.shortId, fromAnswer: 'bad', waitMs: 0, relaunch: noRelaunch });
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.fromAnswer, 'bad');
  assert.ok(bad.issues.some((issue) => /fragment steps\[0\]\.owner is not allowed/.test(issue)), JSON.stringify(bad.issues));
  const none = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.shortId, fromAnswer: 'hold', waitMs: 0, relaunch: noRelaunch });
  assert.equal(none.status, 'error');
  assert.match(none.why, /has no step "hold"/);
  const good = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.shortId, fromAnswer: 'plan', waitMs: 0, relaunch: noRelaunch });
  assert.equal(good.status, 'applied', JSON.stringify(good));
  assert.deepEqual(good.steps, ['check-a']);
  assert.match(readState(run).revisions.at(-1).summary, /add check-a from the answer of plan/);
});

test('add refuses a v2 run with the plan revise command, and the CLI prints what it added', async (t) => {
  const f = fixture(t);
  const v2 = v2V3Fixtures();
  const state = applyV2PlannerResponse(createV2DurableState(createV2GoalDocument(v2.goal), { runId: 'wf-acme-000020', shortId: 'acme20' }), v2.response);
  const runDir = join(f.bullswarmDir, 'workflows', state.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  const refused = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: state.runId, fragment: checkFragment(), waitMs: 0 });
  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 1);
  assert.match(refused.why, /is not a v3 run; workflow add appends to v3 runs\. Change a v2 run's plan with bullswarm workflow plan export acme20 --out plan.json, then bullswarm workflow plan revise acme20 --program plan.json/);

  const run = await launch(f, findProgram(), fakeDispatch(script));
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  const file = join(f.root, 'checks.json');
  // No route: this home configures no pool, and add checks a route against today's pools.
  writeFileSync(file, JSON.stringify({ steps: [{ id: 'check-f1', dependsOn: ['find'], prompt: 'Check finding f1.' }] }));
  const call = (...args) => spawnSync(process.execPath, [cli, 'workflow', 'add', ...args], { encoding: 'utf8', env });
  let out = call(run.shortId);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage: bullswarm workflow add/);
  out = call(run.shortId, '--steps', file, '--from-answer', 'find');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /mutually exclusive/);
  // The live kernel relaunch is replaced by a paused run: the addition applies and nothing starts.
  out = spawnSync(process.execPath, [cli, 'workflow', 'pause', run.shortId, '--json'], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  out = call(run.shortId, '--steps', file);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, new RegExp(`✓ added to ${run.shortId} · revision \\d+ \\(applied directly; the run stays paused\\)`));
  assert.match(out.stdout, /added {4}step check-f1/);
  assert.match(out.stdout, new RegExp(`wait {5}bullswarm workflow wait ${run.shortId} check-f1`));
});

test('the append-only check backs onto the round trip: a stored step that would renormalise differently is refused, never amended', async (t) => {
  const f = fixture(t);
  const run = await launch(f, findProgram(), fakeDispatch(script));
  const state = readState(run);
  // Every stored step normalises to itself.
  const stored = { schemaVersion: V3, actions: state.program.actions, control: state.program.control };
  assert.deepEqual(normaliseProgramV3(normaliseProgramV3(stored)).steps, state.program.actions);
  // A stored step missing a derived field would come back changed.
  const tampered = structuredClone(state);
  delete tampered.program.actions[0].inputs;
  const live = exportV2Plan(tampered).program.actions;
  const outcome = appendedActionsV3(tampered, appendedProgramV3(tampered, live, checkFragment(['f1'])), v2LiveProgramRuntime(tampered));
  assert.deepEqual(outcome.issues, ['workflow add would change step find of the run; nothing was added']);
  // A request that drops or edits one of the run's steps is refused too.
  const dropped = { ...appendedProgramV3(state, exportV2Plan(state).program.actions, checkFragment(['f1'])) };
  dropped.actions = dropped.actions.slice(1);
  const planned = planV2Revision(state, { program: dropped, append: true, rerun: [], steeringIds: [] });
  assert.equal(planned.ok, false);
  assert.match(planned.issues[0], /workflow add never changes or removes what the run has/);
});

// --- workflow wait ---------------------------------------------------------------

test('wait returns each id\'s facts and checked answer; a waiting gate is settled; exit 0', async (t) => {
  const f = fixture(t);
  const run = await launch(f, findProgram(), fakeDispatch(script));
  const result = await waitV3Nodes({ bullswarmDir: f.bullswarmDir, token: run.shortId, ids: ['find', 'review'], pollMs: 10 });
  assert.equal(result.code, 0);
  assert.equal(result.status, 'settled');
  assert.equal(result.run, 'waiting');
  const [find, review] = result.nodes;
  assert.equal(find.status, 'succeeded');
  assert.ok(['acme-pool', 'initech-pool'].includes(find.pool), find.pool);
  assert.equal(find.model, 'acme-model');
  assert.deepEqual(find.answer, findings);
  assert.equal(find.attempts, 1);
  assert.ok(Number.isInteger(find.durationSec));
  assert.deepEqual([review.type, review.status, review.note, review.next],
    ['gate', 'waiting', 'Add one check per finding, then continue', `bullswarm workflow continue ${run.shortId} review`]);

  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  const call = (...args) => spawnSync(process.execPath, [cli, 'workflow', 'wait', ...args], { encoding: 'utf8', env });
  let out = call(run.shortId, 'find', 'review');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /✓ find succeeded · (acme|initech)-pool · acme-model · \d+s/);
  assert.match(out.stdout, /  answer\n {4}\{\n {6}"findings": \[/);
  assert.match(out.stdout, /⧖ gate review waiting · Add one check per finding, then continue/);
  assert.match(out.stdout, new RegExp(`  continue bullswarm workflow continue ${run.shortId} review`));
  out = call(run.shortId, 'find', '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const document = JSON.parse(out.stdout);
  assert.equal(document.action, 'workflow-wait');
  assert.deepEqual(document.nodes[0].answer, findings);
  out = call(run.shortId, 'nowhere');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /has no step, gate or loop nowhere \(it has find, report, review\)/);
  out = call(run.shortId);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage: bullswarm workflow wait/);
});

test('wait exits 1 on a failed step and returns early when the run stops short of an id', async (t) => {
  const f = fixture(t);
  const run = await launch(f, findProgram(), fakeDispatch((id) => (id === 'find' ? { fail: 'provider' } : {})));
  assert.equal(run.result.status, 'partial');
  const failed = await waitV3Nodes({ bullswarmDir: f.bullswarmDir, token: run.shortId, ids: ['find'], pollMs: 10 });
  assert.equal(failed.code, 1);
  assert.equal(failed.status, 'settled');
  assert.equal(failed.nodes[0].status, 'failed');
  assert.equal(failed.nodes[0].answer, null);
  assert.equal(failed.nodes[0].failure.kind, 'provider');

  const parked = await launch(f, findProgram(), fakeDispatch(script));
  const stopped = await waitV3Nodes({ bullswarmDir: f.bullswarmDir, token: parked.shortId, ids: ['report'], pollMs: 10 });
  assert.equal(stopped.code, 1);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.why, 'the run is waiting');
  assert.equal(stopped.nodes[0].status, 'pending');
});

test('wait times out with exit 2 while a live run has not reached the id', async (t) => {
  const f = fixture(t);
  const run = await launch(f, findProgram(), fakeDispatch(script));
  const state = readState(run);
  state.lifecycle.status = 'running';
  delete state.lifecycle.waitingFor;
  writeFileSync(join(run.runDir, 'state.json'), JSON.stringify(state));
  const started = Date.now();
  const result = await waitV3Nodes({
    bullswarmDir: f.bullswarmDir, token: run.shortId, ids: ['report'], timeoutMs: 150, pollMs: 20,
    liveness: () => ({ checked: true, alive: true, reason: null }),
  });
  assert.equal(result.code, 2);
  assert.equal(result.status, 'timeout');
  assert.ok(Date.now() - started >= 150);
});
