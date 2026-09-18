import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/workflow/dash-kit.js';
import {
  absentLine, chartRowCount, columnBars, columns, compactRow, cut, formatDashboardValue, heatRow, niceStep, paletteColor, periodToggle, progressBar, rule,
  seriesColor,
  seriesColors,
  shareBar, sparkline, stackedBars, tabsRow,
} from '../src/workflow/dash-kit.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';

const SGR = /\x1b\[[0-9;]*m/g;
const visible = (text) => String(text ?? '').replace(SGR, '');
const visibleLength = (text) => visible(text).length;
const WIDTHS = [32, 54, 55, 100, 200];
const ASCII = ['.', ':', '-', '=', '#'];

function foregroundColoursIn(line, start, width) {
  const colours = new Set();
  const source = String(line ?? '');
  let at = 0;
  let column = 0;
  let foreground = null;
  while (at < source.length) {
    if (source[at] === '\x1b') {
      const match = source.slice(at).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (match) {
        const sequence = match[0];
        const colour = sequence.match(/^\x1b\[38;2;([^m]+)m$/);
        if (colour) foreground = colour[1];
        else if (/^\x1b\[0m$/.test(sequence)) foreground = null;
        at += sequence.length;
        continue;
      }
    }
    if (column >= start && column < start + width && foreground) colours.add(foreground);
    column += 1;
    at += 1;
  }
  return colours;
}

/** Every `$` the text paints with no `≈` in front of it. */
function unmarkedDollars(text) {
  const source = String(text ?? '');
  return [...source.matchAll(/\$/g)]
    .map((match) => match.index)
    .filter((index) => !source.slice(Math.max(0, index - 2), index).includes('≈'));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ASCII_ENV = { BULLSWARM_ASCII: '1', BULLSWARM_UNICODE: undefined };
const UNICODE_ENV = { BULLSWARM_ASCII: undefined, BULLSWARM_UNICODE: '1' };

const TABS = Object.freeze([
  { id: 'home', label: 'Home', key: 'h' },
  { id: 'runs', label: 'Runs', key: 'r' },
  { id: 'budget', label: 'Budget', key: 'b' },
  { id: 'stats', label: 'Stats', key: 's' },
  { id: 'history', label: 'History', key: 'y' },
  { id: 'fleet', label: 'Fleet', key: 'f' },
]);

const PERIODS = Object.freeze([
  { id: '7d', label: 'Last 7 days', key: '7' },
  { id: '30d', label: 'Last 30 days', key: '3' },
  { id: 'all', label: 'All time', key: 'a' },
]);

const CELLS = Object.freeze([
  { rule: 'budget', rows: ['cmd      1.2%', 'codex    1.5%', 'this run 1.2% of 100%'] },
  { rule: 'live', rows: ['widget-lib  15m/17m', '  > done: lib exported'] },
  { rule: 'so far', rows: ['steps   3/8', 'time    16m', 'spent   $1.05'] },
]);

const FIELDS = Object.freeze([
  { text: '✓', width: 1 },
  { text: 'gcxzza', width: 6 },
  { text: 'bullswarm · docs site rebuilt · 5/5', grow: true, gap: 2 },
  { text: '41m · $2.10', width: 11, align: 'right', gap: 3 },
  { text: '16:41', width: 5, gap: 2 },
]);

const ROWS = Object.freeze([
  { label: 'claude-code', segments: [{ value: 6, color: METER_COLORS.green }, { value: 2, color: METER_COLORS.amber }] },
  { label: 'codex', segments: [{ value: 3, color: METER_COLORS.red }] },
  { label: 'grok', segments: [] },
]);

test('the kit exports its rendering primitives and shared value formatter', () => {
  assert.deepEqual(Object.keys(kit).sort(), [
    'SERIES_PALETTE', 'absentLine', 'chartRowCount', 'columnBars', 'columns', 'compactRow', 'cut', 'formatDashboardValue', 'heatRow', 'niceStep', 'paletteColor', 'periodToggle',
    'progressBar', 'rule', 'seriesColor', 'seriesColors', 'shareBar', 'sparkline', 'stackedBars', 'tabsRow',
  ]);
});

test('rule draws both sides, either side, or a bare rule at the width', () => {
  for (const width of WIDTHS) {
    const both = rule('today', 'history ›', width);
    assert.equal(visibleLength(both), width, `both sides at ${String(width)}`);
    assert.ok(both.startsWith('── today '), 'the title opens the rule');
    assert.ok(both.endsWith(' history › ──'), 'the right side closes the rule');
    assert.equal(visibleLength(rule('today', null, width)), width);
    assert.ok(rule('today', null, width).startsWith('── today ─'), 'the dashes follow the title');
    assert.equal(visibleLength(rule(null, 'right', width)), width);
    assert.ok(rule(null, 'right', width).endsWith('right ──'));
    assert.equal(rule(null, null, width), '─'.repeat(width));
  }
  // A title too long for the line is cut, never painted past it.
  for (const width of WIDTHS) {
    const long = rule('a title of unreasonable length', 'and a right side too', width);
    assert.ok(visibleLength(long) <= width);
    assert.equal(long.includes('NaN'), false);
  }
  assert.equal(rule(null, null, 0), '');
  assert.equal(rule(null, null, -4), '');
  assert.equal(rule(null, null), '─'.repeat(120));
  assert.equal(rule('t', null, undefined).length, 120);
});

test('rule measures a styled title by its visible cells', () => {
  const styled = rule('\x1b[1mtoday\x1b[0m', null, 40);
  assert.equal(visibleLength(styled), 40);
  assert.ok(styled.includes('\x1b[1m'));
});

test('tabsRow paints the active tab inverted and every key underlined', () => {
  const { text, regions } = tabsRow(TABS, { active: 'budget', width: 120 });
  assert.ok(text.includes('\x1b[7m\x1b[4mB\x1b[24mudget\x1b[0m'), 'the active tab is inverted with its key letter underlined');
  assert.ok(text.includes(' \x1b[4mH\x1b[24mome '), 'an inactive key letter is underlined too');
  assert.equal(visible(text), ' Home  Runs  Budget  Stats  History  Fleet');
  assert.equal(regions.length, TABS.length);
  assert.deepEqual(regions[0], { x: 2, width: 4, action: { kind: 'page', page: 'home' } });
  assert.deepEqual(regions[2], { x: 14, width: 6, action: { kind: 'page', page: 'budget' } });
  assert.deepEqual(regions[5], { x: 38, width: 5, action: { kind: 'page', page: 'fleet' } });
  for (const region of regions) {
    assert.ok(region.x >= 1, 'x is a 1-based column of the line');
    assert.ok(region.x + region.width - 1 <= visibleLength(text), 'a region lies inside its line');
    assert.deepEqual(Object.keys(region).sort(), ['action', 'width', 'x']);
  }
});

test('tabsRow drops a hidden tab unless it is the active one', () => {
  const hidden = tabsRow(TABS, { active: 'home', width: 200, hidden: ['fleet'] });
  assert.equal(visible(hidden.text).includes('Fleet'), false);
  assert.equal(hidden.regions.length, TABS.length - 1);
  const active = tabsRow(TABS, { active: 'fleet', width: 200, hidden: ['fleet'] });
  assert.ok(visible(active.text).includes('Fleet'), 'the page the reader is on never disappears');
  assert.equal(active.regions.length, TABS.length);
});

test('tabsRow keeps the active tab when the row does not fit', () => {
  const { text, regions } = tabsRow(TABS, { active: 'fleet', width: 32 });
  assert.ok(visibleLength(text) <= 32);
  assert.ok(visible(text).includes('Fleet'));
  assert.ok(regions.length < TABS.length, 'tabs that do not fit are dropped');
  for (const region of regions) assert.ok(region.x + region.width - 1 <= visibleLength(text));
});

test('tabsRow takes an action override, and survives junk', () => {
  const { regions } = tabsRow(TABS, {
    active: 'home', width: 120, action: (tab) => ({ kind: 'tab', tab: tab.id }),
  });
  assert.deepEqual(regions[3].action, { kind: 'tab', tab: 'stats' });
  for (const value of [null, undefined, [], [null, undefined]]) {
    const empty = tabsRow(value, { active: null, width: 40 });
    assert.equal(typeof empty.text, 'string');
    assert.deepEqual(empty.regions, []);
    assert.equal(empty.text.includes('NaN'), false);
  }
});

test('periodToggle marks the active period and opens it', () => {
  const { text, regions } = periodToggle(PERIODS, { active: '30d', width: 120 });
  assert.equal(visible(text), 'Last 7 days · Last 30 days · All time');
  assert.ok(text.includes('\x1b[7mLast \x1b[4m3\x1b[24m0 days\x1b[0m'), 'the active period is inverted');
  assert.ok(visible(text).startsWith('Last 7 days'), 'no leading space: the caller places it');
  assert.deepEqual(regions.map((region) => region.action), [
    { kind: 'period', period: '7d' }, { kind: 'period', period: '30d' }, { kind: 'period', period: 'all' },
  ]);
  assert.deepEqual(regions[1], { x: 15, width: 12, action: { kind: 'period', period: '30d' } });
  for (const region of regions) assert.ok(region.x + region.width - 1 <= visibleLength(text));
});

test('periodToggle fits a width it is given and holds the active period', () => {
  for (const width of WIDTHS) {
    const { text, regions } = periodToggle(PERIODS, { active: 'all', width });
    assert.ok(visibleLength(text) <= width, `at ${String(width)}`);
    if (width >= 21) assert.ok(visible(text).includes('All time'));
    for (const region of regions) assert.ok(region.x + region.width - 1 <= visibleLength(text));
  }
  assert.equal(visibleLength(periodToggle(PERIODS, { active: 'all', width: 32 }).text) <= 32, true);
  assert.equal(periodToggle(null, { active: null }).text, '');
  assert.deepEqual(periodToggle(undefined, {}).regions, []);
});

test('shareBar fills exactly its width and hands out the largest remainder', () => {
  const parts = [{ value: 1, glyph: '▓' }, { value: 1, glyph: '▒' }, { value: 1, glyph: '░' }];
  for (const width of WIDTHS) {
    const bar = shareBar(parts, { width });
    assert.equal(visibleLength(bar), width, `exactly ${String(width)} cells`);
    const seen = ['▓', '▒', '░'].map((glyph) => (visible(bar).match(new RegExp(glyph, 'g')) ?? []).length);
    assert.equal(seen.reduce((sum, count) => sum + count, 0), width);
    assert.ok(Math.abs(seen[0] - width / 3) <= 1, 'even parts split evenly');
  }
  const skewed = visible(shareBar([{ value: 90, glyph: '▓' }, { value: 10, glyph: '░' }], { width: 100 }));
  assert.equal(skewed.length, 100);
  assert.equal((skewed.match(/▓/g) ?? []).length, 90);
});

test('shareBar falls back to ascii glyphs and can drop colour', () => {
  const parts = [{ value: 40, glyph: '▓' }, { value: 35, glyph: '▒' }, { value: 25, glyph: '░' }];
  withEnv(ASCII_ENV, () => {
    const bar = shareBar(parts, { width: 20, colors: false });
    assert.equal(bar, `${'#'.repeat(8)}${'.'.repeat(7)}${'|'.repeat(5)}`);
    assert.equal(SGR.test(bar), false);
  });
  withEnv(UNICODE_ENV, () => {
    const plain = shareBar(parts, { width: 20, colors: false });
    assert.equal(plain, `${'▓'.repeat(8)}${'▒'.repeat(7)}${'░'.repeat(5)}`);
    assert.equal(plain.includes('\x1b'), false, 'no colour asked for, no colour painted');
  });
});

test('shareBar colours a named palette colour and dims the parts after the first', () => {
  const bar = shareBar([
    { value: 50, glyph: '▓', color: METER_COLORS.red },
    { value: 50, glyph: '░' },
  ], { width: 10, colors: true });
  assert.ok(bar.includes('\x1b[38;2;191;108;105m'), 'the named colour is used');
  assert.ok(bar.includes('\x1b[2m'), 'the trailing part is dimmed');
  assert.equal(visibleLength(bar), 10);
  const junk = shareBar([{ value: 1, color: 'not-a-colour' }, { value: Number.NaN }], { width: 8 });
  assert.equal(junk.includes('NaN'), false);
  assert.equal(junk.includes('not-a-colour'), false);
});

test('shareBar draws an empty bar rather than a wrong one', () => {
  assert.equal(shareBar([], { width: 12 }), ' '.repeat(12));
  assert.equal(shareBar(null, { width: 12 }), ' '.repeat(12));
  assert.equal(visible(shareBar([{ value: 0 }, { value: 0 }], { width: 12 })), ' '.repeat(12));
  assert.equal(shareBar([{ value: 1 }], { width: 0 }), '');
  assert.equal(shareBar([{ value: -5 }, { value: 3 }], { width: 10 }).includes('NaN'), false);
});

test('sparkline scales the window and never invents a peak', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([7, 7, 7, 7], 4), '▄▄▄▄', 'a flat non-zero series sits mid');
  assert.equal(sparkline([0, 0, 0], 3), '▁▁▁', 'a flat zero series sits low');
  assert.equal(sparkline([null, Number.NaN, undefined], 3), '');
  assert.equal(sparkline([0, null, 4], 3), '▁▁█', 'a missing day reads at the low end');
  assert.equal(sparkline([null, 6], 2), '▁▄', 'a missing reading does not set the scale');
  assert.equal(sparkline(['', 6], 2), '▁▄', 'nor does an empty string, which Number() calls zero');
  assert.equal(
    sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3),
    sparkline([10, 11, 12], 3),
    'the window is the newest values',
  );
  assert.equal(sparkline([1, 2], 40).length, 2, 'a short series is not padded out');
  assert.equal(sparkline([], 10), '');
  assert.equal(sparkline(null, 10), '');
  assert.equal(sparkline([1, 2, 3], 0), '');
});

test('sparkline falls back to ascii and stays inside its width', () => {
  withEnv(ASCII_ENV, () => {
    // Eight levels over the five ascii levels the kit keeps: still monotone.
    const line = sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8);
    assert.equal(line, '.::--==#');
    for (const glyph of line) assert.ok(ASCII.includes(glyph), `ascii only, got ${glyph}`);
  });
  for (const width of WIDTHS) {
    const line = sparkline([1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144], width);
    assert.equal(line.length, Math.min(width, 12));
    assert.equal(line.includes('NaN'), false);
  }
});

