// Discover Relay providers in the local OpenCode config and clone the
// opencode2 connector once per extra key. Pool names:
//   opencode2            → first relay* provider (historical)
//   opencode2:<id>       → extra providers (relay-2, relay-3, …)
// Spawn adds or retargets `--model` to `<id>/gpt-5.6-luna` for discovered
// providers. No hardcoded key list — whatever OpenCode has configured with a
// Relay base URL is used.
//
// Each pool also carries env.OPENCODE_CONFIG_CONTENT declaring the five
// reasoning variants for its OWN provider id, which is what makes the
// connector's `--variant <level>` mean anything (see relayVariantsConfig).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REASONING_LEVELS } from './reasoning.js';

export const RELAY_BASE_HOST = 'api.relay.com';
export const RELAY_OPENCODE_MODEL = 'gpt-5.6-luna';
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

/**
 * The OPENCODE_CONFIG_CONTENT value for one Relay pool.
 *
 * opencode's `--variant <level>` only reaches the provider when the CONFIG
 * declares that variant for that model; a bare install declares none, so the
 * flag is accepted and silently dropped. OPENCODE_CONFIG_CONTENT is a JSON
 * string opencode merges OVER the config file (the file's own provider keys,
 * including the API key, stay in force), so declaring one variant per common
 * reasoning level here is what turns `--variant max` into
 * `reasoning_effort: "max"` on the Relay request.
 *
 * The keys are REASONING_LEVELS verbatim, so the injected variants can never
 * drift from the levels connectors/opencode2.json declares.
 *
 * @returns {string} JSON, e.g. for `relay-2`:
 *   {"provider":{"relay-2":{"models":{"gpt-5.6-luna":{"variants":{"low":{"reasoningEffort":"low"},…}}}}}}
 */
export function relayVariantsConfig(providerId, model = RELAY_OPENCODE_MODEL) {
  const variants = {};
  for (const level of REASONING_LEVELS) variants[level] = { reasoningEffort: level };
  return JSON.stringify({ provider: { [providerId]: { models: { [model]: { variants } } } } });
}

/**
 * The shared-credential group every Relay pool belongs to.
 *
 * All three Relay pools relay through ONE upstream host, which relays through
 * ONE pool of Codex OAuth accounts. When that credential died (2026-09-11) the
 * three pool names were three doors into the same outage, so they are benched
 * together on an auth failure (see quarantineUpstreamSiblings in
 * src/lib/state.js). The host is part of the group id so a second Relay-shaped
 * relay on another host would form its own group rather than joining this one.
 * A provider record discovered without a parseable baseURL is Relay by
 * construction and falls back to the canonical host.
 */
export function relayUpstreamGroup(baseURL) {
  let host = RELAY_BASE_HOST;
  try { host = new URL(baseURL).hostname || RELAY_BASE_HOST; } catch { /* fall back */ }
  return `relay:${host}`;
}

export function poolNameForRelayProvider(providerId, index) {
  return index === 0 ? 'opencode2' : `opencode2:${providerId}`;
}

export function retargetOpenCodeModel(cmd, providerId) {
  const retargeted = (cmd ?? []).map((arg) => {
    if (typeof arg !== 'string') return arg;
    return arg.replace(/^relay(?:-\d+)?\//, `${providerId}/`);
  });
  const modelIndex = retargeted.indexOf('--model');
  const model = `${providerId}/${RELAY_OPENCODE_MODEL}`;
  if (modelIndex >= 0) {
    retargeted[modelIndex + 1] = model;
  } else {
    const taskIndex = retargeted.indexOf('{taskFile}');
    const insertAt = taskIndex >= 0 ? taskIndex : retargeted.length;
    retargeted.splice(insertAt, 0, '--model', model);
  }
  return retargeted;
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
      command: `opencode run --auto --model ${p.id}/${RELAY_OPENCODE_MODEL}`,
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

  // An OPENCODE_CONFIG_CONTENT the operator wrote into the INSTALLED
  // connector is their own answer about which opencode config a pool runs
  // under, and is never overwritten — not on the base pool, and not on the
  // clones, which inherit it through structuredClone. Read before any
  // injection, so the base pool's own injected value is not mistaken for one.
  const operatorSetConfigContent = typeof base.env?.OPENCODE_CONFIG_CONTENT === 'string'
    && base.env.OPENCODE_CONFIG_CONTENT.trim() !== '';
  const injectVariants = (clone, providerId) => {
    if (operatorSetConfigContent) return;
    clone.env = {
      ...(clone.env ?? {}),
      OPENCODE_CONFIG_CONTENT: relayVariantsConfig(providerId),
    };
  };

  const primary = providers[0];
  pinModel(base, primary.id);
  injectVariants(base, primary.id);
  base.upstreamGroup = relayUpstreamGroup(primary.baseURL);
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
    injectVariants(clone, extra.id);
    clone.upstreamGroup = relayUpstreamGroup(extra.baseURL);
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
