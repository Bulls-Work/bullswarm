// decideUsageLimit on a plain throttle line: the 94/95 meter boundary, a reset
// that has passed, a quota-refusal window, and which full window wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUsageLimit, QUOTA_METER_SPENT_PCT } from '../src/lib/quota.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const decide = (meter) => decideUsageLimit({ text: '429 rate limit exceeded', meter, now: NOW, timeZone: 'UTC' });
const five = (utilization, resets_at = iso(NOW + HOUR), extra = {}) => ({ five_hour: { utilization, resets_at, ...extra } });

test('the spent line is 95', () => {
  assert.equal(QUOTA_METER_SPENT_PCT, 95);
});

test('the throttle line itself says no window and names no reset', () => {
  const result = decide({});
  assert.equal(result.limit, 'throttle');
  assert.equal(result.rule, 'transient');
  assert.equal(result.until, null);
});

test('a meter at 94% leaves a throttle transient', () => {
  const result = decide(five(94));
  assert.equal(result.rule, 'transient');
  assert.equal(result.until, null);
  assert.match(result.why, /^rate limited \(transient\)/);
});

test('a meter at 95% makes the throttle a spent window until that window resets', () => {
  const result = decide(five(95));
  assert.equal(result.rule, 'meter');
  assert.equal(result.until, NOW + HOUR);
  assert.equal(result.resetsAt, iso(NOW + HOUR));
  assert.equal(result.meterWindow.window, '5h');
});

test('a meter at 100% is a spent window too', () => {
  assert.equal(decide(five(100)).rule, 'meter');
});

test('a full window whose reset has passed is ignored', () => {
  assert.equal(decide(five(100, iso(NOW - 60e3))).rule, 'transient');
});

test('a full window with no reset is ignored', () => {
  assert.equal(decide({ five_hour: { utilization: 100 } }).rule, 'transient');
});

test('a quota-refusal window never counts, however full', () => {
  assert.equal(decide(five(100, iso(NOW + HOUR), { source: 'quota-refusal' })).rule, 'transient');
});

test('two full windows: the fuller one wins', () => {
  const result = decide({
    ...five(96, iso(NOW + HOUR)),
    seven_day: { utilization: 99, resets_at: iso(NOW + 50 * HOUR) },
  });
  assert.equal(result.rule, 'meter');
  assert.equal(result.meterWindow.window, 'weekly');
  assert.equal(result.until, NOW + 50 * HOUR);
});

test('two windows equally full: the one that resets first wins', () => {
  const result = decide({
    seven_day: { utilization: 100, resets_at: iso(NOW + 50 * HOUR) },
    five_hour: { utilization: 100, resets_at: iso(NOW + HOUR) },
  });
  assert.equal(result.meterWindow.window, '5h');
  assert.equal(result.until, NOW + HOUR);
});

test('a window below the line is ignored while another full one decides', () => {
  const result = decide({
    five_hour: { utilization: 40, resets_at: iso(NOW + HOUR) },
    monthly: { utilization: 97, resets_at: iso(NOW + 100 * HOUR) },
  });
  assert.equal(result.meterWindow.window, 'monthly');
});
