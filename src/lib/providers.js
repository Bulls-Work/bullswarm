// bullswarm provider loader — every pool comes from a provider directory.
//
// A provider is a directory holding `connector.json` (a pool template,
// src/providers/_schema.json) and/or `provider.mjs` (docs/reference/providers.md).
// Three tiers, loaded in this order:
//   first-class  <repo>/src/providers/<name>/        always
//   contrib      <repo>/providers/contrib/<name>/    when <bullswarmDir>/providers.json
//                                                    lists it in `enabled`
//   local        <bullswarmDir>/providers/<name>/    always (skipped under node:test
//                                                    unless opts.dirs.local is given)
//                <bullswarmDir>/connectors/*.json    legacy json-only local providers
//
// Doctrine:
//   P1. Synchronous. provider.mjs is loaded through createRequire (require of
//       ESM, Node >= 22.12), so loadConnectors and buildPools stay sync. A
//       module with top-level await fails to load and is recorded.
//   P2. A provider owns a name prefix: every pool it returns is `name` or
//       `name:<suffix>`. Anything else is skipped and recorded.
//   P3. First come, first kept. A pool name already loaded is never
//       overwritten; the later one is skipped and recorded.
//   P4. A bad provider can never crash a run. Bad JSON, an import error, a
//       throwing connectors() — each is caught into `error` on its entry, the
//       same spirit as the old per-file try/catch in loadConnectors.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kit from '../provider-kit.js';

const require = createRequire(import.meta.url);

/** The package root: `{bullswarmDir}` in spawn.cmd resolves here too. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const PROVIDER_TIERS = ['first-class', 'contrib', 'local'];

/** The shipped provider directories (overridable per call through opts.dirs). */
export function providerDirs(bullswarmDir, opts = {}) {
  const root = opts.repoRoot ?? REPO_ROOT;
  return {
    firstClass: opts.dirs?.firstClass ?? join(root, 'src', 'providers'),
    contrib: opts.dirs?.contrib ?? join(root, 'providers', 'contrib'),
    local: opts.dirs?.local ?? join(bullswarmDir, 'providers'),
    legacy: opts.dirs?.legacy ?? join(bullswarmDir, 'connectors'),
  };
}

export function providersConfigPath(bullswarmDir) {
  return join(bullswarmDir, 'providers.json');
}

/**
 * `<bullswarmDir>/providers.json` as `{ enabled: string[] }`. A missing or
 * unreadable file is "nothing enabled", never an error that stops a run.
 */
