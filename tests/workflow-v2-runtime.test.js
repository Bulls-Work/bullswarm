import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { createV2GoalDocument, createV2State, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import {
  GATE_RETRY_HANDOFF_LINE, acceptCallerPlannerResponse, handoffBlock, normalizeAttempt, preferredUsage,
  recordAttemptCapture, reopenV2RunForRetry, reviseV2Program, runV2AutonomousWorkflow,
} from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { needsYouFacts } from '../src/workflow/needs-you.js';
import { summarizeV2Result, v2LimitStoppedDispatch } from '../src/workflow/v2-outcome.js';
import { notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { createRevisionRequest, exportV2Plan, normalizeRevisionInput } from '../src/workflow/v2-revision.js';
import { STAGE2_RUN_FEATURES, STAGE3_RUN_FEATURES } from '../src/workflow/run-features.js';
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

test('normalizeAttempt retains the provider session record for durable callers', () => {
  const normalized = normalizeAttempt({
    status: 'succeeded', pool: 'claude-code', model: 'claude-opus-5',
    startedAt: '2026-09-18T01:00:00.000Z',
    session: { pool: 'claude-code', model: 'claude-opus-5', sessionId: 'session-roundtrip', generation: 1 },
  }, { id: 'attempt-1', actionId: 'build-report', ordinal: 1 });
  assert.equal(normalized.session.sessionId, 'session-roundtrip');
  assert.equal(normalized.session.generation, 1);
});

test('normalizeAttempt copies evidenceResults only when the checks ran', () => {
  const evidenceResults = [{ type: 'command', cmd: 'true', timeoutSec: 120, status: 'passed', exit: 0, durationMs: 4, tail: '', why: null }];
  const base = { status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-09-24T01:00:00.000Z' };
  const withChecks = normalizeAttempt({ ...base, evidenceResults }, { id: 'build-1', actionId: 'build', ordinal: 1 });
  assert.deepEqual(withChecks.evidenceResults, evidenceResults);
  assert.notEqual(withChecks.evidenceResults, evidenceResults, 'a copy, not the dispatch record');
  const without = normalizeAttempt(base, { id: 'build-1', actionId: 'build', ordinal: 1 });
  assert.equal(Object.hasOwn(without, 'evidenceResults'), false);
});

test('normalizeAttempt copies the retry fact only when the attempt has one', () => {
  const base = { status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-09-24T01:00:00.000Z' };
  const retryOf = { attempt: 'build-1', how: 'same-pool' };
  const retried = normalizeAttempt({ ...base, retryOf }, { id: 'build-2', actionId: 'build', ordinal: 2 });
  assert.deepEqual(retried.retryOf, retryOf);
  assert.notEqual(retried.retryOf, retryOf, 'a copy, not the dispatch record');
  assert.equal(Object.hasOwn(normalizeAttempt(base, { id: 'build-1', actionId: 'build', ordinal: 1 }), 'retryOf'), false);
});

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
  // An unmarked run (no stage-3 keys, as 0.35.6 and stages 1-2 launched):
  // review placement stays automatic, so the check is routed away from its
  // writers (R12/R13). The marked twin is further down.
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-test1a-abcdef', dependencies: { dispatchV2Action: dispatch, runFeatures: {} }, now: (() => { let n = 0; return () => `2026-08-31T01:00:${String(n++).padStart(2, '0')}.000Z`; })() });
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

// ── attempt.capture ─────────────────────────────────────────────────────────

const CAPTURED_TOKENS = {
  standardRead: 2, cacheRead: 3, cacheWrite5m: null, cacheWrite1h: null, cacheWrite: null,
  output: 5, reasoning: 4, totalKnown: 14,
};
const capturedUsage = (sessionId) => ({
  model: 'gpt-5.6-luna', sessionId, tokens: { ...CAPTURED_TOKENS }, tokenSource: 'provider-reported',
});
const captureBlock = (sessionId, overrides = {}) => ({
  capturedAt: '2026-08-31T01:00:01.500Z', source: 'event-stream',
  providerSessionId: sessionId, sessionSource: 'provider-stream', model: 'gpt-5.6-luna',
  tokens: { ...CAPTURED_TOKENS }, tokenSource: 'provider-reported', providerCostUsd: 0.5,
  exitCode: 0, signal: null, ...overrides,
});

// Every attempt reports a provider capture at worker exit, then finishes with a
// weaker (estimated) usage and a different capture that must not win.
function captureDispatch(f, onDisk) {
  return async (options) => {
    const files = options.paths(1);
    const runDir = dirname(files.taskFile);
    const startedAt = '2026-08-31T01:00:01.000Z';
    const base = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {},
      session: { pool: 'relay', model: 'gpt-5.6-luna', sessionId: `generated-${options.action.id}`, generation: 1 },
    };
    options.onAttempt?.('started', { ...base, status: 'running' });
    const sessionId = `provider-${options.action.id}`;
    options.onAttempt?.('captured', { ...base, status: 'running', capture: captureBlock(sessionId), usage: capturedUsage(sessionId) });
    // The capture is on disk before the verdict exists: a kernel that dies
    // now still has what the provider reported.
    onDisk.set(options.action.id, deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8')));
    // A second capture of the same attempt is ignored: the first is immutable.
    options.onAttempt?.('captured', { ...base, status: 'running', capture: captureBlock('rewritten', { exitCode: 7 }), usage: null });
    let verdict;
    if (options.action.id === 'preflight-scout') {
      const report = [
        'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
        'UNITS OF WORK:\n- report', 'SHARED FILES:\n- none', 'RISKS:\n- none',
        'Additional repository facts '.repeat(8),
      ].join('\n');
      writeFileSync(files.outFile, report);
      verdict = { ok: true, structured: { value: report }, outFile: files.outFile, meta: { exitCode: 0 } };
    } else if (options.action.id === 'workflow-planner') {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify(programResponse()));
      verdict = { ok: true, structured: options.outputValidator(''), outFile: files.outFile, meta: { exitCode: 0 } };
    } else if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      verdict = { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } };
    } else {
      const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
      writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)?.[1], JSON.stringify(evidence));
      writeFileSync(files.outFile, 'inspected');
      verdict = { ok: true, structured: options.outputValidator(''), outFile: files.outFile, meta: { exitCode: 0 } };
    }
    // The finished record carries a weaker (estimated) usage and a different
    // capture; neither may replace what the provider reported.
    const record = {
      ...base, status: 'succeeded', finishedAt: '2026-08-31T01:00:02.000Z', failureKind: null, why: null, wallSec: 1,
      capture: captureBlock('finished-copy', { exitCode: 9 }),
      usage: {
        model: 'gpt-5.6-luna', sessionId: null, tokenSource: 'estimated:utf8-bytes/4',
        tokens: { ...CAPTURED_TOKENS, standardRead: 90, totalKnown: 99 },
        subscription: { pool: 'relay', window: 'weekly', deltaPct: null, usd: null, basis: 'unknown:no-meter' },
      },
    };
    options.onAttempt?.('finished', record, verdict);
    return { ok: true, status: 'succeeded', attempts: [record], verdict };
  };
}

