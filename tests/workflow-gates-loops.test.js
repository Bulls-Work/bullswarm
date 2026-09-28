// Gates and loops in the kernel, wave B of 0.37.0 (design section 4): control
// nodes in the scheduler, gates that wait or pass by their `when`, loops that
// rerun their steps until their `until` holds, the waiting lifecycle, and
// `workflow continue`. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2DurableState, createV2GoalDocument, validateV2DurableState } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { scheduleV2Actions } from '../src/workflow/v2-scheduler.js';
import { runWorkflowWatch, watchSnapshot, watchTrouble } from '../src/workflow/watch-cli.js';
import {
  applyContinueOffline, previousRoundBlock, readContinueIntents, requestContinue, schedulerView,
} from '../src/workflow/gates-loops.js';
import { acquireKernelLease } from '../src/workflow/v2-process.js';
import { continueV2Run } from '../src/workflow/cli-steps.js';
import { deserializeV2DurableState, serializeV2DurableState } from '../src/workflow/v2-state.js';
import { v2V3Fixtures } from './fixtures/program-v3-fixtures.mjs';

const cli = resolve('bin/bullswarm.js');
const V3 = 'bullswarm.workflow.program.v3';
const types = (run) => readEvents(run.runDir).map((event) => event.type);
const eventsOf = (run, type) => readEvents(run.runDir).filter((event) => event.type === type);
const status = (run, id) => run.state.actions.find((action) => action.id === id)?.status;
const node = (run, id) => run.state.controlNodes.find((record) => record.id === id);

function v3Goal(cwd, goal = 'Deliver the acme brief') {
  return createV2GoalDocument({
    goal, cwd, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-gates-loops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, workspace, bullswarmDir, goalDocument: v3Goal(workspace) };
}

const response = (program) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Gates and loops.', program,
});

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch (its evidence checks run for real) with a fake worker.
// `script(actionId, turn, task)` returns {answer?, fail?, sleepMs?}; `turn`
// counts that step's worker runs from 1.
function fakeDispatch(script = () => ({}), { seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push({ actionId: options.action.id, evidenceAsCondition: options.evidenceAsCondition ?? false, task: options.taskText });
    return dispatchV2Action({
      ...options,
      pools: [connector('acme-pool')],
      dependencies: {
        watchOnce: async (_pool, task, _targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn, task) ?? {};
          if (plan.sleepMs) await new Promise((done) => setTimeout(done, plan.sleepMs));
          writeFileSync(files.taskFile, task);
          const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
          if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
          writeFileSync(files.outFile, plan.reply ?? `done ${options.action.id} turn ${turn}`);
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

function launch(f, program, dispatch) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: response(program),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
  });
}

function resume(f, runId, dispatch) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
  });
}

// Continue a parked run the way the CLI does with no live kernel.
function continueOffline(run, nodeId, rounds = null) {
  const intent = requestContinue(run.runDir, { nodeId, rounds });
  const lease = acquireKernelLease(run.runDir);
  try {
    const state = deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
    const outcome = applyContinueOffline(state, intent, { runDir: run.runDir, at: new Date().toISOString() });
    writeFileSync(join(run.runDir, 'state.json'), serializeV2DurableState(state));
    return { outcome, state };
  } finally { lease.release(); }
}

const passedAnswer = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };

const gateProgram = (gate = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'draft', prompt: 'Draft the acme brief.' },
    { id: 'publish', dependsOn: ['approve'], prompt: 'Publish the acme brief.' },
  ],
  gates: [{ id: 'approve', dependsOn: ['draft'], note: 'Read the draft and decide', ...gate }],
});

const loopProgram = ({ maxRounds = 3, until = { step: 'check', field: 'passed' }, check = {} } = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'fix', prompt: 'Fix the acme widget.' },
    { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme widget.', answer: passedAnswer, ...check },
    { id: 'ship', dependsOn: ['polish'], prompt: 'Ship the acme widget.' },
  ],
  loops: [{ id: 'polish', steps: ['fix', 'check'], until, maxRounds }],
});

// --- the scheduler -------------------------------------------------------------

