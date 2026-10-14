import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiringSoonView, pickPool } from '../src/lib/route.js';

// Real meters from 2026-10-14 17:05Z: claude-code:kipwise is a Team seat with
// `seven_day` null, paced on its 5h window (16% used, 81.7% elapsed, resets
// 18:00Z); claude-code is weekly-paced at +7.6.
const now = Date.parse('2026-10-14T17:05:00Z');
const kipwise = {
  name: 'claude-code:kipwise', costRank: 4, lanes: ['analyze', 'build', 'chore'],
  pacingWindow: '5h', usedPct: 16, elapsedPct: 81.7, pace: 65.7,
  paceResetsAt: '2026-10-14T18:00:00Z', fiveHourUsedPct: 16, fiveHourResetsAt: '2026-10-14T18:00:00Z',
};
const personal = {
  name: 'claude-code', costRank: 4, lanes: ['analyze', 'build', 'chore'],
  pacingWindow: 'weekly', usedPct: 24, elapsedPct: 31.6, pace: 7.6,
  paceResetsAt: '2026-10-19T19:00:00Z', fiveHourUsedPct: 28,
};

test('a 5h-only seat near its reset is expiring soon with urgency', () => {
  const v = expiringSoonView(kipwise, { now });
  assert.equal(v.expiringSoon, true);
  assert.equal(v.window, '5h');
  assert.ok(Math.abs(v.urgency - 65.7 / 0.183) < 1);
  assert.equal(v.state, 'urgent');
});

test('a 5h-only seat early in its window is not expiring soon', () => {
  const early = { ...kipwise, elapsedPct: 20, paceResetsAt: '2026-10-14T21:00:00Z' };
  assert.equal(expiringSoonView(early, { now }).expiringSoon, false);
});

test('the urgent 5h seat wins over a same-cost weekly pool with MORE surplus', () => {
  const richer = { ...personal, usedPct: 0, pace: 31.6 + 50 };
  const r = pickPool('build', [richer, { ...kipwise, pace: 40, usedPct: 41.7 }], { now });
  assert.equal(r.pick.pool, 'claude-code:kipwise');
  assert.match(r.why, /of the 5h window left/);
});

test('a 5h-only seat snapshot falls back from the declared weekly window to 5h', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { snapshotPool } = await import('../src/lib/quota-snapshot.js');
  const { MeterCache } = await import('../src/meters/framework.js');
  const home = mkdtempSync(join(tmpdir(), 'bs5h-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ strategy: { subscriptions: { 'claude-code:k': { quotaWindow: 'weekly' } } } }));
  new MeterCache(join(home, 'meters')).put('claude-code:k', {
    captured_at: '2026-10-14T17:13:05.561Z',
    five_hour: { utilization: 17, resets_at: '2026-10-14T18:00:00Z' },
    seven_day: { utilization: null, resets_at: null }, monthly: null, plan_type: 'team',
  });
  const snap = snapshotPool('claude-code:k', { home, now: Date.parse('2026-10-14T17:14:00Z') });
  assert.equal(snap?.window, '5h');
  assert.equal(snap?.usedPct, 17);
});
