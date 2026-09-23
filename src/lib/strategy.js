// Model discovery and tiered subscription strategy.
// Discovery commands, parsing quirks, tier rules, and dated pricing live in
// connector JSON. Core only executes and normalizes those declarations.

import { execFile } from 'node:child_process';
import { isFreeModel } from './usage.js';
import {
  compareVersions, generationFallback, modelRanking, versionLabelParts,
} from './model-family.js';
import { openRouterMetadata } from './openrouter-models.js';
import {
  isReasoningLevel, REASONING_LEVELS, resolveReasoningLevel, suggestedReasoningLevel,
} from './reasoning.js';
import { attemptWindow } from './spend.js';
import { pacingWindowFor } from '../meters/framework.js';
// The canonical lane/effort tables. Imported, never restated: see
// TIER_CONTEXTS below for the tier -> lane derivation they feed.
import { DEFAULT_EFFORT_BY_LANE, KIND_DEFAULTS } from '../workflow/action-validator.js';
import { formatMoney } from './usage-basis.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeExcludedModels(values = []) {
  return unique((Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean));
}

export function isModelExcluded(model, excludedModels = []) {
  if (!model) return false;
  const excluded = new Set(normalizeExcludedModels(excludedModels));
  return excluded.has(String(model).trim().toLowerCase());
}

export const STRATEGY_TIERS = Object.freeze(['high', 'medium', 'low']);

export function normalizeModelTiers(value = {}) {
  const normalized = {};
  for (const [pool, models] of Object.entries(value ?? {})) {
    if (!models || typeof models !== 'object') continue;
    const poolModels = {};
    for (const [model, tiers] of Object.entries(models)) {
      const selected = STRATEGY_TIERS.filter((tier) => (Array.isArray(tiers) ? tiers : [tiers]).includes(tier));
      if (selected.length) poolModels[model] = selected;
    }
    if (Object.keys(poolModels).length) normalized[pool] = poolModels;
  }
  return normalized;
}

export function selectedModelsForTier(strategy = {}, pool, tier) {
  if (!(strategy.configuredTiers ?? []).includes(tier)) return null;
  const models = normalizeModelTiers(strategy.modelTiers)[pool] ?? {};
  return Object.entries(models)
    .filter(([, tiers]) => tiers.includes(tier))
    .map(([model]) => model);
}

export function setModelTierSelection(strategy, pool, model, tiers) {
  const selected = STRATEGY_TIERS.filter((tier) => (Array.isArray(tiers) ? tiers : [tiers]).includes(tier));
  strategy.modelTiers = normalizeModelTiers(strategy.modelTiers);
  strategy.modelTiers[pool] ??= {};
  if (selected.length) strategy.modelTiers[pool][model] = selected;
  else delete strategy.modelTiers[pool][model];
  if (!Object.keys(strategy.modelTiers[pool]).length) delete strategy.modelTiers[pool];
  return selected;
}

/**
 * Drop the hard pool pin for one effort tier.
 *
 * `assignments[tier]` and `modelTiers[pool][model]` overlap (audit B5): the
 * first pins a pool, the second allow-lists models. Every writer of the second
 * has to invalidate the first, or the two stores disagree about routing and a
 * stale pin silently wins as `pickPool`'s preferredPool. This is that
 * invalidation, in one place, so no writer can forget it.
 *
 * @param {object} strategy `state.strategy` (may be null/undefined)
 * @param {string} tier     high | medium | low
 * @returns {boolean} whether a pin was actually removed
 */
export function clearTierAssignment(strategy, tier) {
  if (!strategy?.assignments || !(tier in strategy.assignments)) return false;
  delete strategy.assignments[tier];
  return true;
}

// --- tier pins ----------------------------------------------------------------
// A pin sends every dispatch of its tier to one pool, so pace-based routing
// never picks another plan for that tier. Only a person makes one now:
// `strategy assign` writes `source: 'user'`, and apply writes per-pool rungs,
// never a pin.
//
// Up to 0.35.4, apply pinned every tier and recorded the pin it wrote in
// `lastReport.suggestions[tier].assignment`. Such a pin carries no source. It
// is sorted once, while that record still exists (so before any report is
// replaced or dropped):
//   - apply ran in this home and the pin has the recorded pool and model:
//     apply wrote it → `source: 'apply'`, removed by the next apply or
//     auto-refresh (releaseAppliedPins);
//   - anything else (a different pin, no record, apply never ran): the user
//     changed it → `source: 'user'`.
// A `user` pin is never removed automatically.

export const PIN_SOURCES = Object.freeze(['user', 'apply']);

export function samePin(a, b) {
  return Boolean(a?.pool && b?.pool) && a.pool === b.pool && a.model === b.model;
}

/**
 * Give every pin without a source one (see above). Mutates `strategy`.
 * @returns {Array<{tier, pool, model, source}>} the pins it sorted
 */
export function sortLegacyPins(strategy) {
  const sorted = [];
  for (const tier of STRATEGY_TIERS) {
    const pin = strategy?.assignments?.[tier];
    if (!pin || PIN_SOURCES.includes(pin.source)) continue;
    const recorded = strategy.lastAppliedAt
      ? strategy.lastReport?.suggestions?.[tier]?.assignment ?? null
      : null;
    pin.source = samePin(pin, recorded) ? 'apply' : 'user';
    sorted.push({ tier, pool: pin.pool, model: pin.model, source: pin.source });
  }
  return sorted;
}

/**
 * Drop the cached report, sorting older pins first, since the report is the
 * only record of which pins an earlier apply wrote.
 */
export function dropStrategyReport(strategy) {
  if (!strategy) return;
  sortLegacyPins(strategy);
  delete strategy.lastReport;
}

/**
 * The pin step of every apply: remove the pins an earlier apply wrote, keep
 * every other one. Mutates `strategy`.
 * @returns {{ unpinned: Array<{tier, pool, model}>, keptPins: Array<{tier, pool, model, source}> }}
 */
export function releaseAppliedPins(strategy) {
  sortLegacyPins(strategy);
  const unpinned = [];
  const keptPins = [];
  for (const tier of STRATEGY_TIERS) {
    const pin = strategy?.assignments?.[tier];
    if (!pin) continue;
    if (pin.source === 'apply') {
      clearTierAssignment(strategy, tier);
      unpinned.push({ tier, pool: pin.pool, model: pin.model });
    } else {
      keptPins.push({ tier, pool: pin.pool, model: pin.model, source: pin.source });
    }
  }
  return { unpinned, keptPins };
}

/**
 * Make a pin's model its pool's rung for the tier. Once a tier is configured,
 * dispatch reads each pool's model from its rung (resolveDispatchModel), so
 * without this a pin would pick its pool but run that pool's rung model. A
 * tier with no rungs yet reads the pin's model directly: nothing to do.
 */
