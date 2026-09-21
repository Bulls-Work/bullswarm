// bullswarm provider — list, enable, disable, validate, scaffold, probe.
//
// Two different "enabled" notions exist and this command owns only the first:
//   loaded   a contrib provider is loaded at all when ~/.bullswarm/providers.json
//            lists it (enable/disable below). First-class and local providers
//            always load.
//   routed   a loaded pool is routed or not in strategy state, which stays
//            `bullswarm strategy set-provider <pool> on|off --yes`.
//
// Doctrine:
//   V1. enable/disable write providers.json and NEVER state.json: the
//       workflow kernel rewrites state.json concurrently.
//   V2. probe is the acceptance step for a provider author. It spawns the
//       pool through the same runner the dispatcher uses (src/lib/watch.js)
//       with no routing, no quota gate, no assignment ledger, and no
//       BULLSWARM_DEPTH check, then reads usage once.
//   V3. Nothing from a pool's env reaches the terminal: argv and error text are
//       redacted against every env value before they are printed.

import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import * as kit from './provider-kit.js';
import {
  loadProviders, loadTemplates, ownsPoolName, providerDirs, providerFor,
  providersConfigPath, readProvidersConfig,
} from './lib/providers.js';
import { argvWithModel, watchOnce } from './lib/watch.js';
import { atomicWriteFileSync } from './lib/fsjson.js';
import { loadState } from './lib/state.js';
import { REASONING_LEVELS } from './lib/reasoning.js';
import { helpText, usageLine } from './help.js';
import { flagName, unknownFlagExit } from './lib/cli-flags.js';

const require = createRequire(import.meta.url);

const SUBCOMMANDS = ['list', 'enable', 'disable', 'validate', 'scaffold', 'probe'];
export const PROBE_TASK = 'Reply with the single word PONG and nothing else';
const PROBE_TIMEOUT_SEC = 300;

function parseFlags(argv) {
  const flags = { rest: [], _flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { flags.rest.push(token); continue; }
    const seen = flagName(token);
    if (seen && !flags._flags.includes(seen)) flags._flags.push(seen);
    const [raw, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[raw] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[raw] = argv[++i];
    else flags[raw] = true;
  }
  return flags;
}

/** An error that carries its own exit code (2 = the request itself is wrong). */
function fail(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

function usage(sub, what) {
  return fail(`${what}: ${usageLine(['provider', sub])}`);
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isProviderDir(dir) {
  return isDir(dir) && (existsSync(join(dir, 'connector.json')) || existsSync(join(dir, 'provider.mjs')));
}

// --- list ---------------------------------------------------------------------

function listReport(bullswarmDir, loaderOpts) {
  const { providers } = loadProviders(bullswarmDir, loaderOpts);
  return {
    schemaVersion: 'bullswarm.provider.list.v1',
    capturedAt: new Date().toISOString(),
    providersConfig: providersConfigPath(bullswarmDir),
    enabledContrib: Array.isArray(loaderOpts.enabled)
      ? loaderOpts.enabled
      : readProvidersConfig(bullswarmDir).enabled,
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      tier: p.tier,
      dir: p.dir,
      enabled: p.enabled,
      pools: p.pools,
      skipped: p.skipped,
      error: p.error,
      hasReadUsage: p.hasReadUsage,
      hasDoctor: p.hasDoctor,
    })),
  };
}

function renderList(report) {
  const lines = [`bullswarm providers · ${report.capturedAt}`, ''];
  const width = Math.max(4, ...report.providers.map((p) => String(p.name ?? '?').length));
  for (const p of report.providers) {
    const loaded = p.tier !== 'contrib' ? 'loaded' : p.enabled ? 'loaded (enabled)' : 'not enabled';
    const meter = p.hasReadUsage ? 'readUsage' : 'no readUsage';
    const pools = p.pools.length
      ? `pools: ${p.pools.join(', ')}`
      : p.tier === 'contrib' && !p.enabled ? 'pools: (not loaded)' : 'pools: none';
    lines.push(`  ${String(p.name ?? '?').padEnd(width)}  ${p.tier.padEnd(11)}  ${loaded.padEnd(16)}  ${meter.padEnd(12)}  ${pools}`);
    for (const s of p.skipped) lines.push(`  ${''.padEnd(width)}  ✗ skipped ${s.pool ?? '(unnamed)'}: ${s.message}`);
    if (p.error) lines.push(`  ${''.padEnd(width)}  ✗ error: ${p.error}`);
  }
  lines.push(
    '',
    `Contrib providers load when ${report.providersConfig} lists them: bullswarm provider enable <name>.`,
    'Whether a loaded pool is routed is separate: bullswarm strategy set-provider <pool> on|off --yes.',
  );
  return lines.join('\n');
}

// --- enable / disable -----------------------------------------------------------

function writeProvidersConfig(bullswarmDir, config) {
  mkdirSync(bullswarmDir, { recursive: true });
  atomicWriteFileSync(providersConfigPath(bullswarmDir), `${JSON.stringify(config, null, 2)}\n`);
}

