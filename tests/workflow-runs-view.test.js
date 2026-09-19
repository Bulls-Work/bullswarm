import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardRunLines,
  daysWithTasks,
  filterDashboardRows,
  humanPhaseName,
  humanWorkflowStatus,
  isWaitingWorkflow,
  listWindow,
  runsPage,
  workflowConcernCount,
} from '../src/workflow/runs-view.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(ANSI, '');

function bodyBuilder() {
  const body = {
    lines: [],
    regions: [],
    push(text = '') { body.lines.push(text); return body; },
    row(text = '', action = null) {
      body.lines.push(text);
      if (action) body.regions.push({ x1: 1, x2: Math.max(1, visible(text).length), y: body.lines.length, action });
      return body;
    },
    parts(parts) {
      let text = '';
      for (const part of parts ?? []) {
        text += String(part?.text ?? '');
        if (part?.action) body.regions.push({ x1: 1, x2: Math.max(1, visible(text).length), y: body.lines.length + 1, action: part.action });
      }
      body.lines.push(text);
      return body;
    },
    kit({ text = '', regions = [] } = {}) {
      body.lines.push(text);
      for (const region of regions) body.regions.push({ ...region, y: body.lines.length });
      return body;
    },
  };
  return body;
}

function row({ status = 'running', ongoing = status === 'running', goal = 'audit the repository', runId = 'wf-runs', shortId = 'runs01', concerns = [] } = {}) {
  return {
    runId, shortId, ongoing,
    state: {
      intent: { goal },
      lifecycle: { status, startedAt: '2026-09-20T11:00:00.000Z', finishedAt: ongoing ? null : '2026-09-20T11:30:00.000Z' },
      outcome: { concerns },
      actions: [], attempts: [],
    },
    status,
    phase: 'Implement: review',
    stepsOk: 0,
    stepsTotal: 0,
  };
}

test('Runs filtering keeps active rows and searches durable and projected fields', () => {
  const live = row({ goal: 'Deploy the dashboard' });
  const done = row({ status: 'completed', ongoing: false, runId: 'wf-docs', shortId: 'docs01', goal: 'Refresh docs' });
  assert.deepEqual(filterDashboardRows([live, done], 'active', ''), [live]);
  assert.deepEqual(filterDashboardRows([live, done], 'all', 'DOCS'), [done]);
  assert.deepEqual(filterDashboardRows([live, done], 'all', 'deploy'), [live]);
  assert.equal(isWaitingWorkflow({ lifecycle: { status: 'waiting_for_caller' } }), true);
  assert.equal(isWaitingWorkflow({ lifecycle: { status: 'completed' } }), false);
});

test('Runs list helpers preserve status, phase, concern and width behavior', () => {
  const live = row({ concerns: [{ id: 'risk' }] });
  const lines = dashboardRunLines([live], 0, true, 55)[0].lines;
  assert.match(visible(lines[0]), /runs01 · audit the repository/);
  assert.match(visible(lines[2]), /Implement ›\s+review/);
  assert.equal(workflowConcernCount(live), 1);
  assert.equal(humanWorkflowStatus('completed', false), 'finished');
  assert.equal(humanWorkflowStatus('waiting_for_caller', false), 'waiting for caller');
  assert.equal(humanPhaseName('Plan:run-workers'), 'Plan › run workers');
  assert.ok(lines.every((line) => visible(line).length <= 55));
  assert.deepEqual(listWindow([{ lines: ['one', 'two'] }, { lines: ['three', 'four'] }], 1, 3, true), ['three', 'four']);
});

test('Runs history merge adds each finished task once and renders its page regions', () => {
  const task = {
    kind: 'task', id: 'task-1', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
    project: 'bullswarm', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:02:00.000Z',
    durationMs: 120_000, ok: true,
  };
  const days = [{ date: '2026-09-20', runs: 0, finished: 0, rows: [{ ...task }] }];
  const merged = daysWithTasks(days, [task, { ...task }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].rows.filter((entry) => entry.kind === 'task').length, 1);

  for (const width of [55, 120, 200]) {
    const body = bodyBuilder();
    const header = runsPage({
      runs: [], assignments: [], pools: [], rollups: [], days: [],
      tasks: { inflight: [], finished: [task] },
    }, { width, narrow: width < 100, nowMs: NOW, allRows: [], filter: 'active' }, body);
    assert.match(header, /bullswarm · runs · active/);
    assert.match(body.lines.join('\n'), /task-1/);
    assert.equal(body.regions.filter((region) => region.action?.kind === 'task').length, 1);
    assert.ok(body.lines.every((line) => visible(line).length <= width), `${width}: ${body.lines.join('\n')}`);
  }
});
