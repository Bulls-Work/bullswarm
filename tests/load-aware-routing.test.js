// End-to-end proof that the three pieces are ONE feature.
//
// The unit suites certify each piece alone: tests/assignments.test.js the
// ledger, tests/spend.test.js the rate model, tests/route.test.js the R8
// selection rules. None of them can show that a real `bullswarm` process
// reads work another process registered and routes around it — that only
// happens once the CLI attaches the ledger and the spend model to the pool
// list before pickPool, which is what this file exercises.
//
// Everything here runs the real bin/bullswarm.js against a temp
// BULLSWARM_HOME with two fixture connectors and hand-written meter
// snapshots. No provider is polled and no delegate is ever spawned:
// `run --dry-run` stops at the routing decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignmentsDir, listAssignments, registerAssignment } from '../src/lib/assignments.js';
import { buildPools } from '../src/lib/config.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const MINUTE = 60_000;

/**
 * Two fixture pools, alphabetical so `alpha` is the one a stable sort would
 * pick on a pure tie. Every pick below that lands on `beta` therefore had to
 * be moved there by the forecast, not by list order.
 */
const POOLS = ['alpha', 'beta'];

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-load-aware-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const name of POOLS) {
    writeFileSync(join(home, 'connectors', `${name}.json`), JSON.stringify({
      name,
      bin: 'node',
      spawn: { cmd: ['node', '{bullswarmDir}/connectors/echo-worker.mjs', '{taskFile}'], cwdMode: 'task-file-dir' },
      outputExtraction: { strategy: 'stdout' },
      meter: { type: 'none' },
      costRank: 3,
      lanes: ['analyze', 'build', 'chore'],
      capabilities: ['code-reading'],
      model: `${name}-local`,
      flags: { testFixture: true },
    }, null, 2));
  }
  writeState(home, []);
  return home;
}

function writeState(home, decisionLog) {
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: Object.fromEntries(POOLS.map((name) => [name, { enabled: true }])),
    incumbents: {},
    decisionLog,
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2));
}

/**
 * A cached meter snapshot, which registry.js serves as a `cache` reading for
 * a pool with no programmatic reader. `capturedAt` defaults to now so the
 * reading is inside FRESH_MS and no live poll is ever attempted.
 */
function writeSnapshot(home, pool, { fiveHourPct, weeklyPct, now, capturedAt = now }) {
  mkdirSync(join(home, 'meters'), { recursive: true });
  writeFileSync(join(home, 'meters', `${pool}.json`), JSON.stringify({
    captured_at: new Date(capturedAt).toISOString(),
    five_hour: {
      utilization: fiveHourPct,
      // Half the 5h window elapsed, identically for both pools.
      resets_at: new Date(now + 2.5 * 60 * MINUTE).toISOString(),
    },
    seven_day: {
      utilization: weeklyPct,
      resets_at: new Date(now + 3.5 * 24 * 60 * MINUTE).toISOString(),
    },
  }, null, 2));
}

