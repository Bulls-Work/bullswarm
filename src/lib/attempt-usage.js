// What one attempt used, as watchOnce records it: the provider's own capture
// at worker exit, the pool's meter snapshots around the attempt and the
// ledger rows observed between them, and the transcript reader that measures
// tokens afterwards.

import { join } from 'node:path';
import * as usageLib from './usage.js';
import { meterHistoryIntervals } from '../meters/registry.js';
import { loadProviders, transcriptReaderFor } from './providers.js';

// The usage/subscription workers land their modules independently of this
// wiring action. Resolve them lazily so the watcher remains usable in a
// partially integrated checkout (and so focused tests can inject the exact
// seams they exercise). Once present, these are the contract modules, not
// alternate implementations.
let accountingModulesPromise = null;

export async function accountingModules() {
  accountingModulesPromise ??= Promise.all([
    import('./quota-snapshot.js').catch(() => null),
    import('./subscription-cost.js').catch(() => null),
  ]).then(([quota, subscription]) => ({ quota, subscription }));
  return accountingModulesPromise;
}

export function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function usageApiUsd(usage) {
  return finiteNonNegative(usage?.api?.usd ?? usage?.cost?.estimatedUsd);
}

export function usageSessionId(usage, reportedUsage, conversation) {
  return usage?.sessionId
    ?? reportedUsage?.sessionId
    ?? conversation?.sessionId
    ?? null;
}

export function decoderUsageForEstimate(connector, reportedUsage) {
  if (!reportedUsage || typeof reportedUsage !== 'object') return reportedUsage;
  const rules = Array.isArray(connector?.eventStream?.usage)
    ? connector.eventStream.usage
    : connector?.eventStream?.usage ? [connector.eventStream.usage] : [];
  const inclusiveOutput = rules.some((rule) => (
    Array.isArray(rule?.inclusive?.output) && rule.inclusive.output.includes('reasoning')
  ));
  // agent-events applies declarative inclusive subtraction as it decodes the
  // stream. usage.js also accepts raw provider counters and subtracts there,
  // so restore the inclusive output only for this hand-off to avoid doing the
  // same subtraction twice at the canonical record boundary.
  if (inclusiveOutput
    && Number.isFinite(Number(reportedUsage.output))
    && Number.isFinite(Number(reportedUsage.reasoning))) {
    return {
      ...reportedUsage,
      output: Number(reportedUsage.output) + Number(reportedUsage.reasoning),
    };
  }
  return reportedUsage;
}

const CAPTURE_TOKEN_FIELDS = [
  'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output', 'reasoning', 'totalKnown',
];

/**
 * The attempt's `capture` block: what the provider itself said when the worker
 * exited, built from the decoded stream alone — no transcript, meter or rate
 * card is consulted, so it is ready the instant the process ends. Token
 * classes are canonical (exclusive) and present only when the provider
 * reported counters; a stream with no counters is `unknown`, never an
 * estimate. The session id is the provider's own when the stream carries
 * one, else the id Bullswarm handed the CLI on its command line.
 */
export function attemptCapture(connector, exit = {}, options = {}) {
  return captureAtExit(connector, exit, options).capture;
}

// The capture plus, when the provider reported counters, the canonical usage
// envelope priced from them (the same record watchOnce ends with, minus the
// meter-side subscription block that needs the end snapshot).
export function captureAtExit(connector, exit = {}, {
  model = null, conversation = null, at = new Date().toISOString(),
} = {}) {
  const reported = exit?.reportedUsage && typeof exit.reportedUsage === 'object' ? exit.reportedUsage : null;
  const usage = reported ? usageLib.estimateInvocationUsage({
    connector,
    model,
    subscription: null,
    reportedUsage: decoderUsageForEstimate(connector, reported),
  }) : null;
  const counted = usage?.tokenSource === 'provider-reported'
    && CAPTURE_TOKEN_FIELDS.some((field) => field !== 'totalKnown' && finiteNonNegative(usage.tokens?.[field]) != null);
  const reportedSessionId = typeof reported?.sessionId === 'string' && reported.sessionId ? reported.sessionId : null;
  const template = conversation?.resume ? connector?.conversation?.resumeArgs : connector?.conversation?.newArgs;
  const assignedSessionId = typeof conversation?.sessionId === 'string' && conversation.sessionId
    && Array.isArray(template) && template.some((arg) => String(arg).includes('{sessionId}'))
    ? conversation.sessionId
    : null;
  const capture = {
    capturedAt: at,
    source: connector?.eventStream?.format === 'jsonl' ? 'event-stream' : 'exit-status',
    providerSessionId: reportedSessionId ?? assignedSessionId,
    sessionSource: reportedSessionId ? 'provider-stream' : assignedSessionId ? 'bullswarm-assigned' : null,
    model: model ?? null,
    tokens: counted
      ? Object.fromEntries(CAPTURE_TOKEN_FIELDS.map((field) => [field, finiteNonNegative(usage.tokens[field])]))
      : null,
    tokenSource: counted ? 'provider-reported' : 'unknown',
    providerCostUsd: finiteNonNegative(reported?.costUsd),
    exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
    signal: typeof exit?.signal === 'string' && exit.signal ? exit.signal : null,
  };
  if (counted) usage.sessionId = capture.providerSessionId;
  return { capture, usage: counted ? usage : null };
}

