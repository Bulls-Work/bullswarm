// An `- outside: none` placeholder is not a blocker: outsideBlockers drops it,
// and a failed check whose report holds only one still gets its automatic retry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { outsideBlockers } from '../src/workflow/time-box.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';

const REQUIREMENT = { id: 'deliver', text: 'Deliver the requested files and validate them.' };

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

function gitRepo(workspace) {
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
}

// `v3`: the goal carries the implicit requirement a v3 program needs.
function fixture(t, settings = {}, { v3 = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-evidence-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bullswarmDir, { recursive: true });
  gitRepo(workspace);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: v3 ? implicitV3Requirements('Deliver the requested files') : [REQUIREMENT],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1, ...settings },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const step = (over = {}) => ({
  id: 'write', purpose: 'Deliver write', dependsOn: [], affects: ['deliver'], ownedFiles: ['write.txt'],
  prompt: 'Write write.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  ...over,
});

const program = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write and check.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

// The real dispatch with a fake worker. `worker` edits the workspace it is
// handed; `runStepEvidence` replaces the real runner only where a test needs
// to stage a moment (a kernel signal mid-check).
function realDispatch({ worker = null, runStepEvidence = null, seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  return (options) => {
    seen.push(options);
    return dispatchV2Action({
      ...options,
      pools: [connector('codex')],
      dependencies: {
        watchOnce: async (_pool, task, targetDir, files) => {
          writeFileSync(files.taskFile, task);
          await worker?.({ targetDir, files, task, options });
          if (!existsSync(files.outFile)) writeFileSync(files.outFile, 'done\n');
          return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
        ...(runStepEvidence ? { runStepEvidence } : {}),
      },
    });
  };
}

// `steps` launches a v3 program (f from fixture(t, settings, { v3: true })).
function launch(f, { runId, actions, steps, dispatch, dependencies = {} }) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId, parentEnv: {},
    initialPlannerResponse: steps ? programV3(steps) : program(actions),
    dependencies: { savedRunTwin: true, refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
  });
}

const eventsOf = (runDir, type) => readEvents(runDir).filter((event) => event.type === type);

const report = (line) => `## Done\n- wrote write.txt\n\n## Not done\n${line}\n`;

test('outsideBlockers drops a placeholder after `outside:`', () => {
  for (const rest of ['none', 'n/a', 'na', 'nothing', 'no', '-', 'nil', 'null', 'none found', 'no blockers', 'no blocker', 'None.', 'N/A!', '  NONE  ', '']) {
    assert.deepEqual(outsideBlockers(report(`- outside: ${rest}`)), [], JSON.stringify(rest));
  }
  assert.deepEqual(outsideBlockers(report('- **outside:** none')), []);
});

test('outsideBlockers keeps a real blocker', () => {
  assert.deepEqual(outsideBlockers(report('- outside: tests/a.js fails')), ['tests/a.js fails']);
  assert.deepEqual(outsideBlockers(report('- outside: none of the tests pass')), ['none of the tests pass']);
});

test('an `outside: none` report still gets the failed check\'s automatic retry', async (t) => {
  const f = fixture(t);
  const run = await launch(f, {
    runId: 'wf-outnone-abcdef',
    actions: [step({ evidence: [{ type: 'command', cmd: 'echo "acme check: write.txt says nope" && grep -q ready write.txt' }] })],
    dispatch: realDispatch({
      worker: ({ targetDir, files }) => { writeFileSync(join(targetDir, 'write.txt'), 'nope\n'); writeFileSync(files.outFile, report('- outside: none')); },
    }),
  });
  assert.equal(run.state.attempts.length, 2, 'the gate retry ran');
  assert.deepEqual(run.state.attempts.map((a) => a.failureKind), ['failed-evidence', 'failed-evidence']);
  for (const attempt of run.state.attempts) {
    assert.equal(Object.hasOwn(attempt, 'outsideBlockers') && attempt.outsideBlockers.length > 0, false);
    assert.doesNotMatch(String(attempt.why), /retry skipped/);
  }
  const finished = readEvents(run.runDir).filter((e) => e.type === 'attempt.finished').map((e) => e.payload.willRetry);
  assert.deepEqual(finished, [true, false]);
});
