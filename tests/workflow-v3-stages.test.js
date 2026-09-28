// A v3 run's stored stages are its phases (0.37.0, wave E): the kernel
// writes them at launch and again on every loop round, the state still
// validates, and the watch reports each phase once under its name. Found
// live: a loop round wrote a stage with a `phase` key the stored-state
// validator refuses, and the kernel stopped with the run interrupted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument, validateV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';

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

const PROGRAM = {
  schemaVersion: 'bullswarm.workflow.program.v3',
  steps: [
    { id: 'count', phase: 'research', prompt: 'Count the lines of README.md.',
      answer: { type: 'object', required: ['lines'], properties: { lines: { type: 'integer' } } } },
    { id: 'draft', phase: 'writing', dependsOn: ['count'], prompt: 'Draft the acme note.' },
    { id: 'check', phase: 'writing', dependsOn: ['draft'], prompt: 'Check the acme note.',
      answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
    { id: 'post', phase: 'publish', dependsOn: ['approve'], prompt: 'Post the acme note.' },
  ],
  loops: [{ id: 'polish', steps: ['draft', 'check'], until: { step: 'check', field: 'passed' }, maxRounds: 3 }],
  gates: [{ id: 'approve', dependsOn: ['polish'], note: 'Read the note' }],
};

test('a v3 run stores its phases as stages through a loop round and parks at its gate', async (t) => {
  const f = fixture(t);
  const dispatch = fakeDispatch((id, turn) => (id === 'count' ? { answer: { lines: 1 } }
    : id === 'check' ? { answer: { passed: turn >= 2 } } : {}));
  const run = await launch(f, PROGRAM, dispatch);
  const state = JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle.status, 'waiting', JSON.stringify(state.lifecycle));
  assert.doesNotThrow(() => validateV2DurableState(state));
  assert.deepEqual(state.presentation.stages.map((stage) => [stage.label, stage.actionIds]), [
    ['Phase 1 · research', ['count']],
    ['Phase 2 · writing', ['draft', 'check']],
    ['Phase 3 · publish', ['post']],
  ]);
  const labels = readEvents(run.runDir).filter((event) => event.type === 'presentation.stage_completed')
    .map((event) => event.payload?.label ?? event.payload?.stage?.label ?? null);
  assert.ok(labels.length > 0);
  assert.ok(labels.every((label) => /^Phase [12] · (research|writing)$/.test(label)), labels.join(' | '));
});
