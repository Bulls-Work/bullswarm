import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  classifyV2DispatchFailure, deliverableVerdict, dispatchV2Action, durableAttemptHandoff, snapshotPossible, statDeliverablePaths,
  trackedDiffStatForTests,
} from '../src/workflow/v2-dispatch.js';
import { handoffBlock } from '../src/workflow/v2-runtime.js';
import { loadState, saveState } from '../src/lib/state.js';
import { listAssignments } from '../src/lib/assignments.js';
import { pickPool } from '../src/lib/route.js';
import {
  createV2GoalDocument, createV2DurableState, deserializeV2DurableState,
} from '../src/workflow/v2-state.js';

const action = { id: 'do-work', lane: 'build', effort: 'low' };
const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
  ...extra,
});

function harness(verdicts, coreOverrides = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [], ...coreOverrides };
  let index = 0;
  return {
    dependencies: {
      watchOnce: async (_connector, _task, _dir, paths, opts) => {
        const item = verdicts[index++];
        return typeof item === 'function' ? item({ paths, opts }) : item;
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-08-31T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => 'session-fixed',
    },
    core,
  };
}

function gitWorkspace(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  return repo;
}

const produceFiles = (extra = {}) => ({
  id: 'write-work', role: 'produce', lane: 'build', effort: 'medium',
  deliverable: { type: 'files' }, ownedFiles: ['owned.txt'], ...extra,
});

// One scripted dispatch against a throwaway git repo, or a plain directory
// when `plain` is set. `watches` are the fake worker verdicts, in order.
async function withGate(prefix, { action, watches = [() => good], plain = false, prepare, ...dispatch }, check) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = plain ? join(root, 'plain') : gitWorkspace(root);
  if (plain) mkdirSync(repo, { recursive: true });
  const home = join(root, 'home');
  mkdirSync(home);
  try {
    if (prepare) prepare(repo);
    const verdicts = typeof watches === 'function' ? watches(repo) : watches;
    const result = await dispatchV2Action({
      action,
      taskText: 'do the step',
      targetDir: repo,
      paths: {
        taskFile: join(home, `task-${action.id}-attempt-1.md`),
        outFile: join(home, `out-${action.id}-attempt-1.md`),
      },
      pools: [connector('sample-pool')],
      bullswarmDir: home,
      dependencies: harness(verdicts).dependencies,
      ...dispatch,
    });
    await check({ result, repo, home });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The free-model liveness probe (src/lib/probe.js) runs before a dispatch to a
// rung that names a free model, and by default it spawns the pool's OWN CLI.
// The staller fixture below never answers anything, so a real probe would burn
// its full 30-second budget and then bench the pool for `probe: timeout` —
// the stall/fallback/handoff behaviour these fixtures exist to test would
// never be reached. Injecting the probe seam declares the free rung live and
// records what was probed, so the probe's own tests (tests/probe.test.js) stay
// the place its liveness logic is checked.
function probeSeam(result = { ok: true, reason: null }) {
  const calls = [];
  return {
    calls,
    probeFreeModel: async ({ pool, model }) => {
      calls.push(`${pool.name}:${model}`);
      return { ...result, at: new Date().toISOString() };
    },
  };
}

const paths = { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' };
const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };

test('a decision append never overwrites a state change made while the worker ran (D5)', async () => {
  // No loadState/saveState injection: this exercises the REAL locked
  // read-modify-write against a real state.json, which is where the
  // last-writer-wins bug lived.
  const home = mkdtempSync(join(tmpdir(), 'bs-v2-dispatch-state-'));
  try {
    saveState(home, {
      version: 1, config: { depthLimit: 2 },
      pools: { 'luna-1': { enabled: true }, beta: { enabled: true } },
      incumbents: {}, decisionLog: [],
    });
    const result = await dispatchV2Action({
      action, taskText: 'do it', targetDir: home, paths, pools: [connector('luna-1')],
      bullswarmDir: home,
      dependencies: {
        watchOnce: async () => {
          // The operator command, run while the worker is "in flight".
          const live = loadState(home);
          live.pools.beta.enabled = false;
          saveState(home, live);
          return good;
        },
      },
    });
    assert.equal(result.ok, true);
    const state = loadState(home);
    assert.equal(state.pools.beta.enabled, false, 'the concurrent write survived the append');
    assert.equal(state.decisionLog.length, 1, 'and the append itself landed');
    assert.equal(state.decisionLog[0].picked, 'luna-1');
    assert.equal(state.decisionLog[0].source, 'workflow-v2');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a quarantine written with a decision append lands on the live file, not a stale copy (D5)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-v2-dispatch-quarantine-'));
  try {
    saveState(home, {
      version: 1, config: { depthLimit: 2 },
      pools: { 'luna-1': { enabled: true }, beta: { enabled: true } },
      incumbents: { build: 'luna-1' }, decisionLog: [],
    });
    await dispatchV2Action({
      action, taskText: 'do it', targetDir: home, paths, pools: [connector('luna-1')],
      bullswarmDir: home,
      dependencies: {
        watchOnce: async () => {
          writeFileSync(join(home, 'marker'), 'worker ran');
          const live = loadState(home);
          live.pools.beta.enabled = false;
          saveState(home, live);
          return {
            ok: false, why: 'usage limit reached', failureKind: 'quota', quarantineHint: true, meta: { exitCode: 1 },
            quotaPause: {
              pause: true, rule: 'message', until: Date.now() + 3600_000,
              line: 'usage limit reached · resets in 1 hour', why: 'usage limit reached',
            },
          };
        },
      },
    });
    assert.equal(readFileSync(join(home, 'marker'), 'utf8'), 'worker ran');
    const state = loadState(home);
    assert.equal(state.pools.beta.enabled, false, 'the concurrent write survived');
    assert.equal(state.pools['luna-1'].quarantine.kind, 'quota', 'the quarantine still landed');
    assert.equal(state.incumbents.build, undefined, 'and a quarantined pool loses incumbency');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('failure classification does not invent a process crash when exit metadata is absent', () => {
  assert.equal(classifyV2DispatchFailure({ ok: false, why: 'content rejected' }), 'semantic');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'schema' }), 'schema');
  assert.equal(classifyV2DispatchFailure({ ok: false, meta: { exitCode: 2 } }), 'process');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'provider' }), 'provider');
});

test('literal empty output from a free pool is a provider failure, not semantic work', () => {
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'empty output', meta: { exitCode: 1 } },
    { free: true },
  ), 'provider');
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'empty output', meta: { exitCode: 1 } },
    { free: false },
  ), 'process');
  assert.equal(classifyV2DispatchFailure(
    { ok: false, why: 'announcement without substance', meta: { exitCode: 0 } },
    { free: true },
  ), 'semantic');
});

test('dispatch passes durable same-pool attempts to watch without duplicating the current attempt', async () => {
  let observed = null;
  const h = harness([
    ({ opts }) => { observed = opts.attempts; return good; },
  ]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('codex')], bullswarmDir: '/tmp/bullswarm-ledger-dispatch',
    ledgerAttempts: [
      { id: 'prior-1', pool: 'codex', usage: { api: { usd: 1 } } },
      { id: 'other-1', pool: 'grok', usage: { api: { usd: 2 } } },
      { id: 'do-work-1', pool: 'codex', usage: null },
    ],
    dependencies: h.dependencies,
  });
  assert.deepEqual(observed, [
    { id: 'prior-1', pool: 'codex', usage: { api: { usd: 1 } } },
  ]);
});

test('a free pool derives its silence clock from the trusted rung median', async () => {
  let observedSilence = null;
  const h = harness([
    ({ opts }) => { observedSilence = opts.silenceTimeoutSec; return good; },
  ], {
    decisionLog: [
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 7 * 60, ts: '2026-08-31T00:10:00Z' },
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 8 * 60, ts: '2026-08-31T00:20:00Z' },
      { picked: 'free-rung', lane: 'build', routing: { effort: 'low' }, ok: true, wallSec: 9 * 60, ts: '2026-08-31T00:30:00Z' },
    ],
  });
  const pool = connector('free-rung', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', tier: 'medium', free: true }],
    strategyAssignments: { low: { pool: 'free-rung', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [pool], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(observedSilence, 8 * 60);
});

test('the worker silence environment override still controls a free-pool probe', async () => {
  let observedSilence = null;
  const h = harness([
    ({ opts }) => { observedSilence = opts.silenceTimeoutSec; return good; },
  ]);
  const pool = connector('free-env', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', tier: 'medium', free: true }],
    strategyAssignments: { low: { pool: 'free-env', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [pool], bullswarmDir: '/tmp/bs', parentEnv: { BULLSWARM_WORKER_SILENCE_SEC: '7' },
    dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(observedSilence, 7);
});

test('a usage limit is classified quota, never process, semantic or auth', () => {
  // The real shape: non-zero exit AND a quarantine hint, both of which used to
  // win over the usage limit itself.
  assert.equal(classifyV2DispatchFailure({
    ok: false, failureKind: 'quota', quarantineHint: true, meta: { exitCode: 1 },
  }), 'quota');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'quota' }), 'quota');
  assert.equal(classifyV2DispatchFailure({ ok: false, quarantineHint: true }), 'auth');
});

test('auth failure quarantines and immediately replaces the pool', async () => {
  const h = harness([{ ok: false, why: 'quota', quarantineHint: true, meta: { exitCode: 1 } }, good]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].status, 'interrupted');
  assert.equal(result.attempts[1].wallSec, 1);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-2']);
  assert.ok(h.core.pools['luna-1'].quarantine);
  assert.equal(h.core.decisionLog.length, 2);
});

test('semantic rejection is observed once and never retried', async () => {
  const h = harness([{ ok: false, why: 'content lacks evidence', meta: { exitCode: 0 } }, good]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.failureKind, 'semantic');
  assert.equal(result.attempts.length, 1);
});

