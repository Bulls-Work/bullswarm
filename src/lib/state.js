// bullswarm state — one JSON file at ~/.bullswarm/state.json.
//
// Doctrine:
//   S1. Quarantine always carries a re-probe deadline; a recovered pool
//       returns to service AUTOMATICALLY (fixes the /offload gap where a
//       pool benched 30 minutes stayed benched while it had recovered).
//       The deadline is 10 minutes unless the caller knows the real one — a
//       usage limit supplies its announced reset time and kind 'quota'.
//   S2. Incumbency per lane persists so picks don't flap between runs.
//   S3. Every run appends to the decision log — routing telemetry is the
//       substrate for burn-rate learning later.
//   S4. Recursion depth is owned by the CORE: the guard counter lives in
//       state, incremented by env var handshake, never trusted from args.
//   S5. state.json is a SHARED file: every write is atomic (temp+rename) and
//       every read-modify-write goes through updateState(), which holds a
//       cross-process lock over a FRESH load. A command that runs for minutes
//       must never save the copy it loaded at the start — that silently
//       discarded a concurrent `strategy set-provider beta off --yes`
//       (audit finding D5, 2026-09-09).

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fsjson.js';

export const DEFAULT_STATE = {
  version: 1,
  pools: {},        // name -> {enabled, meter:{type,windowStart?,usedPct?,declaredBy}, quarantine:{until,reason,kind}|null}
  incumbents: {},   // lane -> poolName
  decisionLog: [],  // {ts, lane, picked, keepOnClaude, ok, why, wallSec}
  config: {
    depthLimit: 2,
    callerName: 'claude-code',
    worktreeIsolation: 'agent-decides',
  },
};

export function loadState(bullswarmDir) {
  const p = join(bullswarmDir, 'state.json');
  if (!existsSync(p)) return structuredClone(DEFAULT_STATE);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      ...structuredClone(DEFAULT_STATE),
      ...raw,
      config: { ...DEFAULT_STATE.config, ...(raw.config ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(bullswarmDir, state) {
  mkdirSync(bullswarmDir, { recursive: true });
  // Temp file + rename (S5): a reader mid-write sees the previous complete
  // file, never a truncated one.
  atomicWriteFileSync(
    join(bullswarmDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

// --- locked read-modify-write (S5) ----------------------------------------

/** How long a lock file may exist before a waiter declares its holder dead. */
export const STATE_LOCK_STALE_MS = 30_000;
/** How long a waiter blocks before giving the command back to the operator. */
export const STATE_LOCK_WAIT_MS = 10_000;
/** Gap between acquisition attempts. */
export const STATE_LOCK_POLL_MS = 25;

export function stateLockPath(bullswarmDir) {
  return join(bullswarmDir, 'state.lock');
}

/** Blocking sleep: the state writers are synchronous, so the wait must be too. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the exclusive state.json lock. `wx` makes creation the atomic test —
 * only one process can win. Waiters retry for STATE_LOCK_WAIT_MS and then
 * fail loudly rather than write over the holder.
 *
 * Stale-lock takeover: a process killed between acquire and release would
 * otherwise bench state.json forever, so a lock file older than
 * STATE_LOCK_STALE_MS (30 s — orders of magnitude longer than any legitimate
 * load/mutate/write, which is a few milliseconds) is removed and retried.
 */
export function acquireStateLock(bullswarmDir, {
  staleMs = STATE_LOCK_STALE_MS,
  waitMs = STATE_LOCK_WAIT_MS,
  pollMs = STATE_LOCK_POLL_MS,
  sleep = sleepSync,
} = {}) {
  mkdirSync(bullswarmDir, { recursive: true });
  const path = stateLockPath(bullswarmDir);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      } finally {
        closeSync(fd);
      }
      return path;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let ageMs = null;
      try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { ageMs = null; }
      if (ageMs != null && ageMs > staleMs) {
        // Best effort: if another waiter takes it over first, we just retry.
        try { rmSync(path, { force: true }); } catch { /* raced */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `state.json is locked by another bullswarm process (${path}, waited ${waitMs}ms); retry the command`,
        );
      }
      sleep(pollMs);
    }
  }
}

export function releaseStateLock(path) {
  try { rmSync(path, { force: true }); } catch { /* already released */ }
}

/**
 * The only safe way to change state.json (S5): lock, load FRESH, mutate,
 * write atomically, release. The mutator mutates the state it is handed in
 * place; returning `false` aborts the write, so an observation command can
 * persist only the changes it actually made. Returns the state the mutator saw.
 */
export function updateState(bullswarmDir, mutator, opts = {}) {
  const lock = acquireStateLock(bullswarmDir, opts);
  try {
    const state = loadState(bullswarmDir);
    if (mutator(state) !== false) saveState(bullswarmDir, state);
    return state;
  } finally {
    releaseStateLock(lock);
  }
}

// --- quarantine -----------------------------------------------------------

export function quarantinePool(state, poolName, reason, now = Date.now(), {
  until = null, kind = 'auth',
} = {}) {
  // Re-probe window: 10 minutes by default (not 30) with automatic release.
  // A quota failure knows better: it passes the reset time the provider
  // announced (or its cached meter reset), so the pool comes back exactly when
  // it has quota again instead of being probed into a second failure.
  const deadline = Number.isFinite(until) && until > now ? until : now + 10 * 60_000;
  state.pools[poolName] ??= {};
  state.pools[poolName].quarantine = { until: deadline, reason, kind };
  // A quarantined pool cannot hold incumbency: it isn't serving work, and
  // keeping the flag would lock the lane against its return.
  for (const [lane, name] of Object.entries(state.incumbents ?? {})) {
    if (name === poolName) delete state.incumbents[lane];
  }
  return deadline;
}

export function releaseIfProbeDue(state, poolName, now = Date.now()) {
  const q = state.pools[poolName]?.quarantine;
  if (!q) return true;
  if (now >= q.until) {
    delete state.pools[poolName].quarantine;
    return true; // automatic return to service
  }
  return false;
}

export function sweepQuarantines(state, now = Date.now()) {
  const released = [];
  for (const name of Object.keys(state.pools)) {
    if (state.pools[name].quarantine && releaseIfProbeDue(state, name, now)) {
      released.push(name);
    }
  }
  return released;
}

// --- recursion ------------------------------------------------------------

export const DEPTH_ENV = 'BULLSWARM_DEPTH';

export function currentDepth(env = process.env) {
  const n = Number.parseInt(env[DEPTH_ENV] ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Throws when a delegate would exceed the configured depth limit.
 * The limit lives in core config — callers cannot widen it via args.
 */
export function assertDepthAllowed(state, env = process.env) {
  const depth = currentDepth(env);
  if (depth >= (state.config.depthLimit ?? 2)) {
    throw new Error(
      `recursion guard: delegate chain already at depth ${depth} ` +
      `(limit ${state.config.depthLimit}); offload refused`,
    );
  }
}

export function childDepthEnv(env = process.env) {
  return { ...env, [DEPTH_ENV]: String(currentDepth(env) + 1) };
}
