// legacy-verification.js on its own: the read side of the former repair loop
// (its decisions, the carry-forward rule, the measures and the labels) over
// synthetic saved states.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actAffectedRequirements, callerDecision, firstSuggestedStep, loopStageLabel, loopVerdictText, NOT_JUDGED_STATUS,
  notJudgedRequirements, requirementAcceptances, revisedVerifyRounds, roundPhases, verifyLoopResult,
  verifyRoundLabel,
} from '../src/workflow/legacy-verification.js';
import { validateActionProgram } from '../src/workflow/action-validator.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { createV2GoalDocument, createV2State, validateV2DurableState } from '../src/workflow/v2-state.js';
import { planStages, runTimelineFacts, workflowPanelModel } from '../src/workflow/run-model.js';
import { workflowTimelineLines } from '../src/workflow/run-view.js';
import { todayTopRuns } from '../src/workflow/home-model.js';

const round = (over = {}) => ({
  round: 1, verifyActionIds: ['verify'], startedAt: '2026-09-21T02:00:00.000Z', closedAt: null,
  toJudge: ['alpha', 'beta'], carried: [], passed: [], failed: [], discovery: [],
  repairActionId: null, repairRequirements: [], repairOwnedFiles: [], repairUnrestricted: false,
  repairStartedAt: null, repairFinishedAt: null, changedFiles: null, ...over,
});

const evidenceRecord = (requirementId, status, lines, { source = 'verify', concerns = [], sequence = 1, revision = 'w1', stale = false } = {}) => ({
  sourceAction: source, inspectedRevision: revision, eventSequence: sequence, schemaVersion: 'x', requirementId,
  status, evidence: lines, concerns, stale,
});

/** A synthetic program state: build-a (src/a.js) → alpha, build-b (src/b.js) → beta, verify both. */
function synthetic({ statuses = { alpha: 'failed', beta: 'passed' }, evidence = null, loop = null, extraActions = [], lifecycle = 'running' } = {}) {
  const program = [
    { id: 'build-a', kind: 'implement', lane: 'build', effort: 'medium', dependsOn: [], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] },
    { id: 'build-b', kind: 'implement', lane: 'build', effort: 'high', dependsOn: [], affects: ['beta'], ownedFiles: ['src/b.js'], evidenceFor: [] },
    { id: 'verify', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['build-a', 'build-b'], affects: [], ownedFiles: [], evidenceFor: ['alpha', 'beta'] },
    ...extraActions,
  ];
  return {
    runId: 'wf-synth-abcdef', shortId: 'syn123',
    config: { settings: { executionMode: 'program' } },
    intent: { requirements: [{ id: 'alpha', text: 'alpha returns 2' }, { id: 'beta', text: 'beta returns 3' }] },
    lifecycle: { status: lifecycle, startedAt: '2026-09-21T02:00:00.000Z', finishedAt: null },
    planner: { status: 'waiting', attempts: [] },
    presentation: { stages: [] },
    revisions: [{ id: 'kernel-loop-1-repair', status: 'applied' }],
    program: { revision: 2, actions: program },
    actions: program.map((action) => ({ id: action.id, status: 'succeeded' })),
    attempts: [],
    ledger: {
      requirements: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { id, mandatory: true, status, workRevision: 'w1' }])),
      evidence: evidence ?? [
        evidenceRecord('alpha', statuses.alpha, ['src/a.js: alpha() printed 1']),
        evidenceRecord('beta', statuses.beta, ['src/b.js: beta() printed 3']),
      ],
    },
    verifyLoop: loop ?? { ...createVerifyLoop(3), rounds: [round()] },
  };
}

// `synthetic()` plus a third declared requirement that `verify` (alpha, beta)
// does not name.
function withUncovered({ mandatory = false, gamma = 'pending', ...over } = {}) {
  const state = synthetic(over);
  state.intent.requirements.push({ id: 'gamma', text: 'gamma returns 4' });
  state.ledger.requirements.gamma = { id: 'gamma', mandatory, status: gamma, workRevision: 'w1' };
  return state;
}

