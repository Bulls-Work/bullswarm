// A continue intent that did not come through the CLI parser (a rounds value
// outside 1-5) is refused like any kernel refusal, and a refused continue
// wakes `watch --until trouble`. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { applyContinueOffline, controlTrouble, readContinueIntents, requestContinue } from '../src/workflow/gates-loops.js';
import { acquireKernelLease } from '../src/workflow/v2-process.js';
import { deserializeV2DurableState, serializeV2DurableState } from '../src/workflow/v2-state.js';

const V3 = 'bullswarm.workflow.program.v3';
const eventsOf = (run, type) => readEvents(run.runDir).filter((event) => event.type === type);
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
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Continue intents.', program,
});

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch (its evidence checks run for real) with a fake worker.
// `script(actionId, turn, task)` returns {answer?, fail?, sleepMs?, write?}; `turn`
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
        watchOnce: async (_pool, task, targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn, task) ?? {};
          if (plan.sleepMs) await new Promise((done) => setTimeout(done, plan.sleepMs));
          for (const [path, body] of Object.entries(plan.write ?? {})) writeFileSync(join(targetDir, path), body);
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

const loopProgram = ({ maxRounds = 3, until = { step: 'check', field: 'passed' }, check = {} } = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'fix', prompt: 'Fix the acme widget.' },
    { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme widget.', answer: passedAnswer, ...check },
    { id: 'ship', dependsOn: ['polish'], prompt: 'Ship the acme widget.' },
  ],
  loops: [{ id: 'polish', steps: ['fix', 'check'], until, maxRounds }],
});

const never = () => fakeDispatch((id) => (id === 'check' ? { answer: { passed: false } } : {}));

test('a continue intent with rounds outside 1-5 is refused, never thrown, and leaves maxRounds alone', async (t) => {
  const f = fixture(t);
  const run = await launch(f, loopProgram({ maxRounds: 2 }), never());
  assert.equal(node(run, 'polish').status, 'waiting');
  for (const rounds of ['2', -1, 0, 1.5, 6]) {
    const before = eventsOf(run, 'control.continue_refused').length;
    let result;
    assert.doesNotThrow(() => { result = continueOffline(run, 'polish', rounds); }, `rounds ${JSON.stringify(rounds)}`);
    assert.equal(result.outcome.applied, false, `rounds ${JSON.stringify(rounds)}`);
    assert.match(result.outcome.why, new RegExp(`rounds.*${String(rounds).replace('.', '\\.')}`));
    const record = result.state.controlNodes.find((entry) => entry.id === 'polish');
    assert.deepEqual([record.status, record.round, record.maxRounds], ['waiting', 2, 2], `rounds ${JSON.stringify(rounds)}`);
    const refused = eventsOf(run, 'control.continue_refused');
    assert.equal(refused.length, before + 1, 'one refusal event');
    assert.equal(refused.at(-1).payload.nodeId, 'polish');
    assert.match(refused.at(-1).payload.why, /rounds/);
    assert.ok(readContinueIntents(run.runDir).every((intent) => intent.appliedAt), 'the intent is marked handled');
  }
});

test('the kernel pass refuses an out-of-range continue intent instead of throwing', async (t) => {
  const f = fixture(t);
  const run = await launch(f, loopProgram({ maxRounds: 2 }), never());
  requestContinue(run.runDir, { nodeId: 'polish', rounds: 6 });
  const again = await resume(f, run.runId, never());
  assert.equal(eventsOf(again, 'control.continue_refused').length, 1);
  assert.deepEqual([node(again, 'polish').status, node(again, 'polish').maxRounds], ['waiting', 2]);
});

test('rounds 3 still extends the loop by 3', async (t) => {
  const f = fixture(t);
  const run = await launch(f, loopProgram({ maxRounds: 2 }), never());
  const { outcome, state } = continueOffline(run, 'polish', 3);
  assert.equal(outcome.applied, true);
  assert.equal(state.controlNodes.find((entry) => entry.id === 'polish').maxRounds, 5);
});

test('a refused continue is a wake for watch --until trouble', () => {
  assert.ok(controlTrouble({ type: 'control.continue_refused', nodeId: 'polish', why: 'rounds -1 is not a whole number from 1 to 5' }));
});
