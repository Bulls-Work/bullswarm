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

import { loadState } from './state.js';
import { paceScore, isQuarantined } from './route.js';
// One strict numeric coercion for the whole codebase (src/lib/num.js).
import { finiteOrNull } from './num.js';
import {
  FIVE_HOUR_NEAR_LIMIT_PCT, pacingWindowFor, pickPacingWindow, declaredResetPacing,
} from '../meters/framework.js';
import { loadProviders } from './providers.js';
import { cachedQuotaRefusal } from '../meters/registry.js';
import { isFreeModel } from './usage.js';
import {
  configuredModel, disabledModelsForPool, resolveDispatchModel, selectedModelsForTier,
  STRATEGY_TIERS,
} from './strategy.js';

/**
 * Every pool by name, from every loaded provider (src/lib/providers.js).
 * A provider that fails to load contributes nothing and never crashes a run;
 * `bullswarm setup` and `bullswarm provider list` surface its error.
 */
export function loadConnectors(bullswarmDir, opts = {}) {
  return loadProviders(bullswarmDir, opts).connectors;
}

/**
 * The same load as loadConnectors, keeping the provider entries (tier,
 * enabled, pools, error, displayName) for callers that report per provider.
 *
 * @returns {{ connectors: Record<string, object>, providers: object[] }}
 */
