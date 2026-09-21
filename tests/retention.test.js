// Retention: only finished runs' workspaces/ copies ever go, and nothing else.
//
// Every test builds its own home under the OS temp dir (or copies the scrubbed
// in-repo fixture into one). A "manifest" is the sha256 of every file outside a
// workspaces/ directory plus the target of every symlink; equal manifests before
// and after prove nothing durable moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_INTERVAL_MS, acquirePruneLock, applyRetention, autoSweepSkipReason, leaseHeld,
  planRetention, pruneHome, readMaintenanceResults, recordMaintenanceResult,
  runRetentionSweep, spawnRetentionSweep, treeBytes,
} from '../src/lib/retention.js';
import { processIdentity } from '../src/workflow/v2-process.js';
import { DEFAULT_RETENTION, resolveRetention } from '../src/lib/state.js';

const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

const cleanup = [];
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix = 'bullswarm-retention-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function makeHome({ retention = undefined } = {}) {
  const home = tempDir();
  mkdirSync(join(home, 'workflows'), { recursive: true });
  const state = { version: 1, pools: {}, decisionLog: [] };
  if (retention !== undefined) state.retention = retention;
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  return home;
}

function makeRun(home, runId, {
  status = 'completed', finishedAt = daysAgo(10), schema = 'bullswarm.workflow.state.v2',
  workspaces = ['fix'], fileBytes = 1000, rawState = null,
} = {}) {
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const lifecycle = { status, startedAt: daysAgo(11) };
  if (finishedAt !== null) lifecycle.finishedAt = finishedAt;
  writeFileSync(join(dir, 'state.json'), rawState ?? JSON.stringify({
    schemaVersion: schema, runId, shortId: runId.slice(-6), lifecycle, actions: [], attempts: [],
  }));
  writeFileSync(join(dir, 'result.json'), '{"status":"completed"}');
  writeFileSync(join(dir, 'report.json'), '{"ok":true}');
  writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\n');
  writeFileSync(join(dir, 'task-fix-attempt-1.md'), 'task text');
  writeFileSync(join(dir, 'out-fix-attempt-1.md'), 'out text');
  writeFileSync(join(dir, 'stream-fix-attempt-1.jsonl'), '{"kind":"response"}\n');
  writeFileSync(join(dir, 'diff-fix-attempt-1.patch'), 'diff --git');
  for (const name of workspaces) {
    const ws = join(dir, 'workspaces', name);
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.js'), 'a'.repeat(fileBytes));
    writeFileSync(join(ws, 'b.txt'), 'b'.repeat(fileBytes));
  }
  return dir;
}