test('an attempt is durable with its capture at worker exit and keeps provider-reported usage through finish', async () => {
  const f = setup();
  const onDisk = new Map();
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-capture-abcdef', dependencies: { dispatchV2Action: captureDispatch(f, onDisk) } });
  assert.equal(result.result.status, 'completed');

  const early = onDisk.get('write-report').attempts.find((attempt) => attempt.actionId === 'write-report');
  assert.equal(early.status, 'running');
  assert.equal(early.finishedAt, null);
  assert.deepEqual(early.capture, captureBlock('provider-write-report'));
  assert.equal(early.usage.tokenSource, 'provider-reported');
  // The provider-confirmed id replaces the generated conversation id.
  assert.equal(early.session.sessionId, 'provider-write-report');
  // Not counted yet: the run totals move once, at finish.
  assert.equal(onDisk.get('write-report').usage.total, 14, 'only the planner turn is counted so far');
  assert.equal(onDisk.get('workflow-planner').planner.attempts[0].capture.providerSessionId, 'provider-workflow-planner');

  const attempts = result.state.attempts;
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.deepEqual(attempt.capture, captureBlock(`provider-${attempt.actionId}`), 'the first capture is immutable');
    assert.equal(attempt.usage.tokenSource, 'provider-reported', 'an estimate never downgrades provider-reported usage');
    assert.deepEqual(attempt.usage.tokens, CAPTURED_TOKENS);
    assert.equal(attempt.usage.subscription.basis, 'unknown:no-meter', 'the meter-side block still comes from the finished record');
    assert.equal(attempt.session.sessionId, `provider-${attempt.actionId}`);
  }
  const planner = result.state.planner.attempts[0];
  assert.deepEqual(planner.capture, captureBlock('provider-workflow-planner'));
  assert.equal(planner.usage.tokenSource, 'provider-reported');
  // Three attempts, each counted once with its provider-reported total.
  assert.equal(result.state.usage.total, 42);
  const reread = deserializeV2DurableState(readFileSync(join(result.runDir, 'state.json'), 'utf8'));
  assert.deepEqual(reread.attempts.map((attempt) => attempt.capture.providerSessionId), ['provider-write-report', 'provider-inspect-report']);
});

test('a preflight scout attempt records its capture the same way', async () => {
  const f = setup({ scout: true });
  const onDisk = new Map();
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-capscout-abcdef', dependencies: { dispatchV2Action: captureDispatch(f, onDisk) } });
  assert.equal(result.result.status, 'completed');
  const early = onDisk.get('preflight-scout').preflight.scout.attempts[0];
  assert.equal(early.status, 'running');
  assert.deepEqual(early.capture, captureBlock('provider-preflight-scout'));
  const scout = result.state.preflight.scout.attempts[0];
  assert.deepEqual(scout.capture, captureBlock('provider-preflight-scout'));
  assert.equal(scout.usage.tokenSource, 'provider-reported');
  // Scout, planner and two workers, each counted once.
  assert.equal(result.state.usage.total, 56);
});

test('preferredUsage upgrades an estimate but never downgrades provider-reported counters', () => {
  const estimated = { tokenSource: 'estimated:utf8-bytes/4', tokens: { totalKnown: 99 } };
  const summed = { tokenSource: 'transcript-summed', tokens: { totalKnown: 20 }, subscription: { basis: 'observed:meter-delta' } };
  const reported = capturedUsage('s1');
  assert.deepEqual(preferredUsage(estimated, summed), summed);
  assert.deepEqual(preferredUsage(null, estimated), estimated);
  assert.deepEqual(preferredUsage(reported, null), reported);
  const kept = preferredUsage(reported, summed);
  assert.equal(kept.tokenSource, 'provider-reported');
  assert.deepEqual(kept.tokens, CAPTURED_TOKENS);
  assert.deepEqual(kept.subscription, { basis: 'observed:meter-delta' });
  const attempt = { status: 'running' };
  assert.equal(recordAttemptCapture(attempt, { capture: captureBlock('s1'), usage: reported }), true);
  assert.equal(recordAttemptCapture(attempt, { capture: captureBlock('s2'), usage: estimated }), false);
  assert.equal(attempt.capture.providerSessionId, 's1');
  assert.equal(attempt.usage.tokenSource, 'provider-reported');
});

test('the state schema accepts a capture only in its documented shape', async () => {
  const f = setup();
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-capschema-abcdef', dependencies: { dispatchV2Action: captureDispatch(f, new Map()) } });
  const text = readFileSync(join(result.runDir, 'state.json'), 'utf8');
  const withCapture = (capture) => {
    const state = JSON.parse(text);
    state.attempts[0].capture = capture;
    state.planner.attempts[0].capture = capture;
    return JSON.stringify(state);
  };
  assert.doesNotThrow(() => deserializeV2DurableState(withCapture(captureBlock('ok'))));
  assert.doesNotThrow(() => deserializeV2DurableState(withCapture(captureBlock(null, { sessionSource: null, tokens: null, tokenSource: 'unknown', providerCostUsd: null }))));
  assert.throws(() => deserializeV2DurableState(withCapture(captureBlock('x', { tokens: null }))), /present exactly when tokenSource is provider-reported/);
  assert.throws(() => deserializeV2DurableState(withCapture(captureBlock('x', { tokenSource: 'estimated:utf8-bytes/4' }))), /tokenSource is invalid/);
  assert.throws(() => deserializeV2DurableState(withCapture(captureBlock('x', { guessedUsd: 1 }))), /guessedUsd/);
  assert.throws(() => deserializeV2DurableState(withCapture(captureBlock('x', { providerCostUsd: -1 }))), /must not be negative/);
});


// --- Stage 3: the failure rule's kernel side (marker, placement, route,
// no free pool, retry facts, who reviewed). Fake dispatches drive the options
// the kernel hands the dispatcher, exactly as the real one calls them.

const WORK_REQ = { id: 'work-done', text: 'work.md exists and says done' };
const NOTES_REQ = { id: 'notes-done', text: 'notes.md exists' };

function stage3Setup(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-stage3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = createV2GoalDocument({
    goal: 'Deliver the work', cwd: workspace, requirements: [WORK_REQ, NOTES_REQ],
    settings: { executionMode: 'program', plannerMode: 'caller', workspaceMode: 'shared', scout: false, concurrency: 2, ...settings },
  });
  return { root, bullswarmDir, workspace, goal };
}

const step3 = (id, over = {}) => ({
  id, purpose: `Run ${id}`, dependsOn: [], affects: ['notes-done'], ownedFiles: [`${id}.md`], prompt: `Do ${id}.`,
  lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...over,
});
const programOf = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Stage-3 kernel test.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

// One attempt through the kernel's onAttempt, as the dispatcher reports it.
function reportAttempt(options, ordinal, { pool = 'relay', ok = true, failureKind = null, why = null, retryOf = null, willRetry = false, changedFileCount = 1 } = {}) {
  const files = options.paths(ordinal);
  const startedAt = new Date().toISOString();
  const started = {
    ordinal, pool, model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile,
    routing: {}, ...(retryOf ? { retryOf } : {}),
  };
  options.onAttempt('started', { ...started });
  writeFileSync(files.taskFile, options.taskText);
  writeFileSync(files.outFile, ok ? 'done' : 'it failed');
  const record = {
    ...started, status: ok ? 'succeeded' : willRetry ? 'interrupted' : 'failed', finishedAt: new Date().toISOString(),
    failureKind, why, willRetry, usage: { tokens: { totalKnown: 1 } }, wallSec: 1, changedFileCount,
  };
  options.onAttempt('finished', { ...record }, ok ? { ok: true, outFile: files.outFile } : { ok: false, why, failureKind, outFile: files.outFile });
  return record;
}

function succeedEvidence(options, requirements, ordinal = 1, attemptOptions = {}) {
  const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
  writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.evidence.v2', requirements }));
  const record = reportAttempt(options, ordinal, attemptOptions);
  const structured = options.outputValidator('prose');
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured, outFile: record.outFile } };
}

const succeed = (options, ordinal = 1, attemptOptions = {}) => {
  const record = reportAttempt(options, ordinal, attemptOptions);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, why: 'ok', outFile: record.outFile } };
};

function launch3(f, { runId, actions, dispatch, dependencies = {}, onEvent = null }) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, parentEnv: {},
    initialPlannerResponse: programOf(actions), ...(onEvent ? { onEvent } : {}),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
  });
}

// A run dir the way a kernel left it, for resume tests.
function savedRun(f, { runId, actions, marker, edit }) {
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  if (marker) writeFileSync(join(runDir, 'features.json'), marker);
  let state = createV2State(f.goal, { runId, shortId: runId.slice(3, 9) });
  state = acceptCallerPlannerResponse(state, programOf(actions), { boundary: 'initial', runDir }).state;
  state.lifecycle.status = 'interrupted';
  edit(state);
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goal));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  return runDir;
}

