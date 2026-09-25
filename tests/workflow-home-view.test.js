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
  licenceCells,
  licenceTableLines,
  medianRunText,
  recentDurationText,
  stepBarText,
} from '../src/workflow/home-view.js';
import { todayLicenceRows, todayRows } from '../src/workflow/home-model.js';
import { readRollupIndex, readRollups } from '../src/workflow/rollup.js';
import { reopenV2RunForRetry, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';
import { runPage } from '../src/workflow/run-view.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';
import { seriesColor } from '../src/workflow/dash-kit.js';
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

const rgbEscape = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
};

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

/** Where a band's two halves sit: each `half` wide, the right one at `right` (0-based). */
function halvesOf(width) {
  const half = Math.floor((width - 2) / 2);
  return { half, right: width - half };
}

const HALF_WIDTHS = [55, 110, 120, 160, 200];

test('Home Today band: three stacked cards on the left half, the licence table on the right from 110 columns', () => {
  const snapshot = SNAPSHOT;
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = {
    runs: [], assignments: [], pools: [],
    rollups: readRollups(snapshot), days: [],
    tasks: { inflight: [], finished: [] }, budget: null, stats: null,
  };
  const pools = todayLicenceRows(model, todayRows(model, nowMs), nowMs).map((row) => row.name);
  assert.deepEqual(pools, ['claude-code', 'claude-code:acme', 'codex', 'grok']);
  for (const width of HALF_WIDTHS) {
    const body = bodyBuilder();
    homePage(model, { width, narrow: width < 100, nowMs, period: '7d' }, body);
    const raw = body.lines;
    const lines = raw.map(visible);
    assert.ok(lines.every((line) => [...line].length <= width), `${width}: line overflow`);
    const start = lines.findIndex((line) => line.startsWith('Home · Today'));
    const end = lines.findIndex((line, index) => index > start && line.startsWith('── running'));
    assert.ok(start >= 0 && end > start, `${width}: today band missing`);
    const band = lines.slice(start + 1, end);
    const bandRaw = raw.slice(start + 1, end);
    const shown = band.join('\n');
    // Three cards, stacked one per row at every width: never side by side.
    const cardTops = band.flatMap((line, index) => (line.startsWith('┌─ ') ? [index] : []));
    assert.equal(cardTops.length, 3, `${width}: three stacked cards\n${shown}`);
    assert.ok(band.every((line) => (line.match(/┌─ /g) ?? []).length <= 1), `${width}: cards side by side\n${shown}`);
    const cardBottom = band.reduce((last, line, index) => (line.includes('┘') ? index : last), -1);
    const ruleAt = band.findIndex((line) => line.includes('── licences · today'));
    const headerAt = band.findIndex((line) => /\bpool {2,}agent min {2,}/.test(line));
    assert.ok(ruleAt >= 0 && headerAt === ruleAt + 1, `${width}: the table has no rule and header\n${shown}`);
    const { half, right } = width >= 110 ? halvesOf(width) : { half: width, right: 0 };
    if (width >= 110) {
      // The left half holds the cards, each exactly as wide as the half; the
      // right half holds the table, opening on the first card's row.
      for (const top of cardTops) assert.equal(band[top].indexOf('┐') + 1, half, `${width}: card width\n${band[top]}`);
      assert.equal(ruleAt, cardTops[0], `${width}: the table does not share the cards' rows\n${shown}`);
      assert.equal(band[ruleAt].indexOf('── licences · today'), right, `${width}: the rule is not at the right half\n${band[ruleAt]}`);
      assert.ok(right - half >= 2, `${width}: gutter under 2`);
      assert.ok(band.every((line) => line.slice(half, right).trim() === ''), `${width}: the gutter is painted\n${shown}`);
    } else {
      // One column: the cards full width, and the table under them.
      assert.equal(band[cardTops[0]].length, width, `${width}: the card is not full width`);
      assert.ok(ruleAt > cardBottom, `${width}: the table is not below the cards\n${shown}`);
      assert.equal(band[ruleAt].indexOf('── licences · today'), 0);
    }
    // One header row, units in it; each pool row right-aligns its numbers so
    // the decimals line up under the header's right edge.
    const header = band[headerAt].slice(right);
    // No pool in this snapshot has a measured quota or a plan price: those
    // all-dash columns are the first to go when the half is too narrow.
    assert.match(header, /^ pool {2,}agent min {2,}(weekly quota {2,})?API \$ {2,}unpriced( {2,}plan \$)?$/, `${width}: ${header}`);
    if (width <= 120) assert.doesNotMatch(header, /weekly quota|plan \$/, `${width}: ${header}`);
    const minutesEnd = header.indexOf('agent min') + 'agent min'.length;
    const apiEnd = header.indexOf('API $') + 'API $'.length;
    const tableRows = band.slice(headerAt + 1).map((line) => line.slice(right));
    for (const name of [...pools, 'total']) {
      const row = tableRows.find((line) => line.startsWith(` ${name} `));
      assert.ok(row, `${width}: no row for ${name}\n${tableRows.join('\n')}`);
      assert.equal(row[minutesEnd - 2], '.', `${width}: ${name} minutes decimal\n${header}\n${row}`);
      assert.equal(row[apiEnd - 3], '.', `${width}: ${name} API decimal\n${header}\n${row}`);
      assert.doesNotMatch(row, /\$/, `${width}: a cell repeats the unit\n${row}`);
    }
    assert.match(tableRows.find((line) => line.startsWith(' codex ')), /^ codex +964\.5 +(— +)?≈36\.30 +25( +—)?$/);
    // The total row sums every column each pool knows.
    assert.match(tableRows.find((line) => line.startsWith(' total ')), /^ total +1270\.4 +≈171\.30 +26$/);
    // Pool names wear the same colour the `by pool` bars do.
    for (const name of pools) {
      assert.ok(bandRaw.some((line) => line.includes(`${rgbEscape(seriesColor(name))}${name}\x1b[0m`)),
        `${width}: ${name} is not painted in its pool colour`);
    }
    // A dim legend under the table names the glyphs.
    assert.ok(bandRaw.some((line) => line.includes('\x1b[2m') && visible(line).includes('≈ ~ estimates')), `${width}: no legend`);
  }
});

