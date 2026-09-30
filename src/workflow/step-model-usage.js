// Token and money normalisation for the Step page: one attempt's usage record
// as a token-class and API/subscription money pair, and the sum over an
// action's attempts with its coverage (metrics.js M2).

import { finiteOrNull } from '../lib/num.js';
import { formatMoneyPair } from '../lib/usage-basis.js';
import { coverageSum } from './metrics.js';
import { hasOwn, textOrNull, clone } from './step-model-values.js';

const TOKEN_FIELDS = [
  'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite',
  'output', 'reasoning',
];

function normalizeTokens(usage) {
  const source = usage?.tokens && typeof usage.tokens === 'object' ? usage.tokens : usage;
  const tokens = {};
  for (const field of TOKEN_FIELDS) tokens[field] = finiteOrNull(source?.[field]);
  const explicitTotal = finiteOrNull(source?.totalKnown);
  const known = [
    tokens.standardRead,
    tokens.cacheRead,
    tokens.output,
    tokens.reasoning,
    ...(tokens.cacheWrite5m != null || tokens.cacheWrite1h != null
      ? [tokens.cacheWrite5m, tokens.cacheWrite1h]
      : [tokens.cacheWrite]),
  ].filter((value) => value != null);
  tokens.totalKnown = explicitTotal ?? (known.length ? known.reduce((sum, value) => sum + value, 0) : null);
  return tokens;
}

function normalizeMoney(usage) {
  const value = usage && typeof usage === 'object' ? usage : {};
  const apiInput = value.api && typeof value.api === 'object' ? value.api : null;
  const legacyApi = value.apiUsd ?? value.apiEquivalentUsd ?? value.cost?.estimatedUsd;
  const apiUsd = finiteOrNull(apiInput && hasOwn(apiInput, 'usd') ? apiInput.usd : legacyApi);
  const api = {
    usd: apiUsd,
    knownSubtotalUsd: apiUsd,
    basis: textOrNull(apiInput?.basis) ?? textOrNull(value.cost?.basis) ?? (apiUsd == null ? 'unknown' : 'legacy'),
    breakdown: clone(apiInput?.breakdown ?? value.cost?.breakdown ?? null),
    pricedFields: Array.isArray(apiInput?.pricedFields) ? [...apiInput.pricedFields] : [],
    unpricedFields: Array.isArray(apiInput?.unpricedFields) ? [...apiInput.unpricedFields] : [],
    rateCard: clone(apiInput?.rateCard ?? null),
    rateCards: clone(apiInput?.rateCards ?? (apiInput?.rateCard ? [apiInput.rateCard] : [])),
  };
  const subInput = value.subscription && typeof value.subscription === 'object'
    ? value.subscription
    : (hasOwn(value, 'subscriptionUsd') || hasOwn(value, 'subscriptionBasis')
      ? {
        usd: value.subscriptionUsd,
        deltaPct: value.subscriptionDeltaPct ?? value.deltaPct,
        window: value.subscriptionWindow ?? value.window,
        basis: value.subscriptionBasis,
      }
      : null);
  const subscription = {
    pool: textOrNull(subInput?.pool),
    window: textOrNull(subInput?.window),
    deltaPct: finiteOrNull(subInput?.deltaPct),
    usd: finiteOrNull(subInput?.usd),
    knownSubtotalUsd: finiteOrNull(subInput?.usd),
    monthlyPriceUsd: finiteOrNull(subInput?.monthlyPriceUsd),
    windowDays: finiteOrNull(subInput?.windowDays),
    basis: textOrNull(subInput?.basis) ?? 'unknown:no-meter',
    snapshots: clone(subInput?.snapshots ?? null),
  };
  const tokenSource = textOrNull(value.tokenSource) ?? 'unknown';
  return {
    api,
    subscription,
    tokenSource,
    normalizedQuota: clone(value.normalizedQuota ?? null),
    pricing: clone(value.pricing ?? api.rateCard ?? null),
    display: formatMoneyPair({ api, subscription, tokenSource }),
    tokens: normalizeTokens(value),
    raw: clone(usage ?? null),
  };
}

export function normalizeAttemptUsage(usage) {
  return normalizeMoney(usage);
}