/** sha256 of every file outside workspaces/, plus symlink targets. */
function manifest(root) {
  const out = {};
  const visit = (path) => {
    const rel = relative(root, path);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) { out[rel] = `link:${readlinkSync(path)}`; return; }
    if (entry.isDirectory()) {
      if (rel.split(sep).includes('workspaces')) return;
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  visit(root);
  // The maintenance record is bookkeeping this feature writes, not durable run data.
  for (const key of Object.keys(out)) if (key.startsWith('maintenance')) delete out[key];
  return out;
}

const runTree = (home, runId) => join(home, 'workflows', runId);
const wsPath = (home, runId, name = 'fix') => join(home, 'workflows', runId, 'workspaces', name);

test('resolveRetention: defaults, overrides, and fail-closed on bad values', () => {
  assert.deepEqual(resolveRetention({}), { ...DEFAULT_RETENTION, invalid: [] });
  assert.deepEqual(DEFAULT_RETENTION, { enabled: true, workspacesDays: 7 });
  assert.deepEqual(resolveRetention({ retention: { enabled: false, workspacesDays: 3 } }),
    { enabled: false, workspacesDays: 3, invalid: [] });
  assert.deepEqual(resolveRetention({ retention: { workspacesDays: 2.5 } }),
    { enabled: true, workspacesDays: 2.5, invalid: [] });
  for (const bad of [{ enabled: 'no' }, { workspacesDays: 0 }, { workspacesDays: '7' }, { workspacesDays: -1 }, 'x', []]) {
    const policy = resolveRetention({ retention: bad });
    assert.equal(policy.enabled, false, `paused for ${JSON.stringify(bad)}`);
    assert.ok(policy.invalid.length, `reported for ${JSON.stringify(bad)}`);
    assert.equal(policy.workspacesDays > 0, true);
  }
});

test('dry run lists old workspaces with bytes and changes nothing', () => {
  const home = makeHome();
  makeRun(home, 'wf-aaaaaa-000001', { workspaces: ['fix', 'verify'], fileBytes: 500 });
  const before = manifest(home);
  const report = pruneHome({ bullswarmDir: home, apply: false, now: NOW });
  assert.equal(report.dryRun, true);
  assert.equal(report.apply, false);
  assert.equal(report.candidateRuns, 1);
  assert.equal(report.candidateWorkspaces, 2);
  assert.equal(report.reclaimableBytes, 2 * 2 * 500);
  assert.equal(report.candidates[0].workspaces[0].path, 'workflows/wf-aaaaaa-000001/workspaces/fix');
  assert.equal(report.removedWorkspaces, 0);
  assert.ok(existsSync(wsPath(home, 'wf-aaaaaa-000001')));
  assert.ok(existsSync(wsPath(home, 'wf-aaaaaa-000001', 'verify')));
  assert.deepEqual(manifest(home), before);
  assert.equal(existsSync(join(home, 'maintenance')), false, 'a dry run writes no record');
});

test('apply removes only workspaces/; every durable artifact keeps its checksum', () => {
  const home = makeHome();
  makeRun(home, 'wf-aaaaaa-000001', { workspaces: ['fix', 'verify'], fileBytes: 700 });
  makeRun(home, 'wf-bbbbbb-000002', { status: 'failed', finishedAt: daysAgo(30) });
  const before = manifest(home);
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.ok, true);
  assert.equal(report.removedRuns, 2);
  assert.equal(report.removedWorkspaces, 3);
  assert.equal(report.removedBytes, 2 * 2 * 700 + 2 * 1000);
  for (const runId of ['wf-aaaaaa-000001', 'wf-bbbbbb-000002']) {
    assert.equal(existsSync(join(runTree(home, runId), 'workspaces')), false);
    for (const file of ['state.json', 'result.json', 'report.json', 'events.jsonl', 'task-fix-attempt-1.md',
      'out-fix-attempt-1.md', 'stream-fix-attempt-1.jsonl', 'diff-fix-attempt-1.patch']) {
      assert.ok(existsSync(join(runTree(home, runId), file)), `${runId}/${file} remains`);
    }
    assert.equal(existsSync(join(runTree(home, runId), 'kernel.lock')), false, 'the lease is released');
  }
  assert.deepEqual(manifest(home), before);
});

test('the limit is measured from finishedAt and follows retention.workspacesDays', () => {
  const home = makeHome({ retention: { enabled: true, workspacesDays: 7 } });
  makeRun(home, 'wf-old000-000001', { finishedAt: daysAgo(7.5) });
  makeRun(home, 'wf-new000-000002', { finishedAt: daysAgo(6.5) });
  let plan = planRetention({ bullswarmDir: home, now: NOW });
  assert.deepEqual(plan.candidates.map((run) => run.runId), ['wf-old000-000001']);
  assert.ok(plan.skipped.some((item) => item.runId === 'wf-new000-000002' && /retention window/.test(item.reason)));
  plan = planRetention({ bullswarmDir: home, workspacesDays: 5, now: NOW });
  assert.equal(plan.candidates.length, 2);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, retention: { workspacesDays: 30 } }));
  plan = planRetention({ bullswarmDir: home, now: NOW });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.policy.workspacesDays, 30);
});

test('runs that are not finished V2 runs are skipped with a reason and kept', () => {
  const home = makeHome();
  makeRun(home, 'wf-run000-000001', { status: 'running', finishedAt: null });
  makeRun(home, 'wf-int000-000002', { status: 'interrupted', finishedAt: daysAgo(30) });
  makeRun(home, 'wf-pau000-000003', { status: 'paused', finishedAt: daysAgo(30) });
  makeRun(home, 'wf-wai000-000004', { status: 'waiting', finishedAt: null });
  makeRun(home, 'wf-leg000-000005', { schema: 'legacy', finishedAt: daysAgo(30) });
  makeRun(home, 'wf-bad000-000006', { rawState: '{ torn' });
  makeRun(home, 'wf-nofin0-000007', { status: 'completed', finishedAt: null });
  makeRun(home, 'wf-badts0-000008', { status: 'completed', finishedAt: 'not a date' });
  const before = manifest(home);
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.removedWorkspaces, 0);
  assert.equal(report.skipped.length, 8);
  const reasons = Object.fromEntries(report.skipped.map((item) => [item.runId, item.reason]));
  assert.match(reasons['wf-run000-000001'], /running/);
  assert.match(reasons['wf-int000-000002'], /interrupted/);
  assert.match(reasons['wf-pau000-000003'], /paused/);
  assert.match(reasons['wf-leg000-000005'], /legacy/);
  assert.match(reasons['wf-bad000-000006'], /unreadable/);
  assert.match(reasons['wf-nofin0-000007'], /finishedAt/);
  assert.match(reasons['wf-badts0-000008'], /finishedAt/);
  for (const runId of Object.keys(reasons)) assert.ok(existsSync(wsPath(home, runId)), `${runId} workspace kept`);
  assert.deepEqual(manifest(home), before);
});

