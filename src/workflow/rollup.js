// Per-run rollup: the one record the dashboard reads instead of rescanning
// every run.
//
// Measured on this machine 2026-09-16: `listRuns` parses 293 state.json files
// (22 MB) in about 100 ms, against the dashboard's 1,000 ms refresh timer.
// Home, Stats and History cannot afford that every second, so each finished
// run writes one small record — `<runDir>/rollup.json` — and appends it to an
// append-only index at `~/.bullswarm/history/runs.jsonl`. Reading the index
// is one file and one pass.
//
// Doctrine:
//   R1. rollupRecord() is pure. No filesystem, no clock beyond the injected
//       `now`, no git. Everything it cannot read from the state and the
//       result envelope it hands back as null.
//   R2. Money is never guessed. `costUsd` is the sum of the estimates the run
//       actually recorded on its attempts; a run that recorded none gets
//       null, never 0. Zero-for-unknown is how a dashboard invents spend.
//   R3. Legacy pre-0.27.0 runs have no V2 state.json, so their record is
//       minimal: identity, the times the run's own files prove, the status it
//       recorded, no cost and no pool minutes. `legacy: true` is what marks
//       one; a record this module builds from V2 state says `legacy: false`.
//       The times come from readLegacyRunFacts — report.json, then
//       state.json, then the run directory's own file times — and never from
//       the clock, so writing the record cannot move what it records.
//   R4. The index is idempotent by runId. Finishing, reopening and finishing
//       again, or re-running `workflow reindex`, leaves exactly one line per
//       run — the newest one.

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync, readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { projectName } from '../lib/project.js';
import { readGoalProject } from './goal.js';
import { isTerminalWorkflowStatus } from './status.js';

export const ROLLUP_SCHEMA_VERSION = 'bullswarm.workflow.rollup.v1';

const MINUTE_MS = 60_000;
const DURATION_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function round(value, places) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Number(null) is 0 and Number(false) is 0. A recorded `estimatedUsd: null`
// means "this run measured no cost" and must stay null all the way to the
// screen (R2), so every numeric read goes through here rather than through a
// bare Number() that would silently coin a zero.
function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseIso(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const TOKEN_SOURCE_RANK = {
  unknown: 0,
  'estimated:utf8-bytes/4': 1,
  'transcript-summed': 2,
  'provider-reported': 3,
};

const SUBSCRIPTION_BASIS_RANK = {
  'unknown:no-price': 0,
  'unknown:no-meter': 1,
  'unknown:below-resolution': 2,
  'unknown:no-cost': 3,
  'calibrated:usd-per-pct': 4,
  'observed:meter-delta': 5,
  'observed:meter-ledger': 6,
};

function tokenSourceOf(value) {
  return Object.hasOwn(TOKEN_SOURCE_RANK, value) ? value : 'unknown';
}

function worstTokenSource(current, candidate) {
  const next = tokenSourceOf(candidate);
  if (current == null) return next;
  return TOKEN_SOURCE_RANK[next] < TOKEN_SOURCE_RANK[current] ? next : current;
}

function subscriptionBasisOf(value) {
  return Object.hasOwn(SUBSCRIPTION_BASIS_RANK, value) ? value : 'unknown:no-meter';
}

function worstSubscriptionBasis(current, candidate) {
  const next = subscriptionBasisOf(candidate);
  if (current == null) return next;
  return SUBSCRIPTION_BASIS_RANK[next] < SUBSCRIPTION_BASIS_RANK[current] ? next : current;
}

function addNullable(total, value) {
  return value == null ? total : (total ?? 0) + value;
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const direct = finiteNumber(tokens.totalKnown);
  if (direct != null) return direct;
  const fields = ['standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output', 'reasoning'];
  let total = null;
  for (const field of fields) total = addNullable(total, finiteNumber(tokens[field]));
  return total;
}

function cacheWriteOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const direct = finiteNumber(tokens.cacheWrite);
  if (direct != null) return direct;
  const five = finiteNumber(tokens.cacheWrite5m);
  const one = finiteNumber(tokens.cacheWrite1h);
  return five != null && one != null ? five + one : null;
}

