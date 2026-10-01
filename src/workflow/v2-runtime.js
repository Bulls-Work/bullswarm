import { withV2Cancellation } from './v2-cancellation.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { appendEvent, readEvents } from './events.js';
import {
  commitV2Revision, pendingRevisionRequests, planV2Revision, rejectedRevisionRecord, removeStaleReceipts,
  revisionEventPayload, acceptedEventPayloads,
} from './v2-revision.js';
import { generateShortId, isProcessAlive, listRuns, newRunId, v2RunnerLiveness } from './short-id.js';
import { invalidateRequirements } from './ledger.js';
import { captureWorkspaceManifest, checkOwnership } from './ownership.js';
import { scheduleV2Actions } from './v2-scheduler.js';
import {
  actionDefinition, actionState, assertV2Resume, createV2DurableState, deserializeV2DurableState,
  serializeV2DurableState, statePath, validateV2GoalDocument, writeRunState,
} from './v2-state.js';
import { V2_TERMINAL_STATUSES } from './status.js';
import { clone } from '../lib/clone.js';
import { validateV2PlannerResponse, V2PlannerValidationError } from './v2-planner.js';
import { recordGoalProject } from './goal.js';
import { writeRunRollup } from './rollup.js';
import {
  consolidateV2Gaps, createV2ResultEnvelope, deserializeV2ResultEnvelope, evaluateV2Progress, stepProof,
} from './v2-outcome.js';
import {
  appliedStepRestart, clearStepRestart, dispatchV2Action, durableAttemptHandoff, markStepRestartApplied,
  readStepRestarts, requeueRestartedStep,
} from './v2-dispatch.js';
import { countRefusalRepicks, countRetries, declaredEvidence, poolCausedPools, roleOf } from './step-vocabulary.js';
import { resolveRouteFilter } from './step-route.js';
import { rewriteEvidenceCwd } from './evidence-runner.js';
import { EVIDENCE_RUNNING_NOTE, evidenceRunning } from '../lib/stale.js';
import {
  STAGE3_RUN_FEATURES, isProgramV3Run, readRunFeatures, runFeatureFlags, withProgramFormat, writeRunFeatures,
} from './run-features.js';
import { isProgramV3 } from './program-v3.js';
import { viewOnlyRunLine } from './cli-run-lookup.js';
import { PROGRAM_V2_REFUSAL, ProgramV2RefusedError } from './cli-program-checks.js';
import { settleStepAnswer, stepAnswerHooks } from './answers.js';
import { continuePending, evidenceIsCondition, kernelControlPass, schedulerView, unblockControlNodes } from './gates-loops.js';
import { createPoolRefresher } from './pool-refresh.js';
import { createIsolatedWorkspace, disposeIsolatedWorkspace, integrateIsolatedWorkspace } from './v2-workspace.js';
import { presentationStageStatus, stageForAction } from './v2-presentation.js';
import { peekSteering } from './steering.js';
import { enforcesOwnership, isProgramWorkflow, v2SchedulingOptions } from './execution-policy.js';
import { buildWorkspaceReport, captureWorkspaceStatus } from './workspace-report.js';
import { acquireKernelLease, processIdentity, liveWorker, stopWorker } from './v2-process.js';
import { reconcileRunState } from './reconcile.js';
import { spawnRetentionSweep } from '../lib/retention.js';
import { timeBoxForAttempt, timeBoxHistory } from './time-box.js';
import { addUsage, reconcileSubscriptionLedger } from './usage-ledger.js';
import {
  normalizeAttempt, evidenceOutcomePayload, receiptVerdict, recordReturnedEarly, recordAttemptCapture,
  settleFinishedAttempt,
} from './attempt-record.js';
import { handoffBlock } from './retry-handoff.js';
import { buildWorkTask } from './step-prompts.js';
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
});

function settings(state) { return { ...DEFAULTS, ...(state.config.settings ?? {}) }; }

function goalPath(runDir) { return join(runDir, 'goal.json'); }

