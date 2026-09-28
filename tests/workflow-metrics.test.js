// One metrics module (src/workflow/metrics.js) and its legacy reader
// (src/workflow/metrics-legacy.js): every page aggregates attempt records
// through the same functions.
//
// Doctrine under test (metrics.js M1-M6):
//   M1. Unknown stays unknown, never zero.
//   M2. Money keeps its coverage: a whole amount only when every attempt was
//       priced, a named subtotal otherwise.
//   M3. Active minutes are the union of attempt intervals.
//   M5. "Today" is the finish day.
//   M6. Old rollups and old single-run log entries reach the same records
//       through the legacy reader, marked legacy.
//
// Every fixture builds its own home under the OS temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateAttemptUsage, attemptInterval, attemptMetric, attemptsUnion, intervalMinutes,
  recordEntries, recordTotals, sumEntries, unionIntervals,
} from '../src/workflow/metrics.js';
import { legacyTaskRecord, readLegacyTaskRecords } from '../src/workflow/metrics-legacy.js';
import { readRollups, rollupRecord } from '../src/workflow/rollup.js';
import { overviewModel, poolsModel } from '../src/workflow/stats-model.js';
import { budgetModel } from '../src/workflow/budget-model.js';
import { historyDays } from '../src/workflow/history.js';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-metrics-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, 'history'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function attempt({ pool = 'acme', model = 'm1', start = 0, end = 10, api = 1, sub = null, source = 'provider-reported', status = 'succeeded', actionId = 's1' } = {}) {
  return {
    actionId, attemptNumber: 1, pool, model, status,
    startedAt: iso(start), finishedAt: end == null ? null : iso(end),
    wallSec: end == null ? null : (end - start) * 60,
    usage: {
      tokenSource: source,
      tokens: { totalKnown: 100 },
      api: { usd: api },
      subscription: sub == null ? undefined : { usd: sub, basis: 'calibrated:usd-per-pct' },
    },
  };
}

// ------------------------------------------------------------- intervals

test('M3: the union merges overlapping attempts and keeps the idle gap out', () => {
  const union = attemptsUnion([
    attempt({ start: 0, end: 10 }),
    attempt({ start: 5, end: 15 }),
    attempt({ start: 30, end: 40 }),
  ], { now: T0 + 3_600_000, terminal: true });
  assert.equal(union.activeMinutes, 25);
  assert.equal(union.spanMinutes, 40);
});

test('M3: an attempt with no start makes the union unknown, never shorter', () => {
  const union = attemptsUnion([attempt({ start: 0, end: 10 }), { pool: 'acme', wallSec: 60 }], { terminal: true });
  assert.equal(union.activeMinutes, null);
  assert.deepEqual(intervalMinutes([{ pool: 'acme', wallSec: 60 }], { terminal: true }), { active: null, span: null });
  // A finish and measured wall seconds are two measurements: the start follows.
  assert.equal(attemptsUnion([{ finishedAt: iso(10), wallSec: 120 }], { terminal: true }).activeMinutes, 2);
});

test('M3: an attempt that recorded no finish ends at its start plus its wall seconds', () => {
  const interval = attemptInterval({ startedAt: iso(0), wallSec: 120, status: 'succeeded' });
  assert.equal(interval.end - interval.start, 120_000);
  assert.equal(interval.spanKnown, false);
  const union = unionIntervals([interval], { terminal: true });
  assert.equal(union.activeMs, 120_000);
  assert.equal(union.spanMs, null, 'an end the attempt did not record proves no span');
});

test('M3: a running attempt is open through now', () => {
  const union = attemptsUnion([{ startedAt: iso(0), status: 'running' }], { now: T0 + 5 * 60_000, terminal: false });
  assert.equal(union.activeMinutes, 5);
  assert.equal(union.open, true);
  assert.equal(union.spanMinutes, null);
});

// ------------------------------------------------------------------ money

test('M2: a partly priced scope has no whole amount, and keeps its subtotal and counts', () => {
  const total = aggregateAttemptUsage([attempt({ api: 2 }), attempt({ api: null })]);
  assert.equal(total.apiUsd, null);
  assert.equal(total.apiKnownSubtotalUsd, 2);
  assert.equal(total.pricedAttempts, 1);
  assert.equal(total.attempts, 2);
});

test('M1: an old pool entry with no amount is unknown money, not zero', () => {
  const record = { pools: { acme: { attempts: 2, minutes: 3, costUsd: null } } };
  const total = recordTotals(record);
  assert.equal(total.apiUsd, null);
  assert.equal(total.apiKnownSubtotalUsd, null);
  assert.equal(total.legacy, true);
  assert.equal(total.minutes, 3);
});

