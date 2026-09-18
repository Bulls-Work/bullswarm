import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsLines } from '../src/workflow/stats-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(SGR, '');

const buckets = [
  { key: '2026-09-13', label: '2026-09-13', value: 0.08, tokenSource: 'estimated:utf8-bytes/4', segments: [{ name: 'claude-code', value: 0.08 }] },
  { key: '2026-09-14', label: '2026-09-14', value: 2.93, tokenSource: 'estimated:utf8-bytes/4', segments: [{ name: 'acme', value: 2.93 }] },
  { key: '2026-09-15', label: '2026-09-15', value: 0.36, tokenSource: 'estimated:utf8-bytes/4', segments: [{ name: 'codex', value: 0.36 }] },
  { key: '2026-09-16', label: '2026-09-16', value: 1.18, tokenSource: 'estimated:utf8-bytes/4', segments: [{ name: 'cmd', value: 1.18 }] },
  { key: '2026-09-17', label: '2026-09-17', value: null, tokenSource: 'unknown', segments: [] },
  { key: '2026-09-18', label: '2026-09-18', value: null, tokenSource: 'unknown', segments: [] },
  { key: '2026-09-19', label: '2026-09-19', value: null, tokenSource: 'unknown', segments: [] },
];

function fixture({ emptyModels = false } = {}) {
  const pools = [
    { name: 'claude-code', runs: 3, attempts: 106, minutes: 1995, apiEquivalentUsd: 3, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.284, verified: 8, verifiedShare: 0.5, live: { usedPct: 41, resetsAt: '2026-09-20T00:00:00Z' } },
    { name: 'acme', runs: 2, attempts: 74, minutes: 1258, apiEquivalentUsd: 3.27, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.179, verified: 9, verifiedShare: 0.6, live: { usedPct: null } },
    { name: 'idle-pool', runs: 0, attempts: 0, minutes: null, apiEquivalentUsd: null, tokenSource: 'unknown', minutesShare: null, verified: 0, verifiedShare: null, live: { usedPct: null } },
  ];
  const models = emptyModels ? [] : [
    { name: 'claude-opus-5', runs: 3, attempts: 97, minutes: 1788, apiEquivalentUsd: null, minutesShare: 0.255, verified: 20, verifiedShare: 0.6 },
    { name: 'gpt-5.6-luna', runs: 2, attempts: 74, minutes: 1500, apiEquivalentUsd: null, minutesShare: 0.214, verified: 10, verifiedShare: 0.5 },
  ];
  return {
    overview: {
      keys: { workflows: 59, activeDays: 6, totalWorkerMinutes: 7018.74, apiEquivalentUsd: 7.032817, tokenSource: 'estimated:utf8-bytes/4', medianRunMinutes: 54.49 },
      outcomes: { statusCounts: { completed: 53, partial: 2, cancelled: 4 }, verified: 30, verifiedTotal: 59, verifiedShare: 30 / 59, requirementsPassed: 235, requirementsTotal: 301, requirementsShare: 235 / 301, medianWallMinutes: 54.49, maxWallMinutes: 542.69 },
      breakdown: { pools, models, projects: [{ name: 'project-c', runs: 20, attempts: 40, minutes: 3000, apiEquivalentUsd: 2.1, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.427 }, { name: 'bullswarm', runs: 15, attempts: 30, minutes: 1900, apiEquivalentUsd: 1.8, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.271 }] },
    },
    spendPerDay: { metric: 'spend', segmentBasis: 'the recorded API-equivalent estimate per pool', buckets, total: 7.032817 },
    pools: { rows: pools, totals: { runs: 5, attempts: 180, minutes: 3253, apiEquivalentUsd: 6.27 }, licencePerDay: null },
    models: {
      rows: models,
      totals: { runs: 5, attempts: 171, minutes: 3288, apiEquivalentUsd: null },
      trend: { metric: 'minutes', unit: 'worker-minutes', segmentBasis: 'measured worker-minutes per model', buckets: buckets.map((bucket, index) => ({ ...bucket, value: index < 4 ? [320, 940, 400, 600][index] : null, segments: index < 4 ? [{ name: 'claude-opus-5', value: [220, 600, 250, 400][index] }, { name: 'gpt-5.6-luna', value: [100, 340, 150, 200][index] }] : [] })) },
    },
    projects: {
      rows: [{ name: 'project-c', runs: 20, attempts: 40, minutes: 3000, apiEquivalentUsd: 2.1, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.427 }, { name: 'bullswarm', runs: 15, attempts: 30, minutes: 1900, apiEquivalentUsd: 1.8, tokenSource: 'estimated:utf8-bytes/4', minutesShare: 0.271 }],
      trend: { metric: 'runs', segmentBasis: 'the project each run recorded', buckets: buckets.map((bucket, index) => ({ ...bucket, value: index < 4 ? index + 2 : 0, segments: index < 4 ? [{ name: 'project-c', value: index + 1 }, { name: 'bullswarm', value: 1 }] : [] })) },
    },
  };
}

