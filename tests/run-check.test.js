// `bullswarm run --check '<cmd>'`: a single-step run proven by a command.
// Each --check becomes one `{type:'command', cmd}` evidence item on the run's
// step, in the order given; `--check-timeout` sets timeoutSec on every item.
// Without --check the program, goal and verdict are exactly as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../src/cli.js';
import { runStepGoal, runStepProgram, runStepRequest } from '../src/lib/run-step.js';
import { PROGRAM_V3_SCHEMA_VERSION } from '../src/workflow/program-v3.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-run-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(repo);
  for (const file of ['connector.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file === 'connector.json' ? 'echo.json' : file), readFileSync(join(REPO, 'src', 'providers', 'echo', file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, home, repo };
}

function bullswarm(f, args) {
  const env = { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: f.repo, env, encoding: 'utf8', timeout: 60_000 });
}

const noRunRecorded = (f) => !(existsSync(join(f.home, 'workflows'))
  && readdirSync(join(f.home, 'workflows')).some((name) => name.startsWith('wf-')));
const runState = (f, runId) => JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'), 'utf8'));

// --- (a) one --check is one command evidence item ----------------------------

test('run --check: one check becomes one command evidence item on the run\'s step', () => {
  const parsed = runStepRequest({ lane: 'build', check: ['npm test'], prompt: 'Fix the acme parser', rest: [] }, { cwd: '/tmp' });
  assert.equal(parsed.error, undefined);
  const [step] = runStepProgram(parsed.request).steps;
  assert.deepEqual(step.evidence, [{ type: 'command', cmd: 'npm test' }]);
});

test('run --check works on every lane the v3 validator takes command evidence for', () => {
  for (const lane of ['analyze', 'build', 'chore']) {
    const parsed = runStepRequest({ lane, check: ['true'], prompt: 'x', rest: [] }, { cwd: '/tmp' });
    assert.equal(parsed.error, undefined, `${lane}: ${parsed.error}`);
    assert.deepEqual(runStepProgram(parsed.request).steps[0].evidence, [{ type: 'command', cmd: 'true' }]);
  }
});

// --- (b) repeated --check, both forms, in order ------------------------------

test('parseArgs collects repeated --check in order, both --check X and --check=X forms', () => {
  const opts = parseArgs(['--lane', 'build', '--check', 'npm test', '--check=npm run lint', '--check', 'node -e 1', 'task text'], { lists: ['check'] });
  assert.deepEqual(opts.check, ['npm test', 'npm run lint', 'node -e 1']);
  assert.deepEqual(opts.rest, ['task text']);
  assert.equal(opts.lane, 'build');
  const parsed = runStepRequest(opts, { cwd: '/tmp' });
  assert.deepEqual(runStepProgram(parsed.request).steps[0].evidence.map((item) => item.cmd), ['npm test', 'npm run lint', 'node -e 1']);
});

test('parseArgs: other flags still keep their last value, and --check stays boolean elsewhere (update --check)', () => {
  assert.equal(parseArgs(['--lane', 'build', '--lane', 'chore']).lane, 'chore');
  assert.equal(parseArgs(['--check']).check, true);
  assert.deepEqual(parseArgs(['--check', 'x']).rest, ['x']);
});

// --- (c) --check-timeout and usage errors ------------------------------------

test('run --check-timeout sets timeoutSec on every --check item', () => {
  const parsed = runStepRequest({ lane: 'build', check: ['a', 'b'], 'check-timeout': '90', prompt: 'x', rest: [] }, { cwd: '/tmp' });
  assert.equal(parsed.error, undefined);
  assert.deepEqual(runStepProgram(parsed.request).steps[0].evidence, [
    { type: 'command', cmd: 'a', timeoutSec: 90 }, { type: 'command', cmd: 'b', timeoutSec: 90 },
  ]);
});

test('run --check: bad values are usage errors, exit 2, with and without --json, and nothing runs', (t) => {
  const f = fixture(t);
  const six = Array.from({ length: 6 }, (_, i) => ['--check', `echo ${i}`]).flat();
  const cases = [
    [['--check'], /--check requires a command/],
    [['--check', '--json'], /--check requires a command/],
    [['--check', '   '], /--check requires a command|empty/],
    [['--check='], /--check requires a command|empty/],
    [six, /at most 5/],
    [['--check', 'true', '--check-timeout', '0'], /--check-timeout must be a number of seconds greater than 0/],
    [['--check', 'true', '--check-timeout', 'soon'], /--check-timeout must be a number of seconds greater than 0/],
    [['--check', 'true', '--check-timeout'], /--check-timeout must be a number of seconds greater than 0/],
    [['--check-timeout', '30'], /--check-timeout needs --check/],
  ];
  for (const [extra, message] of cases) {
    for (const json of [[], ['--json']]) {
      const result = bullswarm(f, ['run', '--lane', 'build', '--add-dir', f.repo, ...json, ...extra, '--prompt', 'x']);
      assert.equal(result.status, 2, `${extra.join(' ')} ${json}: ${result.stderr}${result.stdout}`);
      assert.match(result.stderr, message, extra.join(' '));
    }
  }
  assert.equal(noRunRecorded(f), true);
});

