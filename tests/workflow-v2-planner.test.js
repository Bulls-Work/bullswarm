import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument, createV2State, serializeV2DurableState, validateV2DurableState } from '../src/workflow/v2-state.js';
import {
  V2PlannerValidationError, V2_PROGRAM_EXAMPLE, V2_PROGRAM_ACTION_FIELDS, V2_ROLE_PROGRAM_EXAMPLE, applyV2PlannerResponse, buildV2PlannerContract, buildV2PlannerPrompt,
  buildPlannerPreflight, createV2PlannerContext, readPlannerCandidate, plannerCorrectionRequest,
  v2PlannerContractRules, validateV2PlannerResponse,
} from '../src/workflow/v2-planner.js';
import { KIND_DEFAULTS } from '../src/workflow/action-validator.js';
import {
  DELIVERABLE_TYPES, EVIDENCE_TYPES, KIND_ROLES, ROLES, ROLE_DEFAULT_DELIVERABLE, ROLE_DELIVERABLES, ROLE_ROUTING,
} from '../src/workflow/step-vocabulary.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

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

test('V2 planning targets never reject an essential wider or longer program', () => {
  const targetState = createV2State(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp/repo',
    settings: { concurrency: 1, maxActions: 1, maxAgents: 1, maxExpansionRounds: 1 },
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
  }), { runId: 'wf-target-abcdef', shortId: 'tgt234' });
  const accepted = validateV2PlannerResponse(response(), targetState);
  const next = applyV2PlannerResponse(targetState, accepted);
  assert.equal(next.program.actions.length, 2);
  assert.equal(validateV2DurableState(next), true);
  const context = createV2PlannerContext(next);
  assert.deepEqual(context.targets, {
    advisoryOnly: true,
    actions: 1, actionsUsed: 2, actionsRemaining: -1,
    agents: 1, agentsUsed: 0, agentsRemaining: 1,
    expansionRounds: 1, expansionRoundsUsed: 0, expansionRoundsRemaining: 1,
  });
  assert.equal(context.execution.concurrency, 1);
  assert.ok(!('limits' in context));
  assert.match(buildV2PlannerPrompt(context), /advisory planning targets, never execution ceilings/i);
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
  assert.match(prompt, /Goal requirements outrank the current implementation/i);
  assert.match(prompt, /narrow\/mobile/i);
  assert.match(prompt, /affects means the action directly owns and delivers a bounded acceptance slice/i);
  assert.match(prompt, /merely editing a supporting test/i);
  assert.match(prompt, /Requirement context never expands ownedFiles/i);
  assert.match(prompt, /final acceptance unit must remain a mutation-capable action/i);
  assert.match(prompt, /Do not turn that unit into tests-only regression work/i);
  assert.deepEqual(initial.scoutUnits, ['write-report']);
  assert.match(prompt, /kernel exclusively supplies and validates the evidence output contract/i);
  assert.match(prompt, /Choose lane from the action itself/i);
  assert.match(prompt, /Medium is the default/i);
  assert.match(prompt, /High is exceptional/i);
  assert.match(prompt, /Do not choose high merely because an action uses analyze/i);
  assert.match(prompt, /exact file comparison or formatting update = low/i);
  assert.match(prompt, /ordinary scoped feature plus focused test = medium/i);
  assert.match(prompt, /choosing an architecture across subsystems = high/i);
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

test('a planner response must be a schema-valid object and corrections are bounded', () => {
  assert.equal(validateV2PlannerResponse(response(), state()).kind, 'program');
  let error;
  try { validateV2PlannerResponse('not json', state()); } catch (caught) { error = caught; }
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

test('the planning contract documents the per-action reasoning override and echoes the run-wide levels', () => {
  const goal = createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', concurrency: 2 },
    workerRouting: { reasoning: 'high' },
    plannerRouting: { pool: 'codex', reasoning: 'xhigh' },
  });
  const contract = buildV2PlannerContract(goal);
  assert.equal(contract.reasoning.worker, 'high');
  assert.equal(contract.reasoning.planner, 'xhigh');
  assert.deepEqual(contract.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max', 'default']);
  assert.match(contract.program.actionFields.reasoning, /^optional low \| medium \| high \| xhigh \| max \| default/);
  const rule = contract.rules.find((entry) => entry.includes('`reasoning` field'));
  assert.ok(rule, `no reasoning rule in the contract rules: ${contract.rules.join(' | ')}`);
  assert.match(rule, /outranks every configured level/);
  assert.match(rule, /nearest level it supports/);
  assert.match(rule, /`default` passes nothing/);
  // The shape a caller copies must show the field on exactly one action, so
  // it reads as optional rather than required.
  const withReasoning = contract.program.example.program.actions.filter((action) => action.reasoning !== undefined);
  assert.equal(withReasoning.length, 1);
  assert.equal(withReasoning[0].reasoning, 'high');
  // A goal with no run-wide override reports null rather than inventing a level.
  const bare = buildV2PlannerContract(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', plannerMode: 'caller' },
  }));
  assert.deepEqual([bare.reasoning.worker, bare.reasoning.planner], [null, null]);
});

