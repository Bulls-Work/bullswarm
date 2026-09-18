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

/**
 * Format one usage record's cost and its measurement basis.
 *
 * Supported calls are `formatUsageBasis(usage)` and
 * `formatUsageBasis(tokenSource, costUsd)`; the latter keeps tiny call sites
 * from having to allocate a wrapper object.
 */
export function formatUsageBasis(usageOrSource = {}, costValue = undefined) {
  const usage = usageOrSource && typeof usageOrSource === 'object' ? usageOrSource : null;
  const tokenSource = usage?.tokenSource ?? (typeof usageOrSource === 'string' ? usageOrSource : 'unknown');
  const amount = amountOf(usage ?? costValue);
  const rendered = money(amount);

  if (tokenSource === 'provider-reported') return rendered ? `$ ${rendered.slice(1)}` : 'cost unknown';
  if (tokenSource === 'transcript-summed') return rendered ? `≈ ${rendered} summed` : 'cost unknown';
  if (tokenSource === 'estimated:utf8-bytes/4') return rendered ? `~ ${rendered} estimated` : 'cost unknown';
  return 'cost unknown';
}

export default formatUsageBasis;
