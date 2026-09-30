// The kernel's first routing pick for one step, without spawning anything
// (`bullswarm run --dry-run`, 0.37.0).
//
// The pick is made the way dispatchV2Action makes a step's first pick in a
// marked run: the same pool preparation (a window at its limit, the step's
// route, the effort tier's models), the same "expiring but draining" rule,
// the same forecast and the same router call with the caller never eligible.
// No probe runs and nothing is written: no ledger entry, no decision log.

import { join } from 'node:path';

import { argvWithModel } from '../lib/worker-argv.js';
import { expiringSoonView, pickPool } from '../lib/route.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { expectedMinutesFromSpendModel } from '../lib/assignments.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';
import { freeModelsOffV2DispatchPools, prepareV2DispatchPools, selectedV2DispatchModel } from './v2-dispatch.js';
import { resolveRouteFilter, routeUnavailableWhy } from './step-route.js';
import { poolCanRunModel } from '../lib/model-pin.js';
import { drainingPart, heldEntry, noPoolFailureKind, noPoolWhy, spentWindowPart } from './no-pool-why.js';

/**
 * Why no pool was picked, as dispatchV2Action says it for a marked step that
 * cannot start (no-pool-why.js): a capable pool at a spent window or nearly
 * spent first, then the route, then a missing tier model.
 */
function noPickWhy({ pools, action, lane, effort, now, routeFilter, draining, routerWhy }) {
  const preferredModel = action.model ?? null;
  if (preferredModel && !pools.some((pool) => pool.enabled !== false && poolCanRunModel(pool, preferredModel).ok)) {
    const reasons = pools.filter((pool) => pool.enabled !== false).map((pool) => poolCanRunModel(pool, preferredModel).reason);
    return { why: `no pool can run ${preferredModel}: ${reasons.join('; ') || 'no pool is enabled'}`, failureKind: 'unavailable' };
  }
  const capable = prepareV2DispatchPools(pools, action, effort, { now, routeFilter, preferredModel, ignoreBurstGate: true })
    .filter((pool) => (pool.lanes ?? [lane]).includes(lane));
  const held = [];
  for (const pool of capable) {
    const parts = [spentWindowPart(pool, now), draining.has(pool.name) ? drainingPart(draining.get(pool.name)) : null].filter(Boolean);
    if (parts.length) held.push(heldEntry(pool.name, parts));
  }
  const failureKind = noPoolFailureKind(capable.length, held);
  if (held.length) return { why: noPoolWhy({ capableCount: capable.length, held, failureKind, lane, effort }), failureKind };
  if (!capable.length && routeFilter
    && prepareV2DispatchPools(pools, action, effort, { now, preferredModel, ignoreBurstGate: true }).length) {
    return { why: routeUnavailableWhy(routeFilter, { lane, effort }), failureKind };
  }
  if (capable.length) return { why: routerWhy, failureKind };
  const freeOff = freeModelsOffV2DispatchPools(pools, action, effort, { preferredModel, routeFilter, now })
    .filter((pool) => (pool.lanes ?? [lane]).includes(lane)).map((pool) => pool.name);
  return { why: noPoolWhy({ capableCount: 0, held, failureKind, lane, effort, freeOff }), failureKind };
}

/**
 * `action` is a normalised v3 step (program-v3.js). `coreState` is the loaded
 * state.json (decision log, strategy, config); `runReasoning` the run-wide level. Returns the preview document:
 * `{ ok, why, routeWhy, routeCandidates, candidates, forecast, pick, reasoning }`,
 * with no `pick` and a `failureKind` (quota or unavailable) when no pool can
 * take the step now.
 */
export async function previewStepPick({ action, pools, bullswarmDir, coreState, targetDir, runReasoning = null, now = Date.now() }) {
  const lane = action.lane ?? 'chore';
  const effort = action.effort ?? DEFAULT_EFFORT_BY_LANE[lane] ?? 'medium';
  const routeFilter = action.route ? resolveRouteFilter({ attempts: [] }, action, pools) : null;
  const decisionLog = coreState?.decisionLog ?? [];
  const inflightPenaltyPct = inflightPenaltyFrom(coreState);
  const expected = await expectedMinutesFromSpendModel(
    { lane, effort },
    { decisionLog: decisionLog.filter((entry) => entry?.failureKind !== 'stalled') },
  );
  const prepared = prepareV2DispatchPools(pools, action, effort, { now, routeFilter, preferredModel: action.model ?? null });
  // The kernel keeps a draining pool off a marked step unless the caller named it.
  const named = routeFilter?.usePools?.length === 1 ? routeFilter.usePools[0] : null;
  const viewed = attachForecast(prepared.map((pool) => ({ ...pool })), bullswarmDir, { now, decisionLog });
  // As the kernel's drainingAt: pool name -> { until, forecast }.
  const draining = new Map();
  for (const pool of viewed) {
    if (pool.name === named) continue;
    const view = expiringSoonView(pool, { now, candidateMinutes: expected.expectedMinutes, inflightPenaltyPct });
    if (view.state !== 'draining') continue;
    const until = Date.parse(pool.paceResetsAt ?? '');
    draining.set(pool.name, { until: Number.isFinite(until) ? until : null, forecast: view.forecast });
  }
  const routingPools = prepared.filter((pool) => !draining.has(pool.name));
  attachForecast(routingPools, bullswarmDir, { now, decisionLog });
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])?.strategyAssignments?.[effort] ?? null;
  const route = pickPool(lane, routingPools, {
    preferredPool: configuredAssignment?.pool ?? null,
    effortTier: effort,
    now,
    candidateMinutes: expected.expectedMinutes,
    inflightPenaltyPct,
    routeNote: routeFilter?.summary || null,
  });
  if (!route.pick) {
    const { why, failureKind } = noPickWhy({ pools, action, lane, effort, now, routeFilter, draining, routerWhy: route.why });
    return { ok: false, dryRun: true, why, failureKind, routeWhy: route.why, routeCandidates: route.candidates, candidates: route.candidates };
  }
  const pool = route.pick.connector;
  const connector = pool.connector ?? pool;
  const model = selectedV2DispatchModel(pool, effort, action.model ?? null);
  const reasoning = resolveReasoningLevel({
    connector,
    tier: effort,
    model,
    strategy: coreState?.strategy ?? null,
    runOverride: runReasoning,
    actionOverride: isReasoningLevel(action.reasoning) ? action.reasoning : null,
  });
  return {
    ok: true,
    dryRun: true,
    why: route.why,
    routeWhy: route.why,
    routeCandidates: route.candidates,
    forecast: forecastRecord(route, connector.name),
    candidates: route.candidates,
    pick: {
      pool: connector.name,
      // As the attempt record names it (dispatchV2Action).
      model: model ?? connector.model ?? null,
      // The run's id is chosen when it starts; the file name is the first attempt's.
      command: argvWithModel(connector, {
        taskFile: join(bullswarmDir, 'workflows', '<run>', `task-${action.id}-attempt-1.md`), cwd: targetDir,
      }, model, null, reasoning),
    },
    reasoning,
  };
}
