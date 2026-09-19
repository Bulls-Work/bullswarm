// Transparent invocation usage estimates.
//
// Provider CLIs are inconsistent about exposing token accounting. Prefer
// reported counters when present; otherwise use a visibly-labelled UTF-8
// byte estimate. Pricing is connector/model metadata so provider quirks and
// dated rate cards never leak into core routing logic.

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === ''
    || typeof value === 'boolean' || Array.isArray(value)
    || (typeof value === 'string' && value.trim() === '')) return null;
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

function parseReportedReasoning(text) {
  return lastCounter(text, [
    'reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning_tokens',
    'reasoningTokens', 'thinking_tokens', 'thinkingTokens',
  ]);
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
  const reasoning = firstReportedValue(reported, [
    'reasoning', 'reasoningTokens', 'reasoning_tokens', 'thinkingTokens', 'thinking_tokens',
  ]);
  const values = {
    standardRead: firstReportedValue(reported, ['standardRead', 'standardReadTokens']),
    cacheRead: firstReportedValue(reported, ['cacheRead', 'cacheReadTokens']),
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite: cacheWrite5m != null || cacheWrite1h != null
      ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
      : explicitCacheWrite,
    // Keep the provider's inclusive counter here. `normalizeTokens` applies
    // the exclusive reasoning subtraction exactly once at the canonical
    // record boundary.
    output: firstReportedValue(reported, ['output', 'outputTokens']),
    reasoning,
    costUsd: firstReportedValue(reported, ['costUsd', 'totalCostUsd', 'total_cost_usd']),
    sessionId: typeof reported.sessionId === 'string' && reported.sessionId ? reported.sessionId : null,
    model: typeof reported.model === 'string' && reported.model ? reported.model : null,
  };
  const present = Object.values(values).some((value) => value != null);
  if (!present) return null;
  const source = ['provider-reported', 'transcript-summed'].includes(reported.tokenSource)
    ? reported.tokenSource
    : null;
  const normalized = source ? { ...values, tokenSource: source } : values;
  if (reported.outputIsExclusive === true || reported.tokenSource === 'transcript-summed') {
    normalized.outputIsExclusive = true;
  }
  return normalized;
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

function tokenSum(tokens) {
  const values = [tokens.standardRead, tokens.cacheRead, tokens.output, tokens.reasoning];
  if (tokens.cacheWrite5m != null || tokens.cacheWrite1h != null) {
    values.push(tokens.cacheWrite5m, tokens.cacheWrite1h);
  } else {
    values.push(tokens.cacheWrite);
  }
  const known = values.filter((value) => value != null && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function normalizeTokens(source) {
  if (!source || typeof source !== 'object') return null;
  const cacheWrite5m = finiteNonNegative(source.cacheWrite5m ?? source.cacheWrite5mTokens);
  const cacheWrite1h = finiteNonNegative(source.cacheWrite1h ?? source.cacheWrite1hTokens);
  const directCacheWrite = finiteNonNegative(source.cacheWrite ?? source.cacheWriteTokens);
  const reasoning = finiteNonNegative(
    source.reasoning ?? source.reasoningTokens ?? source.reasoning_tokens
      ?? source.thinkingTokens ?? source.thinking_tokens,
  );
  const inclusiveOutput = finiteNonNegative(source.output ?? source.outputTokens);
  const output = source.outputIsExclusive === true || inclusiveOutput == null || reasoning == null
    ? inclusiveOutput
    : Math.max(0, inclusiveOutput - reasoning);
  const cacheWrite = cacheWrite5m != null || cacheWrite1h != null
    ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
    : directCacheWrite;
  const tokens = {
    standardRead: finiteNonNegative(source.standardRead ?? source.standardReadTokens),
    cacheRead: finiteNonNegative(source.cacheRead ?? source.cacheReadTokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite,
    output,
    reasoning,
    totalKnown: null,
  };
  tokens.totalKnown = tokenSum(tokens);
  return tokens;
}

function tokenFields(tokens) {
  const fields = [
    ['standardRead', tokens.standardRead],
    ['cacheRead', tokens.cacheRead],
    ['output', tokens.output],
    ['reasoning', tokens.reasoning],
  ];
  if (tokens.cacheWrite5m != null || tokens.cacheWrite1h != null) {
    fields.push(['cacheWrite5m', tokens.cacheWrite5m], ['cacheWrite1h', tokens.cacheWrite1h]);
  } else {
    fields.push(['cacheWrite', tokens.cacheWrite]);
  }
  return fields;
}

const BREAKDOWN_NAME = {
  standardRead: 'standardReadUsd',
  cacheRead: 'cacheReadUsd',
  cacheWrite5m: 'cacheWrite5mUsd',
  cacheWrite1h: 'cacheWrite1hUsd',
  cacheWrite: 'cacheWriteUsd',
  output: 'outputUsd',
  reasoning: 'reasoningUsd',
};

function contextPricing(pricing, contextTier) {
  if (contextTier !== 'long') return pricing;
  const nested = pricing?.longContext ?? pricing?.long ?? pricing?.contextTiers?.long;
  if (nested && typeof nested === 'object') return { ...pricing, ...nested };
  const flat = {};
  for (const [base, aliases] of Object.entries({
    inputUsdPerMillion: ['longInputUsdPerMillion', 'inputUsdPerMillionLongContext'],
    cacheReadUsdPerMillion: ['longCacheReadUsdPerMillion', 'cacheReadUsdPerMillionLongContext'],
    cacheWrite5mUsdPerMillion: ['longCacheWrite5mUsdPerMillion', 'cacheWrite5mUsdPerMillionLongContext'],
    cacheWrite1hUsdPerMillion: ['longCacheWrite1hUsdPerMillion', 'cacheWrite1hUsdPerMillionLongContext'],
    cacheWriteUsdPerMillion: ['longCacheWriteUsdPerMillion', 'cacheWriteUsdPerMillionLongContext'],
    outputUsdPerMillion: ['longOutputUsdPerMillion', 'outputUsdPerMillionLongContext'],
    reasoningUsdPerMillion: ['longReasoningUsdPerMillion', 'reasoningUsdPerMillionLongContext'],
  })) {
    const key = aliases.find((candidate) => pricing?.[candidate] != null);
    if (key) flat[base] = pricing[key];
  }
  return Object.keys(flat).length ? { ...pricing, ...flat } : null;
}

function oneRequestBreakdown(tokens, pricing) {
  const breakdown = {
    standardReadUsd: tokenCost(tokens.standardRead, pricing?.inputUsdPerMillion),
    cacheReadUsd: tokenCost(tokens.cacheRead, pricing?.cacheReadUsdPerMillion),
    cacheWrite5mUsd: tokenCost(tokens.cacheWrite5m,
      pricing?.cacheWrite5mUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion),
    cacheWrite1hUsd: tokenCost(tokens.cacheWrite1h,
      pricing?.cacheWrite1hUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion),
    cacheWriteUsd: null,
    outputUsd: tokenCost(tokens.output, pricing?.outputUsdPerMillion),
    reasoningUsd: tokenCost(tokens.reasoning,
      pricing?.reasoningUsdPerMillion ?? pricing?.outputUsdPerMillion),
  };
  if (tokens.cacheWrite5m == null && tokens.cacheWrite1h == null) {
    breakdown.cacheWriteUsd = tokenCost(tokens.cacheWrite, pricing?.cacheWriteUsdPerMillion);
  } else if (breakdown.cacheWrite5mUsd != null && breakdown.cacheWrite1hUsd != null) {
    breakdown.cacheWriteUsd = breakdown.cacheWrite5mUsd + breakdown.cacheWrite1hUsd;
  }
  return breakdown;
}

function requestPricing(tokens, pricing, requests) {
  if (!Array.isArray(requests) || requests.length === 0) return null;
  const sums = Object.fromEntries(Object.values(BREAKDOWN_NAME).map((name) => [name, 0]));
  const seen = new Set();
  const unpriced = new Set();
  for (const request of requests) {
    const requestTokens = normalizeTokens({ ...(request?.tokens ?? {}), outputIsExclusive: true });
    if (!requestTokens) continue;
    const rates = contextPricing(pricing, request.contextTier);
    const costs = oneRequestBreakdown(requestTokens, rates);
    for (const [field, count] of tokenFields(requestTokens)) {
      if (count == null) continue;
      const key = BREAKDOWN_NAME[field];
      if (costs[key] == null) {
        if (count > 0) unpriced.add(field);
      } else {
        seen.add(field);
        sums[key] += costs[key];
      }
    }
  }
  const breakdown = Object.fromEntries(Object.values(BREAKDOWN_NAME).map((key) => [key, null]));
  for (const field of Object.keys(BREAKDOWN_NAME)) {
    const key = BREAKDOWN_NAME[field];
    if (unpriced.has(field)) breakdown[key] = null;
    else if (seen.has(field)) breakdown[key] = roundMoney(sums[key]);
  }
  return { breakdown, unpriced };
}

function apiPricing(tokens, pricing, profile, selectedModel, requests = null) {
  const breakdown = {
    standardReadUsd: tokenCost(tokens.standardRead, pricing?.inputUsdPerMillion),
    cacheReadUsd: tokenCost(tokens.cacheRead, pricing?.cacheReadUsdPerMillion),
    cacheWrite5mUsd: tokenCost(tokens.cacheWrite5m,
      pricing?.cacheWrite5mUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion),
    cacheWrite1hUsd: tokenCost(tokens.cacheWrite1h,
      pricing?.cacheWrite1hUsdPerMillion ?? pricing?.cacheWriteUsdPerMillion),
    cacheWriteUsd: null,
    outputUsd: tokenCost(tokens.output, pricing?.outputUsdPerMillion),
    reasoningUsd: tokenCost(tokens.reasoning,
      pricing?.reasoningUsdPerMillion ?? pricing?.outputUsdPerMillion),
  };
  if (tokens.cacheWrite5m == null && tokens.cacheWrite1h == null) {
    breakdown.cacheWriteUsd = tokenCost(tokens.cacheWrite, pricing?.cacheWriteUsdPerMillion);
  } else if (breakdown.cacheWrite5mUsd != null && breakdown.cacheWrite1hUsd != null) {
    breakdown.cacheWriteUsd = breakdown.cacheWrite5mUsd + breakdown.cacheWrite1hUsd;
  }
  for (const key of Object.keys(breakdown)) breakdown[key] = roundMoney(breakdown[key]);

  const pricedFields = [];
  const unpricedFields = [];
  const requestCosts = requestPricing(tokens, pricing, requests);
  if (requestCosts) Object.assign(breakdown, requestCosts.breakdown);
  const breakdownName = BREAKDOWN_NAME;
  for (const [field, count] of tokenFields(tokens)) {
    if (count == null) continue;
    if (requestCosts?.unpriced.has(field)) unpricedFields.push(field);
    else if (breakdown[breakdownName[field]] != null) pricedFields.push(field);
    else unpricedFields.push(field);
  }
  const positiveUnpriced = tokenFields(tokens).some(([field, count]) => (
    count != null && count > 0 && !pricedFields.includes(field)
  ));
  const knownCosts = tokenFields(tokens)
    .map(([field]) => breakdown[breakdownName[field]])
    .filter((value) => value != null);
  const usd = tokens.totalKnown == null || positiveUnpriced
    ? null
    : roundMoney(knownCosts.reduce((sum, value) => sum + value, 0));
  const basis = !selectedModel
    ? 'unknown:no-model'
    : !pricing
      ? 'unknown:no-rate-card'
      : positiveUnpriced
        ? 'rate-card:partial'
        : tokens.totalKnown == null
          ? 'unknown:no-rate-card'
          : 'rate-card:complete';
  const api = {
    usd,
    breakdown,
    pricedFields,
    unpricedFields,
    rateCard: {
      source: profile?.pricingSource ?? pricing?.source ?? null,
      updatedAt: profile?.pricingUpdatedAt ?? pricing?.updatedAt ?? null,
    },
    basis,
  };
  return api;
}

function compatibilitySubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const snapshot = (value) => (value && typeof value === 'object' ? value : null);
  return {
    pool: typeof subscription.pool === 'string' ? subscription.pool : null,
    window: subscription.window ?? subscription.quotaWindow ?? null,
    deltaPct: finiteNonNegative(subscription.deltaPct),
    usd: finiteNonNegative(subscription.usd),
    monthlyPriceUsd: finiteNonNegative(subscription.monthlyPriceUsd),
    windowDays: finiteNonNegative(subscription.windowDays),
    basis: typeof subscription.basis === 'string' ? subscription.basis : 'unknown:no-meter',
    snapshots: {
      start: snapshot(subscription.snapshots?.start ?? subscription.start),
      end: snapshot(subscription.snapshots?.end ?? subscription.end),
    },
  };
}

function computedSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const computed = Object.hasOwn(subscription, 'basis')
    || Object.hasOwn(subscription, 'deltaPct')
    || Object.hasOwn(subscription, 'usd')
    || Object.hasOwn(subscription, 'snapshots')
    || Object.hasOwn(subscription, 'windowDays');
  return computed ? compatibilitySubscription(subscription) : null;
}

function buildUsage({
  taskText = '', outputText = '', connector = {}, model = null, subscription = null,
  reportedUsage = null, sessionId = null, forceTokenSource = null, requests = null,
} = {}) {
  const structured = normalizeReportedUsage(reportedUsage);
  const parsed = parseReportedUsage(outputText);
  const parsedReasoning = parseReportedReasoning(outputText);
  const parsedWithReasoning = parsed
    ? { ...parsed, reasoning: parsedReasoning }
    : null;
  const reported = structured ?? normalizeReportedUsage(parsedWithReasoning);
  const structuredReported = structured != null;
  const hasTextForEstimate = (typeof taskText === 'string' && taskText.length > 0)
    || (typeof outputText === 'string' && outputText.length > 0);
  let tokens = reported
    ? normalizeTokens(reported)
    : normalizeTokens({
      standardRead: structuredReported || typeof taskText !== 'string' || taskText.length === 0
        ? null : estimateTextTokens(taskText),
      output: structuredReported || typeof outputText !== 'string' || outputText.length === 0
        ? null : estimateTextTokens(outputText),
    });
  if (!tokens) tokens = normalizeTokens({});

  const selectedModel = model ?? structured?.model ?? connector.model ?? null;
  const profile = modelProfile(connector, selectedModel);
  const pricing = profile?.pricing ?? null;
  const tokenSource = forceTokenSource
    ?? structured?.tokenSource
    ?? (reported ? 'provider-reported' : hasTextForEstimate ? 'estimated:utf8-bytes/4' : 'unknown');
  const api = apiPricing(tokens, pricing, profile, selectedModel,
    requests ?? reportedUsage?.requests ?? null);
  // The non-enumerable hint lets the shared formatter render the token basis
  // while keeping the documented API block shape stable for JSON consumers.
  Object.defineProperty(api, 'tokenSource', {
    value: tokenSource, enumerable: false, configurable: true,
  });
  const canonicalSubscription = computedSubscription(subscription);
  const includedValueUsd = finiteNonNegative(subscription?.includedValueUsd);
  const legacyPercent = api.usd != null && includedValueUsd != null && includedValueUsd > 0
    ? roundPct((api.usd / includedValueUsd) * 100)
    : null;
  const subscriptionPercent = canonicalSubscription ? canonicalSubscription.deltaPct : legacyPercent;
  const canonical = {
    model: selectedModel,
    sessionId: structured?.sessionId ?? sessionId ?? null,
    tokens,
    tokenSource,
    api,
    subscription: canonicalSubscription,
    // Compatibility aliases retained for older state/report readers.
    pricing: pricing ? {
      ...pricing,
      source: profile?.pricingSource ?? pricing?.source ?? null,
      updatedAt: profile?.pricingUpdatedAt ?? pricing?.updatedAt ?? null,
    } : null,
    costSource: api.usd != null ? 'local-rate-card' : null,
    pricedFields: api.pricedFields,
    cost: {
      estimatedUsd: api.usd,
      breakdown: api.breakdown,
      basis: api.basis,
    },
    normalizedQuota: {
      estimatedPercent: subscriptionPercent,
      window: canonicalSubscription?.window ?? subscription?.quotaWindow ?? null,
      includedValueUsd,
      basis: canonicalSubscription?.basis
        ?? (api.usd == null
          ? 'unknown: invocation cost is unavailable'
          : includedValueUsd == null || includedValueUsd <= 0
            ? 'unknown: set subscription includedValueUsd to normalize usage'
            : 'estimated API-equivalent cost / declared included subscription value'),
    },
  };
  // Attach the original connector as a private recalculation hint.  This is
  // deliberately non-enumerable and therefore never leaks into durable JSON.
  Object.defineProperty(canonical, '_pricingContext', {
    value: { connector, model: selectedModel }, enumerable: false, configurable: true,
  });
  return canonical;
}

export function estimateInvocationUsage(options = {}) {
  return buildUsage(options);
}

/** Replace an estimate/provider record with authoritative transcript totals. */
export function attachTranscriptUsage(record, transcriptResult) {
  if (!record || typeof record !== 'object' || !transcriptResult?.tokens) return record;
  const context = record._pricingContext ?? {
    connector: {
      model: record.model,
      modelProfiles: record.pricing ? [{
        id: record.model,
        pricing: Object.fromEntries(Object.entries(record.pricing)
          .filter(([key]) => key.endsWith('UsdPerMillion'))),
        pricingSource: record.api?.rateCard?.source ?? null,
        pricingUpdatedAt: record.api?.rateCard?.updatedAt ?? null,
      }] : [],
    },
    model: record.model,
  };
  return buildUsage({
    connector: context.connector,
    model: transcriptResult.model ?? context.model ?? record.model ?? null,
    sessionId: transcriptResult.sessionId ?? record.sessionId ?? null,
    subscription: record.subscription,
    reportedUsage: {
      ...transcriptResult.tokens,
      outputIsExclusive: true,
      requests: transcriptResult.requests,
      model: transcriptResult.model ?? record.model ?? null,
      sessionId: transcriptResult.sessionId ?? record.sessionId ?? null,
      tokenSource: 'transcript-summed',
    },
    forceTokenSource: 'transcript-summed',
    requests: transcriptResult.requests ?? null,
  });
}
