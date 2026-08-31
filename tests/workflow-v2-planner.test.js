import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createV2GoalDocument, createV2State, validateV2DurableState } from '../src/workflow/v2-state.js';
import {
  V2PlannerValidationError, applyV2PlannerResponse, buildV2PlannerPrompt,
  buildPlannerPreflight, createV2PlannerContext, parseV2PlannerResponse, plannerCorrectionRequest,
  validateV2PlannerResponse,
} from '../src/workflow/v2-planner.js';

function state() {
  return createV2State(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp/repo', settings: { concurrency: 2, maxActions: 6, maxExpansionRounds: 1 },
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
  }), { runId: 'wf-test-abcdef', shortId: 'abc234' });
}

const response = () => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write and independently inspect the report.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-ready'], ownedFiles: ['report.md'], prompt: 'Write only report.md and make it complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md against the requirement.', lane: 'analyze', effort: 'low', evidenceFor: ['report-ready'], inputs: ['report'], produces: [] },
  ] },
});

test('accepts a complete generic program and applies it without mutating prior state', () => {
  const before = state();
  const accepted = validateV2PlannerResponse(response(), before);
  const next = applyV2PlannerResponse(before, accepted);
  assert.equal(before.program.actions.length, 0);
  assert.equal(next.program.revision, 1);
  assert.deepEqual(next.program.actions.map((action) => action.id), ['write-report', 'inspect-report']);
  assert.equal(next.planner.turns, 1);
  assert.equal(validateV2DurableState(next), true);
});

test('later program revisions can supersede earlier evidence without invalidating history', () => {
  const first = applyV2PlannerResponse(state(), response());
  const expansion = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Revise and recheck the report from the consolidated gap.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'revise-report', purpose: 'Revise report', dependsOn: ['write-report'], affects: ['report-ready'], ownedFiles: ['report.md'], prompt: 'Revise only report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['revised-report'] },
      { id: 'recheck-report', purpose: 'Recheck report', dependsOn: ['write-report', 'revise-report'], affects: [], ownedFiles: [], prompt: 'Independently recheck report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-ready'], inputs: ['revised-report'], produces: [] },
    ] },
  };
  const next = applyV2PlannerResponse(first, expansion, { boundary: 'gaps' });
  assert.equal(next.program.revision, 2);
  assert.deepEqual(next.actions.map((action) => action.programRevision), [1, 1, 2, 2]);
  assert.equal(validateV2DurableState(next), true);
});

test('planner cannot declare completion/failure or use retired action concepts', () => {
  assert.throws(() => validateV2PlannerResponse({ ...response(), kind: 'complete' }, state()), V2PlannerValidationError);
  const old = response();
  old.program.actions[0].type = 'repair';
  assert.throws(() => validateV2PlannerResponse(old, state()), (error) => error.issues.some((issue) => issue.includes('type')));
  assert.throws(() => validateV2PlannerResponse({ ...response(), completion: { when: 'all-ok' } }, state()), (error) => error.issues.some((issue) => issue.includes('completion')));
});

test('explicit read-only intent rejects mutating planner actions before dispatch', () => {
  const readOnly = createV2State(createV2GoalDocument({
    goal: 'Read-only: inspect the report and return findings without changing files',
    cwd: '/tmp/repo', requirements: [{ id: 'report-ready', text: 'Report is inspected' }],
    constraints: { workspaceMutation: 'forbidden' },
    settings: { concurrency: 2, maxActions: 6, maxExpansionRounds: 1 },
  }), { runId: 'wf-readonly-abcdef', shortId: 'roa234' });
  assert.throws(
    () => validateV2PlannerResponse(response(), readOnly),
    (error) => error.issues.some((issue) => issue.includes('goal forbids workspace mutation')),
  );

  const inspectOnly = response();
  inspectOnly.program.actions[0] = {
    ...inspectOnly.program.actions[0], ownedFiles: [], affects: [], produces: ['report'],
    prompt: 'Inspect without modifying files and return the report as action output.',
  };
  assert.equal(validateV2PlannerResponse(inspectOnly, readOnly).kind, 'program');
  assert.match(buildV2PlannerPrompt(createV2PlannerContext(readOnly)), /deterministically read-only/i);
});

test('exhausted is allowed only at a real consolidated gap boundary', () => {
  const exhausted = { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'exhausted', summary: 'No bounded action remains.', reason: 'The external service is unavailable.' };
  assert.throws(() => validateV2PlannerResponse(exhausted, state()), /problem/);
  const planned = applyV2PlannerResponse(state(), response());
  planned.actions.find((action) => action.id === 'write-report').status = 'failed';
  planned.actions.find((action) => action.id === 'inspect-report').status = 'blocked';
  const next = applyV2PlannerResponse(planned, exhausted, { boundary: 'gaps' });
  assert.equal(next.planner.status, 'completed');
  assert.equal(next.planner.lastDecision.kind, 'exhausted');
});

test('context and prompt contain compact gaps and forbid planner authority', () => {
  const initial = createV2PlannerContext(state(), { scout: 'TREE: report.md absent' });
  assert.equal(initial.boundary, 'initial');
  const prompt = buildV2PlannerPrompt(initial);
  assert.match(prompt, /kernel, not you, decides completion and failure/i);
  assert.match(prompt, /acceptance-independent/);
  assert.match(prompt, /tests for behavior introduced by another action/);
  assert.match(prompt, /reviewer, verify, repair/);
  assert.ok(!prompt.includes('actionLedger'));
});

test('parser accepts only a trailing schema-valid object and corrections are bounded', () => {
  const parsed = parseV2PlannerResponse(`planning note\n${JSON.stringify(response())}`, state());
  assert.equal(parsed.kind, 'program');
  let error;
  try { parseV2PlannerResponse('not json', state()); } catch (caught) { error = caught; }
  assert.ok(error instanceof V2PlannerValidationError);
  assert.equal(plannerCorrectionRequest(error, { attempt: 1, maxCorrections: 1 }).allowed, true);
  assert.equal(plannerCorrectionRequest(error, { attempt: 2, maxCorrections: 1 }).allowed, false);
});

test('planner preflight is deterministic and safely quotes paths', () => {
  const preflight = buildPlannerPreflight("/tmp/state with '$dollar'.json", 'gaps', '/tmp/check planner.js');
  assert.match(preflight, /check-v2-plan|check planner/);
  assert.match(preflight, /--boundary gaps/);
  assert.match(preflight, /candidate_file/);
  assert.doesNotMatch(preflight, /--state \/tmp\/state with/);
});
