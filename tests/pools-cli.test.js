// `bullswarm pools` and a single `bullswarm run` against the real binary on
// throwaway homes: no pool is ever paused or benched (owner decision
// 2026-09-25, state.js S1), and the commands that managed pauses are gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { poolStatusText } from '../src/cli.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

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

test('pools resume and strategy set-pausing are unknown commands now: exit 2, the usual message, nothing written', () => {
  const home = makeHome({ pools: { grok: { quarantine: { until: Date.now() + 600_000, reason: 'auth signature', kind: 'auth' } } } });
  try {
    // The same message any other stray pools subcommand gets. (The first
    // command in a fresh home completes its setup, which writes state.json.)
    const stray = run(home, ['pools', 'frobnicate']);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /^✗ unknown pools subcommand "frobnicate"\n/);
    const before = readFileSync(join(home, 'state.json'), 'utf8');
    const resume = run(home, ['pools', 'resume', 'grok']);
    assert.equal(resume.status, 2, resume.stdout);
    assert.match(resume.stderr, /^✗ unknown pools subcommand "resume"\n/);
    assert.match(resume.stderr, /usage: bullswarm pools /);
    for (const argv of [['strategy', 'set-pausing', 'off'], ['strategy', 'set-pausing', 'on', '--json']]) {
      const pausing = run(home, argv);
      assert.equal(pausing.status, 2, `${argv.join(' ')}: ${pausing.stdout}`);
      // What `strategy` answers every subcommand it does not know.
      assert.equal(pausing.stderr, run(home, ['strategy', 'frobnicate']).stderr, argv.join(' '));
      assert.match(pausing.stderr, /^✗ Usage: bullswarm strategy /);
      assert.equal(pausing.stdout, '');
    }
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before, 'nothing was written');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The owner's state.json still held a bench for opencode, and older homes
// hold quarantines, `strategy.pausing: "off"` and strikes. `bullswarm pools`
// reads past them: no PAUSED, BENCHED or strikes text, no switch line.
test('bullswarm pools reads a state.json with old quarantine, bench and switch records without a pause', () => {
  const until = Date.now() + 3 * 24 * 3600_000;
  const home = makeHome({
    strategy: { pausing: 'off' },
    pools: {
      echo: { enabled: true, quarantine: { until, reason: 'usage limit', kind: 'quota', rule: 'message' }, bench: { until, reason: 'stall', count: 2 } },
      opencode: { bench: { until: null, reason: 'provider', count: 1 } },
    },
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  });
  try {
    const before = readFileSync(join(home, 'state.json'), 'utf8');
    const text = run(home, ['pools']);
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(`${text.stdout}${text.stderr}`, /PAUSED|BENCHED|strikes=|automatic pausing|quarantine|bench expired/i);
    const echo = text.stdout.split('\n').find((line) => line.startsWith('echo '));
    assert.ok(echo, text.stdout);
    assert.match(echo, / ready/);
    const json = run(home, ['pools', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(body), ['pools']);
    for (const pool of body.pools) {
      for (const key of ['quarantine', 'bench', 'pauseWhy']) assert.equal(Object.hasOwn(pool, key), false, `${pool.name}.${key}`);
    }
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before, '`pools` observes; it rewrites nothing');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a pool status is disabled or ready with its 5-hour flags; an old record on the view changes nothing', () => {
  assert.equal(poolStatusText({ name: 'codex', enabled: false }), 'disabled');
  assert.equal(poolStatusText({ name: 'codex', enabled: true }), 'ready');
  assert.equal(poolStatusText({ name: 'codex', enabled: true, burstGate: true, nearFiveHourLimit: true }), 'ready BURST-GATED NEAR-5H-LIMIT');
  assert.equal(poolStatusText({
    name: 'grok', enabled: true,
    quarantine: { until: Date.now() + 600_000, kind: 'auth', reason: 'auth signature' },
    bench: { until: null, reason: 'stall', count: 1 },
  }), 'ready');
});

// A home with only the echo test pool, for a single `bullswarm run`.
function echoHome() {
  const home = makeHome({
    pools: { echo: { enabled: true } },
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
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

// A single run is under the limits-to-caller rule: a spent window with its
// reset named is `quota`, with that reset as retryAfter, and the 100% refusal
// marker is written with a named reset (the echo pool has no meter reader), so
// the next pick sees the spent pool. Nothing is paused.
test('run: a spent usage window with its reset named is quota, pauses nothing and writes a named refusal marker', () => {
  const home = echoHome();
  try {
    const result = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--json', '--prompt', 'FAIL:quota']);
    assert.equal(result.status, 1, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.failureKind, 'quota', verdict.why);
    assert.equal(verdict.usageLimit.rule, 'message');
    assert.match(verdict.why, /^usage window spent: provider said "Error: usage limit reached · resets in 45 minutes" · back at /);
    for (const key of ['quarantineHint', 'quarantineUntil', 'quarantineSource', 'quarantinedUntil', 'quarantinedSiblings', 'quotaPause']) {
      assert.equal(Object.hasOwn(verdict, key), false, key);
    }
    assert.equal(verdict.meterRefresh.source, 'quota-refusal');
    const marker = JSON.parse(readFileSync(join(home, 'meters', 'echo.json'), 'utf8'));
    assert.equal(marker.source, 'quota-refusal');
    assert.equal(marker.quota_refusal.resets_at, verdict.retryAfter);
    assert.equal(marker.quota_refusal.reset_source, 'named');
    const state = readState(home);
    assert.equal(state.pools.echo.quarantine, undefined, 'not paused');
    assert.equal(state.pools.echo.bench, undefined, 'not benched');
    // The named marker keeps the pool out until its reset.
    const next = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--dry-run', '--json', '--prompt', 'hi']);
    assert.equal(next.status, 1, next.stderr);
    assert.equal(JSON.parse(next.stdout).pick, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// MUST FIX (wave B): a window-worded notice that names no reset, on a pool
// with no meter reader, wrote the 100% refusal marker with a GUESSED reset
// (a whole week from now) that routing counted, so the pool was shut out for
// days with nothing to lift it. The marker now says the reset was guessed,
// and a guessed marker keeps no pool out.
test('run: a usage limit that names no reset, on a pool with no meter reader, is quota and the next run still offers the pool', () => {
  const home = makeHome({
    pools: { limited: { enabled: true } },
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  });
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    const worker = join(home, 'connectors', 'limited-worker.mjs');
    writeFileSync(worker, 'const task = (await import("node:fs")).readFileSync(process.argv[2], "utf8");\n'
      + 'console.log(task.includes("LIMIT") ? "You\'ve hit your usage limit" : "## Done\\n\\nAll checks passed; the work is complete and verified.");\n');
    const echo = JSON.parse(readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json'), 'utf8'));
    writeFileSync(join(home, 'connectors', 'limited.json'), JSON.stringify({
      ...echo, name: 'limited', spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    }));
    const limited = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--json', '--prompt', 'LIMIT']);
    assert.equal(limited.status, 1, limited.stderr);
    const verdict = JSON.parse(limited.stdout);
    assert.equal(verdict.pick.pool, 'limited');
    assert.equal(verdict.failureKind, 'quota', verdict.why);
    assert.equal(verdict.retryAfter, undefined, 'no reset was named');
    assert.equal(verdict.why, 'usage window spent: provider said "You\'ve hit your usage limit" · no reset named · meter not read');
    const marker = JSON.parse(readFileSync(join(home, 'meters', 'limited.json'), 'utf8'));
    assert.equal(marker.quota_refusal.reset_source, 'guessed');
    assert.equal(marker.seven_day.utilization, 100);
    // The next routing still offers the pool: the guessed marker is not a wall.
    const next = runEcho(home, ['run', '--lane', 'build', '--no-caller', '--dry-run', '--json', '--prompt', 'hi']);
    assert.equal(next.status, 0, next.stdout);
    assert.equal(JSON.parse(next.stdout).pick.pool, 'limited');
    // `pools` names the refusal without calling the pool blocked.
    const pools = run(home, ['pools']);
    assert.match(pools.stdout, /limited .*\[refused (just now|\d+m ago) · reset unknown\]/);
    assert.doesNotMatch(pools.stdout, /limited .*blocked/);
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
