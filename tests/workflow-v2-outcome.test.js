import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvidence } from '../src/workflow/ledger.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import {
  V2_RETRYABLE_FAILURE_KINDS, consolidateV2Gaps, createV2ResultEnvelope, deserializeV2ResultEnvelope,
  evaluateV2Progress, formatV2HandbackLines, serializeV2ResultEnvelope, summarizeV2Result, v2LimitStoppedDispatch, v2RetryPlan, validateV2ResultEnvelope,
} from '../src/workflow/v2-outcome.js';
import { evidenceFailureWhy } from '../src/workflow/evidence-runner.js';

const goal = () => createV2GoalDocument({
  goal: 'Deliver a report', cwd: '/tmp/repo', settings: { concurrency: 2, workspaceMode: 'isolated' },
  requirements: [{ id: 'report-correct', text: 'The report is correct' }],
});

function plannedState() {
  const state = createV2State(goal(), { runId: 'wf-test-abcdef', shortId: 'abc234' });
  state.lifecycle = { status: 'running', startedAt: '2026-08-31T01:00:00Z', finishedAt: null, resultFile: null };
  state.planner = { status: 'waiting', turns: 1, lastDecision: { kind: 'program-created' }, session: null, attempts: [] };
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [
      { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
      { id: 'check-report', purpose: 'Check report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Check report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
    ],
  };
  state.actions = [
    { id: 'write-report', status: 'pending', attempts: 0, programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [], lastFailure: null },
    { id: 'check-report', status: 'pending', attempts: 0, programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [], lastFailure: null },
  ];
  state.presentation = { stages: [
    { id: 'r1-implementation', label: 'Implementation', revision: 1, actionIds: ['write-report'], startedAt: null, completedAt: null },
    { id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['check-report'], startedAt: null, completedAt: null },
  ] };
  return state;
}

test('kernel distinguishes runnable work, a real gap boundary, and partial exhaustion', () => {
  const state = plannedState();
  assert.deepEqual(evaluateV2Progress(state).runnable, ['write-report']);
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: ['report'] },
    { id: 'check-report', status: 'failed', attempts: 0, programRevision: 1, lastFailure: { kind: 'semantic', message: 'incorrect' } },
  ];
  const boundary = evaluateV2Progress(state);
  assert.equal(boundary.status, 'needs-planner');
  assert.equal(boundary.boundary, 'gaps');
  assert.equal(boundary.gaps.requirements[0].id, 'report-correct');
  assert.deepEqual(boundary.gaps.actions.map((action) => action.id), ['check-report']);
  assert.equal(evaluateV2Progress(state, { plannerExhausted: true }).status, 'partial');
});

test('kernel alone derives verified completion from fresh requirement evidence', () => {
  const state = plannedState();
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report.md matches the requirement'], concerns: [] } } });
  assert.equal(evaluateV2Progress(state).status, 'ready-to-finalize');
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z' });
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.requirements[0].status, 'passed');
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
});

test('result validation rejects malformed nested requirements, actions, gaps, and usage', () => {
  const state = plannedState();
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report matches'], concerns: [] } } });
  const valid = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z' });
  const mutate = (fn) => { const value = structuredClone(valid); fn(value); return value; };
  assert.throws(() => serializeV2ResultEnvelope(mutate((value) => { value.requirements[0] = {}; })), /requirements\[0\]\.id/);
  assert.throws(() => serializeV2ResultEnvelope(mutate((value) => { value.actions[0].status = 'mystery'; })), /actions\[0\]\.status/);
  assert.throws(() => serializeV2ResultEnvelope(mutate((value) => { value.usage.total = -1; })), /usage\.total/);
  assert.throws(() => serializeV2ResultEnvelope(mutate((value) => {
    value.requirements[0].evidence[0].mechanicalFailure = { unexpected: [] };
  })), /mechanicalFailure\.unexpected is not allowed/);

  const partialState = plannedState();
  partialState.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'failed', attempts: 0, programRevision: 1, lastFailure: { kind: 'semantic' } },
  ];
  const partial = createV2ResultEnvelope(partialState, { plannerExhausted: true, finishedAt: '2026-08-31T01:10:00Z' });
  partial.gaps.actions[0].failure = { unexpected: [] };
  assert.throws(() => serializeV2ResultEnvelope(partial), /failure\.unexpected is not allowed/);
  partial.gaps.actions[0].failure = { kind: 'semantic' };
  partial.gaps = { schemaVersion: 'bullswarm.workflow.gaps.v2' };
  assert.throws(() => serializeV2ResultEnvelope(partial), /gaps\.intentId/);
});

test('partial result preserves useful delivery and explicit unresolved evidence', () => {
  const state = plannedState();
  state.actions = [{ id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] }, { id: 'check-report', status: 'failed', attempts: 0, programRevision: 1, lastFailure: { kind: 'semantic' } }];
  const result = createV2ResultEnvelope(state, { plannerExhausted: true, finishedAt: '2026-08-31T01:10:00Z' });
  assert.equal(result.status, 'partial');
  assert.equal(result.verified, false);
  assert.equal(result.actions[0].outputFile, '/tmp/report.md');
  assert.equal(result.gaps.requirements[0].status, 'pending');
});

