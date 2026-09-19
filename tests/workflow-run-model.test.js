import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fittedParts,
  phaseActionGlyph,
  planAttemptDetail,
  planLevels,
  planMoreParts,
  planProgress,
  planStageActions,
  planStageHeader,
  planStageLabel,
  planStages,
  planStripParts,
  runEconomics,
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
