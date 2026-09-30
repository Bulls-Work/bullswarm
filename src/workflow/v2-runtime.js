import { withV2Cancellation } from './v2-cancellation.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { appendEvent, readEvents } from './events.js';
import {
  commitV2Revision, exportV2Plan, pendingRevisionRequests, planV2Revision, rejectedRevisionRecord,
  removeStaleReceipts, revisionEventPayload, acceptedEventPayloads,
} from './v2-revision.js';
import { ACTION_PROGRAM_SCHEMA_VERSION } from './action-validator.js';
import {
  applyRevisionLoopBudget, closeRound, ensureVerifyLoop, failingRequirements, kernelRepairActionIds, nextLoopStep,
  openFirstRound, openNextRound, planRepairStep, planVerifyStep, recheckSet, repairChangedFiles, repairInheritedPaths,
} from './verify-rounds.js';
import { generateShortId, isProcessAlive, listRuns, newRunId, v2RunnerLiveness } from './short-id.js';
import { applyEvidence, invalidateRequirements } from './ledger.js';
import { captureWorkspaceManifest, checkOwnership } from './ownership.js';
import { scheduleV2Actions } from './v2-scheduler.js';
import {
  actionDefinition, actionState, assertV2Resume, createV2DurableState, deserializeV2DurableState,
  initializeNewActions, serializeV2DurableState, statePath, validateV2GoalDocument, writeRunState,
} from './v2-state.js';
import { V2_TERMINAL_STATUSES } from './status.js';
import { clone } from '../lib/clone.js';
import {
  applyV2PlannerResponse, buildPlannerPreflight, buildV2PlannerPrompt, createV2PlannerContext, readPlannerCandidate,
  plannerCorrectionRequest, validateV2PlannerResponse, V2PlannerValidationError,
} from './v2-planner.js';
import { extractScoutUnitIds, recordGoalProject, scoutPrompt } from './goal.js';
import { writeRunRollup } from './rollup.js';
import { EVIDENCE_CONTRACT_SCHEMA_VERSION, readEvidenceCandidate } from './evidence-output.js';
import {
  consolidateV2Gaps, createV2ResultEnvelope, deserializeV2ResultEnvelope, evaluateV2Progress, stepProof,
} from './v2-outcome.js';
import {
  appliedStepRestart, clearStepRestart, dispatchV2Action, durableAttemptHandoff, markStepRestartApplied,
  readStepRestarts, requeueRestartedStep,
} from './v2-dispatch.js';
import { countRetries, declaredEvidence, poolCausedPools, roleOf } from './step-vocabulary.js';
import { resolveRouteFilter, workAttempts } from './step-route.js';
import { modelFamilyOf } from '../lib/route.js';
import { rewriteEvidenceCwd } from './evidence-runner.js';
import { EVIDENCE_RUNNING_NOTE, evidenceRunning } from '../lib/stale.js';
import { STAGE3_RUN_FEATURES, isProgramV3Run, readRunFeatures, repairLoopApplies, runFeatureFlags, withProgramFormat, writeRunFeatures } from './run-features.js';
import { isProgramV3 } from './program-v3.js';
import { settleStepAnswer, stepAnswerHooks } from './answers.js';
import {
  continuePending, evidenceIsCondition, kernelControlPass, schedulerView, unblockControlNodes,
} from './gates-loops.js';
import { createPoolRefresher } from './pool-refresh.js';
import {
  createIsolatedWorkspace, disposeIsolatedWorkspace, integrateIsolatedWorkspace,
} from './v2-workspace.js';
import { presentationStageStatus, stageForAction } from './v2-presentation.js';
import { deliverSteering, peekSteering } from './steering.js';
import { enforcesOwnership, isProgramWorkflow, v2SchedulingOptions } from './execution-policy.js';
import { buildWorkspaceReport, captureWorkspaceStatus } from './workspace-report.js';
import { acquireKernelLease, processIdentity, liveWorker, stopWorker } from './v2-process.js';
import { reconcileRunState } from './reconcile.js';
import { spawnRetentionSweep } from '../lib/retention.js';
import { preferredUsage } from './usage-preference.js';
import { timeBoxForAttempt, timeBoxHistory } from './time-box.js';
import { addUsage, reconcileSubscriptionLedger } from './usage-ledger.js';
import {
  normalizeAttempt, evidenceOutcomePayload, receiptVerdict, recordReturnedEarly, recordAttemptCapture,
  settleFinishedAttempt,
} from './attempt-record.js';
import { handoffBlock } from './retry-handoff.js';
import { buildWorkTask, buildDigestTask, buildEvidenceTask, correctionTask } from './step-prompts.js';
import { embeddedRequirementBytes, attemptBytes, observeAttemptBytes } from './attempt-bytes.js';
import { actStoppedDuringChecksWhy, clearEvidenceRunning, reconcileResume } from './kernel-resume.js';
import { acceptCallerPlannerResponse } from './caller-planner.js';
import { clearRejectedRerunIntent } from './run-control.js';
import { earlierWorkFor } from './earlier-work.js';

const ACTIVE_RUNS = new Set();
const DEFAULTS = Object.freeze({
  concurrency: 4,
  workspaceMode: 'shared',
  maxAgents: 30,
  maxActions: 100,
  maxExpansionRounds: 2,
  maxMechanicalRetries: 1,
  maxManifestFiles: 50_000,
  plannerMode: 'dispatched',
});

function settings(state) { return { ...DEFAULTS, ...(state.config.settings ?? {}) }; }

// Marked runs: a Workflow Planner or preflight scout dispatch that ends on one
// of these goes to the caller; the dispatcher never moves it to another pool
// (usageLimitsToCaller, owner decision 2026-09-25).
const LIMIT_STOP_KINDS = new Set(['quota', 'throttle', 'unavailable']);

