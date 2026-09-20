import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptRoutingText,
  fittedParts,
  phaseActionGlyph,
  planAttemptDetail,
  planLevels,
  planMoreParts,
  planProgress,
  planStageBoxParts,
  planStageBoxText,
  planStageName,
  planStageActions,
  planStageHeader,
  planStageLabel,
  planStages,
  planStripParts,
  runEconomics,
  runDurationFacts,
  phaseDurationFacts,
  attemptDurationText,
  durationClockText,
  runClockText,
  runHeaderFacts,
  runSpendFacts,
  runTimelineFacts,
  stepTally,
  workflowPanelModel,
} from '../src/workflow/run-model.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function fixture() {
  const goal = createV2GoalDocument({
    goal: 'Audit and report the repository',
    cwd: '/tmp/repository',
    requirements: [{ id: 'report', text: 'A report exists.', mandatory: true }],
    settings: { scout: false, executionMode: 'program' },
  });
  let state = createV2State(goal, { runId: 'wf-model', shortId: 'model1' });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2',
    kind: 'program',
    summary: 'Audit then report.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'audit', purpose: 'Audit files', dependsOn: [], affects: ['report'], ownedFiles: ['audit.md'], prompt: 'Audit files.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['audit'] },
        { id: 'report', purpose: 'Write the report', dependsOn: ['audit'], affects: [], ownedFiles: [], prompt: 'Write report.', lane: 'analyze', effort: 'low', evidenceFor: ['report'], inputs: ['audit'], produces: [] },
      ],
    },
  });
  state.lifecycle = { status: 'running', startedAt: '2026-09-20T11:55:00.000Z', finishedAt: null, resultFile: null };
  state.actions[0].status = 'succeeded';
  state.actions[0].startedAt = '2026-09-20T11:56:00.000Z';
  state.actions[0].finishedAt = '2026-09-20T11:57:00.000Z';
  state.actions[1].status = 'running';
  state.actions[1].startedAt = '2026-09-20T11:58:00.000Z';
  state.attempts.push({
    id: 'report-1', actionId: 'report', ordinal: 1, status: 'running',
    pool: 'codex', model: 'gpt-test', startedAt: '2026-09-20T11:58:00.000Z', finishedAt: null,
    usage: { api: { usd: 0.25, tokenSource: 'provider-reported' } },
  });
  return { runId: state.runId, shortId: state.shortId, status: 'running', state, events: [] };
}

test('Run model projects phases, selected agents, progress and clickable plan parts', () => {
  const row = fixture();
  const panel = workflowPanelModel(row);
  assert.equal(panel.dependencyGroups, true);
  assert.deepEqual(panel.phases.map((phase) => phase.actions.map((action) => action.id)), [['audit'], ['report']]);
  assert.equal(panel.selectedAgent.action.id, 'report');

  const progress = planProgress(row, {
    assignments: [{ runId: row.runId, actionId: 'report', expectedMinutes: 10, startedAt: '2026-09-20T11:58:00.000Z' }],
    nowMs: NOW,
  });
  assert.deepEqual({ phase: progress.phase, phases: progress.phases, done: progress.done, remaining: progress.remaining }, { phase: 2, phases: 2, done: 1, remaining: 1 });
  assert.match(progress.eta, /^\d{2}:\d{2}$/);

  const strip = planStripParts(row, { runId: row.runId });
  assert.deepEqual(strip.filter((part) => part.action).map((part) => part.action.actionId), ['audit', 'report']);
  assert.equal(planLevels(row).length, 2);
  assert.equal(stepTally(row).includes('1'), true);
});

test('Run model keeps economics nullable and shapes stage/detail helpers without overflow', () => {
  const row = fixture();
  const economics = runEconomics(row, [{ name: 'codex', spend: { pacing: { ratePerMinute: 0.5, window: 'weekly' } }, usedPct: 12 }], NOW);
  assert.equal(economics.apiEquivalentUsd, 0.25);
  assert.equal(economics.pools[0].name, 'codex');
  assert.equal(economics.pools[0].sharePct, 1);
  assert.equal(runEconomics({ state: { attempts: [{ pool: 'unknown', startedAt: '2026-09-20T11:00:00.000Z' }] } }).apiEquivalentUsd, null);

  const stages = planStages(row).stages;
  assert.equal(planStageLabel(stages[0], 0), 'Phase 1 · audit');
  assert.match(planStageHeader(stages[0], 0), /Phase 1 · audit · 1\/1/);
  assert.deepEqual(planStageActions({ actions: [{ ...stages[0].actions[0] }, { ...stages[0].actions[0], id: 'audit-copy', status: 'pending' }] }, 1).omitted, 1);
  assert.equal(phaseActionGlyph(row.state.actions[1]).includes('▶'), true);
  assert.ok(planAttemptDetail(row.state.attempts[0], 80).length <= 80);
  assert.ok(fittedParts([{ text: 'abcdef' }], 3)[0].text.length <= 3);
  assert.match(planMoreParts(2, 20)[0].text, /\+2 more/);
});

