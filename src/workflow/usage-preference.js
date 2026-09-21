const TOKEN_SOURCE_ORDER = new Map([
  ['unknown', 0],
  ['estimated:utf8-bytes/4', 1],
  ['transcript-summed', 2],
  ['provider-reported', 3],
]);

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Prefer the strongest token measurement while still accepting newer meter
// attribution. Provider-reported counters are immutable authority.
export function preferredUsage(prior, next) {
  if (!next) return clone(prior ?? null);
  if (!prior) return clone(next);
  const rank = (usage) => TOKEN_SOURCE_ORDER.get(usage?.tokenSource) ?? 0;
  if (rank(next) >= rank(prior)) return clone(next);
  return {
    ...clone(prior),
    ...(next.subscription !== undefined ? { subscription: clone(next.subscription) } : {}),
    ...(next.normalizedQuota !== undefined ? { normalizedQuota: clone(next.normalizedQuota) } : {}),
  };
}