test('progressBar fills, clamps and falls back to ascii', () => {
  assert.equal(progressBar(0.5, 8), '▇▇▇▇░░░░');
  assert.equal(progressBar(0, 4), '░░░░');
  assert.equal(progressBar(1, 4), '▇▇▇▇');
  assert.equal(progressBar(2, 4), '▇▇▇▇', 'over-full clamps');
  assert.equal(progressBar(-1, 4), '░░░░', 'under-full clamps');
  assert.equal(progressBar(null, 4), '░░░░', 'no fraction, no fill');
  assert.equal(progressBar(Number.NaN, 4), '░░░░');
  assert.equal(progressBar(0.25, 0), '');
  withEnv(ASCII_ENV, () => assert.equal(progressBar(0.5, 6), '###...'));
  for (const width of WIDTHS) {
    const bar = progressBar(0.37, width);
    assert.equal(bar.length, width);
    assert.equal(bar.includes('NaN'), false);
  }
});

test('stackedBars draws a label gutter and a bar per row inside the width', () => {
  for (const width of WIDTHS) {
    const lines = stackedBars(ROWS, { width });
    assert.equal(lines.length, ROWS.length);
    for (const line of lines) {
      assert.ok(visibleLength(line) <= width, `at ${String(width)}`);
      assert.equal(line.includes('NaN'), false);
    }
  }
  const [first] = stackedBars(
    [{ label: 'claude-code', segments: [{ value: 75, color: METER_COLORS.green }, { value: 25 }] }],
    { width: 40 },
  );
  assert.equal(visible(first), 'claude-code '.padEnd(12) + '█'.repeat(28));
  assert.ok(first.includes('\x1b[38;2;182;189;115m'), 'the segment colour is the palette hex');
});

