// The Step page's two plain-word cost rows: the API rate row and the plan
// row, their amounts, headlines, details and phone text, and the closing
// basis line.

import { finiteOrNull } from '../lib/num.js';
import {
  rateCardVendor,
  apiBasisWords,
  subscriptionBasisWords,
  subscriptionWindowWords,
  tokenSourceNoun,
} from './step-model-basis-words.js';
import { stepDayText, stepTokenText, stepMoneyText } from './step-model-text.js';
import { textOrNull, dateMs } from './step-model-values.js';

/**
 * An exact amount prints plain: the provider's own token counts (reported or
 * summed from its transcript) priced at a complete rate card. A rate card
 * without every field priced or a byte estimate carries `≈`; an amount nobody
 * recorded stays a dash with the reason.
 */
function apiAmountIsExact(api, tokenSource) {
  const basis = textOrNull(api?.basis) ?? '';
  if (basis === 'rate-card:complete') return true;
  if (basis === 'provider-reported' || tokenSource === 'provider-reported') return true;
  return false;
}

/** Why an attempt has no API price, in the words the owner can act on. */
function unpricedReason(api, tokens, { short = false } = {}) {
  if (finiteOrNull(tokens?.totalKnown) == null) return short ? 'not priced · no tokens' : 'not priced · no token counts recorded';
  if (textOrNull(api?.basis) === 'unknown:no-rate-card') {
    return short ? 'not priced · no rate card'
      : 'not priced · no rate card for this model yet (bullswarm workflow reprice fills it in)';
  }
  return 'not priced';
}

function monthlyPriceText(value) {
  const price = finiteOrNull(value);
  return price == null ? '—' : `$${Number(price.toFixed(2))}/mo`;
}

function usageRecordsForAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt) => attempt?.usageModel)
    .filter(Boolean);
}

