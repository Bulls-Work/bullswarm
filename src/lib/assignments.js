// In-flight assignment ledger — the cross-process record of work that is
// running RIGHT NOW, so load is visible to every Bullswarm process at once.
//
// Doctrine:
//   A1. One small JSON file per in-flight assignment under
//       <BULLSWARM_HOME>/assignments/. A directory of independent files (not
//       one shared document) is what lets a `bullswarm run`, a V1 runtime and
//       four concurrent V2 kernel actions write at the same instant without a
//       lock and without ever losing each other's entries.
//   A2. Every write is atomic: temp file then rename. A reader can therefore
//       only ever see a complete record, never a half-written one.
//   A3. A crashed process must never leave phantom load. Every read prunes
//       entries whose owning processes are gone, and entries older than 12
//       hours, so the ledger self-heals instead of needing a reaper.
//   A4. Durations are never invented here. `expectedMinutes` is either a
//       caller-supplied number or comes from the spend model
//       (src/lib/spend.js, imported lazily and optionally); when neither
//       exists the field is null and `expectedSource` says so.

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** An assignment this old is stale by definition, live pids or not (A3). */
export const ASSIGNMENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Sources allowed to register work; anything else is a caller bug. */
export const ASSIGNMENT_SOURCES = Object.freeze(['run', 'workflow-v2']);
const EFFORTS = new Set(['high', 'medium', 'low']);

/** `<BULLSWARM_HOME>/assignments` — every API below takes the HOME, not this. */
export function assignmentsDir(bullswarmDir) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) {
    throw new TypeError('assignments: bullswarmDir is required');
  }
  return join(bullswarmDir, 'assignments');
}

/**
 * Ledger bookkeeping must never break a real dispatch: an unwritable home or
 * a full disk costs us load visibility, not the user's work. Dispatch paths
 * wrap their ledger calls in this; tests call the raw functions so argument
 * mistakes still throw.
 */
