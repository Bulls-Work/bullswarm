import { withV2Cancellation } from './v2-cancellation.js';
// bullswarm workflow CLI — goal | plan | runs | watch | tui.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRuns, cmdReindex } from './runs-cli.js';
import { resolveRunId } from './short-id.js';
import { runDashboard, dashboardJson, overviewSnapshot } from './dashboard.js';
import { readEvents } from './events.js';
import { KIND_DEFAULTS } from './action-validator.js';
import { isProgramV3 } from './program-v3.js';
import { wfAdd, wfContinue, wfWait } from './cli-steps.js';
import { DELIVERABLE_TYPES, EVIDENCE_TYPES, STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES } from './step-vocabulary.js';
import { EVIDENCE_DEFAULT_TIMEOUT_SEC, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_TIMEOUT_SEC, EVIDENCE_ENV_KEYS, CHECKER_PATH } from './evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from './schema-check.js';
import { validateV2GoalDocument } from './v2-state.js';
import { runV2AutonomousWorkflow } from './v2-runtime.js';
import { pauseV2Run, reopenV2RunForRetry, unpauseV2Run } from './run-control.js';
import { workerSilenceTimeoutSec } from './v2-dispatch.js';
import { routeSummary } from './step-route.js';
import { isProgramWorkflow } from './execution-policy.js';
import { requestCancel } from './dashboard.js';
import { v2RoleCatalog } from './v2-planner.js';
import { loadState } from '../lib/state.js';
import { runWorkflowWatch } from './watch-cli.js';
import { queueSteering } from './steering.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { cmdReprice } from './reprice.js';
import { stepPageModel } from './step-model.js';
import { taskStepInput, taskStepModel } from './task-step.js';
import { stepJsonModel } from './step-json.js';
import { listAssignments } from '../lib/assignments.js';
import { resolvePoolId } from '../lib/pool-labels.js';
import { workflowHelpPath, parseFlags, flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal, loadV2RunState } from './cli-run-lookup.js';
import { programRoutes, routePoolIssues, configuredPools, livePoolNames } from './cli-pool-checks.js';
import { executeGoalDocument, launchDetachedResume, printGoalLaunchInstructions } from './cli-launch.js';
import { wfPlan } from './cli-plan.js';
import { wfGoal } from './cli-goal.js';
import { wfStep } from './cli-step-verbs.js';

function isHomeSnapshot(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, '.snapshot.json'), 'utf8'));
    return marker?.kind === 'bullswarm-home-snapshot' && marker?.version === 1;
  } catch {
    return false;
  }
}