function attemptCanonicalUsage(attempt) {
  const usage = attempt?.usage && typeof attempt.usage === 'object' ? attempt.usage : null;
  const tokens = usage?.tokens && typeof usage.tokens === 'object' ? usage.tokens : null;
  const apiUsd = finiteNumber(usage?.api?.usd ?? usage?.cost?.estimatedUsd);
  const subscriptionUsd = finiteNumber(usage?.subscription?.usd);
  const tokenSource = tokenSourceOf(usage?.tokenSource);
  const subscriptionBasis = subscriptionBasisOf(usage?.subscription?.basis);
  const subscriptionDeltaPct = finiteNumber(usage?.subscription?.deltaPct);
  const subscriptionWindow = typeof usage?.subscription?.window === 'string'
    ? usage.subscription.window : null;
  return {
    canonical: Boolean(usage && (usage.api !== undefined || usage.subscription !== undefined)),
    apiUsd,
    subscriptionUsd,
    tokenSource,
    subscriptionBasis,
    subscriptionDeltaPct,
    subscriptionWindow,
    tokens: tokenTotal(tokens),
    cacheRead: finiteNumber(tokens?.cacheRead),
    cacheWrite: cacheWriteOf(tokens),
    reasoning: finiteNumber(tokens?.reasoning),
  };
}

function emptyUsageAggregate() {
  return {
    attempts: 0,
    minutes: null,
    tokens: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    apiUsd: null,
    apiKnownSubtotalUsd: null,
    subscriptionUsd: null,
    subscriptionKnownSubtotalUsd: null,
    measuredAttempts: 0,
    pricedAttempts: 0,
    subscriptionPricedAttempts: 0,
    // Keep these unset while walking attempts so the first real attempt's
    // source/basis is retained.  Initializing to the lowest-ranked value
    // would incorrectly make every all-measured aggregate look unknown.
    tokenSource: null,
    subscriptionBasis: null,
    subscriptionDeltaPct: null,
    subscriptionWindow: null,
    subscriptionWindows: {},
  };
}

function finalizeUsageAggregate(aggregate) {
  const complete = aggregate.attempts > 0 && aggregate.pricedAttempts === aggregate.attempts;
  const subscriptionComplete = aggregate.attempts > 0
    && aggregate.subscriptionPricedAttempts === aggregate.attempts;
  aggregate.apiUsd = complete ? round(aggregate.apiKnownSubtotalUsd, 6) : null;
  aggregate.apiKnownSubtotalUsd = round(aggregate.apiKnownSubtotalUsd, 6);
  aggregate.subscriptionUsd = subscriptionComplete ? round(aggregate.subscriptionKnownSubtotalUsd, 6) : null;
  aggregate.subscriptionKnownSubtotalUsd = round(aggregate.subscriptionKnownSubtotalUsd, 6);
  aggregate.minutes = round(aggregate.minutes, 2);
  for (const field of ['tokens', 'cacheRead', 'cacheWrite', 'reasoning']) {
    aggregate[field] = aggregate[field] == null ? null : Math.round(aggregate[field]);
  }
  aggregate.tokenSource ??= 'unknown';
  aggregate.subscriptionBasis ??= 'unknown:no-meter';
  const windows = Object.entries(aggregate.subscriptionWindows ?? {});
  if (windows.length === 1) {
    aggregate.subscriptionWindow = windows[0][0];
    aggregate.subscriptionDeltaPct = round(windows[0][1], 6);
  }
  return aggregate;
}

/**
 * Aggregate canonical attempt usage with strict completeness semantics.
 *
 * `apiUsd` and `subscriptionUsd` are whole-scope totals only when every
 * attempt has the corresponding amount. The named `*KnownSubtotalUsd` fields
 * retain partial sums, while all token classes stay null until at least one
 * attempt reports that class.
 */
