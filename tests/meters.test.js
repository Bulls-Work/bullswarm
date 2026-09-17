import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCodexWhamUsage, needsRefresh, accessTokenExpiresAtMs,
} from '../src/providers/codex/provider.mjs';
import { parseGrokCreditsConfig } from '../src/providers/grok/provider.mjs';
import {
  parseCommandCodeCredits, parseCommandCodeWindows, computeMonthly, planMonthlyCredits,
} from '../providers/contrib/command-code/provider.mjs';
import { extractCredentials } from '../src/providers/claude-code/provider.mjs';
import {
  windowPace, paceSnapshot, monthlyWindowMs, FIVE_HOUR_NEAR_LIMIT_PCT, BURST_BLOCK_PCT,
  pacingWindowFor, normalizePacingWindow, rollResetForward, declaredResetPacing,
  MeterCache, FRESH_MS,
} from '../src/meters/framework.js';
import { meterSourceLabel } from '../src/cli.js';

const NOW = Date.parse('2026-08-21T12:00:00Z');

// --- codex WHAM decoder -------------------------------------------------------

test('codex: classifies windows by explicit duration, not slot order', () => {
  const body = {
    plan_type: 'prolite',
    rate_limit: {
      // weekly in the PRIMARY slot (codex does this when 5h is absent)
      primary_window: { used_percent: 18, limit_window_seconds: 604800, reset_at: 1788000000 },
      secondary_window: null,
    },
  };
  const r = parseCodexWhamUsage(body, {}, NOW);
  assert.equal(r.seven_day.utilization, 18);
  assert.equal(r.five_hour.utilization, null);
  assert.equal(r.plan_type, 'prolite');
});

test('codex: standard dual windows land in the right slots', () => {
  const body = {
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: 1788000000 },
    },
  };
  const r = parseCodexWhamUsage(body, {}, NOW);
  assert.equal(r.five_hour.utilization, 40);
  assert.equal(r.seven_day.utilization, 22);
  // reset_after_seconds converted to absolute ISO
  assert.ok(r.five_hour.resets_at);
});

test('codex: header percents used when body omits them', () => {
  const body = { rate_limit: { primary_window: { limit_window_seconds: 18000 }, secondary_window: {} } };
  const r = parseCodexWhamUsage(body, {
    'x-codex-primary-used-percent': '33',
    'x-codex-secondary-used-percent': '7',
  }, NOW);
  assert.equal(r.five_hour.utilization, 33);
  assert.equal(r.seven_day.utilization, 7);
});

test('codex JWT exp parsing + refresh decision', () => {
  // header.payload with exp far future
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + 3600 })).toString('base64url');
  const token = `x.${payload}.y`;
  assert.equal(accessTokenExpiresAtMs(token), (Math.floor(NOW / 1000) + 3600) * 1000);
  assert.equal(needsRefresh(token, undefined, NOW), false); // >5min buffer left
  const soon = Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + 60 })).toString('base64url');
  assert.equal(needsRefresh(`x.${soon}.y`, undefined, NOW), true);
});

// --- grok billing decoder ------------------------------------------------------

test('grok: parses creditUsagePercent + weekly period end', () => {
  const r = parseGrokCreditsConfig({
    config: {
      creditUsagePercent: 28.5,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-28T06:29:14.153Z' },
      onDemandCap: { val: 0 },
    },
  });
  assert.equal(r.utilization, 28.5);
  assert.equal(r.resets_at, '2026-08-28T06:29:14.153Z');
  assert.equal(r.period_type, 'USAGE_PERIOD_TYPE_WEEKLY');
});

test('grok: omitted creditUsagePercent means zero (proto3)', () => {
  const r = parseGrokCreditsConfig({
    config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-28T00:00:00Z' } },
  });
  assert.equal(r.utilization, 0);
});

// --- command-code decoders --------------------------------------------------------

test('command-code: window used/cap ratio + resetAt epoch ms', () => {
  const w = parseCommandCodeWindows({
    windowLimits: {
      fiveHour: { used: 15, cap: 1000, resetAt: 1787310000000 },
      weekly: { used: 400, cap: 5000, resetAt: 1787800000000 },
    },
  });
  assert.equal(w.five_hour.utilization, 1.5);
  assert.equal(w.seven_day.utilization, 8);
  assert.equal(w.seven_day.resets_at, new Date(1787800000000).toISOString());
});

test('command-code: monthly utilization from remaining credits vs plan table', () => {
  const m = computeMonthly({
    credits: { remaining: 52.5, purchased: 0, free: 0, planId: 'individual-goat' },
    subscription: { planId: 'individual-goat', plan_type: 'GOAT', currentPeriodEnd: '2026-09-01T00:00:00Z' },
  });
  assert.equal(planMonthlyCredits('individual-goat'), 70);
  assert.equal(m.monthly_quota.used, 17.5);
  assert.ok(Math.abs(m.monthly.utilization - 25) < 0.01);
  assert.equal(m.monthly.resets_at, '2026-09-01T00:00:00Z');
});