export function pinRung(strategy, tier, pin) {
  if (!(strategy?.configuredTiers ?? []).includes(tier) || !pin?.pool || !pin?.model) return;
  strategy.modelTiers = normalizeModelTiers(strategy.modelTiers);
  for (const [other, tiers] of Object.entries(strategy.modelTiers[pin.pool] ?? {})) {
    if (other === pin.model || !tiers.includes(tier)) continue;
    setModelTierSelection(strategy, pin.pool, other, tiers.filter((entry) => entry !== tier));
  }
  const existing = strategy.modelTiers[pin.pool]?.[pin.model] ?? [];
  setModelTierSelection(strategy, pin.pool, pin.model, [...existing, tier]);
}

export function disabledModelsForPool(strategy = {}, pool) {
  return normalizeExcludedModels(strategy.disabledModels?.[pool] ?? []);
}

export function setModelDisabled(strategy, pool, model, disabled) {
  strategy.disabledModels ??= {};
  const current = new Set(normalizeExcludedModels(strategy.disabledModels[pool]));
  if (disabled) current.add(String(model).trim().toLowerCase());
  else current.delete(String(model).trim().toLowerCase());
  if (current.size) strategy.disabledModels[pool] = [...current];
  else delete strategy.disabledModels[pool];
}

// --- reasoning depth ---------------------------------------------------------
// The persisted shape is `state.strategy.reasoning = { tiers, pools }`, where
// every value is a common-scale level or the literal 'default'. Absent keys
// fall through to the next layer; nothing is written implicitly, so an empty
// strategy still lets each connector's own per-tier defaults decide.
//
// One writer is not the operator: applying a recommendation that carries a
// level (a newest-generation fallback) writes it into the pool+tier slot, as
// `strategy set-rung --reasoning` would, and marks it in
// `state.strategy.recommendedReasoning = { [pool]: { [tier]: { level, model,
// why } } }`. The mark is what makes the resolver report `recommendation`,
// and what lets the next apply replace or remove its own level. Every operator
// writer below drops the mark it touches, so a user's level is never
// overwritten by a later apply.

function reasoningLevelList() {
  return [...REASONING_LEVELS, 'default'].join(', ');
}

function normalizeReasoningTiers(value) {
  const normalized = {};
  if (!value || typeof value !== 'object') return normalized;
  for (const tier of STRATEGY_TIERS) {
    if (isReasoningLevel(value[tier])) normalized[tier] = value[tier];
  }
  return normalized;
}

export function getStrategyReasoning(strategy = {}) {
  const raw = strategy?.reasoning ?? {};
  const pools = {};
  for (const [pool, tiers] of Object.entries(raw.pools ?? {})) {
    const normalized = normalizeReasoningTiers(tiers);
    if (Object.keys(normalized).length) pools[pool] = normalized;
  }
  return { tiers: normalizeReasoningTiers(raw.tiers), pools };
}

function storeStrategyReasoning(strategy, reasoning) {
  for (const [pool, tiers] of Object.entries(reasoning.pools)) {
    if (!Object.keys(tiers).length) delete reasoning.pools[pool];
  }
  if (Object.keys(reasoning.tiers).length || Object.keys(reasoning.pools).length) {
    strategy.reasoning = reasoning;
  } else {
    delete strategy.reasoning;
  }
  return getStrategyReasoning(strategy);
}

export function assertReasoningTier(tier) {
  if (!STRATEGY_TIERS.includes(tier)) {
    throw new Error(`--tier must be ${STRATEGY_TIERS.join(', ')}`);
  }
  return tier;
}

export function assertReasoningLevel(level) {
  if (!isReasoningLevel(level)) throw new Error(`--level must be ${reasoningLevelList()}`);
  return level;
}

/** The recommendation marks, normalized: `{ [pool]: { [tier]: { level, model, why } } }`. */
export function getRecommendedReasoning(strategy = {}) {
  const marks = {};
  for (const [pool, tiers] of Object.entries(strategy?.recommendedReasoning ?? {})) {
    if (!tiers || typeof tiers !== 'object') continue;
    for (const tier of STRATEGY_TIERS) {
      const mark = tiers[tier];
      if (!mark || !REASONING_LEVELS.includes(mark.level)) continue;
      (marks[pool] ??= {})[tier] = {
        level: mark.level,
        model: typeof mark.model === 'string' ? mark.model : null,
        why: typeof mark.why === 'string' ? mark.why : null,
      };
    }
  }
  return marks;
}

function storeRecommendedReasoning(strategy, marks) {
  for (const [pool, tiers] of Object.entries(marks)) {
    if (!Object.keys(tiers).length) delete marks[pool];
  }
  if (Object.keys(marks).length) strategy.recommendedReasoning = marks;
  else delete strategy.recommendedReasoning;
}

/** Drop the recommendation marks `(pool, tier)` matches; returns the dropped ones. */
function dropRecommendedMarks(strategy, matches) {
  const marks = getRecommendedReasoning(strategy);
  const dropped = [];
  for (const [pool, tiers] of Object.entries(marks)) {
    for (const [tier, mark] of Object.entries(tiers)) {
      if (!matches(pool, tier)) continue;
      dropped.push({ pool, tier, ...mark });
      delete tiers[tier];
    }
  }
  if (dropped.length || strategy?.recommendedReasoning) storeRecommendedReasoning(strategy, marks);
  return dropped;
}

/** Set (level) or remove (level null) one tier level, globally or per pool. */
export function setStrategyReasoning(strategy, { tier, level, pool = null } = {}) {
  assertReasoningTier(tier);
  if (level != null) assertReasoningLevel(level);
  const reasoning = getStrategyReasoning(strategy);
  const target = pool ? (reasoning.pools[pool] ??= {}) : reasoning.tiers;
  if (level == null) delete target[tier];
  else target[tier] = level;
  if (pool) {
    // The operator took this slot over, whatever a recommendation wrote there.
    dropRecommendedMarks(strategy, (p, t) => p === pool && t === tier);
  } else if (level != null) {
    // A tier-wide choice is the operator's answer for every pool on that tier,
    // so a recommended per-pool level may not shadow it.
    for (const mark of dropRecommendedMarks(strategy, (_p, t) => t === tier)) {
      if (reasoning.pools[mark.pool]?.[tier] === mark.level) delete reasoning.pools[mark.pool][tier];
    }
  }
  return storeStrategyReasoning(strategy, reasoning);
}

/** Clear everything (no arguments), one pool, one tier, or one pool+tier. */
export function clearStrategyReasoning(strategy, { tier = null, pool = null } = {}) {
  if (tier != null) assertReasoningTier(tier);
  if (tier == null && pool == null) {
    delete strategy.reasoning;
    delete strategy.recommendedReasoning;
    return { tiers: {}, pools: {} };
  }
  const reasoning = getStrategyReasoning(strategy);
  if (pool && tier) delete reasoning.pools[pool]?.[tier];
  else if (pool) delete reasoning.pools[pool];
  else {
    // A tier reset returns that effort tier to connector defaults everywhere,
    // the same way `strategy reset-tier` clears a tier from every selection.
    delete reasoning.tiers[tier];
    for (const tiers of Object.values(reasoning.pools)) delete tiers[tier];
  }
  dropRecommendedMarks(strategy, (p, t) => (pool == null || p === pool) && (tier == null || t === tier));
  return storeStrategyReasoning(strategy, reasoning);
}