test('unplanned and cancelled workflows are kernel states, not planner verdicts', () => {
  const state = createV2State(goal(), { runId: 'wf-test-abcdef', shortId: 'abc234' });
  assert.deepEqual(evaluateV2Progress(state), { status: 'needs-planner', terminal: false, boundary: 'initial', reason: 'the goal has not been planned yet' });
  state.cancellation = { requested: true, requestedAt: '2026-08-31T01:00:00Z', reason: 'operator stopped it' };
  assert.equal(evaluateV2Progress(state).status, 'cancelled');
  assert.equal(createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:01:00Z' }).status, 'cancelled');
});

test('gap report is compact and contains no planner repair instruction', () => {
  const gaps = consolidateV2Gaps(plannedState());
  assert.equal(gaps.schemaVersion, 'bullswarm.workflow.gaps.v2');
  assert.ok(!JSON.stringify(gaps).includes('repair'));
  assert.equal(gaps.requirements[0].status, 'pending');
});

test('result envelope carries the reasoning level of each action\'s last attempt', () => {
  const state = plannedState();
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 2, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  // A retry can land on another connector with another level; the envelope
  // reports the attempt whose output it is describing.
  state.attempts = [
    {
      id: 'write-report-1', actionId: 'write-report', ordinal: 1, status: 'failed',
      pool: 'alpha', model: 'alpha-sol', startedAt: '2026-08-31T01:01:00Z',
      reasoning: { requested: 'max', applied: 'max', source: 'action', clamped: false },
      routeWhy: 'first fixture route',
      routeCandidates: [],
    },
    {
      id: 'write-report-2', actionId: 'write-report', ordinal: 2, status: 'succeeded',
      pool: 'beta', model: 'beta-luna', startedAt: '2026-08-31T01:02:00Z',
      reasoning: { requested: 'max', applied: 'high', source: 'action', clamped: true },
      routeWhy: 'retry fixture route',
      routeCandidates: [{ pool: 'beta', effectiveSurplus: null, urgencyState: null, forecastPacingPct: null }],
    },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report.md matches'], concerns: [] } } });

  const result = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z' });
  assert.deepEqual(result.actions[0].reasoning, { requested: 'max', applied: 'high', source: 'action', clamped: true });
  // The envelope reports the route the LAST attempt was dispatched under:
  // a retry can land elsewhere, so the reason and candidate table follow it.
  assert.equal(result.actions[0].routeWhy, 'retry fixture route');
  assert.deepEqual(result.actions[0].routeCandidates, [{ pool: 'beta', effectiveSurplus: null, urgencyState: null, forecastPacingPct: null }]);
  // An action with no attempt at all reports null rather than inventing a level.
  assert.equal(result.actions[1].reasoning, null);
  assert.equal(result.actions[1].routeWhy, null);
  assert.equal(result.actions[1].routeCandidates, null);
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);

  // Envelopes written before reasoning levels existed still deserialize.
  const legacy = structuredClone(result);
  for (const action of legacy.actions) delete action.reasoning;
  assert.deepEqual(deserializeV2ResultEnvelope(JSON.stringify(legacy)).actions.map((action) => action.id), ['write-report', 'check-report']);
  // Envelopes written before route provenance existed still deserialize too.
  const preroute = structuredClone(result);
  for (const action of preroute.actions) { delete action.routeWhy; delete action.routeCandidates; }
  assert.deepEqual(deserializeV2ResultEnvelope(JSON.stringify(preroute)).actions.map((action) => action.id), ['write-report', 'check-report']);
  const broken = structuredClone(result);
  broken.actions[0].reasoning = 'high';
  assert.throws(() => serializeV2ResultEnvelope(broken), /actions\[0\]\.reasoning must be an object/);
});

test('the result envelope carries each action\'s kind, and envelopes written before kinds still deserialize', () => {
  const state = plannedState();
  // Only the writer states a nature; the checker predates kinds entirely.
  state.program.actions[0].kind = 'implement';
  state.lifecycle = { status: 'completed', startedAt: '2026-08-31T01:00:00Z', finishedAt: '2026-08-31T01:10:00Z', resultFile: null };
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report.md matches'], concerns: [] } } });

  const result = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z' });
  assert.equal(result.actions[0].kind, 'implement');
  // An action without a kind reports null rather than a guessed one.
  assert.equal(result.actions[1].kind, null);
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);

  const legacy = structuredClone(result);
  for (const action of legacy.actions) delete action.kind;
  assert.deepEqual(
    deserializeV2ResultEnvelope(JSON.stringify(legacy)).actions.map((action) => action.id),
    ['write-report', 'check-report'],
  );
  const broken = structuredClone(result);
  broken.actions[0].kind = { name: 'implement' };
  assert.throws(() => serializeV2ResultEnvelope(broken), /actions\[0\]\.kind must be a non-empty string/);
});

