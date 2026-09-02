// Model discovery and tiered subscription strategy.
// Discovery commands, parsing quirks, tier rules, and dated pricing live in
// connector JSON. Core only executes and normalizes those declarations.

import { execFileSync } from 'node:child_process';
import { modelProfile } from './usage.js';
import { openRouterMetadata } from './openrouter-models.js';

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

function configuredModel(connector) {
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
    quotaWindow: declared.quotaWindow ?? pool.connector?.meter?.window ?? null,
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

export const TIER_CONTEXTS = {
  high: {
    lane: 'analyze',
    capabilities: ['strong-analysis', 'workflow-planning'],
    description: 'analysis and autonomous orchestration',
  },
  medium: {
    lane: 'build',
    capabilities: ['code-reading', 'file-editing'],
    description: 'implementation and verification',
  },
  low: {
    lane: 'chore',
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