export function loadPoolProviders(bullswarmDir, opts = {}) {
  return loadProviders(bullswarmDir, opts);
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
 * Resolve the model that a pool would run for an effort tier, then expose the
 * connector-owned free declaration on the runtime view. Dispatch attaches the
 * full model policy again at its pick site; this projection is for pool views,
 * previews, and callers that build a list before dispatch.
 */
function freeSelection(connector, state, poolName, effortTier = null) {
  const strategy = state.strategy ?? {};
  const assignment = effortTier ? strategy.assignments?.[effortTier] ?? null : null;
  const policy = effortTier
    ? resolveDispatchModel(connector, effortTier, {
      assignment,
      excludedModels: [
        ...(strategy.excludedModels ?? []),
        ...disabledModelsForPool(strategy, poolName),
      ],
      allowedModels: selectedModelsForTier(strategy, poolName, effortTier),
    })
    : null;
  const model = policy?.model
    ?? (assignment?.pool === poolName ? assignment.model : null)
    ?? configuredModel(connector);
  return { model, free: isFreeModel(connector, model) };
}

/**
 * Free-ness is a property of (pool, effort tier), not of the pool: the same
 * pool can hold a free model on `medium` and a paid one on `high`. A caller
 * that names no tier still needs to see that — `bullswarm pools` is read
 * before any lane is chosen — so every tier is resolved for the view. Display
 * only: routing reads `pool.free`, the answer for the tier it is routing.
 */
function freeTiersFor(connector, state, poolName) {
  const tiers = {};
  for (const tier of STRATEGY_TIERS) {
    const { model, free } = freeSelection(connector, state, poolName, tier);
    if (free && model) tiers[tier] = model;
  }
  return tiers;
}

/**
 * Build the runtime pool list: connector + state + meter reading.
 * Meter readings are injected by the caller (async — readers poll the
 * network); this function stays sync so tests can build pools without I/O.
 */
export function buildPools(bullswarmDir, now = Date.now(), readings = {}, opts = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir, opts);
  const effortTier = opts?.effortTier ?? null;
  const pools = [];
  for (const [name, conn] of Object.entries(connectors)) {
    const ps = state.pools[name] ?? {};
    const selected = freeSelection(conn, state, name, effortTier);
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
      bench: ps.bench ?? null,
      free: selected.free,
      freeModel: selected.model ?? null,
      freeTiers: freeTiersFor(conn, state, name),
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
      // A provider refusal can be stronger than the last readable meter. The
      // marker is persisted in that snapshot and projected here so every view
      // can say why the pool is blocked and when the next read may clear it.
      quotaRefusal: null,
      quotaRefusedAt: null,
      quotaRefusalResetsAt: null,
      quotaRefusalWindow: null,
      // A failed reader is still useful context when the snapshot is stale;
      // the CLI and Mod surface these without serializing an Error object.
      meterError: null,
      meterHoldUntil: null,
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
    if (!p.enabled) continue;
    const ps = state.pools[p.name] ?? {};
    const paused = isQuarantined(p, now);
    // Quota failures quarantine a pool, so the live poll list deliberately
    // omits it. Still project its persisted refusal marker into `pools` and
    // Budget without contacting the provider; otherwise the page would erase
    // the very 100% wall that caused the quarantine.
    const quotaPaused = paused && (
      ps.quarantine?.kind === 'quota'
      || /quota|usage limit|rate limit/i.test(String(ps.quarantine?.reason ?? ''))
    );
    const reading = readings[p.name]
      ?? (quotaPaused ? cachedQuotaRefusal(p.name, { bullswarmDir, nowMs: now }) : null);
    if (paused && !reading) continue;
    if (reading) {
      p.meterError = typeof reading.meterError === 'string' && reading.meterError
        ? reading.meterError
        : shortMeterError(reading.error);
      p.meterHoldUntil = Number.isFinite(reading.holdUntil) ? reading.holdUntil : null;
      p.quotaRefusal = reading.quotaRefusal ?? reading.snapshot?.quota_refusal ?? null;
      if (p.quotaRefusal && typeof p.quotaRefusal === 'object') {
        p.quotaRefusedAt = p.quotaRefusal.refusedAt ?? p.quotaRefusal.refused_at ?? null;
        p.quotaRefusalResetsAt = p.quotaRefusal.resetsAt ?? p.quotaRefusal.resets_at ?? null;
        p.quotaRefusalWindow = p.quotaRefusal.window ?? null;
      }
    }
    // The 5h gate is independent of the pacing window: a reading may carry a
    // 5h utilization with no weekly/monthly window to pace by, and routing
    // still has to see that the pool is close to its 5h limit.
    if (reading) {
      const fiveHour = fiveHourFromReading(reading);
      p.fiveHourUsedPct = fiveHour.usedPct;
      p.fiveHourResetsAt = fiveHour.resetsAt;
      p.nearFiveHourLimit = fiveHour.nearLimit;
      p.burstGate = reading.burstGate === true;
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
      p.meterSnapshot = reading.snapshot ?? null;
    } else if (reading?.source === 'quota-refusal') {
      // A five-hour-only provider has no pacing score, but its synthetic 100%
      // gate is still authoritative. Keep the refusal source and snapshot so
      // the Budget page and `bullswarm pools` do not fall back to a stale
      // declared percentage or call this pool unmetered.
      p.meterSource = 'quota-refusal';
      p.meterSnapshot = reading.snapshot ?? null;
      p.burstGate = reading.burstGate === true;
      if (p.quotaRefusalWindow === 'weekly' || p.quotaRefusalWindow === 'monthly') {
        const selected = p.quotaRefusalWindow === 'monthly'
          ? reading.snapshot?.monthly
          : reading.snapshot?.seven_day;
        p.usedPct = finiteOrNull(selected?.utilization) ?? 100;
        p.pacingWindow = p.quotaRefusalWindow;
        p.elapsedPct = null;
        p.pace = -100;
        p.paceResetsAt = selected?.resets_at ?? p.quotaRefusalResetsAt;
      }
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

function shortMeterError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) return String(Math.trunc(status));
  if (typeof error?.code === 'string' && error.code.trim()) return error.code.trim();
  const message = error?.message ? String(error.message).trim() : '';
  if (!message) return null;
  return message.length > 80 ? `${message.slice(0, 77)}…` : message;
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
  force = false, getReadings, onProviderProgress, packaged = false, effortTier = null,
} = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir, { packaged });
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
      // A pool's declared subscription (set-subscription) reaches its
      // provider's readUsage as ctx.subscription, e.g. the plan total a
      // used-USD figure is read against; see readerFor.
      subscriptions: state.strategy?.subscriptions ?? {},
      bullswarmDir,
    })
    : {};
  // Forward the loader options: the pool list this returns must come from the
  // same tiers the polling decision above was made against, or a caller that
  // asked for the packaged tiers would poll them and then get none back.
  return buildPools(bullswarmDir, now, readings, { packaged, effortTier });
}
