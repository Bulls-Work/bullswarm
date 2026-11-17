// parseQuotaResetAt edges: wall-clock rollover, midnight/noon, named zones, a
// date already past, the 7-day cap, and a number with no unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaResetAt } from '../src/lib/quota.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const at = (text, timeZone = 'UTC') => parseQuotaResetAt(text, { now: NOW, timeZone });
const z = (value) => Date.parse(value);

test('12am is the coming midnight', () => {
  assert.equal(at('resets 12am'), z('2026-11-01T00:00:00Z'));
});

test('12pm when it is already 12:00 is tomorrow noon', () => {
  assert.equal(at('resets 12pm'), z('2026-11-01T12:00:00Z'));
});

test('a wall time already passed today rolls to tomorrow', () => {
  assert.equal(at('resets 9am'), z('2026-11-01T09:00:00Z'));
});

test('a wall time later today stays today', () => {
  assert.equal(at('resets 3pm'), z('2026-10-31T15:00:00Z'));
});

test('a named IANA zone shifts the instant', () => {
  assert.equal(at('resets 3pm (America/New_York)'), z('2026-10-31T19:00:00Z'));
});

test('an invalid zone name falls back to the zone passed in', () => {
  assert.equal(at('resets 3pm (Not/AReal)'), at('resets 3pm'));
  assert.equal(at('resets 3pm (Not/AReal)'), z('2026-10-31T15:00:00Z'));
});

test('a relative reset beyond 7 days is a parse artifact', () => {
  assert.equal(at('retry in 8 days'), null);
  assert.equal(at('retry in 6 days'), NOW + 6 * 86_400_000);
});

test('today: a "Month day" with no year that is already past returns null, not next year', () => {
  // Looks wrong: "resets Oct 30 at 4pm" read on Oct 31 is a past date in this year
  // and is dropped, so the pool is treated as having no named reset at all.
  assert.equal(at('resets Oct 30 at 4pm'), null);
});

test('a "Month day" later this week parses', () => {
  assert.equal(at('resets Nov 2 at 4pm'), z('2026-11-02T16:00:00Z'));
});

test('a bare number with no unit names no reset', () => {
  assert.equal(at('try again in 5'), null);
});

test('a relative reset with a unit parses', () => {
  assert.equal(at('try again in 5 minutes'), NOW + 5 * 60_000);
});

test('empty and missing text name no reset', () => {
  assert.equal(at(''), null);
  assert.equal(at(null), null);
});
