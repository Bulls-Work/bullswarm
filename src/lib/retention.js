// bullswarm retention — the home stops growing forever.
//
// Doctrine:
//   T1. Only `<run>/workspaces/<action>` is ever removed: the disposable
//       isolated copies a mutating action worked in. Records, reports,
//       streams, task/out/diff markdown, contracts, receipts, baselines and
//       history are never listed, never touched.
//   T2. Only a terminal V2 run is eligible (completed, partial, cancelled,
//       failed), `retention.workspacesDays` after its own `finishedAt`.
//       Interrupted, paused, waiting, running, legacy and unreadable runs are
//       skipped and reported; an interrupted run's workspaces are its
//       recovery material.
//   T3. A run whose kernel lease is held is never touched. Apply takes the
//       lease itself and rechecks the run's state under it.
//   T4. Nothing outside `<run>/workspaces/<direct child>` can be reached: a
//       symlinked run dir, `workspaces` dir or child is skipped, and a
//       symlink inside a copy is unlinked, never followed.
//   T5. Automatic maintenance is the only implicit apply path. It never
//       throws into its caller, honours `enabled`, is throttled by the last
//       recorded result, and runs in a detached child so a kernel finalize
//       or a dashboard paint never waits on a recursive delete.
//
// Every maintenance job (this prune, the reprice reconciler) records its last
// result under `<home>/maintenance/<name>.json` so `bullswarm home status`
// can show what background work last did without reading a log.

import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync, readJsonSafe } from './fsjson.js';
import { loadState, resolveRetention } from './state.js';
import { processIdentity, acquireKernelLease } from '../workflow/v2-process.js';

const DAY_MS = 86_400_000;
const V2_SCHEMA = 'bullswarm.workflow.state.v2';
/** The V2 terminal states that own no recovery material. Not `interrupted`. */
export const PRUNABLE_STATUSES = Object.freeze(['completed', 'partial', 'cancelled', 'failed']);
/** Minimum gap between two automatic sweeps of one home. */
export const AUTO_INTERVAL_MS = 6 * 3_600_000;
/** Not an anomaly: the run is simply not old enough yet. */
export const WINDOW_REASON = 'finished inside the retention window';
const LOCK_STALE_MS = 30 * 60_000;
const LEASE_INIT_GRACE_MS = 10_000;

// --- last-result records ----------------------------------------------------

export function maintenanceDir(bullswarmDir) {
  return join(bullswarmDir, 'maintenance');
}

function safeJobName(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name ?? '')) throw new TypeError(`maintenance job name must be kebab-case: ${name}`);
  return name;
}

/**
 * Persist the last result of one maintenance job. `result.line` is the human
 * one-liner `home status` prints; every other field is machine detail.
 * Recording never throws: bookkeeping must not fail the work it reports on.
 */