test('a writing action with a successful empty diff snapshot fails as a no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-no-op-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const h = harness([good]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'make a bounded change', targetDir: repo,
      paths: { taskFile: join(home, 'task-write-work-attempt-1.md'), outFile: join(home, 'out-write-work-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].failureKind, 'not-produced');
    assert.equal(result.attempts[0].status, 'failed');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
    assert.equal(result.attempts[0].changedFileCount, 0);
    assert.equal(Object.hasOwn(result.attempts[0], 'deliverable'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an analyze action with a successful empty diff snapshot still passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-analyze-empty-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const h = harness([good]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'inspect-work', lane: 'analyze', effort: 'low', ownedFiles: [] },
      taskText: 'inspect without changes', targetDir: repo,
      paths: { taskFile: join(home, 'task-inspect-work-attempt-1.md'), outFile: join(home, 'out-inspect-work-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(result.attempts[0].changedFileCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a build commit step that moves HEAD but changes no file bytes is not a no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-commit-step-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  // The integrator left the edit uncommitted; the commit step only records it.
  writeFileSync(join(repo, 'owned.txt'), 'integrated\n');
  const h = harness([() => {
    execFileSync('git', ['-C', repo, 'commit', '-qam', 'integrate']);
    return good;
  }]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'commit', lane: 'build', effort: 'low', ownedFiles: [] },
      taskText: 'commit the integrated change', targetDir: repo,
      paths: { taskFile: join(home, 'task-commit-attempt-1.md'), outFile: join(home, 'out-commit-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    const commits = execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(commits, '2');
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].status, 'succeeded');
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(result.attempts[0].changedFileCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a chore step that changes neither files nor HEAD, such as opening a PR, still passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-chore-empty-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const h = harness([good]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'open-pr', lane: 'chore', effort: 'low', ownedFiles: [] },
      taskText: 'open the pull request', targetDir: repo,
      paths: { taskFile: join(home, 'task-open-pr-attempt-1.md'), outFile: join(home, 'out-open-pr-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(result.attempts[0].changedFileCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an integration step with nothing to reconcile that only runs the checks still passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-integration-clean-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const h = harness([good]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'integrate', kind: 'integration', lane: 'build', effort: 'high', ownedFiles: [] },
      taskText: 'reconcile the writers and run npm test', targetDir: repo,
      paths: { taskFile: join(home, 'task-integrate-attempt-1.md'), outFile: join(home, 'out-integrate-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].status, 'succeeded');
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(result.attempts[0].changedFileCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an implement-kind writer that changes nothing still fails as a no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-implement-no-op-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const h = harness([good]);
  try {
    const result = await dispatchV2Action({
      action: { id: 'write-work', kind: 'implement', lane: 'build', effort: 'medium', ownedFiles: [] },
      taskText: 'make a bounded change', targetDir: repo,
      paths: { taskFile: join(home, 'task-write-work-attempt-1.md'), outFile: join(home, 'out-write-work-attempt-1.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('files with no paths fails when nothing changed, and a commit that moves HEAD passes', async () => {
  await withGate('bs-files-none-', { action: produceFiles() }, ({ result }) => {
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: true, produced: false });
  });
  await withGate('bs-files-head-', {
    action: produceFiles({ ownedFiles: [] }),
    prepare: (repo) => writeFileSync(join(repo, 'owned.txt'), 'integrated\n'),
    watches: (repo) => [() => {
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'integrate']);
      return good;
    }],
  }, ({ result, repo }) => {
    const commits = execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(commits, '2');
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(result.attempts[0].changedFileCount, 0);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: true, produced: true });
  });
});

test('files with paths: missing fails, a write passes, and an identical rewrite passes on mtime', async () => {
  const action = produceFiles({ deliverable: { type: 'files', paths: ['owned.txt'] } });
  await withGate('bs-files-missing-', {
    action,
    watches: (repo) => [() => {
      rmSync(join(repo, 'owned.txt'));
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'declared files missing: owned.txt');
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'files', gated: true, produced: false, written: [], missing: ['owned.txt'],
    });
  });
  await withGate('bs-files-written-', {
    action,
    watches: (repo) => [() => {
      writeFileSync(join(repo, 'owned.txt'), 'changed\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'files', gated: true, produced: true, written: ['owned.txt'], missing: [],
    });
  });
  await withGate('bs-files-mtime-', {
    action,
    prepare: (repo) => utimesSync(join(repo, 'owned.txt'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z')),
    watches: (repo) => [() => {
      const file = join(repo, 'owned.txt');
      writeFileSync(file, readFileSync(file));
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].changedFileCount, 0);
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'files', gated: true, produced: true, written: ['owned.txt'], missing: [],
    });
  });
});

test('a data path under a git-ignored out/ passes and is attributed', async () => {
  await withGate('bs-data-ignored-', {
    action: {
      id: 'summary', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [],
      deliverable: { type: 'data', paths: ['out/summary.json'] },
    },
    prepare: (repo) => {
      writeFileSync(join(repo, '.gitignore'), 'out/\n');
      execFileSync('git', ['-C', repo, 'add', '.gitignore']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'ignore out']);
    },
    watches: (repo) => [() => {
      mkdirSync(join(repo, 'out'));
      writeFileSync(join(repo, 'out', 'summary.json'), '{"jsFiles":2}\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'data', gated: true, produced: true, written: ['out/summary.json'], missing: [],
    });
    assert.deepEqual(result.attempts[0].changedFiles, ['out/summary.json']);
  });
});

test('a media path that was not created fails as not produced', async () => {
  await withGate('bs-media-missing-', {
    action: {
      id: 'shot', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: ['shot.png'],
      deliverable: { type: 'media', paths: ['shot.png'] },
    },
  }, ({ result }) => {
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'declared media missing: shot.png');
  });
});

test('a non-empty report is produced, and an empty report fails in the verdict helper', async () => {
  await withGate('bs-report-', {
    action: {
      id: 'survey', role: 'investigate', lane: 'analyze', effort: 'medium', ownedFiles: [],
      deliverable: { type: 'report' },
    },
    watches: [({ paths }) => {
      writeFileSync(paths.outFile, 'Two files under src.\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'report', gated: true, produced: true });
  });
  const empty = deliverableVerdict({
    action: { role: 'investigate', lane: 'analyze', deliverable: { type: 'report' } },
    verdict: { ok: true },
    outputBytes: 0,
  });
  assert.equal(empty.failWhy, 'report is empty');
  assert.deepEqual(empty.fact, { type: 'report', gated: true, produced: false });
  // A check step with evidenceFor is never judged, even with the report its
  // role writes back (spec section 2).
  const evidence = deliverableVerdict({
    action: { role: 'check', lane: 'analyze', evidenceFor: ['requirement-1'], deliverable: { type: 'report' } },
    verdict: { ok: true },
    outputBytes: 0,
  });
  assert.equal(evidence.failWhy, null);
  assert.deepEqual(evidence.fact, { type: 'report', gated: false, produced: null });
  const many = deliverableVerdict({
    action: { role: 'produce', lane: 'build', deliverable: { type: 'data', paths: ['a', 'b', 'c', 'd'] } },
    verdict: { ok: true },
    snapshotOk: true,
    pathsBefore: new Map(['a', 'b', 'c', 'd'].map((path) => [path, { exists: false, sha1: null, mtimeMs: null }])),
    pathsAfter: new Map(['a', 'b', 'c', 'd'].map((path) => [path, { exists: false, sha1: null, mtimeMs: null }])),
  });
  assert.equal(many.failWhy, 'declared data missing: a, b, c and 1 more');
  const same = { exists: true, sha1: 'abc', mtimeMs: 1 };
  const untouched = deliverableVerdict({
    action: { role: 'produce', lane: 'build', deliverable: { type: 'data', paths: ['out/summary.json'] } },
    verdict: { ok: true },
    snapshotOk: true,
    pathsBefore: new Map([['out/summary.json', same]]),
    pathsAfter: new Map([['out/summary.json', same]]),
  });
  assert.equal(untouched.failWhy, 'declared data not written: out/summary.json');
  assert.equal(untouched.fact.produced, false);
  assert.deepEqual(untouched.fact.written, []);
});

test('an outward act step is not judged, and combine files may change nothing', async () => {
  await withGate('bs-outward-', {
    action: {
      id: 'notify', role: 'act', lane: 'analyze', effort: 'medium', ownedFiles: [],
      deliverable: { type: 'outward' },
    },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].changedFileCount, 0);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'outward', gated: false, produced: null });
  });
  await withGate('bs-combine-', {
    action: {
      id: 'merge', role: 'combine', lane: 'build', effort: 'high', ownedFiles: [],
      deliverable: { type: 'files' },
    },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: false, produced: null });
  });
  await withGate('bs-integration-files-', {
    action: {
      id: 'integrate', kind: 'integration', lane: 'build', effort: 'high', ownedFiles: [],
      deliverable: { type: 'files' },
    },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: false, produced: null });
  });
});

test('legacyGate false lets an unchanged build step pass, and a lane-only attempt stores no deliverable', async () => {
  await withGate('bs-legacy-off-', {
    action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
    legacyGate: false,
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
    assert.equal(Object.hasOwn(result.attempts[0], 'deliverable'), false);
  });
});

test('the step baseline keeps a file written before a stall retry (D19)', async () => {
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  await withGate('bs-d19-stall-', {
    action: produceFiles(),
    watches: (repo) => [
      () => {
        writeFileSync(join(repo, 'owned.txt'), 'attempt one\n');
        return stalled;
      },
      () => good,
    ],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].failureKind, 'stalled');
    assert.equal(result.attempts[0].changedFileCount, 1);
    assert.equal(result.attempts[1].changedFileCount, 0);
    assert.equal(result.attempts[1].status, 'succeeded');
    assert.deepEqual(result.attempts[1].deliverable, { type: 'files', gated: true, produced: true });
  });
});

test('earlier work carries a clean dispatch, and a refusal rerun is judged again', async () => {
  await withGate('bs-earlier-files-', {
    action: produceFiles(),
    earlierWork: { produced: true },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: false, produced: null, carried: true });
  });
  await withGate('bs-earlier-legacy-', {
    action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
    earlierWork: { produced: true },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.attempts[0], 'deliverable'), false);
  });
  await withGate('bs-earlier-paths-', {
    action: produceFiles({ deliverable: { type: 'data', paths: ['owned.txt'] } }),
    earlierWork: { produced: true },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'data', gated: true, produced: true, written: [], missing: [], carried: true,
    });
  });
  await withGate('bs-earlier-gone-', {
    action: {
      id: 'summary', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [],
      deliverable: { type: 'data', paths: ['out/summary.json'] },
    },
    earlierWork: { produced: true },
  }, ({ result }) => {
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'declared data missing: out/summary.json');
  });
  await withGate('bs-earlier-unknown-', {
    action: produceFiles(),
    earlierWork: { unknown: true },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].deliverable.carried, true);
    assert.equal(result.attempts[0].deliverable.produced, null);
  });
  await withGate('bs-earlier-refused-', {
    action: produceFiles(),
    earlierWork: { produced: false },
  }, ({ result }) => {
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
    assert.equal(result.attempts[0].deliverable.carried, undefined);
  });
});

test('a resumed path deliverable carries when only other files changed, and is judged when it was rewritten', async () => {
  const summary = {
    id: 'summary', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [],
    deliverable: { type: 'data', paths: ['out/summary.json'] },
  };
  // The earlier dispatch wrote out/ (ignored); this one only reruns the checks.
  const prepare = (repo) => {
    writeFileSync(join(repo, '.gitignore'), 'out/\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'ignore out']);
    mkdirSync(join(repo, 'out'));
    writeFileSync(join(repo, 'out', 'summary.json'), '{"jsFiles":2}\n');
  };
  const checksOnly = (repo) => [() => {
    writeFileSync(join(repo, 'check.log'), 'summary.json valid\n');
    return good;
  }];
  for (const earlierWork of [{ produced: true }, { unknown: true }]) {
    await withGate('bs-carry-log-', { action: summary, earlierWork, prepare, watches: checksOnly }, ({ result }) => {
      assert.equal(result.ok, true);
      assert.deepEqual(result.attempts[0].changedFiles, ['check.log']);
      assert.deepEqual(result.attempts[0].deliverable, {
        type: 'data', gated: true, produced: true, written: [], missing: [], carried: true,
      });
    });
  }
  // Without earlier work the same dispatch is judged and fails.
  await withGate('bs-carry-log-none-', { action: summary, prepare, watches: checksOnly }, ({ result }) => {
    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].why, 'declared data not written: out/summary.json');
  });
  // A dispatch that rewrites the path is judged on its own write, not carried.
  await withGate('bs-carry-rewrite-', {
    action: summary, earlierWork: { produced: true }, prepare,
    watches: (repo) => [() => {
      writeFileSync(join(repo, 'out', 'summary.json'), '{"jsFiles":3}\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, {
      type: 'data', gated: true, produced: true, written: ['out/summary.json'], missing: [],
    });
  });
});

test('a workspace in a repository subfolder sees edits to untracked files under workspace paths', async () => {
  const prepare = (repo) => {
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'web', 'index.ts'), 'export {}\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'package']);
    // An earlier step of the same run created this file; it is not committed.
    writeFileSync(join(repo, 'packages', 'web', 'feature.ts'), 'export const v = 1;\n');
  };
  const edits = (repo) => [() => {
    writeFileSync(join(repo, 'packages', 'web', 'feature.ts'), 'export const v = 2;\n');
    writeFileSync(join(repo, 'packages', 'web', 'new.ts'), 'export const w = 1;\n');
    return good;
  }];
  for (const step of [
    { id: 'polish', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [], deliverable: { type: 'files' } },
    { id: 'polish', kind: 'implement', lane: 'build', effort: 'medium', ownedFiles: [] },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'bs-subfolder-'));
    const repo = gitWorkspace(root);
    const home = join(root, 'home');
    mkdirSync(home);
    try {
      prepare(repo);
      const pkg = join(repo, 'packages', 'web');
      const result = await dispatchV2Action({
        action: step, taskText: 'polish feature.ts', targetDir: pkg, legacyGate: true,
        paths: { taskFile: join(home, 'task-polish-attempt-1.md'), outFile: join(home, 'out-polish-attempt-1.md') },
        pools: [connector('sample-pool')], bullswarmDir: home,
        dependencies: harness(edits(repo)).dependencies,
      });
      assert.equal(result.ok, true);
      assert.equal(result.attempts[0].failureKind, null);
      assert.deepEqual(result.attempts[0].changedFiles, ['feature.ts', 'new.ts']);
      const diff = readFileSync(result.attempts[0].diffFile, 'utf8');
      assert.match(diff, /^feature\.ts \| \+1 lines \(new\)$/m);
      assert.match(diff, /^new\.ts \| \+1 lines \(new\)$/m);
      assert.doesNotMatch(diff, /packages\/web/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a workspace its repository ignores is outside git (D21)', async () => {
  const site = (repo) => join(repo, 'scratch', 'site');
  const prepare = (repo) => {
    writeFileSync(join(repo, '.gitignore'), 'scratch/\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'ignore scratch']);
    mkdirSync(site(repo), { recursive: true });
    writeFileSync(join(site(repo), 'index.html'), '<h1>acme</h1>\n');
  };
  const rewrite = (repo) => [() => {
    writeFileSync(join(site(repo), 'index.html'), '<h1>initech</h1>\n');
    writeFileSync(join(site(repo), 'about.html'), '<p>about</p>\n');
    return good;
  }];
  const run = async (step, watches, check) => {
    const root = mkdtempSync(join(tmpdir(), 'bs-ignored-'));
    const repo = gitWorkspace(root);
    const home = join(root, 'home');
    mkdirSync(home);
    try {
      prepare(repo);
      const result = await dispatchV2Action({
        action: step, taskText: 'rewrite the site', targetDir: site(repo), legacyGate: true,
        paths: { taskFile: join(home, `task-${step.id}-attempt-1.md`), outFile: join(home, `out-${step.id}-attempt-1.md`) },
        pools: [connector('sample-pool')], bullswarmDir: home,
        dependencies: harness(watches(repo)).dependencies,
      });
      await check({ result, repo });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const open = { id: 'site', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [], deliverable: { type: 'files' } };
  await run(open, rewrite, ({ result, repo }) => {
    assert.equal(snapshotPossible(site(repo), open), false);
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: false, produced: null });
  });
  // The legacy lane rule does not judge a step it cannot see.
  await run({ id: 'site', kind: 'implement', lane: 'build', effort: 'medium', ownedFiles: [] }, () => [good], ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].failureKind, null);
  });
  // Exact owned files are hashed directly, so a refusal still fails.
  const owned = { ...open, ownedFiles: ['index.html'] };
  await run(owned, () => [good], ({ result, repo }) => {
    assert.equal(snapshotPossible(site(repo), owned), true);
    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
  });
  await run(owned, rewrite, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].changedFiles, ['index.html']);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: true, produced: true });
  });
  // A commit in the repository that ignores the workspace is not the step's work.
  await run(owned, (repo) => [() => {
    writeFileSync(join(repo, 'owned.txt'), 'other\n');
    execFileSync('git', ['-C', repo, 'commit', '-qam', 'unrelated']);
    return good;
  }], ({ result }) => {
    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
  });
});