test('result envelope carries last-attempt bytes and usage totals; missing values stay null', () => {
  const state = plannedState();
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 2, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 1, programRevision: 1, artifactIds: [] },
  ];
  state.attempts = [
    {
      id: 'write-report-1', actionId: 'write-report', ordinal: 1, status: 'failed',
      pool: 'alpha', model: 'alpha-sol', startedAt: '2026-08-31T01:01:00Z',
      bytes: { taskFile: 100, authorPrompt: 40, kernel: 60, dependencyInputs: 0, output: 10 },
    },
    {
      id: 'write-report-2', actionId: 'write-report', ordinal: 2, status: 'succeeded',
      pool: 'beta', model: 'beta-luna', startedAt: '2026-08-31T01:02:00Z',
      bytes: { taskFile: 200, authorPrompt: 40, kernel: 160, dependencyInputs: 0, output: 50 },
    },
    {
      id: 'check-report-1', actionId: 'check-report', ordinal: 1, status: 'succeeded',
      pool: 'beta', model: 'beta-luna', startedAt: '2026-08-31T01:03:00Z',
      bytes: { taskFile: 300, authorPrompt: 80, kernel: 170, dependencyInputs: 50, output: 20 },
    },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report.md matches'], concerns: [] } } });

  const result = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z' });
  assert.deepEqual(result.actions[0].bytes, {
    taskFile: 200, authorPrompt: 40, kernel: 160, dependencyInputs: 0, output: 50,
  });
  assert.deepEqual(result.actions[1].bytes, {
    taskFile: 300, authorPrompt: 80, kernel: 170, dependencyInputs: 50, output: 20,
  });
  assert.deepEqual(result.usage.bytes, { taskFiles: 600, dependencyInputs: 50, outputs: 80 });
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);

  const empty = plannedState();
  empty.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  empty.ledger = applyEvidence(empty.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'passed', evidence: ['report.md matches'], concerns: [] } } });
  const without = createV2ResultEnvelope(empty, { finishedAt: '2026-08-31T01:10:00Z' });
  assert.equal(without.actions[0].bytes, null);
  assert.equal(without.actions[1].bytes, null);
  assert.equal(without.usage.bytes, null);
});

// A program-mode run whose `build` step declares one command check and whose
// `notes` step declares none (stage 2, §2.8).
function evidenceState({ build = {}, attempts = [] } = {}) {
  const state = createV2State(createV2GoalDocument({
    goal: 'Ship the acme widget', cwd: '/tmp/acme',
    settings: { concurrency: 2, workspaceMode: 'shared', executionMode: 'program' },
    requirements: [{ id: 'widget-works', text: 'The widget works' }],
  }), { runId: 'wf-test-evidnc', shortId: 'evd234' });
  state.lifecycle = { status: 'running', startedAt: '2026-09-24T01:00:00Z', finishedAt: null, resultFile: null };
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [
      { id: 'build', purpose: 'Build the widget', dependsOn: [], affects: ['widget-works'], ownedFiles: ['widget.js'], prompt: 'Write widget.js.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], evidence: [{ type: 'command', cmd: 'node --test tests/widget.test.js' }] },
      { id: 'notes', purpose: 'Write notes', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Summarise.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [] },
    ],
  };
  const count = (id) => attempts.filter((attempt) => attempt.actionId === id).length;
  state.actions = [
    { id: 'build', status: 'succeeded', attempts: count('build'), programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: '/tmp/acme-run/out-build-attempt-1.md', artifactIds: [], lastFailure: null, ...build },
    { id: 'notes', status: 'succeeded', attempts: count('notes'), programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: '/tmp/acme-run/out-notes-attempt-1.md', artifactIds: [], lastFailure: null },
  ];
  state.attempts = attempts;
  state.presentation = { stages: [{ id: 'r1-implementation', label: 'Implementation', revision: 1, actionIds: ['build', 'notes'], startedAt: null, completedAt: null }] };
  return state;
}

const FAILED_CHECK = {
  type: 'command', cmd: 'node --test tests/widget.test.js', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 1830,
  tail: 'not ok 1 - joins words with one hyphen', log: '/tmp/acme-run/evidence-build-attempt-1-1.log', why: 'exit 1',
};

