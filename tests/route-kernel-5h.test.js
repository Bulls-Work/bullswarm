// BS-kernel-5h: the hold list and opt-in reserve (R14), fit before reset
// (R15) and stale-meter decay (R16), scored on the fleet's real pools at
// 2026-10-14T22:42Z (tests/fixtures/meters/pools-2026-10-14T2242Z.json:
// `bullswarm pools --json` on the lead Mac, enabled pools, router fields only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickPool, staleAdjusted, MIN_FIT_FOR_URGENT } from '../src/lib/route.js';
import { activeHold, reserveReached, parseHoldUntil, operatorLimit } from '../src/lib/pool-limits.js';
import { preparePools } from '../src/workflow/dispatch-pools.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/meters/pools-2026-10-14T2242Z.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-14T22:42:45Z');
const HOUR = 3_600_000;

// codex's sign-in is dead (401) and dispatch drops it before the router
// (preparePools); the router tests start from the pools dispatch hands it.
function realPools(edit = {}) {
  return FIXTURE.pools
    .filter((p) => p.name !== 'codex')
    .map((p) => ({ ...structuredClone(p), ...(edit[p.name] ?? {}) }));
}

const byName = (route, name) => route.candidates.find((c) => c.pool === name);

test('real snapshot: kipwise, 17 minutes from its 5h reset, takes a short task', () => {
  const route = pickPool('build', realPools(), { now: NOW, candidateMinutes: 10 });
  assert.equal(route.pick.pool, 'claude-code:kipwise');
  assert.match(route.why, /^expiring soon: claude-code:kipwise resets in 17m/);
  assert.equal(byName(route, 'claude-code:kipwise').fitBeforeReset, 1);
  assert.equal(byName(route, 'claude-code:kipwise').urgencyState, 'urgent');
});

test('R15 fit before reset: a task mostly after the reset is not urgent there, and is not refused', () => {
  // 120 expected minutes, 17 before the reset: 14% fits (< MIN_FIT_FOR_URGENT).
  const long = pickPool('build', realPools(), { now: NOW, candidateMinutes: 120 });
  const kip = byName(long, 'claude-code:kipwise');
  assert.ok(kip.fitBeforeReset < MIN_FIT_FOR_URGENT);
  assert.equal(kip.urgencyState, 'normal');
  // It competes on surplus: wati (+38.2 weekly) beats kipwise (+18.3).
  assert.equal(long.pick.pool, 'claude-code:wati');
  assert.ok(long.candidates.some((c) => c.pool === 'claude-code:kipwise'), 'kipwise stays eligible');

  // 40 minutes: 43% fits. Still urgent, urgency scaled by the fit, and said.
  const mid = pickPool('build', realPools(), { now: NOW, candidateMinutes: 40 });
  const short = pickPool('build', realPools(), { now: NOW, candidateMinutes: 10 });
  assert.equal(mid.pick.pool, 'claude-code:kipwise');
  const midKip = byName(mid, 'claude-code:kipwise');
  assert.ok(midKip.fitBeforeReset > 0.4 && midKip.fitBeforeReset < 0.45);
  assert.ok(midKip.urgency < byName(short, 'claude-code:kipwise').urgency);
  assert.match(mid.why, /× 4\d\.\d% of the task before the reset/);

  // Only the pool with the poor fit is affected; with no estimate nothing changes.
  const unknown = pickPool('build', realPools(), { now: NOW });
  assert.equal(unknown.pick.pool, 'claude-code:kipwise');
  assert.equal(byName(unknown, 'claude-code:kipwise').fitBeforeReset, null);
});