// A dispatch's return time as the durable stop record keeps it: the string
// the reason prints, or null when there is none to read.
function returnTimeOrNull(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

// The run's terminal reason when its planner or scout stopped on a usage
// limit, or found no pool free, in a marked run. `who` names the dispatch
// ("the workflow planner", "the preflight scout"). Each command named works
// on the finished run: `workflow resume` runs the stopped planner turn or
// scout again (reopenV2RunForRetry reads the kernel's limitStop record), which
// is the caller's "wait" when it runs after the pool is back; plan revise
// takes the caller's program and runs it instead.
function limitStopReason(who, { failureKind, retryAfter = null, why = null } = {}, token) {
  const unavailable = failureKind === 'unavailable';
  // The dispatcher's own "no pool free: …" lead is not said twice.
  const detail = unavailable ? String(why ?? failureKind).replace(/^no pool free: /, '') : (why ?? failureKind);
  return `${who} ${unavailable ? 'stopped: no pool free' : 'stopped on a usage limit'}: ${detail}`
    + (retryAfter ? ` · back at ${retryAfter}` : '')
    + ` · your call: ${retryAfter ? `resume after ${retryAfter} with bullswarm workflow resume ${token}` : `bullswarm workflow resume ${token} once a pool is free`}`
    + `, plan it yourself with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`;
}

function goalPath(runDir) { return join(runDir, 'goal.json'); }

// Declared deliverable paths a kernel repair inherits from the steps it fixes (D20c).
function extraSnapshotPathsFor(state, actionId) {
  if (!kernelRepairActionIds(state).includes(actionId)) return [];
  return repairInheritedPaths(state, actionId);
}

function nextShortId(bullswarmDir) {
  return generateShortId({ existing: listRuns(bullswarmDir).map((run) => run.shortId).filter(Boolean) });
}

async function runV2Kernel({
  bullswarmDir,
  goalDocument = null,
  pools = [],
  runId = null,
  resumeRunId = null,
  scout = null,
  initialPlannerResponse = null,
  parentEnv = process.env,
  onEvent = null,
  dependencies = {},
  lease,
} = {}) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const dispatch = dependencies.dispatchV2Action ?? dispatchV2Action;
  // Meters move while a run is in flight. Every dispatch site
  // re-reads them through this refresher instead of the list captured at
  // launch, and the dispatch loop gets the same function so it can re-read
  // between its own retries.
  const refreshPools = dependencies.refreshPools
    ?? createPoolRefresher({ bullswarmDir, initialPools: pools });
  const syncPools = async (opts) => {
    try {
      const next = await refreshPools(opts);
      if (Array.isArray(next)) pools = next;
    } catch {
      // A stale pool list still dispatches; a refresh failure must never end
      // the run.
    }
    return pools;
  };
  const captureManifest = dependencies.captureWorkspaceManifest ?? captureWorkspaceManifest;
  const writeResultAtomic = dependencies.writeResultAtomic ?? writeJsonAtomic;
  const writeCompletionReceipt = dependencies.writeCompletionReceipt ?? writeJsonAtomic;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const reconcileCurrentRun = dependencies.reconcileCurrentRun ?? reconcileRunState;
  // The soft time box reads this home's recorded attempts; tests pin both the
  // history and the zone the paragraph's clock is written in.
  const readTimeBoxHistory = dependencies.timeBoxHistory ?? timeBoxHistory;
  const timeBoxTimeZone = dependencies.timeBoxTimeZone ?? null;
  const runsRoot = join(bullswarmDir, 'workflows');
  mkdirSync(runsRoot, { recursive: true });
  const resuming = Boolean(resumeRunId);
  const id = resumeRunId ?? runId ?? newRunId();
  if (!/^wf-[a-z0-9]+-[a-f0-9]{6}$/.test(id)) throw new TypeError(`invalid V2 runId "${id}"`);
  const runDir = join(runsRoot, id);
  if (ACTIVE_RUNS.has(runDir)) throw new Error(`run ${id} already has an active kernel`);
  mkdirSync(runDir, { recursive: true });

  let state;
  let actStepsToCaller = [];
  if (resuming) {
    if (!existsSync(goalPath(runDir)) || !existsSync(statePath(runDir))) throw new Error('unsupported old autonomous run: V2 goal.json and state.json are required');
    const durableGoal = JSON.parse(readFileSync(goalPath(runDir), 'utf8'));
    state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
    assertV2Resume(durableGoal, state, { runId: id });
    goalDocument = durableGoal;
    const durableResultPath = state.lifecycle.resultFile ?? join(runDir, 'result.json');
    if (existsSync(durableResultPath)) {
      const published = deserializeV2ResultEnvelope(readFileSync(durableResultPath, 'utf8'));
      if (published.runId !== id || published.shortId !== state.shortId || published.intentId !== state.intentId) {
        throw new Error(`stable V2 result for ${id} does not match its durable state`);
      }
      if (!V2_TERMINAL_STATUSES.has(state.lifecycle.status)) {
        state.lifecycle.status = published.status;
        state.lifecycle.finishedAt = published.finishedAt;
        state.lifecycle.resultFile = durableResultPath;
        state.planner.status = state.planner.status === 'running' ? 'waiting' : state.planner.status;
        if (isProgramWorkflow(state) && !['failed', 'cancelled'].includes(state.planner.status)) state.planner.status = published.status === 'cancelled' ? 'cancelled' : 'completed';
        appendEvent(runDir, state, 'workflow.finished', {
          status: published.status, verified: published.verified, resultFile: durableResultPath,
          reason: published.reason, recovered: true,
        });
        serializeV2DurableState(state);
        writeJsonAtomic(statePath(runDir), state);
        return { runId: id, shortId: state.shortId, runDir, state: clone(state), result: published };
      }
    }
    if (V2_TERMINAL_STATUSES.has(state.lifecycle.status)) {
      if (!existsSync(durableResultPath)) throw new Error(`terminal V2 run ${id} is missing its stable result envelope`);
      return {
        runId: id, shortId: state.shortId, runDir, state: clone(state),
        result: deserializeV2ResultEnvelope(readFileSync(durableResultPath, 'utf8')),
      };
    }
    const processAlive = dependencies.isProcessAlive ?? isProcessAlive;
    // A run parked at a gate or loop (gates-loops.js) has no kernel, like one awaiting its planner.
    if (!state.planner.awaiting && state.lifecycle.status !== 'waiting' && state.runner?.pid !== process.pid && processAlive(state.runner?.pid)
      && v2RunnerLiveness(state, { processAlive }).alive) {
      throw new Error(`run ${id} already has an active kernel (pid ${state.runner.pid}); watch it or cancel it before resuming`);
    }
    const workersFile = join(runDir, 'workers.json');
    const priorWorkers = existsSync(workersFile) ? JSON.parse(readFileSync(workersFile, 'utf8')) : [];
    const survivors = priorWorkers.filter(liveWorker);
    for (const worker of survivors) stopWorker(worker);
    const deadline = Date.now() + 2000;
    while (survivors.some(liveWorker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    for (const worker of survivors.filter(liveWorker)) stopWorker(worker, 'SIGKILL');
    const forceDeadline = Date.now() + 1000;
    while (survivors.some(liveWorker) && Date.now() < forceDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (survivors.some(liveWorker)) throw new Error('previous kernel workers are still alive; refusing to replay actions');
    actStepsToCaller = reconcileResume(state, now(), runDir);
  } else {
    validateV2GoalDocument(goalDocument);
    writeJsonAtomic(goalPath(runDir), goalDocument);
    // Goal time is the only moment the project is certainly knowable: the
    // checkout is there, the remote is there. Stamp it now so the rollup and
    // every later reindex agree on which project this run belongs to.
    recordGoalProject(runDir, goalDocument.intent.cwd, { now });
    // The run's marker (D16, E23, D28): a new run gets every key this code
    // knows; a resumed run keeps the file it was started with, never
    // rewritten. `dependencies.runFeatures` lets a test launch a run the way
    // an earlier stage did (a saved-run twin).
    writeRunFeatures(runDir, withProgramFormat(dependencies.runFeatures ?? STAGE3_RUN_FEATURES, { v3: isProgramV3(initialPlannerResponse) }));
    state = createV2DurableState(goalDocument, { runId: id, shortId: nextShortId(bullswarmDir) });
  }
  // Read once. Missing or unreadable is `{}`: the legacy lane rule stays off
  // and only steps that declare evidence carry a proof label, so a run started
  // before stage 1 or 2 resumes with its original semantics.
  const runFeatures = readRunFeatures(runDir);
  const legacyGate = runFeatures.deliverableGate === 1;
  // Stage 3 (D28) branches on the keys, never on the file: `failureRule`
  // (one retry then the caller, a usage limit or no free pool straight to the
  // caller, fix-cycle verifyRounds, inherited repair evidence) and
  // `reviewPlacement` (reviews run where the caller routes them). Stage 2's
  // proof labels keep reading `runFeatures`.
  const features = runFeatureFlags(runFeatures);
  const programV3 = isProgramV3Run(runFeatures); // 0.37.0: pass/fail by facts, no repair loop
  // Marked runs: a planner or scout dispatch that ended on a usage limit, a
  // rate limit that did not clear, or no free pool. The run stops there and
  // goes to the caller (limitStopReason).
  const stoppedOnLimit = (result) => Boolean(features.failureRule) && result?.ok === false
    && LIMIT_STOP_KINDS.has(result.failureKind);
  const plannerLimitReason = (result) => limitStopReason('the workflow planner', {
    failureKind: result.failureKind, retryAfter: result.retryAfter ?? null, why: result.verdict?.why ?? null,
  }, state.shortId ?? id);

  let scoutReport = typeof scout === 'string' && scout.trim() ? scout.trim() : null;
  if (!scoutReport && state.preflight.scout.status === 'succeeded' && state.preflight.scout.outputFile && existsSync(state.preflight.scout.outputFile)) {
    scoutReport = readFileSync(state.preflight.scout.outputFile, 'utf8');
  }

  // Liveness. Without this a kernel that dies mid-run leaves state.json saying
  // "running" forever, and every reader — watch, runs list, the TUI — reports
  // progress that cannot happen. persist() is already called on every event and
  // on the progress tick, so stamping it here is the heartbeat.
  const runnerStartedAt = now();
  const persist = () => {
    lease.assertOwner();
    state = withV2Cancellation(state, runDir);
    state.runner = {
      pid: process.pid,
      startedAt: runnerStartedAt,
      lastHeartbeatAt: now(),
    };
    serializeV2DurableState(state);
    writeJsonAtomic(statePath(runDir), state);
  };
  // Price this run's finished attempts that reported no usage, in memory.
  // Pricing never fails, pauses or ends a run; the caller persists.
  const priceFinishedAttempts = () => {
    try { return reconcileCurrentRun(state, { runDir, bullswarmDir })?.changed ?? 0; }
    catch { return 0; }
  };
  const emit = (type, payload = {}) => {
    lease.assertOwner();
    const event = appendEvent(runDir, state, type, payload);
    persist();
    onEvent?.(event);
    return event;
  };
  const startPresentationStage = (actionId) => {
    const stage = stageForAction(state.presentation, actionId);
    if (!stage || stage.startedAt) return;
    stage.startedAt = now();
    emit('presentation.stage_started', {
      stageId: stage.id, label: stage.label, revision: stage.revision,
      actionIds: clone(stage.actionIds),
    });
  };
  const completePresentationStages = () => {
    for (const stage of state.presentation.stages) {
      if (!stage.startedAt || stage.completedAt) continue;
      const status = presentationStageStatus(stage, state.actions);
      if (!status.terminal) continue;
      stage.completedAt = now();
      emit('presentation.stage_completed', {
        stageId: stage.id, label: stage.label, revision: stage.revision,
        status: status.successful ? 'completed' : 'completed-with-gaps',
        completed: status.completed, total: status.total,
      });
    }
  };
  // D25: a failed `action.finished` names the current definition's attempts
  // and, in a marked run, its counted retries, so a watcher replaying from an
  // older cursor still shows the tries as they were.
  const failedFacts = (actionId) => {
    const superseded = actionState(state, actionId)?.supersededAttempts ?? 0;
    const attemptIds = state.attempts
      .filter((attempt) => attempt.actionId === actionId && attempt.ordinal > superseded)
      .map((attempt) => attempt.id);
    return { attemptIds, ...(features.failureRule ? { retries: countRetries(state, actionId, superseded) } : {}) };
  };
  const providerOfPool = (name) => modelFamilyOf(pools.find((pool) => pool?.name === name) ?? name);
  // D27: who judged, and every current-definition attempt that did work on
  // the steps the check judges (D17), crashed attempts that changed files
  // included. One writer entry per step and pool.
  const reviewFacts = (action) => {
    const runtime = actionState(state, action.id);
    const judged = state.attempts.findLast((attempt) => attempt.actionId === action.id && attempt.status === 'succeeded'
      && attempt.ordinal > (runtime?.supersededAttempts ?? 0));
    const reviewer = judged?.pool
      ? { attemptId: judged.id, pool: judged.pool, model: judged.model ?? null, provider: providerOfPool(judged.pool) ?? null }
      : undefined;
    const judgedIds = new Set(action.evidenceFor ?? []);
    const writers = [];
    const seen = new Set();
    for (const step of state.program.actions) {
      if (step.id === action.id || (step.evidenceFor ?? []).length) continue;
      if (!(step.affects ?? []).some((id) => judgedIds.has(id))) continue;
      if (actionState(state, step.id)?.status === 'removed') continue;
      for (const attempt of workAttempts(state, step.id)) {
        if (!attempt.pool || seen.has(`${step.id}\u0000${attempt.pool}`)) continue;
        seen.add(`${step.id}\u0000${attempt.pool}`);
        writers.push({ actionId: step.id, pool: attempt.pool, provider: providerOfPool(attempt.pool) ?? null });
      }
    }
    return { reviewer, writers };
  };
  let interrupted = false;
  // Actions to stop while the run itself goes on: actionId -> {kind, message},
  // where kind is superseded (a plan revision replaced the step) or paused.
  const stopRequested = new Map();
  // Act steps a step restart stopped during their checks (F14): the restart
  // is refused, since the step went to the caller.
  const actStoppedByRestart = new Set();
  const workers = new Map();
  const workersPath = join(runDir, 'workers.json');
  const onSpawn = (pid) => {
    lease.assertOwner();
    workers.set(pid, { pid, identity: processIdentity(pid), processGroup: true });
    writeJsonAtomic(workersPath, [...workers.values()]);
  };
  const onWorkerExit = (pid) => {
    workers.delete(pid);
    lease.assertOwner();
    writeJsonAtomic(workersPath, [...workers.values()]);
  };
  const onSignal = () => { interrupted = true; for (const worker of workers.values()) stopWorker(worker); };
  const refreshCancellation = () => {
    if (interrupted) return true;
    try {
      const requestFile = join(runDir, 'cancellation.json');
      const disk = existsSync(requestFile)
        ? { cancellation: JSON.parse(readFileSync(requestFile, 'utf8')) }
        : JSON.parse(readFileSync(statePath(runDir), 'utf8'));
      if (disk?.cancellation?.requested && !state.cancellation.requested) {
        state.cancellation = clone(disk.cancellation);
        persist();
      }
    } catch { /* next durable write or cancellation poll retries */ }
    return state.cancellation.requested;
  };

  if (!state.lifecycle.startedAt) state.lifecycle.startedAt = now();
  state.lifecycle.status = state.program.actions.length ? 'running' : 'planning';
  persist();
  emit(resuming ? 'workflow.resumed' : 'workflow.started', { runId: id, shortId: state.shortId, intentId: state.intentId, goal: state.intent.goal });
  // An act step whose kernel died during its checks (F14) finished as failed
  // in reconcileResume, before the event log was open: say so now.
  for (const { actionId, why } of actStepsToCaller) {
    emit('action.finished', { actionId, status: 'failed', failureKind: 'failed-evidence', why, ...failedFacts(actionId) });
  }

  let plannerExhausted = false;
  let limitsExhausted = false;
  let terminalReason = null;
  const config = settings(state);
  const programExecution = isProgramWorkflow(state);
  const schedulingOptions = v2SchedulingOptions(state);
  const captureStatus = dependencies.captureWorkspaceStatus ?? captureWorkspaceStatus;
  let workspaceBaseline = null;
  if (programExecution) {
    const baselinePath = join(runDir, 'workspace-baseline.json');
    try {
      if (existsSync(baselinePath)) workspaceBaseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      else {
        workspaceBaseline = captureStatus(state.intent.cwd);
        writeJsonAtomic(baselinePath, workspaceBaseline);
      }
    } catch {
      workspaceBaseline = { changedFiles: [], warnings: ['The initial workspace change inventory is unavailable.'] };
    }
  }
  const callerPlanner = config.plannerMode === 'caller';
  let pendingInitialResponse = initialPlannerResponse ? clone(initialPlannerResponse) : null;
  // A caller program supplied at launch is kept in the run directory until the
  // kernel applies it, so an interruption before the initial boundary (for
  // example during an opt-in scout) does not lose it: the resume applies it
  // instead of pausing to ask for a program the caller already authored.
  const pendingInitialPath = join(runDir, 'initial-planner-response.json');
  if (pendingInitialResponse) writeJsonAtomic(pendingInitialPath, pendingInitialResponse);
  else if (callerPlanner && resuming && state.planner.turns === 0 && !state.planner.awaiting && existsSync(pendingInitialPath)) {
    try { pendingInitialResponse = JSON.parse(readFileSync(pendingInitialPath, 'utf8')); } catch { pendingInitialResponse = null; }
  }
  // A durable exhausted decision (submitted by a caller planner, or recorded
  // just before an interrupted finalize) must survive resume; the runtime's
  // in-memory flag alone would otherwise re-open a planning boundary.
  if (state.planner.status === 'completed' && state.planner.lastDecision?.kind === 'exhausted') {
    plannerExhausted = true;
    terminalReason = state.planner.lastDecision.reason ?? terminalReason;
  }
  const schedulerWorkspaceMode = config.workspaceMode === 'isolated' ? 'isolated' : 'shared';
  const createWorkspace = dependencies.createIsolatedWorkspace ?? createIsolatedWorkspace;
  const integrateWorkspace = dependencies.integrateIsolatedWorkspace ?? integrateIsolatedWorkspace;
  const disposeWorkspace = dependencies.disposeIsolatedWorkspace ?? disposeIsolatedWorkspace;

  const runScout = async () => {
    const durable = state.preflight.scout;
    if (durable.status === 'skipped') return { ok: true, skipped: true };
    // A scout that runs (or is supplied) again is no longer the one a limit
    // stopped (a marked run's record; unmarked runs never carry it).
    delete durable.limitStop;
    if (scoutReport) {
      const outputFile = join(runDir, 'out-preflight-scout.md');
      writeFileSync(outputFile, scoutReport);
      Object.assign(durable, { status: 'succeeded', startedAt: durable.startedAt ?? now(), finishedAt: now(), outputFile, lastFailure: null });
      persist();
      emit('preflight.scout_finished', { status: 'succeeded', supplied: true, outputFile });
      return { ok: true };
    }
    durable.status = 'running'; durable.startedAt ??= now(); durable.finishedAt = null; durable.lastFailure = null;
    // Marked runs: a scout run again (after a resume) writes its task and
    // output beside its earlier attempts' files, never over them.
    const fileBase = features.failureRule ? durable.attempts.length : 0;
    state.lifecycle.status = 'planning'; persist();
    emit('preflight.scout_started', { purpose: 'Read-only repository and capability inspection' });
    let current = null; let lastProgressPersist = 0;
    const reportValidator = (text) => {
      const source = String(text ?? '').trim();
      const missing = ['TREE', 'MANIFEST', 'TEST STATUS', 'UNITS OF WORK', 'SHARED FILES', 'RISKS']
        .filter((heading) => !new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?${heading}:`, 'i').test(source));
      const units = extractScoutUnitIds(source);
      const errors = [
        ...(source.length < 200 ? ['scout report must contain at least 200 characters'] : []),
        ...missing.map((heading) => `missing ${heading}: heading`),
        ...(units.length ? [] : ['scout report must end with a non-empty unique kebab-case JSON unit array']),
      ];
      return { ok: errors.length === 0, errors, value: source };
    };
    await syncPools();
    const result = await dispatch({
      action: { id: 'preflight-scout', lane: 'analyze', effort: 'low' },
      legacyGate,
      earlierWork: earlierWorkFor(state, 'preflight-scout'),
      extraSnapshotPaths: extraSnapshotPathsFor(state, 'preflight-scout'),
      taskText: scoutPrompt(state.intent.goal, state.intent.cwd), targetDir: state.intent.cwd,
      paths: (ordinal) => ({ taskFile: join(runDir, `task-preflight-scout-attempt-${fileBase + ordinal}.md`), outFile: join(runDir, `out-preflight-scout-attempt-${fileBase + ordinal}.md`) }),
      pools, refreshPools, bullswarmDir, runId: id, parentEnv,
      preferredPool: state.config.workerRouting?.pool ?? state.config.workerRouting?.preferredPool ?? null,
      preferredModel: state.config.workerRouting?.model ?? state.config.workerRouting?.preferredModel ?? null,
      strictPool: state.config.workerRouting?.strictPool ?? state.config.workerRouting?.pool ?? null,
      runReasoning: state.config.workerRouting?.reasoning ?? null,
      maxMechanicalRetries: config.maxMechanicalRetries, shouldCancel: refreshCancellation, onSpawn, onWorkerExit,
      // Marked runs: a usage limit, or no free pool, ends the scout and goes
      // to the caller; it never moves to another pool by itself.
      usageLimitsToCaller: Boolean(features.failureRule),
      outputValidator: reportValidator,
      correctionTask: (verdict, { originalTask }) => `${originalTask}\n\nYour prior scout report failed deterministic validation:\n${(verdict?.structured?.errors ?? []).map((error) => `- ${error}`).join('\n')}\nReturn a corrected report with every exact heading.`,
      onAttempt: (stage, record) => {
        if (stage === 'started') {
          current = {
            ordinal: durable.attempts.length + 1, turn: 1, status: 'running', pool: record.pool, model: record.model,
            reasoning: clone(record.reasoning ?? null),
            startedAt: record.startedAt, finishedAt: null, taskFile: record.taskFile, outputFile: record.outFile,
          };
          durable.attempts.push(current);
          emit('preflight.scout_attempt_started', { ordinal: current.ordinal, pool: current.pool, model: current.model });
        } else if (stage === 'captured') {
          if (recordAttemptCapture(current, record)) persist();
        } else if (stage === 'corrected') {
          // A rate-limit backoff the attempt promised could not run: its status
          // and why change; it adds no usage.
          Object.assign(current, { status: record.status, why: record.why ?? current.why ?? null });
          persist();
        } else {
          Object.assign(current, {
            status: record.status, finishedAt: record.finishedAt, outputFile: record.outFile,
            failureKind: record.failureKind ?? null, why: record.why ?? null,
            usage: preferredUsage(current.usage ?? null, record.usage ?? null), wallSec: record.wallSec ?? null,
            ...(record.outputTruncated !== undefined ? { outputTruncated: record.outputTruncated } : {}),
            ...(record.outputSource !== undefined ? { outputSource: record.outputSource } : {}),
          });
          addUsage(state, { ...record, usage: current.usage });
          emit('preflight.scout_attempt_finished', {
            ordinal: current.ordinal,
            status: current.status,
            failureKind: current.failureKind,
            ...(current.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(current.outputSource ? { outputSource: current.outputSource } : {}),
          });
        }
      },
      onActivity: ({ at, bytes }) => {
        if (!current) return; current.lastActivityAt = at;
        current.outputBytesObserved = Number(current.outputBytesObserved ?? 0) + Number(bytes ?? 0);
        const time = Date.now(); if (time - lastProgressPersist >= 1000) { lastProgressPersist = time; persist(); }
      },
      onAgentEvent: (event) => { if (current) { current.lastEventAt = event.at ?? now(); current.lastAgentEvent = clone(event); } },
    });
    durable.finishedAt = now();
    if (!result.ok) {
      durable.status = 'failed'; durable.lastFailure = { kind: result.failureKind, message: result.verdict?.why ?? 'preflight scout failed' };
      // Marked runs: a usage limit or no free pool says when to try again,
      // and whether the run goes on without the report (`runContinues`, the
      // kernel's decision just after this: a program run with the caller's
      // program, or one already there, runs on; any other run finishes). The
      // event carries it so a watch replay reads the decision, not a state a
      // later plan revise moved on.
      persist(); emit('preflight.scout_finished', {
        status: 'failed', failureKind: result.failureKind, why: result.verdict?.why ?? null,
        ...(stoppedOnLimit(result) ? {
          retryAfter: result.retryAfter ?? null,
          runContinues: programExecution && (Boolean(pendingInitialResponse) || state.program.actions.length > 0),
        } : {}),
      });
      return result;
    }
    durable.status = 'succeeded'; durable.outputFile = result.verdict?.outFile ?? result.attempts.at(-1)?.outFile ?? null; durable.lastFailure = null;
    scoutReport = result.verdict?.structured?.value ?? readFileSync(durable.outputFile, 'utf8');
    persist(); emit('preflight.scout_finished', { status: 'succeeded', outputFile: durable.outputFile });
    return result;
  };

  // Caller-planner mode: the kernel never dispatches a planner process, and it
  // never waits for its caller either. At a point only the caller can decide
  // (no program, a program it could not accept, requirements still open with
  // nothing left to run), the run finishes with what it has and the result
  // hands that decision back: continue it (plan revise), retry it (resume),
  // take the work over, or start again. A held run looked stuck; one sat 197
  // minutes waiting for a caller that had moved on (project-b, 2026-09).
  const handBackToCaller = (boundary, { issues = null } = {}) => {
    const token = state.shortId ?? id;
    const scout = state.preflight?.scout ?? {};
    let reason;
    if (issues) {
      const shown = issues.slice(0, 3).join('; ');
      reason = `the supplied program was not accepted, so nothing ran: ${shown}${issues.length > 3 ? `; and ${issues.length - 3} more` : ''}. Fix it and add it with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`;
    } else if (boundary === 'initial') {
      const scouted = scout.status === 'succeeded' && scout.outputFile
        ? ` (the scout report is at ${scout.outputFile})`
        : scout.status === 'failed' ? ` (the scout failed: ${scout.lastFailure?.message ?? scout.lastFailure?.kind ?? 'unknown'})` : '';
      reason = `no program to run${scouted}. Add steps with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run with --program`;
    } else if (boundary === 'gaps') {
      reason = `requirements are still open and no step is left to run: ${consolidateV2Gaps(state).summary}`;
    } else {
      reason = 'guidance arrived that the current plan does not cover';
    }
    emit('planner.handed_back', { boundary, reason, ...(issues ? { issues: [...issues] } : {}) });
    return { ok: false, status: 'handed-back', reason };
  };

  const applyInitialCallerProgram = (boundary) => {
    const response = pendingInitialResponse;
    pendingInitialResponse = null;
    let accepted;
    try {
      accepted = validateV2PlannerResponse(response, state, { boundary, requiredScoutUnits: [] });
    } catch (error) {
      if (!(error instanceof V2PlannerValidationError)) throw error;
      rmSync(pendingInitialPath, { force: true });
      return handBackToCaller(boundary, { issues: [...error.issues] });
    }
    const turn = state.planner.turns + 1;
    writeJsonAtomic(join(runDir, `candidate-workflow-planner-turn-${turn}.json`), accepted);
    const result = acceptCallerPlannerResponse(state, accepted, { boundary, runDir, onEvent, now });
    state = result.state;
    persist();
    return { ok: true, status: 'succeeded', accepted: result.accepted };
  };

  const runPlanner = async (boundary) => {
    if (callerPlanner) {
      if (pendingInitialResponse && boundary === 'initial') return applyInitialCallerProgram(boundary);
      return handBackToCaller(boundary);
    }
    const deliveredSteering = deliverSteering(state, runDir);
    for (const entry of deliveredSteering) {
      emit('steering.delivered', {
        steeringId: entry.id,
        message: entry.message,
        decisionSequence: entry.decisionSequence,
      });
    }
    const context = createV2PlannerContext(state, {
      scout: scoutReport,
      steering: [
        ...(state.config.settings.suggestedPlan ? [state.config.settings.suggestedPlan] : []),
        ...deliveredSteering.map((entry) => entry.message),
      ],
      boundary,
    });
    const turn = state.planner.turns + 1;
    const candidatePath = join(runDir, `candidate-workflow-planner-turn-${turn}.json`);
    rmSync(candidatePath, { force: true });
    const prompt = `${buildV2PlannerPrompt(context)}\n\n${buildPlannerPreflight(statePath(runDir), boundary, candidatePath)}`;
    // Marked runs: a turn run again (after a resume) writes its task and
    // output beside its earlier attempts' files, never over them.
    const fileBase = features.failureRule ? state.planner.attempts.filter((attempt) => attempt.turn === turn).length : 0;
    // A turn that runs is no longer the one a limit stopped (a marked run's
    // record; unmarked runs never carry it).
    delete state.planner.limitStop;
    state.planner.status = 'running';
    state.lifecycle.status = 'planning';
    persist();
    emit('planner.started', { turn: state.planner.turns + 1, boundary });
    let currentAttemptId = null;
    let lastProgressPersist = 0;
    const plannerAttempt = () => state.planner.attempts.find((item) => item.ordinal === currentAttemptId);
    const persistPlannerProgress = () => {
      const time = Date.now();
      if (time - lastProgressPersist >= 1000) { lastProgressPersist = time; persist(); }
    };
    await syncPools();
    const result = await dispatch({
      action: { id: 'workflow-planner', lane: 'analyze', effort: 'high' },
      legacyGate,
      earlierWork: earlierWorkFor(state, 'workflow-planner'),
      extraSnapshotPaths: extraSnapshotPathsFor(state, 'workflow-planner'),
      taskText: prompt,
      targetDir: state.intent.cwd,
      paths: (ordinal) => ({
        taskFile: join(runDir, `task-workflow-planner-turn-${turn}-attempt-${fileBase + ordinal}.md`),
        outFile: join(runDir, `out-workflow-planner-turn-${turn}-attempt-${fileBase + ordinal}.json`),
      }),
      pools, refreshPools, bullswarmDir, runId: id, parentEnv,
      preferredPool: state.config.plannerRouting?.pool ?? state.config.plannerRouting?.preferredPool ?? null,
      preferredModel: state.config.plannerRouting?.model ?? state.config.plannerRouting?.preferredModel ?? null,
      strictPool: state.config.plannerRouting?.strictPool ?? state.config.plannerRouting?.pool ?? null,
      runReasoning: state.config.plannerRouting?.reasoning ?? null,
      currentSession: state.planner.session,
      maxMechanicalRetries: config.maxMechanicalRetries,
      shouldCancel: refreshCancellation, onSpawn, onWorkerExit,
      // Marked runs: a usage limit, or no free pool, ends the planner turn
      // and goes to the caller; it never moves to another pool by itself.
      usageLimitsToCaller: Boolean(features.failureRule),
      outputValidator: () => readPlannerCandidate(candidatePath, state, {
        boundary,
        requiredScoutUnits: boundary === 'initial' ? context.scoutUnits : [],
      }),
      correctionTask: (verdict, details) => {
        const error = new V2PlannerValidationError(verdict?.structured?.errors ?? []);
        const request = plannerCorrectionRequest(error, { attempt: 1, maxCorrections: 1 });
        return `${details.originalTask}\n\n${request.instruction}\nValidation problems:\n${request.issues.map((issue) => `- ${issue}`).join('\n')}`;
      },
      onAttempt: (stage, record) => {
        if (stage === 'started') {
          currentAttemptId = state.planner.attempts.length + 1;
          state.planner.attempts.push({
            ordinal: currentAttemptId, turn, status: 'running', pool: record.pool, model: record.model,
            reasoning: clone(record.reasoning ?? null),
            startedAt: record.startedAt, finishedAt: null, taskFile: record.taskFile,
            outputFile: record.outFile, continued: record.continued === true,
          });
          emit('planner.attempt_started', { turn, ordinal: currentAttemptId, pool: record.pool, model: record.model, reasoning: clone(record.reasoning ?? null) });
        } else if (stage === 'captured') {
          if (recordAttemptCapture(state.planner.attempts.find((item) => item.ordinal === currentAttemptId), record)) persist();
        } else if (stage === 'corrected') {
          // A rate-limit backoff the attempt promised could not run: its status
          // and why change; it adds no usage.
          const attempt = state.planner.attempts.find((item) => item.ordinal === currentAttemptId);
          if (attempt) Object.assign(attempt, { status: record.status, why: record.why ?? attempt.why ?? null });
          persist();
        } else {
          const attempt = state.planner.attempts.find((item) => item.ordinal === currentAttemptId);
          if (attempt) Object.assign(attempt, {
            status: record.status, finishedAt: record.finishedAt, outputFile: record.outFile,
            failureKind: record.failureKind ?? null, why: record.why ?? null,
            usage: preferredUsage(attempt.usage ?? null, record.usage ?? null),
            wallSec: record.wallSec ?? null,
            ...(record.outputTruncated !== undefined ? { outputTruncated: record.outputTruncated } : {}),
            ...(record.outputSource !== undefined ? { outputSource: record.outputSource } : {}),
          });
          addUsage(state, attempt ? { ...record, usage: attempt.usage } : record);
          emit('planner.attempt_finished', {
            turn,
            ordinal: currentAttemptId,
            status: record.status,
            failureKind: record.failureKind ?? null,
            ...(attempt?.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(attempt?.outputSource ? { outputSource: attempt.outputSource } : {}),
          });
        }
      },
      onActivity: ({ at, bytes }) => {
        const attempt = plannerAttempt();
        if (!attempt) return;
        attempt.lastActivityAt = at;
        attempt.outputBytesObserved = Number(attempt.outputBytesObserved ?? 0) + Number(bytes ?? 0);
        persistPlannerProgress();
      },
      onAgentProgress: ({ at, providerType, model }) => {
        const attempt = plannerAttempt();
        if (!attempt) return;
        attempt.lastEventAt = at;
        attempt.lastAgentEvent = { at, providerType: providerType ?? null, model: model ?? attempt.model ?? null };
        if (model) attempt.model = model;
        persistPlannerProgress();
      },
      onAgentEvent: (event) => {
        const attempt = plannerAttempt();
        if (!attempt) return;
        attempt.lastEventAt = event.at ?? now();
        attempt.lastAgentEvent = clone(event);
        persistPlannerProgress();
      },
    });
    state.planner.session = result.session ?? state.planner.session;
    if (!result.ok) {
      state.planner.status = result.status === 'cancelled' ? 'cancelled' : 'failed';
      // Marked runs: the stop ends the run (the kernel loop's next boundary),
      // and `workflow resume` reads this record to run the turn again, with
      // the steering it took handed back to it.
      if (stoppedOnLimit(result)) {
        state.planner.limitStop = {
          failureKind: result.failureKind, retryAfter: returnTimeOrNull(result.retryAfter), boundary, at: now(),
          steeringIds: deliveredSteering.map((entry) => entry.id),
        };
      }
      persist();
      // Marked runs: a usage limit or no free pool says when to try again.
      emit('planner.finished', {
        turn, ok: false, failureKind: result.failureKind, why: result.verdict?.why ?? null,
        ...(stoppedOnLimit(result) ? { retryAfter: result.retryAfter ?? null } : {}),
      });
      return result;
    }
    const accepted = result.verdict.structured.value;
    state = applyV2PlannerResponse(state, accepted, { boundary });
    state.planner.session = result.session ?? state.planner.session;
    if (boundary === 'gaps') state.budget.expansions += 1;
    ensureVerifyLoop(state, accepted, features);
    initializeNewActions(state);
    persist();
    emit('planner.finished', { turn: state.planner.turns, ok: true, kind: accepted.kind, summary: accepted.summary, programRevision: state.program.revision });
    return { ...result, accepted };
  };

  const runAction = async (action) => {
    startPresentationStage(action.id);
    const runtime = actionState(state, action.id);
    const completedAttempt = state.attempts.findLast((attempt) => attempt.actionId === action.id && attempt.status === 'succeeded'
      && attempt.ordinal > (runtime.supersededAttempts ?? 0));
    const receiptPath = join(runDir, `completion-${action.id}.json`);
    let receipt = completedAttempt && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
    if (receipt && receipt.attemptId !== completedAttempt.id) throw new Error(`completion receipt does not match ${completedAttempt.id}; preserved work requires review`);
    if (completedAttempt && !receipt) {
      // Older shared program runs have no post-dispatch ownership or integration.
      // Recover their output; never silently repeat successful worker edits.
      if (enforcesOwnership(state) || action.evidenceFor.length || !completedAttempt.outputFile || !existsSync(completedAttempt.outputFile)) {
        throw new Error(`completed attempt ${completedAttempt.id} has no recovery receipt; preserved work requires review rather than replay`);
      }
      receipt = { attemptId: completedAttempt.id, isolated: null, before: null, verdict: { ok: true, outFile: completedAttempt.outputFile } };
    }
    runtime.status = 'running';
    runtime.startedAt ??= now();
    runtime.finishedAt = null;
    runtime.lastFailure = null;
    if (!receipt && action.affects.length) {
      const revision = `work-${state.program.revision}-${state.events.sequence + 1}-${action.id}`;
      state.ledger = invalidateRequirements(state.ledger, action.affects, revision);
      runtime.workRevision = revision;
    }
    persist();
    // Round 1 opens when the first evidence step starts.
    if (action.evidenceFor.length && programExecution && state.verifyLoop) {
      const opened = openFirstRound(state, { at: now() });
      if (opened) {
        emit('workflow.verify-round', {
          round: 1, of: state.verifyLoop.max, stage: 'started', steps: [...opened.verifyActionIds],
          toJudge: [...opened.toJudge], carried: [],
        });
      }
    }
    emit('action.started', { actionId: action.id, purpose: action.purpose, evidence: action.evidenceFor.length > 0 });
    // A review step (evidenceFor): the kernel's JSON contract, routed away from
    // the writers. Not the step's own `evidence` checks (E20).
    const review = action.evidenceFor.length > 0;
    const baseAttemptOrdinal = runtime.attempts;
    const runWideAttemptId = (local) => {
      const prefix = `${action.id}-`;
      const ordinal = String(local).startsWith(prefix) ? Number(String(local).slice(prefix.length)) : NaN;
      return Number.isInteger(ordinal) && ordinal > 0 ? `${action.id}-${baseAttemptOrdinal + ordinal}` : local;
    };
    const contract = review ? { schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor: clone(action.evidenceFor) } : null;
    const contractPath = review ? join(runDir, `contract-${action.id}.json`) : null;
    const candidatePath = review ? join(runDir, `candidate-${action.id}.json`) : null;
    if (contract) writeJsonAtomic(contractPath, contract);
    if (candidatePath && !receipt) rmSync(candidatePath, { force: true });
    let isolated = receipt?.isolated ?? null;
    const isolatedName = `${action.id}-attempt-${baseAttemptOrdinal + 1}-${Date.now().toString(36)}`;
    if (!receipt && !review && action.ownedFiles.length && schedulerWorkspaceMode === 'isolated') {
      isolated = createWorkspace({ sourceDir: state.intent.cwd, runDir, actionId: isolatedName, maxFiles: config.maxManifestFiles });
      emit('action.workspace_created', { actionId: action.id, mode: 'isolated', workspaceRoot: isolated.workspaceRoot });
    }
    const targetDir = isolated?.targetDir ?? state.intent.cwd;
    const releaseWorkspace = () => {
      if (!isolated) return;
      if (runtime.status === 'succeeded') disposeWorkspace(isolated);
      else emit('action.workspace_retained', { actionId: action.id, workspaceRoot: isolated.workspaceRoot, reason: 'unfinished work preserved for recovery' });
      isolated = null;
    };
    try {
    let before = receipt?.before ?? null;
    if (!receipt && enforcesOwnership(state) && action.ownedFiles.length) before = captureManifest(targetDir, { maxFiles: config.maxManifestFiles });
    let currentAttemptId = null;
    // Set when this act step's checks were stopped (F14): it goes to the caller.
    let actStoppedWhy = null;
    let lastProgressPersist = 0;
    const workerAttempt = () => state.attempts.find((item) => item.id === currentAttemptId);
    const answerHooks = programV3 && !review ? stepAnswerHooks(action, { attempt: workerAttempt }) : null;
    const persistWorkerProgress = () => {
      const time = Date.now();
      if (time - lastProgressPersist >= 1000) { lastProgressPersist = time; persist(); }
    };
    let result;
    if (!receipt) await syncPools();
    // Composed once, so the byte ledger below measures exactly the text this
    // attempt was handed rather than a second rendering of it.
    const digest = action.kind === 'digest';
    const taskText = review
      ? buildEvidenceTask(state, action, contractPath, candidatePath)
      : digest ? buildDigestTask(state, action, targetDir) : buildWorkTask(state, action, targetDir, runDir);
    const observedRequirementBytes = embeddedRequirementBytes(state, action, { evidence: review, digest });
    // Unmarked runs keep today's writer avoidance byte for byte (R12/R13). A
    // run with caller-placed reviews (D15) passes no writers: the check keeps
    // "no free-first", and independence comes only from its route.
    const writerPools = review
      ? [...new Set(state.attempts
        .filter((attempt) => attempt.status === 'succeeded'
          && (actionDefinition(state, attempt.actionId)?.affects ?? [])
            .some((id) => action.evidenceFor.includes(id)))
        .map((attempt) => attempt.pool)
        .filter(Boolean))]
      : [];
    const durablePriorAttempt = resuming
      ? state.attempts.findLast((attempt) => attempt.actionId === action.id
        && attempt.ordinal > (runtime.supersededAttempts ?? 0)
        && ['interrupted', 'failed'].includes(attempt.status))
      : null;
    // A caller restart (workflow step restart) hands the next attempt the
    // stopped attempt's handoff and, when the caller named one, its pool.
    const restart = receipt ? null : appliedStepRestart(state, runDir, action.id, handoffBlock);
    const durablePriorHandoff = restart?.handoff ?? (durablePriorAttempt
      ? durableAttemptHandoff(durablePriorAttempt, runDir, handoffBlock)
      : null);
    const dispatchedTaskText = durablePriorHandoff
      ? `${taskText}\n\n${durablePriorHandoff.block}`
      : taskText;
    const dispatchedBytes = attemptBytes(state, action, dispatchedTaskText, { evidence: review, digest });
    // The step's own checks (E14): one evidence retry per current definition.
    // A revise, rerun or amend raises supersededAttempts and grants a fresh
    // one; a kernel resume does not.
    const evidenceRetryAvailable = !state.attempts.some((attempt) => attempt.actionId === action.id
      && attempt.ordinal > (runtime.supersededAttempts ?? 0) && attempt.failureKind === 'failed-evidence');
    // An isolated copy runs each `cmd` against its own path, as its brief says;
    // the stored definition keeps the caller's path.
    const dispatchedAction = isolated && declaredEvidence(action).length
      ? { ...action, evidence: rewriteEvidenceCwd(declaredEvidence(action), state.intent.cwd, targetDir) }
      : action;
    // Every dispatched task (work, digest and evidence) closes with a soft
    // time box, composed per attempt at dispatch (the pool and the clock exist
    // only then). A box that cannot be composed is left out, never fatal.
    let boxBytes = 0;
    const timeBox = ({ pool, startedAt }) => {
      let boxed = null;
      try {
        boxed = timeBoxForAttempt({
          action, pool, startedAt, evidence: review,
          history: () => readTimeBoxHistory(bullswarmDir),
          timeZone: timeBoxTimeZone,
        });
      } catch { boxed = null; }
      boxBytes = boxed ? Buffer.byteLength(`\n\n${boxed.text}`, 'utf8') : 0;
      return boxed;
    };
    try { result = receipt ? { ok: true, status: 'succeeded', verdict: receipt.verdict, attempts: [] } : await dispatch({
      action: dispatchedAction,
      legacyGate,
      earlierWork: earlierWorkFor(state, action.id, { isolated: Boolean(isolated) }),
      extraSnapshotPaths: extraSnapshotPathsFor(state, action.id),
      taskText: dispatchedTaskText,
      targetDir,
      paths: (ordinal) => ({ taskFile: join(runDir, `task-${action.id}-attempt-${baseAttemptOrdinal + ordinal}.md`), outFile: join(runDir, `out-${action.id}-attempt-${baseAttemptOrdinal + ordinal}.${review ? 'json' : 'md'}`) }),
      pools, refreshPools, bullswarmDir, runId: id, parentEnv,
      preferredPool: restart?.pool ?? state.config.workerRouting?.pool ?? state.config.workerRouting?.preferredPool ?? null,
      // The step's own model outranks the run-wide pin.
      preferredModel: action.model ?? state.config.workerRouting?.model ?? state.config.workerRouting?.preferredModel ?? null,
      strictPool: restart?.pool ?? state.config.workerRouting?.strictPool ?? state.config.workerRouting?.pool ?? null,
      // The program author's per-action override outranks the run-wide level.
      reasoningOverride: action.reasoning ?? null,
      runReasoning: state.config.workerRouting?.reasoning ?? null,
      // Evidence prefers normal routing but passes the pools that authored the
      // inspected work so the router can prefer a different eligible pool. A
      // writer remains a valid fallback when it is the only eligible choice;
      // the route reason names that exception for operators.
      evidence: review ? { writerPools: features.reviewPlacement === 'caller' ? [] : writerPools } : null,
      maxMechanicalRetries: action.retry ?? config.maxMechanicalRetries,
      evidenceRetryAvailable,
      // A loop's evidence-form `until` step: failed checks read "not passed".
      evidenceAsCondition: evidenceIsCondition(state, action),
      // Stage 3 (§2.1): one automatic retry per step, counted from stored
      // `retryOf` facts so a kernel resume neither refunds nor spends it.
      failureRule: features.failureRule,
      retriesAlready: countRetries(state, action.id, runtime.supersededAttempts ?? 0),
      // The step's route (D18): a hard filter on every pool list, in every run
      // where it is present.
      routeFilter: resolveRouteFilter(state, action, pools),
      pinSource: restart?.pool ? 'step restart' : null,
      // A step that failed on a pool because of the pool (a sign-in, a
      // provider error, a worker that died before it answered) starts
      // elsewhere when another pool can take it: a rerun, a resume or a
      // revise --rerun (marked runs; a pool named by restart --pool wins).
      leavePools: restart?.pool ? [] : poolCausedPools(state.attempts, action.id),
      // The checks run in the isolated copy before integration (E5), with the
      // private-copy side-effect scope.
      privateWorkspace: Boolean(isolated),
      // A plan revision or a pause --now can stop this one action while the
      // rest of the run carries on.
      shouldCancel: () => stopRequested.has(action.id) || refreshCancellation(), onSpawn, onWorkerExit,
      outputValidator: review ? () => readEvidenceCandidate(candidatePath, contract) : answerHooks?.outputValidator ?? null,
      correctionTask: review ? correctionTask : answerHooks?.correctionTask ?? null,
      answerBrief: answerHooks?.answerBrief ?? null,
      handoffBlock,
      resumeHandoff: durablePriorHandoff,
      runDir,
      timeBox,
      ledgerAttempts: state.attempts,
      onAttempt: (stage, record, verdict) => {
        // The dispatcher names attempts by its own count; the run's ids start
        // after this step's earlier attempts.
        if (record?.retryOf?.attempt) record = { ...record, retryOf: { attempt: runWideAttemptId(record.retryOf.attempt), how: record.retryOf.how } };
        if (stage === 'started') {
          const ordinal = baseAttemptOrdinal + record.ordinal;
          currentAttemptId = `${action.id}-${ordinal}`;
          runtime.attempts = ordinal;
          // The step reads as running while an attempt runs, with no failure.
          runtime.status = 'running';
          runtime.lastFailure = null;
          if (record.handoff) {
            const prior = state.attempts.findLast((item) => item.actionId === action.id);
            if (prior?.id) record = { ...record, handoff: { ...record.handoff, from: prior.id } };
          }
          const bytes = clone(dispatchedBytes);
          if (record.timeBox && boxBytes) { bytes.taskFile += boxBytes; bytes.kernel += boxBytes; }
          if (answerHooks?.briefBytes()) { bytes.taskFile += answerHooks.briefBytes(); bytes.kernel += answerHooks.briefBytes(); }
          state.attempts.push(normalizeAttempt({ ...record, bytes }, { id: currentAttemptId, actionId: action.id, ordinal }));
          const prior = record.handoff
            ? state.attempts.find((item) => item.id === record.handoff.from)
            : null;
          emit('attempt.started', {
            actionId: action.id, attemptId: currentAttemptId, pool: record.pool, model: record.model,
            reasoning: clone(record.reasoning ?? null),
            ...(record.handoff ? {
              handoff: {
                from: record.handoff.from,
                bytes: record.handoff.bytes,
                pool: prior?.pool ?? null,
                files: prior?.changedFileCount ?? 0,
                lastSaid: prior?.lastResponse ?? prior?.lastAgentEvent?.summary ?? '',
              },
            } : {}),
          });
          // The restart is delivered once its attempt has started.
          if (restart) clearStepRestart(runDir, action.id);
        } else if (stage === 'captured') {
          lease.assertOwner();
          if (recordAttemptCapture(workerAttempt(), record)) persist();
        } else if (stage === 'corrected') {
          // E14 (d): the stored attempt promised an evidence retry the pinned
          // pick could not make. Its status and why change; it adds no usage,
          // writes no receipt and settles nothing.
          lease.assertOwner();
          const attemptId = Number.isInteger(record.ordinal) ? `${action.id}-${baseAttemptOrdinal + record.ordinal}` : currentAttemptId;
          const attempt = state.attempts.find((item) => item.id === attemptId);
          if (attempt) Object.assign(attempt, { status: record.status, why: record.why ?? attempt.why ?? null });
          persist();
          emit('attempt.finished', {
            actionId: action.id,
            attemptId,
            status: record.status,
            failureKind: record.failureKind ?? attempt?.failureKind ?? null,
            pool: record.pool ?? attempt?.pool ?? null,
            model: record.model ?? attempt?.model ?? null,
            why: record.why ?? null,
            willRetry: false,
            outputFile: attempt?.outputFile ?? record.outputFile ?? record.outFile ?? null,
            ...evidenceOutcomePayload(record),
            corrected: true,
          });
        } else {
          lease.assertOwner();
          const stop = record.status === 'cancelled' && !interrupted ? stopRequested.get(action.id) ?? null : null;
          const checksStopped = record.status === 'cancelled'
            && Array.isArray(record.evidenceResults) && record.evidenceResults.some((item) => item?.why === 'stopped');
          if (checksStopped && roleOf(action) === 'act' && stop?.kind !== 'superseded') {
            // F14: whatever stopped them (a kernel signal, pause --now, a step
            // restart, workflow cancel), an act step's stopped checks send it
            // to the caller. A plan revision already decided what follows.
            let cause = 'stopped by workflow cancel';
            if (interrupted) cause = 'stopped by a kernel signal';
            else if (stop?.kind === 'paused') cause = 'stopped by workflow pause --now';
            else if (stop?.kind === 'restarted') cause = 'stopped by workflow step restart';
            actStoppedWhy = actStoppedDuringChecksWhy(cause);
            record = { ...record, status: 'failed', failureKind: 'failed-evidence', willRetry: false, why: actStoppedWhy };
          } else if (interrupted && checksStopped) {
            // A kernel signal during the checks (E16): the attempt did not fail
            // and was not cancelled by the caller; it runs again on resume, which
            // hands it on as it does a worker the kernel killed.
            record = {
              ...record, status: 'interrupted', failureKind: 'interrupted',
              why: 'kernel stopped during evidence; the attempt runs again on resume',
            };
          } else if (stop) {
            // An attempt stopped by a plan revision or a pause is not a failure of
            // its pool: record why it stopped, the same kind action.finished carries.
            record = { ...record, failureKind: stop.kind, why: stop.message };
          }
          // The receipt carries the check results (E31), so a kernel that dies
          // before the attempt below is stored still recovers them.
          if (record.status === 'succeeded') writeCompletionReceipt(receiptPath, {
            attemptId: currentAttemptId, finishedAt: record.finishedAt, before, isolated,
            verdict: receiptVerdict(verdict, record),
          });
          const attempt = state.attempts.find((item) => item.id === currentAttemptId);
          if (attempt) {
            const prior = { capture: attempt.capture, usage: attempt.usage };
            Object.assign(attempt, normalizeAttempt(record, { id: currentAttemptId, actionId: action.id, ordinal: attempt.ordinal }));
            clearEvidenceRunning(attempt);
            settleFinishedAttempt(attempt, prior);
            observeAttemptBytes(attempt, { authorPrompt: dispatchedBytes.authorPrompt, requirements: observedRequirementBytes });
            if (record.status === 'succeeded' && !review && !digest) recordReturnedEarly(attempt);
          }
          addUsage(state, attempt ? { ...record, usage: attempt.usage } : record);
          emit('attempt.finished', {
            actionId: action.id,
            attemptId: currentAttemptId,
            status: record.status,
            failureKind: record.failureKind ?? null,
            pool: record.pool ?? attempt?.pool ?? null,
            model: record.model ?? attempt?.model ?? null,
            why: record.why ?? null,
            willRetry: record.willRetry === true,
            // 'wait' when the dispatcher backs off a transient rate limit on the
            // same pool (F23); 'move' only in a record a stage-3 dispatcher wrote.
            ...(['move', 'wait'].includes(record.quotaNext) ? { quotaNext: record.quotaNext } : {}),
            outputFile: attempt?.outputFile ?? record.outputFile ?? record.outFile ?? null,
            ...(attempt?.outputBytes != null ? { outputBytes: attempt.outputBytes } : (record.outputBytes != null ? { outputBytes: record.outputBytes } : {})),
            ...(attempt?.streamFile ?? record.streamFile ? { streamFile: attempt?.streamFile ?? record.streamFile } : {}),
            ...(attempt?.diffFile ?? record.diffFile ? { diffFile: attempt?.diffFile ?? record.diffFile } : {}),
            ...(attempt?.changedFileCount != null ? { changedFileCount: attempt.changedFileCount } : (record.changedFileCount != null ? { changedFileCount: record.changedFileCount } : {})),
            ...(record.lastResponse != null ? { lastResponse: record.lastResponse } : {}),
            ...(attempt?.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(attempt?.outputSource ? { outputSource: attempt.outputSource } : {}),
            ...(attempt?.notes ? { notes: clone(attempt.notes) } : (record.notes ? { notes: clone(record.notes) } : {})),
            ...(attempt?.outputSamples ? { outputSamples: clone(attempt.outputSamples) } : (record.outputSamples ? { outputSamples: clone(record.outputSamples) } : {})),
            ...evidenceOutcomePayload(record),
            // Marked runs: the watch's quota line reads "back to you", or "no
            // retry spent" on an attempt that promised a retry.
            ...(features.failureRule ? { failureRule: true } : {}),
            ...(record.stalled ? {
              stalled: true,
              partialOutput: record.partialOutput ?? attempt?.partialOutput ?? record.outFile ?? null,
              silentSec: record.silentSec ?? null,
            } : {}),
          });
        }
      },
      onActivity: ({ at, bytes }) => {
        const attempt = workerAttempt();
        if (!attempt) return;
        attempt.lastActivityAt = at;
        attempt.outputBytesObserved = Number(attempt.outputBytesObserved ?? 0) + Number(bytes ?? 0);
        const atMs = Date.parse(at);
        if (Number.isFinite(atMs) && Number.isFinite(attempt.outputBytesObserved)) {
          attempt.outputSamples ??= [];
          const last = attempt.outputSamples.at(-1);
          if (last && atMs - last[0] < 5000) {
            // Keep the newest byte count in the current five-second bucket so
            // a live dashboard reflects progress without adding points faster
            // than the durable sampling contract permits.
            last[1] = attempt.outputBytesObserved;
          } else {
            if (attempt.outputSamples.length >= 240) attempt.outputSamples.shift();
            attempt.outputSamples.push([atMs, attempt.outputBytesObserved]);
          }
        }
        persistWorkerProgress();
      },
      onAgentProgress: ({ at, providerType, model }) => {
        const attempt = workerAttempt();
        if (!attempt) return;
        attempt.lastEventAt = at;
        attempt.lastAgentEvent = { at, providerType: providerType ?? null, model: model ?? attempt.model ?? null };
        if (model) attempt.model = model;
        persistWorkerProgress();
      },
      onAgentEvent: (event) => {
        const attempt = workerAttempt();
        if (!attempt) return;
        attempt.lastEventAt = event.at ?? now();
        attempt.lastAgentEvent = clone(event);
        persistWorkerProgress();
      },
      // Each check's start, 30 s heartbeat and end count as activity (E18), so
      // a long silent check never reads as a stale attempt.
      onEvidence: (event) => {
        const attempt = workerAttempt();
        if (attempt) {
          attempt.lastActivityAt = now();
          // The first check's start marks the checks phase: the stale probe
          // stops scoring the exited worker (F15), and a kernel that dies now
          // leaves the fact for reconcileResume (F14). The started event
          // below persists it at once.
          if (event?.stage === 'started' && !evidenceRunning(attempt)) {
            attempt.notes = [...(attempt.notes ?? []), { at: attempt.lastActivityAt, kind: EVIDENCE_RUNNING_NOTE, text: 'the worker finished; Bullswarm is running the step\'s checks' }];
          }
        }
        persistWorkerProgress();
        if (event?.stage !== 'started' && event?.stage !== 'finished') return;
        emit('attempt.evidence_item', {
          actionId: action.id, attemptId: currentAttemptId, stage: event.stage,
          index: event.index ?? null, of: event.of ?? null, type: event.type ?? null, label: event.label ?? null,
          ...(event.stage === 'finished' ? { status: event.status ?? null, why: event.why ?? null, durationMs: event.durationMs ?? null } : {}),
        });
      },
    }); } catch (error) {
      releaseWorkspace();
      throw error;
    }
    runtime.finishedAt = now();
    runtime.outputFile = review && result.ok
      ? candidatePath
      : result.verdict?.outFile ?? result.attempts.at(-1)?.outFile ?? null;
    if (answerHooks) settleStepAnswer(state, runtime, action, result, baseAttemptOrdinal);
    if (!result.ok && actStoppedWhy) {
      // An act step whose checks were stopped (F14): never requeued by a
      // resume, a pause or a restart; the caller decides.
      if (stopRequested.get(action.id)?.kind === 'restarted') actStoppedByRestart.add(action.id);
      runtime.status = 'failed';
      runtime.lastFailure = { kind: 'failed-evidence', message: actStoppedWhy };
      persist();
      emit('action.finished', { actionId: action.id, status: 'failed', failureKind: 'failed-evidence', why: actStoppedWhy, ...failedFacts(action.id) });
      releaseWorkspace();
      completePresentationStages();
      return;
    }
    if (!result.ok) {
      // Stopped on purpose (a plan revision replaced it, or pause --now): the
      // step is cancelled here and the revision or pause decides what follows.
      const stop = interrupted ? null : stopRequested.get(action.id) ?? null;
      if (stop?.kind === 'restarted') {
        // The caller restarted it: straight back in the queue, never through a
        // terminal state a watcher could read as the step ending.
        Object.assign(runtime, { status: 'pending', finishedAt: null, lastFailure: null });
        persist();
        releaseWorkspace();
        return;
      }
      runtime.status = interrupted ? 'interrupted' : stop || result.status === 'cancelled' ? 'cancelled' : 'failed';
      runtime.lastFailure = interrupted
        ? { kind: 'interrupted', message: 'kernel interrupted; work retained for resume' }
        : stop ? { kind: stop.kind, message: stop.message }
          : {
            kind: result.failureKind, message: result.verdict?.why ?? 'dispatch failed',
            // The dispatcher's time to try again, when it names one: the
            // earliest return among the held pools that can run it, or in
            // marked runs the failed pool's own reset after a usage limit or
            // a rate-limit wait the provider named. The run does not wait for it.
            ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
            // No pool took the step: why, and what ruled each pool out.
            ...(result.routeCandidates ? { route: { why: result.routeWhy ?? null, candidates: clone(result.routeCandidates) } } : {}),
          };
      persist();
      emit('action.finished', {
        actionId: action.id, status: runtime.status, failureKind: stop?.kind ?? result.failureKind, why: stop?.message ?? result.verdict?.why ?? null,
        ...(!stop && !interrupted && result.retryAfter ? { retryAfter: result.retryAfter } : {}),
        ...(runtime.status === 'failed' ? failedFacts(action.id) : {}),
      });
      releaseWorkspace();
      completePresentationStages();
      return;
    }
    if (before) {
      // What a step's own checks left changed in its private copy and could
      // not put back (E11) is a check by-product, not the worker's work: it
      // never fails the gate and never merges back.
      const byProducts = new Set(isolated ? result.checkByProducts ?? [] : []);
      const after = captureManifest(targetDir, { maxFiles: config.maxManifestFiles });
      const ownership = checkOwnership({ before, after, ownedFiles: action.ownedFiles });
      const outOfScope = ownership.outOfScope.filter((path) => !byProducts.has(path));
      if (outOfScope.length) {
        runtime.status = 'failed';
        runtime.lastFailure = { kind: 'ownership', message: `out-of-scope mutation: ${outOfScope.join(', ')}`, ownership };
        persist();
        emit('action.finished', { actionId: action.id, status: 'failed', failureKind: 'ownership', outOfScope, ...failedFacts(action.id) });
        releaseWorkspace();
        completePresentationStages();
        return;
      }
      if (isolated) {
        const integration = integrateWorkspace(isolated, { ownedFiles: action.ownedFiles, maxFiles: config.maxManifestFiles, checkByProducts: [...byProducts] });
        if (!integration.ok) {
          runtime.status = 'failed';
          const paths = integration.concurrent ?? integration.ownership?.outOfScope ?? [];
          runtime.lastFailure = {
            kind: integration.kind === 'conflict' ? 'ownership-conflict' : 'ownership',
            message: integration.kind === 'conflict'
              ? `owned paths changed in the main workspace while the isolated worker ran: ${paths.join(', ')}`
              : `out-of-scope mutation: ${paths.join(', ')}`,
            integration,
          };
          persist();
          emit('action.finished', { actionId: action.id, status: 'failed', failureKind: runtime.lastFailure.kind, paths, ...failedFacts(action.id) });
          releaseWorkspace();
          completePresentationStages();
          return;
        }
        emit('action.workspace_integrated', { actionId: action.id, files: integration.integrated });
      }
    }
    if (review) {
      const inspectedRevisions = Object.fromEntries(action.evidenceFor.map((id) => [id, state.ledger.requirements[id].workRevision]));
      const sequence = state.events.sequence + 1;
      const { reviewer, writers } = reviewFacts(action);
      state.ledger = applyEvidence(state.ledger, {
        actionId: action.id, evidenceFor: action.evidenceFor, inspectedRevisions, eventSequence: sequence,
      }, result.verdict.structured.value, { ...(reviewer ? { reviewer } : {}), writers });
      runtime.status = 'succeeded';
      runtime.artifactIds = [];
      persist();
      emit('evidence.recorded', {
        actionId: action.id, requirements: action.evidenceFor, statuses: Object.fromEntries(action.evidenceFor.map((id) => [id, state.ledger.requirements[id].status])),
        ...(reviewer ? { reviewer } : {}), writers,
      });
    } else {
      runtime.status = 'succeeded';
      runtime.artifactIds = clone(action.produces ?? []);
      // A run resumed from its completion receipt never saw the attempt
      // finish, so its report is read here instead.
      const finished = state.attempts.findLast((attempt) => attempt.actionId === action.id && attempt.status === 'succeeded');
      if (finished && finished.returnedEarly === undefined && !digest) recordReturnedEarly(finished);
      persist();
      // What backs the step (E22): only in a run marked proofLabels, or for a
      // step that declares evidence (E23); never for review or digest steps.
      const proof = stepProof(state, action, { atFinish: true, features: runFeatures });
      emit('action.finished', {
        actionId: action.id, status: 'succeeded', outputFile: runtime.outputFile, artifacts: runtime.artifactIds,
        ...(finished?.returnedEarly ? { returnedEarly: { count: finished.returnedEarly.count } } : {}),
        ...(proof ? { proof } : {}),
        // This dispatch changed nothing; an earlier attempt's work stands (D19).
        ...(finished?.deliverable?.carried === true ? { carried: true } : {}),
      });
    }
    releaseWorkspace();
    completePresentationStages();
    } finally { releaseWorkspace(); }
  };

  const finalize = () => {
    // A signalled kernel is never terminal. This is the ONLY place a lifecycle
    // becomes terminal, so the guard belongs here and not at each call site:
    // the progress check below reached finalize without asking, and a run
    // SIGTERM'd in that window was written out `cancelled` — terminal, with a
    // result.json — instead of the resumable `interrupted` the durability
    // contract promises. Whatever the progress evaluation decided about work
    // the signal itself just stopped, the answer is: resume from it.
    if (interrupted) return pauseInterrupted();
    const finishedAt = now();
    // All worker attempts are durable by this point. Reconcile overlapping
    // subscription meter intervals before publishing the result and rollup so
    // each pool's shares conserve the observed run delta.
    // Last chance to price attempts that finished without usage before the
    // subscription shares, the result and the rollup are computed.
    priceFinishedAttempts();
    reconcileSubscriptionLedger(state);
    // Guidance nobody acted on no longer holds a run open: the result lists
    // it, and the caller decides whether it still matters.
    const unreadSteering = peekSteering(state, runDir);
    const workspace = programExecution ? buildWorkspaceReport(state.intent.cwd, workspaceBaseline, state.program.actions, captureStatus) : null;
    const retainedRoot = join(runDir, 'workspaces');
    if (workspace && existsSync(retainedRoot)) for (const entry of readdirSync(retainedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) workspace.warnings.push(`Inspect retained isolated work at ${join(retainedRoot, entry.name)} before retrying.`);
    }
    const result = createV2ResultEnvelope(state, { finishedAt, plannerExhausted, limitsExhausted, terminalReason, workspace, unreadSteering, features: runFeatures });
    const resultPath = join(runDir, 'result.json');
    writeResultAtomic(resultPath, result);
    spawnRetentionSweep({ bullswarmDir, trigger: 'kernel' });
    state.lifecycle.status = result.status;
    state.lifecycle.finishedAt = finishedAt;
    state.lifecycle.resultFile = resultPath;
    state.planner.status = state.planner.status === 'running' ? 'waiting' : state.planner.status;
    if (programExecution && !['failed', 'cancelled'].includes(state.planner.status)) state.planner.status = result.status === 'cancelled' ? 'cancelled' : 'completed';
    // A terminal run is never waiting for its caller planner; a stale request
    // would otherwise make watch/plan show report a cancelled run as paused.
    state.planner.awaiting = null;
    // Nor is it paused: a cancelled pause is finalized, and its intent file goes.
    state.pause = null;
    rmSync(join(runDir, 'pause.json'), { force: true });
    persist();
    emit('workflow.finished', {
      status: result.status, verified: result.verified, resultFile: resultPath, reason: result.reason,
      ...(result.handback ? { unfinished: result.handback.unfinished.length, unreadSteering: result.handback.unreadSteering.length } : {}),
    });
    // The dashboard's per-run rollup and its history index. The run is
    // already delivered at this point, so a rollup that cannot be written is
    // reported and left for `bullswarm workflow reindex` — it never costs a
    // finished run its result.
    try { writeRunRollup(runDir, state, result, { now: Date.parse(finishedAt) || Date.now() }); }
    catch (error) { console.error(`✗ rollup not recorded for ${id}: ${error.message}; bullswarm workflow reindex backfills it`); }
    return { runId: id, shortId: state.shortId, runDir, state: clone(state), result };
  };

  const runActionSafely = async (action) => {
    try { await runAction(action); }
    catch (error) {
      const runtime = actionState(state, action.id);
      const finishedAt = now();
      const stop = interrupted ? null : stopRequested.get(action.id) ?? null;
      runtime.status = interrupted ? 'interrupted' : stop || refreshCancellation() ? 'cancelled' : 'failed';
      runtime.finishedAt = finishedAt;
      runtime.lastFailure = stop ? { kind: stop.kind, message: stop.message } : { kind: 'runtime', message: error?.message || String(error) };
      for (const attempt of state.attempts) if (attempt.actionId === action.id && attempt.status === 'running') {
        Object.assign(attempt, { status: runtime.status, finishedAt, failureKind: runtime.lastFailure.kind, why: runtime.lastFailure.message });
        runtime.outputFile ??= attempt.outputFile;
      }
      emit('action.finished', {
        actionId: action.id, status: runtime.status, failureKind: runtime.lastFailure.kind, why: runtime.lastFailure.message,
        ...(runtime.status === 'failed' ? failedFacts(action.id) : {}),
      });
      completePresentationStages();
    }
  };
  const activeTasks = new Map();

  // Live control. Callers and operators write intents next to the run (a
  // queued plan revision, pause.json, cancellation.json, steering). The kernel
  // checks for them about once a second even while every agent is busy, so a
  // revision or pause takes effect without waiting for the current step.
  const controlPollMs = dependencies.controlPollMs ?? 1000;
  const pausePath = join(runDir, 'pause.json');
  const pauseMode = (value) => (value === 'now' ? 'now' : 'drain');
  let announcedSteering = null;
  const announcedSteeringIds = () => {
    announcedSteering ??= new Set(readEvents(runDir).filter((event) => event.type === 'steering.received').map((event) => event.payload?.steeringId));
    return announcedSteering;
  };
  const readPauseRequest = () => {
    try {
      if (!existsSync(pausePath)) return null;
      const request = JSON.parse(readFileSync(pausePath, 'utf8'));
      return request?.requested ? request : null;
    } catch { return null; }
  };
  const controlPending = () => {
    try {
      if (existsSync(join(runDir, 'cancellation.json'))) return true;
      const pause = readPauseRequest();
      if (pause ? !state.pause || state.pause.mode !== pauseMode(pause.mode) : Boolean(state.pause && !state.pause.pausedAt)) return true;
      if (programExecution && pendingRevisionRequests(state, runDir).length) return true;
      if (programExecution && readStepRestarts(runDir).some((entry) => !entry.appliedAt)) return true;
      if (programExecution && continuePending(runDir)) return true;
      if (callerPlanner && peekSteering(state, runDir).some((entry) => !announcedSteeringIds().has(entry.id))) return true;
    } catch { /* the next poll retries */ }
    return false;
  };
  // Wait until an active action settles or a control intent arrives.
  const waitForProgress = () => new Promise((resolve) => {
    let settled = false;
    const timer = setInterval(() => { if (controlPending()) done(); }, controlPollMs);
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve();
    };
    if (activeTasks.size) Promise.race(activeTasks.values()).then(done, done);
  });

  const announceSteering = (entries) => {
    const seen = announcedSteeringIds();
    for (const entry of entries) if (!seen.has(entry.id)) {
      seen.add(entry.id);
      emit('steering.received', { steeringId: entry.id, message: entry.message, queuedAt: entry.queuedAt ?? null });
    }
  };

  const planQueuedRevision = (request) => planV2Revision(state, request, {
    pendingSteeringIds: peekSteering(state, runDir).map((entry) => entry.id),
    features,
  });
  const rejectRevision = (request, issues) => {
    state.revisions = [...(state.revisions ?? []), rejectedRevisionRecord(request, issues, now())];
    emit('program.revision_rejected', { requestId: request.id, issues: [...issues], source: request.source ?? 'cli' });
    // The CLI that queued a step rerun may be gone (it returned `queued`):
    // only the kernel can remove the intent its rejected revision left (D20).
    clearRejectedRerunIntent(runDir, request);
  };
  // Stop exactly the running agents the revision replaces, let the rest keep
  // going, then apply the revision to the state they all share.
  const applyQueuedRevision = async (request) => {
    let planned = planQueuedRevision(request);
    if (!planned.ok) return rejectRevision(request, planned.issues);
    const stopping = planned.affected.filter((actionId) => activeTasks.has(actionId));
    if (stopping.length) {
      for (const actionId of stopping) stopRequested.set(actionId, { kind: 'superseded', message: `stopped by plan revision ${request.id}` });
      emit('program.revision_stopping', { requestId: request.id, actionIds: stopping });
      await Promise.allSettled(stopping.map((actionId) => activeTasks.get(actionId)).filter(Boolean));
      for (const actionId of stopping) stopRequested.delete(actionId);
      planned = planQueuedRevision(request);
      if (!planned.ok) return rejectRevision(request, planned.issues);
    }
    const hadActions = state.program.actions.length > 0;
    const committed = commitV2Revision(state, planned, { request, runDir, at: now() });
    applyRevisionLoopBudget(state, request, hadActions, features);
    persist();
    for (const entry of committed.deliveredSteering) {
      emit('steering.delivered', { steeringId: entry.id, message: entry.message, decisionSequence: entry.decisionSequence, source: 'revision' });
    }
    emit('program.revised', revisionEventPayload(committed.record));
    for (const payload of acceptedEventPayloads(planned)) emit('step.accepted', payload);
    removeStaleReceipts(runDir, committed.staleReceipts);
  };

  // --- The repair loop (verify-rounds.js) -----------------------------------
  // A kernel step is an ordinary program step added by a kernel-source plan
  // revision, so scheduling, dispatch, cost, pages and resume need no second
  // path. The loop record is written first: validation reads the repair's id
  // from it. Returns false (and records the rejection) when the revision is
  // not accepted.
  const applyKernelLoopStep = (action, { round, kind }) => {
    const base = `kernel-loop-${round}-${kind}`;
    const taken = new Set((state.revisions ?? []).map((entry) => entry.id));
    let requestId = base;
    for (let k = 2; taken.has(requestId); k += 1) requestId = `${base}-${k}`;
    const request = {
      id: requestId, source: 'kernel', queuedAt: now(),
      summary: kind === 'repair' ? `Kernel repair after verify round ${round}: ${action.affects.join(', ')}` : `Kernel verify round ${round}: re-check ${action.evidenceFor.join(', ')}`,
      baseRevision: state.program.revision,
      program: { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, actions: [...exportV2Plan(state).program.actions, action] },
      rerun: [], steeringIds: [],
    };
    const planned = planV2Revision(state, request, { pendingSteeringIds: [], features });
    if (!planned.ok) { rejectRevision(request, planned.issues); return false; }
    const committed = commitV2Revision(state, planned, { request, runDir, at: now() });
    persist();
    emit('program.revised', revisionEventPayload(committed.record));
    removeStaleReceipts(runDir, committed.staleReceipts);
    return true;
  };

  // At the boundary where every live step has succeeded: close the open
  // round, add a repair while rounds remain, or add the next round's verify
  // step once a repair succeeded. True when a step was added (the run goes
  // on); false when the run finishes now. With `repairableOnly` (marked runs
  // at `partial`, D12) only the requirements whose writers all succeeded and
  // that a succeeded check judged are repaired. The kernel's steps inherit
  // the route of the steps they stand for (D19); in a marked run a files
  // repair also runs their evidence (D33).
  const advanceVerifyLoop = (options = {}) => {
    if (!repairLoopApplies(runFeatures)) return false;
    const added = advanceVerifyLoopStep(options);
    if (!added && features.failureRule) wakeLateFailures();
    return added;
  };

  // F11, marked runs: the loop finishes with a failing requirement its last
  // closed round never listed (a check that ran after the loop stopped found
  // it). The caller is told with one finished round event naming it, so the
  // needs-you block wakes; the run finishes right after, so it is sent once.
  const wakeLateFailures = () => {
    const last = state.verifyLoop?.rounds.at(-1);
    if (!last || last.closedAt == null) return;
    const listed = new Set(last.failed);
    const late = failingRequirements(state).filter((id) => !listed.has(id));
    if (!late.length) return;
    emit('workflow.verify-round', { round: last.round, of: state.verifyLoop.max, stage: 'finished', passed: [], failed: late, discovery: 0, next: 'caller' });
  };

  const advanceVerifyLoopStep = ({ repairableOnly = false } = {}) => {
    const loop = programExecution ? state.verifyLoop : null;
    if (!loop) return false;
    // The step that stopped the loop has succeeded since (resume, revision).
    if (loop.stoppedBy === 'step-failed') loop.stoppedBy = null;
    for (let guard = 0; guard < 8; guard += 1) {
      const next = nextLoopStep(state, { repairableOnly });
      if (next.step === 'close-round') {
        emit('workflow.verify-round', closeRound(state, { at: now() }));
        continue;
      }
      if (next.step === 'add-repair') {
        const round = loop.rounds.at(-1);
        const plan = planRepairStep(state, { repairableOnly, inheritRoute: true, inheritEvidence: features.failureRule });
        Object.assign(round, plan.record, { repairStartedAt: now() });
        if (!applyKernelLoopStep(plan.action, { round: round.round, kind: 'repair' })) {
          Object.assign(round, { repairActionId: null, repairRequirements: [], repairOwnedFiles: [], repairUnrestricted: false, repairStartedAt: null });
          loop.stoppedBy = 'revision';
          persist();
          return false;
        }
        emit('workflow.repair', {
          round: round.round, stage: 'started', actionId: plan.action.id, requirements: [...round.repairRequirements],
          ownedFiles: [...round.repairOwnedFiles], unrestricted: round.repairUnrestricted, discovery: round.discovery.length,
          ...(features.failureRule ? { evidenceInherited: plan.evidenceCounts?.inherited ?? 0, evidenceDropped: plan.evidenceCounts?.dropped ?? 0 } : {}),
        });
        return true;
      }
      if (next.step === 'finish-repair') {
        const round = loop.rounds.at(-1);
        const changed = repairChangedFiles(state, round.repairActionId);
        round.changedFiles = changed;
        round.repairFinishedAt = now();
        const recheck = recheckSet(state, round, changed);
        // Passed requirements whose evidence names a file the repair changed
        // read pending until a round judges them again; the rest carry forward.
        if (recheck.touched.length) state.ledger = invalidateRequirements(state.ledger, recheck.touched, `loop-${round.round}-touched`);
        emit('workflow.repair', {
          round: round.round, stage: 'finished', actionId: round.repairActionId, status: 'succeeded',
          changedFiles: changed == null ? null : changed.length, recheck: recheck.toJudge.length,
        });
        if (!recheck.toJudge.length || round.round >= loop.max) {
          loop.stoppedBy = recheck.toJudge.length ? 'rounds' : 'passed';
          persist();
          return false;
        }
        const verify = planVerifyStep(state, { round: round.round + 1, repairActionId: round.repairActionId, toJudge: recheck.toJudge, inheritRoute: true });
        const opened = openNextRound(state, { verifyActionId: verify.id, toJudge: recheck.toJudge, carried: recheck.carried, at: now() });
        if (!applyKernelLoopStep(verify, { round: opened.round, kind: 'verify' })) {
          loop.rounds.pop();
          loop.stoppedBy = 'revision';
          persist();
          return false;
        }
        emit('workflow.verify-round', {
          round: opened.round, of: loop.max, stage: 'started', steps: [...opened.verifyActionIds],
          toJudge: [...opened.toJudge], carried: [...opened.carried],
        });
        return true;
      }
      if (next.stoppedBy && loop.stoppedBy !== next.stoppedBy) { loop.stoppedBy = next.stoppedBy; persist(); }
      return false;
    }
    return false;
  };

  // D12, marked runs only: a failed step elsewhere no longer cancels the
  // repair of an independent failed review. The open round closes even when
  // some of its checks did not succeed (their requirements stay failing and go
  // to the caller), then the loop repairs what it still can. True when a step
  // was added.
  const advanceVerifyLoopAtPartial = () => {
    const loop = programExecution ? state.verifyLoop : null;
    if (!loop) return false;
    const open = loop.rounds.at(-1);
    if (open && open.closedAt == null) {
      // F16: a round with a check that did not succeed closes here only when
      // one of its checks judged a requirement failing. When every failure
      // waits on a check that never judged it, the round stays open: the
      // failed step's own needs-you covers it, and once the caller reruns that
      // step the round finishes as usual.
      const checksDone = open.verifyActionIds.filter((id) => actionState(state, id)?.status !== 'removed')
        .every((id) => actionState(state, id)?.status === 'succeeded');
      const toJudge = new Set(open.toJudge);
      const judgedFailure = failingRequirements(state, open)
        .some((id) => toJudge.has(id) && ['failed', 'blocked'].includes(state.ledger.requirements[id]?.status));
      if (!checksDone && !judgedFailure) return false;
      const closed = closeRound(state, { at: now(), partial: true });
      if (closed) emit('workflow.verify-round', closed);
    }
    return advanceVerifyLoop({ repairableOnly: true });
  };

  // F13: D12's close-and-repair belongs to a `partial` that failed steps
  // caused: every live step reached its end and one of them failed. A partial
  // a limit or the planner caused while steps are still pending settles as in
  // saved runs.
  const partialFromFailedSteps = () => {
    if (limitsExhausted || plannerExhausted) return false;
    const live = state.program.actions.map((action) => actionState(state, action.id)?.status ?? 'pending').filter((status) => status !== 'removed');
    return live.every((status) => ['succeeded', 'failed', 'blocked'].includes(status)) && live.includes('failed');
  };

  // A run that finishes because a step failed: a round whose verify steps all
  // finished is closed (its failures go to the caller), and the loop records
  // that a step stopped it once a round has closed.
  const settleVerifyLoopAtPartial = () => {
    const loop = programExecution ? state.verifyLoop : null;
    if (!loop) return;
    const open = loop.rounds.at(-1);
    if (open && open.closedAt == null && open.verifyActionIds.every((id) => actionState(state, id)?.status === 'succeeded')) {
      emit('workflow.verify-round', { ...closeRound(state, { at: now() }), next: 'caller' });
    }
    if (!loop.stoppedBy && loop.rounds.some((round) => round.closedAt != null)) loop.stoppedBy = 'step-failed';
  };

  // A caller restart (workflow step restart): stop exactly that step's running
  // attempt, then queue the step again; its next attempt carries the handoff.
  const applyStepRestart = async (request) => {
    const task = activeTasks.get(request.actionId);
    if (task) {
      stopRequested.set(request.actionId, { kind: 'restarted', message: `stopped by the caller with workflow step restart (${request.id})` });
      await Promise.allSettled([task]);
      stopRequested.delete(request.actionId);
      if (actStoppedByRestart.delete(request.actionId)) {
        clearStepRestart(runDir, request.actionId);
        emit('step.restart_refused', {
          requestId: request.id, actionId: request.actionId,
          why: 'an act step whose worker had finished may already have acted; its checks were stopped and it went to you (run it again with plan revise --rerun)',
        });
        return;
      }
    }
    const outcome = requeueRestartedStep(state, request);
    if (!outcome.requeued) {
      clearStepRestart(runDir, request.actionId);
      emit('step.restart_refused', { requestId: request.id, actionId: request.actionId, why: outcome.why });
      return;
    }
    markStepRestartApplied(runDir, request, { at: now(), attemptId: outcome.attemptId });
    emit('step.restarted', {
      requestId: request.id, actionId: request.actionId, attemptId: outcome.attemptId,
      stoppedPool: outcome.stoppedPool, pool: request.pool ?? null, source: request.source ?? 'cli',
    });
  };

  const requeuePausedActions = () => {
    const requeued = [];
    for (const action of state.actions) if (action.status === 'cancelled' && action.lastFailure?.kind === 'paused') {
      Object.assign(action, { status: 'pending', finishedAt: null, lastFailure: null });
      requeued.push(action.id);
    }
    return requeued;
  };
  const clearPauseStops = () => {
    for (const [actionId, stop] of stopRequested) if (stop.kind === 'paused') stopRequested.delete(actionId);
  };
  // Returns the paused kernel result once nothing runs, or null: either there
  // is no pause, or it is still draining (state.pause set) and the loop waits.
  const honorPause = async () => {
    const request = readPauseRequest();
    if (!request && state.pause) {
      // The intent file is gone: `workflow resume` either withdrew a pause that
      // had not taken effect, or lifted one a previous kernel completed. The
      // lift happens here, under this kernel's lease, so no watcher ever sees
      // the run as running before a live kernel owns it.
      const resumed = Boolean(state.pause.pausedAt);
      clearPauseStops();
      state.pause = null;
      if (state.lifecycle.status === 'paused') state.lifecycle.status = state.planner.awaiting ? 'waiting' : 'running';
      emit('workflow.unpaused', { source: resumed ? 'resume' : 'withdrawn', requeued: requeuePausedActions() });
      return null;
    }
    if (request && (!state.pause || state.pause.mode !== pauseMode(request.mode))) {
      const first = !state.pause;
      state.pause = {
        requestedAt: state.pause?.requestedAt ?? request.requestedAt ?? now(),
        mode: pauseMode(request.mode),
        source: typeof request.source === 'string' && request.source ? request.source : 'operator',
        pausedAt: state.pause?.pausedAt ?? null,
      };
      if (first && !state.pause.pausedAt) emit('workflow.pause_requested', { mode: state.pause.mode, source: state.pause.source, running: [...activeTasks.keys()] });
      else persist();
    }
    if (!state.pause) return null;
    if (state.pause.mode === 'now') {
      for (const actionId of activeTasks.keys()) if (!stopRequested.has(actionId)) {
        stopRequested.set(actionId, { kind: 'paused', message: 'stopped by workflow pause; it runs again after resume' });
      }
    }
    if (activeTasks.size) { await waitForProgress(); return null; }
    clearPauseStops();
    const requeued = requeuePausedActions();
    const already = Boolean(state.pause.pausedAt);
    state.pause.pausedAt ??= now();
    state.lifecycle.status = 'paused';
    if (already && !requeued.length) persist();
    else emit('workflow.paused', { mode: state.pause.mode, source: state.pause.source, requeued, kernel: true });
    return { runId: id, shortId: state.shortId, runDir, state: clone(state), result: null, paused: clone(state.pause) };
  };

  // A quiet worker is not a dead coordinator. Keep this independent of the
  // provider's output/progress callbacks, and stop it on every exit path.
  const startInterval = dependencies.setInterval ?? setInterval;
  const stopInterval = dependencies.clearInterval ?? clearInterval;
  let heartbeatErrorReported = false;
  const heartbeat = startInterval(() => {
    try { refreshCancellation(); persist(); heartbeatErrorReported = false; }
    catch (error) {
      if (!heartbeatErrorReported) process.stderr.write(`workflow ${id} heartbeat could not be persisted: ${error.message}\n`);
      heartbeatErrorReported = true;
    }
  }, 10_000);
  heartbeat.unref?.();
  ACTIVE_RUNS.add(runDir);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const pauseInterrupted = () => {
    state.lifecycle.status = 'interrupted';
    state.lifecycle.finishedAt = null;
    for (const action of state.actions) if (['running', 'cancelled'].includes(action.status)) {
      action.status = 'interrupted'; action.finishedAt = now();
      action.lastFailure = { kind: 'interrupted', message: 'kernel interrupted by signal; work retained for resume' };
    }
    if (['running', 'failed', 'cancelled'].includes(state.planner.status)) state.planner.status = 'pending';
    if (['running', 'failed', 'cancelled'].includes(state.preflight.scout.status)) state.preflight.scout.status = 'pending';
    emit('workflow.interrupted', { reason: 'kernel received SIGTERM or SIGINT; delegate processes drained' });
    return { runId: id, shortId: state.shortId, runDir, state: clone(state), result: null };
  };
  try {
    for (;;) {
      if (refreshCancellation()) {
        await Promise.all(activeTasks.values());
        if (interrupted) return pauseInterrupted();
        if (programExecution) for (const action of state.actions) if (['pending', 'ready', 'waiting'].includes(action.status)) {
          action.status = 'cancelled';
          action.finishedAt = now();
          action.lastFailure = { kind: 'cancelled', message: 'cancelled before dispatch' };
          emit('action.finished', { actionId: action.id, status: 'cancelled', why: action.lastFailure.message });
        }
        return finalize();
      }
      // A queued plan revision applies before anything else is decided, so
      // nothing is scheduled from a plan the caller has already replaced.
      if (programExecution) {
        const [request] = pendingRevisionRequests(state, runDir);
        if (request) {
          await applyQueuedRevision(request);
          continue;
        }
        const restart = readStepRestarts(runDir).find((entry) => !entry.appliedAt);
        if (restart) {
          await applyStepRestart(restart);
          continue;
        }
      }
      const paused = await honorPause();
      if (paused) return paused;
      if (state.pause) continue;
      // A run left waiting for its caller by a version before 0.30.0. Resuming
      // it without a submission finishes it and hands the decision back, like
      // every other point that needs the caller (plan submit still answers it).
      if (callerPlanner && state.planner.awaiting) {
        const { boundary } = state.planner.awaiting;
        state.planner.awaiting = null;
        if (state.lifecycle.status === 'waiting') state.lifecycle.status = state.program.actions.length ? 'running' : 'planning';
        const handed = handBackToCaller(boundary);
        plannerExhausted = true;
        terminalReason = handed.reason;
        continue;
      }
      if (state.preflight.scout.status === 'pending') {
        const scouted = await runScout();
        if (interrupted) return pauseInterrupted();
        // Marked runs: a scout stopped on a usage limit, or with no pool free,
        // goes to the caller when no program is there to run (--scout alone,
        // or before a dispatched planner). A caller's program runs without
        // the report.
        if (stoppedOnLimit(scouted) && !pendingInitialResponse && !state.program.actions.length) {
          limitsExhausted = true;
          terminalReason = limitStopReason('the preflight scout', {
            failureKind: scouted.failureKind, retryAfter: scouted.retryAfter ?? null, why: scouted.verdict?.why ?? null,
          }, state.shortId ?? id);
          // The stop ended the run: `workflow resume` reads this record to
          // run the scout again. A scout the run went on without has none.
          state.preflight.scout.limitStop = { failureKind: scouted.failureKind, retryAfter: returnTimeOrNull(scouted.retryAfter), at: now() };
          return finalize();
        }
        if (!scouted.ok && !programExecution) {
          limitsExhausted = true;
          terminalReason = `repository preflight could not produce a valid report: ${scouted.verdict?.why ?? scouted.failureKind}`;
          return finalize();
        }
        continue;
      }
      if (state.program.actions.length) {
        unblockControlNodes(state, { at: now() }); // a gate or loop whose failed step was recovered (gates-loops.js)
        const graph = schedulerView(state);
        const blockedSchedule = scheduleV2Actions(graph.actions, graph.states, schedulingOptions);
        for (const blocked of blockedSchedule.blocked) {
          const runtime = actionState(state, blocked.id);
          if (runtime && !['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(runtime.status)) {
            runtime.status = 'blocked';
            runtime.finishedAt = now();
            runtime.lastFailure = { kind: 'dependency', message: blocked.reason };
            startPresentationStage(blocked.id);
            emit('action.finished', { actionId: blocked.id, status: 'blocked', why: blocked.reason });
            completePresentationStages();
          }
        }
      }
      // Program v3: gates and loops move, and a run where only waiting gates
      // or loops are left parks as waiting (gates-loops.js).
      const control = kernelControlPass(state, { runDir, at: now(), emit, features, active: activeTasks.size, schedulingOptions });
      if (control?.changed) { persist(); continue; }
      if (control?.waiting) return { runId: id, shortId: state.shortId, runDir, state: clone(state), result: null, waiting: control.waiting };
      const pendingSteering = peekSteering(state, runDir);
      // A caller can revise the live plan at any time, so steering never halts
      // its run: it is announced once (a --next watcher wakes on it) and stays
      // pending until a revision consumes it. A run that finishes first lists
      // it in the result as not acted on.
      if (pendingSteering.length && callerPlanner) announceSteering(pendingSteering);
      else if (pendingSteering.length && state.program.actions.length) {
        if (activeTasks.size) { await waitForProgress(); continue; }
        const planned = await runPlanner('steering');
        if (!planned.ok) {
          if (planned.status === 'cancelled') continue;
          limitsExhausted = true;
          terminalReason = stoppedOnLimit(planned)
            ? plannerLimitReason(planned)
            : `the workflow planner could not incorporate queued steering: ${planned.verdict?.why ?? planned.failureKind}`;
        }
        continue;
      }
      // A quiet boundary: no worker is streaming, so pricing the attempts that
      // finished without usage delays nothing, and what it priced is durable now.
      if (!activeTasks.size && priceFinishedAttempts()) persist();
      const progress = evaluateV2Progress(state, { plannerExhausted, limitsExhausted, terminalReason });
      // A step whose dispatch is still in flight (its task has not settled)
      // may already read as finished: the run never finishes, repairs or
      // re-plans under it.
      if (activeTasks.size && ['ready-to-finalize', 'partial', 'needs-planner'].includes(progress.status)) {
        await waitForProgress();
        continue;
      }
      // The repair loop decides at the boundary before the run may finish.
      if (progress.status === 'ready-to-finalize' && !interrupted && advanceVerifyLoop()) continue;
      if (progress.status === 'partial' && !interrupted) {
        if (features.failureRule && partialFromFailedSteps() && advanceVerifyLoopAtPartial()) continue;
        settleVerifyLoopAtPartial();
      }
      if (['ready-to-finalize', 'partial', 'cancelled'].includes(progress.status)) return finalize();
      if (progress.status === 'needs-planner') {
        const planned = await runPlanner(progress.boundary);
        if (!planned.ok) {
          if (planned.status === 'handed-back') {
            plannerExhausted = true;
            terminalReason = planned.reason;
            continue;
          }
          if (planned.status === 'cancelled') continue;
          limitsExhausted = true;
          terminalReason = stoppedOnLimit(planned)
            ? plannerLimitReason(planned)
            : `the workflow planner could not produce a mechanically valid program: ${planned.verdict?.why ?? planned.failureKind}`;
        } else if (planned.accepted.kind === 'exhausted') {
          plannerExhausted = true;
          terminalReason = planned.accepted.reason;
        }
        continue;
      }
      const graph = schedulerView(state);
      const schedule = scheduleV2Actions(graph.actions, graph.states, schedulingOptions);
      const selected = schedule.selected;
      if (!selected.length) {
        if (activeTasks.size) { await waitForProgress(); continue; }
        limitsExhausted = true;
        terminalReason = 'the workflow has unfinished work but no dependency-ready action can run';
        continue;
      }
      state.lifecycle.status = 'running';
      state.planner.status = 'waiting';
      persist();
      if (programExecution) {
        for (const actionId of selected) {
          const task = runActionSafely(actionDefinition(state, actionId)).finally(() => {
            activeTasks.delete(actionId);
          });
          activeTasks.set(actionId, task);
        }
        await waitForProgress();
      } else {
        await Promise.all(selected.map((actionId) => runActionSafely(actionDefinition(state, actionId))));
      }
    }
  } finally {
    await Promise.allSettled(activeTasks.values());
    stopInterval(heartbeat);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    ACTIVE_RUNS.delete(runDir);
  }
}

export async function runV2AutonomousWorkflow(options = {}) {
  const { bullswarmDir, resumeRunId } = options;
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const id = resumeRunId ?? options.runId ?? newRunId();
  if (!/^wf-[a-z0-9]+-[a-f0-9]{6}$/.test(id)) throw new TypeError(`invalid V2 runId "${id}"`);
  const runDir = join(bullswarmDir, 'workflows', id);
  if (ACTIVE_RUNS.has(runDir)) throw new Error(`run ${id} already has an active kernel`);
  if (!resumeRunId && existsSync(runDir)) throw new Error(`cannot start: run ${id} already exists`);
  mkdirSync(runDir, { recursive: true });
  const lease = acquireKernelLease(runDir);
  try { return await runV2Kernel({ ...options, runId: id, lease }); }
  catch (error) {
    markKernelStopped(runDir, lease, error);
    throw error;
  }
  finally { lease.release(); }
}

// A kernel that throws must not leave its run claiming to be running: that
// run looked alive to nobody and finished for nobody (dskxrs, 2026-09-10).
// Record the error where watch and runs show read it; the run resumes like any
// interrupted run.
function markKernelStopped(runDir, lease, error) {
  try {
    lease.assertOwner();
    if (!existsSync(statePath(runDir))) return;
    const state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
    if (V2_TERMINAL_STATUSES.has(state.lifecycle.status) || ['interrupted', 'paused'].includes(state.lifecycle.status)) return;
    const message = String(error?.message ?? error).split(/\r?\n/, 1)[0].slice(0, 500) || 'unknown error';
    const at = new Date().toISOString();
    state.lifecycle.status = 'interrupted';
    for (const action of state.actions) if (action.status === 'running') {
      Object.assign(action, { status: 'interrupted', finishedAt: at, lastFailure: { kind: 'runtime', message: `kernel stopped: ${message}` } });
    }
    appendEvent(runDir, state, 'workflow.interrupted', { reason: `kernel stopped on an error: ${message}` });
    writeRunState(runDir, state);
  } catch { /* readers still report the dead kernel through its liveness check */ }
}
