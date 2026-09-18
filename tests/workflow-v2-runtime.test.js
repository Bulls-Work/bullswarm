import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { createV2GoalDocument, createV2State, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { readGoalProject } from '../src/workflow/goal.js';
import { readRollup, readRollupIndex, readRollups, rollupIndexPath } from '../src/workflow/rollup.js';

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

function fakeDispatch(handler, { reasoning = undefined } = {}) {
  let calls = 0;
  const resolved = reasoning === undefined ? {} : { reasoning };
  const dispatch = async (options) => {
    calls += 1;
    const files = typeof options.paths === 'function' ? options.paths(1) : options.paths;
    const startedAt = '2026-08-31T01:00:01.000Z';
    options.onAttempt?.('started', { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {}, ...resolved });
    const value = await handler(options, calls, files);
    const record = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: value.ok ? 'succeeded' : 'failed',
      startedAt, finishedAt: '2026-08-31T01:00:02.000Z', taskFile: files.taskFile, outFile: files.outFile,
      failureKind: value.failureKind ?? null, why: value.verdict?.why ?? null,
      usage: { tokens: { totalKnown: 10 } }, wallSec: 1, routing: {}, ...resolved,
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
  let evidenceRouting = null;
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
    evidenceRouting = options.evidence;
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
  assert.match(workTask, /Authoritative requirement context for this bounded acceptance slice/i);
  assert.match(workTask, /report-correct: report\.md exists and contains READY/i);
  assert.match(workTask, /Other clauses remain sibling work/i);
  assert.match(workTask, /Exact ownedFiles are an absolute mutation boundary/i);
  assert.doesNotMatch(workTask, /Goal: Deliver a correct report/);
  assert.match(workTask, /exercise the real production entry point or state transition/i);
  assert.match(workTask, /untouched baseline and observe the expected failure/i);
  assert.match(workTask, /transition matrix for every affected level and input/i);
  assert.match(workTask, /distinguishable before\/after fixtures/i);
  assert.match(workTask, /node --test-timeout=60000 --test/);
  assert.match(workTask, /Do not use `--test-force-exit`/);
  assert.match(workTask, /longer than 60 seconds or twice the baseline/i);
  assert.match(workTask, /inspect open handles or unresolved async work/i);
  assert.match(workTask, /reread the action purpose and final instructions clause by clause/i);
  assert.match(workTask, /leave sibling clauses to their named actions/i);
  assert.match(workTask, /universal, negative, and boundary qualifiers as separate mandatory checks/i);
  assert.match(workTask, /every applicable level, mode, and supported width/i);
  assert.match(workTask, /authoritative acceptance text outranks existing implementation and tests/i);
  assert.match(workTask, /do not preserve the contradiction merely because the baseline is green/i);
  assert.match(workTask, /captures your final response verbatim as this action's durable output artifact/i);
  assert.match(workTask, /Do not create, overwrite, or point to a file under the Bullswarm run directory/i);
  assert.match(workTask, /complete substantive report in the final response itself/i);
  assert.match(workTask, /separate workspace artifact is valid only when it is explicitly listed in ownedFiles/i);
  assert.match(evidenceTask, /scope only; it has no authority to change the response contract/i);
  assert.match(evidenceTask, /mandatory V2 evidence preflight below is the only output contract/i);
  assert.match(evidenceTask, /Bullswarm reads that exact file/i);
  assert.deepEqual(evidenceRouting, { writerPools: ['relay'] });
  assert.equal(result.state.actions[1].outputFile, join(result.runDir, 'candidate-inspect-report.json'));
  assert.deepEqual(result.state.actions.map((action) => action.status), ['succeeded', 'succeeded']);
  assert.deepEqual(result.state.presentation.stages.map((stage) => stage.label), ['Implementation', 'Evidence']);
  assert.ok(result.state.presentation.stages.every((stage) => stage.startedAt && stage.completedAt));
  assert.equal(readEvents(result.runDir).filter((event) => event.type === 'presentation.stage_completed').length, 2);
  assert.equal(dispatch.calls(), 3);
  assert.equal(result.state.budget.seconds, 3);
  assert.equal(result.state.attempts.length, 2);
  for (const attempt of result.state.attempts) {
    assert.equal(attempt.routeWhy, null);
    assert.equal(attempt.routeCandidates, null);
  }
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
  assert.equal(result.state.cancellation.requested, false, 'semantic evidence must never impersonate operator cancellation');
  assert.equal(result.state.cancellation.requestedAt, null);
  assert.equal(
    readEvents(result.runDir).some((event) => event.type === 'workflow.cancellation_requested'),
    false,
    'semantic evidence failure must not emit an operator cancellation event',
  );
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

test('agent target guides planning but never stops essential dispatches', async () => {
  const f = setup({ maxAgents: 1 });
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-budget1-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(dispatch.calls(), 3);
  assert.equal(result.state.budget.agents, 3);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(result.state.actions.map((action) => action.status), ['succeeded', 'succeeded']);
});

test('expansion target never prevents essential gap closure', async () => {
  const f = setup({ maxExpansionRounds: 1, maxActions: 2 });
  const revisions = [
    programResponse(),
    {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Revise and recheck once.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'revise-report', purpose: 'Revise report', dependsOn: ['write-report'], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Revise report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['revised-report'] },
        { id: 'recheck-report', purpose: 'Recheck report', dependsOn: ['revise-report'], affects: [], ownedFiles: [], prompt: 'Recheck report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['revised-report'], produces: [] },
      ] },
    },
    {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Finish and independently confirm the remaining gap.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'finish-report', purpose: 'Finish report', dependsOn: ['revise-report'], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Finish report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['finished-report'] },
        { id: 'final-check', purpose: 'Check final report', dependsOn: ['finish-report'], affects: [], ownedFiles: [], prompt: 'Check report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['finished-report'], produces: [] },
      ] },
    },
  ];
  let plannerTurn = 0;
  let evidenceTurn = 0;
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      const value = revisions[plannerTurn++];
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (!options.action.evidenceFor.length) {
      writeFileSync(join(f.workspace, 'report.md'), options.action.id === 'finish-report' ? 'READY\n' : 'NOT READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    evidenceTurn += 1;
    const status = evidenceTurn === 3 ? 'passed' : 'failed';
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status, evidence: [`check ${evidenceTurn}`], concerns: status === 'passed' ? [] : ['still incomplete'] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-softexp-abcdef', dependencies: { dispatchV2Action: dispatch } });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.state.budget.expansions, 2);
  assert.equal(result.state.program.actions.length, 6);
  assert.equal(result.state.ledger.requirements['report-correct'].status, 'passed');
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

test('resume reconciles an atomically published result after a crash before terminal state persistence', async () => {
  const f = setup();
  const runId = 'wf-crash1-abcdef';
  const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  let injected = false;
  await assert.rejects(() => runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId,
    dependencies: {
      dispatchV2Action: dispatch,
      writeResultAtomic(path, value) {
        writeJsonAtomic(path, value);
        if (!injected) { injected = true; throw new Error('simulated crash after result publication'); }
      },
    },
  }), /simulated crash/);

  const runDir = join(f.bullswarmDir, 'workflows', runId);
  assert.ok(existsSync(join(runDir, 'result.json')));
  assert.notEqual(deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8')).lifecycle.status, 'completed');

  const noDispatch = fakeDispatch(async () => { throw new Error('reconciliation must not dispatch'); });
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: noDispatch },
  });
  assert.equal(noDispatch.calls(), 0);
  assert.equal(resumed.result.status, 'completed');
  assert.equal(resumed.state.lifecycle.status, 'completed');
  assert.equal(resumed.state.lifecycle.resultFile, join(runDir, 'result.json'));
  assert.equal(readEvents(runDir).at(-1).payload.recovered, true);
});

