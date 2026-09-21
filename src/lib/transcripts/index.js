// Provider-neutral transcript hook.  Provider quirks stay in their sibling
// modules; this file only normalizes provider selection and the no-reader
// result used by callers that do not have a durable transcript hook.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadProviders, providerFor, transcriptReaderFor } from '../providers.js';

function blankTokens() {
  return {
    standardRead: null,
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    totalKnown: null,
  };
}

function none() {
  return {
    tokens: blankTokens(),
    model: null,
    sessionId: null,
    cwd: null,
    file: null,
    firstAt: null,
    lastAt: null,
    requests: [],
    confidence: 'none',
  };
}

function providerName(provider) {
  const raw = typeof provider === 'string' ? provider : provider?.name;
  return typeof raw === 'string' && raw ? raw : null;
}

function providerEntries(providers) {
  if (Array.isArray(providers)) return providers;
  if (Array.isArray(providers?.providers)) return providers.providers;
  return [];
}

/**
 * The old public helper accepted `provider: "codex"` without a provider
 * registry. Keep that call shape useful for library consumers and the
 * first-class transcript tests, but discover the implementation through the
 * shipped provider directories rather than maintaining a second hard-coded
 * reader table here.
 */
function loadTranscriptProviders({ home = homedir(), bullswarmDir = null } = {}) {
  const root = typeof bullswarmDir === 'string' && bullswarmDir
    ? bullswarmDir
    : join(home, '.bullswarm');
  try {
    return loadProviders(root, { packaged: true }).providers;
  } catch {
    return [];
  }
}

function resolveEntries(providers, { home = homedir(), bullswarmDir = null } = {}) {
  const supplied = providerEntries(providers);
  const explicitlySupplied = Array.isArray(providers) || Array.isArray(providers?.providers);
  const loaded = explicitlySupplied
    ? supplied
    : loadTranscriptProviders({ home, bullswarmDir });
  // Older callers supplied a list of provider names to the index builder.
  // Resolve those names through the same owner helper instead of treating the
  // strings as provider entries.
  if (supplied.length && supplied.every((entry) => typeof entry === 'string')) {
    const available = loadTranscriptProviders({ home, bullswarmDir });
    return supplied.map((name) => providerFor(available, name)).filter(Boolean);
  }
  return loaded;
}

function resolveOwner(providers, pool) {
  const owner = providerFor(providers, pool);
  if (owner) return owner;
  const poolName = providerName(pool)?.toLowerCase();
  // Workflow records written before the OpenCode pool rename still use
  // `opencode2[:account]`. Resolve that historical name through the loaded
  // `opencode` provider so repricing does not strand old attempts.
  if (poolName === 'opencode2' || poolName?.startsWith('opencode2:')) {
    return providerFor(providers, `opencode${poolName.slice('opencode2'.length)}`);
  }
  // `claude` was the public alias before the provider was named
  // `claude-code`; retain it without making aliases part of provider
  // ownership or pool-prefix matching.
  if (poolName === 'claude') {
    return providerFor(providers, 'claude-code');
  }
  return null;
}

function canonicalProvider(pool, owner) {
  const raw = providerName(pool);
  if (!raw) return owner?.name ?? null;
  if (raw.toLowerCase() === 'claude') return owner?.name ?? raw;
  if (owner?.name?.toLowerCase() === 'opencode'
    && (raw.toLowerCase() === 'opencode2' || raw.toLowerCase().startsWith('opencode2:'))) {
    return `opencode${raw.slice('opencode2'.length)}`;
  }
  return raw;
}

/**
 * Resolve and read one provider's durable transcript.
 *
 * Unknown providers intentionally return `confidence: "none"`; callers can
 * continue through the byte estimate/unknown fallback without treating the
 * absence of a hook as a provider failure.
 */
export function readTranscriptUsage({
  provider,
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  taskText = null,
  taskFile = null,
  taskPath = null,
  home = homedir(),
  index = null,
  providers = null,
  bullswarmDir = null,
} = {}) {
  const entries = resolveEntries(providers, { home, bullswarmDir });
  const owner = resolveOwner(entries, provider);
  const reader = owner ? transcriptReaderFor(entries, owner.name) : null;
  if (!reader) return none();
  try {
    return reader({
      provider: canonicalProvider(provider, owner),
      sessionId,
      cwd,
      startedAt,
      endedAt,
      taskText,
      taskFile,
      taskPath,
      home,
      index,
    });
  } catch {
    return none();
  }
}

/** Build each provider store index once for a bulk repricing invocation. */
export function buildTranscriptIndexes({
  home = homedir(),
  providers = null,
  bullswarmDir = null,
} = {}) {
  const entries = resolveEntries(providers, { home, bullswarmDir });
  const indexes = {};
  for (const owner of entries) {
    const key = providerName(owner);
    const build = owner?.module?.buildTranscriptIndex;
    if (!key || typeof build !== 'function' || indexes[key]) continue;
    try {
      indexes[key] = build({ home });
    } catch {
      indexes[key] = null;
    }
  }
  return indexes;
}

export function indexedTranscriptReader({
  home = homedir(),
  providers = null,
  bullswarmDir = null,
} = {}) {
  const entries = resolveEntries(providers, { home, bullswarmDir });
  const indexes = buildTranscriptIndexes({ home, providers: entries, bullswarmDir });
  return (args = {}) => readTranscriptUsage({
    ...args,
    home: args.home ?? home,
    providers: entries,
    index: indexes[resolveOwner(entries, args.provider)?.name] ?? null,
  });
}

export { blankTokens };
