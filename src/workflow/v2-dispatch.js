import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pickPool, isQuarantined } from '../lib/route.js';
import { assertDepthAllowed, childDepthEnv, loadState, quarantinePool, saveState } from '../lib/state.js';
import { resolveDispatchModel } from '../lib/strategy.js';
import { watchOnce } from '../lib/watch.js';

const EFFORT_BY_LANE = Object.freeze({ analyze: 'high', build: 'medium', chore: 'low' });
const MECHANICAL_KINDS = new Set(['auth', 'provider', 'process', 'interrupted', 'schema']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function classifyFailure(verdict) {
  if (verdict?.ok) return null;
  if (verdict?.cancelled || verdict?.meta?.cancelled) return 'cancelled';
  if (verdict?.quarantineHint) return 'auth';
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
  avoidPools = [], preferredModel = null, now = Date.now(),
} = {}) {
  const available = [];
  for (const pool of pools) {
    if (pool.enabled === false || pool.burstGate === true || isQuarantined(pool, now)) continue;
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
      excludedModels: pool.strategyExcludedModels ?? [],
    });
    if (!modelPolicy.eligible) continue;
    available.push({ ...pool, modelPolicy });
  }
  const preferred = available.filter((pool) => !avoidPools.includes(pool.name));
  // Evidence independence is preferred, never a deadlock: reuse an ancestor
  // pool only when no independent eligible pool exists.
  return preferred.length ? preferred : available;
}

function attemptPaths(base, ordinal) {
  if (typeof base === 'function') return base(ordinal);
  if (!base?.taskFile || !base?.outFile) throw new TypeError('paths must provide taskFile and outFile');
  if (ordinal === 1) return base;
  const suffix = `-attempt-${ordinal}`;
  const insert = (path) => path.replace(/(\.[^./]+)?$/, `${suffix}$1`);
  return { taskFile: insert(base.taskFile), outFile: insert(base.outFile) };
}

function appendDecision(bullswarmDir, record, { loadCoreState, saveCoreState, quarantine = null }) {
  const state = loadCoreState(bullswarmDir);
  state.decisionLog ??= [];
  state.decisionLog.push(record);
  if (quarantine) quarantinePool(state, quarantine.pool, quarantine.reason, quarantine.now);
  saveCoreState(bullswarmDir, state);
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
  bullswarmDir,
  parentEnv = process.env,
  preferredPool = null,
  preferredModel = null,
  strictPool = null,
  avoidPools = [],
  outputValidator = null,
  correctionTask = null,
  currentSession = null,
  maxMechanicalRetries = 1,
  shouldCancel = null,
  onAttempt = null,
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
  const saveCoreState = dependencies.saveState ?? saveState;
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const effort = action.effort ?? EFFORT_BY_LANE[action.lane] ?? 'low';
  let candidates = preparePools(pools, action, effort, {
    avoidPools, preferredModel, now: now(),
  });
  if (strictPool) candidates = candidates.filter((pool) => pool.name === strictPool);
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])
    ?.strategyAssignments?.[effort] ?? null;
  const effectivePreferredPool = preferredPool ?? configuredAssignment?.pool ?? null;
  const remaining = [...candidates];
  const attempts = [];
  let correctionUsed = false;
  let retriesUsed = 0;
  let nextTask = taskText;
  let last = null;

  while (remaining.length || (last && retriesUsed < maxMechanicalRetries)) {
    if (shouldCancel?.()) return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts, verdict: last };
    const routePools = remaining.length ? remaining : candidates;
    const route = pickPool(action.lane ?? 'chore', routePools, {
      callerEligible: false,
      callerSession: false,
      preferredPool: effectivePreferredPool,
      effortTier: effort,
      now: now(),
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
    const startedAt = new Date(now()).toISOString();
    const record = {
      ordinal, pool: pool.name, model: model ?? connector.model ?? null,
      startedAt, finishedAt: null, status: 'running', taskFile: files.taskFile,
      outFile: files.outFile, routing: { reason: route.why, candidates: route.candidates, effort, lane: action.lane ?? 'chore' },
      ...(session ? { session: clone(session.durable), continued: session.invocation.resume } : {}),
    };
    attempts.push(record);
    onAttempt?.('started', clone(record));
    const runtimeConnector = { ...connector, subscription: pool.subscription ?? connector.subscription ?? null };
    const verdict = await watch(runtimeConnector, nextTask, targetDir, files, {
      env: childDepthEnv(parentEnv),
      model,
      conversation: session?.invocation ?? null,
      shouldCancel,
      outputValidator,
      onActivity,
      onAgentEvent,
      onAgentProgress,
    });
    const finishedAt = new Date(now()).toISOString();
    const kind = classifyFailure(verdict);
    Object.assign(record, {
      finishedAt,
      status: verdict.ok ? 'succeeded' : kind === 'cancelled' ? 'cancelled' : 'failed',
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
      keepOnClaude: false, ok: verdict.ok, why: verdict.why ?? null,
      wallSec: verdict.meta?.wallSec ?? null, model: record.model,
      usage: verdict.meta?.usage ?? null, routing: record.routing,
      outFile: files.outFile, source: 'workflow-v2', actionId: action.id,
    }, {
      loadCoreState, saveCoreState,
      quarantine: verdict.quarantineHint ? { pool: pool.name, reason: verdict.why, now: now() } : null,
    });
    if (verdict.ok) return { ok: true, status: 'succeeded', attempts, verdict, session: currentSession };
    if (kind === 'cancelled') return { ok: false, status: 'cancelled', failureKind: kind, attempts, verdict };
    if (!MECHANICAL_KINDS.has(kind)) return { ok: false, status: 'failed', failureKind: kind, attempts, verdict };

    const index = remaining.findIndex((candidate) => candidate.name === pool.name);
    if (index >= 0) remaining.splice(index, 1);
    if (kind === 'schema' && !correctionUsed && typeof correctionTask === 'function') {
      correctionUsed = true;
      nextTask = correctionTask(verdict, { originalTask: taskText, attempt: ordinal });
      // Schema correction continues the same physical conversation when the
      // connector supports it. Put the same pool first without widening the
      // total correction allowance.
      remaining.unshift(pool);
      continue;
    }
    if (retriesUsed >= maxMechanicalRetries) break;
    retriesUsed += 1;
    // Prefer a different eligible pool. If no alternative exists, one bounded
    // same-pool retry is permitted for transient process/provider failure.
    if (!remaining.length && candidates.length === 1 && kind !== 'auth') remaining.push(pool);
  }

  return {
    ok: false,
    status: 'failed',
    failureKind: last ? classifyFailure(last) : 'unavailable',
    attempts,
    verdict: last ?? { ok: false, why: 'no eligible pool', meta: { exitCode: null } },
  };
}

export { classifyFailure as classifyV2DispatchFailure, preparePools as prepareV2DispatchPools };
