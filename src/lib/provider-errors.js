// The provider's error channel of one attempt (watch.js W5-W7): the records a
// provider flags as errors or ends on, kept apart from the agent's own reply
// (which may quote a quota or auth signature), the auth signature a failure
// names, and a reply that is only the provider's own limit notice.

import { ERROR_SHAPED_LINE, findQuotaFailure } from './quota.js';
import { JSON_ERROR_EVENT_LINE } from './auth-signatures.js';

// True when the provider reported the turn's usage and it produced nothing:
// output tokens 0 when counted, otherwise every reported counter 0.
function reportedNoWork(reportedUsage) {
  if (!reportedUsage || typeof reportedUsage !== 'object') return false;
  if (typeof reportedUsage.output === 'number') return reportedUsage.output === 0;
  const counters = Object.entries(reportedUsage)
    .filter(([key, value]) => key !== 'sessionId' && typeof value === 'number');
  return counters.length > 0 && counters.every(([, value]) => value === 0);
}

// The reply as the provider's own limit notice (W7's one exception): the
// whole trimmed reply is a single line the quota gate accepts as a notice,
// from a turn the provider reports as having produced nothing.
export function relayedQuotaNotice(connector, reply, reportedUsage) {
  const text = typeof reply === 'string' ? reply.trim() : '';
  if (!text || /[\r\n]/.test(text) || !reportedNoWork(reportedUsage)) return null;
  const hit = findQuotaFailure(connector, text);
  return hit && hit.line === text ? text : null;
}

export function matchAuthSignature(connector, text) {
  const sigs = connector.authSignatures ?? [];
  return sigs.find((s) => text.toLowerCase().includes(s.toLowerCase())) ?? null;
}

export function matchLikelyAuthFailure(connector, text) {
  const hit = matchAuthSignature(connector, text);
  if (!hit) return null;
  const lower = String(text).toLowerCase();
  const index = lower.indexOf(hit.toLowerCase());
  const lineStart = lower.lastIndexOf('\n', index) + 1;
  const lineEnd = lower.indexOf('\n', index);
  const line = lower.slice(lineStart, lineEnd < 0 ? lower.length : lineEnd).trim();
  // A provider error event is a machine record of a failure and counts as
  // error-shaped however it reads (auth-signatures.js A2); anything else must
  // look like a provider failure rather than report or source text.
  if (JSON_ERROR_EVENT_LINE.test(line)) return hit;
  return ERROR_SHAPED_LINE.test(line) ? hit : null;
}

/**
 * How much of the raw stdout an error-channel scan reads in the live path (the
 * verdict-time read uses the whole capture). A provider failure is at the
 * failure point, so the tail is where its record is.
 */
export const PROVIDER_ERROR_SCAN_CHARS = 64 * 1024;

/** Longest single provider record kept as evidence. */
export const ERROR_RECORD_MAX_CHARS = 4000;

/** Bound on the concatenated error channel. */
export const ERROR_CHANNEL_MAX_CHARS = 8000;

/**
 * Characters compared to tell a provider's terminal record from the agent's
 * own reply it mirrors (Claude Code's `result` repeats the final message).
 */
const MIRRORED_REPLY_CHARS = 60;

function declaredFailureSet(declared) {
  return declared instanceof Set ? declared : new Set((declared ?? []).map(String));
}

/**
 * Does `text` open the same way as something the agent itself wrote? A
 * provider that mirrors the agent's final message into its terminal record
 * (Claude Code's `result`) is repeating the agent's own words, and the gate
 * must not be fooled by the copy. A genuine limit notice shares no opening.
 */
/** The whitespace-collapsed opening of a reply, as long as the mirror check reads. */
export function replyOpening(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MIRRORED_REPLY_CHARS);
}

export function mirrorsAgentReply(text, agentText) {
  const head = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MIRRORED_REPLY_CHARS);
  return Boolean(head) && String(agentText ?? '').replace(/\s+/g, ' ').includes(head);
}

/**
 * A record type a CLI uses for its OWN summary of the finished turn: Claude
 * Code and Command Code write `result`, Codex writes `turn.completed`, grok
 * writes `end`. The agent's own events are `assistant` / `item.completed` /
 * `message_end` / `text`, never one of these — that separation is what makes
 * the record evidence and a reply not.
 */
const TERMINAL_RECORD_TYPE =
  /^(?:result|turn[._](?:completed|failed|end)|run[._](?:end|complete[d]?)|end|done)$/i;

/** Longest string leaf of a terminal record that still enters the channel. */
const TERMINAL_RECORD_MAX_STRINGS = 6;

/**
 * Keys whose values are identifiers or enums, never the provider's words. The
 * token itself is still available through the record's raw line.
 */
const RECORD_META_KEYS = new Set([
  'type', 'subtype', 'kind', 'status', 'level', 'severity', 'code', 'id', 'uuid',
  'model', 'sessionid', 'session_id', 'thread_id', 'requestid', 'request_id', 'timestamp', 'at',
]);

/** Bounded string leaves of a provider record, in order. */
function providerRecordStrings(value) {
  const out = [];
  const walk = (node, depth) => {
    if (out.length >= TERMINAL_RECORD_MAX_STRINGS || depth > 4) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text) out.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (RECORD_META_KEYS.has(key.toLowerCase())) continue;
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * Is this decoded JSONL line a record the PROVIDER flagged as its own failure?
 * Top-level markers only: an `error` field nested inside a tool result is the
 * tool talking, and an assistant message is never a provider failure record.
 */
export function isProviderErrorRecord(value, declared = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = typeof value.type === 'string' ? value.type : '';
  if (declaredFailureSet(declared).has(type)) return true;
  if (value.is_error === true || value.isError === true || value.status === 'error') return true;
  if (typeof value.subtype === 'string' && /error|fail/i.test(value.subtype)) return true;
  if (/^(?:error|error[._-]|stream[._-]error|turn[._-]failed)/i.test(type)) return true;
  return value.error != null && (typeof value.error === 'object' || typeof value.error === 'string');
}

/**
 * The records in `text` the provider itself wrote about this attempt: the
 * events it flags as errors and its terminal summary. Each is reduced to the
 * provider's own strings — so a verdict quotes the sentence the provider wrote,
 * not a JSON blob — and a terminal record's strings that repeat the agent's
 * reply are dropped (the CLI mirrors the final message into `result`). Raw
 * error lines are kept as well, because an upstream body is a machine record
 * of a failure whatever it reads like. Only complete lines that parse as JSON
 * objects are read, so an agent's prose cannot enter the error channel (W7).
 */
export function providerErrorRecords(text, declared = [], { agentText = '' } = {}) {
  const types = declaredFailureSet(declared);
  const kept = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 2 || trimmed.length > ERROR_RECORD_MAX_CHARS || trimmed[0] !== '{') continue;
    let value;
    try { value = JSON.parse(trimmed); } catch { continue; }
    const failure = isProviderErrorRecord(value, types);
    if (!failure && !TERMINAL_RECORD_TYPE.test(typeof value?.type === 'string' ? value.type : '')) {
      continue;
    }
    // The raw record comes first for an error event: an upstream body is a
    // machine record of a failure, and the auth table is matched against it
    // (auth-signatures.js A1/A2). Its own strings follow, so a signature the
    // raw line cannot carry still has the provider's words to match.
    if (failure) kept.push(trimmed);
    for (const leaf of providerRecordStrings(value)) {
      if (!failure && mirrorsAgentReply(leaf, agentText)) continue;
      kept.push(leaf);
    }
  }
  return kept.join('\n').slice(-ERROR_CHANNEL_MAX_CHARS);
}
