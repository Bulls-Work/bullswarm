// A seat whose provider reports only a 5h window (a Claude Team seat: the
// usage API returns `seven_day: null`) is paced on that window. Before, it
// read `unmetered surplus=0` and routing reached it only once every metered
// pool had fallen behind, so its 5h windows expired unused.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fiveHourOnlyPace } from '../src/lib/config.js';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const reading = (fiveHour, extra = {}) => ({
  source: 'cache',
  snapshot: { five_hour: fiveHour, seven_day: { utilization: null, resets_at: null }, monthly: null, ...extra },
});

test('a 5h-only seat is paced on its 5h window: elapsed minus used', () => {
  // The window resets at 12:30, so it opened at 07:30: 50% elapsed.
  const pace = fiveHourOnlyPace(reading({ utilization: 20, resets_at: '2026-10-09T12:30:00Z' }), NOW);
  assert.deepEqual(pace, { usedPct: 20, elapsedPct: 50, surplus: 30, resetsAt: '2026-10-09T12:30:00.000Z' });
});

test('a window not yet opened, or already reset, is wholly unspent', () => {
  assert.equal(fiveHourOnlyPace(reading({ utilization: 0, resets_at: null }), NOW).surplus, 100);
  assert.equal(fiveHourOnlyPace(reading({ utilization: 70, resets_at: '2026-10-09T09:00:00Z' }), NOW).surplus, 100);
});

test('a seat with a weekly or monthly window keeps the 5h window as a gate only', () => {
  const five = { utilization: 20, resets_at: '2026-10-09T12:30:00Z' };
  assert.equal(fiveHourOnlyPace(reading(five, { seven_day: { utilization: 43, resets_at: '2026-10-12T12:00:00Z' } }), NOW), null);
  assert.equal(fiveHourOnlyPace(reading(five, { monthly: { utilization: 10, resets_at: '2026-11-01T00:00:00Z' } }), NOW), null);
});

test('no 5h reading, or a refusal marker, gives no pace', () => {
  assert.equal(fiveHourOnlyPace(reading({ utilization: null, resets_at: null }), NOW), null);
  assert.equal(fiveHourOnlyPace({ ...reading({ utilization: 100, resets_at: '2026-10-09T12:30:00Z' }), source: 'quota-refusal' }, NOW), null);
  assert.equal(fiveHourOnlyPace(null, NOW), null);
});