const eventsOfType = (runDir, type) => readEvents(runDir).filter((event) => event.type === type);
const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));

test('handoffBlock adds the gate line only for a gate retry, just before the unverified-edits line', () => {
  const facts = { pool: 'relay', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', failureKind: 'not-produced', why: 'no file changed and no commit made' };
  const plain = handoffBlock(facts);
  assert.equal(handoffBlock({ ...facts, gate: false }), plain);
  assert.doesNotMatch(plain, /automatic retry/);
  const gated = handoffBlock({ ...facts, gate: true }).split('\n');
  assert.equal(GATE_RETRY_HANDOFF_LINE, '- This is the step\'s one automatic retry: the failure above closed its gate. Fix what it names; your earlier edits are still in the workspace.');
  assert.deepEqual(gated.slice(-2), [GATE_RETRY_HANDOFF_LINE, '- Those edits are unverified. You decide whether to keep, fix or revert them, and you must report which.']);
  assert.equal(gated.filter((line) => line !== GATE_RETRY_HANDOFF_LINE).join('\n'), plain);
});

test('stage 3: a new run is marked, reviews are caller-placed, independentOf feeds the route filter, and who reviewed is recorded', async (t) => {
  const f = stage3Setup(t);
  const seen = {};
  const dispatch = async (options) => {
    seen[options.action.id] = options;
    if (options.action.id === 'write') {
      // Attempt 1 crashed on another provider after changing files; the one
      // retry succeeded here. Both did work on the step (D17).
      const first = reportAttempt(options, 1, { pool: 'codex:acme', ok: false, failureKind: 'process', why: 'exit 1', willRetry: true, changedFileCount: 2 });
      writeFileSync(join(f.workspace, 'work.md'), 'done\n');
      const second = reportAttempt(options, 2, { pool: 'relay', retryOf: { attempt: 'write-1', how: 'other-pool' } });
      return { ok: true, status: 'succeeded', attempts: [first, second], verdict: { ok: true, outFile: second.outFile } };
    }
    if (options.action.id === 'check') return succeedEvidence(options, { 'work-done': { status: 'passed', evidence: ['work.md says done'], concerns: [] } }, 1, { pool: 'grok' });
    return succeed(options);
  };
  const run = await launch3(f, {
    runId: 'wf-stage3-abcdef', dispatch,
    actions: [
      step3('write', { affects: ['work-done'] }),
      step3('notes'),
      step3('check', { dependsOn: ['write'], ownedFiles: [], affects: [], lane: 'analyze', evidenceFor: ['work-done'], route: { independentOf: ['write'] } }),
    ],
  });
  assert.equal(run.result.status, 'completed');
  assert.deepEqual(JSON.parse(readFileSync(join(run.runDir, 'features.json'), 'utf8')), { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' });
  assert.deepEqual(JSON.parse(readFileSync(join(run.runDir, 'features.json'), 'utf8')), { ...STAGE3_RUN_FEATURES });
  for (const id of ['write', 'notes', 'check']) {
    assert.equal(seen[id].failureRule, true, id);
    assert.equal(seen[id].retriesAlready, 0, id);
    assert.equal(seen[id].pinSource, null, id);
    // A step never waits for a pool (owner decision, 2026-09-25): no wait hooks.
    for (const hook of ['onWaiting', 'claimWake', 'nextSettleOr']) assert.equal(Object.hasOwn(seen[id], hook), false, `${id} ${hook}`);
  }
  // D15: the check keeps "no free-first" and loses automatic writer avoidance.
  assert.deepEqual(seen.check.evidence, { writerPools: [] });
  assert.equal(seen.write.evidence, null);
  // D17/D18: independence resolves to every provider that did work on write.
  assert.equal(seen.write.routeFilter, null);
  assert.deepEqual(seen.check.routeFilter.independentOf, { write: ['codex', 'relay'] });
  assert.deepEqual(seen.check.routeFilter.independentProviders, ['codex', 'relay']);
  assert.equal(seen.check.routeFilter.summary, 'independent of write (providers codex, relay)');
  // The retry fact is stored on the successor, with the run-wide attempt id.
  const writeAttempts = run.state.attempts.filter((attempt) => attempt.actionId === 'write');
  assert.equal(Object.hasOwn(writeAttempts[0], 'retryOf'), false);
  assert.deepEqual(writeAttempts[1].retryOf, { attempt: 'write-1', how: 'other-pool' });
  // A stage-3 run labels a step without evidence (stage 2's proofLabels kept).
  const finished = Object.fromEntries(eventsOfType(run.runDir, 'action.finished').map((event) => [event.payload.actionId, event.payload]));
  assert.deepEqual(finished.notes.proof, { by: [], reviewPending: false });
  // D27: the reviewer and every writer attempt, the crashed one included.
  const reviewer = { attemptId: 'check-1', pool: 'grok', model: 'gpt-5.6-luna', provider: 'grok' };
  const writers = [{ actionId: 'write', pool: 'codex:acme', provider: 'codex' }, { actionId: 'write', pool: 'relay', provider: 'relay' }];
  const recorded = eventsOfType(run.runDir, 'evidence.recorded')[0].payload;
  assert.deepEqual(recorded.reviewer, reviewer);
  assert.deepEqual(recorded.writers, writers);
  const record = run.state.ledger.evidence.find((entry) => entry.sourceAction === 'check');
  assert.deepEqual(record.reviewer, reviewer);
  assert.deepEqual(record.writers, writers);
  // Marked attempt.finished payloads say so (the watch's quota tails read it).
  assert.ok(eventsOfType(run.runDir, 'attempt.finished').every((event) => event.payload.failureRule === true));
});

test('an unmarked run keeps automatic review placement and never marks attempt.finished', async (t) => {
  const f = stage3Setup(t);
  const seen = {};
  const dispatch = async (options) => {
    seen[options.action.id] = options;
    if (options.action.id === 'check') return succeedEvidence(options, { 'work-done': { status: 'passed', evidence: ['ok'], concerns: [] } }, 1, { pool: 'grok' });
    return succeed(options);
  };
  const run = await launch3(f, {
    runId: 'wf-unmark-abcdef', dispatch, dependencies: { runFeatures: {} },
    actions: [step3('write', { affects: ['work-done'] }), step3('check', { dependsOn: ['write'], ownedFiles: [], affects: [], lane: 'analyze', evidenceFor: ['work-done'] })],
  });
  assert.equal(run.result.status, 'completed');
  assert.deepEqual(seen.check.evidence, { writerPools: ['relay'] });
  assert.equal(seen.check.failureRule, false);
  assert.ok(eventsOfType(run.runDir, 'attempt.finished').every((event) => !Object.hasOwn(event.payload, 'failureRule')));
});

test('a resumed stage-2 run keeps its marker file, its labels and its E14 evidence retry', async (t) => {
  const f = stage3Setup(t);
  const marker = `${JSON.stringify(STAGE2_RUN_FEATURES, null, 2)}\n`;
  const runDir = savedRun(f, {
    runId: 'wf-s2keep-abcdef', marker,
    actions: [step3('write', { affects: ['work-done'], evidence: [{ type: 'command', cmd: 'true' }] }), step3('notes')],
    edit: () => {},
  });
  const seen = {};
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-s2keep-abcdef', pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: async (options) => { seen[options.action.id] = options; return succeed(options); } },
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(readFileSync(join(runDir, 'features.json'), 'utf8'), marker, 'never rewritten');
  assert.equal(seen.write.failureRule, false);
  assert.equal(seen.write.evidenceRetryAvailable, true);
  assert.equal(seen.write.legacyGate, true);
  const finished = Object.fromEntries(eventsOfType(runDir, 'action.finished').map((event) => [event.payload.actionId, event.payload]));
  assert.deepEqual(finished.notes.proof, { by: [], reviewPending: false }, 'stage-2 labels kept');
});

test('retriesAlready is counted from stored retry facts: a kernel resume keeps it, a rerun resets it', async (t) => {
  const f = stage3Setup(t);
  const attempts = [
    { id: 'write-1', actionId: 'write', ordinal: 1, status: 'failed', pool: 'codex', model: null, startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', failureKind: 'process', why: 'exit 1' },
    { id: 'write-2', actionId: 'write', ordinal: 2, status: 'interrupted', pool: 'relay', model: null, startedAt: '2026-09-24T10:02:00.000Z', finishedAt: '2026-09-24T10:03:00.000Z', failureKind: 'interrupted', why: 'runner stopped', retryOf: { attempt: 'write-1', how: 'other-pool' } },
  ];
  for (const [label, superseded, expected] of [['kernel resume', 0, 1], ['rerun', 2, 0]]) {
    const runId = superseded ? 'wf-s3rrun-abcdef' : 'wf-s3kres-abcdef';
    savedRun(f, {
      runId, marker: JSON.stringify(STAGE3_RUN_FEATURES), actions: [step3('write')],
      edit: (state) => {
        state.attempts = attempts.map((attempt) => ({ ...attempt }));
        Object.assign(state.actions[0], { status: 'interrupted', attempts: 2, supersededAttempts: superseded, startedAt: '2026-09-24T10:00:00.000Z' });
      },
    });
    const seen = [];
    const run = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
      dependencies: { refreshPools: async () => null, dispatchV2Action: async (options) => { seen.push(options); return succeed(options); } },
    });
    assert.equal(seen[0].retriesAlready, expected, label);
    // A kernel resume starts a plain attempt: a kernel stop is not the step's failure (D3).
    assert.equal(Object.hasOwn(run.state.attempts.at(-1), 'retryOf'), false, label);
    assert.equal(run.state.attempts.at(-1).id, 'write-3', label);
  }
});

test('a kernel resume resets a waiting step to pending: no worker ran, nothing is spent', async (t) => {
  const f = stage3Setup(t);
  const runDir = savedRun(f, {
    runId: 'wf-s3wres-abcdef', marker: JSON.stringify(STAGE3_RUN_FEATURES), actions: [step3('write')],
    edit: (state) => {
      state.lifecycle.status = 'running';
      Object.assign(state.actions[0], { status: 'waiting', startedAt: '2026-09-24T10:00:00.000Z', lastFailure: { kind: 'waiting', message: 'waiting for quota: relay back at 2026-09-24T12:00:00.000Z' } });
    },
  });
  const seen = [];
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-s3wres-abcdef', pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: async (options) => { seen.push(options); return succeed(options); } },
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].retriesAlready, 0);
  assert.equal(seen[0].resumeHandoff, null, 'no attempt ran, so nothing is handed on');
  assert.deepEqual(run.state.attempts.map((attempt) => attempt.id), ['write-1']);
  assert.equal(eventsOfType(runDir, 'action.started').length, 1);
});