export async function cmdWorkflow(args, {
  bullswarmDir = BULLSWARM_DIR(), input = process.stdin, output = process.stdout,
  runsAlias = null,
} = {}) {
  // A leading flag means no subcommand was given: `workflow --bogus` is a
  // flag error on the workflow root, not an unknown subcommand named
  // "--bogus".
  const [head, ...tail] = args;
  const sub = flagName(head) ? undefined : head;
  const opts = parseFlags(sub === undefined ? args : tail);
  for (const key of ['pool', 'worker-pool', 'orchestrator', 'strict-orchestrator']) {
    if (typeof opts[key] === 'string' && opts[key] !== 'auto') {
      opts[key] = resolvePoolId(opts[key], bullswarmDir);
    }
  }

  if (!sub && input.isTTY && output.isTTY) {
    try { return await runDashboard(bullswarmDir, { input, output }); }
    catch (err) { console.error(`✗ ${err.message}`); return 1; }
  }

  // One gate for every workflow verb whose flags are parsed here. `plan` and
  // `runs` re-parse their own tail against their own subcommand's table, so
  // they run the same check inside their own dispatcher instead.
  // Reprice owns its small flag grammar so it can also be invoked from tests
  // with an injected transcript reader.  The central flag registry/help node
  // is integrator-owned and will add its allow-list alongside the new leaf.
  if (sub !== 'plan' && sub !== 'runs' && sub !== 'reprice') {
    const path = workflowHelpPath(sub, opts);
    if (path) {
      const flagExit = unknownFlagExit(opts.flags, path);
      if (flagExit !== null) return flagExit;
    }
  }

  switch (sub) {
    case 'goal':
      return wfGoal(opts);
    case 'plan':
      return wfPlan(tail);
    case 'cancel':
      return wfCancel(opts);
    case 'pause':
      return wfPause(opts);
    case 'resume':
      return wfResume(opts);
    case 'runs':
      return cmdRuns(tail, runsAlias ? { alias: runsAlias } : {});
    case 'reindex':
      return cmdReindex(tail);
    case 'reprice':
      return cmdReprice(tail, { bullswarmDir });
    case 'capabilities':
      return wfCapabilities(opts);
    case 'tui':
      try {
        {
          const token = opts.rest[0] ?? opts.show;
          if (token) {
            const legacy = legacyRunRefusal(token, { json: Boolean(opts.json) });
            if (legacy !== null) return legacy;
          }
        }
        if (opts.overview) {
          const token = opts.rest[0] ?? opts.show;
          if (!token) { console.error(`usage: ${usageLine(['workflow', 'tui'])}\n--overview needs a run: pass <runId> or --show <runId>`); return 2; }
          const snapshot = overviewSnapshot(bullswarmDir, token, { width: opts.width, height: opts.height });
          if (opts.json) console.log(JSON.stringify(snapshot, null, 2));
          else console.log(snapshot.lines.join('\n'));
          return snapshot.legacy ? 2 : 0;
        }
        if (opts.json || opts.cancel || opts.show || opts.all) {
          const token = opts.rest[0] ?? opts.show;
          const result = dashboardJson(bullswarmDir, {
            all: opts.all || (opts.json && isHomeSnapshot(bullswarmDir)),
            token,
            cancel: opts.cancel,
          });
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        return await runDashboard(bullswarmDir, { token: opts.rest[0] ?? null, input, output });
      }
      catch (err) { console.error(`✗ ${err.message}`); return 1; }
    case 'events':
      return wfEvents(opts);
    case 'watch':
      return wfWatch(opts);
    case 'steer':
      return wfSteer(opts);
    case 'action':
      return wfAction(opts);
    case 'task':
      return wfTask(opts, bullswarmDir);
    case 'step':
      return wfStep(opts);
    case 'continue':
      return wfContinue(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume });
    case 'add':
      return wfAdd(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume, routeIssues: (actions, doc, state) => (programRoutes(actions) ? routePoolIssues(actions, configuredPools(), doc, undefined, state, { recordedWork: true }) : []) });
    case 'wait':
      return wfWait(opts, { bullswarmDir, helpText, flagErrors });
    default: {
      // Smart error: if the user typed a `runs` subcommand directly
      // under `workflow` (e.g. `workflow show jd3uki`), point them at
      // the right verb instead of dumping the whole help text.
      const runsSubcommands = new Set(['show', 'delete']);
      if (sub && runsSubcommands.has(sub)) {
        console.error(
          `✗ "workflow ${sub}" is not a subcommand. ` +
          `Did you mean "workflow runs ${sub} <id>"?`,
        );
        return 2;
      }
      console.error(helpText(['workflow']));
      return 2;
    }
  }
}

