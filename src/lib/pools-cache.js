// The shared status cache: one build of `pools --json`, `workflow runs --json`
// or `assignments --json` serves every caller for a while. Each Claude
// session's mod asks all three on a timer, and each is a full CLI load
// (~280 MB RSS; a pools build adds every meter read, 260-345 MB, and 11 ran at
// once on 2026-10-20). With `--max-age`, a young cache is the answer, and when
// it is old one caller takes a file lock and rebuilds while the rest answer
// with the last good result.
//
// Only node built-ins here: bin/bullswarm.js imports this before the CLI, so a
// cache hit never loads the rest of Bullswarm.

import {
  closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** An unreadable lock this old belongs to a refresher that died mid-write. A dead pid is cleared at once. */
const LOCK_STALE_MS = 120_000;
/**
 * How long a caller with nothing cached waits for another caller's build.
 * Under the mod's 30s `$.process.run` budget (mods/bullswarm/hooks/register.ts).
 */
export const WAIT_MS = 20_000;
/**
 * A lock older than this is stuck, even when its holder is alive (a hung
 * meter read, or a pid reused by another process): the next caller takes it
 * over. This bounds extra builders to one per ceiling.
 */
export const LOCK_CEILING_MS = 300_000;

/** Each cache is `<home>/cache/<name>.json` (pools, runs, assignments) under its own schema. */
const schemaOf = (name) => `bullswarm.${name}-cache.v1`;

export function cachePaths(home, name) {
  const dir = join(home, 'cache');
  return { dir, file: join(dir, `${name}.json`), lock: join(dir, `${name}.lock`) };
}

/** The cached `{ savedAt, doc }`, or null when there is none or it is unreadable. */
export function readCache(home, name) {
  try {
    const { schema, savedAt, ...doc } = JSON.parse(readFileSync(cachePaths(home, name).file, 'utf8'));
    if (schema !== schemaOf(name) || !Number.isFinite(savedAt)) return null;
    return { savedAt, doc };
  } catch {
    return null;
  }
}

/** Writes the cache whole or not at all: a reader never sees half a file. */
export function writeCache(home, name, doc, savedAt = Date.now()) {
  const { dir, file } = cachePaths(home, name);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ schema: schemaOf(name), savedAt, ...doc }, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The `<pid> <ms> <token>` a lock file holds, or null when it is gone or unreadable. */
function lockOwner(lock) {
  try {
    const [pid, , token] = readFileSync(lock, 'utf8').trim().split(' ');
    return { pid: Number(pid), token: token ?? null };
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Test seams: `beforeBreak(lock)` runs between judging a lock and breaking it,
 * `afterRename(lock)` between the rename aside and the read of what we hold,
 * `statOf(path)` the stat of an aside or `.broken` file (default `statSync`).
 */
export const __testHooks = { beforeBreak: null, afterRename: null, statOf: statSync };

/**
 * This caller's token when it now holds the lock, else null. A live holder
 * keeps a lock younger than `ceilingMs`; past it the lock is stuck and taken
 * over. A dead holder loses it at once, even when the file is young. An
 * unreadable lock is broken only once it is two minutes old.
 *
 * A judged lock is broken by renaming it aside (atomic on one filesystem), not
 * by deleting it: between our last look and a delete another caller may have
 * broken the same lock and created its own, and a delete would remove that
 * live lock. The judged lock is identified by {dev, ino, mtimeMs, size, token}
 * taken at judgment (token is null when the lock has none yet). The inode alone
 * is not enough: a filesystem that reuses freed inode numbers (ext4) can give a
 * successor's new lock the number of the lock it replaced, so mtime and size
 * must match too, and the token whenever the judged lock had one. After the
 * rename, the same identity: delete it and retry the create. A different one is
 * a successor's lock: link it back (this fails when a newer lock already
 * exists, which then stays) and return null. A rename error other than ENOENT
 * means we do not hold the lock: null, never a throw. A crash in between leaves
 * a `.broken` file, which a later break sweeps once its ctime (set by the
 * rename, unlike mtime) is older than the ceiling.
 *
 * Known limit: during a put-back the lock path is briefly missing, so a third
 * caller can build alongside the successor. Only the lock holder's write lands
 * (writeCache is token-guarded), so the cache is never written twice; at worst
 * one extra build.
 */
function takeLock(lock, ceilingMs) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, `${process.pid} ${Date.now()} ${token}\n`); } finally { closeSync(fd); }
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let judgedStat;
      try { judgedStat = statSync(lock); } catch { continue; }
      const age = Date.now() - judgedStat.mtimeMs;
      const owner = lockOwner(lock);
      const judged = { dev: judgedStat.dev, ino: judgedStat.ino, mtimeMs: judgedStat.mtimeMs, size: judgedStat.size, token: owner?.token ?? null };
      const alive = processAlive(owner?.pid);
      if (alive && age < ceilingMs) return null;
      const deadPid = owner != null && Number.isInteger(owner.pid) && owner.pid > 0;
      if (!alive && !deadPid && age < LOCK_STALE_MS) return null;
      __testHooks.beforeBreak?.(lock);
      if (!breakLock(lock, token, judged)) return null;
    }
  }
  return null;
}

/**
 * Breaks the lock we judged, by rename. True when the create may be retried
 * (we removed our judged lock, or another caller already had); false when we
 * do not hold the lock: a successor's lock grabbed by the rename is put back,
 * and a failed rename leaves the lock as it was.
 */