test('Home licence table puts a dim dash in unknown cells and drops the least useful column before cutting a number', () => {
  const rows = [
    { name: 'claude-code', subscriptionUsd: 2.63, tokenSource: 'provider-reported', apiUsd: 108.68, attempts: 4, pricedAttempts: 4 },
    { name: 'codex', subscriptionUsd: null, tokenSource: 'estimated:utf8-bytes/4', apiUsd: 0.00379, attempts: 2, pricedAttempts: 2 },
  ].map((row, index) => Object.defineProperties(row, {
    workerMinutes: { value: index ? null : 248.13 },
    weeklyShare: { value: index ? null : 2.9 },
    shareBasis: { value: index ? null : 'pace' },
    apiFacts: { value: { apiKnownSubtotalUsd: row.apiUsd, unmeasured: 0 } },
  }));
  const wide = licenceTableLines(rows, 99);
  const text = wide.map((line) => visible(line.text));
  assert.match(text[1], /^ pool +agent min +weekly quota +API \$ +plan \$$/);
  // A known share draws its bar in the pool's colour and its pace-estimate glyph.
  assert.match(text[2], /^ claude-code +248\.1 +▏?░+ ≈2\.9% +108\.68 +2\.63$/);
  // Unknown cells are a dim dash; a fraction of a cent keeps its estimate glyph.
  assert.match(text[3], /^ codex +— +— +~<0\.01 +—$/);
  assert.ok(wide[3].text.includes('\x1b[2m—\x1b[0m'), 'the unknown cells are not dim');
  // Each pool row opens Budget on that pool.
  assert.deepEqual(wide.filter((line) => line.action).map((line) => line.action.pool), ['claude-code', 'codex']);
  for (const width of [55, 54, 40, 30]) {
    const narrow = licenceTableLines(rows, width).map((line) => visible(line.text));
    assert.ok(narrow.every((line) => line.length <= width), `${width}:\n${narrow.join('\n')}`);
    // Whatever was dropped, the numbers that remain are whole.
    for (const figure of ['108.68', '248.1']) {
      if (narrow[1].includes(figure === '108.68' ? 'API $' : 'agent min')) {
        assert.ok(narrow.some((line) => line.includes(figure)), `${width}: ${figure} was cut\n${narrow.join('\n')}`);
      }
    }
    assert.match(narrow[1], /API \$/, `${width}: the API column went before a less useful one`);
  }
});