test('every planner rule set states the reasoning field once', () => {
  for (const executionMode of ['program', 'verified']) {
    const rules = v2PlannerContractRules({ executionMode });
    const matches = rules.filter((rule) => rule.includes('`reasoning` field'));
    assert.equal(matches.length, 1, `executionMode ${executionMode} rules mention reasoning ${matches.length} time(s)`);
  }
  // The dispatched planner prompt renders the same rulebook.
  const prompt = buildV2PlannerPrompt(createV2PlannerContext(state(), { scout: null }));
  assert.match(prompt, /optional per-action `reasoning` field \(low\|medium\|high\|xhigh\|max\|default\)/);
});

test('program planner guidance keeps writer inputs, slices and delivery explicit', () => {
  const expected = 'Use `dependsOn` for files or contracts a writer needs before it can compile or prove its change; keep each behavior with its focused test in one writer action, and have writers run the checks they own. ' +
    'After integration, put the full browser/e2e gate, commit, and PR in separate actions in that order, with an explicit `timeBox` sized for the full suite. ' +
    'Make the gate a `check` step and the commit and PR steps kind `mechanical` (not judged, and with empty ownedFiles they run alone). A step whose declared deliverable was not produced fails as `not-produced`; a build-lane step with no declared deliverable, other than `integration`, fails the same way when it changes no file and makes no commit.';
  assert.ok(v2PlannerContractRules({ executionMode: 'program' }).includes(expected));
  // Only the caller may declare evidence (E29), so only its rule set tells it to put the gate's suite there.
  const caller = expected.replace('Make the gate a `check` step and the commit and PR steps kind `mechanical`',
    'Make the gate a `check` step and declare its suite as `evidence` so Bullswarm runs it (a check item times out at 600 seconds at most, so put a longer suite in the step\'s prompt or split it into several items); commit and PR steps are kind `mechanical`');
  assert.ok(v2PlannerContractRules({ executionMode: 'program', plannerMode: 'caller' }).includes(caller));
  assert.equal(v2PlannerContractRules({ executionMode: 'program' }).some((rule) => rule.includes('declare its suite as `evidence`')), false);
});

// Spec §4: the rules name review steps, never "evidence actions", and the
// program-mode sentence reads exactly as written (no word-for-word rewrite).
test('the reworded review-step rules read exactly as the spec gives them', () => {
  const reviewRule = 'Review steps are optional. To request structured independent judgment, use a check step (analyze) with evidenceFor and empty affects/ownedFiles. They must depend on all work affecting their requirements. Their prompt specifies checks only; the kernel supplies the evidence JSON contract. Negative evidence is reported and never silently converted to verified success.';
  for (const plannerMode of ['caller', 'dispatched']) {
    for (const workspaceMode of ['shared', 'isolated']) {
      const rules = v2PlannerContractRules({ executionMode: 'program', plannerMode, workspaceMode });
      assert.ok(rules.includes(reviewRule), `${plannerMode}/${workspaceMode}`);
      assert.equal(rules.some((rule) => /evidence actions?/i.test(rule)), false, `${plannerMode}/${workspaceMode}`);
    }
  }
  const verified = v2PlannerContractRules({ executionMode: 'verified' });
  for (const exact of [
    'Use only generic actions. A work action declares affects and any exact ownedFiles. affects means the action directly owns and delivers a bounded acceptance slice of that requirement; merely editing a supporting test or sharing a file does not make an action affect every requirement associated with that file. A review step declares evidenceFor, has empty affects/ownedFiles, and independently inspects the work it judges.',
    'For review steps, the prompt describes only what to inspect and which concrete checks to run. Never prescribe a response JSON, object, schema, envelope, format, or fields such as ok/concerns/summary; the V2 kernel exclusively supplies and validates the evidence output contract.',
  ]) assert.ok(verified.includes(exact), exact);
  assert.ok(verified.some((rule) => rule.startsWith('Every mandatory unresolved requirement needs a review step. ')));
  assert.equal(verified.some((rule) => /evidence actions?/i.test(rule)), false);
});

