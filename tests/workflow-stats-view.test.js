import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsLines } from '../src/workflow/stats-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line) => String(line ?? '').replace(SGR, '');
const WIDTHS = [54, 55, 80, 100, 200];

/** Every `$` the frame paints with no `≈` in front of it — rule 11's sweep. */
function unmarkedDollars(text) {
  const source = String(text ?? '');
  return [...source.matchAll(/\$/g)]
    .map((match) => match.index)
    .filter((index) => !source.slice(Math.max(0, index - 2), index).includes('≈'));
}

const overview = {
  period: '7d',
  keys: {
    workflows: 5,
    activeDays: 4,
    totalAgentMinutes: 97,
    medianRunMinutes: 2.5,
    longestRunMinutes: 100,
    favouritePool: { name: 'claude-code', attempts: 4 },
    favouriteModel: { name: 'claude-opus-5', attempts: 4 },
    busiestProject: { name: 'bullswarm', runs: 3 },
  },
  heat: {
    days: Array.from({ length: 10 }, (_, index) => ({
      date: `2026-09-${String(index + 7).padStart(2, '0')}`,
      weekday: index % 7,
      value: (index + 1) / 10,
      inHistory: true,
    })),
    spanDays: 10,
    max: 2,
  },
  breakdown: {
    pools: [{ name: 'claude-code', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: 0.37, workflowsCompleted: 2, minutesShare: 0.7, medianWallMinutes: 2.5, live: { usedPct: 41, elapsedPct: 29 } }],
    models: [{ name: 'claude-opus-5', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: null, workflowsCompleted: 2, minutesShare: 1, medianWallMinutes: 2.5 }],
    projects: [{ name: 'bullswarm', runs: 3, attempts: 4, minutes: 75, apiEquivalentUsd: 0.37, workflowsCompleted: 2, minutesShare: 1, medianWallMinutes: 2.5 }],
  },
};

const trend = {
  metric: 'runs',
  period: '7d',
  buckets: [
    { key: '2026-09-15', label: '2026-09-15', value: 3, segments: [{ name: 'claude-code', value: 3 }] },
    { key: '2026-09-16', label: '2026-09-16', value: 2, segments: [{ name: 'claude-code', value: 2 }] },
  ],
  total: 5,
  cumulative: [3, 5],
  segmentBasis: 'the pool with the most worker-minutes in each run',
};

function models() {
  return {
    overview,
    trend,
    pools: { rows: overview.breakdown.pools, mostUsed: 'claude-code' },
    models: { rows: overview.breakdown.models, mostUsed: 'claude-opus-5', notes: ['apiEquivalentUsd is null for every model: cost per pool, not per model'] },
    projects: { rows: overview.breakdown.projects, mostUsed: 'bullswarm' },
  };
}

test('Stats exposes every tab and period as the approved action kinds', () => {
  const view = statsLines(models(), { width: 120, tab: 'trends', period: '30d', metric: 'spend', ansi: false });
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'tab').map((region) => region.action.tab), [
    'overview', 'trends', 'pools', 'models', 'projects',
  ]);
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'period').map((region) => region.action.period), ['7d', '30d', 'all']);
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'metric').map((region) => region.action.metric), ['runs', 'spend', 'minutes', 'verified']);
});

test('every Stats tab and period is width-safe, including the phone frame', () => {
  for (const width of WIDTHS) {
    for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
      for (const period of ['7d', '30d', 'all']) {
        for (const metric of ['runs', 'spend']) {
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

test('model cost stays blank with its reason, never a made-up share of a licence', () => {
  const view = statsLines(models(), { width: 120, tab: 'models', period: '7d', ansi: false });
  const text = view.lines.join('\n');
  assert.match(text, /cost per pool, not per model/);
  assert.equal(text.includes('licence share'), false);
  assert.equal(text.includes('$'), false);
});

// A spend trend whose middle bucket nobody recorded an estimate for: the
// shape the third acceptance pass found unmarked.
const spendTrend = {
  metric: 'spend',
  period: '7d',
  buckets: [
    { key: '2026-09-15', label: '2026-09-15', value: 0.12, segments: [{ name: 'claude-code', value: 0.12 }] },
    { key: '2026-09-16', label: '2026-09-16', value: null, segments: [] },
    { key: '2026-09-17', label: '2026-09-17', value: 1.245, segments: [{ name: 'claude-code', value: 1.245 }] },
  ],
  total: 1.365,
  cumulative: [0.12, null, 1.365],
  segmentBasis: 'the recorded API-equivalent estimate per pool',
};

test('the Trends spend chart marks every money figure it paints', () => {
  for (const width of [120, 55, 54]) {
    const view = statsLines({ trend: spendTrend }, {
      width, tab: 'trends', period: '7d', metric: 'spend', ansi: false,
    });
    const lines = view.lines.map(visible);
    const text = lines.join('\n');
    assert.ok(text.includes('$'), `the frame paints money at ${String(width)}`);
    assert.deepEqual(unmarkedDollars(text), [], `a money figure at ${String(width)} has no ≈`);
    const chartStart = lines.findIndex((line) => line.startsWith('── spend'));
    const axisRow = lines.findIndex((line) => line.includes('┼'));
    assert.ok(chartStart > 0 && axisRow > chartStart, `the chart draws its axis at ${String(width)}`);
    for (const line of lines.slice(chartStart + 1, axisRow)) {
      const tick = line.split('┤')[0].trim();
      if (tick) assert.match(tick, /^≈\$/, `the tick "${tick}" at ${String(width)} carries the mark`);
    }
    assert.match(lines[axisRow + 1], /≈\$0\.1/, 'the value row is marked');
    assert.match(lines.find((line) => line.startsWith('total')), /≈\$1\.4/, 'the running total is marked');
  }
});

test('the spend chart states its basis in one line at both widths', () => {
  for (const width of [120, 55, 54]) {
    const view = statsLines({ trend: spendTrend }, {
      width, tab: 'trends', period: '7d', metric: 'spend', ansi: false,
    });
    const lines = view.lines.map(visible);
    const basis = lines.filter((line) => line.includes('API-equivalent estimate') && line.includes('none recorded'));
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

test('a spend bucket with no recorded estimate is a blank with its reason, never $0', () => {
  const view = statsLines({ trend: spendTrend }, {
    width: 120, tab: 'trends', period: '7d', metric: 'spend', ansi: false,
  });
  const lines = view.lines.map(visible);
  const axisRow = lines.findIndex((line) => line.includes('┼'));
  const valueRow = lines[axisRow + 1];
  assert.match(valueRow, /≈\$0\.1\s+—\s+≈\$1\.2/, 'the uncosted bucket sits between two marked figures as a blank');
  assert.doesNotMatch(valueRow, /\$0(?!\.\d)/, 'a bucket nobody recorded a cost for is never $0');
  assert.equal(/≈\s*—/.test(valueRow), false, 'a blank carries no mark: there is nothing to qualify');
  assert.match(lines.join('\n'), /— = none recorded/, 'the frame says why the blank is blank');
});

test('a measured metric carries no estimate mark and no money basis', () => {
  const view = statsLines(models(), { width: 120, tab: 'trends', period: '7d', metric: 'runs', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Total: 5 runs/, 'the runs chart still totals as a count');
  assert.equal(text.includes('≈'), false, 'a count is a measurement, not an estimate');
  assert.equal(text.includes('API-equivalent estimate, recorded'), false, 'and it states no money basis');
});
