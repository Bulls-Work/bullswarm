// verify-rounds.js on its own: the loop's decisions, the carry-forward rule,
// the repair plan, the measures and the labels, over synthetic states. The
// kernel paths are exercised end to end in workflow-verify-rounds-kernel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actAffectedRequirements, applyRevisionVerifyRounds, callerDecision, closeRound, createVerifyLoop, firstSuggestedStep, loopStageLabel, loopVerdictText,
  NOT_JUDGED_STATUS, nextLoopStep, notJudgedRequirements, planRepairStep, recheckSet, repairInheritedPaths, roundBrief, roundPhases, verifyLoopResult,
  verifyRoundLabel,
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

test('state.verifyLoop is checked: its fields, at most three rounds, no legacy names, program runs only', () => {
  const state = programState();
  state.verifyLoop = { max: 3, stoppedBy: null, rounds: [round({ toJudge: ['alpha'] })] };
  assert.equal(validateV2DurableState(state), true);
  const broken = (edit, pattern) => {
    const copy = structuredClone(state);
    edit(copy);
    assert.throws(() => validateV2DurableState(copy), pattern);
  };
  broken((copy) => { copy.verifyLoop.max = 4; }, /verifyLoop\.max must be 1, 2 or 3/);
  broken((copy) => { copy.verifyLoop.rounds[0].decision = 'x'; }, /legacy autonomous field/);
  broken((copy) => { copy.verifyLoop.rounds[0].toJudge = ['nope']; }, /unknown requirement nope/);
  broken((copy) => { copy.verifyLoop.stoppedBy = 'tired'; }, /stoppedBy must be/);
  broken((copy) => {
    copy.verifyLoop.rounds = [1, 2, 3, 4].map((n) => round({ round: n, toJudge: ['alpha'], closedAt: 'x' }));
  }, /at most three rounds/);
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
