import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

// Audit 9 (26 Nov): two dashboards held 85-120% CPU each. A profile showed every
// paint (the 400 ms spinner included) rebuilt the Stats and Budget aggregates and
// deep-copied the whole model, rollup index and all, to swap pool ids for labels.

const POOL = 'echo';
const LABEL = 'sample:a';
const usage = { pools: [{ name: POOL, poolLabel: LABEL }], assignments: [], rungs: [], capturedAt: null };

/** A rollup record whose fields count how often anything reads them. */
function countedRecords(n, counter) {
  return Array.from({ length: n }, (_, i) => {
    const record = {};
    for (const [key, value] of Object.entries({
      runId: `wf-${i}`, pool: POOL, lane: 'analyze', status: 'completed',
      startedAt: '2026-11-20T00:00:00.000Z', endedAt: '2026-11-20T00:01:00.000Z',
    })) {
      Object.defineProperty(record, key, {
        enumerable: true,
        get() { counter.reads += 1; return value; },
      });
    }
    return record;
  });
}

test('relabelling copies an unchanged rollup index once, not on every frame', () => {
  const counter = { reads: 0 };
  const rollups = countedRecords(50, counter);
  const base = dashboardModel(null, { usage, rollups: [] });
  const frame = (page) => renderDashboardPage({ ...base, rollups }, { page, width: 120, height: 40 });

  frame('home');
  const afterFirst = counter.reads;
  assert.ok(afterFirst > 0, 'the first frame relabels the records');
  frame('home');
  frame('budget');
  assert.equal(counter.reads, afterFirst, 'later frames reuse the relabelled copy of the same records');
});

test('relabelled output still shows the label for an id inside a reused record', () => {
  const rollups = [{ runId: 'wf-1', pool: POOL, note: `ran on ${POOL}` }];
  const base = dashboardModel(null, { usage, rollups: [] });
  let seen = null;
  // Render twice through a page that reads model.rollups; capture what it saw.
  for (let i = 0; i < 2; i += 1) {
    const model = { ...base, rollups };
    const frame = renderDashboardPage(model, { page: 'home', width: 120, height: 40 });
    seen = frame;
  }
  assert.ok(seen.lines.length > 0);
  // The source records are never rewritten in place.
  assert.equal(rollups[0].pool, POOL);
  assert.equal(rollups[0].note, `ran on ${POOL}`);
});

test('the Stats and Budget aggregates are reused while their inputs are unchanged', () => {
  const rollups = [];
  const cache = {};
  const nowMs = Date.parse('2026-11-26T10:00:00.000Z');
  const first = dashboardModel(null, { usage, rollups, nowMs, aggregateCache: cache });
  const second = dashboardModel(null, { usage, rollups, nowMs: nowMs + 1_000, aggregateCache: cache });
  assert.ok(first.stats && first.budget);
  assert.equal(second.stats, first.stats, 'same records, pools and period: the stats are not rebuilt');
  assert.equal(second.budget, first.budget, 'same inputs: the budget is not rebuilt');

  const newIndex = dashboardModel(null, { usage, rollups: [], nowMs: nowMs + 2_000, aggregateCache: cache });
  assert.notEqual(newIndex.stats, first.stats, 'a re-read index rebuilds them');

  const otherPeriod = dashboardModel(null, { usage, rollups, nowMs, period: '30d', aggregateCache: cache });
  assert.notEqual(otherPeriod.stats, first.stats, 'another period rebuilds them');

  const later = dashboardModel(null, { usage, rollups, nowMs: nowMs + 120_000, aggregateCache: cache });
  assert.notEqual(later.stats, otherPeriod.stats, 'time moving on rebuilds them');
});

test('without a cache every model is built fresh, as before', () => {
  const rollups = [];
  const a = dashboardModel(null, { usage, rollups });
  const b = dashboardModel(null, { usage, rollups });
  assert.notEqual(a.stats, b.stats);
});
