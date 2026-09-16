// The Stats page's arithmetic (src/workflow/stats-model.js).
//
// Doctrine under test:
//   S1. A figure with no source is null, never 0 — Number(null) is 0, and a
//       zero-dollar day is how a dashboard invents spend.
//   S2. Money is the recorded API-equivalent estimate and appears only under
//       `apiEquivalentUsd`. There is no per-model cost to show.
//   S3. A median is a real median, never a mean wearing its name.
//   S4. A period that asks for more history than exists returns what exists
//       and says so.
//   S5. The model names its own nulls so a view can blank them deliberately.
//
// Every fixture builds its own home with mkdtempSync and drives the real
// rollup index through appendRollupIndex/readRollups, so these tests exercise
// the same path the dashboard reads. Nothing touches the developer's real
// ~/.bullswarm and nothing needs the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRollupIndex, readRollups, ROLLUP_SCHEMA_VERSION } from '../src/workflow/rollup.js';
import {
  PERIODS, TREND_METRICS, periodRange, overviewModel, trendModel,
  poolsModel, modelsModel, projectsModel,
} from '../src/workflow/stats-model.js';

const homes = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-stats-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  homes.push(dir);
  return dir;
}
test.after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

// A local instant, so a fixture's day is the same day the model buckets it
// into whatever zone the suite runs in.
function localAt(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

function record({
  runId, startedAt, finishedAt, status = 'completed', verified = false,
  wall = null, agent = null, project = 'bullswarm', pools = {}, models = {}, legacy = false,
}) {
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId,
    shortId: runId.slice(-6),
    project,
    goal: `goal for ${runId}`,
    cwd: '/tmp/fixture',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status,
    verified,
    requirements: { passed: verified ? 1 : 0, total: 1 },
    minutes: { wall, agent },
    pools,
    models,
    legacy,
  };
}

function indexOf(records) {
  const dir = home();
  for (const entry of records) appendRollupIndex(dir, entry);
  return readRollups(dir);
}

// Every number a model hands a view has to be a real number or null. NaN is
// what Number(undefined) and 0/0 produce, and it renders as "NaN" on screen.
function assertNoNaN(value, path = '$') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, i) => assertNoNaN(entry, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoNaN(entry, `${path}.${key}`);
  }
}

// ---------------------------------------------------------------- the corpus
//
// The fixture the brief asks for, all in one index:
//   * wf-nocost  — finished, but no attempt recorded an estimate (S1)
//   * wf-legacy  — a legacy record: no pools, no models, no minutes
//   * wf-single  — the only run of its day (a day with a single run)
//   * a stretch of days with no runs at all (a period with no data)
//   * wall minutes chosen so the median and the mean differ (S3)

const NOW = localAt(2026, 9, 16, 15);
const DAY = (n, hour = 12) => localAt(2026, 9, 16 - n, hour);

function corpus() {
  return [
    // today: one verified run with a recorded estimate
    record({
      runId: 'wf-today', startedAt: DAY(0, 9), finishedAt: DAY(0, 10), verified: true,
      wall: 100, agent: 90,
      pools: { 'claude-code': { attempts: 2, minutes: 40, costUsd: 0.25, tokens: 1000 } },
      models: { 'claude-opus-5': { attempts: 2, minutes: 40 } },
    }),
    // today: a run that recorded NO estimate at all (S1)
    record({
      runId: 'wf-nocost', startedAt: DAY(0, 11), finishedAt: DAY(0, 13), status: 'failed',
      wall: 1, agent: 4,
      pools: { codex: { attempts: 1, minutes: 20, costUsd: null, tokens: null } },
      models: { 'gpt-5.6': { attempts: 1, minutes: 20 } },
    }),
    // yesterday: the only run of its day
    record({
      runId: 'wf-single', startedAt: DAY(1, 9), finishedAt: DAY(1, 10), verified: true,
      wall: 2, agent: 1, project: 'kipwise',
      pools: { 'claude-code': { attempts: 1, minutes: 30, costUsd: 0.1, tokens: 20 } },
      models: { 'claude-opus-5': { attempts: 1, minutes: 30 } },
    }),
    // three days back: a legacy record — a run, and nothing measured about it
    record({
      runId: 'wf-legacy', startedAt: DAY(3, 9), finishedAt: DAY(3, 9), status: null,
      project: null, legacy: true,
    }),
    // six days back: two pools on one run
    record({
      runId: 'wf-split', startedAt: DAY(6, 8), finishedAt: DAY(6, 9), wall: 3, agent: 2,
      pools: {
        'claude-code': { attempts: 1, minutes: 5, costUsd: 0.02, tokens: 7 },
        grok: { attempts: 3, minutes: 15, costUsd: 0.03, tokens: 9 },
      },
      models: { 'claude-opus-5': { attempts: 1, minutes: 5 }, 'grok-4.6': { attempts: 3, minutes: 15 } },
    }),
  ];
}

