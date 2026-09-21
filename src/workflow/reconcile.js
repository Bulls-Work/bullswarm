// Incremental pricing reconciler.
//
// `workflow reprice` is the manual full backfill. This pass is its automatic
// counterpart: it prices only terminal attempts whose usage is still
// `unknown` or a byte estimate, through the same primitives (candidateFor,
// stateUsage, the result/rollup writers), and remembers every attempt it
// tried in a ledger so no work is repeated:
//
//   $BULLSWARM_HOME/pricing/reconcile.json         ledger, cursors, last pass
//   $BULLSWARM_HOME/pricing/transcript-index/*.json provider index caches
//   $BULLSWARM_HOME/pricing.lock                    one pass at a time
//
// A try that finds no transcript (`none`) or several (`ambiguous`) leaves the
// attempt exactly as it was — unknown stays unknown, an estimate stays a
// labelled estimate — and is retried only when it can come out differently:
// a fresh attempt on a short schedule (its transcript may still be
// flushing), any attempt when its provider store gains a transcript that
// overlaps its window, and every attempt when the reader version changes.
//
// Three callers: the kernel prices its own run in memory at quiet
// boundaries (reconcileRunState), watch completion and the dashboard start a
// detached child (scheduleReconcile), which runs the historical pass
// (reconcilePricing).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, readdirSync,
  statSync, unlinkSync, utimesSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { recordMaintenanceResult } from '../lib/retention.js';
import { updateState } from '../lib/state.js';
import { overlapsIndex } from '../lib/transcripts/indexing.js';
import {
  buildTranscriptIndexes,
  canIndexTranscripts,
  indexedTranscriptReader,
  transcriptOwnerName,
} from '../lib/transcripts/index.js';
import {
  attemptEntries,
  candidateFor,
  loadPricingProviders,
  MATCHED_CONFIDENCES,
  sourceOf,
  stateUsage,
  taskEntries,
  taskTextIn,
  writeRepricedRun,
} from './reprice.js';
import { isOngoing } from './short-id.js';
import { isTerminalWorkflowStatus } from './status.js';
import { acquireKernelLease } from './v2-process.js';
import { validateV2DurableState } from './v2-state.js';
import { preferredUsage } from './usage-preference.js';

export const RECONCILE_SCHEMA_VERSION = 1;
// Bump when a transcript reader or matcher changes what it can resolve: every
// attempt the ledger closed becomes eligible again exactly once.
export const RECONCILE_READER_VERSION = 'transcripts-v2-task-text-1';
export const RECONCILE_MAX_TRIES = 3;
/** Delay before try 2 and try 3 of an attempt that has just finished. */
export const RECONCILE_RETRY_DELAYS_MS = Object.freeze([60_000, 10 * 60_000]);
// An attempt that finished this long before a try has flushed its
// transcript; retrying it on the clock cannot change the answer.
export const RECONCILE_SETTLED_MS = 60 * 60_000;
/** Minimum gap between two detached passes started by the same trigger. */
export const RECONCILE_THROTTLE_MS = 5 * 60_000;

const PRICEABLE_SOURCES = new Set(['unknown', 'estimated:utf8-bytes/4']);
const LOCK_STALE_MS = 30 * 60_000;
const LOCK_INIT_GRACE_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const BIN = fileURLToPath(new URL('../../bin/bullswarm.js', import.meta.url));

function defaultBullswarmDir() {
  return process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');
}

function timeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// --- files ------------------------------------------------------------------

export function pricingDir(bullswarmDir) {
  return join(bullswarmDir, 'pricing');
}

export function reconcileLedgerPath(bullswarmDir) {
  return join(pricingDir(bullswarmDir), 'reconcile.json');
}

// Small on purpose: a view reads it every refresh while a pass runs.
export function reconcileActivePath(bullswarmDir) {
  return join(pricingDir(bullswarmDir), 'active.json');
}

export function pricingLockPath(bullswarmDir) {
  return join(bullswarmDir, 'pricing.lock');
}

