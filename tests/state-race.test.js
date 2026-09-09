// state.json is a shared file (doctrine S5, audit finding D5).
//
// The reproduction this file guards: a `run` loads state, dispatches a worker
// that takes minutes, then saves the copy it loaded — silently discarding
// whatever an operator did meanwhile. The audit saw
// `strategy set-provider beta off --yes` land mid-run and then be undone, with
// only one decision-log entry surviving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

/** A home whose only pool is the echo fixture, explicitly enabled. */
function echoHome() {
  const home = mkdtempSync(join(tmpdir(), 'bs-state-race-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const file of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file), readFileSync(join(REPO, 'connectors', file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { echo: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    // Already migrated: this test is about the race, not the fixture migration.
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function readState(home) {
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
}

/** Resolves once the delegate's task file exists, i.e. the worker is running. */
async function waitForWorker(home, timeoutMs = 20_000) {
  const runs = join(home, 'runs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(runs) && readdirSync(runs).some((f) => f.startsWith('task-'))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the delegate worker never started');
}

test('an operator write during a long run survives the run (D5)', async () => {
  const f = echoHome();
  try {
    // A 3-second worker: long enough to write state.json out of band while the
    // run is genuinely in flight.
    const run = spawn(process.execPath, [
      BIN, 'run', '--lane', 'chore', '--no-caller', '--json',
      '--prompt', 'SLEEP_MS:3000 report the race',
    ], { env: { ...process.env, BULLSWARM_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    run.stdout.on('data', (c) => { stdout += c; });
    run.stderr.on('data', (c) => { stderr += c; });

    await waitForWorker(f.home);

    // The operator command the audit used, run for real against the same home
    // while the worker is still going.
    const off = spawnSync(process.execPath, [BIN, 'strategy', 'set-provider', 'echo', 'off', '--yes'], {
      env: { ...process.env, BULLSWARM_HOME: f.home }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(readState(f.home).pools.echo.enabled, false, 'the operator write landed mid-run');

    const code = await new Promise((resolve) => run.on('exit', resolve));
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    const verdict = JSON.parse(stdout);
    assert.equal(verdict.ok, true, verdict.why);

    const state = readState(f.home);
    assert.equal(
      state.pools.echo.enabled, false,
      'the run must not resurrect the pool the operator disabled while it ran',
    );
    assert.equal(state.decisionLog.length, 1, 'the run still recorded its own decision');
    assert.equal(state.decisionLog[0].picked, 'echo');
    assert.equal(state.decisionLog[0].ok, true);
    assert.equal(state.incumbents.chore, 'echo', 'and its incumbency write landed');
  } finally { f.cleanup(); }
});