test('every dispatch re-reads pools through the refresher, not the launch list', async () => {
  const f = setup();
  const launchPools = [{ name: 'launch-snapshot', enabled: true, lanes: ['analyze', 'build', 'chore'], pace: 0 }];
  // Each refresh reports a different live list, so the pools handed to a
  // dispatch identify exactly which refresh produced them.
  const refreshed = [
    [{ name: 'refresh-1', enabled: true, lanes: ['analyze', 'build', 'chore'], pace: 0, fiveHourUsedPct: 3, nearFiveHourLimit: false }],
    [{ name: 'refresh-2', enabled: true, lanes: ['analyze', 'build', 'chore'], pace: 0, fiveHourUsedPct: 82, nearFiveHourLimit: true }],
    [{ name: 'refresh-3', enabled: true, lanes: ['analyze', 'build', 'chore'], pace: 0, fiveHourUsedPct: 40, nearFiveHourLimit: false }],
  ];
  const refreshCalls = [];
  const refreshPools = async (opts = {}) => {
    refreshCalls.push(opts);
    return refreshed[Math.min(refreshCalls.length - 1, refreshed.length - 1)];
  };

  const seen = [];
  const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    seen.push({
      actionId: options.action.id,
      pools: options.pools.map((pool) => pool.name),
      refreshPools: options.refreshPools,
    });
    if (options.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });

  const result = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: launchPools,
    runId: 'wf-refresh-abcdef', dependencies: { dispatchV2Action: dispatch, refreshPools },
  });
  assert.equal(result.result.status, 'completed');

  assert.deepEqual(seen.map((entry) => entry.actionId), ['workflow-planner', 'write-report', 'inspect-report']);
  // One refresh per dispatch, each dispatch seeing its own refresh's list.
  assert.deepEqual(seen.map((entry) => entry.pools), [['refresh-1'], ['refresh-2'], ['refresh-3']]);
  assert.equal(refreshCalls.length, 3);
  // The launch-time snapshot never reaches a dispatch again.
  assert.equal(seen.some((entry) => entry.pools.includes('launch-snapshot')), false);
  // The dispatch loop gets the refresher itself so it can re-read between its
  // own retries (forced after a quota failure).
  for (const entry of seen) assert.equal(entry.refreshPools, refreshPools);
});