test('stackedBars handles ascii, no colour, empty rows and zero values', () => {
  withEnv(ASCII_ENV, () => {
    const [line] = stackedBars([{ label: 'cmd', segments: [{ value: 1 }] }], { width: 20, colors: false });
    assert.equal(visible(line), `cmd ${'#'.repeat(16)}`);
    assert.equal(line.includes('\x1b'), false);
    for (const glyph of visible(line).slice(4)) assert.equal(glyph, '#', 'the bar is ascii');
  });
  assert.deepEqual(stackedBars([], { width: 40 }), []);
  assert.deepEqual(stackedBars(null, { width: 40 }), []);
  const [empty] = stackedBars([{ label: 'grok', segments: [] }], { width: 30, colors: false });
  assert.equal(empty, 'grok '.padEnd(5) + ' '.repeat(25), 'no segments draw an empty track');
  const [zero] = stackedBars(
    [{ label: 'grok', segments: [{ value: 0 }, { value: Number.NaN }] }],
    { width: 30, colors: false },
  );
  assert.equal(zero.includes('NaN'), false);
  assert.equal(visible(zero).trim(), 'grok');
  const [long] = stackedBars([{ label: 'x'.repeat(80), segments: [{ value: 1 }] }], { width: 32, colors: false });
  assert.ok(visibleLength(long) <= 32);
  assert.ok(visible(long).includes('…'), 'a label too long for the gutter is cut');
});

test('columnBars keeps magnitude, value labels and cumulative totals in a narrow width', () => {
  const chart = columnBars([
    { values: [1, 36], color: METER_COLORS.green },
  ], ['2026-09-15', '2026-09-16'], {
    width: 55, height: 6, col: 8, barW: 3, cumulative: true, colors: false,
  });
  assert.equal(chart.length, chart.meta.chartRows + 3, 'chart rows plus labels, values and cumulative rows');
  assert.ok(chart.meta.columns[1].height > chart.meta.columns[0].height, '36x value is visibly taller than 1x');
  assert.deepEqual(chart.meta.sums, [1, 36]);
  assert.ok(chart.some((line) => visible(line).includes('36')), 'value row carries the total');
  assert.ok(chart.some((line) => visible(line).includes('37')), 'cumulative row carries the running total');
  for (const line of chart) assert.ok(visibleLength(line) <= 55, `column chart overran 55: ${visible(line)}`);
  withEnv(ASCII_ENV, () => {
    const ascii = columnBars([{ values: [1, 36] }], ['a', 'b'], { width: 55, colors: false });
    assert.equal(ascii.join('\n').includes('█'), false, 'ascii mode uses # columns');
    assert.ok(ascii.join('\n').includes('#'));
  });
});

test('columnBars marks every money figure it prints and blanks the column with no reading', () => {
  const chart = columnBars([{ values: [1.2, null, 36] }], ['Mon', 'Tue', 'Wed'], {
    width: 55, height: 4, col: 8, barW: 3, mark: '≈', cumulative: true, colors: false,
  });
  const rows = chart.map((line) => visible(line));
  const meta = chart.meta;
  const ticks = rows.slice(0, meta.chartRows).map((line) => line.split(/[┤|]/)[0].trim()).filter(Boolean);
  assert.ok(ticks.length >= 2, 'the axis paints ticks');
  for (const tick of ticks) assert.match(tick, /^≈\$/, `tick "${tick}" carries the mark`);
  const valueRow = rows[meta.valueRow - 1];
  assert.match(valueRow, /≈\$1\.2/, 'a recorded value is marked');
  assert.match(valueRow, /≈\$36/);
  assert.match(valueRow, /—/, 'the bucket nobody recorded a figure for is a blank');
  assert.equal(/≈\s*—/.test(valueRow), false, 'a blank has no reading to qualify');
  assert.doesNotMatch(valueRow, /\$0(?!\.\d)/, 'a blank is never a zero');
  const totalsRow = rows[meta.cumulativeRow - 1];
  assert.match(totalsRow, /≈\$1\.2/, 'the running total is marked too');
  assert.match(totalsRow, /≈\$37/);
  assert.deepEqual(unmarkedDollars(rows.join('\n')), [], 'no `$` is painted without its mark');
  for (const line of rows) assert.ok(line.length <= 55, `column chart overran 55: ${line}`);
});

