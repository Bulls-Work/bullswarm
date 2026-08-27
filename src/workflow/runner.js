// bullswarm workflow runner — load, validate, execute phases, report.
//
// Phase semantics:
//   step onError: continue | fail (abort whole run) | skip-phase
//   settings.stopOnPhaseFailure: abort after a phase with any failure
// Resume: steps whose recorded verdict is ok:true are skipped (R2).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateWorkflow } from './validate.js';
import { WorkflowRuntime } from './runtime.js';
import { generateShortId, listRuns } from './short-id.js';
import {
  validateDecisionProposal, normalizeDecisionProposal, DecisionValidationError,
} from './decision.js';

export function loadWorkflow(pathOrName, searchDirs) {
  let path = pathOrName;
  if (!path.endsWith('.json')) {
    const candidates = searchDirs.flatMap((d) => [
      join(d, `${pathOrName}.json`),
      join(d, pathOrName, 'workflow.json'),
    ]);
    path = candidates.find((p) => existsSync(p));
    if (!path) {
      throw new Error(`workflow "${pathOrName}" not found in: ${searchDirs.join(', ')}`);
    }
  }
  if (!existsSync(path)) throw new Error(`workflow file not found: ${path}`);
  return {
    doc: JSON.parse(readFileSync(path, 'utf8')),
    path,
  };
}