test('marked: a step no pool can take now goes to the caller with each pool\'s return, never waits, and the rest of the run goes on', async (t) => {
  const f = stage3Setup(t);
  // A pool whose meter reads its 5-hour window at the limit until its reset.
  const soonMs = Date.now() + 2 * 3600_000;
  const laterMs = Date.now() + 4 * 3600_000;
  const [soon, later] = [soonMs, laterMs].map((ms) => new Date(ms).toISOString());
  const pausedPool = (name, until) => ({
    name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
    fiveHourUsedPct: 100, fiveHourResetsAt: new Date(until).toISOString(),
  });
  const slept = [];
  // `write` goes through the real dispatcher, with seams that would show a
  // worker start or a wait; `notes` is faked so the rest of the run can finish.
  const dispatch = (options) => (options.action.id === 'write'
    ? dispatchV2Action({ ...options, dependencies: {
      watchOnce: async () => { throw new Error('no worker may start'); },
      sleep: async (ms) => { slept.push(ms); throw new Error('the step waited for a pool'); },
    } })
    : succeed(options));
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [pausedPool('luna-1', soonMs), pausedPool('luna-2', laterMs)],
    runId: 'wf-s3nofree-abcdef', parentEnv: {}, initialPlannerResponse: programOf([step3('write', { affects: ['work-done'] }), step3('notes')]),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
  });
  const why = `no pool with quota to spare: luna-1 at its 5-hour limit until ${soon}; luna-2 at its 5-hour limit until ${later}`;
  const write = run.state.actions.find((action) => action.id === 'write');
  assert.equal(write.status, 'failed');
  assert.deepEqual(write.lastFailure, { kind: 'quota', message: why, retryAfter: soon });
  assert.equal(run.state.actions.find((action) => action.id === 'notes').status, 'succeeded');
  assert.deepEqual(slept, [], 'no wait');
  assert.deepEqual(eventsOfType(run.runDir, 'action.waiting'), []);
  assert.deepEqual(eventsOfType(run.runDir, 'attempt.started').map((event) => event.payload.actionId), ['notes']);
  const finished = eventsOfType(run.runDir, 'action.finished').find((event) => event.payload.actionId === 'write');
  assert.deepEqual([finished.payload.status, finished.payload.failureKind, finished.payload.why, finished.payload.retryAfter], ['failed', 'quota', why, soon]);
  // The caller's block says when a rerun can get through; nothing waits for it.
  const facts = needsYouFacts(run.state, finished, { runDir: run.runDir });
  assert.equal(facts.backAt, soon);
  assert.equal(facts.options.waitForIt, `after ${soon}: bullswarm workflow step rerun ${run.shortId} write`);
});

test('the failed action.finished names the current attempts and, in a marked run, the counted retries', async (t) => {
  for (const [label, features, runId] of [['marked', STAGE3_RUN_FEATURES, 'wf-s3fail-abcdef'], ['unmarked', STAGE2_RUN_FEATURES, 'wf-s2fail-abcdef']]) {
    const f = stage3Setup(t);
    const dispatch = async (options) => {
      const first = reportAttempt(options, 1, { pool: 'codex', ok: false, failureKind: 'process', why: 'exit 1', willRetry: true });
      const second = reportAttempt(options, 2, { pool: 'relay', ok: false, failureKind: 'process', why: 'exit 2', retryOf: { attempt: 'write-1', how: 'other-pool' } });
      return { ok: false, status: 'failed', failureKind: 'process', attempts: [first, second], verdict: { ok: false, why: 'exit 2', failureKind: 'process' } };
    };
    const run = await launch3(f, { runId, dispatch, actions: [step3('write')], dependencies: { runFeatures: features } });
    const finished = eventsOfType(run.runDir, 'action.finished').at(-1).payload;
    assert.equal(finished.status, 'failed', label);
    assert.deepEqual(finished.attemptIds, ['write-1', 'write-2'], label);
    if (label === 'marked') assert.equal(finished.retries, 1);
    else assert.equal(Object.hasOwn(finished, 'retries'), false, 'a saved run counts attempts minus one in the watcher');
  }
});