test('columnBars floors $2.93 to eighths under an evenly spaced $3 axis', () => {
  withEnv(UNICODE_ENV, () => {
    const chart = columnBars([{ values: [2.93] }], ['day'], {
      height: 8, mark: '≈', colors: false, col: 4, barW: 3, totals: false,
    });
    const rows = [...chart];
    assert.match(rows[0], /┤ ▅▅▅/);
    assert.match(rows.at(-1), /┼day/);
    assert.equal(rows.filter((line) => line.includes('≈\$')).length, 6);
    assert.equal(rows.filter((line) => line.includes('≈\$')).at(-1), '≈$0.00 ┤ ███');
    assert.equal(chart.meta.columns[0].eighths, 93);
    assert.equal(chart.meta.columns[0].height, chart.meta.chartRows);
    assert.equal(chart.meta.axisTop, 3);
  });
  for (const height of [2, 3, 5, 6, 8, 9, 12, 20]) {
    for (const value of [0.01, 0.3, 2.93, 36, 293]) {
      const chart = columnBars([{ values: [value] }], ['day'], { height, colors: false });
      const meta = chart.meta;
      assert.ok(meta.chartRows >= height);
      const ticks = chart.slice(0, meta.chartRows).flatMap((line, row) => visible(line).split(/[┤|]/)[0].trim() ? [row] : []);
      for (let at = 1; at < ticks.length; at += 1) assert.equal(ticks[at] - ticks[at - 1], meta.rowsPerTick);
      assert.ok(meta.columns[0].eighths / 8 / meta.chartRows * meta.axisTop <= value + 1e-12);
      assert.equal(meta.axisRow, meta.chartRows + 1);
    }
  }
});

test('columnBars places a one-step tick on the row above the filled bottom cell', () => {
  const chart = columnBars([{ values: [0.5, 2] }], ['small', 'large'], {
    height: 4, colors: false, col: 4, barW: 2, totals: false,
  });
  const stepLabel = chart.findIndex((line) => visible(line).includes('0.50'));
  assert.equal(chart.meta.columns[0].height, 1);
  assert.equal(stepLabel, chart.meta.chartRows - 2, 'the one-step label marks the filled row\'s top edge');
  assert.match(visible(chart[stepLabel]), /0\.50/);
});