export function newRunId() {
  return `wf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function newShortId(bullswarmDir) {
  const existing = listRuns(bullswarmDir).map((r) => r.shortId).filter(Boolean);
  return generateShortId({ existing });
}

/**
 * Execute a workflow.
 * @param {object} opts
 * @param {string} opts.bullswarmDir
 * @param {object} opts.doc           validated workflow document
 * @param {object} opts.pools         live pools (buildPoolsLive)
 * @param {object} opts.inputs        runtime inputs (CLI --input k=v)
 * @param {string} [opts.resumeRunId]
 * @param {function} opts.onEvent     UX event sink
 */
export async function runWorkflow(opts) {
  const { bullswarmDir, doc, pools, inputs = {} } = opts;
  const runsRoot = join(bullswarmDir, 'workflows');
  mkdirSync(runsRoot, { recursive: true });

  const resuming = Boolean(opts.resumeRunId);
  const runId = resuming ? opts.resumeRunId : (opts.runId ?? newRunId());
  if (!/^wf-[a-z0-9]+-[a-f0-9]{6}$/.test(runId)) {
    throw new Error(`invalid workflow runId "${runId}"`);
  }
  const runDir = join(runsRoot, runId);
  if (!resuming && opts.runId && existsSync(runDir)) {
    throw new Error(`cannot start: run ${runId} already exists`);
  }
  mkdirSync(runDir, { recursive: true });
  if (!resuming) {
    // A generated goal workflow must be restartable without the initiating
    // process or an external draft file. The exact executable definition is
    // therefore a first-class run artifact.
    writeFileSync(join(runDir, 'workflow.json'), `${JSON.stringify(doc, null, 2)}\n`);
  }

  let state;
  if (resuming && existsSync(join(runDir, 'state.json'))) {
    state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    state.resumeHistory ??= [];
    state.resumeHistory.push({
      status: state.status ?? null,
      finishedAt: state.finishedAt ?? null,
      abortReason: state.abortReason ?? null,
      resumedAt: new Date().toISOString(),
    });
    delete state.finishedAt;
    delete state.cancelledAt;
    delete state.cancellingAt;
    delete state.cancellationLatencyMs;
    delete state.cancelRequested;
    delete state.cancelRequestedAt;
    delete state.interruptionSignal;
    delete state.interruptionRequestedAt;
    delete state.interruptedAt;
    delete state.recovery;
    delete state.abortReason;
    state.resumed = true;
    // Commit cleared terminal/control markers before WorkflowRuntime begins
    // merging dashboard-side state. Otherwise the first resume event can
    // re-import the stale cancelRequested marker from the interrupted run.
    writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  } else {
    if (resuming) {
      throw new Error(`cannot resume: no state.json for run ${runId}`);
    }
    const shortId = newShortId(bullswarmDir);
    state = {
      runId,
      shortId,
      workflow: doc.name,
      inputs: { ...Object.fromEntries(
        Object.entries(doc.inputs ?? {}).map(([k, v]) => [k, v.default]),
      ), ...inputs },
       settings: {
         escalateOnFail: true,
         concurrency: 4,
         retryAttempts: 1,
         maxExpansionRounds: 0,
         maxActions: 100,
         maxItemsPerExpansion: 50,
         maxWorkflowSeconds: 3600,
         ...(doc.settings ?? {}),
       },
      outputs: {},
      steps: [],   // linear log: {phase, stepId, type, verdict summary}
      status: 'queued',
      stage: 'planning',
      intent: doc.intent ?? { description: doc.description },
      plan: {
        version: 1,
        actions: doc.phases.flatMap((phase) => (phase.steps ?? []).map((step) => ({
          id: step.id, kind: step.type, phase: phase.name, dependsOn: step.dependsOn ?? [], source: 'initial',
        }))),
      },
      actionLedger: [],
      attempts: [],
      decisions: [],
      routingStrategy: {
        assignments: pools[0]?.strategyAssignments ?? {},
      },
      usage: {
        attempts: 0,
        tokens: { standardRead: null, cacheRead: null, cacheWrite: null, output: null, totalKnown: null },
        cost: { estimatedUsd: null },
        normalizedQuota: { estimatedPercent: null, basis: 'no attempts yet' },
      },
      orchestration: doc.orchestration ? { ...doc.orchestration, selectedPool: null, selectedModel: null } : null,
      budget: {
        dispatchesUsed: 0,
        dispatchLimit: doc.settings?.maxAgents ?? null,
        expansionRound: 0,
        expansionLimit: doc.settings?.maxExpansionRounds ?? 0,
      },
      startedAt: new Date().toISOString(),
      resumed: false,
    };
  }
  // Always keep a reference to the doc on the state so the runtime can
  // enforce inputs.<k>.required (R-run-time-required).
  state._doc = doc;
  if (opts.inputs && Object.keys(opts.inputs).length) {
    state.inputs = { ...state.inputs, ...opts.inputs };
  }

  // Pre-flight: required inputs must be present BEFORE we start, with
  // defaults filled in. A missing required input is a hard failure —
  // never a "skip the step" or "use empty string" — the same semantics
  // as a missing --input flag for a required CLI argument.
  for (const [k, spec] of Object.entries(doc.inputs ?? {})) {
    if (!spec || spec.required !== true) continue;
    const v = state.inputs[k];
    const missing = v === undefined || v === null || v === '' ||
      (typeof v === 'string' && v.trim() === '');
    if (missing) {
      throw new Error(
        `required input "${k}" missing (pass --input ${k}=… or set a default in the workflow)`,
      );
    }
  }

  // Spend guard: if the doc sets settings.maxAgents, the runtime aborts
  // the run as soon as a single dispatch would push us past the cap.
  // This mirrors Claude Code's "Large workflow" warning, but enforces a
  // hard ceiling instead of just warning.
  const maxAgents = doc.settings?.maxAgents ?? state.settings.maxAgents;
  if (maxAgents != null) state.settings.maxAgents = maxAgents;
  const warnAt = doc.settings?.warnAtAgents ?? state.settings.warnAtAgents ?? 25;
  state.settings.warnAtAgents = warnAt;

  const runtime = new WorkflowRuntime({
    bullswarmDir,
    pools,
    state,
    runDir,
    onEvent: opts.onEvent,
    env: opts.env,
  });
  state.runner = {
    pid: process.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  };
  let interruptionSignal = state.interruptionSignal ?? null;
  const requestInterruption = (signal) => {
    if (state.finishedAt || interruptionSignal) return;
    interruptionSignal = signal;
    state.interruptionSignal = signal;
    state.interruptionRequestedAt = new Date().toISOString();
    state.cancelRequested = true;
    state.cancelRequestedAt ??= state.interruptionRequestedAt;
    state.status = 'interrupting';
    state.stage = 'interrupting';
    runtime.emit('run.interruption_requested', { signal, requestedAt: state.interruptionRequestedAt });
  };
  const onSigterm = () => requestInterruption('SIGTERM');
  const onSigint = () => requestInterruption('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  try {
  state.availableCapabilities = {
    pools: pools.map((pool) => ({
      name: pool.name,
      enabled: pool.enabled !== false,
      lanes: pool.lanes ?? pool.connector?.lanes ?? [],
      capabilities: pool.capabilities ?? pool.connector?.capabilities ?? [],
      model: (() => {
        const connector = pool.connector ?? pool;
        const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
        return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : connector.model ?? null;
      })(),
      burstGate: pool.burstGate === true,
      quarantined: Boolean(pool.quarantine),
    })),
  };
  // An interrupted process leaves running attempts behind. On resume they are
  // historical facts, not live workers.
  if (resuming) {
    for (const attempt of state.attempts ?? []) {
      if (attempt.status === 'running') {
        attempt.status = 'abandoned';
        attempt.finishedAt = new Date().toISOString();
        attempt.why = 'runner stopped before attempt reached a terminal state';
        runtime.emit('attempt.abandoned', { actionId: attempt.actionId, attemptNumber: attempt.attemptNumber });
      }
    }
  } else {
    runtime.emit('run.queued', { runId, workflow: doc.name });
    runtime.emit('plan.created', { version: state.plan.version, actions: state.plan.actions });
  }
  state.status = 'running';
  state.stage = 'executing';
  runtime.emit('run.started', { runId, workflow: doc.name, phases: doc.phases.length, resumed: state.resumed });
  runtime.emit('workflow.started', { runId, workflow: doc.name, phases: doc.phases.length, resumed: state.resumed });

  let aborted = false;
  let abortReason = null;
  let cancelled = false;
  let completedByPlanner = false;
  let waitingForApproval = false;
  let budgetExhausted = false;
  let interrupted = false;
  const retryAttempts = state.settings.retryAttempts ?? 1;

  for (let pi = 0; pi < doc.phases.length && !aborted && !cancelled && !completedByPlanner && !waitingForApproval && !budgetExhausted; pi++) {
    const phase = doc.phases[pi];
    state.currentPhase = { index: pi, name: phase.name, total: doc.phases.length };
    runtime.persist();
    runtime.emit('phase.started', { index: pi, total: doc.phases.length, name: phase.name });
    let phaseFailed = false;

    for (const step of phase.steps ?? []) {
      if (state.cancelRequested) { cancelled = true; break; }
      state.currentStep = { id: step.id, type: step.type, phase: phase.name };
      runtime.persist();
      // R2: skip ok:true on resume for both `run` and `verify`. (Fanout
      // is resumed inside the runtime, per-item by fingerprint.)
      if (resuming && state.outputs[step.id]?.ok === true
          && (step.type === 'run' || step.type === 'verify')) {
        runtime.emit('step.skipped', { stepId: step.id });
        continue;
      }
      let r;
      try {
        // Spend guard: refuse a new step if it would cross maxAgents.
        // We count the step (not the per-attempt dispatch) so a single
        // run step with one escalation is 1 unit, not 2.
        if (state.settings.maxAgents != null
            && runtime.dispatchCount >= state.settings.maxAgents) {
          r = {
            ok: false,
            why: `spend guard: maxAgents=${state.settings.maxAgents} reached`,
          };
          state.outputs[step.id] = { ...r, maxAgentsReached: true };
        } else {
          r = step.type === 'decide'
            ? await runDecisionLoop({ runtime, gate: step, phase: phase.name, state, retryAttempts })
            : await runtime.runStep(step, { phase: phase.name, retryAttempts });
        }
      } catch (err) {
        // Step-level errors (bad template refs, unparseable fanout items, …)
        // are step failures under onError semantics — never crashes.
        r = { ok: false, why: err.message };
        state.outputs[step.id] = { ok: false, why: err.message };
        runtime.setActionStatus(step, { phase: phase.name }, 'failed_terminal', {
          finishedAt: new Date().toISOString(), why: err.message,
        });
        runtime.emit('action.failed', { actionId: step.id, status: 'failed_terminal', why: err.message });
      }
      state.steps.push({
        phase: phase.name,
        stepId: step.id,
        type: step.type,
        ok: r.ok,
        why: r.why ?? null,
      });
      runtime.persist();

      if (r.complete === true) { completedByPlanner = true; break; }
      if (r.waitingForApproval === true) { waitingForApproval = true; break; }
      if (r.budgetExhausted === true) { budgetExhausted = true; abortReason = r.why; break; }

      if (state.cancelRequested) { cancelled = true; break; }

      if (!r.ok) {
        phaseFailed = true;
        if (step.type === 'decide') {
          aborted = true;
          abortReason = `adaptive decision gate ${step.id} failed: ${r.why ?? 'unknown'}`;
          break;
        }
        const onError = step.onError ?? 'continue';
        if (onError === 'fail') {
          aborted = true;
          abortReason = `step ${step.id} failed (onError: fail): ${r.why ?? 'unknown'}`;
          break;
        }
        if (onError === 'skip-phase') {
          runtime.emit('phase.skipped-rest', { phase: phase.name, stepId: step.id });
          break;
        }
        // 'continue' — record and move on
      }
    }

    if (!aborted && phaseFailed && (doc.settings?.stopOnPhaseFailure || state.settings.stopOnPhaseFailure)) {
      aborted = true;
      abortReason = `phase ${phase.name} had failures (stopOnPhaseFailure)`;
    }
    runtime.emit('phase.completed', { index: pi, name: phase.name, failed: phaseFailed });
  }

  const finishedAt = new Date().toISOString();
  if (!waitingForApproval) state.finishedAt = finishedAt;
  // Re-read the marker because cancellation can be requested by the dashboard
  // while the runner is inside a long dispatch.
  try {
    const diskState = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    cancelled ||= diskState.cancelRequested === true;
    interruptionSignal ??= diskState.interruptionSignal ?? null;
  } catch { /* use the in-memory cancellation state */ }
  interrupted = Boolean(interruptionSignal);
  if (cancelled && !interrupted) {
    state.status = 'cancelling';
    state.cancellingAt = new Date().toISOString();
    runtime.emit('run.cancelling', { requestedAt: state.cancelRequestedAt ?? null });
  }
  state.status = interrupted ? 'interrupted' : cancelled ? 'cancelled' : waitingForApproval ? 'waiting_for_approval' : budgetExhausted ? 'budget_exhausted' : (aborted ? 'failed' : 'completed');
  state.stage = interrupted ? 'interrupted' : cancelled ? 'cancelled' : waitingForApproval ? 'waiting_for_approval' : budgetExhausted ? 'budget_exhausted' : (aborted ? 'failed' : 'delivered');
  delete state.currentPhase;
  delete state.currentStep;
  delete state.activeAgents;
  if (cancelled && !interrupted) {
    state.cancelledAt = finishedAt;
    const requested = Date.parse(state.cancelRequestedAt ?? '');
    state.cancellationLatencyMs = Number.isFinite(requested) ? Math.max(0, Date.parse(finishedAt) - requested) : null;
  }
  if (interrupted) {
    state.interruptedAt = finishedAt;
    state.abortReason = `runner interrupted by ${interruptionSignal}`;
    state.recovery = { resumable: true, signal: interruptionSignal, interruptedAt: finishedAt };
  }
  if (abortReason && !interrupted) state.abortReason = abortReason;
  runtime.persist();

  const preliminaryReport = buildReport(state, doc, runDir);
  runtime.emit(interrupted ? 'run.interrupted' : cancelled ? 'run.cancelled' : waitingForApproval ? 'run.waiting_for_approval' : budgetExhausted ? 'run.budget_exhausted' : 'run.completed', { runId, status: state.status, report: preliminaryReport.summary });
  const report = buildReport(state, doc, runDir);
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  opts.onEvent?.({ type: 'workflow.completed', runId, status: state.status, report: report.summary });

  return { runId, runDir, state, report };
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }
}

async function runDecisionLoop({ runtime, gate, phase, state, retryAttempts }) {
  const settings = state.settings;

  const executeActions = async (actions) => {
    const pending = new Map(actions.map((action) => [action.id, action]));
    while (pending.size) {
      if (state.cancelRequested) return { ok: false, why: 'workflow cancellation requested' };
      const elapsedSec = (Date.now() - Date.parse(state.startedAt)) / 1000;
      if (elapsedSec >= settings.maxWorkflowSeconds) {
        return { ok: false, why: `budget exhausted: maxWorkflowSeconds=${settings.maxWorkflowSeconds}`, budgetExhausted: true };
      }
      const ready = [...pending.values()].filter((action) =>
        (action.dependsOn ?? []).every((id) => state.outputs[id]?.ok === true));
      if (!ready.length) {
        const blocked = [...pending.values()].map((action) => ({ id: action.id, dependsOn: action.dependsOn ?? [] }));
        const why = `dynamic actions blocked by failed or unresolved dependencies: ${JSON.stringify(blocked)}`;
        for (const action of pending.values()) {
          state.outputs[action.id] = { ok: false, why, dependencyBlocked: true };
          runtime.setActionStatus(action, { phase: `${phase}:adaptive` }, 'failed_terminal', {
            finishedAt: new Date().toISOString(), why,
          });
          runtime.emit('action.failed', { actionId: action.id, status: 'failed_terminal', why });
        }
        pending.clear();
        // This is an observation, not a runtime crash. Return to the planner so
        // it can propose a bounded retry/escalation or stop truthfully.
        return { ok: true, blocked, why };
      }
      for (const action of ready) {
        pending.delete(action.id);
        if (state.outputs[action.id]?.ok === true) {
          runtime.emit('action.resumed', { actionId: action.id, status: 'succeeded' });
          continue;
        }
        let result;
        try {
          result = await runtime.runStep(
            { ...action, parentId: gate.id, _dynamic: true },
            { phase: `${phase}:adaptive`, retryAttempts },
          );
        } catch (err) {
          // A post-artifact observer failure must not rewrite a durably
          // successful action as failed. Propagate it to the gate boundary;
          // resume will use the persisted output and continue pending work.
          if (state.outputs[action.id]?.ok === true) throw err;
          result = { ok: false, why: err.message };
          state.outputs[action.id] = result;
          runtime.setActionStatus(action, { phase: `${phase}:adaptive` }, 'failed_terminal', {
            finishedAt: new Date().toISOString(), why: err.message,
          });
          runtime.emit('action.failed', { actionId: action.id, status: 'failed_terminal', why: err.message });
        }
        state.steps.push({
          phase: `${phase}:adaptive`, stepId: action.id, type: action.type,
          ok: result.ok, why: result.why ?? null, dynamic: true,
        });
        runtime.persist();
      }
    }
    return { ok: true };
  };

  // Resume accepted expansion work before asking the planner for a new
  // semantic decision. Successful actions are skipped by durable output.
  const unfinishedAccepted = (state.plan?.actions ?? [])
    .filter((entry) => entry.source === 'planner' && entry.definition &&
      state.outputs[entry.id] == null)
    .map((entry) => entry.definition);
  if (unfinishedAccepted.length) {
    const resumed = await executeActions(unfinishedAccepted);
    if (!resumed.ok) return resumed;
  }

  while (true) {
    if (state.cancelRequested) return { ok: false, why: 'workflow cancellation requested' };
    const elapsedSec = (Date.now() - Date.parse(state.startedAt)) / 1000;
    if (elapsedSec >= settings.maxWorkflowSeconds) {
      return { ok: false, why: `budget exhausted: maxWorkflowSeconds=${settings.maxWorkflowSeconds}`, budgetExhausted: true };
    }
    state.stage = 'observing';
    runtime.emit('kernel.checkpointed', { stage: 'observing', gateId: gate.id });
    state.stage = 'planning';
    runtime.emit('kernel.checkpointed', { stage: 'planning', gateId: gate.id });
    const planner = await runtime.runStep(gate, { phase, retryAttempts });
    if (!planner.ok) return planner;

    let proposal;
    try {
      proposal = validateDecisionProposal(normalizeDecisionProposal(planner.proposal), {
        knownActionIds: (state.plan?.actions ?? []).map((action) => action.id),
        currentActionCount: state.plan?.actions?.length ?? 0,
        maxActions: settings.maxActions,
        maxItemsPerExpansion: settings.maxItemsPerExpansion,
      });
    } catch (err) {
      const why = err instanceof DecisionValidationError ? err.message : `planner decision rejected: ${err.message}`;
      state.outputs[gate.id] = { ...state.outputs[gate.id], ok: false, why };
      runtime.emit('decision.rejected', { gateId: gate.id, why, issues: err.issues ?? [] });
      return { ok: false, why, budgetExhausted: /maxActions|maxItemsPerExpansion/.test(why) };
    }

    const actionDefaults = { ...(gate.addDir != null ? { addDir: gate.addDir } : {}), ...(gate.actionDefaults ?? {}) };
    proposal = {
      ...proposal,
      actions: proposal.actions.map((action) => ({
        ...action,
        ...actionDefaults,
        ...(action.type === 'fanout' && actionDefaults.addDir != null
          ? { stepTemplate: { ...action.stepTemplate, addDir: actionDefaults.addDir } }
          : {}),
      })),
    };

    const decision = {
      sequence: (state.decisions?.length ?? 0) + 1,
      gateId: gate.id,
      decision: proposal.decision,
      reason: proposal.reason,
      actions: proposal.actions.map((action) => action.id),
      artifact: planner.outFile,
      createdAt: new Date().toISOString(),
      accepted: true,
    };
    state.decisions.push(decision);
    runtime.emit('decision.created', decision);

    if (proposal.decision === 'complete') {
      const policy = state.orchestration?.completionPolicy;
      const dynamicActions = (state.actionLedger ?? []).filter((action) => action.parentId === gate.id);
      const missing = [];
      if (policy?.requireSuccessfulWorker &&
          !dynamicActions.some((action) => action.kind !== 'verify' && action.status === 'succeeded')) {
        missing.push('a successful worker action');
      }
      if (policy?.requireSuccessfulVerification &&
          !dynamicActions.some((action) => action.kind === 'verify' && action.status === 'succeeded')) {
        missing.push('a successful verification action');
      }
      if (missing.length) {
        const why = `autonomous completion rejected: missing ${missing.join(' and ')}`;
        decision.accepted = false;
        decision.rejectionReason = why;
        state.outputs[gate.id] = { ...state.outputs[gate.id], ok: false, why };
        runtime.emit('decision.rejected', { gateId: gate.id, decision: 'complete', why });
        runtime.persist();
        continue;
      }
      return { ok: true, why: proposal.reason, complete: true, decision: proposal };
    }
    if (proposal.decision === 'proceed') return { ok: true, why: proposal.reason, decision: proposal };
    if (proposal.decision === 'stop') return { ok: false, why: `planner stopped workflow: ${proposal.reason}`, decision: proposal };
    if (proposal.decision === 'wait_for_approval') {
      state.approval = { gateId: gate.id, reason: proposal.reason, requestedAt: new Date().toISOString() };
      runtime.setActionStatus(gate, { phase }, 'waiting_for_approval');
      return { ok: true, why: proposal.reason, waitingForApproval: true, decision: proposal };
    }

    if (state.budget.expansionRound >= settings.maxExpansionRounds) {
      const why = `budget exhausted: maxExpansionRounds=${settings.maxExpansionRounds}`;
      state.outputs[gate.id] = { ...state.outputs[gate.id], ok: false, why, budgetExhausted: true };
      return {
        ok: false,
        why,
        budgetExhausted: true,
      };
    }
    state.budget.expansionRound += 1;
    state.budget.expansionLimit = settings.maxExpansionRounds;
    state.stage = 'planning';
    state.plan.version += 1;
    const accepted = proposal.actions.map((action) => ({
      id: action.id,
      kind: action.type,
      phase: `${phase}:adaptive`,
      dependsOn: action.dependsOn,
      source: 'planner',
      decisionSequence: decision.sequence,
      definition: action,
    }));
    state.plan.actions.push(...accepted);
    runtime.emit('plan.updated', {
      version: state.plan.version,
      expansionRound: state.budget.expansionRound,
      reason: proposal.reason,
      actions: accepted.map(({ definition, ...entry }) => entry),
    });
    state.stage = 'executing';
    runtime.emit('kernel.checkpointed', { stage: 'executing', gateId: gate.id });
    const executed = await executeActions(proposal.actions);
    if (!executed.ok) return executed;
    // Loop intentionally returns to observation and invokes the planner again.
  }
}

export function buildReport(state, doc, runDir) {
  const stepResults = state.steps ?? [];
  const fanoutSteps = Object.entries(state.outputs ?? {}).filter(
    ([, v]) => v && typeof v === 'object' && 'items' in v,
  );
  let fanoutOk = 0;
  let fanoutFailed = 0;
  for (const [, v] of fanoutSteps) {
    fanoutOk += v.ok ?? 0;
    fanoutFailed += v.failed ?? 0;
  }
  const simpleOk = stepResults.filter((s) => s.ok).length;
  const simpleFailed = stepResults.filter((s) => s.ok === false).length;

  return {
    schemaVersion: 'bullswarm.workflow.report.v1',
    runId: state.runId,
    shortId: state.shortId ?? null,
    workflow: state.workflow,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    resumed: state.resumed === true,
    abortReason: state.abortReason ?? null,
    interruption: state.interruptionSignal ? {
      signal: state.interruptionSignal,
      requestedAt: state.interruptionRequestedAt ?? null,
      interruptedAt: state.interruptedAt ?? null,
    } : null,
    recovery: state.recovery ?? null,
    resumeHistory: state.resumeHistory ?? [],
    summary: {
      stepsTotal: stepResults.length,
      stepsOk: simpleOk,
      stepsFailed: simpleFailed,
      fanoutSteps: fanoutSteps.length,
      fanoutOk,
      fanoutFailed,
    },
    steps: stepResults,
    outputs: state.outputs,
    intent: state.intent ?? null,
    plan: state.plan ?? null,
    budget: state.budget ?? null,
    actionLedger: state.actionLedger ?? [],
    attempts: state.attempts ?? [],
    decisions: state.decisions ?? [],
    orchestration: state.orchestration ?? null,
    usage: state.usage ?? null,
    routingStrategy: state.routingStrategy ?? null,
    availableCapabilities: state.availableCapabilities ?? null,
    lastEventSequence: state.eventSequence ?? 0,
    artifactsDir: runDir,
  };
}
