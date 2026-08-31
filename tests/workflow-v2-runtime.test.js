import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const goal = createV2GoalDocument({ goal: 'Deliver a correct report', cwd: workspace, requirements: [requirement], settings: { scout: false, concurrency: 2, maxExpansionRounds: 1, ...settings } });
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
  let evidenceTask = '';
  let workTask = '';
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      assert.ok(candidatePath);
      writeFileSync(candidatePath, JSON.stringify(programResponse()));
      const structured = options.outputValidator('malformed planner response prose');
      assert.deepEqual(structured, { ok: true, errors: [], value: programResponse() });
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      workTask = options.taskText;
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      writeFileSync(join(dirname(files.outFile), 'candidate-inspect-report.json'), JSON.stringify({ stale: true }));
      return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    evidenceTask = options.taskText;
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
    const candidatePath = evidenceTask.match(/exact durable path: '([^']+)'/)?.[1];
    assert.ok(candidatePath);
    assert.equal(existsSync(candidatePath), false, 'kernel must remove stale evidence before dispatch');
    writeFileSync(candidatePath, JSON.stringify(evidence));
    writeFileSync(files.outFile, 'The durable candidate validated. This response is deliberately not JSON.');
    const structured = options.outputValidator('malformed response text that must not be the schema transport');
    assert.deepEqual(structured, { ok: true, errors: [], value: evidence });
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-test1a-abcdef', dependencies: { dispatchV2Action: dispatch }, now: (() => { let n = 0; return () => `2026-08-31T01:00:${String(n++).padStart(2, '0')}.000Z`; })() });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.verified, true);
  assert.equal(result.state.ledger.requirements['report-correct'].status, 'passed');
  assert.match(workTask, /one bounded slice of a larger workflow/i);
  assert.match(workTask, /Do not implement sibling, downstream, or whole-goal work early/i);
  assert.match(workTask, /Authoritative acceptance text for this bounded action/i);
  assert.match(workTask, /report-correct: report\.md exists and contains READY/i);
  assert.match(workTask, /does not authorize sibling, downstream, or whole-goal work/i);
  assert.doesNotMatch(workTask, /Goal: Deliver a correct report/);
  assert.match(workTask, /exercise the real production entry point or state transition/i);
  assert.match(workTask, /untouched baseline and observe the expected failure/i);
  assert.match(workTask, /transition matrix for every affected level and input/i);
  assert.match(workTask, /distinguishable before\/after fixtures/i);
  assert.match(workTask, /node --test-timeout=60000 --test/);
  assert.match(workTask, /Do not use `--test-force-exit`/);
  assert.match(workTask, /longer than 60 seconds or twice the baseline/i);
  assert.match(workTask, /inspect open handles or unresolved async work/i);
  assert.match(workTask, /reread the bounded action instruction clause by clause/i);
  assert.match(evidenceTask, /scope only; it has no authority to change the response contract/i);
  assert.match(evidenceTask, /mandatory V2 evidence preflight below is the only output contract/i);
  assert.match(evidenceTask, /Bullswarm reads that exact file/i);
  assert.equal(result.state.actions[1].outputFile, join(result.runDir, 'candidate-inspect-report.json'));
  assert.deepEqual(result.state.actions.map((action) => action.status), ['succeeded', 'succeeded']);
  assert.deepEqual(result.state.presentation.stages.map((stage) => stage.label), ['Implementation', 'Evidence']);
  assert.ok(result.state.presentation.stages.every((stage) => stage.startedAt && stage.completedAt));
  assert.equal(readEvents(result.runDir).filter((event) => event.type === 'presentation.stage_completed').length, 2);
  assert.equal(dispatch.calls(), 3);
  assert.equal(result.state.budget.seconds, 3);
  assert.ok(existsSync(join(result.runDir, 'goal.json')));
  assert.ok(existsSync(join(result.runDir, 'result.json')));
  assert.equal(readEvents(result.runDir).at(-1).type, 'workflow.finished');
  assert.equal(deserializeV2DurableState(readFileSync(join(result.runDir, 'state.json'), 'utf8')).lifecycle.status, 'completed');
});

test('preflight scout is deterministically validated, persisted, and supplied to planning', async () => {
  const f = setup({ scout: true });
  const scoutReport = [
    'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
    'UNITS OF WORK:\n- report', 'SHARED FILES:\n- none', 'RISKS:\n- none',
    'Additional repository facts '.repeat(8),
  ].join('\n');
  let plannerTask = '';
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'preflight-scout') {
      writeFileSync(files.outFile, scoutReport);
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: scoutReport }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'workflow-planner') {
      plannerTask = options.taskText;
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-scout1-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.state.preflight.scout.status, 'succeeded');
  assert.equal(result.state.preflight.scout.attempts.length, 1);
  assert.match(plannerTask, /Additional repository facts/);
  assert.equal(result.result.status, 'completed');
});