test('outside git, exact owned files and data paths are judged and a pathless step with no territory is not (D21)', async () => {
  const owned = {
    id: 'write-work', role: 'produce', lane: 'build', effort: 'medium',
    deliverable: { type: 'files' }, ownedFiles: ['src/a.js'],
  };
  await withGate('bs-d21-refuse-', {
    plain: true,
    action: owned,
    prepare: (repo) => {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'a.js'), 'export {}\n');
    },
  }, ({ result, repo }) => {
    assert.equal(snapshotPossible(repo, owned), true);
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
  });
  await withGate('bs-d21-write-', {
    plain: true,
    action: owned,
    prepare: (repo) => {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'a.js'), 'export {}\n');
    },
    watches: (repo) => [() => {
      writeFileSync(join(repo, 'src', 'a.js'), 'export const n = 1;\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: true, produced: true });
    assert.deepEqual(result.attempts[0].changedFiles, ['src/a.js']);
  });
  await withGate('bs-d21-mtime-', {
    plain: true,
    action: owned,
    prepare: (repo) => {
      mkdirSync(join(repo, 'src'));
      const file = join(repo, 'src', 'a.js');
      writeFileSync(file, 'export {}\n');
      utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    },
    watches: (repo) => [() => {
      const file = join(repo, 'src', 'a.js');
      utimesSync(file, new Date('2026-09-24T12:00:00Z'), new Date('2026-09-24T12:00:00Z'));
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[0].changedFileCount, 0);
    assert.equal(result.attempts[0].deliverable.produced, true);
  });
  const open = {
    id: 'write-work', role: 'produce', lane: 'build', effort: 'medium',
    deliverable: { type: 'files' }, ownedFiles: [],
  };
  await withGate('bs-d21-open-', {
    plain: true,
    action: open,
  }, ({ result, repo }) => {
    assert.equal(snapshotPossible(repo, open), false);
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable, { type: 'files', gated: false, produced: null });
    const stats = statDeliverablePaths(repo, ['missing.txt']);
    assert.deepEqual(stats.get('missing.txt'), { exists: false, sha1: null, mtimeMs: null });
  });
  const data = {
    id: 'summary', role: 'produce', lane: 'build', effort: 'medium', ownedFiles: [],
    deliverable: { type: 'data', paths: ['out/summary.json'] },
  };
  await withGate('bs-d21-data-pass-', {
    plain: true,
    action: data,
    watches: (repo) => [() => {
      mkdirSync(join(repo, 'out'));
      writeFileSync(join(repo, 'out', 'summary.json'), '{"jsFiles":1}\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].deliverable.written, ['out/summary.json']);
    assert.equal(result.attempts[0].deliverable.produced, true);
  });
  await withGate('bs-d21-data-fail-', { plain: true, action: data }, ({ result }) => {
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'declared data missing: out/summary.json');
  });
});

test('an ignored extraSnapshotPaths file counts as a change for a legacy build step', async () => {
  await withGate('bs-extra-path-', {
    action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: [] },
    extraSnapshotPaths: ['out/summary.json'],
    prepare: (repo) => {
      writeFileSync(join(repo, '.gitignore'), 'out/\n');
      execFileSync('git', ['-C', repo, 'add', '.gitignore']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'ignore out']);
    },
    watches: (repo) => [() => {
      mkdirSync(join(repo, 'out'));
      writeFileSync(join(repo, 'out', 'summary.json'), '{"ok":true}\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.attempts[0], 'deliverable'), false);
    assert.ok(result.attempts[0].changedFiles.includes('out/summary.json'));
  });
});

test('diff files remain distinct across dispatch reruns of the same action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-rerun-diff-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  try {
    const first = await dispatchV2Action({
      action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'first bounded change', targetDir: repo,
      paths: { taskFile: join(home, 'task-write-work-attempt-4.md'), outFile: join(home, 'out-write-work-attempt-4.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: harness([() => {
        writeFileSync(join(repo, 'owned.txt'), 'first change\n');
        return good;
      }]).dependencies,
    });
    const firstDiff = readFileSync(first.attempts[0].diffFile, 'utf8');
    const second = await dispatchV2Action({
      action: { id: 'write-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'second bounded change', targetDir: repo,
      paths: { taskFile: join(home, 'task-write-work-attempt-5.md'), outFile: join(home, 'out-write-work-attempt-5.md') },
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: harness([() => {
        writeFileSync(join(repo, 'owned.txt'), 'second change\nsecond line\n');
        return good;
      }]).dependencies,
    });
    assert.equal(first.attempts[0].diffFile, join(home, 'diff-write-work-attempt-4.txt'));
    assert.equal(second.attempts[0].diffFile, join(home, 'diff-write-work-attempt-5.txt'));
    assert.notEqual(first.attempts[0].diffFile, second.attempts[0].diffFile);
    assert.match(firstDiff, /1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
    assert.equal(readFileSync(first.attempts[0].diffFile, 'utf8'), firstDiff);
    assert.match(readFileSync(second.attempts[0].diffFile, 'utf8'), /1 file changed, 2 insertions\(\+\), 1 deletion\(-\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a free stall does not spend the mechanical retry and falls through to the next pool', async () => {
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([stalled, good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    }), connector('paid')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 0, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['free', 'paid']);
  assert.equal(result.attempts[0].willRetry, true);
  assert.match(result.attempts[1].routeWhy, /^fallback from free after stall 300s/);
});

test('a free empty-output provider failure also leaves the mechanical retry untouched', async () => {
  const h = harness([
    { ok: false, why: 'empty output', meta: { exitCode: 1, wallSec: 0.1 } },
    good,
  ]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    }), connector('paid')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 0, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['free', 'paid']);
  assert.equal(result.attempts[0].failureKind, 'provider');
  assert.equal(result.attempts[0].willRetry, true);
});

test('a metered stall still spends the mechanical retry allowance', async () => {
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([stalled, good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('metered')],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['metered', 'metered']);
  assert.equal(result.attempts[0].willRetry, true);
});

test('a free stall still falls through after an earlier schema correction spends the retry budget', async () => {
  const schema = {
    ok: false, failureKind: 'schema', why: 'invalid evidence', structured: { errors: ['bad'] }, meta: { exitCode: 0 },
  };
  const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
  const h = harness([schema, schema, stalled, good]);
  const free = connector('free', {
    model: 'provider/union-free',
    modelProfiles: [{ match: 'union-free', free: true }],
    strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('answerer'), free, connector('metered')],
    evidence: { writerPools: ['free', 'metered'] },
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1,
    correctionTask: () => 'correct it', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['answerer', 'answerer', 'free', 'metered']);
  assert.equal(result.attempts[2].willRetry, true);
});

test('willRetry is false when a free stall is the last eligible pool', async () => {
  const h = harness([{ ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null } }]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('free', {
      model: 'provider/union-free',
      modelProfiles: [{ match: 'union-free', free: true }],
      strategyAssignments: { low: { pool: 'free', model: 'provider/union-free' } },
    })],
    bullswarmDir: '/tmp/bs', maxMechanicalRetries: 1, dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].willRetry, false);
});

test('schema correction is bounded and resumes one physical planner session', async () => {
  const seen = [];
  const pool = connector('luna-1', { conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] } });
  const h = harness([
    ({ opts }) => { seen.push(opts.conversation); return { ok: false, why: 'invalid', failureKind: 'schema', structured: { errors: ['bad'] }, meta: { exitCode: 0 } }; },
    ({ opts }) => { seen.push(opts.conversation); return good; },
  ]);
  const result = await dispatchV2Action({ action, taskText: 'plan', targetDir: '/tmp', paths, pools: [pool], bullswarmDir: '/tmp/bs', outputValidator: () => ({ ok: true }), correctionTask: () => 'correct it', currentSession: null, dependencies: h.dependencies });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].status, 'interrupted');
  assert.deepEqual(seen, [{ sessionId: 'session-fixed', resume: false }, { sessionId: 'session-fixed', resume: true }]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.session.sessionId, 'session-fixed');
});

test('a strict pool pin dispatches only to that pool while other pools are eligible', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action: { ...action, lane: 'analyze' },
    taskText: 'inspect',
    targetDir: '/tmp',
    paths,
    // unrelated-luna first and no preferredPool: only the strict pin can keep dispatch off it.
    pools: [connector('unrelated-luna'), connector('pinned-luna')],
    strictPool: 'pinned-luna',
    bullswarmDir: '/tmp/bs',
    dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'pinned-luna');
});

test('provider-qualified model pins cannot run under another credential pool label', async () => {
  const h = harness([good]);
  const primary = connector('relay', {
    profile: { providerId: 'a' },
    spawn: { cmd: ['fake', '--model', 'a/gpt-5.6-luna'] },
  });
  const second = connector('relay:b', {
    profile: { providerId: 'b' },
    spawn: { cmd: ['fake', '--model', 'b/gpt-5.6-luna'] },
  });
  const result = await dispatchV2Action({
    action: { ...action, lane: 'analyze' }, taskText: 'inspect', targetDir: '/tmp', paths,
    // relay:b first: with nothing pinning the model, dispatch would pick it.
    pools: [second, primary],
    preferredModel: 'a/gpt-5.6-luna', bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'relay');
  assert.equal(result.attempts[0].model, 'a/gpt-5.6-luna');
});

test('persisted effort assignment wins while its pool remains eligible', async () => {
  const h = harness([good]);
  const first = connector('luna-1');
  const assigned = connector('luna-2');
  first.strategyAssignments.low = { pool: 'luna-2', model: 'gpt-5.6-luna' };
  assigned.strategyAssignments.low = { pool: 'luna-2', model: 'gpt-5.6-luna' };
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [first, assigned], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.attempts[0].pool, 'luna-2');
});

test('defensive analyze fallback is medium rather than silently escalating to high', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action: { id: 'inspect-work', lane: 'analyze' },
    taskText: 'inspect it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].routing.effort, 'medium');
});

test('workflow dispatch honors the interactive strategy model allow-list', async () => {
  const h = harness([good]);
  const blocked = connector('luna-1', {
    strategyAssignments: {}, strategyConfiguredTiers: ['low'], strategyModelTiers: {},
  });
  const selected = connector('luna-2', {
    strategyAssignments: {}, strategyConfiguredTiers: ['low'],
    strategyModelTiers: { 'luna-2': { 'gpt-5.6-luna': ['low'] } },
  });
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [blocked, selected], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'luna-2');
  assert.equal(result.attempts[0].model, 'gpt-5.6-luna');
});

test('burst-gated pools are not waited on or dispatched', async () => {
  const h = harness([]);
  const result = await dispatchV2Action({ action, taskText: 'do it', targetDir: '/tmp', paths, pools: [connector('luna-1', { burstGate: true })], bullswarmDir: '/tmp/bs', dependencies: h.dependencies });
  assert.equal(result.failureKind, 'unavailable');
  assert.equal(result.attempts.length, 0);
});

// --- usage-limit recovery (requirement 1) --------------------------------

const QUOTA_RESET = Date.parse('2026-08-31T02:20:00Z');
const quotaVerdict = () => ({
  ok: false,
  failureKind: 'quota',
  quarantineHint: true,
  quarantineUntil: QUOTA_RESET,
  quarantineSource: 'message',
  why: `usage limit: "You've hit your session limit · resets 10:20am (Asia/Hong_Kong)" `
    + `· pool paused until ${new Date(QUOTA_RESET).toISOString()}`,
  // The decideQuotaPause() proof watch.js attaches; without it state.js
  // refuses the quota pause (quota.js Q6).
  quotaPause: {
    pause: true,
    rule: 'message',
    until: QUOTA_RESET,
    resetsAt: new Date(QUOTA_RESET).toISOString(),
    line: "You've hit your session limit · resets 10:20am (Asia/Hong_Kong)",
    meter: null,
    meterWindow: null,
    why: `usage limit: "You've hit your session limit · resets 10:20am (Asia/Hong_Kong)" `
      + `· pool paused until ${new Date(QUOTA_RESET).toISOString()}`,
  },
  meta: { exitCode: 1, wallSec: 0.2 },
});

test('a quota failure quarantines until the announced reset and replaces the pool', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1', { fiveHourUsedPct: 12 }), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-2']);
  assert.equal(result.attempts[0].failureKind, 'quota');
  assert.equal(result.attempts[0].status, 'interrupted');
  assert.equal(result.attempts[0].why, quotaVerdict().why);
  assert.equal(result.attempts[0].routing.fiveHourUsedPct, 12);
  assert.equal(result.attempts[1].routing.fiveHourUsedPct, null);

  const quarantine = h.core.pools['luna-1'].quarantine;
  assert.equal(quarantine.until, QUOTA_RESET, 'the announced reset, not a flat 10 minutes');
  assert.equal(quarantine.kind, 'quota');
  assert.equal(quarantine.reason, quotaVerdict().why);
  assert.equal(h.core.pools['luna-2']?.quarantine, undefined);
});

test('a quota failure on the only pool is never retried on that same pool', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, 'failed');
  assert.equal(h.core.pools['luna-1'].quarantine.until, QUOTA_RESET);
});

test('a quarantine in live core state excludes a pool whose launch-time object looks clean', async () => {
  const h = harness([good]);
  // Written by another action or another run after this dispatch got its list.
  h.core.pools['luna-1'] = {
    quarantine: { until: Date.parse('2026-08-31T03:00:00Z'), reason: 'usage limit', kind: 'quota' },
  };
  const pools = [connector('luna-1'), connector('luna-2')];
  assert.equal(pools[0].quarantine, undefined, 'the stale pool object carries no quarantine');
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths, pools,
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-2']);
});

