// Dispatch one workflow step: pick a pool, run its attempts, gate them, and
// apply the failure rule. The pools, snapshot, deliverable verdict, attempt
// files, handoff, step restart and no-pool reasons live in dispatch-*.js.
import { clone } from '../lib/clone.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { handoffBlock } from './retry-handoff.js';
import { outsideBlockers } from './time-box.js';
import {
  LANES, PACING_FORECAST_BLOCK_PCT, expiringSoonView, pickPool,
} from '../lib/route.js';
import {
  assertDepthAllowed, childDepthEnv, loadState, updateState, upstreamGroupOf,
} from '../lib/state.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { watchOnce } from '../lib/watch.js';
import { MAX_THROTTLE_RETRIES, throttleBackoffMs } from '../lib/quota.js';
import {
  expectedMinutesFromSpendModel, registerAssignment, releaseAssignment, updateAssignment,
  withLedger,
} from '../lib/assignments.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { probeFreeModel, shouldProbeFreeModel } from '../lib/probe.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';
import { REFUSAL_TEXT, declaredDeliverable, declaredEvidence, deliverableTypeOf, failureClassOf, roleOf } from './step-vocabulary.js';
import { poolPassesRoute, routeUnavailableWhy } from './step-route.js';
import { drainingPart, heldEntry, noPoolFailureKind, noPoolWhy, signInPart, spentWindowPart } from './no-pool-why.js';
import { isV3Step } from './program-v3.js';
import {
  evidenceEnv, evidenceFailureWhy, evidenceSchemaBaseline, evidenceScope, removeCreatedOutOfScope,
  restoreChangedOutOfScope, runStepEvidence,
} from './evidence-runner.js';
import { attemptSilenceTimeoutSec, workerSilenceTimeoutSec } from './dispatch-silence.js';
import { preparePools, selectedModel } from './dispatch-pools.js';
import { attemptPaths, evidenceLogFile, fileBytes, runIdFromPaths, withAttemptArtifacts } from './dispatch-attempt-files.js';
import {
  captureDiffSnapshot, hashTerritory, headCommit, statDeliverablePaths, territoryFiles, trackedFiles, uniquePaths,
} from './dispatch-snapshot.js';
import { deliverableVerdict, gateBaselinePaths } from './dispatch-deliverable.js';
import { durableHandoff, lastResponseEvents, streamShowsWork } from './dispatch-handoff.js';
import { noPoolCandidates, tierOffReasons } from './dispatch-no-pool.js';

export { workerSilenceTimeoutSec } from './dispatch-silence.js';
export { attemptArtifactsOnDisk } from './dispatch-attempt-files.js';
export { snapshotPossible } from './dispatch-snapshot.js';
export { durableAttemptHandoff } from './dispatch-handoff.js';
export {
  appliedStepRestart, clearStepRestart, markStepRestartApplied, readStepRestarts, requestStepRestart,
  requeueRestartedStep,
} from './dispatch-restart.js';
export { handoffBlock, deliverableVerdict, statDeliverablePaths };

export const GATE_RETRY_PIN_SOURCE = 'the same pool (gate retry)';
// Gate failures whose one retry a report's `outside:` blocker cancels. A
// schema correction and every process failure keep their retry.
const OUTSIDE_SKIPS_RETRY = new Set(['failed-evidence', 'not-produced', 'semantic']);
const OUTSIDE_WHY_CHARS = 160;

// The `outside:` blockers in an attempt's out file; an unreadable or missing
// file (a killed worker) names none.
function readOutsideBlockers(outFile) {
  if (!outFile) return [];
  try { return outsideBlockers(readFileSync(outFile, 'utf8')); } catch { return []; }
}

function cutChars(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}
// The longest wait a provider may name for a transient rate limit that is
// still sat out on the same pool. A longer one goes to the caller, told when
// the provider said to try again.
export const MARKED_THROTTLE_MAX_WAIT_MS = 2 * 60_000;

// A refusal at start (a sign-in failure, or a model the plan does not
// include, before any work) is picked again at once and never spends the
// step's one retry, at most this many times per step (counted from its
// stored attempts, so a resume does not reset it).
export const MAX_REFUSAL_REPICKS = 3;
const REFUSAL_KINDS = new Set(['auth', 'model-not-in-plan']);
const REFUSAL_LANES = new Set(['analyze', 'build', 'chore']);

function classifyFailure(verdict, pool = null) {
  if (verdict?.ok) return null;
  if (verdict?.cancelled || verdict?.meta?.cancelled) return 'cancelled';
  if (verdict?.failureKind === 'not-produced') return 'not-produced';
  if (verdict?.failureKind === 'failed-evidence') return 'failed-evidence';
  // A usage limit is a healthy credential with an empty window, and only it
  // carries a real reset.
  if (verdict?.failureKind === 'quota') return 'quota';
  if (verdict?.failureKind === 'throttle') return 'throttle';
  if (verdict?.failureKind === 'auth') return 'auth';
  // The pool's plan does not include the model (a connector's
  // modelPlanSignatures): a fact about that pool and model, not a dead pool.
  if (verdict?.failureKind === 'model-not-in-plan') return 'model-not-in-plan';
  if (verdict?.failureKind === 'stalled' || verdict?.meta?.stalled) return 'stalled';
  if (verdict?.failureKind === 'provider' || verdict?.meta?.providerFailureType) return 'provider';
  if (verdict?.failureKind === 'schema') return 'schema';
  // A free endpoint that returned literally no answer is indistinguishable
  // from a dead provider for routing purposes. Keep semantic announcements and
  // other verifier judgments intact; only the explicit empty-output verdict is
  // eligible for the provider retry path. Check this before a non-zero
  // exit-code classification because some connectors terminate after emitting
  // an empty response and still need the provider fallback.
  if (pool?.free === true && verdict?.why === 'empty output') return 'provider';
  // A worker a signal stopped (the kernel's SIGTERM, a timeout) was
  // interrupted, even when the step's output validator already called the
  // missing answer a process failure (watch.js), as it does for every v3 step.
  if (verdict?.meta?.signal) return 'interrupted';
  if (verdict?.failureKind === 'process' || (verdict?.meta?.exitCode != null && verdict.meta.exitCode !== 0)) return 'process';
  if (verdict?.meta?.timedOut || verdict?.meta?.spawnError) return 'provider';
  return 'semantic';
}

// A worker whose CLI never started did nothing, so its failure is a process
// failure (another pool, D4) and the one retry an act step may get (D32).
// classifyFailure keeps reading it as saved runs do.
function workerNeverStarted(verdict) {
  return verdict?.meta?.workerNotStarted === true || Boolean(verdict?.meta?.spawnError);
}

// A spent usage window arrives as `quota` from the worker's verdict itself:
// every dispatch asks watchOnce for the limits-to-caller reading
// (`usageLimitsToCaller`).
function failureKindOf(verdict, pool = null) {
  const kind = classifyFailure(verdict, pool);
  if (kind && kind !== 'cancelled' && workerNeverStarted(verdict) && failureClassOf(kind) !== 'process') return 'process';
  return kind;
}

// When a rate limit names a wait too long to sit out, the time the provider
// said to try again (never slept), else null.
function longThrottleReturn(kind, verdict, finishedMs) {
  const wait = kind === 'throttle' && Number(verdict?.throttleWaitMs) > 0 ? Number(verdict.throttleWaitMs) : null;
  return wait != null && wait > MARKED_THROTTLE_MAX_WAIT_MS ? finishedMs + wait : null;
}

