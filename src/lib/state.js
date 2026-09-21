// bullswarm state — one JSON file at ~/.bullswarm/state.json.
//
// Doctrine:
//   S1. Quarantine always carries a re-probe deadline; a recovered pool
//       returns to service AUTOMATICALLY (fixes the /offload gap where a
//       pool benched 30 minutes stayed benched while it had recovered).
//       The deadline is 10 minutes unless the caller knows the real one — a
//       usage limit supplies its announced reset time and kind 'quota'.
//       A quota pause is only written with proof (quota.js Q6): the
//       decideQuotaPause() evidence travels with it and is stored on the
//       record. `strategy.pausing: "off"` (quota.js Q7) refuses EVERY
//       automatic pause — quota, auth, the credential-group siblings that
//       bench with an auth pause, and the soft bench a strike would write —
//       which is why it is checked here, at the one place all of them are
//       written. `resumePool` (`bullswarm pools resume`) lifts any pause at
//       once.
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

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fsjson.js';
import { pausingEnabled, quotaPauseProven } from './quota.js';

export const RENAMED_POOL_FROM = 'opencode2';
export const RENAMED_POOL_TO = 'opencode';

/**
 * The OpenCode pool was called `opencode2` before the CLI was renamed. Pool
 * names are hierarchical (`opencode2:<account-slug>`), so only the exact
 * name and its colon-prefixed children are migrated.
 */
export function migratedPoolName(value) {
  if (typeof value !== 'string') return value;
  if (value === RENAMED_POOL_FROM || value.startsWith(`${RENAMED_POOL_FROM}:`)) {
    return `${RENAMED_POOL_TO}${value.slice(RENAMED_POOL_FROM.length)}`;
  }
  return value;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && deepEqual(a[key], b[key]));
}

const POOL_VALUE_KEYS = new Set([
  'pool', 'picked', 'poolName', 'preferredPool', 'strictPool',
  'requestedPool', 'workerPool', 'orchestrator',
]);

/**
 * Rename pool-keyed objects and the pool references nested in state reports
 * and routing telemetry. This deliberately does not touch arbitrary prose,
 * model ids, paths, or workflow run records.
 */
function migratePoolReferences(value, filePath, warnings, parentKey = '') {
  let changed = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (POOL_VALUE_KEYS.has(parentKey) && typeof value[i] === 'string') {
        const next = migratedPoolName(value[i]);
        if (next !== value[i]) {
          value[i] = next;
          changed = true;
        }
      } else {
        changed = migratePoolReferences(value[i], filePath, warnings, parentKey) || changed;
      }
    }
    return changed;
  }
  if (!value || typeof value !== 'object') return false;

  const originalKeys = Object.keys(value);
  for (const key of originalKeys) {
    const target = migratedPoolName(key);
    if (target !== key) {
      if (Object.prototype.hasOwnProperty.call(value, target)) {
        if (deepEqual(value[key], value[target])) {
          delete value[key];
          changed = true;
        } else {
          warnings.add(filePath);
        }
      } else {
        value[target] = value[key];
        delete value[key];
        changed = true;
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (POOL_VALUE_KEYS.has(key) && typeof child === 'string') {
      const next = migratedPoolName(child);
      if (next !== child) {
        value[key] = next;
        changed = true;
      }
      continue;
    }
    // incumbents is lane -> poolName rather than poolName -> record.
    if (parentKey === 'incumbents' && typeof child === 'string') {
      const next = migratedPoolName(child);
      if (next !== child) {
        value[key] = next;
        changed = true;
      }
      continue;
    }
    changed = migratePoolReferences(child, filePath, warnings, key) || changed;
  }
  return changed;
}

function parseJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function normalizedState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...structuredClone(DEFAULT_STATE),
    ...raw,
    config: { ...DEFAULT_STATE.config, ...(raw.config ?? {}) },
  };
}

