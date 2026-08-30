// Discover Relay providers in the local OpenCode config and clone the
// opencode2 connector once per extra key. Pool names:
//   opencode2            → first relay* provider (historical)
//   opencode2:<id>       → extra providers (relay-2, relay-3, …)
// Spawn retargets `--model relay/…` to `--model <id>/…`. No hardcoded key
// list — whatever OpenCode has configured with a Relay base URL is used.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RELAY_BASE_HOST = 'api.relay.com';
export const DEFAULT_OPENCODE_CONFIG = () =>
  join(homedir(), '.config', 'opencode', 'opencode.json');

export function isRelayBaseUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).hostname === RELAY_BASE_HOST;
  } catch {
    return false;
  }
}

export function poolNameForRelayProvider(providerId, index) {
  return index === 0 ? 'opencode2' : `opencode2:${providerId}`;
}

export function retargetOpenCodeModel(cmd, providerId) {
  return (cmd ?? []).map((arg) => {
    if (typeof arg !== 'string') return arg;
    return arg.replace(/^relay(?:-\d+)?\//, `${providerId}/`);
  });
}

export function discoverRelayProviders(opts = {}) {
  if (opts.providers) return opts.providers;
  if (process.env.NODE_TEST_CONTEXT && opts.configPath == null) return [];
  if (process.env.BULLSWARM_DISABLE_OPENCODE_RELAY === '1' && opts.configPath == null) return [];
  const configPath = opts.configPath ?? DEFAULT_OPENCODE_CONFIG();
  if (!existsSync(configPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  const providers = parsed?.provider;
  if (!providers || typeof providers !== 'object') return [];
  const found = [];
  for (const [id, spec] of Object.entries(providers)) {
    const baseURL = spec?.options?.baseURL;
    const apiKey = spec?.options?.apiKey;
    if (!isRelayBaseUrl(baseURL)) continue;
    if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-')) continue;
    found.push({
      id,
      name: typeof spec.name === 'string' ? spec.name : id,
      baseURL,
      apiKey,
    });
  }
  // Stable: keep `relay` first when present, then remaining ids A–Z.
  found.sort((a, b) => {
    if (a.id === 'relay') return -1;
    if (b.id === 'relay') return 1;
    return a.id.localeCompare(b.id);
  });
  return found.map((p, index) => ({
    ...p,
    pool: poolNameForRelayProvider(p.id, index),
    command: `opencode run --auto --model ${p.id}/gpt-5.6-luna`,
  }));
}

export function expandOpenCodeRelayConnectors(connectors, opts = {}) {
  if (opts.disabled === true) return connectors;
  if (process.env.BULLSWARM_DISABLE_OPENCODE_RELAY === '1') return connectors;
  if (process.env.NODE_TEST_CONTEXT && opts.providers == null && opts.configPath == null) {
    return connectors;
  }
  const base = connectors.opencode2;
  if (!base) return connectors;
  const providers = opts.providers ?? discoverRelayProviders({ configPath: opts.configPath });
  if (providers.length === 0) return connectors;

  const pinModel = (clone, providerId) => {
    if (!clone.spawn?.cmd) return;
    clone.spawn = { ...clone.spawn, cmd: retargetOpenCodeModel(clone.spawn.cmd, providerId) };
  };

  const primary = providers[0];
  pinModel(base, primary.id);
  base.profile = {
    providerId: primary.id,
    command: primary.command,
  };
  base.meter = { ...(base.meter ?? {}), type: 'reader' };
  base.subscription = {
    ...(base.subscription ?? {}),
    plan: base.subscription?.plan ?? 'relay-wallet',
    quotaWindow: base.subscription?.quotaWindow ?? 'monthly',
  };

  for (const extra of providers.slice(1)) {
    if (connectors[extra.pool]) continue;
    const clone = structuredClone(base);
    clone.name = extra.pool;
    pinModel(clone, extra.id);
    clone.flags = { ...(base.flags ?? {}), isCaller: false };
    clone.profile = {
      providerId: extra.id,
      command: extra.command,
    };
    clone.meter = { type: 'reader' };
    connectors[extra.pool] = clone;
  }
  return connectors;
}