test('a run whose kernel lease is held is skipped; a dead owner’s lease is not', () => {
  const home = makeHome();
  const live = makeRun(home, 'wf-live00-000001');
  const dead = makeRun(home, 'wf-dead00-000002');
  writeFileSync(join(live, 'kernel.lock'), JSON.stringify({
    pid: process.pid, identity: processIdentity(process.pid), token: 'live-token',
  }));
  writeFileSync(join(dead, 'kernel.lock'), JSON.stringify({ pid: 2 ** 22 - 1, identity: 'Thu Jan  1 00:00:00 1970', token: 'dead-token' }));
  assert.equal(leaseHeld(live), true);
  assert.equal(leaseHeld(dead), false);
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.deepEqual(report.candidates.map((run) => run.runId), ['wf-dead00-000002']);
  assert.ok(report.skipped.some((item) => item.runId === 'wf-live00-000001' && /lease/.test(item.reason)));
  assert.ok(existsSync(wsPath(home, 'wf-live00-000001')), 'leased run keeps its workspace');
  assert.ok(existsSync(join(live, 'kernel.lock')), 'the live lease file is never removed');
  assert.equal(existsSync(join(dead, 'workspaces')), false);
  assert.equal(existsSync(join(dead, 'kernel.lock')), false);
});

test('a lease taken between plan and apply stops that run’s deletion', () => {
  const home = makeHome();
  const dir = makeRun(home, 'wf-race00-000001');
  const plan = planRetention({ bullswarmDir: home, now: NOW });
  assert.equal(plan.candidates.length, 1);
  writeFileSync(join(dir, 'kernel.lock'), JSON.stringify({
    pid: process.pid, identity: processIdentity(process.pid), token: 'kernel-started-after-plan',
  }));
  const result = applyRetention(home, plan, { now: NOW });
  assert.equal(result.removedWorkspaces, 0);
  assert.match(result.skippedAtApply[0].reason, /lease/);
  assert.ok(existsSync(wsPath(home, 'wf-race00-000001')));
});

test('a run reopened between plan and apply is rechecked under the lease', () => {
  const home = makeHome();
  const dir = makeRun(home, 'wf-reopen-000001');
  const plan = planRetention({ bullswarmDir: home, now: NOW });
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  state.lifecycle.status = 'running';
  delete state.lifecycle.finishedAt;
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const result = applyRetention(home, plan, { now: NOW });
  assert.equal(result.removedWorkspaces, 0);
  assert.match(result.skippedAtApply[0].reason, /changed before delete/);
  assert.ok(existsSync(wsPath(home, 'wf-reopen-000001')));
});

function gitRepo() {
  const repo = tempDir('bullswarm-retention-repo-');
  const run = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=dev', '-c', 'user.email=dev@example.invalid', ...args], { stdio: 'pipe' });
  run('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'content');
  run('add', '.');
  run('commit', '-q', '-m', 'initial');
  return { repo, run };
}

test('a git worktree workspace is unregistered and its directory removed', () => {
  const { repo, run } = gitRepo();
  const home = makeHome();
  const dir = makeRun(home, 'wf-git000-000001', { workspaces: ['copy-one'] });
  const worktree = join(dir, 'workspaces', 'wt');
  run('worktree', 'add', '--detach', worktree, 'HEAD');
  assert.match(run('worktree', 'list').toString(), /workspaces[\\/]wt/);
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  const kinds = Object.fromEntries(report.candidates[0].workspaces.map((ws) => [ws.name, ws.kind]));
  assert.deepEqual(kinds, { 'copy-one': 'copy', wt: 'git-worktree' });
  assert.equal(existsSync(join(dir, 'workspaces')), false);
  assert.doesNotMatch(run('worktree', 'list').toString(), /workspaces/);
  assert.ok(existsSync(join(repo, 'file.txt')), 'the source checkout is untouched');
});

test('a git worktree whose source repository is gone is removed without error', () => {
  const { repo, run } = gitRepo();
  const home = makeHome();
  const dir = makeRun(home, 'wf-orph00-000001', { workspaces: [] });
  run('worktree', 'add', '--detach', join(dir, 'workspaces', 'wt'), 'HEAD');
  rmSync(repo, { recursive: true, force: true });
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(existsSync(join(dir, 'workspaces')), false);
});

test('a worktree pointer that cannot be read is left in place and reported', () => {
  const home = makeHome();
  const dir = makeRun(home, 'wf-ptr000-000001', { workspaces: ['wt'] });
  writeFileSync(join(dir, 'workspaces', 'wt', '.git'), 'garbage, not a gitdir pointer');
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].error, /pointer is unreadable/);
  assert.ok(existsSync(join(dir, 'workspaces', 'wt')));
});

