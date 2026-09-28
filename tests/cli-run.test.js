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
      'run', '--lane', 'build', '--dry-run', '--json', '--prompt', 'hi',
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

test('pools does not rewrite state.json: it only observes', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    bullswarm(f.dir, ['pools', '--json']); // settle any first-use writes
    const before = stateBytes(f.dir);
    const result = bullswarm(f.dir, ['pools', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stateBytes(f.dir), before, 'an observation command with nothing to change writes nothing');
  } finally { f.cleanup(); }
});

test('pools reads nothing into an old quarantine record: no sweep, no message, no write', () => {
  const quarantine = { until: Date.now() + 60 * 60_000, reason: 'old auth failure', kind: 'auth' };
  const f = home({
    echoPool: { enabled: true, quarantine },
    config: { testFixturesMigrated: true },
  });
  try {
    bullswarm(f.dir, ['pools', '--json']); // settle any first-use writes
    const before = stateBytes(f.dir);
    const result = bullswarm(f.dir, ['pools']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /quarantin|PAUSED|returned to service/);
    assert.match(result.stdout, /^echo\s.*\sready\b/m);
    assert.deepEqual(stateBytes(f.dir), before, 'nothing is swept or rewritten');
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
      '--dry-run', '--json', '--prompt', 'hi',
    ]);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.ok, false);
    // The kernel's pick (0.37.0): its preparation drops the pool, and says why.
    assert.equal(verdict.why, 'no eligible pool: no enabled pool has a model on the medium tier for build work');
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
      '--dry-run', '--json', '--prompt', 'hi',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.pick.pool, 'echo');
    assert.equal(verdict.pick.model, 'echo-local');
  } finally { f.cleanup(); }
});

// A run is a one-step workflow (0.37.0): it is recorded under workflows/<id>/
// with its rollup and project, and its one decision-log entry is the
// workflow attempt's; there is no separate task entry.
test('run records the run under workflows/<id>/ and the attempt in the decision log', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'analyze', '--json', '--add-dir', REPO, '--prompt', 'ledger shape',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    const runDir = join(f.dir, 'workflows', verdict.runId);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.equal(state.decisionLog.length, 1);
    const entry = state.decisionLog[0];
    assert.equal(entry.source, 'workflow-v2');
    assert.equal(entry.actionId, 'task');
    assert.equal(entry.lane, 'analyze');
    assert.equal(entry.picked, 'echo');
    assert.equal(entry.model, 'echo-local');
    assert.equal(entry.ok, true);
    assert.equal(entry.outFile, verdict.outFile);
    assert.ok(verdict.outFile.startsWith(runDir));
    assert.match(verdict.taskFile, /\/task-task-attempt-1\.md$/);
    const rollup = JSON.parse(readFileSync(join(runDir, 'rollup.json'), 'utf8'));
    assert.equal(rollup.runId, verdict.runId);
    assert.equal(JSON.parse(readFileSync(join(runDir, 'project.json'), 'utf8')).name, 'bullswarm');
    const runState = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const [attempt] = runState.attempts;
    assert.equal(attempt.pool, 'echo');
    assert.ok(attempt.finishedAt >= attempt.startedAt);
  } finally { f.cleanup(); }
});

test('run records a failure with its kind and reason', () => {
  const f = home({ config: { testFixturesMigrated: true } });
  try {
    const result = bullswarm(f.dir, [
      'run', '--lane', 'analyze', '--json', '--prompt', 'FAIL:auth',
    ]);
    assert.equal(result.status, 1);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failureKind, 'auth', verdict.why);
    assert.match(verdict.why, /auth/i);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.source, 'workflow-v2');
    assert.equal(entry.ok, false);
    assert.equal(entry.failureKind, 'auth');
  } finally { f.cleanup(); }
});

// --- free models in `bullswarm pools` ---------------------------------------
// Requirement 5: the observation command has to say when a pool is free, or
// an operator cannot tell a free-first pick from an ordinary one. No pool is
// benched or paused any more (state.js S1).

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

test('pools shows no bench or strikes for an old bench record, and --json carries none', () => {
  const f = home();
  try {
    const bench = { until: Date.now() + 9 * 60_000, reason: 'stall', count: 2 };
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    state.pools.echo.bench = bench;
    writeFileSync(join(f.dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const r = bullswarm(f.dir, ['pools']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /BENCHED|strikes|bench/);
    assert.match(r.stdout, /^echo\s.*\sready\b/m);
    const j = bullswarm(f.dir, ['pools', '--json']);
    const echo = JSON.parse(j.stdout).pools.find((p) => p.name === 'echo');
    assert.equal(Object.hasOwn(echo, 'bench'), false);
    assert.equal(Object.hasOwn(echo, 'quarantine'), false);
    assert.equal(echo.free, true);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).pools.echo.bench, bench, 'the old record is left alone');
  } finally { f.cleanup(); }
});
