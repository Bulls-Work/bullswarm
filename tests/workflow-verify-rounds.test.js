// verify-rounds.js on its own: the loop's decisions, the carry-forward rule,
// the repair plan, the measures and the labels, over synthetic states. The
// kernel paths are exercised end to end in workflow-verify-rounds-kernel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actAffectedRequirements, applyRevisionVerifyRounds, callerDecision, closeRound, createVerifyLoop, failingRequirements, firstSuggestedStep,
  inheritedRepairEvidence, loopStageLabel, loopVerdictText, narrowedFailingRequirements, NOT_JUDGED_STATUS, nextLoopStep, notJudgedRequirements,
  planRepairStep, planVerifyStep, recheckSet, repairInheritedPaths, requirementAcceptances, revisedVerifyRounds, roundBrief, roundPhases,
  VERIFY_ROUNDS_MAX, verifyLoopResult, verifyRoundLabel,
} from '../src/workflow/verify-rounds.js';
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

test('nextLoopStep: close, repair while rounds remain, finish at the cap, finish when nothing fails', () => {
  assert.deepEqual(nextLoopStep({}), { step: 'finish', stoppedBy: null });
  assert.equal(nextLoopStep(synthetic()).step, 'close-round');
  const closedFailing = synthetic({ loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.deepEqual(nextLoopStep(closedFailing), { step: 'add-repair', round: 1 });
  const atCap = synthetic({ loop: { max: 1, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.deepEqual(nextLoopStep(atCap), { step: 'finish', stoppedBy: 'rounds' });
  const passing = synthetic({ statuses: { alpha: 'passed', beta: 'passed' }, loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x' })] } });
  assert.deepEqual(nextLoopStep(passing), { step: 'finish', stoppedBy: 'passed' });
});

test('nextLoopStep after a repair: finish-repair once it succeeded, revision when removed, step-failed when it failed', () => {
  const repairing = (status) => {
    const state = synthetic({
      extraActions: [{ id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] }],
      loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'], repairActionId: 'repair-1', repairRequirements: ['alpha'], repairStartedAt: 'x' })] },
    });
    state.actions.find((action) => action.id === 'repair-1').status = status;
    return state;
  };
  assert.deepEqual(nextLoopStep(repairing('succeeded')), { step: 'finish-repair', round: 1 });
  assert.deepEqual(nextLoopStep(repairing('removed')), { step: 'finish', stoppedBy: 'revision' });
  assert.deepEqual(nextLoopStep(repairing('failed')), { step: 'finish', stoppedBy: 'step-failed' });
});

test('closeRound: blocked counts as failing (D4); a middle round keeps Discovery concerns, round 1 and the final round do not', () => {
  const blocked = synthetic({ statuses: { alpha: 'blocked', beta: 'passed' } });
  const payload = closeRound(blocked, { at: '2026-09-21T02:05:00.000Z' });
  assert.deepEqual([payload.round, payload.of, payload.stage, payload.passed, payload.failed, payload.next], [1, 3, 'finished', ['beta'], ['alpha'], 'repair']);

  const concerns = ['Discovery: src/c.js has the same bug', 'plain concern', 'discovery : lower case also counts'];
  const withDiscovery = (roundNumber, max) => {
    const rounds = [];
    for (let index = 1; index < roundNumber; index += 1) rounds.push(round({ round: index, closedAt: 'x', failed: ['alpha'], repairActionId: `repair-${index}`, repairRequirements: ['alpha'], repairStartedAt: 'x', repairFinishedAt: 'x', changedFiles: [] }));
    rounds.push(round({ round: roundNumber, verifyActionIds: ['verify'], toJudge: ['alpha'] }));
    const state = synthetic({
      evidence: [evidenceRecord('alpha', 'failed', ['still 1'], { concerns }), evidenceRecord('beta', 'passed', ['src/b.js ok'])],
      loop: { max, stoppedBy: null, rounds },
    });
    closeRound(state, { at: 'y' });
    return state.verifyLoop.rounds.at(-1).discovery;
  };
  assert.deepEqual(withDiscovery(2, 3), [
    { requirementId: 'alpha', text: 'src/c.js has the same bug' },
    { requirementId: 'alpha', text: 'lower case also counts' },
  ]);
  assert.deepEqual(withDiscovery(1, 3), [], 'round 1 records none');
  assert.deepEqual(withDiscovery(3, 3), [], 'the final round records none');
  assert.deepEqual(withDiscovery(2, 2), [], 'round 2 is final when verifyRounds is 2');
});

// `synthetic()` plus a third declared requirement that `verify` (alpha, beta)
// does not name.
function withUncovered({ mandatory = false, gamma = 'pending', ...over } = {}) {
  const state = synthetic(over);
  state.intent.requirements.push({ id: 'gamma', text: 'gamma returns 4' });
  state.ledger.requirements.gamma = { id: 'gamma', mandatory, status: gamma, workRevision: 'w1' };
  return state;
}

test('round 1 accounts for every declared requirement: one no evidence step covers is not judged, never passed, no repair', () => {
  const state = withUncovered({ statuses: { alpha: 'passed', beta: 'passed' } });
  assert.deepEqual(notJudgedRequirements(state), ['gamma']);
  assert.equal(NOT_JUDGED_STATUS, 'not judged · no evidence step covers it');
  const payload = closeRound(state, { at: '2026-09-21T02:05:00.000Z' });
  assert.deepEqual([payload.passed, payload.failed, payload.notJudged, payload.next], [['alpha', 'beta'], [], ['gamma'], 'finish']);
  assert.deepEqual(state.verifyLoop.rounds[0].toJudge, ['alpha', 'beta'], 'round 1 judged what evidence steps name');
  assert.deepEqual(nextLoopStep(state), { step: 'finish', stoppedBy: 'passed' }, 'no repair on its own');

  // The caller's block names it with the status and a next step, even though the run verified.
  const decision = callerDecision(state, { token: 'syn123' });
  assert.deepEqual(decision, {
    verifyRounds: '1/3',
    requirements: [{
      id: 'gamma', status: NOT_JUDGED_STATUS, round: 1, evidence: 'gamma returns 4',
      next: 'add an evidence step whose evidenceFor names gamma, then judge it: bullswarm workflow plan export syn123 --out plan.json, edit it, then plan revise',
    }],
  });
  assert.deepEqual(verifyLoopResult(state, { token: 'syn123' }).callerDecision, decision);
  assert.deepEqual(roundPhases(state)[0].notJudged, ['gamma']);
  assert.equal(loopVerdictText({ ...state, lifecycle: { ...state.lifecycle, status: 'completed' } }), 'verified',
    'an optional requirement nobody judged leaves the verdict to the mandatory ones, which passed');
});

test('an uncovered requirement is not the loop\'s to fail: a covered failure repairs alone, and a later pass or a covering step removes it', () => {
  const state = withUncovered({ mandatory: true });
  const payload = closeRound(state, { at: '2026-09-21T02:05:00.000Z' });
  assert.deepEqual([payload.failed, payload.notJudged, payload.next], [['alpha'], ['gamma'], 'repair']);
  assert.deepEqual(planRepairStep(state).action.affects, ['alpha'], 'the repair is for the failed requirement only');
  // Both reach the caller once the rounds are spent; the uncovered one keeps its own status.
  const atCap = withUncovered({ mandatory: true, loop: { max: 1, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.deepEqual(callerDecision(atCap, { token: 't' }).requirements.map((entry) => [entry.id, entry.status, entry.round]),
    [['alpha', 'failed', 1], ['gamma', NOT_JUDGED_STATUS, 1]]);
  assert.equal(loopVerdictText({ ...atCap, lifecycle: { ...atCap.lifecycle, status: 'completed' } }), 'not verified');
  // Only round 1 records it, and only while nothing judged or covers it.
  assert.deepEqual(roundPhases(atCap).map((phase) => phase.notJudged ?? null), [['gamma']]);
  assert.deepEqual(notJudgedRequirements(withUncovered({ gamma: 'passed' })), []);
  assert.deepEqual(notJudgedRequirements(withUncovered({ gamma: 'failed' })), [], 'a judged requirement is the loop\'s, not "not judged"');
  const covered = withUncovered({ extraActions: [{ id: 'verify-gamma', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['build-a'], affects: [], ownedFiles: [], evidenceFor: ['gamma'] }] });
  assert.deepEqual(notJudgedRequirements(covered), []);
  assert.deepEqual(notJudgedRequirements(synthetic({ loop: { max: 3, stoppedBy: null, rounds: [] } })), [], 'no round 1 yet, nothing to account for');
});

test('recheckSet: a path or a whole-word basename re-opens, a file-less line is workspace-wide (D3), unknown changes re-open everything', () => {
  const state = (line) => synthetic({ evidence: [evidenceRecord('alpha', 'failed', ['x']), evidenceRecord('beta', 'passed', [line])] });
  const repaired = round({ closedAt: 'x', failed: ['alpha'], repairActionId: 'repair-1', repairRequirements: ['alpha'] });
  const touched = (line, changed) => recheckSet(state(line), repaired, changed).touched;
  assert.deepEqual(touched('src/b.js: beta() printed 3', ['src/a.js']), []);
  assert.deepEqual(touched('src/b.js: beta() printed 3', ['src/a.js', 'src/b.js']), ['beta']);
  assert.deepEqual(touched('b.js exports beta', ['lib/b.js']), ['beta'], 'basename as a whole word');
  assert.deepEqual(touched('sub.js exports beta', ['lib/b.js']), [], 'not a whole word');
  assert.deepEqual(touched('b.json parses', ['lib/b.js']), [], 'a longer extension is another file');
  assert.deepEqual(touched('npm test: 1735 pass, 0 fail', ['src/a.js']), ['beta'], 'no file named: workspace-wide');
  assert.deepEqual(touched('npm test: 1735 pass, 0 fail', []), [], 'a repair that changed nothing re-opens nothing');
  assert.deepEqual(touched('src/b.js: beta() printed 3', null), ['beta'], 'unknown changed files re-open every passed requirement');
  const concernOnly = synthetic({ evidence: [evidenceRecord('alpha', 'failed', ['x']), evidenceRecord('beta', 'passed', ['beta() printed 3'], { concerns: ['watch src/a.js'] })] });
  assert.deepEqual(recheckSet(concernOnly, repaired, ['src/a.js']).touched, ['beta'], 'concern lines count too');
  assert.deepEqual(recheckSet(state('src/b.js ok'), repaired, ['src/a.js']), { failing: ['alpha'], touched: [], carried: ['beta'], toJudge: ['alpha'] });
});

test('planRepairStep: failing requirements, the union of the affecting steps\' files, the highest effort, a free id', () => {
  const state = synthetic({
    statuses: { alpha: 'failed', beta: 'failed' },
    loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha', 'beta'] })] },
  });
  const { action, record } = planRepairStep(state);
  assert.deepEqual(action, {
    id: 'repair-1', purpose: 'Repair after verify round 1: alpha, beta', dependsOn: ['verify'],
    affects: ['alpha', 'beta'], ownedFiles: ['src/a.js', 'src/b.js'],
    prompt: 'Kernel repair: make alpha, beta pass. The kernel adds the failing evidence, discovery items, not-done items and handoffs below.',
    kind: 'implement', effort: 'high', evidenceFor: [], inputs: [], produces: [],
  });
  assert.deepEqual(record, { repairActionId: 'repair-1', repairRequirements: ['alpha', 'beta'], repairOwnedFiles: ['src/a.js', 'src/b.js'], repairUnrestricted: false });

  const taken = synthetic({ extraActions: [{ id: 'repair-1', lane: 'analyze', affects: [], ownedFiles: [], evidenceFor: [], dependsOn: [] }], loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.equal(planRepairStep(taken).action.id, 'repair-1-2', 'an author id is never reused; the kernel knows its steps from the loop record');

  const integrator = synthetic({ extraActions: [{ id: 'glue', kind: 'integration', lane: 'build', effort: 'high', dependsOn: [], affects: ['alpha'], ownedFiles: [], evidenceFor: [] }], loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  const unrestricted = planRepairStep(integrator);
  assert.deepEqual([unrestricted.action.ownedFiles, unrestricted.record.repairUnrestricted], [[], true]);
});

test('the round paragraph: round 1 asks for actionable failures; none for a one-round run', () => {
  const state = synthetic();
  assert.match(roundBrief(state, 'verify'), /^Verify round 1 of 3\. A requirement you fail starts a kernel repair built from your evidence/);
  state.verifyLoop.max = 1;
  assert.equal(roundBrief(state, 'verify'), null);
  assert.equal(roundBrief(synthetic(), 'build-a'), null);
});

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
  assert.deepEqual([roundPhases(state)[0].cost, roundPhases(state)[0].unmeasured], ['at least $0.20 · 1 unmeasured', 1]);
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

test('a revision\'s verifyRounds sets the rest of the run\'s budget, never below the rounds already closed', () => {
  const state = synthetic({ loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x' }), round({ round: 2, closedAt: 'y' })] } });
  assert.equal(applyRevisionVerifyRounds(state, { actions: [] }), false, 'absent leaves it unchanged');
  assert.equal(state.verifyLoop.max, 3);
  assert.equal(applyRevisionVerifyRounds(state, { defaults: { verifyRounds: 1 } }), true);
  assert.equal(state.verifyLoop.max, 2, 'two rounds are closed, so the budget stays at 2');
  applyRevisionVerifyRounds(state, { defaults: { verifyRounds: 3 } });
  assert.equal(state.verifyLoop.max, 3);
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

test('act-affected failures are not repaired, and a report-only failure repairs as an analyze report', () => {
  const onlyAct = synthetic({
    statuses: { alpha: 'failed', beta: 'passed' },
    extraActions: [actStep(['alpha'])],
    loop: { max: 3, stoppedBy: null, rounds: [round()] },
  });
  const closed = closeRound(onlyAct, { at: '2026-09-24T03:00:00.000Z' });
  assert.equal(closed.next, 'caller');
  assert.deepEqual(actAffectedRequirements(onlyAct, ['alpha', 'beta']), ['alpha']);
  assert.deepEqual(nextLoopStep(onlyAct), { step: 'finish', stoppedBy: 'act-step' });
  assert.equal(callerDecision(onlyAct, { token: 'syn123' }).requirements[0].next, ACT_NEXT);

  const mixed = synthetic({
    statuses: { alpha: 'failed', beta: 'failed' },
    extraActions: [actStep(['beta'])],
    loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha', 'beta'] })] },
  });
  assert.deepEqual(nextLoopStep(mixed), { step: 'add-repair', round: 1 });
  assert.deepEqual(planRepairStep(mixed).action.affects, ['alpha']);
  assert.equal(planRepairStep(mixed).action.lane, undefined, 'a kind-only repair keeps today\'s shape');

  const report = synthetic({
    statuses: { alpha: 'failed', beta: 'passed' },
    loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] },
  });
  for (const action of report.program.actions) if (action.id !== 'verify') action.affects = [];
  report.program.actions.push({
    id: 'study', role: 'investigate', lane: 'analyze', effort: 'medium', dependsOn: [],
    affects: ['alpha'], ownedFiles: [], evidenceFor: [], deliverable: { type: 'report' },
  });
  report.actions.push({ id: 'study', status: 'succeeded' });
  const planned = planRepairStep(report);
  assert.deepEqual([planned.action.lane, planned.action.deliverable, planned.action.ownedFiles, planned.action.kind], ['analyze', 'report', [], 'implement']);
  assert.equal(planned.record.repairUnrestricted, false);
  assert.deepEqual(planned.record.repairRequirements, ['alpha']);

  const inherited = synthetic({
    loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'], repairActionId: 'repair-1', repairRequirements: ['alpha'] })] },
  });
  assert.deepEqual(repairInheritedPaths(inherited, 'repair-1'), []);
  inherited.program.actions.push({
    id: 'rows', role: 'produce', lane: 'build', effort: 'medium', dependsOn: [],
    affects: ['alpha'], ownedFiles: [], evidenceFor: [],
    deliverable: { type: 'data', paths: ['out/summary.json', 'out/rows.json'] },
  });
  assert.deepEqual(repairInheritedPaths(inherited, 'repair-1'), ['out/rows.json', 'out/summary.json']);
});

// --- Stage 3: fix cycles, the partial boundary, inherited route and evidence, acceptance ---

test('createVerifyLoop with countsFixes reads verifyRounds as fix cycles (max = fixes + 1); without it, as total rounds', () => {
  assert.equal(VERIFY_ROUNDS_MAX, 4);
  const fixes = (value) => createVerifyLoop(value, { countsFixes: true }).max;
  assert.deepEqual([fixes(undefined), fixes(0), fixes(1), fixes(2), fixes(3), fixes(7), fixes(-1), fixes('2')], [2, 1, 2, 3, 4, 4, 1, 2]);
  assert.deepEqual(createVerifyLoop(0, { countsFixes: true }), { max: 1, stoppedBy: null, rounds: [] });
  const rounds = (value) => createVerifyLoop(value).max;
  assert.deepEqual([rounds(undefined), rounds(0), rounds(1), rounds(2), rounds(3), rounds(4), rounds('2')], [3, 1, 1, 2, 3, 3, 3], 'saved runs keep 1-3, default 3');
  assert.equal(createVerifyLoop(3, { countsFixes: false }).max, 3);
});

test('revisedVerifyRounds reads the value through the marker, never below the rounds already closed', () => {
  const marked = synthetic({ loop: { max: 2, stoppedBy: null, rounds: [round()] } });
  const fixes = (value, state = marked) => revisedVerifyRounds(state, { defaults: { verifyRounds: value } }, { countsFixes: true });
  assert.deepEqual([fixes(0), fixes(1), fixes(2), fixes(3)], [1, null, 3, 4]);
  const saved = synthetic({ loop: { max: 3, stoppedBy: null, rounds: [round()] } });
  const total = (value) => revisedVerifyRounds(saved, { defaults: { verifyRounds: value } });
  assert.deepEqual([total(0), total(1), total(2), total(3)], [1, 1, 2, null]);
  assert.equal(revisedVerifyRounds(saved, { verifyRounds: 1 }), 1, 'the top-level form too');
  assert.equal(revisedVerifyRounds(saved, { defaults: {} }), null, 'absent leaves it alone');
  const twoClosed = synthetic({ loop: { max: 3, stoppedBy: null, rounds: [round({ closedAt: 'x' }), round({ round: 2, closedAt: 'x' })] } });
  assert.equal(fixes(0, twoClosed), 2, 'never below the rounds already closed');
  assert.equal(applyRevisionVerifyRounds(marked, { defaults: { verifyRounds: 3 } }, { countsFixes: true }), true);
  assert.equal(marked.verifyLoop.max, 4);
  assert.equal(applyRevisionVerifyRounds(saved, { defaults: { verifyRounds: 3 } }), false);
});

const accept = (requirements, over = {}) => ({
  evidence: 'choice', reason: 'good enough for now', attemptId: null, failureKind: null, at: '2026-09-25T01:00:00.000Z', revision: 3,
  requirements, ...over,
});

test('failingRequirements and callerDecision skip a current acceptance; it lapses when workRevision moves', () => {
  const state = synthetic({ loop: { max: 1, stoppedBy: 'rounds', rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  assert.deepEqual(failingRequirements(state), ['alpha']);
  state.actions.find((action) => action.id === 'verify').acceptance = accept([{ id: 'alpha', workRevision: 'w1' }]);
  assert.deepEqual(failingRequirements(state), []);
  assert.deepEqual([...requirementAcceptances(state)], [['alpha', { step: 'verify', reason: 'good enough for now', at: '2026-09-25T01:00:00.000Z' }]]);
  assert.equal(callerDecision(state, { token: 'syn123' }), null, 'nothing is left for the caller');
  assert.equal(state.ledger.requirements.alpha.status, 'failed', 'a choice is not proof: the ledger is untouched');
  assert.equal(loopVerdictText({ ...state, lifecycle: { ...state.lifecycle, status: 'completed' } }), 'not verified');
  state.ledger.requirements.alpha.workRevision = 'w2';
  assert.deepEqual(failingRequirements(state), ['alpha'], 'a later fix or rerun moved workRevision: the acceptance lapsed');
  assert.deepEqual(callerDecision(state, { token: 'syn123' }).requirements.map((entry) => entry.id), ['alpha']);
  // A step acceptance (no requirements) and a removed step accept nothing.
  state.ledger.requirements.alpha.workRevision = 'w1';
  state.actions.find((action) => action.id === 'verify').acceptance = accept(undefined, { attemptId: 'verify-1', failureKind: 'semantic' });
  assert.deepEqual(failingRequirements(state), ['alpha']);
  state.actions.find((action) => action.id === 'verify').acceptance = accept([{ id: 'alpha', workRevision: 'w1' }]);
  state.actions.find((action) => action.id === 'verify').status = 'removed';
  assert.deepEqual(failingRequirements(state), ['alpha']);
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

test('closeRound partial and repairableOnly (D12): only what a succeeded check judged on succeeded work is repaired, never born blocked', () => {
  const state = partialShape();
  const payload = closeRound(state, { at: '2026-09-25T01:00:00.000Z', partial: true });
  assert.deepEqual([payload.failed, payload.next], [['alpha', 'beta'], 'repair'], 'the blocked check\'s requirement stays failing');
  assert.deepEqual(narrowedFailingRequirements(state), ['beta']);
  assert.deepEqual(nextLoopStep(state, { repairableOnly: true }), { step: 'add-repair', round: 1 });
  const { action, record } = planRepairStep(state, { repairableOnly: true });
  assert.deepEqual([action.affects, action.dependsOn, action.ownedFiles, record.repairRequirements], [['beta'], ['check-b'], ['src/b.js'], ['beta']]);
  assert.equal(action.route, undefined, 'no route without inheritRoute');
  assert.equal(action.evidence, undefined, 'no evidence without inheritEvidence');
  // The unmarked plan depends on the blocked check too (the stage-2 defect D12 fixes).
  const legacy = planRepairStep(state);
  assert.deepEqual([legacy.action.affects, legacy.action.dependsOn], [['beta'], ['check-a', 'check-b']]);

  // Nothing left to repair: the round goes to the caller, and the loop settles.
  const onlyBlocked = partialShape({ beta: 'passed' });
  const closed = closeRound(onlyBlocked, { at: 'x', partial: true });
  assert.deepEqual([closed.failed, closed.next], [['alpha'], 'caller']);
  assert.deepEqual(nextLoopStep(onlyBlocked, { repairableOnly: true }), { step: 'finish', stoppedBy: 'step-failed' });
  assert.equal(closeRound(partialShape({ beta: 'passed' }), { at: 'x' }).next, 'repair', 'without partial, today\'s rule');
  // A failing requirement with no current record (a check judged nothing) is not repaired.
  const stale = partialShape();
  stale.ledger.evidence[0].stale = true;
  assert.deepEqual(narrowedFailingRequirements(stale), []);
});

test('repair and verify steps carry the inherited route (D19)', () => {
  const routes = {
    'build-a': { pools: { avoid: ['pool-a'] } },
    'build-b': { pools: { use: ['pool-c'], avoid: ['pool-b'] }, providers: { avoid: ['grok'] } },
    'check-a': { independentOf: ['build-a'] },
    'check-b': { pools: { avoid: ['pool-x'] }, independentOf: ['build-b'] },
  };
  const state = partialShape({ routes });
  closeRound(state, { at: 'x', partial: true });
  const plan = planRepairStep(state, { repairableOnly: true, inheritRoute: true });
  assert.deepEqual(plan.action.route, { pools: { use: ['pool-c'], avoid: ['pool-b'] }, providers: { avoid: ['grok'] } });
  // Both writers: avoid unions, use only when every affecting step has one, never independentOf.
  const failedBoth = structuredClone(state);
  failedBoth.ledger.requirements.alpha.status = 'failed';
  const both = planRepairStep(failedBoth, { inheritRoute: true }).action.route;
  assert.deepEqual(both, { pools: { avoid: ['pool-a', 'pool-b'] }, providers: { avoid: ['grok'] } });

  state.program.actions.push(plan.action);
  state.actions.push({ id: plan.action.id, status: 'succeeded' });
  Object.assign(state.verifyLoop.rounds[0], plan.record);
  const verify = planVerifyStep(state, { round: 2, repairActionId: 'repair-1', toJudge: ['beta'], inheritRoute: true });
  assert.deepEqual(verify.dependsOn, ['repair-1']);
  assert.deepEqual(verify.route, { pools: { avoid: ['pool-x'] }, independentOf: ['build-b', 'repair-1'] },
    'independent of the named steps and the repair; build-a does not run before it, so it is left out');
  assert.equal(planVerifyStep(state, { round: 2, repairActionId: 'repair-1', toJudge: ['beta'] }).route, undefined);

  const writers = partialShape({ routes: { 'check-b': { independentOf: 'writers' } } });
  closeRound(writers, { at: 'x', partial: true });
  const repair = planRepairStep(writers, { repairableOnly: true, inheritRoute: true });
  assert.equal(repair.action.route, undefined, 'a repair never inherits independentOf');
  writers.program.actions.push(repair.action);
  writers.actions.push({ id: repair.action.id, status: 'succeeded' });
  Object.assign(writers.verifyLoop.rounds[0], repair.record);
  assert.deepEqual(planVerifyStep(writers, { round: 2, repairActionId: 'repair-1', toJudge: ['beta'], inheritRoute: true }).route, { independentOf: 'writers' });
});

test('a files repair inherits the affecting steps\' evidence (D33); a report repair inherits none', () => {
  const items = [
    { type: 'command', cmd: 'npm test' },
    { type: 'command', cmd: 'npm test' },
    { type: 'schema', file: 'out/b.json', schema: 'schemas/b.json' },
    { type: 'schema', file: '$output', schema: 'schemas/report.json' },
    { type: 'command', cmd: 'node check.js "$BULLSWARM_STEP_OUTPUT"' },
    { type: 'schema', file: 'src/b.js', schema: 'schemas/b.json', format: 'json' },
  ];
  const state = partialShape({ evidence: { 'build-b': items } });
  closeRound(state, { at: 'x', partial: true });
  const plan = planRepairStep(state, { repairableOnly: true, inheritEvidence: true });
  assert.deepEqual(plan.action.evidence, [
    { type: 'command', cmd: 'npm test' },
    { type: 'schema', file: 'src/b.js', schema: 'schemas/b.json', format: 'json' },
  ]);
  assert.deepEqual(plan.evidenceCounts, { inherited: 2, dropped: 3 });
  assert.equal(planRepairStep(state, { repairableOnly: true }).action.evidence, undefined, 'unmarked runs: no evidence');

  // An unrestricted repair reaches every file; the first five after de-duplication.
  const many = Array.from({ length: 7 }, (_, index) => ({ type: 'command', cmd: `npm run check-${index}` }));
  const capped = inheritedRepairEvidence([{ id: 'glue', evidence: [...many, { type: 'schema', file: 'out/x.json', schema: 's.json' }] }], { unrestricted: true });
  assert.deepEqual(capped.evidence.map((item) => item.cmd), ['npm run check-0', 'npm run check-1', 'npm run check-2', 'npm run check-3', 'npm run check-4']);
  assert.deepEqual([capped.inherited, capped.dropped], [5, 3]);
  // A declared deliverable path is within reach.
  const data = inheritedRepairEvidence([{ id: 'rows', deliverable: { type: 'data', paths: ['out/rows.json'] }, evidence: [{ type: 'schema', file: 'out/rows.json', schema: 's.json' }] }]);
  assert.deepEqual(data.evidence, [{ type: 'schema', file: 'out/rows.json', schema: 's.json' }]);

  const report = synthetic({ loop: { max: 2, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] } });
  for (const action of report.program.actions) if (action.id !== 'verify') action.affects = [];
  report.program.actions.push({
    id: 'study', role: 'investigate', lane: 'analyze', effort: 'medium', dependsOn: [], affects: ['alpha'], ownedFiles: [], evidenceFor: [],
    deliverable: { type: 'report' }, evidence: [{ type: 'command', cmd: 'npm test' }],
  });
  report.actions.push({ id: 'study', status: 'succeeded' });
  const planned = planRepairStep(report, { inheritEvidence: true });
  assert.equal(planned.action.deliverable, 'report');
  assert.equal(planned.action.evidence, undefined);
  assert.deepEqual(planned.evidenceCounts, { inherited: 0, dropped: 1 });
});

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

test('F5/F10: a repair narrowed at partial is re-checked on exactly its requirements, depends only on the repair, and the left-out requirement goes to the caller', () => {
  const state = partialWithGamma();
  const closed = closeRound(state, { at: '2026-09-25T01:00:00.000Z', partial: true });
  assert.deepEqual([closed.failed, closed.next], [['alpha', 'beta'], 'repair']);
  const plan = planRepairStep(state, { repairableOnly: true });
  assert.deepEqual([plan.action.affects, plan.action.dependsOn], [['beta'], ['check-b']], 'never born blocked: only the check that judged beta');
  const first = state.verifyLoop.rounds[0];
  Object.assign(first, plan.record, { repairStartedAt: 'x' });
  addSucceeded(state, plan.action);
  state.ledger.requirements.beta.status = 'pending';
  state.ledger.requirements.beta.workRevision = 'w2';
  assert.deepEqual(nextLoopStep(state, { repairableOnly: true }), { step: 'finish-repair', round: 1 });

  // gamma's evidence names no file, so an ordinary repair would re-open it;
  // this one does not reach build-c, so gamma carries forward.
  const recheck = recheckSet(state, first, ['src/b.js']);
  assert.deepEqual([recheck.toJudge, recheck.touched, recheck.carried], [['beta'], [], ['gamma']]);
  assert.deepEqual(recheckSet(state, first, null).toJudge, ['beta'], 'unknown changed files re-open nothing a narrowed repair cannot reach');
  const verify = planVerifyStep(state, { round: 2, repairActionId: plan.action.id, toJudge: recheck.toJudge });
  assert.deepEqual([verify.dependsOn, verify.evidenceFor], [['repair-1'], ['beta']]);
  addSucceeded(state, verify);
  assert.doesNotThrow(() => validateLooped(state), 'the kernel\'s own re-review revision passes the evidence-ancestor rule');
  Object.assign(first, { repairFinishedAt: 'y', changedFiles: ['src/b.js'] });

  // Round 2 passes beta while build-a is still failed: it closes at partial,
  // and alpha, which the narrowed repair left out, is still failing.
  const second = { ...round({ round: 2, verifyActionIds: [verify.id], toJudge: recheck.toJudge, carried: recheck.carried }) };
  state.verifyLoop.rounds.push(second);
  state.ledger.requirements.beta.status = 'passed';
  state.ledger.evidence.push(evidenceRecord('beta', 'passed', ['src/b.js: beta() printed 3'], { source: verify.id, sequence: 3, revision: 'w2' }));
  const closedSecond = closeRound(state, { at: 'z', partial: true });
  assert.deepEqual([closedSecond.passed, closedSecond.failed, closedSecond.next], [['beta'], ['alpha'], 'caller']);
  assert.deepEqual(nextLoopStep(state, { repairableOnly: true }), { step: 'finish', stoppedBy: 'rounds' });

  const decision = callerDecision(state, { token: 'syn123', failureRule: true });
  assert.deepEqual(decision.requirements.map((entry) => [entry.id, entry.status]), [['alpha', 'pending']]);
  assert.equal(decision.requirements[0].evidence, 'not judged: check-a is blocked by build-a (failed)');
  assert.equal(decision.requirements[0].next,
    `check-a is blocked by build-a (failed), so alpha was never judged: rerun build-a (bullswarm workflow step rerun syn123 build-a), accept it (bullswarm workflow step accept syn123 build-a --reason "…"), or ${FIX_TEXT}`);
});

test('F5: after a narrowed repair, a later repair re-opens only passed requirements whose writers are upstream of it', () => {
  const state = partialWithGamma({ max: 3 });
  closeRound(state, { at: 'a', partial: true });
  const plan = planRepairStep(state, { repairableOnly: true });
  const first = state.verifyLoop.rounds[0];
  Object.assign(first, plan.record, { repairStartedAt: 'x', repairFinishedAt: 'y', changedFiles: ['src/b.js'] });
  addSucceeded(state, plan.action);
  const verify = planVerifyStep(state, { round: 2, repairActionId: plan.action.id, toJudge: ['beta'] });
  addSucceeded(state, verify);
  state.verifyLoop.rounds.push(round({ round: 2, verifyActionIds: [verify.id], toJudge: ['beta'], carried: ['gamma'], closedAt: 'b', failed: ['beta'] }));
  state.ledger.evidence.push(evidenceRecord('beta', 'failed', ['src/b.js: beta() still printed 1'], { source: verify.id, sequence: 3 }));
  // Round 2 failed beta again; repair-2 depends on every live check of its round.
  const second = planRepairStep(state, { repairableOnly: true });
  assert.deepEqual(second.action.dependsOn, ['verify-round-2']);
  Object.assign(state.verifyLoop.rounds[1], second.record, { repairStartedAt: 'c' });
  addSucceeded(state, second.action);
  const recheck = recheckSet(state, state.verifyLoop.rounds[1], null);
  assert.deepEqual([recheck.toJudge, recheck.carried], [['beta'], ['gamma']], 'build-c is not upstream of repair-2');
});

test('F11: a round closed at partial is never forgotten: its blocked check\'s requirement stays failing and reaches the caller', () => {
  // Two closed rounds; round 2 did not list alpha (a build before the fix).
  // The caller then accepted build-a and check-a failed alpha.
  const state = partialWithGamma();
  state.verifyLoop.rounds = [
    round({ verifyActionIds: ['check-a', 'check-b', 'check-c'], toJudge: ['alpha', 'beta', 'gamma'], closedAt: 'a', failed: ['alpha', 'beta'], passed: ['gamma'], repairActionId: 'repair-1', repairRequirements: ['beta'], repairStartedAt: 'b', repairFinishedAt: 'c', changedFiles: ['src/b.js'] }),
    round({ round: 2, verifyActionIds: ['verify-round-2'], toJudge: ['beta'], carried: ['gamma'], closedAt: 'd', passed: ['beta'], failed: [] }),
  ];
  addSucceeded(state, { id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['check-b'], affects: ['beta'], ownedFiles: ['src/b.js'], evidenceFor: [] });
  addSucceeded(state, { id: 'verify-round-2', kind: 'adversarial-acceptance', lane: 'analyze', effort: 'high', dependsOn: ['repair-1'], affects: [], ownedFiles: [], evidenceFor: ['beta'] });
  state.ledger.requirements.beta.status = 'passed';
  // Still pending (check-a blocked): the loop remembers it at partial.
  assert.deepEqual(nextLoopStep(state, { repairableOnly: true }), { step: 'finish', stoppedBy: 'rounds' });
  assert.deepEqual(callerDecision(state, { token: 'syn123', failureRule: true }).requirements.map((entry) => entry.id), ['alpha']);
  // Now judged failed by check-a.
  state.actions.find((action) => action.id === 'build-a').status = 'succeeded';
  state.actions.find((action) => action.id === 'check-a').status = 'succeeded';
  state.ledger.requirements.alpha.status = 'failed';
  state.ledger.evidence.push(evidenceRecord('alpha', 'failed', ['src/a.js: alpha() printed 1'], { source: 'check-a', sequence: 9 }));
  const decision = callerDecision(state, { token: 'syn123', failureRule: true });
  assert.deepEqual(decision.requirements.map((entry) => [entry.id, entry.status]), [['alpha', 'failed']]);
  assert.match(decision.requirements[0].next, /step accept syn123 check-a --requirement alpha --reason "…"\)$/);
  assert.equal(loopVerdictText({ ...state, lifecycle: { ...state.lifecycle, status: 'completed' } }), 'not verified · verify rounds 2/2');
});

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

test('L6: after a report repair the next round judges the repair\'s output as the current report; a files repair adds no such line', () => {
  const state = synthetic({ statuses: { alpha: 'failed', beta: 'passed' } });
  for (const action of state.program.actions) if (action.id !== 'verify') action.affects = [];
  state.program.actions.push({
    id: 'study', role: 'investigate', lane: 'analyze', effort: 'medium', dependsOn: [], affects: ['alpha'], ownedFiles: [], evidenceFor: [], deliverable: { type: 'report' },
  });
  state.actions.push({ id: 'study', status: 'succeeded', outputFile: '/runs/r1/out-study-attempt-1.md' });
  state.verifyLoop = { max: 2, stoppedBy: null, rounds: [round({ closedAt: 'x', failed: ['alpha'] })] };
  const plan = planRepairStep(state);
  assert.equal(plan.action.deliverable, 'report');
  Object.assign(state.verifyLoop.rounds[0], plan.record, { repairStartedAt: 'x', repairFinishedAt: 'y', changedFiles: [] });
  state.ledger.requirements.alpha.status = 'pending';
  state.program.actions.push(plan.action);
  state.actions.push({ id: plan.action.id, status: 'succeeded', outputFile: '/runs/r1/out-repair-1-attempt-1.md' });
  const verify = planVerifyStep(state, { round: 2, repairActionId: plan.action.id, toJudge: ['alpha'] });
  assert.deepEqual(verify.dependsOn, ['repair-1'], 'the repair\'s output is among its dependency artifacts');
  state.program.actions.push(verify);
  state.actions.push({ id: verify.id, status: 'pending' });
  state.verifyLoop.rounds.push(round({ round: 2, verifyActionIds: [verify.id], toJudge: ['alpha'] }));
  const brief = roundBrief(state, verify.id).split('\n');
  assert.equal(brief[1], 'The current version of study\'s report is /runs/r1/out-repair-1-attempt-1.md; judge that, not the earlier output.');

  // A files repair changes the workspace: no report line.
  const files = synthetic({ extraActions: [{ id: 'repair-1', kind: 'implement', lane: 'build', effort: 'high', dependsOn: ['verify'], affects: ['alpha'], ownedFiles: ['src/a.js'], evidenceFor: [] }] });
  files.actions.find((action) => action.id === 'repair-1').outputFile = '/runs/r1/out-repair-1-attempt-1.md';
  files.program.actions.push({ id: 'verify-round-2', kind: 'adversarial-acceptance', dependsOn: ['repair-1'], affects: [], ownedFiles: [], evidenceFor: ['alpha'] });
  files.verifyLoop = { max: 2, stoppedBy: null, rounds: [
    round({ closedAt: 'x', failed: ['alpha'], repairActionId: 'repair-1', repairRequirements: ['alpha'], repairStartedAt: 'x', repairFinishedAt: 'y', changedFiles: ['src/a.js'] }),
    round({ round: 2, verifyActionIds: ['verify-round-2'], toJudge: ['alpha'] }),
  ] };
  assert.doesNotMatch(roundBrief(files, 'verify-round-2'), /current version/);
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