test('symlinks cannot carry a delete outside the run’s own workspaces', () => {
  const home = makeHome();
  const outside = tempDir('bullswarm-retention-outside-');
  writeFileSync(join(outside, 'precious.txt'), 'keep me');
  mkdirSync(join(outside, 'sub'));
  writeFileSync(join(outside, 'sub', 'deep.txt'), 'keep me too');
  const outsideSum = () => JSON.stringify(manifest(outside));
  const before = outsideSum();

  // (a) a symlink INSIDE a copy (a shared node_modules) is unlinked, not followed
  const inside = makeRun(home, 'wf-inlink-000001');
  symlinkSync(outside, join(inside, 'workspaces', 'fix', 'node_modules'), 'dir');
  // (b) a workspace child that is itself a symlink to an outside directory
  const child = makeRun(home, 'wf-child0-000002', { workspaces: [] });
  mkdirSync(join(child, 'workspaces'));
  symlinkSync(outside, join(child, 'workspaces', 'escape'), 'dir');
  // (c) the workspaces directory is a symlink
  const container = makeRun(home, 'wf-cont00-000003', { workspaces: [] });
  symlinkSync(outside, join(container, 'workspaces'), 'dir');
  // (d) the run directory is a symlink
  const target = makeRun(makeHome(), 'wf-target-000004');
  symlinkSync(target, join(home, 'workflows', 'wf-runlnk-000004'), 'dir');

  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(outsideSum(), before, 'the outside directory is unchanged');
  assert.ok(existsSync(join(outside, 'precious.txt')));
  assert.equal(existsSync(join(inside, 'workspaces')), false, '(a) the copy is gone');
  assert.ok(existsSync(join(child, 'workspaces', 'escape')), '(b) the symlinked child is left');
  assert.ok(lstatSync(join(container, 'workspaces')).isSymbolicLink(), '(c) the symlinked container is left');
  assert.ok(existsSync(wsPath(dirOf(target), 'wf-target-000004')), '(d) the symlinked run keeps its workspace');
  const reasons = report.skipped.map((item) => `${item.runId}: ${item.reason}`).join('\n');
  assert.match(reasons, /wf-child0-000002: a non-directory entry/);
  assert.match(reasons, /wf-cont00-000003: workspaces is not a plain directory/);
  assert.match(reasons, /wf-runlnk-000004: run directory is a symlink/);
});

function dirOf(runDir) {
  return join(runDir, '..', '..');
}

test('a second pass is idempotent and reports nothing to remove', () => {
  const home = makeHome();
  makeRun(home, 'wf-idem00-000001', { workspaces: ['a', 'b'] });
  const first = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(first.removedWorkspaces, 2);
  const after = manifest(home);
  const second = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(second.removedWorkspaces, 0);
  assert.equal(second.candidateRuns, 0);
  assert.equal(second.reclaimableBytes, 0);
  assert.match(second.line, /nothing to remove/);
  assert.deepEqual(manifest(home), after);
});

test('the report is plain JSON with the policy, counts, paths, bytes and failures', () => {
  const home = makeHome({ retention: { enabled: true, workspacesDays: 7 } });
  makeRun(home, 'wf-json00-000001');
  const report = JSON.parse(JSON.stringify(pruneHome({ bullswarmDir: home, now: NOW })));
  for (const key of ['action', 'apply', 'dryRun', 'policy', 'cutoff', 'scannedRuns', 'runsWithWorkspaces',
    'candidateRuns', 'candidateWorkspaces', 'reclaimableBytes', 'candidates', 'skipped', 'removedWorkspaces',
    'removedBytes', 'failures', 'ok', 'line']) {
    assert.ok(key in report, `report.${key}`);
  }
  assert.deepEqual(report.policy, { enabled: true, workspacesDays: 7, invalid: [] });
  assert.equal(report.cutoff, daysAgo(7));
  assert.equal(JSON.stringify(report).includes(home), false, 'reports carry home-relative paths only');
  assert.equal(treeBytes(wsPath(home, 'wf-json00-000001')), report.reclaimableBytes);
});