async function wfPause(opts) {
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

async function wfCancel(opts) {
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

async function wfResume(opts) {
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

async function wfCapabilities(opts) {
  const { pools } = await livePoolNames();
  const coreState = loadState(BULLSWARM_DIR());
  const result = {
    lanes: ['analyze', 'build', 'chore'],
    engines: {
      autonomousV2: {
        command: 'bullswarm workflow goal',
        goalSchema: 'bullswarm.workflow.goal.v2',
        stateSchema: 'bullswarm.workflow.state.v2',
        resultSchema: 'bullswarm.workflow.result.v2',
        actionModel: 'generic work and evidence actions',
        // Reported from the validator table, not restated, so a new kind is
        // visible to a probing agent the moment the closed list gains it.
        actionKinds: JSON.parse(JSON.stringify(KIND_DEFAULTS)),
        // Program-mode vocabulary beside kinds: the roles (each kind belongs to
        // one), the deliverable types a step may promise, and the evidence
        // types, of which only review (a check step with evidenceFor) is usable.
        actionRoles: v2RoleCatalog(),
        deliverableTypes: [...DELIVERABLE_TYPES],
        evidenceTypes: { types: [...EVIDENCE_TYPES], usable: [...USABLE_EVIDENCE_TYPES], note: 'choice is recorded by bullswarm workflow step accept (never proof)' },
        stepEvidence: {
          fieldTypes: [...STEP_EVIDENCE_TYPES], maxItems: EVIDENCE_MAX_ITEMS,
          timeoutSec: { default: EVIDENCE_DEFAULT_TIMEOUT_SEC, max: EVIDENCE_MAX_TIMEOUT_SEC },
          schemaKeywords: [...SCHEMA_ASSERTED_KEYWORDS], schemaIgnored: [...SCHEMA_IGNORED_KEYWORDS],
          schemaFormats: ['json', 'jsonl'], outputFile: '$output', env: [...EVIDENCE_ENV_KEYS],
          actRetry: false, checker: CHECKER_PATH,
        },
        completionAuthority: 'kernel action results; requirement evidence is reported separately',
        features: {
          plannerCreatesBoundedProgram: true,
          plannerCannotDeclareCompletion: true,
          dependencyReadyConcurrency: true,
          enforcedFileOwnership: false,
          optionalWorktreeIsolation: true,
          sharedWorkspaceByDefault: true,
          automaticGapRounds: false,
          requirementEvidenceAndInvalidation: true,
          deterministicOutputPreflight: true,
          mechanicalRetriesOnly: true,
          semanticRepairLoops: false,
          detachedRunner: true,
          durableOrderedEvents: true,
          resumable: true,
          cooperativeCancellation: true,
          presentationStagesDerivedFromActions: true,
          advisoryPlanningTargets: true,
          callerPlanner: true,
          programRequired: true,
          livePlanRevisions: true,
          pauseAndResume: true,
          // A run never waits for its caller, a pool, or a silent worker: it
          // finishes and its result hands back what is left.
          runsNeverWait: true,
          resultHandback: true,
          resumeRetriesFinishedRuns: true,
          workerSilenceTimeoutSec: workerSilenceTimeoutSec(),
        },
        plannerModes: {
          caller: 'default: the calling agent authors the program (workflow plan contract|validate, workflow goal --program, workflow plan export|revise); the kernel never dispatches a planner and never waits for the caller: a run that needs a decision finishes, and its result hands the decision back',
          dispatched: 'explicit --orchestrator auto|<pool>: the kernel routes a Workflow Planner agent process at each planning boundary; in runs started by this version a usage limit or no free pool stops the planner (or the scout before it) with no move to another pool, a nearly spent pool is never given to either, and the run finishes with the caller\'s options (routing.failureRule.plannerAndScout)',
        },
        defaults: { concurrency: 4, maxAgents: 30, maxActions: 100, maxExpansionRounds: 2, plannerMode: 'caller', executionMode: 'program', workspaceMode: 'shared' },
        compatibility: { resumesAutonomousV1: false, migratesAutonomousV1: false, preservesSavedV2Semantics: true },
      },
      // Retired in 0.27.0, but still reported so an agent that probes for the
      // authored-graph engine reads an explicit retirement instead of undefined.
      authoredGraphs: {
        retired: '0.27.0',
        command: null,
        documentSchema: null,
        stepTypes: [],
        legacyRuns: 'run directories remain readable as rows marked legacy; every driving command fails closed with exit 2',
      },
    },
    routing: {
      automatic: true,
      selection: 'Constraints first: the step\'s route, a run-wide pin, the model policy and the effort tier. Then 5-hour burst gates, free-first (never for checks), quota urgency, the tier assignment and pace surplus. In runs started by this version a review runs only where its route puts it; earlier runs keep automatic writer avoidance.',
      failureRule: {
        retriesPerStep: 1,
        processFailure: 'retry once on another eligible pool; the same pool when it is the only candidate (except auth)',
        gateFailure: 'retry once on the same pool with the failure attached',
        quota: 'a usage limit (a spent 5-hour or weekly window, or no credit left: a notice that says so, with or without a reset, or a full meter) ends the step and goes to the caller at once, never waited out, moved or retried; retryAfter is the reset when it is known, else the earliest known return when no capable pool is free',
        throttle: 'a transient rate limit (too many requests, no usage window spent) backs off on the same pool at most twice without spending the retry (20 s, then 60 s, or a named wait of at most 2 minutes), then goes to the caller; a longer named wait goes to the caller at once, with retryAfter at its end; a backoff whose pool is no longer free goes to the caller at once, as quota when that pool is out on a usage limit, with retryAfter its known return',
        noFreePool: 'no capable pool free at the first pick (nearly spent, or a 5-hour, weekly or monthly window at its limit): the step goes to the caller, as quota when every reason is a usage limit, else unavailable; why names each pool and its reason; retryAfter is the earliest known return; a promised retry that finds no free pool keeps the last failure\'s kind and its why ends "· no retry: <pool> <reason>; …"',
        plannerAndScout: 'the dispatched planner and the preflight scout follow the quota, throttle and noFreePool rules: a usage limit, a rate limit still there after its short same-pool backoff, or no free pool stops them with no move to another pool; a nearly spent pool (its window closes soon and the dispatch would push it past its limit) is never given to them either, unless the caller named it; the run finishes partial with "the workflow planner stopped on a usage limit: <why>" (or "the preflight scout stopped on a usage limit: <why>" for a scout with no program after it; "stopped: no pool free" when a pool was out for another reason or no pool can run it at all), back at retryAfter when known, and the caller\'s options (bullswarm workflow resume after retryAfter runs the stopped planner turn or scout again; plan it yourself with plan revise; or start a new run); a scout before a caller program lets the run go on without its report, and resume does not run that scout again; a sign-in failure, a provider error or a worker that died at start still moves them to another pool',
        then: 'caller; only dependents wait',
        savedRuns: 'keep their original retry and review rules',
      },
      modelSelection: 'connector-declared discovery and model flag; approved assignments may select a model; excluded models are never dispatched and force an allowed tier fallback when supported',
      strategyPolicy: coreState.strategy?.policy ?? null,
      assignments: coreState.strategy?.assignments ?? {},
      excludedModels: coreState.strategy?.excludedModels ?? [],
    },
    worktreeIsolation: {
      policy: coreState.config?.worktreeIsolation ?? 'agent-decides',
      autonomousV2: 'mutating actions use isolated worktrees unless policy is off; shared writers are serialized and changed-path ownership is enforced before integration',
    },
    pools: pools.map((p) => ({
      name: p.name,
      enabled: p.enabled !== false,
      lanes: p.lanes ?? p.connector?.lanes ?? [],
      capabilities: p.capabilities ?? p.connector?.capabilities ?? [],
      command: p.connector?.profile?.command ?? p.connector?.spawn?.cmd?.[0] ?? null,
      configDir: p.connector?.profile?.configDir ?? p.connector?.env?.CLAUDE_CONFIG_DIR ?? null,
      model: (() => {
        const cmd = p.connector?.spawn?.cmd ?? [];
        const i = cmd.indexOf('--model');
        return i >= 0 ? cmd[i + 1] ?? null : null;
      })(),
      meter: p.meter ?? { type: p.connector?.meter?.type ?? 'none' },
      usedPct: p.usedPct ?? null,
      pace: p.pace ?? null,
      burstGate: p.burstGate === true,
      fiveHourUsedPct: p.fiveHourUsedPct ?? null,
      nearFiveHourLimit: p.nearFiveHourLimit === true,
    })),
  };
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function wfEvents(opts) {
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'events'])}`);
    return 2;
  }
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) {
    console.error(`✗ no run found for "${token}"`);
    return 1;
  }
  const after = Number(opts.after ?? 0);
  if (!Number.isInteger(after) || after < 0) {
    console.error('✗ --after must be a non-negative integer');
    return 2;
  }
  const events = readEvents(resolved.runDir, { after });
  console.log(JSON.stringify({ action: 'events', runId: resolved.runId, shortId: resolved.shortId, after, count: events.length, events }, null, 2));
  return 0;
}

async function wfWatch(opts) {
  // A value flag with no value (--heartbeat, --interval, --stall-after,
  // --after, --since) is a usage error, not a silent fall back to the default.
  const flagError = flagErrors(opts, ['workflow', 'watch']);
  if (flagError != null) return flagError;
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'watch'])}`);
    return 2;
  }
  // --classic forces the older heartbeat-based watcher, which has no notion
  // of notable events to wake up on, so it cannot combine with --next.
  if (opts.classic === true && opts.next === true) {
    console.error('✗ --classic cannot combine with --next (--next only applies to event mode)');
    return 2;
  }
  // --until is its own stopping rule and prints only trouble and the outcome.
  let until = null;
  if (opts.until != null) {
    if (!['outcome', 'trouble'].includes(opts.until)) {
      console.error(`✗ --until must be outcome or trouble (got "${opts.until}")`);
      return 2;
    }
    const clash = ['next', 'once', 'classic', 'heartbeat'].filter((flag) => opts[flag] != null);
    if (clash.length) {
      console.error(`✗ --until cannot combine with ${clash.map((flag) => `--${flag}`).join(', ')}: it prints only trouble and the outcome`);
      return 2;
    }
    until = opts.until;
  }
  const intervalSec = Number(opts.interval ?? 2);
  // --heartbeat is opt-in: absent means no periodic line in event mode, and
  // the historical 60s in --once/--classic mode.
  const heartbeatSec = opts.heartbeat == null ? null : Number(opts.heartbeat);
  if (!Number.isFinite(intervalSec) || intervalSec < 0.1 ||
      (heartbeatSec != null && (!Number.isFinite(heartbeatSec) || heartbeatSec < 1))) {
    console.error('✗ --interval must be >= 0.1 seconds and --heartbeat must be >= 1 second');
    return 2;
  }
  const stallAfterSec = Number(opts['stall-after'] ?? 300);
  if (!Number.isFinite(stallAfterSec) || stallAfterSec < 1) {
    console.error('✗ --stall-after must be >= 1 second');
    return 2;
  }
  // Continuity for a relaunched watcher: both values come from the `next:` line
  // the previous --next exit printed.
  let afterSequence = null;
  if (opts.after != null) {
    afterSequence = Number(opts.after);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      console.error('✗ --after must be a non-negative integer');
      return 2;
    }
  }
  let sinceMs = null;
  if (opts.since != null) {
    sinceMs = Date.parse(opts.since);
    if (!Number.isFinite(sinceMs)) {
      console.error('✗ --since must be an ISO 8601 timestamp');
      return 2;
    }
  }
  try {
    return await runWorkflowWatch(BULLSWARM_DIR(), token, {
      intervalMs: intervalSec * 1000,
      heartbeatMs: heartbeatSec == null ? null : heartbeatSec * 1000,
      stallAfterMs: stallAfterSec * 1000,
      afterSequence,
      sinceMs,
      once: opts.once === true,
      next: opts.next === true,
      classic: opts.classic === true,
      jsonl: opts.jsonl === true,
      verbose: opts.verbose === true,
      until,
    });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function wfSteer(opts) {
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

// A V2 run keeps its graph in state.program.actions and its per-action
// bookkeeping in state.actions.
function v2ActionJson(resolved, state, actionId) {
  const action = state.program?.actions?.find((entry) => entry.id === actionId);
  if (!action) throw new Error(`run "${resolved.shortId ?? resolved.runId}" has no action "${actionId}"`);
  const actionState = state.actions?.find((entry) => entry.id === actionId) ?? null;
  const step = stepPageModel({
    runId: resolved.runId,
    shortId: resolved.shortId ?? state.shortId ?? null,
    runDir: resolved.runDir,
    state,
  }, { actionId });
  return {
    action: 'show-action',
    runId: resolved.runId,
    shortId: resolved.shortId ?? null,
    runDir: resolved.runDir,
    actionRecord: {
      id: action.id,
      purpose: action.purpose,
      status: actionState?.status ?? 'unknown',
      // `kind` only when the author supplied one; lane and effort are always
      // the values acceptance resolved, which is what dispatch used.
      ...(action.kind ? { kind: action.kind } : {}),
      ...(action.role ? { role: action.role } : {}),
      ...(action.deliverable ? { deliverable: action.deliverable } : {}),
      lane: action.lane,
      effort: action.effort,
      ...(action.reasoning ? { reasoning: action.reasoning } : {}),
      ...(action.route ? { route: action.route, routeSummary: routeSummary(action.route) } : {}),
      dependsOn: action.dependsOn,
      affects: action.affects,
      evidenceFor: action.evidenceFor,
      ownedFiles: action.ownedFiles,
      inputs: action.inputs ?? [],
      produces: action.produces ?? [],
      programRevision: actionState?.programRevision ?? null,
      outputFile: actionState?.outputFile ?? null,
      artifactIds: actionState?.artifactIds ?? [],
      lastFailure: actionState?.lastFailure ?? null,
      ...(actionState?.acceptance ? { acceptance: actionState.acceptance } : {}),
    },
    // Each attempt as stored, including `retryOf` on one the dispatcher
    // started because of an earlier one (stage 3).
    attempts: (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId),
    events: readEvents(resolved.runDir).filter((event) =>
      event.payload?.actionId === actionId || event.payload?.parentId === actionId),
    step: stepJsonModel(step),
  };
}

function wfAction(opts) {
  const [sub, token, actionId] = opts.rest;
  if (sub !== 'show' || !token || !actionId) {
    console.error(`usage: ${usageLine(['workflow', 'action', 'show'])}`);
    return 2;
  }
  // The refusal is the same single line every other verb prints; --json asks
  // for the machine form instead.
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  try {
    const resolved = resolveRunId(BULLSWARM_DIR(), token);
    if (!resolved) throw new Error(`no run found for "${token}"`);
    const state = withV2Cancellation(JSON.parse(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')), resolved.runDir);
    console.log(JSON.stringify(v2ActionJson(resolved, state, actionId), null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function taskRecordFor(home, token) {
  const live = listAssignments(home, { prune: false }).filter((entry) => entry?.source === 'run');
  let finished = [];
  try {
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    finished = (state?.decisionLog ?? []).filter((entry) => entry?.kind === 'run' || entry?.source === 'run');
  } catch { /* a home with only a live ledger is still inspectable */ }
  const records = [...live, ...finished];
  const exact = records.find((entry) => entry?.id === token);
  if (exact) return exact;
  const matches = records.filter((entry) => typeof entry?.id === 'string' && entry.id.endsWith(token));
  if (matches.length > 1) throw new Error(`task id "${token}" is ambiguous`);
  return matches[0] ?? null;
}

/** Read one standalone task through the dashboard's shared Step projection. */
function wfTask(opts, home) {
  const [sub, token] = opts.rest;
  if (sub !== 'show' || !token) {
    console.error(`usage: ${usageLine(['workflow', 'task', 'show'])}`);
    return 2;
  }
  try {
    const taskRecord = taskRecordFor(home, token);
    if (!taskRecord) throw new Error(`no task found for "${token}"`);
    const input = taskStepInput(taskRecord, { runsDir: join(home, 'runs') });
    const attempt = input.row.state.attempts[0] ?? null;
    const actionRecord = input.row.state.actions[0] ?? null;
    const step = stepJsonModel(taskStepModel(input));
    console.log(JSON.stringify({
      action: 'show-task',
      taskId: taskRecord.id ?? null,
      taskRecord,
      actionRecord,
      attempts: attempt ? [attempt] : [],
      events: [],
      step,
    }, null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}