export function aggregateAttemptUsage(attempts) {
  const aggregate = emptyUsageAggregate();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || typeof attempt !== 'object') continue;
    aggregate.attempts += 1;
    const wallSec = finiteNumber(attempt.wallSec);
    if (wallSec != null && wallSec >= 0) aggregate.minutes = addNullable(aggregate.minutes, wallSec / 60);
    const usage = attemptCanonicalUsage(attempt);
    aggregate.tokens = addNullable(aggregate.tokens, usage.tokens);
    aggregate.cacheRead = addNullable(aggregate.cacheRead, usage.cacheRead);
    aggregate.cacheWrite = addNullable(aggregate.cacheWrite, usage.cacheWrite);
    aggregate.reasoning = addNullable(aggregate.reasoning, usage.reasoning);
    aggregate.tokenSource = worstTokenSource(aggregate.tokenSource, usage.tokenSource);
    aggregate.subscriptionBasis = worstSubscriptionBasis(aggregate.subscriptionBasis, usage.subscriptionBasis);
    if (usage.subscriptionDeltaPct != null && usage.subscriptionWindow) {
      aggregate.subscriptionWindows[usage.subscriptionWindow] =
        (aggregate.subscriptionWindows[usage.subscriptionWindow] ?? 0) + usage.subscriptionDeltaPct;
    }
    if (usage.apiUsd != null) {
      aggregate.apiKnownSubtotalUsd = addNullable(aggregate.apiKnownSubtotalUsd, usage.apiUsd);
      aggregate.pricedAttempts += 1;
    }
    if (usage.subscriptionUsd != null) {
      aggregate.subscriptionKnownSubtotalUsd = addNullable(aggregate.subscriptionKnownSubtotalUsd, usage.subscriptionUsd);
      aggregate.subscriptionPricedAttempts += 1;
    }
    if (usage.tokenSource === 'provider-reported' || usage.tokenSource === 'transcript-summed') {
      aggregate.measuredAttempts += 1;
    }
  }
  return finalizeUsageAggregate(aggregate);
}

/**
 * Measure the time the supplied attempts were actually overlapping.
 *
 * A worker's wall clock is intentionally not used here: it is a separate
 * worker-minutes measure and may include provider-side accounting that the
 * attempt timestamps cannot prove.  Every interval must have a valid start;
 * a terminal interval must also have a recorded finish.  One bad endpoint
 * makes the union unknown instead of quietly under-counting the run.
 *
 * Running attempts are open through `now`.  `span` is withheld until the
 * caller says the record is terminal, because an open run has no proved last
 * finish yet.
 */
export function intervalMinutes(attempts, { now = Date.now(), terminal = false } = {}) {
  const list = Array.isArray(attempts) ? attempts.filter((attempt) => attempt && typeof attempt === 'object') : [];
  if (!list.length) return { active: null, span: null };
  const endNow = parseIso(now);
  const intervals = [];
  let unknown = false;
  let firstStart = null;
  let lastFinish = null;

  for (const attempt of list) {
    const started = parseIso(attempt.startedAt);
    const recordedFinish = parseIso(attempt.finishedAt ?? attempt.endedAt);
    if (started == null) {
      unknown = true;
      continue;
    }
    if (firstStart == null || started < firstStart) firstStart = started;
    const finish = recordedFinish ?? (!terminal ? endNow : null);
    if (finish == null || finish < started) {
      unknown = true;
      continue;
    }
    if (recordedFinish != null && (lastFinish == null || recordedFinish > lastFinish)) lastFinish = recordedFinish;
    intervals.push([started, finish]);
  }

  if (unknown || !intervals.length) return { active: null, span: null };
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  const activeMs = merged.reduce((total, [started, finished]) => total + finished - started, 0);
  const spanMs = terminal && firstStart != null && lastFinish != null && lastFinish >= firstStart
    ? lastFinish - firstStart : null;
  return {
    active: round(activeMs / MINUTE_MS, 2),
    span: spanMs == null ? null : round(spanMs / MINUTE_MS, 2),
  };
}

function terminalStateOf(state, result) {
  if (state?.lifecycle?.finishedAt || result?.finishedAt) return true;
  return isTerminalWorkflowStatus(state?.lifecycle?.status)
    || isTerminalWorkflowStatus(result?.status);
}

function phaseRecords(state, attempts, { now, terminal }) {
  const stages = Array.isArray(state?.presentation?.stages) ? state.presentation.stages : [];
  return stages.map((stage, index) => {
    const actionIds = Array.isArray(stage?.actionIds) ? stage.actionIds.filter((id) => typeof id === 'string') : [];
    const phaseAttempts = attempts.filter((attempt) => actionIds.includes(attempt?.actionId));
    return {
      ...stage,
      id: stage?.id ?? `phase-${index + 1}`,
      name: stage?.name ?? stage?.label ?? `phase-${index + 1}`,
      actionIds,
      minutes: intervalMinutes(phaseAttempts, { now, terminal }),
    };
  });
}

