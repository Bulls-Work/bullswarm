import { withV2Cancellation } from './v2-cancellation.js';
// bullswarm workflow CLI — goal | plan | runs | watch | tui.

import {
  existsSync, statSync, readFileSync, writeFileSync, mkdirSync,
  openSync, closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { buildPools, buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { cmdRuns } from './runs-cli.js';
import { newRunId, resolveRunId, isLegacyRunDir, isLegacyRunState, legacyRunLine } from './short-id.js';
import { runDashboard, dashboardJson } from './dashboard.js';
import { readEvents } from './events.js';
import { REASONING_LEVELS, isReasoningLevel } from '../lib/reasoning.js';
import { extractGoalRequirements, REQUIREMENT_GRANULARITY_HINT } from './goal.js';
import { programAdvisories } from './action-validator.js';
import { createV2GoalDocument, createV2DurableState, validateV2GoalDocument, v2PlannerMode } from './v2-state.js';
import { runV2AutonomousWorkflow, submitCallerPlannerResponse, callerPlannerSubmitCommand, readCallerPlannerRequest } from './v2-runtime.js';
import { requestCancel } from './dashboard.js';
import {
  buildV2PlannerContract, normalizeCallerPlannerResponse, validateV2PlannerResponse,
  V2PlannerValidationError,
} from './v2-planner.js';
import { maybeRefreshStrategy } from '../strategy-cli.js';
import { loadState } from '../lib/state.js';
import { runWorkflowWatch } from './watch-cli.js';
import { queueSteering } from './steering.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';

// BULLSWARM_DIR is read on every call so that changes to the
// BULLSWARM_HOME env var (e.g. set per-test) are honored, not
// captured at module load. (The previous module-level IIFE form
// silently broke resume-by-shortId for any run whose BULLSWARM_HOME
// differed from the one in effect when the module was first
// imported.)
function bullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}
export const BULLSWARM_DIR = bullswarmDir; // back-compat for any external import

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

  if (!sub && input.isTTY && output.isTTY) {
    try { return await runDashboard(bullswarmDir, { input, output }); }
    catch (err) { console.error(`✗ ${err.message}`); return 1; }
  }

  // One gate for every workflow verb whose flags are parsed here. `plan` and
  // `runs` re-parse their own tail against their own subcommand's table, so
  // they run the same check inside their own dispatcher instead.
  if (sub !== 'plan' && sub !== 'runs') {
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
    case 'resume':
      return wfResume(opts);
    case 'runs':
      return cmdRuns(tail, runsAlias ? { alias: runsAlias } : {});
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
        if (opts.json || opts.cancel || opts.show || opts.all) {
          const token = opts.rest[0] ?? opts.show;
          const result = dashboardJson(bullswarmDir, {
            all: opts.all,
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

function goalSettings(opts) {
  const mappings = {
    'max-agents': 'maxAgents',
    'max-expansion-rounds': 'maxExpansionRounds',
    'max-actions': 'maxActions',
    concurrency: 'concurrency',
    'retry-attempts': 'maxMechanicalRetries',
  };
  const settings = Object.fromEntries(Object.entries(mappings)
    .filter(([flag]) => opts[flag] != null)
    .map(([flag, setting]) => {
      const value = Number(opts[flag]);
      if (!Number.isInteger(value) || value < (flag === 'retry-attempts' ? 0 : 1)) throw new Error(`--${flag} must be a ${flag === 'retry-attempts' ? 'non-negative' : 'positive'} integer`);
      return [setting, value];
    }));
  return settings;
}

function compactV2Requirements(goal) {
  return extractGoalRequirements(goal).map((requirement, index) => ({
    id: `requirement-${index + 1}`, text: requirement.text, mandatory: true,
  }));
}

export function extractV2GoalConstraints(goal) {
  const source = String(goal ?? '');
  const explicitReadOnly = /^\s*read[- ]only(?:\s|:|$)/i.test(source)
    || /\b(?:do not|must not|never)\s+(?:modify|edit|write(?:\s+to)?|change)\s+(?:any\s+)?(?:repository|repo|workspace)\s+files?\b/i.test(source);
  return explicitReadOnly ? { workspaceMutation: 'forbidden' } : null;
}

function v2Routing({ pool = null, model = null, strict = false, reasoning = null } = {}) {
  const routing = {};
  if (pool) routing[strict ? 'pool' : 'preferredPool'] = pool;
  if (model) routing.preferredModel = model;
  if (strict && pool) routing.strictPool = pool;
  // Run-wide reasoning depth. It outranks the configured strategy and the
  // connector default, and a per-action `reasoning` field outranks it.
  if (reasoning) routing.reasoning = reasoning;
  return Object.keys(routing).length ? routing : null;
}

// A run-wide reasoning flag is a usage error when it is not on the common
// scale: silently ignoring a typo would let a controlled provider QA run think
// at a level the caller did not ask for.
function reasoningFlag(opts, flag) {
  const value = opts[flag];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isReasoningLevel(value)) {
    throw new Error(`--${flag} must be ${[...REASONING_LEVELS, 'default'].join('|')}`);
  }
  return value;
}

function goalUsage() {
  return helpText(['workflow', 'goal']);
}

// The exhausted decision is only meaningful at a gap boundary (the initial
// boundary requires a program; steering asks for an update), so it is only
// advertised there.
function callerPlannerNextCommands(token, boundary) {
  return {
    show: `bullswarm workflow plan show ${token} --json`,
    submit: callerPlannerSubmitCommand(token),
    ...(boundary === 'gaps' ? { exhausted: `bullswarm workflow plan submit ${token} --exhausted --reason "<why no bounded action remains>"` } : {}),
  };
}

function cancellationSummary(cancellation) {
  if (!cancellation?.requested) return null;
  return { requested: true, requestedAt: cancellation.requestedAt ?? null, reason: cancellation.reason ?? null, source: cancellation.source ?? null };
}

function plannerAwaitingDocument({ runId, shortId, awaiting, cancellation = null }) {
  const token = shortId ?? runId;
  const cancelling = cancellationSummary(cancellation);
  return {
    action: 'planner-awaiting',
    runId, shortId,
    status: 'waiting',
    plannerMode: 'caller',
    boundary: awaiting.boundary,
    turn: awaiting.turn,
    requestPath: awaiting.requestPath,
    candidatePath: awaiting.candidatePath,
    correction: awaiting.correction ?? null,
    cancellation: cancelling,
    next: cancelling
      ? { finalize: `bullswarm workflow cancel ${token} --json` }
      : callerPlannerNextCommands(token, awaiting.boundary),
    note: cancelling
      ? 'cancellation was requested while the run was paused; no kernel is alive, so workflow cancel finalizes it and records the cancelled result (no program can be submitted)'
      : awaiting.boundary === 'initial'
        ? 'the kernel is waiting for the caller to author the initial program'
        : awaiting.boundary === 'gaps'
          ? 'the kernel consolidated the remaining gaps and is waiting for the caller to author the next program revision (or declare exhausted)'
          : 'queued steering needs a caller-authored program update',
  };
}

function printPlannerAwaiting(doc) {
  console.log(`workflow ${doc.shortId ?? doc.runId} is waiting for its caller planner (${doc.boundary} boundary, turn ${doc.turn})`);
  if (doc.correction) {
    console.log('  the previous program was rejected before dispatch:');
    for (const issue of doc.correction.issues) console.log(`    - ${issue}`);
  }
  console.log(`  request  ${doc.requestPath}`);
  if (doc.cancellation) {
    console.log(`  cancel   requested ${doc.cancellation.requestedAt ?? ''} (${doc.cancellation.reason ?? 'operator requested stop'}); no program can be submitted`);
    console.log(`  finalize ${doc.next.finalize}`);
    return;
  }
  console.log(`  show     ${doc.next.show}`);
  console.log(`  submit   ${doc.next.submit}`);
  if (doc.next.exhausted) console.log(`  or       ${doc.next.exhausted}`);
}

async function executeGoalDocument({ doc, pools, opts, runId, resumeRunId, initialPlannerResponse = null }) {
  const result = await runV2AutonomousWorkflow({
    bullswarmDir: BULLSWARM_DIR(), goalDocument: doc, pools, runId, resumeRunId, initialPlannerResponse,
  });
  if (!result.result && result.state?.lifecycle?.status === 'interrupted') {
    const interrupted = { action: 'workflow-interrupted', runId: result.runId, shortId: result.shortId, status: 'interrupted', next: `bullswarm workflow goal --resume ${result.shortId ?? result.runId}` };
    if (opts.json) console.log(JSON.stringify(interrupted, null, 2));
    else if (!opts.quiet) console.log(`workflow ${result.shortId ?? result.runId} interrupted; edits retained. Resume with: ${interrupted.next}`);
    return 130;
  }
  if (!result.result && result.awaiting) {
    const awaiting = plannerAwaitingDocument({ ...result, cancellation: result.state?.cancellation ?? null });
    if (opts.json) console.log(JSON.stringify(awaiting, null, 2));
    else if (!opts.quiet) printPlannerAwaiting(awaiting);
    return 0;
  }
  if (opts.json) console.log(JSON.stringify(result.result, null, 2));
  else if (!opts.quiet) {
    console.log(`workflow ${result.shortId ?? result.runId} ${result.result.status}; result: bullswarm workflow runs result ${result.shortId ?? result.runId} --json`);
    if (result.result.executionMode === 'program') {
      console.log(`verification: ${result.result.verified ? 'all mandatory requirements have passing evidence' : 'not independently verified; inspect action outputs and evidence'}`);
      console.log(`workspace: ${result.result.workspace?.cwd ?? doc.intent.cwd}`);
    }
  }
  return result.result.status === 'completed' ? 0 : 1;
}

function spawnDetachedGoalChild(goalDir, argv, cwd) {
  const stdoutPath = join(goalDir, 'stdout.log');
  const stderrPath = join(goalDir, 'stderr.log');
  const stdoutFd = openSync(stdoutPath, 'a');
  const stderrFd = openSync(stderrPath, 'a');
  let child;
  // Spawn failures (a cwd removed since launch, an unusable node binary) are
  // reported as an 'error' event, not thrown; without a listener they would
  // crash this process after state was already mutated.
  const launch = { child: null, stdoutPath, stderrPath, error: null };
  try {
    child = spawn(process.execPath, [resolve(process.argv[1]), ...argv], {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.once('error', (err) => { launch.error = err; });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  launch.child = child;
  return launch;
}

function assertDetachedChildLaunched(launch, runId) {
  if (!launch.error) return;
  throw new Error(`could not launch the detached kernel for ${runId}: ${launch.error.message}; resume it manually with bullswarm workflow goal --resume ${runId}`);
}

async function waitForRunState(runId, { attempts = 400 } = {}) {
  let state = null;
  const statePath = join(BULLSWARM_DIR(), 'workflows', runId, 'state.json');
  // A detached child can take a few seconds to publish state when the host is
  // busy (for example while several provider/test processes are starting).
  // Keep the launch handoff deterministic before --watch resolves the run.
  for (let i = 0; i < attempts && !state; i++) {
    if (existsSync(statePath)) {
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* atomic state write in progress */ }
    }
    if (!state) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return state;
}

function goalObserveCommands(token, { callerPlanner = false } = {}) {
  return {
    watch: `bullswarm workflow watch ${token}`,
    summary: `bullswarm workflow runs show ${token}`,
    result: `bullswarm workflow runs result ${token} --json`,
    dashboard: `bullswarm workflow tui ${token}`,
    inspect: `bullswarm workflow tui --json ${token}`,
    events: `bullswarm workflow events --json ${token} --after 0`,
    steer: `bullswarm workflow steer ${token} --message "<guidance>"`,
    cancel: `bullswarm workflow cancel ${token} --json`,
    ...(callerPlanner ? { plan: `bullswarm workflow plan show ${token} --json` } : {}),
  };
}

async function launchDetachedResume(doc, runId, opts) {
  const goalDir = join(BULLSWARM_DIR(), 'goals', runId);
  mkdirSync(goalDir, { recursive: true });
  const spawned = spawnDetachedGoalChild(goalDir, [
    'workflow', 'goal', '--resume', runId, '--json', '--quiet',
  ], doc.intent.cwd);
  const { child, stdoutPath, stderrPath } = spawned;
  writeFileSync(join(goalDir, 'launcher.json'), `${JSON.stringify({
    schemaVersion: 'bullswarm.goal.launcher.v2',
    runId,
    pid: child.pid,
    launchedAt: new Date().toISOString(),
    resume: true,
    stdoutPath,
    stderrPath,
  }, null, 2)}\n`);
  const state = await waitForRunState(runId, { attempts: 40 });
  assertDetachedChildLaunched(spawned, runId);
  const token = state?.shortId ?? runId;
  const launch = {
    action: 'goal-resumed',
    runId,
    shortId: state?.shortId ?? null,
    status: state?.lifecycle?.status ?? 'resuming',
    pid: child.pid,
    observe: goalObserveCommands(token, { callerPlanner: v2PlannerMode(doc) === 'caller' }),
    logs: { stdout: stdoutPath, stderr: stderrPath },
  };
  launch.instructions = goalLaunchInstructions(launch.observe);
  return launch;
}

async function launchDetachedGoal(doc, opts, { initialPlannerResponse = null } = {}) {
  const runId = newRunId();
  const goalDir = join(BULLSWARM_DIR(), 'goals', runId);
  mkdirSync(goalDir, { recursive: true });
  const requestPath = join(goalDir, 'request.json');
  writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 'bullswarm.goal.request.v2',
    runId,
    document: doc,
    ...(initialPlannerResponse ? { initialPlannerResponse } : {}),
  }, null, 2)}\n`);

  const spawned = spawnDetachedGoalChild(goalDir, [
    'workflow', 'goal',
    '--request', requestPath,
    '--run-id', runId,
    '--json', '--quiet',
  ], doc.intent.cwd);
  const { child, stdoutPath, stderrPath } = spawned;
  writeFileSync(join(goalDir, 'launcher.json'), `${JSON.stringify({
    schemaVersion: 'bullswarm.goal.launcher.v2',
    runId,
    pid: child.pid,
    launchedAt: new Date().toISOString(),
    requestPath,
    stdoutPath,
    stderrPath,
  }, null, 2)}\n`);

  const state = await waitForRunState(runId);
  assertDetachedChildLaunched(spawned, runId);
  const callerPlanner = v2PlannerMode(doc) === 'caller';
  const token = state?.shortId ?? runId;
  const launch = {
    action: 'goal-launched',
    runId,
    shortId: state?.shortId ?? null,
    status: state?.lifecycle?.status ?? 'starting',
    pid: child.pid,
    goal: doc.intent.goal,
    cwd: doc.intent.cwd,
    plannerMode: callerPlanner ? 'caller' : 'dispatched',
    requestedOrchestrator: callerPlanner ? 'caller' : (doc.config?.plannerRouting?.preferredPool ?? doc.config?.plannerRouting?.pool ?? 'auto'),
    // Run-wide reasoning depth, echoed so the caller can see what its
    // per-action `reasoning` fields will be overriding. null = not overridden.
    reasoning: {
      worker: doc.config?.workerRouting?.reasoning ?? null,
      planner: doc.config?.plannerRouting?.reasoning ?? null,
    },
    observe: goalObserveCommands(token, { callerPlanner }),
    logs: { stdout: stdoutPath, stderr: stderrPath },
  };
  launch.instructions = goalLaunchInstructions(launch.observe);
  if (!opts.silentLaunch && opts.json) console.log(JSON.stringify(launch, null, 2));
  else if (!opts.silentLaunch) {
    printGoalLaunchInstructions(launch);
  }
  return launch;
}

function goalLaunchInstructions(observe) {
  return {
    ...(observe.plan ? {
      callerPlanner: {
        purpose: 'When the run pauses at a planning boundary, read the durable planner request, author the next program, and submit it.',
        command: observe.plan,
      },
    } : {}),
    agentInspect: {
      purpose: 'Obtain a machine-readable snapshot for an agentic caller.',
      command: observe.inspect,
    },
    watch: {
      purpose: 'Follow low-noise semantic progress until the workflow is terminal.',
      command: observe.watch,
    },
    humanTui: {
      purpose: 'Open the interactive Phase → Agent → Activity browser; q detaches safely.',
      command: observe.dashboard,
    },
    result: {
      purpose: 'After completion, obtain the stable delivery and verification envelope.',
      command: observe.result,
    },
    cancel: {
      purpose: 'Stop the run cooperatively; a run paused for its caller planner is finalized immediately.',
      command: observe.cancel,
    },
  };
}

function printGoalLaunchInstructions(launch) {
  console.log(`workflow ${launch.shortId ?? launch.runId} continues independently; next commands:`);
  for (const [name, instruction] of Object.entries(launch.instructions)) {
    console.log(`  ${name.padEnd(13)} ${instruction.command}`);
    console.log(`                 ${instruction.purpose}`);
  }
}

export function shouldAutoWatchGoal(opts) {
  return opts.watch === true && opts.detach !== true && opts.foreground !== true &&
    opts.json !== true && opts.resume == null && opts.request == null;
}

function readJsonFile(path, label) {
  let raw;
  try { raw = readFileSync(resolve(path), 'utf8'); }
  catch (err) { throw new Error(`cannot read ${label} ${path}: ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`${label} ${path} is not valid JSON: ${err.message}`); }
}

// Build a fresh V2 goal document from CLI options. Shared by `workflow goal`
// and `workflow plan contract` so the requirement IDs a caller plans against
// are exactly the IDs the launched run will enforce.
function buildNewGoalDocument(goal, opts, planning) {
  const callerPlanner = planning.mode === 'caller';
  const workerPool = opts['worker-pool'] && opts['worker-pool'] !== 'auto' ? opts['worker-pool'] : null;
  const workerModel = opts['worker-model'] && opts['worker-model'] !== 'auto' ? opts['worker-model'] : null;
  const workerReasoning = reasoningFlag(opts, 'worker-reasoning');
  const plannerReasoning = reasoningFlag(opts, 'planner-reasoning');
  if (opts.isolation !== undefined && typeof opts.isolation !== 'boolean') throw new Error('--isolation is a boolean flag');
  // Caller planner: the caller has done its own reconnaissance, so the kernel
  // scout is opt-in (--scout with a program adds advisory context; --scout
  // alone means "survey, then pause for my program"). Dispatched planner:
  // the scout runs unless --no-scout.
  const scout = callerPlanner ? (planning.programSupplied ? opts.scout === true : true) : !opts.noScout;
  return createV2GoalDocument({
    goal, cwd: resolve(opts.cwd ?? process.cwd()), requirements: compactV2Requirements(goal),
    constraints: extractV2GoalConstraints(goal),
    settings: {
      ...goalSettings(opts), scout,
      executionMode: 'program',
      workspaceMode: opts.isolation === true ? 'isolated' : 'shared',
      ...(opts['suggested-plan'] ? { suggestedPlan: String(opts['suggested-plan']).trim() } : {}),
      ...(callerPlanner ? { plannerMode: 'caller' } : {}),
    },
    plannerRouting: callerPlanner ? null : v2Routing({ pool: planning.pool ?? null, model: planning.model ?? null, strict: Boolean(planning.strict), reasoning: plannerReasoning }),
    workerRouting: v2Routing({ pool: workerPool, model: workerModel, strict: Boolean(workerPool), reasoning: workerReasoning }),
  });
}

// Caller-first planning. `workflow goal` needs a program: the calling agent is
// the Workflow Planner unless it asks for a dispatched one with --orchestrator.
// Usage conflicts throw; the "program required" case is returned, not thrown,
// so the caller can print the full next-command guidance.
function resolvePlanning(opts) {
  if (opts.planner !== undefined) {
    throw new Error('--planner was removed: pass --program <file.json> to plan yourself, --scout to have the kernel survey first and pause for your program, or --orchestrator auto|<pool> to dispatch a Workflow Planner agent');
  }
  const strictAlias = opts['strict-orchestrator'];
  if (opts.orchestrator !== undefined && strictAlias !== undefined) throw new Error('--orchestrator and --strict-orchestrator are mutually exclusive');
  const orchestrator = opts.orchestrator ?? strictAlias ?? null;
  if (orchestrator !== null && (typeof orchestrator !== 'string' || !orchestrator.trim())) throw new Error('--orchestrator requires auto or a pool name');
  const dispatched = orchestrator !== null;
  if (dispatched && opts.program) throw new Error('--program and --orchestrator are mutually exclusive: either you author the program or a dispatched Workflow Planner does');
  const strict = opts['orchestrator-strict'] === true || strictAlias !== undefined;
  if (!dispatched) {
    const dispatchedOnly = [
      ['orchestrator-model', '--orchestrator-model'], ['orchestrator-strict', '--orchestrator-strict'],
      ['suggested-plan', '--suggested-plan'], ['noScout', '--no-scout'],
      // Caller-planner mode never sets plannerRouting, so a planner reasoning
      // level would be accepted and then dropped without a trace.
      ['planner-reasoning', '--planner-reasoning'],
    ].filter(([key]) => opts[key] !== undefined && opts[key] !== false).map(([, flag]) => flag);
    if (dispatchedOnly.length) {
      throw new Error(`${dispatchedOnly.join(', ')} appl${dispatchedOnly.length === 1 ? 'ies' : 'y'} only with --orchestrator (a dispatched Workflow Planner); when you are the planner, the plan is the program`);
    }
  }
  if (strict && orchestrator === 'auto') throw new Error('--orchestrator-strict needs a named pool: --orchestrator <pool> --orchestrator-strict');
  return {
    mode: dispatched ? 'dispatched' : 'caller',
    pool: dispatched && orchestrator !== 'auto' ? orchestrator : null,
    strict: dispatched && strict,
    model: dispatched && opts['orchestrator-model'] && opts['orchestrator-model'] !== 'auto' ? opts['orchestrator-model'] : null,
    programSupplied: Boolean(opts.program),
    scoutFirst: !dispatched && !opts.program && opts.scout === true,
    programRequired: !dispatched && !opts.program && opts.scout !== true,
  };
}

// Flags that only make sense on a launch or with a dispatched planner have no
// meaning for the read-only planning commands.
function contractFlagError(opts, { allowProgram = false } = {}) {
  if (opts.planner !== undefined) return '--planner was removed; the planning commands always describe caller-planner mode';
  if (opts.orchestrator !== undefined || opts['strict-orchestrator'] !== undefined || opts['orchestrator-model'] !== undefined || opts['orchestrator-strict']) {
    return 'the planning commands describe a caller-authored program; --orchestrator, --orchestrator-model, --orchestrator-strict, and --strict-orchestrator do not apply';
  }
  if (opts['suggested-plan'] !== undefined) return '--suggested-plan applies only to a dispatched planner; when you are the planner, the plan is the program';
  // --worker-reasoning is echoed back in the contract; --planner-reasoning has
  // nothing to describe here, so it is refused rather than silently dropped.
  if (opts['planner-reasoning'] !== undefined) return '--planner-reasoning applies only to a dispatched planner; use --worker-reasoning for the run-wide worker level';
  if (!allowProgram && opts.program !== undefined) return 'this command takes the goal text only; pass --program to workflow plan validate or workflow goal';
  if (opts.resume !== undefined || opts.request !== undefined) return '--resume and --request do not apply to the planning commands';
  return null;
}

function shellArg(value) {
  if (/^[A-Za-z0-9_./\-]+$/.test(value)) return value;
  // Single-quote for the shell: a JSON string would re-escape newlines as a
  // literal backslash-n, which does not round-trip through double quotes.
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// A goal is inlined into the next-commands only when it stays readable on one
// line; otherwise the caller (who already holds the text) sees a placeholder,
// so the guidance does not bury the commands under the whole goal.
function goalArg(goal) {
  const text = String(goal);
  return text.includes('\n') || text.length > 120 ? '"<goal>"' : shellArg(text);
}

// The commands a caller can run next when it has a goal but no accepted program.
function goalNextCommands(goal, cwd, { isolation = false } = {}) {
  const q = goalArg(goal);
  const c = shellArg(cwd);
  const workspaceFlag = isolation === true ? ' --isolation' : '';
  return {
    contract: `bullswarm workflow plan contract ${q} --cwd ${c}${workspaceFlag} --json`,
    validate: `bullswarm workflow plan validate ${q} --program plan.json --cwd ${c}${workspaceFlag} --json`,
    launch: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --program plan.json --json`,
    scout: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --scout`,
    orchestrator: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --orchestrator auto`,
  };
}

const GOAL_NEXT_PURPOSES = Object.freeze({
  contract: 'what the kernel will enforce: requirement IDs, rules, schema, example',
  validate: 'check plan.json against that contract without launching',
  launch: 'launch with your program; zero planner or scout dispatches',
  scout: 'kernel surveys the repository first, then pauses for your program',
  orchestrator: 'dispatch a Workflow Planner agent instead of planning yourself',
});

function printGoalNext(next, { only = null } = {}) {
  for (const [name, command] of Object.entries(next)) {
    if (only && !only.includes(name)) continue;
    console.error(`  ${name.padEnd(13)} ${command}`);
    console.error(`                ${GOAL_NEXT_PURPOSES[name]}`);
  }
}

function refuseProgramRequired(goal, opts) {
  const doc = {
    error: 'program-required',
    message: 'workflow goal needs a program: you are the Workflow Planner',
    next: goalNextCommands(goal, resolve(opts.cwd ?? process.cwd()), opts),
  };
  if (opts.json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.error(`✗ ${doc.message}.`);
    printGoalNext(doc.next);
  }
  return 2;
}

function refuseProgramInvalid(goal, opts, issues, { message = 'caller program invalid (nothing ran)' } = {}) {
  const next = goalNextCommands(goal, resolve(opts.cwd ?? process.cwd()), opts);
  const doc = { error: 'program-invalid', message, issues: [...issues], next: { contract: next.contract, validate: next.validate } };
  if (opts.json) console.log(JSON.stringify(doc, null, 2));
  else {
    printValidationIssues(message, issues);
    printGoalNext(next, { only: ['contract', 'validate'] });
  }
  return 2;
}

function loadCallerProgram(opts) {
  if (!opts.program) return null;
  const raw = readJsonFile(opts.program, 'program file');
  return normalizeCallerPlannerResponse(raw, { summary: opts.summary ?? null });
}

// Validate a caller-authored initial program against a preview of the exact
// durable state the run will start with, so an invalid program is rejected
// synchronously and nothing is launched or dispatched.
function previewValidateInitialProgram(doc, response) {
  const preview = createV2DurableState(doc, { runId: 'wf-preview-000000', shortId: 'previe' });
  return validateV2PlannerResponse(response, preview, { boundary: 'initial', requiredScoutUnits: [] });
}

// Advisories are advice, never a rejection: they go to stderr so a --json
// caller keeps a clean stdout document, and the exit code is untouched.
function printAdvisories(advisories, { stream = console.error } = {}) {
  for (const advisory of advisories) {
    stream(`advisory: ${advisory.code}${advisory.actionId ? ` ${advisory.actionId}` : ''} — ${advisory.message}`);
  }
}

function printValidationIssues(prefix, issues) {
  console.error(`✗ ${prefix}:`);
  for (const issue of issues) console.error(`  - ${issue}`);
}

async function wfGoal(opts) {
  if (opts.help) {
    console.log(goalUsage());
    return 0;
  }
  const flagExit = flagErrors(opts, ['workflow', 'goal']);
  if (flagExit !== null) return flagExit;
  if (opts.watch && (opts.detach || opts.foreground || opts.json || opts.resume || opts.request)) {
    console.error('✗ --watch is only valid for a new human-readable independent launch; do not combine it with --detach, --foreground, --json, --resume, or --request');
    return 2;
  }
  let planning;
  try { planning = resolvePlanning(opts); }
  catch (err) { console.error(`✗ ${err.message}`); return 2; }
  const callerPlanner = planning.mode === 'caller';
  const { names, pools } = await livePoolNames();
  let doc;
  let resumeRunId = null;
  let initialPlannerResponse = null;

  if (opts.resume) {
    const resolvedRun = resolveRunId(BULLSWARM_DIR(), opts.resume);
    if (!resolvedRun) {
      console.error(`✗ --resume token "${opts.resume}" did not match any run`);
      return 1;
    }
    resumeRunId = resolvedRun.runId;
    const durableGoalPath = join(resolvedRun.runDir, 'goal.json');
    try {
      if (!existsSync(durableGoalPath)) throw new Error('unsupported V1 autonomous run; start a new V2 goal');
      doc = JSON.parse(readFileSync(durableGoalPath, 'utf8'));
      validateV2GoalDocument(doc);
    } catch (err) {
      console.error(`✗ cannot resume ${resumeRunId}: ${err.message}`);
      return 1;
    }
    if (opts.orchestrator || opts['strict-orchestrator'] || opts['orchestrator-model'] || opts['worker-pool'] || opts['worker-model']
      || opts['worker-reasoning'] || opts['planner-reasoning']) {
      console.error('✗ V2 resume preserves its durable routing contract; routing overrides are valid only when starting a new goal');
      return 2;
    }
    if (opts.program || opts.scout || opts.isolation !== undefined) {
      console.error(`✗ a resumed run keeps its durable planner mode; to submit a caller program use: ${callerPlannerSubmitCommand(resolvedRun.shortId ?? resumeRunId)}`);
      return 2;
    }
  } else if (opts.request) {
    try {
      const request = JSON.parse(readFileSync(resolve(opts.request), 'utf8'));
      if (request.schemaVersion !== 'bullswarm.goal.request.v2' || !request.document) {
        throw new Error('invalid goal request schema');
      }
      if (request.runId !== opts['run-id']) throw new Error('goal request runId mismatch');
      doc = request.document;
      initialPlannerResponse = request.initialPlannerResponse ?? null;
    } catch (err) {
      console.error(`✗ cannot load goal request: ${err.message}`);
      return 1;
    }
  } else {
    const goal = opts.rest.join(' ').trim();
    if (!goal) {
      console.error(goalUsage());
      return 2;
    }
    if (planning.programRequired) return refuseProgramRequired(goal, opts);
    try {
      initialPlannerResponse = loadCallerProgram(opts);
      doc = buildNewGoalDocument(goal, opts, planning);
    } catch (err) {
      if (err instanceof V2PlannerValidationError) return refuseProgramInvalid(goal, opts, err.issues);
      console.error(`✗ invalid goal options: ${err.message}`);
      return 2;
    }
  }

  const targetDir = doc?.intent?.cwd;
  if (typeof targetDir !== 'string' || !existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${targetDir ?? '(missing)'}`);
    return 1;
  }

  try { validateV2GoalDocument(doc); }
  catch (err) { console.error(`✗ autonomous V2 goal invalid (nothing ran): ${err.message}`); return 1; }
  for (const [label, routing] of [['planner', doc.config.plannerRouting], ['worker', doc.config.workerRouting]]) {
    const pool = routing?.pool ?? routing?.preferredPool ?? routing?.strictPool;
    if (pool && !names.includes(pool)) { console.error(`✗ requested ${label} pool "${pool}" is not available`); return 1; }
  }
  if (initialPlannerResponse && !opts.request) {
    let previewed;
    try { previewed = previewValidateInitialProgram(doc, initialPlannerResponse); }
    catch (err) {
      if (err instanceof V2PlannerValidationError) return refuseProgramInvalid(doc.intent.goal, opts, err.issues);
      throw err;
    }
    // The same lines `plan validate` prints, at the moment the program is
    // actually launched. The kernel also stores them on the run state.
    printAdvisories(programAdvisories(previewed.program));
  }

  if (!opts.foreground && !resumeRunId && !opts.request) {
    const launch = await launchDetachedGoal(doc, opts, { initialPlannerResponse });
    if (shouldAutoWatchGoal(opts)) {
      // The detached child writes state.json asynchronously; give it a
      // bounded grace period instead of failing the handoff on a slow host.
      return runWorkflowWatch(BULLSWARM_DIR(), launch.runId ?? launch.shortId, { waitForRunMs: 30_000 });
    }
    return 0;
  }
  return executeGoalDocument({
    doc,
    pools,
    opts,
    runId: opts['run-id'] ?? undefined,
    resumeRunId,
    initialPlannerResponse,
  });
}

// --- workflow plan: the caller-as-planner surface -----------------------------
// `contract` renders the exact planning contract for a goal before any run
// exists; `show` prints the durable request a paused run left for its caller;
// `submit` validates and applies a caller-authored program (or an exhausted
// decision) and relaunches the paused kernel.

async function wfPlan(rest) {
  const [head, ...tail] = rest;
  const sub = flagName(head) ? undefined : head;
  const opts = parseFlags(sub === undefined ? rest : tail);
  const subs = ['contract', 'validate', 'show', 'submit'];
  if (sub === undefined || sub === 'help' || (opts.help && !subs.includes(sub))) {
    // A flag with no subcommand is a usage error on `workflow plan` itself.
    const planFlags = sub === undefined && !opts.help
      ? unknownFlagExit(opts.flags, ['workflow', 'plan'])
      : null;
    if (planFlags !== null) return planFlags;
    console.log(helpText(['workflow', 'plan']));
    return sub ? 0 : 2;
  }
  if (subs.includes(sub) && !opts.help) {
    const flagExit = flagErrors(opts, ['workflow', 'plan', sub]);
    if (flagExit !== null) return flagExit;
  }
  switch (sub) {
    case 'contract': return planContract(opts);
    case 'validate': return planValidate(opts);
    case 'show': return planShow(opts);
    case 'submit': return planSubmit(opts);
    default:
      console.error(helpText(['workflow', 'plan']));
      return 2;
  }
}

// Build the goal document a planning command describes, with the same cwd
// guard a launch applies. Returns { doc } or { exit } after printing.
function planningGoalDocument(opts, path, { allowProgram = false } = {}) {
  const goal = opts.rest.join(' ').trim();
  if (!goal) { console.error(`usage: ${usageLine(path)}`); return { exit: 2 }; }
  const flagError = contractFlagError(opts, { allowProgram });
  if (flagError) { console.error(`✗ ${flagError}`); return { exit: 2 }; }
  let doc;
  try { doc = buildNewGoalDocument(goal, opts, { mode: 'caller', programSupplied: true }); }
  catch (err) { console.error(`✗ invalid goal options: ${err.message}`); return { exit: 2 }; }
  if (!existsSync(doc.intent.cwd) || !statSync(doc.intent.cwd).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${doc.intent.cwd}`);
    return { exit: 1 };
  }
  return { goal, doc };
}

function planContract(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'contract'])); return 0; }
  const built = planningGoalDocument(opts, ['workflow', 'plan', 'contract']);
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  const next = goalNextCommands(goal, doc.intent.cwd, opts);
  const contract = buildV2PlannerContract(doc, { launchCommand: next.launch });
  // Advice, never a rule, and only when it applies: a goal that collapsed to a
  // single requirement gets one verdict for the whole thing, and any gap
  // reopens all of it. A holistic outcome is legitimately one requirement.
  const advice = contract.requirements.length === 1
    ? { advice: { requirements: REQUIREMENT_GRANULARITY_HINT } }
    : {};
  console.log(JSON.stringify({
    action: 'plan-contract',
    ...contract,
    ...advice,
    next: { validate: next.validate, launch: next.launch, scout: next.scout },
  }, null, 2));
  return 0;
}

// Dry-run a caller program against the contract: the same validator and the
// same preview state a launch uses, without creating a run.
function planValidate(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'validate'])); return 0; }
  if (!opts.program) { console.error(`usage: ${usageLine(['workflow', 'plan', 'validate'])}`); return 2; }
  const built = planningGoalDocument(opts, ['workflow', 'plan', 'validate'], { allowProgram: true });
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  let accepted;
  try { accepted = previewValidateInitialProgram(doc, loadCallerProgram(opts)); }
  catch (err) {
    if (err instanceof V2PlannerValidationError) return refuseProgramInvalid(goal, opts, err.issues, { message: 'program invalid against the contract (nothing launched)' });
    console.error(`✗ ${err.message}`);
    return 2;
  }
  const next = goalNextCommands(goal, doc.intent.cwd, opts);
  const payload = {
    action: 'plan-valid',
    requirements: doc.intent.requirements,
    program: {
      summary: accepted.summary,
      actions: accepted.program.actions.map((action) => ({
        id: action.id,
        ...(action.kind ? { kind: action.kind } : {}),
        lane: action.lane, effort: action.effort,
        ...(action.reasoning ? { reasoning: action.reasoning } : {}),
        dependsOn: action.dependsOn,
        affects: action.affects, evidenceFor: action.evidenceFor, ownedFiles: action.ownedFiles,
      })),
    },
    // Advice about the accepted program. Present (possibly empty) on every
    // valid program so a caller can read it without probing for the key.
    advisories: programAdvisories(accepted.program),
    next: { launch: next.launch },
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`✓ program valid against the contract: ${payload.program.actions.length} action${payload.program.actions.length === 1 ? '' : 's'} for ${payload.requirements.length} requirement${payload.requirements.length === 1 ? '' : 's'} (nothing launched)`);
    for (const action of payload.program.actions) console.log(`  ${action.id.padEnd(24)} ${action.lane}/${action.effort}${action.kind ? ` kind=${action.kind}` : ''}${action.reasoning ? ` reasoning=${action.reasoning}` : ''}${action.evidenceFor.length ? ` evidence for ${action.evidenceFor.join(', ')}` : ` affects ${action.affects.join(', ') || '(none)'}`}`);
    printAdvisories(payload.advisories, { stream: console.log });
    console.log(`  launch   ${next.launch}`);
  }
  return 0;
}

// Legacy (pre-0.27.0 authored-graph) runs are read-only history. Every verb
// that would drive one — cancel, resume, steer, action show, tui <runId> —
// answers with the same sentence and exit 2 before doing anything else.
// Returns null when `token` is not a legacy run, so the caller carries on.
function legacyRunRefusal(token, { json = false } = {}) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) return null;
  if (!isLegacyRunDir(resolved.runDir)) return null;
  const message = legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir });
  if (json) console.log(JSON.stringify({ legacy: true, runId: resolved.runId, shortId: resolved.shortId ?? null, dir: resolved.runDir, message }, null, 2));
  else console.error(message);
  return 2;
}

function loadV2RunState(token) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = withV2Cancellation(JSON.parse(readFileSync(statePath, 'utf8')), resolved.runDir);
  if (isLegacyRunState(state)) throw new Error(`run "${token}" is not an autonomous V2 run`);
  return { ...resolved, state };
}

function planShow(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'show'])); return 0; }
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'plan', 'show'])}`); return 2; }
  let run;
  try { run = loadV2RunState(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const { state } = run;
  const id = state.shortId ?? state.runId;
  const terminal = ['completed', 'partial', 'cancelled', 'failed'].includes(state.lifecycle?.status) || Boolean(state.lifecycle?.finishedAt);
  // A terminal run is never waiting, whatever a stale request record says.
  const awaiting = terminal ? null : (state.planner?.awaiting ?? null);
  if (!awaiting) {
    const mode = v2PlannerMode(state);
    const status = {
      action: 'plan-status', runId: state.runId, shortId: state.shortId ?? null, awaiting: false,
      plannerMode: mode, status: state.lifecycle?.status ?? 'unknown',
      plannerStatus: state.planner?.status ?? 'unknown', plannerTurns: state.planner?.turns ?? 0,
      note: terminal
        ? `the run is ${state.lifecycle.status}; read its result with bullswarm workflow runs result ${id} --json`
        : mode === 'caller'
          ? 'the kernel is not waiting for a program right now; watch the run or read its result'
          : 'this run uses a dispatched Workflow Planner; there is nothing for a caller to submit',
    };
    if (opts.json) console.log(JSON.stringify(status, null, 2));
    else console.log(`workflow ${id} is not waiting for a planner submission (workflow ${status.status}, planner ${status.plannerStatus}); ${status.note}`);
    return 1;
  }
  // Refresh the request with steering queued since the pause so the caller
  // sees every pending instruction and a submission consumes exactly them.
  let shown;
  try { shown = readCallerPlannerRequest({ bullswarmDir: BULLSWARM_DIR(), runId: state.runId }); }
  catch (err) { console.error(`✗ planner request unavailable: ${err.message}`); return 1; }
  const request = shown.request;
  if (!request) { console.error(`✗ planner request unavailable at ${awaiting.requestPath}`); return 1; }
  const cancellation = cancellationSummary(state.cancellation);
  const payload = {
    action: 'plan-request',
    ...request,
    requestRefreshed: shown.refreshed,
    cancellation,
    submit: cancellation ? null : {
      program: callerPlannerSubmitCommand(id),
      ...(request.boundary === 'gaps' ? { exhausted: `bullswarm workflow plan submit ${id} --exhausted --reason "<why no bounded action remains>"` } : {}),
    },
    ...(cancellation ? { finalize: `bullswarm workflow cancel ${id} --json` } : {}),
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`workflow ${id} is waiting for its caller planner · ${request.boundary} boundary · turn ${request.turn}`);
    if (request.context?.gaps?.summary) console.log(`  gaps     ${request.context.gaps.summary}`);
    if (request.pendingSteering?.length) {
      console.log(`  steering ${request.pendingSteering.length} pending instruction${request.pendingSteering.length === 1 ? '' : 's'} (consumed by your submission):`);
      for (const entry of request.pendingSteering) console.log(`    - ${entry.message}`);
    }
    if (request.correction?.issues?.length) {
      console.log('  the previous program was rejected before dispatch:');
      for (const issue of request.correction.issues) console.log(`    - ${issue}`);
    }
    console.log(`  request  ${awaiting.requestPath}`);
    if (cancellation) {
      console.log(`  cancel   requested ${cancellation.requestedAt ?? ''} (${cancellation.reason ?? 'operator requested stop'}); no program can be submitted`);
      console.log(`  finalize ${payload.finalize}`);
      return 0;
    }
    console.log(`  submit   ${payload.submit.program}`);
    if (payload.submit.exhausted) console.log(`  or       ${payload.submit.exhausted}`);
    console.log('  Use --json for the full request (requirements, known actions, gaps, rules).');
  }
  return 0;
}

async function planSubmit(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'submit'])); return 0; }
  const token = opts.rest[0];
  if (!token || (!opts.program && !opts.exhausted)) { console.error(`usage: ${usageLine(['workflow', 'plan', 'submit'])}`); return 2; }
  if (opts.program && opts.exhausted) { console.error('✗ --program and --exhausted are mutually exclusive'); return 2; }
  if (opts.exhausted && !opts.reason) { console.error('✗ --exhausted requires --reason <text>'); return 2; }
  if (opts.watch && (opts.foreground || opts.json)) { console.error('✗ --watch cannot combine with --foreground or --json'); return 2; }
  let run;
  try { run = loadV2RunState(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  // The relaunch needs the goal's working directory; check it before any
  // state is mutated so a vanished cwd is a clean refusal, not a crash after
  // the program was already accepted.
  let doc;
  try { doc = JSON.parse(readFileSync(join(run.runDir, 'goal.json'), 'utf8')); }
  catch (err) { console.error(`✗ cannot read the durable goal for ${token}: ${err.message}`); return 1; }
  const targetDir = doc?.intent?.cwd;
  if (typeof targetDir !== 'string' || !existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${targetDir ?? '(missing)'}; nothing was submitted`);
    return 1;
  }
  let response;
  try {
    response = opts.exhausted
      ? normalizeCallerPlannerResponse({ kind: 'exhausted' }, { summary: opts.summary ?? null, exhaustedReason: String(opts.reason) })
      : loadCallerProgram(opts);
  } catch (err) {
    if (err instanceof V2PlannerValidationError) { printValidationIssues('planner response invalid (nothing submitted)', err.issues); return 2; }
    console.error(`✗ ${err.message}`);
    return 2;
  }
  let submitted;
  try { submitted = submitCallerPlannerResponse({ bullswarmDir: BULLSWARM_DIR(), runId: run.runId, response }); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  if (!submitted.ok) {
    printValidationIssues(`planner response rejected at the ${submitted.boundary} boundary (run state unchanged)`, submitted.issues);
    return 2;
  }
  const id = submitted.state.shortId ?? run.runId;
  const accepted = {
    action: 'plan-submitted', runId: run.runId, shortId: submitted.state.shortId ?? null,
    boundary: submitted.boundary, turn: submitted.state.planner.turns, kind: submitted.accepted.kind,
    summary: submitted.accepted.summary, programRevision: submitted.state.program.revision,
    actions: submitted.state.program.actions.length, candidatePath: submitted.candidatePath,
  };
  if (opts.foreground) {
    if (!opts.json) console.log(`✓ ${accepted.kind} accepted for ${id} (turn ${accepted.turn}, ${accepted.boundary} boundary, program revision ${accepted.programRevision}); resuming in the foreground`);
    const { pools } = await livePoolNames();
    return executeGoalDocument({ doc, pools, opts, resumeRunId: run.runId });
  }
  let launch;
  try { launch = await launchDetachedResume(doc, run.runId, opts); }
  catch (err) {
    // The program is already accepted durably; only the relaunch failed.
    console.error(`✗ ${accepted.kind} accepted for ${id} (turn ${accepted.turn}) but ${err.message}`);
    return 1;
  }
  const payload = { ...accepted, relaunch: launch };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`✓ ${accepted.kind} accepted for ${id} (turn ${accepted.turn}, ${accepted.boundary} boundary, program revision ${accepted.programRevision}); kernel relaunched independently`);
    printGoalLaunchInstructions({ ...launch, shortId: launch.shortId ?? id });
  }
  if (opts.watch) return runWorkflowWatch(BULLSWARM_DIR(), run.runId, { waitForRunMs: 30_000 });
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
  // A caller-planner run paused at a boundary has no kernel alive to honor
  // the request; finalize it here. The kernel reads the cancellation at the
  // top of its loop and records the cancelled result without dispatching.
  if (requested.planner?.awaiting) {
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
    else console.log(`✓ workflow ${id} was paused for its caller planner; cancelled and finalized (${payload.status}); result: ${payload.result}`);
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

async function wfResume(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'resume'])); return 0; }
  const flagExit = flagErrors(opts, ['workflow', 'resume']);
  if (flagExit !== null) return flagExit;
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'resume'])}`); return 2; }
  if (opts.watch && (opts.foreground || opts.json)) { console.error('✗ --watch cannot combine with --foreground or --json'); return 2; }
  if (opts.program || opts.orchestrator !== undefined || opts['strict-orchestrator'] !== undefined || opts.scout || opts['suggested-plan'] !== undefined || opts.isolation !== undefined) {
    console.error(`✗ a resumed run keeps its durable planner mode and routing; to submit a caller program use: ${callerPlannerSubmitCommand(token)}`);
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
  if (opts.foreground) {
    const { pools } = await livePoolNames();
    return executeGoalDocument({ doc, pools, opts, resumeRunId: resolvedRun.runId });
  }
  let launch;
  try { launch = await launchDetachedResume(doc, resolvedRun.runId, opts); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
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
        },
        plannerModes: {
          caller: 'default: the calling agent authors the program (workflow plan contract|validate, workflow goal --program, workflow plan show|submit); the kernel pauses durably at each boundary and never dispatches a planner',
          dispatched: 'explicit --orchestrator auto|<pool>: the kernel routes a Workflow Planner agent process at each planning boundary',
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
      selection: 'pools with 5h headroom first (a pool at or above the near-limit threshold is chosen only when no eligible pool below it exists); within that set, approved effort-tier assignment when eligible, otherwise highest time-adjusted quota surplus among lane/capability/model-policy-eligible, enabled, non-quarantined, non-burst-gated pools',
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
      quarantined: Boolean(p.quarantine),
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
      lane: action.lane,
      effort: action.effort,
      ...(action.reasoning ? { reasoning: action.reasoning } : {}),
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
    },
    attempts: (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId),
    events: readEvents(resolved.runDir).filter((event) =>
      event.payload?.actionId === actionId || event.payload?.parentId === actionId),
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

// The help path whose usage line explains this workflow verb. Returns null
// for a verb with no help node — the dispatcher's default branch already
// answers those with guidance and exit 2.
function workflowHelpPath(sub, opts) {
  if (!sub) return ['workflow'];
  if (sub === 'action') return opts.rest[0] === 'show' ? ['workflow', 'action', 'show'] : ['workflow', 'action'];
  const LEAVES = ['goal', 'cancel', 'resume', 'capabilities', 'tui', 'events', 'watch', 'steer'];
  return LEAVES.includes(sub) ? ['workflow', sub] : null;
}

function parseFlags(argv) {
  const out = { inputs: {}, rest: [], flags: [] };
  const valueFlags = new Set([
    'resume', 'after', 'cwd', 'orchestrator', 'strict-orchestrator', 'orchestrator-model',
    'worker-pool', 'worker-model', 'worker-reasoning', 'planner-reasoning', 'request', 'run-id',
    'suggested-plan', 'planner', 'program', 'summary', 'reason',
    'max-agents', 'max-expansion-rounds', 'max-actions', 'concurrency',
    'retry-attempts', 'interval', 'heartbeat', 'stall-after', 'since', 'message',
  ]);
  // A value flag with no value (end of argv, or the next token is another
  // flag) is a usage error, never a silent default: a bare --program must not
  // launch a dispatched-planner run.
  const errors = [];
  const missingValue = (i) => argv[i + 1] === undefined || /^--./.test(argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Record every flag-shaped token exactly as typed so the unknown-flag
    // gate sees `--porgram`, not the normalized key this switch produces.
    const name = flagName(a);
    if (name && !out.flags.includes(name)) out.flags.push(name);
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--no-scout') out.noScout = true;
    else if (a === '--resume' || a === '--after' || a === '--input') {
      if (missingValue(i)) { errors.push(`${a} requires a value`); continue; }
      if (a === '--resume') { out.resume = argv[++i]; continue; }
      if (a === '--after') { out.after = argv[++i]; continue; }
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const key = kv.slice(0, eq);
        const raw = kv.slice(eq + 1);
        // Accept JSON for non-string values: --input items='["a","b"]' or
        // --input count=3. Falls back to the raw string on parse failure
        // so a literal value with a colon doesn't silently lose data.
        let v = raw;
        if (raw.length && '[{"\''.includes(raw[0])) {
          try { v = JSON.parse(raw); } catch { v = raw; }
        }
        out.inputs[key] = v;
      }
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq > 0 ? eq : undefined);
      if (eq > 0) out[key] = a.slice(eq + 1);
      else if (valueFlags.has(key)) {
        if (missingValue(i)) errors.push(`--${key} requires a value`);
        else out[key] = argv[++i];
      } else out[key] = true;
    } else out.rest.push(a);
  }
  if (errors.length) out.errors = errors;
  return out;
}

// Report flag-parsing errors for one command and return its exit code, or
// null when the flags parsed cleanly.
function flagErrors(opts, path) {
  const unknown = unknownFlagExit(opts.flags, path);
  if (unknown !== null) return unknown;
  if (!opts.errors?.length) return null;
  for (const error of opts.errors) console.error(`✗ ${error}`);
  console.error(`usage: ${usageLine(path)}`);
  return 2;
}

async function livePoolNames() {
  try {
    await maybeRefreshStrategy(BULLSWARM_DIR());
    const { pools } = await buildPoolsLive(BULLSWARM_DIR(), Date.now(), {
      getReadings: getAllMeterReadings,
    });
    return { names: pools.map((p) => p.name), pools };
  } catch (err) {
    const { pools } = buildPools(BULLSWARM_DIR(), Date.now());
    return { names: pools.map((p) => p.name), pools, meterWarning: err.message };
  }
}
