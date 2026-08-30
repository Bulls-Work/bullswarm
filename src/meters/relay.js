// Relay meter — New API token usage + OpenAI-compatible billing spend.
//
// The console wallet page (https://api.relay.com/wallet) is an HTML app that
// needs a user session cookie. API keys (`sk-…`) cannot call /api/user/self.
// They CAN call:
//   GET /api/usage/token                  token grant / used / unlimited_quota
//   GET /v1/dashboard/billing/usage       total_usage in $0.01 units (÷ 100 = USD)
//   GET /v1/dashboard/billing/subscription  access_until (unix; 0 = no expiry)
//
// Tokens with unlimited_quota:true spend the parent wallet; token
// total_available goes negative. Spend USD is still real.

const USAGE_TOKEN = 'https://api.relay.com/api/usage/token';
const BILLING_USAGE = 'https://api.relay.com/v1/dashboard/billing/usage';
const BILLING_SUB = 'https://api.relay.com/v1/dashboard/billing/subscription';
const UA = 'Mozilla/5.0 (compatible; bullswarm-relay-meter)';
const QUOTA_PER_USD = 500_000; // New API quota_per_unit observed on this host

export class RelayMeterError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function parseRelayUsage({ token, billingUsage, billingSub, pool = 'opencode2', includedUsd = null }) {
  const data = token?.data ?? token ?? {};
  const usedUsdFromBilling = typeof billingUsage?.total_usage === 'number'
    ? billingUsage.total_usage / 100
    : null;
  const usedUsdFromQuota = typeof data.total_used === 'number'
    ? data.total_used / QUOTA_PER_USD
    : null;
  const usedUsd = usedUsdFromBilling ?? usedUsdFromQuota;
  const expiresAtSec = Number(data.expires_at ?? billingSub?.access_until ?? 0);
  const resetsAt = expiresAtSec > 0 ? new Date(expiresAtSec * 1000).toISOString() : null;
  const included = Number.isFinite(Number(includedUsd)) && Number(includedUsd) > 0
    ? Number(includedUsd)
    : null;
  const utilization = usedUsd != null && included
    ? Math.max(0, Math.min(100, (usedUsd / included) * 100))
    : null;

  return {
    captured_at: new Date().toISOString(),
    pool,
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: null, resets_at: null },
    monthly: utilization == null ? null : { utilization, resets_at: resetsAt },
    used_usd: usedUsd,
    unlimited_quota: data.unlimited_quota === true,
    token_name: typeof data.name === 'string' ? data.name : null,
    expires_at: resetsAt,
    plan_type: data.unlimited_quota === true ? 'unlimited-token' : 'quota-token',
  };
}

async function getJson(url, apiKey) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
  } catch (err) {
    throw new RelayMeterError(`Network error reaching Relay: ${err.message}`, 'network');
  }
  if (!res.ok) {
    throw new RelayMeterError(`Relay ${url.split('relay.com')[1] ?? url} returned ${res.status}`, 'http');
  }
  try {
    return await res.json();
  } catch (err) {
    throw new RelayMeterError(`Failed to parse Relay response: ${err.message}`, 'parse');
  }
}

export async function fetchRelayUsage(apiKey, opts = {}) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-')) {
    throw new RelayMeterError('No Relay API key.', 'no_token');
  }
  const [token, billingUsage, billingSub] = await Promise.all([
    getJson(USAGE_TOKEN, apiKey),
    getJson(BILLING_USAGE, apiKey),
    getJson(BILLING_SUB, apiKey),
  ]);
  return parseRelayUsage({
    token,
    billingUsage,
    billingSub,
    pool: opts.pool ?? 'opencode2',
    includedUsd: opts.includedUsd,
  });
}
