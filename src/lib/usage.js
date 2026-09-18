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
  let last = null;
  let lastIndex = -1;
  let found = false;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[,{\\s])["']?${escaped}["']?\\s*[:=]\\s*(\\d+)`, 'gi');
    for (const match of String(text ?? '').matchAll(re)) {
      // Provider streams repeat cumulative counters on every event and some
      // result objects contain the same counter under several nested aliases.
      // The final occurrence is the only trustworthy total; adding matches
      // triple-counts a single provider result (and sums cumulative events).
      const index = match.index ?? -1;
      if (index >= lastIndex) {
        last = Number(match[1]);
        lastIndex = index;
      }
      found = true;
    }
  }
  return found ? finiteNonNegative(last) : null;
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

function firstReportedValue(reported, keys) {
  for (const key of keys) {
    const value = finiteNonNegative(reported?.[key]);
    if (value != null) return value;
  }
  return null;
}

/** Normalize a connector-decoded usage object into the common field names. */
export function normalizeReportedUsage(reported) {
  if (!reported || typeof reported !== 'object') return null;
  const cacheWrite5m = firstReportedValue(reported, ['cacheWrite5m', 'cacheWrite5mTokens']);
  const cacheWrite1h = firstReportedValue(reported, ['cacheWrite1h', 'cacheWrite1hTokens']);
  const explicitCacheWrite = firstReportedValue(reported, ['cacheWrite', 'cacheWriteTokens']);
  const values = {
    standardRead: firstReportedValue(reported, ['standardRead', 'standardReadTokens']),
    cacheRead: firstReportedValue(reported, ['cacheRead', 'cacheReadTokens']),
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite: explicitCacheWrite ?? (cacheWrite5m != null || cacheWrite1h != null
      ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
      : null),
    output: firstReportedValue(reported, ['output', 'outputTokens']),
    costUsd: firstReportedValue(reported, ['costUsd', 'totalCostUsd', 'total_cost_usd']),
    sessionId: typeof reported.sessionId === 'string' && reported.sessionId ? reported.sessionId : null,
    model: typeof reported.model === 'string' && reported.model ? reported.model : null,
  };
  const present = Object.values(values).some((value) => value != null);
  if (!present) return null;
  const source = ['provider-reported', 'transcript-summed'].includes(reported.tokenSource)
    ? reported.tokenSource
    : null;
  return source ? { ...values, tokenSource: source } : values;
}

/**
 * One definition of "this model costs nothing", for routing (R12), for the
 * model recommendation score, and for the pool view. The connector's own
 * `modelProfiles[].free` declaration is authoritative; the name pattern is the
 * fallback for a discovered model no profile matched (`openrouter/x:free`).
 * It is deliberately narrow — a bare "free" inside a word never matches.
 */