function enableProvider(bullswarmDir, name, loaderOpts) {
  const dirs = providerDirs(bullswarmDir, loaderOpts);
  const contribDir = join(dirs.contrib, name);
  if (!isProviderDir(contribDir)) {
    const known = isDir(dirs.contrib)
      ? readdirSync(dirs.contrib).filter((n) => !n.startsWith('_') && !n.startsWith('.') && isProviderDir(join(dirs.contrib, n)))
      : [];
    throw fail(`no contrib provider named "${name}" (known: ${known.length ? known.join(', ') : 'none'})`);
  }
  // Load every contrib module so the contrib provider's exported name is known
  // too: a local provider claiming either spelling would shadow its pools.
  const { providers } = loadProviders(bullswarmDir, { ...loaderOpts, allContrib: true });
  const contrib = providers.find((p) => p.tier === 'contrib' && p.dir === contribDir);
  const names = new Set([name, contrib?.name].filter(Boolean));
  // Only a real local provider DIRECTORY blocks the name. A legacy
  // `<home>/connectors/<name>.json` does not: every install that predates the
  // provider tiers has one of those for each packaged connector, they are
  // stale copies of the very provider being enabled, and the loader already
  // shadows them (contrib loads first, and P3 keeps the first pool of a name).
  // Refusing on those would make the contrib tier unreachable on every
  // existing install — and would leave the operator on a copy with no meter.
  const claimant = providers.find((p) => p.tier === 'local'
    && names.has(p.name)
    && !p.dir.endsWith('.json'));
  if (claimant) {
    throw fail(`refusing to enable "${name}": the local provider at ${claimant.dir} already claims the name "${claimant.name}"`);
  }
  const config = readProvidersConfig(bullswarmDir);
  if (config.enabled.includes(name)) return { action: 'provider-enable', name, changed: false, config };
  const next = { ...config, enabled: [...config.enabled, name] };
  writeProvidersConfig(bullswarmDir, next);
  return { action: 'provider-enable', name, changed: true, config: next };
}

function disableProvider(bullswarmDir, name) {
  const config = readProvidersConfig(bullswarmDir);
  if (!config.enabled.includes(name)) return { action: 'provider-disable', name, changed: false, config };
  const next = { ...config, enabled: config.enabled.filter((n) => n !== name) };
  writeProvidersConfig(bullswarmDir, next);
  return { action: 'provider-disable', name, changed: true, config: next };
}

// --- validate -----------------------------------------------------------------

const PROVIDER_EXPORTS = ['name', 'displayName', 'connectors', 'readUsage', 'readTranscriptUsage', 'doctor'];
const SPAWN_PLACEHOLDERS = ['taskFile', 'cwd', 'sessionId', 'bullswarmDir'];
const FOLLOW_UP_PLACEHOLDERS = ['taskFile', 'cwd', 'sessionId', 'prompt', 'bullswarmDir'];
const TIERS = ['high', 'medium', 'low'];
const LANES = ['analyze', 'build', 'chore'];
const METER_WINDOWS = ['5h', 'weekly', 'monthly', 'none'];
const QUOTA_WINDOWS = ['5h', 'weekly', 'monthly'];