export function recordMaintenanceResult(bullswarmDir, name, result, { now = Date.now() } = {}) {
  try {
    // A detached job that outlives its home (a deleted copy, a test's temp
    // home) must not recreate it just to say what it did.
    if (!existsSync(bullswarmDir)) return null;
    const record = {
      job: safeJobName(name),
      at: new Date(now).toISOString(),
      ok: result?.ok !== false,
      ...result,
    };
    atomicWriteFileSync(
      join(maintenanceDir(bullswarmDir), `${name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  } catch {
    return null;
  }
}

/** `{ <job>: record }` for every recorded job; a torn or missing file is absent. */
export function readMaintenanceResults(bullswarmDir) {
  const dir = maintenanceDir(bullswarmDir);
  const out = {};
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const file of names.sort()) {
    if (!file.endsWith('.json')) continue;
    const record = readJsonSafe(join(dir, file), null);
    if (record && typeof record === 'object') out[file.slice(0, -'.json'.length)] = record;
  }
  return out;
}

// --- policy -----------------------------------------------------------------

/** The retention policy of a home, defaults filled, invalid values reported. */
export function readRetentionPolicy(bullswarmDir) {
  return resolveRetention(loadState(bullswarmDir, { skipMigration: true }));
}

// --- scanning ---------------------------------------------------------------

function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

/** Apparent bytes under `root`, counting symlinks as links, never following. */
export function treeBytes(root) {
  let total = 0;
  const visit = (path) => {
    const entry = lstatOrNull(path);
    if (!entry) return;
    if (entry.isDirectory()) {
      let names = [];
      try { names = readdirSync(path); } catch { return; }
      for (const name of names) visit(join(path, name));
    } else {
      total += entry.size;
    }
  };
  visit(root);
  return total;
}

/**
 * Whether a kernel lease is held on a run, without taking it. A lease still
 * being written counts as held for a short grace period, like the kernel's own
 * acquire path.
 */
export function leaseHeld(runDir) {
  const path = join(runDir, 'kernel.lock');
  const entry = lstatOrNull(path);
  if (!entry) return false;
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return Date.now() - entry.mtimeMs <= LEASE_INIT_GRACE_MS; }
  return Boolean(owner?.identity) && processIdentity(owner.pid) === owner.identity;
}

function readRunState(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')); } catch { return null; }
}

/** Why a run may not be pruned, or null when it is eligible at `cutoffMs`. */
function ineligibleReason(state, cutoffMs) {
  if (state == null) return 'state.json is missing or unreadable';
  if (state.schemaVersion !== V2_SCHEMA) return 'legacy run';
  const status = state.lifecycle?.status;
  if (!PRUNABLE_STATUSES.includes(status)) return `status ${status ?? 'unknown'} is not a finished run`;
  const finishedAt = isoMs(state.lifecycle?.finishedAt);
  if (finishedAt == null) return 'no valid finishedAt';
  if (finishedAt > cutoffMs) return WINDOW_REASON;
  return null;
}

function workspaceKind(path) {
  const dotGit = lstatOrNull(join(path, '.git'));
  return dotGit?.isFile() ? 'git-worktree' : 'copy';
}

/** The repository a linked worktree belongs to, or null when unreadable. */
function worktreeSource(workspaceRoot) {
  let pointer;
  try { pointer = readFileSync(join(workspaceRoot, '.git'), 'utf8'); } catch { return null; }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const gitdir = resolve(workspaceRoot, match[1]);
  // <repo>/.git/worktrees/<name>
  if (basename(dirname(gitdir)) !== 'worktrees') return null;
  const commonDir = dirname(dirname(gitdir));
  return { gitdir, commonDir, sourceRoot: dirname(commonDir), sourceExists: existsSync(commonDir) };
}

/**
 * Plan a retention pass without changing anything.
 *
 * @returns {{ policy, cutoff, scannedRuns, runsWithWorkspaces, candidates, skipped, reclaimableBytes, workspaceBytes }}
 */
export function planRetention({
  bullswarmDir, workspacesDays = null, now = Date.now(),
} = {}) {
  const policy = readRetentionPolicy(bullswarmDir);
  const days = workspacesDays ?? policy.workspacesDays;
  const cutoffMs = now - days * DAY_MS;
  const root = join(bullswarmDir, 'workflows');
  const plan = {
    policy: { ...policy, workspacesDays: days },
    cutoff: new Date(cutoffMs).toISOString(),
    scannedRuns: 0,
    runsWithWorkspaces: 0,
    candidates: [],
    skipped: [],
    reclaimableBytes: 0,
    workspaceBytes: 0,
  };
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return plan; }
  for (const runId of names) {
    if (!runId.startsWith('wf-')) continue;
    const runDir = join(root, runId);
    const runEntry = lstatOrNull(runDir);
    if (!runEntry) continue;
    plan.scannedRuns += 1;
    const workspacesDir = join(runDir, 'workspaces');
    const wsEntry = lstatOrNull(workspacesDir);
    // Most runs never used an isolated workspace: no state.json parse for them.
    if (!wsEntry) continue;
    plan.runsWithWorkspaces += 1;
    const skip = (reason) => plan.skipped.push({ runId, reason });
    if (!runEntry.isDirectory()) { skip('run directory is a symlink'); continue; }
    if (!wsEntry.isDirectory()) { skip('workspaces is not a plain directory'); continue; }
    let children = [];
    try { children = readdirSync(workspacesDir).sort(); } catch { skip('workspaces is unreadable'); continue; }
    const workspaces = [];
    for (const name of children) {
      const path = join(workspacesDir, name);
      const entry = lstatOrNull(path);
      if (!entry) continue;
      const bytes = entry.isDirectory() ? treeBytes(path) : entry.size;
      plan.workspaceBytes += bytes;
      workspaces.push({
        name,
        path: `workflows/${runId}/workspaces/${name}`,
        kind: entry.isDirectory() ? workspaceKind(path) : 'unexpected',
        bytes,
        removable: entry.isDirectory(),
      });
    }
    const state = readRunState(runDir);
    const reason = ineligibleReason(state, cutoffMs);
    if (reason) { skip(reason); continue; }
    if (leaseHeld(runDir)) { skip('kernel lease is held'); continue; }
    const removable = workspaces.filter((workspace) => workspace.removable);
    if (removable.length !== workspaces.length) skip('a non-directory entry sits in workspaces; left untouched');
    if (!removable.length) continue;
    const bytes = removable.reduce((sum, workspace) => sum + workspace.bytes, 0);
    plan.candidates.push({
      runId,
      shortId: state.shortId ?? null,
      status: state.lifecycle.status,
      finishedAt: state.lifecycle.finishedAt,
      ageDays: Math.floor((now - isoMs(state.lifecycle.finishedAt)) / DAY_MS),
      workspaces: removable,
      bytes,
    });
    plan.reclaimableBytes += bytes;
  }
  return plan;
}

// --- applying ---------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Remove one workspace copy: the git registration first, then the files. */
function removeWorkspace(workspacesDir, workspace) {
  const path = join(workspacesDir, workspace.name);
  // Re-lstat at the moment of deletion: the plan may be seconds old.
  const entry = lstatOrNull(path);
  if (!entry) return;
  if (!entry.isDirectory()) throw new Error('not a plain directory');
  // The resolved parent must still be this run's own workspaces directory.
  if (realpathSync(dirname(path)) !== realpathSync(workspacesDir)) throw new Error('resolved outside the run workspaces directory');
  const source = workspaceKind(path) === 'git-worktree' ? worktreeSource(path) : null;
  if (workspaceKind(path) === 'git-worktree' && !source) throw new Error('git worktree pointer is unreadable; left in place');
  if (source?.sourceExists) {
    try { git(source.sourceRoot, ['worktree', 'remove', '--force', path]); return; }
    catch { /* fall through: delete the files, then prune the registration */ }
  }
  rmSync(path, { recursive: true, force: true });
  if (source?.sourceExists) {
    try { git(source.sourceRoot, ['worktree', 'prune']); }
    catch (error) { throw new Error(`files removed but git worktree prune failed: ${String(error.message).split('\n')[0]}`); }
  }
}

/** Apply the candidates of a plan. Each run is leased and rechecked first. */
export function applyRetention(bullswarmDir, plan, { now = Date.now() } = {}) {
  const cutoffMs = Date.parse(plan.cutoff);
  const result = { removedWorkspaces: 0, removedRuns: 0, removedBytes: 0, failures: [], skippedAtApply: [] };
  for (const candidate of plan.candidates) {
    const runDir = join(bullswarmDir, 'workflows', candidate.runId);
    let lease;
    try { lease = acquireKernelLease(runDir); }
    catch (error) {
      result.skippedAtApply.push({ runId: candidate.runId, reason: `kernel lease unavailable: ${String(error.message).split('\n')[0]}` });
      continue;
    }
    try {
      // Recheck under the lease: the run may have been revised or resumed.
      const reason = ineligibleReason(readRunState(runDir), cutoffMs);
      if (reason) { result.skippedAtApply.push({ runId: candidate.runId, reason: `changed before delete: ${reason}` }); continue; }
      const workspacesDir = join(runDir, 'workspaces');
      let removedHere = 0;
      for (const workspace of candidate.workspaces) {
        try {
          removeWorkspace(workspacesDir, workspace);
          result.removedWorkspaces += 1;
          result.removedBytes += workspace.bytes;
          removedHere += 1;
        } catch (error) {
          result.failures.push({ runId: candidate.runId, workspace: workspace.name, error: String(error.message).split('\n')[0] });
        }
      }
      if (removedHere) result.removedRuns += 1;
      // The empty container goes too; rmdir refuses when anything is left.
      try { rmdirSync(workspacesDir); } catch { /* not empty or already gone */ }
    } finally {
      lease.release();
    }
  }
  return result;
}

// --- one-at-a-time maintenance lock -----------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Take the home's prune lock; null when another live sweep holds it. */
export function acquirePruneLock(bullswarmDir) {
  const path = join(maintenanceDir(bullswarmDir), 'prune.lock');
  mkdirSync(dirname(path), { recursive: true });
  for (let retry = 0; retry < 3; retry += 1) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`); }
      finally { closeSync(fd); }
      return { release() { try { unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const entry = lstatOrNull(path);
      if (!entry) continue;
      // Lock age is file time against the wall clock, never a caller's `now`.
      const now = Date.now();
      let stale;
      try {
        const owner = JSON.parse(readFileSync(path, 'utf8'));
        stale = !pidAlive(owner.pid) || now - entry.mtimeMs > LOCK_STALE_MS;
      } catch {
        // Still being written, or torn: give the writer a moment.
        stale = now - entry.mtimeMs > LEASE_INIT_GRACE_MS;
      }
      if (!stale) return null;
      try { unlinkSync(path); } catch { /* another sweeper took it over */ }
    }
  }
  return null;
}

// --- reports ----------------------------------------------------------------

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 1024) return `${value} B`;
  let scaled = value;
  let unit = 'B';
  for (const candidate of ['KB', 'MB', 'GB', 'TB']) {
    scaled /= 1024;
    unit = candidate;
    if (scaled < 1024) break;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${unit}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The one line `home status` prints for a finished prune. */
export function pruneLine(report) {
  if (report.skippedReason) return report.skippedReason;
  const verb = report.apply ? 'removed' : 'would remove';
  const workspaces = report.apply ? report.removedWorkspaces : report.candidateWorkspaces;
  const runs = report.apply ? report.removedRuns : report.candidateRuns;
  const bytes = report.apply ? report.removedBytes : report.reclaimableBytes;
  const tail = report.failures?.length ? ` · ${plural(report.failures.length, 'failure')}` : '';
  if (!workspaces) return `nothing to remove (${report.policyDays}-day limit)${tail}`;
  return `${verb} ${plural(workspaces, 'workspace')} from ${plural(runs, 'run')} · ${formatBytes(bytes)}${tail}`;
}

function summarizePlan(plan) {
  return {
    candidateRuns: plan.candidates.length,
    candidateWorkspaces: plan.candidates.reduce((sum, run) => sum + run.workspaces.length, 0),
    reclaimableBytes: plan.reclaimableBytes,
  };
}

/**
 * Plan, and optionally apply, a retention pass.
 *
 * @param {{bullswarmDir: string, apply?: boolean, workspacesDays?: number|null, now?: number}} options
 */
export function pruneHome({
  bullswarmDir, apply = false, workspacesDays = null, now = Date.now(),
} = {}) {
  const plan = planRetention({ bullswarmDir, workspacesDays, now });
  const report = {
    action: 'prune',
    apply: Boolean(apply),
    dryRun: !apply,
    at: new Date(now).toISOString(),
    policy: plan.policy,
    policyDays: plan.policy.workspacesDays,
    cutoff: plan.cutoff,
    scannedRuns: plan.scannedRuns,
    runsWithWorkspaces: plan.runsWithWorkspaces,
    workspaceBytes: plan.workspaceBytes,
    ...summarizePlan(plan),
    candidates: plan.candidates,
    skipped: plan.skipped,
    removedWorkspaces: 0,
    removedRuns: 0,
    removedBytes: 0,
    failures: [],
    skippedAtApply: [],
  };
  if (apply) Object.assign(report, applyRetention(bullswarmDir, plan, { now }));
  report.ok = report.failures.length === 0;
  report.line = pruneLine(report);
  return report;
}

// --- automatic maintenance --------------------------------------------------

/** Why an automatic sweep should not run now, or null when it should. */
export function autoSweepSkipReason(bullswarmDir, { now = Date.now(), intervalMs = AUTO_INTERVAL_MS, force = false } = {}) {
  const policy = readRetentionPolicy(bullswarmDir);
  if (!policy.enabled) return 'retention is disabled';
  if (force) return null;
  const last = readMaintenanceResults(bullswarmDir).prune;
  const lastAt = isoMs(last?.at);
  if (lastAt != null && now - lastAt < intervalMs) return 'swept recently';
  return null;
}

/**
 * Record an applied prune as the job's last result. A pass that removed nothing
 * keeps the previous real removal in `lastRemoval`, so `home status` still says
 * what the last delete was after any number of no-op sweeps.
 */
export function recordPrune(bullswarmDir, report, { trigger, now = Date.now() } = {}) {
  const removed = report.removedWorkspaces > 0;
  const previous = readMaintenanceResults(bullswarmDir).prune;
  const lastRemoval = removed
    ? { at: new Date(now).toISOString(), workspaces: report.removedWorkspaces, runs: report.removedRuns, bytes: report.removedBytes }
    : previous?.lastRemoval ?? null;
  return recordMaintenanceResult(bullswarmDir, 'prune', {
    ok: report.ok,
    trigger,
    line: report.line,
    removedWorkspaces: report.removedWorkspaces,
    removedRuns: report.removedRuns,
    removedBytes: report.removedBytes,
    failures: report.failures.length,
    lastRemoval,
  }, { now });
}

/**
 * The automatic sweep, in this process: honours `enabled`, waits its turn
 * behind the last result, holds the prune lock, applies, records. Never throws.
 */
export function runRetentionSweep({
  bullswarmDir, trigger = 'auto', now = Date.now(), intervalMs = AUTO_INTERVAL_MS, force = false,
} = {}) {
  try {
    if (!existsSync(bullswarmDir)) return { ok: true, skipped: true, skippedReason: 'no Bullswarm home here', line: 'no Bullswarm home here' };
    const why = autoSweepSkipReason(bullswarmDir, { now, intervalMs, force });
    if (why) return { ok: true, skipped: true, skippedReason: why, line: why };
    const lock = acquirePruneLock(bullswarmDir);
    if (!lock) return { ok: true, skipped: true, skippedReason: 'another prune is running', line: 'another prune is running' };
    try {
      const report = pruneHome({ bullswarmDir, apply: true, now });
      recordPrune(bullswarmDir, report, { trigger, now });
      return report;
    } finally {
      lock.release();
    }
  } catch (error) {
    const line = `prune failed: ${String(error?.message ?? error).split('\n')[0]}`;
    recordMaintenanceResult(bullswarmDir, 'prune', { ok: false, trigger, line, failures: 1 }, { now });
    return { ok: false, error: String(error?.message ?? error), line };
  }
}

const CLI_BIN = fileURLToPath(new URL('../../bin/bullswarm.js', import.meta.url));

/**
 * Whether any run in the home still holds a `workspaces/` directory: the only
 * thing a sweep can remove. One directory listing plus one lstat per run.
 */
export function hasWorkspaceCopies(bullswarmDir) {
  const root = join(bullswarmDir, 'workflows');
  let names;
  try { names = readdirSync(root); } catch { return false; }
  return names.some((name) => lstatOrNull(join(root, name, 'workspaces'))?.isDirectory() === true);
}

/**
 * Start the automatic sweep as a detached child and return immediately. This
 * is the call the kernel (after a run finalizes), watch completion and the
 * dashboard (when it opens) make: a few small reads when nothing is due or
 * no run holds a workspace copy, one unref'd spawn when something is. Returns
 * whether a child was started.
 */
export function spawnRetentionSweep({
  bullswarmDir, trigger = 'auto', now = Date.now(), spawnFn = spawn,
} = {}) {
  try {
    if (!hasWorkspaceCopies(bullswarmDir)) return false;
    if (autoSweepSkipReason(bullswarmDir, { now })) return false;
    const child = spawnFn(process.execPath, [CLI_BIN, 'home', 'prune', '--auto', '--trigger', trigger], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BULLSWARM_HOME: bullswarmDir },
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
