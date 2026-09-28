// The kernel's first routing pick for one step, without spawning anything
// (`bullswarm run --dry-run`, 0.37.0).
//
// The pick is made the way dispatchV2Action makes a step's first pick in a
// marked run: the same pool preparation (a window at its limit, the step's
// route, the effort tier's models), the same "expiring but draining" rule,
// the same forecast and the same router call with the caller never eligible.
// No probe runs and nothing is written: no ledger entry, no decision log.

import { join } from 'node:path';

import { argvWithModel } from '../lib/watch.js';
import { expiringSoonView, pickPool } from '../lib/route.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { expectedMinutesFromSpendModel } from '../lib/assignments.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';
import { prepareV2DispatchPools, selectedV2DispatchModel } from './v2-dispatch.js';
import { resolveRouteFilter, routeUnavailableWhy } from './step-route.js';

/**
 * `action` is a normalised v3 step (program-v3.js). `coreState` is the loaded
 * state.json (decision log, strategy, config); `runReasoning` the run-wide level. Returns the preview document:
 * `{ ok, why, routeWhy, routeCandidates, candidates, forecast, pick, reasoning }`,
 * with no `pick` when no pool can take the step now.
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
  const prepared = prepareV2DispatchPools(pools, action, effort, { now, routeFilter });
  // The kernel keeps a draining pool off a marked step unless the caller named it.
  const named = routeFilter?.usePools?.length === 1 ? routeFilter.usePools[0] : null;
  const viewed = attachForecast(prepared.map((pool) => ({ ...pool })), bullswarmDir, { now, decisionLog });
  const draining = new Set(viewed
    .filter((pool) => pool.name !== named
      && expiringSoonView(pool, { now, candidateMinutes: expected.expectedMinutes, inflightPenaltyPct }).state === 'draining')
    .map((pool) => pool.name));
  const routingPools = prepared.filter((pool) => !draining.has(pool.name));
  attachForecast(routingPools, bullswarmDir, { now, decisionLog });
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])?.strategyAssignments?.[effort] ?? null;
  const route = pickPool(lane, routingPools, {
    callerEligible: false,
    callerSession: false,
    preferredPool: configuredAssignment?.pool ?? null,
    effortTier: effort,
    now,
    candidateMinutes: expected.expectedMinutes,
    inflightPenaltyPct,
    routeNote: routeFilter?.summary || null,
  });
  if (!route.pick) {
    let why = route.why;
    if (!prepared.length) {
      const unrouted = routeFilter ? prepareV2DispatchPools(pools, action, effort, { now }) : [];
      why = unrouted.length
        ? routeUnavailableWhy(routeFilter, { lane, effort })
        : `no eligible pool: no enabled pool has a model on the ${effort} tier for ${lane} work`;
    }
    return { ok: false, dryRun: true, why, routeWhy: route.why, routeCandidates: route.candidates, candidates: route.candidates };
  }
  const pool = route.pick.connector;
  const connector = pool.connector ?? pool;
  const model = selectedV2DispatchModel(pool, effort, null);
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
