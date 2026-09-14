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
//
// Declared reset (doctrine M2, operator path): a provider reading that
// carries usage but no reset for the pacing window is paced from
// `state.strategy.subscriptions[pool].resetsAt` when the operator declared
// one (`strategy set-subscription --resets-at`). The used% stays the
// provider's; only the window's end is declared, and `p.resetSource` says
// 'declared' (else 'provider') so every view can label it.
//
// Pacing window (doctrine M3): WHICH window paces a pool is the pool's own
// subscription window — `state.strategy.subscriptions[pool].quotaWindow`,
// else `connector.subscription.quotaWindow` — resolved here, where both the
// state and the connector are in hand, so a cache, stale or live reading is
// paced identically. `p.pacingWindow` names the window the numbers on the
// pool view actually came from.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from './state.js';
import { paceScore, isQuarantined } from './route.js';
// One strict numeric coercion for the whole codebase (src/lib/num.js).
import { finiteOrNull } from './num.js';
import {
  FIVE_HOUR_NEAR_LIMIT_PCT, pacingWindowFor, pickPacingWindow, declaredResetPacing,
} from '../meters/framework.js';
import { expandClaudeAccountConnectors } from './claude-accounts.js';
import { expandOpenCodeRelayConnectors } from './opencode-relay.js';

export function loadConnectors(bullswarmDir, opts = {}) {
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
  expandClaudeAccountConnectors(out, opts);
  expandOpenCodeRelayConnectors(out, opts);
  return out;
}

/**
 * Whether a connector's pool is enabled, by the one rule both buildPools and
 * buildPoolsLive apply: a test-fixture pool is opt-IN (it must be switched on
 * explicitly), every other pool is opt-out.
 */
function poolEnabled(conn, poolState) {
  return conn?.flags?.testFixture === true
    ? poolState?.enabled === true
    : poolState?.enabled !== false;
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
      testFixture: conn.flags?.testFixture === true,
      enabled: poolEnabled(conn, ps),
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
      // Where the pacing reset came from: 'provider' | 'declared' | null.
      resetSource: null,
      // The subscription window that paces this pool, before any reading:
      // the operator's setting, else the connector's declaration, else null
      // (default order). Replaced below by the window a reading really used.
      pacingWindow: pacingWindowFor({
        connector: conn,
        subscription: state.strategy?.subscriptions?.[name] ?? null,
      }),
      burstGate: false,
      // 5h window (doctrine M3): gates routing, never paces it.
      fiveHourUsedPct: null,
      fiveHourResetsAt: null,
      nearFiveHourLimit: false,
      meterSnapshot: null,
      subscription: {
        ...(conn.subscription ?? {}),
        ...(state.strategy?.subscriptions?.[name] ?? {}),
      },
      strategyAssignments: state.strategy?.assignments ?? {},
      strategyExcludedModels: state.strategy?.excludedModels ?? [],
      strategyModelTiers: state.strategy?.modelTiers ?? {},
      strategyConfiguredTiers: state.strategy?.configuredTiers ?? [],
      strategyDisabledModels: state.strategy?.disabledModels ?? {},
    };
    pools.push(pool);
  }

  for (const p of pools) {
    if (!p.enabled || isQuarantined(p, now)) continue;
    const ps = state.pools[p.name] ?? {};

    const reading = readings[p.name];
    // The 5h gate is independent of the pacing window: a reading may carry a
    // 5h utilization with no weekly/monthly window to pace by, and routing
    // still has to see that the pool is close to its 5h limit.
    if (reading) {
      const fiveHour = fiveHourFromReading(reading);
      p.fiveHourUsedPct = fiveHour.usedPct;
      p.fiveHourResetsAt = fiveHour.resetsAt;
      p.nearFiveHourLimit = fiveHour.nearLimit;
    }
    const paced = pacedReading(reading, p.pacingWindow)
      // Provider usage with no provider reset: the operator-declared reset
      // ends the window (M2, operator path). Provider truth stays first.
      ?? declaredResetPacing(reading?.snapshot, {
        pacingWindow: p.pacingWindow,
        resetsAt: p.subscription?.resetsAt ?? null,
        nowMs: now,
      });
    if (paced) {
      // Provider-truth path (M1/M2)
      p.meterSource = reading.source; // live | cache | stale
      p.resetSource = paced.resetSource ?? 'provider';
      p.usedPct = paced.pacing.usedPct;
      p.elapsedPct = paced.pacing.elapsedPct;
      p.pace = paced.pacing.surplus; // surplus = elapsed − used
      p.paceResetsAt = paced.pacing.resetsAt;
      p.pacingWindow = paced.window;
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
 * The window of a reading that paces this pool, and its name.
 *
 * `reading.windows` carries every window the provider reported, so the choice
 * is made here rather than re-deriving it: 'monthly' takes monthly and falls
 * back to weekly, anything else keeps the historical weekly-first order.
 * A reading assembled without `windows` (a hand-built one, or an older code
 * path) still carries `pacing`, which is used as-is — its window name is
 * whatever the producer labeled, else the pool's declaration.
 *
 * @returns {{pacing: object, window: 'weekly'|'monthly'|null}|null}
 */
function pacedReading(reading, pacingWindow) {
  if (!reading) return null;
  if (reading.windows) {
    const chosen = pickPacingWindow(reading.windows, pacingWindow);
    if (chosen.pacing) return chosen;
  }
  if (!reading.pacing) return null;
  return { pacing: reading.pacing, window: reading.pacingWindow ?? pacingWindow ?? null };
}

/**
 * 5h window fields from a meter reading. Prefers the flat fields paceSnapshot
 * produces and falls back to the raw snapshot, so a reading assembled by an
 * older code path still reports a real 5h number instead of null.
 */
function fiveHourFromReading(reading) {
  const usedPct = finiteOrNull(reading?.fiveHourUsedPct)
    ?? finiteOrNull(reading?.snapshot?.five_hour?.utilization);
  const raw = reading?.fiveHourResetsAt ?? reading?.snapshot?.five_hour?.resets_at ?? null;
  const resetsMs = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return {
    usedPct,
    resetsAt: Number.isFinite(resetsMs) ? new Date(resetsMs).toISOString() : null,
    nearLimit: usedPct != null && usedPct >= FIVE_HOUR_NEAR_LIMIT_PCT,
  };
}

/**
 * Async variant that fetches live readings for pools with readers.
 */
export async function buildPoolsLive(bullswarmDir, now = Date.now(), {
  force = false, getReadings, onProviderProgress,
} = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  // Poll only the pools whose readings can be used (D6). The loop above
  // already skips disabled and quarantined pools when it applies readings, so
  // asking for theirs read a credential and called a provider usage endpoint
  // for a number that was thrown away — on every `pools`, every `run` and
  // every 15-second V2 refresh.
  const names = Object.keys(connectors).filter((name) => {
    const ps = state.pools?.[name] ?? {};
    return poolEnabled(connectors[name], ps)
      && !isQuarantined({ quarantine: ps.quarantine ?? null }, now);
  });
  const readings = getReadings
    ? await getReadings(names, {
      force, nowMs: now, onProgress: onProviderProgress,
      // A pool's declared plan total (set-subscription --included-usd) is the
      // denominator its meter reads used USD against; see relayIncludedUsd.
      subscriptions: state.strategy?.subscriptions ?? {},
    })
    : {};
  return buildPools(bullswarmDir, now, readings);
}