// --- claude credentials -------------------------------------------------------------

test('claude: extracts OAuth creds from keychain blob shape', () => {
  const c = extractCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 },
  }));
  assert.equal(c.accessToken, 'tok');
  assert.ok(c.expiresAt > Date.now());
});

// --- framework pace math ---------------------------------------------------------------

test('pace: elapsed derives from resets_at minus window length (M2)', () => {
  // weekly window resetting exactly 3 days from now → elapsed = 4/7 = 57.14%
  const resetsAt = NOW + 3 * 24 * 3600_000;
  const p = windowPace({ usedPct: 18, resetsAtMs: resetsAt, windowMs: 7 * 24 * 3600_000, nowMs: NOW });
  assert.ok(Math.abs(p.elapsedPct - 57.1) < 0.1, `elapsed ${p.elapsedPct}`);
  assert.ok(Math.abs(p.surplus - (57.1 - 18)) < 0.1);
});

test('pace snapshot: weekly paces, 5h only gates (M3)', () => {
  const snap = {
    five_hour: { utilization: 95, resets_at: new Date(NOW + 3600_000).toISOString() },
    seven_day: { utilization: 18, resets_at: new Date(NOW + 3 * 24 * 3600_000).toISOString() },
  };
  const r = paceSnapshot(snap, NOW);
  assert.equal(r.pacing.usedPct, 18); // weekly drives pacing
  assert.equal(r.burstGate, true);    // 5h >= 90 blocks dispatch
});

test('pace snapshot: 5h near-limit threshold is 75, burst gate stays 90', () => {
  assert.equal(FIVE_HOUR_NEAR_LIMIT_PCT, 75);
  assert.equal(BURST_BLOCK_PCT, 90);
  const resetsAt = new Date(NOW + 3600_000).toISOString();
  const at = (utilization) => paceSnapshot({
    five_hour: { utilization, resets_at: resetsAt },
    seven_day: { utilization: 18, resets_at: new Date(NOW + 3 * 24 * 3600_000).toISOString() },
  }, NOW);

  const below = at(74);
  assert.equal(below.fiveHourUsedPct, 74);
  assert.equal(below.nearFiveHourLimit, false);
  assert.equal(below.burstGate, false);
  assert.equal(below.fiveHourResetsAt, resetsAt);
  // 5h never paces (M3): the weekly window still drives surplus.
  assert.equal(below.pacing.usedPct, 18);

  const atThreshold = at(75);
  assert.equal(atThreshold.fiveHourUsedPct, 75);
  assert.equal(atThreshold.nearFiveHourLimit, true);
  assert.equal(atThreshold.burstGate, false);

  const highButDispatchable = at(89);
  assert.equal(highButDispatchable.nearFiveHourLimit, true);
  assert.equal(highButDispatchable.burstGate, false);

  const gated = at(90);
  assert.equal(gated.fiveHourUsedPct, 90);
  assert.equal(gated.nearFiveHourLimit, true);
  assert.equal(gated.burstGate, true);
});

test('pace snapshot: no 5h reading means headroom, not near-limit', () => {
  const noWindow = paceSnapshot({
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: 18, resets_at: new Date(NOW + 3 * 24 * 3600_000).toISOString() },
  }, NOW);
  assert.equal(noWindow.fiveHourUsedPct, null);
  assert.equal(noWindow.fiveHourResetsAt, null);
  assert.equal(noWindow.nearFiveHourLimit, false);

  const empty = paceSnapshot(null, NOW);
  assert.equal(empty.fiveHourUsedPct, null);
  assert.equal(empty.fiveHourResetsAt, null);
  assert.equal(empty.nearFiveHourLimit, false);
});

