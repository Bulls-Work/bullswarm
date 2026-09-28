// `bullswarm workflow pause | cancel | resume | steer`: the caller's control
// of a whole run.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId } from './short-id.js';
import { isProgramV3 } from './program-v3.js';
import { validateV2GoalDocument } from './v2-state.js';
import { runV2AutonomousWorkflow } from './v2-runtime.js';
import { pauseV2Run, reopenV2RunForRetry, unpauseV2Run } from './run-control.js';
import { isProgramWorkflow } from './execution-policy.js';
import { requestCancel } from './dashboard.js';
import { runWorkflowWatch } from './watch-cli.js';
import { queueSteering } from './steering.js';
import { helpText, usageLine } from '../help.js';
import { flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal, loadV2RunState } from './cli-run-lookup.js';
import { livePoolNames } from './cli-pool-checks.js';
import { executeGoalDocument, launchDetachedResume, printGoalLaunchInstructions } from './cli-launch.js';

export async function wfPause(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'pause'])); return 0; }
  const flagExit = flagErrors(opts, ['workflow', 'pause']);
  if (flagExit !== null) return flagExit;
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'pause'])}`); return 2; }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  let run;
  try { run = loadV2RunState(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const mode = opts.now ? 'now' : 'drain';
  let outcome;
  try { outcome = await pauseV2Run({ bullswarmDir: BULLSWARM_DIR(), runId: run.runId, mode, source: 'cli', waitMs: opts.now ? 60_000 : 0 }); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const id = run.state.shortId ?? run.runId;
  const running = (outcome.state?.actions ?? []).filter((action) => action.status === 'running').map((action) => action.id);
  const payload = {
    action: 'pause', runId: run.runId, shortId: run.state.shortId ?? null, status: outcome.status, mode,
    already: outcome.already, appliedBy: outcome.appliedBy, running: outcome.status === 'pausing' ? running : [],
    next: { resume: `bullswarm workflow resume ${id}`, ...(isProgramV3(run.state.program) ? { add: `bullswarm workflow add ${id} --steps part.json` } : { export: `bullswarm workflow plan export ${id} --out plan.json` }) },
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  if (outcome.status === 'paused') console.log(`✓ workflow ${id} ${outcome.already ? 'was already' : 'is'} paused; nothing new starts until: ${payload.next.resume}`);
  else if (outcome.status === 'pausing') {
    console.log(`✓ pause requested for ${id}; nothing new starts. ${running.length} running step${running.length === 1 ? '' : 's'} ${mode === 'now' ? 'being stopped' : 'finish first'}${running.length ? ` (${running.join(', ')})` : ''}`);
    console.log(`  watch    bullswarm workflow watch ${id} --next`);
  } else console.log(`workflow ${id} reached ${outcome.status} before the pause took effect`);
  console.log(payload.next.add ? `  add      ${payload.next.add}` : `  revise   ${payload.next.export}, then bullswarm workflow plan revise ${id} --program plan.json`);
  return 0;
}

// --- workflow cancel / resume: first-class management verbs --------------------

export async function wfCancel(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'cancel'])); return 0; }
  const flagExit = flagErrors(opts, ['workflow', 'cancel']);
  if (flagExit !== null) return flagExit;
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'cancel'])}`); return 2; }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  let resolvedRun;
  try { resolvedRun = loadV2RunState(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const { state } = resolvedRun;
  const id = state.shortId ?? state.runId;
  const terminal = ['completed', 'partial', 'cancelled', 'failed'].includes(state.lifecycle?.status);
  if (terminal) {
    const payload = { action: 'cancel', runId: state.runId, shortId: state.shortId ?? null, alreadyFinished: true, finalized: false, status: state.lifecycle.status, result: `bullswarm workflow runs result ${id} --json` };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`workflow ${id} is already terminal (${state.lifecycle.status}); result: ${payload.result}`);
    return 0;
  }
  let requested = state.cancellation?.requested ? state : null;
  if (!requested) {
    try { requested = requestCancel(BULLSWARM_DIR(), token, { source: 'cli' }).state; }
    catch (err) { console.error(`✗ ${err.message}`); return 1; }
  }
  // A caller-planner run paused at a boundary, or a run stopped by workflow
  // pause, has no kernel alive to honor the request; finalize it here. The
  // kernel reads the cancellation at the top of its loop and records the
  // cancelled result without dispatching.
  if (requested.planner?.awaiting || ['paused', 'waiting'].includes(requested.lifecycle?.status)) {
    let finished;
    try {
      const doc = JSON.parse(readFileSync(join(resolvedRun.runDir, 'goal.json'), 'utf8'));
      finished = await runV2AutonomousWorkflow({ bullswarmDir: BULLSWARM_DIR(), goalDocument: doc, pools: [], resumeRunId: state.runId });
    } catch (err) {
      console.error(`✗ cancellation recorded for ${id} but it could not be finalized here: ${err.message}; run bullswarm workflow resume ${id} --foreground to finalize`);
      return 1;
    }
    const payload = {
      action: 'cancel', runId: state.runId, shortId: state.shortId ?? null, alreadyFinished: false, finalized: true,
      status: finished.result?.status ?? finished.state?.lifecycle?.status ?? 'cancelled',
      result: `bullswarm workflow runs result ${id} --json`,
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`✓ workflow ${id} ${state.lifecycle?.status === 'waiting' ? 'was waiting at a gate or loop' : 'was paused for its caller planner'}; cancelled and finalized (${payload.status}); result: ${payload.result}`);
    return 0;
  }
  const payload = {
    action: 'cancel', runId: state.runId, shortId: state.shortId ?? null, alreadyFinished: false, finalized: false,
    status: requested.lifecycle?.status ?? state.lifecycle?.status,
    note: 'cooperative: the running kernel stops at its next safe checkpoint; an interrupted kernel records the cancelled result on its next resume',
    next: { watch: `bullswarm workflow watch ${id}`, resume: `bullswarm workflow resume ${id} --foreground --json` },
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`✓ cancellation requested for ${id}; ${payload.note}`);
    console.log(`  watch    ${payload.next.watch}`);
  }
  return 0;
}