/**
 * Write the reasoning levels an applied recommendation carries, never over
 * an operator's. `levels` is `{ [pool]: { [tier]: { level, model, why } } }`.
 *
 *   - A slot holding an operator's level (one without this module's mark),
 *     or a tier the operator set tier-wide, is kept as it is.
 *   - Otherwise the level is written into the pool+tier slot and marked.
 *   - A level an earlier apply wrote that this one no longer carries (a
 *     `gpt-6-terra` appeared, so medium is no longer a fallback) is removed,
 *     so the connector's own default for that tier applies again.
 *
 * Pure, like setRung: the caller saves state once.
 * @returns {{written: object[], kept: object[], cleared: object[]}}
 */
export function applyRecommendedReasoning(strategy, levels = {}) {
  const reasoning = getStrategyReasoning(strategy);
  const previous = getRecommendedReasoning(strategy);
  const marks = {};
  const result = { written: [], kept: [], cleared: [] };
  const wanted = (pool, tier) => {
    const level = levels?.[pool]?.[tier]?.level;
    return REASONING_LEVELS.includes(level) ? level : null;
  };
  for (const [pool, tiers] of Object.entries(previous)) {
    for (const [tier, mark] of Object.entries(tiers)) {
      if (reasoning.pools[pool]?.[tier] !== mark.level || wanted(pool, tier)) continue;
      delete reasoning.pools[pool][tier];
      result.cleared.push({ pool, tier, level: mark.level, model: mark.model });
    }
  }
  for (const [pool, tiers] of Object.entries(levels ?? {})) {
    for (const tier of STRATEGY_TIERS) {
      const level = wanted(pool, tier);
      if (!level) continue;
      const slot = reasoning.pools[pool]?.[tier] ?? null;
      const ours = slot != null && previous[pool]?.[tier]?.level === slot;
      if (slot != null && !ours) {
        result.kept.push({ pool, tier, level: slot, source: 'strategy-pool' });
        continue;
      }
      if (reasoning.tiers[tier] != null) {
        result.kept.push({ pool, tier, level: reasoning.tiers[tier], source: 'strategy-tier' });
        continue;
      }
      const entry = levels[pool][tier];
      const mark = {
        level,
        model: typeof entry.model === 'string' ? entry.model : null,
        why: typeof entry.why === 'string' ? entry.why : null,
      };
      (reasoning.pools[pool] ??= {})[tier] = level;
      (marks[pool] ??= {})[tier] = mark;
      result.written.push({ pool, tier, ...mark });
    }
  }
  storeStrategyReasoning(strategy, reasoning);
  storeRecommendedReasoning(strategy, marks);
  return result;
}

/** Effective `{ [pool]: { [tier]: { level, source } } }` for a pool list. */
export function reasoningEffective(pools, strategy = {}) {
  const effective = {};
  for (const pool of pools) {
    const connector = pool.connector ?? pool;
    effective[pool.name] = Object.fromEntries(STRATEGY_TIERS.map((tier) => {
      const resolved = resolveReasoningLevel({ connector, tier, strategy });
      return [tier, { level: resolved.applied, source: resolved.source }];
    }));
  }
  return effective;
}

export function configuredModel(connector) {
  if (connector.model) return connector.model;
  const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
  return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
}

// --- ranking -----------------------------------------------------------------
// One quality scale: the connector's quality rank (a family's base rank, or an
// exact row's). Benchmarks never share that scale. They only break ties
// between models of EQUAL rank, and each is compared only with its own kind:
// the datapack's OpenRouter index with other OpenRouter indices, then a
// connector-declared dated score with other declared scores. A model without
// one loses that tie-break and nothing else.
//
// Within one pool and family the newer version always wins. Its comparison
// key is never worse than any older member's in the same candidate list — it
// takes the best of them — so a missing price, benchmark, or local record
// cannot put it below its predecessor. Pace, pool cost, and price still order
// different families and pools; they never reorder one family.

/** Descending lexicographic order of two numeric keys; -1 means `a` first. */
function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? -Infinity;
    const y = b[i] ?? -Infinity;
    if (x > y) return -1;
    if (x < y) return 1;
  }
  return 0;
}

/**
 * Sort `{ pool, model, key }` entries best first, newest first inside each
 * pool+family. Each entry gains `effectiveKey` and `inheritsFrom` (the older
 * family member whose standing a newer model took, or null).
 */
function rankCandidates(entries) {
  const families = new Map();
  for (const entry of entries) {
    const parts = entry.model.family ? versionLabelParts(entry.model.version) : null;
    entry.versionParts = parts;
    entry.groupLabel = parts ? `family:${entry.model.family}` : `model:${entry.model.id}`;
    entry.effectiveKey = entry.key;
    entry.inheritsFrom = null;
    if (!parts) continue;
    const group = JSON.stringify([entry.pool, entry.model.family]);
    if (!families.has(group)) families.set(group, []);
    families.get(group).push(entry);
  }
  for (const members of families.values()) {
    members.sort((a, b) => compareVersions(a.versionParts, b.versionParts));
    let best = null;
    for (let start = 0; start < members.length;) {
      let end = start;
      while (end < members.length
        && compareVersions(members[end].versionParts, members[start].versionParts) === 0) end += 1;
      // Members of one version do not inherit from each other (`x` and
      // `x[1m]`); each inherits only from strictly older versions.
      const batch = members.slice(start, end);
      for (const entry of batch) {
        if (best && compareKeys(best.key, entry.key) < 0) {
          entry.effectiveKey = best.key;
          entry.inheritsFrom = best.model;
        }
      }
      for (const entry of batch) {
        if (!best || compareKeys(entry.effectiveKey, best.key) < 0) {
          best = { key: entry.effectiveKey, model: entry.inheritsFrom ?? entry.model.id };
        }
      }
      start = end;
    }
  }
  return entries.sort((a, b) => compareKeys(a.effectiveKey, b.effectiveKey)
    || String(a.pool).localeCompare(String(b.pool))
    || a.groupLabel.localeCompare(b.groupLabel)
    || compareVersions(b.versionParts, a.versionParts)
    || a.model.id.localeCompare(b.model.id));
}

/** A pool's models by quality rank alone, newest first inside a family. */
function strongestFirst(connector, models) {
  return rankCandidates(models.map((model) => {
    const ranking = modelRanking(connector, model);
    return {
      pool: connector.name ?? '',
      model: { id: model, family: ranking.family, version: ranking.version },
      key: [ranking.qualityRank ?? 0],
    };
  })).map((entry) => entry.model.id);
}

/**
 * Resolve a model under the persisted routing policy. Once any model is
 * excluded, an implicit provider default is not trustworthy: Bullswarm pins
 * an allowed model through the connector-owned modelSelection flag, or marks
 * that pool ineligible when it cannot guarantee the policy.
 */