test('the planning contract documents kind, its derived table, program defaults, and the advisories', () => {
  const goal = createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', concurrency: 2 },
  });
  const contract = buildV2PlannerContract(goal);
  assert.deepEqual(contract.program.kinds, KIND_DEFAULTS);
  assert.deepEqual(contract.program.defaults.allowed, ['effort', 'reasoning', 'timeBox', 'verifyRounds']);
  assert.match(contract.program.defaults.note, /action > kind > program defaults > lane default/);
  assert.deepEqual(contract.program.advisories.codes, ['all-writers-high', 'docs-at-high', 'requirement-unchecked']);
  assert.match(contract.program.advisories['requirement-unchecked'], /never verified/);
  assert.match(contract.program.advisories.note, /never a rejection/);
  // Derived, so a new kind reaches the schema description without an edit here.
  assert.ok(contract.program.actionFields.kind.startsWith(`optional ${Object.keys(KIND_DEFAULTS).join(' | ')} —`), contract.program.actionFields.kind);
  assert.ok(contract.program.actionFields.kind.includes('digest'), contract.program.actionFields.kind);
  assert.match(contract.program.actionFields.lane, /omit when kind supplies it/);
  assert.match(contract.program.actionFields.effort, /omit to take it from kind/);
  const rule = contract.rules.find((entry) => entry.includes('`kind` field'));
  assert.ok(rule, `no kind rule in the contract rules: ${contract.rules.join(' | ')}`);
  for (const [kind, { lane, effort }] of Object.entries(KIND_DEFAULTS)) {
    assert.ok(rule.includes(`${kind}=${lane}/${effort}`), `rule omits ${kind}`);
  }
  assert.match(rule, /A kind outside that closed list is a validation error/);
  assert.match(rule, /all-writers-high/);
  assert.match(rule, /docs-at-high/);
  // The worked example a program-mode caller copies uses role on every action
  // and omits the two fields the role supplies.
  const example = contract.program.example.program.actions;
  assert.deepEqual(example.map((action) => action.role), ['produce', 'check']);
  for (const action of example) {
    assert.equal('kind' in action, false, action.id);
    assert.equal('lane' in action, false, action.id);
    assert.equal('effort' in action, false, action.id);
  }
});

test('every planner rule set states the kind field once, and the example still validates', () => {
  for (const executionMode of ['program', 'verified']) {
    const rules = v2PlannerContractRules({ executionMode });
    assert.equal(rules.filter((rule) => rule.includes('`kind` field')).length, 1, executionMode);
  }
  assert.match(buildV2PlannerPrompt(createV2PlannerContext(state(), { scout: null })), /optional per-action `kind` field/);
  // The example must be a program the kernel would actually accept.
  const exampleState = createV2State(createV2GoalDocument({
    goal: 'Fix the parser', cwd: '/tmp/repo', settings: { concurrency: 2 },
    requirements: [{ id: 'requirement-1', text: 'The parser handles trailing commas' }],
  }), { runId: 'wf-examp-abcdef', shortId: 'exa234' });
  const accepted = validateV2PlannerResponse(clone(V2_PROGRAM_EXAMPLE), exampleState);
  assert.deepEqual(
    accepted.program.actions.map((action) => [action.id, action.kind, action.lane, action.effort]),
    [['fix-parser', 'implement', 'build', 'medium'], ['check-parser', 'check', 'analyze', 'medium']],
  );
});