test('firstSuggestedStep reads the first item under the last `Suggested next step` heading', () => {
  assert.equal(firstSuggestedStep('## Done\n- x\n\n## Suggested next step\n- run the migration\n- then this'), 'run the migration');
  assert.equal(firstSuggestedStep('### Suggested next steps:\nRerun verify after the fix.\n## Other'), 'Rerun verify after the fix.');
  assert.equal(firstSuggestedStep('## Suggested next step\n- none'), null);
  assert.equal(firstSuggestedStep('## Done\n- x'), null);
});

test('round measures: the union of attempt intervals, pools in start order, and honest cost text', () => {
  const attempt = (id, actionId, start, end, usd, pool) => ({
    id, actionId, ordinal: 1, status: 'succeeded', pool, startedAt: start, finishedAt: end,
    usage: usd == null ? null : { api: { usd } },
  });
  const state = synthetic({
    extraActions: [{ id: 'verify-b', kind: 'check', lane: 'analyze', dependsOn: ['build-a'], affects: [], ownedFiles: [], evidenceFor: ['alpha'] }],
    loop: { max: 3, stoppedBy: null, rounds: [round({ verifyActionIds: ['verify', 'verify-b'], closedAt: '2026-09-21T03:00:00.000Z', failed: ['alpha'] })] },
  });
  state.attempts = [
    attempt('verify-1', 'verify', '2026-09-21T02:10:00.000Z', '2026-09-21T02:20:00.000Z', 0.2, 'codex'),
    attempt('verify-b-1', 'verify-b', '2026-09-21T02:15:00.000Z', '2026-09-21T02:25:00.000Z', 0.1, 'grok'),
  ];
  const [phase] = roundPhases(state);
  assert.deepEqual(phase, { kind: 'verify', round: 1, steps: ['verify', 'verify-b'], judged: 2, failed: ['alpha'], wallMinutes: 15, pools: ['codex', 'grok'], apiUsd: 0.3, unmeasured: 0, cost: '$0.30' });
  state.attempts[1].usage = null;
  assert.deepEqual([roundPhases(state)[0].cost, roundPhases(state)[0].unmeasured], ['≥$0.20', 1]);
  state.attempts[0].usage = null;
  assert.deepEqual([roundPhases(state)[0].cost, roundPhases(state)[0].apiUsd], ['—', null], 'nothing priced is a dash, never $0');
});

