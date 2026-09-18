import { test } from 'node:test';
import { SERIES_PALETTE } from '../src/workflow/dash-kit.js';
import assert from 'node:assert/strict';
import { statsLines } from '../src/workflow/stats-view.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';
import { seriesColor } from '../src/workflow/dash-kit.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line) => String(line ?? '').replace(SGR, '');
const WIDTHS = [54, 55, 80, 100, 200];
/** The three frames the goal names, in the painted widths frameWidth() hands down. */
const FRAMES = [[54, 26], [120, 40], [200, 50]];

/** Every `$` the frame paints with no `≈` in front of it — rule 11's sweep. */
function unmarkedDollars(text) {
  const source = String(text ?? '');
  return [...source.matchAll(/\$/g)]
    .map((match) => match.index)
    .filter((index) => !source.slice(Math.max(0, index - 2), index).includes('≈'));
}

/** Thirty real local days from 19 Aug, so the heat grid spans two months. */
const heatDays = Array.from({ length: 30 }, (_, index) => {
  const at = new Date(2026, 7, 19 + index, 12);
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return {
    date,
    weekday: (at.getDay() + 6) % 7,
    value: (index % 5) / 4,
    inHistory: index > 2,
    runs: index % 4,
  };
});

const overview = {
  period: '7d',
  keys: {
    workflows: 5,
    activeDays: 4,
    totalAgentMinutes: 97,
    medianRunMinutes: 38,
    longestRunMinutes: 100,
    favouritePool: { name: 'claude-code', attempts: 4 },
    favouriteModel: { name: 'claude-opus-5', attempts: 4 },
    busiestProject: { name: 'bullswarm', runs: 3 },
  },
  heat: {
    days: heatDays,
    spanDays: 27,
    max: 2,
  },
  breakdown: {
    pools: [{ name: 'claude-code', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: 0.37, workflowsCompleted: 2, minutesShare: 0.7, medianWallMinutes: 2.5, okShare: 2 / 3, live: { usedPct: 41, elapsedPct: 29 } }],
    models: [{ name: 'claude-opus-5', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: null, workflowsCompleted: 2, minutesShare: 1, medianWallMinutes: 2.5, okShare: 2 / 3 }],
    projects: [{ name: 'bullswarm', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: 0.37, workflowsCompleted: 2, minutesShare: 1, medianWallMinutes: 2.5, okShare: 2 / 3 }],
  },
};

const trend = {
  metric: 'runs',
  period: '7d',
  bucketBy: 'day',
  buckets: [
    { key: '2026-09-15', label: '2026-09-15', value: 3, segments: [{ name: 'claude-code', value: 3 }] },
    { key: '2026-09-16', label: '2026-09-16', value: 2, segments: [{ name: 'claude-code', value: 2 }] },
  ],
  total: 5,
  cumulative: [3, 5],
  segmentBasis: 'the pool with the most worker-minutes in each run',
};

/** The retained meter history, two pools over four days. */
function licenceRows() {
  return [
    { date: '2026-09-14', segments: [{ name: 'claude-code', value: 20 }, { name: 'codex', value: 12 }] },
    { date: '2026-09-15', segments: [{ name: 'claude-code', value: 48 }, { name: 'codex', value: 30 }] },
    { date: '2026-09-16', segments: [{ name: 'claude-code', value: 62 }] },
    { date: '2026-09-17', segments: [] },
  ];
}

/** One of the palette's hex values as the SGR truecolour triple it paints. */
function rgbTriple(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ].join(';');
}

const PAINTED = (hex) => new RegExp(`\\x1b\\[38;2;${rgbTriple(hex)}m`);
const paintedColours = (lines) => new Set(lines.flatMap((line) => [...String(line).matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((match) => match[1])));

function models({ withTrends = true, licence = true } = {}) {
  const stats = {
    overview,
    trend,
    pools: {
      rows: [
        ...overview.breakdown.pools,
        { name: 'codex', runs: 2, attempts: 3, minutes: 20, apiEquivalentUsd: null, workflowsCompleted: 2, minutesShare: 0.3, medianWallMinutes: 9, okShare: 1, live: { usedPct: null, elapsedPct: null } },
      ],
      mostUsed: 'claude-code',
      ...(licence ? { licencePerDay: licenceRows(), licence: { basis: 'live pool meters, each in its own pacing window (2 of 3 pools metered)' } } : {}),
    },
    models: { rows: overview.breakdown.models, mostUsed: 'claude-opus-5', notes: ['no per-model money: cost per pool, not per model'] },
    projects: { rows: overview.breakdown.projects, mostUsed: 'bullswarm' },
  };
  if (withTrends) {
    stats.models = {
      ...stats.models,
      trend: {
        metric: 'minutes', period: '7d', bucketBy: 'day',
        buckets: [
          { key: '2026-09-16', segments: [{ name: 'claude-opus-5', value: 42 }] },
          { key: '2026-09-17', segments: [{ name: 'claude-opus-5', value: 20 }] },
        ],
      },
    };
    stats.projects = {
      ...stats.projects,
      trend: {
        metric: 'runs', period: '7d', bucketBy: 'day',
        buckets: [
          { key: '2026-09-16', segments: [{ name: 'bullswarm', value: 1 }] },
          { key: '2026-09-17', segments: [{ name: 'bullswarm', value: 2 }] },
        ],
      },
    };
  }
  return stats;
}

test('Stats exposes every tab and period as the approved action kinds', () => {
  const view = statsLines(models(), { width: 120, tab: 'trends', period: '30d', metric: 'spend', ansi: false });
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'tab').map((region) => region.action.tab), [
    'overview', 'trends', 'pools', 'models', 'projects',
  ]);
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'period').map((region) => region.action.period), ['7d', '30d', 'all']);
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'metric').map((region) => region.action.metric), ['runs', 'verified', 'spend', 'minutes', 'licence']);
});