const POOLS = [
  {
    name: 'claude-code', enabled: true, usedPct: 41, elapsedPct: 28.9, pace: -12.1,
    pacingWindow: 'weekly', paceResetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
    resetSource: 'provider', meterSource: 'live',
    meterSnapshot: { monthly_quota: { used: 66.41, limit: 70, unit: 'credits' } },
  },
  // Enabled, metered, and nothing ran on it this period.
  { name: 'idle-pool', enabled: true, usedPct: 5, elapsedPct: 60, pace: 55, pacingWindow: 'weekly', meterSource: 'live' },
  // No meter at all: usedPct stays null rather than becoming 0.
  { name: 'unmetered-pool', enabled: true, usedPct: null, elapsedPct: null, pace: null, meterSource: 'none' },
];

// ------------------------------------------------------------------- exports

test('PERIODS and TREND_METRICS are the frozen lists the toggle and the tab use', () => {
  assert.deepEqual([...PERIODS], ['7d', '30d', 'all']);
  assert.deepEqual([...TREND_METRICS], ['runs', 'spend', 'minutes', 'verified']);
});

// --------------------------------------------------------------- periodRange

test('periodRange: 7d is seven calendar days ending today, all has no lower bound', () => {
  const week = periodRange('7d', NOW);
  assert.equal(week.days, 7);
  assert.equal(week.to, NOW);
  assert.equal(new Date(week.from).getHours(), 0, 'from is local midnight, not now-minus-168h');
  assert.equal(new Date(week.from).getDate(), new Date(localAt(2026, 9, 10)).getDate());

  const all = periodRange('all', NOW);
  assert.equal(all.from, null);
  assert.equal(all.days, null);

  assert.equal(periodRange('30d', NOW).days, 30);
  // The Budget page speaks 'week'; one range function serves both pages.
  assert.equal(periodRange('week', NOW).period, '7d');
  assert.equal(periodRange('week', NOW).days, 7);
  // A typo must not kill a dashboard that repaints every second.
  assert.equal(periodRange('fortnight', NOW).period, '7d');
});

// ------------------------------------------------------------- overviewModel

test('overviewModel: today\'s tiles count the runs that finished today', () => {
  const model = overviewModel(indexOf(corpus()), POOLS, { now: NOW });
  assert.equal(model.today.date, '2026-09-16');
  assert.equal(model.today.finished, 2);
  assert.equal(model.today.verified, 1);
  assert.equal(model.today.verifiedShare, 0.5);
  // Only wf-today recorded an estimate; wf-nocost recorded none and must not
  // drag the tile toward a fake zero.
  assert.equal(model.today.apiEquivalentUsd, 0.25);
  assert.equal(model.today.pricedRuns, 1);
  assertNoNaN(model);
});

test('overviewModel: a day where nothing recorded an estimate is null, not $0 (S1)', () => {
  const noMoney = corpus().filter((entry) => entry.runId === 'wf-nocost');
  const model = overviewModel(indexOf(noMoney), POOLS, { now: NOW });
  assert.equal(model.today.finished, 1);
  assert.equal(model.today.apiEquivalentUsd, null);
  assert.equal(model.today.pricedRuns, 0);
  assert.ok(model.nulls.includes('today.apiEquivalentUsd'));
});