test('labels: the Run phase names, the in-loop round, and the finished verdict', () => {
  const state = synthetic({
    extraActions: [
      { id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] },
      { id: 'verify-round-2', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['repair-1'], affects: [], ownedFiles: [], evidenceFor: ['alpha'] },
    ],
    loop: { max: 3, stoppedBy: null, rounds: [
      round({ closedAt: 'x', failed: ['alpha'], passed: ['beta'], repairActionId: 'repair-1', repairRequirements: ['alpha'], repairStartedAt: 'x' }),
    ] },
  });
  state.actions.find((action) => action.id === 'verify-round-2').status = 'pending';
  state.actions.find((action) => action.id === 'repair-1').status = 'running';
  assert.equal(loopStageLabel(state, { actionIds: ['verify'] }), 'verify · round 1 of 3 · 2 to judge');
  assert.equal(loopStageLabel(state, { actionIds: ['repair-1'] }), 'repair · round 1 · 1 requirement');
  assert.equal(loopStageLabel(state, { actionIds: ['build-a', 'build-b'] }), null);
  assert.equal(verifyRoundLabel(state), 'verify round 2/3', 'during repair-1 the run works toward round 2');
  state.verifyLoop.rounds.push(round({ round: 2, verifyActionIds: ['verify-round-2'], toJudge: ['alpha'], carried: ['beta'] }));
  assert.equal(verifyRoundLabel(state), 'verify round 2/3');
  assert.equal(loopStageLabel(state, { actionIds: ['verify-round-2'] }), 'verify · round 2 of 3 · 1 to re-check');

  // The Run page's timeline phases and the Home card read the same labels.
  const row = { runId: state.runId, shortId: state.shortId, state, status: 'running' };
  assert.deepEqual(runTimelineFacts(row).phases.map((phase) => phase.name), [
    'build-a · build-b', 'verify · round 1 of 3 · 2 to judge', 'repair · round 1 · 1 requirement', 'verify · round 2 of 3 · 1 to re-check',
  ]);
  assert.deepEqual(planStages(row).stages.map((stage) => stage.loopLabel ?? null), [null, 'verify · round 1 of 3 · 2 to judge', 'repair · round 1 · 1 requirement', 'verify · round 2 of 3 · 1 to re-check']);
  const [card] = todayTopRuns({ runs: [{ ...row, ongoing: true }], rollups: [] }, Date.parse('2026-09-21T03:00:00.000Z'));
  assert.equal(card.status, 'verify round 2/3');

  // Finished: the verdict, and the rounds only when failures were handed back.
  state.lifecycle.status = 'completed';
  state.verifyLoop.rounds[1].closedAt = 'y';
  state.verifyLoop.rounds[1].failed = ['alpha'];
  assert.equal(verifyRoundLabel(state), null);
  assert.equal(loopVerdictText(state), 'not verified · verify rounds 2/3');
  state.ledger.requirements.alpha.status = 'passed';
  state.verifyLoop.rounds[1].failed = [];
  assert.equal(loopVerdictText(state), 'verified');
  assert.equal(loopVerdictText({}), null, 'runs without a loop read as before');
});

test('Run phase rules name each phase from its steps\' kinds: Build, Verify, Repair, and a mix joined with +', () => {
  // The owner's form (0.35.3): `── ✓ Phase 2 · Build · time-box · docs ──`.
  // A digest beside the two builds makes phase 1 a mix, named in the order
  // its kinds first appear; the kernel's repair is `Repair` though it was
  // added as an implement step; a round's own leading word is not repeated.
  const state = synthetic({
    extraActions: [
      { id: 'digest-notes', kind: 'digest', lane: 'analyze', effort: 'low', dependsOn: [], affects: [], ownedFiles: [], evidenceFor: [] },
      { id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] },
      { id: 'verify-round-2', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['repair-1'], affects: [], ownedFiles: [], evidenceFor: ['alpha'] },
    ],
    loop: { max: 3, stoppedBy: null, rounds: [
      round({ closedAt: 'x', failed: ['alpha'], passed: ['beta'], repairActionId: 'repair-1', repairRequirements: ['alpha'], repairStartedAt: 'x', repairFinishedAt: 'y' }),
      round({ round: 2, verifyActionIds: ['verify-round-2'], toJudge: ['alpha'], carried: ['beta'] }),
    ] },
  });
  state.actions.find((action) => action.id === 'verify-round-2').status = 'running';
  const row = { runId: state.runId, shortId: state.shortId, state, status: 'running' };
  assert.deepEqual(runTimelineFacts(row).phases.map((phase) => phase.kindName), ['Build + Digest', 'Verify', 'Repair', 'Verify']);
  const rules = (width) => workflowTimelineLines(workflowPanelModel(row), width, 0, { goalPreview: false })
    .lines.filter((line) => line.header && line.phaseIndex >= 0)
    .map((line) => line.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  // At 55 the step names give way; the phase number and name never do.
  assert.deepEqual(rules(55), [
    '── ✓ Phase 1 · Build + Digest · build-a · build-b · di…',
    '── ✓ Phase 2 · Verify · round 1 of 3 · 2 to judge',
    '── ✓ Phase 3 · Repair · round 1 · 1 requirement',
    '── ▶ Phase 4 · Verify · round 2 of 3 · 1 to re-check',
  ]);
  for (const [index, line] of rules(200).entries()) {
    assert.equal([...line].length, 200, line);
    assert.match(line, new RegExp(`^── [✓▶] Phase ${index + 1} · (Build \\+ Digest|Verify|Repair) · \\S.* ─+ .* · \\d+/\\d+$`), line);
  }

  // Only a round's label loses its leading word: a phase whose first step is
  // named `build` still names it.
  const plain = synthetic({ loop: { max: 1, stoppedBy: null, rounds: [] } });
  plain.program.actions = ['build', 'docs'].map((id) => ({ id, kind: 'implement', lane: 'build', effort: 'medium', dependsOn: [], affects: [], ownedFiles: [`${id}.md`], evidenceFor: [] }));
  plain.actions = plain.program.actions.map((action) => ({ id: action.id, status: 'succeeded' }));
  const plainRow = { runId: plain.runId, shortId: plain.shortId, state: plain, status: 'running' };
  const [first] = workflowTimelineLines(workflowPanelModel(plainRow), 55, 0, { goalPreview: false })
    .lines.filter((line) => line.header && line.phaseIndex >= 0);
  assert.equal(first.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), '── ✓ Phase 1 · Build · build · docs');
});

