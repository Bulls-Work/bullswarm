// bullswarm state — one JSON file at ~/.bullswarm/state.json.
//
// Doctrine:
//   S1. Quarantine always carries a re-probe deadline; a recovered pool
//       returns to service AUTOMATICALLY (fixes the /offload gap where a
//       pool benched 30 minutes stayed benched while it had recovered).
//   S2. Incumbency per lane persists so picks don't flap between runs.
//   S3. Every run appends to the decision log — routing telemetry is the
//       substrate for burn-rate learning later.
//   S4. Recursion depth is owned by the CORE: the guard counter lives in
//       state, incremented by env var handshake, never trusted from args.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_STATE = {
  version: 1,
  pools: {},        // name -> {enabled, meter:{type,windowStart?,usedPct?,declaredBy}, quarantine:{until,reason}|null}
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
  writeFileSync(
    join(bullswarmDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

// --- quarantine -----------------------------------------------------------

export function quarantinePool(state, poolName, reason, now = Date.now()) {
  // Re-probe window: 10 minutes by default (not 30) with automatic release.
  const until = now + 10 * 60_000;
  state.pools[poolName] ??= {};
  state.pools[poolName].quarantine = { until, reason };
  // A quarantined pool cannot hold incumbency: it isn't serving work, and
  // keeping the flag would lock the lane against its return.
  for (const [lane, name] of Object.entries(state.incumbents ?? {})) {
    if (name === poolName) delete state.incumbents[lane];
  }
  return until;
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