function indexCachePath(bullswarmDir, provider) {
  return join(pricingDir(bullswarmDir), 'transcript-index', `${provider.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function blankLedger() {
  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    readerVersion: RECONCILE_READER_VERSION,
    cursor: { runs: {}, tasks: null },
    attempts: {},
    lastPass: null,
  };
}

/** The ledger, or a blank one. A different schema starts over. */
export function readReconcileLedger(bullswarmDir) {
  const raw = readJsonSafe(reconcileLedgerPath(bullswarmDir), null);
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== RECONCILE_SCHEMA_VERSION) return blankLedger();
  return {
    ...blankLedger(),
    ...raw,
    cursor: {
      runs: raw.cursor?.runs && typeof raw.cursor.runs === 'object' ? raw.cursor.runs : {},
      tasks: raw.cursor?.tasks ?? null,
    },
    attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {},
  };
}

function writeLedger(bullswarmDir, ledger) {
  writeJsonAtomic(reconcileLedgerPath(bullswarmDir), ledger);
}

function fileFingerprint(path) {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

// --- lock ---------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Take the home's pricing lock without waiting; null when a live pass holds
 * it. The holder touches the file while it works, so a lock is stale only
 * when its process is gone or it has not been touched for LOCK_STALE_MS.
 */
export function acquirePricingLock(bullswarmDir) {
  const path = pricingLockPath(bullswarmDir);
  // The home must already exist: a late child never recreates a removed one.
  if (!existsSync(bullswarmDir)) return null;
  const owner = { pid: process.pid, token: randomUUID(), at: new Date().toISOString() };
  for (let retry = 0; retry < 3; retry += 1) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, `${JSON.stringify(owner)}\n`); } finally { closeSync(fd); }
      let lastBeat = Date.now();
      const ours = () => {
        try { return JSON.parse(readFileSync(path, 'utf8')).token === owner.token; } catch { return false; }
      };
      return {
        path,
        heartbeat() {
          const at = Date.now();
          if (at - lastBeat < HEARTBEAT_MS) return;
          lastBeat = at;
          try { if (ours()) utimesSync(path, at / 1000, at / 1000); } catch { /* best effort */ }
        },
        release() {
          try { if (ours()) unlinkSync(path); } catch { /* never remove another pass's lock */ }
        },
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code !== 'EEXIST') throw error;
      let stat;
      try { stat = statSync(path); } catch { continue; }
      const age = Date.now() - stat.mtimeMs;
      let stale;
      try {
        const holder = JSON.parse(readFileSync(path, 'utf8'));
        stale = !pidAlive(holder.pid) || age > LOCK_STALE_MS;
      } catch {
        stale = age > LOCK_INIT_GRACE_MS;
      }
      if (!stale) return null;
      try { if (statSync(path).ino === stat.ino) unlinkSync(path); } catch { /* raced */ }
    }
  }
  return null;
}

// --- eligibility --------------------------------------------------------------

/** A terminal attempt whose usage is unknown or a byte estimate. */
export function priceableAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return false;
  // Workflow attempts record `finishedAt`; single tasks record `endedAt`.
  if (attempt.status === 'running' || !(attempt.finishedAt ?? attempt.endedAt)) return false;
  return PRICEABLE_SOURCES.has(sourceOf(attempt.usage));
}

function attemptWindow(attempt) {
  return {
    startedAt: attempt.startedAt ?? null,
    endedAt: attempt.finishedAt ?? attempt.endedAt ?? null,
  };
}

/** Whether a ledger record says this attempt should be tried now. */
function dueNow(record, nowMs) {
  if (!record || record.readerVersion !== RECONCILE_READER_VERSION) return true;
  if ((record.tries ?? 0) >= RECONCILE_MAX_TRIES) return false;
  const next = timeMs(record.nextTryAt);
  return next == null || nowMs >= next;
}

function nextRecord(record, { outcome, nowMs, startedAt = null, finishedAt, pool, provider }) {
  const fresh = !record || record.readerVersion !== RECONCILE_READER_VERSION;
  const tries = (fresh ? 0 : record.tries ?? 0) + 1;
  const finishedMs = timeMs(finishedAt);
  const settled = finishedMs == null || nowMs - finishedMs > RECONCILE_SETTLED_MS;
  const closed = outcome === 'matched' || outcome === 'no-reader' || settled || tries >= RECONCILE_MAX_TRIES;
  const delay = RECONCILE_RETRY_DELAYS_MS[Math.min(tries - 1, RECONCILE_RETRY_DELAYS_MS.length - 1)];
  return {
    tries: closed ? Math.max(tries, RECONCILE_MAX_TRIES) : tries,
    lastTriedAt: iso(nowMs),
    nextTryAt: closed ? null : iso(nowMs + delay),
    lastOutcome: outcome,
    readerVersion: RECONCILE_READER_VERSION,
    pool: pool ?? null,
    provider: provider ?? null,
    // The window lets a later pass decide from the ledger alone whether a new
    // transcript could belong to this attempt.
    startedAt,
    finishedAt: finishedAt ?? null,
  };
}

// Closed, still unmeasured: only a new transcript or a new reader reopens it.
function closedUnmeasured(record) {
  return record
    && record.readerVersion === RECONCILE_READER_VERSION
    && (record.tries ?? 0) >= RECONCILE_MAX_TRIES
    && (record.lastOutcome === 'none' || record.lastOutcome === 'ambiguous')
    && typeof record.provider === 'string';
}

// --- transcript indexes -------------------------------------------------------

function readIndexCache(bullswarmDir, provider, transcriptHome) {
  const cached = readJsonSafe(indexCachePath(bullswarmDir, provider), null);
  if (!cached || cached.readerVersion !== RECONCILE_READER_VERSION) return null;
  return cached.index?.home === transcriptHome ? cached.index : null;
}

/**
 * Build (or incrementally refresh) the indexes of `names`. A provider whose
 * builder supports `previous` rereads only changed transcripts, and its
 * `changedFiles` tell the caller which pending attempts a new transcript
 * could now resolve.
 */
function refreshIndexes({ bullswarmDir, transcriptHome, providers, names, stats }) {
  if (!names.size) return {};
  const previous = {};
  for (const name of names) previous[name] = readIndexCache(bullswarmDir, name, transcriptHome);
  const began = Date.now();
  const indexes = buildTranscriptIndexes({
    home: transcriptHome, providers, bullswarmDir, only: [...names], previous,
  });
  stats.indexBuildMs += Date.now() - began;
  for (const [name, index] of Object.entries(indexes)) {
    if (!index) continue;
    stats.indexesBuilt += 1;
    const changed = Array.isArray(index.changedFiles) ? index.changedFiles.length : index.entries?.length ?? 0;
    stats.transcriptsRead += changed;
    // Only an incremental index is worth caching: a full rebuild never reads it.
    if (Array.isArray(index.changedFiles) && (changed || !previous[name])) {
      try {
        writeJsonAtomic(indexCachePath(bullswarmDir, name), {
          readerVersion: RECONCILE_READER_VERSION,
          savedAt: new Date().toISOString(),
          index: { ...index, changedFiles: undefined, grownFrom: undefined },
        });
      } catch { /* a cache is an optimisation only */ }
    }
  }
  return indexes;
}

// The time ranges this pass added to the store: a new transcript's whole
// span, and for one that grew only what came after its previous last row (a
// days-long interactive session must not reopen every attempt it spans).
function changedEntries(index) {
  if (!index || !Array.isArray(index.changedFiles) || !index.changedFiles.length) return [];
  const changed = new Set(index.changedFiles);
  const grownFrom = index.grownFrom ?? {};
  return (index.entries ?? [])
    .filter((entry) => changed.has(entry.file))
    .map((entry) => {
      const previousLast = Object.hasOwn(grownFrom, entry.file) ? timeMs(grownFrom[entry.file]) : null;
      // The previous last row is not new; the appended ones come after it.
      return previousLast == null ? entry : { ...entry, firstAt: iso(previousLast + 1) };
    });
}

// --- pricing core -------------------------------------------------------------

function newStats() {
  return {
    eligible: 0,
    due: 0,
    reopened: 0,
    scannedRuns: 0,
    parsedRuns: 0,
    scannedAttempts: 0,
    matched: 0,
    ambiguous: 0,
    missing: 0,
    noReader: 0,
    changedRuns: 0,
    changedTasks: 0,
    skippedRuns: 0,
    indexesBuilt: 0,
    indexBuildMs: 0,
    transcriptsRead: 0,
    failures: [],
    byPool: {},
  };
}

function poolStats(stats, pool) {
  const key = pool ?? 'unknown';
  stats.byPool[key] ??= { tried: 0, matched: 0, ambiguous: 0, missing: 0 };
  return stats.byPool[key];
}

/**
 * Refresh the cached index of every provider that has closed, unmeasured
 * attempts, and reopen each attempt that a new or grown transcript overlaps.
 * Returns the refreshed indexes (reused by the pricing step) and the reopened
 * ledger keys.
 */
function reopenFromStores({ ledger, bullswarmDir, transcriptHome, pricing: lazyPricing, stats }) {
  const byProvider = new Map();
  for (const [key, record] of Object.entries(ledger.attempts)) {
    if (!closedUnmeasured(record)) continue;
    if (!byProvider.has(record.provider)) byProvider.set(record.provider, []);
    byProvider.get(record.provider).push([key, record]);
  }
  const names = new Set([...byProvider.keys()]
    .filter((name) => readIndexCache(bullswarmDir, name, transcriptHome)));
  if (!names.size) return { indexes: {}, reopened: new Set() };
  const indexes = refreshIndexes({ bullswarmDir, transcriptHome, providers: lazyPricing().providers, names, stats });
  const reopened = new Set();
  for (const [name, index] of Object.entries(indexes)) {
    const changed = changedEntries(index);
    if (!changed.length) continue;
    for (const [key, record] of byProvider.get(name) ?? []) {
      if (changed.some((entry) => overlapsIndex(entry, record.startedAt, record.finishedAt))) {
        delete ledger.attempts[key];
        reopened.add(key);
      }
    }
  }
  stats.reopened += reopened.size;
  return { indexes, reopened };
}

/**
 * Price every due item. Each item is `{ key, attempt, state, dir }`; a
 * matched item gets `item.usage` (and `cwd`, `project`) for the caller to
 * persist. The ledger is mutated in place.
 */
function priceItems(items, { ledger, bullswarmDir, transcriptHome, pricing: lazyPricing, nowMs, stats, lock, indexes = {} }) {
  if (!items.length) return;
  const pricing = lazyPricing();
  const ownerOf = new Map();
  const owner = (pool) => {
    if (!ownerOf.has(pool)) {
      ownerOf.set(pool, transcriptOwnerName(pool, { home: transcriptHome, providers: pricing.providers, bullswarmDir }));
    }
    return ownerOf.get(pool);
  };
  const due = [];
  for (const item of items) {
    stats.eligible += 1;
    item.provider = owner(item.attempt.pool);
    if (dueNow(ledger.attempts[item.key], nowMs)) due.push(item);
  }
  if (!due.length) return;

  const names = new Set();
  for (const item of due) {
    if (item.provider && !indexes[item.provider]
      && canIndexTranscripts(item.provider, { home: transcriptHome, providers: pricing.providers, bullswarmDir })) {
      names.add(item.provider);
    }
  }
  const built = {
    ...indexes,
    ...refreshIndexes({ bullswarmDir, transcriptHome, providers: pricing.providers, names, stats }),
  };
  lock?.heartbeat();
  const reader = indexedTranscriptReader({
    home: transcriptHome, providers: pricing.providers, bullswarmDir, indexes: built,
  });
  for (const item of due) {
    stats.due += 1;
    stats.scannedAttempts += 1;
    lock?.heartbeat();
    const { attempt } = item;
    const record = ledger.attempts[item.key];
    const window = attemptWindow(attempt);
    const base = {
      nowMs, startedAt: window.startedAt, finishedAt: window.endedAt, pool: attempt.pool ?? null, provider: item.provider,
    };
    if (!item.provider) {
      stats.noReader += 1;
      ledger.attempts[item.key] = nextRecord(record, { ...base, outcome: 'no-reader' });
      continue;
    }
    const perPool = poolStats(stats, attempt.pool);
    perPool.tried += 1;
    let candidate;
    try {
      candidate = candidateFor({
        attempt,
        state: item.state,
        connectors: pricing.connectors,
        home: bullswarmDir,
        transcriptHome,
        readTranscriptUsage: reader,
        taskText: taskTextIn(item.dir, attempt.taskFile),
      });
    } catch (error) {
      stats.failures.push({ key: item.key, error: error.message });
      ledger.attempts[item.key] = nextRecord(record, { ...base, outcome: 'error' });
      continue;
    }
    // A matched transcript with no counted tokens is not a measurement.
    const matched = MATCHED_CONFIDENCES.has(candidate.confidence)
      && sourceOf(candidate.usage) === 'transcript-summed'
      && Number.isFinite(candidate.usage?.tokens?.totalKnown);
    const outcome = matched
      ? 'matched'
      : candidate.confidence === 'ambiguous' ? 'ambiguous' : 'none';
    if (outcome === 'matched') { stats.matched += 1; perPool.matched += 1; }
    else if (outcome === 'ambiguous') { stats.ambiguous += 1; perPool.ambiguous += 1; }
    else { stats.missing += 1; perPool.missing += 1; }
    ledger.attempts[item.key] = { ...nextRecord(record, { ...base, outcome }), confidence: candidate.confidence };
    if (matched) {
      item.usage = candidate.usage;
      item.cwd = candidate.cwd;
      item.project = candidate.projectChanged ? candidate.project : null;
    }
  }
}

function applyToAttempt(attempt, item) {
  attempt.usage = preferredUsage(attempt.usage ?? null, item.usage);
  if (item.cwd && !attempt.cwd) attempt.cwd = item.cwd;
  if (item.project) attempt.project = item.project;
}

function summaryLine(stats, { scope }) {
  const priced = stats.matched;
  const left = stats.ambiguous + stats.missing;
  const parts = [`${priced} attempt${priced === 1 ? '' : 's'} priced`];
  if (left) parts.push(`${left} still unmeasured (${stats.ambiguous} ambiguous, ${stats.missing} no transcript)`);
  if (!stats.due) parts.push('nothing due');
  parts.push(`${stats.changedRuns + stats.changedTasks} record${stats.changedRuns + stats.changedTasks === 1 ? '' : 's'} rewritten`);
  return `${scope}: ${parts.join(' · ')}`;
}

function finishPass(bullswarmDir, ledger, { stats, beganAt, trigger, scope, status = 'complete' }) {
  const finishedAt = Date.now();
  ledger.readerVersion = RECONCILE_READER_VERSION;
  ledger.lastPass = {
    status,
    trigger,
    scope,
    startedAt: iso(beganAt),
    finishedAt: iso(finishedAt),
    elapsedMs: finishedAt - beganAt,
    ...stats,
    failures: stats.failures.slice(0, 20),
    line: summaryLine(stats, { scope }),
  };
  writeLedger(bullswarmDir, ledger);
  try { unlinkSync(reconcileActivePath(bullswarmDir)); } catch { /* none was written */ }
  recordResult(bullswarmDir, ledger.lastPass);
  return ledger.lastPass;
}

function recordResult(bullswarmDir, pass) {
  // `home status` shows the last reprice beside the last prune.
  recordMaintenanceResult(bullswarmDir, 'reprice', {
    ok: pass.failures.length === 0,
    trigger: pass.trigger,
    line: pass.line,
    matched: pass.matched,
    ambiguous: pass.ambiguous,
    missing: pass.missing,
    changedRuns: pass.changedRuns,
    changedTasks: pass.changedTasks,
    elapsedMs: pass.elapsedMs,
  });
}

// --- historical pass ------------------------------------------------------------

function runDirs(bullswarmDir) {
  const root = join(bullswarmDir, 'workflows');
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return []; }
  return names.filter((name) => name.startsWith('wf-')).map((name) => ({ runId: name, runDir: join(root, name) }));
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function stateValid(state) {
  try { return validateV2DurableState(state); } catch { return false; }
}

// A run (or the task log) stays open while one of its unmeasured attempts
// can still come due on the clock; closed attempts reopen via the ledger.
function openItems(items, ledger) {
  return items.some((item) => !item.usage && !closedUnmeasured(ledger.attempts[item.key])
    && ledger.attempts[item.key]?.lastOutcome !== 'no-reader');
}

/**
 * One incremental pass over every terminal run and single task of a home.
 * Never throws for a busy home; returns `{ status: 'busy' }` instead.
 */
export function reconcilePricing({
  bullswarmDir = defaultBullswarmDir(),
  transcriptHome = homedir(),
  connectors = null,
  providers = null,
  trigger = 'manual',
  now = () => Date.now(),
} = {}) {
  const beganAt = Date.now();
  if (!existsSync(join(bullswarmDir, 'state.json')) && !existsSync(join(bullswarmDir, 'workflows'))) {
    return { status: 'skipped', reason: 'no Bullswarm home here', trigger };
  }
  const lock = acquirePricingLock(bullswarmDir);
  if (!lock) return { status: 'busy', trigger };
  try {
    const nowMs = now();
    const ledger = readReconcileLedger(bullswarmDir);
    const readerChanged = ledger.readerVersion !== RECONCILE_READER_VERSION;
    if (readerChanged) ledger.cursor = { runs: {}, tasks: null };
    const stats = newStats();
    // Provider modules load only when there is something to price.
    let loaded = null;
    const pricing = () => (loaded ??= loadPricingProviders(bullswarmDir, { connectors, providers }));
    const { indexes, reopened } = reopenFromStores({ ledger, bullswarmDir, transcriptHome, pricing, stats });
    const reopenedRuns = new Set([...reopened].map((key) => key.split('/')[0]));

    // Runs: parse only a state.json that changed since the last pass, that
    // still has attempts due on the clock, or that a new transcript reopened.
    const runs = [];
    const items = [];
    for (const { runId, runDir } of runDirs(bullswarmDir)) {
      stats.scannedRuns += 1;
      const statePath = join(runDir, 'state.json');
      const fingerprint = fileFingerprint(statePath);
      const cursor = ledger.cursor.runs[runId];
      if (fingerprint && cursor?.fingerprint === fingerprint && !cursor.open && !reopenedRuns.has(runId)) continue;
      const state = readState(statePath);
      stats.parsedRuns += 1;
      if (!state || state.schemaVersion == null || !state.lifecycle) {
        ledger.cursor.runs[runId] = { fingerprint, open: false };
        continue;
      }
      // A live kernel prices its own run; an unfinished one is not history yet.
      if (!isTerminalWorkflowStatus(state.lifecycle.status) || isOngoing(runDir, state)) {
        ledger.cursor.runs[runId] = { fingerprint: null, open: true };
        continue;
      }
      const runItems = [];
      for (const entry of attemptEntries(state)) {
        if (!priceableAttempt(entry.attempt)) continue;
        runItems.push({ key: `${runId}/${entry.attemptId}`, attempt: entry.attempt, state, dir: runDir });
      }
      runs.push({ runId, runDir, state, items: runItems, fingerprint });
      items.push(...runItems);
    }

    // Single tasks live in the home's decision log.
    const homeStatePath = join(bullswarmDir, 'state.json');
    const homeFingerprint = fileFingerprint(homeStatePath);
    const taskItems = [];
    const taskCursor = ledger.cursor.tasks;
    const tasksUnchanged = taskCursor?.fingerprint === homeFingerprint && !taskCursor.open && !reopenedRuns.has('task');
    if (homeFingerprint && !tasksUnchanged) {
      const homeState = readState(homeStatePath);
      for (const entry of taskEntries(homeState ?? {})) {
        if (!priceableAttempt(entry.attempt)) continue;
        taskItems.push({
          key: `task/${entry.attemptId}`,
          attempt: entry.attempt,
          task: entry.task,
          state: {
            runId: `task:${entry.attemptId}`,
            lifecycle: { finishedAt: entry.attempt.finishedAt ?? entry.attempt.endedAt ?? null },
            intent: { cwd: entry.attempt.cwd },
          },
          dir: join(bullswarmDir, 'runs'),
        });
      }
      items.push(...taskItems);
    }

    if (items.length) {
      try {
        writeJsonAtomic(reconcileActivePath(bullswarmDir), {
          pid: process.pid, trigger, startedAt: iso(beganAt), eligible: items.length,
        });
      } catch { /* the note is cosmetic */ }
    }
    priceItems(items, { ledger, bullswarmDir, transcriptHome, pricing, nowMs, stats, lock, indexes });

    for (const run of runs) {
      const changed = run.items.filter((item) => item.usage);
      let fingerprint = run.fingerprint;
      if (changed.length) {
        let lease = null;
        try {
          // A short-lived fence: no kernel may resume this run mid-write.
          lease = acquireKernelLease(run.runDir);
          const fresh = readState(join(run.runDir, 'state.json'));
          if (!fresh || JSON.stringify(fresh.attempts) !== JSON.stringify(run.state.attempts)) {
            throw new Error('run changed during the pass; it is retried next pass');
          }
          const wasValid = stateValid(run.state);
          for (const item of changed) applyToAttempt(item.attempt, item);
          run.state.usage = stateUsage(run.state);
          if (wasValid) validateV2DurableState(run.state);
          const existingResult = readJsonSafe(join(run.runDir, 'result.json'), null);
          writeRepricedRun(run.runDir, run.state, existingResult, {
            finishedAt: existingResult?.finishedAt ?? run.state.lifecycle?.finishedAt,
            cwd: changed.find((item) => item.cwd)?.cwd,
            project: changed.find((item) => item.project)?.project ?? undefined,
          });
          stats.changedRuns += 1;
          fingerprint = fileFingerprint(join(run.runDir, 'state.json'));
        } catch (error) {
          stats.skippedRuns += 1;
          stats.failures.push({ key: run.runId, error: error.message });
          for (const item of changed) delete ledger.attempts[item.key];
          fingerprint = null;
        } finally {
          lease?.release();
        }
      }
      ledger.cursor.runs[run.runId] = { fingerprint, open: openItems(run.items, ledger) };
    }

    const pricedTasks = taskItems.filter((item) => item.usage);
    if (pricedTasks.length) {
      try {
        updateState(bullswarmDir, (state) => {
          const log = Array.isArray(state.decisionLog) ? state.decisionLog : [];
          let wrote = 0;
          for (const item of pricedTasks) {
            const live = log.find((entry) => entry && (
              (item.task.id != null && entry.id === item.task.id)
              || (item.task.id == null && entry.outFile === item.task.outFile && entry.ts === item.task.ts)
            ));
            if (!live || !PRICEABLE_SOURCES.has(sourceOf(live.usage))) continue;
            applyToAttempt(live, item);
            wrote += 1;
          }
          stats.changedTasks += wrote;
          return wrote > 0;
        });
      } catch (error) {
        stats.failures.push({ key: 'state.json', error: error.message });
        for (const item of pricedTasks) delete ledger.attempts[item.key];
      }
    }
    if (homeFingerprint && !tasksUnchanged) {
      ledger.cursor.tasks = { fingerprint: fileFingerprint(homeStatePath), open: openItems(taskItems, ledger) };
    }
    const pass = finishPass(bullswarmDir, ledger, { stats, beganAt, trigger, scope: 'history' });
    return { status: 'complete', ...pass };
  } finally {
    lock.release();
  }
}

// --- kernel pass ----------------------------------------------------------------

// A kernel asks at every quiet boundary; its providers do not change mid-run.
const KERNEL_PROVIDER_TTL_MS = 5 * 60_000;
const kernelProviders = new Map();

function providersForKernel(bullswarmDir, { connectors, providers }) {
  if (connectors || providers) return loadPricingProviders(bullswarmDir, { connectors, providers });
  const cached = kernelProviders.get(bullswarmDir);
  if (cached && Date.now() - cached.at < KERNEL_PROVIDER_TTL_MS) return cached.value;
  const value = loadPricingProviders(bullswarmDir);
  kernelProviders.set(bullswarmDir, { at: Date.now(), value });
  return value;
}

/**
 * Price the kernel's own run in memory. The caller holds the kernel lease
 * and persists `state` afterwards; nothing here writes the run directory.
 * Skipped (and harmless) while any attempt is still running, because the
 * aggregate usage is recomputed from every attempt.
 */
export function reconcileRunState(state, {
  runDir,
  bullswarmDir = defaultBullswarmDir(),
  transcriptHome = homedir(),
  connectors = null,
  providers = null,
  trigger = 'kernel',
  now = () => Date.now(),
} = {}) {
  const beganAt = Date.now();
  const all = attemptEntries(state);
  if (all.some((entry) => entry.attempt?.status === 'running')) return { status: 'skipped', reason: 'attempts running', changed: 0 };
  const candidates = all.filter((entry) => priceableAttempt(entry.attempt));
  if (!candidates.length) return { status: 'complete', changed: 0 };
  // Only pools whose provider reads transcripts can ever be priced here.
  const pricingContext = providersForKernel(bullswarmDir, { connectors, providers });
  const items = candidates
    .filter((entry) => transcriptOwnerName(entry.attempt.pool, {
      home: transcriptHome, providers: pricingContext.providers, bullswarmDir,
    }))
    .map((entry) => ({ key: `${state.runId}/${entry.attemptId}`, attempt: entry.attempt, state, dir: runDir }));
  if (!items.length) return { status: 'complete', changed: 0 };
  const nowMs = now();
  const ledger = readReconcileLedger(bullswarmDir);
  if (!items.some((item) => dueNow(ledger.attempts[item.key], nowMs))) return { status: 'complete', changed: 0 };
  const lock = acquirePricingLock(bullswarmDir);
  if (!lock) return { status: 'busy', changed: 0 };
  try {
    const fresh = readReconcileLedger(bullswarmDir);
    const stats = newStats();
    priceItems(items, { ledger: fresh, bullswarmDir, transcriptHome, pricing: () => pricingContext, nowMs, stats, lock });
    const changed = items.filter((item) => item.usage);
    for (const item of changed) applyToAttempt(item.attempt, item);
    if (changed.length) state.usage = stateUsage(state);
    const pass = finishPass(bullswarmDir, fresh, { stats: { ...stats, changedRuns: changed.length ? 1 : 0 }, beganAt, trigger, scope: `run ${state.runId}` });
    return { status: 'complete', changed: changed.length, pass };
  } finally {
    lock.release();
  }
}

// --- detached child ---------------------------------------------------------------

/**
 * Start one detached historical pass unless a pass is running or one started
 * within `throttleMs`. Never waits for it; returns what it decided.
 */
export function scheduleReconcile({
  bullswarmDir = defaultBullswarmDir(),
  trigger = 'dashboard',
  throttleMs = RECONCILE_THROTTLE_MS,
  delayMs = 0,
  transcriptHome = null,
  spawnImpl = spawn,
  now = Date.now(),
} = {}) {
  try {
    if (!existsSync(join(bullswarmDir, 'state.json'))) return { started: false, reason: 'no Bullswarm home here' };
    const lockPath = pricingLockPath(bullswarmDir);
    if (existsSync(lockPath)) {
      try {
        const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (pidAlive(holder.pid)) return { started: false, reason: 'a pricing pass is running' };
      } catch { return { started: false, reason: 'a pricing pass is starting' }; }
    }
    const ledger = readReconcileLedger(bullswarmDir);
    const last = timeMs(ledger.lastPass?.startedAt);
    if (last != null && ledger.lastPass?.scope === 'history' && now - last < throttleMs) {
      return { started: false, reason: 'throttled' };
    }
    const args = [BIN, 'workflow', 'reprice', '--incremental', '--trigger', trigger];
    if (transcriptHome) args.push('--transcript-home', transcriptHome);
    if (delayMs > 0) args.push('--delay-ms', String(Math.round(delayMs)));
    const child = spawnImpl(process.execPath, args, {
      env: { ...process.env, BULLSWARM_HOME: bullswarmDir },
      detached: true,
      stdio: 'ignore',
    });
    child.once?.('error', () => { /* a pass that cannot start is retried next time */ });
    child.unref?.();
    return { started: true, pid: child.pid ?? null };
  } catch (error) {
    return { started: false, reason: error.message };
  }
}

/** One quiet line for a view while a pass runs, or null. */
export function reconcileActivity(bullswarmDir) {
  const active = readJsonSafe(reconcileActivePath(bullswarmDir), null);
  if (!active || !pidAlive(active.pid)) return null;
  const count = Number(active.eligible) || 0;
  return count ? `pricing ${count} older record${count === 1 ? '' : 's'}…` : null;
}