test('M2: a pre-v2 costUsd-only pool counts its attempts as priced by that amount', () => {
  const total = recordTotals({ pools: { acme: { attempts: 2, minutes: 3, costUsd: 0.5 } } });
  assert.equal(total.apiUsd, 0.5);
  assert.equal(total.pricedAttempts, 2);
  assert.equal(total.tokenSource, 'estimated:utf8-bytes/4', 'a pre-basis amount was the bytes/4 estimate');
});

test('M2: mixing a priced and an unpriced old pool makes the whole amount unknown', () => {
  const total = recordTotals({ pools: {
    acme: { attempts: 1, minutes: 1, costUsd: 0.5 },
    initech: { attempts: 1, minutes: 1, costUsd: null },
  } });
  assert.equal(total.apiUsd, null);
  assert.equal(total.apiKnownSubtotalUsd, 0.5);
});

// ------------------------------------------------------- attempt records

test('rollups store one metrics record per attempt, planner and scout included', () => {
  const state = {
    schemaVersion: 'bullswarm.workflow.state.v2',
    runId: 'wf-metrics-1', shortId: 'met001',
    intent: { goal: 'g', cwd: '/tmp/acme' },
    lifecycle: { status: 'completed', startedAt: iso(0), finishedAt: iso(60) },
    preflight: { scout: { attempts: [attempt({ pool: 'initech', start: 0, end: 2, api: 0.1 })] } },
    planner: { attempts: [attempt({ pool: 'initech', start: 2, end: 5, api: 0.2 })] },
    attempts: [attempt({ pool: 'acme', model: 'm2', start: 5, end: 20, api: 3 })],
    actions: [{ id: 's1', status: 'succeeded' }],
  };
  const record = rollupRecord(state, null, { project: 'acme', now: T0 + 3_600_000 });
  assert.deepEqual(record.attemptMetrics.map((metric) => [metric.role, metric.pool, metric.model, metric.provider, metric.apiUsd]), [
    ['scout', 'initech', 'm1', 'initech', 0.1],
    ['planner', 'initech', 'm1', 'initech', 0.2],
    ['worker', 'acme', 'm2', 'acme', 3],
  ]);
  const byModel = sumEntries(recordEntries(record, { by: 'model' }).filter((entry) => entry.key === 'm2'));
  assert.equal(byModel.apiUsd, 3, 'per-attempt records carry money per model');
  assert.equal(recordTotals(record).apiUsd, 3.3);
});

test('attemptMetric names the retry and the outcome', () => {
  const metric = attemptMetric({ ...attempt(), attemptNumber: 2, status: 'failed' }, { role: 'worker' });
  assert.equal(metric.retry, 1);
  assert.equal(metric.outcome, 'failed');
});

// ------------------------------------------ Stats and Budget read the same

test('Stats and Budget sum a run\'s money from its attempts, so they agree on one run', () => {
  // A record whose run-level total disagrees with its pool entries: the pool
  // entries are the attempt grain, and both pages must read them.
  const record = {
    runId: 'wf-agree-1', shortId: 'agr001', project: 'acme', status: 'completed', verified: false,
    startedAt: iso(0), finishedAt: iso(30),
    minutes: { active: 30, span: 30 },
    pools: { acme: { attempts: 1, minutes: 30, apiUsd: 12, apiKnownSubtotalUsd: 12, pricedAttempts: 1, measuredAttempts: 1, tokenSource: 'provider-reported' } },
    models: { m1: { attempts: 1, minutes: 30 } },
    usage: { attempts: 1, apiUsd: 2, apiKnownSubtotalUsd: 2, pricedAttempts: 1, tokenSource: 'provider-reported' },
  };
  const now = T0 + 3_600_000;
  const stats = overviewModel([record], [], { period: '7d', now });
  const budget = budgetModel([{ name: 'acme' }], { rollups: [record], period: 'week', now, sampledAt: iso(60) });
  assert.equal(stats.keys.apiUsd, 12);
  assert.equal(stats.today.apiUsd, 12);
  assert.equal(poolsModel([record], [], { period: '7d', now }).rows[0].apiUsd, 12);
  assert.equal(budget.rows[0].apiEquivalentUsd, 12);
});

// ---------------------------------------------------------- legacy reader

function taskEntry(overrides = {}) {
  return {
    ts: iso(12), kind: 'run', source: 'run', id: 'task-acme-1', lane: 'build',
    pool: 'acme', picked: 'acme', model: 'm1', ok: true, why: 'verified',
    startedAt: iso(2), endedAt: iso(12), durationMs: 600_000, wallSec: 600,
    project: 'acme', cwd: '/tmp/acme', taskFile: '/tmp/acme-task.md', outFile: '/tmp/acme-out.md',
    usage: { tokenSource: 'provider-reported', tokens: { totalKnown: 50 }, api: { usd: 0.25 } },
    ...overrides,
  };
}