test('evidenceResults: only steps that declare evidence carry the key; null when the latest attempt ran none', () => {
  // The worker process died, so no check ran (E15).
  const state = evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'process', message: 'worker exited with code 1' } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process' }],
  });
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
  assert.equal(result.actions[0].evidenceResults, null);
  assert.equal(Object.hasOwn(result.actions[1], 'evidenceResults'), false, 'a step without evidence keeps the older shape');
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);

  // The exact-field validator accepts results and refuses malformed ones.
  const withResults = structuredClone(result);
  withResults.actions[0].evidenceResults = [FAILED_CHECK];
  assert.equal(validateV2ResultEnvelope(withResults), true);
  const bad = (mutate) => { const value = structuredClone(withResults); mutate(value.actions[0]); return value; };
  assert.throws(() => validateV2ResultEnvelope(bad((action) => { action.evidenceResults = [{ ...FAILED_CHECK, verdict: 'x' }]; })), /actions\[0\]\.evidenceResults\[0\]\.verdict is not allowed/);
  assert.throws(() => validateV2ResultEnvelope(bad((action) => { action.evidenceResults = [{ ...FAILED_CHECK, status: 'maybe' }]; })), /evidenceResults\[0\]\.status/);
  assert.throws(() => validateV2ResultEnvelope(bad((action) => { action.evidenceResults = Array(6).fill(FAILED_CHECK); })), /at most 5 items/);
  assert.throws(() => validateV2ResultEnvelope(bad((action) => { action.evidenceResults = 'passed'; })), /must be an array/);
});

test('a failed-evidence step needs the caller: not retryable, listed in needsCaller, and its handback why is the §2.7 line', () => {
  assert.equal(V2_RETRYABLE_FAILURE_KINDS.includes('failed-evidence'), false);
  const why = 'node --test tests/widget.test.js → exit 1: not ok 1 - joins words with one hyphen';
  const state = evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'failed-evidence', message: why } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process' }],
  });
  assert.deepEqual(v2RetryPlan(state), { rerun: [], blocked: [], needsCaller: [{ id: 'build', status: 'failed', failureKind: 'failed-evidence' }] });
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
  assert.deepEqual(result.handback.unfinished, [{ id: 'build', status: 'failed', failureKind: 'failed-evidence', why, retryable: false }]);
  assert.deepEqual(result.actions[0].failure, { kind: 'failed-evidence', message: why });
});

test('the envelope carries the latest attempt\'s evidenceResults', () => {
  const passed = { ...FAILED_CHECK, status: 'passed', exit: 0, tail: 'ok 1', why: null, log: '/tmp/acme-run/evidence-build-attempt-2-1.log' };
  const state = evidenceState({
    build: { status: 'succeeded' },
    attempts: [
      { id: 'build-1', actionId: 'build', ordinal: 1, status: 'interrupted', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK] },
      { id: 'build-2', actionId: 'build', ordinal: 2, status: 'succeeded', evidenceResults: [passed] },
    ],
  });
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
  assert.deepEqual(result.actions[0].evidenceResults, [passed]);
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
});

test('F17: a failed-evidence reason longer than the handback keeps its suffix; the middle is cut instead', () => {
  const longCheck = {
    ...FAILED_CHECK,
    cmd: "node scripts/read-back.mjs --channel release-announcements --expect 'Release 2.4.0 is live' --retries 3",
    tail: 'posting check\nread-back failed: message "Release 2.4.0 is live" not found in the last 50 messages of #release-announcements (checked 3 times)',
  };
  const cases = [
    [[longCheck], ' · act steps are not retried'],
    [[longCheck], ' · no retry: acme-pool is no longer eligible'],
    [[longCheck, FAILED_CHECK, FAILED_CHECK], ''],
  ];
  for (const [results, suffix] of cases) {
    const why = evidenceFailureWhy(results, { suffix });
    const tail = `${results.length > 1 ? ` (+${results.length - 1} more failed)` : ''}${suffix}`;
    assert.ok(why.length > 160 && why.endsWith(tail), `the stored reason is over 160 characters and ends with ${tail}: ${why}`);
    const state = evidenceState({
      build: { status: 'failed', lastFailure: { kind: 'failed-evidence', message: why } },
      attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'failed-evidence', why, evidenceResults: results }],
    });
    const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
    assert.equal(result.handback.unfinished[0].why, why, 'result.json keeps the whole reason');
    const summary = summarizeV2Result(result, state, { runDir: '/tmp/acme-run', features: { deliverableGate: 1, proofLabels: 1 } });
    const clipped = summary.handback.unfinished[0].why;
    assert.ok(clipped.length <= 160, clipped);
    assert.ok(clipped.endsWith(`…${tail}`), `the suffix survives the cut: ${clipped}`);
    assert.ok(clipped.startsWith(why.slice(0, 60)), 'the reason still opens with the check label');
    const line = formatV2HandbackLines(summary).find((entry) => entry.startsWith('  step build:'));
    assert.equal(line, `  step build: failed (failed-evidence) — ${clipped}`);
  }
  // A long reason with no kept suffix is cut at its end, as before.
  const plain = `worker exited with code 1 ${'x'.repeat(200)}`;
  const state = evidenceState({ build: { status: 'failed', lastFailure: { kind: 'process', message: plain } }, attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process' }] });
  const summary = summarizeV2Result(createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' }), state, { runDir: '/tmp/acme-run', features: {} });
  assert.equal(summary.handback.unfinished[0].why, plain.slice(0, 160));
});

test('a marked run\'s reason that names the held pools after ` · no retry: ` keeps that list through the cut', () => {
  // v2-dispatch.js noRetry: why nothing ran after the attempt, pool by pool.
  const held = ' · no retry: luna-1 already failed on this step; luna-2 paused for quota until 2026-09-24T03:00:00.000Z';
  const marked = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  const stateFor = (why) => evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'process', message: why } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process', why }],
  });
  const stderr = (count) => `worker exited with code 1: ${'npm ERR! missing script: build '.repeat(count).trim()}`;
  // Over the summary's 160 characters: result.json keeps it whole, and the
  // summary cuts the middle.
  const why = `${stderr(4)}${held}`;
  assert.ok(why.length > 160 && why.length <= 300, why);
  const state = stateFor(why);
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: marked });
  assert.equal(result.handback.unfinished[0].why, why, 'result.json keeps the whole reason');
  const summary = summarizeV2Result(result, state, { runDir: '/tmp/acme-run', features: marked });
  const clipped = summary.handback.unfinished[0].why;
  assert.ok(clipped.length <= 160, clipped);
  assert.ok(clipped.endsWith(`…${held}`), `the held list survives the cut: ${clipped}`);
  assert.ok(clipped.startsWith('worker exited with code 1: npm ERR!'), clipped);
  const line = formatV2HandbackLines(summary).find((entry) => entry.startsWith('  step build:'));
  // The step declares a check its failed worker never reached.
  assert.equal(line, `  step build: failed (process) — ${clipped} · evidence not run`);
  // Over result.json's 300 characters: the stored reason keeps the list too.
  const longer = `${stderr(12)}${held}`;
  assert.ok(longer.length > 300, longer);
  const stored = createV2ResultEnvelope(stateFor(longer), { finishedAt: '2026-09-24T01:10:00Z', features: marked }).handback.unfinished[0].why;
  assert.ok(stored.length <= 300 && stored.endsWith(`…${held}`), stored);
  // An unmarked run's stored reason is cut at its end, as before.
  const unmarked = createV2ResultEnvelope(stateFor(longer), { finishedAt: '2026-09-24T01:10:00Z', features: {} }).handback.unfinished[0].why;
  assert.equal(unmarked, longer.slice(0, 300));
});

