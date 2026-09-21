import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeRunLines,
  cardLines,
  homeDetails,
  homePage,
  homeTodayBand,
  licenceRowText,
  medianRunText,
  recentDurationText,
  stepBarText,
  todayTableRow,
  todayTaskLine,
  todayWorkflowLine,
} from '../src/workflow/home-view.js';
import { todayLicenceRows, todayRows } from '../src/workflow/home-model.js';
import { readRollupIndex, readRollups } from '../src/workflow/rollup.js';
import { reopenV2RunForRetry, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';
import { runPage } from '../src/workflow/run-view.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

// The fixture's clocks were recorded in Hong Kong and the expectations quote
// them as HKT, so this file reads them there on any machine (CI runs in UTC).
process.env.TZ = 'Asia/Hong_Kong';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;
// A top-run card reads a run's state from under BULLSWARM_HOME, so the file
// points the model at the scrubbed in-repo home (scripts/build-test-home.mjs):
// rendering a real card never probes the live home.
const SNAPSHOT = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
process.env.BULLSWARM_HOME = SNAPSHOT;

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

test('Home cards use the shared h/m/s clock and only name a differing span', () => {
  const withSpan = cardLines({
    name: 'long-running task', project: 'bullswarm', status: 'completed', verdict: '—',
    minutes: { active: 355, span: 415 }, steps: { done: 18, total: 21 },
    money: { text: 'api unknown · sub unknown' },
  }, 200).map(visible).join('\n');
  assert.match(withSpan, /5h55m active of 6h55m · steps 18\/21/);
  assert.doesNotMatch(withSpan, /725\.95m|355\.00m|415\.00m/);

  const sameClock = cardLines({
    name: 'short task', project: 'bullswarm', status: 'completed', verdict: '—',
    minutes: { active: 58 + 37 / 60, span: 58 + 37 / 60 }, steps: { done: 9, total: 9 },
    money: { text: 'api unknown · sub unknown' },
  }, 200).map(visible).join('\n');
  assert.match(sameClock, /58m37s · steps 9\/9/);
  assert.doesNotMatch(sameClock, /active of|span /);
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

test('Home real snapshot flows the top cards by width with the licence words plain', () => {
  const snapshot = SNAPSHOT;
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
    if (width >= 160) {
      // Owner note (a): the three cards and the licence block share their rows,
      // and a licence row is painted on the same row as a card's own border.
      assert.ok(licenceAt >= cardTops[0] && licenceAt <= cardBottom,
        `${width}: the licence header is not on the cards' rows\n${band.join('\n')}`);
      assert.ok(band.some((line) => /[┌└│]/.test(line) && line.includes('claude-code · 171.30')),
        `${width}: no licence row shares a row with a card\n${band.join('\n')}`);
      assert.ok(band.some((line) => line.includes('┐  ┌')), `${width}: the top cards did not flow side by side`);
    } else if (width >= 120) {
      // 120–159 columns: the cards take the whole width, side by side, and the
      // licence block reads below them at the same width. Each card is about
      // (width − 4)/3 wide and a field too long for it ends in `…`.
      assert.ok(licenceAt > cardBottom, `${width}: the licence block is not below the cards`);
      assert.equal(cardTops.length, 1, `${width}: the three cards did not share a row\n${band.join('\n')}`);
      assert.equal((band[cardTops[0]].match(/┌─ /g) ?? []).length, 3, `${width}: ${band[cardTops[0]]}`);
      const firstBox = band[cardTops[0]].indexOf('┌');
      const firstClose = band[cardTops[0]].indexOf('┐');
      assert.equal(firstClose - firstBox + 1, Math.floor((width - 4) / 3), `${width}: card width\n${band[cardTops[0]]}`);
      assert.match(band.join('\n'), /…/, `${width}: a card field was clipped without an ellipsis`);
    } else {
      assert.ok(licenceAt > cardBottom, `${width}: the phone did not stack the licence block below the cards`);
      assert.equal(cardTops.length, 3, `${width}: the phone stacks one card per row\n${band.join('\n')}`);
    }
  }
});

test('Home restores the period band and the recent list below the budget block', () => {
  const snapshot = SNAPSHOT;
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
  const snapshot = SNAPSHOT;
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

/** A pool, a finished workflow on it, and the licence row the two produce. */
function shareRow(model, now = NOW) {
  return todayLicenceRows(model, todayRows(model, now), now)[0];
}

function shareModel({ pools = null } = {}) {
  const workflow = {
    runId: 'wf-today', shortId: 'today1', finishedAt: TODAY, status: 'completed',
    pools: {
      codex: {
        minutes: 60, apiKnownSubtotalUsd: 12, attempts: 4, pricedAttempts: 3,
        measuredAttempts: 2, subscriptionWindow: 'weekly', tokenSource: 'provider-reported',
      },
    },
  };
  return {
    runs: [], assignments: [], rollups: [workflow], days: [],
    tasks: { inflight: [], finished: [] }, budget: null, stats: null,
    pools: pools ?? [{ name: 'codex', usedPct: 12, spend: { pacing: { ratePerMinute: 0.02, window: 'weekly' } } }],
  };
}

test('Home window-share shows the ledger drop when one exists, the labelled pace estimate otherwise', () => {
  // A temporary home holding one calibration ledger. The ledger's sample is
  // attributed to the day's run, so the share it names is a measurement —
  // never an extrapolation from the pool's rate.
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-home-share-'));
  const previousHome = process.env.BULLSWARM_HOME;
  const ledger = join(home, 'calibration', 'codex.json');
  try {
    mkdirSync(join(home, 'calibration'), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify({
      schema: 'bullswarm.calibration.v1',
      pool: 'codex',
      window: 'weekly',
      samples: [
        { at: '2026-09-20T09:00:00.000Z', apiUsd: 6, deltaPct: 1.5, runId: 'wf-today', attemptId: 'build-1' },
        // Another run's drop is not this row's measurement, and a task with no
        // run attribution can never be one either.
        { at: '2026-09-20T09:30:00.000Z', apiUsd: 9, deltaPct: 4, runId: 'wf-elsewhere', attemptId: 'verify-1' },
        { at: '2026-09-20T10:00:00.000Z', apiUsd: 3, deltaPct: 2, attemptId: 'e4704acb-9bd3-45e0-8d7a-ff168eebd0ff' },
      ],
      usdPerPct: 2.6,
      sampleCount: 3,
      updatedAt: '2026-09-20T10:00:00.000Z',
    })}\n`);
    process.env.BULLSWARM_HOME = home;

    const measured = shareRow(shareModel());
    assert.equal(measured.shareBasis, 'measured');
    assert.equal(measured.weeklyShare, 1.5, 'only the run\'s own attributed drop counts');
    assert.equal(measured.shareSamples, 1);
    const measuredLine = licenceRowText(measured);
    assert.match(measuredLine, /^codex · 60\.00 · 1\.5% measured · at least \$12\.00 · 1 unmeasured · —$/);

    // The same pool with no ledger attributed to it: the pace estimate, named
    // as the estimate it is.
    rmSync(ledger);
    const pace = shareRow(shareModel());
    assert.equal(pace.shareBasis, 'pace');
    assert.equal(Math.round(pace.weeklyShare * 100) / 100, 1.2);
    assert.match(licenceRowText(pace), /^codex · 60\.00 · ≈1\.2% pace estimate · at least \$12\.00 · 1 unmeasured · —$/);

    // A pure-rollup render (no live pool list — the committed frames) never
    // reads a ledger it was not handed, even with a home in the environment.
    writeFileSync(ledger, `${JSON.stringify({
      schema: 'bullswarm.calibration.v1',
      pool: 'codex',
      window: 'weekly',
      samples: [{ at: '2026-09-20T09:00:00.000Z', apiUsd: 6, deltaPct: 1.5, runId: 'wf-today', attemptId: 'build-1' }],
      usdPerPct: null,
      sampleCount: 1,
      updatedAt: '2026-09-20T09:00:00.000Z',
    })}\n`);
    const noPools = shareRow(shareModel({ pools: [] }));
    assert.equal(noPools.shareBasis, null, 'a render without a meter list consults no ledger');
    assert.equal(noPools.weeklyShare, null);
    assert.match(licenceRowText(noPools), /^codex · 60\.00 · — · at least \$12\.00 · 1 unmeasured · —$/);

    // A pool whose rate was never measured, with no ledger either, keeps the
    // dash: no third basis, and never a guessed number beside the unknown.
    rmSync(ledger);
    const unrated = shareRow(shareModel({
      pools: [{ name: 'codex', usedPct: 12, spend: { pacing: { ratePerMinute: null, window: 'weekly' } } }],
    }));
    assert.equal(unrated.shareBasis, null);
    assert.equal(unrated.weeklyShare, null);
    assert.match(licenceRowText(unrated), /^codex · 60\.00 · — · at least \$12\.00 · 1 unmeasured · —$/);

    // A monthly ledger is not the weekly column's measurement: refused, so the
    // row falls back to its own window's pace estimate rather than relabelling
    // another window's drop as weekly.
    writeFileSync(ledger, `${JSON.stringify({
      schema: 'bullswarm.calibration.v1',
      pool: 'codex',
      window: 'monthly',
      samples: [{ at: '2026-09-20T09:00:00.000Z', apiUsd: 6, deltaPct: 9, runId: 'wf-today', attemptId: 'build-1' }],
      usdPerPct: null,
      sampleCount: 1,
      updatedAt: '2026-09-20T09:00:00.000Z',
    })}\n`);
    const wrongWindow = shareRow(shareModel());
    assert.equal(wrongWindow.shareBasis, 'pace');
    assert.notEqual(wrongWindow.weeklyShare, 9);
  } finally {
    if (previousHome === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('Home card hit regions cover each run for Enter and click navigation', () => {
  const snapshot = SNAPSHOT;
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
  const snapshot = SNAPSHOT;
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, runs: [], period: '7d',
    usage: { pools: [], assignments: [] },
  });
  const text = renderDashboardPage(model, { page: 'home', width: 200, height: 60, nowMs })
    .lines.map(visible).join('\n');

  // 83 of the period's 149 attempts carried a price. The strict total stays
  // unknown, so the page states the recorded subtotal as the lower bound it
  // is, in the Run spend block's own words, rather than the `api unknown`
  // this data used to print.
  assert.match(text, /Spent: at least \$299\.87 api · 66 unmeasured/);
  assert.match(text, /recorded at least \$299\.87 api · 66 unmeasured of API-equivalent work/);
  assert.doesNotMatch(text, /recorded no API-equivalent estimate/);

  // All three recorded days are charted — 18 and 20 Sep are subtotals — and the
  // axis says `at least`, so every bar is read as a lower bound.
  const band = text.split('── last 7 days')[1].split('── recent')[0];
  assert.match(band, /at least \$160\.00/, band);
  assert.equal((band.match(/███/g) ?? []).length > 0, true);
  assert.equal(band.split('\n').at(-3).trim().startsWith('┼'), false);

  // A pool whose attempts were only partly priced shows the lower bound and
  // the count of attempts that produced it.
  assert.match(text, /codex · 964\.50 · — · at least \$36\.30 · 25 unmeasured/);
  // A run with no strict total shows its own recorded lower bound on its card.
  assert.match(text, /API at least \$9\.52 · 6 unmeasured/);
});

const rgbEscape = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
};

test('Home recent lists finished runs only: a reopened or live run sits in running, whatever its failed steps', () => {
  const finished = (shortId, extra) => ({
    runId: `wf-${shortId}`, shortId, project: 'bullswarm', goal: `${shortId} goal`,
    startedAt: '2026-09-20T08:00:00.000Z', finishedAt: '2026-09-20T09:00:00.000Z',
    minutes: { active: 10 }, pools: {}, ...extra,
  });
  const model = emptyModel();
  model.rollups = [
    // A plan revision reopened this run after a step failed: its index row says
    // running yet still carries the finish of its earlier life, and it is the
    // newest by that finish.
    finished('reopn1', { status: 'running', verified: false, finishedAt: '2026-09-20T11:30:00.000Z' }),
    finished('livrun', { status: 'running', finishedAt: null }),
    finished('nover1', { status: 'completed', verified: false, finishedAt: '2026-09-20T10:00:00.000Z' }),
    finished('verif1', { status: 'completed', verified: true, finishedAt: '2026-09-20T09:50:00.000Z' }),
    finished('faild1', { status: 'failed', verified: false, finishedAt: '2026-09-20T09:40:00.000Z' }),
    finished('partl1', { status: 'partial', verified: false, finishedAt: '2026-09-20T09:30:00.000Z' }),
  ];
  model.runs = [{
    runId: 'wf-reopn1', shortId: 'reopn1', status: 'running',
    state: { lifecycle: { status: 'running', startedAt: '2026-09-20T08:00:00.000Z' }, intent: { goal: 'reopn1 goal' }, actions: [], attempts: [] },
  }];
  const body = bodyBuilder();
  homePage(model, { width: 200, narrow: false, nowMs: NOW, period: '7d' }, body);
  const raw = body.lines;
  const lines = raw.map(visible);
  const running = lines.findIndex((line) => line.includes('── running'));
  const recent = lines.findIndex((line) => line.includes('── recent'));
  assert.ok(running >= 0 && recent > running, 'the running block sits above the recent list');
  const inRunning = lines.slice(running, recent).join('\n');
  const inRecent = lines.slice(recent + 1).filter((line) => /ago\s*$/.test(line.trimEnd()));
  assert.match(inRunning, /reopn1/, 'the reopened run is in the running block');
  assert.ok(inRecent.every((line) => !/reopn1|livrun/.test(line)), `a live or reopened run is in recent: ${inRecent.join('\n')}`);
  assert.deepEqual(inRecent.map((line) => line.match(/(nover1|verif1|faild1|partl1)/)?.[1]), ['nover1', 'verif1', 'faild1', 'partl1'],
    'the finished runs follow, newest finish first');

  // Each mark is the one the Run page header gives that status, so a
  // completed-not-verified run is a green tick here as it is there.
  const recentRaw = raw.slice(recent + 1);
  const rowFor = (id) => recentRaw.find((line) => visible(line).includes(id));
  const glyphOf = (line) => visible(line).trim()[0];
  const cases = [['nover1', 'completed', METER_COLORS.green], ['verif1', 'completed', METER_COLORS.green],
    ['faild1', 'failed', METER_COLORS.red], ['partl1', 'partial', METER_COLORS.red]];
  for (const [id, status, color] of cases) {
    const state = createV2State(createV2GoalDocument({
      goal: 'g', cwd: '/tmp/repository', requirements: [{ id: 'report', text: 'A report exists.', mandatory: true }],
      settings: { scout: false, executionMode: 'program' },
    }), { runId: `wf-${status}`, shortId: 'mark01' });
    state.lifecycle = { status, startedAt: '2026-09-20T08:00:00.000Z', finishedAt: '2026-09-20T09:00:00.000Z', resultFile: null };
    const page = runPage({ row: { runId: state.runId, shortId: state.shortId, status, state, events: [], assignments: [], pools: [] },
      assignments: [], pools: [] }, {
      width: 120, bodyHeight: 20, narrow: false, nowMs: NOW, spinnerFrame: 0, focus: 0,
    }, bodyBuilder());
    const pageGlyph = visible(page).trim()[0];
    const row = rowFor(id);
    assert.equal(glyphOf(row), pageGlyph, `${id}: same glyph as the Run page for ${status}`);
    assert.ok(page.includes(`${rgbEscape(color)}${pageGlyph}`), `${id}: the Run page paints ${pageGlyph} ${color}`);
    assert.ok(row.includes(`${rgbEscape(color)}${pageGlyph}`), `${id}: Home paints ${pageGlyph} ${color} too`);
  }
  assert.notEqual(glyphOf(rowFor('nover1')), '○', 'a completed-not-verified run never reads as pending');
});

test('a run the kernel reopens is indexed with no finish and drops out of Home recent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-home-reopen-'));
  try {
    const bullswarmDir = join(root, 'home');
    const workspace = join(root, 'repo');
    mkdirSync(workspace); mkdirSync(bullswarmDir);
    const work = (id) => ({
      id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
      prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    });
    // Step `a` stalls on its first try, so the run finishes partial with a
    // failed step; step `b` succeeds.
    let calls = 0;
    const dispatchV2Action = async (options) => {
      const files = options.paths(1);
      const record = {
        ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running',
        startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
      };
      writeFileSync(files.taskFile, options.taskText);
      options.onAttempt?.('started', record);
      calls += 1;
      if (options.action.id === 'a' && calls === 1) {
        const why = 'stalled: the worker wrote nothing for 60 min and was stopped';
        Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'stalled', why });
        options.onAttempt?.('finished', record);
        return { attempts: [record], ok: false, status: 'failed', failureKind: 'stalled', verdict: { ok: false, why, meta: { exitCode: null } } };
      }
      writeFileSync(join(options.targetDir, `${options.action.id}.txt`), 'done');
      writeFileSync(files.outFile, `delivered ${options.action.id}`);
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
      options.onAttempt?.('finished', record);
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
    };
    const runId = 'wf-hreopn1-abcdef';
    const first = await runV2AutonomousWorkflow({
      bullswarmDir, pools: [], runId, dependencies: { dispatchV2Action },
      goalDocument: createV2GoalDocument({
        goal: 'Deliver the requested files', cwd: workspace,
        requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
        settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
      }),
      initialPlannerResponse: {
        schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.',
        program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [work('a'), work('b')] },
      },
    });
    assert.equal(first.result.status, 'partial');
    const recentText = () => {
      const nowMs = Date.now();
      const model = dashboardModel(null, { rollups: readRollups(bullswarmDir), nowMs, runs: [], period: '7d', usage: { pools: [], assignments: [] } });
      const lines = renderDashboardPage(model, { page: 'home', width: 200, height: 400, nowMs, period: '7d' }).lines.map(visible);
      return lines.slice(lines.findIndex((line) => line.includes('── recent'))).join('\n');
    };
    const finishedRow = readRollupIndex(bullswarmDir).find((record) => record.runId === runId);
    assert.equal(finishedRow.status, 'partial');
    assert.ok(finishedRow.finishedAt, 'a finished run is indexed with its finish');
    assert.match(recentText(), new RegExp(first.state.shortId), 'the finished run is listed as recent');

    const reopened = reopenV2RunForRetry({ bullswarmDir, runId });
    assert.equal(reopened.status, 'reopened');
    const reopenedRow = readRollupIndex(bullswarmDir).find((record) => record.runId === runId);
    assert.equal(reopenedRow.status, 'running');
    assert.equal(reopenedRow.finishedAt, null, 'the re-indexed row carries no finish or outcome');
    assert.doesNotMatch(recentText(), new RegExp(first.state.shortId), 'a reopened run is not a finished run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