test('a refresh that throws or returns garbage never fails the run', async () => {
  const f = setup();
  const launchPools = [{ name: 'launch-snapshot', enabled: true, lanes: ['analyze', 'build', 'chore'], pace: 0 }];
  let calls = 0;
  const refreshPools = async () => {
    calls += 1;
    if (calls === 1) throw new Error('meter registry exploded');
    return null; // contract violation from a future refresher
  };
  const seen = [];
  const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    seen.push(options.pools.map((pool) => pool.name));
    if (options.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });

  const result = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: launchPools,
    runId: 'wf-refbad-abcdef', dependencies: { dispatchV2Action: dispatch, refreshPools },
  });
  assert.equal(result.result.status, 'completed');
  assert.equal(calls, 3);
  // Every dispatch still had a usable list: the last known good one.
  assert.deepEqual(seen, [['launch-snapshot'], ['launch-snapshot'], ['launch-snapshot']]);
});

test('the kernel carries the per-action reasoning override and the run-wide level into every dispatch', async () => {
  const f = setup({ scout: true });
  // Both routing objects carry a run-wide level; the program overrides it on
  // exactly one action so the two layers are distinguishable in the options.
  f.goal.config.workerRouting = { reasoning: 'high' };
  f.goal.config.plannerRouting = { reasoning: 'xhigh' };
  const reasoningProgram = () => ({
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Write the report at maximum depth and inspect it at the run-wide level.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', reasoning: 'max', evidenceFor: [], inputs: [], produces: ['report'] },
      { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
    ] },
  });
  const scoutReport = [
    'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
    'UNITS OF WORK:\n- write-report', 'SHARED FILES:\n- none', 'RISKS:\n- none',
    'Additional repository facts '.repeat(8), '["write-report"]',
  ].join('\n');
  const options = new Map();
  const dispatch = fakeDispatch(async (opts, _calls, files) => {
    options.set(opts.action.id, { reasoningOverride: opts.reasoningOverride, runReasoning: opts.runReasoning });
    if (opts.action.id === 'preflight-scout') {
      writeFileSync(files.outFile, scoutReport);
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: scoutReport }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (opts.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: reasoningProgram() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (opts.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const result = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [],
    runId: 'wf-reason-abcdef', dependencies: { dispatchV2Action: dispatch },
  });
  assert.equal(result.result.status, 'completed');
  // Program action with its own level: the override wins and the run-wide
  // level still travels so the resolver can see both layers.
  assert.deepEqual(options.get('write-report'), { reasoningOverride: 'max', runReasoning: 'high' });
  // Program action without one: no override, run-wide level only.
  assert.deepEqual(options.get('inspect-report'), { reasoningOverride: null, runReasoning: 'high' });
  // Kernel-owned dispatches are not program actions, so they never carry an override.
  assert.deepEqual(options.get('preflight-scout'), { reasoningOverride: undefined, runReasoning: 'high' });
  assert.deepEqual(options.get('workflow-planner'), { reasoningOverride: undefined, runReasoning: 'xhigh' });
});

test('a resolved reasoning record survives dispatch into the durable attempt and the started event', async () => {
  const f = setup();
  const resolved = { requested: 'xhigh', applied: 'high', source: 'run', clamped: true };
  const dispatch = fakeDispatch(async (opts, _calls, files) => {
    if (opts.action.id === 'workflow-planner') {
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: programResponse() }, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (opts.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['READY found'], concerns: [] } } };
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: { value: evidence }, outFile: files.outFile, meta: { exitCode: 0 } } };
  }, { reasoning: resolved });
  const result = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [],
    runId: 'wf-reasrec-abcdef', dependencies: { dispatchV2Action: dispatch },
  });
  assert.equal(result.result.status, 'completed');
  for (const attempt of result.state.attempts) assert.deepEqual(attempt.reasoning, resolved);
  assert.deepEqual(result.state.planner.attempts[0].reasoning, resolved);
  const started = readEvents(result.runDir).filter((event) => event.type === 'attempt.started');
  assert.equal(started.length, 2);
  for (const event of started) assert.deepEqual(event.payload.reasoning, resolved);
  // The durable state must still validate with the new field present.
  const durable = deserializeV2DurableState(readFileSync(join(result.runDir, 'state.json'), 'utf8'));
  assert.deepEqual(durable.attempts.map((attempt) => attempt.reasoning?.applied), ['high', 'high']);
});