test('Home restores the period band and the recent list below the budget block', () => {
  const snapshot = SNAPSHOT;
  assert.ok(existsSync(`${snapshot}/history/runs.jsonl`), 'the supplied real Home snapshot is missing');
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, usage: { pools: [], assignments: [] }, days: [], period: '7d',
  });
  for (const width of HALF_WIDTHS) {
    const frame = renderDashboardPage(model, { page: 'home', width, height: 400, nowMs, period: '7d' });
    const lines = frame.lines.map(visible);
    assert.ok(lines.every((line) => [...line].length <= width), `${width}: line overflow`);
    const budget = lines.findIndex((line) => line.includes('── budget · this week'));
    const band = lines.findIndex((line) => line.includes('── last 7 days'));
    const recent = lines.findIndex((line) => line.includes('── recent'));
    assert.ok(budget >= 0 && band > budget, `${width}: the period band is not below the budget block`);
    assert.ok(recent > band, `${width}: the recent list is not below the period band`);
    const head = lines.findIndex((line) => line.includes('spent per day'));
    assert.ok(head > band && head < recent, `${width}: no spent-per-day chart in the band`);
    assert.equal(lines[head].indexOf('spent per day'), 1, `${width}: the chart is not in the left half`);
    // The three breakdowns, one under another, in their order.
    const labelAt = (heading) => lines.findIndex((line, index) => index >= head && index < recent && line.includes(heading));
    const at = ['by pool', 'by model', 'by project'].map(labelAt);
    assert.ok(at.every((index) => index >= 0) && at[0] < at[1] && at[1] < at[2], `${width}: ${at}`);
    const dayRow = lines.findIndex((line, index) => index > head && /\bMon\b.*\bSun\b/.test(line));
    if (width >= 110) {
      // The right half holds all three, stacked, each starting at that half's
      // first column, the first beside the chart's own label.
      const { right } = halvesOf(width);
      assert.equal(at[0], head, `${width}: by pool does not open beside the chart`);
      for (const index of at) {
        assert.equal(lines[index].search(/by (pool|model|project)/), right + 1, `${width}: ${lines[index]}`);
      }
      // Each section fills its half: its rows reach the page's right edge.
      const poolRow = lines[at[0] + 1];
      assert.ok(poolRow.length >= width - 1, `${width}: the by pool row does not use the half\n${poolRow}`);
    } else {
      // One column: chart first, then the three sections under it, flush left.
      assert.ok(at[0] > dayRow, `${width}: by pool is not under the chart`);
      for (const index of at) assert.equal(lines[index].search(/by (pool|model|project)/), 1, `${width}: ${lines[index]}`);
    }
    // Each section shows at most four rows, then `+N more`.
    const sectionRows = (from, to) => lines.slice(from + 1, to).map((line) => (width >= 110 ? line.slice(halvesOf(width).right) : line))
      .filter((line) => line.trim() && !line.includes('+'));
    assert.equal(sectionRows(at[0], at[1]).length, 4, `${width}: by pool rows`);
    assert.match(lines.slice(at[0], at[1]).join('\n'), /\+1 more/, `${width}: by pool does not count the rest`);
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
    // A click on the chart opens the spend trend; one on a section its tab.
    const actionAt = (row, x) => frame.regions.find((region) => region.y === row + 1 && region.x1 <= x && x <= region.x2)?.action;
    assert.deepEqual(actionAt(head + 2, 3), { kind: 'trend', metric: 'spend' }, `${width}: the chart lost its click`);
    const x = width >= 110 ? halvesOf(width).right + 3 : 3;
    assert.deepEqual(actionAt(at[0] + 1, x), { kind: 'tab', tab: 'pool' }, `${width}: by pool lost its click`);
    assert.deepEqual(actionAt(at[2] + 1, x), { kind: 'tab', tab: 'project' }, `${width}: by project lost its click`);
    const recentRows = lines.slice(recent + 1).filter((line) => /ago\s*$/.test(line.trimEnd()));
    assert.equal(recentRows.length, width >= 100 ? 5 : 3, `${width}: the recent list has ${recentRows.length} rows`);
  }
});