test('accepting a program records its advisories on the run state without changing acceptance', () => {
  const writers = ['one', 'two', 'three'].map((name) => ({
    id: `write-${name}`, purpose: `Write ${name}`, dependsOn: [], affects: ['report-ready'],
    ownedFiles: name === 'one' ? ['docs/report.md'] : [`src/${name}.js`],
    prompt: `Write ${name} and run its focused checks.`, kind: 'integration',
    evidenceFor: [], inputs: [], produces: [],
  }));
  const programState = createV2State(createV2GoalDocument({
    goal: 'Deliver the report', cwd: '/tmp/repo',
    settings: { executionMode: 'program', concurrency: 3 },
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
  }), { runId: 'wf-advis-abcdef', shortId: 'adv234' });
  assert.deepEqual(programState.advisories, []);
  const next = applyV2PlannerResponse(programState, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Three integration writers, one of them markdown-only.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: writers },
  });
  assert.equal(next.program.revision, 1, 'advisories never block acceptance');
  assert.deepEqual(next.advisories.map((advisory) => [advisory.code, advisory.actionId]), [
    ['all-writers-high', null],
    ['docs-at-high', 'write-one'],
  ]);
  assert.equal(validateV2DurableState(next), true);
  assert.deepEqual(programState.advisories, [], 'the input state is not mutated');
  // A program with no smell records an empty list rather than a missing key.
  assert.deepEqual(applyV2PlannerResponse(state(), response()).advisories, []);
});

function programState() {
  return createV2State(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp/repo',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', concurrency: 2 },
  }), { runId: 'wf-prog-abcdef', shortId: 'prg234' });
}

test('the planning contract teaches timeBox and verifyRounds and says where the kernel takes over', () => {
  const contract = buildV2PlannerContract(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', concurrency: 2 },
  }));
  assert.match(contract.program.actionFields.timeBox, /^optional whole minutes 0-240/);
  assert.match(contract.program.actionFields.timeBox, /never a timeout/);
  assert.match(contract.program.defaults.note, /timeBox\)/);
  // Stage 3 (D13): in program mode verifyRounds counts fix cycles.
  assert.match(contract.program.defaults.note, /verifyRounds \(0-3, default 1: fix-and-re-review cycles\)/);
  assert.equal(contract.program.defaults.verifyRounds, '0-3, default 1: fix-and-re-review cycles');
  const box = contract.rules.filter((rule) => rule.includes('`timeBox` field'));
  assert.equal(box.length, 1);
  assert.match(box[0], /`## Done`, `## Not done`, `## Suggested next step`/);
  assert.match(box[0], /`timeBox: 0` leaves the paragraph out/);
  assert.match(box[0], /not a timeout/);
  assert.match(box[0], /returned early/);
  const loop = contract.rules.filter((rule) => rule.includes('the kernel adds one fix step'));
  assert.equal(loop.length, 1);
  assert.match(loop[0], /one fix step \(`repair-1`\) built from its findings and one re-review \(`verify-round-2`\)/);
  assert.match(loop[0], /`defaults\.verifyRounds` \(0-3, default 1\) sets how many fix-and-re-review cycles run; 0 means no automatic fix/);
  assert.match(loop[0], /Never author a repair step/);
  assert.match(loop[0], /`callerDecision`/);
  assert.match(loop[0], /needs-you block/);
  assert.ok(!contract.rules.some((rule) => rule.includes('bounded repair loop')), 'the stage-2 loop rule is replaced');
  // The old advice to author repairs by hand is gone.
  assert.ok(!contract.rules.some((rule) => /Repairs or further investigation belong in an explicitly authored follow-up program\.$/.test(rule) && rule.includes('result status describes')));
  // Authors still may not invent repair fields.
  assert.ok(contract.rules.some((rule) => /Do not invent provider, model, timeout, phase, repair, or retry fields/.test(rule)));
});

test('every planner rule set states the time box once, and only program runs state the repair loop', () => {
  for (const executionMode of ['program', 'verified']) {
    const rules = v2PlannerContractRules({ executionMode });
    assert.equal(rules.filter((rule) => rule.includes('`timeBox` field')).length, 1, executionMode);
    assert.equal(rules.filter((rule) => rule.includes('the kernel adds one fix step')).length, executionMode === 'program' ? 1 : 0, executionMode);
  }
  const verifiedPrompt = buildV2PlannerPrompt(createV2PlannerContext(state(), { scout: null }));
  assert.match(verifiedPrompt, /optional per-action `timeBox` field/);
  assert.match(verifiedPrompt, /reviewer, verify, repair/);
  const programPrompt = buildV2PlannerPrompt(createV2PlannerContext(programState(), { scout: null }));
  assert.match(programPrompt, /the kernel adds one fix step \(`repair-1`\)/);
});

