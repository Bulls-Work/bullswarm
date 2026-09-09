// Model discovery and tiered subscription strategy.
// Discovery commands, parsing quirks, tier rules, and dated pricing live in
// connector JSON. Core only executes and normalizes those declarations.

import { execFileSync } from 'node:child_process';
import { modelProfile } from './usage.js';
import { openRouterMetadata } from './openrouter-models.js';
import { isReasoningLevel, REASONING_LEVELS, resolveReasoningLevel } from './reasoning.js';
import { attemptWindow } from './spend.js';
import { pacingWindowFor } from '../meters/framework.js';
// The canonical lane/effort tables. Imported, never restated: see
// TIER_CONTEXTS below for the tier -> lane derivation they feed.
import { DEFAULT_EFFORT_BY_LANE, KIND_DEFAULTS } from '../workflow/action-validator.js';

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

/** Set (level) or remove (level null) one tier level, globally or per pool. */
export function setStrategyReasoning(strategy, { tier, level, pool = null } = {}) {
  assertReasoningTier(tier);
  if (level != null) assertReasoningLevel(level);
  const reasoning = getStrategyReasoning(strategy);
  const target = pool ? (reasoning.pools[pool] ??= {}) : reasoning.tiers;
  if (level == null) delete target[tier];
  else target[tier] = level;
  return storeStrategyReasoning(strategy, reasoning);
}

