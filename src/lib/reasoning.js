// bullswarm reasoning — connector-declared thinking level, resolved per attempt.
//
// Doctrine:
//   RS1. Reasoning is a CONNECTOR fact, never core logic. Every CLI names its
//        own flag and its own accepted values; core knows only the common
//        scale and asks the connector how to say it. A connector that
//        declares no `reasoning` block gets nothing appended — inventing a
//        flag for it would break the spawn outright.
//   RS2. Exactly ONE level is resolved per attempt, through one precedence
//        chain: explicit per-action override > run-wide override > strategy
//        per-model level (one pool's model on one tier) > strategy per-pool
//        level > strategy per-tier level > connector default for the effort
//        tier > nothing. Every dispatch path calls this resolver, so
//        the dry-run preview, the attempt record, the decision log and the
//        spawned argv cannot drift apart.
//   RS3. `default` is a real answer, not a missing one: it means "pass
//        nothing, let the CLI's own configuration decide". It stops
//        resolution at the layer that said it, and `source` names that layer
//        so the operator can see who chose silence.
//   RS4. A request the connector cannot express is CLAMPED, never dropped and
//        never invented: down to the strongest level it does support, or up
//        to the weakest one when the request is below all of them. The clamp
//        is reported, so a record never claims a level the CLI never saw.
//   RS5. Resolution never throws and never blocks a dispatch. A malformed
//        level, a broken `skipModels` regex or a missing strategy object
//        degrades to "nothing appended", because a thinking-level preference
//        is not worth failing real work over.
//   RS6. Zero dependencies.
//   RS7. A level a strategy recommendation wrote (`strategy.recommendedReasoning`
//        marks it) sits in the per-pool slot but reports source
//        `recommendation`, and stops applying once the rung runs a different
//        model than the one it was recommended for. Any operator write to the
//        slot takes it over (src/lib/strategy.js).

/** The common scale, weakest → strongest. Order is the clamping order. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The literal that means "append nothing; the CLI's own config decides". */
export const REASONING_DEFAULT = 'default';

/** Every `source` value resolveReasoningLevel can report. */
export const REASONING_SOURCES = [
  'action', 'run', 'strategy-model', 'strategy-pool', 'recommendation', 'strategy-tier', 'connector',
  'none', 'unsupported', 'skipped-model',
];

/** True for the five common-scale levels and for the literal `default`. */
export function isReasoningLevel(value) {
  return typeof value === 'string'
    && (value === REASONING_DEFAULT || REASONING_LEVELS.includes(value));
}

function requestedLevel(value) {
  return isReasoningLevel(value) ? value : null;
}

/**
 * The levels this connector says its CLI accepts, weakest → strongest.
 * Unknown names are dropped rather than trusted: clamping can only reason
 * about positions on the common scale.
 */
function supportedLevels(connector, model = null, strategy = null) {
  const discovered = typeof model === 'string' && model
    ? strategy?.lastReport?.discoveries?.[connector?.name]?.models
      ?.find((entry) => entry.id === model)?.reasoningLevels
    : null;
  return levelsOnScale(connector, discovered);
}

/**
 * The model's discovered levels when the CLI reported a list, else the
 * connector's, kept to the common scale (a CLI-only `ultra` or `minimal`
 * drops out), weakest → strongest.
 */
function levelsOnScale(connector, discovered) {
  const declared = Array.isArray(discovered) ? discovered : connector?.reasoning?.levels;
  if (!Array.isArray(declared)) return [];
  const seen = new Set();
  for (const level of declared) {
    if (typeof level === 'string' && REASONING_LEVELS.includes(level)) seen.add(level);
  }
  return REASONING_LEVELS.filter((level) => seen.has(level));
}

/**
 * The common-scale levels this connector's CLI accepts, weakest → strongest,
 * for screens that offer a choice. Empty when the connector declares none.
 */
export function connectorReasoningLevels(connector) {
  return levelsOnScale(connector, null);
}

/** RS4: strongest supported level not above the request, else the weakest. */
function clampToSupported(level, levels) {
  const wanted = REASONING_LEVELS.indexOf(level);
  let best = null;
  for (const candidate of levels) {
    if (REASONING_LEVELS.indexOf(candidate) <= wanted) best = candidate;
  }
  const applied = best ?? levels[0];
  return { applied, clamped: applied !== level };
}

/**
 * Does the connector mark this model as one that must not receive the flag?
 * A connector-owned regex; a broken pattern never blocks the dispatch (RS5).
 */
function skipsModel(connector, model) {
  if (typeof model !== 'string' || !model) return false;
  const patterns = connector?.reasoning?.skipModels;
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    try { return new RegExp(pattern).test(model); }
    catch { return false; }
  });
}

/**
 * Resolve the one reasoning level this attempt runs at.
 *
 * @param {object} input
 * @param {object|null} input.connector  the real connector spec (not the pool view)
 * @param {string|null} input.tier       effort tier: high | medium | low
 * @param {string|null} input.model      the selected model, for skipModels
 * @param {object|null} input.strategy   core state.strategy (reads .reasoning)
 * @param {string|null} input.runOverride     run-wide level or 'default'
 * @param {string|null} input.actionOverride  per-action level or 'default'
 * @returns {{requested: string|null, applied: string|null, source: string, clamped: boolean}}
 */