test('overviewModel: a day with nothing finished has no verified share (S1)', () => {
  const model = overviewModel(indexOf(corpus().filter((e) => e.runId === 'wf-split')), POOLS, { now: NOW });
  assert.equal(model.today.finished, 0);
  assert.equal(model.today.verifiedShare, null, 'a share of nothing is not 0%');
  assert.ok(model.nulls.includes('today.verifiedShare'));
});

test('overviewModel: the licence tile reads the live meters and blanks the unmetered', () => {
  const model = overviewModel(indexOf(corpus()), POOLS, { now: NOW });
  const licence = model.today.licence;
  assert.equal(licence.metered, 2, 'unmetered-pool reports no used% and is not counted');
  assert.equal(licence.total, 3);
  assert.equal(licence.maxUsedPct, 41);
  assert.equal(licence.maxPool, 'claude-code');
  assert.equal(licence.meanUsedPct, 23);
  assert.match(licence.basis, /2 of 3 pools metered/);
});

test('overviewModel: no metered pool at all leaves the licence tile null, with a reason', () => {
  const model = overviewModel(indexOf(corpus()), [{ name: 'unmetered-pool', usedPct: null }], { now: NOW });
  assert.equal(model.today.licence.maxUsedPct, null);
  assert.equal(model.today.licence.meanUsedPct, null);
  assert.equal(model.today.licence.basis, 'no pool reported a licence meter');
  assert.ok(model.nulls.includes('today.licence.maxUsedPct'));
});

test('overviewModel: the breakdown splits the period by pool, model and project', () => {
  const model = overviewModel(indexOf(corpus()), POOLS, { period: '7d', now: NOW });
  const pool = model.breakdown.pools.find((row) => row.name === 'claude-code');
  assert.equal(pool.runs, 3);
  assert.equal(pool.attempts, 4);
  assert.equal(pool.minutes, 75);
  assert.equal(pool.apiEquivalentUsd, 0.37);

  // S2: attempts and minutes per model, and no money anywhere near it.
  const model5 = model.breakdown.models.find((row) => row.name === 'claude-opus-5');
  assert.equal(model5.attempts, 4);
  assert.equal(model5.apiEquivalentUsd, null);

  const project = model.breakdown.projects.find((row) => row.name === 'kipwise');
  assert.equal(project.runs, 1);
  assert.equal(project.apiEquivalentUsd, 0.1);
});

test('overviewModel: the heat grid is sized to the history that exists', () => {
  const model = overviewModel(indexOf(corpus()), POOLS, { now: NOW });
  // The oldest run is six days back, so the grid covers that history and no
  // months-wide field of blanks.
  assert.ok(model.heat.days.length <= 14, `grid is ${model.heat.days.length} days wide`);
  assert.equal(model.heat.to, '2026-09-16');
  assert.equal(model.heat.max, 2, 'the busiest day had two runs');
  assert.equal(model.heat.truncated, false);
  // Columns line up: the grid opens on a Monday and every column has seven
  // weekday slots, the current week's unreached days left null.
  assert.equal(model.heat.days[0].weekday, 0);
  for (const column of model.heat.weeks) assert.equal(column.length, 7);
  assert.ok(model.heat.weeks.at(-1).includes(null), 'the current week is not over yet');
  const today = model.heat.days.at(-1);
  assert.equal(today.runs, 2);
  assert.equal(today.value, 1);
  assert.equal(today.inHistory, true);
  // Cells before the first run on record are outside the history, not quiet.
  assert.ok(model.heat.days.some((day) => day.inHistory === false));
});

test('overviewModel: an empty corpus has an empty heat grid and no invented keys', () => {
  const model = overviewModel(indexOf([]), POOLS, { now: NOW });
  assert.deepEqual(model.heat.days, []);
  assert.equal(model.heat.max, null);
  assert.equal(model.heat.spanDays, 0);
  assert.equal(model.keys.workflows, 0);
  assert.equal(model.keys.medianRunMinutes, null, 'no runs is not a zero-minute median');
  assert.equal(model.keys.totalAgentMinutes, null);
  assert.equal(model.keys.favouritePool, null);
  assertNoNaN(model);
});

