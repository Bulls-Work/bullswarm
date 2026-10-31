// One rule for a window's utilization across every meter path: a finite
// number or a decimal-number string is a reading; anything else, and anything
// below 0, is no reading (never "unused"); above 100 is kept but paced as 100.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { meterReadingOf } from '../src/lib/quota.js';
import { paceSnapshot, windowSpent, usedPctOf } from '../src/meters/framework.js';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const WEEK_RESET = '2026-10-12T12:00:00Z';
const FIVE_RESET = '2026-10-09T12:30:00Z';
const week = (utilization) => ({ seven_day: { utilization, resets_at: WEEK_RESET } });
const five = (utilization) => ({ five_hour: { utilization, resets_at: FIVE_RESET } });

const GARBAGE = [['empty string', ''], ['whitespace', '  '], ['true', true], ['false', false],
  ['array', []], ['object', {}], ['NaN', NaN], ['Infinity', Infinity], ['negative', -30],
  ['negative string', '-30'], ['hex string', '0x10'], ['word', 'abc']];

for (const [name, raw] of GARBAGE) {
  test(`${name} is no reading in every path`, () => {
    assert.equal(usedPctOf(raw), null);
    assert.equal(meterReadingOf(week(raw), { now: NOW }), null);
    assert.equal(meterReadingOf(five(raw), { now: NOW }), null);
    assert.deepEqual(paceSnapshot(week(raw), NOW).windows, {});
    assert.deepEqual(paceSnapshot(five(raw), NOW).windows, {});
    assert.equal(paceSnapshot(five(raw), NOW).fiveHourUsedPct, null);
    assert.equal(paceSnapshot(week(raw), NOW).pacing, null);
    assert.equal(windowSpent({ meterSnapshot: { ...week(raw), ...five(raw) } }, NOW), null);
  });
}

for (const raw of [80, '80', ' 80 ']) {
  test(`${JSON.stringify(raw)} reads as 80 in every path`, () => {
    assert.equal(usedPctOf(raw), 80);
    assert.equal(meterReadingOf(week(raw), { now: NOW }).windows[0].usedPct, 80);
    assert.equal(paceSnapshot(week(raw), NOW).windows.seven_day.usedPct, 80);
    assert.equal(paceSnapshot(five(raw), NOW).windows.five_hour.usedPct, 80);
    assert.equal(paceSnapshot(five(raw), NOW).fiveHourUsedPct, 80);
    assert.equal(paceSnapshot(five(raw), NOW).nearFiveHourLimit, true);
  });
}

test("'100' is spent, like 100", () => {
  for (const raw of [100, '100']) {
    assert.equal(windowSpent({ meterSnapshot: week(raw) }, NOW)?.window, 'weekly');
    assert.equal(windowSpent({ meterSnapshot: five(raw) }, NOW)?.window, '5-hour');
    assert.equal(paceSnapshot(five(raw), NOW).burstGate, true);
  }
});

test('250 is spent and paced as 100', () => {
  assert.equal(usedPctOf(250), 250);
  assert.equal(windowSpent({ meterSnapshot: week(250) }, NOW)?.window, 'weekly');
  assert.equal(paceSnapshot(week(250), NOW).windows.seven_day.usedPct, 100);
  assert.equal(paceSnapshot(five(250), NOW).windows.five_hour.usedPct, 100);
  assert.equal(paceSnapshot(five(250), NOW).fiveHourUsedPct, 100);
  assert.equal(paceSnapshot(five(250), NOW).burstGate, true);
});

test('0 and 0.0 stay a real reading of unused', () => {
  assert.equal(usedPctOf(0), 0);
  assert.equal(usedPctOf('0'), 0);
  assert.equal(paceSnapshot(week(0), NOW).windows.seven_day.usedPct, 0);
  assert.equal(meterReadingOf(week('0'), { now: NOW }).windows[0].usedPct, 0);
});

test('a garbage weekly window cannot win routing as almost unused', () => {
  const pace = paceSnapshot(week(-20), NOW);
  assert.equal(pace.pacing, null);
});
