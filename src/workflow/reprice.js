// Historical workflow usage re-pricing.
//
// This command deliberately has no implicit write path.  A dry run walks the
// durable V2 attempts, resolves transcript usage (or re-prices an already
// provider-reported attempt), and returns the proposed records.  `--apply`
// atomically writes the changed state/result and then uses the same rollup
// writer as the normal finish and `workflow reindex` paths.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadProviders } from '../lib/providers.js';
import { projectName } from '../lib/project.js';
import { attachTranscriptUsage, estimateInvocationUsage } from '../lib/usage.js';
import { indexedTranscriptReader, readTranscriptUsage as defaultReadTranscriptUsage } from '../lib/transcripts/index.js';
import { subscriptionCost } from '../lib/subscription-cost.js';
import { readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { formatMoney } from '../lib/usage-basis.js';
import { aggregateAttemptUsage, readRollup, rollupRecord, writeRunRollup } from './rollup.js';
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
  'unknown:below-resolution': 2,
  'unknown:no-cost': 3,
  'calibrated:usd-per-pct': 4,
  'observed:meter-delta': 5,
  'observed:meter-ledger': 6,
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
    const lower = poolName.toLowerCase();
    const canonical = lower === 'opencode2' || lower.startsWith('opencode2:')
      ? `opencode${poolName.slice('opencode2'.length)}`
      : poolName;
    if (connectors?.[canonical]) return { ...connectors[canonical], name: poolName };
    const entry = Object.entries(connectors ?? {}).find(([name]) => (
      canonical === name || canonical.startsWith(`${name}:`)
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

function taskRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.kind === 'run' || entry.source === 'run') return true;
  return entry.source == null && entry.picked != null && entry.outFile != null;
}

function taskTimes(entry) {
  const endedAt = entry?.endedAt ?? entry?.finishedAt ?? entry?.ts ?? null;
  const endedMs = timeMs(endedAt);
  const wallSec = nonNegative(entry?.wallSec);
  const startedAt = entry?.startedAt
    ?? (endedMs != null && wallSec != null ? new Date(endedMs - wallSec * 1000).toISOString() : null);
  return { startedAt, endedAt };
}

function taskEntries(state) {
  return (Array.isArray(state?.decisionLog) ? state.decisionLog : [])
    .map((entry, index) => ({
      task: entry,
      index,
      attempt: {
        ...entry,
        id: entry.id ?? `single-task-${index + 1}`,
        actionId: 'single-task',
        ordinal: 1,
        pool: entry.pool ?? entry.picked ?? null,
        model: entry.model ?? null,
        ...taskTimes(entry),
        cwd: entry.cwd ?? null,
        project: entry.project ?? entry.projectName ?? null,
        session: entry.session ?? null,
        usage: entry.usage ?? null,
      },
      actionId: 'single-task',
      ordinal: 1,
      attemptId: entry.id ?? entry.outFile ?? `single-task-${index + 1}`,
    }))
    .filter(({ task }) => taskRecord(task));
}

function projectLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'unknown' ? text : 'unknown';
}

function projectForRecord(record, state) {
  return projectLabel(record?.project ?? record?.projectName
    ?? state?.project ?? state?.intent?.project);
}

function projectDisplay(oldProject, newProject) {
  const oldName = projectLabel(oldProject);
  const newName = projectLabel(newProject);
  return oldName === newName ? newName : `${oldName} → ${newName}`;
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
  const sessionId = attempt.session?.sessionId
    ?? (typeof attempt.session === 'string' ? attempt.session : null)
    ?? attempt.sessionId
    ?? oldUsage?.sessionId
    ?? null;
  const cwd = attempt.cwd ?? state.intent?.cwd ?? null;
  const oldProject = projectForRecord(attempt, state);
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
      cwd: null,
      oldProject,
      project: oldProject,
      projectChanged: false,
      oldSource,
    };
  }

  let transcript = null;
  try {
    transcript = readTranscriptUsage({
      provider: poolName,
      sessionId,
      cwd,
      startedAt: attempt.startedAt ?? null,
      endedAt,
      taskFile: attempt.taskFile ?? null,
      home: transcriptHome,
    });
  } catch {
    transcript = null;
  }
  const confidence = transcript?.confidence ?? 'none';
  const matched = confidence === 'exact' || confidence === 'window';
  const transcriptCwd = matched && typeof transcript?.cwd === 'string' && transcript.cwd
    ? transcript.cwd : null;
  const derivedProject = oldProject === 'unknown' && transcriptCwd
    ? projectName(transcriptCwd) : null;
  const project = oldProject === 'unknown' && derivedProject
    ? projectLabel(derivedProject) : oldProject;
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
    cwd: transcriptCwd,
    oldProject,
    project,
    projectChanged: oldProject !== project,
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

