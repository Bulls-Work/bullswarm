// bullswarm config — merge connectors + state into runtime pool views.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from './state.js';
import { paceScore, elapsedPct, isQuarantined } from './route.js';

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
 * Build the runtime pool list: connector + state + computed pace.
 */
export function buildPools(bullswarmDir, now = Date.now()) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const pools = [];
  for (const [name, conn] of Object.entries(connectors)) {
    const ps = state.pools[name] ?? {};
    const meter = { type: conn.meter?.type ?? 'none' };
    if (conn.meter?.window) meter.window = conn.meter.window;
    if (ps.meter) Object.assign(meter, ps.meter);
    if (meter.type !== 'none' && !meter.windowStart) meter.windowStart = now;
    pools.push({
      name,
      connector: conn,
      enabled: ps.enabled !== false,
      costRank: conn.costRank ?? 5,
      lanes: conn.lanes,
      meter,
      usedPct: meter.usedPct,
      quarantine: ps.quarantine ?? null,
      incumbentLane: Object.entries(state.incumbents ?? {})
        .filter(([, v]) => v === name)
        .map(([k]) => k),
      pace: null,
    });
  }
  for (const p of pools) {
    p.pace =
      p.enabled && !isQuarantined(p, now)
        ? Math.round(paceScore({ meter: p.meter }, now) * 10) / 10
        : null;
    p.elapsedPct =
      p.meter.type === 'none'
        ? null
        : Math.round(elapsedPct(p.meter, now) * 10) / 10;
  }
  return { state, connectors, pools };
}