test('Stats exposes exactly Spending, Pool, Model and Project tabs', () => {
  const view = statsLines(fixture(), { width: 120, tab: 'spending', period: '30d', ansi: false });
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'tab').map((region) => region.action.tab), ['spending', 'pool', 'model', 'project']);
  assert.deepEqual(view.regions.filter((region) => region.action.kind === 'period').map((region) => region.action.period), ['7d', '30d', 'all']);
});

test('all four tabs keep the shared order and fit 55, 120 and 200 columns', () => {
  for (const width of [55, 120, 200]) {
    for (const tab of ['spending', 'pool', 'model', 'project']) {
      const view = statsLines(fixture(), { width, tab, period: '7d', stackBy: 'pool', ansi: false });
      assert.ok(view.lines.length > 0);
      for (const line of view.lines) assert.ok(visible(line).length <= width, `${tab}/${width}: ${line}`);
      for (const region of view.regions) {
        assert.ok(region.x >= 1 && region.width >= 1);
        assert.ok(region.x + region.width - 1 <= width, `${tab}/${width} region overrun`);
      }
      const text = view.lines.map(visible).join('\n');
      assert.match(text, /Summary/);
      assert.match(text, /Legend/);
    }
  }
});

test('Spending renders a dated spend chart, including an unmeasured day', () => {
  const view = statsLines(fixture(), { width: 55, tab: 'spending', period: '7d', stackBy: 'pool', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Spend per day/);
  assert.match(text, /Sep13|13 Sep/);
  assert.match(text, /Sep19|19 Sep/);
  assert.match(text, /—/);
  assert.doesNotMatch(text, /\bS\s+M\s+T\b/);
  assert.match(text, /Pool spend/);
  assert.match(text, /Outcome & duration/);
});

test('the Spending toggle changes both the chart metric and visible grid basis', () => {
  const byPool = statsLines(fixture(), { width: 120, tab: 'spending', stackBy: 'pool', ansi: false });
  const byModel = statsLines(fixture(), { width: 120, tab: 'spending', stackBy: 'model', ansi: false });
  const poolText = byPool.lines.map(visible).join('\n');
  const modelText = byModel.lines.map(visible).join('\n');
  assert.match(poolText, /Spend per day · API-equivalent · pool/);
  assert.match(poolText, /\[By Pool\]/);
  assert.match(modelText, /Worker-minutes per day · model cost is not measured/);
  assert.match(modelText, /\[By Model\]/);
  assert.match(modelText, /Model worker-minutes/);
  assert.match(modelText, /Model attempts/);
  assert.match(modelText, /model cost is not measured/);
  const toggleActions = byPool.regions.filter((region) => region.action.kind === 'stackBy');
  assert.deepEqual(toggleActions.map((region) => region.action.stackBy), ['pool', 'model']);
  const modelSlices = byModel.regions.filter((region) => region.action.payload?.kind === 'slice');
  assert.ok(modelSlices.length > 0);
  assert.ok(modelSlices.every((region) => region.action.payload.metric === 'minutes'));
  assert.ok(modelSlices.every((region) => region.action.payload.label !== 'model cost unavailable'));
});

test('the four panel slots remain titled at narrow width and are capped at six rows', () => {
  const view = statsLines(fixture(), { width: 55, tab: 'spending', stackBy: 'pool', ansi: false });
  const lines = view.lines.map(visible);
  const titles = lines.map((line, index) => line.startsWith('── ') ? index : -1).filter((index) => index >= 0);
  const panelTitles = titles.filter((index) => /Pool spend|Pool worker-minutes|Project runs|Outcome & duration/.test(lines[index]));
  assert.equal(panelTitles.length, 4);
  for (let index = 0; index < panelTitles.length; index += 1) {
    const start = panelTitles[index] + 1;
    const end = panelTitles[index + 1] ?? lines.length;
    const dataRows = lines.slice(start, end).filter((line) => line.trim() && !line.startsWith('── ') && !line.startsWith('● ') && !line.startsWith('Basis'));
    assert.ok(dataRows.length <= 6, `panel ${index + 1} has ${dataRows.length} rows`);
  }
});

test('a model with no measured rows is an honest empty panel, not a zero bar', () => {
  const view = statsLines(fixture({ emptyModels: true }), { width: 55, tab: 'model', period: '7d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Model worker-minutes/);
  assert.match(text, /no measured data|no measured series/);
  assert.match(text, /Cost availability/);
  assert.match(text, /cost per pool, not per model/);
  assert.doesNotMatch(text, /\$0\.00/);
});

test('a pool with no model rows keeps its missing worker-minutes reason visible', () => {
  const stats = fixture();
  stats.pools.rows.push({ name: 'no-model-rows', runs: 1, attempts: 1, minutes: null, apiEquivalentUsd: null, tokenSource: 'unknown', live: { usedPct: null } });
  const view = statsLines(stats, { width: 55, tab: 'pool', period: '7d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /no-model-rows/);
  assert.match(text, /worker-minutes not measured/);
  assert.doesNotMatch(text, /no-model-rows[^\n]*0m/);
});

test('bar regions carry durable hover payloads and the reserved row formats them', () => {
  const plain = statsLines(fixture(), { width: 120, tab: 'spending', stackBy: 'pool', ansi: false });
  const slice = plain.regions.find((region) => region.action.payload?.kind === 'slice');
  assert.ok(slice, 'a stacked slice is clickable');
  assert.equal(slice.action.kind, 'slice');
  assert.equal(slice.action.payload.tab, 'spending');
  assert.equal(slice.action.payload.metric, 'spend');
  assert.match(slice.action.payload.bucketLabel, /Sep|2026/);
  const hovered = statsLines(fixture(), { width: 120, tab: 'spending', stackBy: 'pool', slice: slice.action, ansi: false });
  assert.match(visible(hovered.lines[2]), /Sep|2026/);
  assert.match(visible(hovered.lines[2]), /of the day/);
  // The desktop grid now makes one all-four bar decision. The fixture's
  // outcome value field forces that decision to drop panel bars together.
  const share = statsLines(fixture(), { width: 55, tab: 'spending', stackBy: 'pool', ansi: false }).regions
    .find((region) => region.action.payload?.kind === 'share');
  assert.ok(share, 'a panel share row is clickable');
  assert.match(share.action.payload.unit, /usd|minutes|runs|attempts|count/);
});

test('every visible Spending panel track is covered cell-for-cell, including tiny bars', () => {
  const desktop = statsLines(fixture(), { width: 120, tab: 'spending', stackBy: 'pool', ansi: false });
  assert.equal(desktop.regions.filter((region) => region.action.payload?.kind === 'share').length, 0);
  const view = statsLines(fixture(), { width: 55, tab: 'spending', stackBy: 'pool', ansi: false });
  const glyph = /[▓▒░█#.|]/;
  const shares = view.regions.filter((region) => region.action.payload?.kind === 'share');
  assert.ok(shares.length > 0);
  for (const region of shares) {
    const line = visible(view.lines[region.y - 1]);
    for (let x = region.x; x < region.x + region.width; x += 1) {
      assert.match(line[x - 1], glyph, `${region.action.payload.label} missing bar cell ${x}`);
    }
  }
  const poolRows = shares.filter((region) => region.action.payload.metric === 'spend');
  assert.ok(poolRows.some((region) => region.action.payload.label === 'acme'));
  assert.ok(poolRows.every((region) => region.width >= 1));
});

test('stack slices and outcome duration rows use measured values and matching units', () => {
  const base = { width: 120, tab: 'spending', stackBy: 'pool', period: '7d', ansi: false };
  const view = statsLines(fixture(), base);
  const slices = view.regions.filter((region) => region.action.payload?.kind === 'slice');
  assert.ok(slices.length > 0);
  for (const region of slices) {
    const label = visible(statsLines(fixture(), { ...base, slice: region.action }).lines[2]);
    assert.doesNotMatch(label, /value unavailable/);
    if (region.action.payload.value != null) assert.doesNotMatch(label, /not measured/);
  }
  // Panel bars are intentionally absent in this desktop fixture. At the
  // stacked width each panel gets its own full-width geometry and exposes the
  // measured outcome rows for the same hover assertions.
  const stacked = statsLines(fixture(), { ...base, width: 55 });
  const median = stacked.regions.find((region) => region.action.payload?.label === 'Median wall');
  const longest = stacked.regions.find((region) => region.action.payload?.label === 'Longest wall');
  assert.ok(median && longest);
  assert.equal(median.action.payload.unit, 'minutes');
  assert.equal(longest.action.payload.unit, 'minutes');
  assert.match(visible(statsLines(fixture(), { ...base, width: 55, slice: median.action }).lines[2]), /54m/);
  assert.match(visible(statsLines(fixture(), { ...base, width: 55, slice: longest.action }).lines[2]), /9h03m/);
});

test('model cost never becomes a fabricated dollar chart or panel value', () => {
  const view = statsLines(fixture(), { width: 120, tab: 'model', period: '7d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Worker-minutes per day · model/);
  assert.match(text, /Cost availability/);
  assert.match(text, /cost per pool, not per model/);
  const costLine = view.lines.map(visible).find((line) => line.includes('Cost availability'));
  assert.ok(costLine);
  assert.doesNotMatch(text.slice(text.indexOf('Cost availability')), /\$\d/);
});