export function withLedger(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

/**
 * Liveness by signal 0. EPERM means the pid exists but belongs to another
 * user — alive, and pruning it would be exactly the phantom-load bug in
 * reverse (dropping real load we cannot signal).
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// --- spend model (optional dependency) ---------------------------------------

let spendModule;

/**
 * Expected wall-clock minutes for a (lane, effort) pair, from the spend model
 * if it exists. Resolved once per process and memoized. A missing
 * src/lib/spend.js is not an error: the ledger still records real work, it
 * just records that no expectation was available.
 *
 * `opts` is forwarded to the spend model untouched — callers that already
 * hold core state pass `{decisionLog}` so the estimate comes from measured
 * history rather than a documented default. The model's own verdict is kept
 * in `expectedSource` so a reader can tell the two apart.
 */
export async function expectedMinutesFromSpendModel({ lane = null, effort = null } = {}, opts = {}) {
  spendModule ??= import('./spend.js').then((mod) => mod, () => null);
  const mod = await spendModule;
  const fn = mod?.expectedMinutesFor;
  if (typeof fn !== 'function') {
    return { expectedMinutes: null, expectedSource: 'unavailable:src/lib/spend.js' };
  }
  try {
    const raw = fn({ lane, effort }, opts);
    const structured = raw !== null && typeof raw === 'object';
    const minutes = Number(structured ? (raw.minutes ?? raw.expectedMinutes ?? null) : raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { expectedMinutes: null, expectedSource: 'spend-model:no-estimate' };
    }
    const detail = structured && typeof raw.source === 'string' ? raw.source : 'expectedMinutesFor';
    return { expectedMinutes: minutes, expectedSource: `spend-model:${detail}` };
  } catch {
    return { expectedMinutes: null, expectedSource: 'spend-model:error' };
  }
}

// --- storage -----------------------------------------------------------------

function writeRecord(dir, record) {
  mkdirSync(dir, { recursive: true });
  // A dot-prefixed, non-.json temp name is invisible to listAssignments even
  // in the instant before the rename lands (A2).
  const temp = join(dir, `.${record.id}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  try {
    renameSync(temp, join(dir, `${record.id}.json`));
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  return record;
}

function readRecord(dir, id) {
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function nullableInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** null/undefined/'' are "no expectation" — never coerce them to a real 0. */
function nullableNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// --- API ---------------------------------------------------------------------

/**
 * Register one in-flight assignment the moment a pool is picked — before the
 * worker is spawned, so a pool never looks idle during process startup.
 *
 * @param {string} bullswarmDir  BULLSWARM_HOME (the ledger lives beneath it)
 * @param {object} fields        pool (required) plus model/lane/effort/source/
 *                               runId/actionId/attempt/expectedMinutes/
 *                               expectedSource/workerPid/startedAt/id
 * @returns {object} the stored record
 */
export function registerAssignment(bullswarmDir, fields = {}) {
  const dir = assignmentsDir(bullswarmDir);
  if (typeof fields.pool !== 'string' || !fields.pool) {
    throw new TypeError('registerAssignment: pool is required');
  }
  if (fields.source != null && !ASSIGNMENT_SOURCES.includes(fields.source)) {
    throw new TypeError(`registerAssignment: source must be one of ${ASSIGNMENT_SOURCES.join(', ')}`);
  }
  if (fields.effort != null && !EFFORTS.has(fields.effort)) {
    throw new TypeError('registerAssignment: effort must be high, medium, or low');
  }
  const expectedMinutes = nullableNumber(fields.expectedMinutes);
  const record = {
    id: typeof fields.id === 'string' && fields.id ? fields.id : randomUUID(),
    pool: fields.pool,
    model: fields.model ?? null,
    lane: fields.lane ?? null,
    effort: fields.effort ?? null,
    source: fields.source ?? null,
    runId: fields.runId ?? null,
    actionId: fields.actionId ?? null,
    attempt: nullableInt(fields.attempt),
    kernelPid: process.pid,
    workerPid: nullableInt(fields.workerPid),
    startedAt: typeof fields.startedAt === 'string' && fields.startedAt
      ? fields.startedAt
      : new Date().toISOString(),
    expectedMinutes,
    expectedSource: fields.expectedSource ?? (expectedMinutes == null ? 'none' : 'caller'),
  };
  return writeRecord(dir, record);
}

/**
 * Release an assignment when its attempt ends. Returns whether an entry was
 * actually removed, so a double release is visible but harmless.
 */
export function releaseAssignment(bullswarmDir, id) {
  if (typeof id !== 'string' || !id) return false;
  try {
    unlinkSync(join(assignmentsDir(bullswarmDir), `${id}.json`));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Patch a live assignment — in practice `{workerPid}` once the child spawns.
 * Returns the updated record, or null if the entry is already gone (the
 * attempt finished, or another process pruned it).
 */
export function updateAssignment(bullswarmDir, id, patch = {}) {
  const dir = assignmentsDir(bullswarmDir);
  const current = readRecord(dir, id);
  if (!current) return null;
  const next = { ...current };
  if ('workerPid' in patch) next.workerPid = nullableInt(patch.workerPid);
  if ('model' in patch) next.model = patch.model ?? null;
  if ('attempt' in patch) next.attempt = nullableInt(patch.attempt);
  if ('runId' in patch) next.runId = patch.runId ?? null;
  if ('actionId' in patch) next.actionId = patch.actionId ?? null;
  if ('expectedMinutes' in patch) next.expectedMinutes = nullableNumber(patch.expectedMinutes);
  if ('expectedSource' in patch) next.expectedSource = patch.expectedSource ?? null;
  return writeRecord(dir, next);
}

/**
 * Every live assignment, newest last. Pruning (A3) removes:
 *   - entries older than 12 hours, and
 *   - entries whose kernel process is dead and whose worker is absent or dead.
 * A live kernel with no worker yet is KEPT: that is a pool picked microseconds
 * ago whose child has not spawned, which is precisely the load we exist to
 * make visible.
 */
export function listAssignments(bullswarmDir, { now = Date.now(), prune = true } = {}) {
  const dir = assignmentsDir(bullswarmDir);
  if (!existsSync(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const live = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const path = join(dir, file);
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { record = null; }
    if (!record || typeof record.pool !== 'string') {
      // Unreadable entries hold no usable load information. Drop them only
      // once they are older than the max age, so a file being written by an
      // older/newer version is never destroyed on sight.
      if (prune && olderThanMaxAge(path, now)) tryUnlink(path);
      continue;
    }
    if (!prune) { live.push(record); continue; }
    // The reader's own entries are known-live work by construction. Deleting
    // one would erase load we are about to consume, so they are exempt from
    // every prune rule including the age cap.
    if (record.kernelPid === process.pid) { live.push(record); continue; }
    const startedMs = Date.parse(record.startedAt);
    const tooOld = !Number.isFinite(startedMs) || now - startedMs > ASSIGNMENT_MAX_AGE_MS;
    const kernelAlive = isProcessAlive(record.kernelPid);
    const workerAlive = record.workerPid != null && isProcessAlive(record.workerPid);
    if (tooOld || (!kernelAlive && !workerAlive)) {
      tryUnlink(path);
      continue;
    }
    live.push(record);
  }
  return live.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function olderThanMaxAge(path, now) {
  try { return now - statSync(path).mtimeMs > ASSIGNMENT_MAX_AGE_MS; } catch { return false; }
}

function tryUnlink(path) {
  try { unlinkSync(path); } catch { /* another process pruned it first */ }
}

/** Live assignments grouped by pool name. */
export function inflightByPool(bullswarmDir, opts = {}) {
  const byPool = new Map();
  for (const record of listAssignments(bullswarmDir, opts)) {
    if (!byPool.has(record.pool)) byPool.set(record.pool, []);
    byPool.get(record.pool).push(record);
  }
  return byPool;
}

/** Per-entry view used by both `attachInflight` and the CLI renderer. */
export function describeAssignment(record, now = Date.now()) {
  const startedMs = Date.parse(record.startedAt);
  const elapsedMinutes = Number.isFinite(startedMs)
    ? round(Math.max(0, now - startedMs) / 60_000)
    : null;
  const expectedMinutes = nullableNumber(record.expectedMinutes);
  return {
    id: record.id,
    lane: record.lane ?? null,
    effort: record.effort ?? null,
    startedAt: record.startedAt ?? null,
    elapsedMinutes,
    expectedMinutes,
    remainingMinutes: expectedMinutes == null || elapsedMinutes == null
      ? null
      : round(Math.max(0, expectedMinutes - elapsedMinutes)),
  };
}

/**
 * Stamp `pool.inflight` on every pool view (mutates and returns `pools`), so
 * routing and `bullswarm pools` read current load from the same record.
 *
 * `minutes` is total elapsed worker-minutes in flight — always a real number.
 * `remainingMinutes` sums only entries that carry an expectation and is null
 * when none do; `unknownExpected` counts the entries it could not include.
 */
export function attachInflight(pools, bullswarmDir, opts = {}) {
  const now = opts.now ?? Date.now();
  const byPool = inflightByPool(bullswarmDir, { ...opts, now });
  for (const pool of pools ?? []) {
    const records = (byPool.get(pool.name) ?? []).map((record) => describeAssignment(record, now));
    const known = records.filter((r) => r.remainingMinutes != null);
    pool.inflight = {
      count: records.length,
      minutes: round(records.reduce((sum, r) => sum + (r.elapsedMinutes ?? 0), 0)),
      remainingMinutes: known.length
        ? round(known.reduce((sum, r) => sum + r.remainingMinutes, 0))
        : null,
      unknownExpected: records.length - known.length,
      records,
    };
  }
  return pools;
}
