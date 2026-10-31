// pickPool tests exhaustion on the RAW pool (windowSpent), then charges a stale
// meter (staleAdjusted) only as a soft score. These pin what that does today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool } from '../src/lib/route.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const mk = (name, over) => ({ name, lanes: ['analyze', 'build', 'chore'], connector: { name }, ...over });
const row = (route, name) => route.candidates.find((c) => c.pool === name);

const staleA = () => mk('a', {
  fiveHourUsedPct: 97, pace: 20, meterCapturedAt: iso(NOW - 60 * MIN),
  spend: { fiveHour: { ratePerMinute: 1 } },
});
const freshB = () => mk('b', { fiveHourUsedPct: 10, pace: 5 });

test('a stale pool near its wall gives way to a fresh pool, and the charge is reported', () => {
  const route = pickPool('build', [staleA(), freshB()], { now: NOW });
  assert.equal(route.pick.pool, 'b');
  // 60 minutes old = 50 minutes past the 10-minute line, at 1 pt/min, capped at 50.
  assert.equal(row(route, 'a').staleMeter.fiveHourPenalty, 50);
  assert.match(route.why, /stale meter charged: a \(60m old: 5h \+50\)/);
});

test('today: a stale pool charged past 100% stays eligible and is picked when it is the only one', () => {
  // Looks wrong: 97% read an hour ago, charged +50, is shown as 147% used and
  // still gets the step, because exhaustion looks at the raw reading (97%).
  const route = pickPool('build', [staleA()], { now: NOW });
  assert.equal(route.pick.pool, 'a');
  assert.equal(row(route, 'a').fiveHourUsedPct, 147);
  assert.match(route.why, /last mile: a 147% of 5h/);
});

test('today: a sole pool read at 99% five hours ago is picked with the flat +5 charge', () => {
  const route = pickPool('build', [mk('a', { fiveHourUsedPct: 99, pace: 5, meterCapturedAt: iso(NOW - 300 * MIN) })], { now: NOW });
  assert.equal(route.pick.pool, 'a');
  assert.equal(row(route, 'a').staleMeter.fiveHourPenalty, 5);
  assert.equal(row(route, 'a').fiveHourUsedPct, 104);
});

test('a stale charge that pushes the forecast over the wall ranks the pool last', () => {
  const a = { ...staleA(), projectedFiveHourPct: 60 };
  const route = pickPool('build', [a, freshB()], { now: NOW });
  assert.equal(route.pick.pool, 'b');
  assert.equal(row(route, 'a').forecastOverLimit, true);
  assert.match(route.why, /forecast over 100% \(still eligible; ranked last\): a 110%/);
});

test('the over-limit pool is still picked when every pool is over the wall', () => {
  const a = { ...staleA(), projectedFiveHourPct: 60 };
  const route = pickPool('build', [a], { now: NOW });
  assert.equal(route.pick.pool, 'a');
});

test('a raw reading at 100% with a future reset keeps the pool out, stale or not', () => {
  const spent = mk('a', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 30 * MIN), pace: 20 });
  const route = pickPool('build', [spent, freshB()], { now: NOW });
  assert.equal(route.pick.pool, 'b');
  assert.equal(row(route, 'a'), undefined);
});

test('a fresh reading is never charged', () => {
  const a = { ...staleA(), meterCapturedAt: iso(NOW - 5 * MIN) };
  assert.equal(row(pickPool('build', [a], { now: NOW }), 'a').staleMeter, null);
});