// --- the durable record and the validator ------------------------------------

function programState() {
  const goal = createV2GoalDocument({
    goal: 'Make alpha right', cwd: '/tmp/repo',
    requirements: [{ id: 'alpha', text: 'alpha returns 2' }],
    settings: { executionMode: 'program', scout: false, plannerMode: 'caller' },
  });
  return applyV2PlannerResponse(createV2State(goal, { runId: 'wf-loopst-abcdef', shortId: 'lps123' }), {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Build alpha and check it.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'build', purpose: 'Build alpha', dependsOn: [], affects: ['alpha'], ownedFiles: ['a.js'], prompt: 'Write a.js.', kind: 'implement', evidenceFor: [] },
      { id: 'verify', purpose: 'Check alpha', dependsOn: ['build'], affects: [], ownedFiles: [], prompt: 'Run a.js.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'] },
    ] },
  });
}

test('state.verifyLoop is checked: its fields, at most four rounds, no legacy names, program runs only', () => {
  const state = programState();
  state.verifyLoop = { max: 3, stoppedBy: null, rounds: [round({ toJudge: ['alpha'] })] };
  assert.equal(validateV2DurableState(state), true);
  const broken = (edit, pattern) => {
    const copy = structuredClone(state);
    edit(copy);
    assert.throws(() => validateV2DurableState(copy), pattern);
  };
  broken((copy) => { copy.verifyLoop.max = 5; }, /verifyLoop\.max must be 1 to 4/);
  broken((copy) => { copy.verifyLoop.rounds[0].decision = 'x'; }, /legacy autonomous field/);
  broken((copy) => { copy.verifyLoop.rounds[0].toJudge = ['nope']; }, /unknown requirement nope/);
  broken((copy) => { copy.verifyLoop.stoppedBy = 'tired'; }, /stoppedBy must be/);
  broken((copy) => {
    copy.verifyLoop.rounds = [1, 2, 3, 4, 5].map((n) => round({ round: n, toJudge: ['alpha'], closedAt: 'x' }));
  }, /at most four rounds/);
  broken((copy) => { copy.config.settings.executionMode = undefined; }, /requires a program workflow/);
  broken((copy) => { copy.attempts = [{ id: 'build-1', actionId: 'build', ordinal: 1, status: 'succeeded', changedFiles: [3] }]; }, /changedFiles must list at most 200 paths/);
});

const issue = (pattern) => (error) => error.issues.some((text) => pattern.test(text));