test('R14 reserve is off by default and, when set, stops new picks at 100 - reserve', () => {
  // Default: no reserve, kipwise at 76% of 5h is burned on.
  assert.equal(pickPool('build', realPools(), { now: NOW, candidateMinutes: 10 }).pick.pool, 'claude-code:kipwise');

  // reserve 40 on the 5h window: ceiling 60%, kipwise is at 76% → kept out, and named.
  const reserved = pickPool('build', realPools({ 'claude-code:kipwise': { reserve: { pct: 40, window: '5h' } } }), { now: NOW, candidateMinutes: 10 });
  assert.notEqual(reserved.pick.pool, 'claude-code:kipwise');
  assert.equal(byName(reserved, 'claude-code:kipwise'), undefined);
  assert.match(reserved.why, /kept out: claude-code:kipwise at its reserve: 5h 76% >= 60% \(reserve 40%\)/);

  // reserve 20: ceiling 80%, 76% is under it → still picked.
  const under = pickPool('build', realPools({ 'claude-code:kipwise': { reserve: { pct: 20, window: '5h' } } }), { now: NOW, candidateMinutes: 10 });
  assert.equal(under.pick.pool, 'claude-code:kipwise');

  // In-flight work projected past the ceiling counts too (a burst stops at it).
  const projected = realPools({ 'claude-code:kipwise': { reserve: { pct: 20, window: '5h' }, projectedFiveHourPct: 81 } });
  assert.notEqual(pickPool('build', projected, { now: NOW, candidateMinutes: 10 }).pick.pool, 'claude-code:kipwise');

});

test('R14 reserve windows: 5h, pacing and all', () => {
  const wati = realPools().find((p) => p.name === 'claude-code:wati'); // 5h 32%, weekly 36%
  assert.deepEqual(reserveReached({ ...wati, reserve: { pct: 70, window: '5h' } })?.window, '5h');
  assert.equal(reserveReached({ ...wati, reserve: { pct: 60, window: '5h' } }), null);
  assert.equal(reserveReached({ ...wati, reserve: { pct: 70, window: 'monthly' } }), null);
  assert.equal(reserveReached({ ...wati, reserve: { pct: 65, window: 'weekly' } })?.window, 'weekly');
  assert.equal(reserveReached({ ...wati, reserve: { pct: 65 } })?.window, 'weekly');
  assert.equal(reserveReached({ ...wati, reserve: { pct: 0 } }), null);
  assert.equal(reserveReached(wati), null);
});