test('the automatic sweep honours enabled, records its result, and waits out the interval', () => {
  const home = makeHome();
  makeRun(home, 'wf-auto00-000001');
  const first = runRetentionSweep({ bullswarmDir: home, trigger: 'kernel', now: NOW });
  assert.equal(first.removedWorkspaces, 1);
  const record = readMaintenanceResults(home).prune;
  assert.equal(record.trigger, 'kernel');
  assert.equal(record.ok, true);
  assert.equal(record.at, new Date(NOW).toISOString());
  assert.match(record.line, /removed 1 workspace from 1 run/);
  makeRun(home, 'wf-auto00-000002');
  const soon = runRetentionSweep({ bullswarmDir: home, now: NOW + AUTO_INTERVAL_MS - 1 });
  assert.equal(soon.skipped, true);
  assert.equal(soon.skippedReason, 'swept recently');
  assert.ok(existsSync(wsPath(home, 'wf-auto00-000002')));
  const later = runRetentionSweep({ bullswarmDir: home, now: NOW + AUTO_INTERVAL_MS + 1 });
  assert.equal(later.removedWorkspaces, 1);
});

test('the automatic sweep never runs when retention is off or its config is invalid', () => {
  for (const retention of [{ enabled: false }, { enabled: 'yes' }, { workspacesDays: 'seven' }]) {
    const home = makeHome({ retention });
    makeRun(home, 'wf-off000-000001');
    assert.ok(autoSweepSkipReason(home, { now: NOW }));
    const result = runRetentionSweep({ bullswarmDir: home, now: NOW });
    assert.equal(result.skipped, true);
    assert.ok(existsSync(wsPath(home, 'wf-off000-000001')), JSON.stringify(retention));
    assert.equal(existsSync(join(home, 'maintenance', 'prune.json')), false);
  }
});

test('an explicit prune of a disabled home still applies the limit', () => {
  const home = makeHome({ retention: { enabled: false } });
  makeRun(home, 'wf-manual-000001');
  const report = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.equal(report.policy.enabled, false);
  assert.equal(report.removedWorkspaces, 1);
});

test('two sweeps cannot run at once: the second reports it and touches nothing', () => {
  const home = makeHome();
  makeRun(home, 'wf-lock00-000001');
  const lock = acquirePruneLock(home);
  assert.ok(lock);
  assert.equal(acquirePruneLock(home), null, 'a live holder blocks a second taker');
  const blocked = runRetentionSweep({ bullswarmDir: home, now: NOW });
  assert.equal(blocked.skippedReason, 'another prune is running');
  assert.ok(existsSync(wsPath(home, 'wf-lock00-000001')));
  lock.release();
  const freed = runRetentionSweep({ bullswarmDir: home, now: NOW });
  assert.equal(freed.removedWorkspaces, 1);
});

test('a lock left by a dead process is taken over', () => {
  const home = makeHome();
  mkdirSync(join(home, 'maintenance'));
  writeFileSync(join(home, 'maintenance', 'prune.lock'), JSON.stringify({ pid: 2 ** 22 - 1, at: daysAgo(0) }));
  const lock = acquirePruneLock(home);
  assert.ok(lock);
  lock.release();
  assert.equal(existsSync(join(home, 'maintenance', 'prune.lock')), false);
});

test('the automatic sweep never throws into its caller', () => {
  const missing = join(tempDir(), 'no-such-home');
  const result = runRetentionSweep({ bullswarmDir: missing, now: NOW });
  assert.equal(typeof result.ok, 'boolean');
  const junk = makeHome();
  writeFileSync(join(junk, 'state.json'), '{ not json');
  makeRun(junk, 'wf-junk00-000001');
  assert.doesNotThrow(() => runRetentionSweep({ bullswarmDir: junk, now: NOW }));
});

