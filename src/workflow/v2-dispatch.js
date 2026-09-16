import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pickPool, isQuarantined } from '../lib/route.js';
import {
  assertDepthAllowed, childDepthEnv, loadState, quarantinePool, quarantineUpstreamSiblings,
  updateState, upstreamGroupOf,
} from '../lib/state.js';
import { disabledModelsForPool, resolveDispatchModel, selectedModelsForTier } from '../lib/strategy.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { watchOnce } from '../lib/watch.js';
import {
  expectedMinutesFromSpendModel, registerAssignment, releaseAssignment, updateAssignment,
  withLedger,
} from '../lib/assignments.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';

const MECHANICAL_KINDS = new Set(['auth', 'quota', 'provider', 'process', 'interrupted', 'schema', 'stalled']);
/** Kinds that make the SAME pool unusable, so a retry must move elsewhere. */
const POOL_FATAL_KINDS = new Set(['auth', 'quota']);

// A worker that writes nothing at all for this long is stalled: its process is
// stopped and the attempt fails as `stalled`, a mechanical failure that retries
// once and otherwise hands the run back. It bounds silence, not run time: the
// clock restarts on every byte, so an agent that keeps working is never cut off.
// Without it one hung worker kept its whole run open forever.
export const DEFAULT_WORKER_SILENCE_SEC = 60 * 60;

