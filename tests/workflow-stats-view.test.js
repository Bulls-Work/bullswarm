import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statsLines } from '../src/workflow/stats-view.js';
import { appendRollupIndex, readRollups, rollupRecord, ROLLUP_SCHEMA_VERSION } from '../src/workflow/rollup.js';
import { modelsModel, overviewModel, poolsModel, projectsModel, trendModel } from '../src/workflow/stats-model.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(SGR, '');

// The real Claude result the other Stats fixtures use, so the API figures
// below are the fixture's own and not a number written into a test.
const CLAUDE_RESULT = JSON.parse(
  readFileSync(new URL('./fixtures/transcripts/claude-result-event.json', import.meta.url), 'utf8'),
);

const homes = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-stats-view-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  homes.push(dir);
  return dir;
}
test.after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

/**
 * The v2 record shape the rollup writer emits, with `minutes` in the shape an
 * index that predates `workflow reprice` still has: the older `wall` alias and
 * no attempt-interval union.
 */
function v2Record({
  runId, finishedAt, priced = 1, attempts = 2, apiUsd = null, subtotal = CLAUDE_RESULT.total_cost_usd,
  pools = {}, models = {}, wall = 30,
}) {
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId,
    shortId: runId.slice(-6),
    project: 'project-a',
    goal: `goal for ${runId}`,
    startedAt: finishedAt,
    finishedAt,
    status: 'completed',
    verified: true,
    requirements: { passed: 1, total: 1 },
    minutes: { wall },
    pools,
    models,
    usage: {
      attempts, minutes: wall, apiUsd, apiKnownSubtotalUsd: subtotal,
      subscriptionUsd: null, subscriptionKnownSubtotalUsd: null,
      measuredAttempts: priced, pricedAttempts: priced, subscriptionPricedAttempts: 0,
      tokenSource: 'transcript-summed', subscriptionBasis: 'unknown:no-meter',
    },
  };
}

function statsOf(records, { period = '30d', now = Date.now() } = {}) {
  const overview = overviewModel(records, [], { period, now });
  return {
    overview,
    breakdown: overview.breakdown,
    trend: trendModel(records, { metric: 'runs', period, now }),
    spendPerDay: trendModel(records, { metric: 'spend', period, now }),
    pools: poolsModel(records, [], { period, now }),
    models: modelsModel(records, { period, now }),
    projects: projectsModel(records, { period, now }),
  };
}

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
      outcomes: { statusCounts: { completed: 53, partial: 2, cancelled: 4 }, verified: 30, verifiedTotal: 59, verifiedShare: 30 / 59, requirementsPassed: 235, requirementsTotal: 301, requirementsShare: 235 / 301, medianActiveMinutes: 54.49, maxActiveMinutes: 542.69 },
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