test('control nodes in the scheduler: passed counts as success, waiting and blocked hold, nodes are never listed', () => {
  const actions = [
    { id: 'draft', dependsOn: [], ownedFiles: [] },
    { id: 'publish', dependsOn: ['approve'], ownedFiles: [] },
    { id: 'approve', type: 'gate', dependsOn: ['draft'], ownedFiles: [] },
  ];
  const run = (states) => scheduleV2Actions(actions, states);
  let schedule = run({ draft: 'succeeded', publish: 'pending', approve: 'passed' });
  assert.deepEqual(schedule.selected, ['publish']);
  schedule = run({ draft: 'succeeded', publish: 'pending', approve: 'waiting' });
  assert.deepEqual([schedule.selected, schedule.waiting.map((entry) => entry.id), schedule.blocked], [[], ['publish'], []]);
  schedule = run({ draft: 'failed', publish: 'pending', approve: 'pending' });
  assert.deepEqual(schedule.blocked.map((entry) => entry.id), ['publish'], 'a pending gate behind a failure blocks its dependents');
  schedule = run({ draft: 'pending', publish: 'pending', approve: 'pending' });
  assert.deepEqual(schedule.selected, ['draft'], 'the gate itself is never selected, waiting or blocked');
  assert.equal([...schedule.ready, ...schedule.waiting.map((entry) => entry.id)].includes('approve'), false);
  schedule = run({ draft: 'succeeded', publish: 'pending', approve: 'blocked' });
  assert.deepEqual(schedule.blocked.map((entry) => entry.id), ['publish']);
});

test('the scheduler view of a v2 run is its own lists, untouched', () => {
  const f = v2V3Fixtures();
  const state = applyV2PlannerResponse(createV2DurableState(createV2GoalDocument(f.goal), { runId: 'wf-acme-000009', shortId: 'acme09' }), f.response);
  const view = schedulerView(state);
  assert.equal(view.actions, state.program.actions);
  assert.equal(view.states, state.actions);
});

// --- gates ---------------------------------------------------------------------

test('a gate: its dependency runs, the gate waits, the run parks as waiting; continue passes it and the run finishes', async (t) => {
  const f = fixture(t);
  const seen = [];
  const run = await launch(f, gateProgram(), fakeDispatch(() => ({}), { seen }));
  assert.equal(run.result, null);
  assert.deepEqual(run.waiting.map((entry) => [entry.id, entry.type, entry.note]), [['approve', 'gate', 'Read the draft and decide']]);
  assert.equal(run.state.lifecycle.status, 'waiting');
  assert.deepEqual(run.state.lifecycle.waitingFor.map((entry) => entry.id), ['approve']);
  assert.equal(status(run, 'draft'), 'succeeded');
  assert.equal(status(run, 'publish'), 'pending');
  assert.equal(node(run, 'approve').status, 'waiting');
  assert.deepEqual(seen.map((entry) => entry.actionId), ['draft'], 'nothing behind the gate ran');
  assert.ok(types(run).includes('gate.waiting'));
  assert.ok(types(run).includes('workflow.waiting'));
  assert.equal(existsSync(join(run.runDir, 'result.json')), false, 'a waiting run has no result');
  assert.equal(validateV2DurableState(run.state), true);

  // A resume with nothing to do parks again and dispatches nothing.
  const again = await resume(f, run.runId, fakeDispatch(() => ({}), { seen }));
  assert.deepEqual(again.waiting.map((entry) => entry.id), ['approve']);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['draft']);

  const { outcome, state } = continueOffline(run, 'approve');
  assert.deepEqual(outcome, { applied: true, why: null });
  assert.equal(state.lifecycle.status, 'running');
  assert.equal(state.lifecycle.waitingFor, undefined);
  assert.ok(readContinueIntents(run.runDir)[0].appliedAt);
  const done = await resume(f, run.runId, fakeDispatch(() => ({}), { seen }));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['draft', 'publish']);
  assert.equal(node(done, 'approve').status, 'passed');
  assert.equal(done.state.lifecycle.waitingFor, undefined);
  const passed = eventsOf(done, 'gate.passed');
  assert.equal(passed.at(-1).payload.reason, 'continued');
});

