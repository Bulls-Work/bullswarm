// Route filters on `bullswarm run`: --avoid-pool, --use-provider,
// --avoid-provider and --independent-of. They are the workflow step route
// (src/workflow/step-route.js: route.pools / route.providers / independentOf)
// as flags, resolved into the same filter object and applied with the same
// poolPassesRoute, as hard filters before pace ranks anything. The caller
// keeps the control flow; this only narrows where one run may go. When the
// filters leave no pool, the run fails with the reason. It never widens.

import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { modelFamilyOf } from './route.js';
import { resolvePoolId } from './pool-labels.js';
import { poolPassesRoute, routeSummary } from '../workflow/step-route.js';

/** The repeatable flags; src/cli.js parseArgs keeps every value of these. */
export const RUN_ROUTE_FLAGS = Object.freeze(['avoid-pool', 'use-provider', 'avoid-provider', 'independent-of']);

const NAME_MAX = 80;
const LIST_FLAGS = ['avoid-pool', 'use-provider', 'avoid-provider'];
const sortedUnique = (values) => [...new Set(values)].sort();
const joined = (values) => values.join(', ');
const isRunEntry = (entry) => entry?.kind === 'run' || entry?.source === 'run';

function values(raw) {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * The flags as typed, checked for shape only (a value is present and is a
 * name). Pool and provider flags take a name or a comma list and may repeat;
 * --independent-of takes one run ref per flag and may repeat. Returns
 * `{ route }` (null when no route flag was given) or `{ error }` for exit 2.
 */
export function parseRunRoute(opts = {}) {
  const lists = {};
  for (const flag of LIST_FLAGS) {
    const names = [];
    for (const value of values(opts[flag])) {
      if (typeof value !== 'string') return { error: `usage: --${flag} requires a value` };
      for (const name of value.split(',').map((part) => part.trim())) {
        if (!name) return { error: `usage: --${flag} has an empty name in "${value}"` };
        if (name.length > NAME_MAX || /\s/.test(name)) return { error: `usage: --${flag} "${name}" is not a name (no spaces, at most ${NAME_MAX} characters)` };
        names.push(name);
      }
    }
    lists[flag] = sortedUnique(names);
  }
  const refs = [];
  for (const value of values(opts['independent-of'])) {
    if (typeof value !== 'string' || !value.trim()) return { error: 'usage: --independent-of requires a value (an earlier run\'s outFile path or id)' };
    if (!refs.includes(value.trim())) refs.push(value.trim());
  }
  for (const name of lists['use-provider']) {
    if (lists['avoid-provider'].includes(name)) return { error: `usage: --use-provider and --avoid-provider both name "${name}"` };
  }
  if (!refs.length && LIST_FLAGS.every((flag) => !lists[flag].length)) return { route: null };
  return {
    route: {
      avoidPools: lists['avoid-pool'],
      useProviders: lists['use-provider'].length ? lists['use-provider'] : null,
      avoidProviders: lists['avoid-provider'],
      refs,
    },
  };
}

/**
 * The finished `run` a ref names in the decision log: its `id`, or the path
 * of its `outFile` (relative paths resolve against `cwd`). The latest entry
 * wins if more than one matches.
 */
export function findRunEntry(decisionLog, ref, { cwd = process.cwd() } = {}) {
  const path = resolve(cwd, ref);
  // One file under two spellings is one run (macOS /tmp is /private/tmp).
  let real;
  const samePath = (outFile) => {
    const other = resolve(outFile);
    if (other === path) return true;
    if (basename(other) !== basename(path)) return false;
    real ??= realPath(path);
    return realPath(other) === real;
  };
  const entries = (Array.isArray(decisionLog) ? decisionLog : []).filter(isRunEntry);
  return entries.findLast((entry) => entry.id === ref
    || (typeof entry.outFile === 'string' && entry.outFile && samePath(entry.outFile))) ?? null;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve parsed flags against this home: pool labels become ids, every
 * pool and provider must be configured, and each --independent-of ref
 * becomes the provider of the pool that ran it. `pools` is the configured
 * pool list (objects with `name` and `connector`, or built pool views).
 * Returns `{ filter }` (null without route flags) or `{ error }` for exit 2.
 * The filter has step-route.js's resolveRouteFilter shape, so poolPassesRoute
 * applies it unchanged.
 */
export function resolveRunRoute(route, {
  pools = [], decisionLog = [], home = null, cwd = process.cwd(),
} = {}) {
  if (!route) return { filter: null };
  const configured = pools.map((pool) => pool?.name).filter((name) => typeof name === 'string');
  const providerOfName = (name) => modelFamilyOf(pools.find((pool) => pool?.name === name) ?? name);
  const providers = sortedUnique(pools.map((pool) => modelFamilyOf(pool)).filter(Boolean));

  const avoidPools = [];
  for (const name of route.avoidPools ?? []) {
    const id = home ? resolvePoolId(name, home) : name;
    if (!configured.includes(id)) return { error: `usage: --avoid-pool names "${name}", which is not a configured pool (configured: ${joined(configured) || 'none'})` };
    if (!avoidPools.includes(id)) avoidPools.push(id);
  }
  for (const [flag, names] of [['use-provider', route.useProviders ?? []], ['avoid-provider', route.avoidProviders ?? []]]) {
    for (const name of names) {
      if (!providers.includes(name)) return { error: `usage: --${flag} names "${name}", which no configured pool uses (providers: ${joined(providers) || 'none'})` };
    }
  }

  const independentOf = {};
  const runs = [];
  for (const ref of route.refs ?? []) {
    const entry = findRunEntry(decisionLog, ref, { cwd });
    if (!entry) {
      return { error: `usage: --independent-of "${ref}" matches no finished run in this home's decision log; pass the outFile path or id of an earlier bullswarm run (the log keeps the last 500 decisions)` };
    }
    const pool = entry.pool ?? entry.picked ?? null;
    if (typeof pool !== 'string' || !pool) return { error: `usage: --independent-of "${ref}" names a run with no recorded pool, so its provider is unknown` };
    const provider = providerOfName(pool);
    const key = typeof entry.id === 'string' && entry.id ? entry.id : ref;
    independentOf[key] = sortedUnique([...(independentOf[key] ?? []), provider]);
    runs.push({ ref, id: entry.id ?? null, pool, provider, outFile: entry.outFile ?? null });
  }

  const summaryRoute = {
    ...(avoidPools.length ? { pools: { avoid: sortedUnique(avoidPools) } } : {}),
    ...(route.useProviders || route.avoidProviders?.length ? {
      providers: {
        ...(route.useProviders ? { use: route.useProviders } : {}),
        ...(route.avoidProviders?.length ? { avoid: route.avoidProviders } : {}),
      },
    } : {}),
    ...(Object.keys(independentOf).length ? { independentOf: Object.keys(independentOf).sort() } : {}),
  };
  const filter = {
    usePools: null,
    avoidPools: sortedUnique(avoidPools),
    useProviders: route.useProviders ? [...route.useProviders] : null,
    avoidProviders: [...(route.avoidProviders ?? [])],
    independentProviders: sortedUnique(Object.values(independentOf).flat()),
    independentOf,
    runs,
  };
  filter.summary = routeSummary(summaryRoute, filter);
  return { filter };
}

/**
 * parseRunRoute then resolveRunRoute, for cmdRun. `configuredPools` is a
 * function, so a run without route flags loads nothing extra.
 */
export function runRouteFromOpts(opts, { decisionLog = [], home = null, configuredPools = () => [] } = {}) {
  const parsed = parseRunRoute(opts);
  if (parsed.error || !parsed.route) return parsed.error ? parsed : { filter: null };
  return resolveRunRoute(parsed.route, { pools: configuredPools(), decisionLog, home });
}

// Every rule a pool fails, in poolPassesRoute's order, as flag wording.
function failedRules(pool, filter) {
  const name = typeof pool === 'string' ? pool : pool?.name;
  const provider = modelFamilyOf(pool);
  const why = [];
  if ((filter.avoidPools ?? []).includes(name)) why.push('in --avoid-pool');
  if (filter.useProviders && !filter.useProviders.includes(provider)) why.push(`provider ${provider} is not in --use-provider ${joined(filter.useProviders)}`);
  if ((filter.avoidProviders ?? []).includes(provider)) why.push(`provider ${provider} is in --avoid-provider`);
  if ((filter.independentProviders ?? []).includes(provider)) {
    const ran = Object.entries(filter.independentOf ?? {})
      .filter(([, providers]) => providers.includes(provider)).map(([id]) => id);
    why.push(`provider ${provider} ran --independent-of ${joined(ran)}`);
  }
  return why.join('; ');
}

// `pool (why), pool (why)`: the one form the why and the text line share.
const listed = (rows) => rows.map((row) => `${row.pool} (${row.why})`).join(', ');

/**
 * Apply a resolved filter to the pool list. `pools` passes straight through
 * without a filter. `filteredOut` names every enabled pool the filters took
 * out and why; `empty` is true when they took out every enabled pool, and
 * `why` then says so. The caller (the calling agent, by `callerName`) is
 * held to the same filter: when it fails, `callerEligible` is false, so an
 * empty list is a failure and never a silent keep-on-caller.
 */
export function applyRunRoute(filter, pools = [], { callerName = null, callerEligible = true } = {}) {
  if (!filter) return { pools, callerEligible, empty: false, report: null, why: null };
  const kept = pools.filter((pool) => poolPassesRoute(pool, filter));
  const filteredOut = pools
    .filter((pool) => pool?.enabled !== false && !kept.includes(pool))
    .map((pool) => ({ pool: pool.name, provider: modelFamilyOf(pool), why: failedRules(pool, filter) }))
    .sort((a, b) => a.pool.localeCompare(b.pool));
  const callerPasses = !callerName || poolPassesRoute(callerName, filter);
  const caller = callerEligible && !callerPasses
    ? { name: callerName, provider: modelFamilyOf(callerName), why: failedRules(callerName, filter) }
    : null;
  const left = kept.filter((pool) => pool?.enabled !== false).map((pool) => pool.name);
  const empty = filteredOut.length > 0 && left.length === 0;
  const report = {
    summary: filter.summary,
    avoidPools: filter.avoidPools,
    useProviders: filter.useProviders,
    avoidProviders: filter.avoidProviders,
    independentOf: filter.runs ?? [],
    left,
    filteredOut,
    ...(caller ? { callerFilteredOut: caller } : {}),
    empty,
  };
  // A pool the filters keep but that is switched off is why "use grok" found
  // nothing: say so, or the why reads as if the filters were wrong.
  const disabled = kept.filter((pool) => pool?.enabled === false).map((pool) => pool.name).sort();
  const why = empty
    ? `no pool left after route filters (${filter.summary}): ${listed(filteredOut)}`
      + (disabled.length ? `; passes the filters but disabled: ${joined(disabled)}` : '')
    : null;
  return { pools: kept, callerEligible: callerEligible && callerPasses, empty, report, why };
}

/**
 * One text line for the filtered-out pools, or null when nothing was taken
 * out or when every pool was (the verdict's why already names them all).
 */
export function routeFilterLine(report) {
  if (!report || report.empty) return null;
  const caller = report.callerFilteredOut;
  const rows = [...(report.filteredOut ?? []), ...(caller ? [{ pool: `the caller ${caller.name}`, why: caller.why }] : [])];
  return rows.length ? `filtered out: ${listed(rows)}` : null;
}