export function readProvidersConfig(bullswarmDir) {
  const path = providersConfigPath(bullswarmDir);
  if (!existsSync(path)) return { enabled: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const enabled = Array.isArray(parsed?.enabled)
      ? parsed.enabled.filter((n) => typeof n === 'string' && n !== '')
      : [];
    return { ...parsed, enabled };
  } catch {
    return { enabled: [] };
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Provider directories under `root`, A–Z, skipping `_`/`.`-prefixed names. */
function listProviderDirs(root) {
  if (!isDir(root)) return [];
  let names;
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .map((n) => join(root, n))
    .filter((dir) => isDir(dir)
      && (existsSync(join(dir, 'connector.json')) || existsSync(join(dir, 'provider.mjs'))));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Every shipped connector.json (first-class and contrib, enabled or not) by
 * its `name`, else its directory name. Unparseable files are left out; their
 * provider entry records the error.
 */
export function loadTemplates(dirs) {
  const templates = {};
  for (const root of [dirs.firstClass, dirs.contrib]) {
    for (const dir of listProviderDirs(root)) {
      const file = join(dir, 'connector.json');
      if (!existsSync(file)) continue;
      try {
        const template = readJson(file);
        const key = typeof template?.name === 'string' && template.name ? template.name : basename(dir);
        if (!(key in templates)) templates[key] = template;
      } catch { /* recorded on the provider entry */ }
    }
  }
  return templates;
}

/** Whether `poolName` is `name` or `name:<suffix>`. */
export function ownsPoolName(name, poolName) {
  return typeof name === 'string' && name !== '' && typeof poolName === 'string'
    && (poolName === name || (poolName.startsWith(`${name}:`) && poolName.length > name.length + 1));
}

function hidden(entry, key, value) {
  Object.defineProperty(entry, key, { value, enumerable: false, writable: true, configurable: true });
}

function errorText(err) {
  return err?.message ? String(err.message) : String(err);
}

/**
 * Load one provider directory (or one legacy json file) into an entry.
 * `load` false lists the provider without calling connectors().
 */
function loadOne({ dir, file, tier, enabled, load }, shared) {
  const entry = {
    name: basename(file ?? dir).replace(/\.json$/, ''),
    displayName: null,
    tier,
    dir: file ?? dir,
    enabled,
    pools: [],
    skipped: [],
    error: null,
    hasReadUsage: false,
    hasDoctor: false,
  };
  hidden(entry, 'module', null);
  hidden(entry, 'template', null);
  hidden(entry, 'ctx', null);
  // Keep the historical serialized provider-entry shape stable while still
  // exposing the optional capability to code that needs it.
  hidden(entry, 'hasReadTranscriptUsage', false);

  try {
    const jsonPath = file ?? join(dir, 'connector.json');
    const template = existsSync(jsonPath) ? readJson(jsonPath) : null;
    entry.template = template;
    const modulePath = file ? null : join(dir, 'provider.mjs');
    const mod = modulePath && existsSync(modulePath) ? require(modulePath) : null;
    entry.module = mod;

    if (mod) {
      if (typeof mod.name !== 'string' || mod.name === '') {
        throw new Error('provider.mjs must export a non-empty string `name`');
      }
      entry.name = mod.name;
    } else if (typeof template?.name === 'string' && template.name !== '') {
      entry.name = template.name;
    } else {
      throw new Error('connector.json has no `name` and there is no provider.mjs');
    }
    entry.displayName = typeof mod?.displayName === 'string' && mod.displayName
      ? mod.displayName
      : (typeof template?.displayName === 'string' && template.displayName ? template.displayName : entry.name);
    entry.hasReadUsage = typeof mod?.readUsage === 'function';
    // Transcript accounting is an optional provider capability. The flag is
    // exposed to code that needs it while its enumerability remains hidden to
    // preserve the established provider-entry JSON contract.
    entry.hasReadTranscriptUsage = typeof mod?.readTranscriptUsage === 'function';
    entry.hasDoctor = typeof mod?.doctor === 'function';
    if (mod && mod.connectors !== undefined && typeof mod.connectors !== 'function') {
      throw new Error('provider.mjs `connectors` must be a function');
    }

    entry.ctx = {
      kit,
      template,
      templates: shared.templates,
      home: shared.home,
      env: shared.env,
      bullswarmDir: shared.bullswarmDir,
      opts: shared.opts,
    };
    if (!load) return entry;

    let pools;
    if (typeof mod?.connectors === 'function') {
      // Each provider sees its own copy of the templates and its template, so
      // one provider mutating them cannot change what the next one clones.
      const ctx = {
        ...entry.ctx,
        template: template == null ? null : structuredClone(template),
        templates: structuredClone(shared.templates),
      };
      pools = mod.connectors(ctx);
      if (pools && typeof pools.then === 'function') {
        pools.catch?.(() => {});
        throw new Error('connectors() must be synchronous; it returned a Promise');
      }
      if (!Array.isArray(pools)) throw new Error('connectors() must return an array of pools');
    } else if (template) {
      pools = [structuredClone(template)];
    } else {
      throw new Error('provider has no connector.json and exports no connectors()');
    }

    for (const pool of pools) {
      const poolName = pool?.name;
      if (!pool || typeof pool !== 'object' || typeof poolName !== 'string' || poolName === '') {
        entry.skipped.push({ pool: typeof poolName === 'string' ? poolName : null, reason: 'invalid', message: 'pool is not an object with a string `name`' });
        continue;
      }
      if (!ownsPoolName(entry.name, poolName)) {
        entry.skipped.push({ pool: poolName, reason: 'prefix', message: `pool name must be "${entry.name}" or "${entry.name}:<suffix>"` });
        continue;
      }
      if (Object.hasOwn(shared.connectors, poolName)) {
        entry.skipped.push({ pool: poolName, reason: 'duplicate', message: `pool "${poolName}" is already defined by provider "${shared.owners[poolName]}"` });
        continue;
      }
      shared.connectors[poolName] = pool;
      shared.owners[poolName] = entry.name;
      entry.pools.push(poolName);
    }
  } catch (err) {
    entry.error = errorText(err);
  }
  return entry;
}

/**
 * Load every provider.
 *
 * opts:
 *   dirs        { firstClass, contrib, local, legacy } directory overrides
 *   repoRoot    root for the shipped tiers (default: this package)
 *   enabled     contrib names to load, instead of providers.json
 *   allContrib  load every contrib provider regardless of enabled (probe)
 *   homeDir     ctx.home (default os.homedir())
 *   env         ctx.env (default process.env)
 * Everything in opts also reaches providers as ctx.opts, so test injection
 * (accounts, configPath, …) keeps working through a provider.
 *
 * @returns {{ connectors: Record<string, object>, providers: object[] }}
 *   Each provider entry carries non-enumerable `module`, `template` and `ctx`
 *   (the base context for readUsage/doctor), so JSON output shows only the
 *   contract fields.
 */
export function loadProviders(bullswarmDir, opts = {}) {
  const dirs = providerDirs(bullswarmDir, opts);
  const shared = {
    connectors: {},
    owners: {},
    templates: loadTemplates(dirs),
    home: opts.homeDir ?? homedir(),
    env: opts.env ?? process.env,
    bullswarmDir,
    opts,
  };
  const providers = [];

  // node:test children inherit NODE_TEST_CONTEXT. A test that hands us its own
  // bullswarmDir expects exactly the connectors it planted there, so the
  // PACKAGE's own tiers stay out unless the test names their directories. Same
  // guard the local tier uses below, and the same rule the retired
  // expandClaudeAccountConnectors / expandOpenCodeRelayConnectors followed —
  // without it every fixture home also grows the real claude-code, codex and
  // grok pools and no pool-list assertion can hold.
  // `packaged: true` is the deliberate escape hatch for the one caller whose
  // job IS the packaged tiers — `bullswarm setup` discovers what ships with
  // the package, so hiding those from it under node:test would test nothing.
  // BULLSWARM_NO_PACKAGED_PROVIDERS=1 forces the packaged tiers off even for a
  // caller that asked for them. It exists for tests that SPAWN the real CLI
  // against a fixture home: the child is production code and rightly wants the
  // packaged tiers, but a test asserting "these are the only pools" needs them
  // gone, and NODE_TEST_CONTEXT alone cannot say which of the two a given
  // child is. Never set it in production.
  const forcedOff = (shared.env ?? process.env).BULLSWARM_NO_PACKAGED_PROVIDERS === '1';
  const underTest = forcedOff
    || (Boolean(process.env.NODE_TEST_CONTEXT) && opts.packaged !== true);
  const skipFirstClass = underTest && opts.dirs?.firstClass == null;
  const skipContrib = underTest && opts.dirs?.contrib == null;

  if (!skipFirstClass) {
    for (const dir of listProviderDirs(dirs.firstClass)) {
      providers.push(loadOne({ dir, tier: 'first-class', enabled: true, load: true }, shared));
    }
  }

  const enabledContrib = new Set(Array.isArray(opts.enabled)
    ? opts.enabled
    : readProvidersConfig(bullswarmDir).enabled);
  for (const dir of skipContrib ? [] : listProviderDirs(dirs.contrib)) {
    // Enabled is decided by directory name before import, so a disabled
    // contrib provider's connectors() never runs; its module still loads for
    // displayName / hasReadUsage in `provider list`.
    const enabled = enabledContrib.has(basename(dir));
    providers.push(loadOne({ dir, tier: 'contrib', enabled, load: enabled || opts.allContrib === true }, shared));
  }

  // node:test children inherit NODE_TEST_CONTEXT: never execute the
  // operator's own provider code unless the test names the directory.
  const skipLocal = Boolean(process.env.NODE_TEST_CONTEXT) && opts.dirs?.local == null;
  if (!skipLocal) {
    for (const dir of listProviderDirs(dirs.local)) {
      providers.push(loadOne({ dir, tier: 'local', enabled: true, load: true }, shared));
    }
  }

  // Legacy json files are data, not code, and were always read (tests
  // included), so they are not behind the node:test guard.
  if (isDir(dirs.legacy)) {
    let files = [];
    try {
      files = readdirSync(dirs.legacy).sort().filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    } catch { /* unreadable */ }
    for (const f of files) {
      providers.push(loadOne({ file: join(dirs.legacy, f), tier: 'local', enabled: true, load: true }, shared));
    }
  }

  return { connectors: shared.connectors, providers };
}

/**
 * The provider that owns a pool: one listing the pool among its loaded pools,
 * else the longest name that is the pool name or its `name:` prefix. First in
 * load order wins a tie.
 *
 * @param {object[]} providers  loadProviders(...).providers
 * @param {string|{name: string}} pool
 */
export function providerFor(providers, pool) {
  const poolName = typeof pool === 'string' ? pool : pool?.name;
  if (typeof poolName !== 'string' || !Array.isArray(providers)) return null;
  const owner = providers.find((p) => p.pools?.includes(poolName));
  if (owner) return owner;
  let best = null;
  for (const p of providers) {
    if (!ownsPoolName(p.name, poolName)) continue;
    if (!best || p.name.length > best.name.length) best = p;
  }
  return best;
}

/**
 * Resolve the optional durable-transcript reader for one pool.
 *
 * The provider owns the on-disk format, so callers must not infer a provider
 * from the pool name or reach into `module` themselves.  The returned
 * closure preserves the provider's context and accepts the common
 * `readTranscriptUsage({ provider, sessionId, cwd, startedAt, endedAt, home })`
 * argument object.  A provider without the hook is an ordinary, supported
 * case and returns null so usage can fall through to byte estimation.
 */
export function transcriptReaderFor(providers, pool) {
  const owner = providerFor(providers, pool);
  const readTranscriptUsage = owner?.module?.readTranscriptUsage;
  if (typeof readTranscriptUsage !== 'function') return null;
  return (args = {}) => readTranscriptUsage({
    ...args,
    provider: args.provider ?? owner.name,
    home: args.home ?? owner.ctx?.home ?? null,
  });
}

/**
 * Convenience loader for callers that only have a Bullswarm home and pool.
 * `providers` may be supplied to avoid a second provider load in a hot path.
 */
export function readTranscriptUsageFor(pool, {
  bullswarmDir,
  providers = null,
  ...opts
} = {}) {
  const loaded = providers ?? loadProviders(bullswarmDir, opts).providers;
  return transcriptReaderFor(loaded, pool);
}

// Descriptive aliases keep the helper discoverable to integrations that use
// either the capability name or the provider-oriented name.
export const providerTranscriptReader = transcriptReaderFor;
export const transcriptUsageReaderFor = readTranscriptUsageFor;
