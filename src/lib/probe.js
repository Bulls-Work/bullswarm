// Liveness probes for explicitly selected free-model rungs.
//
// A probe is deliberately narrower than model discovery: it runs only after
// routing has selected a concrete model named by strategy, and it never asks a
// provider what other models it has.  The result (including a failure) is
// cached briefly so concurrent dispatches do not turn one dead endpoint into a
// burst of identical calls.

import {
  existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync, readJsonSafe } from './fsjson.js';
import { watchOnce } from './watch.js';
import { isFreeModel } from './usage.js';

export const FREE_MODEL_PROBE_PROMPT = 'PONG';
export const FREE_MODEL_PROBE_TTL_MS = 15 * 60_000;
export const FREE_MODEL_PROBE_TIMEOUT_MS = 30_000;
export const FREE_MODEL_PROBE_CACHE_FILE = 'cache/free-model-probes.json';

function nowMs(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const number = Number(resolved);
  return Number.isFinite(number) ? number : Date.now();
}

function poolNameOf(pool) {
  return pool?.name ?? pool?.connector?.name ?? null;
}

function modelSourceOf(pool) {
  return pool?.modelPolicy?.source ?? pool?.modelSource ?? null;
}

/**
 * A probe is allowed only for a concrete model selected by strategy.  The
 * connector default is intentionally not enough: a default can change under
 * the provider without a strategy rung changing, and must never cause a
 * liveness call.  `modelPolicy` is attached by both routing callers.
 */
export function shouldProbeFreeModel(pool, model) {
  const source = modelSourceOf(pool);
  // These two sources are safety fallbacks for exclusions, not a rung that
  // names a model. Only an assignment or tier allow-list is an explicit
  // strategy choice worth probing.
  if (!model || !source || source === 'connector-default'
      || source === 'configured-model' || source === 'exclusion-safe-tier-fallback') return false;
  const connector = pool?.connector ?? pool;
  return isFreeModel(connector, model)
    || (pool?.free === true && pool.freeModel === model);
}

function cachePath(home) {
  return typeof home === 'string' && home
    ? join(home, FREE_MODEL_PROBE_CACHE_FILE)
    : null;
}

function cacheKey(pool, model) {
  return `${poolNameOf(pool) ?? '?'}\u0000${String(model)}`;
}

function readCache(home) {
  const path = cachePath(home);
  const value = path ? readJsonSafe(path, null) : null;
  if (value && typeof value === 'object' && value.entries && typeof value.entries === 'object') {
    return value;
  }
  // Accept the simple map shape too; this keeps a hand-created test cache
  // readable without making it part of the public contract.
  return value && typeof value === 'object' ? { entries: value } : { entries: {} };
}

function cacheHit(home, key, at) {
  const entry = readCache(home).entries[key];
  if (!entry || typeof entry !== 'object') return null;
  const numericAt = Number(entry.at);
  const captured = Number.isFinite(numericAt) ? numericAt : Date.parse(entry.at ?? '');
  if (!Number.isFinite(captured) || at < captured || at - captured >= FREE_MODEL_PROBE_TTL_MS) return null;
  return {
    ok: entry.ok === true,
    reason: entry.reason ?? null,
    at: entry.at,
    cached: true,
  };
}

function writeCache(home, key, result) {
  const path = cachePath(home);
  if (!path) return;
  const current = readCache(home);
  current.entries[key] = {
    ok: result.ok === true,
    reason: result.reason ?? null,
    at: result.at,
  };
  atomicWriteFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function reasonOf(observed) {
  // `watchOnce` puts its timeout verdict in meta. An injected runner may
  // report that its own wall-clock timer fired at the top level. Do not scan
  // arbitrary verdict text for timeout words: even the key name `timedOut`
  // inside a serialized meta object would otherwise make every failure look
  // like a timeout.
  if (observed?.meta?.timedOut === true || observed?.timedOut === true) {
    return 'timeout';
  }

  // A missing model is a provider-side 404 even when the CLI exits quickly
  // and only explains it in the verdict's why text or stderr.
  const text = [observed?.why, observed?.stderrTail, observed?.stderr].map(textOf).join('\n');
  if (observed?.status === 404 || observed?.statusCode === 404 || observed?.code === 404
      || /\b404\b|model\s+not\s+found/i.test(text)) {
    return '404';
  }
  return 'provider error';
}

/** Run the same worker watcher used by provider-cli, with a liveness validator. */
async function defaultRunner({ pool, model, home, timeoutMs }) {
  const connector = pool?.connector ?? pool;
  const work = mkdtempSync(join(tmpdir(), 'bullswarm-free-probe-'));
  const paths = {
    taskFile: join(work, 'task.md'),
    outFile: join(work, 'output.txt'),
  };
  try {
    const verdict = await watchOnce(connector, FREE_MODEL_PROBE_PROMPT, work, paths, {
      model,
      timeoutSec: timeoutMs / 1000,
      processGroup: true,
      bullswarmDir: home,
      // A liveness response is intentionally not judged as a coding answer.
      // The transport, exit status and timeout still go through watchOnce.
      outputValidator: () => ({ ok: true }),
    });
    return {
      ...verdict,
      output: existsSync(paths.outFile) ? readFileSync(paths.outFile, 'utf8') : '',
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Probe one explicitly named free model.
 *
 * `runner` is injectable and receives `{ pool, model, home, timeoutMs, now,
 * prompt }`; the default delegates through the pool's own CLI via watchOnce.
 * A skipped (default or paid) model is a successful no-op, so callers can use
 * the result directly without accidentally skipping the pool.
 */
export async function probeFreeModel({
  pool,
  model,
  home,
  timeoutMs = FREE_MODEL_PROBE_TIMEOUT_MS,
  now = Date.now,
  runner: injectedRunner = null,
  run = null,
} = {}) {
  const atMs = nowMs(now);
  const at = new Date(atMs).toISOString();
  if (!shouldProbeFreeModel(pool, model)) return { ok: true, reason: null, at, skipped: true };

  const key = cacheKey(pool, model);
  const cached = cacheHit(home, key, atMs);
  if (cached) return cached;

  let observed;
  try {
    const runner = injectedRunner ?? run ?? defaultRunner;
    const context = {
      pool, model, home, timeoutMs: Number(timeoutMs), now: atMs,
      prompt: FREE_MODEL_PROBE_PROMPT,
    };
    // The object form is the public test seam; accepting positional runners
    // keeps tiny fixtures convenient without changing the default runner.
    observed = await (runner.length >= 2
      ? runner(pool, model, context)
      : runner(context));
  } catch (error) {
    observed = {
      ok: false,
      error: error?.message ?? String(error),
      ...(error?.status != null ? { status: error.status } : {}),
      ...(error?.statusCode != null ? { statusCode: error.statusCode } : {}),
      ...(error?.code != null ? { code: error.code } : {}),
    };
  }
  const result = {
    ok: observed?.ok === true,
    reason: observed?.ok === true ? null : reasonOf(observed),
    at,
  };
  writeCache(home, key, result);
  return result;
}