// --- the dashboard's data floor ----------------------------------------
//
// The finish path writes one rollup record per run and appends it to the
// history index, so Home, Stats and History never have to parse every
// state.json (293 directories, 22 MB, ~100 ms measured on this machine) on
// the dashboard's 1 s refresh timer. Goal time stamps the project.

test('a finished run writes rollup.json, appends the history index, and stamps its project at goal time', async () => {
  const f = setup();
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify(programResponse()));
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: options.outputValidator('x'), outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
    writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)[1], JSON.stringify(evidence));
    writeFileSync(files.outFile, 'inspected');
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: options.outputValidator('x'), outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const finished = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-rollup-abcdef',
    dependencies: { dispatchV2Action: dispatch },
    now: (() => { let n = 0; return () => `2026-08-31T01:00:${String(n++).padStart(2, '0')}.000Z`; })(),
  });
  assert.equal(finished.result.status, 'completed');

  // Goal time: the project the run's cwd belongs to, recorded beside
  // goal.json before a single agent is dispatched.
  const stamped = readGoalProject(finished.runDir);
  assert.ok(stamped, 'a launch must record its project identity');
  assert.equal(stamped.cwd, f.workspace);
  assert.equal(stamped.name, basename(f.workspace), 'a plain directory is named after itself');

  // Finish time: the record and the index line.
  const record = readRollup(finished.runDir);
  assert.ok(record, 'a finished run must leave a rollup');
  assert.equal(record.schemaVersion, 'bullswarm.workflow.rollup.v1');
  assert.equal(record.runId, 'wf-rollup-abcdef');
  assert.equal(record.shortId, finished.state.shortId);
  assert.equal(record.project, basename(f.workspace));
  assert.equal(record.goal, 'Deliver a correct report');
  assert.equal(record.cwd, f.workspace);
  assert.equal(record.status, 'completed');
  assert.equal(record.verified, true);
  assert.deepEqual(record.requirements, { passed: 1, total: 1 });
  assert.equal(record.legacy, false);
  assert.equal(record.startedAt, finished.state.lifecycle.startedAt);
  assert.equal(record.finishedAt, finished.state.lifecycle.finishedAt);
  // The fake dispatcher records wallSec 1 and no cost estimate on every
  // attempt, so minutes are real and the money stays blank.
  assert.equal(record.minutes.agent, Math.round((finished.state.budget.seconds / 60) * 100) / 100);
  assert.equal(record.pools.relay.attempts, finished.state.attempts.length);
  assert.equal(record.pools.relay.costUsd, null, 'no estimate recorded → null, never 0');
  assert.equal(record.models['gpt-5.6-luna'].attempts, finished.state.attempts.length);

  const index = readRollupIndex(f.bullswarmDir);
  assert.equal(readFileSync(rollupIndexPath(f.bullswarmDir), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(index, [record]);

  // readRollups reaches it through the index, which is what the dashboard
  // does instead of listRuns.
  assert.deepEqual(readRollups(f.bullswarmDir).map((entry) => entry.runId), ['wf-rollup-abcdef']);
});

