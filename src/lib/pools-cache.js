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
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A lock older than this whose holder is gone belongs to a refresher that died; each read has a 30 s budget in the mod. */
const LOCK_STALE_MS = 120_000;
/** How long a caller with nothing cached waits for another caller's build. */
const WAIT_MS = 45_000;

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
 * This caller's token when it now holds the lock, else null. A lock is broken
 * only when it is over two minutes old and its holder is gone.
 */
function takeLock(lock) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, `${process.pid} ${Date.now()} ${token}\n`); } finally { closeSync(fd); }
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS || processAlive(lockOwner(lock)?.pid)) return null;
      try { unlinkSync(lock); } catch { /* another caller broke it first */ }
    }
  }
  return null;
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
}) {
  const { dir, lock } = cachePaths(home, name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const cached = readCache(home, name);
    if (cached && now() - cached.savedAt <= maxAgeMs) return { ...cached, source: 'cache' };
    mkdirSync(dir, { recursive: true });
    const token = takeLock(lock);
    if (token) {
      try {
        // Another caller may have finished between our read and our lock.
        const again = readCache(home, name);
        if (again && now() - again.savedAt <= maxAgeMs) return { ...again, source: 'cache' };
        const doc = await build();
        const savedAt = now();
        writeCache(home, name, doc, savedAt);
        return { savedAt, doc, source: 'built' };
      } finally {
        dropLock(lock, token);
      }
    }
    if (cached) return { ...cached, source: 'stale' };
    // Nothing to answer with yet: wait for the build in flight, then build
    // ourselves if it never lands (its lock goes stale, or the wait runs out).
    if (Date.now() >= deadline) {
      const doc = await build();
      const savedAt = now();
      writeCache(home, name, doc, savedAt);
      return { savedAt, doc, source: 'built' };
    }
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

/** A `--max-age` call: exit code; the full CLI loads only to rebuild. */
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