test('Home spend chart: one bar a day for seven days from a $0 axis, whole-dollar ticks marked only with ~', () => {
  const snapshot = SNAPSHOT;
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(snapshot), nowMs, usage: { pools: [], assignments: [] }, days: [], period: '7d',
  });
  for (const width of HALF_WIDTHS) {
    const frame = renderDashboardPage(model, { page: 'home', width, height: 400, nowMs, period: '7d' });
    const lines = frame.lines.map(visible);
    const head = lines.findIndex((line) => line.includes('spent per day'));
    const chartWidth = width >= 110 ? halvesOf(width).half : width;
    const left = lines.slice(head + 1).map((line) => line.slice(0, chartWidth).trimEnd());
    const dayRow = left.findIndex((line) => /\bSun\b/.test(line));
    assert.ok(dayRow > 0, `${width}: no day labels\n${left.slice(0, 20).join('\n')}`);
    // Seven day labels, oldest first, today last: every day of the period,
    // the days nothing ran on included.
    assert.deepEqual(left[dayRow].trim().split(/\s+/), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], `${width}`);
    const chart = left.slice(0, dayRow);
    const ticks = chart.flatMap((line) => [...line.matchAll(/(~?\$[\d,]+)\s[┤┼]/g)].map((match) => match[1]));
    assert.ok(ticks.length >= 3 && ticks.length <= 4, `${width}: ${ticks.length} axis labels: ${ticks}`);
    // The axis starts at $0 on the baseline, and no label carries cents or words.
    assert.equal(ticks.at(-1), '$0', `${width}: the axis does not start at $0`);
    assert.match(chart.at(-1), /\$0 ┼─+$/, `${width}: ${chart.at(-1)}`);
    for (const tick of ticks.slice(0, -1)) assert.match(tick, /^~\$\d[\d,]*$/, `${width}: ${tick}`);
    const band = lines.slice(head, head + dayRow + 3).join('\n');
    assert.doesNotMatch(band, /at least/, `${width}: the chart says at least`);
    assert.doesNotMatch(chart.join('\n'), /\$\d+\.\d/, `${width}: an axis label has cents`);
    // Bars stand on the days that spent: Fri 18, Sat 19 and Sun 20 Sep.
    const columnOf = (name) => left[dayRow].indexOf(name) + 1;
    const baseRow = chart.length - 2;
    for (const [name, drawn] of [['Mon', false], ['Thu', false], ['Fri', true], ['Sat', true], ['Sun', true]]) {
      assert.equal(/[▁-█]/.test(chart[baseRow][columnOf(name)] ?? ' '), drawn, `${width}: ${name} bar\n${chart.join('\n')}`);
    }
    // One dim line under the chart says what the bars leave out.
    assert.equal(left[dayRow + 1].trim(), '~ bars leave 66 unpriced attempts out', `${width}`);
  }
});