export function resolveDispatchModel(connector, tier, {
  assignment = null,
  excludedModels = [],
  allowedModels = null,
} = {}) {
  const excluded = normalizeExcludedModels(excludedModels);
  if (Array.isArray(allowedModels)) {
    const allowed = unique(allowedModels).filter((model) => !isModelExcluded(model, excluded));
    if (!allowed.length) return {
      eligible: false, model: null, source: 'tier-selection-empty',
      reason: `no enabled model is assigned to ${tier}`,
    };
    const configured = configuredModel(connector);
    const candidates = strongestFirst(connector, allowed);
    if (connector.modelSelection?.flag && candidates[0]) {
      return { eligible: true, model: candidates[0], source: 'tier-selection' };
    }
    if (configured && allowed.includes(configured)) {
      return { eligible: true, model: configured, source: 'tier-selection-configured' };
    }
    return {
      eligible: false, model: null, source: 'tier-selection-unsupported',
      reason: `connector ${connector.name} cannot select an assigned ${tier} model`,
    };
  }
  if (assignment?.pool === connector.name && !isModelExcluded(assignment.model, excluded)) {
    return { eligible: true, model: assignment.model, source: 'assignment' };
  }
  if (!excluded.length) return { eligible: true, model: null, source: 'connector-default' };

  const configured = configuredModel(connector);
  const candidates = strongestFirst(connector, unique([...(connector.knownModels ?? []), configured])
    .filter((model) => !isModelExcluded(model, excluded))
    .filter((model) => modelRanking(connector, model).tier === tier));

  // Never fall back onto a model the connector marks never-recommend (such as
  // a premium or double-price variant); the configured model comes next.
  const fallback = candidates.find((model) => modelRanking(connector, model).autoRecommend !== false);
  if (connector.modelSelection?.flag && fallback) {
    return { eligible: true, model: fallback, source: 'exclusion-safe-tier-fallback' };
  }
  if (configured && !isModelExcluded(configured, excluded)) {
    return { eligible: true, model: configured, source: 'configured-model' };
  }
  return {
    eligible: false,
    model: null,
    source: 'model-policy-blocked',
    reason: `cannot guarantee an allowed ${tier} model while exclusions are active`,
  };
}

// --- rungs -------------------------------------------------------------------
// A rung is ONE pool's model plus its reasoning level for ONE effort tier —
// the two halves an operator actually chooses together, read and written as
// one row. Nothing new is persisted: the model half stays in
// `strategy.modelTiers[pool][model]` and the reasoning half in
// `strategy.reasoning.pools[pool][tier]`, so a rung view is a projection of
// state that already exists and setRung() is the two existing writers applied
// together. No migration, no schema change.

/**
 * Pool name and effort tier for one decision-log entry. Every writer has used
 * a slightly different shape (`bullswarm run` records no effort tier at all;
 * the V2 dispatcher records it under `routing.effort`), so these mirror the
 * accessors in src/lib/spend.js — a rung's local record counts exactly the
 * attempts expectedMinutesFor() would price for that lane and tier.
 */
function decisionPool(entry) {
  return entry?.picked ?? entry?.pool ?? entry?.poolName ?? null;
}

