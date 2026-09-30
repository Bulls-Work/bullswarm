// The pools that can take a step now, each with the model it would run:
// the enabled pools outside a spent window that pass the step's route, the
// caller's exact model and the pool's plan exclusions, with the tier's model
// resolved per pool (preparePools, selectedModel).
import { modelBaseId, poolCanRunModel } from '../lib/model-pin.js';
import { isFree } from '../lib/route.js';
import { windowSpent } from '../meters/framework.js';
import { disabledModelsForPool, resolveDispatchModel, selectedModelsForTier } from '../lib/strategy.js';
import { poolPassesRoute } from './step-route.js';

// The models this pool's plan was seen not to include (config.js attaches
// strategy.js planExclusionsForPool): passed over like a model turned off for
// this pool only. The pool itself stays pickable (doctrine 4).
export function planExcludedIds(pool) {
  return (Array.isArray(pool?.strategyPlanExcludedModels) ? pool.strategyPlanExcludedModels : [])
    .map((entry) => String(entry?.model ?? '').trim().toLowerCase())
    .filter(Boolean);
}

// A context-window selector (`[1m]`) runs the same model, so the plan's
// refusal of the base id covers it (model-pin.js modelBaseId).
export function planExcludes(pool, model) {
  const wanted = String(model ?? '').trim().toLowerCase();
  return planExcludedIds(pool).some((id) => id === wanted || modelBaseId(id) === modelBaseId(wanted));
}

function providerIdFromModel(model) {
  if (typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function preparePools(pools, action, effort, {
  preferredModel = null, strictPool = null, now = Date.now(),
  // Which pools COULD run this action were none at its limit: a pool with a
  // window at its limit (framework.js windowSpent) is still capable (it comes
  // back at its reset). Used to say when work can be retried, and to refuse
  // a pin or a route that can never run it.
  ignoreBurstGate = false,
  // The step's route (step-route.js resolveRouteFilter): a hard filter on
  // every list this builds, before any ranking (D18).
  routeFilter = null,
} = {}) {
  const available = [];
  for (const pool of pools) {
    if (pool.enabled === false || (!ignoreBurstGate && windowSpent(pool, now))) continue;
    if (routeFilter && !poolPassesRoute(pool, routeFilter)) continue;
    const connector = pool.connector ?? pool;
    // A discovered provider clone represents one concrete credential and its
    // meter. Retargeting it to another provider-qualified model would make the
    // pool label and quota attribution untrue. An exact
    // model pin may therefore use only the clone for that provider ID.
    const pinnedProvider = providerIdFromModel(preferredModel);
    if (pinnedProvider && connector.profile?.providerId
      && connector.profile.providerId !== pinnedProvider) continue;
    // An exact model the caller asked for (a step's model, the run's pin)
    // replaces the tier's model: a pool runs it only when it can say it
    // runs that model (model-pin.js), whatever its tier selection holds.
    if (preferredModel && !poolCanRunModel(pool, preferredModel).ok) continue;
    if (preferredModel && planExcludes(pool, preferredModel)) continue;
    const assignment = pool.strategyAssignments?.[effort] ?? null;
    const modelPolicy = preferredModel ? { eligible: true, model: preferredModel, source: 'caller-model' } : resolveDispatchModel(connector, effort, {
      assignment,
      excludedModels: [
        ...(pool.strategyExcludedModels ?? []),
        ...disabledModelsForPool({ disabledModels: pool.strategyDisabledModels }, pool.name),
        ...planExcludedIds(pool),
      ],
      allowedModels: selectedModelsForTier({
        modelTiers: pool.strategyModelTiers,
        configuredTiers: pool.strategyConfiguredTiers,
      }, pool.name, effort),
      excludeFree: pool.strategyFreeModels === 'never',
    });
    if (!modelPolicy.eligible) continue;
    // Free-ness is a property of the model selected for THIS effort tier, not
    // of the connector's launch-time default. The pool list may have been
    // built without an effortTier (workflow refreshes do that), so re-evaluate
    // against the resolved policy before the stall clock and router see it.
    const selectedModelForTier = modelPolicy.model ?? pool.freeModel ?? connector.model ?? null;
    const free = selectedModelForTier == null
      ? pool.free === true
      : isFree({
        ...pool,
        free: undefined,
        freeModel: selectedModelForTier,
        modelPolicy,
      });
    available.push({ ...pool, modelPolicy, free, freeModel: selectedModelForTier });
  }
  // A strict pin defines the complete dispatch universe.
  return strictPool
    ? available.filter((pool) => pool.name === strictPool)
    : available;
}

export function selectedModel(pool, effort, preferredModel = null) {
  if (preferredModel && !(pool.strategyExcludedModels ?? []).includes(preferredModel)) return preferredModel;
  const assignment = pool.strategyAssignments?.[effort] ?? null;
  return pool.modelPolicy?.model
    ?? (assignment?.pool === pool.name ? assignment.model : null)
    ?? null;
}