function migrateStateFile(bullswarmDir, warnings) {
  const path = join(bullswarmDir, 'state.json');
  const raw = parseJson(path);
  const state = normalizedState(raw);
  if (!state) return { state: null, changed: false };
  const changed = migratePoolReferences(state, path, warnings);
  if (changed) saveState(bullswarmDir, state);
  return { state, changed };
}

function migrateRoutingFile(bullswarmDir, warnings) {
  const path = join(bullswarmDir, 'routing.json');
  const value = parseJson(path);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let changed = false;
  for (const lane of Object.values(value)) {
    if (!Array.isArray(lane?.order)) continue;
    const next = [];
    for (const pool of lane.order) {
      const renamed = migratedPoolName(pool);
      if (renamed !== pool) changed = true;
      if (!next.includes(renamed)) next.push(renamed);
    }
    lane.order = next;
  }
  if (changed) atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return changed;
}

function migrateProvidersFile(bullswarmDir) {
  const path = join(bullswarmDir, 'providers.json');
  const value = parseJson(path);
  if (!value || typeof value !== 'object' || !Array.isArray(value.enabled)) return false;
  const next = [];
  let changed = false;
  for (const provider of value.enabled) {
    const renamed = migratedPoolName(provider);
    if (renamed !== provider) changed = true;
    if (!next.includes(renamed)) next.push(renamed);
  }
  if (changed) {
    value.enabled = next;
    atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return changed;
}

function migrateMeterContents(content, extension) {
  if (extension === '.json') {
    try {
      const value = JSON.parse(content);
      const warnings = new Set();
      const changed = migratePoolReferences(value, '<meter>', warnings);
      return { content: changed ? `${JSON.stringify(value, null, 2)}\n` : content, value };
    } catch {
      return { content, value: null };
    }
  }
  if (extension === '.jsonl') {
    const lines = content.split('\n');
    let changed = false;
    const next = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const value = JSON.parse(line);
        const warnings = new Set();
        if (migratePoolReferences(value, '<meter>', warnings)) changed = true;
        return JSON.stringify(value);
      } catch {
        return line;
      }
    });
    return { content: changed ? next.join('\n') : content, value: null };
  }
  return { content, value: null };
}

function equivalentMeterContents(oldContent, targetContent, extension) {
  const oldMigrated = migrateMeterContents(oldContent, extension);
  if (extension === '.json' && oldMigrated.value != null) {
    try { return deepEqual(oldMigrated.value, JSON.parse(targetContent)); } catch { return false; }
  }
  if (extension === '.jsonl') {
    try {
      const left = oldMigrated.content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      const right = targetContent.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      return deepEqual(left, right);
    } catch { return oldMigrated.content === targetContent; }
  }
  return oldContent === targetContent;
}

function migrateMeterFiles(bullswarmDir, warnings) {
  const meters = join(bullswarmDir, 'meters');
  const dirs = [meters, join(meters, 'history')];
  let changed = false;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      const extension = dir === join(meters, 'history') ? '.jsonl' : '.json';
      if (!(file.endsWith(extension))) continue;
      const stem = file.slice(0, -extension.length);
      const renamedStem = migratedPoolName(stem);
      if (renamedStem === stem) continue;
      const oldPath = join(dir, file);
      const targetPath = join(dir, `${renamedStem}${extension}`);
      let oldContent;
      try { oldContent = readFileSync(oldPath, 'utf8'); } catch { continue; }
      if (existsSync(targetPath)) {
        let targetContent;
        try { targetContent = readFileSync(targetPath, 'utf8'); } catch { targetContent = null; }
        if (targetContent != null && equivalentMeterContents(oldContent, targetContent, extension)) {
          try { unlinkSync(oldPath); changed = true; } catch { /* best effort */ }
        } else {
          warnings.add(targetPath);
        }
        continue;
      }
      const migrated = migrateMeterContents(oldContent, extension);
      try {
        renameSync(oldPath, targetPath);
        if (migrated.content !== oldContent) atomicWriteFileSync(targetPath, migrated.content);
        changed = true;
      } catch {
        // A concurrent meter writer may have won the rename. The next command
        // will retry, and no pool data is discarded here.
      }
    }
  }
  return changed;
}