// Returns null (the run is not finished), the reopen outcome, or an exit code
// after printing why nothing was relaunched.
function reopenFinishedRun(resolvedRun, opts) {
  let current = null;
  try { current = JSON.parse(readFileSync(join(resolvedRun.runDir, 'state.json'), 'utf8')); } catch { return null; }
  if (!['completed', 'partial', 'cancelled', 'failed'].includes(current?.lifecycle?.status)) return null;
  const id = resolvedRun.shortId ?? resolvedRun.runId;
  let outcome;
  try { outcome = reopenV2RunForRetry({ bullswarmDir: BULLSWARM_DIR(), runId: resolvedRun.runId }); }
  catch (err) { console.error(`✗ cannot reopen ${id}: ${err.message}`); return 1; }
  if (outcome.status === 'live') { console.error(`✗ a kernel is still finishing ${id}; watch it with bullswarm workflow watch ${id} --next`); return 1; }
  if (outcome.status === 'not-finished') return null;
  if (outcome.status === 'nothing-to-retry') {
    const program = isProgramWorkflow(current);
    const payload = {
      action: 'resume', status: 'nothing-to-retry', runId: resolvedRun.runId, shortId: resolvedRun.shortId ?? null,
      runStatus: current.lifecycle.status, needsCaller: outcome.needsCaller ?? [],
      next: {
        result: `bullswarm workflow runs result ${id} --json --summary`,
        ...(program && isProgramV3(current.program)
          ? { add: `bullswarm workflow add ${id} --steps part.json`, rerun: `bullswarm workflow step rerun ${id} <step>` }
          : program ? { revise: `bullswarm workflow plan export ${id} --out plan.json, then bullswarm workflow plan revise ${id} --program plan.json --rerun <step ids>` } : {}),
      },
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.error(`✗ nothing to retry in ${id} (${current.lifecycle.status}): no step stopped for a reason a plain retry fixes; nothing was relaunched`);
      for (const entry of payload.needsCaller) console.error(`  ${entry.id}  ${entry.status}${entry.failureKind ? ` (${entry.failureKind})` : ''}`);
      if (payload.next.revise) console.error(`  change the plan: ${payload.next.revise}`);
      if (payload.next.add) console.error(`  add steps: ${payload.next.add}\n  rerun a step: ${payload.next.rerun}`);
      console.error(`  result: ${payload.next.result}`);
    }
    return 1;
  }
  // A step that failed with a return time still ahead (its pool out of quota;
  // every pool that can run it out) can fail the same way
  // when it runs before then. Say so; the caller chose to retry now.
  const retryNow = Date.now();
  const stillOut = (current.actions ?? []).filter((action) => outcome.requeued.includes(action.id)
    && Date.parse(action.lastFailure?.retryAfter ?? '') > retryNow);
  if (!opts.json) {
    // A marked run's Workflow Planner or preflight scout that stopped on a
    // limit runs again first; it is named as what it is, not by its id.
    const dispatch = outcome.dispatch ?? null;
    const running = outcome.requeued.map((entry, index) => (dispatch && index === 0 && entry === dispatch.id ? dispatch.who : entry));
    console.log(`✓ reopened the ${outcome.previousStatus} run ${id}; running again: ${running.join(', ')}`);
    if (dispatch && Date.parse(dispatch.retryAfter ?? '') > retryNow) {
      console.log(`  note: ${dispatch.who} stopped with its pool back at ${dispatch.retryAfter}; run before then, it can fail the same way again`);
    }
    for (const action of stillOut) console.log(`  note: ${action.id} stopped with its pool back at ${action.lastFailure.retryAfter}; run before then, it can fail the same way again (at once when no other pool is free)`);
  }
  return outcome;
}