function writeMeterHistory(home, pool, lines) {
  mkdirSync(join(home, 'meters', 'history'), { recursive: true });
  writeFileSync(
    join(home, 'meters', 'history', `${pool}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

function cli(home, args) {
  const env = { ...process.env, BULLSWARM_HOME: home };
  // A nested Bullswarm would inherit the parent's depth and be refused; this
  // suite always dispatches from depth 0.
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

function dryRun(home, extra = []) {
  const result = cli(home, [
    'run', '--lane', 'build', '--add-dir', ROOT, '--dry-run', '--json', ...extra,
    'summarize the routing doctrine',
  ]);
  assert.equal(result.status, 0, `run --dry-run failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function candidateFor(verdict, pool) {
  const row = (verdict.candidates ?? []).find((c) => c.pool === pool);
  assert.ok(row, `no candidate row for ${pool} in ${JSON.stringify(verdict.candidates)}`);
  return row;
}

/** Two live assignments on one pool, registered exactly as a dispatch does. */
function registerTwoOn(home, pool, { startedAt, expectedMinutes }) {
  return [1, 2].map((attempt) => registerAssignment(home, {
    pool,
    model: `${pool}-local`,
    lane: 'build',
    effort: 'medium',
    source: 'workflow-v2',
    runId: 'wf-loadaware-000001',
    actionId: `action-${attempt}`,
    attempt,
    startedAt: new Date(startedAt).toISOString(),
    expectedMinutes,
    expectedSource: 'spend-model:default',
  }));
}

test('a burst spreads: two agents already on one pool move the next pick to the quieter one', () => {
  const home = fixtureHome();
  try {
    const now = Date.now();
    // Identical meters: nothing but in-flight load can separate these pools.
    for (const pool of POOLS) writeSnapshot(home, pool, { fiveHourPct: 30, weeklyPct: 20, now });

    const idle = dryRun(home);
    assert.equal(idle.pick.pool, 'alpha', 'with nothing in flight the tie goes to the first pool');
    assert.equal(candidateFor(idle, 'alpha').inflight, 0);

    registerTwoOn(home, 'alpha', { startedAt: now - 2 * MINUTE, expectedMinutes: 10 });
    assert.equal(listAssignments(home).length, 2);

    const loaded = dryRun(home);
    assert.equal(loaded.pick.pool, 'beta', 'the same tie now goes to the pool carrying no work');

    const alpha = candidateFor(loaded, 'alpha');
    const beta = candidateFor(loaded, 'beta');
    assert.equal(alpha.inflight, 2, 'the picker sees both assignments another process registered');
    assert.equal(beta.inflight, 0);
    assert.equal(alpha.pace, beta.pace, 'raw quota pace is still identical');
    assert.ok(
      alpha.effectiveSurplus < beta.effectiveSurplus,
      `in-flight work must cost alpha surplus: ${alpha.effectiveSurplus} vs ${beta.effectiveSurplus}`,
    );
    // No rate is measurable from two agents six seconds of dispatch old, so
    // the documented flat penalty is what moved the pick — and it says so.
    assert.equal(alpha.estimateSource, 'penalty');
    assert.match(loaded.why, /preferred over busier: alpha \(2 in flight\)/);
    assert.equal(loaded.forecast.inflight, 0, 'the forecast recorded is the PICKED pool\'s');
    assert.equal(loaded.forecast.expectedMinutes, 6, 'build/medium books the documented 6 minutes');

    // A preview is a pure read (doctrine F1): it registered nothing of its own
    // and wrote no decision.
    assert.equal(listAssignments(home).length, 2, 'a dry run must not register an assignment');
    assert.equal(readdirSync(assignmentsDir(home)).filter((f) => f.endsWith('.json')).length, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).decisionLog,
      [],
      'a dry run must not write the decision log',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a measured spend rate skips a pool as near-limit before its reading gets there', () => {
  const home = fixtureHome();
  try {
    const now = Date.now();
    // Both pools read 60% of their 5-hour window — under the 75% line, so
    // nothing here is near-limit on the READING alone.
    for (const pool of POOLS) writeSnapshot(home, pool, { fiveHourPct: 60, weeklyPct: 20, now });

    // Three readings 10 minutes apart, +10 utilization points each, with the
    // dispatch that produced them recorded in the decision log: 20 points over
    // 20 worker-minutes, so alpha's measured 5h burn is ~1 point per minute.
    const resetsAt = new Date(now + 2.5 * 60 * MINUTE).toISOString();
    writeMeterHistory(home, 'alpha', [30, 20, 0].map((agoMin, index) => ({
      captured_at: new Date(now - agoMin * MINUTE).toISOString(),
      five_hour: { utilization: [40, 50, 60][index], resets_at: resetsAt },
    })));
    writeState(home, [30, 20].map((agoMin) => ({
      ts: new Date(now - (agoMin - 10) * MINUTE).toISOString(),
      lane: 'build',
      picked: 'alpha',
      keepOnClaude: false,
      ok: true,
      why: 'fixture attempt',
      wallSec: 600,
    })));

    registerTwoOn(home, 'alpha', { startedAt: now - 2 * MINUTE, expectedMinutes: 10 });

    const verdict = dryRun(home);
    const alpha = candidateFor(verdict, 'alpha');
    const beta = candidateFor(verdict, 'beta');

    assert.equal(alpha.fiveHourUsedPct, 60, 'the reading itself is still well under the line');
    assert.ok(
      alpha.ratePerMinute > 0.5 && alpha.ratePerMinute < 1.5,
      `measured burn should be ~1 point per worker-minute, got ${alpha.ratePerMinute}`,
    );
    assert.ok(
      alpha.projectedFiveHourPct > 60,
      `in-flight work must push the projection past the reading, got ${alpha.projectedFiveHourPct}`,
    );
    assert.ok(
      alpha.forecastFiveHourPct >= 75,
      `this assignment must carry alpha past the near-limit line, got ${alpha.forecastFiveHourPct}`,
    );
    assert.equal(alpha.nearFiveHourLimit, true);
    assert.equal(alpha.forecastGated, false, '78% is near-limit, not burst-blocked');

    // beta has no history, so no rate: its forecast is its reading, and it
    // keeps its 5h headroom.
    assert.equal(beta.ratePerMinute, null);
    assert.equal(beta.nearFiveHourLimit, false);

    assert.equal(verdict.pick.pool, 'beta');
    assert.match(verdict.why, /skipped near 5h limit \(projected\): alpha \d+(\.\d+)?%/);

    // R10 end-to-end: the elapsed share of the 5h window travels from the
    // snapshot's resets_at through buildPools into the candidate row and the
    // skip label. The fixture places both pools half way through the window,
    // so alpha's ~78% forecast is genuinely ahead of its own clock and stays
    // tiered down; only a pool whose forecast sits BELOW its elapsed share is
    // exempt.
    assert.ok(
      alpha.fiveHourElapsedPct >= 50 && alpha.fiveHourElapsedPct < 55,
      `half of alpha's 5h window should have elapsed, got ${alpha.fiveHourElapsedPct}`,
    );
    assert.ok(alpha.forecastFiveHourPct > alpha.fiveHourElapsedPct, 'ahead of its clock');
    assert.match(verdict.why, /skipped near 5h limit \(projected\): alpha \d+(\.\d+)?% \(5\d\.\d% elapsed\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pools and assignments report the same live load the router used', () => {
  const home = fixtureHome();
  try {
    const now = Date.now();
    for (const pool of POOLS) writeSnapshot(home, pool, { fiveHourPct: 30, weeklyPct: 20, now });
    registerTwoOn(home, 'alpha', { startedAt: now - 2 * MINUTE, expectedMinutes: 10 });

    const poolsJson = cli(home, ['pools', '--json']);
    assert.equal(poolsJson.status, 0, poolsJson.stderr);
    const pools = JSON.parse(poolsJson.stdout).pools;
    const alpha = pools.find((p) => p.name === 'alpha');
    const beta = pools.find((p) => p.name === 'beta');

    assert.equal(alpha.inflight.count, 2);
    assert.equal(beta.inflight.count, 0);
    assert.ok(alpha.inflight.remainingMinutes > 0, 'in-flight work has minutes left to run');
    assert.ok('projectedFiveHourPct' in alpha, 'every pool exposes its 5h projection');
    assert.equal(beta.projectedFiveHourPct, 30, 'an idle pool projects exactly its reading');
    assert.ok(alpha.spend && beta.spend, 'every pool exposes its spend model');

    const table = cli(home, ['pools']);
    assert.equal(table.status, 0, table.stderr);
    assert.match(table.stdout, /alpha\s+.*inflight=2/);
    // R10: the 5-hour column carries how much of the window has already run.
    assert.match(table.stdout, /beta\s+.*inflight=0 5h=30% \(5\d% elapsed\)/);

    const listed = cli(home, ['assignments', '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    const records = JSON.parse(listed.stdout);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.pool, 'alpha');
      assert.equal(record.lane, 'build');
      assert.equal(record.source, 'workflow-v2');
      assert.equal(record.expectedMinutes, 10);
      assert.ok(record.elapsedMinutes >= 2, 'age is reported from startedAt');
      assert.ok(record.remainingMinutes > 0 && record.remainingMinutes <= 8);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the V2 kernel re-reads the ledger per pick, so simultaneous actions land on different pools', async () => {
  const home = fixtureHome();
  try {
    const now = Date.now();
    // Identical meters again: only what each action registers can separate them.
    for (const pool of POOLS) writeSnapshot(home, pool, { fiveHourPct: 30, weeklyPct: 20, now });
    const { pools } = buildPools(home, now, {});

    // Both dispatches are started before either finishes, exactly as the
    // kernel's 4-way scheduler does it. Each worker blocks until released, so
    // the second pick happens while the first assignment is still in flight.
    const released = [];
    const holdUntil = new Promise((resolve) => { released.push(resolve); });
    const started = [];
    const watchOnce = (connector) => {
      started.push(connector.name);
      return holdUntil.then(() => ({ ok: true, why: 'fixture', meta: { wallSec: 1 } }));
    };

    const dispatchOne = (id) => dispatchV2Action({
      action: { id, lane: 'build', effort: 'medium' },
      taskText: 'fixture task',
      targetDir: ROOT,
      paths: { taskFile: join(home, `task-${id}.md`), outFile: join(home, `out-${id}.md`) },
      pools,
      bullswarmDir: home,
      runId: 'wf-loadaware-000002',
      dependencies: { watchOnce },
    });

    const first = dispatchOne('action-one');
    // Yield until the first dispatch has actually registered and is inside
    // watchOnce; only then is the second pick a genuine concurrent pick.
    while (started.length === 0) await new Promise((r) => setImmediate(r));
    assert.equal(listAssignments(home).length, 1, 'the first pool is booked before its worker returns');
    const second = dispatchOne('action-two');
    while (started.length < 2) await new Promise((r) => setImmediate(r));

    assert.equal(listAssignments(home).length, 2, 'both actions are in flight at once');
    assert.deepEqual(
      [...started].sort(),
      ['alpha', 'beta'],
      `two simultaneous actions must spread across both pools, got ${started.join(' + ')}`,
    );

    released[0]();
    const results = await Promise.all([first, second]);
    for (const result of results) assert.equal(result.ok, true, result.verdict?.why);

    // Every attempt released its booking, and each recorded the forecast it
    // was routed on.
    assert.deepEqual(listAssignments(home), []);
    for (const result of results) {
      const forecast = result.attempts[0].routing.forecast;
      assert.equal(forecast.expectedMinutes, 6);
      assert.ok('inflight' in forecast && 'projectedFiveHourPct' in forecast, JSON.stringify(forecast));
      assert.ok('forecastFiveHourPct' in forecast && 'ratePerMinute' in forecast);
      assert.ok('estimateSource' in forecast);
    }
    const log = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).decisionLog;
    assert.equal(log.length, 2);
    for (const entry of log) assert.ok(entry.forecast, 'every decision records its forecast');
    assert.deepEqual([...log.map((e) => e.picked)].sort(), ['alpha', 'beta']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