test('marked: a failure a check finds after the loop stopped wakes the caller with one finished round naming it; a saved run adds nothing (F11)', async (t) => {
  for (const [label, features, runId] of [['marked', STAGE3_RUN_FEATURES, 'wf-f11mrk-abcdef'], ['unmarked', STAGE2_RUN_FEATURES, 'wf-f11st2-abcdef']]) {
    const f = stage3Setup(t);
    const verdict = { status: 'passed' };
    const dispatch = async (options) => (options.action.evidenceFor.length
      ? succeedEvidence(options, { 'work-done': { status: verdict.status, evidence: [`work.md judged ${verdict.status}`], concerns: [] } })
      : succeed(options));
    const actions = [
      step3('write', { affects: ['work-done', 'notes-done'], ownedFiles: ['work.md'] }),
      step3('check', { dependsOn: ['write'], ownedFiles: [], affects: [], lane: 'analyze', evidenceFor: ['work-done'] }),
    ];
    const first = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, parentEnv: {},
      initialPlannerResponse: { ...programOf(actions), program: { ...programOf(actions).program, defaults: { verifyRounds: label === 'marked' ? 0 : 1 } } },
      dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, runFeatures: features },
    });
    assert.equal(first.result.status, 'completed', label);
    assert.equal(first.state.verifyLoop.max, 1, label);
    // The caller adds a second look at work-done after the loop stopped, and it fails.
    const exported = exportV2Plan(first.state);
    exported.program.actions.push(step3('recheck', { dependsOn: ['check'], ownedFiles: [], affects: [], lane: 'analyze', evidenceFor: ['work-done'] }));
    const body = normalizeRevisionInput(exported, { rerun: [] });
    const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request: createRevisionRequest({ ...body, baseRevision: first.state.program.revision }, { source: 'cli' }), waitMs: 0 });
    assert.equal(revised.status, 'applied', label);
    verdict.status = 'failed';
    const second = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
      dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
    });
    assert.equal(second.state.ledger.requirements['work-done'].status, 'blocked', `${label}: the two checks disagree`);
    const finished = eventsOfType(second.runDir, 'workflow.verify-round').filter((event) => event.payload.stage === 'finished').map((event) => event.payload);
    if (label === 'marked') {
      assert.deepEqual(finished.map(({ wallMinutes, ...payload }) => payload), [
        { round: 1, of: 1, stage: 'finished', passed: ['work-done'], failed: [], discovery: 0, next: 'finish', notJudged: ['notes-done'] },
        { round: 1, of: 1, stage: 'finished', passed: [], failed: ['work-done'], discovery: 0, next: 'caller' },
      ]);
    } else {
      assert.equal(finished.length, 1, 'a saved run keeps its one round event');
    }
  }
});

test('attempt.finished carries the dispatcher\'s backoff decision for a transient rate limit (F23)', async (t) => {
  const f = stage3Setup(t);
  const dispatch = async (options) => {
    const files = options.paths(1);
    const started = { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile, routing: {} };
    options.onAttempt('started', { ...started });
    writeFileSync(files.outFile, 'too many requests');
    // A throttle backs off on the same pool; a usage limit records no
    // decision (it goes to the caller).
    options.onAttempt('finished', { ...started, status: 'interrupted', finishedAt: new Date().toISOString(), failureKind: 'throttle', why: 'too many requests', willRetry: true, quotaNext: 'wait' }, { ok: false, why: 'too many requests' });
    const second = reportAttempt(options, 2, { pool: 'relay', retryOf: { attempt: 'write-1', how: 'wait' } });
    return { ok: true, status: 'succeeded', attempts: [second], verdict: { ok: true, outFile: second.outFile } };
  };
  const run = await launch3(f, { runId: 'wf-s3qnext-abcdef', dispatch, actions: [step3('write')] });
  assert.equal(run.result.status, 'completed');
  const finished = eventsOfType(run.runDir, 'attempt.finished').map((event) => [event.payload.attemptId, event.payload.quotaNext ?? null]);
  assert.deepEqual(finished, [['write-1', 'wait'], ['write-2', null]]);
});

// --- stage 3: the Workflow Planner and preflight scout of a marked run -------
// A usage limit, a rate limit that did not clear, or no free pool stops them
// and goes to the caller; the dispatcher never moves them to another pool
// (usageLimitsToCaller, owner decision 2026-09-25).

const LIMIT_RESET = '2026-08-31T02:20:00.000Z';
const LIMIT_WHY = `usage limit: "You've hit your session limit" · pool paused until ${LIMIT_RESET}`;
const BENCH_UNTIL = '2026-08-31T01:20:00.000Z';
const THROTTLE_WHY = 'rate limited (transient): "Error: 429 Too Many Requests" · pool not paused';

// A dispatch that stopped on a limit, as the dispatcher returns it: one
// failed attempt reported through onAttempt, or none when no pool was free.
function limitStopped(options, { failureKind = 'quota', retryAfter = LIMIT_RESET, why = LIMIT_WHY, attempt = true } = {}) {
  const attempts = attempt ? [reportAttempt(options, 1, { ok: false, failureKind, why })] : [];
  return {
    ok: false, status: 'failed', failureKind, ...(retryAfter ? { retryAfter } : {}), attempts,
    verdict: { ok: false, why, failureKind, meta: { exitCode: attempt ? 1 : null } },
  };
}
// The caller's options (owner decision 2026-09-25): resume runs the stopped
// planner or scout again, after its return when one is known.
const yourCall = (token, retryAfter) => ` · your call: ${retryAfter ? `resume after ${retryAfter} with bullswarm workflow resume ${token}` : `bullswarm workflow resume ${token} once a pool is free`}`
  + `, plan it yourself with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`;
// A dispatched planner turn that returns `actions` as its program.
const planned = (options, actions) => {
  const record = reportAttempt(options, 1);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured: { value: programOf(actions) }, outFile: record.outFile } };
};
const SCOUT_REPORT = [
  'TREE:\n- work.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- no tests',
  'UNITS OF WORK:\n- write', 'SHARED FILES:\n- none', 'RISKS:\n- none',
  'Additional repository facts '.repeat(8), '["write"]',
].join('\n');
const scouted = (options) => {
  const record = reportAttempt(options, 1);
  writeFileSync(record.outFile, SCOUT_REPORT);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured: { value: SCOUT_REPORT }, outFile: record.outFile } };
};
const resumeRun = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
});
const recordingDispatch = (handler) => {
  const seen = [];
  const dispatch = async (options) => {
    seen.push({ id: options.action.id, usageLimitsToCaller: options.usageLimitsToCaller });
    return handler(options);
  };
  dispatch.seen = seen;
  return dispatch;
};
const launchPlanned = (f, runId, dispatch, dependencies = {}) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
});

test('marked: a Workflow Planner stopped on a usage limit ends the run for the caller with its reset, and is not dispatched again', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched' });
  const dispatch = recordingDispatch((options) => limitStopped(options));
  const run = await launchPlanned(f, 'wf-plq001-abcdef', dispatch);
  assert.deepEqual(dispatch.seen, [{ id: 'workflow-planner', usageLimitsToCaller: true }], 'one planner dispatch, under the usage-limit rules');
  assert.equal(run.result.status, 'partial');
  const token = run.state.shortId;
  assert.equal(run.result.reason, `the workflow planner stopped on a usage limit: ${LIMIT_WHY} · back at ${LIMIT_RESET}${yourCall(token, LIMIT_RESET)}`);
  assert.deepEqual(eventsOfType(run.runDir, 'planner.finished').map((event) => event.payload), [
    { turn: 1, ok: false, failureKind: 'quota', why: LIMIT_WHY, retryAfter: LIMIT_RESET },
  ]);
  assert.equal(run.state.planner.status, 'failed');
  assert.deepEqual(run.state.planner.attempts.map((attempt) => [attempt.status, attempt.failureKind]), [['failed', 'quota']]);
  // The durable record `workflow resume` reads to run the turn again.
  const { at, ...stop } = run.state.planner.limitStop;
  assert.deepEqual(stop, { failureKind: 'quota', retryAfter: LIMIT_RESET, boundary: 'initial', steeringIds: [] });
  assert.ok(!Number.isNaN(Date.parse(at)));
  assert.deepEqual(v2LimitStoppedDispatch(run.state), { id: 'workflow-planner', who: 'the workflow planner', failureKind: 'quota', retryAfter: LIMIT_RESET });
  // The result's options carry the resume that runs it again.
  const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir });
  assert.equal(summary.handback.options.retry, `bullswarm workflow resume ${token} after ${LIMIT_RESET} (reruns the workflow planner)`);
  // The watch reads the kernel's event as the planner's stop, not a rejected
  // plan: its pool, when to try again, and its own trouble kind.
  const [line] = notableWatchEvents({ events: eventsOfType(run.runDir, 'planner.finished'), state: run.state, runDir: run.runDir }).notable;
  assert.equal(renderWatchEvent(line).replace(/^\S+ /, '✗ '), `✗ planner stopped · out of quota on relay · back at ${LIMIT_RESET}`);
  assert.equal(line.retryAfter, LIMIT_RESET);
  assert.equal(watchTrouble(line, { program: true }), 'planner-limit');
});

