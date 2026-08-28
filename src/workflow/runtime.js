// bullswarm workflow runtime — executes a validated workflow document.
//
// Doctrine:
//   R1. Dispatch reuses watchOnce verbatim — same verdict contract, same
//       quarantine side effects, same meter accounting as single runs.
//   R2. State persists to disk after EVERY step; resume = skip ok:true.
//   R3. Escalation is verdict-driven: failed step retries once on next pool
//       by surplus (never the same pool, never more than once).
//   R4. Concurrency limiter is global across fanout expansions (one Semaphore
//       shared by all in-flight dispatches; per-fanout worker cap ≤ global).
//   R5. onError: continue | fail (abort run) | skip-phase (rest of phase).
//   R6. Workflow dispatches propagate BULLSWARM_DEPTH to the spawned
//       connector; the recursion guard is core-owned. A workflow that itself
//       triggers `bullswarm` is refused at the depth limit instead of
//       recursing forever.
//   R7. Auth/throttle verdicts from inside a workflow do call quarantinePool
//       and append to the shared decisionLog, so `bullswarm health` sees
//       workflow runs and a misbehaving pool is benched for the next dispatch.
//   R8. Burst-gated pools (5h ≥ 90%) are excluded from workflow dispatch,
//       matching the single-run path.
//   R9. `outputText` is truncated when persisted to state.json; the full
//       text always lives in the per-step outFile.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pickPool, isQuarantined } from '../lib/route.js';
import { watchOnce } from '../lib/watch.js';
import { renderDeep, extractItems, getPath } from './template.js';
import { loadState, saveState, quarantinePool, childDepthEnv, DEPTH_ENV, assertDepthAllowed } from '../lib/state.js';
import { Semaphore } from './semaphore.js';
import { appendEvent } from './events.js';
import { DECISION_SCHEMA_VERSION, parseDecisionText } from './decision.js';
import { aggregateUsage } from '../lib/usage.js';
import { classifyAgentProgress, recordAgentAction } from '../lib/agent-events.js';
import { deliverSteering } from './steering.js';
import { resolveDispatchModel } from '../lib/strategy.js';
import { getMeterReading } from '../meters/registry.js';

// Cap how much of each step's output we keep inline in state.json.
// Persisting full transcripts bloat state.json on long workflows. The
// full text is always on disk in the per-step outFile.
export const OUTPUT_TEXT_CAP_BYTES = 64 * 1024;
// Per-item excerpt kept in a fan-out's durable summary artifact.
const FANOUT_ITEM_EXCERPT_BYTES = 6_000;
// What the planner sees of each action's output (per output / all outputs).
const PLANNER_EXCERPT_CHARS = 3_000;
const PLANNER_EXCERPT_TOTAL_CHARS = 36_000;
// A burst gate (provider 5h window >= 90 % used) is a WAIT, never a hard stop:
// the runtime parks the dispatch until the window resets (+ grace), re-reading
// the meter every QUOTA_POLL_MS, and only then fails with the reset time named.
export const BURST_WAIT_GRACE_MS = 10 * 60_000;
export const BURST_WAIT_UNKNOWN_RESET_MS = 5 * 3600_000;
export const QUOTA_POLL_MS = 60_000;

export function plannerBudgetContext(budget = {}) {
  const dispatchesUsedBeforePlanner = Number(budget.dispatchesUsed ?? 0);
  const rawTarget = budget.dispatchTarget ?? budget.dispatchLimit;
  const dispatchTarget = rawTarget == null ? null : Number(rawTarget);
  const dispatchesUsed = dispatchesUsedBeforePlanner + 1;
  const hasTarget = Number.isFinite(dispatchTarget);
  const expansionRound = Number(budget.expansionRound ?? 0);
  const rawExpansionTarget = budget.expansionTarget ?? budget.expansionLimit;
  const expansionTarget = rawExpansionTarget == null ? null : Number(rawExpansionTarget);
  const hasExpansionTarget = Number.isFinite(expansionTarget);
  return {
    ...budget,
    dispatchesUsed,
    dispatchesUsedBeforePlanner,
    dispatchTarget: hasTarget ? dispatchTarget : null,
    remainingDispatches: hasTarget
      ? Math.max(0, dispatchTarget - dispatchesUsed)
      : null,
    overTargetBy: hasTarget ? Math.max(0, dispatchesUsed - dispatchTarget) : 0,
    targetExceeded: hasTarget ? dispatchesUsed > dispatchTarget : false,
    expansionRound,
    expansionTarget: hasExpansionTarget ? expansionTarget : null,
    expansionLimit: hasExpansionTarget ? expansionTarget : null,
    remainingExpansionRounds: hasExpansionTarget
      ? Math.max(0, expansionTarget - expansionRound)
      : null,
    expansionOverTargetBy: hasExpansionTarget
      ? Math.max(0, expansionRound - expansionTarget)
      : 0,
    expansionTargetReached: hasExpansionTarget ? expansionRound >= expansionTarget : false,
    expansionAdvisoryOnly: true,
    convergenceRecommended: hasExpansionTarget ? expansionRound >= Math.max(1, expansionTarget - 1) : false,
    advisoryOnly: true,
    includesCurrentPlannerDispatch: true,
  };
}

