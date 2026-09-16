// The Budget page's arithmetic (src/workflow/budget-model.js).
//
// Doctrine under test:
//   B1. Two kinds of money, each named for what it is: `apiEquivalentUsd` is
//       the estimate the runs recorded, `subscription` is money at a DECLARED
//       rate and is null without one. Neither is derived from the other.
//   B2. A licence draw is only ratePerMinute x measured worker-minutes, with
//       its source, and is null when the rate is null.
//   B3. The share bar has two terms, workflows and rest. There is no "you,
//       interactive" term, because the CLI has no source for one.
//   B4. The reset is an absolute date and time in the reader's own resolved
//       zone. No hard-coded zone.
//   B5. A figure with no source is null, never 0, and the model says which.
//
// Fixtures build their own home with mkdtempSync and drive the real rollup
// index. Nothing touches the developer's ~/.bullswarm and nothing needs the
// network. The bundled data/plan-prices.json declares no price for any pool
// (verified 2026-09-16), so an undeclared pool really does resolve to null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendRollupIndex, readRollups, ROLLUP_SCHEMA_VERSION } from '../src/workflow/rollup.js';
import { poolBudget, budgetModel, biggestRuns } from '../src/workflow/budget-model.js';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const homes = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-budget-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  homes.push(dir);
  return dir;
}
test.after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

function localAt(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}
const NOW = localAt(2026, 9, 16, 15);
const DAY = (n, hour = 12) => localAt(2026, 9, 16 - n, hour);

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
// Worker-minutes on claude-code: 40, 30, 10, 20 → a median of 25, where the
// mean is also 25 only by accident, so the fit test uses a set where they
// differ. Runs with and without a recorded estimate are both present.

function corpus() {
  return [
    record({
      runId: 'wf-big', startedAt: DAY(0, 8), finishedAt: DAY(0, 10), verified: true, wall: 120, agent: 90,
      pools: { 'claude-code': { attempts: 2, minutes: 40, costUsd: 0.25, tokens: 1000 } },
      models: { 'claude-opus-5': { attempts: 2, minutes: 40 } },
    }),
    // A run that recorded NO estimate at all (B5).
    record({
      runId: 'wf-nocost', startedAt: DAY(1, 8), finishedAt: DAY(1, 9), status: 'failed', wall: 60,
      pools: { 'claude-code': { attempts: 1, minutes: 30, costUsd: null, tokens: null } },
      models: { 'claude-opus-5': { attempts: 1, minutes: 30 } },
    }),
    record({
      runId: 'wf-small', startedAt: DAY(2, 8), finishedAt: DAY(2, 9), wall: 30, project: 'kipwise',
      pools: {
        'claude-code': { attempts: 1, minutes: 10, costUsd: 0.05, tokens: 12 },
        codex: { attempts: 1, minutes: 7, costUsd: null, tokens: null },
      },
      models: { 'claude-opus-5': { attempts: 1, minutes: 10 }, 'gpt-5.6': { attempts: 1, minutes: 7 } },
    }),
    // A legacy record: a run, and nothing measured about it.
    record({ runId: 'wf-legacy', startedAt: DAY(3, 8), finishedAt: DAY(3, 8), status: null, project: null, legacy: true }),
    // Outside a one-week window: the 30-day period reaches it, 'week' does not.
    record({
      runId: 'wf-old', startedAt: DAY(20, 8), finishedAt: DAY(20, 9), wall: 45,
      pools: { 'claude-code': { attempts: 1, minutes: 99, costUsd: 9.99, tokens: 3 } },
      models: { 'claude-opus-5': { attempts: 1, minutes: 99 } },
    }),
  ];
}

// A metered pool with a measured %/minute rate, resetting three days out.
function metered(overrides = {}) {
  return {
    name: 'claude-code',
    enabled: true,
    usedPct: 40,
    elapsedPct: 28.9,
    pace: -11.1,
    pacingWindow: 'weekly',
    paceResetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
    resetSource: 'provider',
    meterSource: 'live',
    subscription: { plan: 'max20' },
    spend: { pacing: { window: 'weekly', ratePerMinute: 0.1, source: 'meter-history', samples: 12 } },
    meterSnapshot: { monthly_quota: { used: 66.41, limit: 70, unit: 'credits' } },
    ...overrides,
  };
}

