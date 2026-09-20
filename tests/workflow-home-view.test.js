import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  activeRunLines,
  homeDetails,
  homePage,
  homeTodayBand,
  medianRunText,
  recentDurationText,
  stepBarText,
  todayTableRow,
  todayTaskLine,
  todayWorkflowLine,
} from '../src/workflow/home-view.js';
import { readRollups } from '../src/workflow/rollup.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;
// A top-run card reads a run's state from under BULLSWARM_HOME, so the file
// points the model at the supplied read-only snapshot: rendering a real card
// never probes the live home.
process.env.BULLSWARM_HOME = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';

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

test('Home real snapshot paints the top cards beside the licence words at 55/120/200', () => {
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
    assert.match(text, /weekly share · API · subscription/);
    assert.doesNotMatch(text, /wf % \(est\.\)|run min|API · sub\s*$/m);
    // The today band only: everything between its header and the running block.
    const lines = body.lines.map(visible);
    const start = lines.findIndex((line) => line.startsWith('Home · Today'));
    const end = lines.findIndex((line, index) => index > start && line.startsWith('── running'));
    assert.ok(start >= 0 && end > start, `${width}: today band missing`);
    const band = lines.slice(start, end).filter((line) => line.trim());
    const cardTops = band.map((line, index) => (line.includes('┌─ ') ? index : -1)).filter((index) => index >= 0);
    assert.equal((band.join('\n').match(/┌─ /g) ?? []).length, 3, `${width}: three cards\n${band.join('\n')}`);
    const cardBottom = band.reduce((last, line, index) => (line.includes('┘') ? index : last), 0);
    const licenceAt = band.findIndex((line) => line.includes('licence · pool · worker-minutes'));
    assert.ok(licenceAt >= 0, `${width}: the licence header is missing`);
    if (width >= 120) {
      // Owner note (a): the three cards and the licence block share their rows,
      // and a licence row is painted on the same row as a card's own border.
      assert.ok(licenceAt >= cardTops[0] && licenceAt <= cardBottom,
        `${width}: the licence header is not on the cards' rows\n${band.join('\n')}`);
      assert.ok(band.some((line) => /[┌└│]/.test(line) && line.includes('claude-code · 171.30')),
        `${width}: no licence row shares a row with a card\n${band.join('\n')}`);
    } else {
      assert.ok(licenceAt > cardBottom, `${width}: the phone did not stack the licence block below the cards`);
    }
    if (width >= 200) {
      const cardRow = band.find((line) => line.includes('┐  ┌'));
      assert.ok(cardRow, `${width}: the top cards did not flow side by side`);
    }
  }
});

test('Home restores the period band and the recent list below the budget block', () => {
  const snapshot = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, usage: { pools: [], assignments: [] }, days: [], period: '7d',
  });
  for (const width of [55, 120, 200]) {
    const frame = renderDashboardPage(model, { page: 'home', width, height: 400, nowMs, period: '7d' });
    const lines = frame.lines.map(visible);
    assert.ok(lines.every((line) => line.length <= width), `${width}: line overflow`);
    const budget = lines.findIndex((line) => line.includes('── budget · this week'));
    const band = lines.findIndex((line) => line.includes('── last 7 days'));
    const recent = lines.findIndex((line) => line.includes('── recent'));
    assert.ok(budget >= 0 && band > budget, `${width}: the period band is not below the budget block`);
    assert.ok(recent > band, `${width}: the recent list is not below the period band`);
    const head = lines.findIndex((line) => line.includes('spent per day'));
    assert.ok(head > band && head < recent, `${width}: no spent-per-day chart in the band`);
    if (width >= 120) {
      assert.match(lines[head], /spent per day.*by pool.*by model.*by project/,
        `${width}: the four breakdown columns did not share a row`);
    } else {
      assert.doesNotMatch(lines[head], /by pool/, `${width}: the phone kept four columns on one row`);
      for (const heading of ['by pool', 'by model', 'by project']) {
        assert.ok(lines.slice(head, recent).some((line) => line.trim().startsWith(heading)),
          `${width}: the phone lost the ${heading} column`);
      }
    }
    for (const label of ['Workflows:', 'Favourite pool:', 'Favourite model:', 'Spent:', 'Median run:', 'Busiest project:']) {
      assert.ok(lines.slice(band, recent).some((line) => line.includes(label)), `${width}: the summary lost ${label}`);
    }
    const toggleRow = lines.findIndex((line, index) => index >= band && line.includes('Last 7 days') && line.includes('All time'));
    assert.ok(toggleRow >= band, `${width}: the period toggle is missing`);
    assert.ok(lines[toggleRow].includes('── last 7 days') || lines[toggleRow - 1].includes('── last 7 days'),
      `${width}: the band does not name the active period`);
    assert.deepEqual(
      frame.regions
        .filter((region) => region.y === toggleRow + 1 && region.action?.kind === 'period')
        .map((region) => region.action.period),
      ['7d', '30d', 'all'],
      `${width}: the toggle lost a period`,
    );
    const recentRows = lines.slice(recent + 1).filter((line) => /ago\s*$/.test(line.trimEnd()));
    assert.equal(recentRows.length, width >= 100 ? 5 : 3, `${width}: the recent list has ${recentRows.length} rows`);
  }
});