test('a gate whose `when` does not hold passes by itself; one whose `when` holds waits', async (t) => {
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'merge', prompt: 'Merge the acme labels.', answer: { type: 'object', required: ['hasUncertain'], properties: { hasUncertain: { type: 'boolean' } } } },
      { id: 'report', dependsOn: ['rule'], prompt: 'Report the acme labels.' },
    ],
    gates: [{ id: 'rule', dependsOn: ['merge'], when: { step: 'merge', field: 'hasUncertain' } }],
  };
  const f = fixture(t);
  const done = await launch(f, program, fakeDispatch((id) => (id === 'merge' ? { answer: { hasUncertain: false } } : {})));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.equal(node(done, 'rule').status, 'passed');
  assert.equal(eventsOf(done, 'gate.passed')[0].payload.reason, 'when-false');
  assert.equal(eventsOf(done, 'gate.waiting').length, 0);

  const g = fixture(t);
  const parked = await launch(g, program, fakeDispatch((id) => (id === 'merge' ? { answer: { hasUncertain: true } } : {})));
  assert.deepEqual(parked.waiting.map((entry) => entry.id), ['rule']);
  assert.equal(status(parked, 'report'), 'pending');
});

test('a gate behind a failed step is blocked: its dependents are blocked and the run ends partial, never waiting', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch((id) => (id === 'draft' ? { fail: 'provider' } : {})));
  assert.equal(run.result.status, 'partial');
  assert.equal(status(run, 'draft'), 'failed');
  assert.equal(status(run, 'publish'), 'blocked');
  assert.equal(node(run, 'approve').status, 'blocked');
  assert.equal(eventsOf(run, 'gate.waiting').length, 0);
  assert.equal(run.state.lifecycle.waitingFor, undefined);
});

test('gate.waiting is emitted the moment the gate waits, while another branch still runs; the run parks after it', async (t) => {
  const f = fixture(t);
  const program = gateProgram();
  program.steps.push({ id: 'survey', prompt: 'Survey the initech archive.' });
  const run = await launch(f, program, fakeDispatch((id) => (id === 'survey' ? { sleepMs: 600 } : {})));
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['approve']);
  const events = readEvents(run.runDir);
  const waitingAt = events.find((event) => event.type === 'gate.waiting').sequence;
  const surveyDone = events.find((event) => event.type === 'action.finished' && event.payload.actionId === 'survey').sequence;
  assert.ok(waitingAt < surveyDone, 'the gate waits before the other branch finishes');
  assert.equal(status(run, 'survey'), 'succeeded');
  // --until trouble wakes on it while the run is still running.
  assert.equal(watchTrouble({ type: 'gate.waiting' }), 'waiting');
  assert.equal(watchTrouble({ type: 'loop.out-of-rounds' }), 'waiting');
  const running = structuredClone(run.state);
  delete running.lifecycle.waitingFor;
  running.lifecycle.status = 'running';
  running.runner = { pid: process.pid, startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString() };
  writeFileSync(join(run.runDir, 'state.json'), serializeV2DurableState(running));
  let text = '';
  const code = await runWorkflowWatch(f.bullswarmDir, run.shortId, {
    until: 'trouble', afterSequence: 0, intervalMs: 10, stale: false, output: { write: (chunk) => { text += chunk; } },
  });
  assert.equal(code, 0);
  assert.match(text, new RegExp(`gate approve waiting · Read the draft and decide · continue: bullswarm workflow continue ${run.shortId} approve`));
  assert.match(text, new RegExp(`next: bullswarm workflow watch ${run.shortId} --until trouble --after \\d+`));
  assert.doesNotMatch(text, /outcome: waiting/, 'woken by the event, not by the parked run');
});

test('a continue intent on disk is applied by the next kernel pass', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch());
  requestContinue(run.runDir, { nodeId: 'approve' });
  const done = await resume(f, run.runId, fakeDispatch());
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.equal(node(done, 'approve').status, 'passed');
  assert.ok(readContinueIntents(run.runDir)[0].appliedAt);
});

// --- loops ---------------------------------------------------------------------