test('a cancelled run is rolled up too, and finishing twice leaves one index line', async () => {
  const f = setup();
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)[1], JSON.stringify(programResponse()));
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: options.outputValidator('x'), outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      // Request cancellation from inside the first worker, so the kernel
      // finalizes a cancelled run on its next checkpoint.
      writeFileSync(join(f.bullswarmDir, 'workflows', 'wf-cancel-abcdef', 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: '2026-08-31T01:00:05.000Z', reason: 'test' }));
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    writeFileSync(files.outFile, 'inspected');
    return { ok: false, status: 'failed', failureKind: 'cancelled', verdict: { ok: false, why: 'cancelled', outFile: files.outFile, meta: { exitCode: 1 } } };
  });
  const finished = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-cancel-abcdef',
    dependencies: { dispatchV2Action: dispatch },
    now: (() => { let n = 0; return () => `2026-08-31T01:00:${String(n++).padStart(2, '0')}.000Z`; })(),
  });
  assert.equal(finished.result.status, 'cancelled');
  const record = readRollup(finished.runDir);
  assert.ok(record, 'a cancelled run is history too and must be rolled up');
  assert.equal(record.status, 'cancelled');
  assert.equal(record.verified, false);

  // Resuming a terminal run replays the finish path. The index must still
  // carry exactly one line for it.
  await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], resumeRunId: 'wf-cancel-abcdef', dependencies: { dispatchV2Action: dispatch } });
  const lines = readFileSync(rollupIndexPath(f.bullswarmDir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'the index is idempotent by runId');
  assert.equal(JSON.parse(lines[0]).runId, 'wf-cancel-abcdef');
});

test('a rollup that cannot be indexed never costs a finished run its result', async () => {
  const f = setup();
  // A regular FILE where the history directory belongs: appending to the
  // index throws, which is the failure this guard exists for.
  writeFileSync(join(f.bullswarmDir, 'history'), 'not a directory\n');
  const dispatch = fakeDispatch(async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') {
      writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)[1], JSON.stringify(programResponse()));
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured: options.outputValidator('x'), outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
    writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)[1], JSON.stringify(evidence));
    writeFileSync(files.outFile, 'inspected');
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured: options.outputValidator('x'), outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const finished = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-blocked-abcdef',
    dependencies: { dispatchV2Action: dispatch },
  });
  assert.equal(finished.result.status, 'completed', 'the run still delivers');
  assert.equal(finished.result.verified, true);
  assert.equal(existsSync(join(finished.runDir, 'result.json')), true, 'the result envelope is still on disk');
  // The record itself was written before the index append failed, so
  // `workflow reindex` has everything it needs to repair the index later.
  assert.ok(readRollup(finished.runDir), 'the run still holds its own record');
  assert.equal(readFileSync(join(f.bullswarmDir, 'history'), 'utf8'), 'not a directory\n', 'nothing clobbered the blocking file');
});