function containsMigratablePoolReference(value, parentKey = '') {
  if (Array.isArray(value)) {
    return value.some((child) => (
      POOL_VALUE_KEYS.has(parentKey) && typeof child === 'string'
        ? migratedPoolName(child) !== child
        : containsMigratablePoolReference(child, parentKey)
    ));
  }
  if (!value || typeof value !== 'object') {
    return (POOL_VALUE_KEYS.has(parentKey) || parentKey === 'incumbents')
      && typeof value === 'string' && migratedPoolName(value) !== value;
  }
  return Object.entries(value).some(([key, child]) => (
    migratedPoolName(key) !== key
    || ((POOL_VALUE_KEYS.has(key) || parentKey === 'incumbents')
      && typeof child === 'string' && migratedPoolName(child) !== child)
    || containsMigratablePoolReference(child, key)
  ));
}

// The check parses state.json (hundreds of decision-log entries) and walks
// every value; every state load asks it. The answer only changes when one
// of the three files does, so it is remembered per file fingerprint.
const migrationCheckCache = new Map();
function homeMigrationFingerprint(bullswarmDir) {
  return ['state.json', 'routing.json', 'providers.json'].map((name) => {
    try {
      const stat = statSync(join(bullswarmDir, name));
      return `${stat.size}:${stat.mtimeMs}`;
    } catch { return 'absent'; }
  }).join('|');
}

function homeMigrationNeeded(bullswarmDir) {
  const fingerprint = homeMigrationFingerprint(bullswarmDir);
  const cached = migrationCheckCache.get(bullswarmDir);
  if (cached && cached.fingerprint === fingerprint) return cached.needed;
  const needed = homeMigrationNeededUncached(bullswarmDir);
  migrationCheckCache.set(bullswarmDir, { fingerprint, needed });
  return needed;
}

function homeMigrationNeededUncached(bullswarmDir) {
  const state = parseJson(join(bullswarmDir, 'state.json'));
  if (state && containsMigratablePoolReference(state)) return true;
  const routing = parseJson(join(bullswarmDir, 'routing.json'));
  if (routing && Object.values(routing).some((lane) =>
    Array.isArray(lane?.order) && lane.order.some((pool) => migratedPoolName(pool) !== pool))) return true;
  const providers = parseJson(join(bullswarmDir, 'providers.json'));
  if (providers?.enabled?.some?.((pool) => migratedPoolName(pool) !== pool)) return true;
  for (const dir of [join(bullswarmDir, 'meters'), join(bullswarmDir, 'meters', 'history')]) {
    try {
      if (readdirSync(dir).some((file) => file === `${RENAMED_POOL_FROM}.json`
        || file.startsWith(`${RENAMED_POOL_FROM}:`) && (file.endsWith('.json') || file.endsWith('.jsonl'))
        || file === `${RENAMED_POOL_FROM}.jsonl`
        || containsMigratablePoolReference(parseJson(join(dir, file))))) return true;
    } catch { /* absent/unreadable */ }
  }
  return false;
}

function migrateHomeLocked(bullswarmDir) {
  const warnings = new Set();
  const stateResult = migrateStateFile(bullswarmDir, warnings);
  const routingChanged = migrateRoutingFile(bullswarmDir, warnings);
  const providersChanged = migrateProvidersFile(bullswarmDir);
  const metersChanged = migrateMeterFiles(bullswarmDir, warnings);
  const changed = stateResult.changed || routingChanged || providersChanged || metersChanged;
  for (const file of warnings) {
    console.warn(`pool rename migration kept both names in ${file}`);
  }
  return { ...stateResult, changed };
}

/**
 * Run the OpenCode pool migration for a home directory. State loads call this
 * automatically; meter-only entry points call it explicitly as well. The
 * state lock covers state, routing/providers config, and meter file renames.
 */