export function isFreeModel(connector, model) {
  const id = String(model ?? connector?.model ?? '');
  if (!id) return false;
  return modelProfile(connector, id)?.free === true
    || /(?:^|[/:-])free(?:$|[/:-])/i.test(id);
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
  reportedUsage = null,
} = {}) {
  const structured = normalizeReportedUsage(reportedUsage);
  const reported = structured ?? normalizeReportedUsage(parseReportedUsage(outputText));
  const structuredReported = structured != null;
  const hasTextForEstimate = (typeof taskText === 'string' && taskText.length > 0)
    || (typeof outputText === 'string' && outputText.length > 0);
  const tokens = {
    standardRead: reported?.standardRead ?? (structuredReported ? null : estimateTextTokens(taskText)),
    cacheRead: reported?.cacheRead ?? null,
    cacheWrite5m: reported?.cacheWrite5m ?? null,
    cacheWrite1h: reported?.cacheWrite1h ?? null,
    cacheWrite: reported?.cacheWrite ?? null,
    output: reported?.output ?? (structuredReported ? null : estimateTextTokens(outputText)),
  };
  if (tokens.cacheWrite == null && (tokens.cacheWrite5m != null || tokens.cacheWrite1h != null)) {
    tokens.cacheWrite = (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0);
  }
  const totalFields = [tokens.standardRead, tokens.cacheRead, tokens.output];
  if (tokens.cacheWrite5m != null || tokens.cacheWrite1h != null) {
    totalFields.push(tokens.cacheWrite5m, tokens.cacheWrite1h);
  } else {
    totalFields.push(tokens.cacheWrite);
  }
  tokens.totalKnown = totalFields.reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0), 0,
  );

  const selectedModel = model ?? connector.model ?? null;
  const profile = modelProfile(connector, selectedModel);
  const pricing = profile?.pricing ?? null;
  const cacheWrite5mRate = pricing?.cacheWrite5mUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion;
  const cacheWrite1hRate = pricing?.cacheWrite1hUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion;
  const cacheWrite5mUsd = tokenCost(tokens.cacheWrite5m, cacheWrite5mRate);
  const cacheWrite1hUsd = tokenCost(tokens.cacheWrite1h, cacheWrite1hRate);
  const cacheWriteParts = [cacheWrite5mUsd, cacheWrite1hUsd].filter((value) => value != null);
  const cacheWriteUsd = cacheWriteParts.length
    ? cacheWriteParts.reduce((sum, value) => sum + value, 0)
    : tokenCost(tokens.cacheWrite, pricing?.cacheWriteUsdPerMillion);
  const costs = pricing ? {
    standardReadUsd: tokenCost(tokens.standardRead, pricing.inputUsdPerMillion),
    cacheReadUsd: tokenCost(tokens.cacheRead, pricing.cacheReadUsdPerMillion),
    cacheWrite5mUsd,
    cacheWrite1hUsd,
    cacheWriteUsd,
    outputUsd: tokenCost(tokens.output, pricing.outputUsdPerMillion),
  } : null;
  const knownCosts = costs
    ? [costs.standardReadUsd, costs.cacheReadUsd, costs.cacheWriteUsd, costs.outputUsd]
      .filter((value) => value != null)
    : [];
  const locallyPricedUsd = knownCosts.length ? roundMoney(knownCosts.reduce((a, b) => a + b, 0)) : null;
  const providerBilledUsd = structured?.costUsd ?? null;
  const estimatedCostUsd = providerBilledUsd ?? locallyPricedUsd;
  if (costs) for (const key of Object.keys(costs)) costs[key] = roundMoney(costs[key]);

  const pricedFields = [];
  if (costs?.standardReadUsd != null) pricedFields.push('standardRead');
  if (costs?.cacheReadUsd != null) pricedFields.push('cacheRead');
  if (costs?.cacheWriteUsd != null) pricedFields.push('cacheWrite');
  if (costs?.outputUsd != null) pricedFields.push('output');
  const costSource = providerBilledUsd != null
    ? 'provider-billed'
    : locallyPricedUsd != null ? 'local-rate-card' : null;

  const includedValueUsd = finiteNonNegative(subscription?.includedValueUsd);
  const quotaPercent = estimatedCostUsd != null && includedValueUsd > 0
    ? roundPct((estimatedCostUsd / includedValueUsd) * 100)
    : null;

  return {
    model: selectedModel,
    tokens,
    tokenSource: structured?.tokenSource
      ?? (reported ? 'provider-reported' : hasTextForEstimate ? 'estimated:utf8-bytes/4' : 'unknown'),
    sessionId: structured?.sessionId ?? null,
    costSource,
    pricedFields,
    pricing: pricing ? {
      ...pricing,
      source: profile?.pricingSource ?? null,
      updatedAt: profile?.pricingUpdatedAt ?? null,
    } : null,
    cost: {
      estimatedUsd: estimatedCostUsd,
      breakdown: costs,
      basis: costSource === 'provider-billed'
        ? 'provider-billed total_cost_usd'
        : costSource === 'local-rate-card'
          ? 'local rate card; subscription debit may differ'
          : 'unknown: no model rate metadata',
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