test('R14 hold list: a held pool is out until its end, then back by itself', () => {
  const hold = { reason: 'Kipwise #767 review', until: new Date(NOW + 2 * HOUR).toISOString() };
  const held = realPools({ 'claude-code:kipwise': { hold } });
  const route = pickPool('build', held, { now: NOW, candidateMinutes: 10 });
  assert.notEqual(route.pick.pool, 'claude-code:kipwise');
  assert.match(route.why, /kept out: claude-code:kipwise held until 2026-10-15T00:42:45.000Z \(Kipwise #767 review\)/);
  // After the hold ends, nothing needs lifting.
  const later = NOW + 3 * HOUR;
  assert.equal(activeHold(held.find((p) => p.name === 'claude-code:kipwise'), later), null);

  // Dispatch's eligibility filter leaves it to the router, so the reason can name it.
  const action = { lane: 'build' };
  const prepared = preparePools(held, action, 'medium', { now: NOW });
  assert.ok(prepared.some((p) => p.name === 'claude-code:kipwise'));
  assert.match(pickPool('build', prepared, { now: NOW, candidateMinutes: 10 }).why, /kept out: claude-code:kipwise held until/);

  // Everything held: no pick, and the reason says why.
  const all = realPools(Object.fromEntries(FIXTURE.pools.map((p) => [p.name, { hold }])));
  const none = pickPool('build', all, { now: NOW });
  assert.equal(none.pick, null);
  assert.match(none.why, /^no eligible pool · kept out: /);
});

test('R16 stale meter: charged the spend it probably missed, so a fresh pool wins a close call', () => {
  const fresh = realPools({ grok: { pace: 37.5 } }).filter((p) => p.name !== 'claude-code:kipwise');
  assert.equal(pickPool('build', fresh, { now: NOW }).pick.pool, 'claude-code:wati'); // 38.2 > 37.5

  // wati's reading 70 minutes old: 60 minutes past the 10-minute line.
  const capturedAt = new Date(NOW - 70 * 60_000).toISOString();
  const stale = realPools({ grok: { pace: 37.5 }, 'claude-code:wati': { meterCapturedAt: capturedAt } })
    .filter((p) => p.name !== 'claude-code:kipwise');
  const view = staleAdjusted(stale.find((p) => p.name === 'claude-code:wati'), NOW);
  assert.deepEqual(view.stale, { minutes: 70, fiveHourPenalty: 17.3, pacingPenalty: 1.3 }); // 0.288×60, 0.0223×60
  assert.equal(view.fiveHourUsedPct, 32 + 0.288443 * 60);
  const route = pickPool('build', stale, { now: NOW });
  assert.equal(route.pick.pool, 'grok');
  assert.match(route.why, /stale meter charged: claude-code:wati \(70m old: 5h \+17.3, weekly \+1.3\)/);
  // The caller gets its own pool object back, not the adjusted view.
  const pickedWati = pickPool('build', stale.filter((p) => p.name === 'claude-code:wati'), { now: NOW });
  assert.equal(pickedWati.pick.connector.fiveHourUsedPct, 32);

  // A fresh reading (snapshot 5 minutes old) is not charged; an unmeasured stale one gets the flat 5.
  assert.equal(staleAdjusted({ ...stale.find((p) => p.name === 'claude-code:wati'), meterCapturedAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW).stale, undefined);
  const unmeasured = staleAdjusted({ name: 'x', usedPct: 10, pace: 20, fiveHourUsedPct: 5, meterCapturedAt: capturedAt }, NOW);
  assert.equal(unmeasured.pace, 15);
  assert.equal(unmeasured.fiveHourUsedPct, 10);
});

test('parseHoldUntil takes a date or a duration', () => {
  assert.equal(parseHoldUntil('24h', NOW), NOW + 24 * HOUR);
  assert.equal(parseHoldUntil('90m', NOW), NOW + 90 * 60_000);
  assert.equal(parseHoldUntil('2026-10-16T12:00:00Z', NOW), Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(parseHoldUntil('soon', NOW), null);
  assert.equal(operatorLimit({ name: 'p', hold: { reason: 'r', until: 'bad' } }, NOW), null);
});

test('CLI: strategy hold / unhold / set-reserve write state and pools shows them', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-kernel5h-cli-'));
  const bin = new URL('../bin/bullswarm.js', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_METER_SNAPSHOT_DIR: '' }, encoding: 'utf8',
  });
  try {
    assert.equal(run('strategy', 'hold', 'echo', '--until', '2h', '--reason', 'test hold').status, 2, 'needs --yes');
    const held = run('strategy', 'hold', 'echo', '--until', '2h', '--reason', 'test hold', '--yes');
    assert.equal(held.status, 0, held.stderr);
    assert.equal(JSON.parse(held.stdout).action, 'pool-held');
    assert.equal(run('strategy', 'hold', 'echo', '--until', 'yesterday', '--reason', 'x', '--yes').status, 2);
    run('strategy', 'set-provider', 'echo', 'on', '--yes');
    let pools = JSON.parse(run('pools', '--json', '--pool', 'echo').stdout).pools;
    assert.equal(pools[0].hold.reason, 'test hold');
    assert.match(run('pools', '--pool', 'echo').stdout, /held until .* \(test hold\)/);
    assert.equal(run('strategy', 'unhold', 'echo', '--yes').status, 0);
    const reserve = run('strategy', 'set-reserve', 'echo', '40', '--window', '5h', '--yes');
    assert.equal(reserve.status, 0, reserve.stderr);
    assert.deepEqual(JSON.parse(reserve.stdout), { action: 'reserve-set', pool: 'echo', pct: 40, window: '5h', ceiling: 60 });
    pools = JSON.parse(run('pools', '--json', '--pool', 'echo').stdout).pools;
    assert.equal(pools[0].hold, null);
    assert.deepEqual(pools[0].reserve, { pct: 40, window: '5h' });
    assert.equal(run('strategy', 'set-reserve', 'echo', '100', '--yes').status, 2);
    assert.equal(run('strategy', 'set-reserve', 'echo', '10', '--window', 'daily', '--yes').status, 2);
    assert.equal(JSON.parse(run('strategy', 'set-reserve', 'echo', 'off', '--yes').stdout).action, 'reserve-cleared');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