// A pool with a meter but no measured rate: the case where a licence share
// and a fit cannot be computed at all.
function unrated() {
  return {
    name: 'codex',
    enabled: true,
    usedPct: 30,
    elapsedPct: 49,
    pace: 19,
    pacingWindow: 'weekly',
    paceResetsAt: null,
    resetSource: null,
    meterSource: 'live',
    subscription: {},
    spend: { pacing: { window: 'weekly', ratePerMinute: null, source: null, samples: 0 } },
  };
}

// No meter at all.
function unmetered() {
  return { name: 'unmetered-pool', enabled: true, usedPct: null, elapsedPct: null, pace: null, meterSource: 'none', subscription: {} };
}

// ------------------------------------------------------------------ the row

test('poolBudget: the row carries the meter, the money and the fit', () => {
  const row = poolBudget(metered(), { rollups: indexOf(corpus()), now: NOW });
  assert.equal(row.name, 'claude-code');
  assert.equal(row.planType, 'max20');
  assert.equal(row.window, 'weekly');
  assert.equal(row.usedPct, 40);
  assert.equal(row.elapsedPct, 28.9);
  assert.equal(row.paceWord, 'on track', '40 used against 28.9 elapsed is 11.1pp, inside the 15pp band');
  assert.equal(row.resetSource, 'provider');
  assert.deepEqual(row.credits, { used: 66.41, limit: 70, unit: 'credits', remaining: 3.59 });
  // 0.25 + null + 0.05 over the week; wf-old is 20 days back and outside it.
  assert.equal(row.apiEquivalentUsd, 0.3);
  assert.equal(row.runs, 3);
  assertNoNaN(row);
});

test('poolBudget: paceWord is the word, at the same 15pp thresholds the pool rows use', () => {
  assert.equal(poolBudget(metered({ usedPct: 10, elapsedPct: 60 }), { now: NOW }).paceWord, 'slow');
  assert.equal(poolBudget(metered({ usedPct: 90, elapsedPct: 60 }), { now: NOW }).paceWord, 'hot');
  assert.equal(poolBudget(metered({ usedPct: 50, elapsedPct: 60 }), { now: NOW }).paceWord, 'on track');
  // No elapsed mark, no pace: a word is not invented from used% alone.
  assert.equal(poolBudget(metered({ elapsedPct: null }), { now: NOW }).paceWord, null);
});

// ------------------------------------------------------------ the reset text

test('poolBudget: resetsText is an absolute date and time, with the zone named (B4)', () => {
  const row = poolBudget(metered(), { now: NOW });
  assert.ok(row.resetsText, 'a pool with a reset time has reset text');
  assert.match(row.resetsText, /\d{2}:\d{2}/, 'an absolute time, not "in 3d"');
  assert.match(row.resetsText, /Sep/);
  assert.ok(row.resetsText.length > 12, `too short to carry a zone: ${row.resetsText}`);
  assert.equal(row.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(row.resetsInMinutes, 3 * 24 * 60);

  // No reset time, no text — never the word "unknown" dressed as a date.
  const none = poolBudget(metered({ paceResetsAt: null }), { now: NOW });
  assert.equal(none.resetsText, null);
  assert.equal(none.resetsInMinutes, null);
  assert.ok(none.nulls.includes('resetsText'));
});

test('poolBudget: the reset text follows the reader\'s zone, and is not hard-coded (B4)', () => {
  const script = `
    const { poolBudget } = await import(${JSON.stringify(join(REPO, 'src/workflow/budget-model.js'))});
    const row = poolBudget({ name: 'p', paceResetsAt: '2026-09-19T12:00:00.000Z', pacingWindow: 'weekly' },
      { now: Date.parse('2026-09-16T12:00:00.000Z') });
    console.log(JSON.stringify({ text: row.resetsText, zone: row.timeZone }));
  `;
  const run = (TZ) => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ },
    });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim());
  };
  const tokyo = run('Asia/Tokyo');
  const newYork = run('America/New_York');
  assert.equal(tokyo.zone, 'Asia/Tokyo');
  assert.equal(newYork.zone, 'America/New_York');
  assert.notEqual(tokyo.text, newYork.text, 'the same instant reads differently in two zones');
  assert.match(tokyo.text, /21:00/, 'noon UTC is 21:00 in Tokyo');
  assert.match(newYork.text, /08:00/, 'noon UTC is 08:00 in New York');
});