test('buildPools copies the 5h gate fields onto flat pool fields', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'bs-5h-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    for (const name of ['near', 'headroom', 'unmetered']) {
      writeFileSync(join(dir, `connectors/${name}.json`), JSON.stringify({
        name, costRank: 2, lanes: ['analyze', 'build', 'chore'],
        meter: { type: 'reader', window: 'weekly' },
      }));
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1, pools: { near: { enabled: true }, headroom: { enabled: true }, unmetered: { enabled: true } },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));
    const resetsAt = new Date(NOW + 3600_000).toISOString();
    const weeklyResets = new Date(NOW + 3 * 24 * 3600_000).toISOString();
    const readings = {
      near: paceSnapshot({
        five_hour: { utilization: 82, resets_at: resetsAt },
        seven_day: { utilization: 10, resets_at: weeklyResets },
      }, NOW),
      // Reading with a 5h window and no pacing window at all: the gate must
      // still land on the pool.
      headroom: paceSnapshot({ five_hour: { utilization: 3, resets_at: resetsAt } }, NOW),
    };
    readings.near.source = 'live';
    readings.headroom.source = 'live';

    const { pools } = buildPools(dir, NOW, readings);
    const byName = Object.fromEntries(pools.map((pool) => [pool.name, pool]));
    assert.equal(byName.near.fiveHourUsedPct, 82);
    assert.equal(byName.near.fiveHourResetsAt, resetsAt);
    assert.equal(byName.near.nearFiveHourLimit, true);
    assert.equal(byName.headroom.fiveHourUsedPct, 3);
    assert.equal(byName.headroom.nearFiveHourLimit, false);
    assert.equal(byName.unmetered.fiveHourUsedPct, null);
    assert.equal(byName.unmetered.fiveHourResetsAt, null);
    assert.equal(byName.unmetered.nearFiveHourLimit, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a forced refresh keeps a cached reading for a pool with no live reader', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'bs-force-'));
  const previous = process.env.BULLSWARM_HOME;
  try {
    process.env.BULLSWARM_HOME = home;
    // Fresh import so METERS_DIR() resolves against this home.
    const { getMeterReading } = await import(`../src/meters/registry.js?forced=${Date.now()}`);
    mkdirSync(join(home, 'meters'), { recursive: true });
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(home, 'meters', 'fixture-pool.json'), JSON.stringify({
      captured_at: capturedAt,
      pool: 'fixture-pool',
      five_hour: { utilization: 80, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 5, resets_at: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() },
    }));
    // `fixture-pool` has no reader in READERS. Before, a forced call returned
    // source 'none' and blanked the 5h fields — right after a quota failure,
    // when routing needs them most.
    const forced = await getMeterReading('fixture-pool', { force: true });
    assert.equal(forced.source, 'cache');
    assert.equal(forced.fiveHourUsedPct, 80);
    assert.equal(forced.nearFiveHourLimit, true);

    const unforced = await getMeterReading('fixture-pool', { force: false });
    assert.equal(unforced.fiveHourUsedPct, 80);

    // No cache at all still reports honestly that nothing was measured.
    const missing = await getMeterReading('other-fixture-pool', { force: true });
    assert.equal(missing.source, 'none');
    assert.equal(missing.snapshot, null);
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed meter poll is held, honors Retry-After, then retries and clears on success', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-hold-'));
  const previous = process.env.BULLSWARM_HOME;
  const pool = 'rate-limited';
  const at = (ms) => new Date(NOW + ms).toISOString();
  let calls = 0;
  try {
    process.env.BULLSWARM_HOME = home;
    const { getMeterReading } = await import(`../src/meters/registry.js?hold=${Date.now()}`);
    const cache = new MeterCache(join(home, 'meters'));
    cache.put(pool, {
      captured_at: at(-FRESH_MS - 1),
      pool,
      five_hour: { utilization: 12, resets_at: at(3_600_000) },
      seven_day: { utilization: 20, resets_at: at(3 * 86_400_000) },
    });
    const reader = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('Usage endpoint returned 429');
        error.code = 'http';
        error.status = 429;
        error.retryAfterMs = 3 * 60_000;
        throw error;
      }
      return {
        captured_at: at(3 * 60_000),
        pool,
        five_hour: { utilization: 13, resets_at: at(3_600_000) },
        seven_day: { utilization: 21, resets_at: at(3 * 86_400_000) },
      };
    };

    const first = await getMeterReading(pool, { nowMs: NOW, reader });
    assert.equal(calls, 1);
    assert.equal(first.source, 'stale');
    assert.equal(first.meterError, '429');
    assert.equal(first.holdUntil, NOW + 3 * 60_000);
    assert.equal(first.error.status, 429);

    const held = await getMeterReading(pool, { nowMs: NOW + 60_000, reader });
    assert.equal(calls, 1, 'the reader is not called during the persisted hold');
    assert.equal(held.source, 'stale');
    assert.equal(held.holdUntil, NOW + 3 * 60_000);
    const hold = new MeterCache(join(home, 'meters')).getHold(pool);
    assert.equal(hold.retry_after_ms, 3 * 60_000);
    assert.equal(hold.failed_at, new Date(NOW).toISOString());
    assert.equal(hold.reason, '429');

    const retried = await getMeterReading(pool, { nowMs: NOW + 3 * 60_000, reader });
    assert.equal(calls, 2, 'the reader is called again once the hold expires');
    assert.equal(retried.source, 'live');
    assert.equal(retried.snapshot.seven_day.utilization, 21);
    assert.equal(new MeterCache(join(home, 'meters')).getHold(pool), null, 'success clears the hold');
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('force bypasses a meter hold, and errors without Retry-After use FRESH_MS', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-force-hold-'));
  const previous = process.env.BULLSWARM_HOME;
  const pool = 'force-rate-limited';
  let calls = 0;
  try {
    process.env.BULLSWARM_HOME = home;
    const { getMeterReading } = await import(`../src/meters/registry.js?force-hold=${Date.now()}`);
    const cache = new MeterCache(join(home, 'meters'));
    cache.put(pool, {
      captured_at: new Date(NOW - FRESH_MS - 1).toISOString(),
      pool,
      five_hour: { utilization: 12, resets_at: new Date(NOW + 3_600_000).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
    });
    const reader = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('offline'), { code: 'network' });
      return {
        captured_at: new Date(NOW + 60_000).toISOString(),
        pool,
        five_hour: { utilization: 13, resets_at: new Date(NOW + 3_600_000).toISOString() },
        seven_day: { utilization: 21, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
      };
    };
    const failed = await getMeterReading(pool, { nowMs: NOW, reader });
    assert.equal(failed.source, 'stale');
    assert.equal(new MeterCache(join(home, 'meters')).getHold(pool).retry_after_ms, FRESH_MS);
    const forced = await getMeterReading(pool, { nowMs: NOW + 60_000, force: true, reader });
    assert.equal(calls, 2);
    assert.equal(forced.source, 'live');
    assert.equal(new MeterCache(join(home, 'meters')).getHold(pool), null);
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('pools labels a stale HTTP 429 with its retry time', () => {
  assert.equal(
    meterSourceLabel({
      meterSource: 'stale', meterError: '429', meterHoldUntil: NOW + 3 * 60_000,
    }, NOW),
    'stale · 429, retry in 3m',
  );
});

test('pace snapshot: monthly used when no weekly', () => {
  const resetsAt = NOW + 10 * 24 * 3600_000;
  const snap = { monthly: { utilization: 41.6, resets_at: new Date(resetsAt).toISOString() } };
  const r = paceSnapshot(snap, NOW);
  assert.equal(r.pacing.usedPct, 41.6);
  assert.equal(r.pacing.resetsAt, new Date(resetsAt).toISOString());
  // month window length sanity (Aug 21 → Sep 21 = 31 days)
  assert.equal(monthlyWindowMs(resetsAt), 31 * 24 * 3600_000);
});

test('declared meter loses to provider reading; surplus from resets_at (M1/M2)', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'bs-meter-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    // grok: STALE declared 95% (the historical bug) + connector says weekly
    writeFileSync(join(dir, 'connectors/grok.json'), JSON.stringify({
      name: 'grok', costRank: 2, lanes: ['analyze','build','chore'],
      meter: { type: 'reader', window: 'weekly' },
    }));
    writeFileSync(join(dir, 'connectors/codex.json'), JSON.stringify({
      name: 'codex', costRank: 3, lanes: ['analyze','build','chore'],
      meter: { type: 'reader', window: 'weekly' },
    }));
    const state = {
      version: 1, pools: {}, incumbents: {}, decisionLog: [],
      config: { depthLimit: 2 },
    };
    state.pools.grok = { enabled: true, meter: { usedPct: 95 } };   // stale declare
    state.pools.codex = { enabled: true, meter: { usedPct: 18 } };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    // Provider truth: grok is actually at 1%, codex at 18%.
    const NOW = Date.parse('2026-08-21T12:00:00Z');
    const resetsAt = new Date(NOW + 3 * 24 * 3600_000).toISOString();
    const readings = {
      grok: {
        source: 'live',
        pacing: { usedPct: 1, elapsedPct: 57.1, surplus: 56.1, resetsAt },
        burstGate: false,
      },
      codex: {
        source: 'live',
        pacing: { usedPct: 18, elapsedPct: 57.1, surplus: 39.1, resetsAt },
        burstGate: false,
      },
    };
    const { pools } = buildPools(dir, NOW, readings);
    const g = pools.find((p) => p.name === 'grok');
    assert.equal(g.meterSource, 'live');           // reading wins over declaration
    assert.equal(g.usedPct, 1);                    // NOT the stale 95%
    assert.equal(g.pace, 56.1);                    // surplus from resets_at math
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M3: WHICH window paces one pool ----------------------------------------
//
// The command-code meter, read live at 2026-09-09T10:45:28Z. command-code
// buys a MONTHLY credit allocation (55.57 of 70 credits used, 14.43 left for
// the 7.7 days to 2026-09-17T03:06:55Z) and rate-limits weekly, so pacing it
// by its weekly window reported surplus +18.7 — "most behind, send it work" —
// while its real budget was already 4.1 points overspent.
const CMD_SNAPSHOT = {
  captured_at: '2026-09-09T10:45:28.000Z',
  pool: 'command-code',
  five_hour: { utilization: 25.2222, resets_at: '2026-09-09T13:24:01.942Z' },
  seven_day: { utilization: 73.11298889657142, resets_at: '2026-09-10T00:54:20.169Z' },
  monthly: { utilization: 79.38571428571429, resets_at: '2026-09-17T03:06:55.000Z' },
  monthly_quota: { used: 55.57, limit: 70, remaining: 14.43, unit: 'credits' },
  plan_type: 'GOAT',
};
const CMD_NOW = Date.parse('2026-09-09T11:09:44.982Z');

test('pace snapshot: a monthly-paced pool paces by its monthly window', () => {
  const monthly = paceSnapshot(CMD_SNAPSHOT, CMD_NOW, { pacingWindow: 'monthly' });
  assert.deepEqual(monthly.pacing, {
    usedPct: 79.4,
    elapsedPct: 75.3,
    surplus: -4.1,
    resetsAt: '2026-09-17T03:06:55.000Z',
  });
  assert.equal(monthly.pacingWindow, 'monthly');
  // The 31-day window length comes from the provider's resets_at (M2).
  assert.equal(monthlyWindowMs(Date.parse('2026-09-17T03:06:55.000Z')), 31 * 24 * 3600_000);
  // The 5h gate is untouched by the pacing window.
  assert.equal(monthly.fiveHourUsedPct, 25.2222);
  assert.equal(monthly.nearFiveHourLimit, false);
  assert.equal(monthly.burstGate, false);

  // 'weekly' and no declaration are the historical numbers, unchanged.
  const weekly = paceSnapshot(CMD_SNAPSHOT, CMD_NOW, { pacingWindow: 'weekly' });
  const dflt = paceSnapshot(CMD_SNAPSHOT, CMD_NOW);
  for (const r of [weekly, dflt]) {
    assert.deepEqual(r.pacing, {
      usedPct: 73.1,
      elapsedPct: 91.8,
      surplus: 18.7,
      resetsAt: '2026-09-10T00:54:20.169Z',
    });
    assert.equal(r.pacingWindow, 'weekly');
  }
  // Both windows are always reported; only the choice between them changes.
  assert.equal(dflt.windows.monthly.surplus, -4.1);
  assert.equal(monthly.windows.seven_day.surplus, 18.7);
});

test('pace snapshot: the chosen window falls back when the provider omits it', () => {
  const weeklyOnly = {
    seven_day: { utilization: 40, resets_at: new Date(NOW + 3 * 24 * 3600_000).toISOString() },
    monthly: { utilization: null, resets_at: null },
  };
  const paced = paceSnapshot(weeklyOnly, NOW, { pacingWindow: 'monthly' });
  assert.equal(paced.pacing.usedPct, 40);
  // pacingWindow names the window actually used, not the one asked for.
  assert.equal(paced.pacingWindow, 'weekly');

  const monthlyOnly = {
    monthly: { utilization: 41.6, resets_at: new Date(NOW + 10 * 24 * 3600_000).toISOString() },
  };
  const asWeekly = paceSnapshot(monthlyOnly, NOW, { pacingWindow: 'weekly' });
  assert.equal(asWeekly.pacing.usedPct, 41.6);
  assert.equal(asWeekly.pacingWindow, 'monthly');

  // Nothing to pace by at all: no window, no name.
  const gateOnly = paceSnapshot({
    five_hour: { utilization: 3, resets_at: new Date(NOW + 3600_000).toISOString() },
  }, NOW, { pacingWindow: 'monthly' });
  assert.equal(gateOnly.pacing, null);
  assert.equal(gateOnly.pacingWindow, null);
  assert.equal(paceSnapshot(null, NOW).pacingWindow, null);
});

test('pacingWindowFor: the operator overrides the connector; unknown labels pace by default', () => {
  const connector = { subscription: { quotaWindow: 'monthly' } };
  // Connector alone (command-code ships quotaWindow: "monthly").
  assert.equal(pacingWindowFor({ connector }), 'monthly');
  assert.equal(pacingWindowFor({ connector: { subscription: { quotaWindow: 'weekly' } } }), 'weekly');
  // state.strategy.subscriptions[pool] wins over the connector.
  assert.equal(pacingWindowFor({ connector, subscription: { quotaWindow: 'weekly' } }), 'weekly');
  assert.equal(
    pacingWindowFor({ connector: { subscription: { quotaWindow: 'weekly' } }, subscription: { quotaWindow: 'MONTHLY' } }),
    'monthly',
  );
  // A stored label that is neither is ignored for pacing (default order),
  // never rejected on read — pre-0.28.1 state holds free-text labels.
  assert.equal(pacingWindowFor({ connector, subscription: { quotaWindow: 'fortnight' } }), null);
  assert.equal(pacingWindowFor({ connector: { subscription: { quotaWindow: 'weekly+monthly+5h' } } }), null);
  // Nothing declared anywhere.
  assert.equal(pacingWindowFor({}), null);
  assert.equal(pacingWindowFor(), null);
  assert.equal(pacingWindowFor({ connector: { subscription: { quotaWindow: null } } }), null);

  assert.equal(normalizePacingWindow('  Weekly '), 'weekly');
  assert.equal(normalizePacingWindow(7), null);
  assert.equal(normalizePacingWindow(null), null);
});

test('buildPools: a monthly-paced pool paces monthly with no operator setting', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'bs-pacing-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    // Exactly what connectors/command-code.json and connectors/claude-code.json declare.
    writeFileSync(join(dir, 'connectors/command-code.json'), JSON.stringify({
      name: 'command-code', costRank: 1, lanes: ['analyze', 'build', 'chore'],
      meter: { type: 'reader', window: 'weekly+monthly+5h' },
      subscription: { plan: null, quotaWindow: 'monthly' },
    }));
    writeFileSync(join(dir, 'connectors/claude-code.json'), JSON.stringify({
      name: 'claude-code', costRank: 2, lanes: ['analyze', 'build', 'chore'],
      meter: { type: 'reader', window: 'weekly' },
      subscription: { plan: null, quotaWindow: 'weekly' },
    }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      pools: { 'command-code': { enabled: true }, 'claude-code': { enabled: true } },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));

    const claudeSnapshot = {
      captured_at: '2026-09-09T10:45:28.000Z',
      five_hour: { utilization: 10, resets_at: '2026-09-09T13:24:01.942Z' },
      seven_day: { utilization: 20, resets_at: '2026-09-10T00:54:20.169Z' },
    };
    const readings = {
      // The cache path and the live path are paced identically: the choice is
      // made where the connector and the state are, not in the reader.
      'command-code': { ...paceSnapshot(CMD_SNAPSHOT, CMD_NOW), source: 'cache', snapshot: CMD_SNAPSHOT },
      'claude-code': { ...paceSnapshot(claudeSnapshot, CMD_NOW), source: 'live', snapshot: claudeSnapshot },
    };
    const { pools } = buildPools(dir, CMD_NOW, readings);
    const byName = Object.fromEntries(pools.map((pool) => [pool.name, pool]));

    const cmd = byName['command-code'];
    assert.equal(cmd.pacingWindow, 'monthly');
    assert.equal(cmd.usedPct, 79.4);
    assert.equal(cmd.elapsedPct, 75.3);
    assert.equal(cmd.pace, -4.1);           // NOT the weekly +18.7
    assert.equal(cmd.paceResetsAt, '2026-09-17T03:06:55.000Z');
    // The 5h gate still reads the 5h window.
    assert.equal(cmd.fiveHourUsedPct, 25.2222);

    // A weekly pool with a weekly reading is untouched.
    const claude = byName['claude-code'];
    assert.equal(claude.pacingWindow, 'weekly');
    assert.equal(claude.usedPct, 20);
    assert.equal(claude.pace, 71.8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPools: the operator setting overrides the connector window', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'bs-pacing-override-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    writeFileSync(join(dir, 'connectors/command-code.json'), JSON.stringify({
      name: 'command-code', costRank: 1, lanes: ['chore'],
      meter: { type: 'reader', window: 'weekly+monthly+5h' },
      subscription: { quotaWindow: 'monthly' },
    }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      pools: { 'command-code': { enabled: true } },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
      strategy: { subscriptions: { 'command-code': { quotaWindow: 'weekly' } } },
    }));
    const readings = {
      'command-code': { ...paceSnapshot(CMD_SNAPSHOT, CMD_NOW), source: 'live', snapshot: CMD_SNAPSHOT },
    };
    // First-class providers load alongside the home's connector, so find it by name.
    const pool = buildPools(dir, CMD_NOW, readings).pools.find((candidate) => candidate.name === 'command-code');
    assert.equal(pool.pacingWindow, 'weekly');
    assert.equal(pool.pace, 18.7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPools: a reading with no windows keeps its pacing, and an unmetered pool keeps its declaration', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'bs-pacing-legacy-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    writeFileSync(join(dir, 'connectors/legacy.json'), JSON.stringify({
      name: 'legacy', costRank: 2, lanes: ['chore'],
      meter: { type: 'reader', window: 'weekly' },
      subscription: { quotaWindow: 'monthly' },
    }));
    writeFileSync(join(dir, 'connectors/quiet.json'), JSON.stringify({
      name: 'quiet', costRank: 2, lanes: ['chore'],
      meter: { type: 'none' },
      subscription: { quotaWindow: 'monthly' },
    }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1, pools: { legacy: { enabled: true }, quiet: { enabled: true } },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));
    // A hand-built reading with `pacing` and no `windows` (an older code
    // path): its numbers are used as-is rather than dropped.
    const readings = {
      legacy: {
        source: 'live',
        pacing: { usedPct: 12, elapsedPct: 50, surplus: 38, resetsAt: '2026-09-10T00:54:20.169Z' },
        burstGate: false,
      },
    };
    const byName = Object.fromEntries(
      buildPools(dir, CMD_NOW, readings).pools.map((pool) => [pool.name, pool]),
    );
    assert.equal(byName.legacy.pace, 38);
    assert.equal(byName.legacy.pacingWindow, 'monthly');
    // No reading at all: the declared window still says how this pool is paced.
    assert.equal(byName.quiet.meterSource, 'none');
    assert.equal(byName.quiet.pacingWindow, 'monthly');
    assert.equal(byName.quiet.pace, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- declared reset (M2, operator path) --------------------------------------

test('rollResetForward: a future anchor is itself; a passed one steps by whole windows', () => {
  const now = Date.parse('2026-09-11T06:48:54Z');
  // Not yet passed: used exactly as declared.
  assert.equal(
    rollResetForward(Date.parse('2026-09-17T01:46:01Z'), 'monthly', now),
    Date.parse('2026-09-17T01:46:01Z'),
  );
  // Passed: the next calendar month, same day and time.
  assert.equal(
    rollResetForward(Date.parse('2026-08-17T01:46:01Z'), 'monthly', now),
    Date.parse('2026-09-17T01:46:01Z'),
  );
  // Months count from the anchor, so a 31st does not drift to the 28th.
  assert.equal(
    rollResetForward(Date.parse('2026-01-31T00:00:00Z'), 'monthly', Date.parse('2026-03-01T00:00:00Z')),
    Date.parse('2026-03-31T00:00:00Z'),
  );
  // Weekly steps are 7 days.
  assert.equal(rollResetForward(now - 10 * 24 * 3600_000, 'weekly', now), now + 4 * 24 * 3600_000);
  // Nothing usable is NaN, never a guess.
  assert.ok(Number.isNaN(rollResetForward(NaN, 'monthly', now)));
  assert.ok(Number.isNaN(rollResetForward(now - 1, '5h', now)));
});

test('declaredResetPacing: provider usage with no reset paces from the declared date, labeled', () => {
  const now = Date.parse('2026-09-11T06:48:54Z');
  // A reseller wallet reader's shape for a never-expiring token: usage, no reset.
  const snap = { monthly: { utilization: 73.765296, resets_at: null } };
  // paceSnapshot alone cannot pace this — no reset, no elapsed (M2).
  assert.equal(paceSnapshot(snap, now).pacing, null);

  const r = declaredResetPacing(snap, { pacingWindow: 'monthly', resetsAt: '2026-09-17T01:46:01Z', nowMs: now });
  assert.equal(r.window, 'monthly');
  assert.equal(r.resetSource, 'declared');
  assert.equal(r.pacing.usedPct, 73.8);
  assert.equal(r.pacing.resetsAt, '2026-09-17T01:46:01.000Z');
  // Aug 17 → Sep 17 is 31 days; elapsed is the share of it already run.
  const windowMs = 31 * 24 * 3600_000;
  const elapsedRaw = ((now - (Date.parse('2026-09-17T01:46:01Z') - windowMs)) / windowMs) * 100;
  assert.equal(r.pacing.elapsedPct, Math.round(elapsedRaw * 10) / 10);
  assert.equal(r.pacing.surplus, Math.round((elapsedRaw - 73.765296) * 10) / 10);
});

test('declaredResetPacing: a provider-dated window is left alone; no declaration means no pacing', () => {
  const now = Date.parse('2026-09-11T06:48:54Z');
  const dated = { monthly: { utilization: 26.9, resets_at: '2026-09-30T07:12:10.000Z' } };
  assert.equal(
    declaredResetPacing(dated, { pacingWindow: 'monthly', resetsAt: '2026-09-29T07:12:02Z', nowMs: now }),
    null,
  );
  const undated = { monthly: { utilization: 10.7, resets_at: null } };
  assert.equal(declaredResetPacing(undated, { pacingWindow: 'monthly', resetsAt: null, nowMs: now }), null);
  assert.equal(declaredResetPacing(undated, { pacingWindow: 'monthly', resetsAt: 'someday', nowMs: now }), null);
  assert.equal(declaredResetPacing(null, { pacingWindow: 'monthly', resetsAt: '2026-09-17T01:46:01Z', nowMs: now }), null);
});

test('buildPools: an operator-declared reset paces a reading the provider left undated', async () => {
  const { buildPools } = await import('../src/lib/config.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const now = Date.parse('2026-09-11T06:48:54Z');
  const dir = mkdtempSync(join(tmpdir(), 'bs-declared-reset-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    for (const name of ['relay', 'relay:b', 'relay:c']) {
      writeFileSync(join(dir, `connectors/${name}.json`), JSON.stringify({
        name, costRank: 1, lanes: ['analyze', 'build', 'chore'],
        meter: { type: 'reader' },
        subscription: { plan: 'relay-wallet', quotaWindow: 'monthly' },
      }));
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      pools: {
        relay: { enabled: true },
        'relay:b': { enabled: true },
        'relay:c': { enabled: true },
      },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
      strategy: {
        subscriptions: {
          // Declared for a pool the provider leaves undated …
          relay: { resetsAt: '2026-09-17T01:46:01.000Z' },
          // … and for one the provider DOES date (a day apart), to prove the
          // provider's wins. relay:c declares nothing.
          'relay:b': { resetsAt: '2026-09-29T07:12:02.000Z' },
        },
      },
    }));
    const snapshotFor = (pool, utilization, resets_at = null) => ({
      captured_at: '2026-09-11T06:46:26.341Z', pool,
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      monthly: { utilization, resets_at },
    });
    const readings = {};
    for (const [pool, u, reset] of [
      ['relay', 73.765296, null],
      ['relay:b', 26.918544, '2026-09-30T07:12:10.000Z'],
      ['relay:c', 10.661976, null],
    ]) {
      const snapshot = snapshotFor(pool, u, reset);
      readings[pool] = { ...paceSnapshot(snapshot, now), source: 'live', snapshot };
    }
    const { pools } = buildPools(dir, now, readings);
    const byName = Object.fromEntries(pools.map((pool) => [pool.name, pool]));

    const declared = byName.relay;
    assert.equal(declared.meterSource, 'live');      // the used% is still the provider's
    assert.equal(declared.resetSource, 'declared');
    assert.equal(declared.pacingWindow, 'monthly');
    assert.equal(declared.usedPct, 73.8);
    assert.equal(declared.paceResetsAt, '2026-09-17T01:46:01.000Z');
    assert.ok(declared.elapsedPct > 80 && declared.elapsedPct < 82, `elapsed ${declared.elapsedPct}`);
    assert.ok(Math.abs(declared.pace - (declared.elapsedPct - declared.usedPct)) <= 0.11, `pace ${declared.pace}`);

    // Provider truth first: the declared date is ignored when the meter dates
    // the window itself.
    const dated = byName['relay:b'];
    assert.equal(dated.resetSource, 'provider');
    assert.equal(dated.paceResetsAt, '2026-09-30T07:12:10.000Z');
    assert.equal(dated.usedPct, 26.9);

    // No declaration: the same undated reading stays unmetered — no reset, no
    // elapsed, no invented window (M2).
    const plain = byName['relay:c'];
    assert.equal(plain.meterSource, 'none');
    assert.equal(plain.resetSource, null);
    assert.equal(plain.usedPct, null);
    assert.equal(plain.pace, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan total: the declared subscription reaches the provider reader as its denominator', async () => {
  const { declaredSubscription, readerFor } = await import('../src/meters/registry.js');
  const { loadProviders } = await import('../src/lib/providers.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // A newcomer wallet can be $20 while the older ones are $50.
  const subs = { 'relay:b': { includedValueUsd: 20 }, relay: { includedValueUsd: null } };
  assert.deepEqual(declaredSubscription(subs, 'relay:b'), { includedValueUsd: 20 });
  assert.deepEqual(declaredSubscription(subs, 'relay'), { includedValueUsd: null });
  assert.equal(declaredSubscription(undefined, 'relay:c'), null);
  assert.equal(declaredSubscription({ relay: 'garbage' }, 'relay'), null);

  // The contract's relay fixture reports $12.50 spent from its wallet.
  const fixtures = fileURLToPath(new URL('./fixtures/providers/', import.meta.url));
  const home = mkdtempSync(join(tmpdir(), 'bs-plan-total-'));
  try {
    const { providers } = loadProviders(home, {
      dirs: { local: join(fixtures, 'local'), legacy: join(home, 'connectors') },
    });
    const utilization = async (pool, opts) => (await readerFor(pool, { providers, ...opts })()).monthly.utilization;
    assert.equal(await utilization('relay:b', { subscriptions: subs }), 62.5);
    assert.equal(await utilization('relay:b', { subscription: { includedValueUsd: 50 } }), 25);
    // No declared plan total means no denominator, never a guessed one.
    assert.equal(await utilization('relay', { subscriptions: subs }), null);
    assert.equal(await utilization('relay:b', {}), null);
    assert.equal(readerFor('nobody-owns-this', { providers }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
