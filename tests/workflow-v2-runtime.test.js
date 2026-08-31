import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument, createV2State, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';

const requirement = { id: 'report-correct', text: 'report.md exists and contains READY' };
const programResponse = () => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
  summary: 'Write the report and independently inspect it.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
  ] },
});
const exhausted = {
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'exhausted',
  summary: 'No safe bounded action remains.', reason: 'The prior worker changed an undeclared path, so its work cannot be trusted.',
};

function setup(settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-runtime-'));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = createV2GoalDocument({ goal: 'Deliver a correct report', cwd: workspace, requirements: [requirement], settings: { concurrency: 2, maxExpansionRounds: 1, ...settings } });
  return { root, bullswarmDir, workspace, goal };
}

function fakeDispatch(handler) {
  let calls = 0;
  const dispatch = async (options) => {
    calls += 1;
    const files = typeof options.paths === 'function' ? options.paths(1) : options.paths;
    const startedAt = '2026-08-31T01:00:01.000Z';
    options.onAttempt?.('started', { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {} });
    const value = await handler(options, calls, files);
    const record = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: value.ok ? 'succeeded' : 'failed',
      startedAt, finishedAt: '2026-08-31T01:00:02.000Z', taskFile: files.taskFile, outFile: files.outFile,
      failureKind: value.failureKind ?? null, why: value.verdict?.why ?? null,
      usage: { tokens: { totalKnown: 10 } }, wallSec: 1, routing: {},
    };
    options.onAttempt?.('finished', record, value.verdict);
    return { attempts: [record], ...value };
  };
  dispatch.calls = () => calls;
  return dispatch;
}

test('runs a complete V2 program and kernel—not planner—writes verified result', async () => {
  const f = setup();
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
    writeFileSync(files.outFile, JSON.stringify(evidence));
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-test1a-abcdef', dependencies: { dispatchV2Action: dispatch }, now: (() => { let n = 0; return () => `2026-08-31T01:00:${String(n++).padStart(2, '0')}.000Z`; })() });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.verified, true);
  assert.equal(result.state.ledger.requirements['report-correct'].status, 'passed');
  assert.deepEqual(result.state.actions.map((action) => action.status), ['succeeded', 'succeeded']);
  assert.equal(dispatch.calls(), 3);
  assert.equal(result.state.budget.seconds, 3);
  assert.ok(existsSync(join(result.runDir, 'goal.json')));
  assert.ok(existsSync(join(result.runDir, 'result.json')));
  assert.equal(readEvents(result.runDir).at(-1).type, 'workflow.finished');
  assert.equal(deserializeV2DurableState(readFileSync(join(result.runDir, 'state.json'), 'utf8')).lifecycle.status, 'completed');
});

test('isolated mode runs file-disjoint writers concurrently and integrates both before evidence', async () => {
  const f = setup({ workspaceMode: 'isolated', concurrency: 2 });
  const parallelProgram = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write two disjoint files and inspect them together.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'write-left', purpose: 'Write left', dependsOn: [], affects: ['report-correct'], ownedFiles: ['left.txt'], prompt: 'Write left.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['left'] },
      { id: 'write-right', purpose: 'Write right', dependsOn: [], affects: ['report-correct'], ownedFiles: ['right.txt'], prompt: 'Write right.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['right'] },
      { id: 'inspect-pair', purpose: 'Inspect pair', dependsOn: ['write-left', 'write-right'], affects: [], ownedFiles: [], prompt: 'Inspect both files.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['left', 'right'], produces: [] },
    ] },
  };
  let active = 0; let peak = 0;
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: parallelProgram }, outFile: files.outFile, meta: { exitCode: 0 } } };
    if (options.action.id.startsWith('write-')) {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const name = options.action.id === 'write-left' ? 'left.txt' : 'right.txt';
      writeFileSync(join(options.targetDir, name), `${name}\n`);
      active -= 1;
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    assert.equal(existsSync(join(f.workspace, 'left.txt')), true);
    assert.equal(existsSync(join(f.workspace, 'right.txt')), true);
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['both files integrated'], concerns: [] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-isolate-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'completed');
  assert.equal(peak, 2);
  assert.equal(readFileSync(join(f.workspace, 'left.txt'), 'utf8'), 'left.txt\n');
  assert.equal(readFileSync(join(f.workspace, 'right.txt'), 'utf8'), 'right.txt\n');
});

test('out-of-scope work becomes one consolidated gap and returns useful partial outcome', async () => {
  const f = setup();
  let plannerTurns = 0;
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      plannerTurns += 1;
      const value = plannerTurns === 1 ? programResponse() : exhausted;
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
    writeFileSync(join(f.workspace, 'undeclared.txt'), 'unsafe\n');
    return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-test2a-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'partial');
  assert.equal(result.result.verified, false);
  assert.equal(plannerTurns, 2);
  assert.equal(result.state.actions.find((action) => action.id === 'write-report').lastFailure.kind, 'ownership');
  assert.equal(result.state.actions.find((action) => action.id === 'inspect-report').status, 'blocked');
  assert.match(result.result.reason, /undeclared path|cannot be trusted/);
});

test('resume mechanically requeues an interrupted V2 action and rejects old run shapes', async () => {
  const f = setup();
  const runId = 'wf-test3a-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goal));
  const state = createV2State(f.goal, { runId, shortId: 'abc234' });
  state.lifecycle = { status: 'running', startedAt: '2026-08-31T01:00:00Z', finishedAt: null, resultFile: null };
  state.planner = { status: 'waiting', turns: 1, lastDecision: { kind: 'program', summary: 'Inspect directly.' }, session: null, attempts: [] };
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: [], produces: [] },
  ] };
  state.actions = [{ id: 'inspect-report', status: 'running', attempts: 1, programRevision: 1, workRevision: 'initial', startedAt: '2026-08-31T01:00:00Z', finishedAt: null, outputFile: null, artifactIds: [], lastFailure: null }];
  state.attempts = [{ id: 'inspect-report-1', actionId: 'inspect-report', ordinal: 1, status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-08-31T01:00:00Z', finishedAt: null }];
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
  const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
  const dispatch = fakeDispatch(async (_options, _calls, files) => ({ ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } }));
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.state.attempts[0].status, 'interrupted');
  assert.equal(result.state.attempts[1].status, 'succeeded');

  const oldDir = join(f.bullswarmDir, 'workflows', 'wf-oldrun-abcdef');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'state.json'), JSON.stringify({ schemaVersion: 'bullswarm.workflow.state.v1' }));
  await assert.rejects(() => runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-oldrun-abcdef', pools: [] }), /unsupported old autonomous run/);
});