test('spawnRetentionSweep starts one detached child only when a sweep is due', () => {
  const home = makeHome();
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() { calls.at(-1).unref = true; } };
  };
  // No run holds a workspace copy: there is nothing a sweep could remove.
  makeRun(home, 'wf-bare-abcdef', { workspaces: [] });
  assert.equal(spawnRetentionSweep({ bullswarmDir: home, trigger: 'kernel', now: NOW, spawnFn }), false);
  assert.equal(calls.length, 0);
  makeRun(home, 'wf-copy-abcdef');
  assert.equal(spawnRetentionSweep({ bullswarmDir: home, trigger: 'kernel', now: NOW, spawnFn }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1), ['home', 'prune', '--auto', '--trigger', 'kernel']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.env.BULLSWARM_HOME, home);
  assert.equal(calls[0].unref, true);
  recordMaintenanceResult(home, 'prune', { line: 'x' }, { now: NOW });
  assert.equal(spawnRetentionSweep({ bullswarmDir: home, now: NOW + 1000, spawnFn }), false);
  assert.equal(calls.length, 1, 'recently swept: nothing spawned');
  const off = makeHome({ retention: { enabled: false } });
  makeRun(off, 'wf-copy-abcdef');
  assert.equal(spawnRetentionSweep({ bullswarmDir: off, now: NOW, spawnFn }), false);
  assert.equal(spawnRetentionSweep({ bullswarmDir: home, now: NOW + AUTO_INTERVAL_MS + 1, spawnFn: () => { throw new Error('no'); } }), false);
});

test('maintenance results: any job records a line, torn files are ignored, bad names never throw', () => {
  const home = makeHome();
  recordMaintenanceResult(home, 'reprice', { trigger: 'kernel', line: 'priced 4 attempts · 0 left' }, { now: NOW });
  recordMaintenanceResult(home, 'prune', { ok: false, line: 'boom' }, { now: NOW });
  writeFileSync(join(home, 'maintenance', 'torn.json'), '{ "job": ');
  assert.equal(recordMaintenanceResult(home, '../escape', { line: 'x' }), null);
  assert.equal(existsSync(join(home, 'escape.json')), false);
  const results = readMaintenanceResults(home);
  assert.deepEqual(Object.keys(results).sort(), ['prune', 'reprice']);
  assert.equal(results.reprice.line, 'priced 4 attempts · 0 left');
  assert.equal(results.reprice.ok, true);
  assert.equal(results.prune.ok, false);
  assert.deepEqual(readMaintenanceResults(join(home, 'nothing-here')), {});
  // A detached job that outlives its home never recreates it.
  const gone = join(home, 'deleted-home');
  assert.equal(recordMaintenanceResult(gone, 'reprice', { line: 'x' }), null);
  assert.equal(runRetentionSweep({ bullswarmDir: gone, now: NOW }).skipped, true);
  assert.equal(existsSync(gone), false);
});

test('the scrubbed in-repo fixture: old runs’ workspaces go, every recorded file keeps its checksum', () => {
  const home = tempDir('bullswarm-retention-fixture-');
  cpSync(FIXTURE_HOME, home, { recursive: true });
  const runIds = readdirSync(join(home, 'workflows')).filter((name) => name.startsWith('wf-'));
  assert.ok(runIds.length >= 10, 'the fixture carries real runs');
  const finishedAt = Object.fromEntries(runIds.map((runId) => [
    runId, JSON.parse(readFileSync(join(home, 'workflows', runId, 'state.json'), 'utf8')).lifecycle.finishedAt,
  ]));
  const cutoff = new Date(NOW - 7 * DAY).toISOString();
  const expected = runIds.filter((runId) => finishedAt[runId] <= cutoff).sort();
  assert.ok(expected.length >= 3 && expected.length < runIds.length, 'the fixture straddles the limit');
  for (const runId of runIds) {
    const ws = join(home, 'workflows', runId, 'workspaces', 'act');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'copy.txt'), `copy of ${runId}`);
  }
  const before = manifest(home);
  const dry = pruneHome({ bullswarmDir: home, apply: false, now: NOW });
  assert.deepEqual(dry.candidates.map((run) => run.runId).sort(), expected);
  assert.deepEqual(manifest(home), before);
  const real = pruneHome({ bullswarmDir: home, apply: true, now: NOW });
  assert.deepEqual(real.candidates.map((run) => run.runId).sort(), expected);
  assert.equal(real.removedWorkspaces, expected.length);
  for (const runId of runIds) {
    assert.equal(existsSync(join(home, 'workflows', runId, 'workspaces')), !expected.includes(runId), runId);
  }
  assert.deepEqual(manifest(home), before, 'no recorded file changed');
});
