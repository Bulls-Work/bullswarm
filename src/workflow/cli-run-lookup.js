// Where the workflow verbs find things: the home (BULLSWARM_HOME, read on
// every call) and the run a token names, refusing a legacy run before any
// verb drives it.

import { withV2Cancellation } from './v2-cancellation.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveRunId, isLegacyRunDir, isLegacyRunState, legacyRunLine } from './short-id.js';

// BULLSWARM_DIR is read on every call so that changes to the
// BULLSWARM_HOME env var (e.g. set per-test) are honored, not
// captured at module load. (The previous module-level IIFE form
// silently broke resume-by-shortId for any run whose BULLSWARM_HOME
// differed from the one in effect when the module was first
// imported.)
function bullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

export const BULLSWARM_DIR = bullswarmDir; // back-compat for any external import

// Legacy (pre-0.27.0 authored-graph) runs are read-only history. Every verb
// that would drive one — cancel, resume, steer, action show, tui <runId> —
// answers with the same sentence and exit 2 before doing anything else.
// Returns null when `token` is not a legacy run, so the caller carries on.
export function legacyRunRefusal(token, { json = false } = {}) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) return null;
  if (!isLegacyRunDir(resolved.runDir)) return null;
  const message = legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir });
  if (json) console.log(JSON.stringify({ legacy: true, runId: resolved.runId, shortId: resolved.shortId ?? null, dir: resolved.runDir, message }, null, 2));
  else console.error(message);
  return 2;
}

export function loadV2RunState(token) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = withV2Cancellation(JSON.parse(readFileSync(statePath, 'utf8')), resolved.runDir);
  if (isLegacyRunState(state)) throw new Error(`run "${token}" is not an autonomous V2 run`);
  return { ...resolved, state };
}
