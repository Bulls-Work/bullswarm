import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCodexWhamUsage, needsRefresh, accessTokenExpiresAtMs,
} from '../src/meters/codex.js';
import { parseGrokCreditsConfig } from '../src/meters/grok.js';
import {
  parseCommandCodeCredits, parseCommandCodeWindows, computeMonthly, planMonthlyCredits,
} from '../src/meters/command-code.js';
import { extractCredentials } from '../src/meters/claude.js';
import { windowPace, paceSnapshot, monthlyWindowMs } from '../src/meters/framework.js';

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
