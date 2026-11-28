// bullswarm state — one JSON file at ~/.bullswarm/state.json.
//
// Doctrine:
//   S1. No pool is paused, benched or struck out here (owner decision,
//       2026-09-25): a spent or dead pool is never remembered from one step
//       to the next. Old `quarantine` and `bench` records in a saved
//       state.json are left as they are and read by nothing.
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
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fsjson.js';

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

const MIGRATIONS_MARKER_FILE = '.migrations.json';
const DECISION_LOG_ARCHIVE_FILE = 'decision-log-archive.jsonl';
export const DECISION_LOG_LIVE_LIMIT = 200;
const LIVE_DECISION_LOG_HOME = Symbol('bullswarm.liveDecisionLogHome');

/**
 * Archive identity attached (non-enumerably) to a combined decision log by
 * readDecisionLog / resolveDecisionLog: `{path, key, cacheKey, fullKey,
 * appendedFrom, archived}`. spend.js uses it to cache the archived rows'
 * windows by file identity and walk only the live tail on a reload (R2,
 * 0.41.0). `fullKey` names the last full parse of this generation; after an
 * append it also merges only the new archive lines (`appendedFrom` is the
 * archived row count before those lines, null when the read was a full parse).
 * Both facts persist for the whole cache generation, so a read that follows
 * the one that first saw the append still knows the prefix is unchanged.
 */
export const DECISION_LOG_ARCHIVE = Symbol('bullswarm.decisionLogArchive');

export function decisionLogArchivePath(bullswarmDir) {
  return join(bullswarmDir, DECISION_LOG_ARCHIVE_FILE);
}

// One parsed snapshot per archive path: `{size, mtimeMs, ino, rows, fullKey,
// appendedFrom}`. `size` is the byte offset of the last COMPLETE line committed
// to `rows`, so an append that left a partial line is picked up by the next
// read. The inode tells an append (same file, grown) from an atomic rewrite
// (new inode via temp+rename); a plain truncate-and-rewrite that keeps the
// inode is caught by the boundary byte check below. `fullKey`/`appendedFrom`
// describe this generation and are reset only by a full parse.
const archivedLogCache = new Map();

function tagArchivedRows(rows, p, key, fullKey, appendedFrom) {
  Object.defineProperty(rows, DECISION_LOG_ARCHIVE, {
    value: { path: p, key, cacheKey: `${p}:${key}`, fullKey, appendedFrom },
    enumerable: false,
    configurable: true,
  });
  return rows;
}

function parseArchiveLines(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return rows;
}

/**
 * Bytes from `from` to `size`, read from `from - 1` so the caller can verify
 * the join is a line boundary: `tail[0]` is the byte just before the cached
 * prefix's end. Returns null on any read error.
 */
function readArchiveTail(p, from, size) {
  const start = from > 0 ? from - 1 : 0;
  const length = size - start;
  if (length <= 0) return null;
  const buf = Buffer.allocUnsafe(length);
  let fd;
  try {
    fd = openSync(p, 'r');
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buf, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    return buf.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function readArchivedDecisionLog(bullswarmDir) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return [];
  const p = decisionLogArchivePath(bullswarmDir);
  let stat;
  try { stat = statSync(p); } catch { return []; }
  const cached = archivedLogCache.get(p);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return tagArchivedRows(
      cached.rows.slice(), p, `${cached.size}:${cached.mtimeMs}`, cached.fullKey, cached.appendedFrom,
    );
  }
  if (cached && cached.ino === stat.ino && stat.size > cached.size) {
    const tail = readArchiveTail(p, cached.size, stat.size);
    // The byte before the cached prefix's end must be a newline, or the file
    // was rewritten in place rather than appended to: parse it whole.
    if (tail && (cached.size === 0 || tail[0] === 0x0a)) {
      const text = tail.toString('utf8', cached.size === 0 ? 0 : 1);
      const cut = text.lastIndexOf('\n');
      const completeText = cut >= 0 ? text.slice(0, cut + 1) : '';
      if (completeText) {
        const rows = cached.rows.concat(parseArchiveLines(completeText));
        const size = cached.size + Buffer.byteLength(completeText, 'utf8');
        archivedLogCache.set(p, {
          size, mtimeMs: stat.mtimeMs, ino: stat.ino, rows,
          fullKey: cached.fullKey, appendedFrom: cached.rows.length,
        });
        return tagArchivedRows(
          rows.slice(), p, `${size}:${stat.mtimeMs}`, cached.fullKey, cached.rows.length,
        );
      }
      // Nothing complete was appended yet: keep the snapshot we have.
      return tagArchivedRows(
        cached.rows.slice(), p, `${cached.size}:${cached.mtimeMs}`, cached.fullKey, cached.appendedFrom,
      );
    }
  }
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const rows = parseArchiveLines(text);
  const key = `${stat.size}:${stat.mtimeMs}`;
  archivedLogCache.set(p, {
    size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, rows, fullKey: key, appendedFrom: null,
  });
  return tagArchivedRows(rows.slice(), p, key, key, null);
}

