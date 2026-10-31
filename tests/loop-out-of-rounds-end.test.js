// `workflow goal --out-of-rounds end` (0.38.19, docs/design/0.38.19-loops-end-themselves.md):
// a loop that runs out of rounds ends itself, reason `rounds-spent`, instead of
// waiting for `workflow continue`. The default `wait` is today's behaviour.
// The real kernel with a fake worker; made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2GoalDocument, deserializeV2DurableState, serializeV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { FINDINGS_ANSWER } from '../src/workflow/dry-loops.js';
import { loopOutcomes, requestContinue, applyContinueOffline } from '../src/workflow/gates-loops.js';
import { acquireKernelLease } from '../src/workflow/v2-process.js';

const cli = resolve('bin/bullswarm.js');
const V3 = 'bullswarm.workflow.program.v3';
const eventsOf = (run, type) => readEvents(run.runDir).filter((event) => event.type === type);
const node = (run, id) => run.state.controlNodes.find((record) => record.id === id);
const status = (run, id) => run.state.actions.find((action) => action.id === id)?.status;

function fixture(t, outOfRounds) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-loop-end-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goal = 'Harden the acme parser';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 3, ...(outOfRounds ? { outOfRounds } : {}) },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

function fakeDispatch(script = () => ({}), { seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push(options.action.id);
    return dispatchV2Action({
      ...options,
      pools: [connector('acme-pool')],
      dependencies: {
        watchOnce: async (_pool, task, targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn) ?? {};
          if (options.action.lane === 'build') writeFileSync(join(targetDir, `${options.action.id}.txt`), `turn ${turn} ${Math.random()}\n`);
          writeFileSync(files.taskFile, task);
          const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
          if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
          writeFileSync(files.outFile, `done ${options.action.id} turn ${turn}`);
          const checked = opts.outputValidator ? opts.outputValidator('') : { ok: true };
          const structured = { ok: checked.ok, errors: checked.errors ?? [], ...(checked.value !== undefined ? { value: checked.value } : {}) };
          return checked.ok
            ? { ok: true, why: 'structured output validated', structured, meta: { exitCode: 0, wallSec: 1 } }
            : { ok: false, why: 'structured output invalid', failureKind: 'schema', structured, meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
      },
    });
  };
}

const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Loop ends.', program });
const launch = (f, program, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
  initialPlannerResponse: response(program),
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
});
const resume = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
});

const passedAnswer = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };
const plainProgram = (maxRounds = 2) => ({
  schemaVersion: V3,
  steps: [
    { id: 'fix', prompt: 'Fix the acme widget.' },
    { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme widget.', answer: passedAnswer },
    { id: 'ship', dependsOn: ['polish'], prompt: 'Ship the acme widget.' },
  ],
  loops: [{ id: 'polish', steps: ['fix', 'check'], until: { step: 'check', field: 'passed' }, maxRounds }],
});
const never = fakeDispatch((id) => (id === 'check' ? { answer: { passed: false } } : {}));

const findingsAnswer = JSON.parse(JSON.stringify(FINDINGS_ANSWER));
const dryProgram = (maxRounds = 2) => ({
  schemaVersion: V3,
  steps: [
    { id: 'build', lane: 'build', prompt: 'Build the acme parser.' },
    { id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review the acme parser.', answer: findingsAnswer, areas: ['grammar', 'types'] },
    { id: 'fix', dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme parser.' },
    { id: 'ship', dependsOn: ['harden'], prompt: 'Ship the acme parser.' },
  ],
  loops: [{ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry: 1, nonFunctional: false, yield: false }, maxRounds }],
});
const findingEveryRound = fakeDispatch((id, turn) => (id.startsWith('review') ? { answer: { findings: [{ title: `Acme bug ${id} ${turn}`, inScope: true }] } } : {}));

test('(a) a plain loop out of rounds under `end` settles rounds-spent in the same pass; ship runs; the run completes', async (t) => {
  const f = fixture(t, 'end');
  const run = await launch(f, plainProgram(2), never);
  assert.equal(run.result?.status, 'completed', JSON.stringify(run.result));
  assert.deepEqual(run.waiting ?? [], []);
  assert.deepEqual([node(run, 'polish').status, node(run, 'polish').reason, node(run, 'polish').round], ['passed', 'rounds-spent', 2]);
  assert.equal(status(run, 'ship'), 'succeeded');
  assert.equal(eventsOf(run, 'loop.out-of-rounds').length, 0);
  assert.equal(eventsOf(run, 'workflow.waiting').length, 0, 'the run never parks');
  const passed = eventsOf(run, 'loop.passed')[0].payload;
  assert.deepEqual([passed.reason, passed.round, passed.of, passed.source], ['rounds-spent', 2, 2, 'flag']);
  assert.equal(loopOutcomes(run.state)[0].outcome, 'continued-unmet', 'read as the condition never held, like a caller continue');
  assert.equal(run.result.loops[0].outcome, 'continued-unmet');
});

test('(b) a dry loop with area reviewers under `end` likewise; the findings summary is still there', async (t) => {
  const f = fixture(t, 'end');
  const run = await launch(f, dryProgram(2), findingEveryRound);
  assert.equal(run.result?.status, 'completed', JSON.stringify(run.result));
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason], ['passed', 'rounds-spent']);
  assert.equal(status(run, 'ship'), 'succeeded');
  assert.equal(eventsOf(run, 'loop.passed')[0].payload.reason, 'rounds-spent');
  const loop = run.result.loops[0];
  assert.equal(loop.outcome, 'continued-unmet');
  assert.ok(loop.findings.known.length >= 2, JSON.stringify(loop.findings));
  assert.equal(eventsOf(run, 'workflow.waiting').length, 0);
});