// ------------------------------------------------------------- the share bar

test('poolBudget: the share bar is workflows and rest, and nothing else (B3)', () => {
  const row = poolBudget(metered(), { rollups: indexOf(corpus()), now: NOW });
  assert.deepEqual(
    Object.keys(row.share).filter((key) => key === 'you' || key === 'interactive'),
    [], 'there is no "you, interactive" term: the CLI has no source for one',
  );
  // The meter's own window is the reset minus seven days: 2026-09-12 15:00.
  // Inside it: wf-big (40) and wf-nocost (30). wf-small is 2026-09-14... and
  // also inside; wf-old is not.
  assert.equal(row.share.workflowMinutes, 80);
  // B2: 0.1%/min x 80 measured worker-minutes.
  assert.equal(row.share.workflows, 8);
  assert.equal(row.share.rest, 32, 'the rest of the 40% the meter reports');
  assert.equal(row.share.workflows + row.share.rest, row.usedPct);
  assert.equal(row.share.ratePerMinute, 0.1);
  assert.equal(row.share.rateSource, 'meter-history');
  assert.equal(row.share.rateSamples, 12);
  assert.match(row.share.basis, /0\.1%\/min × measured worker-minutes/);
  assert.match(row.share.windowSource, /weekly meter window/);
});

test('poolBudget: no measured rate means no licence share at all (B2)', () => {
  const row = poolBudget(unrated(), { rollups: indexOf(corpus()), now: NOW });
  assert.equal(row.share.workflows, null, 'a share with no rate is null, not 0%');
  assert.equal(row.share.rest, null);
  assert.equal(row.share.ratePerMinute, null);
  assert.equal(row.share.workflowMinutes, 7, 'the minutes are still measured');
  assert.match(row.share.basis, /no measured %\/minute rate/);
  assert.ok(row.nulls.includes('share.workflows'));
  assert.ok(row.nulls.includes('share.rest'));
});

test('poolBudget: an unmetered pool reports nulls, not a full or an empty meter', () => {
  const row = poolBudget(unmetered(), { rollups: indexOf(corpus()), now: NOW });
  assert.equal(row.usedPct, null);
  assert.equal(row.elapsedPct, null);
  assert.equal(row.paceWord, null);
  assert.equal(row.credits, null);
  assert.equal(row.remainingPct, null);
  assert.equal(row.fits, null);
  assert.equal(row.share.workflows, null);
  assert.equal(row.apiEquivalentUsd, null, 'nothing ran there, so no estimate was recorded');
  assertNoNaN(row);
});

// ------------------------------------------------------------------- the fit

test('poolBudget: fits is remaining licence over one median run\'s draw (B2)', () => {
  // claude-code worker-minutes over the week: 40, 30, 10 → median 30.
  // 0.1%/min x 30 = 3% per median run; 60% left → 20 runs fit.
  const row = poolBudget(metered(), { rollups: indexOf(corpus()), now: NOW });
  assert.equal(row.medianRunMinutes, 30);
  assert.equal(row.drawPerRunPct, 3);
  assert.equal(row.remainingPct, 60);
  assert.equal(row.fits, 20);
  assert.match(row.fitsBasis, /60% licence left ÷ 3% per median run/);
});

test('poolBudget: fits is null, with the reason, whenever it cannot be computed', () => {
  const rollups = indexOf(corpus());
  const noRate = poolBudget(unrated(), { rollups, now: NOW });
  assert.equal(noRate.fits, null);
  assert.match(noRate.fitsBasis, /no measured %\/minute rate/);

  // A rate, but nothing ran there this period: no median run to divide by.
  const noRuns = poolBudget(metered({ name: 'never-used' }), { rollups, now: NOW });
  assert.equal(noRuns.fits, null);
  assert.match(noRuns.fitsBasis, /no run on this pool recorded worker-minutes/);

  // A rate and runs, but no meter: nothing to say how much licence is left.
  const noMeter = poolBudget(metered({ usedPct: null }), { rollups, now: NOW });
  assert.equal(noMeter.fits, null);
  assert.match(noMeter.fitsBasis, /reports no used%/);
});

// ------------------------------------------------------------------- money