function tagCombinedLog(combined, archived) {
  const info = archived?.[DECISION_LOG_ARCHIVE];
  if (!info) return combined;
  Object.defineProperty(combined, DECISION_LOG_ARCHIVE, {
    value: { ...info, archived: archived.length },
    enumerable: false,
    configurable: true,
  });
  return combined;
}

export function writeArchivedDecisionLog(bullswarmDir, rows) {
  const p = decisionLogArchivePath(bullswarmDir);
  mkdirSync(bullswarmDir, { recursive: true });
  const body = Array.isArray(rows) && rows.length
    ? `${rows.map((row) => JSON.stringify(row) ?? 'null').join('\n')}\n`
    : '';
  atomicWriteFileSync(p, body);
  archivedLogCache.delete(p);
}

export function readDecisionLog(bullswarmDir, liveState = null) {
  const archived = readArchivedDecisionLog(bullswarmDir);
  const state = liveState ?? loadState(bullswarmDir);
  const live = Array.isArray(state?.decisionLog) ? state.decisionLog : [];
  return archived.length ? tagCombinedLog([...archived, ...live], archived) : live.slice();
}

export function resolveDecisionLog(decisionLog, bullswarmDir = null) {
  const list = Array.isArray(decisionLog) ? decisionLog : [];
  const taggedHome = Array.isArray(decisionLog) ? decisionLog[LIVE_DECISION_LOG_HOME] : null;
  const home = taggedHome ?? (decisionLog === undefined ? bullswarmDir : null);
  if (!home) return list;
  const archived = readArchivedDecisionLog(home);
  return archived.length ? tagCombinedLog([...archived, ...list], archived) : list;
}

function tagLiveDecisionLog(state, bullswarmDir) {
  if (state && Array.isArray(state.decisionLog) && typeof bullswarmDir === 'string' && bullswarmDir) {
    Object.defineProperty(state.decisionLog, LIVE_DECISION_LOG_HOME, {
      value: bullswarmDir,
      enumerable: false,
      configurable: true,
    });
  }
  return state;
}

const READONLY_FIXTURES_ROOT = resolve(fileURLToPath(new URL('../../tests/fixtures', import.meta.url)));

function isReadOnlyHome(bullswarmDir) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return true;
  if (existsSync(join(bullswarmDir, '.snapshot.json'))) return true;
  const resolved = resolve(bullswarmDir);
  return resolved === READONLY_FIXTURES_ROOT || resolved.startsWith(`${READONLY_FIXTURES_ROOT}${sep}`);
}

export function readHomeMigrations(bullswarmDir) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return {};
  const raw = parseJson(join(bullswarmDir, MIGRATIONS_MARKER_FILE));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function recordHomeMigrations(bullswarmDir, patch) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir || !existsSync(bullswarmDir) || isReadOnlyHome(bullswarmDir)) return;
  try {
    const current = readHomeMigrations(bullswarmDir);
    const next = { ...current, ...patch };
    atomicWriteFileSync(join(bullswarmDir, MIGRATIONS_MARKER_FILE), `${JSON.stringify(next)}\n`);
  } catch { /* best-effort cache marker */ }
}