export function migratePoolNameHome(bullswarmDir) {
  if (!homeMigrationNeeded(bullswarmDir)) return false;
  const lock = acquireStateLock(bullswarmDir);
  try {
    return migrateHomeLocked(bullswarmDir).changed;
  } finally {
    releaseStateLock(lock);
  }
}

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

/**
 * Home retention (`state.json.retention`). Absent keys take these defaults.
 * It is deliberately not part of DEFAULT_STATE: an untouched home never gains a
 * `retention` block just because something loaded and saved its state.
 */
export const DEFAULT_RETENTION = Object.freeze({ enabled: true, workspacesDays: 7 });

/**
 * The effective retention policy of a loaded state. A value of the wrong type
 * is reported in `invalid` and pauses the AUTOMATIC prune (`enabled: false`):
 * a destructive background job never runs on a policy it could not read. The
 * days still fall back to the default so an explicit `home prune` has a limit.
 */
export function resolveRetention(state) {
  const raw = state?.retention;
  const invalid = [];
  let enabled = DEFAULT_RETENTION.enabled;
  let workspacesDays = DEFAULT_RETENTION.workspacesDays;
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    invalid.push('retention must be an object');
  } else if (raw) {
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
      else invalid.push('retention.enabled must be true or false');
    }
    if (raw.workspacesDays !== undefined) {
      if (typeof raw.workspacesDays === 'number' && Number.isFinite(raw.workspacesDays) && raw.workspacesDays > 0) {
        workspacesDays = raw.workspacesDays;
      } else {
        invalid.push('retention.workspacesDays must be a number greater than 0');
      }
    }
  }
  return { enabled: invalid.length ? false : enabled, workspacesDays, invalid };
}

export function loadState(bullswarmDir, { skipMigration = false } = {}) {
  const p = join(bullswarmDir, 'state.json');
  if (!skipMigration && homeMigrationNeeded(bullswarmDir)) migratePoolNameHome(bullswarmDir);
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
    // The caller already owns the S5 lock. State migration must therefore run
    // inline instead of trying to acquire the same lock a second time.
    if (homeMigrationNeeded(bullswarmDir)) migrateHomeLocked(bullswarmDir);
    const state = loadState(bullswarmDir, { skipMigration: true });
    if (mutator(state) !== false) saveState(bullswarmDir, state);
    return state;
  } finally {
    releaseStateLock(lock);
  }
}

// --- quarantine -----------------------------------------------------------

/**
 * Take a pool out of service until a deadline.
 *
 * kind 'auth' (the default) is the flat 10-minute re-probe unless `until`
 * says otherwise. kind 'quota' is refused — nothing written, null returned —
 * unless `evidence` is a decideQuotaPause() result that proves the pause
 * (quota.js Q6); the pause then lasts exactly until the reset that evidence
 * names, and the record keeps the provider line, the meter reading and the
 * rule so every surface can say why.
 *
 * `strategy.pausing: "off"` (quota.js Q7) refuses EVERY pause, auth included:
 * with the switch off no command takes a pool out of service on its own
 * judgement. The refusals live at this choke point, so every caller —
 * dispatch, a single run, the sibling bench — is covered by one check.
 *
 * @returns {number|null} the deadline, or null when the pause was refused
 */
export function quarantinePool(state, poolName, reason, now = Date.now(), {
  until = null, kind = 'auth', evidence = null,
} = {}) {
  if (!pausingEnabled(state)) return null;
  if (kind === 'quota') {
    if (!quotaPauseProven(evidence, now)) return null;
    state.pools[poolName] ??= {};
    state.pools[poolName].quarantine = {
      until: Number(evidence.until),
      reason: evidence.why ?? reason,
      kind,
      rule: evidence.rule,
      line: evidence.line ?? null,
      meter: evidence.meter ?? null,
      meterWindow: evidence.meterWindow ?? null,
      resetsAt: evidence.resetsAt ?? new Date(Number(evidence.until)).toISOString(),
      pausedAt: new Date(now).toISOString(),
    };
    dropIncumbency(state, poolName);
    return Number(evidence.until);
  }
  // Re-probe window: 10 minutes by default (not 30) with automatic release.
  const deadline = Number.isFinite(until) && until > now ? until : now + 10 * 60_000;
  state.pools[poolName] ??= {};
  state.pools[poolName].quarantine = { until: deadline, reason, kind };
  dropIncumbency(state, poolName);
  return deadline;
}