test('poolBudget: subscription is null unless a price was declared (B1)', () => {
  const rollups = indexOf(corpus());
  // Nothing declared anywhere, and data/plan-prices.json bundles no prices.
  const undeclared = poolBudget(metered(), { rollups, now: NOW });
  assert.equal(undeclared.subscription, null);
  assert.ok(undeclared.nulls.includes('subscription'));
  assert.equal(undeclared.apiEquivalentUsd, 0.3, 'the recorded estimate is unaffected by a missing price');

  // Declared through the state's subscriptions map.
  const declared = poolBudget(metered(), {
    rollups, now: NOW,
    prices: { 'claude-code': { monthlyPriceUsd: 200, includedValueUsd: 1000 } },
  });
  assert.equal(declared.subscription.monthlyPriceUsd, 200);
  assert.equal(declared.subscription.includedValueUsd, 1000);
  assert.equal(declared.subscription.windowDays, 7);
  // 200 x 7 / 30, on the 30-day-month convention prices.js documents.
  assert.equal(declared.subscription.windowUsd, 46.66666667);
  assert.ok(declared.subscription.basis);
  // B1: the two kinds of money stay separate.
  assert.equal(declared.apiEquivalentUsd, 0.3);
});

test('poolBudget: an includedValueUsd with no monthly price is not a price', () => {
  const row = poolBudget(metered(), {
    rollups: indexOf(corpus()), now: NOW,
    prices: { 'claude-code': { includedValueUsd: 1000 } },
  });
  assert.equal(row.subscription, null, 'included value alone must not become a subscription figure');
});

test('poolBudget: apiEquivalentUsd is null when no run recorded an estimate (B5)', () => {
  const rollups = indexOf([corpus()[1]]); // wf-nocost only
  const row = poolBudget(metered(), { rollups, now: NOW });
  assert.equal(row.runs, 1);
  assert.equal(row.apiEquivalentUsd, null, 'a run with no estimate is not a $0 run');
  assert.ok(row.nulls.includes('apiEquivalentUsd'));
});

test('poolBudget: the money window follows the period, the share follows the meter', () => {
  const rollups = indexOf(corpus());
  const week = poolBudget(metered(), { rollups, period: 'week', now: NOW });
  const month = poolBudget(metered(), { rollups, period: 'month', now: NOW });
  assert.equal(week.apiEquivalentUsd, 0.3);
  assert.equal(month.apiEquivalentUsd, 10.29, 'the 30-day window reaches wf-old at $9.99');
  // The share is measured over the meter's window either way, so it does not
  // move when the reader changes the page's period.
  assert.equal(week.share.workflows, month.share.workflows);
  assert.equal(week.share.from, month.share.from);
});

// ------------------------------------------------------------- budgetModel