function aggregateUsageModels(attempts) {
  const records = attempts.map((attempt) => attempt?.usageModel).filter(Boolean);
  if (!records.length) return normalizeAttemptUsage(null);
  if (records.length === 1) return records[0];

  const sumField = (source, field) => {
    const values = records.map((record) => finiteOrNull(record?.[source]?.[field])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const sumToken = (field) => {
    const values = records.map((record) => finiteOrNull(record.tokens?.[field])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const tokenSourceValues = [...new Set(records.map((record) => record.tokenSource).filter((value) => value && value !== 'unknown'))];
  const tokenSource = tokenSourceValues.length === 1 ? tokenSourceValues[0] : tokenSourceValues.length ? 'mixed' : 'unknown';
  const tokens = Object.fromEntries([...TOKEN_FIELDS, 'totalKnown'].map((field) => [field, sumToken(field)]));
  // The money over the attempts, with coverage (metrics.js M2).
  const apiMoney = coverageSum(records.map((record) => record.api?.usd));
  const subscriptionMoney = coverageSum(records.map((record) => record.subscription?.usd));
  const apiKnownSubtotalUsd = apiMoney.subtotal;
  const subscriptionKnownSubtotalUsd = subscriptionMoney.subtotal;
  const apiUsd = apiMoney.whole;
  const subscriptionUsd = subscriptionMoney.whole;
  const deltaPct = sumField('subscription', 'deltaPct');
  const subscriptionPools = [];
  const subscriptionPoolByName = new Map();
  for (const record of records) {
    const source = record.subscription ?? {};
    const name = textOrNull(source.pool) ?? 'pool';
    let pool = subscriptionPoolByName.get(name);
    if (!pool) {
      pool = {
        name,
        monthlyPriceUsd: null,
        window: textOrNull(source.window),
        windowDays: finiteOrNull(source.windowDays),
        basis: textOrNull(source.basis) ?? 'unknown:no-meter',
      };
      subscriptionPoolByName.set(name, pool);
      subscriptionPools.push(pool);
    }
    const price = finiteOrNull(source.monthlyPriceUsd);
    if (pool.monthlyPriceUsd == null && price != null) pool.monthlyPriceUsd = price;
  }
  const namedPools = records.map((record) => textOrNull(record.subscription?.pool));
  const sameNamedPool = namedPools.length > 0
    && namedPools.every((name) => name != null && name === namedPools[0]);
  const monthlyPriceUsd = sameNamedPool
    ? finiteOrNull(subscriptionPools.find((pool) => pool.name === namedPools[0])?.monthlyPriceUsd)
    : null;
  const apiBreakdown = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record.api?.breakdown ?? {})) {
      const number = finiteOrNull(value);
      if (number != null) apiBreakdown[key] = (apiBreakdown[key] ?? 0) + number;
    }
  }
  const firstSubscription = records.find((record) => record.subscription?.pool || record.subscription?.window)?.subscription;
  const apiBases = [...new Set(records.map((record) => record.api?.basis).filter(Boolean))];
  const subscriptionBases = [...new Set(records.map((record) => record.subscription?.basis).filter(Boolean))];
  const rateCards = [];
  const seenRateCards = new Set();
  for (const record of records) {
    for (const card of record.api?.rateCards ?? (record.api?.rateCard ? [record.api.rateCard] : [])) {
      const key = `${textOrNull(card?.source) ?? ''}|${textOrNull(card?.updatedAt) ?? ''}`;
      if (seenRateCards.has(key)) continue;
      seenRateCards.add(key);
      rateCards.push(clone(card));
    }
  }
  const api = {
    usd: apiUsd,
    knownSubtotalUsd: apiKnownSubtotalUsd,
    basis: apiBases.length === 1 && apiUsd != null ? apiBases[0] : apiUsd == null ? 'unknown: incomplete attempts' : 'aggregate',
    breakdown: Object.keys(apiBreakdown).length ? apiBreakdown : null,
    pricedFields: [...new Set(records.flatMap((record) => record.api?.pricedFields ?? []))],
    unpricedFields: [...new Set(records.flatMap((record) => record.api?.unpricedFields ?? []))],
    rateCard: clone(records.find((record) => record.api?.rateCard)?.api.rateCard ?? null),
    rateCards,
  };
  const subscription = {
    pool: textOrNull(firstSubscription?.pool),
    window: textOrNull(firstSubscription?.window),
    deltaPct,
    usd: subscriptionUsd,
    knownSubtotalUsd: subscriptionKnownSubtotalUsd,
    monthlyPriceUsd,
    pools: subscriptionPools,
    windowDays: finiteOrNull(firstSubscription?.windowDays),
    basis: subscriptionBases.length === 1 && subscriptionUsd != null
      ? subscriptionBases[0]
      : subscriptionUsd == null ? 'unknown:no-meter' : 'aggregate',
    snapshots: clone(records.find((record) => record.subscription?.snapshots)?.subscription.snapshots ?? null),
  };
  return {
    api,
    subscription,
    tokenSource,
    normalizedQuota: clone(records.find((record) => record.normalizedQuota)?.normalizedQuota ?? null),
    pricing: clone(records.find((record) => record.pricing)?.pricing ?? api.rateCard ?? null),
    display: formatMoneyPair({ api, subscription, tokenSource }),
    tokens,
    raw: records.map((record) => clone(record.raw)),
  };
}

export {
  normalizeTokens,
  aggregateUsageModels,
};
