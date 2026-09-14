// The vendor-neutral reseller example from the provider contract (section 9).
export const name = 'relay';
export const displayName = 'Relay';
export function connectors({ kit, templates }) {
  const accounts = [{ id: 'a', models: ['gpt-5.6-sol'] }, { id: 'b', models: ['gpt-5.6-sol'] }];
  return accounts.map((acc, i) => kit.clonePool(templates.opencode2, {
    name: i === 0 ? 'relay' : `relay:${acc.id}`,
    model: `${acc.id}/gpt-5.6-sol`,
    env: { OPENCODE_CONFIG_CONTENT: kit.opencodeVariants(acc.id, acc.models) },
    profile: { providerId: acc.id },
    credentialGroup: 'relay:relay.example',
    meter: { type: 'reader', window: 'monthly' },
    subscription: { plan: 'relay-wallet', quotaWindow: 'monthly' },
  }));
}
export async function readUsage(pool, { kit, subscription }) {
  const usedUsd = 12.5;
  const included = subscription?.includedValueUsd ?? null;
  return kit.snapshot({ pool, used_usd: usedUsd,
    monthly: { utilization: kit.pct(usedUsd, included), resets_at: null } });
}
export function doctor() {
  return { installed: true, loggedIn: true };
}