test('Home at every width from 110 to 260: the halves and gutter add up to the page, the right column keeps its last cells, the chart fills its half', () => {
  // The owner read Home at 199–200 columns with the right column's last cell
  // gone on every row (`40` for `40%`). The halves must add up to the width
  // at odd widths as well as even ones, and nothing the band says is cut.
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const model = dashboardModel(null, {
    rollups: readRollups(SNAPSHOT), nowMs, usage: { pools: [], assignments: [] }, days: [], period: '7d',
  });
  const breakdown = model.stats.overview.breakdown;
  const shares = (list) => list.slice(0, 4).map((row) => `${Math.round(row.minutesShare * 100)}%`);
  const figures = [
    ...shares(breakdown.pools),
    ...shares(breakdown.models),
    ...breakdown.projects.slice(0, 4).map((row) => String(row.runs)),
  ];
  assert.ok(figures.some((figure) => /^\d$/.test(figure)), 'the fixture has a single-digit count to lose');
  // The page body as painted, before the frame cuts anything, on the owner's
  // 55-row terminal and a 36-row one: the chart's height once followed the
  // terminal's, and only the 36-row one left it shorter than the breakdowns
  // with this fixture.
  for (const [width, height] of Array.from({ length: 151 }, (_, index) => [[110 + index, 55], [110 + index, 36]]).flat()) {
    const body = bodyBuilder();
    homePage(model, { width, narrow: false, nowMs, period: '7d', height }, body);
    const lines = body.lines.map(visible);
    const over = lines.find((line) => [...line].length > width);
    assert.equal(over, undefined, `${width}: a line is wider than the page\n${over}`);
    const { half, right } = halvesOf(width);
    assert.equal(right + half, width, `${width}: left half, gutter and right half do not add up`);

    // The period band: every breakdown row fills the right half to the page's
    // last cell, and that cell ends its own figure.
    const head = lines.findIndex((line) => line.includes('spent per day'));
    const summary = lines.findIndex((line, index) => index > head && line.includes('Workflows:'));
    const band = lines.slice(head, summary);
    const rowsWith = band.filter((line) => /[▇░]/.test(line.slice(right)));
    assert.equal(rowsWith.length, figures.length, `${width}: breakdown rows\n${band.join('\n')}`);
    rowsWith.forEach((line, index) => {
      assert.equal([...line].length, width, `${width}: the right half stops short\n${line}`);
      assert.ok(line.endsWith(` ${figures[index]}`), `${width}: the row lost the end of ${figures[index]}\n${line}`);
      assert.equal(line.slice(half, right).trim(), '', `${width}: the gutter is painted\n${line}`);
    });
    // The chart takes the height of the three breakdowns beside it: its note,
    // day labels and baseline end on the stack's last row.
    const leftEnd = band.findLastIndex((line) => line.slice(0, half).trim());
    const rightEnd = band.findLastIndex((line) => line.slice(right).trim());
    assert.equal(leftEnd, rightEnd, `${width}: the chart and the breakdowns end on different rows\n${band.join('\n')}`);
    assert.match(band[leftEnd], /^ ~ bars leave 66 unpriced attempts out/, `${width}`);

    // The Today band's licence table and the summary band cut nothing.
    const today = lines.slice(lines.findIndex((line) => line.startsWith('Home · Today')), lines.findIndex((line) => line.startsWith('── running')));
    assert.ok(today.every((line) => !line.slice(right).includes('…')), `${width}: the licence table is cut\n${today.join('\n')}`);
    const figuresBand = lines.slice(summary, lines.findIndex((line) => line.startsWith('── recent')));
    assert.ok(figuresBand.every((line) => !line.includes('…')), `${width}: the summary is cut\n${figuresBand.join('\n')}`);
    const figuresText = figuresBand.join('\n');
    assert.match(figuresText, /Spent: at least \$299\.87 api · 66 unmeasured/, `${width}\n${figuresText}`);
    assert.match(figuresText, /sub unknown \(no plan price\)/, `${width}\n${figuresText}`);
    if (width >= 190) {
      assert.match(figuresText, /Spent: at least \$299\.87 api · 66 unmeasured · sub unknown \(no plan price\)/, `${width}: Spent wraps at a width that holds it\n${figuresText}`);
    }
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
    // The table's cells: a measured share has no estimate glyph, and the
    // partly-priced API subtotal keeps its `≈` with the attempt it leaves out.
    const cellsOf = (row) => {
      const cells = licenceCells(row);
      return [cells.minutesText, cells.quotaText, cells.apiText, cells.unpricedText, cells.planText];
    };
    assert.deepEqual(cellsOf(measured), ['60.0', '1.5%', '≈12.00', '1', null]);

    // The same pool with no ledger attributed to it: the pace estimate, named
    // as the estimate it is.
    rmSync(ledger);
    const pace = shareRow(shareModel());
    assert.equal(pace.shareBasis, 'pace');
    assert.equal(Math.round(pace.weeklyShare * 100) / 100, 1.2);
    assert.deepEqual(cellsOf(pace), ['60.0', '≈1.2%', '≈12.00', '1', null]);

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
    assert.deepEqual(cellsOf(noPools), ['60.0', null, '≈12.00', '1', null]);

    // A pool whose rate was never measured, with no ledger either, keeps the
    // dash: no third basis, and never a guessed number beside the unknown.
    rmSync(ledger);
    const unrated = shareRow(shareModel({
      pools: [{ name: 'codex', usedPct: 12, spend: { pacing: { ratePerMinute: null, window: 'weekly' } } }],
    }));
    assert.equal(unrated.shareBasis, null);
    assert.equal(unrated.weeklyShare, null);
    assert.deepEqual(cellsOf(unrated), ['60.0', null, '≈12.00', '1', null]);

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
  // Stacked in the left half, each card is clickable (and hovers) across its
  // own box and nowhere else; each licence row in the right half opens Budget.
  for (const width of [120, 200]) {
    const { half, right } = halvesOf(width);
    const page = renderDashboardPage(model, { page: 'home', width, height: 60, nowMs });
    const first = Math.min(...page.regions.filter((region) => region.action?.kind === 'run').map((region) => region.y));
    const cards = page.regions.filter((region) => region.action?.kind === 'run' && region.y < first + 15);
    assert.equal(cards.length, 15, `${width}: five rows per card`);
    assert.ok(cards.every((region) => region.x1 === 1 && region.x2 === half), `${width}: ${JSON.stringify(cards[0])}`);
    assert.deepEqual(page.runRows.map((row) => row.y), [page.runRows[0].y, page.runRows[0].y + 5, page.runRows[0].y + 10]);
    const licence = page.regions.filter((region) => region.action?.kind === 'page' && region.action.page === 'budget'
      && region.y > 1 && region.y < first + 15);
    assert.deepEqual(licence.map((region) => region.action.pool), ['claude-code', 'claude-code:acme', 'codex', 'grok']);
    assert.ok(licence.every((region) => region.x1 === right + 1 && region.x2 <= width), `${width}: ${JSON.stringify(licence[0])}`);
    assert.ok(licence.every((region) => region.y >= first + 2), `${width}: a licence row is above its header`);
  }
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

  // All three recorded days are charted — 18 and 20 Sep are subtotals — so the
  // axis marks its figures `~` and one dim line counts what the bars leave
  // out. The words `at least` never appear on the chart.
  const band = text.split('── last 7 days')[1].split('Workflows:')[0];
  assert.match(band, /~\$200 ┤/, band);
  assert.match(band, /\$0 ┼/, band);
  assert.doesNotMatch(band, /at least/, band);
  assert.match(band, /~ bars leave 66 unpriced attempts out/, band);
  assert.equal((band.match(/████/g) ?? []).length > 0, true);

  // A pool whose attempts were only partly priced shows the subtotal, marked
  // `≈`, and the count of attempts it leaves out.
  assert.match(text, /codex +964\.5 +(— +)?≈36\.30 +25\b/);
  // A run with no strict total shows its own recorded lower bound on its card.
  assert.match(text, /API at least \$9\.52 · 6 unmeasured/);
});

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
