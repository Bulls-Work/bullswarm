// Workflow verbs that act on one part of a v3 run (0.37.0, design section 5):
// `workflow continue` here; `add` and `wait` join it in the next build.
//
// `workflow continue <run> <gate-or-loop> [--rounds N]` passes a waiting gate,
// or gives an out-of-rounds loop N more rounds (without --rounds the loop
// passes as it stands). It writes a durable intent next to the run. A live
// kernel applies it on its next pass; with no live kernel this command applies
// it under the run's lease, sets the lifecycle back to running itself, and
// relaunches the kernel detached, as `plan revise` does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { usageLine } from '../help.js';
import {
  CONTINUE_MAX_ROUNDS, applyContinueOffline, continueRefusal, readContinueIntents, requestContinue,
} from './gates-loops.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { isLegacyRunDir, resolveRunId } from './short-id.js';
import { acquireKernelLease } from './v2-process.js';
import { deserializeV2DurableState, serializeV2DurableState } from './v2-state.js';

const TERMINAL = new Set(['completed', 'partial', 'cancelled', 'failed']);

function readState(runDir) {
  return deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8'));
}

function tryLease(runDir) {
  try { return acquireKernelLease(runDir); } catch { return null; }
}

/** Parse --rounds: a whole number from 1 to 5, or null when absent. Throws with the usage message. */
export function parseContinueRounds(value) {
  if (value === undefined) return null;
  const text = String(value);
  const rounds = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > CONTINUE_MAX_ROUNDS) {
    throw new Error(`--rounds must be a whole number from 1 to ${CONTINUE_MAX_ROUNDS}`);
  }
  return rounds;
}

/**
 * Continue one waiting gate or loop. Resolves {code, status, ...}: status
 * `applied` (appliedBy offline|kernel), `queued` (a live kernel has not taken
 * it within waitMs), or `refused` with `why`. `relaunch(runId)` starts the
 * kernel again after an offline apply.
 */
export async function continueV2Run({
  bullswarmDir, token, nodeId, rounds = null,
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { code: 1, status: 'refused', why: `no run found for "${token}"` };
  if (isLegacyRunDir(resolved.runDir)) return { code: 2, status: 'refused', why: `run "${token}" is a legacy run; nothing drives it` };
  const { runDir } = resolved;
  let state;
  try { state = readState(runDir); } catch (err) { return { code: 1, status: 'refused', why: `cannot read the run state: ${err.message}` }; }
  const base = { runId: state.runId, shortId: state.shortId ?? null, node: nodeId, rounds };
  const id = state.shortId ?? state.runId;
  const refusal = continueRefusal(state, nodeId, rounds);
  if (refusal) return { code: /^--rounds/.test(refusal) ? 2 : 1, status: 'refused', why: refusal, ...base };
  if (TERMINAL.has(state.lifecycle.status)) {
    return { code: 1, status: 'refused', why: `the run is ${state.lifecycle.status}; start a new run or reopen it with bullswarm workflow resume ${id}`, ...base };
  }
  const intent = requestContinue(runDir, { nodeId, rounds, source: 'cli', now });
  const features = runFeatureFlags(readRunFeatures(runDir));
  const settledByKernel = () => {
    const current = readContinueIntents(runDir).find((entry) => entry.id === intent.id);
    if (!current?.appliedAt) return null;
    return current.refused
      ? { code: 1, status: 'refused', why: current.refused, appliedBy: 'kernel', ...base }
      : { code: 0, status: 'applied', appliedBy: 'kernel', ...base };
  };
  const applyOffline = () => {
    const lease = tryLease(runDir);
    if (!lease) return null;
    try {
      const settled = settledByKernel();
      if (settled) return settled;
      const current = readState(runDir);
      const outcome = applyContinueOffline(current, intent, { runDir, at: now(), features });
      serializeV2DurableState(current);
      writeJsonAtomic(join(runDir, 'state.json'), current);
      if (!outcome.applied) return { code: 1, status: 'refused', why: outcome.why, ...base };
      return { code: 0, status: 'applied', appliedBy: 'offline', lifecycle: current.lifecycle.status, ...base };
    } finally { lease.release(); }
  };
  let result = applyOffline();
  const deadline = Date.now() + Math.max(0, waitMs);
  while (!result) {
    result = settledByKernel() ?? applyOffline();
    if (result) break;
    if (Date.now() >= deadline) return { code: 0, status: 'queued', appliedBy: null, ...base };
    await new Promise((done) => setTimeout(done, pollMs));
  }
  if (result.status === 'applied' && result.appliedBy === 'offline' && result.lifecycle === 'running' && typeof relaunch === 'function') {
    try { result.relaunch = await relaunch(state.runId); }
    catch (err) { return { code: 1, status: 'applied', why: `continue applied but the kernel did not relaunch: ${err.message}`, ...result }; }
  }
  return result;
}

function describe(result, type) {
  if (result.rounds != null) return `loop ${result.node} gets ${result.rounds} more round${result.rounds === 1 ? '' : 's'}`;
  return `${type ?? 'node'} ${result.node} passed`;
}

/** `bullswarm workflow continue <runId> <gate-or-loop> [--rounds N] [--wait s] [--json]`. */
export async function wfContinue(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume }) {
  const path = ['workflow', 'continue'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [token, nodeId] = opts.rest;
  if (!token || !nodeId || opts.rest.length > 2) { console.error(`usage: ${usageLine(path)}`); return 2; }
  let rounds;
  try { rounds = parseContinueRounds(opts.rounds); } catch (err) { console.error(`✗ ${err.message}`); return 2; }
  const waitSec = opts.wait === undefined ? 120 : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  const resolved = resolveRunId(bullswarmDir, token);
  let type = null;
  try { type = resolved ? readState(resolved.runDir).program?.control?.gates?.some((gate) => gate.id === nodeId) ? 'gate' : 'loop' : null; } catch { type = null; }
  const relaunch = async (runId) => {
    const doc = JSON.parse(readFileSync(join(bullswarmDir, 'workflows', runId, 'goal.json'), 'utf8'));
    return launchDetachedResume(doc, runId, opts);
  };
  const result = await continueV2Run({ bullswarmDir, token, nodeId, rounds, waitMs: waitSec * 1000, relaunch });
  const { code, ...payload } = result;
  if (opts.json) console.log(JSON.stringify({ action: 'workflow-continue', ...payload }, null, 2));
  if (result.status === 'refused') {
    if (!opts.json) console.error(`✗ ${result.why}`);
    return code;
  }
  if (opts.json) return code;
  const id = result.shortId ?? result.runId;
  if (result.status === 'queued') {
    console.log(`✓ continue ${nodeId} queued for ${id}; its running kernel applies it at its next check`);
  } else if (result.appliedBy === 'kernel') {
    console.log(`✓ ${describe(result, type)} in ${id} (applied by its running kernel)`);
  } else {
    console.log(`✓ ${describe(result, type)} in ${id}${result.relaunch ? '; kernel relaunched' : ''}`);
    if (result.why) console.error(`✗ ${result.why}`);
  }
  console.log(`  watch    bullswarm workflow watch ${id} --until trouble`);
  return code;
}
