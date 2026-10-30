// windowSpent: the one gate every pick reads (pickPool, preparePools, no-pool-why).
// Fixed clock, hand-built pool views, no meters read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSpent } from '../src/meters/framework.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('a window at 100% whose reset has passed is not spent', () => {
  assert.equal(windowSpent({ fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW - 60e3) }, NOW), null);
});

test('99.9% with a future reset is not spent', () => {
  assert.equal(windowSpent({ fiveHourUsedPct: 99.9, fiveHourResetsAt: iso(NOW + 60e3) }, NOW), null);
});

test('100% with a future reset is spent on the 5-hour window and names the reset', () => {
  assert.deepEqual(windowSpent({ fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 60e3) }, NOW),
    { window: '5-hour', resetsAt: iso(NOW + 60e3) });
});

test('a reset given as epoch milliseconds counts', () => {
  assert.deepEqual(windowSpent({ fiveHourUsedPct: 100, fiveHourResetsAt: NOW + 60e3 }, NOW),
    { window: '5-hour', resetsAt: iso(NOW + 60e3) });
  assert.equal(windowSpent({ fiveHourUsedPct: 100, fiveHourResetsAt: NOW - 1 }, NOW), null);
});

test('a full window that names no reset stays spent', () => {
  assert.deepEqual(windowSpent({ pacingWindow: 'weekly', usedPct: 100 }, NOW), { window: 'weekly', resetsAt: null });
  assert.deepEqual(windowSpent({ fiveHourUsedPct: 100 }, NOW), { window: '5-hour', resetsAt: null });
});

test('several full windows report the one that resets last', () => {
  const snapshot = {
    five_hour: { utilization: 100, resets_at: iso(NOW + 30 * 60e3) },
    seven_day: { utilization: 100, resets_at: iso(NOW + 5000 * 60e3) },
  };
  assert.deepEqual(windowSpent({ meterSnapshot: snapshot }, NOW),
    { window: 'weekly', resetsAt: iso(NOW + 5000 * 60e3) });
});

test('a full window with no reset outlasts one with a known reset', () => {
  const snapshot = {
    five_hour: { utilization: 100, resets_at: iso(NOW + 30 * 60e3) },
    monthly: { utilization: 100 },
  };
  assert.deepEqual(windowSpent({ meterSnapshot: snapshot }, NOW), { window: 'monthly', resetsAt: null });
});

test('a declared meter never counts as spent', () => {
  assert.equal(windowSpent({ meterSource: 'declared', pacingWindow: 'weekly', usedPct: 100, paceResetsAt: iso(NOW + 60e3) }, NOW), null);
});

test('a quota-refusal window with a guessed reset is ignored; a named or measured reset counts', () => {
  const marker = (reset_source) => ({ meterSnapshot: {
    five_hour: { utilization: 100, source: 'quota-refusal', reset_source, resets_at: iso(NOW + 60e3) },
  } });
  assert.equal(windowSpent(marker('guessed'), NOW), null);
  assert.equal(windowSpent(marker(undefined), NOW), null, 'a marker that says nothing counts as guessed');
  assert.deepEqual(windowSpent(marker('named'), NOW), { window: '5-hour', resetsAt: iso(NOW + 60e3) });
  assert.deepEqual(windowSpent(marker('measured'), NOW), { window: '5-hour', resetsAt: iso(NOW + 60e3) });
});

test('a hand-built burstGate view is spent on the 5-hour window with no reset', () => {
  assert.deepEqual(windowSpent({ burstGate: true }, NOW), { window: '5-hour', resetsAt: null });
});

test('the pacing window reads flat usedPct / paceResetsAt even when the snapshot says otherwise', () => {
  const pool = {
    pacingWindow: 'weekly', usedPct: 100, paceResetsAt: iso(NOW + 90 * 60e3),
    meterSnapshot: { seven_day: { utilization: 10, resets_at: iso(NOW + 90 * 60e3) } },
  };
  assert.deepEqual(windowSpent(pool, NOW), { window: 'weekly', resetsAt: iso(NOW + 90 * 60e3) });
});

test('a non-object pool is not spent', () => {
  assert.equal(windowSpent(null, NOW), null);
  assert.equal(windowSpent('pool', NOW), null);
});