test('budgetModel: one row per pool, with totals that name what is missing', () => {
  const model = budgetModel([metered(), unrated(), unmetered()], { rollups: indexOf(corpus()), now: NOW });
  assert.deepEqual(model.rows.map((row) => row.name), ['claude-code', 'codex', 'unmetered-pool']);
  assert.equal(model.totals.pools, 3);
  assert.equal(model.totals.metered, 2);
  assert.equal(model.totals.apiEquivalentUsd, 0.3);
  // B1: nothing declared a price, so the subscription total is null, not 0.
  assert.equal(model.totals.subscriptionUsd, null);
  assert.deepEqual(model.totals.priced, []);
  assert.deepEqual(model.totals.unpriced, ['claude-code', 'codex', 'unmetered-pool']);
  assert.ok(model.notes.some((note) => /no declared subscription price/.test(note)));
  assert.ok(model.notes.some((note) => /no measured %\/minute rate/.test(note) && /codex/.test(note)));
  assert.equal(model.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assertNoNaN(model);
});

test('budgetModel: a partial subscription total names the pools it does not cover (B1)', () => {
  const model = budgetModel([metered(), unrated()], {
    rollups: indexOf(corpus()), now: NOW,
    prices: { 'claude-code': { monthlyPriceUsd: 200 } },
  });
  assert.equal(model.totals.subscriptionUsd, 46.666667, 'totals round to the cent-and-then-some, like every other money total');
  assert.deepEqual(model.totals.priced, ['claude-code']);
  assert.deepEqual(model.totals.unpriced, ['codex'], 'a partial total must never read as a whole one');
});

test('budgetModel: no pools and no runs is empty, not zero', () => {
  const model = budgetModel([], { rollups: indexOf([]), now: NOW });
  assert.deepEqual(model.rows, []);
  assert.equal(model.totals.apiEquivalentUsd, null);
  assert.equal(model.totals.subscriptionUsd, null);
  assert.equal(model.totals.workflowMinutes, null);
  assertNoNaN(model);
});

test('budgetModel excludes disabled pools and records them for the dim footer', () => {
  const model = budgetModel([
    metered(),
    { ...unmetered(), name: 'claude-code:petsona', enabled: false },
    { ...unmetered(), name: 'echo', enabled: false },
  ], { rollups: indexOf(corpus()), now: NOW });
  assert.deepEqual(model.rows.map((row) => row.name), ['claude-code']);
  assert.deepEqual(model.disabledPools, ['claude-code:petsona', 'echo']);
});

// ------------------------------------------------------------- biggestRuns

test('biggestRuns: ranked by worker-minutes and by recorded estimate, each labelled', () => {
  const model = biggestRuns(indexOf(corpus()), { period: 'week', now: NOW, limit: 5 });
  assert.deepEqual(model.byMinutes.map((entry) => entry.runId), ['wf-big', 'wf-nocost', 'wf-small']);
  assert.deepEqual(model.byMinutes.map((entry) => entry.workerMinutes), [40, 30, 17]);
  assert.match(model.byMinutesBasis, /worker-minutes/);

  // B5: a run that recorded no estimate is absent from the money list rather
  // than sorted in at $0, and the count of them is reported.
  assert.deepEqual(model.byApiEquivalentUsd.map((entry) => entry.runId), ['wf-big', 'wf-small']);
  assert.equal(model.pricedRuns, 2);
  assert.equal(model.unpricedRuns, 2, 'wf-nocost and wf-legacy recorded none');
  assert.match(model.byApiEquivalentUsdBasis, /API-equivalent estimate/);
  assertNoNaN(model);
});

test('biggestRuns: never ranked by licence draw, and it says why (B2)', () => {
  const model = biggestRuns(indexOf(corpus()), { period: 'week', now: NOW });
  assert.ok(!('byLicence' in model) && !('byLicenceDraw' in model));
  assert.match(model.notes[0], /estimatedPercent is null on every recorded attempt/);
});

test('biggestRuns: a pool filter measures that pool only', () => {
  const model = biggestRuns(indexOf(corpus()), { pool: 'codex', period: 'week', now: NOW, limit: 5 });
  assert.deepEqual(model.byMinutes.map((entry) => entry.runId), ['wf-small']);
  assert.equal(model.byMinutes[0].workerMinutes, 7, 'codex\'s 7 minutes, not the run\'s 17');
  assert.deepEqual(model.byApiEquivalentUsd, [], 'codex recorded no estimate on that run');
  assert.equal(model.unpricedRuns, 1);
  assert.match(model.byMinutesBasis, /on codex/);
});

test('biggestRuns: the limit is honoured and a period with no data is empty', () => {
  const rollups = indexOf(corpus());
  assert.equal(biggestRuns(rollups, { period: 'all', now: NOW, limit: 2 }).byMinutes.length, 2);
  const none = biggestRuns(indexOf([]), { period: 'week', now: NOW });
  assert.deepEqual(none.byMinutes, []);
  assert.deepEqual(none.byApiEquivalentUsd, []);
  assert.equal(none.runs, 0);
  assertNoNaN(none);
});

// ---------------------------------------------------------------- robustness

test('nothing in the budget model produces a NaN, at any period or shape', () => {
  const rollups = indexOf(corpus());
  const pools = [metered(), unrated(), unmetered(), { name: 'bare' }];
  for (const period of ['day', 'week', 'month', 'all', '7d', '30d', 'nonsense']) {
    assertNoNaN(budgetModel(pools, { rollups, period, now: NOW }));
    assertNoNaN(biggestRuns(rollups, { period, now: NOW }));
    for (const pool of pools) assertNoNaN(poolBudget(pool, { rollups, period, now: NOW }));
  }
  for (const junk of [null, undefined, 'not an array', 42, [null, 'x', {}]]) {
    assertNoNaN(budgetModel(junk, { rollups: junk, now: NOW }));
    assertNoNaN(biggestRuns(junk, { now: NOW }));
    assertNoNaN(poolBudget(junk, { rollups: junk, now: NOW }));
  }
});