function dropIncumbency(state, poolName) {
  // A quarantined pool cannot hold incumbency: it isn't serving work, and
  // keeping the flag would lock the lane against its return.
  for (const [lane, name] of Object.entries(state.incumbents ?? {})) {
    if (name === poolName) delete state.incumbents[lane];
  }
}

/**
 * Lift a pool's pause at once (`bullswarm pools resume <pool>`): its
 * quarantine, quota or auth, and an active bench. The lift is appended to the
 * decision log with what it lifted. A pool with nothing to lift is untouched.
 *
 * @returns {{quarantine: object|null, bench: object|null}} what was lifted
 */
export function resumePool(state, poolName, now = Date.now(), { source = 'pools resume' } = {}) {
  const record = state.pools?.[poolName];
  const quarantine = record?.quarantine ?? null;
  const bench = record?.bench?.until != null ? record.bench : null;
  if (!quarantine && !bench) return { quarantine: null, bench: null };
  delete record.quarantine;
  if (bench) delete record.bench;
  state.decisionLog ??= [];
  state.decisionLog.push({
    ts: new Date(now).toISOString(),
    kind: 'pool-resume',
    source,
    pool: poolName,
    lifted: {
      ...(quarantine ? {
        quarantine: {
          kind: quarantine.kind ?? 'auth',
          until: Number.isFinite(Number(quarantine.until)) ? new Date(Number(quarantine.until)).toISOString() : null,
          reason: quarantine.reason ?? null,
        },
      } : {}),
      ...(bench ? { bench: { until: new Date(Number(bench.until)).toISOString(), reason: bench.reason ?? null } } : {}),
    },
  });
  if (state.decisionLog.length > 500) state.decisionLog = state.decisionLog.slice(-500);
  return { quarantine, bench };
}

/** Turn automatic pausing on or off (`bullswarm strategy set-pausing on|off`). */
export function setPausing(state, on) {
  state.strategy ??= {};
  if (on) delete state.strategy.pausing;
  else state.strategy.pausing = 'off';
  return pausingEnabled(state);
}

export { pausingEnabled };

/**
 * The credential group a pool view or a bare connector declares:
 * `credentialGroup`, else the legacy spelling `upstreamGroup`. Pools in one
 * credential group share one upstream credential.
 */
export function upstreamGroupOf(pool) {
  const connector = pool?.connector ?? pool;
  for (const group of [connector?.credentialGroup, connector?.upstreamGroup]) {
    if (typeof group === 'string' && group) return group;
  }
  return null;
}

/**
 * Bench every pool in the failing pool's credential group.
 *
 * Several pools can be names for ONE relayed account. When that credential was
 * invalidated (2026-09-11 12:24 UTC) the retry of a failed action walked three
 * sibling pools of the same group and burned both attempts on the same dead
 * credential, blocking every dependent action. Quota is deliberately NOT
 * shared: a sibling with its own window still has work in it (Q1), so only an
 * auth quarantine spreads. With `strategy.pausing: "off"` (Q7) no sibling is
 * benched at all: the fan-out is part of the same automatic pausing the switch
 * turns off.
 *
 * @param {object[]} pools pool views (or bare connectors) to consider
 * @returns {string[]} the pools benched here, in list order
 */