test('an accepted program validates again (verifyRounds is its normalized form), and only kernel repairs skip the ancestor rule', () => {
  const runtime = { requirements: [{ id: 'alpha', mandatory: true }], relaxedGraph: true };
  const accepted = validateActionProgram({
    schemaVersion: 'bullswarm.workflow.program.v2', defaults: { verifyRounds: 2 },
    actions: [
      { id: 'build', purpose: 'Build', dependsOn: [], affects: ['alpha'], ownedFiles: ['a.js'], prompt: 'Write a.js.', kind: 'implement', evidenceFor: [] },
      { id: 'verify', purpose: 'Check', dependsOn: ['build'], affects: [], ownedFiles: [], prompt: 'Run a.js.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'] },
    ],
  }, runtime);
  assert.equal(accepted.verifyRounds, 2);
  assert.equal(validateActionProgram(accepted, runtime).verifyRounds, 2, 'the double validation on the accept path passes');
  assert.throws(() => validateActionProgram({ ...accepted, defaults: { verifyRounds: 3 } }, runtime), issue(/program\.verifyRounds must match program\.defaults\.verifyRounds/));

  const looped = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      { id: 'build', purpose: 'Build', dependsOn: [], affects: ['alpha'], ownedFiles: ['a.js'], prompt: 'Write a.js.', kind: 'implement', evidenceFor: [] },
      { id: 'verify', purpose: 'Check', dependsOn: ['build'], affects: [], ownedFiles: [], prompt: 'Run a.js.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'] },
      { id: 'repair-1', purpose: 'Repair', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['a.js'], prompt: 'Fix a.js.', kind: 'implement', evidenceFor: [] },
    ],
  };
  assert.throws(() => validateActionProgram(looped, runtime), issue(/must depend on work action "repair-1"/));
  assert.equal(validateActionProgram(looped, { ...runtime, kernelRepairActionIds: ['repair-1'] }).actions.length, 3);
  // The exemption is by the loop record, never by name: an author's own
  // `repair-1` is held to the rule.
  assert.throws(() => validateActionProgram(looped, { ...runtime, kernelRepairActionIds: ['repair-2'] }), issue(/must depend on work action "repair-1"/));
});

const ACT_NEXT = 'an act step affects alpha; Bullswarm never repeats an outward action on its own. Check what was done, then add an act step if it must be redone: bullswarm workflow plan export syn123 --out plan.json, edit it, then plan revise';
const actStep = (affects) => ({
  id: 'send', role: 'act', lane: 'analyze', effort: 'medium', dependsOn: [], affects, ownedFiles: [], evidenceFor: [],
  deliverable: { type: 'outward' },
});

// --- Stage 3: fix cycles, the partial boundary, inherited route and evidence, acceptance ---

const accept = (requirements, over = {}) => ({
  evidence: 'choice', reason: 'good enough for now', attemptId: null, failureKind: null, at: '2026-09-25T01:00:00.000Z', revision: 3,
  requirements, ...over,
});

/**
 * The common D12 shape: writer A failed, its check `check-a` is blocked;
 * writer B succeeded and `check-b` failed B's requirement.
 */
function partialShape({ beta = 'failed', routes = {}, evidence = {} } = {}) {
  const program = [
    { id: 'build-a', kind: 'implement', lane: 'build', effort: 'medium', dependsOn: [], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [], ...(routes['build-a'] ? { route: routes['build-a'] } : {}), ...(evidence['build-a'] ? { evidence: evidence['build-a'] } : {}) },
    { id: 'build-b', kind: 'implement', lane: 'build', effort: 'high', dependsOn: [], affects: ['beta'], ownedFiles: ['src/b.js'], evidenceFor: [], ...(routes['build-b'] ? { route: routes['build-b'] } : {}), ...(evidence['build-b'] ? { evidence: evidence['build-b'] } : {}) },
    { id: 'check-a', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['build-a'], affects: [], ownedFiles: [], evidenceFor: ['alpha'], ...(routes['check-a'] ? { route: routes['check-a'] } : {}) },
    { id: 'check-b', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['build-b'], affects: [], ownedFiles: [], evidenceFor: ['beta'], ...(routes['check-b'] ? { route: routes['check-b'] } : {}) },
  ];
  const state = synthetic({ statuses: { alpha: 'pending', beta }, evidence: [evidenceRecord('beta', beta, ['src/b.js: beta() printed 1'], { source: 'check-b' })] });
  state.program.actions = program;
  state.actions = [
    { id: 'build-a', status: 'failed' }, { id: 'build-b', status: 'succeeded' },
    { id: 'check-a', status: 'blocked' }, { id: 'check-b', status: 'succeeded' },
  ];
  state.verifyLoop = { max: 2, stoppedBy: null, rounds: [round({ verifyActionIds: ['check-a', 'check-b'], toJudge: ['alpha', 'beta'] })] };
  return state;
}

