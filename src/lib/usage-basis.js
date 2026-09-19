// One shared money-basis formatter for usage-aware views.
//
// Keep the source label next to the number. A local byte estimate and a
// provider's billed total are both dollars, but they are not the same fact.

function amountOf(value) {
  if (value && typeof value === 'object') {
    return value.costUsd ?? value.estimatedUsd ?? value.cost?.estimatedUsd ?? null;
  }
  return value;
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : null;
}

function windowLabel(window) {
  if (window === '5h') return '5h';
  if (window === 'weekly') return 'wk';
  if (window === 'monthly') return 'mo';
  return null;
}

function apiLabel(api, tokenSource = null) {
  const amount = money(api?.usd ?? api?.estimatedUsd ?? api?.costUsd);
  const source = tokenSource ?? api?.tokenSource ?? null;
  if (amount == null) return 'api unknown';
  if (source === 'transcript-summed') return `≈ ${amount} api summed`;
  if (source === 'estimated:utf8-bytes/4') return `~ ${amount} api estimated`;
  if (source === 'unknown') return 'api unknown';
  // A canonical API block without a source hint is still a dated local rate
  // card result; provider-reported is the only measured glyph available.
  return `${amount} api`;
}

function subscriptionLabel(subscription) {
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
  const amount = money(subscription.usd);
  const pct = Number(subscription.deltaPct);
  const label = windowLabel(subscription.window);
  if (amount == null) return basis.startsWith('unknown:') ? 'sub unknown (no meter/calibration)' : 'sub unknown';
  const prefix = basis === 'calibrated:usd-per-pct' ? '≈ ' : '';
  const quota = Number.isFinite(pct) && label ? `${pct}% ${label} ` : '';
  return `${quota}${prefix}${amount} sub`;
}

/**
 * Render API-rate and subscription costs side by side.  The leading glyph is
 * derived from the measurement basis, so estimates can never look measured.
 */
export function formatMoneyPair(input = {}) {
  const { api = null, subscription = null, tokenSource = null } = input ?? {};
  const apiText = apiLabel(api, tokenSource);
  const subText = subscriptionLabel(subscription);
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
  const rendered = money(amount);

  if (tokenSource === 'provider-reported') return rendered ? `$ ${rendered.slice(1)}` : 'cost unknown';
  if (tokenSource === 'transcript-summed') return rendered ? `≈ ${rendered} summed` : 'cost unknown';
  if (tokenSource === 'estimated:utf8-bytes/4') return rendered ? `~ ${rendered} estimated` : 'cost unknown';
  return 'cost unknown';
}

export default formatUsageBasis;