test('an expired live quarantine does not exclude the pool', async () => {
  const h = harness([good]);
  h.core.pools['luna-1'] = {
    quarantine: { until: Date.parse('2026-08-31T00:30:00Z'), reason: 'usage limit', kind: 'quota' },
  };
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.attempts[0].pool, 'luna-1');
});

test('refreshPools runs before every pick, is forced after a quota failure, and drives the next pick', async () => {
  const h = harness([quotaVerdict(), good]);
  const calls = [];
  // luna-3 exists only in the refreshed list: picking it proves the live list
  // replaced the one captured at launch.
  const refreshed = [connector('luna-1'), connector('luna-3')];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    refreshPools: async (opts) => { calls.push(opts); return refreshed; },
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-3']);
});

test('a refresher that throws or returns nothing leaves the dispatch on its launch list', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')],
    refreshPools: async () => { throw new Error('meter reader exploded'); },
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].pool, 'luna-1');

  const empty = harness([good]);
  const second = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')],
    refreshPools: async () => [],
    bullswarmDir: '/tmp/bs', dependencies: empty.dependencies,
  });
  assert.equal(second.attempts[0].pool, 'luna-1');
});

// --- reasoning ---------------------------------------------------------------
// One level is resolved PER ATTEMPT, from the connector actually picked, and it
// has to arrive in three places at once: the spawned watch options, the attempt
// record (which is what `attempt.started` carries), and the decision log.

const thinking = (name, reasoning, extra = {}) => connector(name, {
  reasoning: reasoning ?? {
    flag: '--effort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
  },
  ...extra,
});

async function dispatchWithReasoning({ pools, core = {}, ...rest } = {}) {
  const seen = [];
  const h = harness([({ opts }) => { seen.push(opts.reasoning); return good; }], core);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools, bullswarmDir: '/tmp/bs', dependencies: h.dependencies, ...rest,
  });
  return { result, seen, core: h.core };
}

test('an attempt resolves its reasoning level from the connector default for the effort tier', async () => {
  // action.effort is 'low', so the connector's low default is what runs.
  const { result, seen, core } = await dispatchWithReasoning({ pools: [thinking('luna-1')] });
  assert.equal(result.ok, true);
  const expected = { requested: 'medium', applied: 'medium', source: 'connector', clamped: false };
  assert.deepEqual(result.attempts[0].reasoning, expected);
  assert.deepEqual(seen, [expected], 'watchOnce must receive opts.reasoning');
  assert.deepEqual(core.decisionLog[0].reasoning, expected);
});

test('a strategy tier level in live core state outranks the connector default', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [thinking('luna-1')],
    core: { strategy: { reasoning: { tiers: { low: 'high' } } } },
  });
  const expected = { requested: 'high', applied: 'high', source: 'strategy-tier', clamped: false };
  assert.deepEqual(result.attempts[0].reasoning, expected);
  assert.deepEqual(seen, [expected]);
});

test('a strategy per-pool level outranks the strategy tier level', async () => {
  const { result } = await dispatchWithReasoning({
    pools: [thinking('luna-1')],
    core: { strategy: { reasoning: { tiers: { low: 'high' }, pools: { 'luna-1': { low: 'max' } } } } },
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'max', source: 'strategy-pool', clamped: false,
  });
});

test('runReasoning outranks strategy, and reasoningOverride outranks everything', async () => {
  const core = { strategy: { reasoning: { tiers: { low: 'high' }, pools: { 'luna-1': { low: 'max' } } } } };
  const run = await dispatchWithReasoning({ pools: [thinking('luna-1')], core, runReasoning: 'low' });
  assert.deepEqual(run.result.attempts[0].reasoning, {
    requested: 'low', applied: 'low', source: 'run', clamped: false,
  });
  const override = await dispatchWithReasoning({
    pools: [thinking('luna-1')], core, runReasoning: 'low', reasoningOverride: 'xhigh',
  });
  assert.deepEqual(override.result.attempts[0].reasoning, {
    requested: 'xhigh', applied: 'xhigh', source: 'action', clamped: false,
  });
  assert.deepEqual(override.seen, [{
    requested: 'xhigh', applied: 'xhigh', source: 'action', clamped: false,
  }]);
});

test('a program action carrying its own reasoning field is honored as the action override', async () => {
  const seen = [];
  const h = harness([({ opts }) => { seen.push(opts.reasoning); return good; }]);
  const result = await dispatchV2Action({
    action: { ...action, reasoning: 'max' }, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [thinking('luna-1')], runReasoning: 'low',
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'max', source: 'action', clamped: false,
  });
  assert.deepEqual(seen[0], result.attempts[0].reasoning);
});

test('a request the picked connector cannot express is clamped on the record it ran under', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [thinking('luna-1', {
      args: ['-c', 'model_reasoning_effort={level}'],
      levels: ['low', 'medium', 'high'],
      defaults: { high: 'high', medium: 'medium', low: 'low' },
    })],
    runReasoning: 'max',
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: 'high', source: 'run', clamped: true,
  });
  assert.deepEqual(seen, [{ requested: 'max', applied: 'high', source: 'run', clamped: true }]);
});

test('a connector without reasoning records unsupported instead of a level it never sent', async () => {
  const { result, seen } = await dispatchWithReasoning({
    pools: [connector('luna-1')], runReasoning: 'max',
  });
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'max', applied: null, source: 'unsupported', clamped: false,
  });
  assert.deepEqual(seen, [{ requested: 'max', applied: null, source: 'unsupported', clamped: false }]);
});

test('a model the connector marks as skipped records skipped-model', async () => {
  const { result } = await dispatchWithReasoning({
    pools: [thinking('luna-1', {
      flag: '--effort',
      levels: ['low', 'medium', 'high'],
      defaults: { low: 'medium' },
      skipModels: ['^gpt-5\\.6-luna$'],
    })],
  });
  // The strategy assignment pins gpt-5.6-luna as this pool's model.
  assert.equal(result.attempts[0].model, 'gpt-5.6-luna');
  assert.deepEqual(result.attempts[0].reasoning, {
    requested: 'medium', applied: null, source: 'skipped-model', clamped: false,
  });
});

test('each attempt of one action resolves against the connector it actually landed on', async () => {
  const seen = [];
  const h = harness([
    ({ opts }) => { seen.push(opts.reasoning); return { ok: false, why: 'auth', quarantineHint: true, meta: { exitCode: 1 } }; },
    ({ opts }) => { seen.push(opts.reasoning); return good; },
  ]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    // luna-1 accepts the full scale; luna-2 tops out at high.
    pools: [
      thinking('luna-1'),
      thinking('luna-2', { flag: '--effort', levels: ['low', 'medium', 'high'], defaults: { low: 'low' } }),
    ],
    runReasoning: 'xhigh',
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.reasoning), [
    { requested: 'xhigh', applied: 'xhigh', source: 'run', clamped: false },
    { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
  ]);
  assert.deepEqual(seen, result.attempts.map((attempt) => attempt.reasoning));
  assert.deepEqual(h.core.decisionLog.map((entry) => entry.reasoning), result.attempts.map((a) => a.reasoning));
});