test('marked: a planner with no pool free or rate limited with no time says so; any other planner failure keeps its reason', async (t) => {
  const cases = [
    {
      runId: 'wf-plq002-abcdef', stop: { failureKind: 'unavailable', retryAfter: BENCH_UNTIL, why: `no pool free: luna-1 benched until ${BENCH_UNTIL}`, attempt: false },
      reason: (token) => `the workflow planner stopped: no pool free: luna-1 benched until ${BENCH_UNTIL} · back at ${BENCH_UNTIL}${yourCall(token, BENCH_UNTIL)}`,
      retryAfter: BENCH_UNTIL,
    },
    {
      runId: 'wf-plq003-abcdef', stop: { failureKind: 'throttle', retryAfter: null, why: THROTTLE_WHY },
      reason: (token) => `the workflow planner stopped on a usage limit: ${THROTTLE_WHY}${yourCall(token, null)}`,
      retryAfter: null,
    },
    {
      runId: 'wf-plq004-abcdef', stop: { failureKind: 'schema', retryAfter: null, why: 'the planner response failed validation' },
      reason: () => 'the workflow planner could not produce a mechanically valid program: the planner response failed validation',
      retryAfter: undefined,
    },
  ];
  for (const entry of cases) {
    const f = stage3Setup(t, { plannerMode: 'dispatched' });
    const dispatch = recordingDispatch((options) => limitStopped(options, entry.stop));
    const run = await launchPlanned(f, entry.runId, dispatch);
    assert.equal(dispatch.seen.length, 1, entry.runId);
    assert.equal(run.result.reason, entry.reason(run.state.shortId), entry.runId);
    const [finished] = eventsOfType(run.runDir, 'planner.finished').map((event) => event.payload);
    if (entry.retryAfter === undefined) assert.equal(Object.hasOwn(finished, 'retryAfter'), false, entry.runId);
    else assert.equal(finished.retryAfter, entry.retryAfter, entry.runId);
    // A limit stop is kept for resume, with its return when known; any other
    // planner failure is not, and resume has nothing to retry after it.
    const retry = summarizeV2Result(run.result, run.state, { runDir: run.runDir }).handback.options.retry;
    if (entry.retryAfter === undefined) {
      assert.equal(Object.hasOwn(run.state.planner, 'limitStop'), false, entry.runId);
      assert.equal(retry, undefined, entry.runId);
      assert.equal(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId: entry.runId }).status, 'nothing-to-retry', entry.runId);
    } else {
      assert.deepEqual([run.state.planner.limitStop.failureKind, run.state.planner.limitStop.retryAfter], [entry.stop.failureKind, entry.retryAfter], entry.runId);
      assert.equal(retry, `bullswarm workflow resume ${run.state.shortId}${entry.retryAfter ? ` after ${entry.retryAfter}` : ''} (reruns the workflow planner)`, entry.runId);
    }
  }
});

test('marked: a Workflow Planner that stops on a usage limit at a steering boundary ends the run with the same reason, and is not dispatched again', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched' });
  const runId = 'wf-plq007-abcdef';
  let plannerTurns = 0;
  const dispatch = recordingDispatch((options) => {
    if (options.action.id === 'workflow-planner') {
      plannerTurns += 1;
      if (plannerTurns > 1) return limitStopped(options);
      const record = reportAttempt(options, 1);
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured: { value: programOf([step3('write')]) }, outFile: record.outFile } };
    }
    // The step queues steering, so the next boundary is a steering turn.
    writeFileSync(join(f.bullswarmDir, 'workflows', runId, 'steering.jsonl'), `${JSON.stringify({
      id: 'steer-limit', message: 'Keep the notes short.', queuedAt: new Date().toISOString(),
      delivery: 'next-not-yet-started-planner-checkpoint',
    })}\n`);
    return succeed(options);
  });
  const run = await launchPlanned(f, runId, dispatch);
  assert.deepEqual(dispatch.seen, [
    { id: 'workflow-planner', usageLimitsToCaller: true },
    { id: 'write', usageLimitsToCaller: undefined },
    { id: 'workflow-planner', usageLimitsToCaller: true },
  ], 'one steering turn, and no planner dispatch after it stopped');
  assert.equal(run.result.status, 'partial');
  assert.equal(run.result.reason, `the workflow planner stopped on a usage limit: ${LIMIT_WHY} · back at ${LIMIT_RESET}${yourCall(run.state.shortId, LIMIT_RESET)}`);
  assert.deepEqual(eventsOfType(run.runDir, 'planner.finished').map((event) => [event.payload.ok, event.payload.retryAfter ?? null]), [[true, null], [false, LIMIT_RESET]]);
  assert.equal(run.state.actions.find((action) => action.id === 'write').status, 'succeeded');
});

test('marked: a preflight scout stopped on a usage limit with no program ends the run for the caller; the planner never runs', async (t) => {
  for (const [plannerMode, runId] of [['dispatched', 'wf-scq001-abcdef'], ['caller', 'wf-scq002-abcdef']]) {
    const f = stage3Setup(t, { plannerMode, scout: true });
    const dispatch = recordingDispatch((options) => limitStopped(options));
    const run = await launchPlanned(f, runId, dispatch);
    assert.deepEqual(dispatch.seen, [{ id: 'preflight-scout', usageLimitsToCaller: true }], plannerMode);
    assert.equal(run.result.status, 'partial', plannerMode);
    const token = run.state.shortId;
    assert.equal(run.result.reason, `the preflight scout stopped on a usage limit: ${LIMIT_WHY} · back at ${LIMIT_RESET}${yourCall(token, LIMIT_RESET)}`, plannerMode);
    // The run finishes here: the event says so for a later replay.
    assert.deepEqual(eventsOfType(run.runDir, 'preflight.scout_finished').map((event) => event.payload), [
      { status: 'failed', failureKind: 'quota', why: LIMIT_WHY, retryAfter: LIMIT_RESET, runContinues: false },
    ], plannerMode);
    assert.equal(eventsOfType(run.runDir, 'planner.started').length, 0, plannerMode);
    // The stop ended the run: the record `workflow resume` reads, and the
    // result's option that runs the scout again.
    const { at, ...stop } = run.state.preflight.scout.limitStop;
    assert.deepEqual(stop, { failureKind: 'quota', retryAfter: LIMIT_RESET }, plannerMode);
    assert.ok(!Number.isNaN(Date.parse(at)), plannerMode);
    assert.equal(summarizeV2Result(run.result, run.state, { runDir: run.runDir }).handback.options.retry,
      `bullswarm workflow resume ${token} after ${LIMIT_RESET} (reruns the preflight scout)`, plannerMode);
  }
});

test('marked: a preflight scout stopped on a usage limit before a caller program: the run continues without the report and runs its steps', async (t) => {
  const f = stage3Setup(t, { scout: true });
  const dispatch = recordingDispatch((options) => (options.action.id === 'preflight-scout' ? limitStopped(options) : succeed(options)));
  const run = await launch3(f, { runId: 'wf-scq003-abcdef', actions: [step3('write')], dispatch });
  assert.deepEqual(dispatch.seen, [
    { id: 'preflight-scout', usageLimitsToCaller: true },
    { id: 'write', usageLimitsToCaller: undefined },
  ]);
  assert.equal(run.result.status, 'completed');
  assert.equal(run.state.actions.find((action) => action.id === 'write').status, 'succeeded');
  // The caller's program keeps the run going: the event says so.
  assert.deepEqual(eventsOfType(run.runDir, 'preflight.scout_finished').map((event) => event.payload), [
    { status: 'failed', failureKind: 'quota', why: LIMIT_WHY, retryAfter: LIMIT_RESET, runContinues: true },
  ]);
  // A scout the run went on without did not end it: no record, never run again.
  assert.equal(Object.hasOwn(run.state.preflight.scout, 'limitStop'), false);
  assert.equal(v2LimitStoppedDispatch(run.state), null);
});

