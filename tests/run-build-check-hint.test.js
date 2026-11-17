// `bullswarm run --lane build` with no --check can only finish unproven, so
// the run says so: one hint line on stderr, before dispatch. Never on stdout
// (with --json, stdout stays exactly one JSON object), never with --check,
// never for analyze or chore, and never for --dry-run, which dispatches
// nothing. Every case runs cmdRun in this process with fakes: a fake
// runOneStep (handed fake dispatchV2Action and refreshPools that throw), fake
// pools and no strategy refresh, under a temporary BULLSWARM_HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdRun, parseArgs } from '../src/cli.js';

const HINT = /^hint: no --check, so this build can only finish unproven; add --check '<command>' \(for example your test command\) to prove it$/;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-run-hint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: {}, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return { home, repo };
}

// Run cmdRun with fakes and capture what it prints, in order.
async function run(t, args) {
  const f = fixture(t);
  const saved = { home: process.env.BULLSWARM_HOME, depth: process.env.BULLSWARM_DEPTH, log: console.log, error: console.error };
  const stdout = [];
  const stderr = [];
  const calls = [];
  const never = (name) => async () => { throw new Error(`${name} must not be reached in this test`); };
  process.env.BULLSWARM_HOME = f.home;
  delete process.env.BULLSWARM_DEPTH;
  console.log = (...parts) => { stdout.push(parts.join(' ')); };
  console.error = (...parts) => { stderr.push(parts.join(' ')); };
  let code;
  try {
    const opts = parseArgs(['--add-dir', f.repo, ...args, '--prompt', 'Fix the acme parser'], { lists: ['check'] });
    code = await cmdRun(opts, {
      buildPools: async () => ({ pools: [] }),
      refreshStrategy: async () => {},
      stepDependencies: { dispatchV2Action: never('dispatchV2Action'), refreshPools: never('refreshPools') },
      runOneStep: async (input) => {
        calls.push({ stderrSoFar: [...stderr], input });
        return { ok: true, why: 'all 1 step succeeded', pool: 'acme', model: 'acme-model', runId: 'wf-acme', shortId: 'acme01' };
      },
    });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    if (saved.home === undefined) delete process.env.BULLSWARM_HOME; else process.env.BULLSWARM_HOME = saved.home;
    if (saved.depth !== undefined) process.env.BULLSWARM_DEPTH = saved.depth;
  }
  return { code, stdout, stderr, calls };
}

const hints = (lines) => lines.filter((line) => line.includes('no --check'));

test('run --lane build without --check prints one hint line on stderr, before dispatch', async (t) => {
  const result = await run(t, ['--lane', 'build']);
  assert.equal(result.code, 0);
  assert.equal(hints(result.stderr).length, 1, result.stderr.join('\n'));
  assert.match(hints(result.stderr)[0], HINT);
  assert.equal(hints(result.stdout).length, 0, 'the hint is never on stdout');
  assert.equal(result.calls.length, 1);
  assert.equal(hints(result.calls[0].stderrSoFar).length, 1, 'the hint is printed before the step is dispatched');
  // The fakes reach the step, so no real dispatch or pool discovery can run.
  assert.equal(typeof result.calls[0].input.dependencies?.dispatchV2Action, 'function');
  assert.equal(typeof result.calls[0].input.dependencies?.refreshPools, 'function');
});

test('run --lane build --check prints no hint, in both --check forms', async (t) => {
  for (const check of [['--check', 'npm test'], ['--check=npm test']]) {
    const result = await run(t, ['--lane', 'build', ...check]);
    assert.equal(result.code, 0);
    assert.deepEqual(hints(result.stderr), [], check.join(' '));
    assert.deepEqual(hints(result.stdout), [], check.join(' '));
  }
});

test('run --lane analyze and --lane chore without --check print no hint', async (t) => {
  for (const lane of ['analyze', 'chore']) {
    const result = await run(t, ['--lane', lane]);
    assert.equal(result.code, 0);
    assert.deepEqual(hints(result.stderr), [], lane);
    assert.deepEqual(hints(result.stdout), [], lane);
  }
});

test('run --lane build --json without --check: stdout is exactly one JSON object, the hint is on stderr', async (t) => {
  const result = await run(t, ['--lane', 'build', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 1, result.stdout.join('\n'));
  const verdict = JSON.parse(result.stdout.join('\n'));
  assert.equal(typeof verdict, 'object');
  assert.equal(verdict.ok, true);
  assert.equal(hints(result.stderr).length, 1);
  assert.match(hints(result.stderr)[0], HINT);
});

test('run --lane build --dry-run prints no hint: a preview dispatches nothing', async (t) => {
  const result = await run(t, ['--lane', 'build', '--dry-run', '--json']);
  assert.equal(result.calls.length, 0, 'a dry run never reaches runOneStep');
  assert.deepEqual(hints(result.stderr), []);
  assert.deepEqual(hints(result.stdout), []);
});
