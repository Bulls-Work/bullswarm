import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMeterReading, refreshMeterAfterQuota } from '../src/meters/registry.js';
import { MeterCache, windowSpent } from '../src/meters/framework.js';
import { pickPool } from '../src/lib/route.js';

// 2026-10-19 17:41Z: claude-code said "You've hit your session limit · resets
// 2:30am" (a reset the provider named), then its meter read 43% and routing
// picked it again for nine more dispatches.
const NOW = Date.parse('2026-10-19T17:41:00Z');
const H = 3600_000;
const POOL = 'fake-metered';
const connector = { name: POOL, meter: { type: 'reader', window: 'weekly+5h' }, subscription: { quotaWindow: 'weekly' } };

function reading(capturedMs, { fiveHour = 43, fiveResetMs = NOW + 6 * H, weekly = 20, weeklyResetMs = NOW + 3 * 86_400_000 } = {}) {
  return {
    pool: POOL,
    captured_at: new Date(capturedMs).toISOString(),
    five_hour: { utilization: fiveHour, resets_at: new Date(fiveResetMs).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(weeklyResetMs).toISOString() },
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-named-refusal-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  const cache = new MeterCache(join(home, 'meters'));
  cache.put(POOL, reading(NOW - 60_000, { fiveHour: 30 }));
  return { home, cache, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

async function refuse(f, { resetSource, resetAtMs = NOW + 6 * H, meter = connector } = {}) {
  await refreshMeterAfterQuota(POOL, {
    bullswarmDir: f.home,
    connector: meter,
    nowMs: NOW,
    resetAtMs,
    ...(resetSource ? { resetSource } : {}),
    reader: async () => { throw new Error('meter unavailable'); },
  });
  return f.cache.get(POOL).quota_refusal;
}

const live = (f, nowMs, snap) => getMeterReading(POOL, {
  bullswarmDir: f.home, connector, nowMs, force: true, shareMs: 0, singleFlight: false, reader: async () => snap,
});

test('a named refusal survives a live read at 52% until its reset', async () => {
  const f = fixture();
  try {
    const marker = await refuse(f);
    assert.equal(marker.reset_source, 'named');
    const r = await live(f, NOW + 30 * 60_000, reading(NOW + 30 * 60_000, { fiveHour: 52 }));
    assert.equal(r.quotaRefusal?.resetsAt, marker.resets_at);
    assert.equal(r.source, 'quota-refusal');
    assert.equal(f.cache.get(POOL).quota_refusal?.resets_at, marker.resets_at, 'the cache keeps the marker');
    assert.equal(r.snapshot.five_hour.utilization, 100, 'the refused window still reads as spent');
    assert.equal(r.snapshot.seven_day.utilization, 20, 'other windows keep the live numbers');
    const spent = windowSpent({ fiveHourUsedPct: r.fiveHourUsedPct, fiveHourResetsAt: r.fiveHourResetsAt, meterSnapshot: r.snapshot }, NOW + 30 * 60_000);
    assert.equal(spent?.window, '5-hour');
  } finally { f.cleanup(); }
});

test('a named refusal is cleared by the first live read after its reset', async () => {
  const f = fixture();
  try {
    const marker = await refuse(f);
    const later = Date.parse(marker.resets_at) + 60_000;
    const r = await live(f, later, reading(later, { fiveHour: 3, fiveResetMs: later + 5 * H }));
    assert.equal(r.source, 'live');
    assert.equal(r.quotaRefusal, undefined);
    assert.equal(f.cache.get(POOL).quota_refusal, undefined);
  } finally { f.cleanup(); }
});

test('a live read whose 5h window resets after the marker clears it', async () => {
  const f = fixture();
  try {
    await refuse(f);
    const t = NOW + 30 * 60_000;
    const r = await live(f, t, reading(t, { fiveHour: 5, fiveResetMs: NOW + 11 * H }));
    assert.equal(r.source, 'live');
    assert.equal(f.cache.get(POOL).quota_refusal, undefined);
  } finally { f.cleanup(); }
});

test('a weekly named refusal is cleared when the live weekly reset is more than 60 s later, not before', async () => {
  const f = fixture();
  try {
    f.cache.put(POOL, { ...reading(NOW - 60_000), five_hour: null });
    const weeklyReset = NOW + 2 * 86_400_000;
    const marker = await refuse(f, { resetAtMs: weeklyReset, meter: { ...connector, meter: { type: 'reader', window: 'weekly' } } });
    assert.equal(marker.window, 'weekly');
    const t = NOW + 60_000;
    const same = await live(f, t, { ...reading(t, { weekly: 40, weeklyResetMs: weeklyReset + 30_000 }), five_hour: null });
    assert.equal(same.source, 'quota-refusal', 'a 30 s drift is the same window');
    const next = await live(f, t + 1000, { ...reading(t, { weekly: 2, weeklyResetMs: weeklyReset + 7 * 86_400_000 }), five_hour: null });
    assert.equal(next.source, 'live');
    assert.equal(f.cache.get(POOL).quota_refusal, undefined);
  } finally { f.cleanup(); }
});

for (const resetSource of ['measured', 'guessed']) {
  test(`a ${resetSource} refusal is still cleared by a live read`, async () => {
    const f = fixture();
    try {
      if (resetSource === 'guessed') f.cache.put(POOL, reading(NOW - 60_000, { fiveResetMs: NOW - H }));
      const marker = await refuse(f, resetSource === 'guessed' ? { resetAtMs: null } : { resetSource });
      assert.equal(marker.reset_source, resetSource);
      const t = NOW + 30 * 60_000;
      const r = await live(f, t, reading(t, { fiveHour: 52 }));
      assert.equal(r.source, 'live');
      assert.equal(r.snapshot.five_hour.utilization, 52);
      assert.equal(f.cache.get(POOL).quota_refusal, undefined);
    } finally { f.cleanup(); }
  });
}

test('routing does not pick a pool with a surviving named refusal while another is eligible', async () => {
  const f = fixture();
  try {
    await refuse(f);
    const t = NOW + 30 * 60_000;
    const r = await live(f, t, reading(t, { fiveHour: 52 }));
    const refused = {
      name: POOL, costRank: 1, lanes: ['build'], pacingWindow: 'weekly', usedPct: 20, elapsedPct: 60, pace: 40,
      paceResetsAt: r.snapshot.seven_day.resets_at, fiveHourUsedPct: r.fiveHourUsedPct, fiveHourResetsAt: r.fiveHourResetsAt,
      meterSnapshot: r.snapshot,
    };
    const other = { name: 'other', costRank: 4, lanes: ['build'], pacingWindow: 'weekly', usedPct: 50, elapsedPct: 50, pace: 0, paceResetsAt: r.snapshot.seven_day.resets_at, fiveHourUsedPct: 10 };
    const pick = pickPool('build', [refused, other], { now: t });
    assert.equal(pick.pick.pool, 'other');
  } finally { f.cleanup(); }
});
