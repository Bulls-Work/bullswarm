// An exact model a caller asks for: `model` on a program step, `--model` on
// `bullswarm run`, `--worker-model` on a workflow.
//
// A pool may run the model only when it can say so: its last model discovery
// (`strategy refresh`) lists the model, or, with no discovery yet, its
// connector names it (`model`, `knownModels`), or it is provider-qualified
// with the pool's own provider id (`a/gpt-5.6-luna` on a pool of provider
// `a`). A model the operator turned
// off, for every pool or for this one, is never run. Nothing substitutes
// another model: with no pool able to run it, the step goes to the caller
// with each pool's reason.

// No import from strategy.js: the program validators load this module, and
// strategy.js loads theirs.

export const MODEL_ID_MAX = 200;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$/;

/** True for a string that can name a model on a worker CLI's command line. */
export function isModelId(value) {
  return typeof value === 'string' && value.length <= MODEL_ID_MAX && MODEL_ID_RE.test(value);
}

// Trailing `[...]` selectors (a context-window variant such as `[1m]`) choose
// how a model runs, not which model it is.
const base = (id) => String(id ?? '').trim().replace(/(?:\[[^\]]*\])+$/, '').toLowerCase();

/** The model ids this pool is known to run, and where the list came from. */
function knownModels(pool) {
  if (Array.isArray(pool?.discoveredModels) && pool.discoveredModels.length) {
    return { ids: pool.discoveredModels, source: 'discovery' };
  }
  const connector = pool?.connector ?? pool ?? {};
  const ids = [connector.model, ...(Array.isArray(connector.knownModels) ? connector.knownModels : [])]
    .filter((id) => typeof id === 'string' && id);
  return { ids, source: 'connector' };
}

/**
 * Whether `pool` can run exactly `model`, with the reason when it cannot.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function poolCanRunModel(pool, model) {
  const wanted = String(model ?? '').trim().toLowerCase();
  const excluded = (pool?.strategyExcludedModels ?? []).map((id) => String(id).toLowerCase());
  if (excluded.includes(wanted) || excluded.includes(base(wanted))) {
    return { ok: false, reason: `${model} is turned off (strategy exclude-model)` };
  }
  const perPool = pool?.strategyDisabledModels?.[pool?.name];
  const disabled = (Array.isArray(perPool) ? perPool : []).map((id) => String(id).trim().toLowerCase());
  if (disabled.includes(wanted) || disabled.includes(base(wanted))) {
    return { ok: false, reason: `${model} is turned off for ${pool.name}` };
  }
  // The provider said this pool's plan does not include the model
  // (model-not-in-plan); the pool still runs its other models.
  const notInPlan = (Array.isArray(pool?.strategyPlanExcludedModels) ? pool.strategyPlanExcludedModels : [])
    .map((entry) => String(entry?.model ?? '').trim().toLowerCase());
  if (notInPlan.includes(wanted) || notInPlan.includes(base(wanted))) {
    return { ok: false, reason: `${pool.name} plan does not include ${model}` };
  }
  // A provider-qualified id (`<providerId>/<model>`) under this pool's own
  // provider id is that credential's namespace: the pool runs it.
  const providerId = (pool?.connector ?? pool)?.profile?.providerId;
  if (providerId && wanted.startsWith(`${String(providerId).toLowerCase()}/`)) return { ok: true };
  const { ids, source } = knownModels(pool);
  if (!ids.length) return { ok: false, reason: `no model list for ${pool?.name} (run bullswarm strategy refresh)` };
  const matches = ids.some((id) => String(id).toLowerCase() === wanted || base(id) === base(wanted));
  if (matches) return { ok: true };
  return {
    ok: false,
    reason: source === 'discovery'
      ? `${pool.name} does not list ${model}`
      : `${pool.name} does not name ${model} (run bullswarm strategy refresh to discover its models)`,
  };
}
