import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvidence } from '../src/workflow/ledger.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import {
  consolidateV2Gaps, createV2ResultEnvelope, deserializeV2ResultEnvelope,
  evaluateV2Progress, serializeV2ResultEnvelope,
} from '../src/workflow/v2-outcome.js';

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
