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
//        per-pool level > strategy per-tier level > connector default for the
//        effort tier > nothing. Every dispatch path calls this resolver, so
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

/** The common scale, weakest → strongest. Order is the clamping order. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The literal that means "append nothing; the CLI's own config decides". */
export const REASONING_DEFAULT = 'default';

/** Every `source` value resolveReasoningLevel can report. */
export const REASONING_SOURCES = [
  'action', 'run', 'strategy-pool', 'strategy-tier', 'connector',
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
function supportedLevels(connector) {
  const declared = connector?.reasoning?.levels;
  if (!Array.isArray(declared)) return [];
  const seen = new Set();
  for (const level of declared) {
    if (typeof level === 'string' && REASONING_LEVELS.includes(level)) seen.add(level);
  }
  return REASONING_LEVELS.filter((level) => seen.has(level));
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
  const layers = [
    ['action', actionOverride],
    ['run', runOverride],
    ['strategy-pool', pool && tierKey ? configured?.pools?.[pool]?.[tierKey] : null],
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
  const levels = supportedLevels(connector);
  if (!levels.length) return { requested, applied: null, source: 'unsupported', clamped: false };
  if (requested == null) return { requested: null, applied: null, source: 'none', clamped: false };
  // RS3: an explicit `default` is the decision — report the layer that made it.
  if (requested === REASONING_DEFAULT) return { requested, applied: null, source, clamped: false };
  if (skipsModel(connector, model)) return { requested, applied: null, source: 'skipped-model', clamped: false };
  const { applied, clamped } = clampToSupported(requested, levels);
  return { requested, applied, source, clamped };
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