// The schema is an annotated example document, so its allowed values are the
// `a|b|c` strings it carries. `pwd` is documented in its cwdMode comment.
function schemaEnums() {
  const schema = JSON.parse(readFileSync(new URL('./providers/_schema.json', import.meta.url), 'utf8'));
  const split = (value) => String(value ?? '').split(/\s*\(|\s+/)[0].split('|').filter(Boolean);
  return {
    topKeys: Object.keys(schema).filter((k) => !k.startsWith('$')),
    outputStrategies: split(schema.outputExtraction?.strategy),
    cwdModes: [...new Set([...split(schema.spawn?.cwdMode), 'pwd'])],
    meterTypes: split(schema.meter?.type),
    toolKinds: [...new Set(Object.values(schema.eventStream?.toolKinds ?? {}).flatMap(split))],
  };
}

// Pool fields contract section 6 names that the example document leaves out.
const EXTRA_POOL_KEYS = [
  'model', 'env', 'conversation', 'profile', 'upstreamGroup', 'preferredConcurrency', 'displayName',
];

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function checkPool(pool, providerName, { enums, hasReadUsage }) {
  const errors = [];
  const warnings = [];
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
    return { name: null, ok: false, errors: ['pool is not an object'], warnings };
  }
  const name = typeof pool.name === 'string' ? pool.name : null;
  if (!name) errors.push('name: required non-empty string');
  else if (!ownsPoolName(providerName, name)) errors.push(`name: must be "${providerName}" or "${providerName}:<suffix>"`);

  const cmd = pool.spawn?.cmd;
  if (!pool.spawn || typeof pool.spawn !== 'object') errors.push('spawn: required object');
  else if (!isStringArray(cmd) || cmd.length === 0) errors.push('spawn.cmd: required non-empty array of strings');
  else {
    if (!cmd.some((a) => a.includes('{taskFile}'))) errors.push('spawn.cmd: must contain {taskFile}');
    for (const a of cmd) {
      for (const [, placeholder] of a.matchAll(/\{([A-Za-z]+)\}/g)) {
        if (!SPAWN_PLACEHOLDERS.includes(placeholder)) {
          errors.push(`spawn.cmd: unknown placeholder {${placeholder}} (allowed: ${SPAWN_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')})`);
        }
      }
    }
  }
  if (pool.spawn?.cwdMode !== undefined && !enums.cwdModes.includes(pool.spawn.cwdMode)) {
    errors.push(`spawn.cwdMode: must be ${enums.cwdModes.join(', ')}`);
  }

  const followUp = pool.conversation?.followUp;
  if (followUp !== undefined) {
    if (!followUp || typeof followUp !== 'object' || Array.isArray(followUp)) {
      errors.push('conversation.followUp: must be an object');
    } else {
      if (!isStringArray(followUp.cmd) || followUp.cmd.length === 0) {
        errors.push('conversation.followUp.cmd: required non-empty array of strings');
      } else {
        for (const arg of followUp.cmd) {
          for (const [, placeholder] of arg.matchAll(/\{([A-Za-z]+)\}/g)) {
            if (!FOLLOW_UP_PLACEHOLDERS.includes(placeholder)) {
              errors.push(`conversation.followUp.cmd: unknown placeholder {${placeholder}} (allowed: ${FOLLOW_UP_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')})`);
            }
          }
        }
      }
      if (followUp.eventStreamArgs !== undefined && !isStringArray(followUp.eventStreamArgs)) {
        errors.push('conversation.followUp.eventStreamArgs: must be an array of strings');
      }
    }
  }

  const strategy = pool.outputExtraction?.strategy;
  if (strategy === undefined) errors.push('outputExtraction.strategy: required');
  else if (!enums.outputStrategies.includes(strategy)) {
    errors.push(`outputExtraction.strategy: must be ${enums.outputStrategies.join(', ')}`);
  }
  if (strategy === 'event-stream' && !Array.isArray(pool.eventStream?.output)) {
    warnings.push('eventStream.output: event-stream extraction without output rules falls back to raw stdout');
  }
  const usageRules = pool.eventStream?.usage;
  const hasUsageRules = Array.isArray(usageRules)
    ? usageRules.length > 0
    : Boolean(usageRules && typeof usageRules === 'object' && Object.keys(usageRules).length > 0);
  if (pool.eventStream !== undefined && !hasUsageRules) {
    warnings.push('eventStream.usage: eventStream is declared but no usage rules exist; attempts require transcript or byte fallback');
  }
  const capture = pool.eventStream?.capture;
  if (capture !== undefined) {
    if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
      errors.push('eventStream.capture: must be an object');
    } else {
      for (const key of ['responseBytes', 'fileBytes']) {
        if (capture[key] !== undefined && !(Number.isInteger(capture[key]) && capture[key] > 0)) {
          errors.push(`eventStream.capture.${key}: must be a positive integer`);
        }
      }
      for (const key of Object.keys(capture)) {
        if (!key.startsWith('$') && key !== 'responseBytes' && key !== 'fileBytes') {
          errors.push(`eventStream.capture.${key}: unknown capture field`);
        }
      }
    }
  }
  const toolKinds = pool.eventStream?.toolKinds;
  if (toolKinds !== undefined) {
    if (!toolKinds || typeof toolKinds !== 'object' || Array.isArray(toolKinds)) {
      errors.push('eventStream.toolKinds: must be an object of tool name → kind');
    } else {
      for (const [tool, kind] of Object.entries(toolKinds)) {
        if (!enums.toolKinds.includes(kind)) errors.push(`eventStream.toolKinds.${tool}: must be ${enums.toolKinds.join(', ')}`);
      }
    }
  } else if (pool.eventStream !== undefined) {
    warnings.push('eventStream.toolKinds: no tool kinds declared; the Step page counts every tool as other');
  }

  const hasModel = (typeof pool.model === 'string' && pool.model !== '')
    || (isStringArray(pool.knownModels) && pool.knownModels.length > 0)
    || (pool.modelDiscovery && typeof pool.modelDiscovery === 'object');
  if (!hasModel) errors.push('model: set model, knownModels, or modelDiscovery');
  if (pool.modelSelection?.flag !== undefined && typeof pool.modelSelection.flag !== 'string') {
    errors.push('modelSelection.flag: must be a string');
  }

  if (pool.meter !== undefined) {
    if (!enums.meterTypes.includes(pool.meter?.type)) errors.push(`meter.type: must be ${enums.meterTypes.join(', ')}`);
    if (pool.meter?.window !== undefined
      && !String(pool.meter.window).split('+').every((w) => METER_WINDOWS.includes(w))) {
      errors.push(`meter.window: must be ${METER_WINDOWS.join(', ')}, or several joined with +`);
    }
    if (pool.meter?.type === 'reader' && !hasReadUsage) {
      warnings.push('meter.type: reader, but the provider exports no readUsage, so the pool is unmetered');
    }
  }

  if (pool.modelProfiles !== undefined) {
    if (!Array.isArray(pool.modelProfiles)) errors.push('modelProfiles: must be an array');
    else pool.modelProfiles.forEach((profile, i) => {
      // src/lib/usage.js matches a profile by exact `id` or by `match` regex.
      if (typeof profile?.match !== 'string' && typeof profile?.id !== 'string') {
        errors.push(`modelProfiles[${i}]: set match (a regex) or id (an exact model id)`);
      } else if (typeof profile.match === 'string') {
        try { new RegExp(profile.match, 'i'); } catch (err) { errors.push(`modelProfiles[${i}].match: ${err.message}`); }
      }
      if (profile?.tier !== undefined && !TIERS.includes(profile.tier)) {
        errors.push(`modelProfiles[${i}].tier: must be ${TIERS.join(', ')}`);
      }
      if (profile?.pricing && typeof profile.pricing === 'object') {
        const hasCacheWriteRate = [
          profile.pricing.cacheWriteUsdPerMillion,
          profile.pricing.cacheWrite5mUsdPerMillion,
          profile.pricing.cacheWrite1hUsdPerMillion,
        ].some((rate) => rate !== null && rate !== undefined && rate !== ''
          && Number.isFinite(Number(rate)) && Number(rate) >= 0);
        if (!hasCacheWriteRate) {
          warnings.push(`modelProfiles[${i}].pricing: cache-write rate missing (cacheWrite5mUsdPerMillion/cacheWrite1hUsdPerMillion)`);
        }
      }
    });
  }

  const reasoning = pool.reasoning;
  if (reasoning !== undefined) {
    if ((reasoning?.flag === undefined) === (reasoning?.args === undefined)) {
      errors.push('reasoning: declare exactly one of flag or args');
    }
    if (reasoning?.flag !== undefined && typeof reasoning.flag !== 'string') errors.push('reasoning.flag: must be a string');
    if (reasoning?.args !== undefined && !isStringArray(reasoning.args)) errors.push('reasoning.args: must be an array of strings');
    if (reasoning?.levels !== undefined
      && !(isStringArray(reasoning.levels) && reasoning.levels.every((l) => REASONING_LEVELS.includes(l)))) {
      errors.push(`reasoning.levels: must be a subset of ${REASONING_LEVELS.join(', ')}`);
    }
    for (const [tier, level] of Object.entries(reasoning?.defaults ?? {})) {
      if (!TIERS.includes(tier)) errors.push(`reasoning.defaults.${tier}: unknown tier (${TIERS.join(', ')})`);
      if (!REASONING_LEVELS.includes(level) && level !== 'default') {
        errors.push(`reasoning.defaults.${tier}: must be ${REASONING_LEVELS.join(', ')} or default`);
      }
    }
  }

  const quotaWindow = pool.subscription?.quotaWindow;
  if (quotaWindow != null && !QUOTA_WINDOWS.includes(quotaWindow)) {
    errors.push(`subscription.quotaWindow: must be ${QUOTA_WINDOWS.join(', ')} or null`);
  }
  if (pool.env !== undefined
    && (!pool.env || typeof pool.env !== 'object' || !Object.values(pool.env).every((v) => typeof v === 'string'))) {
    errors.push('env: must be an object of string values');
  }
  if (pool.lanes !== undefined && !(isStringArray(pool.lanes) && pool.lanes.every((l) => LANES.includes(l)))) {
    errors.push(`lanes: must be a subset of ${LANES.join(', ')}`);
  }
  if (pool.costRank !== undefined && !Number.isFinite(pool.costRank)) errors.push('costRank: must be a number');
  for (const key of ['credentialGroup', 'upstreamGroup', 'bin']) {
    if (pool[key] !== undefined && typeof pool[key] !== 'string') errors.push(`${key}: must be a string`);
  }
  if (pool.configDirs !== undefined && !isStringArray(pool.configDirs)) errors.push('configDirs: must be an array of strings');

  const known = new Set([...enums.topKeys, ...EXTRA_POOL_KEYS]);
  for (const key of Object.keys(pool)) {
    if (!key.startsWith('$') && !known.has(key)) warnings.push(`${key}: not a pool field any reader uses`);
  }
  return { name, ok: errors.length === 0, errors, warnings };
}