// A time bound may be an ISO string, a Date, epoch milliseconds, or a
// relative duration ('7d', '24h') measured back from `now` — the same
// vocabulary `workflow runs --since` already accepts.
export function toBoundMs(bound, now = Date.now()) {
  if (bound == null) return null;
  if (bound instanceof Date) return Number.isFinite(bound.getTime()) ? bound.getTime() : null;
  if (typeof bound === 'number') return Number.isFinite(bound) ? bound : null;
  const text = String(bound).trim();
  if (!text) return null;
  const duration = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(text);
  if (duration) return now - Number(duration[1]) * DURATION_MS[duration[2].toLowerCase()];
  return parseIso(text);
}

// Attempts carry their pool, model, wall seconds, and whatever usage the
// dispatcher recorded. `null` pool/model keys land under 'unknown', which is
// what src/workflow/v2-runtime.js addUsage() already does for pool totals.
function attemptTotals(attempts) {
  const list = (Array.isArray(attempts) ? attempts : []).filter((attempt) => attempt && typeof attempt === 'object');
  const pools = {};
  const models = {};
  const poolAttempts = new Map();
  const canonical = list.some((attempt) => attemptCanonicalUsage(attempt).canonical);
  for (const attempt of list) {
    const poolKey = attempt.pool ?? 'unknown';
    const modelKey = attempt.model ?? 'unknown';
    const pool = poolAttempts.get(poolKey) ?? [];
    pool.push(attempt);
    poolAttempts.set(poolKey, pool);
    const wallSec = finiteNumber(attempt.wallSec);
    const minutes = wallSec != null && wallSec >= 0 ? wallSec / 60 : null;
    const model = models[modelKey] ??= { attempts: 0, minutes: null };
    model.attempts += 1;
    if (minutes != null) model.minutes = (model.minutes ?? 0) + minutes;
  }
  if (canonical) {
    for (const [poolKey, grouped] of poolAttempts) {
      const aggregate = aggregateAttemptUsage(grouped);
      pools[poolKey] = {
        ...aggregate,
        // `costUsd` is the pre-v2 alias. It follows the strict whole-scope
        // amount; partial sums live only in the explicitly named subtotal.
        costUsd: aggregate.apiUsd,
      };
    }
  } else {
    // Historical records only carried costUsd and token classes. Preserve
    // their enumerable shape so older readers and fixtures continue to load.
    for (const attempt of list) {
      const poolKey = attempt.pool ?? 'unknown';
      const pool = pools[poolKey] ??= {
        attempts: 0, minutes: null, costUsd: null, tokens: null,
        cacheRead: null, cacheWrite: null, tokenSource: null,
      };
      const wallSec = finiteNumber(attempt.wallSec);
      const minutes = wallSec != null && wallSec >= 0 ? wallSec / 60 : null;
      const costUsd = finiteNumber(attempt.usage?.cost?.estimatedUsd);
      const tokens = finiteNumber(attempt.usage?.tokens?.totalKnown);
      const cacheRead = finiteNumber(attempt.usage?.tokens?.cacheRead);
      const explicitCacheWrite = finiteNumber(attempt.usage?.tokens?.cacheWrite);
      const cacheWrite5m = finiteNumber(attempt.usage?.tokens?.cacheWrite5m);
      const cacheWrite1h = finiteNumber(attempt.usage?.tokens?.cacheWrite1h);
      const cacheWrite = explicitCacheWrite ?? (cacheWrite5m != null || cacheWrite1h != null
        ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
        : null);
      const tokenSource = tokenSourceOf(attempt.usage?.tokenSource);
      pool.attempts += 1;
      pool.tokenSource = worstTokenSource(pool.tokenSource, tokenSource);
      if (minutes != null) pool.minutes = (pool.minutes ?? 0) + minutes;
      if (costUsd != null) pool.costUsd = (pool.costUsd ?? 0) + costUsd;
      if (tokens != null) pool.tokens = (pool.tokens ?? 0) + tokens;
      if (cacheRead != null) pool.cacheRead = (pool.cacheRead ?? 0) + cacheRead;
      if (cacheWrite != null) pool.cacheWrite = (pool.cacheWrite ?? 0) + cacheWrite;
    }
    for (const pool of Object.values(pools)) {
      pool.minutes = round(pool.minutes, 2);
      pool.costUsd = round(pool.costUsd, 6);
      pool.tokens = pool.tokens == null ? null : Math.round(pool.tokens);
      pool.cacheRead = pool.cacheRead == null ? null : Math.round(pool.cacheRead);
      pool.cacheWrite = pool.cacheWrite == null ? null : Math.round(pool.cacheWrite);
      pool.tokenSource ??= 'unknown';
    }
  }
  for (const model of Object.values(models)) model.minutes = round(model.minutes, 2);
  return { pools, models, canonical };
}

