// preparePools gates: sign-in-dead and spent pools drop out; ignoreBurstGate
// keeps both; a strictPool pin defines the whole universe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePools, meterSignInDead } from '../src/workflow/dispatch-pools.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const mk = (name, over = {}) => ({
  name, enabled: true, lanes: ['analyze', 'build', 'chore'],
  connector: { name, model: 'm', spawn: { cmd: ['fake'] } },
  ...over,
});
const names = (pools) => pools.map((p) => p.name);
const prepare = (pools, opts = {}) => preparePools(pools, 'build', 'medium', { now: NOW, ...opts });

test('meterSignInDead is true only for an explicit meterSignInFailed === true', () => {
  assert.equal(meterSignInDead(mk('a', { meterSignInFailed: true })), true);
  assert.equal(meterSignInDead(mk('a', { meterSignInFailed: 'yes' })), false);
  assert.equal(meterSignInDead(mk('a')), false);
  assert.equal(meterSignInDead(null), false);
});

test('a pool whose meter read a sign-in failure is dropped', () => {
  assert.deepEqual(names(prepare([mk('dead', { meterSignInFailed: true }), mk('ok')])), ['ok']);
});

test('a pool with a spent 5-hour window is dropped', () => {
  const spent = mk('spent', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 10 * 60e3) });
  assert.deepEqual(names(prepare([spent, mk('ok')])), ['ok']);
});

test('a window at 100% whose reset has passed does not drop the pool', () => {
  const over = mk('over', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW - 60e3) });
  assert.deepEqual(names(prepare([over, mk('ok')])), ['over', 'ok']);
});

test('a disabled pool is dropped', () => {
  assert.deepEqual(names(prepare([mk('off', { enabled: false }), mk('ok')])), ['ok']);
});

test('ignoreBurstGate keeps spent pools', () => {
  const spent = mk('spent', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 10 * 60e3) });
  assert.deepEqual(names(prepare([mk('ok'), spent], { ignoreBurstGate: true })), ['ok', 'spent']);
});

test('today: ignoreBurstGate also keeps a sign-in-dead pool', () => {
  // Looks wrong for a "which pools could ever run this" answer: a dead credential
  // cannot run anything until a meter read succeeds, yet it is listed as capable.
  const dead = mk('dead', { meterSignInFailed: true });
  assert.deepEqual(names(prepare([dead, mk('ok')], { ignoreBurstGate: true })), ['dead', 'ok']);
});

test('a strictPool pin on a spent pool yields an empty universe', () => {
  const spent = mk('spent', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 10 * 60e3) });
  assert.deepEqual(prepare([spent, mk('ok')], { strictPool: 'spent' }), []);
});

test('a strictPool pin on a missing pool yields an empty universe', () => {
  assert.deepEqual(prepare([mk('ok')], { strictPool: 'missing' }), []);
});

test('a strictPool pin on a healthy pool yields only that pool', () => {
  assert.deepEqual(names(prepare([mk('ok'), mk('other')], { strictPool: 'other' })), ['other']);
});

test('strictPool with ignoreBurstGate keeps the spent pool it names', () => {
  const spent = mk('spent', { fiveHourUsedPct: 100, fiveHourResetsAt: iso(NOW + 10 * 60e3) });
  assert.deepEqual(names(prepare([spent, mk('ok')], { strictPool: 'spent', ignoreBurstGate: true })), ['spent']);
});
