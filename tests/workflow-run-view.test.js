import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionNamedIn,
  flatTimelineLines,
  markStepRows,
  planDagLines,
  renderWorkflowOverviewPanel,
  runFrame,
  runPage,
  workflowTimelineLines,
} from '../src/workflow/run-view.js';
import { workflowPanelModel } from '../src/workflow/run-model.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(ANSI, '');

function rowFixture() {
  const goal = createV2GoalDocument({
    goal: 'Audit and report the repository', cwd: '/tmp/repository',
    requirements: [{ id: 'report', text: 'A report exists.', mandatory: true }],
    settings: { scout: false, executionMode: 'program' },
  });
  let state = createV2State(goal, { runId: 'wf-view', shortId: 'view01' });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Audit then report.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'audit', purpose: 'Audit files', dependsOn: [], affects: ['report'], ownedFiles: ['audit.md'], prompt: 'Audit files.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['audit'] },
      { id: 'report', purpose: 'Write report', dependsOn: ['audit'], affects: [], ownedFiles: [], prompt: 'Write report.', lane: 'analyze', effort: 'low', evidenceFor: ['report'], inputs: ['audit'], produces: [] },
    ] },
  });
  state.lifecycle = { status: 'running', startedAt: '2026-09-20T11:55:00.000Z', finishedAt: null, resultFile: null };
  state.actions[0].status = 'succeeded';
  state.actions[1].status = 'running';
  state.actions[1].startedAt = '2026-09-20T11:58:00.000Z';
  state.attempts.push({ id: 'report-1', actionId: 'report', ordinal: 1, status: 'running', pool: 'codex', model: 'gpt-test', startedAt: '2026-09-20T11:58:00.000Z', lastActivityAt: '2026-09-20T11:59:00.000Z' });
  return { runId: state.runId, shortId: state.shortId, status: 'running', state, events: [], assignments: [], pools: [], liveness: { alive: true } };
}

function bodyBuilder() {
  const body = {
    lines: [], regions: [],
    push(text = '') { body.lines.push(text); return body; },
    row(text = '', action = null) {
      body.lines.push(text);
      if (action) body.regions.push({ x1: 1, x2: Math.max(1, visible(text).length), y: body.lines.length, action });
      return body;
    },
    parts(parts) {
      let text = '';
      for (const part of parts ?? []) text += String(part?.text ?? '');
      body.lines.push(text);
      return body;
    },
  };
  return body;
}

test('Run view keeps timeline, overview and plan rows within the requested width', () => {
  const row = rowFixture();
  const panel = workflowPanelModel(row);
  for (const width of [55, 120, 200]) {
    const frame = runFrame(row, { width, height: 30, bodyHeight: 20, spinnerFrame: 0 });
    assert.ok(frame.body.length > 0);
    assert.ok(frame.body.every((line) => visible(line).length <= width), `${width}: ${frame.body.join('\n')}`);
    const overview = renderWorkflowOverviewPanel(panel, width, 18, 0);
    assert.ok(overview.every((line) => visible(line).length <= width));
    const plan = planDagLines(row, { width, nowMs: NOW });
    assert.ok(plan.length > 0);
    assert.ok(plan.every((line) => visible(line.parts.map((part) => part.text).join('')).length <= width));
  }
});

test('Run view preserves timeline segments and step hit regions through the extracted page', () => {
  const row = rowFixture();
  const panel = workflowPanelModel(row);
  const timeline = workflowTimelineLines(panel, 100, 0, { goalPreview: false });
  assert.ok(timeline.lines.some((line) => line.header && line.segment));
  assert.ok(flatTimelineLines(panel, { width: 55, rows: 8 }).length <= 8);
  assert.equal(actionNamedIn('  ✓ report completed', row.state.actions).id, 'report');

  const body = bodyBuilder();
  const header = runPage({ row, assignments: [], pools: [] }, { width: 55, bodyHeight: 22, narrow: true, nowMs: NOW, spinnerFrame: 0, focus: 0 }, body);
  assert.match(header, /^ view01 running/);
  assert.ok(body.lines.some((line) => visible(line).includes('timeline')));
  markStepRows(body, body.lines, panel, row.runId);
  assert.ok(body.regions.some((region) => region.action?.kind === 'step'));
});

test('Run view paints phase-only boxes and attempt routing metadata', () => {
  const row = rowFixture();
  row.state.attempts[0].status = 'succeeded';
  row.state.attempts[0].finishedAt = '2026-09-20T11:59:30.000Z';
  row.state.attempts[0].effort = 'high';
  row.state.attempts[0].routing = { effort: 'high' };
  for (const width of [55, 120, 200]) {
    const lines = planDagLines(row, { width, nowMs: NOW }).map((line) => line.parts.map((part) => part.text).join(''));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visible(line).length <= width));
    assert.ok(lines.every((line) => !line.includes('codex') && !line.includes('gpt-test')));
  }
  const firstBox = planDagLines(row, { width: 55 })[0].parts.find((part) => part.action);
  assert.equal(firstBox.action.actionId, 'audit');
  const timeline = workflowTimelineLines(workflowPanelModel(row), 120, 0, { goalPreview: false, nowMs: NOW });
  const text = timeline.lines.map((line) => line.text ?? line).join('\n');
  assert.match(text, /codex · gpt-test · high · 1m30s/);
  assert.match(text, /phase active/);
});