test('overviewModel: the key-value block is a real median and a measured total', () => {
  const model = overviewModel(indexOf(corpus()), POOLS, { period: 'all', now: NOW });
  assert.equal(model.keys.workflows, 5);
  assert.equal(model.keys.activeDays, 4);
  assert.equal(model.keys.favouritePool.name, 'claude-code');
  assert.equal(model.keys.favouriteModel.name, 'claude-opus-5');
  assert.equal(model.keys.busiestProject.name, 'bullswarm');
  // S3: wall minutes are 100, 1, 2, 3 (the legacy run recorded none). Sorted
  // that is 1, 2, 3, 100 — a median of 2.5, where the MEAN is 26.5.
  assert.equal(model.keys.medianRunMinutes, 2.5);
  assert.equal(model.keys.longestRunMinutes, 100);
  assert.equal(model.keys.totalAgentMinutes, 97);
});

test('overviewModel: a legacy record is a run and nothing more — no NaN, no zeros', () => {
  const model = overviewModel(indexOf(corpus().filter((e) => e.runId === 'wf-legacy')), [], { period: 'all', now: NOW });
  assert.equal(model.keys.workflows, 1);
  assert.equal(model.keys.medianRunMinutes, null);
  assert.equal(model.keys.totalAgentMinutes, null);
  assert.equal(model.keys.totalWorkerMinutes, null);
  assert.equal(model.keys.favouritePool, null, 'a record with no pools names no favourite pool');
  assert.deepEqual(model.breakdown.pools, []);
  assertNoNaN(model);
});

// ---------------------------------------------------------------- trendModel

test('trendModel: 7d buckets by day and the segments sum to the bucket', () => {
  const model = trendModel(indexOf(corpus()), { metric: 'runs', period: '7d', now: NOW });
  assert.equal(model.bucketBy, 'day');
  assert.equal(model.total, 5);
  assert.equal(model.cumulative.at(-1), 5);
  assert.equal(model.max, 2);
  assert.equal(model.segmentBy, 'pool');
  const today = model.buckets.at(-1);
  assert.equal(today.label, '2026-09-16');
  assert.equal(today.value, 2);
  const summed = today.segments.reduce((sum, segment) => sum + segment.value, 0);
  assert.equal(summed, today.value, 'a stacked bar whose segments do not sum to it is a lie');
  assertNoNaN(model);
});

test('trendModel: a spend bucket with no recorded estimate is null, not zero (S1)', () => {
  const model = trendModel(indexOf(corpus()), { metric: 'spend', period: '7d', now: NOW });
  const byDay = new Map(model.buckets.map((bucket) => [bucket.label, bucket]));
  assert.equal(byDay.get('2026-09-16').value, 0.25);
  // Three days back only the legacy run finished, and it recorded nothing.
  assert.equal(byDay.get('2026-09-13').value, null);
  assert.equal(byDay.get('2026-09-13').runs, 1, 'the run happened; only its money is unknown');
  assert.equal(byDay.get('2026-09-13').segments.length, 0);
  // A day with no runs at all is also null, never $0.
  assert.equal(byDay.get('2026-09-14').value, null);
  assert.equal(byDay.get('2026-09-14').runs, 0);
  assert.equal(model.total, 0.4);
  assert.ok(model.nulls.every((path) => path !== 'total'));
});

test('trendModel: a period with no data at all has no buckets and no totals', () => {
  const empty = trendModel(indexOf([]), { metric: 'spend', period: '30d', now: NOW });
  assert.deepEqual(empty.buckets, []);
  assert.equal(empty.total, null);
  assert.equal(empty.max, null);
  assert.equal(empty.from, null);
  assert.deepEqual(empty.cumulative, []);
  assertNoNaN(empty);

  // Runs and verified are counts, so an empty window totals a measured 0.
  const counts = trendModel(indexOf([]), { metric: 'runs', period: '7d', now: NOW });
  assert.equal(counts.total, 0);
  assert.deepEqual(counts.buckets, []);
});

