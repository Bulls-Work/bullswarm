// The plain words a cost row prints for how a figure was measured: the rate
// card's vendor, the API and subscription basis codes, the quota window and
// the token source, each a word map over the finite codes in usage-basis.js.

import { finiteOrNull } from '../lib/num.js';
import { stepDayText } from './step-model-text.js';
import { textOrNull } from './step-model-values.js';

// The one phrase a row prints for its measurement basis. Both word maps are
// closed over the finite codes in usage-basis.js: a code the map does not know
// prints itself, so a new basis is visible rather than silently blank.
function rateCardVendor(rateCard) {
  const source = String(rateCard?.source ?? '');
  if (/openai/i.test(source)) return 'OpenAI';
  if (/anthropic|claude/i.test(source)) return 'Anthropic';
  if (/(^|\.)x\.ai|xai|grok/i.test(source)) return 'xAI';
  if (/google|gemini/i.test(source)) return 'Google';
  return null;
}

function apiBasisWords(basis, rateCard, pool, { short = false, includeDate = true } = {}) {
  const code = textOrNull(basis) ?? 'unknown';
  const vendor = rateCardVendor(rateCard) ?? textOrNull(pool) ?? 'model';
  const dated = includeDate && rateCard ? stepDayText(rateCard.updatedAt) : null;
  const card = short
    ? `${vendor} card${dated ? ` ${dated}` : ''}`
    : dated ? `${vendor} rate card, ${dated}` : `${vendor} rate card`;
  if (code === 'rate-card:complete' || code === 'rate-card:partial') {
    return code === 'rate-card:partial' ? `${card}${short ? '' : ' (partial)'}` : card;
  }
  if (code === 'provider-reported') return 'provider-reported';
  if (code === 'legacy') return 'legacy estimate';
  if (code === 'aggregate') return 'summed across attempts';
  if (code === 'unknown') return 'no recorded rate';
  if (code === 'unknown:no-rate-card') return short ? 'no rate card' : 'no rate card for this model';
  // An `unknown: <why>` code is the kernel's own reason; print it as a phrase.
  const reason = code.replace(/^unknown:\s*/, '').trim();
  if (reason === code) return code;
  return /^no\b/i.test(reason) ? reason : `no ${reason}`;
}

function subscriptionBasisWords(basis, pool, { short = false } = {}) {
  const code = textOrNull(basis) ?? 'unknown';
  const name = textOrNull(pool) ?? 'pool';
  if (code === 'unknown:no-meter') return short ? 'no meter reading' : 'no meter reading for this attempt';
  if (code === 'unknown:no-price') return short ? 'no plan price' : 'no plan price recorded';
  if (code === 'unknown:no-cost') return short ? 'no API cost' : 'no API cost to price';
  if (code === 'unknown:below-resolution') return short ? 'below meter resolution' : 'below the meter resolution';
  // Every plan amount is this attempt's share of an account-wide meter.
  if (code === 'observed:meter-delta') return `share of the ${name} meter's move`;
  if (code === 'observed:meter-ledger') return `share of the ${name} meter ledger`;
  if (code === 'calibrated:usd-per-pct') return `estimated from the ${name} meter's $ per %`;
  if (code === 'provider-reported') return 'provider-reported';
  if (code === 'aggregate') return 'summed across attempts';
  if (code === 'unknown') return 'no meter reading';
  return code;
}

function subscriptionWindowWords(window, windowDays, { short = false } = {}) {
  const code = textOrNull(window);
  if (!code) {
    const days = finiteOrNull(windowDays);
    return days == null ? null : `${days}-day${short ? '' : ' window'}`;
  }
  if (code === 'weekly') return short ? 'weekly' : 'weekly window';
  if (code === 'monthly') return short ? 'monthly' : 'monthly window';
  if (code === '5h') return short ? '5h' : '5-hour window';
  return short ? code : `${code} window`;
}

// The token source says who measured the tokens; that is the sentence's own
// subject, so the map is over the finite codes in usage-basis.js.
function tokenSourceNoun(tokenSource, pool) {
  const code = textOrNull(tokenSource) ?? 'unknown';
  const name = textOrNull(pool) ?? 'provider';
  if (code === 'transcript-summed') return `${name} transcript`;
  if (code === 'provider-reported') return `${name} provider report`;
  if (code === 'estimated:utf8-bytes/4') return `${name} output bytes`;
  if (code === 'mixed') return 'recorded attempts';
  return null;
}

export {
  rateCardVendor,
  apiBasisWords,
  subscriptionBasisWords,
  subscriptionWindowWords,
  tokenSourceNoun,
};