function cancellationRequested(runDir, state) {
  if (state.cancellation?.requested) return true;
  try { return JSON.parse(readFileSync(join(runDir, 'cancellation.json'), 'utf8'))?.requested === true; } catch { return false; }
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
    // 0.38.0 (D1): only a run marked programFormat 3 is driven. An earlier
    // Bullswarm's run stays view-only here too, so a direct kernel start
    // cannot drive it either (the CLI's drivableRunRefusal says the same).
    // A requested cancellation is the one exception: `workflow cancel`
    // finalizes such a run through this kernel, which dispatches nothing.
    if (!isProgramV3Run(readRunFeatures(runDir)) && !cancellationRequested(runDir, state)) throw new Error(viewOnlyRunLine(state.shortId ?? id));
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
  let pendingInitialResponse = initialPlannerResponse ? clone(initialPlannerResponse) : null;
  // A caller program supplied at launch is kept in the run directory until the
  // kernel applies it, so an interruption before the initial boundary does
  // not lose it: the resume applies it instead of pausing to ask for a
  // program the caller already authored.
  const pendingInitialPath = join(runDir, 'initial-planner-response.json');
  if (pendingInitialResponse) writeJsonAtomic(pendingInitialPath, pendingInitialResponse);
  else if (resuming && state.planner.turns === 0 && !state.planner.awaiting && existsSync(pendingInitialPath)) {
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

  // The kernel never dispatches a planner (0.38.0): the caller's program at
  // launch is applied, and every later point that needs a plan hands back.
  const runPlanner = async (boundary) => {
    if (pendingInitialResponse && boundary === 'initial') return applyInitialCallerProgram(boundary);
    return handBackToCaller(boundary);
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
    emit('action.started', { actionId: action.id, purpose: action.purpose, evidence: action.evidenceFor.length > 0 });
    const baseAttemptOrdinal = runtime.attempts;
    const runWideAttemptId = (local) => {
      const prefix = `${action.id}-`;
      const ordinal = String(local).startsWith(prefix) ? Number(String(local).slice(prefix.length)) : NaN;
      return Number.isInteger(ordinal) && ordinal > 0 ? `${action.id}-${baseAttemptOrdinal + ordinal}` : local;
    };
    let isolated = receipt?.isolated ?? null;
    const isolatedName = `${action.id}-attempt-${baseAttemptOrdinal + 1}-${Date.now().toString(36)}`;
    if (!receipt && action.ownedFiles.length && schedulerWorkspaceMode === 'isolated') {
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
    const answerHooks = programV3 ? stepAnswerHooks(action, { attempt: workerAttempt }) : null;
    const persistWorkerProgress = () => {
      const time = Date.now();
      if (time - lastProgressPersist >= 1000) { lastProgressPersist = time; persist(); }
    };
    let result;
    if (!receipt) await syncPools();
    // Composed once, so the byte ledger below measures exactly the text this
    // attempt was handed rather than a second rendering of it.
    const taskText = buildWorkTask(state, action, targetDir, runDir);
    const observedRequirementBytes = embeddedRequirementBytes(state, action);
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
    const dispatchedBytes = attemptBytes(state, action, dispatchedTaskText);
    // An isolated copy runs each `cmd` against its own path, as its brief says;
    // the stored definition keeps the caller's path.
    const dispatchedAction = isolated && declaredEvidence(action).length
      ? { ...action, evidence: rewriteEvidenceCwd(declaredEvidence(action), state.intent.cwd, targetDir) }
      : action;
    // Every dispatched task closes with a soft
    // time box, composed per attempt at dispatch (the pool and the clock exist
    // only then). A box that cannot be composed is left out, never fatal.
    let boxBytes = 0;
    const timeBox = ({ pool, startedAt }) => {
      let boxed = null;
      try {
        boxed = timeBoxForAttempt({
          action, pool, startedAt,
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
      taskText: dispatchedTaskText,
      targetDir,
      paths: (ordinal) => ({ taskFile: join(runDir, `task-${action.id}-attempt-${baseAttemptOrdinal + ordinal}.md`), outFile: join(runDir, `out-${action.id}-attempt-${baseAttemptOrdinal + ordinal}.md`) }),
      pools, refreshPools, bullswarmDir, runId: id, parentEnv,
      preferredPool: restart?.pool ?? state.config.workerRouting?.pool ?? state.config.workerRouting?.preferredPool ?? null,
      // The step's own model outranks the run-wide pin.
      preferredModel: action.model ?? state.config.workerRouting?.model ?? state.config.workerRouting?.preferredModel ?? null,
      strictPool: restart?.pool ?? state.config.workerRouting?.strictPool ?? state.config.workerRouting?.pool ?? null,
      // The program author's per-action override outranks the run-wide level.
      reasoningOverride: action.reasoning ?? null,
      runReasoning: state.config.workerRouting?.reasoning ?? null,
      maxMechanicalRetries: action.retry ?? config.maxMechanicalRetries,
      // A loop's evidence-form `until` step: failed checks read "not passed".
      evidenceAsCondition: evidenceIsCondition(state, action),
      // One automatic retry per step, counted from stored `retryOf` facts so
      // a kernel resume neither refunds nor spends it.
      retriesAlready: countRetries(state, action.id, runtime.supersededAttempts ?? 0),
      // The refusal re-pick bound is the step's too (MAX_REFUSAL_REPICKS).
      refusalsAlready: countRefusalRepicks(state, action.id, runtime.supersededAttempts ?? 0),
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
      outputValidator: answerHooks?.outputValidator ?? null,
      correctionTask: answerHooks?.correctionTask ?? null,
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
          // The stored attempt promised a retry no pool could take. Its status
          // and why change; it adds no usage, writes no receipt and settles
          // nothing.
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
            if (record.status === 'succeeded') recordReturnedEarly(attempt);
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
    runtime.outputFile = result.verdict?.outFile ?? result.attempts.at(-1)?.outFile ?? null;
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
    runtime.status = 'succeeded';
    runtime.artifactIds = clone(action.produces ?? []);
    // A run resumed from its completion receipt never saw the attempt
    // finish, so its report is read here instead.
    const finished = state.attempts.findLast((attempt) => attempt.actionId === action.id && attempt.status === 'succeeded');
    if (finished && finished.returnedEarly === undefined) recordReturnedEarly(finished);
    persist();
    // What backs the step (E22): only in a run marked proofLabels, or for a
    // step that declares evidence (E23).
    const proof = stepProof(state, action, { atFinish: true, features: runFeatures });
    emit('action.finished', {
      actionId: action.id, status: 'succeeded', outputFile: runtime.outputFile, artifacts: runtime.artifactIds,
      ...(finished?.returnedEarly ? { returnedEarly: { count: finished.returnedEarly.count } } : {}),
      ...(proof ? { proof } : {}),
      // This dispatch changed nothing; an earlier attempt's work stands (D19).
      ...(finished?.deliverable?.carried === true ? { carried: true } : {}),
    });
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
      if (peekSteering(state, runDir).some((entry) => !announcedSteeringIds().has(entry.id))) return true;
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
    const committed = commitV2Revision(state, planned, { request, runDir, at: now() });
    persist();
    for (const entry of committed.deliveredSteering) {
      emit('steering.delivered', { steeringId: entry.id, message: entry.message, decisionSequence: entry.decisionSequence, source: 'revision' });
    }
    emit('program.revised', revisionEventPayload(committed.record));
    for (const payload of acceptedEventPayloads(planned)) emit('step.accepted', payload);
    removeStaleReceipts(runDir, committed.staleReceipts);
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
      if (pendingSteering.length) announceSteering(pendingSteering);
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
      if (['ready-to-finalize', 'partial', 'cancelled'].includes(progress.status)) return finalize();
      if (progress.status === 'needs-planner') {
        const planned = await runPlanner(progress.boundary);
        if (!planned.ok) {
          plannerExhausted = true;
          terminalReason = planned.reason;
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
  // 0.38.0 (D2): a new run takes a program v3 only, whichever caller starts
  // it (the CLI, a --request relaunch, a direct call), and the refusal comes
  // before the run folder exists. `dependencies.savedRunTwin` is the one
  // exception, for tests only (no CLI path passes dependencies): it builds a
  // run the way an earlier Bullswarm did, which is then view-only like one.
  if (!resumeRunId && options.dependencies?.savedRunTwin !== true && !isProgramV3(options.initialPlannerResponse)) {
    throw new ProgramV2RefusedError(PROGRAM_V2_REFUSAL);
  }
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
