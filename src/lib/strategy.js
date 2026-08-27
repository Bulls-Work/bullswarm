// Model discovery and tiered subscription strategy.
// Discovery commands, parsing quirks, tier rules, and dated pricing live in
// connector JSON. Core only executes and normalizes those declarations.

import { execFileSync } from 'node:child_process';
import { modelProfile } from './usage.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
  const configured = (() => {
    if (connector.model) return connector.model;
    const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
    return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
  })();
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
  const quality = candidate.model.benchmarkScore ?? candidate.model.qualityRank ?? 0;
  const pace = Number.isFinite(candidate.pool.pace) ? candidate.pool.pace : 0;
  const costRank = Number(candidate.pool.costRank ?? 5);
  const freeBonus = candidate.model.free ? 1 : 0;
  if (tier === 'high') return quality * 100 + pace - costRank;
  if (tier === 'medium') return quality * 50 + pace * 2 - costRank * 5 + freeBonus * 10;
  return freeBonus * 200 - costRank * 20 + quality * 10 + pace;
}

export function buildStrategy({ connectors, pools, state, discoveries }) {
  const subscriptions = pools.map((pool) => subscriptionView(pool, state));
  const tiers = ['high', 'medium', 'low'];
  const suggestions = {};
  for (const tier of tiers) {
    const candidates = [];
    for (const pool of pools) {
      if (pool.enabled === false || pool.quarantine || pool.burstGate) continue;
      const discovery = discoveries[pool.name];
      for (const model of discovery?.models ?? []) {
        if (model.tier !== tier) continue;
        candidates.push({ pool, model, score: 0 });
      }
    }
    for (const candidate of candidates) candidate.score = candidateScore(candidate, tier);
    candidates.sort((a, b) => b.score - a.score || a.pool.name.localeCompare(b.pool.name) || a.model.id.localeCompare(b.model.id));
    const configured = state.strategy?.assignments?.[tier] ?? null;
    suggestions[tier] = {
      assignment: configured,
      recommended: candidates[0] ? { pool: candidates[0].pool.name, model: candidates[0].model.id } : null,
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
        ? 'dated benchmark score when declared (quality rank fallback), then live quota surplus and cost rank'
        : tier === 'medium'
          ? 'balanced dated benchmark or quality rank, live quota surplus, and cost rank'
          : 'free/low-cost first, then dated benchmark or quality rank and live quota surplus',
    };
  }
  return {
    schemaVersion: 'bullswarm.strategy.v1',
    capturedAt: new Date().toISOString(),
    subscriptions,
    discoveries,
    suggestions,
    caveats: [
      'Model availability comes from local CLI discovery plus connector fallbacks.',
      'Benchmark and pricing fields are used only when connector metadata provides a dated source.',
      'API-equivalent prices may not match subscription quota debits.',
      'Unknown license value, token counters, pricing, or benchmarks remain null; Bullswarm does not invent them.',
    ],
  };
}

export function discoverAllModels(connectors, opts = {}) {
  return Object.fromEntries(Object.values(connectors).map((connector) => [
    connector.name,
    discoverConnectorModels(connector, opts),
  ]));
}
