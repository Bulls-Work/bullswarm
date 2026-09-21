import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  measuredTaskMinutes,
  cardDurationText,
  medianRunDuration,
  poolRatePerMinute,
  runMinutesInfo,
  runStepCounts,
  todayTopRuns,
  recordCost,
  recordCostInfo,
  recordMoneyPair,
  taskIdentity,
  taskToday,
  todayDateLabel,
  todayLicenceRows,
  todayMinutesNumberText,
  todayMinutesText,
  todayRows,
} from '../src/workflow/home-model.js';
import { readJsonSafe } from '../src/lib/fsjson.js';
import { withV2Cancellation } from '../src/workflow/v2-cancellation.js';
import { runDurationFacts } from '../src/workflow/run-model.js';
import { readRollups } from '../src/workflow/rollup.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = new Date(2026, 8, 20, 12, 0, 0, 0).getTime();
const TODAY = new Date(NOW).toISOString();
// The scrubbed in-repo capture of a real home (scripts/build-test-home.mjs). The top-run cards read a
// run's state from under BULLSWARM_HOME, so the file points the model at this
// snapshot: no test here may probe the live home.
const SNAPSHOT = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
process.env.BULLSWARM_HOME = SNAPSHOT;

test('Home model keeps task identity, dates, durations and nullable figures honest', () => {
  const finished = { id: 'task-1', pool: 'codex', endedAt: TODAY, durationMs: 90_000 };
  assert.equal(taskToday(finished, NOW, { finished: true }), true);
  assert.equal(taskIdentity(finished), 'id:task-1');
  assert.equal(todayMinutesText(1.25), '1.3m');
  assert.equal(todayMinutesNumberText(1.25), '1.3');
  assert.equal(measuredTaskMinutes(finished), 1.5);
  assert.equal(measuredTaskMinutes({ durationMs: 'not measured' }), null);
  assert.equal(cardDurationText({ active: 355, span: 415 }), '5h55m active of 6h55m');
  assert.equal(cardDurationText({ active: 58 + 37 / 60, span: 58 + 37 / 60 }), '58m37s');
  assert.equal(cardDurationText({ active: null, span: 4 }), 'span 4m00s');
  assert.equal(todayDateLabel('2026-09-20', { year: true }), '20 Sep 2026');
  assert.equal(todayDateLabel(null), 'today');
});

test('Home model deduplicates today rows and builds measured licence rows', () => {
  const workflow = {
    runId: 'wf-today', shortId: 'today1', finishedAt: TODAY, status: 'completed', verified: true,
    pools: {
      codex: {
        minutes: 2, costUsd: 0.5, tokenSource: 'provider-reported',
        subscriptionUsd: 0.1, subscriptionBasis: 'observed:meter-delta',
        subscriptionDeltaPct: 2, subscriptionWindow: 'weekly',
      },
    },
  };
  const task = { id: 'task-1', pool: 'codex', endedAt: TODAY, durationMs: 60_000 };
  const model = {
    days: [{ date: TODAY.slice(0, 10), rows: [workflow, { ...task, kind: 'task' }] }],
    rollups: [workflow],
    tasks: { finished: [task] },
    pools: [{ name: 'codex', usedPct: 12, ratePerMinute: 0.5 }],
    budget: { rows: [{ name: 'codex', share: { ratePerMinute: 0.5 } }] },
  };
  const today = todayRows(model, NOW);
  assert.equal(today.workflows.length, 1);
  assert.equal(today.tasks.length, 1);

  const rows = todayLicenceRows(model, today, NOW);
  assert.deepEqual(rows, [{
    name: 'codex', workflowMinutes: 2, runMinutes: 1, apiUsd: 0.5,
    // The recorded subtotal and its coverage travel with the row so a
    // partly-priced pool can show a lower bound instead of a dash. A fully
    // priced pool's subtotal equals its strict amount.
    apiKnownSubtotalUsd: 0.5, attempts: 0, pricedAttempts: 0,
    subscriptionUsd: 0.1, subscriptionBasis: 'observed:meter-delta', subscriptionDeltaPct: 2,
    subscriptionWindow: 'weekly', tokenSource: 'provider-reported', worked: true,
    ratePerMinute: 0.5, usedPct: 12, workflowPct: 1,
  }]);
  assert.equal(poolRatePerMinute(null, { share: { ratePerMinute: 0.25 } }), 0.25);
});