function homeHasAnySurface(bullswarmDir) {
  return ['state.json', 'routing.json', 'providers.json', 'meters'].some((name) => existsSync(join(bullswarmDir, name)));
}

function homeJsonSurfacesReadable(bullswarmDir) {
  return ['state.json', 'routing.json', 'providers.json'].every((name) => {
    const p = join(bullswarmDir, name);
    return !existsSync(p) || parseJson(p) !== null;
  });
}

// The check parses state.json (hundreds of decision-log entries) and walks
// every value; every state load asks it. Once a home has been verified clean
// or migrated, `.migrations.json` skips the scan across future CLI processes.
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
  if (readHomeMigrations(bullswarmDir).poolRenameMigrated === true) {
    migrationCheckCache.set(bullswarmDir, { fingerprint, needed: false });
    return false;
  }
  if (!homeHasAnySurface(bullswarmDir)) {
    migrationCheckCache.set(bullswarmDir, { fingerprint, needed: false });
    return false;
  }
  const needed = homeMigrationNeededUncached(bullswarmDir);
  if (!needed && homeJsonSurfacesReadable(bullswarmDir)) {
    recordHomeMigrations(bullswarmDir, { poolRenameMigrated: true });
  }
  migrationCheckCache.set(bullswarmDir, { fingerprint, needed });
  return needed;
}

function homeMigrationNeededUncached(bullswarmDir) {
  const state = parseJson(join(bullswarmDir, 'state.json'));
  if (state && containsMigratablePoolReference(state)) return true;
  if (readArchivedDecisionLog(bullswarmDir).some((row) => containsMigratablePoolReference(row))) return true;
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

function migrateArchiveFile(bullswarmDir) {
  const path = decisionLogArchivePath(bullswarmDir);
  if (!existsSync(path)) return false;
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return false; }
  const migrated = migrateMeterContents(content, '.jsonl');
  if (migrated.content === content) return false;
  atomicWriteFileSync(path, migrated.content);
  archivedLogCache.delete(path);
  return true;
}