test('callerDecision next names fix, rerun the review elsewhere and accept, with the reviewer and its pool', () => {
  const state = synthetic({ loop: { max: 1, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  state.attempts = [{ id: 'verify-1', actionId: 'verify', ordinal: 1, status: 'succeeded', pool: 'pool-b' }];
  assert.equal(callerDecision(state, { token: 'syn123' }).requirements[0].next,
    'fix it with a step (bullswarm workflow plan export syn123 --out plan.json → plan revise), rerun the review elsewhere (bullswarm workflow step rerun syn123 verify --avoid pool-b), or accept it (bullswarm workflow step accept syn123 verify --reason "…")');
  state.attempts = [];
  assert.match(callerDecision(state, { token: 'syn123' }).requirements[0].next, /step rerun syn123 verify --avoid <pool>\)/, 'an unknown pool stays a placeholder');
  // The repair report's own suggestion and the act-step text are unchanged.
  const act = synthetic({ extraActions: [actStep(['alpha'])], loop: { max: 1, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.equal(callerDecision(act, { token: 'syn123' }).requirements[0].next, ACT_NEXT);
});

// --- Stage-3 fix round: the narrowed loop, remembered failures, the caller's options, report repairs ---

/**
 * partialShape() plus a third writer and check: build-c → check-c passed
 * gamma with evidence that names no file (workspace-wide, D3).
 */
function partialWithGamma({ max = 2 } = {}) {
  const state = partialShape();
  state.intent.requirements.push({ id: 'gamma', text: 'gamma returns 4' });
  state.ledger.requirements.gamma = { id: 'gamma', mandatory: true, status: 'passed', workRevision: 'w1' };
  state.ledger.evidence.push(evidenceRecord('gamma', 'passed', ['judged gamma passed'], { source: 'check-c', sequence: 2 }));
  state.program.actions.push(
    { id: 'build-c', kind: 'implement', lane: 'build', effort: 'medium', dependsOn: [], affects: ['gamma'], ownedFiles: ['src/c.js'], evidenceFor: [] },
    { id: 'check-c', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['build-c'], affects: [], ownedFiles: [], evidenceFor: ['gamma'] },
  );
  state.actions.push({ id: 'build-c', status: 'succeeded' }, { id: 'check-c', status: 'succeeded' });
  state.verifyLoop = { max, stoppedBy: null, rounds: [round({ verifyActionIds: ['check-a', 'check-b', 'check-c'], toJudge: ['alpha', 'beta', 'gamma'] })] };
  return state;
}

// Apply a planned kernel step the way the runtime does, as a succeeded step.
function addSucceeded(state, action, status = 'succeeded') {
  state.program.actions.push(action);
  state.actions.push({ id: action.id, status });
}

// The program as the validator sees it after a kernel revision.
function validateLooped(state) {
  const actions = state.program.actions.map((action) => ({ purpose: action.id, prompt: action.id, inputs: [], produces: [], ...action }));
  return validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', actions }, {
    requirements: state.intent.requirements.map((item) => ({ id: item.id, mandatory: true })),
    relaxedGraph: true, kernelRepairActionIds: state.verifyLoop.rounds.map((entry) => entry.repairActionId).filter(Boolean),
  });
}

// Marked runs print the change as two whole commands (F26).
const FIX_TEXT = 'fix it with a step (bullswarm workflow plan export syn123 --out plan.json, edit it, then bullswarm workflow plan revise syn123 --program plan.json)';

test('F12/L4: marked runs use the spec text, name the check that judged the requirement, and suggest accept only when step accept would take it', () => {
  const state = synthetic({ loop: { max: 2, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  state.attempts = [{ id: 'verify-1', actionId: 'verify', ordinal: 1, status: 'succeeded', pool: 'pool-b' }];
  assert.equal(callerDecision(state, { token: 'syn123', failureRule: true }).requirements[0].next,
    `${FIX_TEXT}, rerun the review elsewhere (bullswarm workflow step rerun syn123 verify --avoid pool-b), or accept it (bullswarm workflow step accept syn123 verify --requirement alpha --reason "…")`);
  // The repair report's own suggestion follows; it never replaces the options.
  const repaired = synthetic({
    extraActions: [{ id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] }],
    loop: { max: 2, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha'], repairActionId: 'repair-1', repairRequirements: ['alpha'], repairStartedAt: 'x' })] },
  });
  repaired.attempts = [
    { id: 'verify-1', actionId: 'verify', ordinal: 1, status: 'succeeded', pool: 'pool-b' },
    { id: 'repair-1-1', actionId: 'repair-1', ordinal: 1, status: 'succeeded', pool: 'pool-a', outputFile: '/runs/out-repair-1.md' },
  ];
  const readText = () => '## Done\n- tried\n\n## Suggested next step\n- rewrite alpha() against docs/alpha.md';
  assert.match(callerDecision(repaired, { token: 'syn123', readText, failureRule: true }).requirements[0].next,
    /^fix it with a step .*, or accept it \(bullswarm workflow step accept syn123 verify --requirement alpha --reason "…"\); suggested: rewrite alpha\(\) against docs\/alpha\.md$/);
  assert.equal(callerDecision(repaired, { token: 'syn123', readText }).requirements[0].next, 'rewrite alpha() against docs/alpha.md', 'unmarked runs keep the report\'s suggestion');

  // A repair that failed left alpha pending: accept on verify would be
  // refused, so the text points at the repair instead.
  repaired.actions.find((action) => action.id === 'repair-1').status = 'failed';
  repaired.ledger.requirements.alpha.status = 'pending';
  repaired.ledger.requirements.alpha.workRevision = 'w2';
  const pending = callerDecision(repaired, { token: 'syn123', failureRule: true }).requirements[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.next, `repair-1 failed, so no review judged alpha after it: rerun repair-1 (bullswarm workflow step rerun syn123 repair-1), accept it (bullswarm workflow step accept syn123 repair-1 --reason "…"), or ${FIX_TEXT}`);
  assert.doesNotMatch(pending.next, /accept syn123 verify/);
  // The check itself failed: rerun it; accepting the check would not judge alpha.
  const failedCheck = synthetic({ statuses: { alpha: 'pending', beta: 'passed' }, evidence: [], loop: { max: 2, stoppedBy: 'step-failed', rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  failedCheck.actions.find((action) => action.id === 'verify').status = 'failed';
  assert.equal(callerDecision(failedCheck, { token: 'syn123', failureRule: true }).requirements[0].next,
    `verify failed, so no review judged alpha after it: rerun verify (bullswarm workflow step rerun syn123 verify), or ${FIX_TEXT}`);
});

test('F21: a requirement entry an earlier accept made keeps that accept\'s reason and time', () => {
  const state = synthetic({ statuses: { alpha: 'failed', beta: 'failed' }, loop: { max: 1, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha', 'beta'] })] } });
  state.actions.find((action) => action.id === 'verify').acceptance = accept([
    { id: 'beta', workRevision: 'w1', reason: 'beta is out of scope', at: '2026-09-25T00:30:00.000Z' },
    { id: 'alpha', workRevision: 'w1' },
  ]);
  assert.deepEqual([...requirementAcceptances(state)], [
    ['beta', { step: 'verify', reason: 'beta is out of scope', at: '2026-09-25T00:30:00.000Z' }],
    ['alpha', { step: 'verify', reason: 'good enough for now', at: '2026-09-25T01:00:00.000Z' }],
  ]);
});
