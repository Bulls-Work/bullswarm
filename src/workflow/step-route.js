// A step's `route` (stage 3, D16-D19): where it may run. Pure: the
// validator normalises it, the runtime resolves it into a pool filter the
// dispatcher applies before pace ranking, and the kernel's loop steps inherit
// it. Lane and capability (effort, reasoning) stay the step's own fields.

import { modelFamilyOf } from '../lib/route.js';

const ROUTE_KEYS = Object.freeze(['pools', 'providers', 'independentOf']);
const LIST_KEYS = Object.freeze(['use', 'avoid']);
const CAPABILITY_KEYS = new Set(['model', 'reasoning', 'effort']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 80;
export const ROUTE_WRITERS = 'writers';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = (value) => typeof value === 'string' && value.length > 0 && value.length <= NAME_MAX && !/\s/.test(value);
const sortedUnique = (values) => [...new Set(values)].sort();

function normalizeList(raw, at, noun, issues) {
  if (!Array.isArray(raw) || !raw.every(isName)) {
    issues.push(`${at} must be an array of ${noun}`);
    return [];
  }
  return sortedUnique(raw);
}

function normalizeUseAvoid(raw, at, noun, issues) {
  if (!isObject(raw)) {
    issues.push(`${at} must be an object with use and/or avoid`);
    return undefined;
  }
  const key = at.slice(at.lastIndexOf('.') + 1);
  for (const field of Object.keys(raw)) {
    if (!LIST_KEYS.includes(field)) issues.push(`${at}.${field} is not allowed; ${key} takes use and avoid`);
  }
  const result = {};
  for (const field of LIST_KEYS) {
    if (raw[field] === undefined) continue;
    const list = normalizeList(raw[field], `${at}.${field}`, noun, issues);
    if (list.length) result[field] = list;
  }
  for (const name of result.use ?? []) {
    if ((result.avoid ?? []).includes(name)) issues.push(`${at} names "${name}" in both use and avoid`);
  }
  return Object.keys(result).length ? result : undefined;
}

// Every step that runs before `id`, over dependsOn (direct and transitive).
function ancestorsOf(id, graph) {
  const seen = new Set();
  const stack = [...(graph.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

function dependencyGraph(program, knownActions) {
  const graph = new Map();
  for (const action of [...(knownActions ?? []), ...(Array.isArray(program?.actions) ? program.actions : [])]) {
    if (!isObject(action) || typeof action.id !== 'string') continue;
    const deps = Array.isArray(action.dependsOn) ? action.dependsOn.filter((dep) => typeof dep === 'string') : [];
    graph.set(action.id, [...(graph.get(action.id) ?? []), ...deps]);
  }
  return graph;
}

/**
 * The §2.4 shape and messages. Returns the normalised route (fixed key
 * order, sorted unique lists, empties dropped), or undefined when it is empty
 * or refused; the reasons go to `issues`. `program` is the raw program being
 * validated (ids and ancestors are read from it and from `knownActions`),
 * `actionIndex` the step's position in it.
 */
export function normalizeRoute(raw, at, issues, {
  program = null, actionIndex = -1, evidenceFor = [], relaxedGraph = false, knownActions = [],
} = {}) {
  if (raw === undefined) return undefined;
  if (relaxedGraph !== true) {
    issues.push(`${at}.route needs a program-mode run`);
    return undefined;
  }
  if (!isObject(raw)) {
    issues.push(`${at}.route must be an object with pools, providers or independentOf`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (ROUTE_KEYS.includes(key)) continue;
    if (key === 'lane') issues.push(`${at}.route.lane is not a route key; set the lane with the step's own "lane" field`);
    else if (CAPABILITY_KEYS.has(key)) issues.push(`${at}.route.${key} is not allowed; a step's capability is its effort (and reasoning), not its route`);
    else issues.push(`${at}.route.${key} is not allowed; route takes pools, providers and independentOf`);
  }
  const route = {};
  if (raw.pools !== undefined) {
    const pools = normalizeUseAvoid(raw.pools, `${at}.route.pools`, 'pool ids', issues);
    if (pools) route.pools = pools;
  }
  if (raw.providers !== undefined) {
    const providers = normalizeUseAvoid(raw.providers, `${at}.route.providers`, 'provider names', issues);
    if (providers) route.providers = providers;
  }
  if (raw.independentOf !== undefined) {
    const independentOf = normalizeIndependentOf(raw.independentOf, at, issues, {
      program, actionIndex, evidenceFor, knownActions,
    });
    if (independentOf !== undefined) route.independentOf = independentOf;
  }
  return Object.keys(route).length ? route : undefined;
}

function normalizeIndependentOf(raw, at, issues, { program, actionIndex, evidenceFor, knownActions }) {
  const where = `${at}.route.independentOf`;
  if (raw === ROUTE_WRITERS) {
    if (!Array.isArray(evidenceFor) || !evidenceFor.length) {
      issues.push(`${where} "writers" needs evidenceFor; on other steps name the steps`);
      return undefined;
    }
    return ROUTE_WRITERS;
  }
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && ID_RE.test(id))) {
    issues.push(`${where} must be "writers" or an array of step ids`);
    return undefined;
  }
  const ids = sortedUnique(raw);
  const actions = Array.isArray(program?.actions) ? program.actions : [];
  const self = isObject(actions[actionIndex]) ? actions[actionIndex].id : null;
  const known = new Set([...(knownActions ?? []), ...actions]
    .filter((action) => isObject(action) && typeof action.id === 'string')
    .map((action) => action.id));
  const ancestors = typeof self === 'string' ? ancestorsOf(self, dependencyGraph(program, knownActions)) : new Set();
  for (const id of ids) {
    if (id === self) issues.push(`${where} cannot name the step itself`);
    else if (!known.has(id)) issues.push(`${where} names "${id}", which is not a step in this program`);
    else if (!ancestors.has(id)) issues.push(`${where} names "${id}", which does not run before this step; add it to dependsOn (directly or through another step)`);
  }
  return ids.length ? ids : undefined;
}

const joined = (values) => values.join(', ');

/**
 * `use a, b · avoid c · providers d · avoid providers e · independent of x, y
 * (providers p, q)`. `resolved` is resolveRouteFilter's result; without it
 * the independence clause names only the steps.
 */
export function routeSummary(route, resolved = null) {
  if (!isObject(route)) return '';
  const parts = [];
  if (route.pools?.use?.length) parts.push(`use ${joined(route.pools.use)}`);
  if (route.pools?.avoid?.length) parts.push(`avoid ${joined(route.pools.avoid)}`);
  if (route.providers?.use?.length) parts.push(`providers ${joined(route.providers.use)}`);
  if (route.providers?.avoid?.length) parts.push(`avoid providers ${joined(route.providers.avoid)}`);
  const independentOf = route.independentOf;
  if (independentOf === ROUTE_WRITERS || (Array.isArray(independentOf) && independentOf.length)) {
    const steps = independentOf === ROUTE_WRITERS ? 'writers' : joined(independentOf);
    const providers = resolved?.independentProviders ?? [];
    parts.push(providers.length ? `independent of ${steps} (providers ${joined(providers)})` : `independent of ${steps}`);
  }
  return parts.join(' · ');
}

function currentAttempts(state, stepId) {
  const runtime = (state?.actions ?? []).find((action) => action?.id === stepId);
  const superseded = runtime?.supersededAttempts ?? 0;
  return {
    runtime,
    attempts: (state?.attempts ?? []).filter((attempt) => attempt?.actionId === stepId && attempt.ordinal > superseded),
  };
}

/**
 * D17: every current-definition attempt of `stepId` that did work: it
 * succeeded, changed files, wrote its deliverable, has no snapshot (the
 * kernel stopped before it), or left partial output a later attempt was
 * handed. An accepted step's accepted attempt always counts.
 */
export function workAttempts(state, stepId) {
  const { runtime, attempts } = currentAttempts(state, stepId);
  const acceptedId = runtime?.acceptance?.attemptId ?? null;
  return attempts.filter((attempt) => attempt.status === 'succeeded'
    || attempt.id === acceptedId
    || attempt.changedFileCount === undefined || attempt.changedFileCount === null
    || attempt.changedFileCount > 0
    || (Array.isArray(attempt.deliverable?.written) && attempt.deliverable.written.length > 0)
    || (Boolean(attempt.partialOutput) && attempt.outputBytes > 0));
}

function definitionOf(state, stepId) {
  return (state?.program?.actions ?? []).find((action) => action?.id === stepId) ?? null;
}

// The work steps a check's "writers" stands for: live steps with no
// evidenceFor whose affects meet the check's evidenceFor.
function writerSteps(state, action) {
  const judged = new Set(action?.evidenceFor ?? []);
  const removed = new Set((state?.actions ?? []).filter((item) => item?.status === 'removed').map((item) => item.id));
  return (state?.program?.actions ?? [])
    .filter((item) => item?.id !== action?.id && !removed.has(item?.id)
      && !(item.evidenceFor ?? []).length
      && (item.affects ?? []).some((id) => judged.has(id)))
    .map((item) => item.id);
}

function providerOf(poolName, pools) {
  const pool = (pools ?? []).find((item) => item?.name === poolName);
  return modelFamilyOf(pool ?? poolName);
}

/**
 * The step's route as the filter preparePools applies, or null when the step
 * has no route. `independentOf` resolves to the providers of every attempt
 * that did work on the named steps (D17); `pools` gives each pool name its
 * provider.
 */
export function resolveRouteFilter(state, action, pools = []) {
  const definition = action?.route !== undefined ? action : definitionOf(state, action?.id);
  const route = definition?.route;
  if (!isObject(route)) return null;
  const steps = route.independentOf === ROUTE_WRITERS
    ? writerSteps(state, definition)
    : (Array.isArray(route.independentOf) ? route.independentOf : []);
  const independentOf = {};
  for (const stepId of steps) {
    independentOf[stepId] = sortedUnique(workAttempts(state, stepId)
      .map((attempt) => (attempt.pool ? providerOf(attempt.pool, pools) : null))
      .filter(Boolean));
  }
  const filter = {
    usePools: route.pools?.use ? [...route.pools.use] : null,
    avoidPools: [...(route.pools?.avoid ?? [])],
    useProviders: route.providers?.use ? [...route.providers.use] : null,
    avoidProviders: [...(route.providers?.avoid ?? [])],
    independentProviders: sortedUnique(Object.values(independentOf).flat()),
    independentOf,
  };
  filter.summary = routeSummary(route, filter);
  return filter;
}

/** Whether a pool (object or name) passes a resolved route filter. */
export function poolPassesRoute(pool, filter) {
  if (!filter) return true;
  const name = typeof pool === 'string' ? pool : pool?.name;
  const provider = modelFamilyOf(pool);
  if (filter.usePools && !filter.usePools.includes(name)) return false;
  if ((filter.avoidPools ?? []).includes(name)) return false;
  if (filter.useProviders && !filter.useProviders.includes(provider)) return false;
  if ((filter.avoidProviders ?? []).includes(provider)) return false;
  if ((filter.independentProviders ?? []).includes(provider)) return false;
  return true;
}

/**
 * The run-time "no eligible pool" reason under a route (§2.4). With
 * `sharedProvider` true the capable pools existed but every one shares a
 * provider with a step the route is independent of.
 */
export function routeUnavailableWhy(filter, { lane, effort, sharedProvider = false } = {}) {
  const head = `no eligible pool under the step's route (${filter?.summary ?? ''})`;
  if (!sharedProvider) return `${head}: no enabled pool left has a model on the ${effort} tier for ${lane} work`;
  const steps = Object.keys(filter?.independentOf ?? {});
  return `${head}: every pool that could run it shares a provider with ${joined(steps)} (${joined(filter?.independentProviders ?? [])})`;
}

// Union of every list; the intersection of `use` lists only when every
// source has one. A use entry that another source avoids is dropped; when the
// intersection is empty the union of the use lists stands in (see below).
function inheritUseAvoid(sources) {
  const avoid = sortedUnique(sources.flatMap((source) => source?.avoid ?? []));
  const result = {};
  if (avoid.length) result.avoid = avoid;
  if (sources.length && sources.every((source) => Array.isArray(source?.use) && source.use.length)) {
    let use = sources.map((source) => source.use).reduce((left, right) => left.filter((name) => right.includes(name)));
    // An empty intersection would be dropped by normalisation and read as
    // "anywhere"; the union keeps the step on pools its sources named.
    if (!use.length) use = sources.flatMap((source) => source.use);
    use = sortedUnique(use).filter((name) => !avoid.includes(name));
    if (use.length) result.use = use;
  }
  return Object.keys(result).length ? result : undefined;
}

function inheritLists(actions) {
  const route = {};
  for (const key of ['pools', 'providers']) {
    const inherited = inheritUseAvoid(actions.map((action) => (isObject(action?.route) ? action.route[key] : undefined)));
    if (inherited) route[key] = inherited;
  }
  return route;
}

/** D19: `repair-N`'s route from the steps it repairs; never independentOf. */
export function inheritedRepairRoute(affectingActions = []) {
  const route = inheritLists(affectingActions);
  return Object.keys(route).length ? route : undefined;
}

/**
 * D19: `verify-round-N`'s route from round 1's authored check steps: avoid
 * unions, use intersections, and "writers" when any check said so; otherwise
 * the union of the named steps plus every earlier repair, when any check
 * named steps.
 */
export function inheritedVerifyRoute(authoredChecks = [], repairIds = []) {
  const route = inheritLists(authoredChecks);
  const lists = authoredChecks.map((check) => check?.route?.independentOf);
  if (lists.includes(ROUTE_WRITERS)) route.independentOf = ROUTE_WRITERS;
  else if (lists.some((list) => Array.isArray(list) && list.length)) {
    route.independentOf = sortedUnique([...lists.filter(Array.isArray).flat(), ...repairIds]);
  }
  return Object.keys(route).length ? route : undefined;
}

// The route's pools/providers lists as a filter, before any attempt exists
// (independence resolves only at run time).
function staticFilter(route) {
  return {
    usePools: route.pools?.use ?? null,
    avoidPools: route.pools?.avoid ?? [],
    useProviders: route.providers?.use ?? null,
    avoidProviders: route.providers?.avoid ?? [],
    independentProviders: [],
    independentOf: {},
    summary: routeSummary(route),
  };
}

/**
 * The CLI checks that need the configured pool list (§2.4), as exit-2
 * messages. `labels` maps pool ids to display labels; `preparePools(pools,
 * action, effort, opts)` is the dispatcher's capability filter (called with
 * the pauses, holds and 5h gates ignored); `runPin` is --worker-pool.
 */
export function routeIssuesForPools(program, pools = [], { runPin = null, preparePools = null, labels = {} } = {}) {
  const issues = [];
  const configured = (pools ?? []).map((pool) => pool?.name).filter((name) => typeof name === 'string');
  const providers = sortedUnique((pools ?? []).map((pool) => modelFamilyOf(pool)).filter(Boolean));
  const idByLabel = new Map(Object.entries(labels ?? {}).map(([id, label]) => [label, id]));
  for (const action of Array.isArray(program?.actions) ? program.actions : []) {
    const route = action?.route;
    if (!isObject(route)) continue;
    const step = action.id;
    const before = issues.length;
    for (const field of LIST_KEYS) {
      for (const name of route.pools?.[field] ?? []) {
        if (configured.includes(name)) continue;
        if (idByLabel.has(name) && configured.includes(idByLabel.get(name))) {
          issues.push(`step ${step} route.pools.${field} names "${name}", which is a pool label; use its id "${idByLabel.get(name)}"`);
        } else issues.push(`step ${step} route.pools.${field} names "${name}", which is not a configured pool (configured: ${joined(configured)})`);
      }
      for (const name of route.providers?.[field] ?? []) {
        if (!providers.includes(name)) issues.push(`step ${step} route.providers.${field} names "${name}", which no configured pool uses (providers: ${joined(providers)})`);
      }
    }
    if (issues.length > before) continue;
    const filter = staticFilter(route);
    if (runPin) {
      const pinned = (pools ?? []).find((pool) => pool?.name === runPin) ?? runPin;
      if (!poolPassesRoute(pinned, filter)) issues.push(`step ${step}: its route leaves nothing of the run's pinned pool ${runPin} (--worker-pool)`);
      continue;
    }
    const capable = typeof preparePools === 'function'
      ? preparePools(pools, action, action.effort, {
        routeFilter: filter, ignoreQuarantine: true, ignoreBench: true, ignoreBurstGate: true,
      }).filter((pool) => poolPassesRoute(pool, filter))
      : (pools ?? []).filter((pool) => pool?.enabled !== false && poolPassesRoute(pool, filter));
    if (!capable.length) {
      issues.push(`step ${step}: no enabled pool can run it under its route (${action.lane}/${action.effort} work; route: ${filter.summary})`);
    }
  }
  return issues;
}