function resolveProviderTarget(bullswarmDir, target, loaderOpts) {
  const asPath = resolve(target);
  if (isDir(asPath)) return asPath;
  const dirs = providerDirs(bullswarmDir, loaderOpts);
  for (const root of [dirs.local, dirs.contrib, dirs.firstClass]) {
    if (isProviderDir(join(root, target))) return join(root, target);
  }
  throw fail(`no provider directory "${target}" (looked for a path, then ${dirs.local}, ${dirs.contrib}, ${dirs.firstClass})`);
}

export function validateProvider(bullswarmDir, dir, loaderOpts = {}) {
  const report = {
    schemaVersion: 'bullswarm.provider.validate.v1',
    dir,
    name: null,
    ok: false,
    exports: {},
    errors: [],
    warnings: [],
    pools: [],
  };
  if (!isProviderDir(dir)) {
    report.errors.push('directory has neither connector.json nor provider.mjs');
    return report;
  }
  let template = null;
  const jsonPath = join(dir, 'connector.json');
  if (existsSync(jsonPath)) {
    try {
      template = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      report.errors.push(`connector.json: ${err.message}`);
    }
  }
  let mod = null;
  const modulePath = join(dir, 'provider.mjs');
  if (existsSync(modulePath)) {
    try {
      mod = require(modulePath);
    } catch (err) {
      report.errors.push(`provider.mjs failed to load (no top-level await; it is loaded synchronously): ${err.message}`);
    }
  }
  if (report.errors.length) return report;

  if (mod) {
    // Other exports are allowed: shipped providers export their parsers for tests.
    for (const key of PROVIDER_EXPORTS) report.exports[key] = typeof mod[key];
    if (typeof mod.name !== 'string' || mod.name === '') report.errors.push('export name: required non-empty string');
    if (mod.displayName !== undefined && typeof mod.displayName !== 'string') report.errors.push('export displayName: must be a string');
    for (const fn of ['connectors', 'readUsage', 'readTranscriptUsage', 'doctor']) {
      if (mod[fn] !== undefined && typeof mod[fn] !== 'function') report.errors.push(`export ${fn}: must be a function`);
    }
    report.name = typeof mod.name === 'string' && mod.name ? mod.name : null;
  } else if (typeof template?.name === 'string' && template.name) {
    report.name = template.name;
  } else {
    report.errors.push('connector.json has no name and there is no provider.mjs');
  }
  if (report.name?.includes(':')) report.errors.push(`name "${report.name}": must not contain ":" (it separates a pool suffix)`);
  if (report.name && report.name !== basename(dir)) {
    report.warnings.push(`name "${report.name}" differs from the directory name "${basename(dir)}"; enable and scaffold use the directory name`);
  }
  if (report.errors.length) return report;

  const dirs = providerDirs(bullswarmDir, loaderOpts);
  const templates = loadTemplates(dirs);
  let pools;
  if (typeof mod?.connectors === 'function') {
    const ctx = {
      kit,
      template: template == null ? null : structuredClone(template),
      templates: structuredClone(templates),
      home: loaderOpts.homeDir ?? homedir(),
      env: loaderOpts.env ?? process.env,
      bullswarmDir,
      opts: loaderOpts,
    };
    try {
      pools = mod.connectors(ctx);
    } catch (err) {
      report.errors.push(`connectors() threw: ${err?.message ?? err}`);
      return report;
    }
    if (pools && typeof pools.then === 'function') {
      pools.catch?.(() => {});
      report.errors.push('connectors() must be synchronous; it returned a Promise');
      return report;
    }
    if (!Array.isArray(pools)) {
      report.errors.push('connectors() must return an array of pools');
      return report;
    }
  } else if (template) {
    pools = [template];
  } else {
    report.errors.push('no connector.json and no connectors() export: the provider has no pools');
    return report;
  }
  if (pools.length === 0) report.warnings.push('the provider returns no pools');

  // Pools other providers already load: a name here that is taken there is
  // skipped at load time (first come, first kept).
  let others = {};
  try {
    const loaded = loadProviders(bullswarmDir, loaderOpts);
    const ownerDirs = Object.fromEntries(loaded.providers.flatMap((p) => p.pools.map((pool) => [pool, p.dir])));
    others = Object.fromEntries(Object.entries(ownerDirs).filter(([, owner]) => owner !== dir));
  } catch { /* the collision check is advisory */ }

  const enums = schemaEnums();
  const seen = new Set();
  for (const pool of pools) {
    const checked = checkPool(pool, report.name, { enums, hasReadUsage: typeof mod?.readUsage === 'function' });
    if (checked.name && seen.has(checked.name)) {
      checked.errors.push(`name: "${checked.name}" is returned twice`);
      checked.ok = false;
    }
    if (checked.name) seen.add(checked.name);
    if (checked.name && others[checked.name]) {
      checked.warnings.push(`name: "${checked.name}" is already loaded from ${others[checked.name]}, which wins; this pool would be skipped`);
    }
    report.pools.push(checked);
  }
  report.ok = report.errors.length === 0 && report.pools.every((p) => p.ok);
  return report;
}