export async function safeSnapshot(snapshotPool, poolName, home, now, source = 'cache') {
  if (typeof snapshotPool !== 'function' || !poolName || !home) return null;
  try {
    const snapshot = await snapshotPool(poolName, { home, now });
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    // snapshotPool keeps cursor/precision markers non-enumerable for legacy
    // cache-only reads. Preserve them explicitly when crossing this seam;
    // otherwise the ledger cannot bracket the delegate even though the
    // production snapshot reader found the row.
    return {
      ...snapshot,
      ...(snapshot.historyCursor ? { historyCursor: snapshot.historyCursor } : {}),
      ...(snapshot.history_cursor ? { history_cursor: snapshot.history_cursor } : {}),
      ...(snapshot.resolutionPct != null ? { resolutionPct: snapshot.resolutionPct } : {}),
      source: source ?? snapshot.source ?? 'cache',
    };
  } catch {
    return null;
  }
}

function snapshotDelta(quota, start, end) {
  if (typeof quota?.deltaBetween !== 'function') return null;
  try { return quota.deltaBetween(start, end); } catch { return null; }
}

export function snapshotsFor(start, end) {
  return { start: start ?? null, end: end ?? null };
}

export function cursorFor(snapshot, fallbackAt = null) {
  const cursor = snapshot?.historyCursor ?? snapshot?.history_cursor;
  if (cursor && typeof cursor === 'object') return { ...cursor };
  const at = snapshot?.at ?? fallbackAt;
  return at ? { at, window: snapshot?.window ?? null, index: null, source: snapshot?.source ?? null } : null;
}

function epochMs(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function ledgerWindow(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (name === '5h' || name === 'five_hour' || name === 'five-hour') return '5h';
  if (name === 'weekly' || name === 'seven_day' || name === 'seven-day') return 'weekly';
  if (name === 'monthly') return 'monthly';
  return null;
}

/**
 * Read only the ledger rows observed between the start and end cursors. The
 * cursor indexes are preferred because a meter interval may begin before the
 * delegate starts but be observed during it; timestamps are the fallback for
 * cache/history fixtures that predate cursor metadata.
 */
export function attemptLedgerIntervals({
  opts, poolName, home, startSnapshot, endSnapshot, startCursor, endCursor,
  startedAt, endedAt, window = null,
}) {
  const reader = opts.meterHistoryIntervals ?? meterHistoryIntervals;
  if (typeof reader !== 'function' || !poolName) return null;
  if (!home && !opts.meterHistoryDir && !opts.historyDir && !opts.ledgerDir) return null;
  try {
    const rows = reader(poolName, {
      dir: opts.meterHistoryDir ?? opts.historyDir ?? opts.ledgerDir ?? join(home, 'meters'),
      window,
    });
    if (!Array.isArray(rows)) return null;
    const callerPassedWindow = window !== null && window !== undefined;
    const resolvedWindow = ledgerWindow(window);
    const startIndex = Number.isInteger(startCursor?.index) ? startCursor.index : null;
    const endIndex = Number.isInteger(endCursor?.index) ? endCursor.index : null;
    const startMs = epochMs(startSnapshot?.at ?? startCursor?.at ?? startedAt);
    const endMs = epochMs(endSnapshot?.at ?? endCursor?.at ?? endedAt);
    return rows.filter((row) => {
      const rowWindowValue = row?.window;
      const rowHasWindow = rowWindowValue !== null
        && rowWindowValue !== undefined
        && String(rowWindowValue).trim() !== '';
      if (callerPassedWindow) {
        if (resolvedWindow == null || !rowHasWindow || ledgerWindow(rowWindowValue) !== resolvedWindow) {
          return false;
        }
      } else if (rowHasWindow) {
        return false;
      }
      const rowIndex = Number.isInteger(row?.row) ? row.row : null;
      if (startIndex != null && endIndex != null && rowIndex != null) {
        return rowIndex > startIndex && rowIndex <= endIndex;
      }
      const at = epochMs(row?.at ?? row?.captured_at ?? row?.to);
      return at != null && (startMs == null || at >= startMs) && (endMs == null || at <= endMs);
    });
  } catch {
    return null;
  }
}

export function fallbackSubscription({ poolName, subscription, start, end, quota }) {
  if (!poolName && !start && !end) return null;
  const delta = snapshotDelta(quota, start, end);
  const monthlyPriceUsd = finiteNonNegative(subscription?.monthlyPriceUsd);
  const window = subscription?.quotaWindow
    ?? (delta?.window === '5h' ? '5h' : delta?.window ?? null);
  const block = {
    pool: poolName ?? null,
    window,
    deltaPct: delta?.deltaPct ?? null,
    usd: null,
    monthlyPriceUsd,
    windowDays: null,
    basis: monthlyPriceUsd == null
      ? 'unknown:no-price'
      : delta?.deltaPct == null ? 'unknown:no-meter' : 'unknown:no-cost',
    snapshots: snapshotsFor(start, end),
  };
  return block;
}

export async function resolveTranscriptReader(opts, poolName, home) {
  if (typeof opts.readTranscriptUsage === 'function') return opts.readTranscriptUsage;
  if (!poolName || !home) return null;
  try {
    const loaded = opts.providers ?? loadProviders(home, { packaged: true });
    const providers = Array.isArray(loaded) ? loaded : loaded?.providers;
    return transcriptReaderFor(providers, poolName);
  } catch {
    return null;
  }
}