test('Home model preserves API cost precedence and usage basis', () => {
  const record = {
    usage: { apiUsd: 1.25 },
    pools: { codex: { costUsd: 0.5, tokenSource: 'provider-reported' } },
  };
  assert.equal(recordCost(record), 1.25);
  assert.deepEqual(recordCostInfo(record), {
    value: 1.25,
    apiUsd: 1.25,
    // A whole amount carries no subtotal: the strict figure is the answer.
    apiKnownSubtotalUsd: null,
    apiCoverage: { priced: null, attempts: null },
    tokenSource: 'provider-reported',
    subscription: {
      usd: null, deltaPct: null, window: null, basis: 'unknown:no-meter',
    },
    subscriptionUsd: null,
    subscriptionBasis: 'unknown:no-meter',
  });
  assert.equal(recordCost({ pools: { codex: { costUsd: 0.5 } } }), 0.5);
  assert.equal(recordCost({ pools: { codex: { costUsd: null } } }), null);
});

test('Home money shows a partly-priced run as the recorded subtotal, not a dash', () => {
  const partial = {
    runId: 'wf-partial',
    usage: { apiUsd: null, apiKnownSubtotalUsd: 9.523847, pricedAttempts: 3, attempts: 9 },
  };
  const info = recordCostInfo(partial);
  assert.equal(info.apiUsd, null, 'the strict total stays strict');
  assert.equal(info.apiKnownSubtotalUsd, 9.523847);
  assert.deepEqual(info.apiCoverage, { priced: 3, attempts: 9 });
  assert.match(recordMoneyPair(partial).text, /^\u2248 \$9\.52 api \u00b7 /);
  assert.match(
    recordMoneyPair(partial, { coverage: true }).text,
    /^\u2248 \$9\.52 api \u00b7 3\/9 priced \u00b7 /,
  );
  // A run whose attempts were all priced is untouched by the fallback.
  const whole = { runId: 'wf-whole', usage: { apiUsd: 9.760216, apiKnownSubtotalUsd: 9.760216, pricedAttempts: 5, attempts: 5 } };
  assert.match(recordMoneyPair(whole).text, /^~ \$9\.76 api estimated \u00b7 /);
  // No recorded amount at all is still a dash, never a zero.
  assert.match(recordMoneyPair({ runId: 'wf-none', usage: { apiUsd: null, apiKnownSubtotalUsd: null, pricedAttempts: 0, attempts: 2 } }).text, /^api unknown/);
});

test('Home model medians the period\'s runs on active minutes, or on a labelled span', () => {
  const records = [
    { runId: 'wf-a', finishedAt: '2026-09-20T09:00:00.000Z', minutes: { active: 10, span: 40, wall: 40 } },
    { runId: 'wf-b', finishedAt: '2026-09-20T10:00:00.000Z', minutes: { active: 20, span: 90, wall: 90 } },
    { runId: 'wf-c', finishedAt: '2026-09-20T11:00:00.000Z', minutes: { active: 60, span: 200, wall: 200 } },
    // Outside the 7-day window: a period median never reads an older run.
    { runId: 'wf-old', finishedAt: '2026-09-01T11:00:00.000Z', minutes: { active: 600, span: 600, wall: 600 } },
  ];
  const range = { from: Date.parse('2026-09-14T00:00:00.000Z'), to: Date.parse('2026-09-20T23:59:59.000Z') };
  assert.deepEqual(medianRunDuration(records, range), { minutes: 20, basis: 'active' });
  // A run that recorded no finish is placed by its start, the way the Stats
  // range selection reads it.
  assert.deepEqual(
    medianRunDuration([{ startedAt: '2026-09-19T09:00:00.000Z', minutes: { active: 30 } }], range),
    { minutes: 30, basis: 'active' },
  );
  // Nothing proved an active interval: the spans stand in, still said to be spans.
  const spans = records.map((record) => ({ ...record, minutes: { active: null, span: record.minutes.span } }));
  assert.deepEqual(medianRunDuration(spans, range), { minutes: 90, basis: 'span' });
  // A pre-0.35 record keeps only the `wall` alias, which is a span too.
  assert.deepEqual(
    medianRunDuration([
      { finishedAt: '2026-09-19T09:00:00.000Z', minutes: { wall: 12 } },
      { finishedAt: '2026-09-19T10:00:00.000Z', minutes: { wall: 20 } },
    ], range),
    { minutes: 16, basis: 'span' },
  );
  assert.deepEqual(medianRunDuration([], range), { minutes: null, basis: null });
  assert.deepEqual(medianRunDuration([{ finishedAt: 'nonsense', minutes: { active: 5 } }], range), { minutes: null, basis: null });
});