// The result envelope is the authority on requirements when it exists; a run
// finalized before this module shipped, or one whose envelope is gone, falls
// back to the durable ledger.
function requirementTotals(state, result) {
  const fromResult = Array.isArray(result?.requirements) ? result.requirements : null;
  if (fromResult) {
    return { passed: fromResult.filter((entry) => entry?.status === 'passed').length, total: fromResult.length };
  }
  const ledger = state?.ledger?.requirements;
  if (ledger && typeof ledger === 'object') {
    const entries = Object.values(ledger);
    return { passed: entries.filter((entry) => entry?.status === 'passed').length, total: entries.length };
  }
  const intent = Array.isArray(state?.intent?.requirements) ? state.intent.requirements : [];
  return { passed: 0, total: intent.length };
}

/**
 * The durable record for one finished run. Pure (R1).
 *
 * @param {object} state   the V2 durable state
 * @param {object|null} result  the stable result envelope, when one exists
 * @param {{project?: string|null, cwd?: string|null, now?: number}} [options]
 */
export function rollupRecord(state, result, { project = null, cwd, now = Date.now() } = {}) {
  const lifecycle = state?.lifecycle ?? {};
  const recordedCwd = cwd !== undefined ? cwd : (state?.intent?.cwd ?? null);
  const startedAtMs = parseIso(lifecycle.startedAt);
  const terminal = terminalStateOf(state, result);
  // A run that is not terminal has not finished, so its row carries no finish
  // time at all: a reopened run is re-indexed here as running, and inheriting
  // `now` (or its earlier finish) would list it beside the runs that ended.
  const finishedAt = terminal ? (lifecycle.finishedAt ?? result?.finishedAt ?? isoOf(now)) : null;
  const finishedAtMs = parseIso(finishedAt);
  const agentSeconds = finiteNumber(state?.budget?.seconds);
  const attempts = [
    ...(state?.preflight?.scout?.attempts ?? []),
    ...(state?.planner?.attempts ?? []),
    ...(state?.attempts ?? []),
  ];
  // Pre-v2 attempts can include the planner's transport record, but the
  // historical per-pool/model ledgers counted only worker attempts. Preserve
  // that enumerable shape for a legacy-shaped run; once any canonical v2
  // usage is present, aggregate every durable attempt so planner/scout usage
  // cannot disappear from a cost-aware run.
  const hasCanonicalUsage = attempts.some((attempt) => attemptCanonicalUsage(attempt).canonical);
  const ledgerAttempts = hasCanonicalUsage ? attempts : (state?.attempts ?? attempts);
  const { pools, models, canonical } = attemptTotals(ledgerAttempts);
  const usage = aggregateAttemptUsage(attempts);
  const minutes = intervalMinutes(attempts, { now, terminal });
  const phases = phaseRecords(state, attempts, { now, terminal });
  const lifecycleWallMinutes = startedAtMs != null && finishedAtMs != null
    ? round((finishedAtMs - startedAtMs) / MINUTE_MS, 2) : null;
  // Keep the legacy token ledger alongside the richer v2 aggregate. The
  // explicit cost/coverage fields are authoritative for all new views.
  usage.total = state?.usage?.total ?? (usage.tokens ?? 0);
  usage.byPool = state?.usage?.byPool && typeof state.usage.byPool === 'object'
    ? { ...state.usage.byPool }
    : {};
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId: state?.runId ?? result?.runId ?? null,
    shortId: state?.shortId ?? result?.shortId ?? null,
    project: project ?? null,
    goal: state?.intent?.goal ?? result?.goal ?? null,
    cwd: recordedCwd,
    startedAt: lifecycle.startedAt ?? null,
    finishedAt: finishedAt ?? null,
    status: result?.status ?? lifecycle.status ?? null,
    verified: result?.verified === true,
    requirements: requirementTotals(state, result),
    steps: {
      done: (state?.actions ?? []).filter((action) => action?.status === 'succeeded').length,
      total: Array.isArray(state?.actions) ? state.actions.length : null,
    },
    minutes: {
      active: minutes.active,
      span: minutes.span,
      // Keep the pre-0.35 field as a compatibility alias for older readers.
      // New duration readers must use `active`; `span` is the explicit wall
      // fact retained for secondary display only. The old alias follows the
      // attempt span when it is provable, and otherwise keeps the lifecycle
      // value for pre-0.35-shaped fixtures that have no attempt timestamps.
      wall: minutes.span ?? lifecycleWallMinutes,
      agent: agentSeconds != null && agentSeconds >= 0 ? round(agentSeconds / 60, 2) : null,
    },
    phases,
    pools,
    models,
    usage: canonical ? usage : {
      total: usage.total,
      byPool: usage.byPool,
    },
    legacy: false,
  };
}

