// Every pool enable or disable leaves a record of who, when and why
// (state.json strategy.poolToggles). On 11 Nov a pool was disabled and
// nothing said who did it or why, so a weekly review could not tell.
//
// Every case runs on a throwaway BULLSWARM_HOME holding only the echo test
// pool, with the packaged providers off. Nothing here reaches dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const OS_USER = userInfo().username;

function echoHome(pools = { echo: { enabled: true } }, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-pool-toggle-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'echo.json'), readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json')));
  writeFileSync(join(home, 'connectors', 'echo-worker.mjs'), readFileSync(join(ROOT, 'src', 'providers', 'echo', 'echo-worker.mjs')));
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools,
    decisionLog: [],
    config: { depthLimit: 2, testFixturesMigrated: true },
    // A cached report, so strategy commands read it instead of running
    // discovery against installed CLIs.
    strategy: {
      lastReport: {
        capturedAt: new Date().toISOString(),
        subscriptions: [],
        suggestions: {},
        discoveries: { echo: { models: [{ id: 'echo-local', tier: 'low', qualityRank: 1 }] } },
      },
    },
    ...extra,
  }, null, 2)}\n`);
  return home;
}

function run(home, argv, env = {}) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: {
      ...process.env,
      BULLSWARM_HOME: home,
      BULLSWARM_NO_PACKAGED_PROVIDERS: '1',
      BULLSWARM_DISABLE_CLAUDE_PROFILES: '1',
      ...env,
    },
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
}

const readState = (home) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('set-provider off --reason and on without one each record enabled, at, by, reason and via', () => {
  const home = echoHome();
  try {
    const before = Date.now();
    const off = run(home, ['strategy', 'set-provider', 'echo', 'off', '--yes', '--reason', 'weekly cap reached'], { HERDR_PANE_ID: 'w9:p2' });
    assert.equal(off.status, 0, off.stderr);
    let state = readState(home);
    assert.equal(state.pools.echo.enabled, false);
    const first = state.strategy.poolToggles.echo.latest;
    assert.equal(first.enabled, false);
    assert.match(first.at, ISO);
    assert.ok(Date.parse(first.at) >= before - 1000 && Date.parse(first.at) <= Date.now() + 1000);
    assert.equal(first.by, OS_USER);
    assert.equal(first.reason, 'weekly cap reached');
    assert.equal(first.via, 'set-provider');
    assert.equal(first.caller?.herdrPane, 'w9:p2', 'the existing caller identity rides along');
    // The command's own answer names the record too.
    assert.deepEqual(JSON.parse(off.stdout).toggle, first);

    const on = run(home, ['strategy', 'set-provider', 'echo', 'on', '--yes']);
    assert.equal(on.status, 0, on.stderr);
    state = readState(home);
    const second = state.strategy.poolToggles.echo.latest;
    assert.equal(second.enabled, true);
    assert.equal(second.reason, null, 'no --reason records null');
    assert.equal(second.via, 'set-provider');
    assert.deepEqual(state.strategy.poolToggles.echo.history, [first, second]);
    // The cached report and other strategy keys survive the write.
    assert.ok(state.strategy.lastReport);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('set-provider --reason with no text is a usage error and writes nothing', () => {
  const home = echoHome();
  try {
    const before = readFileSync(join(home, 'state.json'), 'utf8');
    const result = run(home, ['strategy', 'set-provider', 'echo', 'off', '--yes', '--reason', '   ']);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the history keeps the last 20 toggles per pool, newest last', async () => {
  const { setPoolEnabled, POOL_TOGGLE_HISTORY } = await import('../src/lib/pool-toggle.js');
  assert.equal(POOL_TOGGLE_HISTORY, 20);
  const state = { pools: {} };
  for (let i = 0; i < 25; i += 1) {
    setPoolEnabled(state, 'echo', i % 2 === 0, {
      via: 'set-provider', reason: `r${i}`, now: Date.UTC(2026, 10, 11, 3, i), by: 'alice',
    });
  }
  const record = state.strategy.poolToggles.echo;
  assert.equal(record.history.length, 20);
  assert.equal(record.history[0].reason, 'r5');
  assert.equal(record.history.at(-1).reason, 'r24');
  assert.deepEqual(record.latest, record.history.at(-1));
  assert.deepEqual(record.latest, {
    enabled: true, at: '2026-11-11T03:24:00.000Z', by: 'alice', reason: 'r24', via: 'set-provider',
    caller: record.latest.caller,
  });
  assert.equal(state.pools.echo.enabled, true);
  // Another pool keeps its own history.
  setPoolEnabled(state, 'other', false, { via: 'tui', now: Date.UTC(2026, 10, 11), by: 'bob' });
  assert.equal(state.strategy.poolToggles.other.history.length, 1);
  assert.equal(state.strategy.poolToggles.other.latest.reason, null);
  assert.equal(state.strategy.poolToggles.echo.history.length, 20);
});

test('a write that changes nothing is not recorded when only changes count (configure, setup)', async () => {
  const { setPoolEnabled } = await import('../src/lib/pool-toggle.js');
  const state = { pools: { a: { enabled: true }, fixture: {} } };
  setPoolEnabled(state, 'a', true, { via: 'configure', onlyIfChanged: true });
  setPoolEnabled(state, 'b', true, { via: 'auto-setup', onlyIfChanged: true });
  // A test fixture is off by default, so writing false over nothing is no change.
  setPoolEnabled(state, 'fixture', false, { via: 'auto-setup', onlyIfChanged: true, defaultEnabled: false });
  assert.equal(state.strategy?.poolToggles, undefined);
  setPoolEnabled(state, 'c', false, { via: 'auto-setup', reason: 'first-use: not detected on this machine', onlyIfChanged: true });
  assert.equal(state.pools.c.enabled, false);
  assert.equal(state.strategy.poolToggles.c.latest.via, 'auto-setup');
  assert.equal(state.strategy.poolToggles.c.latest.reason, 'first-use: not detected on this machine');
});

test('by is the OS user name; no environment value is recorded', async () => {
  const { setPoolEnabled } = await import('../src/lib/pool-toggle.js');
  const state = { pools: {} };
  setPoolEnabled(state, 'echo', false, { via: 'tui' });
  const record = state.strategy.poolToggles.echo.latest;
  assert.equal(record.by, OS_USER);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'by', 'caller', 'enabled', 'reason', 'via']);
  assert.deepEqual(Object.keys(record.caller).sort(), ['claudeSession', 'herdrPane']);
});

test('pools shows who disabled a pool, when and why; pools --json carries the latest record as toggle', () => {
  const home = echoHome();
  try {
    assert.equal(run(home, ['strategy', 'set-provider', 'echo', 'off', '--yes', '--reason', 'weekly cap reached']).status, 0);
    const latest = readState(home).strategy.poolToggles.echo.latest;
    const when = new Date(latest.at);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const stamp = `${when.getUTCDate()} ${months[when.getUTCMonth()]} ${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}Z`;

    const text = run(home, ['pools']);
    assert.equal(text.status, 0, text.stderr);
    const line = text.stdout.split('\n').find((row) => row.startsWith('echo '));
    assert.ok(line, text.stdout);
    assert.ok(line.endsWith(` disabled since ${stamp} by ${OS_USER}: weekly cap reached`), line);

    const json = run(home, ['pools', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const echo = JSON.parse(json.stdout).pools.find((pool) => pool.name === 'echo');
    assert.deepEqual(echo.toggle, latest);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a disabled pool with no record shows plain disabled, and toggle is null', () => {
  const home = echoHome({ echo: { enabled: false } });
  try {
    const text = run(home, ['pools']);
    assert.equal(text.status, 0, text.stderr);
    const line = text.stdout.split('\n').find((row) => row.startsWith('echo '));
    assert.ok(line.endsWith(' disabled'), line);
    const echo = JSON.parse(run(home, ['pools', '--json']).stdout).pools.find((pool) => pool.name === 'echo');
    assert.equal(echo.toggle, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pool status text: disabled with a record says since, by and the reason, or that none was recorded', async () => {
  const { poolStatusText } = await import('../src/cli.js');
  const toggle = { enabled: false, at: '2026-11-11T03:00:00.000Z', by: 'alice', reason: null, via: 'set-provider' };
  assert.equal(poolStatusText({ name: 'personal', enabled: false, toggle }), 'disabled since 11 Nov 03:00Z by alice: no reason recorded');
  assert.equal(
    poolStatusText({ name: 'personal', enabled: false, toggle: { ...toggle, reason: 'over budget' } }),
    'disabled since 11 Nov 03:00Z by alice: over budget',
  );
  // An enabled pool says nothing new; a stale "enabled" record on a disabled pool says nothing either.
  assert.equal(poolStatusText({ name: 'personal', enabled: true, toggle: { ...toggle, enabled: true } }), 'ready');
  assert.equal(poolStatusText({ name: 'personal', enabled: false, toggle: { ...toggle, enabled: true } }), 'disabled');
});

test('strategy inventory --json carries the latest toggle on each provider', () => {
  const home = echoHome();
  try {
    assert.equal(run(home, ['strategy', 'set-provider', 'echo', 'on', '--yes', '--reason', 'back on']).status, 0);
    const result = run(home, ['strategy', 'inventory', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const echo = JSON.parse(result.stdout).providers.find((provider) => provider.name === 'echo');
    assert.ok(echo, result.stdout);
    assert.equal(echo.toggle.reason, 'back on');
    assert.equal(echo.toggle.via, 'set-provider');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the strategy TUI toggle records via tui', async () => {
  const home = echoHome();
  try {
    const { persistProvider } = await import('../src/strategy-dashboard.js');
    persistProvider(home, 'echo', false);
    const latest = readState(home).strategy.poolToggles.echo.latest;
    assert.equal(latest.enabled, false);
    assert.equal(latest.via, 'tui');
    assert.equal(latest.reason, null);
    assert.equal(latest.by, OS_USER);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('strategy configure records via configure for the pools it changes', () => {
  const home = echoHome();
  try {
    const document = join(home, 'strategy.json');
    writeFileSync(document, JSON.stringify({ providers: { echo: false } }));
    const result = run(home, ['strategy', 'configure', '--file', document, '--yes']);
    assert.equal(result.status, 0, result.stderr);
    const latest = readState(home).strategy.poolToggles.echo.latest;
    assert.equal(latest.enabled, false);
    assert.equal(latest.via, 'configure');
    // The same document again changes nothing, so nothing new is recorded.
    assert.equal(run(home, ['strategy', 'configure', '--file', document, '--yes']).status, 0);
    assert.equal(readState(home).strategy.poolToggles.echo.history.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('set-provider help documents --reason and the record', async () => {
  const { helpText } = await import('../src/help.js');
  const text = helpText(['strategy', 'set-provider']);
  assert.match(text, /--reason/);
  assert.match(text, /bullswarm pools/);
  assert.match(text, /who|by/);
});