function renderValidate(report) {
  const lines = [`bullswarm provider validate ${report.dir} — ${report.ok ? 'OK' : 'FAILED'}`];
  if (report.name) lines.push(`  provider: ${report.name}`);
  const exported = Object.entries(report.exports).filter(([, type]) => type !== 'undefined').map(([key]) => key);
  if (exported.length) lines.push(`  exports: ${exported.join(', ')}`);
  for (const e of report.errors) lines.push(`  ✗ ${e}`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  for (const pool of report.pools) {
    lines.push(`  ${pool.ok ? '✓' : '✗'} pool ${pool.name ?? '(unnamed)'}`);
    for (const e of pool.errors) lines.push(`      ✗ ${e}`);
    for (const w of pool.warnings) lines.push(`      ! ${w}`);
  }
  if (report.ok) lines.push('', `Next: bullswarm provider probe ${report.pools[0]?.name ?? '<pool>'}`);
  return lines.join('\n');
}

// --- scaffold -----------------------------------------------------------------

const SCAFFOLD_NAME = /^[a-z0-9][a-z0-9-]*$/;

function titleCase(name) {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function providerSkeleton(name, from) {
  const connectorsDoc = from
    ? [
      ' * This directory\'s connector.json was copied from the shipped "' + from + '" template,',
      ' * so `template` below is that pool. Edit connector.json for per-CLI fields;',
      ' * return several clones here for several accounts.',
    ]
    : [
      ' * There is no connector.json yet, so the pool is written inline. Replace',
      ' * the command and fields with your CLI\'s, or clone a shipped template:',
      ' *   return [kit.clonePool(templates.codex, { name: \'' + name + '\', model: \'...\' })];',
    ];
  const body = from
    ? [
      '  // One pool per account, each named "' + name + '" or "' + name + ':<suffix>":',
      '  //   return accounts.map((acc, i) => kit.clonePool(template, {',
      '  //     name: i === 0 ? \'' + name + '\' : `' + name + ':${acc.id}`,',
      '  //     credentialGroup: \'' + name + ':example.com\',',
      '  //   }));',
      '  return [kit.clonePool(template, { name })];',
    ]
    : [
      '  return [{',
      '    name,',
      '    bin: \'' + name + '\',',
      '    // {taskFile} is required; {cwd} {sessionId} {bullswarmDir} are also substituted.',
      '    spawn: { cmd: [\'' + name + '\', \'{taskFile}\'], cwdMode: \'add-dir\' },',
      '    // stdout | stdout-tail | json-field | file | event-stream',
      '    outputExtraction: { strategy: \'stdout\' },',
      '    model: \'default\',',
      '    // reader once readUsage below is implemented; none until then.',
      '    meter: { type: \'none\' },',
      '    lanes: [\'analyze\', \'build\', \'chore\'],',
      '  }];',
    ];
  return [
    `// ${name} — a Bullswarm provider, scaffolded by \`bullswarm provider scaffold\`.`,
    '//',
    '// A provider teaches Bullswarm one agent CLI and returns its pools. The full',
    '// contract is docs/reference/providers.md in the bullswarm package.',
    '//',
    '//   check it  bullswarm provider validate <this directory>',
    `//   run it    bullswarm provider probe ${name}     (the step not to skip)`,
    '//',
    '// Rules:',
    '//   - No top-level await: this file is loaded synchronously.',
    '//   - Use ctx.kit. A file outside the bullswarm package cannot import',
    '//     bullswarm/provider-kit.',
    `//   - Every pool is named "${name}" or "${name}:<suffix>".`,
    '//   - A pool\'s env reaches the CLI verbatim: put a pointer there (a config',
    '//     dir, a key file path), never a secret.',
    '',
    '/** Required: the name every pool of this provider starts with. */',
    `export const name = '${name}';`,
    '',
    '/** Optional: the label strategy tables show. */',
    `export const displayName = '${titleCase(name)}';`,
    '',
    '/**',
    ' * Optional. Returns this provider\'s pools. Synchronous, cheap, and offline:',
    ' * it runs on every bullswarm start. Without it the provider has one pool,',
    ' * connector.json itself.',
    ' *',
    ' * ctx: { kit, template, templates, home, env, bullswarmDir }',
    ' *   template   this directory\'s connector.json, parsed, or null',
    ' *   templates  every shipped connector.json by provider name',
    ' *',
    ...connectorsDoc,
    ' */',
    `export function connectors({ kit, template, templates }) {`,
    ...body,
    '}',
    '',
    '// Optional. One live usage read for one pool, returning a snapshot. ctx also',
    '// carries `subscription`: the pool\'s declared plan ({ plan, quotaWindow,',
    '// includedValueUsd, resetsAt, monthlyPriceUsd }) or null. Read credentials',
    '// yourself (a key file, a keychain entry); throw an Error, or',
    '// kit.MeterError(message, code), when the read fails. Without readUsage the',
    '// pool uses its declared meter or is unmetered. Uncomment to implement:',
    '//',
    '// export async function readUsage(pool, { kit, home, subscription }) {',
    '//   const token = readFileSync(`${home}/.config/example/key`, \'utf8\').trim();',
    '//   const body = await kit.bearerJson(\'https://api.example.com/usage\', token);',
    '//   return kit.snapshot({',
    '//     pool,',
    '//     used_usd: body.used_usd,',
    '//     monthly: { utilization: kit.pct(body.used_usd, subscription?.includedValueUsd), resets_at: null },',
    '//   });',
    '// }',
    '',
    '// Optional. Readiness for `bullswarm setup`. Without it: installed means',
    '// `bin` is on PATH, loggedIn means any configDirs entry exists.',
    '//',
    '// export function doctor({ home }) {',
    `//   return { installed: true, loggedIn: null, hint: 'run ${name} login' };`,
    '// }',
    '',
  ].join('\n');
}

function scaffoldProvider(bullswarmDir, name, { from = null, dir = null } = {}, loaderOpts = {}) {
  if (!SCAFFOLD_NAME.test(name)) {
    throw fail(`provider name "${name}" must be lowercase letters, digits, and dashes`);
  }
  const target = dir ? resolve(dir) : join(bullswarmDir, 'providers', name);
  if (existsSync(target) && (!isDir(target) || readdirSync(target).length > 0)) {
    throw fail(`refusing to scaffold into ${target}: it already exists and is not empty`);
  }
  let connector = null;
  const notes = [];
  if (from) {
    const templates = loadTemplates(providerDirs(bullswarmDir, loaderOpts));
    if (!templates[from]) {
      throw fail(`no shipped template "${from}" (known: ${Object.keys(templates).join(', ') || 'none'})`);
    }
    connector = { ...structuredClone(templates[from]), name };
    if (connector.meter?.type === 'reader') {
      connector.meter = { ...connector.meter, type: 'none' };
      notes.push(`meter.type set to none: "${from}" reads usage through its own provider; export readUsage, then set it back to reader`);
    }
    if (connector.flags?.isCaller) connector.flags = { ...connector.flags, isCaller: false };
  }
  mkdirSync(target, { recursive: true });
  const files = [join(target, 'provider.mjs')];
  writeFileSync(files[0], providerSkeleton(name, from));
  if (connector) {
    files.push(join(target, 'connector.json'));
    writeFileSync(files[1], `${JSON.stringify(connector, null, 2)}\n`);
  }
  return { action: 'provider-scaffold', name, dir: target, from, files, notes };
}

// --- probe --------------------------------------------------------------------

/** Replace every value of the pool's env (and any secret-looking argv value) with a marker. */
function redactor(connector) {
  const values = Object.values(connector.env ?? {})
    .filter((v) => typeof v === 'string' && v.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const value of values) out = out.split(value).join('[redacted env value]');
    return out;
  };
}

export async function probePool(bullswarmDir, poolName, { loaderOpts = {}, timeoutSec = PROBE_TIMEOUT_SEC } = {}) {
  // Contrib providers are probed before they are enabled: probing is how an
  // author earns the enable.
  const { connectors, providers } = loadProviders(bullswarmDir, { ...loaderOpts, allContrib: true });
  const connector = connectors[poolName];
  if (!connector) {
    const owner = providerFor(providers, poolName);
    const why = owner?.error ? ` (provider "${owner.name}" failed to load: ${owner.error})`
      : owner?.skipped?.find((s) => s.pool === poolName)?.message
        ? ` (skipped: ${owner.skipped.find((s) => s.pool === poolName).message})`
        : '';
    throw fail(`unknown pool "${poolName}"${why}; known pools: ${Object.keys(connectors).join(', ') || 'none'}`);
  }
  const entry = providerFor(providers, poolName);
  const redact = redactor(connector);
  const work = mkdtempSync(join(tmpdir(), 'bullswarm-probe-'));
  const paths = { taskFile: join(work, 'task.md'), outFile: join(work, 'output.txt') };
  const result = {
    schemaVersion: 'bullswarm.provider.probe.v1',
    pool: poolName,
    provider: entry?.name ?? null,
    tier: entry?.tier ?? null,
    task: PROBE_TASK,
    argv: [],
    elapsedMs: null,
    exitCode: null,
    timedOut: false,
    verdict: null,
    output: '',
    pong: false,
    usage: { called: false, snapshot: null, error: null },
    ok: false,
  };
  try {
    result.argv = argvWithModel(connector, { taskFile: paths.taskFile, cwd: resolve(work) }).map(redact);
    // The dispatcher's own runner and extraction. No pickPool, no quota gate,
    // no assignment ledger, and no BULLSWARM_DEPTH refusal: probe names the
    // pool itself.
    const startedAt = Date.now();
    const verdict = await watchOnce(connector, PROBE_TASK, work, paths, {
      timeoutSec, bullswarmDir, processGroup: true,
    });
    result.elapsedMs = Date.now() - startedAt;
    result.exitCode = verdict.meta?.exitCode ?? null;
    result.timedOut = verdict.meta?.timedOut === true;
    result.verdict = redact(verdict.why);
    result.output = redact(existsSync(paths.outFile) ? readFileSync(paths.outFile, 'utf8') : '');
    result.pong = /\bPONG\b/i.test(result.output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (entry?.hasReadUsage) {
    const state = loadState(bullswarmDir);
    const declared = { ...(connector.subscription ?? {}), ...(state.strategy?.subscriptions?.[poolName] ?? {}) };
    const subscription = Object.keys(declared).length ? declared : null;
    result.usage.called = true;
    try {
      result.usage.snapshot = await entry.module.readUsage(poolName, { ...entry.ctx, subscription });
    } catch (err) {
      result.usage.error = { message: redact(err?.message ?? String(err)), code: err?.code ?? null };
    }
  }
  result.ok = result.pong && !result.usage.error;
  return result;
}

function renderProbe(r) {
  const shown = r.output.length > 2000 ? `${r.output.slice(0, 2000)}\n…[${r.output.length - 2000} more characters]` : r.output;
  const usageLine = !r.usage.called
    ? `– provider "${r.provider}" exports no readUsage`
    : r.usage.error
      ? `✗ readUsage threw${r.usage.error.code ? ` (${r.usage.error.code})` : ''}: ${r.usage.error.message}`
      : `✓ ${JSON.stringify(r.usage.snapshot)}`;
  return [
    `bullswarm provider probe ${r.pool} — ${r.ok ? 'OK' : 'FAILED'}`,
    `  provider: ${r.provider} (${r.tier})`,
    `  argv:     ${r.argv.join(' ')}`,
    `  elapsed:  ${(r.elapsedMs / 1000).toFixed(1)}s · exit ${r.exitCode ?? 'none'}${r.timedOut ? ' · timed out' : ''}`,
    `  runner:   ${r.verdict}`,
    `  reply:    ${r.pong ? '✓ contains PONG' : '✗ does not contain PONG'}`,
    '  output:',
    ...(shown ? shown.split('\n').map((l) => `    ${l}`) : ['    (empty)']),
    `  usage:    ${usageLine}`,
  ].join('\n');
}

// --- dispatcher ---------------------------------------------------------------

/**
 * `bullswarm provider <sub>`. `loaderOpts` reaches loadProviders (tests point
 * it at fixture directories); `log`/`error` default to the console.
 */
export async function cmdProvider(args, {
  bullswarmDir, loaderOpts = {}, log = console.log, error = console.error,
} = {}) {
  const [head, ...tail] = args;
  const sub = head === undefined || flagName(head) ? 'list' : head;
  const opts = parseFlags(head !== undefined && flagName(head) ? args : tail);
  try {
    if (sub === 'help' || opts.help) {
      log(helpText(['provider']));
      return 0;
    }
    if (!SUBCOMMANDS.includes(sub)) {
      error(`✗ unknown command "provider ${sub}"`);
      error(helpText(['provider']));
      return 2;
    }
    const flagExit = unknownFlagExit(opts._flags, ['provider', sub], { error });
    if (flagExit !== null) return flagExit;
    const [operand] = opts.rest;

    if (sub === 'list') {
      const report = listReport(bullswarmDir, loaderOpts);
      log(opts.json ? JSON.stringify(report, null, 2) : renderList(report));
      return 0;
    }
    if (sub === 'enable' || sub === 'disable') {
      if (!operand) throw usage(sub, 'missing <name>');
      const result = sub === 'enable'
        ? enableProvider(bullswarmDir, operand, loaderOpts)
        : disableProvider(bullswarmDir, operand);
      const verb = sub === 'enable' ? 'enabled' : 'disabled';
      log(result.changed
        ? `✓ contrib provider "${operand}" ${verb} in ${providersConfigPath(bullswarmDir)}; its pools ${sub === 'enable' ? 'load' : 'stop loading'} on the next bullswarm start`
        : `contrib provider "${operand}" was already ${verb}; nothing written`);
      log('Loading is not routing: bullswarm strategy set-provider <pool> on|off --yes decides whether a loaded pool gets work.');
      return 0;
    }
    if (sub === 'validate') {
      if (!operand) throw usage(sub, 'missing <dir|name>');
      const dir = resolveProviderTarget(bullswarmDir, operand, loaderOpts);
      const report = validateProvider(bullswarmDir, dir, loaderOpts);
      log(opts.json ? JSON.stringify(report, null, 2) : renderValidate(report));
      return report.ok ? 0 : 2;
    }
    if (sub === 'scaffold') {
      if (!operand) throw usage(sub, 'missing <name>');
      if (opts.from === true) throw usage(sub, 'missing --from <template>');
      if (opts.dir === true) throw usage(sub, 'missing --dir <path>');
      const result = scaffoldProvider(bullswarmDir, operand, {
        from: typeof opts.from === 'string' ? opts.from : null,
        dir: typeof opts.dir === 'string' ? opts.dir : null,
      }, loaderOpts);
      log(`✓ scaffolded provider "${result.name}" in ${result.dir}`);
      for (const file of result.files) log(`  wrote ${file}`);
      for (const note of result.notes) log(`  note: ${note}`);
      log(`Next: bullswarm provider validate ${result.dir}, then bullswarm provider probe ${result.name}`);
      return 0;
    }
    // probe
    if (!operand) throw usage(sub, 'missing <pool>');
    let timeoutSec = PROBE_TIMEOUT_SEC;
    if (opts.timeout !== undefined) {
      timeoutSec = Number(opts.timeout);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw usage(sub, '--timeout must be a positive number of seconds');
    }
    const result = await probePool(bullswarmDir, operand, { loaderOpts, timeoutSec });
    log(opts.json ? JSON.stringify(result, null, 2) : renderProbe(result));
    return result.ok ? 0 : 1;
  } catch (err) {
    error(`✗ ${err.message}`);
    return err.exitCode ?? 1;
  }
}
