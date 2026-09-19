import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deltaBetween, snapshotPool } from '../src/lib/quota-snapshot.js';

function home() { return mkdtempSync(join(tmpdir(), 'bullswarm-quota-')); }

test('snapshotPool selects the declared quota window and returns meter age', () => {
  const dir = home();
  try {
    mkdirSync(join(dir, 'meters'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      strategy: { subscriptions: { fixture: { quotaWindow: 'weekly' } } },
    }));
    writeFileSync(join(dir, 'meters', 'fixture.json'), JSON.stringify({
      captured_at: '2026-09-19T12:00:00.000Z',
      five_hour: { utilization: 30, resets_at: '2026-09-19T17:00:00.000Z' },
      seven_day: { utilization: 12.5, resets_at: '2026-09-20T00:00:00.000Z' },
    }));
    const snapshot = snapshotPool('fixture', {
      home: dir, now: Date.parse('2026-09-19T12:00:30.000Z'),
    });
    assert.deepEqual(snapshot, {
      at: '2026-09-19T12:00:00.000Z', window: 'weekly', usedPct: 12.5,
      resetsAt: '2026-09-20T00:00:00.000Z', ageMs: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deltaBetween rejects reset crossings, stale starts, and changed windows', () => {
  const start = {
    at: '2026-09-19T12:00:00.000Z', window: 'weekly', usedPct: 10,
    resetsAt: '2026-09-20T00:00:00.000Z',
  };
  const end = {
    at: '2026-09-19T12:00:30.000Z', window: 'weekly', usedPct: 11.2,
    resetsAt: '2026-09-20T00:00:00.000Z',
  };
  const now = Date.parse('2026-09-19T12:00:30.000Z');
  assert.deepEqual(deltaBetween(start, end, { now }), { deltaPct: 1.2, reason: null });
  assert.deepEqual(deltaBetween(start, {
    ...end, resetsAt: '2026-09-21T00:00:00.000Z',
  }, { now }), { deltaPct: null, reason: 'reset-between-snapshots' });
  assert.deepEqual(deltaBetween(start, { ...end, window: '5h' }, { now }), {
    deltaPct: null, reason: 'window-changed',
  });
  assert.deepEqual(deltaBetween(start, { ...end, usedPct: 9 }, { now }), {
    deltaPct: null, reason: 'counter-decreased',
  });
  assert.deepEqual(deltaBetween(start, end, { maxStartAgeMs: 10 }), {
    deltaPct: null, reason: 'stale-start',
  });
});
