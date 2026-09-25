// Route filters on `bullswarm run` (--avoid-pool, --use-provider,
// --avoid-provider, --independent-of): the workflow step route as flags, as
// hard filters before pace. Unit tests for src/lib/run-route.js, then the
// real bin/bullswarm.js against a temp home with three fixture pools on two
// providers: `alpha` and `alpha:two` (provider alpha) and `beta`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import {
  applyRunRoute, findRunEntry, parseRunRoute, resolveRunRoute, routeFilterLine,
} from '../src/lib/run-route.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const POOLS = ['alpha', 'alpha:two', 'beta'];
const WRITER = {
  ts: '2026-09-20T00:00:00.000Z', kind: 'run', source: 'run', id: 'writer-run-1', lane: 'build',
  pool: 'alpha:two', picked: 'alpha:two', ok: true, outFile: '/nowhere/runs/out-writer.md',
};

const pool = (name, extra = {}) => ({ name, connector: { name }, enabled: true, ...extra });
const resolved = (opts, context = {}) => {
  const parsed = parseRunRoute(opts);
  assert.equal(parsed.error, undefined, parsed.error);
  return resolveRunRoute(parsed.route, { pools: POOLS.map((name) => pool(name)), decisionLog: [WRITER], ...context });
};

// --- src/lib/run-route.js --------------------------------------------------

test('parseArgs keeps every value of a repeated route flag', () => {
  const opts = parseArgs(['--avoid-pool', 'alpha', '--avoid-pool=beta', '--independent-of', 'a', '--lane', 'build']);
  assert.deepEqual(opts['avoid-pool'], ['alpha', 'beta']);
  assert.deepEqual(opts['independent-of'], ['a']);
  assert.equal(opts.lane, 'build', 'other flags keep their single value');
});

test('parseRunRoute: comma lists, repeats, and the usage errors', () => {
  assert.deepEqual(parseRunRoute({}), { route: null });
  const { route } = parseRunRoute({ 'avoid-pool': ['beta,alpha', 'beta'], 'use-provider': 'alpha', 'independent-of': ['x', 'x'] });
  assert.deepEqual(route, { avoidPools: ['alpha', 'beta'], useProviders: ['alpha'], avoidProviders: [], refs: ['x'] });
  assert.match(parseRunRoute({ 'avoid-pool': [true] }).error, /--avoid-pool requires a value/);
  assert.match(parseRunRoute({ 'independent-of': [true] }).error, /--independent-of requires a value/);
  assert.match(parseRunRoute({ 'avoid-provider': ['a,,b'] }).error, /empty name/);
  assert.match(parseRunRoute({ 'use-provider': ['beta'], 'avoid-provider': ['beta'] }).error,
    /--use-provider and --avoid-provider both name "beta"/);
});

