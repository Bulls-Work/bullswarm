// Provider-neutral transcript hook.  Provider quirks stay in their sibling
// modules; this file only normalizes provider selection and the no-reader
// result used by callers that do not have a durable transcript hook.

import { homedir } from 'node:os';

import { buildTranscriptIndex as buildClaudeIndex, readTranscriptUsage as readClaudeTranscriptUsage } from './claude-code.js';
import { buildTranscriptIndex as buildCodexIndex, readTranscriptUsage as readCodexTranscriptUsage } from './codex.js';
import { buildTranscriptIndex as buildGrokIndex, readTranscriptUsage as readGrokTranscriptUsage } from './grok.js';

const READERS = Object.freeze({
  claude: readClaudeTranscriptUsage,
  'claude-code': readClaudeTranscriptUsage,
  codex: readCodexTranscriptUsage,
  grok: readGrokTranscriptUsage,
});

const INDEXERS = Object.freeze({
  claude: buildClaudeIndex,
  'claude-code': buildClaudeIndex,
  codex: buildCodexIndex,
  grok: buildGrokIndex,
});

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
    file: null,
    firstAt: null,
    lastAt: null,
    requests: [],
    confidence: 'none',
  };
}

function providerKey(provider) {
  const raw = typeof provider === 'string' ? provider : provider?.name;
  if (typeof raw !== 'string' || !raw) return null;
  return raw.toLowerCase().split(':', 1)[0];
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
  home = homedir(),
  index = null,
} = {}) {
  const reader = READERS[providerKey(provider)];
  if (!reader) return none();
  try {
    return reader({ sessionId, cwd, startedAt, endedAt, home, index });
  } catch {
    return none();
  }
}

/** Build each provider store index once for a bulk repricing invocation. */
export function buildTranscriptIndexes({ home = homedir(), providers = ['claude-code', 'codex', 'grok'] } = {}) {
  const indexes = {};
  for (const provider of providers) {
    const key = providerKey(provider);
    const build = INDEXERS[key];
    if (!build || indexes[key]) continue;
    try { indexes[key] = build({ home }); } catch { indexes[key] = null; }
  }
  return indexes;
}

export function indexedTranscriptReader({ home = homedir(), providers } = {}) {
  const indexes = buildTranscriptIndexes({ home, providers });
  return (args = {}) => readTranscriptUsage({
    ...args,
    home: args.home ?? home,
    index: indexes[providerKey(args.provider)] ?? null,
  });
}

export { blankTokens };
