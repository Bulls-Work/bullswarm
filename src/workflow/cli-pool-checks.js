// The pools a workflow verb checks a program against before anything runs:
// the configured list (no meter refresh) or a live one, a pinned pool that
// cannot run a step's tier, and the route checks of steps that name a route.

import { buildPools, buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { prepareV2DispatchPools } from './v2-dispatch.js';
import { buildCheckRefusal } from './dispatch-pools.js';
import { resolveRouteFilter, routeIssuesForPools } from './step-route.js';
import { maybeRefreshStrategy } from '../strategy-cli.js';
import { loadPoolLabels } from '../lib/pool-labels.js';
import { BULLSWARM_DIR } from './cli-run-lookup.js';
import { poolCanRunModel } from '../lib/model-pin.js';
import { offLaneReason, servesLane } from '../lib/pool-lanes.js';
import { holdPins, operatorLimit, poolIsPinned } from '../lib/pool-limits.js';

// A pinned pool with no model on a step's tier fails that step within a second
// as "no eligible pool". Say so before anything launches. A spent meter window
// is not counted here: it resets, and the pick at dispatch reads it live.
// `now` is the clock a hold is judged against (tests pass a fixed one).
export function pinnedPoolIssues(doc, program, pools, { now = Date.now() } = {}) {
  const routing = doc.config?.workerRouting ?? {};
  const strictPool = routing.strictPool ?? routing.pool ?? null;
  if (!strictPool || !Array.isArray(pools) || !pools.length) return [];
  const issues = [];
  const pinned = pools.find((pool) => pool.name === strictPool && pool.enabled !== false) ?? null;
  program.actions.forEach((action, index) => {
    const effort = action.effort ?? 'medium';
    // The pinned pool does not serve this step's lane (strategy set-lanes or
    // its connector): the step would fail at its pick, so say why now.
    if (pinned && action.lane && !servesLane(pinned, action.lane)) {
      issues.push(`program.actions[${index}] (${action.id}) is ${action.lane}/${effort} work, which the pinned pool ${strictPool} does not serve: ${offLaneReason(pinned)}; pin another pool or change the step's lane`);
      return;
    }
    const capable = prepareV2DispatchPools(pools, action, effort, {
      preferredModel: action?.model ?? routing.model ?? routing.preferredModel ?? null, strictPool,
    });
    if (!capable.length && pinned && buildCheckRefusal(pinned, action)
      && prepareV2DispatchPools(pools, { ...action, evidence: [...(action.evidence ?? []), { type: 'command' }] }, effort, {
        preferredModel: action?.model ?? routing.model ?? routing.preferredModel ?? null, strictPool,
      }).length) {
      issues.push(`program.actions[${index}] (${action.id}) is ${action.lane}/${effort} work with no check, and ${buildCheckRefusal(pinned, action)}; add command or schema evidence to the step, or pin another pool`);
    } else if (!capable.length) {
      issues.push(`program.actions[${index}] (${action.id}) is ${action.lane}/${effort} work, which the pinned pool ${strictPool} cannot run (disabled, or no model on the ${effort} tier); change the step's effort or pin another pool`);
    }
  });
  const pinnedPool = pools.find((pool) => pool?.name === strictPool);
  const held = pinnedPool ? blockingHold(pinnedPool, holdPins({ strictPool }), now) : null;
  if (held) issues.push(`the pinned pool ${heldText(strictPool, held)}`);
  return issues;
}

// A hold that keeps even a pinned pick out (pool-limits.js): a plain hold, as
// opposed to one set with --allow-pinned. Null when the pins may use the pool.
function blockingHold(pool, pins, now = Date.now()) {
  const limit = operatorLimit(pool, now, { pinned: poolIsPinned(pool, pins) });
  return limit?.kind === 'hold' ? limit : null;
}

function heldText(name, hold) {
  return `${name} is held until ${hold.until} (${hold.reason}), and a plain hold keeps pinned runs out too; `
    + `wait for it to end, run bullswarm strategy unhold ${name} --yes, or hold it again with --allow-pinned`;
}

// A step whose route names the pools or providers it may use (a pin), where
// every capable pool so named is under a plain hold: it could not start.
// An allow-pinned hold lets the route through; an avoid-only route is not a
// pin and is left to routing.
function heldRouteIssues(actions, pools, preparePools, now = Date.now()) {
  const issues = [];
  for (const action of actions ?? []) {
    const route = action?.route;
    if (!route || typeof route !== 'object' || !(route.pools?.use?.length || route.providers?.use?.length)) continue;
    const routeFilter = resolveRouteFilter({ attempts: [] }, action, pools);
    const capable = preparePools(pools, action, action.effort ?? 'medium', { routeFilter, ignoreBurstGate: true })
      .filter((pool) => (pool.lanes ?? [action.lane]).includes(action.lane ?? 'chore'));
    if (!capable.length) continue;
    const pins = holdPins({ routeFilter });
    const held = capable.map((pool) => [pool.name, blockingHold(pool, pins, now)]);
    if (held.every(([, hold]) => hold)) {
      issues.push(`step ${action.id}: every pool its route names is held: ${held.map(([name, hold]) => heldText(name, hold)).join('; ')}`);
    }
  }
  return issues;
}

// A step's model (or the run's --worker-model) that no enabled pool can run
// would fail at its pick. Say so before anything launches, with each pool's
// reason. Meters are not read: a spent window resets.
export function programNamesModel(actions, doc = null) {
  const routing = doc?.config?.workerRouting ?? {};
  return Boolean(routing.model ?? routing.preferredModel)
    || (actions ?? []).some((action) => typeof action?.model === 'string');
}

export function modelPoolIssues(actions, pools, doc = null) {
  if (!Array.isArray(pools)) return [];
  const routing = doc?.config?.workerRouting ?? {};
  const runModel = routing.model ?? routing.preferredModel ?? null;
  const enabled = pools.filter((pool) => pool.enabled !== false);
  const issues = [];
  (actions ?? []).forEach((action, index) => {
    const model = action?.model ?? runModel;
    if (typeof model !== 'string' || !model) return;
    const checks = enabled.map((pool) => ({ pool: pool.name, ...poolCanRunModel(pool, model) }));
    if (checks.some((check) => check.ok)) return;
    const why = checks.map((check) => check.reason).join('; ') || 'no pool is enabled';
    issues.push(`steps[${index}] (${action.id}) asks for model ${model}, which no enabled pool can run: ${why}`);
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
export function routePoolIssues(actions, pools, doc, labels = loadPoolLabels(BULLSWARM_DIR()), state = null, { recordedWork = false, now = Date.now() } = {}) {
  if (!programRoutes(actions) || !Array.isArray(pools)) return [];
  const routing = doc?.config?.workerRouting ?? {};
  const runModel = routing.model ?? routing.preferredModel ?? null;
  // Only pools that serve the step's lane can run it (strategy set-lanes or the connector).
  const preparePools = (list, action, effort, options) => prepareV2DispatchPools(list, action, effort ?? 'medium', {
    preferredModel: action?.model ?? runModel,
    ...options,
  })
    .filter((pool) => !action?.lane || servesLane(pool, action.lane));
  const issues = routeIssuesForPools({ actions }, pools, {
    runPin: routing.strictPool ?? routing.pool ?? null,
    preparePools,
    labels,
    state,
    recordedWork,
  });
  return issues.length ? issues : heldRouteIssues(actions, pools, preparePools, now);
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