function decisionEffort(entry) {
  return entry?.effort ?? entry?.effortTier
    ?? entry?.routing?.effort ?? entry?.routing?.effortTier ?? null;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What this machine actually recorded for one pool on one effort tier:
 * dispatch count, median wall minutes, and ok share. `null` when nothing
 * matched — an unmeasured rung is unknown, never zero (spend doctrine S3).
 * Wall time comes from spend.js's attemptWindow(), so an entry with no usable
 * duration still counts as a dispatch but contributes no minutes.
 */
export function rungRecord(decisionLog, pool, tier) {
  const rows = (Array.isArray(decisionLog) ? decisionLog : [])
    .filter((entry) => decisionPool(entry) === pool && decisionEffort(entry) === tier);
  if (!rows.length) return null;
  // A stall is a transport failure, not a real duration sample. The dispatcher
  // already drops these before it reads p50 for the free-pool silence clock;
  // excluding them here is what `bullswarm strategy` and `workflow usage`
  // display. `stalled: true` covers attempt-shaped rows that never got
  // failureKind. okShare is a separate filter — a stall is still a verdict.
  const stalled = (row) => row.stalled === true || row.failureKind === 'stalled';
  const minutes = [];
  for (const row of rows) {
    if (stalled(row)) continue;
    const window = attemptWindow(row);
    if (window) minutes.push(window.minutes);
  }
  // A dispatch someone stopped (a workflow cancel, a plan revision, a pause) is
  // not a verdict on the pool. Older rows carry no failureKind, only the
  // dispatcher's fixed cancellation message.
  const stopped = (row) => row.failureKind === 'cancelled' || row.why === 'workflow cancellation requested';
  const verdicts = rows.filter((row) => typeof row.ok === 'boolean' && !stopped(row));
  return {
    dispatches: rows.length,
    medianMinutes: minutes.length ? Math.round(medianOf(minutes) * 100) / 100 : null,
    okShare: verdicts.length
      ? Math.round((verdicts.filter((row) => row.ok).length / verdicts.length) * 1000) / 1000
      : null,
  };
}

/**
 * Adapt whatever the caller injected into one `(query) => row|null` lookup.
 * Accepts a plain function or the datapack module's own pair
 * (`{datapack, rungEvidence}`), so core never parses a datapack itself and a
 * missing datapack simply means every rung reports no evidence.
 */
function evidenceLookup(evidence) {
  if (typeof evidence === 'function') return evidence;
  if (evidence && typeof evidence.rungEvidence === 'function') {
    return (query) => evidence.rungEvidence(evidence.datapack ?? null, query);
  }
  return () => null;
}

/**
 * The one-line evidence summary for a rung, or '' when there is no evidence.
 * Callers that need a table cell add their own `no evidence` placeholder; the
 * setup wizard prints nothing at all, which is why this returns an empty
 * string rather than a label.
 */
export function formatRungEvidence(evidence) {
  if (!evidence) return '';
  const parts = [];
  // Display rounding only — the row keeps the datapack's own number.
  if (evidence.blended != null) parts.push(`blended ${Math.round(evidence.blended * 1000) / 1000}`);
  if (evidence.costPerTask != null) parts.push(`${formatMoney(evidence.costPerTask)}/task`);
  if (evidence.tokensPerTask != null) {
    const tokens = Number(evidence.tokensPerTask);
    parts.push(`${tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : Math.round(tokens)} tok/task`);
  }
  return parts.join(' \u00b7 ');
}

/** Keep only the three numbers a rung row reports, and only when real. */
function evidenceCells(row) {
  if (!row || typeof row !== 'object') return null;
  const cell = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  const cells = {
    blended: cell(row.blended),
    costPerTask: cell(row.costPerTask),
    tokensPerTask: cell(row.tokensPerTask),
  };
  return Object.values(cells).some((value) => value != null) ? cells : null;
}

/**
 * Every rung: one row per enabled pool and configured effort tier.
 *
 * @param {object} input
 * @param {Array<object>} input.pools        pool views from buildPools()
 * @param {object} [input.connectors]        name -> connector, for pool views without one
 * @param {object} [input.strategy]          core state.strategy
 * @param {Array<object>} [input.decisionLog] core state.decisionLog
 * @param {Function|object|null} [input.evidence] lookup or {datapack, rungEvidence}
 * @param {string|null} [input.pool]         limit to one pool
 */
export function rungsFor({
  pools = [],
  connectors = {},
  strategy = {},
  decisionLog = [],
  evidence = null,
  pool: only = null,
} = {}) {
  const lookup = evidenceLookup(evidence);
  const tiers = STRATEGY_TIERS.filter((tier) => (strategy?.configuredTiers ?? []).includes(tier));
  // A disabled pool cannot take a dispatch, so it has no rung. The packaged
  // echo test fixture is disabled unless someone enabled it on purpose, which
  // is the same rule `strategy inventory` uses to keep it out of sight.
  const visible = pools
    .filter((pool) => pool.enabled !== false)
    .filter((pool) => only == null || pool.name === only)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rows = [];
  for (const pool of visible) {
    const connector = pool.connector ?? connectors[pool.name] ?? pool;
    for (const tier of tiers) {
      const policy = resolveDispatchModel(connector, tier, {
        assignment: strategy?.assignments?.[tier] ?? null,
        excludedModels: [
          ...(strategy?.excludedModels ?? []),
          ...disabledModelsForPool(strategy, pool.name),
        ],
        allowedModels: selectedModelsForTier(strategy, pool.name, tier),
      });
      const reasoning = resolveReasoningLevel({
        connector, tier, model: policy.model, strategy: strategy ?? {},
      });
      let found = null;
      if (policy.model) {
        // Evidence is advisory: a broken or half-written datapack reports no
        // evidence rather than taking the whole rung table down with it.
        try {
          found = evidenceCells(lookup({
            pool: pool.name, tier, model: policy.model, reasoning: reasoning.applied,
          }));
        } catch { found = null; }
      }
      // Why a recommendation chose this level, where one did (RS7).
      const why = reasoning.source === 'recommendation'
        ? getRecommendedReasoning(strategy ?? {})[pool.name]?.[tier]?.why ?? null
        : null;
      rows.push({
        pool: pool.name,
        tier,
        model: policy.model,
        modelSource: policy.source,
        eligible: policy.eligible,
        reasoning: {
          applied: reasoning.applied,
          source: reasoning.source,
          requested: reasoning.requested,
          clamped: reasoning.clamped,
          ...(why ? { why } : {}),
        },
        evidence: found,
        record: rungRecord(decisionLog, pool.name, tier),
      });
    }
  }
  return rows;
}

/**
 * Write one rung into `strategy`: the pool's model selection for that tier
 * and, when a level is given, that pool+tier reasoning level. Pure — the
 * caller saves state exactly once, so a rung can never land half-written.
 * A rung is singular per pool and tier, so the tier moves off whichever model
 * held it before; the model's OTHER tiers are preserved.
 */
export function setRung(strategy, { pool, tier, model, reasoning = null } = {}) {
  if (!pool) throw new Error('setRung needs a pool');
  if (!model) throw new Error('setRung needs a model');
  assertReasoningTier(tier);
  if (reasoning != null) assertReasoningLevel(reasoning);
  strategy.modelTiers = normalizeModelTiers(strategy.modelTiers);
  for (const [other, tiers] of Object.entries(strategy.modelTiers[pool] ?? {})) {
    if (other === model || !tiers.includes(tier)) continue;
    setModelTierSelection(strategy, pool, other, tiers.filter((entry) => entry !== tier));
  }
  const existing = normalizeModelTiers(strategy.modelTiers)[pool]?.[model] ?? [];
  setModelTierSelection(strategy, pool, model, [...existing, tier]);
  if (reasoning != null) setStrategyReasoning(strategy, { tier, level: reasoning, pool });
  // A rung configures its tier. Without this the model half is inert
  // (configuredModel ignores tiers outside configuredTiers) and rungsFor
  // never lists the row; `strategy set-model` has always done the same.
  strategy.configuredTiers = [...new Set([...(strategy.configuredTiers ?? []), tier])];
  return strategy;
}

export function parseDiscoveredModels(output, discovery = {}) {
  const parse = discovery.parse ?? 'lines';
  const include = discovery.includePattern ? new RegExp(discovery.includePattern, 'i') : null;
  const ignore = discovery.ignorePattern ? new RegExp(discovery.ignorePattern, 'i') : null;
  const models = [];
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (parse === 'bullets') {
      const match = line.match(/^[*+-]\s+(.+)$/);
      if (!match) continue;
      line = match[1].trim().split(/\s+/)[0];
    }
    if (parse === 'columns') line = line.replace(/^[*+-]\s+/, '').split(/\s{2,}|\t/)[0].trim();
    if (ignore?.test(line) || (include && !include.test(line))) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/~-]*$/.test(line)) continue;
    models.push(line);
  }
  return unique(models).slice(0, Number(discovery.maxModels ?? 250));
}

// Asynchronous on purpose: discovery runs every connector at once, and a
// synchronous list command (some take 15 s or more) would freeze the event
// loop while the protocol handshakes of other providers wait on their timers.
function defaultExecutor(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      env: opts.env,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    // Match the old stdin: 'ignore' so a CLI never waits on an open pipe.
    child.stdin?.end();
  });
}

function normalizedDiscoveredModel(entry) {
  if (typeof entry === 'string') return { id: entry };
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;
  const id = entry.id.trim();
  return id ? { ...entry, id } : null;
}

