// The pools a workflow verb checks a program against before anything runs:
// the configured list (no meter refresh) or a live one, a pinned pool that
// cannot run a step's tier, and the route checks of steps that name a route.

import { buildPools, buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { prepareV2DispatchPools } from './v2-dispatch.js';
import { routeIssuesForPools } from './step-route.js';
import { maybeRefreshStrategy } from '../strategy-cli.js';
import { loadPoolLabels } from '../lib/pool-labels.js';
import { BULLSWARM_DIR } from './cli-run-lookup.js';

// A pinned pool with no model on a step's tier fails that step within a second
// as "no eligible pool". Say so before anything launches. A spent meter window
// is not counted here: it resets, and the pick at dispatch reads it live.
export function pinnedPoolIssues(doc, program, pools) {
  const routing = doc.config?.workerRouting ?? {};
  const strictPool = routing.strictPool ?? routing.pool ?? null;
  if (!strictPool || !Array.isArray(pools) || !pools.length) return [];
  const issues = [];
  program.actions.forEach((action, index) => {
    const effort = action.effort ?? 'medium';
    const capable = prepareV2DispatchPools(pools, action, effort, {
      preferredModel: routing.model ?? routing.preferredModel ?? null, strictPool,
    });
    if (!capable.length) {
      issues.push(`program.actions[${index}] (${action.id}) is ${action.lane}/${effort} work, which the pinned pool ${strictPool} cannot run (disabled, or no model on the ${effort} tier); change the step's effort or pin another pool`);
    }
  });
  return issues;
}

// Stage 3 §2.4: the route checks that need the configured pool list (unknown
// pool or provider names, a label instead of an id, nothing capable left, the
// run pin outside the route). Only programs that route a step pay for them.
export function programRoutes(actions) {
  return (actions ?? []).some((action) => action?.route && typeof action.route === 'object');
}

// `state` (a running run) lets the pin check see which steps already did work;
// `recordedWork` (workflow add) lets every independentOf check see it.
export function routePoolIssues(actions, pools, doc, labels = loadPoolLabels(BULLSWARM_DIR()), state = null, { recordedWork = false } = {}) {
  if (!programRoutes(actions) || !Array.isArray(pools)) return [];
  const routing = doc?.config?.workerRouting ?? {};
  const preferredModel = routing.model ?? routing.preferredModel ?? null;
  return routeIssuesForPools({ actions }, pools, {
    runPin: routing.strictPool ?? routing.pool ?? null,
    preparePools: (list, action, effort, options) => prepareV2DispatchPools(list, action, effort ?? 'medium', { preferredModel, ...options }),
    labels,
    state,
    recordedWork,
  });
}

// The configured pools without a live meter refresh: enough for the route
// checks, which ignore the metered-window gates.
export function configuredPools() {
  try { return buildPools(BULLSWARM_DIR(), Date.now()).pools; } catch { return null; }
}

// The pools with live meters (strategy refreshed first); when the meters
// cannot be read, the configured pools and the read error as meterWarning.
export async function livePoolNames() {
  try {
    await maybeRefreshStrategy(BULLSWARM_DIR());
    const { pools } = await buildPoolsLive(BULLSWARM_DIR(), Date.now(), {
      getReadings: getAllMeterReadings,
    });
    return { names: pools.map((p) => p.name), pools };
  } catch (err) {
    const { pools } = buildPools(BULLSWARM_DIR(), Date.now());
    return { names: pools.map((p) => p.name), pools, meterWarning: err.message };
  }
}
