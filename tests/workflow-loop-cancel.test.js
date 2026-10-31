// A cancelled run must not show its loop as still pending: the loop record
// says cancelled (round and rounds kept), the views say so, and reopening the
// run puts the loop back where it was. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { controlRows } from '../src/workflow/v3-display.js';
import { addV3Steps } from '../src/workflow/cli-steps.js';

const cli = resolve('bin/bullswarm.js');
const V3 = 'bullswarm.workflow.program.v3';
const readState = (run) => JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
const node = (state, id) => state.controlNodes.find((record) => record.id === id);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-loop-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goal = 'Polish the acme brief';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const response = (program) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'A loop.', program,
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

const loopProgram = () => ({
  schemaVersion: V3,
  steps: [
    { id: 'fix', prompt: 'Fix the acme brief.' },
    { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme brief.', answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
  ],
  loops: [{ id: 'polish', steps: ['fix', 'check'], until: { step: 'check', field: 'passed' }, maxRounds: 3 }],
});

test('a run cancelled in round 2 records its loop as cancelled, shows it so, and resumes in the same round', async (t) => {
  const f = fixture(t);
  const seen = [];
  let checks = 0;
  const running = launch(f, loopProgram(), fakeDispatch((id) => {
    if (id !== 'check') return { sleepMs: 50 };
    checks += 1;
    return { answer: { passed: false }, sleepMs: 150 };
  }, { seen }));
  // Cancel once round 2 has started (round 1's check is done and fix runs again).
  const workflows = join(f.bullswarmDir, 'workflows');
  let runDir = null;
  for (let waited = 0; waited < 20_000; waited += 20) {
    await new Promise((done) => setTimeout(done, 20));
    try {
      runDir = join(workflows, readdirSync(workflows)[0]);
      const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      if (checks >= 1 && state.actions.find((action) => action.id === 'fix')?.status === 'running') break;
    } catch { /* not written yet */ }
  }
  writeFileSync(join(runDir, 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: new Date().toISOString(), reason: 'acme stop' }));
  const run = await running;
  const state = readState(run);
  assert.equal(state.lifecycle.status, 'cancelled');
  assert.equal(state.actions.find((action) => action.id === 'check').status, 'cancelled');
  assert.equal(state.actions.find((action) => action.id === 'fix').status, 'succeeded');
  const loop = node(state, 'polish');
  assert.equal(loop.status, 'cancelled');
  assert.equal(loop.round, 2);
  assert.equal(loop.maxRounds, 3);

  // The views: no word of the loop being pending.
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir };
  delete env.BULLSWARM_DEPTH;
  for (const args of [['runs', 'show', run.shortId], ['runs', 'result', run.shortId]]) {
    const out = spawnSync(process.execPath, [cli, 'workflow', ...args], { encoding: 'utf8', env });
    const text = out.stdout + out.stderr;
    assert.match(text, /polish/, `workflow ${args.join(' ')} names the loop: ${text}`);
    assert.doesNotMatch(text, /loop polish[^\n]*(pending|round 2 of 3 · until)/i, `workflow ${args.join(' ')} must not call the loop pending: ${text}`);
  }
  const result = JSON.parse(readFileSync(join(run.runDir, 'result.json'), 'utf8'));
  assert.equal(result.loops.find((entry) => entry.id === 'polish').outcome, 'cancelled');
  // The row the timeline and the dashboard draw.
  const [row] = controlRows(state);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.role, 'cancelled');
  assert.match(row.text, /loop polish · cancelled in round 2 of 3/);

  // Reopen: add a step, resume. The loop is pending again in round 2, passes
  // there, and never reruns fix or exceeds its rounds.
  const added = await addV3Steps({
    bullswarmDir: f.bullswarmDir, token: run.shortId, fragment: { steps: [{ id: 'note', prompt: 'Note the acme result.' }] },
    waitMs: 0, relaunch: async (runId) => ({ action: 'goal-resumed', runId }),
  });
  assert.equal(added.status, 'applied');
  assert.equal(node(readState(run), 'polish').status, 'pending');
  assert.equal(node(readState(run), 'polish').round, 2);
  const fixRuns = seen.filter((entry) => entry.actionId === 'fix').length;
  const again = await resume(f, run.runId, fakeDispatch((id) => (id === 'check' ? { answer: { passed: true } } : {}), { seen }));
  assert.equal(again.state.lifecycle.status, 'completed');
  const done = node(again.state, 'polish');
  assert.deepEqual([done.status, done.round, done.maxRounds], ['passed', 2, 3]);
  assert.equal(seen.filter((entry) => entry.actionId === 'fix').length, fixRuns, 'fix does not rerun');
  assert.ok(done.round <= done.maxRounds);
});