test('unmarked: the planner and scout of a saved run are dispatched without the usage-limit rules and keep their old reasons', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched', scout: true });
  const dispatch = recordingDispatch((options) => limitStopped(options));
  const run = await launchPlanned(f, 'wf-plq005-abcdef', dispatch, { runFeatures: STAGE2_RUN_FEATURES });
  // The scout's failure does not stop a saved run: its planner still runs.
  assert.deepEqual(dispatch.seen, [
    { id: 'preflight-scout', usageLimitsToCaller: false },
    { id: 'workflow-planner', usageLimitsToCaller: false },
  ]);
  assert.equal(run.result.reason, `the workflow planner could not produce a mechanically valid program: ${LIMIT_WHY}`);
  const [scouted] = eventsOfType(run.runDir, 'preflight.scout_finished').map((event) => event.payload);
  const [planned] = eventsOfType(run.runDir, 'planner.finished').map((event) => event.payload);
  assert.equal(Object.hasOwn(scouted, 'retryAfter'), false);
  assert.equal(Object.hasOwn(scouted, 'runContinues'), false);
  assert.equal(Object.hasOwn(planned, 'retryAfter'), false);
  // The watch prints a saved run's planner failure as before.
  const [line] = notableWatchEvents({ events: eventsOfType(run.runDir, 'planner.finished'), state: run.state, runDir: run.runDir }).notable;
  assert.equal(renderWatchEvent(line), `× planning attempt rejected · ${LIMIT_WHY}`);
  assert.equal(watchTrouble(line, { program: true }), 'rejected');
  // No stop record, no resume option, and resume still has nothing to retry.
  assert.equal(Object.hasOwn(run.state.planner, 'limitStop'), false);
  assert.equal(Object.hasOwn(run.state.preflight.scout, 'limitStop'), false);
  assert.equal(summarizeV2Result(run.result, run.state, { runDir: run.runDir }).handback.options.retry, undefined);
  assert.equal(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId: 'wf-plq005-abcdef' }).status, 'nothing-to-retry');
});

test('marked: after a planner or scout stop, plan revise runs the caller\'s program instead, and resume no longer runs the planner or scout', async (t) => {
  for (const [settings, runId] of [[{ plannerMode: 'dispatched' }, 'wf-plq006-abcdef'], [{ plannerMode: 'dispatched', scout: true }, 'wf-scq004-abcdef']]) {
    const f = stage3Setup(t, settings);
    const stopped = await launchPlanned(f, runId, recordingDispatch((options) => limitStopped(options)));
    assert.equal(stopped.result.status, 'partial', runId);
    assert.ok(v2LimitStoppedDispatch(stopped.state), runId);
    const body = normalizeRevisionInput(programOf([step3('write')]).program, { summary: 'plan it myself', rerun: [] });
    const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request: createRevisionRequest({ ...body, baseRevision: stopped.state.program.revision }, { source: 'cli' }), waitMs: 0 });
    assert.equal(revised.status, 'applied', runId);
    assert.equal(revised.reopened?.previousStatus, 'partial', runId);
    // The caller's plan replaces what the stopped dispatch would have given.
    assert.equal(Object.hasOwn(revised.state.planner, 'limitStop'), false, runId);
    assert.equal(Object.hasOwn(revised.state.preflight.scout, 'limitStop'), false, runId);
    const after = recordingDispatch((options) => succeed(options));
    const resumed = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
      dependencies: { refreshPools: async () => null, dispatchV2Action: after },
    });
    assert.deepEqual(after.seen.map((entry) => entry.id), ['write'], `${runId}: only the caller's step runs; no planner or scout again`);
    assert.equal(resumed.result.status, 'completed', runId);
    assert.equal(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId }).status, 'nothing-to-retry', runId);
  }
});

// Owner decision (2026-09-25): resuming after the pool is back is the "wait"
// option. `workflow resume` reopens the run through reopenV2RunForRetry, and
// the relaunched kernel's normal loop runs the stopped dispatch again.
test('marked: resume after a Workflow Planner stopped on a usage limit runs the planner again, and the run completes with the program it returns', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched' });
  const runId = 'wf-plq008-abcdef';
  const stopped = await launchPlanned(f, runId, recordingDispatch((options) => limitStopped(options)));
  assert.equal(stopped.result.status, 'partial');
  const reopened = reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId });
  assert.equal(reopened.status, 'reopened');
  assert.deepEqual(reopened.requeued, ['workflow-planner']);
  assert.deepEqual(reopened.dispatch, { id: 'workflow-planner', who: 'the workflow planner', retryAfter: LIMIT_RESET });
  assert.equal(reopened.archivedResult, join(stopped.runDir, 'result-before-resume-1.json'));
  assert.ok(existsSync(reopened.archivedResult));
  assert.equal(existsSync(join(stopped.runDir, 'result.json')), false);
  assert.equal(reopened.state.lifecycle.status, 'running');
  assert.equal(reopened.state.planner.status, 'waiting');
  assert.equal(Object.hasOwn(reopened.state.planner, 'limitStop'), false);
  assert.deepEqual(eventsOfType(stopped.runDir, 'workflow.reopened').map((event) => event.payload), [
    { previousStatus: 'partial', source: 'resume', archivedResult: reopened.archivedResult, requeued: ['workflow-planner'] },
  ]);

  const after = recordingDispatch((options) => (options.action.id === 'workflow-planner' ? planned(options, [step3('write')]) : succeed(options)));
  const resumed = await resumeRun(f, runId, after);
  assert.deepEqual(after.seen, [{ id: 'workflow-planner', usageLimitsToCaller: true }, { id: 'write', usageLimitsToCaller: undefined }]);
  assert.equal(resumed.result.status, 'completed');
  assert.equal(resumed.state.actions.find((action) => action.id === 'write').status, 'succeeded');
  assert.deepEqual(eventsOfType(stopped.runDir, 'planner.finished').map((event) => [event.payload.turn, event.payload.ok]), [[1, false], [1, true]]);
  // The stopped attempt stays on record; the rerun is the turn's next
  // attempt, with its own files.
  const attempts = resumed.state.planner.attempts;
  assert.deepEqual(attempts.map((attempt) => [attempt.ordinal, attempt.turn, attempt.status, attempt.failureKind ?? null]), [[1, 1, 'failed', 'quota'], [2, 1, 'succeeded', null]]);
  assert.equal(basename(attempts[0].taskFile), 'task-workflow-planner-turn-1-attempt-1.md');
  assert.equal(basename(attempts[1].taskFile), 'task-workflow-planner-turn-1-attempt-2.md');
  assert.equal(readFileSync(attempts[0].outputFile, 'utf8'), 'it failed', 'the stopped attempt\'s output is not overwritten');
  assert.equal(Object.hasOwn(resumed.state.planner, 'limitStop'), false);
  assert.equal(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId }).status, 'nothing-to-retry');
});