function toMs(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

function writeFileIfChanged(path, body) {
  try {
    if (readFileSync(path, 'utf8') === body) return;
  } catch { /* first write */ }
  try { writeFileSync(path, body); } catch { /* best effort */ }
}

/**
 * Append this attempt's decision to shared core state. Concurrent actions in
 * one workflow all write this file, so the whole read-modify-write happens
 * inside updateCoreState's cross-process lock on a fresh load — a plain
 * load/push/save dropped sibling entries (S5, D5). The decision log is all a
 * dispatch writes there: no pool is paused or benched (state.js S1).
 */
function appendDecision(bullswarmDir, record, { updateCoreState } = {}) {
  updateCoreState(bullswarmDir, (state) => {
    state.decisionLog ??= [];
    state.decisionLog.push(record);
  });
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
  // Program v3 (answers.js): `({ files, ordinal }) => text | null`, the answer
  // paragraph naming this attempt's answer file. Composed per attempt, like
  // the time box, and never kept in `nextTask`.
  answerBrief = null,
  handoffBlock: formatHandoff = handoffBlock,
  currentSession = null,
  maxMechanicalRetries = 1,
  silenceTimeoutSec = null,
  shouldCancel = null,
  onAttempt = null,
  onSpawn = null,
  onWorkerExit = null,
  onActivity = null,
  onAgentEvent = null,
  onAgentProgress = null,
  evidence = null,
  ledgerAttempts = [],
  dependencies = {},
  resumeAttempt = null,
  resumeHandoff = null,
  runDir = null,
  // `({ pool, startedAt }) => ({ text, record }) | null`: the soft time box
  // for one attempt (src/workflow/time-box.js). Resolved per attempt, because
  // a retry can land on another pool and always starts its own clock.
  timeBox = null,
  // The D16 marker. Saved runs pass false and keep the old unjudged lane rule.
  legacyGate = true,
  earlierWork = { produced: false, unknown: false },
  extraSnapshotPaths = [],
  // Program v3 (gates-loops.js): this step's evidence is its loop's `until`
  // condition, so a failed check is recorded "checked, not passed" and the
  // attempt succeeds; a check that could not run still fails it.
  evidenceAsCondition = false,
  // `(event) => void` for each evidence item's started / running / finished.
  onEvidence = null,
  // The step runs in an isolated copy of its own (E5): the private-copy scope.
  privateWorkspace = false,
  // Counted retries (`retryOf.how` other-pool or same-pool) the step's current
  // definition already started, so a kernel resume never refunds the budget.
  retriesAlready = 0,
  // Refusal re-picks (`retryOf.how` refused) the step already made, so a
  // resume never resets the bound.
  refusalsAlready = 0,
  // step-route.js resolveRouteFilter: a hard filter on every pool list (D18).
  routeFilter = null,
  // Who pinned `strictPool` (D30): null reads `--worker-pool`.
  pinSource = null,
  // `[{pool, failureKind}]`, the pools the step's earlier attempts
  // failed on because of the pool (step-vocabulary.js poolCausedPools). The
  // first pick of this dispatch takes another pool when one can take the
  // step now.
  leavePools = null,
} = {}) {
  if (!action || typeof action.id !== 'string') throw new TypeError('action is required');
  if (typeof taskText !== 'string' || !taskText) throw new TypeError('taskText is required');
  if (!Array.isArray(pools)) throw new TypeError('pools must be an array');
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const watch = dependencies.watchOnce ?? watchOnce;
  const runEvidence = dependencies.runStepEvidence ?? runStepEvidence;
  const choosePool = dependencies.pickPool ?? pickPool;
  const execFile = dependencies.execFile ?? execFileSync;
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
  const backoff = dependencies.sleep ?? ((ms) => new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - started >= ms || shouldCancel?.()) {
        clearInterval(tick);
        resolve();
      }
    }, Math.min(250, Math.max(1, ms)));
  }));
  const callerSilenceOverride = silenceTimeoutSec !== null && silenceTimeoutSec !== undefined;
  const envSilenceOverride = Number.isFinite(Number(parentEnv?.BULLSWARM_WORKER_SILENCE_SEC))
    && Number(parentEnv.BULLSWARM_WORKER_SILENCE_SEC) > 0;
  const silenceOverride = callerSilenceOverride || envSilenceOverride;
  const configuredSilenceTimeoutSec = callerSilenceOverride
    ? silenceTimeoutSec
    : workerSilenceTimeoutSec(parentEnv);
  const effort = action.effort ?? DEFAULT_EFFORT_BY_LANE[action.lane] ?? 'medium';
  const failedProbes = new Set();
  // Credential groups a sign-in failure in THIS dispatch showed dead: no
  // later pick of this dispatch takes a pool in one, however many pool names
  // front it (the 2026-09-11 bug: a retry walked three names for one dead
  // credential). Nothing is stored; the next dispatch starts clean (state.js
  // S1) and learns of a dead credential only by trying it.
  const deadGroups = new Set();
  const inLiveGroup = (pool) => !deadGroups.size || !deadGroups.has(upstreamGroupOf(pool));
  // A pool the router calls "expiring but draining" (its pacing window closes
  // soon and this step would take it past the wall) is never given the step,
  // even when nothing else can take it; the router alone would pick it as a
  // last resort. The step goes to another pool, or to the caller when none
  // can take it, and the picture is read again at every pick. A pool the
  // caller named (the run's pin, or a route that allows only it) is exempt.
  // Map: pool name -> {until, forecast, elapsed}.
  const namedPool = strictPool ?? (routeFilter?.usePools?.length === 1 ? routeFilter.usePools[0] : null);
  const drainingAt = (poolList, at) => {
    const found = new Map();
    if (!poolList.length) return found;
    const viewed = attachForecast(poolList.map((pool) => ({ ...pool })), bullswarmDir, { now: at, decisionLog: coreDecisionLog() });
    for (const pool of viewed) {
      if (pool.name === namedPool) continue;
      const view = expiringSoonView(pool, { now: at, candidateMinutes: expected.expectedMinutes, inflightPenaltyPct });
      if (view.state !== 'draining') continue;
      const elapsed = Number(pool.elapsedPct);
      found.set(pool.name, { until: toMs(pool.paceResetsAt), forecast: view.forecast, elapsed: Number.isFinite(elapsed) ? elapsed : null });
    }
    return found;
  };
  // The draining pools the last prepare() kept out, for the pick's reason.
  let keptOffDraining = new Map();
  // The pools that can take work now, read live, less the draining ones.
  const prepare = (poolList) => {
    const at = now();
    const prepared = preparePools(poolList, action, effort, {
      preferredModel, strictPool, now: at, routeFilter,
    }).filter((pool) => !failedProbes.has(pool.name) && inLiveGroup(pool));
    keptOffDraining = drainingAt(prepared, at);
    return keptOffDraining.size ? prepared.filter((pool) => !keptOffDraining.has(pool.name)) : prepared;
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
  const spendDecisionLog = coreDecisionLog().filter((entry) => entry?.failureKind !== 'stalled');
  const expected = await expectedMinutesFromSpendModel(
    { lane: action.lane ?? 'chore', effort },
    { decisionLog: spendDecisionLog },
  );
  // The models a pool refused as not in its plan during this step, as
  // {pool, model}. Laid on every pool list the step picks from, a refreshed
  // one included (a refresher's cached list may predate the plan record), so
  // a refused model is never picked again on that pool in this step.
  const refusedModels = [];
  const withRefusedModels = (list) => (refusedModels.length ? list.map((candidate) => {
    const refused = refusedModels.filter((entry) => entry.pool === candidate.name);
    return refused.length ? {
      ...candidate,
      strategyPlanExcludedModels: [
        ...(Array.isArray(candidate.strategyPlanExcludedModels) ? candidate.strategyPlanExcludedModels : []),
        ...refused.map((entry) => ({ model: entry.model })),
      ],
    } : candidate;
  }) : list);
  // The unfiltered list, kept current across refreshes.
  let allPools = pools;
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])
    ?.strategyAssignments?.[effort] ?? null;
  const effectivePreferredPool = preferredPool ?? configuredAssignment?.pool ?? null;
  const attempts = [];
  let throttleRetries = 0;
  let nextTask = taskText;
  let last = null;
  const tried = new Set();
  let forceRefresh = false;
  let replayPool = null;
  let fallbackWhy = null;
  let lastPool = null;
  // The prior attempt's durable facts, carried into the next attempt's task as
  // a `## Prior attempt on this step` handoff block. Null on the first attempt.
  const resumedHandoff = resumeHandoff ?? (resumeAttempt ? durableHandoff(resumeAttempt, runDir, formatHandoff) : null);
  const resumedSuffix = resumedHandoff ? `\n\n${resumedHandoff.block}` : '';
  const baseTaskText = resumedSuffix && taskText.endsWith(resumedSuffix)
    ? taskText.slice(0, -resumedSuffix.length)
    : taskText;
  let priorHandoff = resumedHandoff ? { from: resumedHandoff.from, bytes: resumedHandoff.bytes } : null;
  if (resumedHandoff && !nextTask.includes(resumedHandoff.block)) nextTask = `${nextTask}\n\n${resumedHandoff.block}`;
  // Step baseline (D19): HEAD and path stats once, at the first attempt.
  // `stepChanged` is the union the gate judges. Each attempt still records
  // its own diff.
  const declaredForSnapshot = declaredDeliverable(action);
  const snapshotExtras = uniquePaths([
    ...(declaredForSnapshot?.paths ?? []),
    ...(Array.isArray(extraSnapshotPaths) ? extraSnapshotPaths : []),
  ]);
  const territoryOptions = { directWhenUngit: declaredForSnapshot != null, walkWhenUngit: isV3Step(action) };
  const stepEarlier = {
    produced: earlierWork?.produced === true,
    unknown: earlierWork?.unknown === true,
  };
  let stepHeadBefore = null;
  let baselinePaths = [];
  let stepPathsBefore = new Map();
  const stepChanged = new Set();
  let stepBaselineReady = false;
  // Evidence (E14): the checks and the schema hashes at the step baseline
  // (E26). A failed check is a gate failure: the rule below decides its retry.
  const evidenceItems = declaredEvidence(action);
  let schemaBaseline = null;
  // Paths the checks left changed in a private copy that could not be put
  // back (E11): the ownership gate reads them as check by-products, not as
  // the worker's edits.
  const checkByProducts = new Set();
  // The one rule (§2.1). The budget is the step's, not this call's: it
  // starts from the counted retries already stored and is spent when a
  // counted retry STARTS. `pendingRetry` ({attempt, pool, how}) is the retry
  // decided after a failure; the next attempt's record carries it as
  // `retryOf`, and the failed attempt never does. `leftAfterProcessFailure`
  // are pools the step left after a process-class failure (a crash, a stall,
  // a provider error, a sign-in failure and that credential's siblings): a
  // retry never goes back to them. `gatePin` is a gate retry's pool until an
  // attempt starts: the pick is forced onto it whenever it can take work (D5,
  // decided at the pick that starts the retry); `gateBlocked` is set when the
  // router refused it. A step never waits for a pool: a usage limit, or no
  // capable pool free now, sends it to the caller (owner decision,
  // 2026-09-25); only a transient rate limit backs off, on the same pool and
  // only while that pool can take the step. `backoffBlocked` names the pool
  // whose backoff could not be taken or replayed; `namedReturn` is when a
  // provider said to try again after a wait too long to sit out.
  const retryBudget = Math.max(0, (Number(maxMechanicalRetries) || 0) - (Number(retriesAlready) || 0));
  let retriesStarted = 0;
  // Refusal re-picks the step already made, counted from its stored attempts.
  let refusalRepicks = Math.max(0, Number(refusalsAlready) || 0);
  let pendingRetry = null;
  let promisedRecord = null;
  const leftAfterProcessFailure = new Set();
  let gatePin = null;
  let gateBlocked = false;
  let backoffBlocked = null;
  let namedReturn = null;
  let leaveFirst = Array.isArray(leavePools) && leavePools.length
    ? new Map(leavePools.map((entry) => [entry.pool, entry.failureKind ?? null]))
    : null;

  for (;;) {
    if (shouldCancel?.()) return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts, verdict: last };
    const replay = replayPool;
    replayPool = null;
    // This pick replays a transient rate limit's backoff.
    const backoffReplay = replay != null && pendingRetry?.how === 'wait';
    // Meters move while an action is in flight. Re-read them
    // before every pick so a pool that just hit its limit — here or in another
    // run — is no longer a candidate.
    if (typeof refreshPools === 'function') {
      let refreshed = null;
      try { refreshed = await refreshPools({ force: forceRefresh }); }
      catch { refreshed = null; }
      forceRefresh = false;
      if (Array.isArray(refreshed) && refreshed.length) allPools = withRefusedModels(refreshed);
    }
    // The pick's pool list, rebuilt from the live picture every time
    // (prepare() re-reads the meters). A gate retry is forced onto its
    // pool whenever that pool can take work at this pick, and otherwise this
    // pick falls back to the untried eligible pools; the pin stays until an
    // attempt starts. A backoff replays its own pool only: when that pool can
    // no longer take the step (a window at its limit, or draining)
    // the step goes to the caller, never to another pool.
    const candidates = prepare(allPools);
    const remaining = [];
    const replayed = replay ? candidates.find((candidate) => candidate.name === replay.name) : null;
    if (backoffReplay && !replayed) {
      backoffBlocked = replay.name;
      break;
    }
    if (replayed) remaining.push(replayed);
    for (const candidate of backoffReplay ? [] : candidates) {
      if (candidate.name !== replayed?.name && !tried.has(candidate.name)) remaining.push(candidate);
    }
    const pinned = gatePin && !gateBlocked
      ? candidates.find((candidate) => candidate.name === gatePin)
      : null;
    const gatePick = pinned ? pinned.name : null;
    // A rerun after a failure the pool caused starts elsewhere when it can;
    // the same pool is used only when nothing else can take the step now.
    const left = leaveFirst && !pinned && remaining.some((candidate) => !leaveFirst.has(candidate.name))
      ? remaining.filter((candidate) => leaveFirst.has(candidate.name)).map((candidate) => candidate.name)
      : [];
    if (left.length) {
      for (let i = remaining.length - 1; i >= 0; i -= 1) if (leaveFirst.has(remaining[i].name)) remaining.splice(i, 1);
      const note = `moved off ${left.map((name) => `${name} (${leaveFirst.get(name) ?? 'pool'})`).join(', ')}: `
        + `${left.length === 1 ? 'an earlier attempt' : 'earlier attempts'} failed there on the pool`;
      if (!fallbackWhy?.includes(note)) fallbackWhy = fallbackWhy ? `${note} · ${fallbackWhy}` : note;
    }
    const routePools = pinned ? [pinned] : remaining;
    // Nothing can take the step now: it goes to the caller with each capable
    // pool's reason and return time (the failure below), never a wait.
    if (!routePools.length) break;
    const pickStrictPool = gatePick ?? strictPool;
    const pickAt = now();
    const routingPools = routePools.filter((candidate) => !failedProbes.has(candidate.name));
    // The ledger is re-read HERE, before every pick and every retry, not on
    // the refresher's 15s throttle: up to four kernel actions start within
    // milliseconds of each other, and each has to see the assignments the
    // others just registered. Cheap by construction — a directory read, no
    // meter poll and no network.
    attachForecast(routingPools, bullswarmDir, { now: pickAt, decisionLog: coreDecisionLog() });
    const route = choosePool(action.lane ?? 'chore', routingPools, {
      preferredPool: effectivePreferredPool,
      // `routingPools` is already filtered to the pin; the router needs the
      // name so routeWhy says the pick was pinned, not compared.
      strictPool: pickStrictPool,
      effortTier: effort,
      now: pickAt,
      candidateMinutes: expected.expectedMinutes,
      inflightPenaltyPct,
      evidence,
      pinSource: gatePick ? GATE_RETRY_PIN_SOURCE : pinSource,
      routeNote: routeFilter?.summary || null,
    });
    if (route.pick && keptOffDraining.size) {
      // The router never saw the pools kept off above; say so in its words.
      const kept = [...keptOffDraining].map(([name, view]) => `${name} ${Number(view.forecast).toFixed(1)}%${
        view.elapsed != null ? ` (${view.elapsed.toFixed(1)}% elapsed)` : ''}`).join(', ');
      route.why = `${route.why} · expiring but draining (forecast >= ${PACING_FORECAST_BLOCK_PCT}% and past its clock), kept off: ${kept}`;
    }
    // The router refused the gate retry's pool (off its lane, or its live
    // meter is at its limit): the retry falls back to the other untried pools
    // at the next pick.
    if (!route.pick && gatePick) {
      gateBlocked = true;
      continue;
    }
    if (!route.pick) {
      // The router refused a backoff's own pool (off the lane, or a live
      // window at its limit): the caller, as above.
      if (backoffReplay) backoffBlocked = replay.name;
      break;
    }
    const pool = route.pick.connector;
    lastPool = pool;
    const connector = pool.connector ?? pool;
    const model = selectedModel(pool, effort, preferredModel);
    const probe = dependencies.probeFreeModel ?? probeFreeModel;
    // A caller-supplied watchOnce is the dispatcher's worker-test seam. It is
    // not the provider CLI that a liveness probe must exercise, so leave
    // probes disabled for those legacy harnesses unless they explicitly
    // inject a probe function of their own.
    const probeEnabled = !dependencies.watchOnce || typeof dependencies.probeFreeModel === 'function';
    if (probeEnabled && shouldProbeFreeModel(pool, model)) {
      const liveness = await probe({
        pool,
        model,
        home: bullswarmDir,
        timeoutMs: 30_000,
        now: pickAt,
      });
      if (!liveness.ok) {
        const reason = `probe: ${liveness.reason}`;
        failedProbes.add(pool.name);
        tried.add(pool.name);
        // A backoff never moves to another pool: its step goes to the caller.
        if (backoffReplay) {
          backoffBlocked = pool.name;
          break;
        }
        // A gate retry's pool that fails its probe cannot take work: this
        // step never picks it again, so the retry moves.
        fallbackWhy = fallbackWhy
          ? `${fallbackWhy} · ${reason} on ${pool.name}`
          : `${reason} on ${pool.name}`;
        last = { ok: false, why: reason, failureKind: 'provider', meta: { exitCode: null } };
        continue;
      }
    }
    const ordinal = attempts.length + 1;
    const files = withAttemptArtifacts(attemptPaths(paths, ordinal));
    const territory = territoryFiles(targetDir, action.ownedFiles, execFile, snapshotExtras, territoryOptions);
    const beforeAttempt = hashTerritory(targetDir, territory);
    // A workspace git cannot see (D21) has no HEAD of its own; a commit in
    // the repository that ignores it is not this step's work.
    const seesHead = territory.git !== false;
    const headAtStart = seesHead ? headCommit(targetDir, execFile) : null;
    let headAfter = headAtStart;
    if (!stepBaselineReady) {
      stepHeadBefore = headAtStart;
      baselinePaths = gateBaselinePaths(action, territory.git === true);
      stepPathsBefore = statDeliverablePaths(targetDir, baselinePaths);
      // E26: a schema file that changes after this point is recorded as a fact.
      schemaBaseline = evidenceItems.length ? evidenceSchemaBaseline(evidenceItems, targetDir) : null;
      stepBaselineReady = true;
    }
    const incomingHandoff = priorHandoff;
    priorHandoff = null;
    const session = sessionFor(connector, pool, model, currentSession, now(), uuid);
    const coreState = loadCoreState(bullswarmDir);
    assertDepthAllowed(coreState, parentEnv);
    const attemptSilenceSec = attemptSilenceTimeoutSec(
      pool,
      effort,
      coreState?.decisionLog ?? coreDecisionLog(),
      configuredSilenceTimeoutSec,
      silenceOverride,
    );
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
    // A gate retry that starts on another pool says so (D5): the move is a
    // fact of the pick that starts it, not of an earlier look.
    const gateMoved = gatePin && pool.name !== gatePin
      ? `gate retry moved: ${gatePin} cannot take work now`
      : null;
    const routeWhy = [gateMoved, fallbackWhy, route.why].filter(Boolean).join(' · ');
    fallbackWhy = null;
    // The box paragraph closes this attempt's task, after any handoff or
    // correction block, and never enters `nextTask`: the next attempt gets a
    // paragraph with its own clock instead of two. A guide only — nothing
    // below reads it to stop, time out or reroute the attempt.
    const box = typeof timeBox === 'function' ? timeBox({ pool: pool.name, startedAt }) : null;
    const answerText = typeof answerBrief === 'function' ? answerBrief({ files, ordinal }) : null;
    const briefed = answerText ? `${nextTask}\n\n${answerText}` : nextTask;
    const attemptTask = box?.text ? `${briefed}\n\n${box.text}` : briefed;
    // D3: the retry becomes a fact only when its attempt starts. A counted
    // retry is `same-pool` when it landed where the failure happened (a
    // planned same-pool retry that fell back reads `other-pool`).
    const retryOf = pendingRetry
      ? {
        attempt: pendingRetry.attempt,
        how: pendingRetry.how === 'wait' || pendingRetry.how === 'refused'
          ? pendingRetry.how
          : pool.name === pendingRetry.pool ? 'same-pool' : 'other-pool',
      }
      : null;
    const record = {
      ordinal, pool: pool.name, model: model ?? connector.model ?? null,
      routeWhy,
      routeCandidates: route.candidates.map((candidate) => ({
        pool: candidate.pool,
        effectiveSurplus: candidate.effectiveSurplus,
        urgencyState: candidate.urgencyState,
        forecastPacingPct: candidate.forecastPacingPct,
      })),
      startedAt, finishedAt: null, status: 'running', taskFile: files.taskFile,
      outFile: files.outFile, outputFile: files.outFile, reasoning,
      ...(incomingHandoff ? { handoff: { from: incomingHandoff.from, bytes: incomingHandoff.bytes } } : {}),
      ...(retryOf ? { retryOf } : {}),
      ...(box?.record ? { timeBox: clone(box.record) } : {}),
      routing: {
        reason: routeWhy, candidates: route.candidates, effort,
        lane: action.lane ?? 'chore', fiveHourUsedPct: pool.fiveHourUsedPct ?? null,
        // What this attempt was routed on: the pool's load and where its 5h
        // window is projected to land once this assignment has run.
        forecast: forecastRecord(route, pool.name),
      },
      ...(session ? { session: clone(session.durable), continued: session.invocation.resume } : {}),
    };
    attempts.push(record);
    tried.add(pool.name);
    if (retryOf && retryOf.how !== 'wait' && retryOf.how !== 'refused') retriesStarted += 1;
    pendingRetry = null;
    promisedRecord = null;
    gatePin = null;
    leaveFirst = null;
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
    let snapshot = { ok: false, statText: '', changedFiles: [] };
    let deliverableFact = null;
    try {
      verdict = await watch(runtimeConnector, attemptTask, targetDir, files, {
        env: childDepthEnv(parentEnv),
        model,
        reasoning,
        conversation: session?.invocation ?? null,
        shouldCancel,
        silenceTimeoutSec: attemptSilenceSec,
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
        poolName: pool.name,
        // A spent usage window is `quota`, even with no reset named.
        usageLimitsToCaller: true,
        runId: runId ?? runIdFromPaths(files),
        attemptId: `${action.id}-${ordinal}`,
        startedAt,
        subscription: pool.subscription ?? connector.subscription ?? null,
        attempts: (Array.isArray(ledgerAttempts) ? ledgerAttempts : [])
          .filter((attempt) => attempt?.id !== `${action.id}-${ordinal}`
            && (!attempt?.pool || attempt.pool === pool.name)),
        onCapture: (capture, usage) => {
          record.capture = clone(capture);
          onAttempt?.('captured', clone({ ...record, ...(usage ? { usage } : {}) }));
        },
      });
      // Capture before releasing the in-flight ledger entry or invoking the
      // worker-exit callback. Either can let a sibling begin editing this
      // territory, which must not be attributed to the attempt that ended.
      snapshot = captureDiffSnapshot(targetDir, action.ownedFiles, beforeAttempt, execFile, snapshotExtras, territoryOptions);
      headAfter = seesHead ? headCommit(targetDir, execFile) : null;
    } finally {
      if (ledgerEntry) withLedger(() => releaseAssignment(bullswarmDir, ledgerEntry.id));
      if (workerPid) onWorkerExit?.(workerPid);
    }
    // The worker's end (E17): spend, time boxes and phase minutes read the
    // attempt window, and the checks below must not inflate it.
    const workerFinishedAt = new Date(now()).toISOString();
    if (snapshot.ok) {
      for (const file of snapshot.changedFiles) stepChanged.add(file);
    }
    // The saved file is the attribution record; later sibling edits are not
    // replayed into it. Written before the gate and the checks (E4), so a
    // kernel that dies mid-check still leaves it for the durable handoff.
    if (snapshot.ok) writeFileIfChanged(files.diffFile, snapshot.statText ? `${snapshot.statText}\n` : '');
    const outputBytes = fileBytes(files.outFile);
    const pathsAfter = statDeliverablePaths(targetDir, baselinePaths);
    // E30: on a step that declares evidence, a verdict whose only failure is
    // the text heuristic does not skip the checks; the facts decide.
    const textVerdictWhy = evidenceItems.length && failureKindOf(verdict, pool) === 'semantic'
      ? String(verdict?.why ?? 'no reason recorded')
      : null;
    const gateVerdict = textVerdictWhy != null ? { ...verdict, ok: true } : verdict;
    const judged = deliverableVerdict({
      action,
      verdict: gateVerdict,
      legacyGate,
      snapshotOk: snapshot.ok,
      changed: [...stepChanged].sort(),
      headBefore: stepHeadBefore,
      headAfter,
      pathsBefore: stepPathsBefore,
      pathsAfter,
      outputBytes,
      earlierWork: stepEarlier,
    });
    if (gateVerdict?.ok && judged.failWhy) {
      verdict = { ...verdict, ok: false, why: judged.failWhy, failureKind: 'not-produced' };
    }
    deliverableFact = judged.fact;
    // Evidence (E4, E15): only when the verdict is still (provisionally) ok.
    // A stop that arrived as the worker finished records every item as
    // stopped instead of letting the step succeed with its checks unrun.
    let evidenceRun = null;
    if (evidenceItems.length && gateVerdict?.ok && !judged.failWhy) {
      const realTarget = (() => { try { return realpathSync(targetDir); } catch { return targetDir; } })();
      const owned = Array.isArray(action.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
      const lane = action.lane ?? 'chore';
      const mode = privateWorkspace
        ? 'private'
        : owned.length
          ? 'restricted'
          : (lane === 'build' || lane === 'chore') && trackedFiles(realTarget, execFile) != null
            ? 'unrestricted'
            : 'other';
      const taskDir = dirname(files.taskFile);
      evidenceRun = await runEvidence(evidenceItems, {
        cwd: realTarget,
        env: evidenceEnv(parentEnv, { cwd: realTarget, stepId: action.id, outFile: files.outFile, runDir: taskDir }),
        outFile: files.outFile,
        logFileFor: (k) => evidenceLogFile(files.taskFile, action.id, ordinal, k),
        scope: evidenceScope({
          mode,
          cwd: realTarget,
          ownedFiles: owned,
          declaredPaths: declaredDeliverable(action)?.paths ?? [],
          extraPaths: uniquePaths(Array.isArray(extraSnapshotPaths) ? extraSnapshotPaths : []),
          outFile: files.outFile,
          execFile,
        }),
        schemaBaseline,
        // The kernel's own registry, not the ledger wrapper: a kernel stop
        // must reach a running check's process group.
        onSpawn,
        onWorkerExit,
        shouldCancel: () => Boolean(shouldCancel?.()),
        onEvidence: onEvidence ? (event) => onEvidence({ actionId: action.id, ...event }) : null,
        now,
      });
      // What the checks created outside a private copy's scope never reaches
      // the ownership gate or the merge-back, and a pre-existing untracked
      // file they rewrote or deleted is put back (E11). The step is alone in
      // its copy, so neither can undo a sibling's work.
      let leftover = [];
      if (mode === 'private') {
        const removal = evidenceRun.createdOutOfScope?.length
          ? removeCreatedOutOfScope(realTarget, evidenceRun.createdOutOfScope)
          : null;
        const restoral = evidenceRun.changedOutOfScope?.length
          ? restoreChangedOutOfScope(realTarget, evidenceRun)
          : null;
        leftover = uniquePaths([...(removal?.unremoved ?? []), ...(restoral?.unrestored ?? [])]).sort();
        for (const path of leftover) checkByProducts.add(path);
      }
      const results = clone(evidenceRun.results ?? []);
      const note = textVerdictWhy != null
        ? {
          at: new Date(now()).toISOString(),
          kind: 'text-verdict',
          text: evidenceRun.failed
            ? `the output read as failed (${textVerdictWhy}); the evidence ran anyway, and an item failed`
            : `the output read as failed (${textVerdictWhy}); every evidence item passed`,
        }
        : null;
      if (evidenceRun.stopped) {
        verdict = { ...verdict, ok: false, cancelled: true, why: 'evidence stopped', evidenceResults: results };
      } else if (evidenceRun.failed && evidenceAsCondition && !evidenceRun.checkFault) {
        const why = `checked, not passed: ${evidenceRun.why ?? evidenceFailureWhy(results)}`;
        verdict = {
          ...verdict, ok: true, why, evidenceResults: results,
          notes: [...(Array.isArray(verdict.notes) ? verdict.notes : []), { at: new Date(now()).toISOString(), kind: 'checked-not-passed', text: why }],
        };
      } else if (evidenceRun.failed) {
        verdict = {
          ...verdict, ok: false, failureKind: 'failed-evidence',
          why: evidenceRun.why ?? evidenceFailureWhy(results), evidenceResults: results,
        };
      } else {
        // A text-only failure the checks overruled keeps its reason in the
        // note, not as the why of a succeeded attempt.
        verdict = {
          ...verdict, ok: true, evidenceResults: results,
          ...(textVerdictWhy != null ? { why: 'every evidence item passed' } : {}),
        };
      }
      // The note says the facts outranked the text; it stays on a failure too.
      if (note && !evidenceRun.stopped) {
        verdict.notes = [...(Array.isArray(verdict.notes) ? verdict.notes : []), note];
      }
      if (leftover.length) {
        verdict.notes = [...(Array.isArray(verdict.notes) ? verdict.notes : []), {
          at: new Date(now()).toISOString(),
          kind: 'check-by-product',
          text: `check by-product not restored: ${leftover.join(', ')}`,
        }];
      }
    }
    const evidenceResults = evidenceRun ? verdict.evidenceResults : null;
    const streamFile = verdict?.meta?.streamFile
      ?? (files.streamFile && existsSync(files.streamFile) ? files.streamFile : null)
      ?? (files.stdoutFile && existsSync(files.stdoutFile) ? files.stdoutFile : null);
    const lastEvents = lastResponseEvents(streamFile);
    const finishedAt = workerFinishedAt;
    const kind = failureKindOf(verdict, pool);
    // D5: failed checks are a gate failure and take the rule below; an act
    // step's failed checks still say why they go to the caller.
    if (kind === 'failed-evidence' && roleOf(action) === 'act' && !evidenceRun?.checkFault) {
      const suffix = ' · act steps are not retried';
      verdict = { ...verdict, why: evidenceFailureWhy(evidenceResults, { suffix }) ?? `${verdict.why ?? 'failed evidence'}${suffix}` };
    }
    // One dead upstream credential is ONE outage however many pool names front
    // it: the next attempt of THIS action must not walk from one pool name to
    // the next sibling on the same credential into the same failure, as it
    // did on 2026-09-11. prepare() keeps the group out of every later pick of
    // this dispatch, a refresh included (`deadGroups`).
    const deadGroup = kind === 'auth' ? upstreamGroupOf(pool) : null;
    if (deadGroup) deadGroups.add(deadGroup);
    // A refusal at start: the provider refused the sign-in or the model before
    // the worker changed a file or made a tool call. It did no work, so the
    // pick is made again at once with the new fact applied, and the step's
    // one retry stays for a real failure. Only for an analyze, build or
    // chore step with a retry: never an act step (D32) or an outward one,
    // and never when the stream cannot be read (no proof of no work).
    const refusalAtStart = !verdict.ok && REFUSAL_KINDS.has(kind)
      && Number(maxMechanicalRetries) > 0
      && REFUSAL_LANES.has(action.lane ?? 'chore')
      && roleOf(action) !== 'act'
      && deliverableTypeOf(action.deliverable) !== 'outward'
      && snapshot.ok && snapshot.changedFiles.length === 0
      && streamShowsWork(streamFile, pool.name) === false;
    const refusedAtStart = refusalAtStart && refusalRepicks < MAX_REFUSAL_REPICKS;
    if (!verdict.ok && kind === 'model-not-in-plan') {
      // The plan record (watch.js) excludes the model for later dispatches;
      // the step lays it on every list it picks from, so the same pool may
      // run another model of the tier but never this one again.
      const refusedModel = verdict.planModel ?? record.model;
      if (refusedModel) {
        refusedModels.push({ pool: pool.name, model: refusedModel });
        allPools = withRefusedModels(allPools);
      }
    }
    // The pools that can take work now, read live once for what follows this
    // failure.
    let liveNow = null;
    const pickableLive = () => (liveNow ??= prepare(allPools));
    // One decision for a rate limit. A wait the provider named that is too
    // long to sit out is never slept: the caller is told when to try again. A
    // transient one backs off on the same pool, never counted, only while that
    // pool can still take the work; otherwise the caller, with that pool's
    // reason. A usage limit is never retried, moved or waited out: the caller
    // decides (owner decision, 2026-09-25). An act step whose worker started
    // is not backed off either (D32).
    let limitsBackoffNow = false;
    if (!verdict.ok && kind !== 'cancelled') {
      namedReturn = longThrottleReturn(kind, verdict, toMs(workerFinishedAt) ?? now());
      backoffBlocked = null;
      const actStarted = roleOf(action) === 'act' && !workerNeverStarted(verdict);
      if (kind === 'throttle' && namedReturn == null && throttleRetries < MAX_THROTTLE_RETRIES && !actStarted) {
        if (!leftAfterProcessFailure.has(pool.name) && pickableLive().some((candidate) => candidate.name === pool.name)) {
          limitsBackoffNow = true;
        } else {
          backoffBlocked = pool.name;
        }
      }
    }
    // §2.1: what follows this failure, decided before the record is built so
    // the stored attempt never promises a retry that does not happen. Null
    // sends the step to the caller (D10).
    let next = null;
    // The `outside:` items of a failed gate attempt's report, when they
    // cancelled its retry.
    let blockers = [];
    // F23: a transient rate limit's short backoff on the same pool records
    // `quotaNext: 'wait'` on the attempt. A usage limit records none: it goes
    // to the caller.
    let quotaNext = null;
    if (!verdict.ok && kind !== 'cancelled') {
      const failureClass = failureClassOf(kind);
      const hasBudget = retriesStarted < retryBudget;
      if (deadGroup) {
        for (const candidate of allPools) {
          if (candidate.name !== pool.name && upstreamGroupOf(candidate) === deadGroup) {
            leftAfterProcessFailure.add(candidate.name);
            tried.add(candidate.name);
          }
        }
      }
      // The pools the next pick could take now (§2.1): the live untried
      // candidates, plus the pool that just failed unless the step left it
      // after a process failure. `others`, the sole-candidate rule and the
      // backoff read the same set (D2, D4).
      const pickableNow = pickableLive().filter((candidate) => (candidate.name === pool.name
        ? !leftAfterProcessFailure.has(candidate.name)
        : !tried.has(candidate.name)));
      const others = pickableNow.filter((candidate) => candidate.name !== pool.name);
      const soleCandidate = pickableNow.length === 1 && pickableNow[0].name === pool.name;
      // A refusal at start picks again among the pools free now: for a dead
      // sign-in, outside its credential group; for a model the plan does not
      // include, the same pool too (with another model of the tier).
      const refusalPicks = refusedAtStart
        ? pickableLive().filter((candidate) => (candidate.name === pool.name
          ? kind === 'model-not-in-plan'
          : !tried.has(candidate.name) && !leftAfterProcessFailure.has(candidate.name)))
        : [];
      if (refusalPicks.length) {
        next = { how: 'refused' };
      } else if (refusalAtStart && !refusedAtStart) {
        // Out of refusal re-picks: the caller, with each refused try listed.
        next = null;
      } else if (roleOf(action) === 'act' && !workerNeverStarted(verdict)) {
        // D32: once its worker started, an act step may have acted.
        next = null;
      } else if (kind === 'failed-evidence' && evidenceRun?.checkFault) {
        // E19: the worker cannot fix a check that could not run.
        next = null;
      } else if (hasBudget && OUTSIDE_SKIPS_RETRY.has(kind) && (blockers = readOutsideBlockers(files.outFile)).length) {
        // The worker's own report names a blocker outside what the step may
        // change: the same-pool retry could not fix it, so the step goes to
        // the caller now. It still fails; the report only cancels the retry.
        next = null;
        const suffix = ` · retry skipped: the worker reported a blocker outside this step: ${cutChars(blockers[0], OUTSIDE_WHY_CHARS)}`;
        verdict = {
          ...verdict,
          why: (kind === 'failed-evidence' ? evidenceFailureWhy(evidenceResults, { suffix }) : null)
            ?? `${verdict.why ?? kind}${suffix}`,
        };
      } else if (failureClass === 'process') {
        if (hasBudget && others.length) next = { how: 'other-pool' };
        // A plan without the model is never replayed on the same pool, like a
        // dead sign-in: the same model would be refused again.
        else if (kind === 'model-not-in-plan') next = null;
        else if (hasBudget && soleCandidate && kind !== 'auth') next = { how: 'same-pool', replay: true };
      } else if (failureClass === 'gate') {
        if (hasBudget && kind === 'schema') {
          if (typeof correctionTask === 'function') next = { how: 'same-pool', correction: true };
        } else if (hasBudget) {
          next = { how: 'same-pool', gate: true, fresh: kind === 'not-produced' };
        }
      } else if (limitsBackoffNow) {
        // The transient rate limit's backoff decided above.
        next = { how: 'wait', sameBackoff: true };
        quotaNext = 'wait';
      }
    }
    const willRecover = next != null;
    Object.assign(record, {
      finishedAt,
      // An attempt the dispatcher retries failed; `willRetry` says a retry
      // follows. It is recorded as failed (QA37: a retried check failure read
      // "interrupted"), unless a signal or a kernel stop cut it (kind
      // `interrupted`); older runs keep the "interrupted" label they were
      // written with. Nothing replays on the label: resume, handoff and retry
      // counting read willRetry, retryOf and failureKind, and treat failed
      // and interrupted alike.
      status: verdict.ok
        ? 'succeeded'
        : kind === 'cancelled'
          ? 'cancelled'
          : willRecover && kind === 'interrupted'
            ? 'interrupted'
            : 'failed',
      failureKind: kind,
      why: verdict.why ?? null,
      usage: clone(verdict.meta?.usage ?? null),
      wallSec: verdict.meta?.wallSec ?? null,
      willRetry: willRecover,
      ...(next?.how === 'refused' ? { refusedAtStart: true } : {}),
      ...(quotaNext ? { quotaNext } : {}),
      outputFile: files.outFile,
      ...(outputBytes != null ? { outputBytes } : {}),
      ...(deliverableFact ? { deliverable: deliverableFact } : {}),
      // Only when the checks ran (E15): absence is the exact fact.
      ...(evidenceResults ? { evidenceResults: clone(evidenceResults) } : {}),
      ...(streamFile ? { streamFile } : {}),
      // The path list itself (at most 200; the count stays complete): the
      // repair loop's carry-forward rule and the durable handoff read it.
      ...(snapshot.ok ? { diffFile: files.diffFile, changedFileCount: snapshot.changedFiles.length, changedFiles: snapshot.changedFiles.slice(0, 200) } : {}),
      lastResponse: lastEvents.at(-1)?.summary ?? null,
      ...(verdict.outputTruncated === true ? {
        outputTruncated: true,
        ...(verdict.outputSource ? { outputSource: verdict.outputSource } : {}),
      } : {}),
      ...(Array.isArray(verdict.notes) && verdict.notes.length ? { notes: clone(verdict.notes) } : {}),
      ...(!next && blockers.length ? { outsideBlockers: blockers } : {}),
      ...(kind === 'stalled'
        ? { stalled: true, partialOutput: files.outFile, silentSec: attemptSilenceSec }
        : {}),
    });
    // The provider's own session id (when its stream/transcript reports one)
    // is the durable lookup key. Conversation-capable connectors already have
    // a generated session record; update that record in place so reprice can
    // resolve the same provider session without guessing by time window.
    const measuredSessionId = verdict.meta?.usage?.sessionId ?? null;
    if (measuredSessionId && record.session) {
      record.session.sessionId = measuredSessionId;
    }
    // A schema-invalid answer still completed a real provider turn. Resume
    // that same physical conversation for the bounded correction instead of
    // opening a second session and losing the model's immediate context.
    // A failed check follows a finished worker turn too: its retry continues
    // that conversation with the check output attached.
    const sessionEstablished = verdict.ok || kind === 'schema' || kind === 'semantic' || kind === 'failed-evidence';
    if (session && sessionEstablished) {
      record.session.lastUsedAt = finishedAt;
      currentSession = clone(record.session);
    }
    last = verdict;
    appendDecision(bullswarmDir, {
      ts: finishedAt, lane: action.lane ?? 'chore', picked: pool.name,
      ok: verdict.ok, failureKind: verdict.ok ? null : kind, why: verdict.why ?? null,
      wallSec: verdict.meta?.wallSec ?? null, model: record.model,
      reasoning: clone(reasoning),
      usage: verdict.meta?.usage ?? null, routing: record.routing,
      forecast: record.routing.forecast,
      outFile: files.outFile, source: 'workflow-v2', actionId: action.id,
    }, { updateCoreState });
    onAttempt?.('finished', clone(record), verdict);
    if (verdict.ok) {
      return {
        ok: true, status: 'succeeded', attempts, verdict, session: currentSession,
        ...(checkByProducts.size ? { checkByProducts: [...checkByProducts].sort() } : {}),
      };
    }
    if (kind === 'cancelled') return { ok: false, status: 'cancelled', failureKind: kind, attempts, verdict };
    // D10: a failure that will not be retried goes to the caller; the
    // dispatcher never walks on to another pool by itself.
    if (!next) break;
    pendingRetry = { attempt: `${action.id}-${ordinal}`, pool: pool.name, how: next.how };
    promisedRecord = record;
    if (next.how === 'refused') {
      // The refused try did no work: the next pick gets the same task, no
      // handoff, and the step's retry budget is untouched.
      refusalRepicks += 1;
      if (kind === 'model-not-in-plan') tried.delete(pool.name);
      else leftAfterProcessFailure.add(pool.name);
      fallbackWhy = `picked again: ${pool.name} refused at start (${REFUSAL_TEXT[kind]})`;
      continue;
    }
    if (failureClassOf(kind) === 'process' && !next.replay) leftAfterProcessFailure.add(pool.name);
    if (next.correction) {
      // `schema`: today's same-conversation correction, now the step's one
      // retry, forced onto the same pool.
      nextTask = correctionTask(verdict, { originalTask: baseTaskText, attempt: ordinal });
      gatePin = pool.name;
      forceRefresh = true;
      continue;
    }
    const block = formatHandoff({
      pool: pool.name,
      model: record.model,
      startedAt,
      finishedAt,
      failureKind: kind,
      why: verdict.why ?? null,
      diffStatText: snapshot.statText,
      diffFile: snapshot.ok ? files.diffFile : null,
      changedFiles: snapshot.changedFiles,
      outputFile: files.outFile,
      partialOutput: kind === 'stalled' ? files.outFile : null,
      outputBytes,
      streamFile,
      hasEventStream: connector.eventStream != null,
      lastEvents,
      ...(evidenceResults ? { evidenceResults: clone(evidenceResults) } : {}),
      // §2.3: the gate retry's extra line.
      ...(next.gate ? { gate: true } : {}),
    });
    nextTask = `${baseTaskText}\n\n${block}`;
    priorHandoff = {
      from: `${action.id}-${ordinal}`,
      bytes: Buffer.byteLength(block, 'utf8'),
    };
    if (next.gate) {
      // D5: the same pool, forced, after a live look at whether it can
      // still take work. `not-produced` starts a fresh session (D7).
      gatePin = pool.name;
      forceRefresh = true;
      if (next.fresh) currentSession = null;
    } else if (next.replay) {
      replayPool = pool;
    } else if (next.sameBackoff) {
      throttleRetries += 1;
      replayPool = pool;
      await backoff(throttleBackoffMs(throttleRetries, { waitMs: verdict.throttleWaitMs }));
    } else if (kind === 'stalled') {
      fallbackWhy = `fallback from ${pool.name} after stall ${Math.round(attemptSilenceSec)}s`;
    }
  }

  // The step fails now rather than waiting for a pool: a run never sits open
  // on quota. The failure names each capable pool's reason (a usage limit, a
  // window at its limit, nearly spent, a process failure here) and when it is
  // back, takes a spent usage window as quota, and says why a promised retry
  // or a backoff did not happen.
  const lane = action.lane ?? 'chore';
  // A pool with a window at its limit is still capable: it comes back at
  // that window's reset, so the reason is the limit, never a missing tier
  // (§2.1). A pool off the step's lane is not capable there.
  const onLane = (pool) => (pool.lanes ?? LANES).includes(lane);
  const capable = preparePools(allPools, action, effort, {
    preferredModel, strictPool, now: now(), routeFilter, ignoreBurstGate: true,
  }).filter((pool) => !failedProbes.has(pool.name) && onLane(pool));
  const endAt = now();
  const lastKind = last ? failureKindOf(last, lastPool) : null;
  // The failed pool's own reset, when its usage window is spent and the
  // reset is known (quota.js Q6).
  const lastReset = lastKind === 'quota' && lastPool
    ? toMs(last.retryAfter) ?? toMs(last.usageLimit?.until)
    : null;
  const draining = drainingAt(capable, endAt);
  // Each capable pool that cannot take the step now, as {pool, text, limit
  // (a usage limit), back (when it is back)}: a
  // spent window (known reset or not), a metered window at its limit and a
  // nearly spent window keep the pool out, even when their return is unknown.
  const held = [];
  for (const pool of capable) {
    const parts = [];
    if (pool.name === lastPool?.name && lastKind === 'quota') {
      if (lastReset == null) parts.push(['out of quota', null, true]);
      else if (lastReset > endAt) parts.push(['out of quota', lastReset, true]);
    }
    const signIn = signInPart(pool);
    if (signIn) parts.push(signIn);
    const spent = spentWindowPart(pool, endAt);
    if (spent) parts.push(spent);
    if (draining.has(pool.name)) parts.push(drainingPart(draining.get(pool.name)));
    if (!parts.length) {
      // A pool the step left after a process failure cannot take its retry.
      if (leftAfterProcessFailure.has(pool.name)) held.push({ pool: pool.name, text: `${pool.name} already failed on this step`, limit: false, back: null });
      continue;
    }
    held.push(heldEntry(pool.name, parts));
  }
  // No capable pool can take the step now: the earliest known return among
  // them (a pool whose return is unknown is skipped).
  const known = held.map((entry) => entry.back).filter((ms) => ms != null);
  const comesBack = capable.length && held.length === capable.length && known.length ? Math.min(...known) : null;
  // The pool a backoff could not be taken or replayed on: its usage limit
  // makes the step's failure quota, and its return is when to try again.
  const blocked = backoffBlocked ? held.find((entry) => entry.pool === backoffBlocked) ?? null : null;
  const returnAt = lastReset ?? namedReturn ?? blocked?.back ?? comesBack;
  const retryAfter = returnAt == null ? null : new Date(returnAt).toISOString();
  // No attempt: a usage limit on every capable pool reads as quota.
  const failureKind = last ? (blocked?.limit ? 'quota' : lastKind) : noPoolFailureKind(capable.length, held);
  // A promised retry, or a backoff, that no pool could take keeps the
  // attempt's failure and says why nothing ran after it.
  let noRetry = null;
  if (last && (backoffBlocked || promisedRecord?.willRetry)) {
    const texts = held.map((entry) => entry.text);
    if (backoffBlocked && !blocked) texts.unshift(`${backoffBlocked} cannot take work now`);
    noRetry = ` · no retry: ${texts.length ? texts.join('; ') : 'no pool can take it now'}`;
  }
  // An attempt that promised a retry no pool could take is corrected (the
  // step goes to the caller); it adds no usage and settles nothing.
  if (promisedRecord?.willRetry) {
    Object.assign(promisedRecord, {
      status: 'failed', willRetry: false, ...(noRetry ? { why: `${promisedRecord.why ?? promisedRecord.failureKind}${noRetry}` } : {}),
    });
    onAttempt?.('corrected', clone(promisedRecord));
    promisedRecord = null;
  }
  const offTier = capable.length ? [] : tierOffReasons(allPools, action, effort, {
    preferredModel, strictPool, routeFilter, now: endAt,
  }, (pool) => !failedProbes.has(pool.name) && onLane(pool));
  let why = noPoolWhy({ capableCount: capable.length, held, failureKind, strictPool, lane, effort, offTier });
  // A step no pool took records what ruled each enabled pool out, so its
  // result says why without re-deriving the pick (QA37).
  const ruledOut = last ? null : noPoolCandidates(allPools, action, effort, {
    lane, strictPool, preferredModel, routeFilter, failedProbes, onLane, held, now: endAt, ignoreBurstGate: true,
  });
  if (!capable.length && routeFilter) {
    // §2.4: the route, not the tier or the pin, emptied the capable set.
    const unrouted = preparePools(allPools, action, effort, {
      preferredModel, strictPool, now: now(), ignoreBurstGate: true,
    }).filter((pool) => !failedProbes.has(pool.name) && onLane(pool));
    if (unrouted.length) {
      const withoutIndependence = { ...routeFilter, independentProviders: [] };
      const sharedProvider = (routeFilter.independentProviders ?? []).length > 0
        && unrouted.some((pool) => poolPassesRoute(pool, withoutIndependence));
      const independent = new Set(routeFilter.independentProviders ?? []);
      const others = (ruledOut ?? []).filter((entry) => !independent.has(entry.provider) && entry.inRoute && entry.onLane);
      why = routeUnavailableWhy(routeFilter, { lane, effort, sharedProvider, others, offTier });
    }
  }
  return {
    ok: false,
    status: 'failed',
    failureKind,
    // A return time for any failure: it is set only when trying again then
    // is the real next step.
    ...(retryAfter ? { retryAfter } : {}),
    attempts,
    verdict: last
      ? noRetry ? { ...last, why: `${last.why ?? lastKind}${noRetry}` } : last
      : { ok: false, why, meta: { exitCode: null } },
    ...(ruledOut ? { routeWhy: why, routeCandidates: ruledOut.map(({ pool, provider, excluded }) => ({ pool, provider, excluded })) } : {}),
  };
}

export { classifyFailure as classifyV2DispatchFailure, tierOffReasons as tierOffV2DispatchReasons, preparePools as prepareV2DispatchPools, selectedModel as selectedV2DispatchModel };