test('the attempt.started notification carries the resolved reasoning record', async () => {
  const started = [];
  const h = harness([good]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [thinking('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
    onAttempt: (phase, record) => { if (phase === 'started') started.push(record.reasoning); },
  });
  assert.deepEqual(started, [{ requested: 'medium', applied: 'medium', source: 'connector', clamped: false }]);
});

// --- routed-why provenance on the durable attempt record --------------------

test('every dispatched attempt records the router reason and candidate table', async () => {
  const h = harness([good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.ok(result.attempts[0].routeWhy, 'routeWhy is the router reason string');
  assert.ok(Array.isArray(result.attempts[0].routeCandidates));
  assert.ok(result.attempts[0].routeCandidates.length >= 1);
  for (const attempt of result.attempts) {
    assert.equal(typeof attempt.routeWhy, 'string');
    for (const candidate of attempt.routeCandidates) {
      assert.equal(typeof candidate.pool, 'string');
      assert.ok('effectiveSurplus' in candidate, 'effectiveSurplus present, null preserved');
      assert.ok('urgencyState' in candidate, 'urgencyState present, null preserved');
      assert.ok('forecastPacingPct' in candidate, 'forecastPacingPct present, null preserved');
    }
    assert.ok(
      attempt.routeCandidates.some((candidate) => candidate.pool === attempt.pool),
      'the picked pool appears among the candidates',
    );
  }
  // The routed pool sits in candidate position zero when it is the best pick.
  assert.equal(result.attempts[0].routeCandidates[0].pool, result.attempts[0].pool);
});

test('a state file whose attempts lack the routing fields still loads', () => {
  const goal = createV2GoalDocument({
    goal: 'Old run without route provenance', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Do the thing' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-old', shortId: 'old123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: [], ownedFiles: [],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 1, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  // An attempt recorded before routeWhy/routeCandidates existed: no fields at all.
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'succeeded',
    pool: 'luna-1', model: 'gpt-5.6-luna', startedAt: '2026-08-31T01:00:00.000Z',
    finishedAt: '2026-08-31T01:01:00.000Z',
  }];
  assert.doesNotThrow(() => deserializeV2DurableState(JSON.stringify(state)));
});

test('the attempt.started notification carries the router reason and candidates', async () => {
  const started = [];
  const h = harness([good]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
    onAttempt: (phase, record) => { if (phase === 'started') started.push(record); },
  });
  assert.equal(typeof started[0].routeWhy, 'string');
  assert.ok(Array.isArray(started[0].routeCandidates));
});

// --- one dead upstream credential, three pool names -------------------------
// 2026-09-11: the OAuth pool behind a relaying reseller was invalidated at
// 12:24 UTC. Its three pools were three names for it, and the retry of a failed
// action walked from one sibling to the next, burning both attempts on the
// same dead credential and blocking every dependent action.

const RELAY_GROUP = 'relay:relay.example';
const relayPool = (name) => connector(name, { credentialGroup: RELAY_GROUP });
const upstreamAuthVerdict = () => ({
  ok: false,
  failureKind: 'auth',
  quarantineHint: true,
  why: 'upstream auth failure: "auth_unavailable" (provider stream error)',
  meta: { exitCode: 1, providerFailureType: 'error', wallSec: 0.9 },
});
const HARNESS_T0 = Date.parse('2026-08-31T01:00:00Z');

test('an upstream auth failure benches every pool on that credential and the retry leaves the group', async () => {
  const h = harness([upstreamAuthVerdict(), good]);
  const pools = [
    relayPool('relay:c'), relayPool('relay:b'), relayPool('relay'),
    connector('command-code'),
  ];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths, pools,
    // The refresher hands back the SAME, still-unquarantined pool objects: the
    // group has to stay out of service on the strength of live state alone.
    refreshPools: async () => pools,
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c', 'command-code']);
  const quarantine = (name) => h.core.pools[name]?.quarantine;
  for (const name of ['relay:c', 'relay:b', 'relay']) {
    assert.ok(quarantine(name), `${name} is benched`);
    assert.equal(quarantine(name).kind, 'auth');
  }
  // One upstream, one deadline — the siblings do not open a second window.
  assert.equal(quarantine('relay:b').until, quarantine('relay:c').until);
  assert.equal(quarantine('relay').until, quarantine('relay:c').until);
  const ahead = quarantine('relay:c').until - HARNESS_T0;
  assert.ok(ahead > 600_000 && ahead <= 630_000, `re-probe window is ${ahead}ms after t0`);
  assert.equal(
    quarantine('relay:b').reason,
    'sibling of relay:c: upstream auth failure: "auth_unavailable" (provider stream error)',
  );
  assert.equal(quarantine('command-code'), undefined, 'a pool on its own credential keeps working');
});

test('a group sibling is unreachable for the next attempt even without a refresher', async () => {
  // Two attempts, both auth: with the group benched there is nowhere left to
  // go, and the action must fail instead of burning the second attempt on
  // another name for the same credential.
  const h = harness([upstreamAuthVerdict(), upstreamAuthVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [relayPool('relay:c'), relayPool('relay:b'), relayPool('relay')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'auth');
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c']);
  assert.equal(result.attempts[0].status, 'failed', 'no recovery was promised that the group could not deliver');
});

test('a usage limit benches only the pool that hit it, never its upstream siblings', async () => {
  const h = harness([quotaVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [relayPool('relay:c'), relayPool('relay:b'), relayPool('relay')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['relay:c', 'relay:b']);
  assert.equal(h.core.pools['relay:c'].quarantine.kind, 'quota');
  assert.equal(h.core.pools['relay:b']?.quarantine, undefined, 'a sibling window is its own');
  assert.equal(h.core.pools.relay?.quarantine, undefined);
});

test('an auth failure on a pool with no upstream group benches nothing else', async () => {
  const h = harness([upstreamAuthVerdict(), good]);
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('claude-code:alt'), connector('claude-code')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.ok(h.core.pools['claude-code:alt'].quarantine);
  assert.equal(h.core.pools['claude-code']?.quarantine, undefined, 'a separate seat is a separate credential');
});

test('a free stall keeps partial output, falls back, releases the ledger, and benches on the second strike', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-free-stall-dispatch-'));
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  const fixturePool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  const staller = fixturePool('staller', stallerWorker, 'zen/union-free', { free: true });
  const answerer = fixturePool('answerer', answererWorker, 'paid/answerer');
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  const pathsFor = (prefix) => (ordinal) => ({
    taskFile: join(home, `${prefix}-task-${ordinal}.md`),
    outFile: join(home, `${prefix}-out-${ordinal}.md`),
  });
  const seam = probeSeam();
  const runOnce = (prefix) => dispatchV2Action({
    action: { id: `stall-fallback-${prefix}`, lane: 'build', effort: 'low' },
    taskText: 'perform the bounded fixture dispatch',
    targetDir: home,
    paths: pathsFor(prefix),
    pools: [staller, answerer],
    bullswarmDir: home,
    silenceTimeoutSec: 2,
    maxMechanicalRetries: 1,
    dependencies: { probeFreeModel: seam.probeFreeModel },
  });
  try {
    const first = await runOnce('first');
    assert.equal(first.ok, true);
    assert.deepEqual(first.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    assert.equal(first.attempts[0].failureKind, 'stalled');
    assert.equal(first.attempts[0].stalled, true);
    assert.equal(first.attempts[0].silentSec, 2);
    assert.equal(first.attempts[0].routeWhy.startsWith('fallback from'), false);
    assert.ok(existsSync(first.attempts[0].partialOutput));
    assert.match(readFileSync(first.attempts[0].partialOutput, 'utf8'), /## Partial/);
    assert.match(first.attempts[1].routeWhy, /^fallback from staller after stall 2s · /);
    assert.deepEqual(listAssignments(home), []);
    assert.equal(loadState(home).pools.staller.bench.count, 1);
    assert.equal(loadState(home).pools.staller.bench.until, null);

    const second = await runOnce('second');
    assert.equal(second.ok, true);
    assert.deepEqual(second.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    assert.equal(second.attempts[0].failureKind, 'stalled');
    const bench = loadState(home).pools.staller.bench;
    assert.equal(bench.reason, 'stall');
    assert.equal(bench.count, 2);
    assert.ok(Number.isFinite(bench.until) && bench.until > Date.now());
    assert.deepEqual(listAssignments(home), []);

    const third = await runOnce('third');
    assert.equal(third.ok, true);
    assert.deepEqual(third.attempts.map((attempt) => attempt.pool), ['answerer']);
    assert.match(third.attempts[0].routeWhy, /benched \(stall, back at /);
    // Only the free rung was probed, and only on the two dispatches that
    // actually reached it: the benched third dispatch never probes.
    assert.deepEqual(seam.calls, ['staller:zen/union-free', 'staller:zen/union-free']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stalled attempt survives the durable-state validator with its partial output', () => {
  const goal = createV2GoalDocument({
    goal: 'Free pool stalls', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Do the thing' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-stall', shortId: 'stl123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: [], ownedFiles: [],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 2, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  // The attempt the free pool stalled on, exactly as normalizeAttempt writes it:
  // `stalled`, the partial file kept on disk, and the threshold that ended it.
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'interrupted',
    pool: 'staller', model: 'zen/union-free', startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z', failureKind: 'stalled',
    why: 'stalled: the worker wrote nothing for 8 s and was stopped',
    stalled: true, partialOutput: '/tmp/out-do-work-attempt-1.md', silentSec: 8,
  }, {
    id: 'do-work-2', actionId: 'do-work', ordinal: 2, status: 'succeeded',
    pool: 'answerer', model: 'paid/answerer', startedAt: '2026-09-17T02:30:29.000Z',
    finishedAt: '2026-09-17T02:30:30.000Z',
  }];
  const loaded = deserializeV2DurableState(JSON.stringify(state));
  assert.equal(loaded.attempts[0].stalled, true);
  assert.equal(loaded.attempts[0].partialOutput, '/tmp/out-do-work-attempt-1.md');
  assert.equal(loaded.attempts[0].silentSec, 8);
  // An attempt recorded before the stall clock existed carries none of them.
  assert.equal(loaded.attempts[1].stalled, undefined);
});

test('the tracked diff stat keeps every row exactly as git printed it, leading space included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-diffstat-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    writeFileSync(join(dir, 'doomed.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, 'owned.txt'), 'one\n');
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'seed');
    writeFileSync(join(dir, 'doomed.txt'), 'one\n');
    writeFileSync(join(dir, 'owned.txt'), 'one\ntwo\n');
    const stat = trackedDiffStatForTests(dir, ['doomed.txt', 'owned.txt'], execFileSync);
    const rows = stat.split('\n');
    assert.equal(rows.length, 3, stat);
    // git indents every file row and the summary row by one space; the first
    // row used to lose it to a .trim() and sit misaligned against the rest.
    for (const row of rows) assert.match(row, /^ /, JSON.stringify(row));
    assert.match(rows[0], /^ doomed\.txt\s+\|\s+1 -$/);
    assert.match(rows[1], /^ owned\.txt\s+\|\s+1 \+$/);
    assert.match(rows[2], /^ 2 files changed, 1 insertion\(\+\), 1 deletion\(-\)$/);
    assert.doesNotMatch(stat, /\n$/, 'no trailing newline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoffBlock is a pure template over on-disk facts', () => {
  const block = handoffBlock({
    pool: 'staller',
    model: 'zen/union-free',
    startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'stalled',
    why: 'stalled: the worker wrote nothing for 8 s and was stopped',
    diffStatText: ' owned.txt | 1 +\n 1 file changed, 1 insertion(+)',
    diffFile: '/tmp/run/diff-do-work-attempt-1.txt',
    changedFiles: ['owned.txt'],
    outputFile: '/tmp/run/out-do-work-attempt-1.md',
    outputBytes: 88,
    streamFile: null,
    lastEvents: [
      { at: '2026-09-17T02:30:21.000Z', kind: 'response', summary: 'reading owned.txt' },
      { at: '2026-09-17T02:30:22.000Z', kind: 'response', summary: 'editing owned.txt' },
      { at: '2026-09-17T02:30:23.000Z', kind: 'response', summary: 'going quiet' },
    ],
  });
  assert.match(block, /^## Prior attempt on this step\n/);
  assert.match(block, /^- Pool: staller$/m);
  assert.match(block, /^- Model: zen\/union-free$/m);
  assert.match(block, /^- Duration: 8s$/m);
  assert.match(block, /^- Failure: stalled — stalled: the worker wrote nothing for 8 s and was stopped$/m);
  assert.match(block, /owned\.txt/);
  assert.match(block, /out-do-work-attempt-1\.md \(88 bytes\)/);
  assert.match(block, /Stream file: no stream recorded/);
  assert.match(block, /2026-09-17T02:30:23\.000Z: going quiet/);
  assert.match(block, /Those edits are unverified\. You decide whether to keep, fix or revert them, and you must report which\./);
  assert.doesNotMatch(block, /inlined stream/i);
});

test('handoffBlock identifies connector-default models without guessing a model name', () => {
  assert.match(handoffBlock({ pool: 'codex', model: null }), /^- Model: codex connector default$/m);
  assert.match(handoffBlock({ pool: 'claude-code:acme', model: null }), /^- Model: claude-code:acme connector default$/m);
  assert.match(handoffBlock({ pool: null, model: null }), /^- Model: unknown$/m);
});

test('handoffBlock says why no response events were decoded for a pool without an eventStream', () => {
  const block = handoffBlock({
    pool: 'plain-cli', model: null, startedAt: '2026-09-17T02:30:20.000Z', finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'provider', why: 'provider stream reported error', diffStatText: '', changedFiles: [],
    streamFile: '/tmp/run/stdout-do-work-attempt-1.log', hasEventStream: false, lastEvents: [],
  });
  assert.match(block, /^- Last response events: none decoded \(the plain-cli connector declares no eventStream; see the stream file\)$/m);
  // A pool that does declare one and simply said nothing gets no such line.
  const quiet = handoffBlock({ pool: 'codex', hasEventStream: true, lastEvents: [] });
  assert.doesNotMatch(quiet, /Last response events/);
});

test('a multi-line response stays one list item so it cannot break out of the block', () => {
  const block = handoffBlock({
    pool: 'staller',
    model: 'zen/union-free',
    startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z',
    failureKind: 'stalled',
    why: 'stalled',
    diffStatText: '',
    changedFiles: [],
    streamFile: '/tmp/run/stream-do-work-attempt-1.jsonl',
    lastEvents: [
      { at: '2026-09-17T02:30:23.000Z', kind: 'response', summary: '## Partial\n\nEnumerated 3 files\nbefore going quiet.' },
    ],
  });
  const lines = block.split('\n');
  const heading = lines.filter((line) => line.startsWith('## '));
  assert.deepEqual(heading, ['## Prior attempt on this step'], 'a response heading must not become a block heading');
  assert.ok(lines.includes('  - 2026-09-17T02:30:23.000Z: ## Partial Enumerated 3 files before going quiet.'));
  // The closing sentence is still the last line, not orphaned by a spill.
  assert.match(lines.at(-1), /^- Those edits are unverified\./);
});

test('schema correction keeps its own block and does not append the prior-attempt handoff', async () => {
  const tasks = [];
  const pool = connector('luna-1', { conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] } });
  const h = harness([
    () => ({ ok: false, why: 'invalid', failureKind: 'schema', structured: { errors: ['bad'] }, meta: { exitCode: 0 } }),
    good,
  ]);
  const inner = h.dependencies.watchOnce;
  h.dependencies.watchOnce = async (c, task, dir, paths, opts) => {
    tasks.push(task);
    return inner(c, task, dir, paths, opts);
  };
  const result = await dispatchV2Action({
    action, taskText: 'plan', targetDir: '/tmp', paths, pools: [pool],
    bullswarmDir: '/tmp/bs', outputValidator: () => ({ ok: true }),
    correctionTask: () => 'correct it', currentSession: null, dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(tasks, ['plan', 'correct it']);
  assert.doesNotMatch(tasks[1], /## Prior attempt on this step/);
});

test('a mechanical fallback appends the prior-attempt handoff to the next task', async () => {
  const tasks = [];
  const h = harness([
    { ok: false, failureKind: 'provider', why: 'empty output', meta: { exitCode: 1 } },
    good,
  ]);
  const inner = h.dependencies.watchOnce;
  h.dependencies.watchOnce = async (c, task, dir, paths, opts) => {
    tasks.push(task);
    return inner(c, task, dir, paths, opts);
  };
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(result.ok, true);
  assert.equal(tasks[0], 'do it');
  assert.match(tasks[1], /## Prior attempt on this step/);
  assert.match(tasks[1], /Pool: luna-1/);
  assert.match(tasks[1], /Failure: provider — empty output/);
  assert.match(tasks[1], /Stream file: no stream recorded/);
  assert.match(tasks[1], /Those edits are unverified/);
  assert.equal(result.attempts[1].handoff.from, 'do-work-1');
  assert.ok(result.attempts[1].handoff.bytes > 0);
  assert.equal(result.attempts[1].handoff.bytes, Buffer.byteLength(tasks[1].slice(tasks[1].indexOf('## Prior attempt on this step')), 'utf8'));
});

test('a free stall falls back with a frozen diff snapshot of the prior attempt', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-handoff-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  const fixturePool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  const seam = probeSeam();
  try {
    const result = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'perform the bounded fixture dispatch',
      targetDir: repo,
      paths: (ordinal) => ({
        taskFile: join(home, `task-do-work-attempt-${ordinal}.md`),
        outFile: join(home, `out-do-work-attempt-${ordinal}.md`),
      }),
      pools: [
        fixturePool('staller', stallerWorker, 'zen/union-free', { free: true }),
        fixturePool('answerer', answererWorker, 'paid/answerer'),
      ],
      bullswarmDir: home,
      silenceTimeoutSec: 2,
      maxMechanicalRetries: 1,
      dependencies: { probeFreeModel: seam.probeFreeModel },
      onAttempt: (stage, record) => {
        if (stage === 'started' && record.ordinal === 2) {
          writeFileSync(join(repo, 'owned.txt'), `${readFileSync(join(repo, 'owned.txt'), 'utf8')}answerer edit\n`);
        }
        if (stage === 'finished' && record.ordinal === 1) {
          writeFileSync(join(repo, 'owned.txt'), `${readFileSync(join(repo, 'owned.txt'), 'utf8')}SIBLING EDIT AFTER ATTEMPT END\n`);
          writeFileSync(join(repo, 'later.txt'), 'later sibling\n');
        }
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['staller', 'answerer']);
    const task2 = readFileSync(join(home, 'task-do-work-attempt-2.md'), 'utf8');
    assert.match(task2, /## Prior attempt on this step/);
    assert.match(task2, /Pool: staller/);
    assert.match(task2, /owned\.txt/);
    assert.match(task2, /out-do-work-attempt-1\.md/);
    assert.match(task2, /Those edits are unverified/);
    assert.doesNotMatch(task2, /SIBLING EDIT AFTER ATTEMPT END/);
    assert.doesNotMatch(task2, /later\.txt/);
    assert.doesNotMatch(task2, /Your prior final structured output failed/);
    const diff1 = readFileSync(join(home, 'diff-do-work-attempt-1.txt'), 'utf8');
    assert.match(diff1, /owned\.txt/);
    assert.doesNotMatch(diff1, /later\.txt/);
    assert.doesNotMatch(diff1, /SIBLING EDIT AFTER ATTEMPT END/);
    assert.equal(result.attempts[0].diffFile, join(home, 'diff-do-work-attempt-1.txt'));
    assert.ok(result.attempts[0].outputBytes > 0);
    assert.equal(result.attempts[0].outputFile, join(home, 'out-do-work-attempt-1.md'));
    assert.equal(result.attempts[1].handoff.from, 'do-work-1');
    assert.ok(result.attempts[1].handoff.bytes > 0);
    assert.deepEqual(seam.calls, ['staller:zen/union-free'], 'the paid fallback is never probed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff attribution compares bytes, including new, pre-dirty, staged and deleted files, but not outside files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-diff-attribution-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const tracked = ['owned.txt', 'deleted.txt', 'outside.txt'];
  for (const file of tracked) writeFileSync(join(repo, file), `${file} base\n`);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'add', ...tracked]);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);

  // This is deliberately dirty before dispatch. The attempt must still be
  // credited for the bytes it adds, rather than subtracting the whole path.
  writeFileSync(join(repo, 'owned.txt'), 'owned.txt base\npre-dirty\n');
  const h = harness([
    ({ paths }) => {
      writeFileSync(join(repo, 'owned.txt'), 'owned.txt base\npre-dirty\nduring-attempt\n');
      // Staging must not hide the byte change from the snapshot.
      execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
      writeFileSync(join(repo, 'new-owned.txt'), 'line one\nline two\n');
      rmSync(join(repo, 'deleted.txt'));
      writeFileSync(join(repo, 'outside.txt'), 'outside changed\n');
      // The stub still returns a normal failed worker verdict; output paths
      // are irrelevant to this diff-only assertion.
      return { ok: false, failureKind: 'provider', why: 'empty output', meta: { exitCode: 1 } };
    },
    () => {
      writeFileSync(join(repo, 'owned.txt'), `${readFileSync(join(repo, 'owned.txt'), 'utf8')}accepted attempt\n`);
      return good;
    },
  ]);
  try {
    const result = await dispatchV2Action({
      action: {
        id: 'diff-work', lane: 'build', effort: 'low',
        ownedFiles: ['owned.txt', 'new-owned.txt', 'deleted.txt'],
      },
      taskText: 'attribute the attempt',
      targetDir: repo,
      paths: {
        taskFile: join(home, 'task-diff-work.md'),
        outFile: join(home, 'out-diff-work.md'),
      },
      pools: [connector('luna-1'), connector('luna-2')],
      bullswarmDir: home,
      dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].changedFileCount, 3);
    const diff = readFileSync(result.attempts[0].diffFile, 'utf8');
    assert.match(diff, /owned\.txt/);
    assert.match(diff, /deleted\.txt/);
    assert.match(diff, /new-owned\.txt \| \+2 lines \(new\)/);
    assert.doesNotMatch(diff, /outside\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The two halves as one feature: the sink writes the per-attempt stream, the
// dispatcher records its path, and the handoff block's last-three responses are
// read back out of that same file rather than out of kernel memory.
test('the persisted stream feeds the handoff block on a real fixture fallback', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-handoff-stream-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const stallerWorker = new URL('./fixtures/stalling-connector.mjs', import.meta.url).pathname;
  const answererWorker = new URL('./fixtures/answering-connector.mjs', import.meta.url).pathname;
  // The codex line shape, verbatim from the shipped manifest: the fixture
  // workers speak it under BULLSWARM_FIXTURE_EVENTS=jsonl.
  const eventStream = JSON.parse(readFileSync(
    new URL('../src/providers/codex/connector.json', import.meta.url), 'utf8',
  )).eventStream;
  const streamingPool = (name, worker, model, extra = {}) => ({
    name,
    enabled: true,
    costRank: name === 'staller' ? 1 : 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    spawn: { cmd: [process.execPath, worker, '{taskFile}'] },
    outputExtraction: { strategy: 'event-stream' },
    eventStream: { ...eventStream, args: [] },
    meter: { type: 'none' },
    model,
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: name, model } },
    ...extra,
  });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  saveState(home, {
    version: 1,
    pools: { staller: { enabled: true }, answerer: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  const seam = probeSeam();
  try {
    const result = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low', ownedFiles: ['owned.txt'] },
      taskText: 'perform the bounded fixture dispatch',
      targetDir: repo,
      paths: (ordinal) => ({
        taskFile: join(home, `task-do-work-attempt-${ordinal}.md`),
        outFile: join(home, `out-do-work-attempt-${ordinal}.md`),
      }),
      pools: [
        streamingPool('staller', stallerWorker, 'zen/union-free', { free: true }),
        streamingPool('answerer', answererWorker, 'paid/answerer'),
      ],
      bullswarmDir: home,
      parentEnv: { ...process.env, BULLSWARM_FIXTURE_EVENTS: 'jsonl' },
      silenceTimeoutSec: 2,
      maxMechanicalRetries: 1,
      dependencies: { probeFreeModel: seam.probeFreeModel },
      onAttempt: (stage, record) => {
        if (stage === 'started' && record.ordinal === 2) {
          writeFileSync(join(repo, 'owned.txt'), `${readFileSync(join(repo, 'owned.txt'), 'utf8')}answerer edit\n`);
        }
      },
    });
    assert.equal(result.ok, true);
    const streamFile = join(home, 'stream-do-work-attempt-1.jsonl');
    assert.equal(result.attempts[0].streamFile, streamFile, 'the dispatcher records the file the sink wrote');
    const rows = readFileSync(streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) {
      for (const key of ['seq', 'at', 'source', 'providerType', 'kind', 'status', 'summary']) {
        assert.ok(Object.hasOwn(row, key), `stream row missing ${key}`);
      }
      assert.match(row.at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    const responses = rows.filter((row) => row.kind === 'response');
    assert.ok(responses.length >= 3, 'the fixture speaks at least three responses');
    assert.equal(result.attempts[0].lastResponse, responses.at(-1).summary);

    const task2 = readFileSync(join(home, 'task-do-work-attempt-2.md'), 'utf8');
    assert.match(task2, new RegExp(`- Stream file: ${streamFile.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}$`, 'm'));
    // Every one of the last three responses is in the block, on its own line,
    // with the timestamp the sink stamped.
    for (const row of responses.slice(-3)) {
      assert.ok(
        task2.includes(`  - ${row.at}: ${row.summary.replace(/\s+/g, ' ').trim()}`),
        `block is missing the response at ${row.at}`,
      );
    }
    // The stream is referenced by path, never inlined.
    assert.ok(!task2.includes('"providerType"'), 'the stream must not be inlined into the task');
    assert.deepEqual(seam.calls, ['staller:zen/union-free'], 'the paid fallback is never probed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// quota.js Q6: a transient limit retries the same pool after a short backoff,
// then falls over for this attempt only; the pool is never paused.

const transientVerdict = (extra = {}) => ({
  ok: false,
  failureKind: 'throttle',
  throttleWaitMs: null,
  throttleRetrySamePool: true,
  quotaPause: { pause: false, rule: 'transient', line: 'Error: Rate limit exceeded. Please wait a moment and try again.' },
  why: 'rate limited (transient): "Error: Rate limit exceeded. Please wait a moment and try again." · pool not paused',
  meta: { exitCode: 1, wallSec: 0.2 },
  ...extra,
});

test('a transient limit retries the same pool after a short backoff and never pauses it', async () => {
  const h = harness([transientVerdict(), good]);
  const slept = [];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: { ...h.dependencies, sleep: async (ms) => { slept.push(ms); } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-1']);
  assert.deepEqual(slept, [20_000]);
  assert.equal(h.core.pools['luna-1']?.quarantine, undefined, 'a throttle never pauses the pool');
});

test('two throttles fall over to another pool for this attempt only, still with no pause', async () => {
  const h = harness([transientVerdict(), transientVerdict(), transientVerdict(), good]);
  const slept = [];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: { ...h.dependencies, sleep: async (ms) => { slept.push(ms); } },
  });
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool).slice(0, 3), ['luna-1', 'luna-1', 'luna-1']);
  assert.deepEqual(slept, [20_000, 60_000]);
  assert.ok(result.attempts.slice(3).every((attempt) => attempt.pool === 'luna-2'), result.attempts.map((a) => a.pool).join(','));
  assert.equal(h.core.pools['luna-1']?.quarantine, undefined);
});

test('a throttle naming a wait too long to sit out falls over at once, with no pause', async () => {
  const h = harness([transientVerdict({ throttleWaitMs: 5 * 3600_000, throttleRetrySamePool: false }), good]);
  const slept = [];
  const result = await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')],
    bullswarmDir: '/tmp/bs', dependencies: { ...h.dependencies, sleep: async (ms) => { slept.push(ms); } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-2']);
  assert.deepEqual(slept, []);
  assert.equal(h.core.pools['luna-1']?.quarantine, undefined);
});

test('a quota verdict without its proof pauses nothing (quota.js Q6)', async () => {
  const unproven = quotaVerdict();
  delete unproven.quotaPause;
  const h = harness([unproven, good]);
  await dispatchV2Action({
    action, taskText: 'do it', targetDir: '/tmp', paths,
    pools: [connector('luna-1'), connector('luna-2')], bullswarmDir: '/tmp/bs', dependencies: h.dependencies,
  });
  assert.equal(h.core.pools['luna-1']?.quarantine, undefined);
});

// --- stage 2: evidence inside dispatch (E4, E13-E17, E30) --------------------
// Fake workers, the real evidence runner (real /bin/sh checks) and throwaway
// git repos or plain folders.

// A report step whose checks read its own final response, so a fake worker
// decides pass or fail by what it writes to the out file.
const reportStep = (evidence, extra = {}) => ({
  id: 'ev-report', role: 'investigate', lane: 'analyze', effort: 'medium',
  deliverable: { type: 'report' }, evidence, ...extra,
});
const failsUntilFixed = { type: 'command', cmd: 'grep -q fixed "$BULLSWARM_STEP_OUTPUT" || (echo \'first run: marker missing\'; exit 1)' };
const answer = (text, verdict = good) => ({ paths }) => {
  writeFileSync(paths.outFile, text);
  return verdict;
};
const textFailure = { ok: false, why: 'failure pattern: ENOENT: no such file or directory', meta: { exitCode: 0, wallSec: 1 } };
const passedRunner = (calls = []) => async (items, opts) => {
  calls.push({ items, opts });
  return {
    results: items.map((item) => ({ type: 'command', cmd: item.cmd, timeoutSec: 120, status: 'passed', exit: 0, durationMs: 1, tail: '', why: null })),
    failed: false, stopped: false, checkFault: false, why: null, createdOutOfScope: [],
  };
};

// One dispatch with its seams recorded: the task each attempt was handed, the
// onAttempt stages, the onEvidence events and the core state.
async function withEvidence(prefix, {
  action: step, watches, pools = [connector('sample-pool')], prepare, plain = false, dependencies: extraDeps = {}, ...dispatch
}, check) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = plain ? join(root, 'plain') : gitWorkspace(root);
  if (plain) mkdirSync(repo, { recursive: true });
  const home = join(root, 'home');
  mkdirSync(home);
  const tasks = [];
  const lifecycle = [];
  const events = [];
  try {
    if (prepare) prepare(repo);
    const verdicts = typeof watches === 'function' ? watches(repo) : watches;
    const h = harness(verdicts);
    const inner = h.dependencies.watchOnce;
    h.dependencies.watchOnce = async (c, task, dir, p, opts) => { tasks.push(task); return inner(c, task, dir, p, opts); };
    const result = await dispatchV2Action({
      action: step,
      taskText: 'do the step',
      targetDir: repo,
      paths: (ordinal) => ({
        taskFile: join(home, `task-${step.id}-attempt-${ordinal}.md`),
        outFile: join(home, `out-${step.id}-attempt-${ordinal}.md`),
      }),
      pools,
      bullswarmDir: home,
      onAttempt: (stage, record) => lifecycle.push({ stage, record }),
      onEvidence: (event) => events.push(event),
      ...dispatch,
      dependencies: { ...h.dependencies, ...extraDeps },
    });
    await check({ result, repo, home, tasks, lifecycle, events, core: h.core, clock: h.dependencies.now });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A seeded shuffle, so each pinning round sees a different launch order.
function shuffled(list, seed) {
  const out = [...list];
  let state = seed + 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('evidence: classifyFailure maps failed-evidence, and both schema paths keep their kind', () => {
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'failed-evidence', why: 'x → exit 1' }), 'failed-evidence');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'failed-evidence', why: 'x', meta: { exitCode: 1 } }), 'failed-evidence');
  assert.equal(classifyV2DispatchFailure({ ok: false, cancelled: true, why: 'evidence stopped' }), 'cancelled');
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'schema', why: 'invalid' }), 'schema');
  assert.equal(classifyV2DispatchFailure(textFailure), 'semantic');
});

test('evidence: a passing check keeps the verdict ok and the attempt carries evidenceResults', async () => {
  await withEvidence('bs-ev-pass-', {
    action: reportStep([{ type: 'command', cmd: 'test "$BULLSWARM_EVIDENCE" = 1 && test "$BULLSWARM_STEP_ID" = ev-report && test -s "$BULLSWARM_STEP_OUTPUT" && echo checked' }]),
    watches: [answer('fixed report\n')],
    plain: true,
  }, ({ result, home, events, lifecycle }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 1);
    const [attempt] = result.attempts;
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.failureKind, null);
    assert.equal(attempt.evidenceResults.length, 1);
    const [item] = attempt.evidenceResults;
    assert.equal(item.status, 'passed');
    assert.equal(item.exit, 0);
    assert.equal(item.why, null);
    assert.equal(item.tail, 'checked');
    assert.equal(item.log, join(home, 'evidence-ev-report-attempt-1-1.log'));
    assert.ok(existsSync(item.log));
    // The completion receipt is written from this verdict (E31).
    assert.deepEqual(result.verdict.evidenceResults, attempt.evidenceResults);
    const finished = lifecycle.find((entry) => entry.stage === 'finished').record;
    assert.deepEqual(finished.evidenceResults, attempt.evidenceResults);
    assert.deepEqual(events.filter((event) => event.stage !== 'running').map((event) => [event.actionId, event.stage, event.index, event.of]), [
      ['ev-report', 'started', 1, 1],
      ['ev-report', 'finished', 1, 1],
    ]);
  });
});

test('evidence: a failed check retries once on the same pool, with the failure attached, while another pool ranks higher', { timeout: 60_000 }, async () => {
  const names = ['pool-a', 'pool-b', 'pool-c'];
  // After attempt 1 the meters say pool-a is the worst choice. Without the
  // pin the router would move the retry (checked directly first).
  const flipped = (order) => order.map((name) => connector(name, { pace: name === 'pool-a' ? -90 : 90 }));
  assert.notEqual(pickPool('analyze', flipped(names), { callerEligible: false, callerSession: false, effortTier: 'medium' }).pick.pool, 'pool-a');
  for (let round = 0; round < 20; round += 1) {
    const order = shuffled(names, round);
    const launch = order.map((name) => connector(name, { pace: name === 'pool-a' ? 90 : -90 }));
    const refreshCalls = [];
    const facts = [];
    await withEvidence('bs-ev-pin-', {
      action: reportStep([failsUntilFixed]),
      watches: [answer('broken\n'), answer('fixed\n')],
      plain: true,
      pools: launch,
      refreshPools: async (opts) => { refreshCalls.push(opts); return refreshCalls.length === 1 ? launch : flipped(shuffled(order, round + 7)); },
      handoffBlock: (value) => { facts.push(value); return handoffBlock(value); },
    }, ({ result, tasks }) => {
      assert.equal(result.ok, true, `round ${round}`);
      assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['pool-a', 'pool-a'], `round ${round}: ${order}`);
      // One forced refresh decided (d), and the pinned pick reused it.
      assert.deepEqual(refreshCalls, [{ force: false }, { force: true }], `round ${round}`);
      assert.match(result.attempts[1].routeWhy, /^retry on the same pool after failed evidence · /);
      if (round > 0) return;
      const [first, second] = result.attempts;
      assert.equal(first.status, 'interrupted');
      assert.equal(first.willRetry, true);
      assert.equal(first.failureKind, 'failed-evidence');
      // The label is the cmd cut at a word boundary to 80 characters.
      assert.equal(first.why, 'grep -q fixed "$BULLSWARM_STEP_OUTPUT" || (echo \'first run: marker missing\';… → exit 1: first run: marker missing');
      assert.equal(first.evidenceResults[0].status, 'failed');
      assert.equal(second.status, 'succeeded');
      assert.equal(second.evidenceResults[0].status, 'passed');
      assert.equal(second.handoff.from, 'ev-report-1');
      assert.equal(tasks[0], 'do the step');
      assert.match(tasks[1], /## Prior attempt on this step/);
      assert.match(tasks[1], /- Failure: failed-evidence — /);
      assert.match(tasks[1], /Evidence Bullswarm ran after that attempt/);
      assert.match(tasks[1], /first run: marker missing/);
      assert.equal(facts.length, 1);
      assert.deepEqual(facts[0].evidenceResults, first.evidenceResults);
      assert.equal(facts[0].failureKind, 'failed-evidence');
    });
  }
});

test('evidence: a check that fails twice fails the step on the same pool, and the decision log says failed-evidence', async () => {
  await withEvidence('bs-ev-twice-', {
    action: reportStep([failsUntilFixed]),
    watches: [answer('broken\n'), answer('still broken\n')],
    plain: true,
    pools: [connector('pool-a'), connector('pool-b')],
    preferredPool: 'pool-a',
  }, ({ result, core }) => {
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureKind, 'failed-evidence');
    assert.deepEqual(result.attempts.map((attempt) => [attempt.pool, attempt.status]), [['pool-a', 'interrupted'], ['pool-a', 'failed']]);
    assert.equal(result.attempts[1].willRetry, false);
    assert.doesNotMatch(result.attempts[1].why, /no retry|not retried/);
    const rows = core.decisionLog.filter((row) => row.actionId === 'ev-report');
    assert.deepEqual(rows.map((row) => [row.ok, row.failureKind]), [[false, 'failed-evidence'], [false, 'failed-evidence']]);
    assert.equal(rows[0].ts, result.attempts[0].finishedAt);
  });
});

test('evidence: no retry when the runtime says the step already used it, or when --retry-attempts is 0', async () => {
  for (const options of [{ evidenceRetryAvailable: false }, { maxMechanicalRetries: 0 }]) {
    const refreshCalls = [];
    await withEvidence('bs-ev-noretry-', {
      action: reportStep([failsUntilFixed]),
      watches: [answer('broken\n'), answer('fixed\n')],
      plain: true,
      refreshPools: async (opts) => { refreshCalls.push(opts); return null; },
      ...options,
    }, ({ result }) => {
      assert.equal(result.failureKind, 'failed-evidence', JSON.stringify(options));
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].status, 'failed');
      assert.equal(result.attempts[0].willRetry, false);
      assert.match(result.attempts[0].why, /→ exit 1: first run: marker missing$/);
      assert.deepEqual(refreshCalls, [{ force: false }], 'no forced refresh without a retry to decide');
    });
  }
});

test('evidence: a pool quarantined between the attempts gets no retry, and the stored attempt never promised one', async () => {
  const refreshCalls = [];
  await withEvidence('bs-ev-quarantine-', {
    action: reportStep([failsUntilFixed]),
    watches: [answer('broken\n'), answer('fixed\n')],
    plain: true,
    pools: [connector('pool-a', { pace: 90 }), connector('pool-b', { pace: -90 })],
    refreshPools: async (opts) => {
      refreshCalls.push(opts);
      return refreshCalls.length === 1
        ? [connector('pool-a', { pace: 90 }), connector('pool-b', { pace: -90 })]
        : [connector('pool-a', { quarantine: { until: Date.parse('2027-01-01T00:00:00Z'), reason: 'auth' } }), connector('pool-b')];
    },
  }, ({ result, lifecycle }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    assert.equal(result.attempts.length, 1, 'no other pool is tried');
    const [attempt] = result.attempts;
    assert.equal(attempt.pool, 'pool-a');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.willRetry, false);
    assert.match(attempt.why, /→ exit 1: first run: marker missing · no retry: pool-a is no longer eligible$/);
    const finished = lifecycle.filter((entry) => entry.stage === 'finished').map((entry) => entry.record);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, 'failed');
    assert.equal(finished[0].willRetry, false);
    assert.deepEqual(refreshCalls, [{ force: false }, { force: true }]);
    assert.equal(lifecycle.some((entry) => entry.stage === 'corrected'), false);
  });
});

test('evidence: a pinned pick that finds no pool after the refresh corrects the stored attempt and tries nothing else', async () => {
  const picks = [];
  await withEvidence('bs-ev-race-', {
    action: reportStep([failsUntilFixed]),
    watches: [answer('broken\n'), answer('fixed\n')],
    plain: true,
    pools: [connector('pool-a', { pace: 90 }), connector('pool-b', { pace: -90 }), connector('pool-c', { pace: -90 })],
    dependencies: {
      pickPool: (lane, list, opts) => {
        picks.push({ names: list.map((entry) => entry.name), strictPool: opts.strictPool });
        return picks.length === 1 ? pickPool(lane, list, opts) : { pick: null, why: 'no eligible pool', candidates: [] };
      },
    },
  }, ({ result, lifecycle }) => {
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureKind, 'failed-evidence');
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(picks.map((pick) => pick.strictPool), [null, 'pool-a']);
    assert.deepEqual(picks[1].names, ['pool-a']);
    const suffix = ' · no retry: pool-a is no longer eligible';
    assert.ok(result.verdict.why.endsWith(suffix), result.verdict.why);
    assert.equal(result.attempts[0].status, 'failed');
    assert.equal(result.attempts[0].willRetry, false);
    assert.ok(result.attempts[0].why.endsWith(suffix));
    assert.deepEqual(lifecycle.map((entry) => entry.stage), ['started', 'finished', 'corrected']);
    assert.equal(lifecycle[1].record.status, 'interrupted');
    assert.equal(lifecycle[1].record.willRetry, true);
    const corrected = lifecycle[2].record;
    assert.equal(corrected.status, 'failed');
    assert.equal(corrected.willRetry, false);
    assert.ok(corrected.why.endsWith(suffix));
    assert.equal(corrected.evidenceResults[0].status, 'failed');
  });
});

test('evidence: a failed check on an act step goes to the caller at once, with no forced refresh', async () => {
  const refreshCalls = [];
  await withEvidence('bs-ev-act-', {
    action: {
      id: 'announce', role: 'act', lane: 'analyze', effort: 'medium',
      deliverable: { type: 'outward' }, evidence: [{ type: 'command', cmd: 'test -f outbox.txt' }],
    },
    watches: [answer('posted\n'), answer('posted again\n')],
    plain: true,
    refreshPools: async (opts) => { refreshCalls.push(opts); return null; },
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 'failed');
    assert.equal(result.attempts[0].why, 'test -f outbox.txt → exit 1 · act steps are not retried');
    assert.deepEqual(refreshCalls, [{ force: false }]);
  });
});

test('evidence: a check that could not run goes to the caller, and a missing data file gets the normal retry', async () => {
  await withEvidence('bs-ev-fault-', {
    action: reportStep([{ type: 'schema', file: 'data.json', schema: 'schemas/event.json' }]),
    watches: [answer('done\n'), answer('done again\n')],
    plain: true,
    prepare: (dir) => writeFileSync(join(dir, 'data.json'), '{"a":1}\n'),
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 'failed');
    assert.match(result.attempts[0].why, /^check could not run: schema schemas\/event\.json on data\.json → schema missing/);
    assert.doesNotMatch(result.attempts[0].why, / · /);
    assert.equal(result.attempts[0].evidenceResults[0].fault, 'check');
    assert.equal(result.attempts[0].evidenceResults[0].exit, 2);
  });
  await withEvidence('bs-ev-data-', {
    action: reportStep([{ type: 'schema', file: 'data.json', schema: 'schemas/event.json' }]),
    watches: (dir) => [
      answer('done\n'),
      ({ paths: p }) => { writeFileSync(join(dir, 'data.json'), '{"a":1}\n'); writeFileSync(p.outFile, 'done\n'); return good; },
    ],
    plain: true,
    prepare: (dir) => {
      mkdirSync(join(dir, 'schemas'));
      writeFileSync(join(dir, 'schemas', 'event.json'), '{"type":"object","required":["a"]}\n');
    },
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].failureKind, 'failed-evidence');
    assert.match(result.attempts[0].why, /^schema schemas\/event\.json on data\.json → file missing/);
    assert.equal(Object.hasOwn(result.attempts[0].evidenceResults[0], 'fault'), false);
    assert.equal(result.attempts[1].evidenceResults[0].status, 'passed');
  });
});

