import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measuredTaskMinutes,
  poolRatePerMinute,
  runMinutesInfo,
  runStepCounts,
  todayTopRuns,
  recordCost,
  recordCostInfo,
  taskIdentity,
  taskToday,
  todayDateLabel,
  todayLicenceRows,
  todayMinutesNumberText,
  todayMinutesText,
  todayRows,
} from '../src/workflow/home-model.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = new Date(2026, 8, 20, 12, 0, 0, 0).getTime();
const TODAY = new Date(NOW).toISOString();

test('Home model keeps task identity, dates, durations and nullable figures honest', () => {
  const finished = { id: 'task-1', pool: 'codex', endedAt: TODAY, durationMs: 90_000 };
  assert.equal(taskToday(finished, NOW, { finished: true }), true);
  assert.equal(taskIdentity(finished), 'id:task-1');
  assert.equal(todayMinutesText(1.25), '1.3m');
  assert.equal(todayMinutesNumberText(1.25), '1.3');
  assert.equal(measuredTaskMinutes(finished), 1.5);
  assert.equal(measuredTaskMinutes({ durationMs: 'not measured' }), null);
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
  assert.deepEqual(runStepCounts({ requirements: { passed: 3, total: 4 } }), { done: 3, total: 4 });
});
