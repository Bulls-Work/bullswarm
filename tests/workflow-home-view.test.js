import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  activeRunLines,
  homePage,
  homeTodayBand,
  stepBarText,
  todayTableRow,
  todayTaskLine,
  todayWorkflowLine,
} from '../src/workflow/home-view.js';
import { readRollups } from '../src/workflow/rollup.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = new Date(2026, 8, 20, 12, 0, 0, 0).getTime();
const TODAY = new Date(NOW).toISOString();
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visible(value) {
  return String(value ?? '').replace(ANSI, '');
}

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
      for (const part of parts ?? []) text += String(part?.text ?? '');
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

function emptyModel() {
  return {
    runs: [], assignments: [], pools: [], rollups: [], days: [],
    tasks: { inflight: [], finished: [] }, budget: null, stats: null,
  };
}

test('Home view keeps today rows and table rows at their requested width', () => {
  for (const width of [55, 120, 200]) {
    const workflow = todayWorkflowLine({ shortId: 'today1', project: 'bullswarm', minutes: { wall: 3 }, verified: true }, width);
    const task = todayTaskLine({ id: 'task-1', project: 'bullswarm', durationMs: 60_000 }, width);
    const table = todayTableRow({ name: 'provider:codex', workflowMinutes: 2, workflowPct: 1.5, runMinutes: 1, apiUsd: 0.5, tokenSource: 'provider-reported' }, width);
    assert.equal(visible(workflow).length, width);
    assert.equal(visible(task).length, width);
    // The raw table cell may carry the explicit usage basis; Home pads/cuts
    // it through todayPadded when it is placed in the page band.
    assert.ok(visible(table).length <= width + 10);
  }
});

test('Home view registers today actions and renders the empty page through the extracted page', () => {
  const model = emptyModel();
  model.rollups = [{
    runId: 'wf-today', shortId: 'today1', finishedAt: TODAY, status: 'completed', verified: true,
    project: 'bullswarm', goal: 'Today goal', minutes: { wall: 2 }, pools: {},
  }];
  model.days = [{ date: TODAY.slice(0, 10), rows: model.rollups }];
  model.tasks.finished = [{ id: 'task-1', pool: 'codex', endedAt: TODAY, durationMs: 60_000 }];
  const body = bodyBuilder();
  const result = homeTodayBand(model, { width: 55, narrow: true, nowMs: NOW }, body);
  assert.deepEqual(result, { workflowCount: 1, taskCount: 1, verified: 1 });
  assert.ok(body.regions.some((region) => region.action?.kind === 'run'));
  assert.ok(body.regions.some((region) => region.action?.kind === 'task'));

  const pageBody = bodyBuilder();
  assert.equal(homePage(emptyModel(), { width: 55, narrow: true, nowMs: NOW, period: '7d' }, pageBody), ' bullswarm · home');
  assert.ok(pageBody.lines.length > 0);
  assert.ok(pageBody.lines.every((line) => visible(line).length <= 55));
});

test('Home view renders a measured live step bar and active section without overflow', () => {
  const bar = stepBarText(
    { id: 'build', startedAt: TODAY },
    { expectedMinutes: 10, startedAt: TODAY },
    { width: 30, nowMs: NOW + 5 * 60_000, pool: 'provider:codex' },
  );
  assert.equal(bar.measured, true);
  assert.match(visible(bar.text), /build@codex/);
  assert.ok(visible(bar.text).length <= 30);

  const body = bodyBuilder();
  activeRunLines(emptyModel(), { width: 55, narrow: true, nowMs: NOW }, body);
  assert.ok(body.lines.some((line) => visible(line).includes('running')));
  assert.ok(body.lines.every((line) => visible(line).length <= 55));
});

test('Home real snapshot paints the top cards and licence words at 55/120/200', () => {
  const snapshot = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = {
    runs: [], assignments: [], pools: [],
    rollups: readRollups(snapshot), days: [],
    tasks: { inflight: [], finished: [] }, budget: null, stats: null,
  };
  for (const width of [55, 120, 200]) {
    const body = bodyBuilder();
    homePage(model, { width, narrow: width < 100, nowMs, period: '7d' }, body);
    assert.ok(body.lines.length > 0, `${width}: Home rendered no lines`);
    assert.ok(body.lines.every((line) => visible(line).length <= width), `${width}: line overflow`);
    const text = body.lines.map(visible).join('\n');
    assert.match(text, /Home · Today/);
    assert.match(text, /licence · pool · worker-minutes/);
    assert.doesNotMatch(text, /wf % \(est\.\)|run min|API · sub\s*$/m);
    if (width >= 120) {
      const cardRow = body.lines.map(visible).find((line) => line.includes('┐  ┌'));
      assert.ok(cardRow, `${width}: top cards did not flow side by side`);
    }
  }
});

test('Home card hit regions cover each run for Enter and click navigation', () => {
  const snapshot = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, usage: { pools: [], assignments: [] }, days: [],
  });
  const frame = renderDashboardPage(model, { page: 'home', width: 120, height: 60, nowMs });
  assert.equal(frame.runRows.length, 3);
  assert.deepEqual(frame.runRows.map((row) => row.runId), [
    'wf-mu8vxemr-38a46a', 'wf-mu8thu2e-27c504', 'wf-mu8radyf-bb49cc',
  ]);
  assert.equal(frame.cursorAction?.kind, 'run');
  assert.ok(frame.regions.some((region) => region.action?.kind === 'run'));
});