/** Clear everything (no arguments), one pool, one tier, or one pool+tier. */
export function clearStrategyReasoning(strategy, { tier = null, pool = null } = {}) {
  if (tier != null) assertReasoningTier(tier);
  if (tier == null && pool == null) {
    delete strategy.reasoning;
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
  return storeStrategyReasoning(strategy, reasoning);
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
    const candidates = allowed
      .map((model) => ({ model, profile: modelProfile(connector, model) }))
      .sort((a, b) => Number(b.profile?.qualityRank ?? 0) - Number(a.profile?.qualityRank ?? 0)
        || a.model.localeCompare(b.model));
    if (connector.modelSelection?.flag && candidates[0]) {
      return { eligible: true, model: candidates[0].model, source: 'tier-selection' };
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
  const candidates = unique([...(connector.knownModels ?? []), configured])
    .filter((model) => !isModelExcluded(model, excluded))
    .map((model) => ({ model, profile: modelProfile(connector, model) }))
    .filter((candidate) => candidate.profile?.tier === tier)
    .sort((a, b) => Number(b.profile?.qualityRank ?? 0) - Number(a.profile?.qualityRank ?? 0));

  if (connector.modelSelection?.flag && candidates[0]) {
    return { eligible: true, model: candidates[0].model, source: 'exclusion-safe-tier-fallback' };
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
  const minutes = [];
  for (const row of rows) {
    const window = attemptWindow(row);
    if (window) minutes.push(window.minutes);
  }
  const verdicts = rows.filter((row) => typeof row.ok === 'boolean');
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
  if (evidence.costPerTask != null) parts.push(`$${Math.round(evidence.costPerTask * 100) / 100}/task`);
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

function defaultExecutor(command, args, opts) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function discoverConnectorModels(connector, { executor = defaultExecutor } = {}) {
  const discovery = connector.modelDiscovery ?? null;
  let discovered = [];
  let error = null;
  if (discovery?.cmd?.length) {
    try {
      const output = executor(discovery.cmd[0], discovery.cmd.slice(1), {
        timeoutMs: Number(discovery.timeoutMs ?? 20_000),
      });
      discovered = parseDiscoveredModels(output, discovery);
    } catch (err) {
      error = err.message;
    }
  }
  const configured = configuredModel(connector);
  const models = unique([
    ...discovered,
    ...(connector.knownModels ?? []),
    configured,
  ]).map((id) => {
    const profile = modelProfile(connector, id);
    return {
      id,
      tier: profile?.tier ?? null,
      qualityRank: Number.isFinite(Number(profile?.qualityRank)) ? Number(profile.qualityRank) : null,
      benchmark: profile?.benchmark ?? null,
      benchmarkScore: Number.isFinite(Number(profile?.benchmark?.score)) ? Number(profile.benchmark.score) : null,
      pricing: profile?.pricing ?? null,
      pricingSource: profile?.pricingSource ?? null,
      pricingUpdatedAt: profile?.pricingUpdatedAt ?? null,
      autoRecommend: profile?.autoRecommend !== false,
      free: profile?.free === true || /(?:^|[/:-])free(?:$|[/:-])/i.test(id),
      configured: id === configured,
    };
  });
  return {
    pool: connector.name,
    source: discovered.length ? 'cli' : (connector.knownModels?.length ? 'connector-fallback' : 'configured-only'),
    command: discovery?.cmd ?? null,
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
    valueSource: state.strategy?.subscriptions?.[pool.name]
      ? 'user-declared' : connector.subscription ? 'connector-default' : 'unknown',
  };
}

function candidateScore(candidate, tier) {
  // Core never invents or scrapes benchmark comparisons. A connector may
  // declare a dated score from a comparable harness; otherwise use its coarse
  // quality rank as the explicit fallback.
  const quality = candidate.model.recommendationScore
    ?? candidate.model.benchmarkScore ?? candidate.model.qualityRank ?? 0;
  const pace = Number.isFinite(candidate.pool.pace) ? candidate.pool.pace : 0;
  const costRank = Number(candidate.pool.costRank ?? 5);
  const freeBonus = candidate.model.free ? 1 : 0;
  if (tier === 'high') return quality * 100 + pace - costRank;
  if (tier === 'medium') return quality * 50 + pace * 2 - costRank * 5 + freeBonus * 10;
  return freeBonus * 200 - costRank * 20 + quality * 10 + pace;
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
  const input = Number(metadata?.pricing?.inputUsdPerMillion);
  const output = Number(metadata?.pricing?.outputUsdPerMillion);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

function recommendationScore(model, tier) {
  const external = model.openRouter ?? null;
  const externalQuality = openRouterQuality(external);
  const quality = Number(model.benchmarkScore ?? model.qualityRank ?? 0);
  const price = apiPrice(external);
  // Presence in OpenRouter is availability evidence, not quality evidence.
  // Only an actual benchmark index/rank may outrank connector-owned quality.
  const benchmarkedExternally = externalQuality > 0 ? 1 : 0;
  if (tier === 'high') return benchmarkedExternally * 1_000_000 + externalQuality * 1_000 + quality * 10;
  if (tier === 'medium') return benchmarkedExternally * 1_000_000 + externalQuality * 500 + quality * 20 - (price ?? 0) * 5;
  return Number(model.free) * 2_000_000 + benchmarkedExternally * 1_000_000
    + externalQuality * 50 + quality * 20 - (price ?? 0) * 100;
}

function enrichDiscoveries(discoveries, openRouterCatalog) {
  return Object.fromEntries(Object.entries(discoveries ?? {}).map(([pool, discovery]) => [pool, {
    ...discovery,
    models: (discovery.models ?? []).map((model) => {
      const external = openRouterMetadata(openRouterCatalog, model.id);
      const tier = model.tier;
      return {
        ...model,
        openRouter: external ? {
          id: external.id,
          indices: external.indices,
          ranks: external.ranks,
          pricing: external.pricing,
          pricingSource: external.pricingSource,
          created: external.created,
        } : null,
        recommendationScore: recommendationScore({ ...model, openRouter: external }, tier),
      };
    }),
  }]));
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
  for (const pool of pools) {
    providerSuggestions[pool.name] = {};
    const disabled = new Set([
      ...normalizeExcludedModels(state.strategy?.excludedModels),
      ...disabledModelsForPool(state.strategy, pool.name),
    ]);
    for (const tier of tiers) {
      const context = TIER_CONTEXTS[tier];
      if (pool.enabled === false || pool.quarantine || pool.burstGate || !supportsContext(pool, context)) continue;
      const candidates = recommendationModels(pool, rankedDiscoveries[pool.name])
        .filter((model) => model.tier === tier
          && model.autoRecommend !== false
          && !disabled.has(model.id.toLowerCase()))
        .sort((a, b) => b.recommendationScore - a.recommendationScore || a.id.localeCompare(b.id));
      providerSuggestions[pool.name][tier] = {
        recommended: candidates[0] ? { model: candidates[0].id } : null,
        candidates: candidates.map((model) => ({
          model: model.id,
          score: Math.round(model.recommendationScore * 10) / 10,
          qualityRank: model.qualityRank,
          openRouter: model.openRouter,
        })),
      };
    }
  }
  for (const tier of tiers) {
    const context = TIER_CONTEXTS[tier];
    const candidates = [];
    for (const pool of pools) {
      if (pool.enabled === false || pool.quarantine || pool.burstGate) continue;
      if (!supportsContext(pool, context)) continue;
      const discovery = rankedDiscoveries[pool.name];
      for (const model of recommendationModels(pool, discovery)) {
        if (model.tier !== tier) continue;
        if (model.autoRecommend === false) continue;
        if (isModelExcluded(model.id, state.strategy?.excludedModels)) continue;
        candidates.push({ pool, model, score: 0 });
      }
    }
    for (const candidate of candidates) candidate.score = candidateScore(candidate, tier);
    candidates.sort((a, b) => b.score - a.score || a.pool.name.localeCompare(b.pool.name) || a.model.id.localeCompare(b.model.id));
    const configured = state.strategy?.assignments?.[tier] ?? null;
    suggestions[tier] = {
      assignment: configured,
      recommended: candidates[0] ? { pool: candidates[0].pool.name, model: candidates[0].model.id } : null,
      requirements: context,
      candidates: candidates.slice(0, 8).map((candidate) => ({
        pool: candidate.pool.name,
        model: candidate.model.id,
        qualityRank: candidate.model.qualityRank,
        benchmark: candidate.model.benchmark,
        benchmarkScore: candidate.model.benchmarkScore,
        free: candidate.model.free,
        pricing: candidate.model.pricing,
        pace: candidate.pool.pace ?? null,
        score: Math.round(candidate.score * 10) / 10,
      })),
      basis: tier === 'high'
        ? 'analysis/workflow-planning capability, then dated benchmark score (quality rank fallback), live quota surplus, and cost rank'
        : tier === 'medium'
          ? 'build/editing capability, then balanced dated benchmark or quality rank, live quota surplus, and cost rank'
          : 'chore capability and free/low-cost first, then dated benchmark or quality rank and live quota surplus',
    };
  }
  return {
    schemaVersion: 'bullswarm.strategy.v1',
    capturedAt: new Date().toISOString(),
    subscriptions,
    discoveries: rankedDiscoveries,
    suggestions,
    providerSuggestions,
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
      'Benchmark and pricing fields come from the dated Bullswarm datapack or connector metadata.',
      'OpenRouter agentic, coding, and intelligence indices drive external quality comparisons.',
      'API-equivalent prices may not match subscription quota debits.',
      'Unknown license value, token counters, pricing, or benchmarks remain null; Bullswarm does not invent them.',
    ],
  };
}

export function discoverAllModels(connectors, opts = {}) {
  const outputs = new Map();
  const baseExecutor = opts.executor ?? defaultExecutor;
  const memoizedExecutor = (command, args, execOpts) => {
    const key = JSON.stringify([command, args, execOpts?.timeoutMs]);
    if (outputs.has(key)) {
      const cached = outputs.get(key);
      if (cached.error) throw cached.error;
      return cached.output;
    }
    try {
      const output = baseExecutor(command, args, execOpts);
      outputs.set(key, { output });
      return output;
    } catch (error) {
      outputs.set(key, { error });
      throw error;
    }
  };
  return Object.fromEntries(Object.values(connectors).map((connector) => [
    connector.name,
    discoverConnectorModels(connector, { executor: memoizedExecutor }),
  ]));
}
