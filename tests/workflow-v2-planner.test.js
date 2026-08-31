import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument, createV2State, serializeV2DurableState, validateV2DurableState } from '../src/workflow/v2-state.js';
import {
  V2PlannerValidationError, applyV2PlannerResponse, buildV2PlannerPrompt,
  buildPlannerPreflight, createV2PlannerContext, parseV2PlannerResponse, readPlannerCandidate, plannerCorrectionRequest,
  validateV2PlannerResponse,
} from '../src/workflow/v2-planner.js';

const CHECK_PLANNER = new URL('../bin/check-v2-plan.js', import.meta.url).pathname;

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
  const initial = createV2PlannerContext(state(), { scout: 'TREE: report.md absent\n["write-report"]' });
  assert.equal(initial.boundary, 'initial');
  const prompt = buildV2PlannerPrompt(initial);
  assert.match(prompt, /kernel, not you, decides completion and failure/i);
  assert.match(prompt, /acceptance-independent/);
  assert.match(prompt, /tests for behavior introduced by another action/);
  assert.match(prompt, /disconnected helpers, no-op assertions/i);
  assert.match(prompt, /transition matrix for every affected level and input/i);
  assert.match(prompt, /text already present before the input is vacuous/i);
  assert.match(prompt, /node --test-timeout=60000 --test/);
  assert.match(prompt, /forbid raw `node --test`/);
  assert.match(prompt, /beyond 60 seconds or twice that baseline/i);
  assert.match(prompt, /open-handle or unresolved-async defect/i);
  assert.match(prompt, /coherent acceptance slices, not merely by shared files/i);
  assert.match(prompt, /Do not collapse an entire multi-requirement feature/i);
  assert.match(prompt, /single long requirement may be affected by several ordered actions/i);
  assert.match(prompt, /Do not merge scout units merely because they share a requirement ID/i);
  assert.match(prompt, /Every exact ID in context\.scoutUnits is a kernel-required work action/i);
  assert.deepEqual(initial.scoutUnits, ['write-report']);
  assert.match(prompt, /kernel exclusively supplies and validates the evidence output contract/i);
  assert.match(prompt, /reviewer, verify, repair/);
  assert.ok(!prompt.includes('actionLedger'));
});

test('initial planning cannot absorb or omit an exact scout work unit', () => {
  const current = state();
  assert.throws(
    () => validateV2PlannerResponse(response(), current, {
      boundary: 'initial',
      requiredScoutUnits: ['write-report', 'separate-footer-contract'],
    }),
    (error) => error instanceof V2PlannerValidationError
      && error.issues.some((issue) => /missing exact scout work actions: separate-footer-contract/.test(issue)),
  );
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
  const preflight = buildPlannerPreflight("/tmp/state with '$dollar'.json", 'gaps', '/tmp/planner candidate.json', '/tmp/check planner.js');
  assert.match(preflight, /check-v2-plan|check planner/);
  assert.match(preflight, /--boundary gaps/);
  assert.match(preflight, /--value '\/tmp\/planner candidate\.json'/);
  assert.match(preflight, /do not copy, reproduce, or retype the JSON/i);
  assert.doesNotMatch(preflight, /--state \/tmp\/state with/);
});

test('runtime consumes an exact durable planner candidate instead of response prose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-planner-candidate-'));
  try {
    const candidatePath = join(dir, 'candidate.json');
    writeFileSync(candidatePath, JSON.stringify(response()));
    assert.deepEqual(readPlannerCandidate(candidatePath, state()), { ok: true, errors: [], value: response() });
    assert.equal(readPlannerCandidate(join(dir, 'missing.json'), state()).ok, false);
    writeFileSync(candidatePath, '{');
    assert.equal(readPlannerCandidate(candidatePath, state()).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planner checker enforces the exact scout unit handoff used by runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-planner-checker-'));
  try {
    const current = state();
    const scoutPath = join(dir, 'scout.md');
    const statePath = join(dir, 'state.json');
    const candidatePath = join(dir, 'candidate.json');
    writeFileSync(scoutPath, 'Repository facts\n["write-report","missing-scout-unit"]');
    current.preflight.scout = {
      status: 'succeeded', startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:01Z',
      outputFile: scoutPath, attempts: [], lastFailure: null,
    };
    writeFileSync(statePath, serializeV2DurableState(current));
    writeFileSync(candidatePath, JSON.stringify(response()));
    const checked = spawnSync(process.execPath, [CHECK_PLANNER, '--state', statePath, '--boundary', 'initial', '--value', candidatePath], { encoding: 'utf8' });
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /missing exact scout work actions: missing-scout-unit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