export function resolveReasoningLevel({
  connector = null,
  tier = null,
  model = null,
  strategy = null,
  runOverride = null,
  actionOverride = null,
} = {}) {
  const pool = typeof connector?.name === 'string' ? connector.name : null;
  const tierKey = typeof tier === 'string' ? tier : null;
  const configured = strategy?.reasoning ?? null;
  const poolLevel = pool && tierKey ? configured?.pools?.[pool]?.[tierKey] : null;
  const modelLevel = pool && tierKey && typeof model === 'string' && model
    ? configured?.models?.[pool]?.[model]?.[tierKey] : null;
  // RS7: the per-pool slot holds either an operator's level or one a
  // recommendation wrote for one model.
  const recommended = pool && tierKey ? strategy?.recommendedReasoning?.[pool]?.[tierKey] : null;
  const fromRecommendation = recommended != null && poolLevel != null && recommended.level === poolLevel;
  const otherModel = fromRecommendation && typeof model === 'string' && model
    && typeof recommended.model === 'string' && recommended.model !== model;
  const layers = [
    ['action', actionOverride],
    ['run', runOverride],
    ['strategy-model', modelLevel],
    [fromRecommendation ? 'recommendation' : 'strategy-pool', otherModel ? null : poolLevel],
    ['strategy-tier', tierKey ? configured?.tiers?.[tierKey] : null],
    ['connector', tierKey ? connector?.reasoning?.defaults?.[tierKey] : null],
  ];
  let source = 'none';
  let requested = null;
  for (const [name, value] of layers) {
    const level = requestedLevel(value);
    if (level == null) continue;
    source = name;
    requested = level;
    break;
  }

  // RS1: no usable connector declaration means there is no truthful flag to
  // append, whatever any layer asked for.
  const levels = supportedLevels(connector, model, strategy);
  if (!levels.length) return { requested, applied: null, source: 'unsupported', clamped: false };
  if (requested == null) return { requested: null, applied: null, source: 'none', clamped: false };
  // RS3: an explicit `default` is the decision — report the layer that made it.
  if (requested === REASONING_DEFAULT) return { requested, applied: null, source, clamped: false };
  if (skipsModel(connector, model)) return { requested, applied: null, source: 'skipped-model', clamped: false };
  const { applied, clamped } = clampToSupported(requested, levels);
  return { requested, applied, source, clamped };
}

/**
 * The level a strategy recommendation may suggest for one model: `requested`
 * clamped (RS4) to what that model accepts — the levels its CLI reported at
 * discovery, else the connector's — so it is the strongest supported level
 * not above the request, and never above `max`. Null when the connector
 * declares no reasoning or skips the flag for this model (RS1).
 *
 * @param {object|null} connector
 * @param {{id?: string, reasoningLevels?: string[]}} model  a discovered model
 * @param {string} requested  a common-scale level, `max` by default
 * @returns {{requested: string, applied: string|null, clamped: boolean}}
 */
export function suggestedReasoningLevel(connector, model = {}, requested = 'max') {
  const wanted = REASONING_LEVELS.includes(requested) ? requested : 'max';
  const levels = levelsOnScale(connector, model?.reasoningLevels);
  if (!levels.length || skipsModel(connector, model?.id)) {
    return { requested: wanted, applied: null, clamped: false };
  }
  return { requested: wanted, ...clampToSupported(wanted, levels) };
}

/**
 * The argv fragment that tells THIS connector's CLI to think at `applied`.
 * `[flag, level]` for the flag form, the substituted `args` for the config
 * form, and `[]` whenever nothing should be appended.
 */
export function reasoningArgs(connector, applied) {
  if (typeof applied !== 'string' || !REASONING_LEVELS.includes(applied)) return [];
  const spec = connector?.reasoning ?? null;
  if (!spec) return [];
  if (typeof spec.flag === 'string' && spec.flag) return [spec.flag, applied];
  if (Array.isArray(spec.args)) {
    return spec.args.map((arg) => String(arg).replaceAll('{level}', applied));
  }
  return [];
}

/**
 * The level to actually append, from either a resolved record or a bare
 * level string. `default`, null and anything off the common scale all mean
 * "append nothing".
 */
export function appliedReasoningLevel(reasoning) {
  const value = typeof reasoning === 'string' ? reasoning : reasoning?.applied ?? null;
  return typeof value === 'string' && REASONING_LEVELS.includes(value) ? value : null;
}

/**
 * Normalize whatever a caller passed into the reported record shape.
 * A bare level string is treated as a run-wide override, which is what a
 * direct caller handing watchOnce a level is expressing.
 */
export function reasoningRecord(reasoning) {
  if (reasoning == null) return { requested: null, applied: null, source: 'none', clamped: false };
  if (typeof reasoning === 'string') {
    return {
      requested: isReasoningLevel(reasoning) ? reasoning : null,
      applied: appliedReasoningLevel(reasoning),
      source: isReasoningLevel(reasoning) ? 'run' : 'none',
      clamped: false,
    };
  }
  return {
    requested: reasoning.requested ?? null,
    applied: appliedReasoningLevel(reasoning),
    source: REASONING_SOURCES.includes(reasoning.source) ? reasoning.source : 'none',
    clamped: reasoning.clamped === true,
  };
}
