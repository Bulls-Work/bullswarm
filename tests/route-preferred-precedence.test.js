// Selection order inside pickPool when a configured assignment (preferredPool)
// meets a free pool, an over-limit forecast, a draining pool or a near-limit pool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool } from '../src/lib/route.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const mk = (name, over) => ({ name, lanes: ['analyze', 'build', 'chore'], connector: { name }, ...over });
const row = (route, name) => route.candidates.find((c) => c.pool === name);

test('today: a free pool beats the preferred pool', () => {
  // Looks wrong if the operator's assignment is meant to be an explicit choice:
  // the free tier narrows `selectable` before the preference is read.
  const route = pickPool('build', [mk('f', { free: true, pace: 0 }), mk('p', { pace: 30 })], { now: NOW, preferredPool: 'p' });
  assert.equal(route.pick.pool, 'f');
  assert.match(route.why, /free pool first: f/);
});

test('a preferred pool forecast over the wall is replaced by a pool inside it', () => {
  const p = mk('p', { pace: 30, fiveHourUsedPct: 50, projectedFiveHourPct: 120 });
  const route = pickPool('build', [p, mk('q', { pace: 1 })], { now: NOW, preferredPool: 'p' });
  assert.equal(route.pick.pool, 'q');
  assert.equal(row(route, 'p').forecastOverLimit, true);
  assert.match(route.why, /forecast over 100% \(still eligible; ranked last\): p 120%/);
});

test('a preferred pool near its 5h limit is still taken, and the reason says last mile', () => {
  const p = mk('p', { pace: 5, fiveHourUsedPct: 90, fiveHourResetsAt: iso(NOW + 250 * MIN) });
  const route = pickPool('build', [p, mk('q', { pace: 10 })], { now: NOW, preferredPool: 'p' });
  assert.equal(route.pick.pool, 'p');
  assert.match(route.why, /^configured effort assignment \(p, 5h used 90%/);
  assert.match(route.why, /last mile: p 90% of 5h/);
});

const weekly = (name, over) => mk(name, {
  pacingWindow: 'weekly', paceResetsAt: iso(NOW + 60 * MIN), pace: 10, ...over,
});

test('a preferred pool that is draining is replaced by a pool that is not', () => {
  const drain = weekly('p', { usedPct: 96, elapsedPct: 50, spend: { pacing: { ratePerMinute: 0.001 } } });
  const route = pickPool('build', [drain, mk('q', { pace: 1 })], { now: NOW, preferredPool: 'p' });
  assert.equal(row(route, 'p').urgencyState, 'draining');
  assert.equal(route.pick.pool, 'q');
  assert.match(route.why, /expiring but draining/);
});

test('a draining preferred pool is taken when nothing else is left', () => {
  const drain = weekly('p', { usedPct: 96, elapsedPct: 50, spend: { pacing: { ratePerMinute: 0.001 } } });
  assert.equal(pickPool('build', [drain], { now: NOW, preferredPool: 'p' }).pick.pool, 'p');
});

test('an urgent pool beats the preferred pool', () => {
  const urgent = weekly('u', { usedPct: 40, elapsedPct: 90, spend: { pacing: { ratePerMinute: 0.001 } } });
  const route = pickPool('build', [urgent, mk('p', { pace: 30 })], { now: NOW, preferredPool: 'p' });
  assert.equal(row(route, 'u').urgencyState, 'urgent');
  assert.equal(route.pick.pool, 'u');
});

test('a preferred pool outside the lane is ignored', () => {
  const route = pickPool('build', [mk('p', { lanes: ['analyze'], pace: 30 }), mk('q', { pace: 1 })], { now: NOW, preferredPool: 'p' });
  assert.equal(route.pick.pool, 'q');
});
