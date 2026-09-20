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
    writeFileSync(join(dir, 'connectors', file), readFileSync(join(REPO, 'src', 'providers', 'echo', file === 'echo.json' ? 'connector.json' : file)));
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
    env: { ...process.env, BULLSWARM_HOME: dir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' }, encoding: 'utf8', timeout: 60_000,
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

test('run records a task ledger entry with project and lifecycle fields', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'build', '--json', '--no-caller', '--add-dir', REPO, '--prompt', 'ledger shape',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.kind, 'run');
    assert.equal(entry.source, 'run');
    assert.equal(entry.lane, 'build');
    assert.equal(entry.pool, 'echo');
    assert.equal(entry.model, 'echo-local');
    assert.equal(entry.project, 'bullswarm');
    assert.equal(entry.cwd, REPO);
    assert.equal(entry.ok, true);
    assert.equal(entry.reason, null);
    assert.match(entry.taskFile, /\/runs\/task-/);
    assert.match(entry.outFile, /\/runs\/out-/);
    assert.match(entry.streamFile, /\/runs\/stream-/);
    assert.equal(
      entry.streamFile.replace(/stream-/, 'task-').replace(/\.jsonl$/, '.md'),
      entry.taskFile,
      'stream file uses the same id suffix as the task file',
    );
    assert.match(entry.startedAt, /^2026-|^20\d\d-/);
    assert.match(entry.endedAt, /^2026-|^20\d\d-/);
    assert.ok(entry.endedAt >= entry.startedAt);
    assert.equal(typeof entry.durationMs, 'number');
    assert.match(entry.id, /^[0-9a-f-]{20,}$/);
  } finally { f.cleanup(); }
});

test('run records a short failure reason in the task ledger', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'build', '--json', '--no-caller', '--prompt', 'FAIL:auth',
    ]);
    assert.equal(result.status, 1);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.kind, 'run');
    assert.equal(entry.ok, false);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length <= 160);
    assert.match(entry.reason, /auth/i);
  } finally { f.cleanup(); }
});

// --- free models and the soft bench in `bullswarm pools` --------------------
// Requirement 5: the observation command has to say when a pool is free and
// when it is benched, or an operator cannot tell a free-first pick or a paused
// pool from an ordinary one.

test('pools names the free model a pool would run', () => {
  const f = home();
  try {
    const r = bullswarm(f.dir, ['pools']);
    assert.equal(r.status, 0, r.stderr);
    // echo's only model profile declares `free: true`, and it is the model the
    // connector configures, so every effort tier resolves to it.
    assert.match(r.stdout, /^echo\s.*\sfree=echo-local\s/m);
  } finally { f.cleanup(); }
});

test('pools shows a benched pool with its deadline, reason and strike count', () => {
  const f = home();
  try {
    const until = Date.now() + 9 * 60_000;
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    state.pools.echo.bench = { until, reason: 'stall', count: 2 };
    writeFileSync(join(f.dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const r = bullswarm(f.dir, ['pools']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BENCHED until .* \(stall, 2 strikes\)/);
    // The bench travels into --json untouched, for a caller that parses it.
    const j = bullswarm(f.dir, ['pools', '--json']);
    const echo = JSON.parse(j.stdout).pools.find((p) => p.name === 'echo');
    assert.deepEqual(echo.bench, { until, reason: 'stall', count: 2 });
    assert.equal(echo.free, true);
  } finally { f.cleanup(); }
});

test('pools counts a first strike without calling the pool benched, and sweeps an expired bench', () => {
  const f = home();
  try {
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    state.pools.echo.bench = { until: null, reason: 'provider', count: 1 };
    writeFileSync(join(f.dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const first = bullswarm(f.dir, ['pools']);
    assert.match(first.stdout, /ready.*strikes=1\(provider\)/);
    assert.doesNotMatch(first.stdout, /BENCHED/);

    // An expired bench is released on the same terms as an expired quarantine,
    // and the strike count stays.
    const expired = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    expired.pools.echo.bench = { until: Date.now() - 1000, reason: 'stall', count: 2 };
    writeFileSync(join(f.dir, 'state.json'), `${JSON.stringify(expired, null, 2)}\n`);
    const second = bullswarm(f.dir, ['pools']);
    assert.match(second.stderr, /bench expired, returned to service: echo/);
    assert.doesNotMatch(second.stdout, /BENCHED/);
    assert.match(second.stdout, /strikes=2\(stall\)/);
    const swept = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.deepEqual(swept.pools.echo.bench, { until: null, reason: 'stall', count: 2 });
  } finally { f.cleanup(); }
});