test('Home model orders active runs before newest finished and never promotes wall span to active time', () => {
  const active = {
    runId: 'wf-active', ongoing: true, status: 'running', project: 'p',
    state: {
      lifecycle: { startedAt: '2026-09-20T10:00:00.000Z' },
      actions: [{ id: 'one', status: 'running' }],
      attempts: [{ id: 'attempt-1', actionId: 'one', startedAt: '2026-09-20T10:00:00.000Z' }],
    },
    goal: 'live goal',
  };
  const older = {
    runId: 'wf-older', finishedAt: '2026-09-20T09:00:00.000Z', status: 'completed',
    requirements: { passed: 1, total: 1 }, minutes: { wall: 4 }, goal: 'older goal',
  };
  const newer = {
    runId: 'wf-newer', finishedAt: '2026-09-20T11:00:00.000Z', status: 'completed',
    requirements: { passed: 2, total: 2 }, minutes: { active: 3, span: 5 }, goal: 'newer goal',
  };
  const cards = todayTopRuns({ runs: [active], rollups: [older, newer] }, NOW, { limit: 3 });
  assert.deepEqual(cards.map((card) => card.id), ['wf-active', 'wf-newer', 'wf-older']);
  assert.equal(cards[1].minutes.label, 'active');
  assert.equal(cards[2].minutes.label, 'active');
  assert.equal(cards[2].minutes.active, null);
  assert.equal(cards[2].minutes.span, 4);
  assert.deepEqual(cards[0].steps, { done: 0, total: 1 });
  assert.deepEqual(runMinutesInfo({ minutes: { wall: 2 } }), {
    active: null, span: 2, label: 'active', intervals: [],
  });
  // Requirements are not steps: a record with only a requirement tally shows no step count.
  assert.deepEqual(runStepCounts({ requirements: { passed: 3, total: 4 } }), { done: null, total: null });
  assert.deepEqual(runStepCounts({ steps: { done: 3, total: 4 }, requirements: { passed: 1, total: 7 } }), { done: 3, total: 4 });
});

test('Home model answers a pre-0.35.1 rollup row with the Run page\'s own figures', () => {
  // g6d6q2's index row is the owner's defect: the run finished before the
  // rollup carried `minutes.active` and `steps`, so the card printed
  // `active — · steps —` beside a Run header that had both.
  const row = readRollups(SNAPSHOT).find((record) => record.shortId === 'g6d6q2');
  assert.ok(row, 'the snapshot does not carry the g6d6q2 history row');
  assert.equal(row.minutes.active, undefined);
  assert.equal(row.steps, undefined);

  const nowMs = Date.parse(row.finishedAt);
  const cards = todayTopRuns({ runs: [], rollups: [row], days: [] }, nowMs, { limit: 3 });
  assert.equal(cards.length, 1);
  const [card] = cards;

  const runDir = join(SNAPSHOT, 'workflows', row.runId);
  const state = withV2Cancellation(readJsonSafe(join(runDir, 'state.json'), null), runDir);
  const duration = runDurationFacts({
    runId: row.runId, runDir, state, report: readJsonSafe(join(runDir, 'report.json'), null),
  }, { nowMs });
  const actions = state.actions ?? [];
  assert.deepEqual(card.steps, {
    done: actions.filter((action) => action.status === 'succeeded').length,
    total: actions.length,
  });
  assert.equal(card.minutes.active, duration.activeMinutes);
  assert.equal(card.minutes.span, duration.spanMinutes);
  // Not equal to nothing: the run's own measured figures, to the hundredth the
  // Run header prints.
  assert.equal(Number(card.minutes.active.toFixed(2)), 360.65);
  assert.deepEqual(card.steps, { done: 14, total: 14 });

  // A row that already carries the fields answers for itself, whatever the
  // run's state says.
  const recorded = todayTopRuns({
    runs: [], days: [],
    rollups: [{ ...row, minutes: { active: 1, span: 2 }, steps: { done: 1, total: 2 } }],
  }, nowMs, { limit: 3 });
  assert.equal(recorded[0].minutes.active, 1);
  assert.deepEqual(recorded[0].steps, { done: 1, total: 2 });

  // No state on disk keeps the dash rather than inventing an interval.
  const gone = todayTopRuns({ runs: [], days: [], rollups: [{ ...row, runId: 'wf-absent' }] }, nowMs, { limit: 3 });
  assert.equal(gone[0].minutes.active, null);
  assert.deepEqual(gone[0].steps, { done: null, total: null });
});