test('trendModel: a period longer than the history returns what exists and says so (S4)', () => {
  const model = trendModel(indexOf(corpus()), { metric: 'runs', period: '30d', now: NOW });
  assert.equal(model.buckets.length, 7, 'the oldest run is six days back');
  assert.equal(model.truncated, true);
  assert.ok(model.requestedFrom < model.from, 'requestedFrom says how much more was asked for');
  assert.equal(model.buckets[0].label, '2026-09-10');
});

test('trendModel: all-time buckets by week', () => {
  const model = trendModel(indexOf(corpus()), { metric: 'runs', period: 'all', now: NOW });
  assert.equal(model.bucketBy, 'week');
  assert.equal(model.truncated, false);
  assert.equal(model.total, 5);
  for (const bucket of model.buckets) {
    assert.equal(bucket.weekday, null, 'a week bucket has no weekday');
    assert.equal(bucket.to - bucket.from, 7 * 86_400_000);
  }
});

test('trendModel: minutes split by model, spend by pool, and the split is named', () => {
  const rollups = indexOf(corpus());
  const minutes = trendModel(rollups, { metric: 'minutes', period: '7d', now: NOW });
  assert.equal(minutes.segmentBy, 'model');
  assert.match(minutes.segmentBasis, /worker-minutes per model/);
  const split = minutes.buckets.find((bucket) => bucket.label === '2026-09-10');
  assert.deepEqual(split.segments, [{ name: 'grok-4.6', value: 15 }, { name: 'claude-opus-5', value: 5 }]);
  assert.equal(split.value, 20);

  const spend = trendModel(rollups, { metric: 'spend', period: '7d', now: NOW });
  assert.equal(spend.segmentBy, 'pool');
  assert.match(spend.segmentBasis, /per pool/);

  // A caller may ask for the other axis; a spend-by-model split does not
  // exist and is answered with no segments and a stated reason, not a guess.
  const impossible = trendModel(rollups, { metric: 'spend', period: '7d', now: NOW, segmentBy: 'model' });
  assert.match(impossible.segmentBasis, /cost per pool, not per model/);
  for (const bucket of impossible.buckets) assert.deepEqual(bucket.segments, []);
});

test('trendModel: an unknown metric falls back to runs rather than throwing', () => {
  const model = trendModel(indexOf(corpus()), { metric: 'dollars-per-smile', period: '7d', now: NOW });
  assert.equal(model.metric, 'runs');
});

// -------------------------------------------------------------------- tables

test('poolsModel: a live pool with no runs this period still gets a row', () => {
  const model = poolsModel(indexOf(corpus()), POOLS, { period: '7d', now: NOW });
  const idle = model.rows.find((row) => row.name === 'idle-pool');
  assert.ok(idle, 'a pool at 5% of its licence with nothing to show is still a row');
  assert.equal(idle.runs, 0);
  assert.equal(idle.minutes, null, 'no runs is not zero minutes');
  assert.equal(idle.okShare, null);
  assert.equal(idle.medianWallMinutes, null);
  assert.equal(idle.apiEquivalentUsd, null);
  assert.equal(idle.live.usedPct, 5);

  const claude = model.rows.find((row) => row.name === 'claude-code');
  assert.equal(claude.live.usedPct, 41);
  assert.equal(claude.live.credits.used, 66.41);
  assert.equal(claude.live.resetSource, 'provider');
  assert.equal(model.mostUsed, 'claude-code');
  assertNoNaN(model);
});

test('poolsModel: a pool only in history keeps its row, with no live meter', () => {
  const model = poolsModel(indexOf(corpus()), POOLS, { period: '7d', now: NOW });
  const grok = model.rows.find((row) => row.name === 'grok');
  assert.equal(grok.attempts, 3);
  assert.equal(grok.live, null);
  assert.equal(grok.enabled, null);
});