function minuteSnapshot(record) {
  return {
    minutes: record?.minutes && typeof record.minutes === 'object'
      ? {
        active: record.minutes.active ?? null,
        span: record.minutes.span ?? null,
        wall: record.minutes.wall ?? null,
        agent: record.minutes.agent ?? null,
      }
      : null,
    phases: Array.isArray(record?.phases)
      ? record.phases.map((phase) => ({
        id: phase?.id ?? null,
        actionIds: Array.isArray(phase?.actionIds) ? phase.actionIds : [],
        active: phase?.minutes?.active ?? null,
        span: phase?.minutes?.span ?? null,
      }))
      : null,
  };
}

function minutesNeedRefresh(existing, next) {
  return JSON.stringify(minuteSnapshot(existing)) !== JSON.stringify(minuteSnapshot(next));
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
    ['project', (row) => row.project ?? 'unknown'],
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

function rowForCandidate({ runId, shortId = null, actionId, attemptId, ordinal, candidate, oldUsage }) {
  const usage = candidate.usage;
  return {
    runId,
    shortId,
    actionId,
    attemptId,
    ordinal,
    pool: candidate.poolName,
    model: usage.model ?? candidate.model ?? null,
    project: projectDisplay(candidate.oldProject, candidate.project),
    oldProject: candidate.oldProject,
    newProject: candidate.project,
    projectChanged: candidate.projectChanged,
    cwd: candidate.cwd,
    oldTokenSource: sourceOf(oldUsage),
    oldCost: oldApiUsd(oldUsage),
    confidence: candidate.confidence,
    tokenSource: sourceOf(usage),
    totalKnown: usage.tokens?.totalKnown ?? null,
    apiUsd: usage.api?.usd ?? null,
    subscriptionUsd: usage.subscription?.usd ?? null,
    subscriptionBasis: basisOf(usage),
  };
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
  providers = null,
  onRow = null,
} = {}) {
  const beganAt = Date.now();
  const sinceMs = since == null ? null : timeMs(since);
  if (since != null && sinceMs == null) throw new Error(`--since must be an ISO-compatible date: ${since}`);
  let connectorMap = connectors;
  let providerEntries = Array.isArray(providers) ? providers : providers?.providers ?? null;
  if (!connectorMap || !providerEntries) {
    try {
      const loaded = loadProviders(bullswarmDir, { packaged: true });
      connectorMap ??= loaded.connectors;
      providerEntries ??= loaded.providers;
    } catch {
      connectorMap ??= {};
      providerEntries ??= [];
    }
  }
  const effectiveReader = readTranscriptUsage === defaultReadTranscriptUsage
    ? indexedTranscriptReader({ home: transcriptHome, providers: providerEntries, bullswarmDir })
    : readTranscriptUsage;
  const report = {
    action: 'reprice',
    apply: Boolean(apply),
    filters: { since: since ?? null, pool: pool ?? null },
    scannedRuns: 0,
    scannedAttempts: 0,
    scannedTasks: 0,
    matched: 0,
    ambiguous: 0,
    missing: 0,
    changedRuns: 0,
    // Duration migration is reported separately from usage rewrites. A dry
    // run can therefore say how many terminal rollups need active/span fields
    // without pretending that it wrote them.
    minutesRecomputed: 0,
    minutesChanged: 0,
    minutesApplied: 0,
    changedTasks: 0,
    changedProjects: 0,
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
      let candidate;
      try {
        candidate = candidateFor({
          attempt,
          state,
          connectors: connectorMap,
          home: bullswarmDir,
          transcriptHome,
          readTranscriptUsage: effectiveReader,
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
      const row = rowForCandidate({
        runId: run.runId,
        shortId: run.shortId ?? null,
        actionId: entry.actionId,
        attemptId: entry.attemptId,
        ordinal: entry.ordinal,
        candidate,
        oldUsage,
      });
      if (candidate.projectChanged) report.changedProjects += 1;
      runRows.push({ entry, usage, candidate, row });
      report.rows.push(row);
      onRow?.(row);
    }
    if (runFailed) {
      report.failures.push({ runId: run.runId, error: runFailed.message });
      // No in-memory mutation has happened yet, so the run remains untouched.
      continue;
    }

    // Duration migration is run-level, not attempt-level. A pool/date filter
    // only limits it to runs that have at least one selected attempt; an
    // unfiltered invocation repairs every terminal run it scans.
    const recomputeMinutes = (sinceMs == null && !pool) || runRows.length > 0;
    const existingResult = readJsonSafe(join(run.runDir, 'result.json'), null);
    const existingRollup = readRollup(run.runDir);
    const finishedAt = existingResult?.finishedAt ?? state.lifecycle?.finishedAt;
    const nextRollup = recomputeMinutes
      ? rollupRecord(state, existingResult, { now: timeMs(finishedAt) ?? Date.now() })
      : null;
    const minutesChanged = nextRollup != null && minutesNeedRefresh(existingRollup, nextRollup);
    if (recomputeMinutes) report.minutesRecomputed += 1;
    if (minutesChanged) report.minutesChanged += 1;

    if (!apply) continue;
    for (const { entry, usage, candidate } of runRows) {
      entry.attempt.usage = clone(usage);
      if (candidate.cwd && !entry.attempt.cwd) entry.attempt.cwd = candidate.cwd;
      if (candidate.projectChanged) entry.attempt.project = candidate.project;
    }
    const stateChanged = JSON.stringify(state) !== original;
    if (!stateChanged && !minutesChanged) continue;
    try {
      let result = existingResult;
      if (stateChanged) {
        state.usage = stateUsage(state);
        result = existingResult && isTerminalWorkflowStatus(state.lifecycle?.status)
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
      }
      // The normal finish path and `workflow reindex` both use these exact
      // primitives; reprice deliberately does not duplicate index logic.
      writeRunRollup(run.runDir, state, result, {
        now: timeMs(finishedAt) ?? Date.now(),
        cwd: runRows.find(({ candidate }) => candidate.cwd)?.candidate.cwd,
        project: runRows.find(({ candidate }) => candidate.projectChanged)?.candidate.project,
      });
      if (stateChanged || minutesChanged) report.changedRuns += 1;
      if (minutesChanged) report.minutesApplied += 1;
    } catch (error) {
      report.failures.push({ runId: run.runId, error: error.message });
    }
  }

  const taskStatePath = join(bullswarmDir, 'state.json');
  const taskState = readJsonSafe(taskStatePath, null);
  const taskRows = [];
  if (taskState && typeof taskState === 'object') {
    const original = JSON.stringify(taskState);
    for (const entry of taskEntries(taskState)) {
      if (!eligible(entry, { sinceMs, pool })) continue;
      report.scannedTasks += 1;
      const oldUsage = entry.attempt.usage && typeof entry.attempt.usage === 'object'
        ? entry.attempt.usage : null;
      let candidate;
      try {
        candidate = candidateFor({
          attempt: entry.attempt,
          state: { runId: `task:${entry.attemptId}`, lifecycle: { finishedAt: entry.attempt.finishedAt }, intent: { cwd: entry.attempt.cwd } },
          connectors: connectorMap,
          home: bullswarmDir,
          transcriptHome,
          readTranscriptUsage: effectiveReader,
        });
      } catch (error) {
        report.failures.push({ runId: entry.attemptId, error: error.message });
        continue;
      }
      const confidence = candidate.confidence;
      if (confidence === 'ambiguous') report.ambiguous += 1;
      else if (confidence === 'none') report.missing += 1;
      else report.matched += 1;
      const row = rowForCandidate({
        runId: entry.attemptId,
        actionId: entry.actionId,
        attemptId: entry.attemptId,
        ordinal: entry.ordinal,
        candidate,
        oldUsage,
      });
      if (candidate.projectChanged) report.changedProjects += 1;
      taskRows.push({ entry, candidate, usage: candidate.usage, row });
      report.rows.push(row);
      onRow?.(row);
    }
    if (apply && taskRows.length) {
      for (const { entry, candidate, usage } of taskRows) {
        entry.task.usage = clone(usage);
        if (candidate.cwd && !entry.task.cwd) entry.task.cwd = candidate.cwd;
        if (candidate.projectChanged) entry.task.project = candidate.project;
      }
      if (JSON.stringify(taskState) !== original) {
        try {
          writeJsonAtomic(taskStatePath, taskState);
          report.changedTasks += 1;
        } catch (error) {
          report.failures.push({ runId: 'state.json', error: error.message });
        }
      }
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
  providers = null,
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
      ? indexedTranscriptReader({ home: transcriptHome, bullswarmDir, providers })
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
      providers,
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
    log(`✓ reprice: ${report.rows.length} record${report.rows.length === 1 ? '' : 's'}, ${report.changedRuns} run${report.changedRuns === 1 ? '' : 's'} changed, ${report.minutesChanged} duration record${report.minutesChanged === 1 ? '' : 's'} stale (${report.minutesRecomputed} recomputed), ${report.changedProjects} project${report.changedProjects === 1 ? '' : 's'} backfilled, ${(report.elapsedMs / 1000).toFixed(1)}s elapsed`);
    for (const failure of report.failures) error(`✗ ${failure.runId}: ${failure.error}`);
  }
  return report.failures.length ? 1 : 0;
}

export { parseArgs as parseRepriceArgs };
