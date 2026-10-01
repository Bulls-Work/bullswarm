// What ruled each pool out of a step no pool took, and which pools lack
// the step's tier only because free models are off or the plan excludes
// the tier's model.
import { poolCanRunModel } from '../lib/model-pin.js';
import { LANES, modelFamilyOf } from '../lib/route.js';
import { windowSpent } from '../meters/framework.js';
import { poolPassesRoute } from './step-route.js';
import { meterSignInDead, meterSignInText, planExcludedIds, planExcludes, preparePools } from './dispatch-pools.js';

const STRATEGY_TIER_ORDER = ['low', 'medium', 'high'];

/**
 * The enabled pools that cannot take `effort` work only because free models
 * are off for them (`strategy set-free never`): each is prepared again with
 * free models allowed, and the ones that then qualify are returned.
 */
function freeModelsOffPools(allPools, action, effort, { preferredModel = null, strictPool = null, routeFilter = null, now } = {}) {
  const opts = { preferredModel, strictPool, routeFilter, now, ignoreBurstGate: true };
  return allPools.filter((pool) => pool.enabled !== false && pool.strategyFreeModels === 'never'
    && !preparePools([pool], action, effort, opts).length
    && preparePools([{ ...pool, strategyFreeModels: 'allow' }], action, effort, opts).length);
}

/**
 * The enabled pools that cannot take `effort` work only because their plan
 * was seen not to include the tier's model (planExcludedModels): each is
 * prepared again without those plan facts, and the ones that then qualify
 * are returned.
 */
function planExcludedOffPools(allPools, action, effort, { preferredModel = null, strictPool = null, routeFilter = null, now } = {}) {
  const opts = { preferredModel, strictPool, routeFilter, now, ignoreBurstGate: true };
  return allPools.filter((pool) => pool.enabled !== false && planExcludedIds(pool).length
    && !preparePools([pool], action, effort, opts).length
    && preparePools([{ ...pool, strategyPlanExcludedModels: [] }], action, effort, opts).length);
}

// A caller's exact model the plan excludes is named as that model, never as
// a missing tier.
function planOffText(pool, effort, preferredModel = null) {
  if (preferredModel && planExcludes(pool, preferredModel)) return `${preferredModel} is not in ${pool.name}'s plan`;
  return `${pool.name} has no ${effort}-tier model its plan includes (plan excludes ${planExcludedIds(pool).join(', ')})`;
}

/**
 * Why each enabled pool (passing `keep`) that would have the tier lacks it
 * now, one text per pool: free models off for it, or its plan without the
 * tier's model.
 */
export function tierOffReasons(allPools, action, effort, opts, keep = () => true) {
  const free = new Set(freeModelsOffPools(allPools, action, effort, opts).filter(keep).map((pool) => pool.name));
  const plan = new Set(planExcludedOffPools(allPools, action, effort, opts).filter(keep).map((pool) => pool.name));
  return allPools.flatMap((pool) => {
    if (free.has(pool.name)) return [`free models are off for ${pool.name}`];
    if (plan.has(pool.name)) return [planOffText(pool, effort, opts.preferredModel)];
    return [];
  });
}

/**
 * What ruled each enabled pool out of a step no pool took:
 * [{pool, provider, excluded, tiers, inRoute, onLane}], in pool order. The
 * first reason that applies is named: the pin, the lane, a failed probe, the
 * route's use/avoid lists, a provider the route is independent of, a spent
 * window, the tier (with the tiers the pool has on this lane), then a hold
 * (a usage limit, a draining window). `tiers`, `inRoute` and `onLane` let the
 * route refusal name the other providers' pools.
 */
export function noPoolCandidates(allPools, action, effort, {
  lane, strictPool, preferredModel, routeFilter, failedProbes, onLane, held, now, ignoreBurstGate,
}) {
  const heldText = new Map(held.map((entry) => [entry.pool, entry.text]));
  const withoutIndependence = routeFilter ? { ...routeFilter, independentProviders: [] } : null;
  return allPools.filter((pool) => pool.enabled !== false).map((pool) => {
    const provider = modelFamilyOf(pool);
    const tiers = STRATEGY_TIER_ORDER.filter((tier) => preparePools([pool], action, tier, { preferredModel, now, ignoreBurstGate: true }).length);
    const inRoute = !withoutIndependence || poolPassesRoute(pool, withoutIndependence);
    const lanes = onLane(pool) && (pool.lanes ?? LANES).includes(lane);
    const sharedWith = Object.entries(routeFilter?.independentOf ?? {}).filter(([, providers]) => providers.includes(provider)).map(([step]) => step);
    let excluded;
    if (strictPool && pool.name !== strictPool) excluded = `not the pinned pool ${strictPool}`;
    else if (!lanes) excluded = `not on the ${lane} lane`;
    else if (failedProbes.has(pool.name)) excluded = 'failed its probe';
    else if (!inRoute) excluded = `outside the route (${routeFilter.summary})`;
    else if (sharedWith.length) excluded = `shares provider ${provider} with ${sharedWith.join(', ')}`;
    else if (meterSignInDead(pool)) excluded = meterSignInText(pool);
    else if (!ignoreBurstGate && windowSpent(pool, now)) excluded = 'a usage window is at its limit';
    else if (preferredModel && !poolCanRunModel(pool, preferredModel).ok) excluded = poolCanRunModel(pool, preferredModel).reason;
    else if (preferredModel && planExcludes(pool, preferredModel)) excluded = `${preferredModel} is not in ${pool.name}'s plan`;
    else if (!tiers.includes(effort) && freeModelsOffPools([pool], action, effort, { preferredModel, now }).length) excluded = `free models are off for ${pool.name}`;
    else if (!tiers.includes(effort) && planExcludedOffPools([pool], action, effort, { preferredModel, now }).length) excluded = planOffText(pool, effort, preferredModel);
    else if (!tiers.includes(effort)) excluded = `no model on the ${effort} tier for ${lane} work (has ${tiers.length ? tiers.join(', ') : 'none'})`;
    else excluded = heldText.get(pool.name) ?? 'capable, but no pick was made';
    return { pool: pool.name, provider, excluded, tiers, inRoute, onLane: lanes };
  });
}