export function workerSilenceTimeoutSec(env = process.env) {
  const raw = Number(env?.BULLSWARM_WORKER_SILENCE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_SILENCE_SEC;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function classifyFailure(verdict) {
  if (verdict?.ok) return null;
  if (verdict?.cancelled || verdict?.meta?.cancelled) return 'cancelled';
  // Quota outranks the quarantine hint: a usage limit also asks for a
  // quarantine, but it is a healthy credential with an empty window, and only
  // it carries a real reset deadline.
  if (verdict?.failureKind === 'quota') return 'quota';
  if (verdict?.quarantineHint) return 'auth';
  if (verdict?.failureKind === 'stalled' || verdict?.meta?.stalled) return 'stalled';
  if (verdict?.failureKind === 'provider' || verdict?.meta?.providerFailureType) return 'provider';
  if (verdict?.failureKind === 'schema') return 'schema';
  if (verdict?.failureKind === 'process' || (verdict?.meta?.exitCode != null && verdict.meta.exitCode !== 0)) return 'process';
  if (verdict?.meta?.signal) return 'interrupted';
  if (verdict?.meta?.timedOut || verdict?.meta?.spawnError) return 'provider';
  return 'semantic';
}

function providerIdFromModel(model) {
  if (typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

function preparePools(pools, action, effort, {
  preferredModel = null, strictPool = null, now = Date.now(),
  liveQuarantine = null,
  // Which pools COULD run this action were none of them paused: used to say
  // when work can be retried, and to refuse a pin that can never run it.
  ignoreQuarantine = false,
} = {}) {
  const available = [];
  for (const pool of pools) {
    if (pool.enabled === false || pool.burstGate === true) continue;
    if (!ignoreQuarantine && isQuarantined(pool, now)) continue;
    // The pool object may predate a quarantine written by another action or
    // another run. Core state is the shared record, so consult it directly.
    const live = !ignoreQuarantine && typeof liveQuarantine === 'function' ? liveQuarantine(pool.name) : null;
    if (live && isQuarantined({ quarantine: live }, now)) continue;
    const connector = pool.connector ?? pool;
    // A discovered provider clone represents one concrete credential and its
    // meter. Retargeting it to another provider-qualified model would make the
    // pool label, quota attribution, and quarantine target untrue. An exact
    // model pin may therefore use only the clone for that provider ID.
    const pinnedProvider = providerIdFromModel(preferredModel);
    if (pinnedProvider && connector.profile?.providerId
      && connector.profile.providerId !== pinnedProvider) continue;
    const assignment = pool.strategyAssignments?.[effort] ?? null;
    const modelPolicy = resolveDispatchModel(connector, effort, {
      assignment,
      excludedModels: [
        ...(pool.strategyExcludedModels ?? []),
        ...disabledModelsForPool({ disabledModels: pool.strategyDisabledModels }, pool.name),
      ],
      allowedModels: selectedModelsForTier({
        modelTiers: pool.strategyModelTiers,
        configuredTiers: pool.strategyConfiguredTiers,
      }, pool.name, effort),
    });
    if (!modelPolicy.eligible) continue;
    available.push({ ...pool, modelPolicy });
  }
  // A strict pin defines the complete dispatch universe.
  return strictPool
    ? available.filter((pool) => pool.name === strictPool)
    : available;
}

/**
 * The run id an artifact path belongs to. The kernel owns the id and should
 * pass it explicitly; deriving it from the run directory keeps the ledger
 * honest for callers that have not been updated yet, without inventing one.
 */
function runIdFromPaths(files) {
  const match = /(?:^|[\\/])(wf-[a-z0-9]+-[a-f0-9]{6})(?:[\\/]|$)/.exec(files?.taskFile ?? '');
  return match ? match[1] : null;
}

function attemptPaths(base, ordinal) {
  if (typeof base === 'function') return base(ordinal);
  if (!base?.taskFile || !base?.outFile) throw new TypeError('paths must provide taskFile and outFile');
  if (ordinal === 1) return base;
  const suffix = `-attempt-${ordinal}`;
  const insert = (path) => path.replace(/(\.[^./]+)?$/, `${suffix}$1`);
  return { taskFile: insert(base.taskFile), outFile: insert(base.outFile) };
}

/**
 * Append this attempt's decision to shared core state. Concurrent actions in
 * one workflow all write this file, so the whole read-modify-write happens
 * inside updateCoreState's cross-process lock on a fresh load — a plain
 * load/push/save dropped sibling entries and undid quarantines (S5, D5).
 */
function appendDecision(bullswarmDir, record, { updateCoreState, quarantine = null }) {
  updateCoreState(bullswarmDir, (state) => {
    state.decisionLog ??= [];
    state.decisionLog.push(record);
    if (quarantine) {
      const kind = quarantine.kind ?? 'auth';
      const until = quarantinePool(state, quarantine.pool, quarantine.reason, quarantine.now, {
        until: quarantine.until ?? null,
        kind,
      });
      // Siblings of a dead credential are benched inside the SAME locked
      // update, on the deadline quarantinePool just computed — one upstream,
      // one deadline, no second window opened a millisecond later.
      quarantineUpstreamSiblings(state, quarantine.groupPools ?? [], {
        pool: quarantine.pool,
        group: quarantine.group ?? null,
        reason: quarantine.reason,
        now: quarantine.now,
        until,
        kind,
      });
    }
  });
}

function selectedModel(pool, effort, preferredModel = null) {
  if (preferredModel && !(pool.strategyExcludedModels ?? []).includes(preferredModel)) return preferredModel;
  const assignment = pool.strategyAssignments?.[effort] ?? null;
  return pool.modelPolicy?.model
    ?? (assignment?.pool === pool.name ? assignment.model : null)
    ?? null;
}

function sessionFor(connector, pool, model, current, now, uuid) {
  if (!connector.conversation) return null;
  if (current?.pool === pool.name && current?.model === (model ?? current.model)) {
    return {
      durable: clone(current),
      invocation: { sessionId: current.sessionId, resume: true },
    };
  }
  const at = new Date(now).toISOString();
  const durable = {
    pool: pool.name,
    model: model ?? connector.model ?? 'provider-default',
    sessionId: uuid(),
    generation: Number(current?.generation ?? 0) + 1,
    startedAt: at,
    lastUsedAt: at,
  };
  return { durable, invocation: { sessionId: durable.sessionId, resume: false } };
}

/**
 * Dispatch one autonomous V2 action.
 *
 * The dispatcher owns only mechanical concerns. Semantic rejection is
 * returned after one observation; it never creates a repair/retry loop.
 */
export async function dispatchV2Action({
  action,
  taskText,
  targetDir,
  paths,
  pools,
  refreshPools = null,
  bullswarmDir,
  runId = null,
  parentEnv = process.env,
  preferredPool = null,
  preferredModel = null,
  strictPool = null,
  reasoningOverride = null,
  runReasoning = null,
  outputValidator = null,
  correctionTask = null,
  currentSession = null,
  maxMechanicalRetries = 1,
  silenceTimeoutSec = workerSilenceTimeoutSec(parentEnv),
  shouldCancel = null,
  onAttempt = null,
  onSpawn = null,
  onWorkerExit = null,
  onActivity = null,
  onAgentEvent = null,
  onAgentProgress = null,
  dependencies = {},
} = {}) {
  if (!action || typeof action.id !== 'string') throw new TypeError('action is required');
  if (typeof taskText !== 'string' || !taskText) throw new TypeError('taskText is required');
  if (!Array.isArray(pools)) throw new TypeError('pools must be an array');
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const watch = dependencies.watchOnce ?? watchOnce;
  const loadCoreState = dependencies.loadState ?? loadState;
  // Injectable for tests; the default is the locked read-modify-write. A test
  // that only stubs loadState/saveState still gets a locked update built from
  // its own stubs, so its recorded writes stay observable.
  const updateCoreState = dependencies.updateState
    ?? (dependencies.loadState || dependencies.saveState
      ? (dir, mutator) => {
        const state = loadCoreState(dir);
        if (mutator(state) !== false) (dependencies.saveState ?? (() => {}))(dir, state);
        return state;
      }
      : updateState);
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const effort = action.effort ?? DEFAULT_EFFORT_BY_LANE[action.lane] ?? 'medium';
  const liveQuarantines = dependencies.liveQuarantines ?? (() => {
    try { return loadCoreState(bullswarmDir).pools ?? {}; }
    catch { return {}; }
  });
  const prepare = (poolList) => {
    const live = liveQuarantines();
    return preparePools(poolList, action, effort, {
      preferredModel, strictPool, now: now(),
      liveQuarantine: (name) => live[name]?.quarantine ?? null,
    });
  };
  const safeCoreState = () => {
    try { return loadCoreState(bullswarmDir); } catch { return null; }
  };
  const coreDecisionLog = () => safeCoreState()?.decisionLog ?? [];
  // Operator-configurable, read once: the flat surplus cost of an in-flight
  // agent on a pool whose pacing-window spend rate nobody has measured yet.
  const inflightPenaltyPct = inflightPenaltyFrom(safeCoreState());
  // One expectation for the whole action: lane and effort do not change
  // between attempts, and the spend model is memoized per process anyway. The
  // decision log makes it a measured median instead of a documented default.
  const expected = await expectedMinutesFromSpendModel(
    { lane: action.lane ?? 'chore', effort },
    { decisionLog: coreDecisionLog() },
  );
  let candidates = prepare(pools);
  // The unfiltered list, kept current across refreshes: a sibling benched for
  // a shared upstream may itself be ineligible for THIS action (wrong lane,
  // blocked model) and still has to be taken out of service for every other.
  let allPools = pools;
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])
    ?.strategyAssignments?.[effort] ?? null;
  const effectivePreferredPool = preferredPool ?? configuredAssignment?.pool ?? null;
  const remaining = [...candidates];
  const attempts = [];
  let correctionUsed = false;
  let retriesUsed = 0;
  let nextTask = taskText;
  let last = null;
  const tried = new Set();
  let forceRefresh = false;
  let replayPool = null;

  while (remaining.length || (last && retriesUsed < maxMechanicalRetries)) {
    if (shouldCancel?.()) return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts, verdict: last };
    const replay = replayPool;
    replayPool = null;
    // Meters and quarantines move while an action is in flight. Re-read them
    // before every pick so a pool that just hit its limit — here or in another
    // run — is no longer a candidate.
    if (typeof refreshPools === 'function') {
      let refreshed = null;
      try { refreshed = await refreshPools({ force: forceRefresh }); }
      catch { refreshed = null; }
      forceRefresh = false;
      if (Array.isArray(refreshed) && refreshed.length) {
        allPools = refreshed;
        candidates = prepare(refreshed);
        remaining.length = 0;
        // A pool deliberately re-queued for a same-pool retry survives the
        // rebuild; every other already-tried pool stays out.
        if (replay) remaining.push(replay);
        for (const candidate of candidates) {
          if (!tried.has(candidate.name) && candidate.name !== replay?.name) remaining.push(candidate);
        }
      }
    }
    const routePools = remaining.length ? remaining : candidates;
    // The ledger is re-read HERE, before every pick and every retry, not on
    // the refresher's 15s throttle: up to four kernel actions start within
    // milliseconds of each other, and each has to see the assignments the
    // others just registered. Cheap by construction — a directory read, no
    // meter poll and no network.
    const pickAt = now();
    attachForecast(routePools, bullswarmDir, { now: pickAt, decisionLog: coreDecisionLog() });
    const route = pickPool(action.lane ?? 'chore', routePools, {
      callerEligible: false,
      callerSession: false,
      preferredPool: effectivePreferredPool,
      effortTier: effort,
      now: pickAt,
      candidateMinutes: expected.expectedMinutes,
      inflightPenaltyPct,
    });
    if (!route.pick) break;
    const pool = route.pick.connector;
    const connector = pool.connector ?? pool;
    const model = selectedModel(pool, effort, preferredModel);
    const ordinal = attempts.length + 1;
    const files = attemptPaths(paths, ordinal);
    const session = sessionFor(connector, pool, model, currentSession, now(), uuid);
    const coreState = loadCoreState(bullswarmDir);
    assertDepthAllowed(coreState, parentEnv);
    // Resolved per attempt, not per action: a retry lands on another pool with
    // another connector and another model, so the level is recomputed against
    // whatever this attempt actually spawns, reading the LIVE core strategy.
    const reasoning = resolveReasoningLevel({
      connector,
      tier: effort,
      model,
      strategy: coreState.strategy ?? null,
      runOverride: runReasoning,
      actionOverride: reasoningOverride
        ?? (isReasoningLevel(action.reasoning) ? action.reasoning : null),
    });
    const startedAt = new Date(now()).toISOString();
    const record = {
      ordinal, pool: pool.name, model: model ?? connector.model ?? null,
      routeWhy: route.why,
      routeCandidates: route.candidates.map((candidate) => ({
        pool: candidate.pool,
        effectiveSurplus: candidate.effectiveSurplus,
        urgencyState: candidate.urgencyState,
        forecastPacingPct: candidate.forecastPacingPct,
      })),
      startedAt, finishedAt: null, status: 'running', taskFile: files.taskFile,
      outFile: files.outFile, reasoning,
      routing: {
        reason: route.why, candidates: route.candidates, effort,
        lane: action.lane ?? 'chore', fiveHourUsedPct: pool.fiveHourUsedPct ?? null,
        // What this attempt was routed on: the pool's load and where its 5h
        // window is projected to land once this assignment has run.
        forecast: forecastRecord(route, pool.name),
      },
      ...(session ? { session: clone(session.durable), continued: session.invocation.resume } : {}),
    };
    attempts.push(record);
    tried.add(pool.name);
    onAttempt?.('started', clone(record));
    const runtimeConnector = { ...connector, subscription: pool.subscription ?? connector.subscription ?? null };
    // In-flight the instant the pool is picked — before the spawn, so four
    // concurrent kernel actions cannot all read this pool as idle.
    const ledgerEntry = withLedger(() => registerAssignment(bullswarmDir, {
      pool: pool.name, model: record.model, lane: action.lane ?? 'chore', effort,
      source: 'workflow-v2', runId: runId ?? runIdFromPaths(files),
      actionId: action.id, attempt: ordinal, startedAt, ...expected,
    }));
    let workerPid = null;
    let verdict;
    try { verdict = await watch(runtimeConnector, nextTask, targetDir, files, {
      env: childDepthEnv(parentEnv),
      model,
      reasoning,
      conversation: session?.invocation ?? null,
      shouldCancel,
      silenceTimeoutSec,
      processGroup: true,
      onSpawn: (pid) => {
        workerPid = pid;
        if (ledgerEntry) withLedger(() => updateAssignment(bullswarmDir, ledgerEntry.id, { workerPid: pid }));
        onSpawn?.(pid);
      },
      outputValidator,
      onActivity,
      onAgentEvent,
      onAgentProgress,
      bullswarmDir,
    }); } finally {
      if (ledgerEntry) withLedger(() => releaseAssignment(bullswarmDir, ledgerEntry.id));
      if (workerPid) onWorkerExit?.(workerPid);
    }
    const finishedAt = new Date(now()).toISOString();
    const kind = classifyFailure(verdict);
    // One dead upstream credential is ONE outage however many pool names front
    // it. The in-memory candidate list predates the quarantine written below,
    // and a refresher is optional, so the group is dropped here as well — the
    // next attempt of THIS action must not walk from one pool name to the next
    // sibling on the same credential into the same failure, as it did on
    // 2026-09-11.
    const benchedGroup = verdict.quarantineHint && kind === 'auth' ? upstreamGroupOf(pool) : null;
    if (benchedGroup) {
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (upstreamGroupOf(remaining[i]) === benchedGroup) remaining.splice(i, 1);
      }
    }
    const remainingAfterAttempt = remaining.filter((candidate) => candidate.name !== pool.name);
    const canCorrectSchema = kind === 'schema' && !correctionUsed && typeof correctionTask === 'function';
    const canRetryMechanically = MECHANICAL_KINDS.has(kind)
      && kind !== 'schema'
      && (remainingAfterAttempt.length > 0
        || (retriesUsed < maxMechanicalRetries && candidates.length === 1 && !POOL_FATAL_KINDS.has(kind)));
    const willRecover = canCorrectSchema || canRetryMechanically;
    Object.assign(record, {
      finishedAt,
      status: verdict.ok
        ? 'succeeded'
        : kind === 'cancelled'
          ? 'cancelled'
          : willRecover
            ? 'interrupted'
            : 'failed',
      failureKind: kind,
      why: verdict.why ?? null,
      usage: clone(verdict.meta?.usage ?? null),
      wallSec: verdict.meta?.wallSec ?? null,
    });
    // A schema-invalid answer still completed a real provider turn. Resume
    // that same physical conversation for the bounded correction instead of
    // opening a second session and losing the model's immediate context.
    const sessionEstablished = verdict.ok || kind === 'schema' || kind === 'semantic';
    if (session && sessionEstablished) {
      record.session.lastUsedAt = finishedAt;
      currentSession = clone(record.session);
    }
    last = verdict;
    onAttempt?.('finished', clone(record), verdict);
    appendDecision(bullswarmDir, {
      ts: finishedAt, lane: action.lane ?? 'chore', picked: pool.name,
      keepOnClaude: false, ok: verdict.ok, failureKind: verdict.ok ? null : kind, why: verdict.why ?? null,
      wallSec: verdict.meta?.wallSec ?? null, model: record.model,
      reasoning: clone(reasoning),
      usage: verdict.meta?.usage ?? null, routing: record.routing,
      forecast: record.routing.forecast,
      outFile: files.outFile, source: 'workflow-v2', actionId: action.id,
    }, {
      updateCoreState,
      quarantine: verdict.quarantineHint ? {
        pool: pool.name, reason: verdict.why, now: now(),
        until: verdict.quarantineUntil ?? null,
        kind: kind === 'quota' ? 'quota' : 'auth',
        group: upstreamGroupOf(pool), groupPools: allPools,
      } : null,
    });
    // A quota failure invalidates this run's meter picture: poll live before
    // choosing where the work goes next.
    if (kind === 'quota') forceRefresh = true;
    if (verdict.ok) return { ok: true, status: 'succeeded', attempts, verdict, session: currentSession };
    if (kind === 'cancelled') return { ok: false, status: 'cancelled', failureKind: kind, attempts, verdict };
    if (!MECHANICAL_KINDS.has(kind)) return { ok: false, status: 'failed', failureKind: kind, attempts, verdict };

    const index = remaining.findIndex((candidate) => candidate.name === pool.name);
    if (index >= 0) remaining.splice(index, 1);
    if (canCorrectSchema) {
      correctionUsed = true;
      nextTask = correctionTask(verdict, { originalTask: taskText, attempt: ordinal });
      // Schema correction continues the same physical conversation when the
      // connector supports it. Put the same pool first without widening the
      // total correction allowance.
      remaining.unshift(pool);
      replayPool = pool;
      continue;
    }
    if (retriesUsed >= maxMechanicalRetries) break;
    retriesUsed += 1;
    // Prefer a different eligible pool. If no alternative exists, one bounded
    // same-pool retry is permitted for transient process/provider failure.
    if (!remaining.length && candidates.length === 1 && !POOL_FATAL_KINDS.has(kind)) {
      remaining.push(pool);
      replayPool = pool;
    }
  }

  // The step fails now rather than waiting for a pool: a run never sits open
  // on quota. When every pool that can run it is paused, say when the first one
  // comes back, so the caller knows when `workflow resume` will get through.
  const lane = action.lane ?? 'chore';
  const capable = preparePools(allPools, action, effort, {
    preferredModel, strictPool, now: now(), ignoreQuarantine: true,
  });
  const live = liveQuarantines();
  let comesBack = null;
  for (const pool of capable) {
    const deadlines = [pool.quarantine?.until, live[pool.name]?.quarantine?.until]
      .map((value) => (typeof value === 'string' ? Date.parse(value) : Number(value)))
      .filter((value) => Number.isFinite(value) && value > now());
    // A capable pool that is not paused gives no single time to wait for.
    if (!deadlines.length) { comesBack = null; break; }
    const back = Math.max(...deadlines);
    comesBack = comesBack == null ? back : Math.min(comesBack, back);
  }
  const retryAfter = comesBack == null ? null : new Date(comesBack).toISOString();
  const failureKind = last ? classifyFailure(last) : 'unavailable';
  const why = !capable.length
    ? strictPool
      ? `no eligible pool: the pinned pool ${strictPool} cannot run ${lane}/${effort} work (it is disabled or has no model on the ${effort} tier)`
      : `no eligible pool: no enabled pool has a model on the ${effort} tier for ${lane} work`
    : retryAfter
      ? `no eligible pool: every pool that can run this step is paused until ${retryAfter}`
      : 'no eligible pool';
  return {
    ok: false,
    status: 'failed',
    failureKind,
    ...(retryAfter && ['quota', 'auth', 'unavailable'].includes(failureKind) ? { retryAfter } : {}),
    attempts,
    verdict: last ?? { ok: false, why, meta: { exitCode: null } },
  };
}

export { classifyFailure as classifyV2DispatchFailure, preparePools as prepareV2DispatchPools };
