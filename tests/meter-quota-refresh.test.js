import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMeterReading, refreshMeterAfterQuota } from '../src/meters/registry.js';
import { MeterCache } from '../src/meters/framework.js';
import { meterSourceLabel } from '../src/cli.js';
import { budgetLines } from '../src/workflow/budget-view.js';
import { budgetModel } from '../src/workflow/budget-model.js';
import { watchOnce } from '../src/lib/watch.js';
import { buildPools } from '../src/lib/config.js';

const NOW = Date.parse('2026-09-20T10:00:00Z');
const connector = {
  name: 'fake-metered',
  meter: { type: 'reader', window: 'weekly+5h' },
  subscription: { quotaWindow: 'weekly' },
};

function snapshot(pool, capturedAt, fiveHour = 12, weekly = 18) {
  return {
    pool,
    captured_at: new Date(capturedAt).toISOString(),
    five_hour: {
      utilization: fiveHour,
      resets_at: new Date(NOW + 2 * 3600_000).toISOString(),
    },
    seven_day: {
      utilization: weekly,
      resets_at: new Date(NOW + 3 * 86_400_000).toISOString(),
    },
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-meter-quota-'));
  const cache = new MeterCache(join(home, 'meters'));
  cache.put('fake-metered', snapshot('fake-metered', NOW - 60_000));
  return { home, cache, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('quota refusal bypasses a fresh cache and performs one forced reader call', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const refreshed = await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: f.home,
      connector,
      nowMs: NOW,
      reader: async () => {
        calls += 1;
        return snapshot('fake-metered', NOW, 41, 23);
      },
    });
    assert.equal(calls, 1, 'the reader is called even though the old cache is fresh');
    assert.equal(refreshed.source, 'live');
    assert.equal(refreshed.snapshot.five_hour.utilization, 41);
    assert.equal(f.cache.get('fake-metered').quota_refusal, undefined);
  } finally {
    f.cleanup();
  }
});

test('watchOnce refreshes the meter immediately when the attempt is classified as quota', async () => {
  const f = fixture();
  const taskFile = join(f.home, 'task.md');
  const outFile = join(f.home, 'out.md');
  try {
    let calls = 0;
    const quotaConnector = {
      ...connector,
      spawn: {
        cmd: [process.execPath, '-e', "console.error('Error: hit your session limit; resets in 45 minutes'); process.exit(1)"],
      },
      outputExtraction: { strategy: 'stdout' },
      authSignatures: [],
      quotaSignatures: ['hit your session limit'],
    };
    const verdict = await watchOnce(quotaConnector, 'Do the work.', f.home, { taskFile, outFile }, {
      bullswarmDir: f.home,
      poolName: 'fake-metered',
      meterReader: async () => {
        calls += 1;
        return snapshot('fake-metered', NOW, 37, 22);
      },
    });
    assert.equal(verdict.failureKind, 'quota');
    assert.equal(calls, 1);
    assert.equal(verdict.meterRefresh.source, 'live');
    assert.equal(f.cache.get('fake-metered').five_hour.utilization, 37);
  } finally {
    f.cleanup();
  }
});

test('a failed forced read writes a 100% five-hour quota-refusal marker with the message reset', async () => {
  const f = fixture();
  try {
    const resetAt = NOW + 45 * 60_000;
    const blocked = await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: f.home,
      connector,
      nowMs: NOW,
      resetAtMs: resetAt,
      reason: 'hit your session limit; resets in 45 minutes',
      reader: async () => { throw new Error('meter endpoint unavailable'); },
    });
    assert.equal(blocked.source, 'quota-refusal');
    assert.equal(blocked.snapshot.five_hour.utilization, 100);
    assert.equal(blocked.snapshot.five_hour.resets_at, new Date(resetAt).toISOString());
    assert.equal(blocked.quotaRefusal.source, 'quota-refusal');
    assert.equal(blocked.quotaRefusal.window, '5h');
    // The reset the message named is recorded as named, on the marker and on
    // the window it filled in.
    assert.equal(blocked.quotaRefusal.resetSource, 'named');
    assert.equal(blocked.snapshot.five_hour.reset_source, 'named');
    assert.equal(f.cache.get('fake-metered').source, 'quota-refusal');
    assert.equal(
      meterSourceLabel({
        meterSource: 'quota-refusal',
        quotaRefusal: blocked.quotaRefusal,
      }, NOW + 2 * 60_000),
      'blocked · refused 2m ago',
    );
    const lines = budgetLines({
      rows: [{
        name: 'fake-metered',
        meterSource: 'quota-refusal',
        quotaRefusal: blocked.quotaRefusal,
        quotaRefusedAt: blocked.quotaRefusal.refusedAt,
        windows: [{ key: '5h', usedPct: 100, elapsedPct: 40, resetsInMinutes: 43 }],
      }],
    }, { ansi: false, width: 100 }).lines;
    assert.match(lines[0], /fake-metered · blocked · refused/);
    assert.match(lines[1], /100\.0%/);
    // A marker whose reset was guessed, or an older one that does not say,
    // blocks nothing and says so.
    for (const marker of [{ ...blocked.quotaRefusal, resetSource: 'guessed' }, { refusedAt: blocked.quotaRefusal.refusedAt }]) {
      assert.equal(
        meterSourceLabel({ meterSource: 'quota-refusal', quotaRefusal: marker }, NOW + 2 * 60_000),
        'refused 2m ago · reset unknown',
      );
    }
  } finally {
    f.cleanup();
  }
});