test('a loop reruns its steps under the same ids until `until` holds, then its dependents run', async (t) => {
  const f = fixture(t);
  const seen = [];
  const run = await launch(f, loopProgram(), fakeDispatch((id, turn) => (id === 'check' ? { answer: { passed: turn >= 2 } } : {}), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['fix', 'check', 'fix', 'check', 'ship']);
  assert.deepEqual([node(run, 'polish').status, node(run, 'polish').round], ['passed', 2]);
  const check = run.state.actions.find((action) => action.id === 'check');
  assert.equal(check.attempts, 2);
  assert.equal(check.supersededAttempts, 1, 'round 1 is kept as a superseded attempt');
  assert.deepEqual(check.answer.value, { passed: true });
  assert.deepEqual(run.state.program.actions.map((action) => action.id), ['fix', 'check', 'ship'], 'no copied ids');
  assert.deepEqual(eventsOf(run, 'loop.round').map((event) => event.payload.round), [2]);
  assert.equal(eventsOf(run, 'loop.passed')[0].payload.round, 2);
  // Round 2's prompts carry the previous round.
  const round2Fix = seen[2].task;
  assert.match(round2Fix, /## Previous round \(loop polish, now round 2 of 3\)/);
  assert.match(round2Fix, /check\.passed is true did not hold after round 1/);
  assert.match(round2Fix, /answer: \{"passed":false\}/);
  assert.doesNotMatch(seen[0].task, /Previous round/);
});

test('a loop out of rounds waits; continue --rounds gives it more; continue without --rounds passes it', async (t) => {
  const f = fixture(t);
  const never = fakeDispatch((id) => (id === 'check' ? { answer: { passed: false } } : {}));
  const run = await launch(f, loopProgram({ maxRounds: 2 }), never);
  assert.deepEqual(run.waiting.map((entry) => [entry.id, entry.type]), [['polish', 'loop']]);
  assert.match(run.waiting[0].note, /out of rounds \(2 of 2\)/);
  assert.equal(eventsOf(run, 'loop.out-of-rounds').length, 1);
  assert.equal(status(run, 'ship'), 'pending');
  assert.equal(run.state.actions.find((action) => action.id === 'check').attempts, 2);

  const more = continueOffline(run, 'polish', 1);
  assert.equal(more.outcome.applied, true);
  const record = more.state.controlNodes.find((entry) => entry.id === 'polish');
  assert.deepEqual([record.status, record.round, record.maxRounds], ['pending', 3, 3]);
  const third = await resume(f, run.runId, never);
  assert.deepEqual(third.waiting.map((entry) => entry.id), ['polish']);
  assert.equal(third.state.actions.find((action) => action.id === 'check').attempts, 3);

  continueOffline(third, 'polish');
  const done = await resume(f, run.runId, never);
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.equal(status(done, 'ship'), 'succeeded');
  assert.equal(node(done, 'polish').reason, 'continued');
});

test('an evidence-form until: a failed check reads "checked, not passed" and the next round starts', async (t) => {
  const f = fixture(t);
  const counter = join(f.root, 'check-count.txt');
  const cmd = `"${process.execPath}" -e "const fs=require('fs');const p=${JSON.stringify(counter).replace(/"/g, '\\"')};const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1;fs.writeFileSync(p,String(n));console.log('round '+n);process.exit(n>=2?0:1)"`;
  const program = loopProgram({ until: { step: 'check', evidence: 'passed' }, check: { answer: undefined, evidence: [{ type: 'command', cmd }] } });
  delete program.steps[1].answer;
  const seen = [];
  const run = await launch(f, program, fakeDispatch(() => ({}), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => [entry.actionId, entry.evidenceAsCondition]), [
    ['fix', false], ['check', true], ['fix', false], ['check', true], ['ship', false],
  ]);
  const checks = run.state.attempts.filter((attempt) => attempt.actionId === 'check');
  assert.deepEqual(checks.map((attempt) => attempt.status), ['succeeded', 'succeeded']);
  assert.equal(checks[0].evidenceResults[0].status, 'failed');
  assert.ok((checks[0].notes ?? []).some((note) => note.kind === 'checked-not-passed'), 'round 1 is recorded checked, not passed');
  assert.equal(checks[0].failureKind, null);
  assert.equal(checks[1].evidenceResults[0].status, 'passed');
  assert.equal(checks.filter((attempt) => attempt.retryOf).length, 0, 'the failed check is not retried as a failure');
  assert.match(seen[2].task, /evidence command `.*`: failed/);
  assert.equal(node(run, 'polish').status, 'passed');
});

test('any other failure in a loop step fails it after its retry, and the loop is blocked', async (t) => {
  const f = fixture(t);
  const run = await launch(f, loopProgram(), fakeDispatch((id) => (id === 'fix' ? { fail: 'provider' } : {})));
  assert.equal(run.result.status, 'partial');
  assert.equal(status(run, 'fix'), 'failed');
  assert.equal(status(run, 'check'), 'blocked');
  assert.equal(status(run, 'ship'), 'blocked');
  assert.equal(node(run, 'polish').status, 'blocked');
  assert.equal(eventsOf(run, 'loop.blocked').length, 1);
});

test('previousRoundBlock is null outside a loop and in round 1', () => {
  const state = { program: { schemaVersion: V3, actions: [], control: { gates: [], loops: [] } }, actions: [], attempts: [] };
  assert.equal(previousRoundBlock(state, { id: 'fix' }), null);
});

// --- continue ----------------------------------------------------------------

test('workflow continue refuses what it cannot move, and applies a waiting node offline, then relaunches', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch());
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  const call = (...args) => spawnSync(process.execPath, [cli, 'workflow', 'continue', ...args], { encoding: 'utf8', env });
  const token = run.shortId;
  let out = call(token, 'nowhere');
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /no gate or loop nowhere \(it has gate approve\)/);
  out = call(token, 'approve', '--rounds', '2');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--rounds applies to a loop; approve is a gate/);
  out = call(token, 'approve', '--rounds', '9');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--rounds must be a whole number from 1 to 5/);
  out = call(token);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage: bullswarm workflow continue/);
  assert.equal(readContinueIntents(run.runDir).length, 0, 'a refusal writes no intent');

  const relaunched = [];
  const result = await continueV2Run({
    bullswarmDir: f.bullswarmDir, token, nodeId: 'approve', waitMs: 0,
    relaunch: async (runId) => { relaunched.push(runId); return { action: 'goal-resumed', runId }; },
  });
  assert.equal(result.code, 0);
  assert.equal(result.status, 'applied');
  assert.equal(result.appliedBy, 'offline');
  assert.deepEqual(relaunched, [run.runId]);
  const state = JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle.status, 'running');
  assert.equal(state.controlNodes.find((record) => record.id === 'approve').status, 'passed');
  out = call(token, 'approve');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /gate approve is passed; only a waiting gate or an out-of-rounds loop can be continued/);
});