test('M6: an old single-run log entry becomes a one-attempt record, marked legacy', () => {
  const record = legacyTaskRecord(taskEntry());
  assert.equal(record.legacy, true);
  assert.equal(record.kind, 'task');
  assert.equal(record.finishedAt, iso(12));
  assert.equal(record.status, 'completed');
  assert.equal(record.minutes.active, 10);
  assert.equal(record.project, 'acme');
  const total = recordTotals(record);
  assert.equal(total.attempts, 1);
  assert.equal(total.apiUsd, 0.25);
  assert.equal(total.minutes, 10);
});

test('M6: a log entry with no amount and no start keeps both unknown', () => {
  const record = legacyTaskRecord(taskEntry({
    kind: undefined, source: undefined, id: undefined, startedAt: undefined, wallSec: undefined, durationMs: undefined,
    usage: { tokenSource: 'unknown' },
  }));
  assert.equal(record.minutes.active, null);
  assert.equal(recordTotals(record).apiUsd, null);
  assert.equal(recordTotals(record).apiKnownSubtotalUsd, null);
  assert.equal(record.ok, true);
});

test('single runs count in Stats, Budget and History through readRollups', () => {
  const { dir, cleanup } = tempHome();
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      decisionLog: [
        taskEntry(),
        { ts: iso(20), source: 'workflow-v2', picked: 'acme', actionId: 's1', wallSec: 60 },
      ],
    }));
    assert.equal(readLegacyTaskRecords(dir).length, 1, 'workflow attempt entries are not single runs');
    const records = readRollups(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'task');
    const now = T0 + 3_600_000;
    assert.equal(overviewModel(records, [], { period: '7d', now }).keys.workflows, 1);
    const budget = budgetModel([{ name: 'acme' }], { rollups: records, period: 'week', now, sampledAt: iso(60) });
    assert.equal(budget.rows[0].runs, 1);
    assert.equal(budget.rows[0].apiEquivalentUsd, 0.25);
    const [day] = historyDays(dir, { days: 1, now, tasks: [] });
    assert.equal(day.finished, 1);
    assert.equal(day.spendUsd, 0.25);
    assert.equal(day.rows.length, 1);
    assert.equal(day.rows[0].kind, 'task');
  } finally { cleanup(); }
});

test('History does not list a single run twice when it arrives as a record and as a task row', () => {
  const { dir, cleanup } = tempHome();
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ decisionLog: [taskEntry()] }));
    const task = { ...taskEntry(), endedAt: iso(12) };
    const [day] = historyDays(dir, { days: 1, now: T0 + 3_600_000, tasks: [task] });
    assert.equal(day.rows.length, 1);
  } finally { cleanup(); }
});

// --------------------------------------------------------- one "today"

test('M5: History files a run on the day it finished, for its count as well as its row', () => {
  const { dir, cleanup } = tempHome();
  try {
    const started = '2026-09-19T12:00:00.000Z';
    const finished = '2026-09-20T12:00:00.000Z';
    const record = {
      schemaVersion: 'bullswarm.workflow.rollup.v1', runId: 'wf-day-1', shortId: 'day001',
      startedAt: started, finishedAt: finished, status: 'completed', pools: {}, models: {},
    };
    writeFileSync(join(dir, 'history', 'runs.jsonl'), `${JSON.stringify(record)}\n`);
    const days = historyDays(dir, { days: 2, now: Date.parse('2026-09-20T13:00:00.000Z') });
    const byDate = Object.fromEntries(days.map((day) => [day.date, day]));
    assert.equal(byDate['2026-09-20'].runs, 1);
    assert.equal(byDate['2026-09-19']?.runs ?? 0, 0);
  } finally { cleanup(); }
});

// ------------------------------------------------ one copy of the maths

test('the page models hold no private copy of the metric arithmetic', () => {
  const dir = new URL('../src/workflow/', import.meta.url);
  const files = ['rollup.js', 'stats-model.js', 'budget-model.js', 'history.js', 'home-model.js', 'run-model.js', 'step-model.js', 'v2-runtime.js'];
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    assert.match(text, /from '\.\/metrics\.js'/, `${file} reads its metrics through metrics.js`);
    assert.doesNotMatch(text, /TOKEN_SOURCE_RANK = /, `${file} defines no token-source rank of its own`);
    assert.doesNotMatch(text, /SUBSCRIPTION_BASIS_RANK = /, `${file} defines no subscription-basis rank of its own`);
    assert.doesNotMatch(text, /previous\.end = Math\.max|previous\[1\] = Math\.max|finish = Math\.max\(finish/, `${file} merges no intervals itself`);
  }
  assert.ok(readdirSync(dir).includes('metrics.js'));
});
