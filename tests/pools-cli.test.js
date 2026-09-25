// `bullswarm pools resume <pool>` and `bullswarm strategy set-pausing on|off`,
// exercised against the real binary on throwaway homes, plus the plain-words
// pause line `bullswarm pools` prints (quota.js Q6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { poolStatusText } from '../src/cli.js';
import { decideQuotaPause } from '../src/lib/quota.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const NOW = Date.parse('2026-09-21T06:30:00Z');
const TRANSIENT = 'Error: Rate limit exceeded. Please wait a moment and try again.';
const SESSION = "You've hit your session limit · resets in 2 hours";

function makeHome(state = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-pools-cli-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, pools: {}, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
    ...state,
  }));
  return home;
}

function run(home, argv) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' },
    encoding: 'utf8',
    input: '',
  });
}

const readState = (home) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));

function quotaRecord(now = Date.now()) {
  const evidence = decideQuotaPause({ text: SESSION, meter: null, pausing: true, now });
  return {
    until: evidence.until, reason: evidence.why, kind: 'quota', rule: evidence.rule,
    line: evidence.line, meter: evidence.meter, meterWindow: null, resetsAt: evidence.resetsAt,
    pausedAt: new Date(now).toISOString(),
  };
}

test('pools resume lifts a quota pause at once, logs it, and drops the refusal meter marker', () => {
  const home = makeHome({ pools: { 'claude-code': { quarantine: quotaRecord() } } });
  try {
    writeFileSync(join(home, 'meters', 'claude-code.json'), JSON.stringify({
      pool: 'claude-code', source: 'quota-refusal', captured_at: new Date().toISOString(),
      quota_refusal: { refused_at: new Date().toISOString(), resets_at: new Date(Date.now() + 3600_000).toISOString(), window: '5h' },
      five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3600_000).toISOString(), source: 'quota-refusal' },
    }));
    const result = run(home, ['pools', 'resume', 'claude-code']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^claude-code resumed — lifted this pause: paused until .* · usage window spent, provider named the reset · provider: "You've hit your session limit · resets in 2 hours"/);
    assert.match(result.stdout, /dropped the 100% quota-refusal meter marker; the next meter read is live/);
    const state = readState(home);
    assert.equal(state.pools['claude-code'].quarantine, undefined);
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.kind, 'pool-resume');
    assert.equal(entry.pool, 'claude-code');
    assert.equal(entry.lifted.quarantine.kind, 'quota');
    assert.equal(existsSync(join(home, 'meters', 'claude-code.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pools resume --json reports what it lifted; an unpaused pool is left as it was', () => {
  const home = makeHome({ pools: { grok: { quarantine: { until: Date.now() + 600_000, reason: 'auth signature', kind: 'auth' } } } });
  try {
    const lifted = run(home, ['pools', 'resume', 'grok', '--json']);
    assert.equal(lifted.status, 0, lifted.stderr);
    const body = JSON.parse(lifted.stdout);
    assert.equal(body.pool, 'grok');
    assert.equal(body.resumed, true);
    assert.equal(body.lifted.quarantine.kind, 'auth');
    assert.equal(body.lifted.refusalMeterMarker, false);
    const again = run(home, ['pools', 'resume', 'grok']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), 'grok was not paused; nothing to lift');
    assert.equal(readState(home).decisionLog.filter((e) => e.kind === 'pool-resume').length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pools resume refuses an unknown pool or a missing name with exit 2 and writes nothing', () => {
  const home = makeHome();
  try {
    const unknown = run(home, ['pools', 'resume', 'no-such-pool']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown pool "no-such-pool"/);
    const missing = run(home, ['pools', 'resume']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /usage: bullswarm pools resume <pool> \[--json\]/);
    assert.equal(readState(home).decisionLog.length, 0);
    const stray = run(home, ['pools', 'frobnicate']);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /unknown pools subcommand "frobnicate"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('strategy set-pausing off|on is stored in state.json; anything else is a usage error', () => {
  const home = makeHome();
  try {
    const off = run(home, ['strategy', 'set-pausing', 'off']);
    assert.equal(off.status, 0, off.stderr);
    // The switch pauses nothing, and changes no failure kind.
    assert.equal(off.stdout.trim(), 'automatic pausing is off: no pool is paused or benched by a command (quota, auth or siblings); '
      + 'a spent usage window still goes back to the caller, and a retry after a sign-in failure still skips the pools that share '
      + 'that credential · bullswarm strategy set-pausing on restores it');
    assert.equal(readState(home).strategy.pausing, 'off');
    const on = run(home, ['strategy', 'set-pausing', 'on', '--json']);
    assert.equal(on.status, 0, on.stderr);
    assert.deepEqual(JSON.parse(on.stdout), { pausing: 'on' });
    assert.equal('pausing' in (readState(home).strategy ?? {}), false);
    const bad = run(home, ['strategy', 'set-pausing', 'maybe']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: bullswarm strategy set-pausing <on\|off> \[--json\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bullswarm pools says why a pool is paused, in plain words, with the lift command', () => {
  const evidence = decideQuotaPause({
    text: TRANSIENT,
    meter: {
      captured_at: '2026-09-21T06:20:00Z',
      five_hour: { utilization: 48, resets_at: '2026-09-21T08:00:00Z' },
      seven_day: { utilization: 96, resets_at: '2026-09-24T12:00:00Z' },
    },
    pausing: true,
    now: NOW,
  });
  const quarantine = { ...evidence, kind: 'quota', reason: evidence.why };
  assert.equal(
    poolStatusText({ name: 'claude-code', enabled: true, quarantine }, NOW, { timeZone: 'UTC' }),
    'PAUSED until Thu 24 Sep 12:00 · usage window spent, meter read weekly 96% (>= 95%)'
      + ` · provider: "${TRANSIENT}" · meter then: 5h 48% · weekly 96%`
      + ' · lift now: bullswarm pools resume claude-code',
  );
  assert.equal(
    poolStatusText({ name: 'grok', enabled: true, quarantine: { until: NOW + 600_000, kind: 'auth', reason: 'auth signature' } }, NOW, { timeZone: 'UTC' }),
    'PAUSED until 06:40 · auth: auth signature · lift now: bullswarm pools resume grok',
  );
  assert.equal(poolStatusText({ name: 'codex', enabled: true, bench: { until: null, reason: 'stall', count: 1 } }, NOW), 'ready strikes=1(stall)');
  assert.equal(poolStatusText({ name: 'codex', enabled: false }, NOW), 'disabled');
});

// A home with only the echo test pool, for a single `bullswarm run`.
function echoHome(strategy = null) {
  const home = makeHome({
    pools: { echo: { enabled: true } },
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
    ...(strategy ? { strategy } : {}),
  });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'echo.json'), readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json')));
  writeFileSync(join(home, 'connectors', 'echo-worker.mjs'), readFileSync(join(ROOT, 'src', 'providers', 'echo', 'echo-worker.mjs')));
  return home;
}

function runEcho(home, argv) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' },
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
}

// A single run is under the limits-to-caller rule. With pausing
// off a spent window with its reset named is still `quota`, and the 100%
// refusal marker is written (the echo pool has no meter reader), so the next
// pick sees the spent pool; nothing is paused.
test('run: with pausing off a spent usage window is quota, pauses nothing and writes the refusal marker', () => {
  const home = echoHome({ pausing: 'off' });
  try {
    const result = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--json', '--prompt', 'FAIL:quota']);
    assert.equal(result.status, 1, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.failureKind, 'quota', verdict.why);
    assert.equal(verdict.quotaPause.rule, 'off');
    assert.equal(verdict.quarantineHint, undefined);
    assert.equal(verdict.meterRefresh.source, 'quota-refusal');
    const marker = JSON.parse(readFileSync(join(home, 'meters', 'echo.json'), 'utf8'));
    assert.equal(marker.source, 'quota-refusal');
    assert.equal(marker.quota_refusal.resets_at, new Date(verdict.quotaPause.holdUntil).toISOString());
    assert.equal(readState(home).pools.echo.quarantine, undefined, 'pausing off: not paused');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A pool whose weekly window reads 100% until a reset days
// away is never picked, even as the only pool.
test('run: a pool with its weekly window spent until a later reset is not picked', () => {
  const home = echoHome();
  try {
    const at = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
    const reading = (weekly) => JSON.stringify({
      pool: 'echo', captured_at: new Date().toISOString(),
      five_hour: { utilization: 10, resets_at: at(2) },
      seven_day: { utilization: weekly, resets_at: at(72) },
    });
    writeFileSync(join(home, 'meters', 'echo.json'), reading(100));
    const spent = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--dry-run', '--json', '--prompt', 'hi']);
    assert.equal(spent.status, 1, spent.stderr);
    const refused = JSON.parse(spent.stdout);
    assert.equal(refused.ok, false);
    assert.equal(refused.pick, undefined, refused.why);
    writeFileSync(join(home, 'meters', 'echo.json'), reading(99));
    const open = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--dry-run', '--json', '--prompt', 'hi']);
    assert.equal(open.status, 0, open.stderr);
    assert.equal(JSON.parse(open.stdout).pick.pool, 'echo');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