test('a parked run can be cancelled (finalized at once) or paused (it parks again on resume)', async (t) => {
  const f = fixture(t);
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  const call = (...args) => spawnSync(process.execPath, [cli, 'workflow', ...args], { encoding: 'utf8', env });
  const paused = await launch(f, gateProgram(), fakeDispatch());
  let out = call('pause', paused.shortId, '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  let state = JSON.parse(readFileSync(join(paused.runDir, 'state.json'), 'utf8'));
  assert.deepEqual([state.lifecycle.status, state.lifecycle.waitingFor], ['paused', undefined]);
  rmSync(join(paused.runDir, 'pause.json'));
  const again = await resume(f, paused.runId, fakeDispatch());
  assert.deepEqual(again.waiting.map((entry) => entry.id), ['approve']);

  const cancelled = await launch(f, gateProgram(), fakeDispatch());
  out = call('cancel', cancelled.shortId, '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(JSON.parse(out.stdout).finalized, true);
  state = JSON.parse(readFileSync(join(cancelled.runDir, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle.status, 'cancelled');
  assert.equal(state.lifecycle.waitingFor, undefined);
  assert.equal(state.actions.find((action) => action.id === 'publish').status, 'cancelled');
});

// --- the caller's surfaces ------------------------------------------------------

test('watch ends on a waiting run with the continue command, in every mode', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch());
  const snapshot = watchSnapshot(run.runDir, run.state);
  assert.deepEqual(snapshot.waiting.map((entry) => entry.id), ['approve']);
  for (const opts of [{}, { until: 'trouble' }, { until: 'outcome' }, { next: true }, { classic: true }]) {
    let text = '';
    const code = await runWorkflowWatch(f.bullswarmDir, run.shortId, { ...opts, intervalMs: 10, stale: false, output: { write: (chunk) => { text += chunk; } } });
    assert.equal(code, 0, JSON.stringify(opts));
    assert.match(text, /outcome: waiting/, JSON.stringify(opts));
    assert.match(text, new RegExp(`next: bullswarm workflow continue ${run.shortId} approve`), JSON.stringify(opts));
  }
  let jsonl = '';
  await runWorkflowWatch(f.bullswarmDir, run.shortId, { jsonl: true, intervalMs: 10, stale: false, output: { write: (chunk) => { jsonl += chunk; } } });
  const last = JSON.parse(jsonl.trim().split('\n').at(-1));
  assert.equal(last.type, 'waiting');
  assert.deepEqual(last.waitingFor.map((entry) => entry.id), ['approve']);
});

test('a v2 watch snapshot carries no waiting key', () => {
  const f = v2V3Fixtures();
  const state = applyV2PlannerResponse(createV2DurableState(createV2GoalDocument(f.goal), { runId: 'wf-acme-000010', shortId: 'acme10' }), f.response);
  assert.equal(Object.hasOwn(watchSnapshot('/tmp/acme-nowhere', state), 'waiting'), false);
});

test('runs result on a waiting run prints the waiting nodes and the continue command, and exits 0', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch());
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  const human = spawnSync(process.execPath, [cli, 'workflow', 'runs', 'result', run.shortId], { encoding: 'utf8', env });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /outcome: waiting/);
  assert.match(human.stdout, /waiting: gate approve · Read the draft and decide/);
  assert.match(human.stdout, new RegExp(`next: bullswarm workflow continue ${run.shortId} approve`));
  const json = spawnSync(process.execPath, [cli, 'workflow', 'runs', 'result', run.shortId, '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout).status, 'waiting');
});

test('the stored control nodes validate; unknown ids and v2 programs are refused', async (t) => {
  const f = fixture(t);
  const run = await launch(f, gateProgram(), fakeDispatch());
  assert.equal(validateV2DurableState(run.state), true);
  const refused = (mutate, pattern) => {
    const copy = structuredClone(run.state);
    mutate(copy);
    assert.throws(() => validateV2DurableState(copy), pattern);
  };
  refused((s) => { s.controlNodes[0].id = 'nowhere'; }, /controlNodes\[0\]\.id must name a gate or loop/);
  refused((s) => { s.controlNodes[0].status = 'running'; }, /controlNodes\[0\]\.status must be pending\|waiting\|passed\|blocked/);
  refused((s) => { s.controlNodes[0].extra = 1; }, /controlNodes\[0\]\.extra is not allowed/);
  const v2 = v2V3Fixtures();
  const v2State = applyV2PlannerResponse(createV2DurableState(createV2GoalDocument(v2.goal), { runId: 'wf-acme-000011', shortId: 'acme11' }), v2.response);
  v2State.controlNodes = [];
  assert.throws(() => validateV2DurableState(v2State), /state\.controlNodes needs a v3 program/);
});

test('workflow goal --foreground launches a program with a gate, parks it and prints the continue command', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-gates-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'acme');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  const echo = JSON.parse(readFileSync(new URL('../src/providers/echo/connector.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify(echo));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } }));
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify(gateProgram()));
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0', BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const goal = spawnSync(process.execPath, [cli, 'workflow', 'goal', 'Deliver the acme brief', '--cwd', workspace, '--program', plan, '--foreground'], { encoding: 'utf8', env, cwd: workspace, timeout: 60_000 });
  assert.equal(goal.status, 0, goal.stdout + goal.stderr);
  assert.doesNotMatch(goal.stdout + goal.stderr, /next build/);
  assert.match(goal.stdout, /outcome: waiting/);
  assert.match(goal.stdout, /waiting: gate approve · Read the draft and decide/);
  assert.match(goal.stdout, /next: bullswarm workflow continue \S+ approve/);
  // --json (what the detached kernel prints): the waiting document.
  const second = spawnSync(process.execPath, [cli, 'workflow', 'goal', 'Deliver the initech brief', '--cwd', workspace, '--program', plan, '--foreground', '--json'], { encoding: 'utf8', env, cwd: workspace, timeout: 60_000 });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const document = JSON.parse(second.stdout);
  assert.equal(document.action, 'workflow-waiting');
  assert.equal(document.status, 'waiting');
  assert.deepEqual(document.waitingFor.map((entry) => [entry.id, entry.type, entry.note]), [['approve', 'gate', 'Read the draft and decide']]);
  assert.deepEqual(document.next, [`bullswarm workflow continue ${document.shortId} approve`]);
});