test('the period selector redraws the band for Last 30 days and All time', () => {
  const snapshot = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const rollups = readRollups(snapshot);
  for (const [period, label] of [['30d', 'last 30 days'], ['all', 'all time']]) {
    const model = dashboardModel(null, {
      rollups, nowMs, usage: { pools: [], assignments: [] }, days: [], period,
    });
    const frame = renderDashboardPage(model, { page: 'home', width: 120, height: 400, nowMs, period });
    const lines = frame.lines.map(visible);
    const band = lines.findIndex((line) => line.includes(`── ${label}`));
    assert.ok(band >= 0, `${period}: the band did not name ${label}`);
    const toggleRow = lines.findIndex((line, index) => index >= band && line.includes('All time'));
    assert.ok(toggleRow >= band, `${period}: the toggle vanished`);
    assert.ok(frame.regions.some((region) => region.y === toggleRow + 1 && region.action?.period === period),
      `${period}: the toggle has no region for the active period`);
    // The band's own figures follow the period the model was built over.
    const overview = model.stats?.overview;
    assert.ok(overview, `${period}: the model carries no overview`);
    assert.match(lines.join('\n'), new RegExp(`Workflows: ${overview.keys.workflows}\\b`), `${period}: the runs count is not the period's`);
  }
});

test('Home labels the median and recent-run durations with the basis they were measured on', () => {
  const records = [
    { runId: 'wf-a', finishedAt: '2026-09-19T10:00:00.000Z', status: 'completed', minutes: { active: 10, span: 40 } },
    { runId: 'wf-b', finishedAt: '2026-09-19T11:00:00.000Z', status: 'completed', minutes: { active: 20, span: 90 } },
  ];
  const withActive = dashboardModel(null, { rollups: records, nowMs: NOW, usage: { pools: [], assignments: [] } });
  assert.equal(medianRunText(withActive), '15m');
  assert.equal(recentDurationText(records[0]), '10m');
  // No run in the period proved an active interval: the span stands in for
  // the median, labelled as the span it is.
  const spansOnly = records.map((record) => ({
    ...record, minutes: { active: null, span: record.minutes.span, wall: record.minutes.span },
  }));
  const withSpans = dashboardModel(null, { rollups: spansOnly, nowMs: NOW, usage: { pools: [], assignments: [] } });
  assert.equal(medianRunText(withSpans), 'span 1h05m');
  assert.equal(recentDurationText(spansOnly[0]), 'span 40m');
  const body = bodyBuilder();
  homeDetails(withSpans, { width: 120, narrow: false, nowMs: NOW, period: '7d' }, body);
  assert.match(body.lines.map(visible).join('\n'), /Median run: span 1h05m/);
  assert.equal(medianRunText(dashboardModel(null, { rollups: [], nowMs: NOW })), '—');
  assert.equal(recentDurationText({ minutes: {} }), '—');
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

test('Home shows a partly-priced period as the subtotal the rollups really hold', () => {
  const snapshot = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, runs: [], period: '7d',
    usage: { pools: [], assignments: [] },
  });
  const text = renderDashboardPage(model, { page: 'home', width: 200, height: 60, nowMs })
    .lines.map(visible).join('\n');

  // 83 of the period's 149 attempts carried a price. The strict total stays
  // unknown, so the page states the recorded subtotal and its coverage rather
  // than the `api unknown` this data used to print.
  assert.match(text, /Spent: ≈ \$299\.87 api · 83\/149 priced/);
  assert.match(text, /recorded ≈ \$299\.87 api of API-equivalent work/);
  assert.doesNotMatch(text, /recorded no API-equivalent estimate/);

  // All three recorded days are charted — 18 and 20 Sep are subtotals — and the
  // axis carries the `≈` that says every bar is a lower bound.
  const band = text.split('── last 7 days')[1].split('── recent')[0];
  assert.match(band, /≈\$160\.00/, band);
  assert.equal((band.match(/███/g) ?? []).length > 0, true);
  assert.equal(band.split('\n').at(-3).trim().startsWith('┼'), false);

  // A pool whose attempts were only partly priced still shows what it recorded.
  assert.match(text, /codex · 964\.50 · — · ≈\$36\.30/);
  // A run with no strict total shows its own recorded subtotal on its card.
  assert.match(text, /API ≈ \$9\.52 · subscription —/);
});