test('the metric chips take the prototype\'s words, and licence used only where the history reaches', () => {
  const withLicence = statsLines(models(), { width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const chips = visible(withLicence.lines.find((line) => line.includes('runs finished')));
  assert.match(chips, /runs finished/);
  assert.match(chips, /verified share/);
  assert.match(chips, /spent/);
  assert.match(chips, /licence used/);

  const without = statsLines(models({ licence: false }), { width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const text = without.lines.map(visible).join('\n');
  assert.equal(text.includes('licence used'), false, 'no licence chip without a retained meter history');
  assert.deepEqual(without.regions.filter((region) => region.action.kind === 'metric').map((region) => region.action.metric), ['runs', 'verified', 'spend', 'minutes']);
});

test('the licence trend charts history kept beside the pools table', () => {
  const view = statsLines({ licenceHistory: [{ date: '2026-09-16', value: 42 }] }, {
    width: 80, tab: 'trends', period: '7d', metric: 'licence', ansi: false,
  });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /── licence used · last 7 days · per day/);
  assert.match(text, /50%┤/);
  assert.match(text, /▏ reset/);
  assert.doesNotMatch(text, /Empty chart/);
});

test('every Stats tab and period is width-safe, including the phone frame', () => {
  for (const width of WIDTHS) {
    for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
      for (const period of ['7d', '30d', 'all']) {
        for (const metric of ['runs', 'spend', 'minutes', 'verified', 'licence']) {
          const view = statsLines(models(), { width, tab, period, metric, ansi: false });
          assert.ok(view.lines.length > 0);
          for (const line of view.lines) assert.ok(visible(line).length <= width, `${tab}/${period}/${metric}/${width}: ${line}`);
          for (const region of view.regions) {
            assert.ok(region.x >= 1);
            assert.ok(region.width >= 1);
            assert.ok(region.x + region.width - 1 <= width, `region overrun at ${tab}/${period}/${metric}/${width}`);
          }
        }
      }
    }
  }
});

test('every Stats page paints a body at the phone, desktop and wide frames', () => {
  for (const [width, height] of FRAMES) {
    for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
      const view = statsLines(models(), { width, tab, period: '7d', metric: 'runs', ansi: false });
      const painted = view.lines.map(visible).filter((line) => line.trim());
      assert.ok(painted.length >= 4, `${tab} at ${width} painted ${painted.length} rows`);
      assert.ok(view.lines.length <= height + 8, `${tab} at ${width} paints ${view.lines.length} rows past its ${height}-row frame`);
      for (const line of view.lines) assert.ok(visible(line).length <= width, `${tab} at ${width}: ${line}`);
    }
  }
});

/** One row per item at 55 columns: 54 painted, no row wider than the frame. */
test('the phone renders one row per item and never past 54 columns', () => {
  const view = statsLines(models(), { width: 54, tab: 'projects', period: '7d', metric: 'runs', ansi: false });
  const rows = view.lines.map(visible);
  for (const line of rows) assert.ok(line.length <= 54, line);
  // The prototype's phone form: one row per project — name, sparkline and
  // figures share it; the name is cut with … rather than wrapped.
  const name = rows.findIndex((line) => /^ bullswa…/.test(line));
  assert.ok(name > 0, rows.join('\n'));
  assert.match(rows[name], /▁█ · 3 runs · ✓ 67% · ≈ \$0\.37 API · 3m medi…$/);
  assert.equal(/^\s\S/.test(rows[name + 1] ?? ''), false, 'a project occupies exactly one row');
});

test('the heatmap is sized to the history that exists, with month labels and the four-shade ramp', () => {
  const view = statsLines(models(), { width: 120, tab: 'overview', period: '7d', metric: 'runs', ansi: false });
  const rows = view.lines.map(visible);
  const header = rows.findIndex((line) => /\bAug\b/.test(line) && /\bSep\b/.test(line));
  assert.ok(header > 0, rows.join('\n'));
  assert.equal(/[·░▒▓█]/.test(rows[header]), false, 'the month header carries no cells');
  // The grid is the history's own weeks, not a months-wide field of blanks.
  const heatRows = rows.slice(header + 1, header + 4);
  assert.ok(heatRows.every((line) => /(Mon|Wed|Fri)\s+[·░▒▓█]/.test(line)), heatRows.join('\n'));
  for (const line of heatRows) assert.ok(line.replace(/^ (Mon|Wed|Fri)\s+/, '').length <= 34, line);
  // Every shade of the palette's own ramp is reachable on the busiest days.
  const legend = rows.find((line) => line.includes('Less') && line.includes('More'));
  for (const shade of ['░', '▒', '▓', '█']) assert.ok(legend.includes(shade), `the ramp is missing ${shade}`);
  assert.match(legend, /measured days/);
});

test('the figure grid is three columns of four and carries the day and streak figures', () => {
  const view = statsLines(models(), { width: 120, tab: 'overview', period: '7d', metric: 'runs', ansi: false });
  const rows = view.lines.map(visible);
  const start = rows.findIndex((line) => line.includes('Workflows:'));
  assert.ok(start > 0, rows.join('\n'));
  const grid = rows.slice(start, start + 4);
  for (const line of grid) assert.ok(line.length <= 120, line);
  // Four figures per row, each in its own column: the second and third
  // columns start where the first row's own figures start.
  const [first, second, third] = [grid[0].indexOf('Workflows:'), grid[0].indexOf('Agent time:'), grid[0].indexOf('Spent:')];
  assert.ok(first >= 0 && second > first && third > second, grid[0]);
  assert.ok(grid[1].includes('Active days:') && grid[1].indexOf('Longest run:') > first, grid[1]);
  assert.ok(grid[1].indexOf('Favourite pool:') > second, grid[1]);
  assert.ok(grid[2].includes('Most active day:') && grid[2].includes('Current streak:') && grid[2].includes('Favourite model:'), grid[2]);
  assert.ok(grid[3].includes('Busiest project:') && grid[3].includes('Median run:') && grid[3].includes('Longest streak:'), grid[3]);
  // Median run is the key-value block's own median; the streaks and the
  // busiest day come off the heat grid's measured days.
  assert.match(grid[3], /Median run: 38m\b/);
  assert.match(grid.join('\n'), /Longest run: 1h40m/);
  assert.match(grid.join('\n'), /Most active day: \w{3} \d+ \w{3} \(\d+ runs\)/);
});

test('the phone keeps every figure the desktop grid carries, one row each', () => {
  const view = statsLines(models(), { width: 55, tab: 'overview', period: '7d', metric: 'runs', ansi: false });
  const text = view.lines.map(visible).join('\n');
  for (const label of ['Workflows:', 'Agent time:', 'Active days:', 'Most active day:', 'Longest run:', 'Favourite pool:', 'Favourite model:', 'Busiest project:', 'Median run:']) {
    assert.ok(text.includes(label), `${label} missing on the phone`);
  }
  assert.match(text, /Spent: ≈ \$0\.37 API/);
  assert.match(text, /longest streak/);
});

test('a trend with no data states why instead of drawing a zero axis', () => {
  const view = statsLines({ trend: { buckets: [], total: null, max: null, nulls: ['total'] } }, {
    width: 80, tab: 'trends', period: '30d', metric: 'spend', ansi: false,
  });
  const text = view.lines.join('\n');
  assert.match(text, /Empty chart/);
  assert.match(text, /recorded API-equivalent|API-equivalent/);
  assert.equal(text.includes('$0'), false);
});

test('trend bars carry a drill region with the chosen metric and bucket', () => {
  const view = statsLines(models(), { width: 80, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const bars = view.regions.filter((region) => region.action.kind === 'trend');
  const actions = [...new Map(bars.map((region) => [region.action.bucket, region.action])).values()];
  assert.equal(actions.length, 2);
  assert.deepEqual(actions, [
    { kind: 'trend', metric: 'runs', period: '7d', bucket: '2026-09-15' },
    { kind: 'trend', metric: 'runs', period: '7d', bucket: '2026-09-16' },
  ]);
  assert.notEqual(view.lines.findIndex((line) => line.includes('3')), -1, 'the value row is visible');
});

test('the running total is drawn as the chart\'s own row, not named beside it', () => {
  const view = statsLines(models(), { width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const rows = view.lines.map(visible);
  const chartStart = rows.findIndex((line) => line.startsWith('── runs finished'));
  assert.ok(chartStart > 0, rows.join('\n'));
  const totalRow = rows.findIndex((line) => line.trimStart().startsWith('total'));
  assert.ok(totalRow > chartStart, rows.join('\n'));
  assert.match(rows[totalRow], /total\s+3\s+5/, 'each column carries its running total');
  assert.match(rows.join('\n'), /5 runs over last 7 days/);
  assert.equal(/· running total/.test(rows.join('\n')), false);
});

test('Trends stacks are coloured per pool and the legend wraps, never truncated', () => {
  const many = { ...trend, buckets: Array.from({ length: 7 }, (_, index) => ({
    key: `2026-09-${String(11 + index).padStart(2, '0')}`,
    value: 1,
    segments: Object.entries({
      'claude-code': 1, codex: 1, grok: 1, 'command-code': 1, opencode2: 1, echo: 1, 'kaihk-3/gpt-5.6-luna': 1, 'claude-code:acme': 1,
    }).map(([name, value]) => ({ name, value })),
  })) };
  const view = statsLines({ trend: many }, { width: 120, tab: 'trends', period: '7d', metric: 'spend', ansi: true });
  const legend = view.lines.find((line) => line.includes('claude-code') && line.includes('█'));
  assert.ok(legend, view.lines.map(visible).join('\n'));
  assert.equal(visible(legend).length <= 120, true);
  for (const line of view.lines) assert.ok(visible(line).length <= 120, line);
  // Eight series, eight distinct colours: the marks are the palette's own.
  const colors = paintedColours([legend]);
  assert.ok(colors.size >= 2, 'the legend marks are not all one colour');
  for (const triple of colors) {
    assert.ok([...Object.values(METER_COLORS), ...SERIES_PALETTE].some((hex) => typeof hex === 'string' && rgbTriple(hex) === triple), `unpalette colour ${triple}`);
  }
  // The chart itself paints the same colours as its legend.
  // The first chart row itself contains the bar glyph; stop before the
  // legend, rather than slicing at that first bar row.
  const legendIndex = view.lines.findIndex((line) => visible(line).includes('claude-code') && visible(line).includes('█'));
  const chart = view.lines.slice(0, legendIndex);
  assert.ok(paintedColours(chart).size >= 2, 'the stacks are painted per pool');

  // Nine series do not fit one 55-column row: the legend wraps onto more
  // rows, names every series, and never cuts a name mid-glyph.
  const crowded = { ...many, buckets: [...many.buckets, ...many.buckets.map((bucket) => ({ ...bucket, key: `${bucket.key}x` }))] };
  const narrow = statsLines({ trend: many }, { width: 55, tab: 'trends', period: '7d', metric: 'spend', ansi: false });
  const narrowText = narrow.lines.map(visible).join('\n');
  assert.doesNotMatch(narrowText, /\+\d+ more/, 'no name hides behind +N more');
  const legendRows = narrow.lines.map(visible).filter((line) => line.includes('█') && /[a-z]/.test(line) && !line.includes('┤'));
  assert.ok(legendRows.length >= 2, `a crowded legend wraps: ${legendRows.join(' | ')}`);
  assert.ok(legendRows.every((line) => !line.includes('…')), 'a wrapped legend never truncates a name');
  assert.ok(narrow.lines.every((line) => visible(line).length <= 55));
  assert.ok(crowded.buckets.length > many.buckets.length);
});

test('model cost stays blank with its reason, never a made-up share of a licence', () => {
  const view = statsLines(models(), { width: 120, tab: 'models', period: '7d', ansi: false });
  const text = view.lines.join('\n');
  assert.match(text, /cost per pool, not per model/);
  assert.equal(text.includes('licence share'), false);
  assert.equal(text.includes('$'), false);
});

test('the model list is keyed by colour to its chart, with the ok-rate beside the attempts', () => {
  const view = statsLines(models(), { width: 120, tab: 'models', period: '7d', ansi: true });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /── worker-minutes per day/);
  assert.match(text, /● claude-opus-5 \(100%\)/);
  assert.match(text, /4 attempts · 67% ok · p50 3m/);
  assert.match(text, /Share is measured worker-minutes, not a licence draw\./);
  // The bullet's colour is the same colour the chart draws that model's line.
  const colours = [];
  for (const line of view.lines) {
    const bullet = /\x1b\[38;2;(\d+;\d+;\d+)m●/.exec(String(line));
    if (bullet) colours.push(bullet[1]);
  }
  assert.equal(colours.length, 1, 'one model row is marked');
  const chart = view.lines.slice(0, view.lines.findIndex((line) => visible(line).includes('●')));
  assert.ok(chart.some((line) => String(line).includes(`\x1b[38;2;${colours[0]}m`)), 'the chart draws that model\'s line');
  assert.equal(text.includes('spend per day'), false, 'the chart is worker-minutes: no per-model money exists');
});

test('the models chart is real worker-minutes from the model\u2019s own daily series, and the page says so', () => {
  // The product's real shape: a modelsModel payload with the per-model daily
  // series and the basis of how many rows carried it. No per-model cost
  // exists in the data, so the axis is worker-minutes and says so.
  const stats = models({ withTrends: false });
  stats.models = {
    ...stats.models,
    seriesRows: 179,
    seriesTotalRows: 296,
    trend: {
      metric: 'minutes', unit: 'worker-minutes', period: '7d', bucketBy: 'day',
      buckets: [
        { key: '2026-09-15', segments: [{ name: 'claude-opus-5', value: 40, minutes: 40, attempts: 2 }] },
        { key: '2026-09-16', segments: [{ name: 'claude-opus-5', value: 30, minutes: 30, attempts: 1 }, { name: 'gpt-5.6', value: 12, minutes: 12, attempts: 1 }] },
      ],
    },
  };
  const view = statsLines(stats, { width: 120, tab: 'models', period: '7d', ansi: true });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /── worker-minutes per day/);
  assert.equal(text.includes('No per-model daily series'), false, 'the real series is drawn');
  assert.ok(view.lines.some((line) => String(line).includes('┤') && String(line).includes('█')), 'the stacked column chart itself is drawn');
  // Two series on the chart, two distinct palette colours, and the legend
  // names both (gpt-5.6 comes from the buckets' segments, not the list).
  assert.match(text, /█ claude-opus-5 · █ gpt-5.6/);
  const legend = view.lines.find((line) => visible(line).includes('█ claude-opus-5'));
  const legendColors = paintedColours([legend]);
  // The marks carry both series colours (the dim `·` separator is a third).
  assert.ok(legendColors.has(rgbTriple(seriesColor('claude-opus-5'))) && legendColors.has(rgbTriple(seriesColor('gpt-5.6'))), 'legend marks carry the stable series colours');
  assert.match(text, /179 of 296 rollups carried the per-model series/);
  assert.match(text, /● claude-opus-5 \(100%\)/);
  assert.match(text, /4 attempts · 67% ok · p50 3m/);
});

test('a model page with no per-model series says so instead of inventing an axis', () => {
  const view = statsLines(models({ withTrends: false }), { width: 120, tab: 'models', period: '7d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /No per-model daily series is loaded/);
  assert.equal(text.includes('┼'), false, 'no axis is drawn');
  assert.match(text, /● claude-opus-5/);
});

test('Projects puts a sparkline beside each name and one context row under it', () => {
  const view = statsLines(models(), { width: 120, tab: 'projects', period: '7d', ansi: true });
  const rows = view.lines.map(visible);
  const name = rows.findIndex((line) => line.trim().startsWith('bullswarm'));
  assert.ok(name > 0, rows.join('\n'));
  assert.match(rows[name], /^ bullswarm\s+[▁▂▃▄▅▆▇█]{2}/);
  assert.match(rows[name + 1], /^\s+3 runs · ✓ 67% · ≈ \$0\.37 API · 3m median$/);
  const spark = view.lines[name];
  assert.ok(String(spark).includes('\x1b[38;2;'), 'the sparkline is painted');
  assert.ok(String(spark).includes(`\x1b[38;2;${rgbTriple(METER_COLORS.orange)}m`), 'orange, as the frame draws it');
  // Every project row and its context row open History.
  assert.ok(view.regions.some((region) => region.y === name + 1 && region.action.page === 'history'));
});

test('Projects keeps an unavailable-series note honest and paints it with the shared grey role', () => {
  const stats = models({ withTrends: false });
  const view = statsLines(stats, { width: 55, tab: 'projects', period: '7d', ansi: true });
  const note = view.lines.find((line) => visible(line).includes('No per-project daily series'));
  assert.ok(note, view.lines.map(visible).join('\n'));
  assert.match(String(note), PAINTED(METER_COLORS.dim));
  assert.equal(view.lines.map(visible).join('\n').includes('▁'), false, 'the reason does not invent a sparkline');
});

test('Projects can draw a sparkline directly from row.daily objects', () => {
  const stats = models({ withTrends: false });
  stats.projects = {
    rows: [{
      ...overview.breakdown.projects[0],
      daily: [
        { date: '2026-09-15', runs: 1, minutes: 4 },
        { date: '2026-09-16', runs: 3, minutes: 9 },
      ],
    }],
  };
  const view = statsLines(stats, { width: 120, tab: 'projects', period: '7d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /^ bullswarm\s+[▁▂▃▄▅▆▇█]{2}/m);
  assert.equal(text.includes('No per-project daily series'), false);
});

test('wide Stats pages use the 200-column composition, including Projects', () => {
  for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
    const view = statsLines(models(), { width: 200, tab, period: '7d', metric: 'runs', ansi: false });
    const max = Math.max(...view.lines.map((line) => visible(line).length));
    assert.equal(max, 200, `${tab} should use the supplied wide frame`);
    for (const line of view.lines) assert.ok(visible(line).length <= 200, `${tab}: ${line}`);
  }
});

test('the ≈ appears wherever the prototype\'s $ appears', () => {
  for (const width of [54, 55, 120, 200]) {
    for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
      const view = statsLines(models(), { width, tab, period: '7d', metric: 'spend', ansi: false });
      assert.deepEqual(unmarkedDollars(view.lines.map(visible).join('\n')), [], `${tab} at ${width}`);
    }
  }
});

test('a spend bucket with no recorded estimate is a blank with its reason, never $0', () => {
  const spendTrend = {
    metric: 'spend',
    period: '7d',
    bucketBy: 'day',
    buckets: [
      { key: '2026-09-15', label: '2026-09-15', value: 0.12, segments: [{ name: 'claude-code', value: 0.12 }] },
      { key: '2026-09-16', label: '2026-09-16', value: null, segments: [] },
      { key: '2026-09-17', label: '2026-09-17', value: 1.245, segments: [{ name: 'claude-code', value: 1.245 }] },
    ],
    total: 1.365,
    cumulative: [0.12, null, 1.365],
    segmentBasis: 'the recorded API-equivalent estimate per pool',
  };
  for (const width of [120, 55, 54]) {
    const view = statsLines({ trend: spendTrend }, {
      width, tab: 'trends', period: '7d', metric: 'spend', ansi: false,
    });
    const lines = view.lines.map(visible);
    const text = lines.join('\n');
    assert.ok(text.includes('$'), `the frame paints money at ${String(width)}`);
    assert.deepEqual(unmarkedDollars(text), [], `a money figure at ${String(width)} has no ≈`);
    const chartStart = lines.findIndex((line) => line.startsWith('── spent'));
    const axisRow = lines.findIndex((line) => line.includes('┼'));
    assert.ok(chartStart > 0 && axisRow > chartStart, `the chart draws its axis at ${String(width)}`);
    for (const line of lines.slice(chartStart + 1, axisRow)) {
      const tick = line.split('┤')[0].trim();
      if (tick) assert.match(tick, /^≈\$/, `the tick "${tick}" at ${String(width)} carries the mark`);
    }
    assert.match(lines[axisRow + 1], /≈\$0\.1/, 'the value row is marked');
    // The running-total row is drawn, and the blank day keeps its blank.
    const totalRow = lines.find((line) => line.trimStart().startsWith('total'));
    assert.match(totalRow, /≈\$0\.12\s+≈\$1\.37/, 'the running total is drawn and marked');
    assert.match(lines.find((line) => line.startsWith(' ≈ $1.36')), /≈ \$1\.36 API/, 'the closing figure keeps its mark');
  }
});

test('the spend chart states its basis in one line at both widths', () => {
  const spendTrend = {
    metric: 'spend',
    period: '7d',
    bucketBy: 'day',
    buckets: [{ key: '2026-09-15', label: '2026-09-15', value: 0.12, segments: [{ name: 'claude-code', value: 0.12 }] }],
    total: 0.12,
    cumulative: [0.12],
  };
  for (const width of [120, 55, 54]) {
    const view = statsLines({ trend: spendTrend }, {
      width, tab: 'trends', period: '7d', metric: 'spend', ansi: false,
    });
    const lines = view.lines.map(visible);
    const basis = lines.filter((line) => line.includes('API-equivalent estimate'));
    assert.equal(basis.length, 1, `exactly one basis line at ${String(width)}: ${lines.join(' | ')}`);
    assert.ok(basis[0].length <= width, `the basis line fits ${String(width)}`);
  }
  const wide = statsLines({ trend: spendTrend }, { width: 120, tab: 'trends', period: '7d', metric: 'spend', ansi: false })
    .lines.map(visible).join('\n');
  assert.match(wide, /Basis: ≈ \$ API-equivalent estimates, recorded per attempt/, 'the desktop frame names the source');
  const phone = statsLines({ trend: spendTrend }, { width: 55, tab: 'trends', period: '7d', metric: 'spend', ansi: false })
    .lines.map(visible).join('\n');
  assert.match(phone, /≈ \$ API-equivalent estimate · — = none recorded/, 'the phone frame keeps the same wording');
});

test('a measured metric carries no estimate mark and no money basis', () => {
  const view = statsLines(models(), { width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /5 runs over last 7 days/, 'the runs chart still totals as a count');
  assert.equal(text.includes('≈'), false, 'a count is a measurement, not an estimate');
  assert.equal(text.includes('API-equivalent estimate, recorded'), false, 'and it states no money basis');
});

test('Overview rounds total minutes before splitting hours and paints the heat it has', () => {
  const fixture = models();
  fixture.overview = {
    ...overview,
    keys: { ...overview.keys, totalAgentMinutes: 79.9999 * 60 },
  };
  const text = statsLines(fixture, { width: 120, tab: 'overview', ansi: false }).lines.map(visible);
  assert.ok(text.some((line) => /Mon\s+.*[░▒▓█]/.test(line)), text.join('\n'));
  assert.ok(text.some((line) => /Wed\s+.*[░▒▓█]/.test(line)), text.join('\n'));
  assert.ok(text.some((line) => /Fri\s+.*[░▒▓█]/.test(line)), text.join('\n'));
  assert.match(text.join('\n'), /Agent time: 80h(?:\s|·|$)/);
  assert.doesNotMatch(text.join('\n'), /79h60m/);
});

test('Pools gives each pool its own seven-day reset-marked sparkline and complete tails', () => {
  const fixture = models();
  fixture.pools.rows[1].live = { usedPct: 30, elapsedPct: 40 };
  fixture.pools.licencePerDay = Array.from({ length: 8 }, (_, index) => ({
    date: `2026-09-${10 + index}`,
    segments: [
      { name: 'claude-code', value: [90, 10, 20, 30, 40, 50, 60, 70][index], reset: index === 1 },
      { name: 'codex', value: [10, 20, 30, 40, 50, 5, 10, 15][index], reset: index === 5 },
    ],
  }));
  for (const width of [55, 60, 170, 200]) {
    const view = statsLines(fixture, { width, tab: 'pools', period: '7d', ansi: true });
    const rows = view.lines.map(visible);
    assert.doesNotMatch(rows.join('\n'), /100%┤|licence used per day, by pool/);
    assert.match(rows.find((line) => line.includes('claude-code')), /▏▂▃▅▆▇█/);
    assert.match(rows.find((line) => line.includes('codex') && line.includes('30%')), /▃▅▆█▏▂▃/);
    assert.match(rows.join(' ').replace(/\s+/g, ' '), /a drop after ▏ is the window resetting/);
    if (width >= 170) {
      assert.match(rows.find((line) => line.includes('claude-code')), /3 runs · ✓ 67% · ≈ \$0.37 API$/);
      assert.match(rows.find((line) => line.includes('codex') && line.includes('30%')), /2 runs · ✓ 100%$/);
    }
    assert.ok(rows.every((line) => line.length <= width));
  }
});

test('a pool with no meter uses words without an empty track', () => {
  const view = statsLines(models(), { width: 120, tab: 'pools', period: '7d', ansi: false });
  const row = view.lines.map(visible).find((line) => line.includes('codex'));
  assert.ok(row, view.lines.map(visible).join('\n'));
  // The name keeps the metered rows' one-cell indent, and the reason starts in
  // the column their meter bar starts in.
  assert.match(row, /^ codex\s+meter unavailable · 2 runs · ✓ 100%/);
  assert.doesNotMatch(row, /[░▇]|·{2,}/);
  assert.equal(/(^|\D)0%\b/.test(row), false, 'an unmeasured pool is never painted as zero');
  const meters = view.regions.filter((region) => region.action.kind === 'page' && region.action.page === 'budget');
  assert.deepEqual(meters.map((region) => region.action.pool).sort(), ['claude-code', 'codex']);
});

test('the live meters read the pace word, not the used/elapsed pair', () => {
  const view = statsLines(models(), { width: 120, tab: 'pools', period: '7d', ansi: false });
  const rows = view.lines.map(visible);
  const row = rows.find((line) => line.includes('claude-code') && line.includes('41%'));
  assert.ok(row, rows.join('\n'));
  assert.match(row, /41% · on track/);
  assert.equal(/41% used/.test(rows.join('\n')), false);
  assert.equal(/elapsed/.test(rows.join('\n')), false);
});

test('a period with no meter history states the empty state instead of an axis', () => {
  const fixture = models();
  fixture.pools = { ...fixture.pools, licencePerDay: null, meterHistoryReason: 'meter logs retain data from 2026-09-14; earlier days in 30d are blank.' };
  const view = statsLines(fixture, { width: 120, tab: 'pools', period: '30d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Usage history unavailable: meter logs retain data from 2026-09-14/);
  assert.equal(text.includes('┼'), false, 'no invented axis');
  assert.match(text, /meter unavailable/);
});

test('a day holding only legacy runs prints no money for them', () => {
  const fixture = models();
  fixture.overview = {
    ...overview,
    breakdown: {
      ...overview.breakdown,
      pools: [{ name: 'legacy', runs: 2, attempts: 0, minutes: 5, apiEquivalentUsd: null, workflowsCompleted: 0, minutesShare: 1, medianWallMinutes: 4 }],
      projects: [{ name: 'legacy', runs: 2, attempts: 0, minutes: 5, apiEquivalentUsd: null, workflowsCompleted: 0, minutesShare: 1, medianWallMinutes: 4 }],
    },
  };
  fixture.projects = { rows: fixture.overview.breakdown.projects };
  const overviewText = statsLines(fixture, { width: 120, tab: 'overview', period: '7d', ansi: false }).lines.map(visible).join('\n');
  assert.match(overviewText, /Spent: estimate unavailable/);
  // The overview keeps its basis line (`≈ $ ...`) even when every value is
  // blank; there must be no dollar-denominated figure for the legacy runs.
  assert.equal(/(?:≈\s*)\$\d/.test(overviewText), false, 'no money for a run that recorded none');
  const projectsText = statsLines(fixture, { width: 120, tab: 'projects', period: '7d', ansi: false }).lines.map(visible).join('\n');
  assert.equal(/(?:≈\s*)\$\d/.test(projectsText), false, 'and none on the project row either');
});

test('narrow Trends uses unique nice ticks, day labels and one month title', () => {
  const buckets = Array.from({ length: 7 }, (_, index) => ({
    key: `2026-09-${String(index + 11).padStart(2, '0')}`,
    value: [4, 7, 10, 13, 16, 18, 20][index],
  }));
  const lines = statsLines({ trend: { metric: 'runs', period: '7d', bucketBy: 'day', buckets, total: 88 } }, {
    width: 55, tab: 'trends', period: '7d', metric: 'runs', ansi: false,
  }).lines.map(visible);
  assert.ok(lines.some((line) => line.startsWith('── runs finished · last 7 days · per day')), lines.join('\n'));
  const axis = lines.filter((line) => line.includes('┤')).map((line) => line.split('┤')[0].trim()).filter(Boolean);
  assert.equal(new Set(axis).size, axis.length, `duplicated ticks: ${axis.join(' ')}`);
  const labels = lines.find((line) => line.includes('┼'));
  assert.match(labels, /\b11\b.*\b12\b.*\b13\b/);
  assert.doesNotMatch(labels, /11 Se/);
  assert.match(labels, /now\s*$/);

  const wide = statsLines({ trend: { metric: 'runs', period: '7d', bucketBy: 'day', buckets, total: 88 } }, {
    width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false,
  }).lines.map(visible).find((line) => line.includes('┼'));
  assert.match(wide, /11 Sep.*12 Sep/);
});

test('a wide Projects row keeps name, shape and complete figures on one row', () => {
  const stats = models({ withTrends: false });
  stats.projects = {
    rows: [{
      ...overview.breakdown.projects[0],
      runs: 45, okShare: 0.82, apiEquivalentUsd: 5.1, medianWallMinutes: 41,
    }],
    trend: {
      metric: 'runs', period: '7d', bucketBy: 'day',
      buckets: Array.from({ length: 7 }, (_, index) => ({
        key: `2026-09-1${index}`,
        segments: [{ name: 'bullswarm', value: index + 1 }],
      })),
    },
  };
  const text = statsLines(stats, { width: 200, tab: 'projects', period: '7d', ansi: false }).lines.map(visible);
  const row = text.find((line) => /^ bullswarm\s/.test(line));
  assert.ok(row, text.join('\n'));
  // The row is written with a one-cell indent; if the fields were laid out on
  // the full width the frame would take that cell back off the last field.
  assert.equal(row.includes('…'), false, `figures are not truncated: ${row}`);
  assert.match(row, /45 runs · ✓ 82% · ≈ \$5\.10 API · 41m median$/);
  assert.equal(row.length, 200, 'and the row reaches the frame edge');
  const shape = (row.match(/[▁▂▃▄▅▆▇█]+/) ?? [''])[0];
  assert.ok(shape.length >= 7, `seven measured days keep a shape: ${shape.length}`);
  assert.ok(shape.length <= 28, `no single day is smeared across the frame: ${shape.length}`);
});

test('a phone Models row that fits keeps its last field whole', () => {
  const stats = models({ withTrends: false });
  stats.models = {
    rows: [{ name: 'opus', runs: 3, attempts: 9, minutes: 75, apiEquivalentUsd: null, workflowsCompleted: 2, minutesShare: 0.42, medianWallMinutes: 54, okShare: 0.88 }],
  };
  const text = statsLines(stats, { width: 54, tab: 'models', period: '7d', ansi: false }).lines.map(visible);
  const row = text.find((line) => /^ ●\s*opus/.test(line));
  assert.ok(row, text.join('\n'));
  assert.equal(row.includes('…'), false, `a row with room to spare is not cut: ${row}`);
  assert.match(row, /p50 54m$/);
  assert.ok(row.length <= 54, `and it still stays inside the frame: ${row.length}`);
});

test('a Pools sparkline marks a real window rollover and ignores restated boundaries', () => {
  // Seven days of one pool. Only 09-16 moves the boundary a week on; the other
  // days restate the same instant with the sub-second jitter every provider
  // read carries, and must not be drawn as resets.
  const fixture = models();
  fixture.pools.rows[1].live = { usedPct: 31, elapsedPct: 35 };
  const boundary = (n) => n < 4 ? `2026-09-16T05:00:00.${String(100 + n)}022+00:00` : `2026-09-23T05:00:00.${String(300 + n)}155+00:00`;
  fixture.pools.licencePerDay = [30, 45, 60, 90, 8, 20, 31].map((value, index) => ({
    date: `2026-09-${12 + index}`,
    segments: [{
      name: 'codex', value, resetsAt: boundary(index), ...(index === 4 ? { reset: true } : {}),
    }],
  }));
  const view = statsLines(fixture, { width: 140, tab: 'pools', period: '7d', ansi: false });
  const rows = view.lines.map(visible);
  const row = rows.find((line) => line.includes('codex') && line.includes('31%'));
  assert.ok(row, rows.join('\n'));
  const spark = row.slice(0, row.search(/[\u2587\u2591]/));
  assert.equal((spark.match(/\u258f/g) ?? []).length, 1, `one reset mark, got ${JSON.stringify(spark)}`);
  assert.match(rows.join(' ').replace(/\s+/g, ' '), /a drop after \u258f is the window resetting/);
});

test('the Trends legend wraps to show every pool instead of `+N more`', () => {
  const names = ['unknown', 'opencode2', 'opencode2:kaihk-2', 'opencode2:kaihk-3', 'command-code', 'grok', 'claude-code:acme', 'claude-code', 'codex', 'opencode', 'echo'];
  const trend = {
    metric: 'runs', period: '30d', bucketBy: 'week', total: 11, cumulative: [11],
    buckets: [{ key: 'w1', label: '12 Sep', value: 11, segments: names.map((name) => ({ name, value: 1 })) }],
  };
  const view = statsLines({ trend }, { width: 120, tab: 'trends', period: '30d', metric: 'runs', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.doesNotMatch(text, /\+\d+ more/, 'no name hides behind +N more');
  for (const name of names) assert.ok(text.includes(name), `${name} is in the legend`);
  for (const line of view.lines) assert.ok(visible(line).length <= 120, 'legend rows stay inside the width');
});
