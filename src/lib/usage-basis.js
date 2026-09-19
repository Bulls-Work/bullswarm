// One shared money-basis formatter for usage-aware views.
//
// Keep the source label next to the number. A local byte estimate and a
// provider's billed total are both dollars, but they are not the same fact.

function amountOf(value) {
  if (value && typeof value === 'object') {
    return value.usd ?? value.costUsd ?? value.estimatedUsd ?? value.cost?.estimatedUsd ?? null;
  }
  return value;
}

function tokenTotal(tokens) {
  if (tokens == null) return null;
  if (typeof tokens !== 'object') {
    const number = Number(tokens);
    return Number.isFinite(number) ? number : null;
  }
  const value = tokens.totalKnown ?? tokens.total ?? tokens.totalTokens;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function smallAmount(number) {
  const precise = number.toPrecision(3);
  if (!/[eE]/.test(precise)) return String(Number(precise));

  // Keep very small values readable as dollars instead of switching to an
  // exponent in a terminal label.
  const [coefficient, exponentText] = precise.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const sign = coefficient.startsWith('-') ? '-' : '';
  const digits = coefficient.replace('-', '').replace('.', '');
  const decimalIndex = (coefficient.replace('-', '').split('.')[0].length) + exponent;
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`.replace(/0+$/, '');
  if (decimalIndex >= digits.length) return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Render a dollar amount without throwing away sub-cent magnitude.
 *
 * Values at or above ten cents use cents; smaller values use three
 * significant digits. A known zero-token record is the only case where an
 * exact zero is rendered as `$0`; a zero with unknown/non-zero tokens keeps
 * the small-amount shape so it cannot look like a free attempt. Unknown
 * amounts are always a dash.
 */
export function formatMoney(value, tokens = null) {
  let candidate = value;
  if (value && typeof value === 'object') {
    tokens ??= value.tokens;
    candidate = value.usd ?? value.costUsd ?? value.estimatedUsd ?? value.cost?.estimatedUsd;
  }
  if (candidate == null || candidate === '' || typeof candidate === 'boolean') return '-';
  const number = Number(candidate);
  if (!Number.isFinite(number)) return '-';
  if (number === 0 && tokenTotal(tokens) === 0) return '$0';
  if (number >= 0.10) return `$${number.toFixed(2)}`;
  if (number === 0) return '$0.000';
  return `$${smallAmount(number)}`;
}

// Descriptive alias for callers that need to distinguish this from pair
// formatting while keeping the same single implementation.
export const formatMoneyAmount = formatMoney;

function windowLabel(window) {
  if (window === '5h') return '5h';
  if (window === 'weekly') return 'wk';
  if (window === 'monthly') return 'mo';
  return null;
}

function apiLabel(api, tokenSource = null, tokens = null) {
  const amount = formatMoney(
    api?.usd ?? api?.estimatedUsd ?? api?.costUsd,
    api?.tokens ?? tokens,
  );
  const source = tokenSource ?? api?.tokenSource ?? null;
  if (amount === '-') return 'api unknown';
  if (source === 'transcript-summed') return `≈ ${amount} api summed`;
  if (source === 'estimated:utf8-bytes/4') return `~ ${amount} api estimated`;
  if (source === 'unknown') return 'api unknown';
  // A canonical API block without a source hint is still a dated local rate
  // card result; provider-reported is the only measured glyph available.
  return `${amount} api`;
}

function subscriptionLabel(subscription, tokens = null) {
  if (!subscription || typeof subscription !== 'object') return 'sub unknown (no meter/calibration)';
  const basis = String(subscription.basis ?? '');
  if (basis === 'unknown:no-price') {
    // Codex exposes an internal `prolite` meter plan that is not named by an
    // official public price page. Keep the amount unknown, but make the
    // operator's one supported declaration path actionable in every surface.
    if (String(subscription.pool ?? '').toLowerCase() === 'codex') {
      return 'sub unknown (declare a price: bullswarm strategy set-subscription codex --monthly-usd <amount>)';
    }
    return 'sub unknown (no plan price)';
  }
  if (basis === 'unknown:no-cost') return 'sub unknown (no API cost)';
  if (basis === 'unknown:no-meter') return 'sub unknown (no meter/calibration)';
  const amount = formatMoney(subscription.usd, subscription.tokens ?? tokens);
  const pct = Number(subscription.deltaPct);
  const label = windowLabel(subscription.window);
  if (amount === '-') return basis.startsWith('unknown:') ? 'sub unknown (no meter/calibration)' : 'sub unknown';
  const prefix = basis === 'calibrated:usd-per-pct' ? '≈ ' : '';
  const quota = Number.isFinite(pct) && label ? `${pct}% ${label} ` : '';
  return `${quota}${prefix}${amount} sub`;
}

/**
 * Render API-rate and subscription costs side by side.  The leading glyph is
 * derived from the measurement basis, so estimates can never look measured.
 */
export function formatMoneyPair(input = {}) {
  const {
    api = null, subscription = null, tokenSource = null, tokens = null,
  } = input ?? {};
  const apiText = apiLabel(api, tokenSource, tokens);
  const subText = subscriptionLabel(subscription, tokens);
  return `${apiText} · ${subText}`;
}

/**
 * Format one usage record's cost and its measurement basis.
 *
 * Supported calls are `formatUsageBasis(usage)` and
 * `formatUsageBasis(tokenSource, costUsd)`; the latter keeps tiny call sites
 * from having to allocate a wrapper object.
 */
export function formatUsageBasis(usageOrSource = {}, costValue = undefined) {
  const usage = usageOrSource && typeof usageOrSource === 'object' ? usageOrSource : null;
  if (usage?.api && Object.hasOwn(usage, 'subscription')) {
    return formatMoneyPair(usage);
  }
  const tokenSource = usage?.tokenSource ?? (typeof usageOrSource === 'string' ? usageOrSource : 'unknown');
  const amount = amountOf(usage ?? costValue);
  const rendered = formatMoney(amount, usage?.tokens);

  if (rendered === '-') return 'cost unknown';
  if (tokenSource === 'provider-reported') return `$ ${rendered.slice(1)}`;
  if (tokenSource === 'transcript-summed') return `≈ ${rendered} summed`;
  if (tokenSource === 'estimated:utf8-bytes/4') return `~ ${rendered} estimated`;
  return 'cost unknown';
}

export default formatUsageBasis;