function migrateHomeLocked(bullswarmDir) {
  const warnings = new Set();
  const stateResult = migrateStateFile(bullswarmDir, warnings);
  const archiveChanged = migrateArchiveFile(bullswarmDir);
  const routingChanged = migrateRoutingFile(bullswarmDir, warnings);
  const providersChanged = migrateProvidersFile(bullswarmDir);
  const metersChanged = migrateMeterFiles(bullswarmDir, warnings);
  const changed = stateResult.changed || archiveChanged || routingChanged || providersChanged || metersChanged;
  for (const file of warnings) {
    console.warn(`pool rename migration kept both names in ${file}`);
  }
  if (warnings.size === 0 && !homeMigrationNeededUncached(bullswarmDir) && homeJsonSurfacesReadable(bullswarmDir)) {
    recordHomeMigrations(bullswarmDir, { poolRenameMigrated: true });
    migrationCheckCache.set(bullswarmDir, { fingerprint: homeMigrationFingerprint(bullswarmDir), needed: false });
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
  pools: {},        // name -> {enabled, meter:{type,windowStart?,usedPct?,declaredBy}}
  // `incumbents` (lane -> pool) is gone in 0.37.0: routing never reads it and
  // nothing writes it. An old home keeps the key, still migrated below.
  decisionLog: [],  // {ts, lane, picked, ok, why, wallSec, ...}
  config: {
    depthLimit: 2,
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
  if (!existsSync(p)) return tagLiveDecisionLog(structuredClone(DEFAULT_STATE), bullswarmDir);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return tagLiveDecisionLog({
      ...structuredClone(DEFAULT_STATE),
      ...raw,
      config: { ...DEFAULT_STATE.config, ...(raw.config ?? {}) },
    }, bullswarmDir);
  } catch {
    return tagLiveDecisionLog(structuredClone(DEFAULT_STATE), bullswarmDir);
  }
}

export function serializeState(state) {
  const log = state?.decisionLog;
  if (!Array.isArray(log) || log.length === 0) return `${JSON.stringify(state, null, 2)}\n`;
  const lines = JSON.stringify({ ...state, decisionLog: [] }, null, 2).split('\n');
  const at = lines.findIndex((l) => l === '  "decisionLog": []' || l === '  "decisionLog": [],');
  if (at < 0) return `${JSON.stringify(state, null, 2)}\n`;
  const comma = lines[at].endsWith(',') ? ',' : '';
  lines[at] = `  "decisionLog": [\n${log.map((r) => `    ${JSON.stringify(r) ?? 'null'}`).join(',\n')}\n  ]${comma}`;
  return `${lines.join('\n')}\n`;
}

export function saveState(bullswarmDir, state) {
  mkdirSync(bullswarmDir, { recursive: true });
  const serialized = serializeState(state);
  // Temp file + rename (S5): a reader mid-write sees the previous complete
  // file, never a truncated one.
  atomicWriteFileSync(
    join(bullswarmDir, 'state.json'),
    serialized,
  );
  if (!serialized.includes(RENAMED_POOL_FROM)
    && !['routing.json', 'providers.json', 'meters'].some((name) => existsSync(join(bullswarmDir, name)))) {
    migrationCheckCache.set(bullswarmDir, { fingerprint: homeMigrationFingerprint(bullswarmDir), needed: false });
  }
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
 * otherwise lock state.json forever, so a lock file older than
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
function archiveDecisionLogOverflowLocked(bullswarmDir, state, limit = DECISION_LOG_LIVE_LIMIT) {
  if (!Array.isArray(state?.decisionLog) || state.decisionLog.length <= limit) return 0;
  const overflow = state.decisionLog.splice(0, state.decisionLog.length - limit);
  mkdirSync(bullswarmDir, { recursive: true });
  const archivePath = decisionLogArchivePath(bullswarmDir);
  appendFileSync(archivePath, `${overflow.map((row) => JSON.stringify(row) ?? 'null').join('\n')}\n`);
  // The cache entry is kept: the next read sees the same inode and a larger
  // size, parses only these appended lines, and hands spend.js their count so
  // it merges just their windows (R2, 0.41.0).
  return overflow.length;
}

export function compactDecisionLog(bullswarmDir, { limit = DECISION_LOG_LIVE_LIMIT } = {}) {
  if (isReadOnlyHome(bullswarmDir)) return 0;
  let moved = 0;
  updateState(bullswarmDir, (state) => {
    if (!Array.isArray(state?.decisionLog) || state.decisionLog.length <= limit) return false;
    moved = archiveDecisionLogOverflowLocked(bullswarmDir, state, limit);
    return moved > 0;
  });
  return moved;
}

export function updateState(bullswarmDir, mutator, opts = {}) {
  const lock = acquireStateLock(bullswarmDir, opts);
  try {
    // The caller already owns the S5 lock. State migration must therefore run
    // inline instead of trying to acquire the same lock a second time.
    if (homeMigrationNeeded(bullswarmDir)) migrateHomeLocked(bullswarmDir);
    const state = loadState(bullswarmDir, { skipMigration: true });
    if (mutator(state) !== false) {
      archiveDecisionLogOverflowLocked(bullswarmDir, state);
      saveState(bullswarmDir, state);
    }
    tagLiveDecisionLog(state, bullswarmDir);
    return state;
  } finally {
    releaseStateLock(lock);
  }
}

// --- credential groups ----------------------------------------------------

/**
 * The credential group a pool view or a bare connector declares:
 * `credentialGroup`, else the legacy spelling `upstreamGroup`. Pools in one
 * credential group share one upstream credential, so after a sign-in failure
 * on one of them the same dispatch never moves to another (v2-dispatch.js).
 */
export function upstreamGroupOf(pool) {
  const connector = pool?.connector ?? pool;
  for (const group of [connector?.credentialGroup, connector?.upstreamGroup]) {
    if (typeof group === 'string' && group) return group;
  }
  return null;
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