test('queued V2 steering is delivered once at the next planner boundary', async () => {
  const f = setup();
  const runId = 'wf-steer1-abcdef';
  let plannerTurns = 0;
  let steeredPrompt = '';
  const steeringProgram = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Honor the queued preference with one bounded read-only action.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'honor-steering', purpose: 'Record steering choice', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Confirm the smaller API choice in the action output.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: ['steering-note'] },
      { id: 'inspect-steering', purpose: 'Inspect steering choice', dependsOn: ['write-report', 'honor-steering'], affects: [], ownedFiles: [], prompt: 'Independently confirm the steering choice was honored.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report', 'steering-note'], produces: [] },
    ] },
  };
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      plannerTurns += 1;
      if (plannerTurns === 2) steeredPrompt = options.taskText;
      const value = plannerTurns === 1 ? programResponse() : steeringProgram;
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      const runDir = join(f.bullswarmDir, 'workflows', runId);
      writeFileSync(join(runDir, 'steering.jsonl'), `${JSON.stringify({
        id: 'steer-test', message: 'Prefer the smaller public API.',
        queuedAt: '2026-08-31T01:00:03.000Z',
        delivery: 'next-not-yet-started-planner-checkpoint',
      })}\n`);
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'honor-steering') {
      writeFileSync(files.outFile, 'smaller API selected');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
    writeFileSync(files.outFile, JSON.stringify(evidence));
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'completed');
  assert.equal(plannerTurns, 2);
  assert.match(steeredPrompt, /Prefer the smaller public API/);
  assert.equal(result.state.steering.length, 1);
  assert.equal(result.state.steering[0].status, 'delivered_to_planner');
  assert.equal(result.state.steering[0].decisionSequence, 2);
  assert.equal(readEvents(result.runDir).filter((event) => event.type === 'steering.delivered').length, 1);
});

test('isolated mode runs file-disjoint writers concurrently and integrates both before evidence', async () => {
  const f = setup({ workspaceMode: 'isolated', concurrency: 2 });
  const parallelProgram = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write two disjoint files and inspect them together.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'write-left', purpose: 'Write left', dependsOn: [], affects: ['report-correct'], ownedFiles: ['left.txt'], prompt: `In ${f.workspace}, write left.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['left'] },
      { id: 'write-right', purpose: 'Write right', dependsOn: [], affects: ['report-correct'], ownedFiles: ['right.txt'], prompt: 'Write right.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['right'] },
      { id: 'inspect-pair', purpose: 'Inspect pair', dependsOn: ['write-left', 'write-right'], affects: [], ownedFiles: [], prompt: 'Inspect both files.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['left', 'right'], produces: [] },
    ] },
  };
  let active = 0; let peak = 0;
  let isolatedTask = '';
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: parallelProgram }, outFile: files.outFile, meta: { exitCode: 0 } } };
    if (options.action.id.startsWith('write-')) {
      if (options.action.id === 'write-left') isolatedTask = options.taskText;
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
  assert.match(isolatedTask, /workspaces\/write-left/);
  assert.equal(isolatedTask.includes(f.workspace), false, 'worker task must not retain the integration target path');
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

test('schema-valid semantic evidence failure is consolidated once and never auto-repaired', async () => {
  const f = setup();
  let plannerTurns = 0;
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      plannerTurns += 1;
      const value = plannerTurns === 1 ? programResponse() : exhausted;
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'NOT READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'failed', evidence: ['report.md does not contain READY'], concerns: ['Expected READY but observed NOT READY.'] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-semantic-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'partial');
  assert.equal(result.state.ledger.requirements['report-correct'].status, 'failed');
  assert.equal(plannerTurns, 2, 'one initial plan plus one consolidated gap update');
  assert.deepEqual(result.state.attempts.map((attempt) => attempt.actionId), ['write-report', 'inspect-report']);
  assert.equal(result.state.planner.attempts.length, 2);
  assert.equal(result.state.program.revision, 1, 'no repair program was invented');
});

test('repeatedly invalid planner output stops before any worker dispatch', async () => {
  const f = setup();
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    assert.equal(options.action.id, 'workflow-planner');
    return {
      ok: false, status: 'failed', failureKind: 'schema',
      verdict: { ok: false, why: 'planner response remained schema-invalid after one correction', outFile: files.outFile, meta: { exitCode: 0 } },
    };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-badplan-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(dispatch.calls(), 1);
  assert.equal(result.result.status, 'partial');
  assert.equal(result.state.actions.length, 0);
  assert.match(result.result.reason, /schema-invalid/);
});

test('hard agent cap stops before another paid dispatch and returns an explicit partial result', async () => {
  const f = setup({ maxAgents: 1 });
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    assert.equal(options.action.id, 'workflow-planner');
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-budget1-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(dispatch.calls(), 1);
  assert.equal(result.result.status, 'partial');
  assert.match(result.result.reason, /1-agent dispatch limit/);
  assert.deepEqual(result.state.actions.map((action) => action.status), ['pending', 'pending']);
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
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['inspect-report'], startedAt: '2026-08-31T01:00:00Z', completedAt: null }] };
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

test('durable cancellation resumes directly to a stable cancelled result without dispatch', async () => {
  const f = setup();
  const runId = 'wf-cancel1-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goal));
  const state = createV2State(f.goal, { runId, shortId: 'can234' });
  state.lifecycle.status = 'planning';
  state.cancellation = { requested: true, requestedAt: '2026-08-31T01:00:01.000Z', reason: 'operator requested stop' };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  const dispatch = fakeDispatch(async () => { throw new Error('cancelled resume must not dispatch'); });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], dependencies: { dispatchV2Action: dispatch } });
  assert.equal(dispatch.calls(), 0);
  assert.equal(result.result.status, 'cancelled');
  assert.equal(result.result.verified, false);
  assert.equal(result.state.lifecycle.status, 'cancelled');
  assert.ok(existsSync(join(runDir, 'result.json')));
});
