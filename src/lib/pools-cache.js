// The shared pools cache: one `pools --json` build serves every caller for a
// while. Each Claude session's mod asks for the pools on a timer, and a build
// is a full CLI load plus every meter read (260-345 MB RSS each; 11 ran at once
// on 2026-10-20). With `--max-age`, a young cache is the answer, and when it
// is old one caller takes a file lock and rebuilds while the rest answer with
// the last good result.
//
// Only node built-ins here: bin/bullswarm.js imports this before the CLI, so a
// cache hit never loads the rest of Bullswarm.

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const POOLS_CACHE_SCHEMA = 'bullswarm.pools-cache.v1';
/** A lock older than this belongs to a refresher that died; pools has a 30 s budget in the mod. */
const LOCK_STALE_MS = 120_000;
/** How long a caller with nothing cached waits for another caller's build. */
const WAIT_MS = 45_000;

export function poolsCachePaths(home) {
  const dir = join(home, 'cache');
  return { dir, file: join(dir, 'pools.json'), lock: join(dir, 'pools.lock') };
}

/** The cached `{ savedAt, pools }`, or null when there is none or it is unreadable. */
export function readPoolsCache(home) {
  try {
    const doc = JSON.parse(readFileSync(poolsCachePaths(home).file, 'utf8'));
    if (doc?.schema !== POOLS_CACHE_SCHEMA || !Number.isFinite(doc.savedAt) || !Array.isArray(doc.pools)) return null;
    return { savedAt: doc.savedAt, pools: doc.pools };
  } catch {
    return null;
  }
}

/** Writes the cache whole or not at all: a reader never sees half a file. */
export function writePoolsCache(home, pools, savedAt = Date.now()) {
  const { dir, file } = poolsCachePaths(home);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ schema: POOLS_CACHE_SCHEMA, savedAt, pools }, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** true when this caller now holds the lock. A dead refresher's lock is broken once. */
function takeLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, `${process.pid} ${Date.now()}\n`); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) return false;
      try { unlinkSync(lock); } catch { /* another caller broke it first */ }
    }
  }
  return false;
}

function dropLock(lock) {
  try { unlinkSync(lock); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pools for a `--max-age` caller: `source` is `cache` (young enough),
 * `built` (this caller rebuilt it), or `stale` (another caller is rebuilding;
 * this is the last good result).
 */
export async function servePools({
  home, maxAgeMs, build, now = Date.now, waitMs = WAIT_MS, waitStepMs = 250,
}) {
  const { dir, lock } = poolsCachePaths(home);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const cached = readPoolsCache(home);
    if (cached && now() - cached.savedAt <= maxAgeMs) return { ...cached, source: 'cache' };
    mkdirSync(dir, { recursive: true });
    if (takeLock(lock)) {
      try {
        // Another caller may have finished between our read and our lock.
        const again = readPoolsCache(home);
        if (again && now() - again.savedAt <= maxAgeMs) return { ...again, source: 'cache' };
        const pools = await build();
        const savedAt = now();
        writePoolsCache(home, pools, savedAt);
        return { savedAt, pools, source: 'built' };
      } finally {
        dropLock(lock);
      }
    }
    if (cached) return { ...cached, source: 'stale' };
    // Nothing to answer with yet: wait for the build in flight, then build
    // ourselves if it never lands (its lock goes stale, or the wait runs out).
    if (Date.now() >= deadline) {
      const pools = await build();
      return { savedAt: now(), pools, source: 'built' };
    }
    await sleep(waitStepMs);
  }
}

/**
 * The max age, in ms, of a `pools … --max-age <s>` argv that the cache may
 * answer: exactly `pools`, `--json` and `--max-age`, in any order. null when
 * the argv is anything else (the full CLI then answers, or refuses it).
 */
export function cachedPoolsMaxAge(argv) {
  if (argv[0] !== 'pools') return null;
  let json = false;
  let seconds = null;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--max-age' && i + 1 < argv.length) seconds = argv[++i];
    else if (arg.startsWith('--max-age=')) seconds = arg.slice('--max-age='.length);
    else return null;
  }
  if (!json || seconds === null || !/^\d+$/.test(seconds)) return null;
  const n = Number(seconds);
  return n >= 1 && n <= 3600 ? n * 1000 : null;
}

/** The `pools --json --max-age` answer: the pools, and where they came from. */
export function servedJson(served, home) {
  return JSON.stringify({
    pools: served.pools,
    cache: { source: served.source, savedAt: served.savedAt, file: poolsCachePaths(home).file },
  }, null, 2);
}

/** Bullswarm's home, as src/cli.js getBullswarmDir names it. */
export function bullswarmHome() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

/** `bullswarm pools --json --max-age <s>`: exit code; the full CLI loads only to rebuild. */
export async function cachedPoolsMain(argv) {
  const maxAgeMs = cachedPoolsMaxAge(argv);
  const home = bullswarmHome();
  const served = await servePools({
    home,
    maxAgeMs,
    build: async () => (await import('../cli.js')).livePoolsForCache(),
  });
  console.log(servedJson(served, home));
  return 0;
}