test('Run model unions overlapping attempt clocks and keeps phase boxes phase-only', () => {
  const row = {
    state: {
      attempts: [
        { id: 'a1', actionId: 'a', status: 'succeeded', startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:10:00.000Z' },
        { id: 'b1', actionId: 'b', status: 'succeeded', startedAt: '2026-09-20T00:05:00.000Z', finishedAt: '2026-09-20T00:07:00.000Z' },
        { id: 'c1', actionId: 'c', status: 'succeeded', startedAt: '2026-09-20T01:00:00.000Z', finishedAt: '2026-09-20T01:04:00.000Z' },
      ],
    },
  };
  const duration = runDurationFacts(row, { nowMs: NOW });
  assert.equal(duration.activeMinutes, 14);
  assert.equal(duration.spanMinutes, 64);
  assert.equal(attemptDurationText(row.state.attempts[1], { nowMs: NOW }), '2m00s');
  assert.equal(durationClockText(14), '14m00s');
  // Both records share one clock: h/m/s, so a step past an hour reads
  // `2h04m`, the way the run header and the Step page read it.
  assert.equal(durationClockText(124.156), '2h04m');
  const live = runDurationFacts({ state: { attempts: [{ actionId: 'live', status: 'running', startedAt: '2026-09-20T11:50:00.000Z', finishedAt: null }] } }, { nowMs: NOW });
  assert.equal(live.activeMinutes, 10);
  assert.equal(live.spanMinutes, null);
  assert.equal(runDurationFacts({ state: { attempts: [
    { actionId: 'good', status: 'succeeded', startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:01:00.000Z' },
    { actionId: 'unknown', status: 'succeeded', startedAt: '2026-09-20T00:02:00.000Z' },
  ] } }, { nowMs: NOW }).activeMinutes, null);

  const stage = { id: 'phase-a', label: 'Phase 1 · audit', actionIds: ['a'], actions: [{ id: 'a', status: 'succeeded' }] };
  assert.equal(phaseDurationFacts(row, stage, { nowMs: NOW }).activeMinutes, 10);
  assert.equal(planStageName(stage, 0), 'audit');
  assert.equal(planStageName({ label: 'Phase 2 · home · active-minutes · run-page · step-page · docs', actions: [
    { id: 'home' }, { id: 'active-minutes' }, { id: 'run-page' }, { id: 'step-page' }, { id: 'docs' },
  ] }, 1), 'five writers');
  // Rule 2 of the run-v2 record: one step keeps its authored name, and any
  // level of more than one step is the writer group it is — a two-step level
  // says `two writers`, not the step names it used to join. The words run to
  // twelve and the count is printed as digits above that.
  const writers = (count) => planStageName({ label: 'Phase 7 · tidy-fixes', actions: Array.from({ length: count }, (_, index) => ({ id: `step-${index}` })) }, 6);
  assert.equal(writers(2), 'two writers');
  assert.equal(writers(3), 'three writers');
  assert.equal(writers(12), 'twelve writers');
  assert.equal(writers(13), '13 writers');
  assert.equal(planStageName({ label: 'Phase 3 · task-page', actions: [{ id: 'task-page' }] }, 2), 'task-page');
  const box = planStageBoxParts(stage, 0, { runId: 'wf-box' });
  assert.match(box[0].text, /^\[✓ 1 audit\]$/);
  assert.equal(box[0].action.actionId, 'a');
  assert.equal(planStageBoxText(stage, 0).includes('1 audit'), true);
});

test('plan boxes print done/total only where the count says something', () => {
  // The record's own examples: a finished single step and a pending phase keep
  // the glyph alone; a multi-step phase and a running phase carry the count.
  const box = (total, completed) => planStageBoxParts({
    label: 'Phase 12 · step-v2',
    actionIds: Array.from({ length: total }, (_, index) => `step-${index}`),
    actions: Array.from({ length: total }, (_, index) => ({ id: `step-${index}`, status: index < completed ? 'succeeded' : 'pending' })),
  }, 11)[0].text;
  assert.equal(box(1, 0), '[○ 12 step-v2]', 'a pending single step says 0/1 twice');
  assert.equal(box(1, 1), '[✓ 12 step-v2]', 'a finished single step says 1/1 twice');
  assert.equal(box(5, 5), '[✓ 12 five writers 5/5]');
  assert.equal(box(3, 0), '[○ 12 three writers]', 'a phase that has not started shows no count');
  assert.equal(box(5, 3), '[○ 12 five writers 3/5]', 'a started multi-step phase keeps its count');
  const running = planStageBoxParts({
    label: 'Phase 12 · step-v2', actionIds: ['step-v2'], actions: [{ id: 'step-v2', status: 'running' }],
  }, 11)[0].text;
  assert.equal(running, '[▶ 12 step-v2 0/1]');
  // The box number is the plan's own chain; a trailing period would read as
  // prose and is gone.
  assert.doesNotMatch(running, /\d+\./);
});

test('Run model names each attempt\'s routing on one line, a dash where nothing was recorded', () => {
  assert.equal(
    attemptRoutingText({ pool: 'command-code', model: 'deepseek-v4.1-flash', effort: 'medium' }),
    'command-code · deepseek-v4.1-flash · medium',
  );
  // A routing record the connector never wrote keeps its slot as a dash; the
  // effort may live under routing.effort when the attempt has no top field.
  assert.equal(attemptRoutingText({ pool: 'codex', model: 'gpt-test', routing: { effort: 'high' } }), 'codex · gpt-test · high');
  assert.equal(attemptRoutingText({ pool: 'codex', model: 'gpt-test' }), 'codex · gpt-test · —');
  assert.equal(attemptRoutingText({}), '— · — · —');
  assert.equal(attemptRoutingText(null), '— · — · —');
});

test('Run v2 header and spend facts keep active/span and partial coverage honest', () => {
  const row = fixture();
  row.project = 'bullswarm';
  row.state.intent.cwd = '/repo';
  row.state.attempts.push(
    {
      id: 'audit-1', actionId: 'audit', ordinal: 1, status: 'succeeded', pool: 'codex', model: 'gpt-test',
      startedAt: '2026-09-20T11:56:00.000Z', finishedAt: '2026-09-20T11:57:00.000Z',
      usage: { api: { usd: 1.25 }, tokenSource: 'provider-reported', subscription: { usd: 0.5 } },
    },
    {
      id: 'other-1', actionId: 'report', ordinal: 2, status: 'failed', pool: 'claude-code', model: 'claude-test',
      startedAt: '2026-09-20T11:59:00.000Z', finishedAt: '2026-09-20T12:00:00.000Z',
      usage: { api: { usd: 0.75 }, tokenSource: 'estimated:utf8-bytes/4' },
    },
  );
  const facts = runHeaderFacts(row, { nowMs: NOW });
  assert.equal(facts.done, 1);
  assert.equal(facts.total, 2);
  assert.deepEqual(facts.running, ['report']);
  assert.deepEqual(facts.waiting, []);
  assert.equal(facts.project, 'bullswarm');
  assert.equal(facts.cwd, '/repo');
  assert.equal(facts.attempts, 3);
  assert.equal(facts.spanMinutes, 4);
  assert.equal(runClockText(362.45), '6h02m');
  assert.equal(runClockText(7.5), '7m30s');

  const spend = runSpendFacts(row);
  assert.equal(spend.attempts, 3);
  assert.equal(spend.apiKnownSubtotalUsd, 2.25);
  assert.equal(spend.measured, 1);
  assert.equal(spend.estimated, 1);
  assert.equal(spend.running, 1);
  assert.equal(spend.unmeasured, 0, 'running attempts have their own coverage class');
  assert.match(spend.coverageText, /^1 of 3 attempts measured$/);
  assert.match(spend.suffix, /1 estimated/);
  assert.match(spend.suffix, /1 running/);
  assert.doesNotMatch(spend.suffix, /unmeasured/);
  assert.deepEqual(spend.pools.map((entry) => entry.pool), ['codex', 'claude-code']);
  assert.equal(spend.plansKnownSubtotalUsd, 0.5);
  assert.equal(spend.planMeter, 1);
  assert.equal(spend.planUnmetered, 2);
});

test('Run v2 timeline facts are phase and attempt projections, not filler milestones', () => {
  const row = fixture();
  const facts = runTimelineFacts(row, { nowMs: NOW });
  assert.equal(facts.phases.length, 2);
  assert.equal(facts.attempts.length, 1);
  assert.equal(facts.attempts[0].actionId, 'report');
  assert.equal(facts.phases[1].endAt, null);
  assert.equal(facts.phases[1].done, 0);
  assert.equal(facts.phases[1].total, 1);
});