export function quarantineUpstreamSiblings(state, pools, {
  pool, group, reason, now = Date.now(), until = null, kind = 'auth',
} = {}) {
  if (!pausingEnabled(state)) return [];
  if (kind !== 'auth' || !group || !pool) return [];
  const benched = [];
  for (const candidate of pools ?? []) {
    const name = candidate?.name;
    if (!name || name === pool || benched.includes(name)) continue;
    if (candidate.enabled === false) continue;
    if (upstreamGroupOf(candidate) !== group) continue;
    // An existing quarantine is that pool's own, truthful deadline — a quota
    // reset outlasts a 10-minute auth re-probe. A borrowed reason never
    // shortens it.
    const existing = state.pools?.[name]?.quarantine;
    if (existing && Number.isFinite(existing.until) && existing.until > now) continue;
    quarantinePool(state, name, `sibling of ${pool}: ${reason}`, now, { until, kind });
    benched.push(name);
  }
  return benched;
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

// --- soft bench -----------------------------------------------------------
// S6. A bench is the SOFT counterpart of a quarantine, for a pool that is
//     alive but not producing: it stalled, the provider errored, or it
//     answered with nothing. It is written here, beside `quarantine`, so the
//     dispatcher that records a failure and the router that reads the pool
//     list share one record — the same file, the same lock, the same shape.
//     Two differences from quarantine are deliberate:
//       - `until: null` means "one strike counted, still in service", the
//         OPPOSITE of quarantine's null (which means forever). A pool is out
//         only once it has a concrete future deadline, which is why
//         `isBenched()` (src/lib/route.js) tests `until != null && now < until`.
//       - `count` is CONSECUTIVE failures. It survives the cooldown expiring
//         and is cleared only by a success, so a pool that stalls once every
//         hour is not benched forever while one that stalls twice in a row is.
//     Auth is untouched: `quarantinePool` still owns that path, and a bench
//     never shortens or replaces a quarantine deadline.

/** The re-probe window a bench waits out — the same 10 minutes quarantine uses. */
export const BENCH_COOLDOWN_MS = 10 * 60_000;
/** Consecutive qualifying failures before a pool is actually taken out. */
export const BENCH_AFTER_STRIKES = 2;
/** Failure kinds that count as a strike, as classified by the dispatcher. */
export const BENCH_REASONS = new Set(['stall', 'provider', 'empty', 'probe']);

/**
 * Record one qualifying failure against a pool.
 *
 * With `strategy.pausing: "off"` (quota.js Q7) nothing is recorded and no
 * deadline is ever written: a bench takes a pool out of service exactly like a
 * quarantine, so the switch covers it too, and not counting strikes means a
 * later `set-pausing on` starts clean.
 *
 * @returns {number|null} the bench deadline when this strike benched the pool,
 *                        null when it was only counted.
 */
export function recordPoolStrike(state, poolName, reason, now = Date.now()) {
  if (!pausingEnabled(state)) return null;
  state.pools ??= {};
  state.pools[poolName] ??= {};
  const prior = state.pools[poolName].bench ?? null;
  const count = Number.isFinite(Number(prior?.count)) ? Number(prior.count) + 1 : 1;
  if (count < BENCH_AFTER_STRIKES) {
    state.pools[poolName].bench = { until: null, reason, count };
    return null;
  }
  const until = now + BENCH_COOLDOWN_MS;
  state.pools[poolName].bench = { until, reason, count };
  // Same rule as quarantine: a pool that is not serving work cannot hold a
  // lane against its own return.
  for (const [lane, name] of Object.entries(state.incumbents ?? {})) {
    if (name === poolName) delete state.incumbents[lane];
  }
  return until;
}

/** A success clears the consecutive-failure record entirely. */
export function clearPoolStrikes(state, poolName) {
  if (state.pools?.[poolName]?.bench) delete state.pools[poolName].bench;
}

/**
 * Drop bench records whose cooldown has passed. Unlike a quarantine sweep this
 * keeps the strike count: the pool is back in service, but a fresh stall right
 * after the cooldown is still its second in a row.
 */
export function sweepBenches(state, now = Date.now()) {
  const released = [];
  for (const name of Object.keys(state.pools ?? {})) {
    const bench = state.pools[name]?.bench;
    if (!bench || bench.until == null) continue;
    if (now >= Number(bench.until)) {
      state.pools[name].bench = { until: null, reason: bench.reason ?? null, count: Number(bench.count ?? 0) };
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