test('the pool projection reads a refusal marker with a known reset as a 100% window; an old quarantine plays no part', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, 'connectors'), { recursive: true });
    writeFileSync(join(f.home, 'connectors/fake-metered.json'), JSON.stringify({
      ...connector,
      flags: { testFixture: true },
      lanes: ['chore'],
    }));
    writeFileSync(join(f.home, 'state.json'), JSON.stringify({
      version: 1,
      pools: {
        'fake-metered': { enabled: true, quarantine: { until: NOW + 30 * 60_000, reason: 'quota' } },
      },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));
    const refused = await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: f.home,
      connector,
      nowMs: NOW,
      reader: async () => { throw new Error('offline'); },
    });
    // No reset named, but the last live reading's five-hour reset is still
    // ahead: that reset is measured.
    assert.equal(refused.quotaRefusal.resetSource, 'measured');
    // The reading routing gets: the cached marker, read back as every
    // process reads it.
    const reading = await getMeterReading('fake-metered', { bullswarmDir: f.home, nowMs: NOW });
    const pool = buildPools(f.home, NOW, { 'fake-metered': reading }).pools.find((entry) => entry.name === 'fake-metered');
    assert.equal(pool.meterSource, 'quota-refusal');
    assert.equal(pool.fiveHourUsedPct, 100);
    assert.equal(pool.burstGate, true);
    assert.equal(Object.hasOwn(pool, 'quarantine'), false);
  } finally {
    f.cleanup();
  }
});

test('a refusal marker with nothing to measure its reset from guesses it, and the pool is not gated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-meter-quota-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors/fake-metered.json'), JSON.stringify({
      ...connector, flags: { testFixture: true }, lanes: ['chore'],
    }));
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: { 'fake-metered': { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));
    // No cached reading and no reset named: the marker's reset is a guess.
    const refused = await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: home,
      connector,
      nowMs: NOW,
      reader: async () => { throw new Error('offline'); },
    });
    assert.equal(refused.source, 'quota-refusal');
    assert.equal(refused.quotaRefusal.resetSource, 'guessed');
    const reading = await getMeterReading('fake-metered', { bullswarmDir: home, nowMs: NOW });
    const pool = buildPools(home, NOW, { 'fake-metered': reading }).pools.find((entry) => entry.name === 'fake-metered');
    assert.equal(pool.meterSource, 'quota-refusal');
    assert.notEqual(pool.fiveHourUsedPct, 100, 'a guessed reset is not a reading');
    assert.equal(pool.burstGate, false);
    assert.equal(meterSourceLabel(pool, NOW + 60_000), 'refused 1m ago · reset unknown');
    // The Budget page draws no 100% window with a guessed reset either: it
    // says the pool was refused, and nothing more.
    const row = budgetModel([pool], { now: NOW + 60_000 }).rows[0];
    assert.deepEqual(row.windows, []);
    const lines = budgetLines({ rows: [row] }, { ansi: false, width: 100, nowMs: NOW + 60_000 }).lines;
    assert.match(lines[0], /^fake-metered · refused 1m ago · reset unknown/);
    assert.doesNotMatch(lines.join('\n'), /100\.0%|resets /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the next successful read below 100% replaces and clears the refusal marker', async () => {
  const f = fixture();
  try {
    await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: f.home,
      connector,
      nowMs: NOW,
      reader: async () => { throw new Error('offline'); },
    });
    const good = await refreshMeterAfterQuota('fake-metered', {
      bullswarmDir: f.home,
      connector,
      nowMs: NOW + 60_000,
      reader: async () => snapshot('fake-metered', NOW + 60_000, 17, 25),
    });
    assert.equal(good.source, 'live');
    assert.equal(good.snapshot.five_hour.utilization, 17);
    assert.equal(f.cache.get('fake-metered').quota_refusal, undefined);
  } finally {
    f.cleanup();
  }
});