test('F23: a failed step whose worker failed before its evidence ran reads `evidence not run` in its handback line', () => {
  const summaryOf = (state) => summarizeV2Result(createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' }), state, { runDir: '/tmp/acme-run', features: { deliverableGate: 1, proofLabels: 1 } });
  const stepLine = (summary, id) => formatV2HandbackLines(summary).find((line) => line.startsWith(`  step ${id}:`));
  const failedFirst = evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'process', message: 'worker exited with code 1' } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process' }],
  });
  const result = createV2ResultEnvelope(failedFirst, { finishedAt: '2026-09-24T01:10:00Z' });
  assert.equal(result.actions[0].evidenceResults, null, 'the result JSON keeps null');
  const summary = summaryOf(failedFirst);
  assert.equal(summary.handback.unfinished[0].evidenceNotRun, true);
  assert.equal(stepLine(summary, 'build'), '  step build: failed (process) — worker exited with code 1 · evidence not run');
  // A failed check ran: its own reason, no label.
  const why = 'node --test tests/widget.test.js → exit 1: not ok 1 - joins words with one hyphen';
  const checked = evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'failed-evidence', message: why } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK] }],
  });
  assert.equal(stepLine(summaryOf(checked), 'build'), `  step build: failed (failed-evidence) — ${why}`);
  // A step that declares no evidence reads as before.
  const plain = evidenceState({ attempts: [{ id: 'notes-1', actionId: 'notes', ordinal: 1, status: 'failed', failureKind: 'process' }] });
  plain.actions[1] = { ...plain.actions[1], status: 'failed', lastFailure: { kind: 'process', message: 'worker exited with code 1' } };
  const plainSummary = summaryOf(plain);
  assert.equal(Object.hasOwn(plainSummary.handback.unfinished[0], 'evidenceNotRun'), false);
  assert.equal(stepLine(plainSummary, 'notes'), '  step notes: failed (process) — worker exited with code 1');
});

// Stage 3 (§2.9, D22, D27, D34): acceptance, who reviewed, retries and the
// caller verbs in the handback, and the verifyRounds caps.
const STAGE3 = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
const ACCEPTED_AT = '2026-09-24T01:08:00.000Z';