test('desktop composition keeps chart and panel bar colours, bounds both layouts, and separates series hues', () => {
  const pools = [
    { name: 'a', runs: 3, attempts: 3, minutes: 3, apiEquivalentUsd: 3, minutesShare: 0.75 },
    { name: 'b', runs: 1, attempts: 1, minutes: 1, apiEquivalentUsd: 1, minutesShare: 0.25 },
  ];
  const projects = [{ name: 'p1', runs: 3, minutes: 3 }, { name: 'p2', runs: 1, minutes: 1 }];
  const stats = {
    overview: { keys: { workflows: 4, totalWorkerMinutes: 4, apiEquivalentUsd: 4, activeDays: 2 }, breakdown: { pools, models: pools, projects } },
    pools: { rows: pools, totals: { runs: 4, attempts: 4, minutes: 4, apiEquivalentUsd: 4 } },
    models: {
      rows: pools,
      totals: { runs: 4, attempts: 4, minutes: 4 },
      trend: {
        metric: 'minutes',
        buckets: [
          { key: '2026-09-13', value: 3, segments: [{ name: 'claude-code:acme', value: 2 }, { name: 'codex', value: 1 }] },
          { key: '2026-09-14', value: 1, segments: [{ name: 'claude-code:acme', value: 1 }] },
        ],
      },
    },
    projects: { rows: projects, totals: { runs: 4, minutes: 4 } },
    spendPerDay: {
      metric: 'spend',
      buckets: [
        { key: '2026-09-13', value: 3, segments: [{ name: 'claude-code:acme', value: 2 }, { name: 'codex', value: 1 }] },
        { key: '2026-09-14', value: 1, segments: [{ name: 'claude-code:acme', value: 1 }] },
      ],
    },
  };
  const colours = (line) => [...String(line).matchAll(/\x1b\[38;2;([^m]+)m/g)].map((match) => match[1]);
  const desktop = statsLines(stats, { width: 120, tab: 'spending', stackBy: 'model', ansi: true });
  const chartLine = desktop.lines.find((line) => /┤.*[▁▂▃▄▅▆▇█#]/.test(line));
  const panelLine = desktop.lines.find((line) => /[▓▒░▏]/.test(line));
  assert.ok(chartLine && colours(chartLine).length > 0, 'the composed chart line retains SGR colour');
  assert.ok(panelLine && colours(panelLine).length > 0, 'the composed panel bar line retains SGR colour');
  const legendLine = desktop.lines.find((line) => line.startsWith('Legend'));
  assert.ok(legendLine);
  const legendColours = colours(legendLine);
  assert.equal(new Set(legendColours).size, legendColours.length, 'one chart assigns every legend series a distinct hue');

  for (const width of [55, 120]) {
    const view = statsLines(stats, { width, tab: 'spending', stackBy: 'model', ansi: true });
    assert.ok(view.lines.every((line) => visible(line).length <= width), `${String(width)}-column line overrun`);
  }
});

test('one Stats render shares chart hues with panel rows and keeps visible panel names distinct', () => {
  const pools = [
    { name: 'codex', runs: 3, attempts: 3, minutes: 3, apiEquivalentUsd: 3 },
    { name: 'claude-code:acme', runs: 2, attempts: 2, minutes: 2, apiEquivalentUsd: 2 },
    { name: 'pool-only', runs: 1, attempts: 1, minutes: 1, apiEquivalentUsd: 1 },
  ];
  const buckets = [
    { key: '2026-09-13', label: '2026-09-13', value: 3, segments: [{ name: 'codex', value: 2 }, { name: 'claude-code:acme', value: 1 }] },
    { key: '2026-09-14', label: '2026-09-14', value: 3, segments: [{ name: 'codex', value: 1 }, { name: 'claude-code:acme', value: 2 }] },
  ];
  const stats = {
    overview: { keys: { workflows: 6, totalWorkerMinutes: 6, apiEquivalentUsd: 6, activeDays: 2 }, breakdown: { pools, models: [], projects: [] } },
    pools: { rows: pools, totals: { runs: 6, attempts: 6, minutes: 6, apiEquivalentUsd: 6 } },
    models: { rows: [], totals: {} },
    projects: { rows: [], totals: {} },
    spendPerDay: { metric: 'spend', buckets },
  };
  const colour = (line) => line.match(/\x1b\[38;2;([^m]+)m/)?.[1] ?? null;
  const view = statsLines(stats, { width: 55, tab: 'spending', stackBy: 'pool', ansi: true });
  const codex = view.lines.find((line) => visible(line).startsWith('codex '));
  const acme = view.lines.find((line) => visible(line).startsWith('acme '));
  const extra = view.lines.find((line) => visible(line).startsWith('pool-only '));
  assert.ok(codex && acme && extra, 'all visible pool rows are rendered');
  const legendStart = view.lines.findIndex((line) => visible(line).startsWith('Legend'));
  assert.ok(legendStart >= 0, 'the legend is rendered');
  const legend = view.lines.slice(legendStart).join('\n');
  const legendColour = (name) => legend.match(new RegExp(`\\x1b\\[38;2;([^m]+)m(?:●|#)\\x1b\\[[0-9;]*m ${name}(?:\\x1b|\\s|$)`))?.[1] ?? null;
  const codexColour = colour(codex);
  const acmeColour = colour(acme);
  const extraColour = colour(extra);
  assert.equal(codexColour, legendColour('codex'));
  assert.equal(acmeColour, legendColour('claude-code:acme'));
  assert.equal(new Set([codexColour, acmeColour, extraColour]).size, 3, 'panel rows have pairwise distinct hues');
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
  const glyph = /[▓▒░█▏#.|]/;
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
  const median = stacked.regions.find((region) => region.action.payload?.label === 'Median run');
  const longest = stacked.regions.find((region) => region.action.payload?.label === 'Longest run');
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

test('Stats prints API and subscription money together without a bare estimate', () => {
  const stats = fixture();
  const money = {
    apiUsd: 1.23,
    apiEquivalentUsd: 1.23,
    apiKnownSubtotalUsd: 1.23,
    subscriptionUsd: 0.5,
    subscriptionKnownSubtotalUsd: 0.5,
    subscriptionDeltaPct: 2.5,
    subscriptionWindow: 'weekly',
    subscriptionBasis: 'calibrated:usd-per-pct',
    tokenSource: 'estimated:utf8-bytes/4',
  };
  stats.overview.keys = { ...stats.overview.keys, ...money };
  stats.overview.breakdown.pools = [{
    ...stats.overview.breakdown.pools[0], ...money,
  }];
  stats.pools.rows = [{ ...stats.pools.rows[0], ...money }];
  stats.pools.totals = { ...stats.pools.totals, ...money };
  stats.spendPerDay = {
    ...stats.spendPerDay,
    total: 1.23,
    buckets: [{
      key: '2026-09-19', label: '2026-09-19', value: 1.23,
      apiUsd: 1.23, apiKnownSubtotalUsd: 1.23,
      subscriptionUsd: 0.5, subscriptionKnownSubtotalUsd: 0.5,
      pricedAttempts: 1, subscriptionPricedAttempts: 1,
      tokenSource: 'estimated:utf8-bytes/4',
      subscriptionBasis: 'calibrated:usd-per-pct',
      segments: [{ name: 'claude-code', value: 1.23 }],
    }],
  };
  const text = statsLines(stats, { width: 120, tab: 'spending', period: '7d', ansi: false })
    .lines.map(visible).join('\n');
  assert.match(text, /~ \$1\.23 api estimated/);
  assert.match(text, /2\.5% wk ≈ \$0\.50 sub/);
  assert.doesNotMatch(text, /(?<!~ )\$1\.23 api(?:\s|·|$)/, 'estimated API money never uses the measured form');
});

// ---------------------------------------------------------------------------
// The second review round's data path: a period whose records carry a price
// for some of their attempts, and an index `workflow reprice` has not
// corrected yet. Both are read through the real models, over the real rollup
// index, exactly as the dashboard reads them.
// ---------------------------------------------------------------------------

const REVIEW_NOW = Date.parse('2026-09-20T12:00:00.000Z');
const REVIEW_DAY = '2026-09-20T09:00:00.000Z';

/** One index holding a partly-priced pool and a fully-priced one. */
function partialIndex() {
  const dir = home();
  const partial = v2Record({
    runId: 'wf-v2-partial', finishedAt: REVIEW_DAY, priced: 1, attempts: 2, wall: 40,
    pools: {
      codex: {
        attempts: 2, minutes: 40, apiUsd: null,
        apiKnownSubtotalUsd: CLAUDE_RESULT.total_cost_usd, costUsd: null,
        pricedAttempts: 1, measuredAttempts: 1, tokens: 1000,
        tokenSource: 'transcript-summed', subscriptionBasis: 'unknown:no-meter',
      },
    },
    models: { 'gpt-5.6-luna': { attempts: 2, minutes: 40 } },
  });
  const whole = v2Record({
    runId: 'wf-v2-whole', finishedAt: REVIEW_DAY, priced: 1, attempts: 1, wall: 20,
    apiUsd: CLAUDE_RESULT.total_cost_usd,
    pools: {
      'claude-code:acme': {
        attempts: 1, minutes: 20, apiUsd: CLAUDE_RESULT.total_cost_usd,
        apiKnownSubtotalUsd: CLAUDE_RESULT.total_cost_usd, costUsd: CLAUDE_RESULT.total_cost_usd,
        pricedAttempts: 1, measuredAttempts: 1, tokens: 2000,
        tokenSource: 'provider-reported', subscriptionBasis: 'unknown:no-meter',
      },
    },
    models: { 'claude-opus-5': { attempts: 1, minutes: 20 } },
  });
  appendRollupIndex(dir, partial);
  appendRollupIndex(dir, whole);
  return readRollups(dir);
}

test('a pool row shows the recorded subtotal instead of the missing-total reason', () => {
  const stats = statsOf(partialIndex(), { period: '30d', now: REVIEW_NOW });
  const text = statsLines(stats, { width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false })
    .lines.map(visible).join('\n');
  const sub = CLAUDE_RESULT.total_cost_usd.toFixed(2);
  assert.match(text, new RegExp(`codex[^\\n]*≈ \\$${sub} api 50%`), 'the partial pool prints its recorded subtotal');
  assert.doesNotMatch(text, /codex [^\n]*cost not recorded/);
  // The page says once what a subtotal is; the panel cell keeps its columns.
  assert.match(text, /Coverage · 2 of 3 attempts carried a price; spend over them is a subtotal, marked ≈\./);
  // The whole-scope pool keeps the strict form and no coverage prose.
  assert.match(text, /acme[^\n]*\$[\d.]+ api 50%/);
});

test('the hover over a subtotal names the coverage that produced it', () => {
  const stats = statsOf(partialIndex(), { period: '30d', now: REVIEW_NOW });
  const view = statsLines(stats, { width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false });
  const row = view.regions.find((region) => region.action.payload?.kind === 'share' && region.action.payload?.label === 'codex');
  assert.ok(row, 'the pool spend row is a hit region');
  assert.equal(row.action.payload.partial, true);
  const hovered = visible(statsLines(stats, {
    width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false, slice: row.action,
  }).lines[2]);
  assert.match(hovered, /codex · ≈\$[\d.]+ \(1\/2 attempts priced\) · [\d.]+% of panel/);
});

test('a day whose attempts were only partly priced draws its recorded subtotal', () => {
  const stats = statsOf(partialIndex(), { period: '30d', now: REVIEW_NOW });
  const view = statsLines(stats, { width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false });
  const chart = view.lines.slice(5, 20).map(visible);
  assert.ok(chart.some((line) => /[█▇▆▅▄▃▂▁]/.test(line)), 'the partial day has a bar');
  const column = view.regions.find((region) => region.action.payload?.kind === 'column');
  assert.ok(column, 'the day is a hit region');
  assert.equal(column.action.payload.partial, true);
  const hovered = visible(statsLines(stats, {
    width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false, slice: { ...column.action, kind: 'column' },
  }).lines[2]);
  assert.match(hovered, /≈\$[\d.]+ \(2\/3 attempts priced\) · 100% of the day/);
  // The summary carries the period's recorded sum, named as a subtotal.
  const summary = visible(view.lines[4]);
  assert.match(summary, /≈ \$[\d.]+ api · 2\/3 priced/);
});

test('duration rows name the span an index without active unions falls back to', () => {
  const stats = statsOf(partialIndex(), { period: '30d', now: REVIEW_NOW });
  const view = statsLines(stats, { width: 200, tab: 'spending', stackBy: 'pool', period: '30d', ansi: false });
  const text = view.lines.map(visible).join('\n');
  assert.match(text, /Median run[^\n]*30m median · span 2\/2/);
  assert.match(text, /Longest run[^\n]*40m maximum · span 2\/2/);
  assert.doesNotMatch(text, /duration not recorded/);
  assert.match(text, /Durations · 2 of 2 runs recorded no active interval union; their span stands in until workflow reprice fills it\./);
  // The label a hover carries stays the row's own, and its unit is minutes.
  const row = view.regions.find((region) => region.action.payload?.label === 'Median run');
  assert.ok(row);
  assert.equal(row.action.payload.unit, 'minutes');
  assert.equal(row.action.payload.value, 30);
});

test('a record that carries an active union is never labelled as a span', () => {
  const dir = home();
  appendRollupIndex(dir, rollupRecord(JSON.parse(
    readFileSync(new URL('./fixtures/workflows/g6d6q2-state.json', import.meta.url), 'utf8'),
  ), null, { project: 'project-a' }));
  const stats = statsOf(readRollups(dir), { period: 'all', now: Date.parse('2026-09-20T12:00:00.000Z') });
  const text = statsLines(stats, { width: 200, tab: 'spending', stackBy: 'pool', period: 'all', ansi: false })
    .lines.map(visible).join('\n');
  assert.match(text, /Median run[^\n]*6h01m median(?! · span)/);
  assert.doesNotMatch(text, /Durations ·/);
});

// The owner screenshot's shape is easiest to regress against the actual
// rollups, rather than a hand-sized fixture: the pool rows are long enough to
// expose the chart/grid mismatch at both desktop widths.
const REAL_SNAPSHOT_HOME = process.env.BULLSWARM_STATS_SNAPSHOT_HOME
  ?? '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
const REAL_SNAPSHOT_NOW = Date.parse('2026-09-20T12:00:00.000Z');

test('real snapshot rollups align every desktop Stats chart with its right column', () => {
  assert.ok(existsSync(join(REAL_SNAPSHOT_HOME, 'workflows')), `missing real rollup snapshot: ${REAL_SNAPSHOT_HOME}`);
  const records = readRollups(REAL_SNAPSHOT_HOME, { now: REAL_SNAPSHOT_NOW });
  assert.ok(records.length > 0, 'the real rollup snapshot is empty');
  const stats = statsOf(records, { period: 'all', now: REAL_SNAPSHOT_NOW });

  for (const width of [120, 200]) {
    const leftWidth = Math.floor((width - 2) / 2);
    for (const tab of ['spending', 'pool', 'model', 'project']) {
      const view = statsLines(stats, { width, tab, period: 'all', stackBy: 'pool', ansi: false });
      const titleRow = view.lines.findIndex((line) => /(?:Spend per day|Worker-minutes per day|Runs per day)/.test(visible(line)));
      assert.ok(titleRow >= 0, `${tab}/${width}: chart title missing`);
      const chartLastRow = view.lines.findLastIndex((line, index) => (
        index >= titleRow && /[┼+]/.test(visible(line).slice(0, leftWidth))
      ));
      const legendRow = view.lines.findIndex((line) => visible(line).startsWith('Legend'));
      assert.ok(chartLastRow > titleRow, `${tab}/${width}: chart axis missing`);
      assert.ok(legendRow > chartLastRow, `${tab}/${width}: right column/legend boundary missing`);
      const rightColumnLastRow = legendRow - 1;
      assert.equal(chartLastRow, rightColumnLastRow, `${tab}/${width}: chart and right column bottoms diverged`);
    }
  }
});
