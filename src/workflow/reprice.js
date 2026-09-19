// Historical workflow usage re-pricing.
//
// This command deliberately has no implicit write path.  A dry run walks the
// durable V2 attempts, resolves transcript usage (or re-prices an already
// provider-reported attempt), and returns the proposed records.  `--apply`
// atomically writes the changed state/result and then uses the same rollup
// writer as the normal finish and `workflow reindex` paths.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConnectors } from '../lib/config.js';
import { attachTranscriptUsage, estimateInvocationUsage } from '../lib/usage.js';
import { indexedTranscriptReader, readTranscriptUsage as defaultReadTranscriptUsage } from '../lib/transcripts/index.js';
import { subscriptionCost } from '../lib/subscription-cost.js';
import { readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { formatMoney } from '../lib/usage-basis.js';
import { aggregateAttemptUsage, writeRunRollup } from './rollup.js';
import { createV2ResultEnvelope } from './v2-outcome.js';
import { listRuns } from './short-id.js';
import { isTerminalWorkflowStatus } from './status.js';
import { helpText, usageLine } from '../help.js';

export const REPRICE_RETENTION_CAVEAT =
  'provider transcripts are pruned. Attempts older than the retention window will resolve to unknown, and the honest dashboard consequence is a visible gap in the history chart, not a silent zero.';
export const REPRICE_USAGE = usageLine(['workflow', 'reprice']);

const TOKEN_SOURCES = new Set([
  'provider-reported',
  'transcript-summed',
  'estimated:utf8-bytes/4',
  'unknown',
]);

const SUBSCRIPTION_RANK = {
  'unknown:no-price': 0,
  'unknown:no-meter': 1,
  'unknown:no-cost': 2,
  'calibrated:usd-per-pct': 3,
  'observed:meter-delta': 4,
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultBullswarmDir() {
  return process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');
}

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

function sourceOf(usage) {
  return TOKEN_SOURCES.has(usage?.tokenSource) ? usage.tokenSource : 'unknown';
}

function basisOf(usage) {
  return Object.hasOwn(SUBSCRIPTION_RANK, usage?.subscription?.basis)
    ? usage.subscription.basis
    : 'unknown:no-meter';
}

function oldApiUsd(usage) {
  return nonNegative(usage?.api?.usd ?? usage?.cost?.estimatedUsd);
}

function connectorFor(connectors, poolName) {
  if (poolName && connectors?.[poolName]) return connectors[poolName];
  if (typeof poolName === 'string') {
    const entry = Object.entries(connectors ?? {}).find(([name]) => (
      poolName === name || poolName.startsWith(`${name}:`)
    ));
    if (entry) return { ...entry[1], name: poolName };
  }
  return { name: poolName ?? null, modelProfiles: [] };
}

function declaredSubscriptions(home, poolName) {
  const state = readJsonSafe(join(home, 'state.json'), null);
  const subscriptions = state?.strategy?.subscriptions;
  return subscriptions && typeof subscriptions === 'object'
    ? (subscriptions[poolName] ?? {})
    : {};
}

function subscriptionFor({ home, poolName, connector, oldSubscription }) {
  const historical = oldSubscription && typeof oldSubscription === 'object'
    ? oldSubscription
    : {};
  const declared = declaredSubscriptions(home, poolName);
  return {
    ...(connector?.subscription ?? {}),
    // Preserve the price/window recorded with the historical attempt when
    // the connector only carries a null placeholder; an explicit current
    // strategy declaration below still wins, including an intentional null.
    ...historical,
    ...declared,
    pool: poolName ?? historical.pool ?? null,
  };
}

function attemptEntries(state) {
  const entries = [];
  const push = (attempt, actionId, fallbackOrdinal = 1) => {
    if (!attempt || typeof attempt !== 'object') return;
    entries.push({
      attempt,
      actionId: attempt.actionId ?? actionId,
      ordinal: attempt.ordinal ?? fallbackOrdinal,
      attemptId: attempt.id ?? `${attempt.actionId ?? actionId}-${attempt.ordinal ?? fallbackOrdinal}`,
    });
  };
  for (const attempt of state?.preflight?.scout?.attempts ?? []) push(attempt, 'workflow-scout');
  for (const attempt of state?.planner?.attempts ?? []) push(attempt, 'workflow-planner');
  for (const attempt of state?.attempts ?? []) push(attempt, attempt.actionId ?? 'workflow');
  return entries;
}

function tokenReport(usage) {
  const tokens = usage?.tokens ?? {};
  return {
    standardRead: tokens.standardRead ?? null,
    cacheRead: tokens.cacheRead ?? null,
    cacheWrite5m: tokens.cacheWrite5m ?? null,
    cacheWrite1h: tokens.cacheWrite1h ?? null,
    cacheWrite: tokens.cacheWrite ?? null,
    output: tokens.output ?? null,
    reasoning: tokens.reasoning ?? null,
    // Existing canonical records store output exclusive of reasoning.  Tell
    // the normalizer that explicitly so reprice never subtracts it twice.
    outputIsExclusive: true,
    requests: Array.isArray(usage?.requests) ? usage.requests : undefined,
    model: usage?.model ?? null,
    sessionId: usage?.sessionId ?? null,
  };
}

function usageFromTokens({ connector, model, sessionId, subscription, tokens, tokenSource, requests = null }) {
  return estimateInvocationUsage({
    connector,
    model,
    sessionId,
    subscription,
    reportedUsage: {
      ...tokens,
      model,
      sessionId,
      requests,
      tokenSource,
    },
    forceTokenSource: tokenSource,
    requests,
  });
}

function attachSubscription(usage, { home, poolName, connector, oldSubscription, runId, attemptId }) {
  const subscription = subscriptionFor({ home, poolName, connector, oldSubscription });
  const computed = subscriptionCost({
    pool: { name: poolName, connector, subscription },
    poolName,
    subscription,
    api: usage.api,
    apiUsd: usage.api?.usd ?? null,
    startSnapshot: oldSubscription?.snapshots?.start ?? null,
    endSnapshot: oldSubscription?.snapshots?.end ?? null,
    window: subscription.window ?? subscription.quotaWindow ?? null,
    home,
    runId,
    attemptId,
  });
  const normalizedQuota = {
    ...(usage.normalizedQuota ?? {}),
    estimatedPercent: computed?.deltaPct ?? null,
    window: computed?.window ?? null,
    basis: computed?.basis ?? 'unknown:no-meter',
  };
  return {
    ...usage,
    subscription: computed,
    normalizedQuota,
  };
}

function candidateFor({ attempt, state, connectors, home, transcriptHome, readTranscriptUsage }) {
  const oldUsage = attempt.usage && typeof attempt.usage === 'object' ? attempt.usage : null;
  const oldSource = sourceOf(oldUsage);
  const poolName = attempt.pool ?? oldUsage?.subscription?.pool ?? null;
  const connector = connectorFor(connectors, poolName);
  const model = attempt.model ?? oldUsage?.model ?? connector.model ?? null;
  const sessionId = attempt.session?.sessionId ?? oldUsage?.sessionId ?? null;
  const oldSubscription = oldUsage?.subscription ?? null;
  const subscription = subscriptionFor({ home, poolName, connector, oldSubscription });
  const endedAt = attempt.finishedAt ?? state.lifecycle?.finishedAt ?? null;

  // Provider totals already represent an authoritative measurement.  They do
  // not need a transcript lookup; only their dated local card is refreshed.
  if (oldSource === 'provider-reported') {
    const usage = usageFromTokens({
      connector,
      model,
      sessionId,
      subscription,
      tokens: tokenReport(oldUsage),
      tokenSource: 'provider-reported',
      requests: oldUsage?.requests ?? null,
    });
    return {
      usage: attachSubscription(usage, { home, poolName, connector, oldSubscription, runId: state.runId, attemptId: attempt.id }),
      confidence: 'provider-reported',
      poolName,
      model,
      oldSource,
    };
  }

  let transcript = null;
  try {
    transcript = readTranscriptUsage({
      provider: poolName,
      sessionId,
      cwd: state.intent?.cwd ?? null,
      startedAt: attempt.startedAt ?? null,
      endedAt,
      home: transcriptHome,
    });
  } catch {
    transcript = null;
  }
  const confidence = transcript?.confidence ?? 'none';
  const matched = confidence === 'exact' || confidence === 'window';
  let usage;
  if (matched && transcript?.tokens) {
    const estimated = usageFromTokens({
      connector,
      model,
      sessionId,
      subscription,
      tokens: blankTokens(),
      tokenSource: 'unknown',
    });
    usage = attachTranscriptUsage(estimated, {
      ...transcript,
      model: transcript.model ?? model,
      sessionId: transcript.sessionId ?? sessionId,
    });
  } else {
    usage = usageFromTokens({
      connector,
      model,
      sessionId,
      subscription,
      tokens: blankTokens(),
      tokenSource: 'unknown',
    });
  }
  return {
    usage: attachSubscription(usage, { home, poolName, connector, oldSubscription, runId: state.runId, attemptId: attempt.id }),
    confidence,
    poolName,
    model: usage.model ?? model,
    oldSource,
  };
}

function allAttempts(state) {
  return attemptEntries(state).map((entry) => entry.attempt);
}

function stateUsage(state) {
  const attempts = allAttempts(state);
  const aggregate = aggregateAttemptUsage(attempts);
  const byPool = {};
  for (const attempt of attempts) {
    const tokens = nonNegative(attempt?.usage?.tokens?.totalKnown);
    if (tokens == null) continue;
    const pool = attempt.pool ?? 'unknown';
    byPool[pool] = (byPool[pool] ?? 0) + tokens;
  }
  const tokenSource = aggregate.tokenSource;
  const subscriptionBasis = aggregate.subscriptionBasis;
  return {
    ...(state.usage ?? {}),
    total: aggregate.tokens ?? 0,
    byPool,
    apiUsd: aggregate.apiUsd,
    apiKnownSubtotalUsd: aggregate.apiKnownSubtotalUsd,
    subscriptionUsd: aggregate.subscriptionUsd,
    subscriptionKnownSubtotalUsd: aggregate.subscriptionKnownSubtotalUsd,
    measuredAttempts: aggregate.measuredAttempts,
    pricedAttempts: aggregate.pricedAttempts,
    subscriptionPricedAttempts: aggregate.subscriptionPricedAttempts,
    attempts: aggregate.attempts,
    apiMissingAttempts: aggregate.attempts - aggregate.pricedAttempts,
    subscriptionMissingAttempts: aggregate.attempts - aggregate.subscriptionPricedAttempts,
    tokenSource,
    subscriptionBasis,
  };
}

// A result envelope is durable evidence, not a projection that may be
// regenerated after a run has finished. Once resultFile is present,
// evaluateV2Progress reports `completed`, while createV2ResultEnvelope only
// accepts the pre-publication `ready-to-finalize` state. Reprice therefore
// refreshes only usage-bearing fields in an existing envelope and leaves its
// status, verdict, reason, requirements, and evidence intact.
function refreshExistingResult(result, state) {
  const refreshed = clone(result) ?? {};
  const attempts = allAttempts(state);
  const totals = aggregateAttemptUsage(attempts);
  const actionIds = new Set([
    ...(Array.isArray(state.program?.actions) ? state.program.actions : []).map((action) => action.id),
    ...(Array.isArray(result?.actions) ? result.actions : []).map((action) => action.id),
  ]);
  const steps = {};
  for (const actionId of actionIds) {
    steps[actionId] = aggregateAttemptUsage(attempts.filter((attempt) => attempt?.actionId === actionId));
  }
  const oldUsage = result?.usage && typeof result.usage === 'object' ? result.usage : {};
  refreshed.usage = {
    ...oldUsage,
    total: state.usage?.total ?? (totals.tokens ?? 0),
    byPool: clone(state.usage?.byPool) ?? {},
    totals,
    steps,
  };
  if (Array.isArray(result?.actions)) {
    refreshed.actions = result.actions.map((action) => ({
      ...action,
      usage: steps[action.id] ?? aggregateAttemptUsage([]),
    }));
  }
  return refreshed;
}

function parseArgs(args) {
  const opts = { apply: false, json: false, since: null, pool: null, all: false };
  const values = new Set(['since', 'pool']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--since' || arg === '--pool') {
      if (index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      opts[arg.slice(2)] = args[++index];
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = arg.slice(2, equals > 0 ? equals : undefined);
      if (!values.has(name) && name !== 'apply' && name !== 'dry-run' && name !== 'json' && name !== 'all') {
        throw new Error(`unknown flag --${name} for workflow reprice`);
      }
      if (equals > 0) opts[name] = arg.slice(equals + 1);
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  const sinceMs = opts.since == null ? null : timeMs(opts.since);
  if (opts.since != null && sinceMs == null) throw new Error(`--since must be an ISO-compatible date: ${opts.since}`);
  if (opts.pool != null && !String(opts.pool).trim()) throw new Error('--pool must be a non-empty pool name');
  if (opts.all && opts.since != null) throw new Error('--all cannot be combined with --since');
  return { ...opts, sinceMs };
}

function eligible(entry, { sinceMs, pool }) {
  if (pool && entry.attempt.pool !== pool) return false;
  if (sinceMs == null) return true;
  const started = timeMs(entry.attempt.startedAt);
  return started != null && started >= sinceMs;
}

function money(value, tokens = null) {
  return formatMoney(nonNegative(value), tokens);
}

function table(rows) {
  const columns = [
    ['run', (row) => row.shortId ?? row.runId],
    ['action', (row) => row.actionId],
    ['try', (row) => row.ordinal],
    ['pool', (row) => row.pool ?? '-'],
    ['model', (row) => row.model ?? '-'],
    ['old tokenSource', (row) => row.oldTokenSource],
    ['old cost', (row) => money(row.oldCost, row.totalKnown)],
    ['new tokenSource', (row) => row.tokenSource],
    ['new api usd', (row) => money(row.apiUsd, row.totalKnown)],
    ['subscription usd', (row) => money(row.subscriptionUsd, row.totalKnown)],
    ['confidence', (row) => row.confidence],
  ];
  const values = rows.map((row) => columns.map(([, value]) => String(value(row) ?? '-')));
  const widths = columns.map(([header], index) => Math.max(header.length, ...values.map((line) => line[index].length)));
  const format = (line) => line.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [format(columns.map(([header]) => header)), format(widths.map((width) => '-'.repeat(width))), ...values.map(format)].join('\n');
}

/**
 * Reprice terminal V2 workflow attempts.
 *
 * The injectable reader/connectors make the command deterministic in tests;
 * the CLI uses the provider-neutral transcript reader and packaged connectors.
 */
export function repriceRuns({
  bullswarmDir = defaultBullswarmDir(),
  transcriptHome = homedir(),
  apply = false,
  since = null,
  pool = null,
  readTranscriptUsage = defaultReadTranscriptUsage,
  connectors = null,
  onRow = null,
} = {}) {
  const beganAt = Date.now();
  const sinceMs = since == null ? null : timeMs(since);
  if (since != null && sinceMs == null) throw new Error(`--since must be an ISO-compatible date: ${since}`);
  let connectorMap = connectors;
  if (!connectorMap) {
    try { connectorMap = loadConnectors(bullswarmDir, { packaged: true }); }
    catch { connectorMap = {}; }
  }
  const report = {
    action: 'reprice',
    apply: Boolean(apply),
    filters: { since: since ?? null, pool: pool ?? null },
    scannedRuns: 0,
    scannedAttempts: 0,
    matched: 0,
    ambiguous: 0,
    missing: 0,
    changedRuns: 0,
    rows: [],
    failures: [],
  };

  for (const run of listRuns(bullswarmDir)) {
    const state = run.state;
    if (run.legacy || !state || !isTerminalWorkflowStatus(state.lifecycle?.status) || run.ongoing) continue;
    report.scannedRuns += 1;
    const original = JSON.stringify(state);
    const runRows = [];
    let runFailed = null;
    for (const entry of attemptEntries(state)) {
      if (!eligible(entry, { sinceMs, pool })) continue;
      report.scannedAttempts += 1;
      const attempt = entry.attempt;
      const oldUsage = attempt.usage && typeof attempt.usage === 'object' ? attempt.usage : null;
      const oldSource = sourceOf(oldUsage);
      let candidate;
      try {
        candidate = candidateFor({
          attempt,
          state,
          connectors: connectorMap,
          home: bullswarmDir,
          transcriptHome,
          readTranscriptUsage,
        });
      } catch (error) {
        runFailed = error;
        break;
      }
      const confidence = candidate.confidence;
      if (confidence === 'ambiguous') report.ambiguous += 1;
      else if (confidence === 'none') report.missing += 1;
      else report.matched += 1;
      const usage = candidate.usage;
      const row = {
        runId: run.runId,
        shortId: run.shortId ?? null,
        actionId: entry.actionId,
        attemptId: entry.attemptId,
        ordinal: entry.ordinal,
        pool: candidate.poolName,
        model: usage.model ?? candidate.model ?? null,
        oldTokenSource: oldSource,
        oldCost: oldApiUsd(oldUsage),
        confidence,
        tokenSource: sourceOf(usage),
        totalKnown: usage.tokens?.totalKnown ?? null,
        apiUsd: usage.api?.usd ?? null,
        subscriptionUsd: usage.subscription?.usd ?? null,
        subscriptionBasis: basisOf(usage),
      };
      runRows.push({ entry, usage, row });
      report.rows.push(row);
      onRow?.(row);
    }
    if (runFailed) {
      report.failures.push({ runId: run.runId, error: runFailed.message });
      // No in-memory mutation has happened yet, so the run remains untouched.
      continue;
    }
    if (!apply || !runRows.length) continue;
    for (const { entry, usage } of runRows) entry.attempt.usage = clone(usage);
    if (JSON.stringify(state) === original) continue;
    try {
      state.usage = stateUsage(state);
      const existingResult = readJsonSafe(join(run.runDir, 'result.json'), null);
      const finishedAt = existingResult?.finishedAt ?? state.lifecycle?.finishedAt;
      const result = existingResult && isTerminalWorkflowStatus(state.lifecycle?.status)
        ? refreshExistingResult(existingResult, state)
        : createV2ResultEnvelope({
          ...state,
          usage: { total: state.usage.total, byPool: state.usage.byPool },
        }, { finishedAt });
      // A copied home can retain an absolute resultFile from the source home.
      // Never follow that path: reprice writes only inside the run directory it
      // is currently operating on.
      const resultPath = join(run.runDir, 'result.json');
      writeJsonAtomic(join(run.runDir, 'state.json'), state);
      writeJsonAtomic(resultPath, result);
      // The normal finish path and `workflow reindex` both use these exact
      // primitives; reprice deliberately does not duplicate index logic.
      writeRunRollup(run.runDir, state, result, {
        now: timeMs(finishedAt) ?? Date.now(),
      });
      report.changedRuns += 1;
    } catch (error) {
      report.failures.push({ runId: run.runId, error: error.message });
    }
  }
  report.elapsedMs = Date.now() - beganAt;
  return report;
}

/** CLI leaf for `bullswarm workflow reprice`. */
export function cmdReprice(args = [], {
  bullswarmDir = defaultBullswarmDir(),
  transcriptHome = homedir(),
  readTranscriptUsage = defaultReadTranscriptUsage,
  connectors = null,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    log(helpText(['workflow', 'reprice']));
    return 0;
  }
  let opts;
  try { opts = parseArgs(args); }
  catch (err) {
    error(`✗ ${err.message}`);
    return 2;
  }
  let report;
  try {
    const effectiveSince = opts.all
      ? null
      : opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const liveReader = readTranscriptUsage === defaultReadTranscriptUsage
      ? indexedTranscriptReader({ home: transcriptHome })
      : readTranscriptUsage;
    const streamRows = readTranscriptUsage === defaultReadTranscriptUsage;
    report = repriceRuns({
      bullswarmDir,
      transcriptHome,
      apply: opts.apply,
      since: effectiveSince,
      pool: opts.pool,
      readTranscriptUsage: liveReader,
      connectors,
      onRow: streamRows ? (row) => log(opts.json
        ? JSON.stringify({ type: 'attempt', ...row })
        : `${row.shortId ?? row.runId}  ${row.actionId}  try ${row.ordinal}  ${row.pool ?? '-'}  ${row.tokenSource}  api=${money(row.apiUsd)}  sub=${money(row.subscriptionUsd)}  ${row.confidence}`) : null,
    });
  } catch (err) {
    error(`✗ ${err.message}`);
    return 1;
  }
  if (opts.json) {
    // Keep stdout valid JSON for scripts; the required caveat is still part of
    // the command's output on stderr.
    error(REPRICE_RETENTION_CAVEAT);
    const summary = readTranscriptUsage === defaultReadTranscriptUsage
      ? { ...report, rows: undefined }
      : report;
    log(JSON.stringify({ type: 'summary', ...summary }));
  } else {
    log(table(report.rows));
    log(REPRICE_RETENTION_CAVEAT);
    log(`✓ reprice: ${report.rows.length} attempt${report.rows.length === 1 ? '' : 's'}, ${report.changedRuns} run${report.changedRuns === 1 ? '' : 's'} changed, ${(report.elapsedMs / 1000).toFixed(1)}s elapsed`);
    for (const failure of report.failures) error(`✗ ${failure.runId}: ${failure.error}`);
  }
  return report.failures.length ? 1 : 0;
}

export { parseArgs as parseRepriceArgs };