test('evidence: the gate runs first; a not-produced attempt and a failed worker run no evidence', async () => {
  const calls = [];
  await withEvidence('bs-ev-gate-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'true' }] }),
    watches: [answer('done\n')],
    evidenceRetryAvailable: true,
    dependencies: { runStepEvidence: passedRunner(calls) },
  }, ({ result }) => {
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(calls.length, 0);
    assert.equal(Object.hasOwn(result.attempts[0], 'evidenceResults'), false);
  });
  await withEvidence('bs-ev-worker-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'true' }] }),
    watches: [{ ok: false, failureKind: 'process', why: 'exit 1', meta: { exitCode: 1 } }],
    maxMechanicalRetries: 0,
    dependencies: { runStepEvidence: passedRunner(calls) },
  }, ({ result }) => {
    assert.equal(result.failureKind, 'process');
    assert.equal(calls.length, 0);
    assert.equal(Object.hasOwn(result.attempts[0], 'evidenceResults'), false);
  });
});

test('evidence: a text-only failure verdict does not skip the checks (E30)', async () => {
  // Passing check: the facts outrank the text, and the note says so.
  await withEvidence('bs-ev-text-pass-', {
    action: reportStep([{ type: 'command', cmd: 'true' }]),
    watches: [answer('ENOENT: no such file or directory\n', textFailure)],
    plain: true,
  }, ({ result }) => {
    assert.equal(result.ok, true);
    const [attempt] = result.attempts;
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.why, 'every evidence item passed');
    assert.equal(attempt.notes.length, 1);
    assert.equal(attempt.notes[0].kind, 'text-verdict');
    assert.equal(attempt.notes[0].text, 'the output read as failed (failure pattern: ENOENT: no such file or directory); every evidence item passed');
    assert.equal(typeof attempt.notes[0].at, 'string');
  });
  // Failing check: failed-evidence, and the note stays.
  await withEvidence('bs-ev-text-fail-', {
    action: reportStep([{ type: 'command', cmd: 'false' }]),
    watches: [answer('ENOENT: no such file or directory\n', textFailure)],
    plain: true,
    evidenceRetryAvailable: false,
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    assert.equal(result.attempts[0].why, 'false → exit 1');
    assert.equal(result.attempts[0].notes[0].kind, 'text-verdict');
  });
  // A no-op worker on a files deliverable: not-produced, and no checks run.
  const calls = [];
  await withEvidence('bs-ev-text-noop-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'true' }] }),
    watches: [answer('ENOENT: no such file or directory\n', textFailure)],
    dependencies: { runStepEvidence: passedRunner(calls) },
  }, ({ result }) => {
    assert.equal(result.failureKind, 'not-produced');
    assert.equal(result.attempts[0].why, 'no file changed and no commit made');
    assert.equal(calls.length, 0);
  });
  // The same output on a step without evidence keeps today's rule.
  await withEvidence('bs-ev-text-none-', {
    action: reportStep(undefined),
    watches: [answer('ENOENT: no such file or directory\n', textFailure)],
    plain: true,
  }, ({ result }) => {
    assert.equal(result.failureKind, 'semantic');
    assert.equal(Object.hasOwn(result.attempts[0], 'evidenceResults'), false);
    assert.equal(Object.hasOwn(result.attempts[0], 'notes'), false);
  });
});

