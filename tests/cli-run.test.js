// `bullswarm run --dry-run` and `bullswarm pools` are documented as previews /
// observations. These tests hold them to that: neither may rewrite state.json
// (audit findings D3 and D1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function home({ echoPool = { enabled: true }, config = {}, strategy = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-cli-run-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  for (const file of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(join(dir, 'connectors', file), readFileSync(join(REPO, 'connectors', file)));
  }
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { echo: echoPool },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', ...config },
    ...(strategy ? { strategy } : {}),
  }, null, 2)}\n`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function bullswarm(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: dir }, encoding: 'utf8', timeout: 60_000,
  });
}

const stateBytes = (dir) => readFileSync(join(dir, 'state.json'));

test('run --dry-run leaves state.json byte-identical even with a stale auto-apply policy (D3)', () => {
  // The exact shape the audit reproduced: an approved auto-apply policy whose
  // TTL has expired. Before the fix, maybeRefreshStrategy ran 51 lines before
  // the dry-run check, downloaded a datapack and wrote its recommendations.
  const f = home({
    config: { testFixturesMigrated: true },
    strategy: {
      policy: { autoApplyRecommendations: true, refreshHours: 24 },
      lastRefreshedAt: '2020-01-01T00:00:00.000Z',
    },
  });
  try {
    const before = stateBytes(f.dir);
    const result = bullswarm(f.dir, [
      'run', '--lane', 'build', '--dry-run', '--json', '--no-caller', '--prompt', 'hi',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.dryRun, true);
    assert.equal(verdict.pick.pool, 'echo', verdict.why);
    assert.ok(Array.isArray(verdict.pick.command), 'the preview still prints the real command');
    assert.deepEqual(stateBytes(f.dir), before, 'a preview writes nothing');
  } finally { f.cleanup(); }
});

test('pools leaves an explicitly enabled test fixture enabled (D1)', () => {
  // No testFixturesMigrated flag: the migration runs, and must not overrule
  // the operator's explicit `enabled: true`.
  const f = home({ echoPool: { enabled: true } });
  try {
    const result = bullswarm(f.dir, ['pools', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const pools = JSON.parse(result.stdout).pools;
    assert.deepEqual(pools.map((p) => p.name), ['echo']);
    assert.equal(pools[0].enabled, true, 'one `pools` must not turn the pool off');
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.enabled, true);
    assert.equal(state.config.testFixturesMigrated, true, 'the migration still ran once');
  } finally { f.cleanup(); }
});

test('pools does not rewrite state.json when its quarantine sweep released nothing', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    bullswarm(f.dir, ['pools', '--json']); // settle any first-use writes
    const before = stateBytes(f.dir);
    const result = bullswarm(f.dir, ['pools', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stateBytes(f.dir), before, 'an observation command with nothing to change writes nothing');
  } finally { f.cleanup(); }
});

test('pools still persists a quarantine release when the sweep makes one', () => {
  const f = home({
    echoPool: { enabled: true, quarantine: { until: 1000, reason: 'old auth failure', kind: 'auth' } },
    config: { testFixturesMigrated: true },
  });
  try {
    const result = bullswarm(f.dir, ['pools']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /quarantine expired, returned to service: echo/);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.quarantine, undefined, 'the release was persisted');
  } finally { f.cleanup(); }
});

// D7 through the CLI, which is where the audit recorded the wrong message.
// `pickPool` learned to name the stage that emptied the candidate list, but
// `run` pre-filtered ineligible pools away before `pickPool` could see them,
// so the fix was invisible from the command line. The unit tests in
// tests/route.test.js cover the reason; this covers the wiring.
test('run names the tier allow-list, not capabilities, when it emptied the candidates (D7)', () => {
  const f = home({
    config: { testFixturesMigrated: true },
    // `echo-local` is allowed for the low tier only, so an --effort medium
    // route has no model it may run on any pool.
    strategy: { configuredTiers: ['medium', 'low'], modelTiers: { echo: { 'echo-local': ['low'] } } },
  });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'build', '--effort', 'medium',
      '--dry-run', '--json', '--no-caller', '--prompt', 'hi',
    ]);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.why, 'no pool has a model allowed for the medium tier');
    assert.doesNotMatch(verdict.why, /capabilit/, 'the connector declares every capability the lane asked for');
  } finally { f.cleanup(); }
});

// The same route with the allow-list satisfied still picks the pool, so the
// removed pre-filter did not widen what `run` is willing to dispatch to.
test('run still routes when the tier allow-list names a model the pool can run', () => {
  const f = home({
    config: { testFixturesMigrated: true },
    strategy: { configuredTiers: ['medium'], modelTiers: { echo: { 'echo-local': ['medium'] } } },
  });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'build', '--effort', 'medium',
      '--dry-run', '--json', '--no-caller', '--prompt', 'hi',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.pick.pool, 'echo');
    assert.equal(verdict.pick.model, 'echo-local');
  } finally { f.cleanup(); }
});
