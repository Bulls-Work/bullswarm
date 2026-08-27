// Transparent invocation usage estimates.
//
// Provider CLIs are inconsistent about exposing token accounting. Prefer
// reported counters when present; otherwise use a visibly-labelled UTF-8
// byte estimate. Pricing is connector/model metadata so provider quirks and
// dated rate cards never leak into core routing logic.

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function lastCounter(text, names) {
  let found = null;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[,{\\s])["']?${escaped}["']?\\s*[:=]\\s*(\\d+)`, 'gi');
    for (const match of String(text ?? '').matchAll(re)) found = Number(match[1]);
  }
  return finiteNonNegative(found);
}

export function parseReportedUsage(text) {
  const standardReadTokens = lastCounter(text, [
    'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens',
  ]);
  const cacheReadTokens = lastCounter(text, [
    'cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens',
  ]);
  const cacheWriteTokens = lastCounter(text, [
    'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_tokens',
  ]);
  const outputTokens = lastCounter(text, [
    'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens',
  ]);
  const present = [standardReadTokens, cacheReadTokens, cacheWriteTokens, outputTokens]
    .some((value) => value != null);
  return present
    ? { standardReadTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
    : null;
}

export function modelProfile(connector, model) {
  const id = String(model ?? connector?.model ?? '');
  for (const profile of connector?.modelProfiles ?? []) {
    if (profile.id && profile.id === id) return profile;
    if (profile.match) {
      try {
        if (new RegExp(profile.match, 'i').test(id)) return profile;
      } catch { /* invalid user-edited profile is ignored */ }
    }
  }
  return null;
}

function tokenCost(tokens, usdPerMillion) {
  const count = finiteNonNegative(tokens);
  const rate = finiteNonNegative(usdPerMillion);
  return count == null || rate == null ? null : (count / 1_000_000) * rate;
}

function roundMoney(value) {
  return value == null ? null : Math.round(value * 1e8) / 1e8;
}

function roundPct(value) {
  return value == null ? null : Math.round(value * 10_000) / 10_000;
}

export function estimateInvocationUsage({
  taskText = '', outputText = '', connector = {}, model = null, subscription = null,
} = {}) {
  const reported = parseReportedUsage(outputText);
  const tokens = {
    standardRead: reported?.standardReadTokens ?? estimateTextTokens(taskText),
    cacheRead: reported?.cacheReadTokens ?? null,
    cacheWrite: reported?.cacheWriteTokens ?? null,
    output: reported?.outputTokens ?? estimateTextTokens(outputText),
  };
  tokens.totalKnown = Object.values(tokens).reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0), 0,
  );

  const selectedModel = model ?? connector.model ?? null;
  const profile = modelProfile(connector, selectedModel);
  const pricing = profile?.pricing ?? null;
  const costs = pricing ? {
    standardReadUsd: tokenCost(tokens.standardRead, pricing.inputUsdPerMillion),
    cacheReadUsd: tokenCost(tokens.cacheRead, pricing.cacheReadUsdPerMillion),
    cacheWriteUsd: tokenCost(tokens.cacheWrite, pricing.cacheWriteUsdPerMillion),
    outputUsd: tokenCost(tokens.output, pricing.outputUsdPerMillion),
  } : null;
  const knownCosts = costs ? Object.values(costs).filter((value) => value != null) : [];
  const estimatedCostUsd = knownCosts.length ? roundMoney(knownCosts.reduce((a, b) => a + b, 0)) : null;
  if (costs) for (const key of Object.keys(costs)) costs[key] = roundMoney(costs[key]);

  const includedValueUsd = finiteNonNegative(subscription?.includedValueUsd);
  const quotaPercent = estimatedCostUsd != null && includedValueUsd > 0
    ? roundPct((estimatedCostUsd / includedValueUsd) * 100)
    : null;

  return {
    model: selectedModel,
    tokens,
    tokenSource: reported ? 'provider-reported' : 'estimated:utf8-bytes/4',
    pricing: pricing ? {
      ...pricing,
      source: profile?.pricingSource ?? null,
      updatedAt: profile?.pricingUpdatedAt ?? null,
    } : null,
    cost: {
      estimatedUsd: estimatedCostUsd,
      breakdown: costs,
      basis: pricing ? 'api-equivalent rate; subscription debit may differ' : 'unknown: no model rate metadata',
    },
    normalizedQuota: {
      estimatedPercent: quotaPercent,
      window: subscription?.quotaWindow ?? null,
      includedValueUsd,
      basis: estimatedCostUsd == null
        ? 'unknown: invocation cost is unavailable'
        : includedValueUsd == null || includedValueUsd <= 0
          ? 'unknown: set subscription includedValueUsd to normalize usage'
        : 'estimated API-equivalent cost / declared included subscription value',
    },
  };
}

export function aggregateUsage(attempts = []) {
  const usages = attempts.map((attempt) => attempt?.usage).filter(Boolean);
  const attemptsMissingUsage = attempts.length - usages.length;
  const sumNullable = (path) => {
    const values = usages.map((usage) => path(usage)).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const tokens = {
    standardRead: sumNullable((u) => u.tokens?.standardRead),
    cacheRead: sumNullable((u) => u.tokens?.cacheRead),
    cacheWrite: sumNullable((u) => u.tokens?.cacheWrite),
    output: sumNullable((u) => u.tokens?.output),
    totalKnown: sumNullable((u) => u.tokens?.totalKnown),
  };
  const knownCostSubtotal = sumNullable((u) => u.cost?.estimatedUsd);
  const costComplete = attempts.length > 0
    && attemptsMissingUsage === 0
    && usages.every((u) => Number.isFinite(u.cost?.estimatedUsd));
  const knownNormalizedSubtotal = sumNullable((u) => u.normalizedQuota?.estimatedPercent);
  const quotaComplete = attempts.length > 0
    && attemptsMissingUsage === 0
    && usages.every((u) => Number.isFinite(u.normalizedQuota?.estimatedPercent));
  return {
    attempts: attempts.length,
    attemptsWithUsage: usages.length,
    attemptsMissingUsage,
    tokens,
    cost: {
      estimatedUsd: costComplete ? roundMoney(knownCostSubtotal) : null,
      knownSubtotalUsd: knownCostSubtotal == null ? null : roundMoney(knownCostSubtotal),
      complete: costComplete,
      basis: costComplete
        ? 'sum of all attempt estimates'
        : attemptsMissingUsage > 0
          ? 'partial: one or more attempts ended without usage evidence'
          : 'partial: one or more attempts lack model rate metadata',
    },
    normalizedQuota: {
      estimatedPercent: quotaComplete ? roundPct(knownNormalizedSubtotal) : null,
      knownSubtotalPercent: knownNormalizedSubtotal == null ? null : roundPct(knownNormalizedSubtotal),
      complete: quotaComplete,
      basis: quotaComplete
        ? 'sum of all per-attempt normalized estimates'
        : attemptsMissingUsage > 0
          ? 'partial: one or more attempts ended without usage evidence'
          : 'partial: one or more attempts lack cost or declared subscription value',
    },
  };
}