/** The dated rate-card vendors represented by every recorded attempt. */
function aggregateRateCardWords(api, attempts) {
  const records = usageRecordsForAttempts(attempts);
  const cards = [];
  const seen = new Set();
  for (const record of records) {
    const card = record.api?.rateCard;
    if (!card) continue;
    const vendor = rateCardVendor(card) ?? textOrNull(record.subscription?.pool) ?? 'model';
    const key = `${vendor}|${textOrNull(card.source) ?? ''}|${textOrNull(card.updatedAt) ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ card, vendor });
  }
  if (!cards.length) return apiBasisWords(api.basis, api.rateCard, null);
  const vendors = [...new Set(cards.map((entry) => entry.vendor))];
  const latest = cards
    .map((entry) => dateMs(entry.card.updatedAt))
    .filter((value) => value != null)
    .sort((a, b) => b - a)[0];
  const noun = vendors.length === 1 ? 'rate card' : 'rate cards';
  return `${vendors.join(' + ')} ${noun}${latest == null ? '' : `, ${stepDayText(latest)}`}`;
}

function poolPriceWords(subscription) {
  const pools = Array.isArray(subscription?.pools) ? subscription.pools : [];
  if (!pools.length) return null;
  return pools.map((pool) => `${pool.name ?? 'pool'} ${monthlyPriceText(pool.monthlyPriceUsd)}`).join(' · ');
}

function selectedAttemptShare(selected) {
  const usage = selected?.usageModel;
  if (!usage) return null;
  const api = usage.api ?? {};
  const amount = stepMoneyText(api.usd, { estimated: !apiAmountIsExact(api, usage.tokenSource) });
  const total = finiteOrNull(usage.tokens?.totalKnown);
  const tokens = total == null
    ? null
    : total >= 1_000_000
      ? `${(total / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`
      : stepTokenText(total);
  const basis = apiBasisWords(api.basis, api.rateCard, usage.subscription?.pool, { includeDate: false });
  return `this attempt ${amount}${tokens ? ` · ${tokens} tokens` : ''}${basis ? ` · ${basis}` : ''}`;
}

function costRows(moneyInput, { running = false, attempts = [], selected = null } = {}) {
  const money = moneyInput?.pair ?? {};
  const api = money.api ?? {};
  const subscription = money.subscription ?? {};
  const tokens = moneyInput?.tokens ?? money.tokens ?? {};
  const tokenSource = textOrNull(moneyInput?.tokenSource ?? money.tokenSource);
  const attemptRecords = usageRecordsForAttempts(attempts);
  const attemptCount = Array.isArray(attempts) && attempts.length
    ? attempts.length
    : finiteOrNull(moneyInput?.attemptCount) ?? 1;
  const poolKeys = [...new Set(attemptRecords.map((record) => textOrNull(record.subscription?.pool) ?? 'pool'))];
  const multiplePools = attemptCount > 1 && poolKeys.length > 1;
  const pending = Boolean(moneyInput?.pending) && (api.usd == null || tokens.totalKnown == null);
  const pool = textOrNull(subscription.pool ?? moneyInput?.pool);
  const totalText = stepTokenText(tokens.totalKnown);
  const apiBasis = attemptCount > 1
    ? aggregateRateCardWords(api, attempts)
    : apiBasisWords(api.basis, api.rateCard, pool);
  const headline = [
    totalText ? `${totalText} tokens` : null,
    apiBasis,
  ].filter(Boolean).join(' · ');
  const classes = [
    ['cache read', tokens.cacheRead],
    ['input', tokens.standardRead],
    ['cache write', finiteOrNull(tokens.cacheWrite5m) ?? finiteOrNull(tokens.cacheWrite1h) ?? finiteOrNull(tokens.cacheWrite)],
    ['output', tokens.output],
    ['reasoning', tokens.reasoning],
  ]
    .filter(([, value]) => finiteOrNull(value) != null && finiteOrNull(value) !== 0)
    .map(([label, value]) => `${stepTokenText(value)} ${label}`);
  const price = finiteOrNull(subscription.monthlyPriceUsd);
  const windowWords = subscriptionWindowWords(subscription.window, subscription.windowDays);
  const poolPrices = multiplePools ? poolPriceWords(subscription) : null;
  const subDetails = [
    price == null ? null : monthlyPriceText(price),
    windowWords,
  ].filter(Boolean);
  const noun = tokenSourceNoun(tokenSource, pool);
  const explicit = finiteOrNull(api.usd);
  const exact = apiAmountIsExact(api, tokenSource);
  const shortBasis = subscriptionBasisWords(subscription.basis, pool, { short: true });
  const shortPlan = [
    price == null ? null : monthlyPriceText(price),
    subscriptionWindowWords(subscription.window, subscription.windowDays, { short: true }),
  ].filter(Boolean).join(' ');
  const selectedShare = attemptCount > 1 ? selectedAttemptShare(selected) : null;
  const apiDetails = selectedShare ? [...classes, selectedShare] : classes;
  const planHeadline = poolPrices ?? subscriptionBasisWords(subscription.basis, pool);
  const planDetails = poolPrices ? [subscriptionBasisWords(subscription.basis, pool), windowWords].filter(Boolean) : subDetails;
  const planPhone = poolPrices
    ? [shortBasis, poolPrices, subscriptionWindowWords(subscription.window, subscription.windowDays, { short: true })].filter(Boolean).join(' · ')
    : [shortBasis, shortPlan || null].filter(Boolean).join(' · ');
  const measuring = running && explicit == null;
  return {
    pending,
    running,
    attemptCount,
    multiplePools,
    rows: [
      {
        label: 'API price',
        amount: measuring ? '—' : stepMoneyText(explicit, { estimated: !exact }),
        headline: measuring ? 'measured when the attempt finishes' : explicit == null ? unpricedReason(api, tokens) : headline,
        details: measuring ? [] : apiDetails,
        // The phone says the same two facts in one row, with the classes left
        // to the desk layout where they fit.
        phoneText: measuring
          ? 'measured when the attempt finishes'
          : explicit == null ? unpricedReason(api, tokens, { short: true }) : [totalText ? `${totalText} tokens` : null, apiBasisWords(api.basis, api.rateCard, pool, { short: true })].filter(Boolean).join(' · '),
        unknown: explicit == null,
      },
      {
        label: `${multiplePools ? 'plans' : pool ?? 'pool'}${multiplePools ? '' : ' plan'}`,
        // A plan amount is a share of an account-wide meter: always `≈`.
        amount: stepMoneyText(subscription.usd, { estimated: true }),
        headline: planHeadline,
        details: planDetails,
        phoneText: planPhone,
        unknown: finiteOrNull(subscription.usd) == null,
      },
    ],
    // Rule 6: the closing line is a word map over the finite tokenSource
    // codes. A live attempt says when the figure will exist instead.
    basisLine: running
      ? `measured when the attempt finishes${noun ? ` (${noun})` : ''}`
      : noun
        ? `${tokenSource === 'estimated:utf8-bytes/4' ? 'estimated from' : 'measured from'} ${noun.startsWith('the ') ? noun : `the ${noun}`}`
        : null,
    tokenSource,
  };
}

export {
  costRows,
};