test('a program may carry timeBox and verifyRounds, and still cannot declare repair steps', () => {
  const boxed = response();
  boxed.program.defaults = { timeBox: 25, verifyRounds: 2 };
  boxed.program.actions[0].timeBox = 30;
  boxed.program.actions[1].timeBox = 0;
  const accepted = validateV2PlannerResponse(boxed, programState());
  assert.equal(accepted.kind, 'program');
  assert.deepEqual(accepted.program.actions.map((action) => action.timeBox), [30, 0]);
  assert.equal(accepted.program.verifyRounds, 2);

  for (const bad of [-1, 241, 12.5, '20']) {
    const wrong = response();
    wrong.program.actions[0].timeBox = bad;
    assert.throws(() => validateV2PlannerResponse(wrong, programState()), (error) => error.issues.some((issue) => issue.includes('timeBox')), String(bad));
  }
  const rounds = response();
  rounds.program.defaults = { verifyRounds: 4 };
  assert.throws(() => validateV2PlannerResponse(rounds, programState()), (error) => error.issues.some((issue) => issue.includes('verifyRounds')));

  // The kernel writes repair steps; an author may not declare one.
  for (const forbidden of [{ repair: { of: 'inspect-report' } }, { type: 'repair' }, { kind: 'repair' }]) {
    const attempt = response();
    Object.assign(attempt.program.actions[0], forbidden);
    assert.throws(() => validateV2PlannerResponse(attempt, programState()), V2PlannerValidationError, JSON.stringify(forbidden));
  }
  const loopKey = response();
  loopKey.program.defaults = { repair: 3 };
  assert.throws(() => validateV2PlannerResponse(loopKey, programState()), V2PlannerValidationError);
});

function goalFor(executionMode) {
  return createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode, concurrency: 2 },
  });
}

