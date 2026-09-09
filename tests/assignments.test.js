// Cross-process in-flight assignment ledger.
//
// Every test owns a temp BULLSWARM_HOME; nothing here touches the real home
// and nothing dispatches a provider. The CLI layer is exercised against the
// real `bullswarm.js` binary so the printed contract is observed, not assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSIGNMENT_MAX_AGE_MS, assignmentsDir, attachInflight, describeAssignment,
  expectedMinutesFromSpendModel, inflightByPool, isProcessAlive, listAssignments,
  registerAssignment, releaseAssignment, updateAssignment, withLedger,
} from '../src/lib/assignments.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'bullswarm-assignments-'));
}

/** A pid that is certainly dead: spawn a process that exits immediately. */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit()'], { stdio: 'ignore' });
  assert.equal(result.status, 0, 'fixture process must exit cleanly');
  assert.ok(Number.isInteger(result.pid) && result.pid > 0, 'spawnSync must report a pid');
  return result.pid;
}

/** Write a record straight to disk so tests can forge pids and start times. */
function planted(home, fields) {
  const dir = assignmentsDir(home);
  mkdirSync(dir, { recursive: true });
  const record = {
    id: fields.id, pool: fields.pool, model: null, lane: 'build', effort: 'medium',
    source: 'workflow-v2', runId: null, actionId: null, attempt: 1,
    kernelPid: fields.kernelPid, workerPid: fields.workerPid ?? null,
    startedAt: fields.startedAt, expectedMinutes: fields.expectedMinutes ?? null,
    expectedSource: fields.expectedSource ?? 'none',
  };
  writeFileSync(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

test('register -> list -> release round-trips one assignment', () => {
  const home = tempHome();
  try {
    assert.deepEqual(listAssignments(home), [], 'a home with no ledger has no assignments');

    const record = registerAssignment(home, {
      pool: 'echo', model: 'echo-local', lane: 'build', effort: 'medium',
      source: 'workflow-v2', runId: 'wf-abc123-4d5e6f', actionId: 'impl-1', attempt: 1,
      expectedMinutes: 3.1, expectedSource: 'caller',
    });

    assert.equal(record.kernelPid, process.pid);
    assert.equal(record.workerPid, null, 'no worker exists at registration time');
    assert.equal(record.expectedMinutes, 3.1);
    assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(readdirSync(assignmentsDir(home)), [`${record.id}.json`],
      'exactly one file, and no temp file left behind');

    const listed = listAssignments(home);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], record);

    const patched = updateAssignment(home, record.id, { workerPid: 4242 });
    assert.equal(patched.workerPid, 4242);
    assert.equal(listAssignments(home)[0].workerPid, 4242);

    assert.equal(releaseAssignment(home, record.id), true);
    assert.deepEqual(listAssignments(home), []);
    assert.equal(releaseAssignment(home, record.id), false, 'a second release is a no-op');
    assert.equal(updateAssignment(home, record.id, { workerPid: 1 }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an entry whose kernel and worker are both dead is pruned on read', () => {
  const home = tempHome();
  try {
    const kernelPid = deadPid();
    const workerPid = deadPid();
    assert.equal(isProcessAlive(kernelPid), false);
    assert.equal(isProcessAlive(workerPid), false);
    planted(home, {
      id: 'dead-kernel-dead-worker', pool: 'echo', kernelPid, workerPid,
      startedAt: new Date().toISOString(),
    });
    planted(home, {
      id: 'dead-kernel-no-worker', pool: 'echo', kernelPid, workerPid: null,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(listAssignments(home), [], 'a crashed process leaves no phantom load');
    assert.deepEqual(readdirSync(assignmentsDir(home)), [], 'pruned entries are removed from disk');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a dead kernel whose worker is still alive is kept', () => {
  const home = tempHome();
  try {
    planted(home, {
      id: 'orphaned-worker', pool: 'echo', kernelPid: deadPid(), workerPid: process.pid,
      startedAt: new Date().toISOString(),
    });
    assert.deepEqual(listAssignments(home).map((r) => r.id), ['orphaned-worker']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a live kernel with no worker pid yet is kept', () => {
  const home = tempHome();
  try {
    // process.ppid is a live process that is not this one, so the entry is
    // kept by the liveness rule rather than by the caller's-own-entry exemption.
    assert.equal(isProcessAlive(process.ppid), true);
    planted(home, {
      id: 'spawning', pool: 'echo', kernelPid: process.ppid, workerPid: null,
      startedAt: new Date().toISOString(),
    });
    assert.deepEqual(listAssignments(home).map((r) => r.id), ['spawning']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a 13-hour-old entry is pruned even while its processes are alive', () => {
  const home = tempHome();
  try {
    const thirteenHours = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    planted(home, {
      id: 'stale-but-live', pool: 'echo', kernelPid: process.ppid, workerPid: process.ppid,
      startedAt: thirteenHours,
    });
    planted(home, {
      id: 'eleven-hours', pool: 'echo', kernelPid: process.ppid, workerPid: null,
      startedAt: new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(),
    });

    assert.equal(ASSIGNMENT_MAX_AGE_MS, 12 * 60 * 60 * 1000);
    assert.deepEqual(listAssignments(home).map((r) => r.id), ['eleven-hours']);
    assert.deepEqual(readdirSync(assignmentsDir(home)), ['eleven-hours.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prune:false reports every entry, including dead ones', () => {
  const home = tempHome();
  try {
    planted(home, {
      id: 'dead', pool: 'echo', kernelPid: deadPid(), startedAt: new Date().toISOString(),
    });
    assert.equal(listAssignments(home, { prune: false }).length, 1);
    assert.equal(listAssignments(home, { prune: true }).length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('attachInflight counts and times live work per pool', () => {
  const home = tempHome();
  try {
    const now = Date.parse('2026-09-09T12:00:00.000Z');
    planted(home, {
      id: 'a', pool: 'echo', kernelPid: process.pid, workerPid: null,
      startedAt: new Date(now - 6 * 60_000).toISOString(), expectedMinutes: 6.1,
      expectedSource: 'spend-model:expectedMinutesFor',
    });
    planted(home, {
      id: 'b', pool: 'echo', kernelPid: process.pid, workerPid: null,
      startedAt: new Date(now - 90_000).toISOString(),
    });
    planted(home, {
      id: 'c', pool: 'codex', kernelPid: process.pid, workerPid: null,
      startedAt: new Date(now - 30_000).toISOString(), expectedMinutes: 2,
    });

    const pools = [{ name: 'echo' }, { name: 'codex' }, { name: 'grok' }];
    const returned = attachInflight(pools, home, { now });
    assert.equal(returned, pools, 'pool views are stamped in place');

    assert.equal(pools[0].inflight.count, 2);
    assert.equal(pools[0].inflight.minutes, 7.5, '6 + 1.5 elapsed minutes');
    assert.equal(pools[0].inflight.remainingMinutes, 0.1, 'only the entry with an expectation');
    assert.equal(pools[0].inflight.unknownExpected, 1);
    assert.deepEqual(pools[0].inflight.records.map((r) => r.id), ['a', 'b']);
    assert.equal(pools[0].inflight.records[1].expectedMinutes, null);
    assert.equal(pools[0].inflight.records[1].remainingMinutes, null);

    assert.equal(pools[1].inflight.count, 1);
    assert.equal(pools[1].inflight.remainingMinutes, 1.5);

    assert.deepEqual(pools[2].inflight, {
      count: 0, minutes: 0, remainingMinutes: null, unknownExpected: 0, records: [],
    }, 'an idle pool still reports inflight=0 rather than nothing');

    const byPool = inflightByPool(home, { now });
    assert.deepEqual([...byPool.keys()].sort(), ['codex', 'echo']);
    assert.equal(byPool.get('echo').length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent registrations from two processes lose no entries', async () => {
  const home = tempHome();
  try {
    const modulePath = join(ROOT, 'src', 'lib', 'assignments.js');
    const script = (pool) => `
      import { registerAssignment } from ${JSON.stringify(modulePath)};
      for (let i = 0; i < 25; i++) {
        registerAssignment(${JSON.stringify(home)}, {
          pool: ${JSON.stringify(pool)}, lane: 'build', effort: 'medium', source: 'run',
        });
      }
    `;
    const run = (pool) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(pool)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', fail);
      child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`exit ${code}: ${stderr}`))));
    });

    await Promise.all([run('echo'), run('codex')]);

    // Both writers have exited, so pruning would (correctly) reap them all;
    // read without pruning to assert the concurrent WRITES all survived.
    const all = listAssignments(home, { prune: false });
    assert.equal(all.length, 50, 'every concurrent registration is present');
    assert.equal(all.filter((r) => r.pool === 'echo').length, 25);
    assert.equal(all.filter((r) => r.pool === 'codex').length, 25);
    assert.equal(new Set(all.map((r) => r.id)).size, 50, 'ids never collide');
    assert.equal(new Set(all.map((r) => r.kernelPid)).size, 2, 'two distinct writer processes');
    assert.equal(readdirSync(assignmentsDir(home)).filter((f) => !f.endsWith('.json')).length, 0,
      'no temp files survive the atomic writes');

    assert.deepEqual(listAssignments(home), [], 'and every dead writer is then pruned');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bad input is rejected, and withLedger keeps a dispatch alive anyway', () => {
  const home = tempHome();
  try {
    assert.throws(() => registerAssignment(home, {}), /pool is required/);
    assert.throws(() => registerAssignment(home, { pool: 'echo', source: 'nope' }), /source must be one of/);
    assert.throws(() => registerAssignment(home, { pool: 'echo', effort: 'extreme' }), /effort must be/);
    assert.equal(withLedger(() => registerAssignment(home, {})), null);
    assert.equal(withLedger(() => { throw new Error('disk full'); }, false), false);
    assert.deepEqual(listAssignments(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('expectedMinutes is never invented when the spend model is absent', async () => {
  const spend = await expectedMinutesFromSpendModel({ lane: 'build', effort: 'high' });
  assert.equal(typeof spend.expectedSource, 'string');
  if (spend.expectedMinutes === null) {
    assert.match(spend.expectedSource, /^(unavailable:src\/lib\/spend\.js|spend-model:(no-estimate|error))$/);
  } else {
    // src/lib/spend.js exists: the estimate must name the model AND the
    // model's own verdict (measured history vs documented default).
    assert.match(spend.expectedSource, /^spend-model:\w+$/);
    assert.ok(spend.expectedMinutes > 0);
  }

  const home = tempHome();
  try {
    const record = registerAssignment(home, { pool: 'echo', ...spend });
    assert.equal(record.expectedMinutes, spend.expectedMinutes);
    assert.equal(record.expectedSource, spend.expectedSource);
    const view = describeAssignment(record, Date.parse(record.startedAt));
    assert.equal(view.elapsedMinutes, 0);
    assert.equal(view.remainingMinutes, spend.expectedMinutes == null ? null : spend.expectedMinutes);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- dispatch paths -----------------------------------------------------------

test('the V2 dispatcher registers before the spawn and releases on every outcome', async () => {
  const home = tempHome();
  try {
    const runDir = join(home, 'workflows', 'wf-mtszc1by-54277e');
    const dispatchPaths = {
      taskFile: join(runDir, 'task-impl-1.md'),
      outFile: join(runDir, 'out-impl-1.md'),
    };
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const seen = [];
    const dependencies = {
      watchOnce: async (_connector, _task, _dir, _files, opts) => {
        seen.push({ stage: 'before-spawn', records: listAssignments(home) });
        opts.onSpawn?.(123456);
        seen.push({ stage: 'after-spawn', records: listAssignments(home) });
        return { ok: true, why: 'done', meta: { exitCode: 0, wallSec: 1 } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
    };
    const pool = {
      name: 'echo', lanes: ['analyze', 'build', 'chore'], enabled: true,
      spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' },
    };

    const result = await dispatchV2Action({
      action: { id: 'impl-1', lane: 'build', effort: 'medium' },
      taskText: 'do it', targetDir: home, paths: dispatchPaths, pools: [pool],
      bullswarmDir: home, dependencies,
    });
    assert.equal(result.ok, true);

    const before = seen[0].records;
    assert.equal(before.length, 1, 'the pool is in flight before the worker exists');
    assert.equal(before[0].pool, 'echo');
    assert.equal(before[0].source, 'workflow-v2');
    assert.equal(before[0].lane, 'build');
    assert.equal(before[0].effort, 'medium');
    assert.equal(before[0].actionId, 'impl-1');
    assert.equal(before[0].attempt, 1);
    assert.equal(before[0].kernelPid, process.pid);
    assert.equal(before[0].workerPid, null);
    assert.equal(before[0].runId, 'wf-mtszc1by-54277e', 'derived from the run directory');

    assert.equal(seen[1].records[0].workerPid, 123456, 'the worker pid lands as soon as it exists');
    assert.deepEqual(listAssignments(home), [], 'released once the attempt ends');

    // An explicit runId from the kernel wins over the path-derived fallback,
    // and a failing attempt still releases.
    seen.length = 0;
    const failed = await dispatchV2Action({
      action: { id: 'impl-2', lane: 'analyze', effort: 'high' },
      taskText: 'do it', targetDir: home, paths: dispatchPaths, pools: [pool],
      bullswarmDir: home, runId: 'wf-explicit-abc123',
      dependencies: {
        ...dependencies,
        watchOnce: async () => {
          seen.push({ stage: 'running', records: listAssignments(home) });
          return { ok: false, why: 'content lacks evidence', meta: { exitCode: 0 } };
        },
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(seen[0].records[0].runId, 'wf-explicit-abc123');
    assert.equal(seen[0].records[0].actionId, 'impl-2');
    assert.deepEqual(listAssignments(home), [], 'a failed attempt releases too');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The V2 kernel dispatches through dispatchV2Action, so the ledger's real
// contract — one entry, carrying the actual child pid, released when the
// attempt ends — is proved here against a real echo delegate rather than a
// stubbed watchOnce.
test('the V2 dispatcher registers an assignment around a real echo dispatch', async () => {
  const base = tempHome();
  const bullswarmDir = join(base, '.bullswarm');
  try {
    mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
    for (const file of ['echo.json', 'echo-worker.mjs']) {
      writeFileSync(
        join(bullswarmDir, 'connectors', file),
        readFileSync(join(ROOT, 'connectors', file)),
      );
    }
    writeFileSync(join(bullswarmDir, 'state.json'), JSON.stringify({
      version: 1,
      pools: { echo: { enabled: true } },
      incumbents: {},
      decisionLog: [],
      config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
    }, null, 2));
    const connector = JSON.parse(readFileSync(join(ROOT, 'connectors', 'echo.json'), 'utf8'));
    connector.spawn.cmd = ['node', join(ROOT, 'connectors', 'echo-worker.mjs'), '{taskFile}'];
    const pools = [{
      name: 'echo', connector, enabled: true, costRank: 5,
      lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
      usedPct: null, quarantine: null, pace: 0,
    }];

    const runId = 'wf-mtszc1by-54277e';
    const runDir = join(bullswarmDir, 'workflows', runId);
    mkdirSync(runDir, { recursive: true });
    let inFlight = null;
    const result = await dispatchV2Action({
      action: { id: 'one', lane: 'chore' },
      taskText: 'SLEEP_MS:1200 do it',
      targetDir: base,
      paths: { taskFile: join(runDir, 'task-one.md'), outFile: join(runDir, 'out-one.md') },
      pools,
      bullswarmDir,
      runId,
      // The pid exists and is already on the record by the time this fires.
      onSpawn: () => { inFlight = listAssignments(bullswarmDir); },
    });

    assert.equal(result.ok, true, result.verdict?.why);
    assert.ok(inFlight, 'the dispatcher reported a spawned child');
    assert.equal(inFlight.length, 1);
    assert.equal(inFlight[0].pool, 'echo');
    assert.equal(inFlight[0].source, 'workflow-v2');
    assert.equal(inFlight[0].lane, 'chore');
    assert.equal(inFlight[0].effort, 'low');
    assert.equal(inFlight[0].actionId, 'one');
    assert.equal(inFlight[0].attempt, 1);
    assert.equal(inFlight[0].kernelPid, process.pid);
    assert.equal(inFlight[0].runId, runId);
    assert.ok(inFlight[0].workerPid > 0, 'the real child pid is recorded');
    assert.deepEqual(listAssignments(bullswarmDir), [], 'released when the attempt ends');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- CLI ---------------------------------------------------------------------

function cli(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
  });
}

/** A fixture-only home: one deterministic connector, no real provider pools. */
function fixtureHome() {
  const home = tempHome();
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify({
    name: 'echo',
    bin: 'node',
    spawn: { cmd: ['node', '{bullswarmDir}/connectors/echo-worker.mjs', '{taskFile}'], cwdMode: 'task-file-dir' },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    costRank: 5,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['code-reading'],
    model: 'echo-local',
    flags: { testFixture: true },
  }, null, 2));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: { echo: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2));
  return home;
}

test('bullswarm assignments --json lists live entries with their age', () => {
  const home = fixtureHome();
  try {
    const empty = cli(home, ['assignments', '--json']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), []);

    const plain = cli(home, ['assignments']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.trim(), 'no in-flight assignments');

    // A live entry: this test process owns it, so it survives pruning in the
    // separate CLI process only via its (real, live) kernel pid.
    const record = registerAssignment(home, {
      pool: 'echo', model: 'echo-local', lane: 'build', effort: 'high',
      source: 'workflow-v2', runId: 'wf-abc123-4d5e6f', actionId: 'impl-1', attempt: 2,
      workerPid: process.pid, expectedMinutes: 6.1, expectedSource: 'caller',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const json = cli(home, ['assignments', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, record.id);
    assert.equal(parsed[0].pool, 'echo');
    assert.equal(parsed[0].source, 'workflow-v2');
    assert.equal(parsed[0].runId, 'wf-abc123-4d5e6f');
    assert.equal(parsed[0].actionId, 'impl-1');
    assert.equal(parsed[0].attempt, 2);
    assert.equal(parsed[0].kernelPid, process.pid);
    assert.equal(parsed[0].workerPid, process.pid);
    assert.equal(parsed[0].expectedMinutes, 6.1);
    assert.ok(parsed[0].elapsedMinutes >= 2, `age was ${parsed[0].elapsedMinutes}`);
    assert.ok(parsed[0].remainingMinutes <= 4.1);

    const human = cli(home, ['assignments']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^echo\s+build\/high\s+workflow-v2\s+wf-abc123-4d5e6f\/impl-1 age=\d/m);
    assert.match(human.stdout, /expected=6\.1m worker=\d+$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a spawning assignment prints worker=spawning', () => {
  const home = fixtureHome();
  try {
    registerAssignment(home, { pool: 'echo', lane: 'chore', effort: 'low', source: 'run' });
    const human = cli(home, ['assignments']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /worker=spawning$/m);
    assert.match(human.stdout, /expected=(unknown|\d)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bullswarm pools reports inflight=<n> per pool', () => {
  const home = fixtureHome();
  try {
    const idle = cli(home, ['pools']);
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /^echo\s+cost=5 .* surplus=0 inflight=0 /m);

    registerAssignment(home, { pool: 'echo', lane: 'build', effort: 'medium', source: 'run' });
    registerAssignment(home, { pool: 'echo', lane: 'build', effort: 'medium', source: 'run' });
    registerAssignment(home, { pool: 'not-a-pool', lane: 'build', effort: 'medium', source: 'run' });

    const busy = cli(home, ['pools']);
    assert.equal(busy.status, 0, busy.stderr);
    assert.match(busy.stdout, /^echo\s+cost=5 .* surplus=0 inflight=2 /m);

    const json = cli(home, ['pools', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const echo = JSON.parse(json.stdout).pools.find((p) => p.name === 'echo');
    assert.equal(echo.inflight.count, 2);
    assert.equal(echo.inflight.records.length, 2);
    assert.equal(echo.inflight.unknownExpected, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bullswarm assignments --help is documented and side-effect free', () => {
  const home = join(tempHome(), 'must-not-be-created');
  const help = cli(home, ['assignments', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: bullswarm assignments \[--json\]/m);
  assert.match(help.stdout, /in flight/i);
  rmSync(dirname(home), { recursive: true, force: true });
});