export class WorkflowRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.bullswarmDir  ~/.bullswarm
   * @param {object} opts.pools         buildPoolsLive result pools array
   * @param {object} opts.state         loaded workflow state (mutable)
   * @param {string} opts.runDir        artifact dir for this run
   * @param {function} opts.onEvent     (event) => void for UX rendering
   */
  constructor(opts) {
    this.bullswarmDir = opts.bullswarmDir;
    this.pools = opts.pools;
    this.state = opts.state;
    this.runDir = opts.runDir;
    this.onEvent = opts.onEvent ?? (() => {});
    // Global concurrency limiter shared across runSingle + runFanout.
    // Sized from settings.concurrency; bounded by the spawn cap (16) to
    // match the Claude Code dynamic-workflow cap. Tests inject their own.
    const concap = opts.semaphore
      ?? new Semaphore(
        Math.min(
          Math.max(1, Number(opts.concurrency ?? this.state?.settings?.concurrency ?? 4)),
          16,
        ),
      );
    this.limiter = concap;
    this.parentEnv = opts.env ?? process.env;
    // Meter refresh used while waiting on a burst gate; tests inject a fake.
    this.readMeter = opts.readMeter ?? ((name) => getMeterReading(name, { force: true }));
    this.quotaPollMs = Math.max(10, Number(opts.quotaPollMs ?? this.state?.settings?.quotaPollMs ?? QUOTA_POLL_MS));
    this.quotaWaitGraceMs = Math.max(0, Number(opts.quotaWaitGraceMs ?? BURST_WAIT_GRACE_MS));
    this.quotaWaitUnknownResetMs = Math.max(0, Number(opts.quotaWaitUnknownResetMs ?? BURST_WAIT_UNKNOWN_RESET_MS));
    // Counters used for planner-visible advisory budgeting.
    this.state.attempts ??= [];
    this.state.actionLedger ??= [];
    this.state.budget ??= {};
    this.dispatchCount = Number(this.state.budget.dispatchesUsed ?? 0);
    this.warningEmitted = false;
    this.targetExceededEmitted = Boolean(this.state.budget.targetExceededAt);
  }

  persist() {
    const elapsedSec = Math.max(0,
      (Date.now() - Date.parse(this.state.startedAt ?? new Date().toISOString())) / 1000);
    const workflowTargetSec = this.state.settings?.maxWorkflowSeconds == null
      ? null
      : Number(this.state.settings.maxWorkflowSeconds);
    const dispatchTarget = this.state.settings?.maxAgents ?? null;
    this.state.budget.dispatchesUsed = this.dispatchCount;
    this.state.budget.dispatchTarget = dispatchTarget;
    this.state.budget.dispatchLimit = dispatchTarget;
    this.state.budget.remainingDispatches = dispatchTarget == null
      ? null
      : Math.max(0, dispatchTarget - this.dispatchCount);
    this.state.budget.overTargetBy = dispatchTarget == null
      ? 0
      : Math.max(0, this.dispatchCount - dispatchTarget);
    this.state.budget.targetExceeded = this.state.budget.overTargetBy > 0;
    this.state.budget.workflowElapsedSec = Math.round(elapsedSec * 10) / 10;
    this.state.budget.workflowTargetSec = Number.isFinite(workflowTargetSec)
      ? workflowTargetSec
      : null;
    this.state.budget.workflowRemainingSec = Number.isFinite(workflowTargetSec)
      ? Math.max(0, workflowTargetSec - elapsedSec)
      : null;
    this.state.budget.workflowOverTargetBySec = Number.isFinite(workflowTargetSec)
      ? Math.max(0, elapsedSec - workflowTargetSec)
      : 0;
    this.state.budget.advisoryOnly = true;
    this.state.runner = {
      ...(this.state.runner ?? {}),
      pid: process.pid,
      status: this.state.finishedAt ? this.state.status : 'running',
      startedAt: this.state.runner?.startedAt ?? this.state.startedAt ?? new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      ...(this.state.finishedAt ? { finishedAt: this.state.finishedAt } : {}),
    };
    // The dashboard may write cancelRequested while a dispatch is running.
    // Preserve that marker when the runner persists its in-memory snapshot.
    try {
      const path = join(this.runDir, 'state.json');
      if (existsSync(path)) {
        const disk = JSON.parse(readFileSync(path, 'utf8'));
        if (disk.cancelRequested) this.state.cancelRequested = true;
        if (disk.cancelRequestedAt) this.state.cancelRequestedAt = disk.cancelRequestedAt;
        if (disk.status === 'cancelling' &&
            !['completed', 'failed', 'cancelled'].includes(this.state.status)) {
          this.state.status = 'cancelling';
        }
        if (disk.cancellingAt) this.state.cancellingAt = disk.cancellingAt;
      }
    } catch { /* a partial state file should not break the workflow */ }
    writeFileSync(join(this.runDir, 'state.json'), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  refreshCancellation() {
    try {
      const disk = JSON.parse(readFileSync(join(this.runDir, 'state.json'), 'utf8'));
      if (disk.cancelRequested) {
        this.state.cancelRequested = true;
        this.state.cancelRequestedAt = disk.cancelRequestedAt ?? this.state.cancelRequestedAt;
        return true;
      }
    } catch { /* keep using the in-memory marker */ }
    return this.state.cancelRequested === true;
  }

  emit(type, payload) {
    const event = appendEvent(this.runDir, this.state, type, payload ?? {});
    this.persist();
    this.onEvent({ type, ...payload, sequence: event.sequence, committedAt: event.committedAt });
    return event;
  }

  actionId(step, opts = {}) {
    return opts.itemIndex == null ? step.id : `${step.id}[${opts.itemIndex}]`;
  }

  ensureAction(step, opts = {}) {
    const id = this.actionId(step, opts);
    let action = this.state.actionLedger.find((entry) => entry.id === id);
    if (!action) {
      action = {
        id,
        parentId: opts.itemIndex == null ? (step.parentId ?? null) : step.id,
        kind: opts.itemIndex == null ? step.type : 'run',
        dependsOn: [...(step.dependsOn ?? [])],
        status: 'queued',
        phase: opts.phase ?? null,
        item: opts.item,
        attempts: [],
        queuedAt: new Date().toISOString(),
      };
      this.state.actionLedger.push(action);
      this.emit('action.queued', { actionId: id, parentId: action.parentId, kind: action.kind });
    }
    return action;
  }

  setActionStatus(step, opts, status, extra = {}) {
    const action = this.ensureAction(step, opts);
    Object.assign(action, extra, { status });
    this.persist();
    return action;
  }

  scopeFor(step) {
    return {
      inputs: this.state.inputs,
      outputs: this.state.outputs,
      runId: this.state.runId,
      wfDir: this.runDir,
    };
  }

  /**
   * Execute one dispatch (run or single fanout expansion).
   * Returns verdict. Applies escalation per R3.
   *
   * Acquires a permit from the global semaphore (R4) and propagates
   * BULLSWARM_DEPTH to the spawned connector (R6). On an auth/throttle
   * verdict the failed pool is quarantined in the core state and a
   * decisionLog entry is appended (R7). Burst-gated pools are excluded
   * before selection (R8).
   */
  async dispatch(step, taskText, targetDir, paths, opts = {}) {
    if (this.state.cancelRequested) return { ok: false, keepOnClaude: false, why: 'workflow cancellation requested', pick: { pool: null }, meta: {} };
    const effortTier = step.effort ?? ({ analyze: 'high', build: 'medium', chore: 'low' }[step.lane ?? 'chore']);
    // A burst-gated provider is waited for (outside the concurrency permit),
    // never failed on the spot.
    await this.awaitBurstRoom(step, effortTier, this.actionId(step, opts));
    if (this.state.cancelRequested) return { ok: false, keepOnClaude: false, why: 'workflow cancellation requested', pick: { pool: null }, meta: {} };
    return this.limiter.runWith(async () => {
      const attemptPools = this.preparePools(step, effortTier);
      let lastVerdict = null;
      const retryAllowance = Math.max(0, Math.min(Number(opts.retryAttempts ?? 1), 3));
      const escalationAllowance = opts.escalate && !step.pool ? 1 : 0;
      const maxAttempts = 1 + retryAllowance + escalationAllowance;
      let escalationUsed = false;
      const actionId = this.actionId(step, opts);
      const action = this.ensureAction(step, opts);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const assignments = attemptPools[0]?.strategyAssignments ?? {};
        const assignment = assignments?.[effortTier] ?? null;
        const route = pickPool(step.lane ?? 'chore', attemptPools, {
          callerEligible: false,
          callerSession: false, // workflow context: every pool is a worker
          now: Date.now(),
          requiredCapabilities: step.requiresCapabilities ?? [],
          preferredPool: assignment?.pool ?? null,
          effortTier,
        });
        if (!route.pick) {
          if (lastVerdict) return lastVerdict;
          const stillGated = attemptPools.length ? [] : this.burstGatedPoolsFor(step, effortTier);
          const refused = {
            ok: false,
            keepOnClaude: false,
            why: stillGated.length
              ? `no eligible pool: every candidate is burst-gated (${WorkflowRuntime.describeBurstGate(stillGated)}) and the wait for the window expired`
              : `no eligible pool (${route.why})`,
            pick: { pool: null },
            meta: { exitCode: null },
          };
          action.status = 'failed_terminal';
          action.finishedAt = new Date().toISOString();
          this.emit('action.failed', { actionId, status: action.status, why: refused.why });
          return refused;
        }
        const poolView = route.pick.connector;
        const connector = poolView?.connector ?? poolView;
        const selectedModel = poolView?.modelPolicy?.model
          ?? (assignment?.pool === connector.name && !poolView?.strategyExcludedModels?.includes(assignment.model)
            ? assignment.model : null);
        const runtimeConnector = {
          ...connector,
          subscription: poolView?.subscription ?? connector.subscription ?? null,
        };

        // Pin pool if requested (validation already checked existence)
        const chosen = step.pool
          ? attemptPools.find((p) => p.name === step.pool)
          : connector;
        const conn = (chosen?.connector) ? chosen.connector : chosen;
        let conversation = null;
        if (step.type === 'decide'
          && this.state.orchestration?.mode === 'autonomous'
          && runtimeConnector.conversation) {
          this.state.orchestration.conversations ??= {};
          const thread = this.state.orchestration.conversations[conn.name] ?? {
            sessionId: randomUUID(),
            started: false,
            createdAt: new Date().toISOString(),
          };
          this.state.orchestration.conversations[conn.name] = thread;
          conversation = { sessionId: thread.sessionId, resume: thread.started === true };
        }

        this.dispatchCount += 1;
        this.state.budget.dispatchesUsed = this.dispatchCount;
        this.state.budget.dispatchTarget = this.state.settings.maxAgents ?? null;
        // Keep the historical field readable for existing dashboards/reports,
        // but it is an advisory target rather than an enforcement limit.
        this.state.budget.dispatchLimit = this.state.settings.maxAgents ?? null;
        this.state.budget.remainingDispatches = this.state.settings.maxAgents == null
          ? null
          : Math.max(0, this.state.settings.maxAgents - this.dispatchCount);
        this.state.budget.overTargetBy = this.state.settings.maxAgents == null
          ? 0
          : Math.max(0, this.dispatchCount - this.state.settings.maxAgents);
        this.state.budget.targetExceeded = this.state.budget.overTargetBy > 0;
        this.state.budget.advisoryOnly = true;
        this.maybeWarnLarge();
        this.maybeRecordTargetOverage();

        const attemptNumber = (action.attempts?.length ?? 0) + 1;
        const attemptPaths = attemptNumber === 1 ? paths : {
          // Retries receive the exact same task artifact; only outputs are
          // split so history cannot overwrite a prior attempt's evidence.
          taskFile: paths.taskFile,
          outFile: paths.outFile.replace(/(\.[^.]+)?$/, `-attempt-${attemptNumber}$1`),
        };
        const startedAt = new Date().toISOString();
        const attemptRecord = {
          actionId,
          attemptNumber,
          pool: conn.name,
          model: selectedModel ?? conn.model ?? (() => {
            const index = conn.spawn?.cmd?.indexOf('--model') ?? -1;
            return index >= 0 ? conn.spawn.cmd[index + 1] ?? null : null;
          })(),
          status: 'running',
          startedAt,
          lastHeartbeatAt: startedAt,
          taskFile: attemptPaths.taskFile,
          outFile: attemptPaths.outFile,
          why: null,
          routing: {
            reason: route.why,
            candidates: route.candidates,
            effort: effortTier,
            lane: step.lane ?? 'chore',
            requiredCapabilities: step.requiresCapabilities ?? [],
            configuredAssignment: assignment ?? null,
            assignmentApplied: assignment?.pool === conn.name ? assignment : null,
            modelPolicy: poolView?.modelPolicy ?? null,
          },
          ...(conversation ? {
            conversation: {
              sessionId: conversation.sessionId,
              continued: conversation.resume,
            },
          } : {}),
        };
        if (step.type === 'decide' && this.state.orchestration) {
          this.state.orchestration.selections ??= [];
          const selection = {
            pool: conn.name,
            model: attemptRecord.model,
            attemptNumber,
            selectedAt: startedAt,
          };
          this.state.orchestration.selectedPool = conn.name;
          this.state.orchestration.selectedModel = attemptRecord.model;
          this.state.orchestration.selections.push(selection);
          this.emit('orchestrator.selected', { ...selection, routing: attemptRecord.routing });
        }
        this.state.attempts.push(attemptRecord);
        action.attempts.push(this.state.attempts.length - 1);
        action.status = 'running';
        action.startedAt ??= startedAt;
        delete action.finishedAt;
        delete action.why;
        this.emit('attempt.started', {
          actionId, attemptNumber, pool: conn.name, model: attemptRecord.model,
          routing: attemptRecord.routing,
        });
        this.emit('action.started', { actionId, attemptNumber });

        this.emit('step.started', {
          stepId: step.id,
          item: opts.item,
          pool: conn.name,
          attempt,
        });
        this.state.activeAgents ??= {};
        const activeKey = actionId;
        this.state.activeAgents[activeKey] = {
          stepId: step.id,
          item: opts.item,
          pool: conn.name,
          model: attemptRecord.model,
          effort: effortTier,
          attempt: attemptNumber,
          startedAt,
          taskFile: attemptPaths.taskFile,
          outFile: attemptPaths.outFile,
          status: 'running',
          lastActivityAt: null,
          outputBytesObserved: 0,
          eventStreamSupported: Boolean(runtimeConnector.eventStream),
          lastEventAt: null,
          lastActionAt: null,
          actionCount: 0,
          lastActions: [],
        };
        this.state.activeAgents[activeKey].stall = classifyAgentProgress(
          this.state.activeAgents[activeKey],
          Date.now(),
          runtimeConnector.eventStream?.silenceThresholdSec ?? 600,
        );
        this.persist();

        // R6: propagate the recursion env so a connector that itself
        // spawns `bullswarm` is refused at the core's depth limit.
        const childEnv = childDepthEnv(this.parentEnv);

        // R7: refuse if THIS workflow process is already at the depth
        // limit. The check uses parentEnv (the current process's depth),
        // not childEnv — the limit means "this process is at depth N and
        // must not spawn a child that would be N+1". The child will
        // receive childEnv in its own env; if IT tries to recurse, the
        // child process's assert will fire at its own depth+1.
        try {
          const coreState = loadState(this.bullswarmDir);
          assertDepthAllowed(coreState, this.parentEnv);
        } catch (err) {
          const refused = {
            ok: false,
            keepOnClaude: false,
            why: `recursion guard: ${err.message}`,
            pick: { pool: conn.name },
            meta: { exitCode: null },
          };
          attemptRecord.status = 'failed_terminal';
          attemptRecord.finishedAt = new Date().toISOString();
          attemptRecord.why = refused.why;
          action.status = 'failed_terminal';
          action.finishedAt = attemptRecord.finishedAt;
          this.state.activeAgents[activeKey].status = 'failed';
          this.state.activeAgents[activeKey].finishedAt = attemptRecord.finishedAt;
          this.state.activeAgents[activeKey].why = refused.why;
          this.emit('attempt.completed', { actionId, attemptNumber, status: 'failed_terminal', ok: false, why: refused.why });
          this.emit('action.failed', { actionId, status: 'failed_terminal', why: refused.why });
          return refused;
        }

        // Keep state.json fresh while a provider is thinking. Without a
        // heartbeat, the dashboard's ongoing-run grace window could expire
        // during a legitimate long dispatch.
        const heartbeat = setInterval(() => {
          const active = this.state.activeAgents[activeKey];
          if (active) {
            active.lastHeartbeatAt = new Date().toISOString();
            active.stall = classifyAgentProgress(
              active,
              Date.now(),
              runtimeConnector.eventStream?.silenceThresholdSec ?? 600,
            );
          }
          this.persist();
        }, 10_000);
        let verdict;
        try {
          verdict = await watchOnce(runtimeConnector, taskText, targetDir, attemptPaths, {
            // No connector-owned or workflow-owned wall-clock kill timer.
            // A timeout is honored only when the workflow author explicitly
            // puts timeoutSec on this action.
            timeoutSec: step.timeoutSec ?? null,
            env: childEnv,
            shouldCancel: () => this.refreshCancellation(),
            onActivity: ({ at, bytes }) => {
              attemptRecord.lastActivityAt = at;
              attemptRecord.outputBytesObserved = Number(attemptRecord.outputBytesObserved ?? 0) + Number(bytes ?? 0);
              const active = this.state.activeAgents?.[activeKey];
              if (active) {
                active.lastActivityAt = at;
                active.lastProgressAt = at;
                active.outputBytesObserved = Number(active.outputBytesObserved ?? 0) + Number(bytes ?? 0);
              }
            },
            onAgentProgress: ({ at, providerType, model }) => {
              const active = this.state.activeAgents?.[activeKey];
              if (!active) return;
              active.lastEventAt = at;
              active.lastProgressAt = at;
              active.lastProviderEventType = providerType ?? null;
              attemptRecord.lastEventAt = at;
              if (model) {
                active.model = model;
                attemptRecord.model = model;
                if (step.type === 'decide' && this.state.orchestration) {
                  this.state.orchestration.selectedModel = model;
                  const selection = this.state.orchestration.selections?.at(-1);
                  if (selection?.attemptNumber === attemptNumber && selection.pool === conn.name) {
                    selection.model = model;
                  }
                }
              }
            },
            onAgentEvent: (event) => {
              const active = this.state.activeAgents?.[activeKey];
              if (!active) return;
              const change = recordAgentAction(active, event, 3);
              attemptRecord.lastActionAt = event.at;
              attemptRecord.actionCount = active.actionCount;
              attemptRecord.lastActions = active.lastActions;
              if (change.isNew || change.statusChanged) {
                this.emit('attempt.agent_action', {
                  actionId, attemptNumber, agentAction: change.action,
                });
              } else if (Date.now() - Number(active.lastPanePersistAtMs ?? 0) >= 1000) {
                active.lastPanePersistAtMs = Date.now();
                this.persist();
              }
            },
            model: selectedModel,
            conversation,
            acceptVerifyJson: step.type === 'verify',
            onSpawn: (pid) => {
              attemptRecord.childPid = pid;
              action.childPid = pid;
              this.state.activeAgents[activeKey].childPid = pid;
              this.emit('attempt.process_started', { actionId, attemptNumber, childPid: pid });
            },
          });
        } finally {
          clearInterval(heartbeat);
        }
        if (conversation && verdict.ok) {
          const thread = this.state.orchestration?.conversations?.[conn.name];
          if (thread?.sessionId === conversation.sessionId) {
            thread.started = true;
            thread.lastTurnAt = new Date().toISOString();
          }
        }
        this.state.activeAgents[activeKey].status = verdict.ok ? 'completed' : 'failed';
        this.state.activeAgents[activeKey].finishedAt = new Date().toISOString();
        this.state.activeAgents[activeKey].why = verdict.why;
        verdict.taskFile = attemptPaths.taskFile;
        verdict.outFile = attemptPaths.outFile;
        attemptRecord.status = verdict.ok ? 'succeeded' : verdict.cancelled ? 'cancelled' :
          (attempt < maxAttempts - 1 ? 'failed_retryable' : 'failed_terminal');
        attemptRecord.finishedAt = new Date().toISOString();
        attemptRecord.lastHeartbeatAt = this.state.activeAgents[activeKey].lastHeartbeatAt ?? attemptRecord.finishedAt;
        attemptRecord.lastActivityAt = this.state.activeAgents[activeKey].lastActivityAt ?? attemptRecord.lastActivityAt ?? null;
        attemptRecord.outputBytesObserved = this.state.activeAgents[activeKey].outputBytesObserved ?? attemptRecord.outputBytesObserved ?? 0;
        attemptRecord.lastEventAt = this.state.activeAgents[activeKey].lastEventAt ?? attemptRecord.lastEventAt ?? null;
        attemptRecord.lastActionAt = this.state.activeAgents[activeKey].lastActionAt ?? attemptRecord.lastActionAt ?? null;
        attemptRecord.lastActions = this.state.activeAgents[activeKey].lastActions ?? attemptRecord.lastActions ?? [];
        attemptRecord.stall = classifyAgentProgress(
          this.state.activeAgents[activeKey],
          Date.now(),
          runtimeConnector.eventStream?.silenceThresholdSec ?? 600,
        );
        attemptRecord.why = verdict.why ?? null;
        attemptRecord.usage = verdict.meta?.usage ?? null;
        attemptRecord.effort = effortTier;
        this.state.usage = aggregateUsage(this.state.attempts);
        if (verdict.cancelled) {
          attemptRecord.childTerminatedAt = attemptRecord.finishedAt;
          attemptRecord.childTerminationSignal = verdict.meta?.signal ?? null;
          this.emit('attempt.process_terminated', {
            actionId, attemptNumber, childPid: attemptRecord.childPid ?? null,
            signal: attemptRecord.childTerminationSignal, reason: 'workflow cancellation',
          });
        }
        action.status = attemptRecord.status;
        action.finishedAt = attemptRecord.finishedAt;
        this.emit('attempt.completed', {
          actionId, attemptNumber, status: attemptRecord.status, ok: verdict.ok, why: verdict.why ?? null,
          usage: attemptRecord.usage,
        });
        this.emit('action.observed', { actionId, attemptNumber, ok: verdict.ok, why: verdict.why ?? null });

        // R7: record EVERY dispatch into the shared decisionLog so
        // `bullswarm health` can correlate workflow outputs.
        this.appendDecision(step, conn.name, verdict, attemptPaths, attemptRecord.routing);

        // R7: auth/throttle verdict → quarantine the pool for 10 min so
        // the next dispatch doesn't re-select it.
        if (verdict.quarantineHint) {
          try {
            const coreState = loadState(this.bullswarmDir);
            quarantinePool(coreState, conn.name, verdict.why, Date.now());
            saveState(this.bullswarmDir, coreState);
            // Reflect the new quarantine on the live pool view used by
            // the next attempt of this very dispatch.
            const live = this.pools.find((p) => p.name === conn.name);
            if (live) {
              live.quarantine = coreState.pools[conn.name].quarantine;
            }
          } catch { /* best effort */ }
        }

        if (verdict.ok) {
          action.status = 'succeeded';
          this.emit('action.completed', { actionId, status: 'succeeded' });
          return verdict;
        }
        if (verdict.cancelled) {
          action.status = 'cancelled';
          this.emit('action.cancelled', { actionId, why: verdict.why });
          return verdict;
        }
        if (step.pool) {
          // A pinned pool cannot escalate, but it can repeat the same
          // invocation when retryAttempts was explicitly requested.
          if (attempt < maxAttempts - 1) {
            action.status = 'retry_scheduled';
            this.emit('attempt.retry_scheduled', { actionId, afterAttempt: attemptNumber });
            continue;
          }
          this.emit('action.failed', { actionId, status: 'failed_terminal', why: verdict.why ?? null });
          return verdict;
        }
        lastVerdict = verdict;
        // Escalate: drop the pool that just failed from this step's candidates.
        const failedName = conn.name;
        const idx = attemptPools.findIndex((p) => p.name === failedName);
        if (idx >= 0) attemptPools.splice(idx, 1);
        if (opts.escalate && !escalationUsed && attemptPools.length > 0) {
          escalationUsed = true;
          this.emit('step.escalate', {
            stepId: step.id, item: opts.item,
            from: failedName, why: verdict.why,
          });
          continue;
        }
        if (attempt < maxAttempts - 1 && !verdict.quarantineHint) {
          const failedPool = this.preparePools({ ...step, pool: failedName }, effortTier)[0];
          attemptPools.splice(0, attemptPools.length);
          if (failedPool) attemptPools.push(failedPool);
          action.status = 'retry_scheduled';
          this.emit('attempt.retry_scheduled', { actionId, afterAttempt: attemptNumber });
          continue;
        }
        break;
      }
      if (lastVerdict) this.emit('action.failed', { actionId, status: 'failed_terminal', why: lastVerdict.why ?? null });
      return lastVerdict;
    });
  }

  preparePools(step, effortTier = step.effort ?? ({ analyze: 'high', build: 'medium', chore: 'low' }[step.lane ?? 'chore']), { ignoreBurstGate = false } = {}) {
    // Fresh eligible list per dispatch: enabled, not quarantined, and
    // not currently burst-gated (R8). Quarantine has been applied to
    // pool.quarantine by the live buildPools pass; if a previous
    // dispatch in this run benched a pool we already mirrored that onto
    // this.pools above.
    const now = Date.now();
    for (const pool of this.pools) {
      if (pool.quarantine && !isQuarantined(pool, now)) pool.quarantine = null;
    }
    return this.pools.filter(
      (p) => p.enabled !== false && !isQuarantined(p, now) && (ignoreBurstGate || p.burstGate !== true) &&
        (step.pool == null || p.name === step.pool) &&
        !(step.avoidPools ?? []).includes(p.name) &&
        (step.requiresCapabilities ?? []).every((capability) =>
          (p.capabilities ?? p.connector?.capabilities ?? []).includes(capability)),
    ).map((pool) => {
      const assignment = pool.strategyAssignments?.[effortTier] ?? null;
      const modelPolicy = resolveDispatchModel(pool.connector ?? pool, effortTier, {
        assignment,
        excludedModels: pool.strategyExcludedModels ?? [],
      });
      return { ...pool, modelPolicy };
    }).filter((pool) => pool.modelPolicy.eligible);
  }

  /** Pools that would serve this step if they were not burst-gated. */
  burstGatedPoolsFor(step, effortTier) {
    return this.preparePools(step, effortTier, { ignoreBurstGate: true }).filter((p) => p.burstGate === true);
  }

  static describeBurstGate(pools) {
    return pools.map((p) => {
      const w = p.meterSnapshot?.five_hour ?? {};
      const used = Number.isFinite(w.utilization) ? `${Math.round(w.utilization)}% used` : 'usage unknown';
      const resets = w.resets_at ? `resets ${new Date(w.resets_at).toISOString().replace(/\.\d{3}Z$/, 'Z')}` : 'reset time unknown';
      return `${p.name} 5h window ${used}, ${resets}`;
    }).join('; ');
  }

  /**
   * If every pool that could serve `step` is burst-gated, wait for the gate
   * to lift instead of failing the action: the provider window resets at a
   * known time, the run is durable, and a failed run costs more than a late
   * one. Re-reads the meters every quotaPollMs; gives up (so the caller fails
   * with a clear reason) only after the latest known reset + grace, or after
   * BURST_WAIT_UNKNOWN_RESET_MS when no reset time is known.
   */
  async awaitBurstRoom(step, effortTier, actionId = step.id) {
    const gatedOnly = () => {
      if (this.preparePools(step, effortTier).length) return null;
      const gated = this.burstGatedPoolsFor(step, effortTier);
      return gated.length ? gated : null;
    };
    let gated = gatedOnly();
    if (!gated) return { waited: false };
    const resetTimes = gated.map((p) => Date.parse(p.meterSnapshot?.five_hour?.resets_at ?? '')).filter(Number.isFinite);
    const startedAt = Date.now();
    const deadline = resetTimes.length
      ? Math.max(...resetTimes) + this.quotaWaitGraceMs
      : startedAt + this.quotaWaitUnknownResetMs;
    const previousStage = this.state.stage;
    this.state.stage = 'waiting_for_quota';
    this.state.quotaWait = {
      actionId,
      since: new Date(startedAt).toISOString(),
      until: new Date(deadline).toISOString(),
      pools: gated.map((p) => ({
        name: p.name,
        fiveHourUsedPct: p.meterSnapshot?.five_hour?.utilization ?? null,
        resetsAt: p.meterSnapshot?.five_hour?.resets_at ?? null,
      })),
    };
    this.emit('dispatch.waiting_for_quota', { actionId, ...this.state.quotaWait, detail: WorkflowRuntime.describeBurstGate(gated) });
    const cancelled = () => {
      if (this.state.cancelRequested) return true;
      try { return JSON.parse(readFileSync(join(this.runDir, 'state.json'), 'utf8')).cancelRequested === true; } catch { return false; }
    };
    let lifted = false;
    while (Date.now() < deadline && !cancelled()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.quotaPollMs, Math.max(1, deadline - Date.now()))));
      for (const gatedView of gated) {
        // preparePools hands out copies; the gate lives on the pool itself.
        const pool = this.pools.find((p) => p.name === gatedView.name) ?? gatedView;
        let reading = null;
        try { reading = await this.readMeter(pool.name); } catch { reading = null; }
        // Only a real provider snapshot may open or keep the gate; a pool
        // without a meter reader ('none') leaves the gate as it was.
        if (!reading?.snapshot) continue;
        pool.burstGate = reading.burstGate === true;
        pool.meterSnapshot = reading.snapshot;
        if (reading.pacing) {
          pool.usedPct = reading.pacing.usedPct ?? pool.usedPct;
          pool.elapsedPct = reading.pacing.elapsedPct ?? pool.elapsedPct;
          pool.pace = reading.pacing.surplus ?? pool.pace;
        }
      }
      gated = gatedOnly();
      if (!gated) { lifted = true; break; }
    }
    const waitedMs = Date.now() - startedAt;
    delete this.state.quotaWait;
    this.state.stage = previousStage;
    if (lifted) {
      this.emit('dispatch.quota_available', { actionId, waitedMs });
    } else {
      this.emit('dispatch.quota_wait_expired', { actionId, waitedMs, detail: gated ? WorkflowRuntime.describeBurstGate(gated) : null, cancelled: cancelled() });
    }
    this.persist();
    return { waited: true, lifted, waitedMs, gated };
  }

  appendDecision(step, poolName, verdict, paths, routing = null) {
    try {
      const coreState = loadState(this.bullswarmDir);
      coreState.decisionLog ??= [];
      coreState.decisionLog.push({
        ts: new Date().toISOString(),
        lane: step.lane ?? 'chore',
        picked: poolName,
        keepOnClaude: false,
        ok: verdict.ok,
        why: verdict.why,
        wallSec: verdict.meta?.wallSec,
        model: verdict.pick?.model ?? null,
        usage: verdict.meta?.usage ?? null,
        routing,
        outFile: paths?.outFile ?? null,
        source: 'workflow',
        stepId: step.id,
      });
      if (coreState.decisionLog.length > 500) {
        coreState.decisionLog = coreState.decisionLog.slice(-500);
      }
      saveState(this.bullswarmDir, coreState);
    } catch { /* never let logging crash a run */ }
  }

  /** Warn once when dispatchCount crosses the configured visibility threshold. */
  maybeWarnLarge() {
    if (this.warningEmitted) return;
    const t = this.state?.settings?.warnAtAgents ?? 25;
    if (this.dispatchCount >= t) {
      this.warningEmitted = true;
      this.emit('workflow.large', {
        threshold: t,
        dispatchCount: this.dispatchCount,
      });
    }
  }

  /** Record, but never block on, crossing the planner's agent-count target. */
  maybeRecordTargetOverage() {
    if (this.targetExceededEmitted || !this.state.budget.targetExceeded) return;
    this.targetExceededEmitted = true;
    this.state.budget.targetExceededAt = new Date().toISOString();
    this.emit('workflow.agent_target_exceeded', {
      target: this.state.budget.dispatchTarget,
      dispatchCount: this.dispatchCount,
      overTargetBy: this.state.budget.overTargetBy,
      advisoryOnly: true,
    });
  }

  async runStep(step, opts = {}) {
    const scope = this.scopeFor(step);
    this.ensureAction(step, opts);
    if (step.type === 'run') {
      return this.runSingle(step, scope, opts);
    }
    if (step.type === 'fanout') {
      return this.runFanout(step, scope, opts);
    }
    if (step.type === 'verify') {
      return this.runVerify(step, scope, opts);
    }
    if (step.type === 'decide') {
      return this.runDecision(step, scope, opts);
    }
    throw new Error(`unknown step type ${step.type}`);
  }

  /**
   * Enforce inputs.<k>.required at runtime. Throws if any required input
   * is missing or empty. Called by runSingle / runFanout / runVerify before
   * any dispatch.
   */
  enforceRequiredInputs(stepId) {
    const docInputs = this.state._doc?.inputs ?? {};
    for (const [k, spec] of Object.entries(docInputs)) {
      if (!spec || spec.required !== true) continue;
      const v = this.state.inputs?.[k];
      const missing = v === undefined || v === null || v === '' ||
        (typeof v === 'string' && v.trim() === '');
      if (missing) {
        throw new Error(
          `required input "${k}" is missing for step "${stepId}" ` +
          `(pass --input ${k}=… or declare a default in the workflow doc)`,
        );
      }
    }
  }

  async runSingle(step, scope, opts = {}) {
    this.enforceRequiredInputs(step.id);
    const rendered = renderDeep(
      {
        lane: step.lane ?? 'chore',
        addDir: step.addDir,
        prompt: step.prompt,
        taskFile: step.taskFile,
      },
      scope,
    );
    const taskText = rendered.prompt
      ?? readFileSync(rendered.taskFile, 'utf8');
    const targetDir = rendered.addDir ? String(rendered.addDir).replace(/^~/, process.env.HOME ?? '') : process.cwd();

    const stamp = `${step.id}-${Date.now().toString(36)}`;
    const paths = {
      taskFile: join(this.runDir, `task-${stamp}.md`),
      outFile: join(this.runDir, `out-${stamp}.md`),
    };

    const verdict = await this.dispatch(step, taskText, targetDir, paths, {
      escalate: this.state.settings.escalateOnFail !== false,
      retryAttempts: opts.retryAttempts,
      phase: opts.phase,
    });
    delete this.state.activeAgents?.[step.id];
    const finalPaths = { taskFile: verdict.taskFile ?? paths.taskFile, outFile: verdict.outFile ?? paths.outFile };
    this.recordOutput(step.id, verdict, finalPaths);
    if (verdict.ok) this.emit('artifact.published', { actionId: step.id, outFile: finalPaths.outFile });
    return verdict;
  }

  /**
   * Adversarial verifier step (skeptic). Renders its prompt against the
   * normal scope, dispatches a single run, then judges the verdict plus
   * the prior step's output by asking the model to RETURN ONLY a JSON
   * object: {ok: bool, concerns: [string], summary: string}. The step
   * records the parsed JSON in `state.outputs[step.id].verify` and the
   * step is `ok:true` only if the JSON parses AND ok===true.
   *
   * If no schema is provided we fall back to a plain run that writes
   * the prior output through the verify gate — the work is delivered
   * downstream unchanged.
   */
  async runVerify(step, scope, opts = {}) {
    this.enforceRequiredInputs(step.id);
    if (!step.review) {
      throw new Error(
        `verify step "${step.id}" needs a "review" path ` +
        `(e.g. review: "outputs.<priorStep>.outFile")`,
      );
    }
    const reviewedText = (() => {
      try {
        // `review` is a dotted path into the scope, NOT a template
        // (matches the design of `fanout.itemsFrom`). Resolve it the
        // same way — getPath is the official path accessor.
        const v = getPath(scope, step.review);
        if (typeof v !== 'string') {
          throw new Error(
            `review target "${step.review}" did not resolve to a file path ` +
            `(got ${typeof v})`,
          );
        }
        return readFileSync(v, 'utf8');
      } catch (err) {
        throw new Error(`verify "${step.id}" review target unreadable: ${err.message}`);
      }
    })();

    const reviewInstructions = [
      step.prompt ?? 'You are a skeptical reviewer. Independently inspect the work and its current repository state.',
      '',
      'RETURN ONLY a single JSON object of the form',
      '{"ok": <true|false>, "concerns": [<string>...], "summary": <string>}.',
      'No prose and no markdown fences. Set ok:true only when the requested checks actually pass.',
    ].join('\n');
    // Only the reviewer INSTRUCTIONS are a template. The review target is a
    // worker's artifact — arbitrary text that routinely contains code, JSDoc
    // types and other double-brace sequences — and is appended verbatim,
    // never rendered. (Observed 2026-08-28: a worker report quoting
    // `{{maxLength?: number}}` killed its verify at render time.)
    const rendered = renderDeep({
      lane: step.lane ?? 'analyze',
      addDir: step.addDir,
      prompt: reviewInstructions,
    }, scope);
    // A custom prompt changes the review instructions, never the review
    // input. Always append the resolved artifact so the skeptic receives
    // the thing it is meant to judge.
    const taskText = [
      rendered.prompt,
      '',
      '---- BEGIN REVIEW TARGET ----',
      reviewedText,
      '---- END REVIEW TARGET ----',
    ].join('\n');
    const targetDir = rendered.addDir ? String(rendered.addDir).replace(/^~/, process.env.HOME ?? '') : process.cwd();

    const stamp = `${step.id}-${Date.now().toString(36)}`;
    const paths = {
      taskFile: join(this.runDir, `task-${stamp}.md`),
      outFile: join(this.runDir, `out-${stamp}.md`),
    };

    const verdict = await this.dispatch(step, taskText, targetDir, paths, {
      escalate: this.state.settings.escalateOnFail !== false,
      retryAttempts: opts.retryAttempts,
      phase: opts.phase,
    });
    delete this.state.activeAgents?.[step.id];

    const finalPaths = { taskFile: verdict.taskFile ?? paths.taskFile, outFile: verdict.outFile ?? paths.outFile };

    let parsed = null;
    let parseError = null;
    try {
      const out = readFileSync(finalPaths.outFile, 'utf8');
      const start = out.indexOf('{');
      const end = out.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const j = JSON.parse(out.slice(start, end + 1));
        if (j && typeof j === 'object') parsed = j;
      }
    } catch (err) {
      parseError = err.message;
    }

    const ok = verdict.ok && !!parsed && parsed.ok === true;
    const verifyVerdict = {
      ok,
      keepOnClaude: false,
      why: ok
        ? 'verify ok'
        : parseError
          ? `verify json parse failed: ${parseError}`
          : !verdict.ok
            ? `verify dispatch failed: ${verdict.why}`
            : 'verify json returned ok:false',
      pick: verdict.pick,
      meta: verdict.meta,
      outFile: finalPaths.outFile,
      taskFile: finalPaths.taskFile,
      verify: parsed,
      contentUsableDespiteExit: verdict.contentUsableDespiteExit,
    };

    // Record into state.outputs the same way runSingle does, with
    // `verify` attached so downstream steps can reference concerns/summary.
    this.recordOutput(step.id, verifyVerdict, finalPaths);
    // Augment with the parsed concerns/summary for the report.
    if (parsed) {
      this.state.outputs[step.id].verify = parsed;
      this.persist();
    }
    return verifyVerdict;
  }

  async runDecision(step, scope, opts = {}) {
    this.enforceRequiredInputs(step.id);
    await this.awaitBurstRoom(step, step.effort ?? 'high', step.id);
    const deliveredSteering = deliverSteering(this.state, this.runDir);
    for (const steering of deliveredSteering) {
      this.emit('steering.delivered', {
        steeringId: steering.id,
        gateId: step.id,
        decisionSequence: steering.decisionSequence,
      });
    }
    // The planner sees what each action actually said, not just ok/why: an
    // excerpt of every output, newest first, under a total character budget so
    // long runs stay within the planner's context.
    let excerptBudget = PLANNER_EXCERPT_TOTAL_CHARS;
    const excerptFor = (output) => {
      const text = typeof output?.outputText === 'string' ? output.outputText.trim() : '';
      if (!text) return { outputExcerpt: null };
      if (excerptBudget <= 0) return { outputExcerpt: null, outputExcerptOmitted: true, outputChars: text.length };
      const limit = Math.min(PLANNER_EXCERPT_CHARS, excerptBudget);
      const excerpt = text.length > limit ? `${text.slice(0, limit)}\n…[${text.length - limit} more chars in outFile]` : text;
      excerptBudget -= excerpt.length;
      return { outputExcerpt: excerpt, outputChars: text.length };
    };
    const outputEntries = Object.entries(this.state.outputs ?? {});
    const excerpts = new Map(outputEntries.slice().reverse().map(([id, output]) => [id, excerptFor(output)]));
    const outputs = Object.fromEntries(outputEntries.map(([id, output]) => [id, {
      ok: output?.ok,
      why: output?.why ?? null,
      pool: output?.pool ?? null,
      outFile: output?.outFile ?? null,
      verify: output?.verify ?? null,
      total: output?.total,
      succeeded: output?.succeeded,
      failed: output?.failed,
      itemsFrom: output?.itemsFrom,
      ...excerpts.get(id),
    }]));
    const actionForPlanner = (action) => ({
      id: action.id,
      parentId: action.parentId ?? null,
      type: action.kind,
      phase: action.phase ?? null,
      status: action.status,
      dependsOn: action.dependsOn ?? [],
      item: action.item,
      attempts: (action.attempts ?? []).map((index) => this.state.attempts?.[index]).filter(Boolean),
      startedAt: action.startedAt ?? null,
      finishedAt: action.finishedAt ?? null,
      why: action.why ?? null,
    });
    const workflowElapsedSec = Math.max(0,
      (Date.now() - Date.parse(this.state.startedAt)) / 1000);
    const workflowTargetSec = this.state.settings?.maxWorkflowSeconds == null
      ? null
      : Number(this.state.settings.maxWorkflowSeconds);
    this.state.budget.workflowElapsedSec = Math.round(workflowElapsedSec * 10) / 10;
    this.state.budget.workflowTargetSec = Number.isFinite(workflowTargetSec)
      ? workflowTargetSec
      : null;
    this.state.budget.workflowRemainingSec = Number.isFinite(workflowTargetSec)
      ? Math.max(0, workflowTargetSec - workflowElapsedSec)
      : null;
    this.state.budget.workflowOverTargetBySec = Number.isFinite(workflowTargetSec)
      ? Math.max(0, workflowElapsedSec - workflowTargetSec)
      : 0;
    this.state.budget.advisoryOnly = true;
    const budget = plannerBudgetContext(this.state.budget);
    const completionPolicy = this.state.orchestration?.completionPolicy ?? {};
    const verificationReserve = completionPolicy.requireSuccessfulVerification === true ? 1 : 0;
    const plannerContext = {
      intent: this.state.intent,
      completedActions: (this.state.actionLedger ?? []).filter((action) =>
        ['succeeded', 'failed_terminal', 'cancelled', 'abandoned'].includes(action.status)).map(actionForPlanner),
      outputs,
      failures: (this.state.actionLedger ?? []).filter((action) =>
        ['failed_terminal', 'abandoned'].includes(action.status)).map(actionForPlanner),
      closedPhases: [...new Set((this.state.plan?.actions ?? [])
        .filter((action) => action.source === 'planner')
        .map((action) => action.definition?.phase)
        .filter(Boolean))],
      budget,
      executionConstraints: {
        concurrency: Number(this.state.settings?.concurrency ?? 1) || 1,
        readySiblingsRunConcurrently: true,
        programFeatures: ['itemsFrom', 'repair', 'completion'],
        plannerConsultedOnlyAtProgramBoundary: true,
        actionTimeoutSec: Number(step.actionDefaults?.timeoutSec ?? step.timeoutSec) || null,
        actionTimeoutIsExplicitOptIn: step.actionDefaults?.timeoutSec != null || step.timeoutSec != null,
        retryAttempts: Number(this.state.settings?.retryAttempts ?? 0),
        verificationDispatchReserve: verificationReserve,
        dispatchesAvailableBeforeReserve: budget.remainingDispatches == null
          ? null
          : Math.max(0, budget.remainingDispatches - verificationReserve),
        completionPolicy,
      },
      approval: this.state.approval ?? null,
      validationFeedback: opts.correction ? {
        attempt: opts.correction.attempt,
        maxAttempts: opts.correction.maxAttempts,
        why: opts.correction.why,
        issues: opts.correction.issues ?? [],
        rejectedProposal: opts.correction.rejectedProposal ?? null,
        rejectedResponseExcerpt: opts.correction.rejectedResponse ?? null,
      } : null,
      operatorSteering: (this.state.steering ?? []).map((entry) => ({
        id: entry.id,
        message: entry.message,
        queuedAt: entry.queuedAt,
        deliveredAt: entry.deliveredAt,
        decisionSequence: entry.decisionSequence,
      })),
      availablePools: this.pools.filter((pool) =>
        pool.enabled !== false && !pool.quarantine && pool.burstGate !== true).map((pool) => ({
          name: pool.name,
          lanes: pool.lanes ?? pool.connector?.lanes ?? [],
          capabilities: pool.capabilities ?? pool.connector?.capabilities ?? [],
          pace: pool.pace ?? null,
        })),
    };
    const rendered = renderDeep({
      prompt: step.prompt ?? 'Judge whether the workflow has enough evidence to finish.',
      addDir: step.addDir,
    }, scope);
    const taskText = [
      rendered.prompt,
      '',
      ...(opts.correction ? [
        `CORRECTION REQUIRED (attempt ${opts.correction.attempt} of ${opts.correction.maxAttempts}): the runtime rejected your previous decision. validationFeedback in the durable context lists the exact issues. Fix only those issues and return the corrected JSON decision. No prose, no markdown fences.`,
        '',
      ] : []),
      `Return ONLY JSON with schemaVersion "${DECISION_SCHEMA_VERSION}", decision, reason, and actions.`,
      'Allowed decisions: proceed, complete, needs_more_work, retry, escalate, wait_for_approval, stop.',
      'Every proposed action MUST use the field "type" (never "kind").',
      'Every action MUST include a forward-only kebab-case "phase". Never reuse a name listed in closedPhases.',
      '',
      'PLANNING DOCTRINE — you are compiling the goal into a PROGRAM, not choosing the next step:',
      '- The runtime executes your whole decision to completion without consulting you: a ready-set scheduler starts every action whose dependsOn have all succeeded, concurrently up to executionConstraints.concurrency, and starts each dependent the moment its own dependencies finish. You are consulted again only at the program boundary, when every action has finished or the graph is blocked. Each consultation is a separate process round trip (typically 1-2 minutes), so anything decidable by data must be encoded in the program, never deferred to a later decision.',
      '- Propose the COMPLETE dependency graph you can see now: discovery, per-item work, per-item verification, and the final whole-system verification, all in ONE decision. A decision carrying a single action when several are obvious wastes a round trip.',
      '- Unknown item count: never spend a decision to learn how many items there are. Propose a discovery run action whose prompt ends with "RETURN ONLY a JSON array of <items>", plus a fanout with "itemsFrom":"outputs.<discovery-id>.outFile" whose stepTemplate.prompt uses {{item}}. The runtime resolves the list when discovery finishes (with one bounded read-only extraction retry if the output is not a clean array) and fans out immediately.',
      '- Verification failures: give each verify a "repair" policy {"prompt":"<how to fix what the verifier rejects>","maxRounds":1-3}. When the verifier returns ok:false, the runtime runs a fix action carrying the verifier concerns verbatim and re-runs the same verify, inside the program. Only verifies still failing after their rounds come back to you.',
      '- A verify that returned ok:true is accepted. Its concerns are informational (overlaps, wording nits, "non-blocking" notes): do not spend a program round polishing them unless the goal text itself demands it. Only ok:false verifies are work.',
      '- Self-completing programs: when the program you propose ends with verification that would satisfy the goal, add a top-level "completion": {"when":"all-actions-ok","reason":"<what a clean run proves>"}. If every action of the program (repairs included) finishes ok and the completion policy is met, the runtime records the completion itself and does not consult you again; anything failing brings the boundary back to you. Use it on every program whose clean run would be the finished goal.',
      '- Per-item chains: for N known items propose N focused run actions plus N verify actions, each verify depending only on its own run, so verifying one item overlaps with fixing another; add one final verify depending on all of them. For items discovered at run time use the discovery → fanout → verify shape above.',
      '- File ownership: every action prompt must name exactly which files it may edit and state that it must not touch any other file. Two actions that must edit the same file MUST be ordered with dependsOn; never let concurrent actions write the same file.',
      '- Self-contained prompts: a worker sees only its own prompt, never this context. Each prompt must state the absolute working directory, what to read, what to change, the exact command that proves success, and what to report back. Prefer many small parallel actions over one large serial one.',
      '- Read before you compile: outputs.<id>.outputExcerpt is what each finished action actually reported (outputs.scout, when present, is a read-only survey of the repository: tree, manifest, test status, units of work, shared files, risks). Name real files, modules, and commands from it in your program instead of guessing.',
      '',
      'Action skeletons (copy the shape exactly; every field shown is required unless marked optional):',
      '  run:    {"id":"bounded-action","type":"run","phase":"implement","prompt":"Do bounded work.","dependsOn":["prior-action"]}',
      '  fanout: {"id":"per-item-check","type":"fanout","phase":"inspect","items":["alpha","beta"],"stepTemplate":{"prompt":"Inspect {{item}} and report concrete evidence."},"dependsOn":["prior-action"]}',
      '  fanout (data-driven): {"id":"per-module-fix","type":"fanout","phase":"fix","itemsFrom":"outputs.discover-modules.outFile","stepTemplate":{"prompt":"In /abs/repo fix only the module {{item}}; run its focused test; report the diff summary."}}',
      '  verify: {"id":"independent-check","type":"verify","phase":"verify","prompt":"Independently re-run the tests and report pass/fail with evidence.","dependsOn":["bounded-action"],"repair":{"prompt":"In /abs/repo fix the failing behaviour the verifier reports, editing only the files named in the concerns, then re-run the tests.","maxRounds":1}}',
      'verify semantics: the reviewer receives the artifact of the action named in review, which the runtime infers as outputs.<the single dependsOn>.outFile; put the reviewer INSTRUCTIONS in prompt. A verify with several dependsOn must set review explicitly to "outputs.<actionId>.outFile". review is never instructions or a filesystem path.',
      'Program skeleton (discovery → data-driven fan-out → verify with repair → final whole-suite check, all in ONE decision; the runtime runs it to the end without you):',
      '  [{"id":"discover-modules","type":"run","phase":"discover","prompt":"In /abs/repo list every module under src/ whose test in tests/ fails. Do not edit anything. RETURN ONLY a JSON array of module names, e.g. [\\"alpha\\",\\"beta\\"]."},',
      '   {"id":"fix-module","type":"fanout","phase":"fix","itemsFrom":"outputs.discover-modules.outFile","stepTemplate":{"prompt":"In /abs/repo edit only src/{{item}}.js so tests/{{item}}.test.js passes; run node --test tests/{{item}}.test.js; report the diff summary."}},',
      '   {"id":"verify-modules","type":"verify","phase":"verify-items","prompt":"For every module in the reviewed fan-out summary re-run node --test tests/<module>.test.js in /abs/repo and confirm tests/ is unchanged.","dependsOn":["fix-module"],"repair":{"prompt":"In /abs/repo fix the modules the verifier lists, editing only their src files, and re-run their tests.","maxRounds":2}},',
      '   {"id":"verify-suite","type":"verify","phase":"verify-suite","prompt":"Run the full npm test in /abs/repo and report pass/fail counts.","dependsOn":["verify-modules"]}]',
      'Graph skeleton (two parallel fix→verify chains plus a final whole-suite check, all in ONE decision):',
      '  [{"id":"fix-alpha","type":"run","phase":"fix","prompt":"In /abs/repo edit only src/alpha.js so tests/alpha.test.js passes; run node --test tests/alpha.test.js; report the diff summary."},',
      '   {"id":"fix-beta","type":"run","phase":"fix","prompt":"In /abs/repo edit only src/beta.js so tests/beta.test.js passes; run node --test tests/beta.test.js; report the diff summary."},',
      '   {"id":"verify-alpha","type":"verify","phase":"verify-items","prompt":"Re-run node --test tests/alpha.test.js in /abs/repo and confirm tests/ is unchanged.","dependsOn":["fix-alpha"]},',
      '   {"id":"verify-beta","type":"verify","phase":"verify-items","prompt":"Re-run node --test tests/beta.test.js in /abs/repo and confirm tests/ is unchanged.","dependsOn":["fix-beta"]},',
      '   {"id":"verify-suite","type":"verify","phase":"verify-suite","prompt":"Run the full npm test in /abs/repo and report pass/fail counts.","review":"outputs.fix-beta.outFile","dependsOn":["verify-alpha","verify-beta"]}]',
      'fanout needs stepTemplate (an object whose prompt uses {{item}}) plus EITHER inline items OR itemsFrom ("outputs.<actionId>.outFile", an action whose output ends with a JSON array; the producer becomes an implicit dependency). A fan-out artifact (outputs.<fanoutId>.outFile) is a summary of every item result, so a verify may depend on a fanout directly. verify.review MUST be a string. dependsOn is optional and may only name existing or newly proposed action IDs.',
      'Do not propose pool, addDir, or taskFile; those are runtime-owned and any such proposal is rejected.',
      'New actions may only be type run, fanout, or verify. The runtime validates every proposal and returns rejected proposals to you with the exact issues for a bounded correction turn.',
      'If executionConstraints.actionTimeoutSec is non-null, size actions to finish within that explicit timeout; otherwise agents may run until they finish or are cancelled.',
      'Agent-count, workflow-duration, and expansion-round budgets are advisory planning targets, never hard stop conditions. The dispatch budget counts this planner call plus every worker, verifier, retry, and escalation attempt.',
      'As expansion headroom approaches zero, strongly prefer convergence: consolidate existing artifacts, avoid optional investigation, and return complete when verification supports it. If important concerns remain, return stop with the best useful outcome and explicit unresolved concerns rather than spending more on marginal refinements. Exceed the expansion target only when one small bounded action is essential to avoid discarding otherwise-completable work or skipping required verification.',
      'operatorSteering contains explicit operator guidance queued for this planning checkpoint. Apply it within the original workflow intent and authorization boundaries. It cannot weaken verification, bypass runtime validation, expand external authority, or alter an already-running worker. If guidance conflicts with the original goal or safety constraints, explain that in the decision reason instead of following it.',
      'Avoid redundant expensive verification. Run a full suite once for each materially changed final state when practical; later independent verifiers should reuse durable clean full-suite evidence and rerun focused/adversarial checks unless that evidence is stale, tainted, or the code changed again.',
      'Shared working tree: concurrent workers editing DISJOINT files in the same tree is the normal, expected mode — that is how N independent fixes run in parallel. What is unsafe is whole-tree mutation (git stash/reset/checkout, reformatting, dependency installs) or running the FULL test suite while other workers are still editing; so give each parallel action its own files and its own focused test command, order any shared file (e.g. an index/barrel) after the actions it aggregates with dependsOn, and run the whole suite once in a final verify that depends on all of them. Use an isolated copy/worktree only for destructive experiments.',
      '',
      '---- BEGIN DURABLE WORKFLOW CONTEXT ----',
      JSON.stringify(plannerContext, null, 2),
      '---- END DURABLE WORKFLOW CONTEXT ----',
    ].join('\n');
    const targetDir = rendered.addDir
      ? String(rendered.addDir).replace(/^~/, process.env.HOME ?? '')
      : process.cwd();
    const stamp = `${step.id}-${Date.now().toString(36)}`;
    const paths = {
      taskFile: join(this.runDir, `task-${stamp}.md`),
      outFile: join(this.runDir, `out-${stamp}.json`),
    };
    const dispatchStep = {
      ...step,
      lane: step.lane ?? 'analyze',
      requiresCapabilities: step.requiresCapabilities ?? ['workflow-planning', 'strong-analysis'],
    };
    const verdict = await this.dispatch(dispatchStep, taskText, targetDir, paths, {
      escalate: this.state.settings.escalateOnFail !== false,
      retryAttempts: opts.retryAttempts,
      phase: opts.phase,
    });
    delete this.state.activeAgents?.[step.id];
    const finalPaths = { taskFile: verdict.taskFile ?? paths.taskFile, outFile: verdict.outFile ?? paths.outFile };
    let proposal = null;
    let parseError = null;
    if (verdict.ok) {
      try {
        proposal = parseDecisionText(readFileSync(finalPaths.outFile, 'utf8'));
      } catch (err) {
        parseError = err.message;
      }
    }
    const result = {
      ...verdict,
      ok: verdict.ok && proposal != null,
      dispatchOk: verdict.ok === true,
      parseError,
      why: proposal ? `planner proposed ${proposal.decision ?? 'unknown'}` :
        (parseError ? `planner response invalid: ${parseError}` : verdict.why),
      proposal,
      taskFile: finalPaths.taskFile,
      outFile: finalPaths.outFile,
    };
    this.recordOutput(step.id, result, finalPaths);
    return result;
  }

  async runFanout(step, scope, opts = {}) {
    this.enforceRequiredInputs(step.id);
    // itemsFrom is a dotted path into the workflow state (NOT a
    // template). It can be either:
    //   - a real array reference: e.g. `inputs.items` — extractItems
    //     will resolve it via getPath and return the array.
    //   - a file path stored in a prior step's outFile: e.g.
    //     `outputs.discover.outFile` — extractItems will open that
    //     file and parse the JSON array inside.
    // The validator (validate.js) already ensures itemsFrom starts
    // with `inputs.` or `outputs.`, so the literal-string case (no
    // {{ }}) is exactly what we want.
    const items = Array.isArray(step.items) ? step.items : extractItems(this.state, step.itemsFrom);
    const parentAction = this.ensureAction(step, opts);
    parentAction.status = 'running';
    parentAction.startedAt ??= new Date().toISOString();
    parentAction.itemsTotal = items.length;
    const concurrency = Math.max(1, Math.min(
      step.concurrency ?? this.state.settings.concurrency ?? 4,
      this.state.settings.concurrency ?? Infinity,
    ));
    // Global cap is the limiter's capacity; per-fanout workers cannot
    // exceed it. The design doc claims R4 and this is the enforcement.
    const workerCap = Math.min(concurrency, this.limiter.permits);
    const results = new Array(items.length).fill(null);
    let cursor = 0;
    let failures = 0;
    const resumed = this.state.outputs?.[step.id]?.items ?? [];

    // R10: build a fingerprint map of prior results so resume is robust
    // against the items array changing between runs. Items are matched by
    // their sha1 fingerprint; if a prior result lacks a fingerprint (old
    // state.json) we fall back to positional alignment for THAT item only.
    const fpOf = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
    const resumedByFp = new Map();
    for (const r of resumed) {
      if (!r) continue;
      const fp = r.fingerprint ?? (r.item !== undefined ? fpOf(r.item) : null);
      if (fp) resumedByFp.set(fp, r);
    }

    const worker = async () => {
      while (cursor < items.length) {
        if (this.state.cancelRequested) break;
        const i = cursor++;
        const item = items[i];
        const fp = fpOf(item);

        // R10: skip by fingerprint first; fall back to positional if
        // either side has no fingerprint (old state.json).
        const byFp = resumedByFp.get(fp);
        const byPos = resumed[i];
        const prev = (byFp && byFp.verdict?.ok === true)
          ? byFp
          : ((!byFp && byPos?.verdict?.ok === true) ? byPos : null);

        if (prev) {
          results[i] = { ...prev, item, fingerprint: fp };
          const itemAction = this.ensureAction(step, { ...opts, item, itemIndex: i });
          itemAction.status = 'succeeded';
          itemAction.finishedAt ??= new Date().toISOString();
          this.emit('item.skipped', { stepId: step.id, index: i, item, fingerprint: fp });
          continue;
        }

        const itemScope = { ...scope, item };
        let template;
        try {
          template = renderDeep(step.stepTemplate, itemScope);
        } catch (err) {
          const itemAction = this.ensureAction(step, { ...opts, item, itemIndex: i });
          itemAction.status = 'failed_terminal';
          itemAction.finishedAt = new Date().toISOString();
          itemAction.why = err.message;
          results[i] = { verdict: { ok: false, why: err.message }, pool: null };
          failures++;
          this.emit('action.failed', { actionId: itemAction.id, status: itemAction.status, why: err.message });
          this.emit('item.failed', { stepId: step.id, index: i, item, why: err.message });
          continue;
        }

        const stamp = `${step.id}-${i}-${Date.now().toString(36)}`;
        const paths = {
          taskFile: join(this.runDir, `task-${stamp}.md`),
          outFile: join(this.runDir, `out-${stamp}.md`),
        };

        const targetDir = template.addDir
          ? String(template.addDir).replace(/^~/, process.env.HOME ?? '')
          : process.cwd();
        const taskText = template.prompt
          ?? readFileSync(String(template.taskFile), 'utf8');

        this.emit('item.started', { stepId: step.id, index: i, total: items.length, item });
        const verdict = await this.dispatch(
          { ...step, ...template, id: step.id },
          taskText, targetDir, paths,
          { item, itemIndex: i, phase: opts.phase, escalate: this.state.settings.escalateOnFail !== false, retryAttempts: opts.retryAttempts },
        );
        results[i] = { item, verdict, outFile: verdict.outFile ?? paths.outFile, fingerprint: fp };
        if (verdict.ok) {
          this.emit('item.completed', { stepId: step.id, index: i, pool: verdict.pick?.pool, wall: verdict.meta?.wallSec });
        } else {
          failures++;
          this.emit('item.failed', { stepId: step.id, index: i, why: verdict.why, pool: verdict.pick?.pool });
        }
        this.persist();
        delete this.state.activeAgents?.[`${step.id}[${i}]`];
        this.persist();
      }
    };

    // Worker count is min(per-fanout concap, global limiter permits,
    // items.length). The semaphore runWith() inside dispatch also acquires
    // a global permit; the worker cap is just how many dispatch loops we
    // start in parallel.
    const totalWorkers = Math.max(1, Math.min(workerCap, items.length));
    // Emit queued event for any work waiting behind the global cap.
    if (items.length > totalWorkers) {
      this.emit('step.blocked', { stepId: step.id, queued: items.length - totalWorkers });
    }
    await Promise.all(Array.from({ length: totalWorkers }, worker));

    const oks = results.filter((r) => r?.verdict?.ok === true).length;
    if (this.state.cancelRequested) failures += items.length - results.filter(Boolean).length;
    // A fan-out is itself an artifact: write a durable summary of every item
    // result so a verify (or a later fan-out) can depend on the fan-out
    // directly via outputs.<fanoutId>.outFile, the same way it depends on a run.
    const summary = this.writeFanoutSummary(step, items, results, oks);
    // `ok` is a boolean like every other output (so dependents and the
    // ready-set scheduler can test outputs.<id>.ok === true); the item count
    // lives in `succeeded`.
    this.state.outputs[step.id] = {
      total: items.length,
      ok: failures === 0,
      succeeded: oks,
      failed: items.length - oks,
      items: results,
      ...(step.itemsResolvedFrom ? { itemsFrom: step.itemsResolvedFrom } : {}),
      outFile: summary.outFile,
      outputText: summary.outputText,
      outputTruncated: summary.truncated || undefined,
    };
    parentAction.status = failures === 0 ? 'succeeded' : 'failed_terminal';
    parentAction.itemsCompleted = oks;
    parentAction.itemsFailed = items.length - oks;
    parentAction.finishedAt = new Date().toISOString();
    this.emit(failures === 0 ? 'action.completed' : 'action.failed', {
      actionId: step.id, status: parentAction.status, itemsCompleted: oks, itemsFailed: items.length - oks,
    });
    this.persist();
    return { ok: failures === 0, results };
  }

  writeFanoutSummary(step, items, results, oks) {
    const lines = [`# fanout ${step.id}: ${oks}/${items.length} items ok`, ''];
    for (const [index, entry] of results.entries()) {
      const item = entry?.item ?? items[index];
      const label = typeof item === 'string' ? item : JSON.stringify(item);
      const verdict = entry?.verdict;
      lines.push(`## [${index}] ${label} — ${verdict?.ok === true ? 'ok' : `failed: ${verdict?.why ?? 'no result'}`}`);
      if (entry?.outFile) lines.push(`artifact: ${entry.outFile}`);
      let text = '';
      try {
        if (entry?.outFile && existsSync(entry.outFile)) text = readFileSync(entry.outFile, 'utf8');
      } catch { /* the per-item artifact is optional in the summary */ }
      if (text.trim()) {
        lines.push('', text.length > FANOUT_ITEM_EXCERPT_BYTES
          ? `${text.slice(0, FANOUT_ITEM_EXCERPT_BYTES)}\n[truncated]` : text.trimEnd());
      }
      lines.push('');
    }
    const outFile = join(this.runDir, `out-${step.id}-summary-${Date.now().toString(36)}.md`);
    const full = lines.join('\n');
    try { writeFileSync(outFile, full); } catch { /* summary is best-effort; items remain in state */ }
    const truncated = full.length > OUTPUT_TEXT_CAP_BYTES;
    return { outFile, outputText: truncated ? full.slice(0, OUTPUT_TEXT_CAP_BYTES) : full, truncated };
  }

  recordOutput(stepId, verdict, paths) {
    let outputText = null;
    let truncated = false;
    try {
      if (paths.outFile && existsSync(paths.outFile)) {
        const raw = readFileSync(paths.outFile, 'utf8');
        if (raw.length > OUTPUT_TEXT_CAP_BYTES) {
          outputText = raw.slice(0, OUTPUT_TEXT_CAP_BYTES);
          truncated = true;
        } else {
          outputText = raw;
        }
      }
    } catch { /* non-fatal */ }
    this.state.outputs[stepId] = {
      ok: verdict.ok,
      pool: verdict.pick?.pool ?? null,
      why: verdict.why,
      outFile: paths.outFile,
      wallSec: verdict.meta?.wallSec,
      outputText,
      outputTruncated: truncated || undefined,
    };
    this.persist();
  }
}
