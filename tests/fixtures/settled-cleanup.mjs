// Removing a test's temporary tree once nothing writes into it any more.
//
// A detached kernel keeps writing after its result is on disk: the rollup
// index at the home's top level, then its lease. A kernel whose run kept a
// workspace copy also starts a detached `bullswarm home prune --auto`, which
// writes the home's maintenance record. rmSync lists each directory once, so
// a file created after that listing fails the removal with ENOTEMPTY, and its
// maxRetries only retries the rmdir, never the listing. So: wait for the
// kernels the home names to exit, then remove, listing again on ENOTEMPTY.

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEPER, 0, 0, ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True once `pid` no longer exists (ESRCH); a pid we may not signal is alive. */
export function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/** Wait until every pid has exited; true when they all did within the time. */
export async function waitForExit(pids, { timeoutMs = 30_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!pids.every(processGone)) {
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/**
 * The kernels a home's runs name (each run's state.json runner and its
 * kernel.lock), other than this process: a test that runs a kernel in
 * process is its own runner.
 */
export function kernelPids(home) {
  let runs = [];
  try { runs = readdirSync(join(home, 'workflows')); } catch { return []; }
  const pids = runs.flatMap((run) => [
    readJson(join(home, 'workflows', run, 'state.json'))?.runner?.pid,
    readJson(join(home, 'workflows', run, 'kernel.lock'))?.pid,
  ]);
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}

/**
 * Remove `root` once the kernels of `homes` (and any `pids`) have exited,
 * listing it again while a late writer finishes. Synchronous, so it fits a
 * `finally` block; it gives up waiting after `timeoutMs` and removes anyway.
 */
export function removeSettled(root, { homes = [], pids = [], timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const waitFor = [...pids, ...homes.flatMap(kernelPids)];
  while (!waitFor.every(processGone) && Date.now() < deadline) sleepSync(25);
  for (;;) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['ENOTEMPTY', 'EBUSY'].includes(error.code) || Date.now() > deadline + 10_000) throw error;
      sleepSync(100);
    }
  }
}