function breakLock(lock, token, judged) {
  const aside = `${lock}.${token}.broken`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    return error.code === 'ENOENT';
  }
  try {
    __testHooks.afterRename?.(lock);
    let grabbed;
    try { grabbed = __testHooks.statOf(aside); } catch { return false; }
    const sameFile = grabbed.dev === judged.dev && grabbed.ino === judged.ino
      && grabbed.mtimeMs === judged.mtimeMs && grabbed.size === judged.size;
    if (sameFile && (judged.token == null || lockOwner(aside)?.token === judged.token)) {
      try { unlinkSync(aside); } catch { /* best effort */ }
      return true;
    }
    try { linkSync(aside, lock); } catch { /* a newer lock exists: it stays */ }
    try { unlinkSync(aside); } catch { /* best effort */ }
    return false;
  } finally {
    sweepBroken(lock);
  }
}

/** Removes `.broken` files a crashed break left behind. Best effort, never throws. */
function sweepBroken(lock) {
  try {
    const dir = dirname(lock);
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.broken')) continue;
      try {
        const path = join(dir, entry);
        if (Date.now() - __testHooks.statOf(path).ctimeMs > LOCK_CEILING_MS) unlinkSync(path);
      } catch { /* gone or busy */ }
    }
  } catch { /* unreadable dir */ }
}

/** Removes the lock only while it is still ours: a successor's lock stays. */
function dropLock(lock, token) {
  if (lockOwner(lock)?.token !== token) return;
  try { unlinkSync(lock); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The doc for a `--max-age` caller: `source` is `cache` (young enough),
 * `built` (this caller rebuilt it), or `stale` (another caller is rebuilding;
 * this is the last good result).
 */
export async function serveCached({
  home, name, maxAgeMs, build, now = Date.now, waitMs = WAIT_MS, waitStepMs = 250,
  ceilingMs = LOCK_CEILING_MS,
}) {
  const { dir, lock } = cachePaths(home, name);
  const deadline = Date.now() + Math.min(Math.max(0, waitMs), WAIT_MS);
  for (;;) {
    const cached = readCache(home, name);
    if (cached && now() - cached.savedAt <= maxAgeMs) return { ...cached, source: 'cache' };
    mkdirSync(dir, { recursive: true });
    const token = takeLock(lock, ceilingMs);
    if (token) {
      try {
        // Another caller may have finished between our read and our lock.
        const again = readCache(home, name);
        if (again && now() - again.savedAt <= maxAgeMs) return { ...again, source: 'cache' };
        const doc = await build();
        const savedAt = now();
        // A holder taken over as stuck must not overwrite its successor's cache.
        if (lockOwner(lock)?.token === token) writeCache(home, name, doc, savedAt);
        return { savedAt, doc, source: 'built' };
      } finally {
        dropLock(lock, token);
      }
    }
    if (cached) return { ...cached, source: 'stale' };
    // Nothing cached, and a live holder still has the lock. Stay inside the
    // mod's process budget: do not start a second build.
    if (Date.now() >= deadline) throw new Error('cache not ready');
    await sleep(waitStepMs);
  }
}

/** `pools --json` writes the cache as `{ pools }`, the shape its plain form prints. */
export function writePoolsCache(home, pools, savedAt = Date.now()) {
  writeCache(home, 'pools', { pools }, savedAt);
}

// --- the CLI forms the cache answers ------------------------------------------

/**
 * Which cache an argv asks, and how old an answer it takes: exactly
 * `pools`, `assignments` or `workflow runs`, with `--json` and
 * `--max-age <seconds>` in any order. null for anything else (the full CLI
 * then answers, or refuses it).
 */
export function cachedCall(argv) {
  const [name, flags] = argv[0] === 'pools' ? ['pools', argv.slice(1)]
    : argv[0] === 'assignments' ? ['assignments', argv.slice(1)]
      : argv[0] === 'workflow' && argv[1] === 'runs' ? ['runs', argv.slice(2)]
        : [null, []];
  if (!name) return null;
  let json = false;
  let seconds = null;
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i];
    if (arg === '--json') json = true;
    else if (arg === '--max-age' && i + 1 < flags.length) seconds = flags[++i];
    else if (arg.startsWith('--max-age=')) seconds = arg.slice('--max-age='.length);
    else return null;
  }
  if (!json || seconds === null || !/^\d+$/.test(seconds)) return null;
  const n = Number(seconds);
  return n >= 1 && n <= 3600 ? { name, maxAgeMs: n * 1000 } : null;
}

/**
 * What a `--max-age` caller prints: the plain form's JSON, plus `cache`
 * {source, savedAt, file} where the plain form is an object. `assignments`
 * stays the bare array its plain form prints.
 */
export function servedJson(served, home, name = 'pools') {
  if (name === 'assignments') return JSON.stringify(served.doc.assignments ?? [], null, 2);
  return JSON.stringify({
    ...served.doc,
    cache: { source: served.source, savedAt: served.savedAt, file: cachePaths(home, name).file },
  }, null, 2);
}

/** Bullswarm's home, as src/cli.js getBullswarmDir names it. */
export function bullswarmHome() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

/** A `--max-age` call: exit code. A young cache is printed before the CLI loads. */
export async function cachedCallMain(argv) {
  const { name, maxAgeMs } = cachedCall(argv);
  const home = bullswarmHome();
  const served = await serveCached({
    home,
    name,
    maxAgeMs,
    build: async () => (await import('../cli.js')).liveDocForCache(name),
  });
  console.log(servedJson(served, home, name));
  return 0;
}