test('the program-mode contract carries roles, kind roles, deliverable and evidence types, and the role example', () => {
  const contract = buildV2PlannerContract(goalFor('program'));
  assert.deepEqual(Object.keys(contract.program.roles), [...ROLES]);
  for (const role of ROLES) {
    assert.deepEqual(contract.program.roles[role], {
      kinds: Object.keys(KIND_ROLES).filter((kind) => KIND_ROLES[kind] === role),
      defaultDeliverable: ROLE_DEFAULT_DELIVERABLE[role] ?? null,
      deliverables: [...ROLE_DELIVERABLES[role]],
      routing: JSON.parse(JSON.stringify(ROLE_ROUTING[role])),
    }, role);
  }
  assert.equal(contract.program.roles.combine.defaultDeliverable, null);
  assert.deepEqual(contract.program.roles.combine.kinds, ['digest', 'integration']);
  assert.deepEqual(contract.program.kindRoles, { ...KIND_ROLES });
  assert.deepEqual(contract.program.deliverableTypes, [...DELIVERABLE_TYPES]);
  assert.deepEqual(contract.program.evidenceTypes.types, [...EVIDENCE_TYPES]);
  assert.deepEqual(contract.program.evidenceTypes.usable, ['command', 'schema', 'review']);
  assert.match(contract.program.evidenceTypes.note, /command and schema go in a step's evidence field/);
  assert.deepEqual(contract.program.stepEvidence.fieldTypes, ['command', 'schema']);
  assert.equal(contract.program.stepEvidence.maxItems, 5);
  assert.deepEqual(contract.program.stepEvidence.timeoutSec, { default: 120, max: 600 });
  assert.deepEqual(contract.program.stepEvidence.schemaFormats, ['json', 'jsonl']);
  assert.equal(contract.program.stepEvidence.outputFile, '$output');
  assert.deepEqual(contract.program.stepEvidence.env, ['BULLSWARM_EVIDENCE', 'BULLSWARM_STEP_ID', 'BULLSWARM_STEP_OUTPUT', 'BULLSWARM_RUN_DIR']);
  assert.equal(contract.program.stepEvidence.actRetry, false);
  assert.match(contract.program.actionFields.evidence, /caller-authored only/);
  assert.match(contract.program.evidenceTypes.note, /review is a check step with evidenceFor/);
  // kinds and the original note stay; the role note is a second note.
  assert.deepEqual(contract.program.kinds, KIND_DEFAULTS);
  assert.match(contract.program.defaults.note, /action > kind > program defaults > lane default/);
  assert.equal(contract.program.defaults.roleNote, 'a role-only action resolves action > role > program defaults > lane default; kind and role never both survive normalisation');
  assert.deepEqual(contract.program.example, JSON.parse(JSON.stringify(V2_ROLE_PROGRAM_EXAMPLE)));
  assert.match(contract.program.actionFields.role, /^optional investigate \| produce \| transform \| combine \| check \| act — /);
  assert.match(contract.program.actionFields.deliverable, /^optional files \| report \| data \| media \| outward, or \{type, paths\} — /);
  assert.equal(contract.program.actionFields.lane, 'analyze | build | chore — omit when kind supplies it, or when role does');
  assert.equal(contract.program.actionFields.effort, 'high | medium | low — omit to take it from kind, role, program defaults, or the lane default');
  assert.match(contract.program.actionFields.produces, /data-flow labels, not the deliverable/);
  const role = contract.rules.filter((rule) => rule.includes('`role` field'));
  const deliverable = contract.rules.filter((rule) => rule.includes('`deliverable` field'));
  assert.equal(role.length, 1);
  assert.equal(deliverable.length, 1);
  for (const [kind, name] of Object.entries(KIND_ROLES)) assert.ok(role[0].includes(`${kind}=${name}`), kind);
  assert.match(role[0], /a kind keeps its own routing and gate/);
  assert.match(role[0], /In new programs, give work steps a role and a deliverable\. Use a kind for commit, formatter and PR steps \(`mechanical`\), for `digest`, or when you want a kind's exact routing/);
  assert.match(role[0], /combine: files=build\/high, data=build\/medium/);
  assert.match(role[0], /A role outside that closed list is a validation error/);
  assert.match(role[0], /Kind and role may both appear only if they agree/);
  assert.match(role[0], /never judged by files, and the kernel never repairs a requirement it affects/);
  assert.match(deliverable[0], /When ownedFiles is not empty, every deliverable path must be listed in it/);
  assert.match(deliverable[0], /files, data and media need build or chore; report and outward need analyze/);
  assert.match(deliverable[0], /`produces`\/`inputs` are data-flow labels between steps, not the deliverable/);
  const repair = contract.rules.find((rule) => rule.includes('the kernel adds one fix step'));
  assert.ok(repair.endsWith('The kernel never repairs a requirement an `act` step affects; it hands it back.'), repair);
});

test('the verified-mode contract has no role vocabulary, and keeps its kind example and field docs', () => {
  const contract = buildV2PlannerContract(goalFor('verified'));
  for (const key of ['roles', 'kindRoles', 'deliverableTypes', 'evidenceTypes', 'stepEvidence']) assert.equal(key in contract.program, false, key);
  assert.equal('roleNote' in contract.program.defaults, false);
  assert.deepEqual(contract.program.example, JSON.parse(JSON.stringify(V2_PROGRAM_EXAMPLE)));
  assert.deepEqual(contract.program.actionFields, { ...V2_PROGRAM_ACTION_FIELDS });
  assert.equal('role' in contract.program.actionFields, false);
  assert.equal('deliverable' in contract.program.actionFields, false);
  assert.match(contract.program.actionFields.evidenceFor, /evidence action independently judges/);
  assert.equal(contract.program.actionFields.lane, 'analyze | build | chore — omit when kind supplies it');
  const rules = v2PlannerContractRules({ executionMode: 'verified' });
  assert.equal(rules.filter((rule) => /`role` field|`deliverable` field|`act` step/.test(rule)).length, 0);
  // The verified example still uses kinds and never a role.
  assert.deepEqual(V2_PROGRAM_EXAMPLE.program.actions.map((action) => [action.kind, 'role' in action]), [['implement', false], ['check', false]]);
});

test('every planner rule set states the kind field exactly once, and the role rules never claim it', () => {
  for (const executionMode of ['program', 'verified']) {
    for (const workspaceMode of ['shared', 'isolated']) {
      const rules = v2PlannerContractRules({ executionMode, workspaceMode });
      assert.equal(rules.filter((rule) => rule.includes('`kind` field')).length, 1, `${executionMode}/${workspaceMode}`);
    }
  }
  const program = v2PlannerContractRules({ executionMode: 'program' });
  const kindIndex = program.findIndex((rule) => rule.includes('`kind` field'));
  assert.ok(program[kindIndex + 1].includes('`role` field'));
  assert.ok(program[kindIndex + 2].includes('`deliverable` field'));
  // The dispatched program-mode prompt renders the same role rules.
  assert.match(buildV2PlannerPrompt(createV2PlannerContext(programState(), { scout: null })), /optional per-action `role` field/);
});

test('E29 permits caller evidence and refuses it from a dispatched planner', () => {
  const caller = programState();
  caller.config.settings.plannerMode = 'caller';
  const planned = response();
  planned.program.actions[0].evidence = [{ type: 'command', cmd: 'node --test tests/report.test.js' }];
  assert.equal(validateV2PlannerResponse(planned, caller).program.actions[0].evidence[0].type, 'command');

  const dispatched = programState();
  assert.throws(() => validateV2PlannerResponse(planned, dispatched), (error) =>
    error instanceof V2PlannerValidationError
      && error.issues.includes("actions[0].evidence is the caller's to declare; a dispatched planner cannot add checks (the caller adds them with bullswarm workflow plan revise)"));

  for (const plannerMode of ['caller', 'dispatched']) {
    const rules = v2PlannerContractRules({ executionMode: 'program', plannerMode }).join('\n');
    if (plannerMode === 'caller') assert.match(rules, /A step may declare `evidence`/);
    else assert.match(rules, /Do not declare evidence; put the acceptance commands a worker must run in its prompt/);
  }
});

test('the role example validates as a program-mode plan and resolves the same routing as the kind example', () => {
  const roleExample = clone(V2_ROLE_PROGRAM_EXAMPLE);
  const accepted = validateV2PlannerResponse(roleExample, createV2State(createV2GoalDocument({
    goal: 'Fix the parser', cwd: '/tmp/repo', settings: { executionMode: 'program', plannerMode: 'caller', concurrency: 2 },
    requirements: [{ id: 'requirement-1', text: 'The parser handles trailing commas' }],
  }), { runId: 'wf-roles-abcdef', shortId: 'rol234' }));
  assert.deepEqual(
    accepted.program.actions.map((action) => [action.id, action.role, action.lane, action.effort, action.deliverable]),
    [['fix-parser', 'produce', 'build', 'medium', { type: 'files' }], ['check-parser', 'check', 'analyze', 'medium', { type: 'report' }]],
  );
  assert.deepEqual(accepted.program.actions[0].evidence, [{ type: 'command', cmd: 'node --test tests/parser.test.js' }]);
  // A verified run refuses the role example (D17).
  assert.throws(() => validateV2PlannerResponse(clone(V2_ROLE_PROGRAM_EXAMPLE), createV2State(createV2GoalDocument({
    goal: 'Fix the parser', cwd: '/tmp/repo', settings: { concurrency: 2 },
    requirements: [{ id: 'requirement-1', text: 'The parser handles trailing commas' }],
  }), { runId: 'wf-rolev-abcdef', shortId: 'rlv234' })), (error) => error.issues.some((issue) => issue.includes('role and deliverable need a program-mode run')));
});

// --- stage 3: the failure rule, route and the fix-cycle meaning ----------------

test('program rules state the failure rule and the route field once; verified rules state neither', () => {
  for (const plannerMode of ['caller', 'dispatched']) {
    const rules = v2PlannerContractRules({ executionMode: 'program', plannerMode });
    const failure = rules.filter((rule) => rule.startsWith('Each step gets one automatic retry, then comes back to you'));
    assert.equal(failure.length, 1, plannerMode);
    assert.ok(failure[0].includes('a crashed, silent or signed-out worker is retried on another eligible pool'));
    assert.ok(failure[0].includes('is retried on the same pool with the failure attached'));
    assert.ok(failure[0].includes('An act step is never retried once its worker started'));
    // A usage limit, or no free pool, goes to the caller at once; nothing waits.
    assert.ok(failure[0].includes('A usage limit (a spent 5-hour or weekly window, or no credit left), or no free pool that can run the step, sends it back to you at once, with the time its pool is back when that is known'));
    assert.ok(failure[0].includes('no step waits for a pool, and a usage limit never moves a step to another pool by itself'));
    // The move after a crash or a sign-in failure stays: only a usage limit never moves.
    assert.ok(!failure[0].includes('moves the step by itself'));
    assert.ok(failure[0].includes('A transient rate limit (too many requests) backs off on the same pool at most twice, then comes back to you.'));
    assert.ok(!failure[0].includes('makes the step wait'));
    assert.ok(failure[0].includes('(step rerun --avoid, plan revise, take over, step accept)'));
    const route = rules.filter((rule) => rule.startsWith('The optional `route` keeps a step on or off pools'));
    assert.equal(route.length, 1, plannerMode);
    assert.ok(route[0].includes('`independentOf` names earlier steps (or "writers" on a step with evidenceFor)'));
    assert.ok(route[0].includes('It is a hard filter applied before quota pacing'));
    assert.ok(route[0].includes('a step it leaves without a free pool comes back to you at once (no eligible pool, or each pool\'s reason) and never waits for one.'));
    assert.ok(!route[0].includes('waits for one to come back'));
    assert.ok(route[0].includes('A review runs where you route it; Bullswarm records who reviewed.'));
    // None of the new rules is mistaken for the kind rule.
    for (const rule of [...failure, ...route]) assert.ok(!rule.includes('`kind` field'));
    assert.equal(rules.filter((rule) => rule.includes('`kind` field')).length, 1);
  }
  const verified = v2PlannerContractRules({ executionMode: 'verified' });
  assert.ok(!verified.some((rule) => rule.includes('one automatic retry') || rule.includes('`route`') || rule.includes('the kernel adds one fix step')));
});

test('the program-mode contract documents route, the fix-cycle verifyRounds and choice evidence', () => {
  const contract = buildV2PlannerContract(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'program', concurrency: 2 },
  }));
  assert.equal(contract.program.actionFields.route, 'optional {pools:{use,avoid}, providers:{use,avoid}, independentOf} — where the step may run; a hard filter before pacing');
  assert.match(contract.program.route.shape, /pools\?: \{use\?, avoid\?\}, providers\?: \{use\?, avoid\?\}, independentOf\?: \[stepId, \.\.\.\] \| "writers"/);
  assert.match(contract.program.route.independentOf, /"writers" only on a step with evidenceFor/);
  assert.match(contract.program.evidenceTypes.note, /choice is recorded by bullswarm workflow step accept/);
  assert.equal(contract.program.defaults.verifyRounds, '0-3, default 1: fix-and-re-review cycles');
});