export async function wfResume(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'resume'])); return 0; }
  const flagExit = flagErrors(opts, ['workflow', 'resume']);
  if (flagExit !== null) return flagExit;
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'resume'])}`); return 2; }
  if (opts.watch && (opts.foreground || opts.json)) { console.error('✗ --watch cannot combine with --foreground or --json'); return 2; }
  if (opts.program || opts.orchestrator !== undefined || opts['strict-orchestrator'] !== undefined || opts.scout || opts['suggested-plan'] !== undefined || opts.isolation !== undefined) {
    console.error(`✗ a resumed run keeps its durable planner mode and routing; to change its plan use: bullswarm workflow plan revise ${token} --program <file.json>`);
    return 2;
  }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  const resolvedRun = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolvedRun) { console.error(`✗ no run found for "${token}"`); return 1; }
  const durableGoalPath = join(resolvedRun.runDir, 'goal.json');
  let doc;
  try {
    if (!existsSync(durableGoalPath)) throw new Error('the run has no durable goal.json to resume from');
    doc = JSON.parse(readFileSync(durableGoalPath, 'utf8'));
    validateV2GoalDocument(doc);
  } catch (err) { console.error(`✗ cannot resume ${resolvedRun.runId}: ${err.message}`); return 1; }
  if (typeof doc.intent?.cwd !== 'string' || !existsSync(doc.intent.cwd) || !statSync(doc.intent.cwd).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${doc.intent?.cwd ?? '(missing)'}`);
    return 1;
  }
  // Resume is the one command that lifts a pause. A pause still draining is
  // withdrawn and the live kernel simply carries on.
  try {
    const current = JSON.parse(readFileSync(join(resolvedRun.runDir, 'state.json'), 'utf8'));
    if (current.lifecycle?.status === 'paused' || current.pause || existsSync(join(resolvedRun.runDir, 'pause.json'))) {
      const lifted = unpauseV2Run({ bullswarmDir: BULLSWARM_DIR(), runId: resolvedRun.runId, source: 'cli' });
      if (lifted.kernelAlive) {
        const token = resolvedRun.shortId ?? resolvedRun.runId;
        const payload = { action: 'goal-resumed', runId: resolvedRun.runId, shortId: resolvedRun.shortId ?? null, status: 'running', pauseWithdrawn: true, note: 'the pause had not taken effect; the running kernel continues' };
        if (opts.json) console.log(JSON.stringify(payload, null, 2));
        else console.log(`✓ pause withdrawn for ${token}; its running kernel continues`);
        return 0;
      }
    }
  } catch (err) { console.error(`✗ cannot lift the pause on ${resolvedRun.runId}: ${err.message}`); return 1; }
  // Resume on a finished run is a retry: it reopens the run for the steps a
  // plain retry can fix, or says there are none and launches nothing.
  const reopened = reopenFinishedRun(resolvedRun, opts);
  if (typeof reopened === 'number') return reopened;
  if (opts.foreground) {
    const { pools } = await livePoolNames();
    return executeGoalDocument({ doc, pools, opts, resumeRunId: resolvedRun.runId });
  }
  let launch;
  try { launch = await launchDetachedResume(doc, resolvedRun.runId, opts); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  if (reopened) launch.reopened = { previousStatus: reopened.previousStatus, requeued: reopened.requeued, archivedResult: reopened.archivedResult };
  if (opts.json) console.log(JSON.stringify(launch, null, 2));
  else {
    console.log(`✓ workflow ${launch.shortId ?? resolvedRun.runId} resumed independently (${launch.status})`);
    printGoalLaunchInstructions({ ...launch, shortId: launch.shortId ?? resolvedRun.runId });
  }
  if (opts.watch) return runWorkflowWatch(BULLSWARM_DIR(), resolvedRun.runId, { waitForRunMs: 30_000 });
  return 0;
}

export function wfSteer(opts) {
  const token = opts.rest[0];
  const message = opts.message ?? opts.rest.slice(1).join(' ');
  if (!token || !message) {
    console.error(`usage: ${usageLine(['workflow', 'steer'])}`);
    return 2;
  }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  try {
    const result = queueSteering(BULLSWARM_DIR(), token, message);
    const payload = {
      action: 'steer',
      runId: result.runId,
      shortId: result.shortId,
      steering: result.entry,
      currentStep: result.state.currentStep ?? null,
      note: 'queued for the next not-yet-started orchestration checkpoint; the active worker is unchanged',
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`✓ steering ${result.entry.id} queued for ${result.shortId ?? result.runId}; active work is unchanged`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}