test('poolsModel: median wall minutes is a real median, not a mean (S3)', () => {
  // Wall minutes 1, 2, 3, 100 on one pool: median 2.5, mean 26.5.
  const rows = [1, 2, 3, 100].map((wall, index) => record({
    runId: `wf-m${index}`, startedAt: DAY(1, 8), finishedAt: DAY(1, 9), wall,
    pools: { 'claude-code': { attempts: 1, minutes: wall, costUsd: null, tokens: null } },
    models: { 'claude-opus-5': { attempts: 1, minutes: wall } },
  }));
  const model = poolsModel(indexOf(rows), [], { period: '7d', now: NOW });
  assert.equal(model.rows[0].medianWallMinutes, 2.5);

  // And an odd count takes the middle value, not the average of the pair.
  const odd = poolsModel(indexOf(rows.slice(0, 3)), [], { period: '7d', now: NOW });
  assert.equal(odd.rows[0].medianWallMinutes, 2);
});

test('modelsModel: every model\'s apiEquivalentUsd is null, and the model says why (S2)', () => {
  const model = modelsModel(indexOf(corpus()), { period: 'all', now: NOW });
  assert.ok(model.rows.length > 0);
  for (const row of model.rows) {
    assert.equal(row.apiEquivalentUsd, null, `${row.name} must not carry invented money`);
    assert.ok(model.nulls.includes(`rows.${model.rows.indexOf(row)}.apiEquivalentUsd`));
  }
  assert.equal(model.totals.apiEquivalentUsd, null);
  assert.match(model.notes[0], /cost per pool, not per model/);
  assert.equal(model.mostUsed, 'claude-opus-5');
  assert.equal(model.rows[0].attempts, 4);
  assertNoNaN(model);
});

test('projectsModel: a run with no recorded project lands under "unknown", labelled', () => {
  const model = projectsModel(indexOf(corpus()), { period: 'all', now: NOW });
  const unknown = model.rows.find((row) => row.name === 'unknown');
  assert.equal(unknown.runs, 1, 'the legacy record recorded no project');
  assert.equal(unknown.apiEquivalentUsd, null);
  assert.equal(unknown.minutes, null);
  assert.match(model.notes[0], /recorded no project/);

  const bullswarm = model.rows.find((row) => row.name === 'bullswarm');
  assert.equal(bullswarm.runs, 3);
  assert.equal(bullswarm.apiEquivalentUsd, 0.3);
  assert.equal(bullswarm.okShare, 0.6667, 'wf-nocost failed: two of three delivered');
  assert.equal(model.mostUsed, 'bullswarm');
  assertNoNaN(model);
});

test('every model survives a period with no data without a NaN or an invented zero', () => {
  const empty = indexOf([]);
  for (const model of [
    overviewModel(empty, POOLS, { period: '7d', now: NOW }),
    overviewModel(empty, [], { period: 'all', now: NOW }),
    ...TREND_METRICS.flatMap((metric) => PERIODS.map((period) => trendModel(empty, { metric, period, now: NOW }))),
    poolsModel(empty, POOLS, { period: '30d', now: NOW }),
    modelsModel(empty, { period: '30d', now: NOW }),
    projectsModel(empty, { period: '30d', now: NOW }),
  ]) assertNoNaN(model);
});

test('every model survives the full fixture at every period without a NaN', () => {
  const rollups = indexOf(corpus());
  for (const period of [...PERIODS, 'day', 'week']) {
    assertNoNaN(overviewModel(rollups, POOLS, { period, now: NOW }));
    assertNoNaN(poolsModel(rollups, POOLS, { period, now: NOW }));
    assertNoNaN(modelsModel(rollups, { period, now: NOW }));
    assertNoNaN(projectsModel(rollups, { period, now: NOW }));
    for (const metric of TREND_METRICS) assertNoNaN(trendModel(rollups, { metric, period, now: NOW }));
  }
});

test('a malformed index does not crash a page that repaints every second', () => {
  for (const junk of [null, undefined, 'not an array', 42, [null, 'x', {}]]) {
    assertNoNaN(overviewModel(junk, null, { now: NOW }));
    assertNoNaN(trendModel(junk, { metric: 'spend', now: NOW }));
    assertNoNaN(poolsModel(junk, junk, { now: NOW }));
    assertNoNaN(modelsModel(junk, { now: NOW }));
    assertNoNaN(projectsModel(junk, { now: NOW }));
  }
});