test('(c) the default and an explicit `wait` keep waiting; continue still ends the loop as `continued`', async (t) => {
  for (const setting of [undefined, 'wait']) {
    const f = fixture(t, setting);
    const run = await launch(f, plainProgram(2), never);
    assert.deepEqual(run.waiting.map((entry) => entry.id), ['polish'], String(setting));
    assert.deepEqual([node(run, 'polish').status, node(run, 'polish').reason], ['waiting', 'out-of-rounds']);
    assert.equal(eventsOf(run, 'loop.out-of-rounds').length, 1);
    assert.equal(status(run, 'ship'), 'pending');
  }
});

test('(c2) a loop already waiting stays waiting under `end`; `continue --rounds` still works and the later round that runs out ends by itself', async (t) => {
  const f = fixture(t, 'wait');
  const run = await launch(f, plainProgram(2), never);
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['polish']);
  // An older run had no setting; switch the saved one to `end` as a later resume would see it.
  const file = join(run.runDir, 'state.json');
  const saved = deserializeV2DurableState(readFileSync(file, 'utf8'));
  saved.config.settings.outOfRounds = 'end';
  writeFileSync(file, serializeV2DurableState(saved));
  const still = await resume(f, run.runId, never);
  assert.deepEqual([node(still, 'polish').status, node(still, 'polish').reason], ['waiting', 'out-of-rounds'], 'unchanged');
  const intent = requestContinue(run.runDir, { nodeId: 'polish', rounds: 1 });
  const lease = acquireKernelLease(run.runDir);
  try {
    const state = deserializeV2DurableState(readFileSync(file, 'utf8'));
    assert.equal(applyContinueOffline(state, intent, { runDir: run.runDir, at: new Date().toISOString() }).applied, true);
    writeFileSync(file, serializeV2DurableState(state));
  } finally { lease.release(); }
  const done = await resume(f, run.runId, never);
  assert.deepEqual([node(done, 'polish').status, node(done, 'polish').reason, node(done, 'polish').round], ['passed', 'rounds-spent', 3]);
  assert.equal(done.result?.status, 'completed');
});

test('(d) the flag survives a save and reload of the state', async (t) => {
  const f = fixture(t, 'end');
  const run = await launch(f, plainProgram(2), never);
  const reloaded = deserializeV2DurableState(serializeV2DurableState(run.state));
  assert.equal(reloaded.config.settings.outOfRounds, 'end');
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8')).config.settings.outOfRounds, 'end');
});

test('(e) --out-of-rounds takes wait or end only: another value is a usage error, exit 2, in both forms', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-loop-end-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, 'plan.json');
  writeFileSync(program, JSON.stringify(plainProgram(2)));
  const home = join(root, 'home'); mkdirSync(home);
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' };
  const bad = (extra) => spawnSync(process.execPath, [cli, 'workflow', 'goal', 'Harden the acme parser', '--program', program, '--cwd', root, '--out-of-rounds', 'sometimes', ...extra], { env, encoding: 'utf8', input: '' });
  for (const extra of [[], ['--json']]) {
    const out = bad(extra);
    assert.equal(out.status, 2, out.stderr + out.stdout);
    assert.match(out.stderr, /--out-of-rounds must be wait or end/);
  }
  for (const value of ['wait', 'end']) {
    const ok = spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Harden the acme parser', '--program', program, '--cwd', root, '--out-of-rounds', value, '--json'], { env, encoding: 'utf8', input: '' });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  }
});