test('the verified-mode contract is unchanged by stage 3', () => {
  const contract = buildV2PlannerContract(createV2GoalDocument({
    goal: 'Create and check report.md', cwd: '/tmp',
    requirements: [{ id: 'report-ready', text: 'report.md is complete' }],
    settings: { executionMode: 'verified', concurrency: 2 },
  }));
  assert.equal('route' in contract.program.actionFields, false);
  assert.equal('route' in contract.program, false);
  assert.equal('verifyRounds' in contract.program.defaults, false);
  assert.match(contract.program.defaults.note, /verifyRounds \(1-3, default 3\)/);
});

test('a program may route a step, and verifyRounds 0 is a valid program default', () => {
  const routed = response();
  routed.program.defaults = { verifyRounds: 0 };
  routed.program.actions[0].route = { pools: { avoid: ['pool-b', 'pool-a', 'pool-a'] } };
  const accepted = validateV2PlannerResponse(routed, programState());
  assert.deepEqual(accepted.program.actions[0].route, { pools: { avoid: ['pool-a', 'pool-b'] } });
  assert.equal(accepted.program.verifyRounds, 0);
  const lane = response();
  lane.program.actions[0].route = { lane: 'build' };
  assert.throws(() => validateV2PlannerResponse(lane, programState()), (error) => error.issues.some((issue) => issue.includes('route.lane is not a route key')));
});
