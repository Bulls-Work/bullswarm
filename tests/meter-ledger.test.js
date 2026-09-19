import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMeterHistory,
  meterHistoryIntervals,
  meterHistoryPath,
  readMeterHistory,
} from '../src/meters/registry.js';
import { monotonicIntervalDelta } from '../src/meters/framework.js';
import { deltaBetween, snapshotPool } from '../src/lib/quota-snapshot.js';

const RESET = '2026-09-26T00:00:00.000Z';
const NEXT_RESET = '2026-10-03T00:00:00.000Z';

function dir() { return mkdtempSync(join(tmpdir(), 'bullswarm-meter-ledger-')); }
function at(minute) { return new Date(Date.parse('2026-09-19T12:00:00.000Z') + minute * 60_000).toISOString(); }
function snapshot(pool, capturedAt, utilization, resetsAt = RESET, extra = {}) {
  return {
    pool,
    captured_at: capturedAt,
    ...extra,
    five_hour: { utilization, resets_at: resetsAt },
    seven_day: { utilization: 20, resets_at: RESET },
    monthly: { utilization: null, resets_at: null },
  };
}

test('whole-percent live readings retain provider time, source, window identity, precision and delta', () => {
  const home = dir();
  try {
    appendMeterHistory('codex', snapshot('codex', at(0), 72), { dir: join(home, 'meters') });
    appendMeterHistory('codex', snapshot('codex', at(5), 74), { dir: join(home, 'meters') });
    const rows = readMeterHistory('codex', { dir: join(home, 'meters') });
    assert.equal(rows[1].provider_at, at(5));
    assert.equal(rows[1].source, 'live');
    assert.equal(rows[1].five_hour.window, 'five_hour');
    assert.equal(rows[1].five_hour.resolution_pct, 1);
    assert.equal(rows[1].five_hour.delta_pct, 2);
    assert.deepEqual(meterHistoryIntervals('codex', { dir: join(home, 'meters') })
      .filter((row) => row.window === 'five_hour')
      .map(({ deltaPct, resolutionPct, reason }) => ({ deltaPct, resolutionPct, reason })), [
      { deltaPct: 2, resolutionPct: 1, reason: null },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('decimal provider readings retain one-decimal observed resolution', () => {
  const home = dir();
  try {
    appendMeterHistory('claude-code:acme', snapshot('claude-code:acme', at(0), 19), { dir: join(home, 'meters') });
    appendMeterHistory('claude-code:acme', snapshot('claude-code:acme', at(5), 19.1), { dir: join(home, 'meters') });
    const row = readMeterHistory('claude-code:acme', { dir: join(home, 'meters') })[1];
    assert.equal(row.five_hour.resolutionPct, 0.1);
    assert.equal(row.five_hour.deltaPct, 0.1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reset crossings and decreases are non-monotonic, never negative deltas', () => {
  assert.deepEqual(monotonicIntervalDelta(
    { usedPct: 99, resetsAt: RESET },
    { usedPct: 2, resetsAt: NEXT_RESET },
  ), { deltaPct: null, reason: 'reset-between-readings' });
  assert.deepEqual(monotonicIntervalDelta(
    { usedPct: 9, resetsAt: RESET },
    { usedPct: 8, resetsAt: RESET },
  ), { deltaPct: null, reason: 'counter-decreased' });

  const home = dir();
  try {
    appendMeterHistory('codex', snapshot('codex', at(0), 99, RESET), { dir: join(home, 'meters') });
    appendMeterHistory('codex', snapshot('codex', at(5), 2, NEXT_RESET), { dir: join(home, 'meters') });
    const interval = meterHistoryIntervals('codex', { dir: join(home, 'meters') })
      .find((row) => row.window === 'five_hour');
    assert.equal(interval.deltaPct, null);
    assert.equal(interval.reason, 'reset-between-readings');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unchanged readings keep a zero with precision metadata; missing windows are absent', () => {
  const home = dir();
  try {
    const meters = join(home, 'meters');
    appendMeterHistory('grok', {
      pool: 'grok', captured_at: at(0),
      seven_day: { utilization: 19, resets_at: RESET },
      five_hour: { utilization: null, resets_at: null },
    }, { dir: meters });
    appendMeterHistory('grok', {
      pool: 'grok', captured_at: at(5),
      seven_day: { utilization: 19, resets_at: RESET },
      five_hour: { utilization: null, resets_at: null },
    }, { dir: meters });
    const rows = readMeterHistory('grok', { dir: meters });
    assert.equal(rows[1].weekly.deltaPct, 0);
    assert.equal(rows[1].weekly.resolutionPct, 0.1);
    assert.equal('five_hour' in rows[0], false);
    assert.equal(meterHistoryIntervals('grok', { dir: meters })
      .filter((row) => row.window === 'five_hour').length, 0);
    const persisted = readFileSync(meterHistoryPath('grok', meters), 'utf8');
    assert.equal(persisted.trim().split('\n').length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('quota snapshot exposes non-breaking precision and history cursor metadata', () => {
  const home = dir();
  try {
    const meters = join(home, 'meters');
    appendMeterHistory('codex', snapshot('codex', at(0), 40), { dir: meters });
    mkdirSync(meters, { recursive: true });
    writeFileSync(join(meters, 'codex.json'), JSON.stringify(snapshot('codex', at(0), 40)));
    const result = snapshotPool('codex', { home, now: Date.parse(at(1)) });
    assert.equal(result.resolutionPct, 1);
    assert.deepEqual(result.historyCursor, {
      at: at(0), window: 'weekly', index: 0, source: 'live', providerAt: at(0),
    });
    assert.equal(result.window, 'weekly');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('quota delta rejects stale starts while preserving measured zero', () => {
  const start = { at: at(0), window: 'weekly', usedPct: 20, resetsAt: RESET };
  const end = { at: at(1), window: 'weekly', usedPct: 20, resetsAt: RESET };
  assert.deepEqual(deltaBetween(start, end, { now: Date.parse(at(1)) }), {
    deltaPct: 0, reason: null,
  });
  assert.deepEqual(deltaBetween(start, end, {
    now: Date.parse(at(2)), maxStartAgeMs: 60_000,
  }), { deltaPct: null, reason: 'stale-start' });
});
