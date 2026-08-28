// bullswarm config — merge connectors + state into runtime pool views.
//
// Meter precedence (doctrine M1):
//   1. live/cached provider reading (meter reader exists)
//   2. declared meter from state.json (labeled "declared")
//   3. unmetered (pace 0, neutral)
//
// Pace source (doctrine M2): the pacing object carries elapsed% computed
// from the provider's resets_at. Declared meters fall back to the local
// elapsed estimate and are visibly labeled.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from './state.js';
import { paceScore, isQuarantined } from './route.js';

export function loadConnectors(bullswarmDir) {
  const dir = join(bullswarmDir, 'connectors');
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      out[c.name] = c;
    } catch {
      // broken connector files surface in `bullswarm setup` repair,
      // never crash a run
    }
  }
  return out;
}

/**
 * Build the runtime pool list: connector + state + meter reading.
 * Meter readings are injected by the caller (async — readers poll the
 * network); this function stays sync so tests can build pools without I/O.
 */
export function buildPools(bullswarmDir, now = Date.now(), readings = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const pools = [];
  for (const [name, conn] of Object.entries(connectors)) {
    const ps = state.pools[name] ?? {};
    const pool = {
      name,
      connector: conn,
      enabled: ps.enabled !== false,
      costRank: conn.costRank ?? 5,
      lanes: conn.lanes,
      capabilities: conn.capabilities ?? [],
      quarantine: isQuarantined({ quarantine: ps.quarantine ?? null }, now)
        ? ps.quarantine
        : null,
      incumbentLane: Object.entries(state.incumbents ?? {})
        .filter(([, v]) => v === name)
        .map(([k]) => k),
      // meter fields filled below
      meterSource: 'none',
      usedPct: null,
      elapsedPct: null,
      pace: null,
      burstGate: false,
      meterSnapshot: null,
      subscription: {
        ...(conn.subscription ?? {}),
        ...(state.strategy?.subscriptions?.[name] ?? {}),
      },
      strategyAssignments: state.strategy?.assignments ?? {},
      strategyExcludedModels: state.strategy?.excludedModels ?? [],
    };
    pools.push(pool);
  }

  for (const p of pools) {
    if (!p.enabled || isQuarantined(p, now)) continue;
    const ps = state.pools[p.name] ?? {};

    const reading = readings[p.name];
    if (reading?.pacing) {
      // Provider-truth path (M1/M2)
      p.meterSource = reading.source; // live | cache | stale
      p.usedPct = reading.pacing.usedPct;
      p.elapsedPct = reading.pacing.elapsedPct;
      p.pace = reading.pacing.surplus; // surplus = elapsed − used
      p.paceResetsAt = reading.pacing.resetsAt;
      p.burstGate = reading.burstGate === true;
      p.meterSnapshot = reading.snapshot ?? null;
    } else {
      // Declared / unmetered fallback
      const meter = { ...(p.connector.meter ?? {}), ...(ps.meter ?? {}) };
      if (meter.type !== 'none' && meter.usedPct != null) {
        p.meterSource = 'declared';
        p.usedPct = meter.usedPct;
        // Without resets_at, elapsed is unknown → surplus is just −used,
        // which still ranks pools by remaining headroom honestly.
        p.pace = -meter.usedPct;
      } else {
        p.meterSource = 'none';
        p.pace = 0;
      }
    }
  }
  return { state, connectors, pools };
}

/**
 * Async variant that fetches live readings for pools with readers.
 */
export async function buildPoolsLive(bullswarmDir, now = Date.now(), { force = false, getReadings } = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const names = Object.keys(connectors);
  const readings = getReadings
    ? await getReadings(names, { force, nowMs: now })
    : {};
  return buildPools(bullswarmDir, now, readings);
}