test('evidence: the retry continues the worker conversation', async () => {
  const seen = [];
  const pool = connector('pool-a', { conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] } });
  const talk = (text) => ({ paths: p, opts }) => { seen.push(opts.conversation); writeFileSync(p.outFile, text); return good; };
  await withEvidence('bs-ev-session-', {
    action: reportStep([failsUntilFixed]),
    watches: [talk('broken\n'), talk('fixed\n')],
    plain: true,
    pools: [pool],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    assert.equal(result.attempts[1].continued, true);
    assert.deepEqual(seen, [{ sessionId: 'session-fixed', resume: false }, { sessionId: 'session-fixed', resume: true }]);
  });
});

test('evidence: finishedAt is the worker end, and the diff file exists when the checks start (E4, E17)', async () => {
  const seen = [];
  const runner = async (items, opts) => {
    seen.push({ at: opts.now(), diffExists: existsSync(join(dirname(opts.logFileFor(1)), 'diff-write-work-attempt-1.txt')), cwd: opts.cwd, env: opts.env });
    return passedRunner()(items, opts);
  };
  await withEvidence('bs-ev-timing-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'true' }] }),
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
    dependencies: { runStepEvidence: runner },
  }, ({ result, core, repo, home }) => {
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].diffExists, true);
    assert.ok(Date.parse(result.attempts[0].finishedAt) < seen[0].at, 'finishedAt is taken before the runner starts');
    assert.equal(core.decisionLog.at(-1).ts, result.attempts[0].finishedAt);
    assert.equal(seen[0].cwd, realpathSync(repo));
    assert.equal(seen[0].env.BULLSWARM_EVIDENCE, '1');
    assert.equal(seen[0].env.BULLSWARM_STEP_ID, 'write-work');
    assert.equal(seen[0].env.BULLSWARM_RUN_DIR, home);
    assert.equal(seen[0].env.BULLSWARM_STEP_OUTPUT, join(home, 'out-write-work-attempt-1.md'));
  });
});