export async function discoverConnectorModels(connector, {
  executor = defaultExecutor, provider = null, providerExecutor = null,
} = {}) {
  const discovery = connector.modelDiscovery ?? null;
  let discovered = [];
  let error = null;
  let command = discovery?.cmd ?? null;
  if (typeof provider?.module?.discoverModels === 'function') {
    try {
      const result = await provider.module.discoverModels(connector, {
        ...(provider.ctx ?? {}),
        ...(providerExecutor ? { executor: providerExecutor } : {}),
      });
      discovered = (result?.models ?? []).map(normalizedDiscoveredModel).filter(Boolean);
      command = result?.command ?? command;
    } catch (err) {
      error = err.message;
    }
  } else if (discovery?.cmd?.length) {
    try {
      const output = await executor(discovery.cmd[0], discovery.cmd.slice(1), {
        timeoutMs: Number(discovery.timeoutMs ?? 20_000),
        env: { ...process.env, ...(connector.env ?? {}) },
      });
      discovered = parseDiscoveredModels(output, discovery).map((id) => ({ id }));
    } catch (err) {
      error = err.message;
    }
  }
  const configured = configuredModel(connector);
  const fallback = discovered.length ? [] : unique([
    ...(connector.knownModels ?? []), configured,
  ]).map((id) => ({ id }));
  const seen = new Set();
  const models = [...discovered, ...fallback].filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((entry) => {
    const { id } = entry;
    const ranking = modelRanking(connector, id);
    const { profile } = ranking;
    return {
      ...entry,
      id,
      tier: ranking.tier,
      qualityRank: ranking.qualityRank,
      family: ranking.family,
      version: ranking.version,
      // `unranked`: the CLI reported it, but no family rule or profile gives
      // it a tier yet. Listed in the report, never recommended.
      ranking: ranking.ranking,
      rankSource: ranking.rankSource,
      benchmark: profile?.benchmark ?? null,
      benchmarkScore: finiteOr(profile?.benchmark?.score, null),
      pricing: profile?.pricing ?? null,
      pricingSource: profile?.pricingSource ?? null,
      pricingUpdatedAt: profile?.pricingUpdatedAt ?? null,
      autoRecommend: ranking.autoRecommend,
      free: isFreeModel(connector, id),
      configured: id === configured,
    };
  });
  return {
    pool: connector.name,
    source: discovered.length ? 'cli' : (connector.knownModels?.length ? 'connector-fallback' : 'configured-only'),
    command,
    error,
    models,
  };
}

function subscriptionView(pool, state) {
  const connector = pool.connector ?? pool;
  const declared = {
    ...(connector.subscription ?? {}),
    ...(state.strategy?.subscriptions?.[pool.name] ?? {}),
  };
  const snapshot = pool.meterSnapshot ?? null;
  const monthlyQuota = snapshot?.monthly_quota ?? null;
  const monthlyPriceUsd = declared.monthlyPriceUsd != null && Number.isFinite(Number(declared.monthlyPriceUsd))
    ? Number(declared.monthlyPriceUsd) : null;
  const includedValueUsd = declared.includedValueUsd != null && Number.isFinite(Number(declared.includedValueUsd))
    ? Number(declared.includedValueUsd) : null;
  return {
    pool: pool.name,
    plan: declared.plan ?? snapshot?.plan_type ?? null,
    monthlyPriceUsd,
    includedValueUsd,
    valueMultiple: monthlyPriceUsd > 0 && includedValueUsd != null
      ? Math.round((includedValueUsd / monthlyPriceUsd) * 100) / 100 : null,
    // `quotaWindow` is the label as declared (it may name several windows,
    // e.g. "weekly+monthly+5h"); `pacingWindow` is the one window routing
    // actually paces this pool by — see src/meters/framework.js.
    quotaWindow: declared.quotaWindow ?? pool.connector?.meter?.window ?? null,
    pacingWindow: pool.pacingWindow
      ?? pacingWindowFor({ connector, subscription: state.strategy?.subscriptions?.[pool.name] }),
    quota: monthlyQuota,
    meterSource: pool.meterSource ?? 'none',
    usedPct: pool.usedPct ?? null,
    elapsedPct: pool.elapsedPct ?? null,
    surplus: pool.pace ?? null,
    // The reset the pacing ran to and where it came from: 'provider' when the
    // meter reported it, 'declared' when the operator did (--resets-at).
    resetsAt: pool.paceResetsAt ?? null,
    resetSource: pool.resetSource ?? null,
    declaredResetsAt: declared.resetsAt ?? null,
    valueSource: state.strategy?.subscriptions?.[pool.name]
      ? 'user-declared' : connector.subscription ? 'connector-default' : 'unknown',
  };
}

function openRouterQuality(metadata) {
  const indices = metadata?.indices ?? {};
  if (['agentic', 'coding', 'intelligence'].some((dimension) => Number.isFinite(Number(indices[dimension])))) {
    return Number(indices.agentic ?? 0) * 5
      + Number(indices.coding ?? 0) * 4
      + Number(indices.intelligence ?? 0) * 2;
  }
  const ranks = metadata?.ranks ?? {};
  const score = (rank, weight) => Number.isFinite(Number(rank))
    ? Math.max(0, 101 - Number(rank)) * weight : 0;
  return score(ranks.agentic, 5)
    + score(ranks.coding, 4)
    + score(ranks.intelligence, 2)
    + score(ranks.popularity, 0.25);
}

function apiPrice(metadata) {
  const input = finiteOr(metadata?.pricing?.inputUsdPerMillion, null);
  const output = finiteOr(metadata?.pricing?.outputUsdPerMillion, null);
  if (input == null && output == null) return null;
  return (input ?? 0) + (output ?? 0);
}