test('resolveRunRoute refuses names no configured pool has, and resolves labels to ids', () => {
  assert.match(resolved({ 'avoid-pool': 'gamma' }).error,
    /--avoid-pool names "gamma", which is not a configured pool \(configured: alpha, alpha:two, beta\)/);
  assert.match(resolved({ 'use-provider': 'gamma' }).error,
    /--use-provider names "gamma", which no configured pool uses \(providers: alpha, beta\)/);
  const home = mkdtempSync(join(tmpdir(), 'bs-run-route-labels-'));
  try {
    writeFileSync(join(home, 'pool-labels.json'), JSON.stringify({ version: 1, labels: { 'alpha:two': 'a2' } }));
    assert.deepEqual(resolved({ 'avoid-pool': 'a2' }, { home }).filter.avoidPools, ['alpha:two']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a run ref is an id or an outFile path; the latest matching run wins', () => {
  const later = { ...WRITER, ts: '2026-09-21T00:00:00.000Z', pool: 'beta' };
  const workflowEntry = { ...WRITER, kind: undefined, source: 'workflow', id: 'wf-1' };
  assert.equal(findRunEntry([WRITER], 'writer-run-1'), WRITER);
  assert.equal(findRunEntry([WRITER], '/nowhere/runs/out-writer.md'), WRITER);
  assert.equal(findRunEntry([WRITER], 'out-writer.md', { cwd: '/nowhere/runs' }), WRITER, 'a relative path resolves against cwd');
  assert.equal(findRunEntry([WRITER, later], 'writer-run-1'), later);
  assert.equal(findRunEntry([workflowEntry], 'wf-1'), null, 'only bullswarm run entries are run refs');
  // The same outFile through a symlinked directory (macOS /tmp is /private/tmp).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bs-run-route-ref-')));
  try {
    mkdirSync(join(dir, 'runs'));
    writeFileSync(join(dir, 'runs', 'out-x.md'), 'x');
    symlinkSync(join(dir, 'runs'), join(dir, 'link'));
    const entry = { ...WRITER, outFile: join(dir, 'runs', 'out-x.md') };
    assert.equal(findRunEntry([entry], join(dir, 'link', 'out-x.md')), entry);
    assert.equal(findRunEntry([entry], join(dir, 'link', 'out-y.md')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(resolved({ 'independent-of': 'nope' }).error,
    /--independent-of "nope" matches no finished run in this home's decision log/);
});

test('each filter takes out its pools, and says why', () => {
  const pools = POOLS.map((name) => pool(name));
  const out = (opts) => applyRunRoute(resolved(opts).filter, pools).report.filteredOut;
  assert.deepEqual(out({ 'avoid-pool': 'beta' }), [{ pool: 'beta', provider: 'beta', why: 'in --avoid-pool' }]);
  assert.deepEqual(out({ 'use-provider': 'beta' }).map((row) => [row.pool, row.why]), [
    ['alpha', 'provider alpha is not in --use-provider beta'],
    ['alpha:two', 'provider alpha is not in --use-provider beta'],
  ]);
  assert.deepEqual(out({ 'avoid-provider': 'alpha' }).map((row) => row.pool), ['alpha', 'alpha:two']);
  // alpha:two wrote the run; its sibling account alpha shares the provider.
  assert.deepEqual(out({ 'independent-of': 'writer-run-1' }).map((row) => [row.pool, row.why]), [
    ['alpha', 'provider alpha ran --independent-of writer-run-1'],
    ['alpha:two', 'provider alpha ran --independent-of writer-run-1'],
  ]);
  const { filter } = resolved({ 'independent-of': '/nowhere/runs/out-writer.md' });
  assert.equal(filter.summary, 'independent of writer-run-1 (providers alpha)');
  assert.deepEqual(filter.runs, [{ ref: '/nowhere/runs/out-writer.md', id: 'writer-run-1', pool: 'alpha:two', provider: 'alpha', outFile: WRITER.outFile }]);
});

test('no filter passes the pool list through untouched', () => {
  const pools = POOLS.map((name) => pool(name));
  const routed = applyRunRoute(null, pools, { callerName: 'claude-code' });
  assert.equal(routed.pools, pools);
  assert.equal(routed.callerEligible, true);
  assert.equal(routed.report, null);
});

test('filters that take out every enabled pool are empty, and the why names each pool', () => {
  const pools = [...POOLS.map((name) => pool(name)), pool('beta:off', { enabled: false })];
  const routed = applyRunRoute(resolved({ 'avoid-provider': 'alpha', 'avoid-pool': 'beta' }).filter, pools);
  assert.equal(routed.empty, true);
  assert.equal(routed.why, 'no pool left after route filters (avoid beta · avoid providers alpha): '
    + 'alpha (provider alpha is in --avoid-provider), alpha:two (provider alpha is in --avoid-provider), beta (in --avoid-pool)'
    + '; passes the filters but disabled: beta:off');
  assert.equal(routeFilterLine(routed.report), null, 'the why already lists them; no second line');
  const noneOff = applyRunRoute(resolved({ 'avoid-provider': 'alpha', 'avoid-pool': 'beta' }).filter, POOLS.map((name) => pool(name)));
  assert.doesNotMatch(noneOff.why, /disabled/, 'no switched-off pool, no tail');
});

test('the caller is held to the same filters', () => {
  const pools = POOLS.map((name) => pool(name));
  const excluded = applyRunRoute(resolved({ 'avoid-provider': 'claude-code' }, {
    pools: [...pools, pool('claude-code')],
  }).filter, pools, { callerName: 'claude-code' });
  assert.equal(excluded.callerEligible, false);
  assert.deepEqual(excluded.report.callerFilteredOut, {
    name: 'claude-code', provider: 'claude-code', why: 'provider claude-code is in --avoid-provider',
  });
  assert.equal(routeFilterLine(excluded.report), 'filtered out: the caller claude-code (provider claude-code is in --avoid-provider)');
  const kept = applyRunRoute(resolved({ 'avoid-pool': 'beta' }).filter, pools, { callerName: 'claude-code' });
  assert.equal(kept.callerEligible, true);
  const noCaller = applyRunRoute(resolved({ 'use-provider': 'beta' }).filter, pools, { callerName: 'claude-code', callerEligible: false });
  assert.equal(noCaller.report.callerFilteredOut, undefined, '--no-caller already took the caller out');
});

// --- the real CLI ----------------------------------------------------------

function fixtureHome({ decisionLog = [WRITER], lanes = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-run-route-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const name of POOLS) {
    writeFileSync(join(home, 'connectors', `${name.replace(':', '-')}.json`), JSON.stringify({
      name,
      bin: 'node',
      spawn: { cmd: ['node', '{bullswarmDir}/src/providers/echo/echo-worker.mjs', '{taskFile}'], cwdMode: 'task-file-dir' },
      outputExtraction: { strategy: 'stdout' },
      meter: { type: 'none' },
      costRank: 3,
      lanes: lanes[name] ?? ['analyze', 'build', 'chore'],
      capabilities: ['code-reading'],
      model: `${name.replace(':', '-')}-local`,
      flags: { testFixture: true },
    }, null, 2));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: Object.fromEntries(POOLS.map((name) => [name, { enabled: true }])),
    incumbents: {},
    decisionLog,
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return home;
}

function bullswarm(home, args) {
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
}

const preview = (home, flags) => bullswarm(home, ['run', '--lane', 'build', '--dry-run', '--json', ...flags, '--prompt', 'hi']);
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));

function withHome(options, body) {
  const home = fixtureHome(options);
  try { return body(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('run --dry-run: each filter takes its pools out of the pick and lists them with why', () => withHome({}, (home) => {
  const cases = [
    { flags: ['--avoid-pool', 'alpha', '--avoid-pool', 'alpha:two'], picks: ['beta'], out: ['alpha', 'alpha:two'] },
    { flags: ['--use-provider', 'beta'], picks: ['beta'], out: ['alpha', 'alpha:two'] },
    { flags: ['--avoid-provider', 'beta'], picks: ['alpha', 'alpha:two'], out: ['beta'] },
  ];
  for (const { flags, picks, out } of cases) {
    const result = preview(home, flags);
    assert.equal(result.status, 0, `${flags.join(' ')}: ${result.stderr}${result.stdout}`);
    const verdict = JSON.parse(result.stdout);
    assert.ok(picks.includes(verdict.pick.pool), `${flags.join(' ')} picked ${verdict.pick.pool}`);
    assert.deepEqual(verdict.routeFilter.filteredOut.map((row) => row.pool).sort(), out, flags.join(' '));
    assert.ok(verdict.routeFilter.filteredOut.every((row) => row.why), 'every filtered-out pool says why');
    assert.ok(verdict.routeCandidates.every((row) => !out.includes(row.pool)), 'a filtered pool is not a candidate');
    assert.match(verdict.why, / · route: /, 'the route is named on the reason');
  }
}));

test('run --independent-of keeps the checker off the writer\'s provider, by outFile or by id', () => withHome({}, (home) => {
  for (const ref of [WRITER.outFile, WRITER.id]) {
    const result = preview(home, ['--independent-of', ref]);
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.pick.pool, 'beta', 'the writer ran on alpha:two, so every alpha pool is out');
    assert.equal(verdict.routeFilter.summary, 'independent of writer-run-1 (providers alpha)');
    assert.deepEqual(verdict.routeFilter.independentOf.map((run) => [run.id, run.pool, run.provider]), [['writer-run-1', 'alpha:two', 'alpha']]);
  }
}));

test('run --dry-run prints the filtered-out pools as text too', () => withHome({}, (home) => {
  const result = bullswarm(home, ['run', '--lane', 'build', '--dry-run', '--no-caller', '--independent-of', WRITER.id, '--prompt', 'hi']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^OK \[beta\] .* · route: independent of writer-run-1 \(providers alpha\)$/m);
  assert.match(result.stdout, /^filtered out: alpha \(provider alpha ran --independent-of writer-run-1\), alpha:two \(provider alpha ran --independent-of writer-run-1\)$/m);
}));

test('an unknown run ref, pool or provider exits 2 before anything is written', () => withHome({}, (home) => {
  const before = readFileSync(join(home, 'state.json'));
  const cases = [
    [['--independent-of', '/nowhere/runs/out-other.md'], /--independent-of "\/nowhere\/runs\/out-other.md" matches no finished run in this home's decision log; pass the outFile path or id of an earlier bullswarm run/],
    [['--avoid-pool', 'gamma'], /--avoid-pool names "gamma", which is not a configured pool/],
    [['--use-provider', 'gamma'], /--use-provider names "gamma", which no configured pool uses \(providers: alpha, beta\)/],
    [['--avoid-provider'], /--avoid-provider requires a value/],
  ];
  for (const [flags, message] of cases) {
    const result = bullswarm(home, ['run', '--lane', 'build', ...flags, '--prompt', 'hi']);
    assert.equal(result.status, 2, `${flags.join(' ')}: ${result.stdout}`);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '', 'no verdict, no dispatch');
  }
  assert.deepEqual(readFileSync(join(home, 'state.json')), before);
}));

test('filters that leave no pool exit 1 with the reason, and never keep the task on the caller', () => withHome({}, (home) => {
  const before = readFileSync(join(home, 'state.json'));
  for (const extra of [['--dry-run'], []]) {
    // No --no-caller: the caller passes these filters, and still gets nothing.
    const result = bullswarm(home, ['run', '--lane', 'build', '--json', ...extra,
      '--avoid-provider', 'alpha', '--independent-of', WRITER.id, '--avoid-pool', 'beta', '--prompt', 'hi']);
    assert.equal(result.status, 1, `${extra.join(' ') || 'real run'}: ${result.stderr}`);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.keepOnClaude, false);
    assert.equal(verdict.why, 'no pool left after route filters (avoid beta · avoid providers alpha · independent of writer-run-1 (providers alpha)): '
      + 'alpha (provider alpha is in --avoid-provider; provider alpha ran --independent-of writer-run-1), '
      + 'alpha:two (provider alpha is in --avoid-provider; provider alpha ran --independent-of writer-run-1), '
      + 'beta (in --avoid-pool)');
    assert.equal(verdict.routeFilter.empty, true);
    assert.deepEqual(verdict.routeFilter.left, []);
  }
  assert.deepEqual(readFileSync(join(home, 'state.json')), before, 'nothing dispatched, nothing logged');
}));

test('a caller the filters exclude never takes the lane when the pools left cannot run it', () => withHome({ lanes: { beta: ['chore'] } }, (home) => {
  // beta is left by --use-provider beta but has no build lane. Without a
  // filter the caller would take the lane; claude-code is not provider beta.
  const unfiltered = preview(home, []);
  assert.equal(unfiltered.status, 0, unfiltered.stderr);
  const result = preview(home, ['--use-provider', 'beta']);
  assert.equal(result.status, 1, result.stdout);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.keepOnClaude, false);
  assert.match(verdict.why, /^no eligible pool · route: providers beta$/);
  assert.equal(verdict.routeFilter.callerFilteredOut.why, 'provider claude-code is not in --use-provider beta');
}));

test('a writer run, then a checker --independent-of its outFile, lands on another provider', () => withHome({ decisionLog: [] }, (home) => {
  const writer = bullswarm(home, ['run', '--lane', 'build', '--no-caller', '--json', '--use-provider', 'alpha', '--prompt', 'write it']);
  assert.equal(writer.status, 0, writer.stderr);
  const written = JSON.parse(writer.stdout);
  assert.match(written.meta.pool, /^alpha/);
  const checker = bullswarm(home, ['run', '--lane', 'build', '--no-caller', '--json', '--independent-of', written.outFile, '--prompt', 'check it']);
  assert.equal(checker.status, 0, checker.stderr);
  const checked = JSON.parse(checker.stdout);
  assert.equal(checked.meta.pool, 'beta');
  assert.deepEqual(checked.routeFilter.filteredOut.map((row) => row.pool), ['alpha', 'alpha:two']);
  const log = stateOf(home).decisionLog.filter((entry) => entry.kind === 'run');
  assert.equal(log.length, 2);
  assert.equal(log[1].pool, 'beta');
  assert.match(log[1].routeWhy, / · route: independent of [0-9a-f-]{36} \(providers alpha\)$/, 'the decision log records the route');
}));