export function rollupPath(runDir) {
  return join(runDir, 'rollup.json');
}

/** The record a run directory holds, or null when it has none (or a foreign one). */
export function readRollup(runDir) {
  const record = readJsonSafe(rollupPath(runDir), null);
  if (!record || typeof record !== 'object') return null;
  if (record.schemaVersion !== ROLLUP_SCHEMA_VERSION) return null;
  return record;
}

export function rollupIndexPath(bullswarmDir) {
  return join(bullswarmDir, 'history', 'runs.jsonl');
}

// <bullswarmDir>/workflows/<runId> → <bullswarmDir>
export function bullswarmDirOfRun(runDir) {
  return dirname(dirname(runDir));
}

function readIndexLines(bullswarmDir) {
  const path = rollupIndexPath(bullswarmDir);
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseIndexLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && record.runId ? record : null;
  } catch {
    // A torn final line (a writer mid-append) is skipped, not fatal: the
    // index is an accelerator, and the run directory still holds the truth.
    return null;
  }
}

/** Every record in the index, oldest line first, one per runId (R4). */
export function readRollupIndex(bullswarmDir) {
  const byId = new Map();
  for (const line of readIndexLines(bullswarmDir)) {
    const record = parseIndexLine(line);
    if (record) byId.set(record.runId, record);
  }
  return [...byId.values()];
}

/**
 * Append one record to the history index, idempotently by runId (R4).
 *
 * @returns {{runId: string, appended: boolean, replaced: boolean}}
 */