test('an accepted step reports its acceptance, the reason names it, and the fields are exact', () => {
  const state = evidenceState({
    build: {
      status: 'succeeded',
      acceptance: { evidence: 'choice', reason: 'the flaky test is known upstream', attemptId: 'build-2', failureKind: 'failed-evidence', at: ACCEPTED_AT, revision: 3 },
    },
    attempts: [
      { id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK] },
      { id: 'build-2', actionId: 'build', ordinal: 2, status: 'failed', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK], retryOf: { attempt: 'build-1', how: 'same-pool' } },
    ],
  });
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 });
  assert.deepEqual(result.actions[0].acceptance, {
    evidence: 'choice', reason: 'the flaky test is known upstream', at: ACCEPTED_AT, attemptId: 'build-2', failureKind: 'failed-evidence',
  });
  assert.equal(Object.hasOwn(result.actions[1], 'acceptance'), false, 'a step nobody accepted keeps the older shape');
  assert.match(result.reason, / · 1 step accepted by choice$/);
  assert.equal(result.verified, false, 'a choice is not proof');
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
  const bad = (mutate) => { const value = structuredClone(result); mutate(value.actions[0].acceptance); return value; };
  assert.throws(() => validateV2ResultEnvelope(bad((value) => { value.revision = 3; })), /actions\[0\]\.acceptance\.revision is not allowed/);
  assert.throws(() => validateV2ResultEnvelope(bad((value) => { value.evidence = 'command'; })), /acceptance\.evidence must be choice/);
  assert.throws(() => validateV2ResultEnvelope(bad((value) => { value.reason = ''; })), /acceptance\.reason must be a non-empty string/);
  assert.throws(() => validateV2ResultEnvelope(bad((value) => { value.at = 'soon'; })), /acceptance\.at must be an ISO-compatible timestamp/);
  assert.throws(() => validateV2ResultEnvelope(bad((value) => { value.requirements = [{ id: 'widget-works' }]; })), /requirements\[0\]\.workRevision must be a string or number/);
});

test('an accepted requirement reports who accepted it while its work revision holds; a moved revision lapses it', () => {
  const state = evidenceState();
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'notes', evidenceFor: ['widget-works'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'widget-works': { status: 'failed', evidence: ['the widget drops the last word'], concerns: [] } } });
  const workRevision = state.ledger.requirements['widget-works'].workRevision;
  state.actions[1].acceptance = {
    evidence: 'choice', reason: 'good enough for the demo', attemptId: null, failureKind: null, at: ACCEPTED_AT, revision: 4,
    requirements: [{ id: 'widget-works', workRevision }],
  };
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 });
  assert.deepEqual(result.requirements[0].accepted, { step: 'notes', reason: 'good enough for the demo', at: ACCEPTED_AT });
  assert.equal(result.requirements[0].status, 'failed', 'the requirement is still failing');
  assert.deepEqual(result.actions[1].acceptance.requirements, [{ id: 'widget-works', workRevision }]);
  assert.doesNotMatch(result.reason, /accepted by choice/, 'a requirement acceptance accepts no step');
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
  const extra = structuredClone(result);
  extra.requirements[0].accepted.revision = 4;
  assert.throws(() => validateV2ResultEnvelope(extra), /requirements\[0\]\.accepted\.revision is not allowed/);
  state.actions[1].acceptance.requirements[0].workRevision = 'an-older-revision';
  assert.equal(Object.hasOwn(createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 }).requirements[0], 'accepted'), false);
});

test('evidence entries name the reviewer and whether it was independent of the writers', () => {
  const judged = (writers) => {
    const state = evidenceState();
    state.ledger = applyEvidence(state.ledger, {
      actionId: 'notes', evidenceFor: ['widget-works'], inspectedRevision: 'initial', eventSequence: 1,
    }, { requirements: { 'widget-works': { status: 'passed', evidence: ['it works'], concerns: [] } } }, {
      reviewer: { attemptId: 'notes-1', pool: 'grok', model: 'grok-4', provider: 'grok' },
      ...(writers ? { writers } : {}),
    });
    return createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 }).requirements[0].evidence[0];
  };
  const other = judged([{ actionId: 'build', pool: 'claude-code:acme', provider: 'claude-code' }]);
  assert.deepEqual(other.reviewer, { pool: 'grok', model: 'grok-4', provider: 'grok' });
  assert.equal(other.independent, true);
  assert.equal(judged([{ actionId: 'build', pool: 'grok', provider: 'grok' }, { actionId: 'build', pool: 'codex', provider: 'codex' }]).independent, false);
  assert.equal(judged([]).independent, null, 'no writer attempt known');
  assert.equal(judged([{ actionId: 'build', pool: 'mystery', provider: null }]).independent, null);
  // A record without the fields (a saved run's) keeps the older shape.
  const state = evidenceState();
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'notes', evidenceFor: ['widget-works'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'widget-works': { status: 'passed', evidence: ['it works'], concerns: [] } } });
  const plain = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' }).requirements[0].evidence[0];
  assert.deepEqual(Object.keys(plain), ['sourceAction', 'status', 'evidence', 'concerns', 'eventSequence']);
  // Exact fields.
  const result = createV2ResultEnvelope(evidenceState(), { finishedAt: '2026-09-24T01:10:00Z' });
  result.requirements[0].evidence = [{ ...other }];
  assert.equal(validateV2ResultEnvelope(result), true);
  result.requirements[0].evidence = [{ ...other, reviewer: { ...other.reviewer, attemptId: 'notes-1' } }];
  assert.throws(() => validateV2ResultEnvelope(result), /evidence\[0\]\.reviewer\.attemptId is not allowed/);
  result.requirements[0].evidence = [{ ...other, independent: 'yes' }];
  assert.throws(() => validateV2ResultEnvelope(result), /independent must be true, false or null/);
});