function finiteOr(value, fallback) {
  if (value == null || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The comparison key of one model on one tier, best first (see "ranking"
 * above). Quality rank leads; the two benchmark kinds follow as tie-breaks;
 * then the tier's budget term from live pace and pool cost; API price last.
 * An unknown price loses only that last tie-break, and a newer family member
 * inherits its predecessor's key, so the unknown never costs it its place.
 */
function tierKey(model, pool, tier) {
  const rank = finiteOr(model.qualityRank, 0);
  // Presence in OpenRouter is availability evidence, not quality evidence:
  // only a real benchmark index or rank counts (externalQuality is null).
  const external = finiteOr(model.externalQuality, -Infinity);
  const declared = finiteOr(model.benchmarkScore, -Infinity);
  const pace = finiteOr(pool.pace, 0);
  const costRank = finiteOr(pool.costRank, 5);
  const free = model.free ? 1 : 0;
  const price = apiPrice(model) ?? apiPrice(model.openRouter);
  const cheapness = price == null ? -Infinity : -price;
  if (tier === 'high') return [rank, external, declared, pace - costRank, cheapness];
  if (tier === 'medium') return [rank, external, declared, pace * 2 - costRank * 5 + free * 10, cheapness];
  return [free, rank, external, declared, pace - costRank * 20, cheapness];
}

function enrichDiscoveries(discoveries, openRouterCatalog) {
  return Object.fromEntries(Object.entries(discoveries ?? {}).map(([pool, discovery]) => [pool, {
    ...discovery,
    models: (discovery.models ?? []).map((model) => {
      const external = openRouterMetadata(openRouterCatalog, model.id);
      const quality = openRouterQuality(external);
      return {
        ...model,
        ranking: model.ranking ?? (model.tier ? 'ranked' : 'unranked'),
        openRouter: external ? {
          id: external.id,
          indices: external.indices,
          ranks: external.ranks,
          pricing: external.pricing,
          pricingSource: external.pricingSource,
          created: external.created,
        } : null,
        externalQuality: quality > 0 ? Math.round(quality * 100) / 100 : null,
      };
    }),
  }]));
}

/** What a report says about one ranked candidate, and why it sits where it does. */
function candidateView(entry) {
  const { model } = entry;
  return {
    model: model.id,
    tier: model.tier ?? null,
    qualityRank: model.qualityRank ?? null,
    family: model.family ?? null,
    version: model.version ?? null,
    // The older family member whose standing this newer model took.
    inheritsFrom: entry.inheritsFrom,
    benchmarkScore: model.benchmarkScore ?? null,
    externalQuality: model.externalQuality ?? null,
    // A newest-generation stand-in for a stale family (see fallbackEntry).
    ...(entry.fallback ? { fallback: entry.fallback } : {}),
  };
}

/**
 * The recommendation a report stores for a tier's top candidate. A
 * newest-generation stand-in also carries the reasoning level it runs at and
 * why, which `applyStrategyRecommendations` writes as that pool's rung level.
 */
function recommendedView(entry, withPool) {
  if (!entry) return null;
  return {
    ...(withPool ? { pool: entry.pool } : {}),
    model: entry.model.id,
    ...(entry.fallback ? { reasoning: entry.fallback.reasoning, why: entry.fallback.reason } : {}),
  };
}

/**
 * A tier's newest-generation stand-in (model-family.js generationFallback)
 * as a ranked entry, or null when the connector does not opt the tier in or
 * the serving family is current.
 *
 * It takes the standing of the candidate it replaces — the pool's best for
 * the tier, normally the stale family's newest member — so pools and
 * families of other providers are compared exactly as before. One trailing
 * key component puts it directly above that candidate and moves nothing
 * else. With no candidate to replace, it stands at the stale family's rank.
 * A tier no family serves has no rank of its own there (0): the stand-in is
 * the pool's own pick for it, and the tier-wide pick only where no other pool
 * serves the tier.
 */
function fallbackEntry(pool, connector, eligible, tier, ranked, listed) {
  const found = generationFallback(connector, eligible, tier);
  if (!found) return null;
  const replaced = ranked[0] ?? null;
  // Nothing left to replace (the operator disabled the stale model): the
  // stand-in still speaks for the family, so it takes the standing of that
  // family's newest listed model, and only failing that the family's rank.
  const staleNewest = replaced || !found.staleFamily ? null : listed
    .filter((model) => model.family === found.staleFamily && model.tier === tier)
    .sort((a, b) => compareVersions(versionLabelParts(b.version), versionLabelParts(a.version)))[0] ?? null;
  const base = replaced?.effectiveKey
    ?? tierKey(staleNewest ?? { ...found.model, qualityRank: found.staleRank }, pool, tier);
  const reasoning = suggestedReasoningLevel(connector, found.model, found.reasoning ?? 'max');
  const entry = {
    pool: pool.name,
    poolView: pool,
    model: found.model,
    key: [...base, 1],
    fallback: {
      family: found.family,
      generation: found.generation,
      staleFamily: found.staleFamily,
      staleVersion: found.staleVersion,
      replaces: replaced?.model.id ?? staleNewest?.id ?? null,
      reasoning: reasoning.applied,
      reasoningClamped: reasoning.clamped,
      reason: found.reason,
    },
  };
  entry.effectiveKey = entry.key;
  entry.inheritsFrom = null;
  return entry;
}

function recommendationModels(pool, discovery) {
  const models = discovery?.models ?? [];
  const connector = pool.connector ?? pool;
  const providerId = connector.profile?.providerId ?? null;
  if (!providerId) return models;
  const prefix = `${providerId}/`;
  const configured = configuredModel(connector);
  return models.filter((model) => model.id.startsWith(prefix) || model.id === configured);
}

/**
 * Effort tier -> lane, DERIVED from the canonical lane/effort tables in
 * src/workflow/action-validator.js rather than restated here. Three tables
 * used to describe this one relation (audit B6/C1) and two of them disagreed.
 *
 * The canonical tables run lane -> effort, so inverting them needs a stated
 * rule, because the relation is not one-to-one — `analyze` and `build` both
 * default to `medium`, and no lane defaults to `high`:
 *
 *   1. The tier's lane is the lane KIND_DEFAULTS pairs with that effort most
 *      often. Two of the three `high` kinds (architecture,
 *      adversarial-acceptance) are `analyze`, so high -> analyze.
 *   2. A tie goes to the most specialised lane — the one with the fewest kinds
 *      overall. `analyze` and `build` have one `medium` kind each (check,
 *      implement), and `build` carries two kinds to `analyze`'s four, so
 *      medium -> build. Likewise low -> chore over `analyze`'s io-read.
 *   3. Remaining ties are alphabetical, so the map is total and stable.
 *
 * DEFAULT_EFFORT_BY_LANE supplies the lane universe, so a lane the validator
 * does not know can never appear in a tier context.
 */
// Kernel-owned kinds are excluded from the count above. A `digest` is written
// from a kernel template rather than an author's prompt, so it describes a
// mechanism, not a nature of work that should define which lane a tier routes
// to; counting it would flip low from chore to analyze on the strength of an
// action no planner has to reason about.
const KERNEL_OWNED_KINDS = new Set(['digest']);

function deriveTierLane(tier) {
  const lanes = new Set(Object.keys(DEFAULT_EFFORT_BY_LANE));
  const kinds = Object.entries(KIND_DEFAULTS)
    .filter(([name, kind]) => !KERNEL_OWNED_KINDS.has(name) && lanes.has(kind.lane))
    .map(([, kind]) => kind);
  const totalKinds = (lane) => kinds.filter((kind) => kind.lane === lane).length;
  const atTier = new Map();
  for (const kind of kinds) {
    if (kind.effort !== tier) continue;
    atTier.set(kind.lane, (atTier.get(kind.lane) ?? 0) + 1);
  }
  const ranked = [...atTier.entries()].sort(
    (a, b) => b[1] - a[1] || totalKinds(a[0]) - totalKinds(b[0]) || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

/** The derived tier -> lane map. Computed, never typed. */
export const TIER_LANES = Object.freeze(Object.fromEntries(
  STRATEGY_TIERS.map((tier) => [tier, deriveTierLane(tier)]),
));

/**
 * Per-tier routing context. The lane half is derived (above); the capability
 * half is strategy's own — nothing else declares which capabilities an effort
 * tier needs, so it stays stated here.
 */
export const TIER_CONTEXTS = {
  high: {
    lane: TIER_LANES.high,
    capabilities: ['strong-analysis', 'workflow-planning'],
    description: 'analysis and autonomous orchestration',
  },
  medium: {
    lane: TIER_LANES.medium,
    capabilities: ['code-reading', 'file-editing'],
    description: 'implementation and verification',
  },
  low: {
    lane: TIER_LANES.low,
    capabilities: [],
    description: 'bounded chores and low-cost work',
  },
};

function supportsContext(pool, context) {
  const lanes = pool.lanes ?? pool.connector?.lanes ?? [];
  const capabilities = pool.capabilities ?? pool.connector?.capabilities ?? [];
  return lanes.includes(context.lane)
    && context.capabilities.every((capability) => capabilities.includes(capability));
}

export function buildStrategy({ connectors, pools, state, discoveries, openRouterCatalog = null }) {
  const rankedDiscoveries = enrichDiscoveries(discoveries, openRouterCatalog);
  const subscriptions = pools.map((pool) => subscriptionView(pool, state));
  const tiers = ['high', 'medium', 'low'];
  const suggestions = {};
  const providerSuggestions = {};
  // pool -> tier -> the newest-generation stand-in, shared by both views.
  const fallbacks = {};
  for (const pool of pools) {
    providerSuggestions[pool.name] = {};
    fallbacks[pool.name] = {};
    const disabled = new Set([
      ...normalizeExcludedModels(state.strategy?.excludedModels),
      ...disabledModelsForPool(state.strategy, pool.name),
    ]);
    // What this pool may recommend on any tier; the newest generation is read
    // from these.
    const listed = recommendationModels(pool, rankedDiscoveries[pool.name]);
    const eligible = listed
      .filter((model) => model.tier
        && model.autoRecommend !== false
        && !disabled.has(model.id.toLowerCase()));
    for (const tier of tiers) {
      const context = TIER_CONTEXTS[tier];
      if (pool.enabled === false || pool.quarantine || pool.burstGate || !supportsContext(pool, context)) continue;
      const candidates = rankCandidates(eligible
        .filter((model) => model.tier === tier)
        .map((model) => ({ pool: pool.name, model, key: tierKey(model, pool, tier) })));
      const fallback = fallbackEntry(pool, pool.connector ?? pool, eligible, tier, candidates, listed);
      if (fallback) {
        fallbacks[pool.name][tier] = fallback;
        candidates.unshift(fallback);
      }
      providerSuggestions[pool.name][tier] = {
        recommended: recommendedView(candidates[0], false),
        candidates: candidates.map((entry) => ({
          ...candidateView(entry),
          openRouter: entry.model.openRouter,
        })),
      };
    }
  }
  // A model no family rule or profile classifies is still reported, by pool,
  // so a new CLI model is visible the day it appears. It has no tier, so no
  // tier's candidate list can ever recommend it.
  const unranked = pools.flatMap((pool) => recommendationModels(pool, rankedDiscoveries[pool.name])
    .filter((model) => !model.tier)
    .map((model) => ({
      pool: pool.name,
      model: model.id,
      ranking: 'unranked',
      reason: 'new model: no family rule or model profile gives it a tier yet',
    })));
  for (const tier of tiers) {
    const context = TIER_CONTEXTS[tier];
    const candidates = [];
    for (const pool of pools) {
      if (pool.enabled === false || pool.quarantine || pool.burstGate) continue;
      if (!supportsContext(pool, context)) continue;
      const discovery = rankedDiscoveries[pool.name];
      // The same exclusions the pool's own suggestion honours, so a tier is
      // never pinned to a model the operator turned off for that pool.
      const disabled = disabledModelsForPool(state.strategy, pool.name);
      for (const model of recommendationModels(pool, discovery)) {
        if (model.tier !== tier) continue;
        if (model.autoRecommend === false) continue;
        if (isModelExcluded(model.id, state.strategy?.excludedModels)) continue;
        if (disabled.includes(model.id.toLowerCase())) continue;
        candidates.push({ pool: pool.name, poolView: pool, model, key: tierKey(model, pool, tier) });
      }
      const fallback = fallbacks[pool.name]?.[tier];
      if (fallback) candidates.push({ ...fallback });
    }
    rankCandidates(candidates);
    const configured = state.strategy?.assignments?.[tier] ?? null;
    suggestions[tier] = {
      assignment: configured,
      recommended: recommendedView(candidates[0], true),
      requirements: context,
      candidates: candidates.slice(0, 8).map((candidate) => ({
        pool: candidate.pool,
        ...candidateView(candidate),
        benchmark: candidate.model.benchmark,
        free: candidate.model.free,
        pricing: candidate.model.pricing,
        pace: candidate.poolView.pace ?? null,
      })),
      basis: tier === 'high'
        ? 'analysis/workflow-planning capability, then quality rank (the newest version wins inside a family), benchmarks only to break equal ranks, then live quota surplus and cost rank'
        : tier === 'medium'
          ? 'build/editing capability, then quality rank (the newest version wins inside a family), benchmarks only to break equal ranks, then live quota surplus, cost rank, and API price'
          : 'chore capability and free models first, then quality rank (the newest version wins inside a family), benchmarks only to break equal ranks, then cost rank, live quota surplus, and API price',
    };
  }
  return {
    schemaVersion: 'bullswarm.strategy.v1',
    capturedAt: new Date().toISOString(),
    subscriptions,
    discoveries: rankedDiscoveries,
    suggestions,
    providerSuggestions,
    unranked,
    openRouter: openRouterCatalog ? {
      capturedAt: openRouterCatalog.capturedAt,
      source: openRouterCatalog.source,
      benchmarksSource: openRouterCatalog.upstream?.benchmarks ?? null,
      rankingsSource: openRouterCatalog.upstream?.rankings ?? null,
      cache: openRouterCatalog.cache,
      error: openRouterCatalog.error ?? null,
    } : null,
    excludedModels: normalizeExcludedModels(state.strategy?.excludedModels),
    caveats: [
      'Model availability comes from local CLI discovery plus connector fallbacks.',
      'Tier and quality rank come from connector family rules and model profiles; inside a family the newest version always ranks first.',
      'Benchmark and pricing fields come from the dated Bullswarm datapack or connector metadata.',
      'OpenRouter agentic, coding, and intelligence indices only break ties between models of equal quality rank.',
      'A discovered model no family rule or profile classifies is listed under unranked and never recommended.',
      'Where a connector opts a tier into generationFallback and the family serving it has no model in the newest generation, that tier takes the next-lower family\'s newest-generation model at the declared reasoning level; a tier no family serves takes the best-ranked family\'s newest model the same way.',
      'API-equivalent prices may not match subscription quota debits.',
      'Unknown license value, token counters, pricing, or benchmarks remain null; Bullswarm does not invent them.',
    ],
  };
}

export async function discoverAllModels(connectors, opts = {}) {
  const outputs = new Map();
  const baseExecutor = opts.executor ?? defaultExecutor;
  const memoizedExecutor = (command, args, execOpts) => {
    const key = JSON.stringify([command, args, execOpts?.timeoutMs, execOpts?.env]);
    // One run per distinct command, shared by every connector that asks for
    // it; the executor may answer synchronously (tests) or with a promise.
    if (!outputs.has(key)) {
      outputs.set(key, (async () => baseExecutor(command, args, execOpts))());
    }
    return outputs.get(key);
  };
  const entries = await Promise.all(Object.values(connectors).map(async (connector) => {
    const provider = opts.providers?.find((candidate) => candidate.pools?.includes(connector.name)) ?? null;
    const discovery = await discoverConnectorModels(connector, {
      executor: memoizedExecutor,
      provider,
      providerExecutor: opts.providerExecutors?.[provider?.name],
    });
    return [connector.name, discovery];
  }));
  return Object.fromEntries(entries);
}
