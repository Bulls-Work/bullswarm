// Two flag checks in `bullswarm run`: --timeout must stay inside what a
// timer can hold (a larger value used to kill the worker after 1 ms), and an
// --avoid-pool / --avoid-provider name that matches nothing is warned about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStepRequest } from '../src/lib/run-step.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');
const TIMEOUT_ERROR = '--timeout must be a number of seconds from 1 to 604800';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-flag-guards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, 'connectors', 'echo.json'), readFileSync(join(REPO, 'src', 'providers', 'echo', 'connector.json')));
  writeFileSync(join(home, 'connectors', 'echo-worker.mjs'), readFileSync(join(REPO, 'src', 'providers', 'echo', 'echo-worker.mjs')));
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', repo]);
  return { home, repo };
}

function dryRun(f, args) {
  const env = { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, 'run', '--lane', 'analyze', '--dry-run', '--json', '--add-dir', f.repo, '--prompt', 'hi', ...args], {
    cwd: f.repo, env, encoding: 'utf8', timeout: 60_000,
  });
}

const request = (timeout) => runStepRequest({ lane: 'analyze', prompt: 'hi', rest: [], timeout }, { cwd: '/tmp' });

test('--timeout refuses values a timer cannot hold or that are not plain seconds', () => {
  for (const bad of ['3000000', '0x10', '1e3', '0.0001', '-5', '+5', '604801', '0', '', ' ', 'abc', 'Infinity']) {
    assert.equal(request(bad).error, TIMEOUT_ERROR, `--timeout ${JSON.stringify(bad)}`);
  }
});

test('--timeout accepts plain decimal seconds from 1 to 604800', () => {
  for (const good of ['1', '604800', '90.5', '1.0']) {
    const parsed = request(good);
    assert.equal(parsed.error, undefined, `--timeout ${good}`);
    assert.equal(parsed.request.timeoutSec, Number(good));
  }
});

test('run --timeout 3000000 exits 2 from the CLI', (t) => {
  const f = fixture(t);
  const result = dryRun(f, ['--timeout', '3000000']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, new RegExp(TIMEOUT_ERROR));
  assert.equal(dryRun(f, ['--timeout', '604800']).status, 0);
});

test('--avoid-pool and --avoid-provider warn once per unknown name and keep running', (t) => {
  const f = fixture(t);
  const result = dryRun(f, ['--avoid-pool', 'nosuch,nosuch', '--avoid-provider', 'nowhere']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true, 'stdout stays the JSON verdict');
  const lines = result.stderr.split('\n').filter((line) => line.startsWith('warning:'));
  assert.deepEqual(lines, [
    'warning: --avoid-pool nosuch matches no pool (bullswarm pools lists them)',
    'warning: --avoid-provider nowhere matches no provider (bullswarm pools lists them)',
  ]);
});

test('a real pool or provider name prints no warning', (t) => {
  const f = fixture(t);
  const result = dryRun(f, ['--avoid-pool', 'echo']);
  assert.doesNotMatch(result.stderr, /warning:/);
  const provider = dryRun(f, ['--avoid-provider', 'echo']);
  assert.doesNotMatch(provider.stderr, /warning:/);
});

test('--heartbeat above 604800 seconds is refused like --timeout', () => {
  const ask = (heartbeat) => runStepRequest({ lane: 'analyze', prompt: 'hi', rest: [], heartbeat }, { cwd: '/tmp' });
  assert.match(ask('3000000').error ?? '', /--heartbeat must be a number of seconds from 1 to 604800/);
  assert.equal(ask('60').error, undefined);
});

test('no worker timer is handed a delay a 32-bit timer cannot hold', async () => {
  const { timerMs } = await import('../src/lib/run-delegate.js');
  assert.equal(timerMs(3_000_000), 604_800_000);
  assert.equal(timerMs(90), 90_000);
  assert.equal(timerMs(0), null);
  assert.equal(timerMs('abc'), null);
  const { createRunHeartbeat } = await import('../src/lib/run-heartbeat.js');
  const delays = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { delays.push(ms); return real(() => {}, 1e9); };
  try {
    const beat = createRunHeartbeat({ intervalSec: 3_000_000, write: () => {} });
    beat.start();
    beat.stop?.();
  } finally { globalThis.setInterval = real; }
  assert.ok(delays.length === 1 && delays[0] <= 2_147_483_647, `heartbeat delay ${delays[0]}`);
});