test('evidence: a stop during a check records it stopped and cancelled, never failed or retried', { timeout: 30_000 }, async () => {
  let stop = false;
  await withEvidence('bs-ev-cancel-', {
    action: reportStep([{ type: 'command', cmd: 'sleep 20' }, { type: 'command', cmd: 'true' }]),
    watches: [answer('done\n')],
    plain: true,
    shouldCancel: () => stop,
    onEvidence: (event) => { if (event.stage === 'started' && event.index === 1) setTimeout(() => { stop = true; }, 300); },
  }, ({ result }) => {
    assert.equal(result.status, 'cancelled');
    assert.equal(result.failureKind, 'cancelled');
    assert.equal(result.attempts.length, 1);
    const [attempt] = result.attempts;
    assert.equal(attempt.status, 'cancelled');
    assert.equal(attempt.why, 'evidence stopped');
    assert.equal(attempt.willRetry, false);
    assert.deepEqual(attempt.evidenceResults.map((item) => [item.status, item.why]), [['not-run', 'stopped'], ['not-run', 'stopped']]);
  });
});

test('evidence: a check that aborts on its own is a failed check, never a stop (E16)', { timeout: 30_000 }, async () => {
  await withEvidence('bs-ev-abort-', {
    action: reportStep([{ type: 'command', cmd: `"${process.execPath}" -e "process.abort()"` }]),
    watches: [answer('done\n')],
    plain: true,
    shouldCancel: () => false,
    evidenceRetryAvailable: false,
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    const [attempt] = result.attempts;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.evidenceResults[0].status, 'failed');
    assert.equal(attempt.evidenceResults[0].signal, 'SIGABRT');
    assert.match(attempt.why, /→ killed by SIGABRT/);
  });
});

test('evidence scope: a restricted step fails a check that edits its owned file', async () => {
  await withEvidence('bs-ev-restricted-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'echo more >> owned.txt' }, { type: 'command', cmd: 'true' }] }),
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
    evidenceRetryAvailable: false,
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    const items = result.attempts[0].evidenceResults;
    assert.equal(items[0].status, 'failed');
    assert.deepEqual(items[0].changed, ['owned.txt']);
    assert.deepEqual([items[1].status, items[1].why], ['not-run', 'not run: an earlier item changed the deliverable']);
    assert.equal(result.attempts[0].why, 'echo more >> owned.txt → changed the deliverable: owned.txt');
  });
});

test('evidence scope: an unrestricted writer reports untracked by-products and fails an edit to a tracked file', async () => {
  await withEvidence('bs-ev-unrestricted-', {
    action: { id: 'whole', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' },
      evidence: [{ type: 'command', cmd: 'echo "<x/>" > junit.xml' }, { type: 'command', cmd: 'echo more >> other.txt' }] },
    prepare: (dir) => {
      writeFileSync(join(dir, 'other.txt'), 'tracked\n');
      execFileSync('git', ['-C', dir, 'add', 'other.txt']);
      execFileSync('git', ['-C', dir, 'commit', '-qm', 'other']);
    },
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
    evidenceRetryAvailable: false,
  }, ({ result, repo }) => {
    const items = result.attempts[0].evidenceResults;
    assert.deepEqual([items[0].status, items[0].touched], ['passed', ['junit.xml']]);
    assert.deepEqual([items[1].status, items[1].changed], ['failed', ['other.txt']]);
    assert.equal(result.failureKind, 'failed-evidence');
    assert.ok(existsSync(join(repo, 'junit.xml')), 'nothing is removed in a shared workspace');
  });
});

test('evidence scope: an analyze step only guards its own output, and a commit is a fact', async () => {
  await withEvidence('bs-ev-other-', {
    action: reportStep([
      { type: 'command', cmd: 'echo more >> owned.txt' },
      { type: 'command', cmd: 'git commit -q --allow-empty -m sibling' },
    ]),
    watches: [answer('done\n')],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    const items = result.attempts[0].evidenceResults;
    assert.equal(items[0].status, 'passed');
    assert.equal(Object.hasOwn(items[0], 'changed'), false);
    assert.equal(items[1].status, 'passed');
    assert.equal(items[1].headMoved, true);
  });
});

test('evidence scope: a private copy removes what a passing check created, and fails an edit to a tracked file', async () => {
  await withEvidence('bs-ev-private-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'mkdir -p test-results && echo "<x/>" > test-results/junit.xml' }] }),
    privateWorkspace: true,
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
  }, ({ result, repo }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].evidenceResults[0].touched, ['test-results/junit.xml']);
    assert.equal(existsSync(join(repo, 'test-results', 'junit.xml')), false);
    assert.equal(existsSync(join(repo, 'test-results')), false, 'the emptied folder goes too');
  });
  await withEvidence('bs-ev-private-tracked-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'echo more >> other.txt' }] }),
    privateWorkspace: true,
    prepare: (dir) => {
      writeFileSync(join(dir, 'other.txt'), 'tracked\n');
      execFileSync('git', ['-C', dir, 'add', 'other.txt']);
      execFileSync('git', ['-C', dir, 'commit', '-qm', 'other']);
    },
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
    evidenceRetryAvailable: false,
  }, ({ result }) => {
    assert.equal(result.failureKind, 'failed-evidence');
    assert.deepEqual(result.attempts[0].evidenceResults[0].changed, ['other.txt']);
  });
});

test('evidence: a private copy outside git removes the files a check created', async () => {
  await withEvidence('bs-ev-private-plain-', {
    action: produceFiles({ evidence: [{ type: 'command', cmd: 'echo x > by-product.log' }] }),
    privateWorkspace: true,
    plain: true,
    prepare: (dir) => writeFileSync(join(dir, 'owned.txt'), 'base\n'),
    watches: (dir) => [({ paths: p }) => { writeFileSync(join(dir, 'owned.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }],
  }, ({ result, repo }) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0].evidenceResults[0].touched, ['by-product.log']);
    assert.equal(existsSync(join(repo, 'by-product.log')), false);
    assert.equal(readFileSync(join(repo, 'owned.txt'), 'utf8'), 'work\n');
  });
});

test('evidence: the durable handoff carries evidenceResults only when the attempt ran checks', () => {
  const seen = [];
  const format = (facts) => { seen.push(facts); return 'block'; };
  const attempt = { id: 'ev-report-1', pool: 'pool-a', failureKind: 'failed-evidence', why: 'false → exit 1' };
  durableAttemptHandoff(attempt, null, format);
  durableAttemptHandoff({ ...attempt, evidenceResults: [{ type: 'command', cmd: 'false', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 3, tail: '', why: 'exit 1' }] }, null, format);
  assert.equal(Object.hasOwn(seen[0], 'evidenceResults'), false);
  assert.equal(seen[1].evidenceResults[0].why, 'exit 1');
});

test('evidence scope: a workspace in a repository subfolder uses workspace-relative paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-ev-subfolder-'));
  const repo = gitWorkspace(root);
  const workspace = join(repo, 'app');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'tracked.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', 'app/tracked.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'app']);
  const home = join(root, 'home');
  mkdirSync(home);
  try {
    const h = harness([({ paths: p }) => { writeFileSync(join(workspace, 'tracked.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }]);
    const result = await dispatchV2Action({
      action: { id: 'app-work', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' },
        evidence: [
          { type: 'command', cmd: 'echo x > report.xml && echo y >> ../owned.txt' },
          { type: 'command', cmd: 'echo more >> tracked.txt' },
        ] },
      taskText: 'work in app', targetDir: workspace,
      paths: (ordinal) => ({ taskFile: join(home, `task-app-work-attempt-${ordinal}.md`), outFile: join(home, `out-app-work-attempt-${ordinal}.md`) }),
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies, evidenceRetryAvailable: false,
    });
    const items = result.attempts[0].evidenceResults;
    assert.deepEqual([items[0].status, items[0].touched], ['passed', ['report.xml']], 'a file outside the workspace is not its deliverable');
    assert.deepEqual([items[1].status, items[1].changed], ['failed', ['tracked.txt']]);
    assert.equal(result.failureKind, 'failed-evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence scope: a workspace its repository ignores only guards the declared paths and the output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-ev-ignored-dir-'));
  const repo = gitWorkspace(root);
  writeFileSync(join(repo, '.gitignore'), 'scratch/\n');
  const workspace = join(repo, 'scratch');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'notes.txt'), 'base\n');
  const home = join(root, 'home');
  mkdirSync(home);
  try {
    const h = harness([({ paths: p }) => { writeFileSync(join(workspace, 'notes.txt'), 'work\n'); writeFileSync(p.outFile, 'done\n'); return good; }]);
    const result = await dispatchV2Action({
      action: { id: 'scratch', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' },
        evidence: [{ type: 'command', cmd: 'echo more >> notes.txt' }] },
      taskText: 'work in scratch', targetDir: workspace,
      paths: (ordinal) => ({ taskFile: join(home, `task-scratch-attempt-${ordinal}.md`), outFile: join(home, `out-scratch-attempt-${ordinal}.md`) }),
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    const [item] = result.attempts[0].evidenceResults;
    assert.equal(item.status, 'passed');
    assert.equal(Object.hasOwn(item, 'touched'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence: a schema the worker edited is recorded as schemaChanged (E26)', async () => {
  await withEvidence('bs-ev-schema-changed-', {
    action: reportStep([{ type: 'schema', file: 'data.json', schema: 'schema.json' }]),
    plain: true,
    prepare: (dir) => {
      writeFileSync(join(dir, 'schema.json'), '{"type":"object","required":["b"]}\n');
      writeFileSync(join(dir, 'data.json'), '{"a":1}\n');
    },
    watches: (dir) => [({ paths: p }) => {
      writeFileSync(join(dir, 'schema.json'), '{"type":"object"}\n');
      writeFileSync(p.outFile, 'done\n');
      return good;
    }],
  }, ({ result }) => {
    assert.equal(result.ok, true);
    const [item] = result.attempts[0].evidenceResults;
    assert.equal(item.status, 'passed');
    assert.equal(item.schemaChanged, true);
  });
});

test('evidence: log files carry the run-wide attempt number from the task file, so a resumed step never overwrites earlier logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-ev-lognames-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const workspace = join(root, 'plain');
  mkdirSync(workspace);
  try {
    // The runtime's third attempt of this step is this dispatch's first.
    const runWide = (ordinal) => ({ taskFile: join(home, `task-ev-report-attempt-${ordinal + 2}.md`), outFile: join(home, `out-ev-report-attempt-${ordinal + 2}.md`) });
    const h = harness([answer('broken\n'), answer('fixed\n')]);
    const result = await dispatchV2Action({
      action: reportStep([failsUntilFixed]), taskText: 'resume the step', targetDir: workspace, paths: runWide,
      pools: [connector('sample-pool')], bullswarmDir: home, dependencies: h.dependencies,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((attempt) => attempt.evidenceResults[0].log), [
      join(home, 'evidence-ev-report-attempt-3-1.log'),
      join(home, 'evidence-ev-report-attempt-4-1.log'),
    ]);
    assert.match(readFileSync(join(home, 'evidence-ev-report-attempt-3-1.log'), 'utf8'), /first run: marker missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
