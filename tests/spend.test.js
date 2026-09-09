import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMeterHistory, readMeterHistory, meterHistoryPath, meterHistoryEntry,
  getMeterReading, MAX_HISTORY_LINES, HISTORY_REWRITE_AT,
} from '../src/meters/registry.js';
import { projectedUtilization, WINDOW_KEYS, monthlyWindowMs } from '../src/meters/framework.js';
import {
  expectedMinutesFor, spendRateFor, workerMinutesForPool, attachSpend,
  attemptWindow, remainingMinutesOf, MIN_EXPECTED_MINUTES, MIN_RATE_MINUTES,
} from '../src/lib/spend.js';
import { fiveHourForecast } from '../src/lib/route.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One history line, the shape the registry writes. */
function reading(capturedAtMs, { fiveHour = null, weekly = null } = {}) {
  const entry = { captured_at: new Date(capturedAtMs).toISOString() };
  if (fiveHour) entry.five_hour = { utilization: fiveHour.util, resets_at: new Date(fiveHour.resets).toISOString() };
  if (weekly) entry.weekly = { utilization: weekly.util, resets_at: new Date(weekly.resets).toISOString() };
  return entry;
}

function writeHistory(dir, pool, entries) {
  const path = meterHistoryPath(pool, dir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return path;
}

// --- history log --------------------------------------------------------------

test('every live reading is appended to the pool history log', async () => {
  const home = tempDir('bs-spend-live-');
  const previous = process.env.BULLSWARM_HOME;
  try {
    process.env.BULLSWARM_HOME = home;
    const pool = 'claude-code:wati';
    const snapshotAt = (capturedAtMs, util) => ({
      captured_at: new Date(capturedAtMs).toISOString(),
      pool,
      five_hour: { utilization: util, resets_at: new Date(NOW + HOUR).toISOString() },
      seven_day: { utilization: 12, resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString() },
    });

    const first = await getMeterReading(pool, {
      force: true, nowMs: NOW, reader: async () => snapshotAt(NOW - HOUR, 26),
    });
    assert.equal(first.source, 'live');
    const second = await getMeterReading(pool, {
      force: true, nowMs: NOW, reader: async () => snapshotAt(NOW, 51),
    });
    assert.equal(second.source, 'live');

    // Written where the requirement says, next to the single-snapshot cache.
    const path = join(home, 'meters', 'history', 'claude-code:wati.jsonl');
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);

    const history = readMeterHistory(pool, { dir: join(home, 'meters') });
    assert.deepEqual(history.map((h) => h.five_hour.utilization), [26, 51]);
    // seven_day is recorded under the spend model's `weekly` name.
    assert.equal(history[0].weekly.utilization, 12);
    assert.equal(history[1].capturedAtMs, NOW);

    // Same snapshot handed over twice is one observation, not two.
    assert.equal(appendMeterHistory(pool, snapshotAt(NOW, 51), { dir: join(home, 'meters') }), null);
    assert.equal(readMeterHistory(pool, { dir: join(home, 'meters') }).length, 2);

    // sinceMs drops readings older than the caller's horizon.
    assert.equal(readMeterHistory(pool, { dir: join(home, 'meters'), sinceMs: NOW }).length, 1);
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the history log is capped by rewriting to the newest MAX_HISTORY_LINES', () => {
  const dir = tempDir('bs-spend-cap-');
  try {
    const pool = 'codex';
    const existing = [];
    for (let i = 0; i < HISTORY_REWRITE_AT; i += 1) {
      existing.push(reading(NOW - (HISTORY_REWRITE_AT - i) * MIN, { fiveHour: { util: 1, resets: NOW + HOUR } }));
    }
    const path = writeHistory(dir, pool, existing);

    appendMeterHistory(pool, {
      captured_at: new Date(NOW).toISOString(),
      five_hour: { utilization: 42, resets_at: new Date(NOW + HOUR).toISOString() },
    }, { dir });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, MAX_HISTORY_LINES);
    // 601 lines minus the 500 kept = the oldest 101 dropped.
    assert.equal(JSON.parse(lines[0]).captured_at, existing[101].captured_at);
    assert.equal(JSON.parse(lines[lines.length - 1]).five_hour.utilization, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history reading survives torn lines and skips windows nobody reported', () => {
  const dir = tempDir('bs-spend-torn-');
  try {
    const path = meterHistoryPath('grok', dir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, [
      JSON.stringify(reading(NOW - MIN, { fiveHour: { util: 5, resets: NOW + HOUR } })),
      '{"captured_at": "2026-09-09T11:5',           // truncated write
      '{"five_hour": {"utilization": 9}}',           // no capture time
      JSON.stringify(reading(NOW, { fiveHour: { util: 7, resets: NOW + HOUR } })),
      '',
    ].join('\n'));
    const history = readMeterHistory('grok', { dir });
    assert.deepEqual(history.map((h) => h.five_hour.utilization), [5, 7]);

    // A snapshot with no readable window is not worth a line.
    assert.equal(meterHistoryEntry({ captured_at: new Date(NOW).toISOString(), five_hour: { utilization: null } }), null);
    assert.equal(meterHistoryEntry({ five_hour: { utilization: 5 } }), null);
    // Unknown pool → no history, not a throw.
    assert.deepEqual(readMeterHistory('never-read', { dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- spend rate ---------------------------------------------------------------

const RESETS = NOW + HOUR;

test('spend rate is fitted over consecutive readings inside one window', () => {
  // The measured claude-code:wati series: 26% → 51% → 84% of the 5h window
  // while 70 then 165 worker-minutes were dispatched to it.
  const history = [
    reading(NOW - 3 * HOUR, { fiveHour: { util: 26, resets: RESETS } }),
    reading(NOW - 2 * HOUR, { fiveHour: { util: 51, resets: RESETS } }),
    reading(NOW - HOUR, { fiveHour: { util: 84, resets: RESETS } }),
  ];
  const minutes = new Map([
    [`${NOW - 3 * HOUR}:${NOW - 2 * HOUR}`, 70],
    [`${NOW - 2 * HOUR}:${NOW - HOUR}`, 165],
  ]);
  const rate = spendRateFor('claude-code:wati', {
    history,
    workerMinutesBetween: (from, to) => minutes.get(`${from}:${to}`) ?? 0,
    nowMs: NOW,
  });

  // Per pair: 25/70 = 0.357 and 33/165 = 0.200. Pooled: 58/235 = 0.246809.
  assert.equal(rate.fiveHour.source, 'history');
  assert.equal(rate.fiveHour.samples, 2);
  assert.equal(rate.fiveHour.ratePerMinute, Math.round((58 / 235) * 1e6) / 1e6);
  assert.equal(rate.fiveHour.ratePerMinute, 0.246809);
  assert.equal(rate.fiveHour.windowUsedPct, 84);
  // Nothing reported a weekly window: unknown, not zero.
  assert.equal(rate.weekly.ratePerMinute, null);
  assert.equal(rate.weekly.source, null);
});

test('one usable pair is not a fit: the rate bootstraps off the whole window', () => {
  const history = [reading(NOW - HOUR, { fiveHour: { util: 84, resets: RESETS } })];
  const windowStart = RESETS - WINDOW_KEYS.fiveHour.windowMs;
  const rate = spendRateFor('claude-code:wati', {
    history,
    // 235 worker-minutes since the window opened; no pair to fit.
    workerMinutesBetween: (from, to) => (from === windowStart && to === NOW ? 235 : 0),
    nowMs: NOW,
  });
  // 84 / 235 = 0.357447 percent of the 5h window per worker-minute.
  assert.equal(rate.fiveHour.source, 'bootstrap');
  assert.equal(rate.fiveHour.samples, 1);
  assert.equal(rate.fiveHour.ratePerMinute, 0.357447);
});

test('a window reset breaks the pair chain and falls back to bootstrap', () => {
  const nextResets = RESETS + 5 * HOUR;
  const history = [
    reading(NOW - 3 * HOUR, { fiveHour: { util: 26, resets: RESETS } }),
    reading(NOW - 2 * HOUR, { fiveHour: { util: 51, resets: RESETS } }),
    // window rolled over: same pool, new window, utilization restarts
    reading(NOW - HOUR, { fiveHour: { util: 4, resets: nextResets } }),
  ];
  const rate = spendRateFor('claude-code:wati', {
    history,
    workerMinutesBetween: () => 50,
    nowMs: NOW,
  });
  // Only one pair survives (26→51), below the two-pair minimum.
  assert.equal(rate.fiveHour.source, 'bootstrap');
  assert.equal(rate.fiveHour.ratePerMinute, 0.08); // 4 / 50
  assert.equal(rate.fiveHour.windowUsedPct, 4);
});

test('a utilization drop inside one window is not a spend observation', () => {
  const history = [
    reading(NOW - 3 * HOUR, { fiveHour: { util: 40, resets: RESETS } }),
    reading(NOW - 2 * HOUR, { fiveHour: { util: 30, resets: RESETS } }), // provider correction
    reading(NOW - HOUR, { fiveHour: { util: 50, resets: RESETS } }),
  ];
  const rate = spendRateFor('p', { history, workerMinutesBetween: () => 100, nowMs: NOW });
  // 40→30 dropped, 30→50 kept: one pair only, so no fitted rate.
  assert.equal(rate.fiveHour.source, 'bootstrap');
  assert.equal(rate.fiveHour.samples, 1);
});

test('no readings, or no worker-minutes, means null — never an invented rate', () => {
  const empty = spendRateFor('p', { history: [], workerMinutesBetween: () => 0, nowMs: NOW });
  assert.deepEqual(empty.fiveHour, { ratePerMinute: null, source: null, samples: 0, windowUsedPct: null });
  assert.deepEqual(empty.weekly, { ratePerMinute: null, source: null, samples: 0, windowUsedPct: null });

  // A reading exists but nothing was dispatched: utilization is known, the
  // rate is not.
  const idle = spendRateFor('p', {
    history: [reading(NOW - HOUR, { fiveHour: { util: 30, resets: RESETS } })],
    workerMinutesBetween: () => 0,
    nowMs: NOW,
  });
  assert.equal(idle.fiveHour.ratePerMinute, null);
  assert.equal(idle.fiveHour.source, null);
  assert.equal(idle.fiveHour.windowUsedPct, 30);

  // Worker-minutes but 0% used: nothing has been spent to measure.
  const unused = spendRateFor('p', {
    history: [reading(NOW - HOUR, { fiveHour: { util: 0, resets: RESETS } })],
    workerMinutesBetween: () => 120,
    nowMs: NOW,
  });
  assert.equal(unused.fiveHour.ratePerMinute, null);
  assert.equal(unused.fiveHour.source, null);
});

test('a denominator smaller than one assignment is not a rate', () => {
  const RESETS = NOW + 2 * HOUR;
  // The failure this floor prevents: a pool 26% into its 5-hour window whose
  // only recorded dispatch is one agent six seconds old. 26 / 0.1 is 260
  // percentage points per worker-minute, which forecasts every pool past the
  // burst line the instant it takes work. The quota was spent by something
  // Bullswarm did not dispatch, so there is nothing here to measure (S3).
  const tiny = spendRateFor('p', {
    history: [reading(NOW - HOUR, { fiveHour: { util: 26, resets: RESETS } })],
    workerMinutesBetween: () => 0.1,
    nowMs: NOW,
  });
  assert.equal(tiny.fiveHour.ratePerMinute, null);
  assert.equal(tiny.fiveHour.source, null);
  assert.equal(tiny.fiveHour.windowUsedPct, 26, 'the reading itself is still reported');

  // At the floor the same observation IS a rate.
  const enough = spendRateFor('p', {
    history: [reading(NOW - HOUR, { fiveHour: { util: 26, resets: RESETS } })],
    workerMinutesBetween: () => MIN_RATE_MINUTES,
    nowMs: NOW,
  });
  assert.equal(enough.fiveHour.source, 'bootstrap');
  assert.equal(enough.fiveHour.ratePerMinute, 26 / MIN_RATE_MINUTES);

  // The floor applies to a fitted rate too: two pairs over a fraction of a
  // minute are two observations of noise, not a measurement.
  const fitted = spendRateFor('p', {
    history: [
      reading(NOW - 2 * HOUR, { fiveHour: { util: 10, resets: RESETS } }),
      reading(NOW - HOUR, { fiveHour: { util: 20, resets: RESETS } }),
      reading(NOW, { fiveHour: { util: 30, resets: RESETS } }),
    ],
    workerMinutesBetween: () => 0.2,
    nowMs: NOW,
  });
  assert.notEqual(fitted.fiveHour.source, 'history');
});

test('the live snapshot extends the series and is never counted twice', () => {
  const history = [
    reading(NOW - 2 * HOUR, { fiveHour: { util: 10, resets: RESETS } }),
    reading(NOW - HOUR, { fiveHour: { util: 20, resets: RESETS } }),
  ];
  const snapshot = {
    captured_at: new Date(NOW).toISOString(),
    five_hour: { utilization: 30, resets_at: new Date(RESETS).toISOString() },
  };
  const withSnapshot = spendRateFor('p', {
    history, snapshot, workerMinutesBetween: () => 50, nowMs: NOW,
  });
  assert.equal(withSnapshot.fiveHour.samples, 2); // 10→20 and 20→30
  assert.equal(withSnapshot.fiveHour.ratePerMinute, 0.2); // 20 / 100
  assert.equal(withSnapshot.fiveHour.windowUsedPct, 30);

  // The registry already appended that same reading: the duplicate must not
  // become a third sample.
  const alreadyLogged = spendRateFor('p', {
    history: [...history, reading(NOW, { fiveHour: { util: 30, resets: RESETS } })],
    snapshot,
    workerMinutesBetween: () => 50,
    nowMs: NOW,
  });
  assert.equal(alreadyLogged.fiveHour.samples, 2);
  assert.equal(alreadyLogged.fiveHour.ratePerMinute, 0.2);
});

// --- expected duration --------------------------------------------------------

const decision = (pool, lane, effort, wallSec, endMs) => ({
  ts: new Date(endMs).toISOString(), lane, picked: pool, ok: true, wallSec,
  routing: { effort, lane },
});

test('expected minutes is the decision-log median once three attempts exist', () => {
  const log = [
    decision('a', 'build', 'high', 120, NOW),
    decision('a', 'build', 'high', 360, NOW),
    decision('a', 'build', 'high', 380, NOW),
    decision('a', 'build', 'high', 400, NOW),
    decision('a', 'build', 'high', 1400, NOW),
    decision('a', 'analyze', 'low', 90, NOW),
  ];
  const build = expectedMinutesFor({ lane: 'build', effort: 'high' }, { decisionLog: log });
  // minutes: 2, 6, 6.33, 6.67, 23.33 → median 6.33
  assert.deepEqual(build, { minutes: 6.33, source: 'history', samples: 5 });

  // Fewer than three samples never beats the documented default.
  const analyze = expectedMinutesFor({ lane: 'analyze', effort: 'low' }, { decisionLog: log });
  assert.deepEqual(analyze, { minutes: 5, source: 'default', samples: 1 });
});

test('the five-minute floor applies to medians and to the defaults', () => {
  const log = [
    decision('a', 'chore', 'low', 42, NOW),
    decision('a', 'chore', 'low', 48, NOW),
    decision('a', 'chore', 'low', 60, NOW),
  ];
  // Real median is 0.8 min; booking that would under-book the window.
  const chore = expectedMinutesFor({ lane: 'chore', effort: 'low' }, { decisionLog: log });
  assert.deepEqual(chore, { minutes: MIN_EXPECTED_MINUTES, source: 'history', samples: 3 });

  // build/low's table value is 4; the floor lifts it to 5.
  assert.deepEqual(
    expectedMinutesFor({ lane: 'build', effort: 'low' }, { decisionLog: [] }),
    { minutes: 5, source: 'default', samples: 0 },
  );
  assert.equal(expectedMinutesFor({ lane: 'build', effort: 'medium' }, {}).minutes, 6);
  assert.equal(expectedMinutesFor({ lane: 'build', effort: 'high' }, {}).minutes, 10);
  assert.equal(expectedMinutesFor({ lane: 'analyze', effort: 'high' }, {}).minutes, 5);
  // Unknown lane/effort: the floor, labeled default.
  assert.deepEqual(
    expectedMinutesFor({ lane: 'nonsense', effort: 'extreme' }, { decisionLog: [] }),
    { minutes: 5, source: 'default', samples: 0 },
  );
});

test('attempts without a real duration are not samples', () => {
  const log = [
    { ts: new Date(NOW).toISOString(), lane: 'build', picked: 'a', routing: { effort: 'high' } },
    { ts: new Date(NOW).toISOString(), lane: 'build', picked: 'a', wallSec: 0, routing: { effort: 'high' } },
    { ts: new Date(NOW).toISOString(), lane: 'build', picked: 'a', wallSec: null, routing: { effort: 'high' } },
    // effort under `effortTier` and start/finish instead of wallSec
    {
      startedAt: new Date(NOW - 12 * MIN).toISOString(), finishedAt: new Date(NOW).toISOString(),
      lane: 'build', pool: 'a', effortTier: 'high',
    },
  ];
  const r = expectedMinutesFor({ lane: 'build', effort: 'high' }, { decisionLog: log });
  assert.deepEqual(r, { minutes: 10, source: 'default', samples: 1 });
  assert.equal(attemptWindow(log[0]), null);
  assert.equal(attemptWindow(log[3]).minutes, 12);
});

// --- worker minutes -----------------------------------------------------------

test('worker minutes clip finished attempts and in-flight agents to the window', () => {
  const log = [
    decision('a', 'build', 'high', 600, NOW),           // a: [NOW-10m, NOW]
    decision('a', 'build', 'high', 600, NOW - 30 * MIN), // a: [NOW-40m, NOW-30m]
    decision('b', 'build', 'high', 600, NOW),           // another pool
  ];
  const inflight = { a: { records: [{ startedAt: new Date(NOW - 4 * MIN).toISOString(), expectedMinutes: 10 }] } };

  // Last 5 minutes: half of the finished attempt + 4 in-flight minutes.
  assert.equal(workerMinutesForPool('a', NOW - 5 * MIN, NOW, { decisionLog: log, inflight, nowMs: NOW }), 9);
  // The whole hour: 10 + 10 finished + 4 in-flight.
  assert.equal(workerMinutesForPool('a', NOW - HOUR, NOW, { decisionLog: log, inflight, nowMs: NOW }), 24);
  // A window the in-flight agent had not started in yet.
  assert.equal(workerMinutesForPool('a', NOW - 40 * MIN, NOW - 30 * MIN, { decisionLog: log, inflight, nowMs: NOW }), 10);
  // Other pools are not this pool's spend.
  assert.equal(workerMinutesForPool('b', NOW - HOUR, NOW, { decisionLog: log, inflight, nowMs: NOW }), 10);
  // Degenerate windows and unknown pools are zero, not NaN.
  assert.equal(workerMinutesForPool('a', NOW, NOW, { decisionLog: log, nowMs: NOW }), 0);
  assert.equal(workerMinutesForPool(null, NOW - HOUR, NOW, { decisionLog: log }), 0);
  assert.equal(workerMinutesForPool('a', NOW - HOUR, NOW, {}), 0);

  // Ledger shapes: bare array, {records}, and keyed map all resolve.
  const records = [{ pool: 'a', startedAt: new Date(NOW - 4 * MIN).toISOString() }];
  for (const shape of [records, { records }, { a: records }, { a: { records } }]) {
    assert.equal(workerMinutesForPool('a', NOW - 5 * MIN, NOW, { inflight: shape, nowMs: NOW }), 4);
  }
});

test('remaining minutes prefer the recorded value and never go negative', () => {
  assert.equal(remainingMinutesOf({ remainingMinutes: 7 }, NOW), 7);
  assert.equal(remainingMinutesOf({ remainingMinutes: -3 }, NOW), 0);
  assert.equal(
    remainingMinutesOf({ startedAt: new Date(NOW - 4 * MIN).toISOString(), expectedMinutes: 10 }, NOW),
    6,
  );
  // Overdue work is 0 remaining, not a negative credit.
  assert.equal(
    remainingMinutesOf({ startedAt: new Date(NOW - 40 * MIN).toISOString(), expectedMinutes: 10 }, NOW),
    0,
  );
  // Nothing recorded → unknown.
  assert.equal(remainingMinutesOf({ startedAt: new Date(NOW).toISOString() }, NOW), null);
  assert.equal(remainingMinutesOf(null, NOW), null);
});

// --- projection ---------------------------------------------------------------

test('projected utilization is the reading plus what the running work will spend', () => {
  assert.deepEqual(
    projectedUtilization({ usedPct: 30, ratePerMinute: 0.2, inflightRemainingMinutes: 20 }),
    { projectedPct: 34, addedPct: 4 },
  );
  // The candidate being routed can be charged on top.
  assert.deepEqual(
    projectedUtilization({ usedPct: 30, ratePerMinute: 0.2, inflightRemainingMinutes: 20, candidateMinutes: 10 }),
    { projectedPct: 36, addedPct: 6 },
  );
  // Clamped to the window.
  assert.deepEqual(
    projectedUtilization({ usedPct: 95, ratePerMinute: 0.5, inflightRemainingMinutes: 60 }),
    { projectedPct: 100, addedPct: 30 },
  );
  // No reading → nothing to project.
  assert.equal(projectedUtilization({ usedPct: null, ratePerMinute: 0.2, inflightRemainingMinutes: 10 }), null);
  // Minutes to charge but no measured rate → unknown, not optimistic.
  assert.equal(projectedUtilization({ usedPct: 30, ratePerMinute: null, inflightRemainingMinutes: 10 }), null);
  // Nothing running → the forecast is exactly the reading, rate or not.
  assert.deepEqual(projectedUtilization({ usedPct: 30, ratePerMinute: null }), { projectedPct: 30, addedPct: 0 });
});

// --- attachSpend --------------------------------------------------------------

test('attachSpend gives a pool view its rate, basis and forecast from real records', () => {
  const dir = tempDir('bs-spend-attach-');
  try {
    const pool = 'claude-code:wati';
    const weeklyResets = NOW + 3 * 24 * HOUR;
    writeHistory(dir, pool, [
      reading(NOW - 2 * HOUR, { fiveHour: { util: 10, resets: RESETS }, weekly: { util: 4, resets: weeklyResets } }),
      reading(NOW - HOUR, { fiveHour: { util: 20, resets: RESETS }, weekly: { util: 4.5, resets: weeklyResets } }),
      reading(NOW, { fiveHour: { util: 30, resets: RESETS }, weekly: { util: 5, resets: weeklyResets } }),
    ]);

    const decisionLog = [
      // 50 worker-minutes inside each reading interval
      decision(pool, 'build', 'high', 3000, NOW - HOUR),
      decision(pool, 'build', 'high', 3000, NOW),
      decision('other-pool', 'build', 'high', 3000, NOW),
    ];
    const inflight = {
      [pool]: {
        count: 1,
        records: [{ startedAt: new Date(NOW - 10 * MIN).toISOString(), expectedMinutes: 30, remainingMinutes: 20 }],
      },
    };

    const view = {
      name: pool,
      fiveHourUsedPct: 30,
      meterSnapshot: {
        captured_at: new Date(NOW).toISOString(),
        five_hour: { utilization: 30, resets_at: new Date(RESETS).toISOString() },
        seven_day: { utilization: 5, resets_at: new Date(weeklyResets).toISOString() },
      },
    };
    const quiet = { name: 'quiet-pool', fiveHourUsedPct: 12 };
    const unmetered = { name: 'unmetered-pool', fiveHourUsedPct: null };

    attachSpend([view, quiet, unmetered], { historyDir: dir, decisionLog, inflight, nowMs: NOW });

    // 5h: (10 + 10) points over (50 + 60) worker-minutes — the second interval
    // also carries the in-flight agent's 10 elapsed minutes. 20/110 = 0.181818.
    assert.deepEqual(view.spend.fiveHour, { ratePerMinute: 0.181818, source: 'history', samples: 2 });
    // weekly: (0.5 + 0.5) / 110 = 0.009091
    assert.deepEqual(view.spend.weekly, { ratePerMinute: 0.009091, source: 'history', samples: 2 });
    // 30 + 0.181818 × 20 remaining minutes = 33.6
    assert.equal(view.projectedFiveHourPct, 33.6);
    // 5 + 0.009091 × 20 = 5.2
    assert.equal(view.projectedWeeklyPct, 5.2);

    // Nothing in flight and no history: the forecast is the reading itself.
    assert.deepEqual(quiet.spend.fiveHour, { ratePerMinute: null, source: null, samples: 0 });
    assert.equal(quiet.projectedFiveHourPct, 12);
    assert.equal(quiet.projectedWeeklyPct, null);

    // Nothing measured at all stays null.
    assert.equal(unmetered.projectedFiveHourPct, null);
    assert.equal(unmetered.spend.weekly.source, null);

    // The router reads exactly these fields (R8): forecast = projection plus
    // this candidate's own minutes. 33.6 + 0.181818 × 5 = 34.509
    const forecast = fiveHourForecast(view, 5);
    assert.equal(forecast.projected, 33.6);
    assert.equal(forecast.ratePerMinute, 0.181818);
    assert.equal(Math.round(forecast.forecast * 1000) / 1000, 34.509);
    assert.equal(forecast.forecasted, true);
    // An unmeasured pool is still never gated or deprioritized by a number
    // nobody produced.
    assert.equal(fiveHourForecast(unmetered, 5).forecast, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachSpend forecasts null when work is running at an unknown rate', () => {
  const pool = {
    name: 'p',
    fiveHourUsedPct: 40,
    inflight: { count: 1, records: [{ startedAt: new Date(NOW - MIN).toISOString(), remainingMinutes: 15 }] },
  };
  attachSpend([pool], { history: {}, decisionLog: [], nowMs: NOW });
  assert.equal(pool.spend.fiveHour.ratePerMinute, null);
  assert.equal(pool.projectedFiveHourPct, null);

  // With a rate supplied by a history reader function, the same pool forecasts.
  const metered = {
    name: 'p',
    fiveHourUsedPct: 40,
    inflight: { count: 1, records: [{ startedAt: new Date(NOW - MIN).toISOString(), remainingMinutes: 15 }] },
  };
  attachSpend([metered], {
    readHistory: () => [
      reading(NOW - 2 * HOUR, { fiveHour: { util: 10, resets: RESETS } }),
      reading(NOW - HOUR, { fiveHour: { util: 25, resets: RESETS } }),
      reading(NOW, { fiveHour: { util: 40, resets: RESETS } }),
    ],
    workerMinutesBetween: null,
    decisionLog: [
      decision('p', 'build', 'high', 3600, NOW - HOUR),
      decision('p', 'build', 'high', 3600, NOW),
    ],
    nowMs: NOW,
  });
  // 30 points over (60 + 60 + 1 in-flight) minutes = 30/121 = 0.247934
  assert.equal(metered.spend.fiveHour.source, 'history');
  assert.equal(metered.spend.fiveHour.ratePerMinute, 0.247934);
  // 40 + 0.247934 × 15 = 43.7
  assert.equal(metered.projectedFiveHourPct, 43.7);
});

test('attachSpend tolerates missing ledgers, missing pools and odd input', () => {
  assert.deepEqual(attachSpend(null), []);
  assert.deepEqual(attachSpend(undefined, { decisionLog: null, inflight: 'nonsense' }), []);
  const pool = { name: 'p', fiveHourUsedPct: 55 };
  attachSpend([pool], { nowMs: NOW, historyDir: join(tmpdir(), 'bs-spend-absent-dir') });
  assert.equal(pool.projectedFiveHourPct, 55);
  assert.deepEqual(pool.spend, {
    fiveHour: { ratePerMinute: null, source: null, samples: 0 },
    weekly: { ratePerMinute: null, source: null, samples: 0 },
    monthly: { ratePerMinute: null, source: null, samples: 0 },
    // A pool that declares no quota window is paced weekly, exactly as
    // before 0.28.1 — `pacing` restates that window's rate, it does not
    // change it.
    pacing: { window: 'weekly', ratePerMinute: null, source: null, samples: 0 },
  });
});

// --- the monthly window and the pacing window --------------------------------
//
// The command-code numbers, read live at 2026-09-09T10:45:28Z: 79.38571…% of a
// monthly credit allocation resetting 2026-09-17T03:06:55Z.
const CMD_MONTHLY_RESETS = Date.parse('2026-09-17T03:06:55.000Z');
const CMD_MONTHLY_UTIL = 79.38571428571429;

test('the monthly rate bootstraps from the window start the provider implies', () => {
  // WINDOW_KEYS.monthly declares no constant length: a month is not 30 days,
  // so the length (and therefore the start) comes from resets_at (M2).
  assert.equal(WINDOW_KEYS.monthly.windowMs, null);
  const windowStart = CMD_MONTHLY_RESETS - monthlyWindowMs(CMD_MONTHLY_RESETS);
  assert.equal(new Date(windowStart).toISOString(), '2026-08-17T03:06:55.000Z');

  const asked = [];
  const rate = spendRateFor('command-code', {
    history: [{
      captured_at: new Date(NOW - HOUR).toISOString(),
      monthly: { utilization: CMD_MONTHLY_UTIL, resets_at: new Date(CMD_MONTHLY_RESETS).toISOString() },
    }],
    workerMinutesBetween: (from, to) => {
      asked.push([from, to]);
      return from === windowStart && to === NOW ? 400 : 0;
    },
    nowMs: NOW,
  });
  assert.deepEqual(asked.at(-1), [windowStart, NOW]);
  assert.equal(rate.monthly.source, 'bootstrap');
  assert.equal(rate.monthly.ratePerMinute, Math.round((CMD_MONTHLY_UTIL / 400) * 1e6) / 1e6);
  assert.equal(rate.monthly.ratePerMinute, 0.198464);
  assert.equal(rate.monthly.windowUsedPct, CMD_MONTHLY_UTIL);
  // A pool with no monthly reading reports unknown, never zero (S3).
  assert.deepEqual(
    spendRateFor('p', { history: [], workerMinutesBetween: () => 100, nowMs: NOW }).monthly,
    { ratePerMinute: null, source: null, samples: 0, windowUsedPct: null },
  );
});

test('spend.pacing and projectedPacingPct follow the pool pacing window', () => {
  const dir = tempDir('bs-spend-pacing-');
  try {
    const pool = 'command-code';
    const weeklyResets = NOW + 12 * HOUR;
    // Three readings, 60 worker-minutes between each pair: the weekly window
    // gains 1.0 point per hour of dispatch, the monthly window 2.0.
    const line = (capturedAtMs, weeklyUtil, monthlyUtil) => ({
      captured_at: new Date(capturedAtMs).toISOString(),
      weekly: { utilization: weeklyUtil, resets_at: new Date(weeklyResets).toISOString() },
      monthly: { utilization: monthlyUtil, resets_at: new Date(CMD_MONTHLY_RESETS).toISOString() },
    });
    writeHistory(dir, pool, [
      line(NOW - 2 * HOUR, 71, 75.4),
      line(NOW - HOUR, 72, 77.4),
      line(NOW, 73, 79.4),
    ]);
    // One agent running for the whole two hours, with 10 minutes left.
    const inflight = {
      [pool]: {
        count: 1,
        records: [{ startedAt: new Date(NOW - 120 * MIN).toISOString(), expectedMinutes: 130, remainingMinutes: 10 }],
      },
    };
    const snapshot = {
      captured_at: new Date(NOW).toISOString(),
      seven_day: { utilization: 73, resets_at: new Date(weeklyResets).toISOString() },
      monthly: { utilization: 79.4, resets_at: new Date(CMD_MONTHLY_RESETS).toISOString() },
    };
    const monthlyPaced = { name: pool, pacingWindow: 'monthly', meterSnapshot: snapshot };
    const weeklyPaced = { name: pool, pacingWindow: 'weekly', meterSnapshot: snapshot };
    const undeclared = { name: pool, meterSnapshot: snapshot };

    for (const view of [monthlyPaced, weeklyPaced, undeclared]) {
      attachSpend([view], { historyDir: dir, decisionLog: [], inflight, nowMs: NOW });
    }

    // Two pairs over 120 worker-minutes: weekly 2/120, monthly 4/120.
    assert.deepEqual(monthlyPaced.spend.weekly, { ratePerMinute: 0.016667, source: 'history', samples: 2 });
    assert.deepEqual(monthlyPaced.spend.monthly, { ratePerMinute: 0.033333, source: 'history', samples: 2 });
    // pacing restates the chosen window's rate and names it.
    assert.deepEqual(monthlyPaced.spend.pacing, {
      window: 'monthly', ratePerMinute: 0.033333, source: 'history', samples: 2,
    });
    // 79.4 + 0.033333 × 10 remaining minutes = 79.7
    assert.equal(monthlyPaced.projectedMonthlyPct, 79.7);
    assert.equal(monthlyPaced.projectedPacingPct, 79.7);
    // 73 + 0.016667 × 10 = 73.2 — still reported, just not what paces.
    assert.equal(monthlyPaced.projectedWeeklyPct, 73.2);

    // Declared weekly, and declared nothing, both pace weekly.
    for (const view of [weeklyPaced, undeclared]) {
      assert.equal(view.spend.pacing.window, 'weekly');
      assert.equal(view.spend.pacing.ratePerMinute, view.spend.weekly.ratePerMinute);
      assert.equal(view.projectedPacingPct, 73.2);
      assert.equal(view.projectedWeeklyPct, 73.2);
    }
    // An unrecognised stored label paces by default (weekly), never by guess.
    const junk = { name: pool, pacingWindow: 'fortnight', meterSnapshot: snapshot };
    attachSpend([junk], { historyDir: dir, decisionLog: [], inflight, nowMs: NOW });
    assert.equal(junk.spend.pacing.window, 'weekly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