test('a marked run hands back each failed step\'s retries and the rerun and accept verbs; a saved run reads as before', () => {
  const failed = () => evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'failed-evidence', message: 'node --test tests/widget.test.js → exit 1: not ok 1' } },
    attempts: [
      { id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK] },
      { id: 'build-2', actionId: 'build', ordinal: 2, status: 'failed', failureKind: 'failed-evidence', evidenceResults: [FAILED_CHECK], retryOf: { attempt: 'build-1', how: 'same-pool' } },
    ],
  });
  const state = failed();
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 });
  assert.equal(result.handback.unfinished[0].retries, 1);
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
  const summary = summarizeV2Result(result, state, { runDir: '/tmp/acme-run', features: STAGE3 });
  assert.equal(summary.handback.unfinished[0].retries, 1);
  assert.equal(summary.handback.options.rerun, 'bullswarm workflow step rerun evd234 build [--avoid <pool>] (runs it again with its last attempt\'s handoff)');
  assert.equal(summary.handback.options.accept, 'bullswarm workflow step accept evd234 build --reason "…" (recorded as your choice, never proof)');
  const lines = formatV2HandbackLines(summary);
  assert.ok(lines.includes('  step build: failed (failed-evidence) after 1 retry — node --test tests/widget.test.js → exit 1: not ok 1'), lines.join('\n'));
  assert.ok(lines.includes(`  rerun     ${summary.handback.options.rerun}`));
  assert.ok(lines.includes(`  accept    ${summary.handback.options.accept}`));
  // Two failed steps: the commands name <step>.
  const two = failed();
  two.actions[1] = { ...two.actions[1], status: 'failed', attempts: 1, lastFailure: { kind: 'process', message: 'worker exited with code 1' } };
  two.attempts.push({ id: 'notes-1', actionId: 'notes', ordinal: 1, status: 'failed', failureKind: 'process' });
  const both = summarizeV2Result(createV2ResultEnvelope(two, { finishedAt: '2026-09-24T01:10:00Z', features: STAGE3 }), two, { runDir: '/tmp/acme-run', features: STAGE3 });
  assert.match(both.handback.options.rerun, /^bullswarm workflow step rerun evd234 <step> \[--avoid <pool>\]/);
  assert.deepEqual(both.handback.unfinished.map((entry) => entry.retries), [1, 0]);
  // A saved run (stage-2 marker): no count, no new verbs, the line as before.
  const saved = createV2ResultEnvelope(failed(), { finishedAt: '2026-09-24T01:10:00Z', features: { deliverableGate: 1, proofLabels: 1 } });
  assert.equal(Object.hasOwn(saved.handback.unfinished[0], 'retries'), false);
  const savedSummary = summarizeV2Result(saved, failed(), { runDir: '/tmp/acme-run', features: { deliverableGate: 1, proofLabels: 1 } });
  assert.equal(Object.hasOwn(savedSummary.handback.options, 'rerun'), false);
  assert.equal(Object.hasOwn(savedSummary.handback.options, 'accept'), false);
  assert.ok(formatV2HandbackLines(savedSummary).includes('  step build: failed (failed-evidence) — node --test tests/widget.test.js → exit 1: not ok 1'));
  // The count is exact-field checked.
  const badRetries = structuredClone(result);
  badRetries.handback.unfinished[0].retries = -1;
  assert.throws(() => validateV2ResultEnvelope(badRetries), /retries must be a non-negative integer/);
});