// --- (d) without --check nothing changes -------------------------------------

test('run without --check: the program and goal are exactly what they were', () => {
  const opts = { lane: 'build', effort: 'high', prompt: 'Fix the acme parser', rest: [], 'avoid-pool': 'grok' };
  const { request } = runStepRequest(opts, { cwd: '/tmp' });
  assert.deepEqual(runStepProgram(request), {
    schemaVersion: PROGRAM_V3_SCHEMA_VERSION,
    steps: [{
      id: 'task', label: 'Fix the acme parser', prompt: 'Fix the acme parser',
      lane: 'build', effort: 'high', retry: 1, route: { pools: { avoid: ['grok'] } },
    }],
  });
  assert.equal(Object.hasOwn(request, 'checks'), false, 'the request carries no checks key');
  const goal = runStepGoal(request);
  goal.createdAt = null;
  const again = runStepGoal(runStepRequest(opts, { cwd: '/tmp' }).request);
  again.createdAt = null;
  assert.deepEqual(goal, again);
});

// --- (e) end to end, through the kernel, on the echo connector ---------------

test('run --check: a passing check proves the step by command', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'build', '--json', '--add-dir', f.repo,
    '--check', 'test -f notes.md', '--prompt', 'Add the notes file TOUCH:notes.md']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true, verdict.why);
  assert.equal(verdict.proof, 'proven by command');
  const attempt = runState(f, verdict.runId).attempts.find((entry) => entry.actionId === 'task');
  assert.deepEqual(attempt.evidenceResults.map((item) => [item.type, item.status]), [['command', 'passed']]);
  const lines = bullswarm(f, ['run', '--lane', 'build', '--add-dir', f.repo,
    '--check', 'test -f other.md', '--prompt', 'Add another TOUCH:other.md']);
  assert.equal(lines.status, 0, lines.stderr || lines.stdout);
  assert.match(lines.stdout, /proof: proven by command/);
});

test('run --check: a failing check fails the run failed-evidence with its tail; one same-pool retry, none with --no-retry', (t) => {
  const f = fixture(t);
  const once = bullswarm(f, ['run', '--lane', 'build', '--json', '--no-retry', '--add-dir', f.repo,
    '--check', 'echo acme-check-broke; exit 3', '--prompt', 'Add the notes file TOUCH:notes.md']);
  assert.equal(once.status, 1, once.stderr || once.stdout);
  const verdict = JSON.parse(once.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureKind, 'failed-evidence', verdict.why);
  assert.match(verdict.why, /acme-check-broke/);
  assert.equal(verdict.attempts, 1);

  const retried = bullswarm(f, ['run', '--lane', 'build', '--json', '--add-dir', f.repo,
    '--check', 'echo acme-check-broke; exit 3', '--prompt', 'Add the second file TOUCH:second.md']);
  assert.equal(retried.status, 1, retried.stderr || retried.stdout);
  const second = JSON.parse(retried.stdout);
  assert.equal(second.attempts, 2, 'one same-pool retry');
  const attempts = runState(f, second.runId).attempts.filter((entry) => entry.actionId === 'task');
  assert.deepEqual(attempts.map((entry) => entry.pool), ['echo', 'echo']);
  assert.equal(attempts[0].failureKind ?? attempts[0].failure?.kind, 'failed-evidence');
});

test('run --check --dry-run shows the checks and runs nothing', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'build', '--dry-run', '--add-dir', f.repo,
    '--check', 'npm test', '--check', 'npm run lint', '--prompt', 'x']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check: npm test/);
  assert.match(result.stdout, /check: npm run lint/);
  const json = bullswarm(f, ['run', '--lane', 'build', '--dry-run', '--json', '--add-dir', f.repo, '--check', 'npm test', '--prompt', 'x']);
  assert.deepEqual(JSON.parse(json.stdout).checks, [{ type: 'command', cmd: 'npm test' }]);
  assert.equal(noRunRecorded(f), true);
});