test('marked: resume after a preflight scout stopped on a usage limit runs the scout again, then the dispatched planner, and the run completes', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched', scout: true });
  const runId = 'wf-scq006-abcdef';
  const stopped = await launchPlanned(f, runId, recordingDispatch((options) => limitStopped(options)));
  assert.equal(stopped.result.status, 'partial');
  const reopened = reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId });
  assert.equal(reopened.status, 'reopened');
  assert.deepEqual(reopened.requeued, ['preflight-scout']);
  assert.deepEqual(reopened.dispatch, { id: 'preflight-scout', who: 'the preflight scout', retryAfter: LIMIT_RESET });
  const scout = reopened.state.preflight.scout;
  assert.deepEqual([scout.status, scout.finishedAt, scout.lastFailure, Object.hasOwn(scout, 'limitStop')], ['pending', null, null, false]);
  assert.deepEqual(scout.attempts.map((attempt) => [attempt.ordinal, attempt.status, attempt.failureKind]), [[1, 'failed', 'quota']]);
  assert.deepEqual(eventsOfType(stopped.runDir, 'workflow.reopened').map((event) => event.payload.requeued), [['preflight-scout']]);

  const after = recordingDispatch((options) => {
    if (options.action.id === 'preflight-scout') return scouted(options);
    if (options.action.id === 'workflow-planner') return planned(options, [step3('write')]);
    return succeed(options);
  });
  const resumed = await resumeRun(f, runId, after);
  assert.deepEqual(after.seen.map((entry) => entry.id), ['preflight-scout', 'workflow-planner', 'write']);
  assert.equal(resumed.result.status, 'completed');
  const attempts = resumed.state.preflight.scout.attempts;
  assert.deepEqual(attempts.map((attempt) => [attempt.ordinal, attempt.status]), [[1, 'failed'], [2, 'succeeded']]);
  assert.equal(basename(attempts[1].taskFile), 'task-preflight-scout-attempt-2.md');
  assert.equal(readFileSync(attempts[0].outputFile, 'utf8'), 'it failed', 'the stopped attempt\'s output is not overwritten');
  assert.equal(resumed.state.preflight.scout.status, 'succeeded');
  assert.equal(readFileSync(resumed.state.preflight.scout.outputFile, 'utf8'), SCOUT_REPORT);
  assert.deepEqual(eventsOfType(stopped.runDir, 'preflight.scout_finished').map((event) => event.payload.status), ['failed', 'succeeded']);
});

test('marked: in a caller-planner run, resume after the scout stopped on a usage limit runs the scout again and hands back its report for the caller\'s program', async (t) => {
  const f = stage3Setup(t, { scout: true });
  const runId = 'wf-scq007-abcdef';
  const stopped = await launchPlanned(f, runId, recordingDispatch((options) => limitStopped(options)));
  assert.equal(stopped.result.status, 'partial');
  assert.deepEqual(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId }).requeued, ['preflight-scout']);
  const after = recordingDispatch((options) => scouted(options));
  const resumed = await resumeRun(f, runId, after);
  assert.deepEqual(after.seen.map((entry) => entry.id), ['preflight-scout'], 'no planner is dispatched in a caller-planner run');
  assert.equal(resumed.result.status, 'partial');
  assert.equal(resumed.result.reason, `no program to run (the scout report is at ${resumed.state.preflight.scout.outputFile}). `
    + `Add steps with bullswarm workflow plan revise ${resumed.state.shortId} --program <file.json>, or start a new run with --program`);
  // The scout got through: resume has nothing left to run again.
  assert.equal(summarizeV2Result(resumed.result, resumed.state, { runDir: resumed.runDir }).handback.options.retry, undefined);
  assert.equal(reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId }).status, 'nothing-to-retry');
});

test('marked: resume after a planner stopped at a steering boundary hands the steering back to the rerun turn, then runs the steps left and the new ones', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched' });
  const runId = 'wf-plq009-abcdef';
  const message = 'Keep the notes short.';
  let plannerTurns = 0;
  const first = recordingDispatch((options) => {
    if (options.action.id === 'workflow-planner') {
      plannerTurns += 1;
      return plannerTurns > 1 ? limitStopped(options) : planned(options, [step3('write'), step3('later', { dependsOn: ['write'] })]);
    }
    writeFileSync(join(f.bullswarmDir, 'workflows', runId, 'steering.jsonl'), `${JSON.stringify({
      id: 'steer-limit', message, queuedAt: new Date().toISOString(), delivery: 'next-not-yet-started-planner-checkpoint',
    })}\n`);
    return succeed(options);
  });
  const stopped = await launchPlanned(f, runId, first);
  assert.equal(stopped.result.status, 'partial');
  const { at: _at, ...stop } = stopped.state.planner.limitStop;
  assert.deepEqual(stop, { failureKind: 'quota', retryAfter: LIMIT_RESET, boundary: 'steering', steeringIds: ['steer-limit'] });
  assert.deepEqual(stopped.state.steering.map((entry) => entry.id), ['steer-limit']);
  // The steering turn runs before the step it left pending; nothing gets
  // through before the planner's pool is back, so that is the time.
  assert.deepEqual(stopped.state.actions.map((action) => [action.id, action.status]), [['write', 'succeeded'], ['later', 'pending']]);
  assert.equal(summarizeV2Result(stopped.result, stopped.state, { runDir: stopped.runDir }).handback.options.retry,
    `bullswarm workflow resume ${stopped.state.shortId} after ${LIMIT_RESET} (reruns the workflow planner, later)`);

  const reopened = reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId });
  assert.deepEqual([reopened.status, reopened.requeued], ['reopened', ['workflow-planner', 'later']]);
  assert.deepEqual(reopened.state.steering, [], 'the steering goes back to the next planner turn');
  let rerunTask = '';
  const after = recordingDispatch((options) => {
    if (options.action.id === 'workflow-planner') {
      rerunTask = options.taskText;
      return planned(options, [step3('notes')]);
    }
    return succeed(options);
  });
  const resumed = await resumeRun(f, runId, after);
  assert.equal(after.seen[0].id, 'workflow-planner', 'the planner turn runs before any step');
  assert.deepEqual(after.seen.slice(1).map((entry) => entry.id).sort(), ['later', 'notes']);
  assert.ok(rerunTask.includes(message), 'the rerun turn is given the steering');
  assert.deepEqual(eventsOfType(stopped.runDir, 'planner.started').map((event) => event.payload.boundary), ['initial', 'steering', 'steering']);
  assert.deepEqual(eventsOfType(stopped.runDir, 'steering.delivered').map((event) => event.payload.steeringId), ['steer-limit', 'steer-limit']);
  assert.equal(resumed.result.status, 'completed');
  assert.deepEqual(resumed.state.actions.map((action) => [action.id, action.status]), [['write', 'succeeded'], ['later', 'succeeded'], ['notes', 'succeeded']]);
  assert.deepEqual(resumed.state.steering.map((entry) => [entry.id, entry.decisionSequence]), [['steer-limit', 2]]);
});

test('marked: a scout stop\'s finish event says whether the run went on, so a replay of the run revised later still reads that it finished there', async (t) => {
  const f = stage3Setup(t, { plannerMode: 'dispatched', scout: true });
  const runId = 'wf-scq005-abcdef';
  const stopped = await launchPlanned(f, runId, recordingDispatch((options) => limitStopped(options)));
  assert.equal(stopped.result.status, 'partial');
  const body = normalizeRevisionInput(programOf([step3('write')]).program, { summary: 'plan it myself', rerun: [] });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request: createRevisionRequest({ ...body, baseRevision: stopped.state.program.revision }, { source: 'cli' }), waitMs: 0 });
  assert.equal(revised.status, 'applied');
  assert.deepEqual(revised.state.program.actions.map((action) => action.id), ['write'], 'the revised run has a program the scout\'s run never had');
  // A replay from the start (watch --after 0) against the revised state.
  const scoutEvent = readEvents(stopped.runDir, { after: 0 }).find((event) => event.type === 'preflight.scout_finished');
  assert.equal(scoutEvent.payload.runContinues, false);
  const [line] = notableWatchEvents({ events: [scoutEvent], state: revised.state, runDir: stopped.runDir }).notable;
  assert.equal(line.runContinues, false);
  assert.equal(renderWatchEvent(line).replace(/^\S+ /, '⚠ '), `⚠ preflight scout stopped · out of quota on relay · back at ${LIMIT_RESET}`);
  // An event written before the field falls back to the state, which moved on.
  const { runContinues: _written, ...older } = scoutEvent.payload;
  const [fallback] = notableWatchEvents({ events: [{ ...scoutEvent, payload: older }], state: revised.state, runDir: stopped.runDir }).notable;
  assert.equal(fallback.runContinues, true);
});