test('the envelope reads the marker from its attempts\' run directory when no features are passed', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'bs-outcome-marker-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const state = evidenceState({
    build: { status: 'failed', lastFailure: { kind: 'process', message: 'worker exited with code 1' } },
    attempts: [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'failed', failureKind: 'process', taskFile: join(runDir, 'task-build-attempt-1.md') }],
  });
  assert.equal(Object.hasOwn(createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' }).handback.unfinished[0], 'retries'), false);
  writeFileSync(join(runDir, 'features.json'), JSON.stringify(STAGE3));
  assert.equal(createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' }).handback.unfinished[0].retries, 0);
});

test('verifyRounds caps go to 4 and the callerDecision pattern follows', () => {
  const state = plannedState();
  state.actions = [
    { id: 'write-report', status: 'succeeded', attempts: 0, programRevision: 1, outputFile: '/tmp/report.md', artifactIds: ['report'] },
    { id: 'check-report', status: 'succeeded', attempts: 0, programRevision: 1, artifactIds: [] },
  ];
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-report', evidenceFor: ['report-correct'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'report-correct': { status: 'failed', evidence: ['wrong total'], concerns: [] } } });
  const base = createV2ResultEnvelope(state, { finishedAt: '2026-08-31T01:10:00Z', plannerExhausted: true });
  const phase = (round) => ({ kind: 'verify', round, steps: ['check-report'], judged: 1, failed: ['report-correct'], wallMinutes: 2, pools: ['grok'], apiUsd: null, unmeasured: 0, cost: '—' });
  const withLoop = (verifyRounds, callerDecision) => ({ ...structuredClone(base), verifyRounds, ...(callerDecision ? { callerDecision } : {}) });
  const decision = (rounds, round) => ({ verifyRounds: rounds, requirements: [{ id: 'report-correct', status: 'failed', round, evidence: 'wrong total', next: 'bullswarm workflow plan export abc234 --out plan.json' }] });
  assert.equal(validateV2ResultEnvelope(withLoop({ max: 4, used: 4, stoppedBy: 'rounds', phases: [phase(4)] }, decision('4/4', 4))), true);
  assert.throws(() => validateV2ResultEnvelope(withLoop({ max: 5, used: 1, stoppedBy: null, phases: [] })), /verifyRounds\.max must be 1 to 4/);
  assert.throws(() => validateV2ResultEnvelope(withLoop({ max: 4, used: 5, stoppedBy: null, phases: [] })), /verifyRounds\.used must be 0 to 4/);
  assert.throws(() => validateV2ResultEnvelope(withLoop({ max: 4, used: 1, stoppedBy: null, phases: [phase(5)] })), /phases\[0\]\.round must be 1 to 4/);
  assert.throws(() => validateV2ResultEnvelope(withLoop({ max: 4, used: 1, stoppedBy: null, phases: [] }, decision('1/5', 1))), /callerDecision\.verifyRounds must read used\/max/);
  assert.throws(() => validateV2ResultEnvelope(withLoop({ max: 4, used: 1, stoppedBy: null, phases: [] }, decision('1/4', 5))), /requirements\[0\]\.round must be 1 to 4/);
});

// Owner decision (2026-09-25): the planner or scout stop `workflow resume`
// runs again is the one that ended the run, and only while the relaunched
// kernel would dispatch it again.
test('v2LimitStoppedDispatch names the scout or planner turn resume runs again, and nothing else', () => {
  const at = '2026-09-25T10:00:00.000Z';
  const reset = '2026-09-25T12:00:00.000Z';
  const unplanned = () => {
    const state = createV2State(goal(), { runId: 'wf-test-abcdef', shortId: 'abc234' });
    state.lifecycle = { status: 'partial', startedAt: at, finishedAt: at, resultFile: null };
    return state;
  };
  // No record: nothing (every unmarked run, and any other failure).
  assert.equal(v2LimitStoppedDispatch(unplanned()), null);
  assert.equal(v2LimitStoppedDispatch(null), null);
  // The scout that ended the run.
  const scout = unplanned();
  Object.assign(scout.preflight.scout, { status: 'failed', lastFailure: { kind: 'quota', message: 'usage limit' }, limitStop: { failureKind: 'quota', retryAfter: reset, at } });
  assert.deepEqual(v2LimitStoppedDispatch(scout), { id: 'preflight-scout', who: 'the preflight scout', failureKind: 'quota', retryAfter: reset });
  // A scout already run again (pending, or succeeded) is not.
  assert.equal(v2LimitStoppedDispatch({ ...scout, preflight: { scout: { ...scout.preflight.scout, status: 'pending' } } }), null);
  // An initial planner turn with still no program.
  const initial = unplanned();
  Object.assign(initial.planner, { status: 'failed', limitStop: { failureKind: 'unavailable', retryAfter: null, boundary: 'initial', at, steeringIds: [] } });
  assert.deepEqual(v2LimitStoppedDispatch(initial), { id: 'workflow-planner', who: 'the workflow planner', failureKind: 'unavailable', retryAfter: null });
  // A planner no longer failed (it ran again) is not.
  assert.equal(v2LimitStoppedDispatch({ ...initial, planner: { ...initial.planner, status: 'waiting' } }), null);
  // An initial turn a program has since replaced is not: the kernel would never plan it again.
  const programmed = plannedState();
  Object.assign(programmed.planner, { status: 'failed', limitStop: { failureKind: 'quota', retryAfter: reset, boundary: 'initial', at, steeringIds: [] } });
  assert.equal(v2LimitStoppedDispatch(programmed), null);
  // A steering turn runs again when its steering goes back to it.
  programmed.planner.limitStop = { failureKind: 'quota', retryAfter: reset, boundary: 'steering', at, steeringIds: ['steer-1'] };
  assert.equal(v2LimitStoppedDispatch(programmed)?.id, 'workflow-planner');
  programmed.planner.limitStop.steeringIds = [];
  assert.equal(v2LimitStoppedDispatch(programmed), null);
  // A gaps turn belongs to a requirements run only.
  programmed.planner.limitStop = { failureKind: 'quota', retryAfter: reset, boundary: 'gaps', at, steeringIds: [] };
  assert.equal(v2LimitStoppedDispatch(programmed)?.id, 'workflow-planner');
  programmed.config.settings.executionMode = 'program';
  assert.equal(v2LimitStoppedDispatch(programmed), null);
});