export function appendRollupIndex(bullswarmDir, record) {
  if (!record?.runId) throw new TypeError('a rollup record needs a runId to be indexed');
  const path = rollupIndexPath(bullswarmDir);
  const line = JSON.stringify(record);
  const lines = readIndexLines(bullswarmDir);
  const existing = lines.filter((entry) => parseIndexLine(entry)?.runId === record.runId);
  if (existing.length === 1 && existing[0] === line) {
    return { runId: record.runId, appended: false, replaced: false };
  }
  if (existing.length) {
    // Rewrite: one line per run, the newest wins. Atomic, so a concurrent
    // reader never sees a half-written index.
    const kept = lines.filter((entry) => parseIndexLine(entry)?.runId !== record.runId);
    atomicWriteFileSync(path, `${[...kept, line].join('\n')}\n`);
    return { runId: record.runId, appended: true, replaced: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  // A single line under the pipe-buffer size appends atomically, so two
  // kernels finishing at once cannot interleave their records.
  appendFileSync(path, `${line}\n`);
  return { runId: record.runId, appended: true, replaced: false };
}

/**
 * Write `<runDir>/rollup.json` and append it to the history index.
 *
 * The project is whatever the run recorded at goal time; a run that predates
 * that recording resolves it from its cwd instead.
 */
export function writeRunRollup(runDir, state, result, { now = Date.now(), project, cwd } = {}) {
  const recordedCwd = cwd !== undefined ? cwd : (state?.intent?.cwd ?? null);
  const resolvedProject = project !== undefined
    ? project
    : (readGoalProject(runDir)?.name ?? (recordedCwd ? projectName(recordedCwd) : null));
  const record = rollupRecord(state, result, { project: resolvedProject, cwd: recordedCwd, now });
  writeJsonAtomic(rollupPath(runDir), record);
  appendRollupIndex(bullswarmDirOfRun(runDir), record);
  return record;
}

// ------------------------------------------------------- legacy run records
//
// A pre-0.27.0 run directory has no V2 state: no lifecycle, no attempts, no
// requirement ledger. It is still a workflow the History timeline has to
// carry, so it gets one minimal record and nothing more. Where V2 state is
// silent, the record is null — never 0, never a guessed cost, never a pool
// minute. Its `goal` is the workflow name the run recorded, because that is
// the label the run itself left behind.

function isoFrom(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isoOfMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The run directory's files, except the rollup this module writes into it: a
// record may not be its own evidence of when the run finished, or writing it
// would move the time it records and break idempotency (R4).
function ownFileTimes(runDir) {
  let oldest = null;
  let newest = null;
  let names;
  try { names = readdirSync(runDir); } catch { return { oldest, newest }; }
  for (const name of names) {
    if (name === 'rollup.json') continue;
    let stat;
    try { stat = statSync(join(runDir, name)); } catch { continue; }
    if (!stat.isFile() || !Number.isFinite(stat.mtimeMs)) continue;
    if (oldest == null || stat.mtimeMs < oldest) oldest = stat.mtimeMs;
    if (newest == null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return { oldest, newest };
}

/**
 * What a legacy run directory can prove about itself, read from the files it
 * holds. `timeSource` names which one answered each time — `report` (the run's
 * own summary), `state` (the little its state.json recorded), `directory` (the
 * file times, the last resort), or `a+b` when the two times came from
 * different places — so a caller never has to guess how firm a time is. A
 * directory with no readable time at all reports nulls, not `now`.
 */
export function readLegacyRunFacts(runDir, { runId = null, shortId = null, project } = {}) {
  const report = readJsonSafe(join(runDir, 'report.json'), null);
  const state = readJsonSafe(join(runDir, 'state.json'), null);
  const reportStart = isoFrom(report?.startedAt);
  const reportFinish = isoFrom(report?.finishedAt);
  const stateStart = isoFrom(state?.startedAt);
  const stateFinish = isoFrom(state?.finishedAt);
  const needsFileTimes = (reportStart == null && stateStart == null)
    || (reportFinish == null && stateFinish == null);
  const times = needsFileTimes ? ownFileTimes(runDir) : { oldest: null, newest: null };
  const sourceOf = (inReport, inState) => (inReport ? 'report' : inState ? 'state' : 'directory');
  const startSource = sourceOf(reportStart != null, stateStart != null);
  const finishSource = sourceOf(reportFinish != null, stateFinish != null);
  const resolvedProject = project !== undefined ? project : (readGoalProject(runDir)?.name ?? null);
  return {
    runId,
    shortId: report?.shortId ?? state?.shortId ?? shortId ?? null,
    project: resolvedProject ?? null,
    // The label the run itself left: the workflow name — a bare string in the
    // earliest runs, an object later, exactly as short-id.js reads it for a
    // read-only row — else whatever goal it recorded. Never a cost.
    goal: report?.workflow
      ?? state?.name
      ?? (typeof state?.workflow === 'string' ? state.workflow : state?.workflow?.name)
      ?? state?.goal
      ?? report?.goal
      ?? null,
    status: report?.status ?? state?.status ?? null,
    startedAt: reportStart ?? stateStart ?? isoOfMs(times.oldest),
    finishedAt: reportFinish ?? stateFinish ?? isoOfMs(times.newest),
    timeSource: startSource === finishSource ? startSource : `${startSource}+${finishSource}`,
  };
}

/**
 * The minimal, durable record for a legacy run directory (R3). Pure: it shapes
 * the facts a reader resolved and reads nothing itself.
 *
 * `requirements` is 0 passed of 0 recorded — a legacy run left no ledger, and
 * a fabricated total would read as requirements that failed. `minutes.span`
 * (and its pre-0.35 `minutes.wall` alias) is the interval between the two times
 * the run itself recorded, and only when both came from the same one: a file
 * time says when a file was last written, which is not the moment the run
 * stopped, so subtracting it from a recorded start would report a duration the
 * run never had. `minutes.active` stays unknown because no attempt was ever
 * measured for this run. `pools` and `models` are empty.
 */
export function legacyRollupRecord(facts = {}) {
  const startedAt = isoFrom(facts.startedAt);
  const finishedAt = isoFrom(facts.finishedAt);
  const startedMs = Date.parse(startedAt ?? '');
  const finishedMs = Date.parse(finishedAt ?? '');
  const wallMinutes = (facts.timeSource === 'report' || facts.timeSource === 'state')
    && Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
    ? round((finishedMs - startedMs) / MINUTE_MS, 2)
    : null;
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId: facts.runId ?? null,
    shortId: facts.shortId ?? null,
    project: facts.project ?? null,
    goal: facts.goal ?? null,
    cwd: null,
    startedAt,
    finishedAt,
    status: facts.status ?? null,
    verified: false,
    requirements: { passed: 0, total: 0 },
    // Legacy runs have no attempt clocks, so active minutes are unknown. Their
    // recorded report/state interval remains an honest secondary span.
    minutes: { active: null, span: wallMinutes, wall: wallMinutes, agent: null },
    pools: {},
    models: {},
    legacy: true,
    timeSource: facts.timeSource ?? null,
  };
}

/**
 * Write `<runDir>/rollup.json` for a legacy run and append it to the history
 * index. The record is derived from the directory's own files only, so running
 * it twice produces the same line and the index reports it as present (R4).
 */
export function writeLegacyRollup(runDir, { runId = null, shortId = null, project } = {}) {
  const record = legacyRollupRecord(readLegacyRunFacts(runDir, { runId, shortId, project }));
  writeJsonAtomic(rollupPath(runDir), record);
  appendRollupIndex(bullswarmDirOfRun(runDir), record);
  return record;
}

// Fallback path only (see readRollups): reads `rollup.json` out of every run
// directory. This never opens a state.json, so it costs a stat and a small
// read per directory rather than the 22 MB `listRuns` parses.
function scanRunDirRollups(bullswarmDir) {
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return [];
  let names;
  try { names = readdirSync(runsRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith('wf-')) continue;
    const dir = join(runsRoot, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const record = readRollup(dir);
    if (record) out.push(record);
  }
  return out;
}

function recordTimeMs(record) {
  return parseIso(record?.finishedAt) ?? parseIso(record?.startedAt);
}

/**
 * Records newest first.
 *
 * Reads the index. Falls back to the run directories when the index is empty,
 * or when the caller asks for a window that starts before the oldest indexed
 * run — the case where a run finished before the index existed.
 *
 * @param {string} bullswarmDir
 * @param {{since?: *, until?: *, limit?: number|null, now?: number}} [options]
 *        `since` is inclusive, `until` exclusive; both accept an ISO string,
 *        a Date, epoch milliseconds, or a relative duration such as '7d'.
 */
export function readRollups(bullswarmDir, { since = null, until = null, limit = null, now = Date.now() } = {}) {
  const indexed = readRollupIndex(bullswarmDir);
  const byId = new Map(indexed.map((record) => [record.runId, record]));
  const sinceMs = toBoundMs(since, now);
  const untilMs = toBoundMs(until, now);

  const indexedTimes = indexed.map(recordTimeMs).filter((ms) => ms != null);
  const oldestIndexed = indexedTimes.length ? Math.min(...indexedTimes) : null;
  // The fallback is deliberately narrow. An empty index means nothing has
  // been recorded yet, and a window that opens before the oldest indexed run
  // is asking for history the index may not carry. An unbounded read trusts
  // the index instead of scanning: `bullswarm workflow reindex` is what makes
  // the index complete, and the whole point of this module is that the
  // dashboard's 1 s refresh reads one file.
  const needsFallback = indexed.length === 0
    || oldestIndexed == null
    || (sinceMs != null && sinceMs < oldestIndexed);
  if (needsFallback) {
    for (const record of scanRunDirRollups(bullswarmDir)) {
      if (!byId.has(record.runId)) byId.set(record.runId, record);
    }
  }

  const records = [...byId.values()].filter((record) => {
    const ms = recordTimeMs(record);
    if (sinceMs != null && (ms == null || ms < sinceMs)) return false;
    if (untilMs != null && (ms == null || ms >= untilMs)) return false;
    return true;
  });
  records.sort((a, b) => (recordTimeMs(b) ?? 0) - (recordTimeMs(a) ?? 0));
  return Number.isInteger(limit) && limit > 0 ? records.slice(0, limit) : records;
}