test('columnBars gives a one-cent slice one eighth at the bottom without increasing the total', () => {
  withEnv(UNICODE_ENV, () => {
    const chart = columnBars([
      { values: [0.01], color: METER_COLORS.red },
      { values: [2.99], color: METER_COLORS.green },
    ], ['day'], { height: 6, barW: 3 });
    const column = chart.meta.columns[0];
    assert.equal(column.eighths, 48);
    // Smallest slice first (bottom), biggest on top; the total stays 48 eighths.
    assert.deepEqual(column.segments.map((entry) => [entry.sourceIndex, entry.eighths]), [[0, 1], [1, 47]]);
    // The bottom bar row holds the red eighth under the green slice: green
    // foreground partial glyph over a red background.
    const bottom = chart[chart.meta.chartRows - 1];
    assert.match(bottom, /\x1b\[48;2;191;108;105m\x1b\[38;2;182;189;115m/);
    assert.match(chart[0], /\x1b\[38;2;182;189;115m█/);
    assert.equal(column.height, 6);
  });
});

test('columnBars merges several sub-eighth pools into one vertical other slice', () => {
  withEnv(UNICODE_ENV, () => {
    const chart = columnBars([
      { name: 'main', values: [2.97, 75], color: METER_COLORS.green },
      { values: [0.01, 0], color: METER_COLORS.red },
      { values: [0.01, 0], color: METER_COLORS.cyan },
      { values: [0.01, 0], color: METER_COLORS.amber },
    ], ['day', 'large'], { height: 6, barW: 3 });
    assert.deepEqual(chart.meta.columns[0].segments.map((entry) => entry.eighths), [1, 1]);
    // The merged `other` slice sits at the bottom, under the named slice.
    assert.equal(chart.meta.columns[0].segments[0].name, 'other (3 pools)');
    assert.ok(chart.meta.legend.includes('main') && chart.meta.legend.includes('other (3 pools)'));
    // No rendered chart row contains horizontal colour lanes. A cell may
    // carry one foreground (plus the lower slice as a background), never a
    // sequence of side-by-side foregrounds inside its own column width.
    for (const line of chart.slice(0, chart.meta.chartRows)) {
      for (const column of chart.meta.columns) {
        assert.ok(
          foregroundColoursIn(line, column.x - 1, column.width).size <= 1,
          `horizontal colour lane in ${JSON.stringify(visible(line))}`,
        );
      }
    }
    const partial = columnBars([{ values: [2.93], color: METER_COLORS.red }], ['day'], { height: 6 });
    assert.match(partial[0], /\x1b\[38;2;191;108;105m▆\x1b\[0m/);
  });
});

test('columnBars uses equal-width phone columns and keeps a single small slice', () => {
  const chart = columnBars([
    { name: 'large', values: [424, 10, 20, 30, 40, 50, 60] },
    { name: 'small', values: [29, 0, 0, 0, 0, 0, 0] },
  ], ['1', '2', '3', '4', '5', '6', '7'], { width: 55, rowCount: 6, colors: false });
  assert.equal(new Set(chart.meta.columns.map((column) => column.width)).size, 1);
  assert.ok(chart.meta.columns[0].segments.some((segment) => segment.sourceIndex === 1 && segment.eighths >= 1));
  assert.ok(chart.meta.chartRows >= 6);
});

test('columnBars keeps a 29-minute model slice visible on a 424-minute day', () => {
  const opus = [29, 9, 897, 75, 278, 686];
  const other = [395, 0, 0, 0, 0, 0];
  const chart = columnBars([
    { name: 'opus', values: opus, color: seriesColor('opus') },
    { name: 'grok', values: other, color: seriesColor('grok') },
  ], ['12', '13', '14', '15', '16', '17'], {
    width: 120, rowCount: 12, unit: 'minutes', colors: false,
  });
  assert.equal(chart.meta.sums[0], 424);
  for (const [index, value] of opus.entries()) {
    if (value <= 0) continue;
    const slice = chart.meta.columns[index].segments.find((entry) => entry.sourceIndex === 0);
    assert.ok(slice && slice.eighths >= 1, `opus day ${index} keeps a visible slice`);
  }
});

test('series colours are stable by name and reserve unknown/other greys', () => {
  assert.equal(seriesColor('grok'), seriesColor('grok'));
  assert.equal(paletteColor('grok'), seriesColor('grok'));
  assert.notEqual(seriesColor('unknown'), seriesColor('grok'));
  assert.notEqual(seriesColor('other'), seriesColor('grok'));
  assert.equal(seriesColor('unknown'), METER_COLORS.dim);
  assert.equal(seriesColor('other (3 pools)'), METER_COLORS.others);
});

test('absentLine is a dim single row of words bounded by width', () => {
  assert.equal(visible(absentLine('opencode', 'free model · no licence meter')), 'opencode   free model · no licence meter');
  for (const width of [0, 1, 12, ...WIDTHS]) {
    const line = absentLine('opencode', 'free model · no licence meter', { width });
    assert.ok(visibleLength(line) <= width);
    assert.doesNotMatch(visible(line), /[▁▂▃▄▅▆▇█▓▒░·]{2,}/);
    if (width) assert.ok(line.startsWith('\x1b[2m'));
  }
  assert.doesNotMatch(absentLine('pool\nname', 'no\rmeter\tyet'), /[\r\n\t]/);
  assert.equal(absentLine(null, null), '');
});

test('partial glyphs opt into licence slivers without changing default bars', () => {
  withEnv(UNICODE_ENV, () => {
    assert.equal(progressBar(0.004, 10, { partialGlyph: '▏' }), `▏${'░'.repeat(9)}`);
    assert.equal(progressBar(0.24, 10, { partialGlyph: '▍' }), `▇▇▍${'░'.repeat(7)}`);
    assert.equal(progressBar(0, 10, { partialGlyph: '▏' }), '░'.repeat(10));
    assert.equal(progressBar(1, 10, { partialGlyph: '▏' }), '▇'.repeat(10));
    const parts = [{ value: 0.4, glyph: '▇', color: METER_COLORS.red }, { value: 99.6, glyph: '░' }];
    const bar = shareBar(parts, { width: 10, partialGlyph: '▏' });
    assert.equal(visible(bar), `▏${'░'.repeat(9)}`);
    assert.match(bar, /\x1b\[38;2;191;108;105m▏/);
    assert.equal(visible(shareBar(parts, { width: 10 })), '░'.repeat(10));
  });
  withEnv(ASCII_ENV, () => {
    assert.equal(progressBar(0.004, 10, { partialGlyph: '▏' }), '|.........');
    assert.equal(shareBar([{ value: 0.4 }, { value: 99.6 }], { width: 10, colors: false, partialGlyph: '▏' }), '|.........');
  });
});

test('sparkline reset markers replace original indexes even in a cropped window', () => {
  withEnv(UNICODE_ENV, () => {
    assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8, { markers: [2, 5] }), '▁▂▏▄▅▏▇█');
    assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 3, { markers: [2, 5, 7] }), '▏▅▏');
    assert.equal(sparkline([1, null, 3], 3, { markers: [1] }), '▁▏█');
    assert.equal(sparkline([null, null], 2, { markers: [1] }), '');
    assert.equal(sparkline([1, 2], 9, { markers: [-1, 7] }), '▁█');
  });
  withEnv(ASCII_ENV, () => assert.equal(sparkline([0, 1, 2], 3, { markers: [1] }), '.|#'));
});

test('columnBars without a mark paints a measured figure bare', () => {
  const chart = columnBars([{ values: [1, 36] }], ['a', 'b'], { width: 55, colors: false });
  const text = chart.map((line) => visible(line)).join('\n');
  assert.match(text, /36/, 'the value row still carries its number');
  assert.equal(text.includes('≈'), false, 'a count is not an estimate');
});

test('columnBars applies the dashboard money precision to fractions of a cent', () => {
  const chart = columnBars([{ values: [0.004] }], ['Mon'], {
    width: 40, mark: '≈', colors: false,
  });
  const valueRow = visible(chart[chart.meta.valueRow - 1]);
  assert.match(valueRow, /≈\$0\.00/, 'money is consistently rounded to cents');
});

test('heatRow paints a cell per value, an empty marker for null', () => {
  assert.equal(heatRow([0, 0.25, 0.5, 1], { ansi: false }), '░ ░ ▒ █');
  assert.equal(heatRow([null, Number.NaN, undefined], { ansi: false }), '· · ·');
  assert.equal(heatRow([], {}), '');
  assert.equal(heatRow(null, {}), '');
  withEnv(ASCII_ENV, () => assert.equal(heatRow([0, 1], { ansi: false }), '. #'));
});

test('heatRow paints the ramp in ansi and fits the width it is given', () => {
  const row = heatRow([0.1, 0.6, 1], {});
  assert.ok(row.includes('\x1b[48;2;'), 'cells are background-coloured');
  assert.equal(visible(row), '░ ▓ █', 'three visible density cells and the two gaps between them');
  assert.equal(visibleLength(heatRow([null, 1], {})), 3);
  const ramps = heatRow([0.1, 0.4, 0.7, 1], {}).match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g);
  assert.equal(ramps.length, 4);
  const tints = ramps.map((code) => code.slice(7, -1).split(';').map(Number));
  for (let channel = 0; channel < 3; channel += 1) {
    const channelValues = tints.map((tint) => tint[channel]);
    assert.deepEqual(
      channelValues,
      [...channelValues].sort((a, b) => a - b),
      `channel ${String(channel)} brightens with the value`,
    );
  }
  for (const width of WIDTHS) {
    const line = heatRow(Array.from({ length: 40 }, (_, index) => index / 40), { width });
    assert.ok(visibleLength(line) <= width, `at ${String(width)}`);
  }
  assert.equal(visibleLength(heatRow([0.1, 0.2, 0.3], { width: 5 })), 5, 'the newest cells are kept');
  assert.equal(visibleLength(heatRow([1, 1, 1], { width: 0 })), 0);
});

test('columns lays one, two and four cells across the width', () => {
  for (const width of WIDTHS) {
    for (const count of [1, 2, 4]) {
      const cells = CELLS.slice(0, 3).concat([{ rule: 'extra', rows: ['one', 'two'] }]).slice(0, count);
      const band = columns(cells, { width });
      assert.equal(band.meta.columns.length, count, `${String(count)} cells at ${String(width)}`);
      for (const line of band) {
        assert.ok(visibleLength(line) <= width, `a line overran ${String(width)}: "${visible(line)}"`);
        assert.equal(line.includes('NaN'), false);
      }
      for (const region of band.meta.columns) {
        assert.ok(region.x >= 1, 'x is a 1-based column of the line');
        assert.ok(region.x + region.width - 1 <= width, `a column sat past ${String(width)}`);
      }
      // Every column is as tall as the block, so the rows below stay aligned.
      const tallest = Math.max(...cells.map((cell) => cell.rows.length)) + 1;
      assert.equal(band.length, tallest, 'the block is as tall as its tallest cell');
    }
  }
});

test('columns draws each cell’s rule across its own column and starts it there', () => {
  const band = columns(CELLS, { width: 119, gap: 2 });
  // 39 + 2 + 38 + 2 + 38 = 119: the odd column goes to the leftmost cell.
  assert.deepEqual(band.meta, {
    gap: 2,
    columns: [{ x: 1, width: 39, rows: 4 }, { x: 42, width: 38, rows: 3 }, { x: 82, width: 38, rows: 4 }],
  });
  assert.equal(visibleLength(band[0]), 119, 'the rule band fills the width');
  assert.equal(
    visible(band[0]),
    [rule('budget', null, 39), rule('live', null, 38), rule('so far', null, 38)].join('  '),
    'each cell’s rule is drawn across its own column',
  );
  for (const [index, region] of band.meta.columns.entries()) {
    assert.equal(visible(band[1]).slice(region.x - 1, region.x - 1 + region.width).trimEnd(), CELLS[index].rows[0]);
  }
});

test('columns honours a measured column width and falls back when it does not fit', () => {
  // The prototype’s Run triptych is 37/36/29, not three equal thirds.
  const measured = columns([
    { rule: 'budget', width: 37, rows: ['cmd 1.2%'] },
    { rule: 'live', width: 36, rows: ['widget-lib 15m/17m'] },
    { rule: 'so far', width: 29, rows: ['spent $1.05'] },
  ], { width: 119, gap: 2 });
  assert.deepEqual(measured.meta.columns.map((region) => region.width), [37, 36, 29]);
  assert.deepEqual(measured.meta.columns.map((region) => region.x), [1, 40, 78]);
  for (const line of measured) assert.ok(visibleLength(line) <= 119);

  // Asked for more than the band holds: an even split, never an overrun.
  const squeezed = columns([
    { rule: 'budget', width: 37, rows: ['cmd 1.2%'] },
    { rule: 'live', width: 36, rows: ['widget-lib'] },
  ], { width: 40, gap: 2 });
  assert.deepEqual(squeezed.meta.columns.map((region) => region.width), [19, 19]);
  for (const line of squeezed) assert.ok(visibleLength(line) <= 40);
});

test('columns cuts a row too wide for its column and pads a short one', () => {
  const band = columns([
    { rows: ['a project name far too long for twelve cells'] },
    { rows: ['x'] },
  ], { width: 26, gap: 2 });
  assert.equal(band.meta.columns[0].width, 12);
  assert.ok(visible(band[0]).startsWith('a project n…'), 'the long row is cut, not wrapped');
  assert.equal(visibleLength(band[0]) <= 26, true);
  assert.equal(visible(band[0]).slice(14), 'x', 'the short column is padded so the next starts on its column');
});

test('columns drops a cell it cannot give a column to, and survives nothing', () => {
  const tight = columns(CELLS, { width: 3, gap: 2 });
  assert.equal(tight.meta.columns.length, 1, 'cells that cannot fit are dropped from the right');
  for (const line of tight) assert.ok(visibleLength(line) <= 3);
  assert.deepEqual(columns([], { width: 40 }), []);
  assert.deepEqual(columns(null, { width: 40 }), []);
  assert.deepEqual(columns(undefined, {}), []);
  assert.deepEqual(columns(CELLS, { width: 0 }), []);
  assert.deepEqual(columns([{ rows: [] }, { rows: [] }], { width: 40 }), [], 'no rows, no block');
  assert.deepEqual(columns(null, { width: 40 }).meta, { gap: 2, columns: [] });
  const untitled = columns([{ rows: ['one'] }, { rows: ['two'] }], { width: 40 });
  assert.equal(untitled.length, 1, 'no cell names a rule, so no heading row is drawn');
});

test('columns and compactRow leak no unicode-only glyph of their own', () => {
  withEnv(ASCII_ENV, () => {
    const band = columns([{ rule: 'budget', rows: ['cmd 1.2%'] }, { rule: 'live', rows: ['x'] }], { width: 55 });
    // `─` and `…` are the two the glyph table documents as safe everywhere.
    for (const glyph of ['▇', '░', '▒', '▓', '█']) {
      assert.equal(band.join('\n').includes(glyph), false, `${glyph} reached an ascii terminal`);
      assert.equal(compactRow(FIELDS, { width: 40 }).includes(glyph), false);
    }
  });
});

test('compactRow gives the slack to the elastic field and pins the rest right', () => {
  for (const width of WIDTHS) {
    const row = compactRow(FIELDS, { width });
    assert.equal(visibleLength(row), width, `the elastic field fills ${String(width)}`);
    assert.ok(visible(row).startsWith('✓ gcxzza'), 'the fixed left fields keep their columns');
    assert.equal(row.includes('NaN'), false);
  }
  const row = compactRow(FIELDS, { width: 54 });
  assert.equal(visible(row), '✓ gcxzza  bullswarm · docs site …   41m · $2.10  16:41');
  assert.ok(visible(row).endsWith('16:41'), 'the trailing metric sits on the right edge');
  const wide = visible(compactRow(FIELDS, { width: 200 }));
  assert.ok(wide.includes('bullswarm · docs site rebuilt · 5/5'), 'nothing is cut when there is room');
  assert.ok(wide.endsWith('41m · $2.10  16:41'));
});

test('compactRow cuts the elastic field before it drops a field', () => {
  // A middle field far wider than the whole row: it shrinks to its floor and
  // ends in an ellipsis, and only then are fields dropped from the right.
  const huge = compactRow([
    { text: 'x', width: 1 },
    { text: 'y'.repeat(500), grow: true },
    { text: 'zz', width: 2 },
  ], { width: 12 });
  assert.equal(visibleLength(huge), 12);
  assert.equal(visible(huge), 'x yyyyyy… zz', 'the middle is cut, the outer fields stay');
  assert.ok(visible(huge).endsWith('zz'), 'nothing was dropped while cutting still fitted');

  const dropped = visible(compactRow([
    { text: 'label' },
    { text: 'y'.repeat(500), grow: true },
    { text: 'zz' },
  ], { width: 8 }));
  assert.ok(visibleLength(dropped) <= 8);
  assert.ok(dropped.startsWith('label'), 'the field that says what the row is never drops');

  const tiny = visible(compactRow([{ text: 'label' }, { text: 'y'.repeat(50), grow: true }], { width: 4 }));
  assert.equal(tiny, 'lab…', 'narrower than the first field: the row is cut, never overrun');
  assert.equal(compactRow(FIELDS, { width: 0 }), '');
  for (let width = 32; width <= 200; width += 1) {
    assert.ok(visibleLength(compactRow(FIELDS, { width })) <= width, `overran ${String(width)}`);
  }
});

test('compactRow takes a bare string, a right-aligned field and its own gaps', () => {
  assert.equal(compactRow(['finished', '4', '✓ 3 · ✗ 1'], { width: 40 }), 'finished 4 ✓ 3 · ✗ 1');
  assert.equal(compactRow(['a', 'b'], { width: 40, gap: 4 }), 'a    b');
  assert.equal(compactRow([{ text: 'a' }, { text: 'b', gap: 0 }], { width: 40 }), 'ab');
  assert.equal(
    compactRow([{ text: 'spent', grow: true }, { text: '$6.40', width: 9, align: 'right' }], { width: 20 }),
    'spent          $6.40',
  );
  assert.equal(compactRow([], { width: 40 }), '');
  assert.equal(compactRow(null, { width: 40 }), '');
  assert.equal(compactRow([null, undefined, { text: 'kept' }], { width: 40 }), 'kept');
  assert.equal(compactRow([{ text: 'x' }, { text: '', grow: true }, { text: 'y' }], { width: 10 }), 'x        y');
});

test('compactRow measures a styled field by its visible cells', () => {
  const row = compactRow([
    { text: '\x1b[1mfinished\x1b[0m', width: 8 },
    { text: '\x1b[38;2;169;156;240ma long middle that will be cut\x1b[0m', grow: true },
    { text: '\x1b[2m16:41\x1b[0m', width: 5 },
  ], { width: 30 });
  assert.equal(visibleLength(row), 30);
  assert.ok(row.includes('\x1b[1m'), 'the escapes a field carries survive');
  assert.ok(visible(row).endsWith('16:41'));
});

test('niceStep rounds an axis to a readable step and lists its ticks', () => {
  assert.deepEqual(niceStep(12.85), { step: 5, ticks: [0, 5, 10, 15] });
  assert.deepEqual(niceStep(100), { step: 50, ticks: [0, 50, 100] });
  assert.deepEqual(niceStep(1), { step: 0.5, ticks: [0, 0.5, 1] });
  assert.deepEqual(niceStep(8, 8), { step: 1, ticks: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  const { step, ticks } = niceStep(293);
  assert.ok([1, 2, 5, 10].includes(step / 10 ** Math.floor(Math.log10(step))), 'a 1/2/5/10 step');
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1] >= 293, 'the axis covers the maximum');
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.ok(ticks.length <= 6);
  for (const value of [0, -4, null, undefined, Number.NaN, Infinity, 'nonsense']) {
    assert.deepEqual(niceStep(value), { step: 0, ticks: [0] }, `nothing to scale for ${String(value)}`);
  }
  assert.deepEqual(niceStep(10, 0), { step: 5, ticks: [0, 5, 10] });
  assert.equal(niceStep(1e9).ticks.includes(Number.NaN), false);
});

test('the shared formatter rounds money, rates and durations once', () => {
  assert.equal(formatDashboardValue(3.248556, 'money'), '$3.25');
  assert.equal(formatDashboardValue(0.022846, 'rate'), '0.0228%/min');
  assert.equal(formatDashboardValue(79.9999 * 60, 'minutes'), '80h');
  assert.equal(formatDashboardValue(null, 'money'), null);
});

test('cut truncates to visible cells with an ellipsis', () => {
  assert.equal(cut('hello', 10), 'hello');
  assert.equal(cut('hello world', 8), 'hello w…');
  assert.equal(cut('hello', 5), 'hello');
  assert.equal(cut('hello', 1), '…');
  assert.equal(cut('hello', 0), '');
  assert.equal(cut(null, 4), '');
  assert.equal(cut(undefined, 4), '');
  assert.equal(cut(12345, 3), '12…');
  assert.equal(cut('héllo wörld', 6).length, 6, 'cells, not bytes');
  const line = cut('\x1b[38;2;182;189;115mabcdefghij\x1b[0m', 4);
  assert.equal(visibleLength(line), 4);
  assert.equal(visible(line), 'abc…');
  assert.ok(line.startsWith('\x1b[38;2;182;189;115m'), 'the escapes it keeps are kept whole');
  assert.ok(line.endsWith('\x1b[0m'), 'nothing is left open past the cut');
  for (const width of WIDTHS) assert.equal(visibleLength(cut('x'.repeat(400), width)), width);
  assert.equal(cut('x'.repeat(400), Number.NaN).length, 20, 'an unusable width falls back');
});

test('no function paints past its width from 32 to 200 columns', () => {
  const cases = [
    (width) => rule('today', 'history ›', width),
    (width) => tabsRow(TABS, { active: 'stats', width }).text,
    (width) => periodToggle(PERIODS, { active: 'all', width }).text,
    (width) => shareBar([{ value: 4, glyph: '▓' }, { value: 3, glyph: '▒' }, { value: 3, glyph: '░' }], { width }),
    (width) => sparkline([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9], width),
    (width) => progressBar(0.42, width),
    (width) => stackedBars(ROWS, { width }).join('\n'),
    (width) => columnBars([{ values: [1, 36] }], ['a', 'b'], { width, colors: false }).join('\n'),
    (width) => heatRow([0.2, 0.4, 0.6, 0.8, 1], { width }),
    (width) => columns(CELLS, { width }).join('\n'),
    (width) => compactRow(FIELDS, { width }),
    (width) => cut('a long line that has to be cut back', width),
  ];
  for (let width = 32; width <= 200; width += 1) {
    for (const [index, draw] of cases.entries()) {
      for (const line of String(draw(width)).split('\n')) {
        assert.ok(visibleLength(line) <= width, `case ${String(index)} at ${String(width)}: "${visible(line)}"`);
        assert.equal(visible(line).includes('NaN'), false, `case ${String(index)} at ${String(width)}`);
      }
    }
  }
});

test('no primitive leaks a unicode-only glyph once ascii mode is on', () => {
  // The bars, the spark and the heat shades; `─` and `…` are the two the
  // glyph table documents as safe everywhere and stay.
  const unicodeOnly = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▓', '▒', '░'];
  withEnv(ASCII_ENV, () => {
    const rendered = [
      rule('today', 'history ›', 55),
      tabsRow(TABS, { active: 'stats', width: 55 }).text,
      periodToggle(PERIODS, { active: 'all', width: 55 }).text,
      shareBar([{ value: 4, glyph: '▓' }, { value: 3, glyph: '▒' }, { value: 3, glyph: '░' }], { width: 30 }),
      sparkline([3, 1, 4, 1, 5, 9, 2, 6], 8),
      progressBar(0.42, 12),
      stackedBars(ROWS, { width: 55 }).join('\n'),
      columnBars([{ values: [1, 36] }], ['a', 'b'], { width: 55 }),
      heatRow([0, 0.5, 1, null], { ansi: false }),
      columns(CELLS, { width: 55 }).join('\n'),
      compactRow(FIELDS, { width: 55 }),
      cut('a label that is far too long for this narrow line', 20),
    ].join('\n');
    const leaked = unicodeOnly.filter((glyph) => rendered.includes(glyph));
    assert.deepEqual(leaked, [], `these glyphs still reach an ascii terminal: ${leaked.join(' ')}`);
  });
  withEnv(UNICODE_ENV, () => {
    const rendered = [sparkline([0, 1], 2), progressBar(1, 2), shareBar([{ value: 1 }], { width: 2 })].join('');
    assert.ok(unicodeOnly.some((glyph) => rendered.includes(glyph)), 'unicode mode really draws them');
  });
});

test('every primitive survives null, empty and junk data without NaN', () => {
  const junk = [null, undefined, [], {}, Number.NaN, '', 0, -1, Infinity];
  for (const value of junk) {
    const rendered = [
      rule('today', 'history ›', 40),
      tabsRow(TABS, { active: value, width: 40 }).text,
      periodToggle(PERIODS, { active: value }).text,
      shareBar([{ value }, { value: 1 }], { width: 10 }),
      sparkline([value, 1, value], 8),
      progressBar(value, 8),
      stackedBars([{ label: 'pool', segments: [{ value }] }], { width: 40 }).join('\n'),
      columnBars([{ values: [value, 1] }], ['a', 'b'], { width: 40, colors: false }).join('\n'),
      heatRow([value, 0.5, value], { width: 10 }),
      columns([{ rule: 'budget', rows: ['a row'], width: value }, { rows: value }], { width: 40, gap: value }).join('\n'),
      compactRow([{ text: 'id', width: value }, { text: 'middle', grow: true, min: value }, { text: 'end', gap: value }], { width: 40, gap: value }),
      JSON.stringify(niceStep(value)) + JSON.stringify(niceStep(1, value)),
      cut('text', 8),
    ].join('\n');
    assert.equal(rendered.includes('NaN'), false, `no NaN for ${JSON.stringify(value)}`);
    assert.equal(rendered.includes('undefined'), false, `no undefined for ${JSON.stringify(value)}`);
  }
  // Junk in every argument position at once: nothing throws, nothing invents.
  for (const value of junk) {
    assert.doesNotThrow(() => {
      rule(value, value, value);
      tabsRow(value, { active: value, width: value, hidden: value });
      periodToggle(value, { active: value, width: value });
      shareBar(value, { width: value, colors: value });
      sparkline(value, value);
      progressBar(value, value);
      stackedBars(value, { width: value, colors: value });
      columnBars(value, value, { width: value, colors: value });
      heatRow(value, { width: value, ansi: value });
      columns(value, { width: value, gap: value });
      compactRow(value, { width: value, gap: value });
      niceStep(value, value);
      cut(value, value);
    }, `nothing throws for ${JSON.stringify(value)}`);
  }
  assert.equal(heatRow([null, Number.NaN, undefined], { ansi: false }), '· · ·', 'no reading, no cell');
  assert.equal(sparkline([null, Number.NaN, undefined], 3), '', 'no reading, no sparkline');
});

test('columnBars keeps one blank cell between per-column totals, rounding a long duration to hours', () => {
  // Seven phone columns at 55 cells give a six-cell column: `16h34m` would fill
  // it and run into the next total, as the owner's phone capture showed.
  const series = [{ name: 'opus', color: '#a99be0', values: [424, 34, 994, 232, 1154, 2529, 523] }];
  const labels = ['12', '13', '14', '15', '16', '17', 'now'];
  const chart = columnBars(series, labels, { width: 55, height: 8, unit: 'minutes', totals: true, colors: false });
  const valuesLine = visible(chart[chart.meta.valueRow - 1]);
  const totals = valuesLine.trim().split(/\s+/);
  assert.equal(totals.length, 7, `seven separate totals, got: ${valuesLine}`);
  for (const total of totals) assert.match(total, /^(\d+h(\d\dm)?|\d+m)$/, `total "${total}" is one duration`);
  assert.ok(totals.includes('17h'), `16h34m compacts to whole hours: ${valuesLine}`);
  assert.ok(totals.includes('42h'), `42h09m compacts to whole hours: ${valuesLine}`);
  assert.ok(totals.includes('34m'), 'a short total keeps its full text');
});

test('seriesColors gives every series in one chart its own hue and keeps a name stable across sets', () => {
  const names = ['claude-opus-5', 'grok-4.6', 'deepseek/deepseek-v4.1-flash', 'claude-sonnet-5', 'gpt-5.6-luna', 'opencode/union-alpha', 'gpt-5.6-sol', 'unknown'];
  const colors = seriesColors(names);
  const hues = names.filter((name) => name !== 'unknown').map((name) => colors.get(name));
  assert.equal(new Set(hues).size, hues.length, `seven models, seven hues: ${hues.join(' ')}`);
  assert.equal(colors.get('unknown'), seriesColor('unknown'), 'unknown keeps its reserved grey');
  // The first name in a set always starts from its own colour, so a pool
  // drawn alone or first keeps the same hue from one period to the next.
  assert.equal(seriesColors(['grok-4.6']).get('grok-4.6'), seriesColor('grok-4.6'));
  assert.equal(seriesColors(['grok-4.6', 'codex']).get('grok-4.6'), seriesColor('grok-4.6'));
});

test('columnBars stacks the smallest slice at the bottom and the biggest on top', () => {
  const chart = columnBars([
    { name: 'big', color: '#a99cf0', values: [12] },
    { name: 'small', color: '#bf6c69', values: [2] },
    { name: 'mid', color: '#b6bd73', values: [6] },
  ], ['d'], { width: 40, height: 10, colors: true });
  const stack = chart.meta.columns?.[0]?.stack ?? chart.meta.stacks?.[0];
  if (stack) {
    assert.deepEqual(stack.map((slice) => slice.name), ['small', 'mid', 'big']);
  } else {
    // Fall back to reading the paint: the bottom painted row carries the small slice's colour.
    const rows = chart.slice(0, chart.meta.chartRows);
    const bottom = rows.at(-1); const top = rows.find((line) => /[█▁▂▃▄▅▆▇]/.test(line));
    assert.ok(bottom.includes('bf6c69') || bottom.includes('191;108;105'), 'small slice is at the bottom');
    assert.ok(top.includes('a99cf0') || top.includes('169;156;240'), 'big slice is on top');
  }
});

test('columnBars exposes slice geometry that tiles each rendered column', () => {
  const chart = columnBars([
    { name: 'luna', values: [1, 3] },
    { name: 'sol', values: [1, 1] },
  ], ['day one', 'day two'], { width: 55, rowCount: 8, colors: false });
  assert.equal(chart.meta.slices.length, 4);
  for (const [index, column] of chart.meta.columns.entries()) {
    const slices = column.slices;
    assert.equal(slices, column.segments);
    assert.ok(slices.every((slice) => slice.columnIndex === index));
    assert.ok(slices.every((slice) => slice.seriesName === slice.name && slice.value > 0));
    assert.ok(slices.every((slice) => slice.columnStart <= slice.columnEnd));
    const ordered = [...slices].sort((a, b) => a.rowStart - b.rowStart);
    assert.equal(ordered[0].rowStart, chart.meta.chartRows - column.height + 1);
    assert.equal(ordered.at(-1).rowEnd, chart.meta.chartRows);
    for (let at = 1; at < ordered.length; at += 1) {
      assert.equal(ordered[at - 1].rowEnd + 1, ordered[at].rowStart);
    }
  }
});
