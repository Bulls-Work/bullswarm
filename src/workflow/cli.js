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
import { cmdRuns, cmdReindex } from './runs-cli.js';
import { newRunId, resolveRunId, listRuns, isLegacyRunDir, isLegacyRunState, isProcessAlive, legacyRunLine, v2RunnerLiveness } from './short-id.js';
import { runDashboard, dashboardJson, overviewSnapshot } from './dashboard.js';
import { readEvents } from './events.js';
import { REASONING_LEVELS, isReasoningLevel } from '../lib/reasoning.js';
import { extractGoalRequirements, REQUIREMENT_GRANULARITY_HINT } from './goal.js';
import { KIND_DEFAULTS, programAdvisories } from './action-validator.js';
import { DELIVERABLE_TYPES, EVIDENCE_TYPES, STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES, poolCausedPools } from './step-vocabulary.js';
import { EVIDENCE_DEFAULT_TIMEOUT_SEC, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_TIMEOUT_SEC, EVIDENCE_ENV_KEYS, CHECKER_PATH } from './evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from './schema-check.js';
import { createV2GoalDocument, createV2DurableState, deserializeV2DurableState, validateV2GoalDocument, v2PlannerMode } from './v2-state.js';
import {
  runV2AutonomousWorkflow, submitCallerPlannerResponse, callerPlannerSubmitCommand, readCallerPlannerRequest,
  pauseV2Run, reopenV2RunForRetry, reviseV2Program, unpauseV2Run,
} from './v2-runtime.js';
import { formatV2HandbackLines, formatV2ProofLine, summarizeV2Result } from './v2-outcome.js';
import {
  clearStepRestart, prepareV2DispatchPools, readStepRestarts, requestStepRestart, workerSilenceTimeoutSec,
} from './v2-dispatch.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { poolPassesRoute, resolveRouteFilter, routeIssuesForPools, routeSummary } from './step-route.js';
import {
  createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, REVISION_CHANGE_KINDS, V2RevisionError,
} from './v2-revision.js';
import { isProgramWorkflow } from './execution-policy.js';
import { requestCancel } from './dashboard.js';
import {
  buildV2PlannerContract, normalizeCallerPlannerResponse, validateV2PlannerResponse,
  V2PlannerValidationError, v2RoleCatalog, workspacePathIssues,
} from './v2-planner.js';
import { maybeRefreshStrategy } from '../strategy-cli.js';
import { loadState } from '../lib/state.js';
import { runWorkflowWatch } from './watch-cli.js';
import { peekSteering, queueSteering } from './steering.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { cmdReprice } from './reprice.js';
import { stepPageModel } from './step-model.js';
import { taskStepInput, taskStepModel } from './task-step.js';
import { stepJsonModel } from './step-json.js';
import { listAssignments } from '../lib/assignments.js';
import { loadPoolLabels, resolvePoolId, withPoolLabels } from '../lib/pool-labels.js';

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
      // Stage 3 (D2): one automatic retry per step by default, at most 3.
      if (flag === 'retry-attempts') {
        if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('--retry-attempts must be 0, 1, 2 or 3');
      } else if (!Number.isInteger(value) || value < 1) throw new Error(`--${flag} must be a positive integer`);
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

function cancellationSummary(cancellation) {
  if (!cancellation?.requested) return null;
  return { requested: true, requestedAt: cancellation.requestedAt ?? null, reason: cancellation.reason ?? null, source: cancellation.source ?? null };
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
  if (!result.result && result.paused) {
    const token = result.shortId ?? result.runId;
    const paused = { action: 'workflow-paused', runId: result.runId, shortId: result.shortId, status: 'paused', mode: result.paused.mode, next: `bullswarm workflow resume ${token}` };
    if (opts.json) console.log(JSON.stringify(paused, null, 2));
    else if (!opts.quiet) console.log(`workflow ${token} paused; nothing new starts until: ${paused.next}`);
    return 0;
  }
  if (opts.json) console.log(JSON.stringify(result.result, null, 2));
  else if (!opts.quiet) {
    console.log(`workflow ${result.shortId ?? result.runId} ${result.result.status}; result: bullswarm workflow runs result ${result.shortId ?? result.runId} --json`);
    if (result.result.executionMode === 'program') {
      console.log(`verification: ${result.result.verified ? 'all mandatory requirements have passing evidence' : 'not independently verified; inspect action outputs and evidence'}`);
      console.log(`workspace: ${result.result.workspace?.cwd ?? doc.intent.cwd}`);
    }
    console.log(`reason: ${result.result.reason}`);
    const summary = summarizeV2Result(result.result, result.state, { runDir: result.runDir });
    const proofLine = formatV2ProofLine(summary);
    if (proofLine) console.log(proofLine);
    for (const line of formatV2HandbackLines(summary)) console.log(line);
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

// A relaunched run already has state.json, still naming the kernel that
// stopped. Until the new kernel records itself, a watcher started next would
// see that dead pid and call the run interrupted, so wait for the handover
// (or for the child to die, which assertDetachedChildLaunched then reports).
async function waitForKernelTakeover(runId, pid, { attempts = 400 } = {}) {
  const statePath = join(BULLSWARM_DIR(), 'workflows', runId, 'state.json');
  let state = null;
  for (let i = 0; i < attempts; i++) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* atomic state write in progress */ }
    if (state?.runner?.pid === pid || !isProcessAlive(pid)) return state;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return state;
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
    ...(callerPlanner ? { plan: `bullswarm workflow plan export ${token} --out plan.json` } : {}),
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
  const state = await waitForKernelTakeover(runId, child.pid);
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
    ...(opts.verifyRoundsMeaning ? { verifyRoundsMeaning: opts.verifyRoundsMeaning } : {}),
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
        purpose: 'Change the running plan at any time: export it, edit it, then plan revise. The run never waits for you; when it finishes, its result hands back whatever is left.',
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
      purpose: 'After it finishes, obtain the stable result: verification, and a handback of anything left with your options (continue, retry, take over, restart).',
      command: observe.result,
    },
    cancel: {
      purpose: 'Stop the run cooperatively; a paused run is finalized immediately.',
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
  // The callers run workspacePathIssues next to their pinned-pool check.
  return validateV2PlannerResponse(response, preview, { boundary: 'initial', requiredScoutUnits: [], workspacePaths: false });
}

// A pinned pool with no model on a step's tier fails that step within a second
// as "no eligible pool". Say so before anything launches. Pool pauses are not
// counted here: they end, and the run reports them if they still matter.
function pinnedPoolIssues(doc, program, pools) {
  const routing = doc.config?.workerRouting ?? {};
  const strictPool = routing.strictPool ?? routing.pool ?? null;
  if (!strictPool || !Array.isArray(pools) || !pools.length) return [];
  const issues = [];
  program.actions.forEach((action, index) => {
    const effort = action.effort ?? 'medium';
    const capable = prepareV2DispatchPools(pools, action, effort, {
      preferredModel: routing.model ?? routing.preferredModel ?? null, strictPool, ignoreQuarantine: true,
    });
    if (!capable.length) {
      issues.push(`program.actions[${index}] (${action.id}) is ${action.lane}/${effort} work, which the pinned pool ${strictPool} cannot run (disabled, or no model on the ${effort} tier); change the step's effort or pin another pool`);
    }
  });
  return issues;
}

// Stage 3 §2.4: the route checks that need the configured pool list (unknown
// pool or provider names, a label instead of an id, nothing capable left, the
// run pin outside the route). Only programs that route a step pay for them.
function programRoutes(actions) {
  return (actions ?? []).some((action) => action?.route && typeof action.route === 'object');
}

// `state` (a running run) lets the pin check see which steps already did work.
function routePoolIssues(actions, pools, doc, labels = loadPoolLabels(BULLSWARM_DIR()), state = null) {
  if (!programRoutes(actions) || !Array.isArray(pools)) return [];
  const routing = doc?.config?.workerRouting ?? {};
  const preferredModel = routing.model ?? routing.preferredModel ?? null;
  return routeIssuesForPools({ actions }, pools, {
    runPin: routing.strictPool ?? routing.pool ?? null,
    preparePools: (list, action, effort, options) => prepareV2DispatchPools(list, action, effort ?? 'medium', { preferredModel, ...options }),
    labels,
    state,
  });
}

// The configured pools without a live meter refresh: enough for the route
// checks, which ignore pauses, benches and 5-hour gates.
function configuredPools() {
  try { return buildPools(BULLSWARM_DIR(), Date.now()).pools; } catch { return null; }
}

// D35: a program that sets verifyRounds is told that it now counts fix cycles.
const VERIFY_ROUNDS_NOTE = 'note: defaults.verifyRounds counts fix cycles since this version (1 = one fix and one re-review, 0 = review only); it counted review rounds before';
function setsVerifyRounds(program) {
  return program?.verifyRounds !== undefined || program?.defaults?.verifyRounds !== undefined;
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

// The same goal text in the same cwd while the first launch is still going is
// a duplicate, not a second slice of work: the retry a caller makes when it
// cannot parse the first launch's output would otherwise race two identical
// workflows in one directory. Only V2 runs can be ongoing, and `ongoing`
// already accounts for a kernel that died without saying so.
function ongoingGoalRun(goal, cwd) {
  for (const run of listRuns(BULLSWARM_DIR())) {
    if (!run.ongoing) continue;
    const intent = run.state?.intent;
    if (typeof intent?.goal !== 'string' || typeof intent?.cwd !== 'string') continue;
    if (intent.goal.trim() === goal && resolve(intent.cwd) === cwd) return run;
  }
  return null;
}

// `started <age> ago`, in the coarse units `workflow runs list` prints.
function runAge(startedAt) {
  const ms = Date.now() - Date.parse(startedAt ?? '');
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function refuseDuplicateGoal(goal, opts, run, cwd) {
  const token = run.shortId ?? run.runId;
  const startedAt = run.state?.lifecycle?.startedAt ?? null;
  const next = {
    watch: `bullswarm workflow watch ${token} --next`,
    again: `bullswarm workflow goal ${goalArg(goal)} --cwd ${shellArg(cwd)}${opts.isolation === true ? ' --isolation' : ''} --again`,
  };
  if (opts.json) {
    console.log(JSON.stringify({
      error: 'duplicate-goal', shortId: run.shortId ?? null, runId: run.runId, startedAt, next,
    }, null, 2));
  } else {
    console.error(`✗ this goal is already running as ${token} (started ${runAge(startedAt)} ago in ${cwd}); watch it with: ${next.watch} · to launch another copy anyway pass --again`);
  }
  return 2;
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
    // A new launch only: --resume continues the run it names, and the internal
    // --request relaunch is the detached child of a launch that already passed.
    const cwd = resolve(opts.cwd ?? process.cwd());
    if (!opts.again) {
      const duplicate = ongoingGoalRun(goal, cwd);
      if (duplicate) return refuseDuplicateGoal(goal, opts, duplicate, cwd);
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
    const workspaceIssues = [
      ...workspacePathIssues(previewed.program, doc.intent.cwd, { isolated: doc.config.settings.workspaceMode === 'isolated' }),
      ...pinnedPoolIssues(doc, previewed.program, pools),
      ...routePoolIssues(previewed.program.actions, pools, doc),
    ];
    if (workspaceIssues.length) return refuseProgramInvalid(doc.intent.goal, opts, workspaceIssues);
    // The same lines `plan validate` prints, at the moment the program is
    // actually launched. The kernel also stores them on the run state.
    printAdvisories(programAdvisories(previewed.program, { requirements: doc.intent.requirements }));
    if (setsVerifyRounds(previewed.program)) {
      console.error(VERIFY_ROUNDS_NOTE);
      opts.verifyRoundsMeaning = 'fix cycles';
    }
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
  const subs = ['contract', 'validate', 'show', 'submit', 'export', 'revise'];
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
    case 'export': return planExport(opts);
    case 'revise': return planRevise(opts);
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
async function planValidate(opts) {
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
  // Everything a launch refuses, validate refuses too.
  const workspaceIssues = workspacePathIssues(accepted.program, doc.intent.cwd, { isolated: doc.config.settings.workspaceMode === 'isolated' });
  const routing = doc.config?.workerRouting ?? {};
  const pinned = Boolean(routing.strictPool ?? routing.pool);
  if (pinned || programRoutes(accepted.program.actions)) {
    const { pools } = await livePoolNames();
    if (pinned) workspaceIssues.push(...pinnedPoolIssues(doc, accepted.program, pools));
    workspaceIssues.push(...routePoolIssues(accepted.program.actions, pools, doc));
  }
  if (workspaceIssues.length) return refuseProgramInvalid(goal, opts, workspaceIssues, { message: 'program invalid against the contract (nothing launched)' });
  const next = goalNextCommands(goal, doc.intent.cwd, opts);
  const payload = {
    action: 'plan-valid',
    requirements: doc.intent.requirements,
    program: {
      summary: accepted.summary,
      actions: accepted.program.actions.map((action) => ({
        id: action.id,
        ...(action.kind ? { kind: action.kind } : {}),
        ...(action.role ? { role: action.role } : {}),
        ...(action.deliverable ? { deliverable: action.deliverable } : {}),
        ...(action.evidence ? { evidence: action.evidence } : {}),
        lane: action.lane, effort: action.effort,
        ...(action.reasoning ? { reasoning: action.reasoning } : {}),
        ...(action.route ? { route: action.route } : {}),
        dependsOn: action.dependsOn,
        affects: action.affects, evidenceFor: action.evidenceFor, ownedFiles: action.ownedFiles,
      })),
    },
    // Advice about the accepted program. Present (possibly empty) on every
    // valid program so a caller can read it without probing for the key.
    advisories: programAdvisories(accepted.program, { requirements: doc.intent.requirements }),
    ...(setsVerifyRounds(accepted.program) ? { verifyRoundsMeaning: 'fix cycles' } : {}),
    next: { launch: next.launch },
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`✓ program valid against the contract: ${payload.program.actions.length} action${payload.program.actions.length === 1 ? '' : 's'} for ${payload.requirements.length} requirement${payload.requirements.length === 1 ? '' : 's'} (nothing launched)`);
    for (const action of payload.program.actions) console.log(`  ${action.id.padEnd(24)} ${action.lane}/${action.effort}${action.kind ? ` kind=${action.kind}` : ''}${action.role ? ` role=${action.role}` : ''}${action.deliverable ? ` deliverable=${action.deliverable.type}${action.deliverable.paths?.length ? `:${action.deliverable.paths.join(',')}` : ''}` : ''}${action.evidence ? ` evidence=${action.evidence.map((item) => item.type).join(',')}` : ''}${action.reasoning ? ` reasoning=${action.reasoning}` : ''}${action.evidenceFor.length ? ` evidence for ${action.evidenceFor.join(', ')}` : ` affects ${action.affects.join(', ') || '(none)'}`}${action.route ? ` route: ${routeSummary(action.route)}` : ''}`);
    printAdvisories(payload.advisories, { stream: console.log });
    if (payload.verifyRoundsMeaning) console.log(VERIFY_ROUNDS_NOTE);
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

// --- live plan revisions and pause -------------------------------------------

function parseIdList(value) {
  if (value == null || value === true) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function loadProgramRun(token) {
  const run = loadV2RunState(token);
  if (!isProgramWorkflow(run.state)) {
    throw new Error(`run "${token}" uses the older verified execution mode; only program-mode runs can be exported or revised`);
  }
  return run;
}

function planExport(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'export'])); return 0; }
  const token = opts.rest[0];
  if (!token) { console.error(`usage: ${usageLine(['workflow', 'plan', 'export'])}`); return 2; }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  let run;
  try { run = loadProgramRun(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const { state } = run;
  const id = state.shortId ?? state.runId;
  const pendingSteering = peekSteering(state, run.runDir);
  const document = exportV2Plan(state, { pendingSteering });
  const out = opts.out ? resolve(opts.out) : null;
  if (out) {
    try { writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`); }
    catch (err) { console.error(`✗ cannot write ${out}: ${err.message}`); return 1; }
  }
  const runtimeById = new Map(state.actions.map((action) => [action.id, action]));
  const payload = {
    action: 'plan-export',
    runId: state.runId,
    shortId: state.shortId ?? null,
    status: state.lifecycle.status,
    programRevision: state.program.revision,
    out,
    actions: state.program.actions.map((definition) => {
      const runtime = runtimeById.get(definition.id);
      return {
        id: definition.id, purpose: definition.purpose, ...(definition.role ? { role: definition.role } : {}),
        status: runtime?.status ?? 'pending',
        attempts: runtime?.attempts ?? 0, dependsOn: definition.dependsOn, outputFile: runtime?.outputFile ?? null,
      };
    }),
    pendingSteering: pendingSteering.map(({ id: steeringId, message, queuedAt }) => ({ id: steeringId, message, queuedAt })),
    ...(out ? {} : { document }),
    next: { revise: `bullswarm workflow plan revise ${id} --program ${out ?? '<file.json>'}` },
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  if (!out) {
    // Bare stdout is the editable document itself, so it can be redirected.
    console.log(JSON.stringify(document, null, 2));
    return 0;
  }
  console.log(`✓ plan of ${id} exported at revision ${state.program.revision} (workflow ${state.lifecycle.status}) to ${out}`);
  for (const entry of payload.actions) console.log(`  ${entry.status.padEnd(11)} ${entry.id}`);
  if (pendingSteering.length) {
    console.log(`  steering ${pendingSteering.length} pending (a revision from this file marks it delivered):`);
    for (const entry of pendingSteering) console.log(`    - ${entry.message}`);
  }
  console.log(`  revise   ${payload.next.revise}`);
  return 0;
}

function printRevisionChanges(changes) {
  const labels = {
    added: 'added', amended: 'amended', restored: 'restored', removed: 'removed',
    rerun: 'rerun', invalidated: 'rerun (downstream)', accepted: 'accepted',
  };
  for (const kind of REVISION_CHANGE_KINDS) {
    const ids = changes?.[kind] ?? [];
    if (ids.length) console.log(`  ${labels[kind].padEnd(19)} ${ids.join(', ')}`);
  }
}

async function planRevise(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'revise'])); return 0; }
  const token = opts.rest[0];
  if (!token || !opts.program || opts.program === true) { console.error(`usage: ${usageLine(['workflow', 'plan', 'revise'])}`); return 2; }
  const waitSec = opts.wait === undefined ? 120 : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  if (opts['base-revision'] !== undefined && !/^\d+$/.test(String(opts['base-revision']))) {
    console.error('✗ --base-revision must be a non-negative integer'); return 2;
  }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  let run;
  try { run = loadProgramRun(token); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  let doc;
  try { doc = JSON.parse(readFileSync(join(run.runDir, 'goal.json'), 'utf8')); }
  catch (err) { console.error(`✗ cannot read the durable goal for ${token}: ${err.message}`); return 1; }
  if (typeof doc?.intent?.cwd !== 'string' || !existsSync(doc.intent.cwd) || !statSync(doc.intent.cwd).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${doc?.intent?.cwd ?? '(missing)'}; nothing was revised`);
    return 1;
  }
  let body;
  try {
    body = normalizeRevisionInput(readJsonFile(opts.program, 'revision file'), {
      summary: typeof opts.summary === 'string' ? opts.summary : null,
      rerun: parseIdList(opts.rerun),
      baseRevision: opts['base-revision'] === undefined ? null : Number(opts['base-revision']),
    });
  } catch (err) {
    if (err instanceof V2RevisionError) { printValidationIssues('revision invalid (nothing submitted)', err.issues); return 2; }
    console.error(`✗ ${err.message}`);
    return 2;
  }
  // Check against the run as it stands, so an invalid revision never reaches
  // a kernel. The kernel checks again against the state it applies it to.
  let current;
  try { current = deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8')); }
  catch (err) { console.error(`✗ cannot read the run state: ${err.message}`); return 1; }
  // The run's marker decides how defaults.verifyRounds reads (D13, rule 6).
  const features = runFeatureFlags(readRunFeatures(run.runDir));
  const precheck = planV2Revision(current, body, { pendingSteeringIds: peekSteering(current, run.runDir).map((entry) => entry.id), features });
  const id = current.shortId ?? current.runId;
  if (precheck.ok) {
    const directories = workspacePathIssues(body.program, doc.intent.cwd, { isolated: current.config.settings.workspaceMode === 'isolated' });
    if (directories.length) Object.assign(precheck, { ok: false, issues: directories });
  }
  if (precheck.ok) {
    // Only the steps this revision (re)starts are checked against today's
    // pools, invalidated dependents included: a finished step's route is
    // history. In the state the pin check reads, those steps run again.
    const starting = new Set([...precheck.changes.added, ...precheck.changes.amended, ...precheck.changes.restored,
      ...precheck.changes.rerun, ...precheck.changes.invalidated]);
    const routed = precheck.desired.filter((action) => starting.has(action.id));
    const restarting = { ...current, actions: current.actions.map((action) => (starting.has(action.id) ? { ...action, status: 'pending' } : action)) };
    const routeIssues = programRoutes(routed) ? routePoolIssues(routed, configuredPools(), doc, undefined, restarting) : [];
    if (routeIssues.length) Object.assign(precheck, { ok: false, issues: routeIssues });
  }
  const verifyRoundsNote = features.failureRule && setsVerifyRounds(body.program);
  if (!precheck.ok) {
    if (opts.json) console.log(JSON.stringify({ action: 'plan-revise', status: 'rejected', runId: current.runId, shortId: current.shortId ?? null, programRevision: current.program.revision, issues: precheck.issues }, null, 2));
    printValidationIssues(`revision rejected against ${id} at revision ${current.program.revision} (run unchanged)`, precheck.issues);
    return 2;
  }
  const request = createRevisionRequest(body, { source: 'cli' });
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir: BULLSWARM_DIR(), runId: run.runId, request, waitMs: waitSec * 1000 }); }
  catch (err) { console.error(`✗ ${err.message}`); return 1; }
  const base = { action: 'plan-revise', requestId: request.id, runId: run.runId, shortId: current.shortId ?? null };
  if (outcome.status === 'rejected') {
    const issues = outcome.record?.issues ?? [];
    if (opts.json) console.log(JSON.stringify({ ...base, status: 'rejected', issues }, null, 2));
    printValidationIssues(`revision ${request.id} rejected (run unchanged)`, issues);
    return 2;
  }
  if (outcome.status === 'queued') {
    const payload = { ...base, status: 'queued', note: `the running kernel has not taken the revision within ${waitSec}s; it applies it at its next check, and watch prints "plan revised"`, ...(verifyRoundsNote ? { verifyRoundsMeaning: 'fix cycles' } : {}), next: { watch: `bullswarm workflow watch ${id} --next` } };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`✓ revision ${request.id} queued for ${id}; ${payload.note}`);
      if (verifyRoundsNote) console.log(`  ${VERIFY_ROUNDS_NOTE}`);
    }
    return 0;
  }
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunch = null;
  if (outcome.appliedBy === 'offline' && !paused) {
    try { relaunch = await launchDetachedResume(doc, run.runId, opts); }
    catch (err) { console.error(`✗ revision ${request.id} applied to ${id} but ${err.message}`); return 1; }
  }
  const payload = {
    ...base, status: 'applied', programRevision: outcome.record.programRevision, summary: outcome.record.summary,
    changes: outcome.record.changes, steeringDelivered: outcome.record.steeringIds ?? [],
    appliedBy: outcome.appliedBy, reopened: outcome.reopened ?? null, paused, relaunch,
    ...(verifyRoundsNote ? { verifyRoundsMeaning: 'fix cycles' } : {}),
    next: paused
      ? { resume: `bullswarm workflow resume ${id}` }
      : { watch: `bullswarm workflow watch ${id} --next`, export: `bullswarm workflow plan export ${id} --out plan.json` },
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  const by = outcome.appliedBy === 'kernel' ? 'by its running kernel' : 'directly (no kernel was running)';
  console.log(`✓ plan of ${id} revised to revision ${payload.programRevision} ${by} · ${payload.summary}`);
  printRevisionChanges(payload.changes);
  if (verifyRoundsNote) console.log(`  ${VERIFY_ROUNDS_NOTE}`);
  if (payload.reopened) console.log(`  reopened the ${payload.reopened.previousStatus} run; its earlier result is archived`);
  if (payload.steeringDelivered.length) console.log(`  steering  ${payload.steeringDelivered.length} instruction(s) marked delivered`);
  if (paused) console.log(`  the run stays paused; continue with: ${payload.next.resume}`);
  else {
    if (relaunch) console.log('  kernel relaunched independently');
    console.log(`  watch    ${payload.next.watch}`);
  }
  return 0;
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
    next: { resume: `bullswarm workflow resume ${id}`, export: `bullswarm workflow plan export ${id} --out plan.json` },
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  if (outcome.status === 'paused') console.log(`✓ workflow ${id} ${outcome.already ? 'was already' : 'is'} paused; nothing new starts until: ${payload.next.resume}`);
  else if (outcome.status === 'pausing') {
    console.log(`✓ pause requested for ${id}; nothing new starts. ${running.length} running step${running.length === 1 ? '' : 's'} ${mode === 'now' ? 'being stopped' : 'finish first'}${running.length ? ` (${running.join(', ')})` : ''}`);
    console.log(`  watch    bullswarm workflow watch ${id} --next`);
  } else console.log(`workflow ${id} reached ${outcome.status} before the pause took effect`);
  console.log(`  revise   ${payload.next.export}, then bullswarm workflow plan revise ${id} --program plan.json`);
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
  if (requested.planner?.awaiting || requested.lifecycle?.status === 'paused') {
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
        ...(program ? { revise: `bullswarm workflow plan export ${id} --out plan.json, then bullswarm workflow plan revise ${id} --program plan.json --rerun <step ids>` } : {}),
      },
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.error(`✗ nothing to retry in ${id} (${current.lifecycle.status}): no step stopped for a reason a plain retry fixes; nothing was relaunched`);
      for (const entry of payload.needsCaller) console.error(`  ${entry.id}  ${entry.status}${entry.failureKind ? ` (${entry.failureKind})` : ''}`);
      if (payload.next.revise) console.error(`  change the plan: ${payload.next.revise}`);
      console.error(`  result: ${payload.next.result}`);
    }
    return 1;
  }
  // A step that failed with a return time still ahead (its pool out of quota,
  // paused or benched; every pool that can run it out) can fail the same way
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
        quota: 'a usage limit (a spent 5-hour or weekly window, or no credit left: a notice that says so, with or without a reset, or a full meter) ends the step and goes to the caller at once, whatever the pausing switch; never waited out, moved or retried; retryAfter is the reset when it is known, else the earliest known return when no capable pool is free',
        throttle: 'a transient rate limit (too many requests, no usage window spent) backs off on the same pool at most twice without spending the retry (20 s, then 60 s, or a named wait of at most 2 minutes), then goes to the caller; a longer named wait goes to the caller at once, with retryAfter at its end; a backoff whose pool is no longer free goes to the caller at once, as quota when that pool is out on a usage limit, with retryAfter its known return',
        noFreePool: 'no capable pool free at the first pick (nearly spent, at its 5-hour limit, paused or benched): the step goes to the caller, as quota when every reason is a usage limit, else unavailable; why names each pool and its reason; retryAfter is the earliest known return; a promised retry that finds no free pool keeps the last failure\'s kind and its why ends "· no retry: <pool> <reason>; …"',
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

// --- workflow step restart ---------------------------------------------------
// The caller's answer to a `looks stale` line. Nothing restarts on its own:
// this writes the intent (see requestStepRestart in v2-dispatch.js), and the
// run's live kernel stops the step's running attempt and queues it again with
// the stopped attempt's handoff block, on --pool when given.

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'cancelled', 'failed']);

/**
 * Request a restart of one running step and wait up to waitMs for its kernel
 * to apply it. Resolves {code, status: restarted|refused|requested|error, ...};
 * code is the exit code the CLI returns. poolNames, when given, is the set a
 * --pool value must belong to.
 */
export async function restartV2Step({
  bullswarmDir, token, stepId, pool = null, poolNames = null, pools = null,
  waitMs = 60_000, pollMs = 200, now = () => new Date().toISOString(),
} = {}) {
  const fail = (code, why, extra = {}) => ({ code, status: 'error', why, ...extra });
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return fail(1, `no run found for "${token}"`);
  let state;
  try { state = JSON.parse(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')); }
  catch { return fail(1, `run "${token}" has no readable state.json`); }
  if (isLegacyRunState(state)) return fail(2, `run "${token}" is not an autonomous V2 run`);
  const id = state.shortId ?? state.runId;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const status = state.lifecycle?.status ?? 'unknown';
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return fail(1, `run ${id} already finished (${status}); nothing is running. Retry its unfinished steps with: bullswarm workflow resume ${id}`, base);
  }
  if (!(state.program?.actions ?? []).some((action) => action.id === stepId)) {
    return fail(1, `run ${id} has no step "${stepId}"`, base);
  }
  const running = (state.attempts ?? []).findLast((attempt) => attempt.actionId === stepId && attempt.status === 'running');
  if (!running) {
    const stepStatus = (state.actions ?? []).find((action) => action.id === stepId)?.status ?? 'unknown';
    return fail(1, `step ${stepId} is not running (${stepStatus}); restart stops a running attempt. `
      + `To run it again: bullswarm workflow plan export ${id} --out plan.json, then bullswarm workflow plan revise ${id} --program plan.json --rerun ${stepId}`, base);
  }
  if (!v2RunnerLiveness(state, { runDir: resolved.runDir }).alive) {
    return fail(1, `the kernel of ${id} is not running, so nothing can stop ${running.id}; `
      + `bullswarm workflow resume ${id} restarts its interrupted steps with their handoff`, base);
  }
  if (pool && Array.isArray(poolNames) && !poolNames.includes(pool)) {
    return fail(2, `unknown pool "${pool}"; configured pools: ${poolNames.join(', ') || 'none'}`, base);
  }
  // D18: a restart pin never overrides the step's route.
  const definition = state.program.actions.find((action) => action.id === stepId);
  if (pool && definition?.route) {
    const filter = resolveRouteFilter(state, definition, pools ?? []);
    const target = (pools ?? []).find((entry) => entry?.name === pool) ?? pool;
    if (filter && !poolPassesRoute(target, filter)) {
      // Point at what works on a running step: restart on an allowed pool, or
      // change the route (an amendment restarts the step). Not step rerun,
      // which refuses a running step.
      const allowed = (pools ?? []).filter((entry) => entry?.name && entry.name !== pool && entry.enabled !== false && poolPassesRoute(entry, filter)).map((entry) => entry.name);
      const restart = allowed.length
        ? `restart it on a pool the route allows: bullswarm workflow step restart ${id} ${stepId} --pool ${allowed[0]} (allowed: ${allowed.join(', ')}), or without --pool; or `
        : '';
      return fail(2, `step ${stepId}'s route does not allow pool ${pool} (${filter.summary}); ${restart}change the route: bullswarm workflow plan export ${id} --out plan.json, edit it, then bullswarm workflow plan revise ${id} --program plan.json`, base);
    }
  }
  const request = requestStepRestart(resolved.runDir, { actionId: stepId, attemptId: running.id, pool, now });
  const outcome = { ...base, requestId: request.id, stoppedAttemptId: running.id, stoppedPool: running.pool ?? null, pool: request.pool };
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const answer = readEvents(resolved.runDir).findLast((event) => ['step.restarted', 'step.restart_refused'].includes(event.type)
      && event.payload?.requestId === request.id);
    if (answer?.type === 'step.restarted') return { code: 0, status: 'restarted', ...outcome, stoppedAttemptId: answer.payload.attemptId ?? running.id };
    if (answer) return { code: 1, status: 'refused', why: answer.payload?.why ?? 'the kernel refused the restart', ...outcome };
    if (Date.now() >= deadline) return { code: 0, status: 'requested', ...outcome };
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

// --- workflow step rerun / accept (stage 3 §2.7, §2.8) -----------------------
// Both are plan revisions the CLI builds for the caller, so they work with a
// live kernel or offline, reopen a finished run, and leave an audit record.
// rerun adds --avoid pools to the step's route and hands the last failed
// attempt's handoff to the next attempt through an already-applied restart
// intent that counts only once its revision is applied (D20). accept records
// a failed step, or a check's failing requirements, as the caller's choice.

const STEP_UNFINISHED = new Set(['failed', 'cancelled', 'interrupted', 'blocked']);
const OLD_KERNEL_HINT = (id) => `  the run's kernel predates step rerun/accept: bullswarm workflow pause ${id}, run this again, then bullswarm workflow resume ${id}`;

// The failed (or cancelled, interrupted) step at the root of why `stepId`
// cannot run, with its status.
function blockingRoot(state, stepId, seen = new Set()) {
  const definitions = new Map(state.program.actions.map((action) => [action.id, action]));
  const statusOf = (id) => state.actions.find((action) => action.id === id)?.status;
  for (const dependency of definitions.get(stepId)?.dependsOn ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    const status = statusOf(dependency);
    if (status === 'blocked' || status === 'pending') {
      const deeper = blockingRoot(state, dependency, seen);
      if (deeper) return deeper;
      if (status === 'blocked') return { id: dependency, status };
    } else if (STEP_UNFINISHED.has(status)) return { id: dependency, status };
  }
  return null;
}

function currentStepAttempts(state, runtime) {
  return (state.attempts ?? [])
    .filter((attempt) => attempt.actionId === runtime.id && attempt.ordinal > (runtime.supersededAttempts ?? 0))
    .sort((left, right) => left.ordinal - right.ordinal);
}

// Load a program run for a step verb, or return the refusal.
function loadStepRun(bullswarmDir, token, stepId, verb) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { refusal: { code: 1, why: `no run found for "${token}"` } };
  let state;
  try { state = deserializeV2DurableState(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')); }
  catch (err) { return { refusal: { code: 1, why: `run "${token}" has no readable state.json (${err.message})` } }; }
  const id = state.shortId ?? state.runId;
  if (!isProgramWorkflow(state)) return { refusal: { code: 1, why: `run ${id} is not a program-mode run; step ${verb} needs a run started with --program` } };
  const runtime = state.actions.find((action) => action.id === stepId);
  if (!runtime || runtime.status === 'removed' || !state.program.actions.some((action) => action.id === stepId)) {
    return { refusal: { code: 1, why: `run ${id} has no step "${stepId}"` } };
  }
  return { resolved, state, id, runtime };
}

function stepError(code, why, extra = {}) {
  return { code, status: 'error', why, ...extra };
}

// Delete the rerun's own intent only: a newer intent for the step stays.
function dropRerunIntent(runDir, intent) {
  if (!intent) return;
  const current = readStepRestarts(runDir).find((entry) => entry.actionId === intent.actionId);
  if (current?.id === intent.id) clearStepRestart(runDir, intent.actionId);
}

function oldKernelRejection(issues) {
  return issues.some((issue) => /\.route\b[^;]*not allowed|route is not allowed/.test(issue))
    || issues.some((issue) => issue.startsWith('the revision changes nothing'));
}

/**
 * `workflow step rerun`: resolves {code, status: applied|queued|rejected|error, ...}.
 * `pools` is the configured pool list (objects), `labels` maps pool ids to
 * labels, and `relaunch(doc, runId)` starts a kernel after an offline apply.
 */
export async function rerunV2Step({
  bullswarmDir, token, stepId, avoid = [], pools = null, labels = {},
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const loaded = loadStepRun(bullswarmDir, token, stepId, 'rerun');
  if (loaded.refusal) return stepError(loaded.refusal.code, loaded.refusal.why);
  const { resolved, state, id, runtime } = loaded;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const status = runtime.status;
  if (status === 'running') return stepError(1, `step ${stepId} is running; to stop it and run it again: bullswarm workflow step restart ${id} ${stepId} [--pool <pool>]`, base);
  if (status === 'blocked') {
    const root = blockingRoot(state, stepId);
    return stepError(1, `step ${stepId} is blocked by ${root?.id ?? 'a failed dependency'} (${root?.status ?? 'failed'}); rerun or accept ${root?.id ?? 'it'} first`, base);
  }
  if (status === 'pending' && !avoid.length) return stepError(1, `step ${stepId} has not run yet; nothing to rerun (add --avoid to keep it off a pool when it runs)`, base);

  // Pool names: ids stay, a label resolves to its id, anything else is refused.
  const configured = (pools ?? []).map((pool) => pool.name);
  const idByLabel = new Map(Object.entries(labels ?? {}).map(([poolId, label]) => [label, poolId]));
  const avoided = [];
  const notes = [];
  for (const name of avoid) {
    if (configured.includes(name)) { if (!avoided.includes(name)) avoided.push(name); continue; }
    const poolId = idByLabel.get(name);
    if (poolId && configured.includes(poolId)) {
      if (!avoided.includes(poolId)) avoided.push(poolId);
      notes.push(`(label "${name}" is pool ${poolId})`);
      continue;
    }
    return stepError(2, `unknown pool "${name}"; configured pools: ${configured.join(', ') || 'none'}`, base);
  }

  const document = exportV2Plan(state);
  const definition = document.program.actions.find((action) => action.id === stepId);
  if (avoided.length) {
    const route = definition.route ? JSON.parse(JSON.stringify(definition.route)) : {};
    const use = route.pools?.use ?? null;
    if (use && use.every((name) => avoided.includes(name))) {
      return stepError(2, `step ${stepId} may only use ${use.join(', ')} (route.pools.use); avoiding ${use.length === 1 ? 'it' : 'them'} leaves nothing. Change its route: bullswarm workflow plan export ${id} --out plan.json, edit it, then bullswarm workflow plan revise ${id} --program plan.json`, base);
    }
    route.pools = { ...(route.pools ?? {}) };
    route.pools.avoid = [...new Set([...(route.pools.avoid ?? []), ...avoided])].sort();
    if (use) route.pools.use = use.filter((name) => !avoided.includes(name));
    definition.route = route;
  }
  // §2.4: the route CLI checks run at every step rerun, not only with --avoid,
  // so a route today's pools cannot serve is refused before anything is written.
  if (definition.route) {
    const doc = (() => { try { return JSON.parse(readFileSync(join(resolved.runDir, 'goal.json'), 'utf8')); } catch { return state; } })();
    if (avoided.length) {
      const routing = doc?.config?.workerRouting ?? {};
      const filter = resolveRouteFilter(state, definition, pools ?? []);
      const capable = prepareV2DispatchPools(pools ?? [], definition, definition.effort ?? 'medium', {
        preferredModel: routing.model ?? routing.preferredModel ?? null, strictPool: routing.strictPool ?? routing.pool ?? null,
        routeFilter: filter, ignoreQuarantine: true, ignoreBench: true, ignoreBurstGate: true,
      }).filter((pool) => poolPassesRoute(pool, filter));
      if (!capable.length) {
        return stepError(2, `no pool could run ${stepId} after avoiding ${avoided.join(', ')} (${definition.lane}/${definition.effort} work); rerun without --avoid, or change the step's effort or route`, base);
      }
    }
    const routeIssues = routePoolIssues([definition], pools, doc, labels, state);
    if (routeIssues.length) return { code: 2, status: 'rejected', issues: routeIssues, ...base };
  }

  const attempts = currentStepAttempts(state, runtime);
  const last = attempts.at(-1) ?? null;
  const handoffFrom = status !== 'pending' && last && ['failed', 'interrupted', 'cancelled'].includes(last.status) ? last : null;
  const lastText = last ? ` (last attempt: ${last.failureKind ?? last.status}${last.pool ? ` on ${last.pool}` : ''})` : '';
  const body = {
    summary: `step rerun ${stepId}${avoided.length ? ` avoiding ${avoided.join(', ')}` : ''}${lastText}`,
    baseRevision: state.program.revision,
    program: document.program,
    rerun: status === 'pending' ? [] : [stepId],
    steeringIds: [],
  };
  const features = runFeatureFlags(readRunFeatures(resolved.runDir));
  const precheck = planV2Revision(state, body, { features });
  if (!precheck.ok) return { code: 2, status: 'rejected', issues: precheck.issues, ...base };

  const request = createRevisionRequest(body, { source: 'step-rerun', now });
  const intent = handoffFrom ? requestStepRestart(resolved.runDir, {
    actionId: stepId, attemptId: handoffFrom.id, pool: null, source: 'step-rerun',
    revisionRequestId: request.id, appliedAt: now(), now,
  }) : null;
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir, runId: state.runId, request, waitMs, pollMs, now }); }
  catch (err) { dropRerunIntent(resolved.runDir, intent); return stepError(1, err.message, base); }
  const result = {
    ...base, requestId: request.id, avoid: avoided, notes,
    handoffFrom: handoffFrom?.id ?? null,
    handoff: handoffFrom ? { attemptId: handoffFrom.id, failureKind: handoffFrom.failureKind ?? handoffFrom.status, pool: handoffFrom.pool ?? null } : null,
    // The pools the rerun starts off, because the step failed there on the
    // pool (marked runs): another pool takes the step if one can now.
    leaves: features.failureRule && status !== 'pending'
      ? poolCausedPools(state.attempts, stepId).map((entry) => entry.pool).filter((pool) => !avoided.includes(pool))
      : [],
    pending: status === 'pending',
    route: definition.route ?? null,
    next: { watch: `bullswarm workflow watch ${id} --until trouble` },
  };
  if (outcome.status === 'rejected') {
    dropRerunIntent(resolved.runDir, intent);
    const issues = outcome.record?.issues ?? [];
    return { code: 2, status: 'rejected', issues, oldKernel: outcome.appliedBy === 'kernel' && oldKernelRejection(issues), ...result };
  }
  if (outcome.status === 'queued') return { code: 0, status: 'queued', programRevision: null, changes: null, appliedBy: null, relaunch: null, ...result };
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunched = null;
  if (outcome.appliedBy === 'offline' && !paused && typeof relaunch === 'function') {
    try { relaunched = await relaunch(state.runId); }
    catch (err) { return stepError(1, `rerun of ${stepId} applied to ${id} (revision ${outcome.record.programRevision}) but ${err.message}`, base); }
  }
  return {
    code: 0, status: 'applied', programRevision: outcome.record.programRevision, changes: outcome.record.changes,
    appliedBy: outcome.appliedBy, reopened: outcome.reopened ?? null, paused, relaunch: relaunched, ...result,
  };
}

/**
 * `workflow step accept`: resolves {code, status: applied|queued|rejected|error, ...}.
 * The refusals are the §2.8 texts planV2Revision reports; the exit code is 2
 * for a usage problem (reason, requirement) and 1 for a step in the wrong state.
 */
export async function acceptV2Step({
  bullswarmDir, token, stepId, reason, requirements = [],
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return stepError(2, '--reason is required: say why you accept it (it is recorded as evidence "choice")');
  if (text.length > 500 || /[\r\n]/.test(text)) return stepError(2, '--reason must be one line of at most 500 characters');
  const loaded = loadStepRun(bullswarmDir, token, stepId, 'accept');
  if (loaded.refusal) return stepError(loaded.refusal.code, loaded.refusal.why);
  const { resolved, state, id, runtime } = loaded;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const named = [...new Set(requirements)];
  const body = {
    summary: `accept ${stepId}: "${text}"`,
    baseRevision: state.program.revision,
    program: exportV2Plan(state).program,
    rerun: [],
    steeringIds: [],
    accept: [{ step: stepId, reason: text, requirements: named.length ? named : null }],
  };
  const features = runFeatureFlags(readRunFeatures(resolved.runDir));
  const precheck = planV2Revision(state, body, { features });
  if (!precheck.ok) {
    const [first] = precheck.issues;
    const usage = /^(--reason|step \S+ does not check |requirement \S+ is not failing)/.test(first ?? '');
    const single = precheck.issues.length === 1;
    return single
      ? stepError(usage ? 2 : 1, first, base)
      : { code: 2, status: 'rejected', issues: precheck.issues, ...base };
  }
  const planned = precheck.acceptances[0];
  const kind = planned.kind;
  const before = new Set((runtime.acceptance?.requirements ?? []).map((entry) => entry.id));
  const acceptedRequirements = kind === 'requirements'
    ? (named.length ? named : planned.requirements.map((entry) => entry.id).filter((entryId) => !before.has(entryId)))
    : named;
  const request = createRevisionRequest(body, { source: 'step-accept', now });
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir, runId: state.runId, request, waitMs, pollMs, now }); }
  catch (err) { return stepError(1, err.message, base); }
  const result = {
    ...base, requestId: request.id, kind, reason: text, requirements: acceptedRequirements,
    attemptId: planned.attemptId ?? null, failureKind: planned.failureKind ?? null,
    next: { watch: `bullswarm workflow watch ${id} --until trouble`, undo: `bullswarm workflow step rerun ${id} ${stepId}` },
  };
  if (outcome.status === 'rejected') {
    const issues = outcome.record?.issues ?? [];
    return { code: 2, status: 'rejected', issues, oldKernel: outcome.appliedBy === 'kernel' && oldKernelRejection(issues), ...result };
  }
  if (outcome.status === 'queued') return { code: 0, status: 'queued', programRevision: null, changes: null, appliedBy: null, relaunch: null, dependents: [], ...result };
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunched = null;
  if (outcome.appliedBy === 'offline' && !paused && typeof relaunch === 'function') {
    try { relaunched = await relaunch(state.runId); }
    catch (err) { return stepError(1, `accept of ${stepId} applied to ${id} (revision ${outcome.record.programRevision}) but ${err.message}`, base); }
  }
  return {
    code: 0, status: 'applied', programRevision: outcome.record.programRevision, changes: outcome.record.changes,
    dependents: outcome.record.changes?.invalidated ?? [], appliedBy: outcome.appliedBy, reopened: outcome.reopened ?? null, paused, relaunch: relaunched, ...result,
  };
}

/**
 * F22: what reopening a finished run by `step rerun` / `step accept` does:
 * the steps queued again, and each act step kept cancelled because its
 * worker had started (it may have acted).
 */
export function stepReopenedLines(reopened) {
  if (!reopened) return [];
  const requeued = reopened.requeued ?? [];
  const lines = [`reopened the ${reopened.previousStatus} run; its earlier result is archived${requeued.length ? `; running again: ${requeued.join(', ')}` : ''}`];
  if (reopened.keptCancelled?.length) lines.push(`not run again (act step, may have acted): ${reopened.keptCancelled.join(', ')}`);
  return lines;
}

function printStepRerun(result, token) {
  const id = result.shortId ?? token;
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return; }
  if (result.status === 'rejected') {
    console.error(`✗ rerun of ${result.step} rejected (run unchanged)`);
    for (const issue of result.issues ?? []) console.error(`  - ${issue}`);
    if (result.oldKernel) console.error(OLD_KERNEL_HINT(id));
    return;
  }
  if (result.status === 'queued') {
    console.log(`✓ rerun of ${result.step} queued for ${id}; the running kernel applies it at its next check, and watch prints "plan revised"`);
    return;
  }
  const avoiding = result.avoid.length ? ` avoiding ${result.avoid.join(', ')}` : '';
  const by = result.appliedBy === 'kernel' ? 'applied by its running kernel'
    : result.paused ? 'applied directly; the run stays paused' : 'applied directly; kernel relaunched';
  if (result.pending) console.log(`✓ ${result.step} of ${id} will avoid ${result.avoid.join(', ')} when it runs · revision ${result.programRevision}`);
  else console.log(`✓ ${result.step} of ${id} runs again${avoiding} · revision ${result.programRevision} (${by})`);
  for (const note of result.notes ?? []) console.log(`  ${note}`);
  for (const line of stepReopenedLines(result.reopened)) console.log(`  ${line}`);
  if (result.handoff) console.log(`  handoff  ${result.handoff.attemptId} (${result.handoff.failureKind}${result.handoff.pool ? ` on ${result.handoff.pool}` : ''}) goes to the next attempt`);
  if (result.leaves?.length) {
    const names = result.leaves.join(', ');
    console.log(`  pool     starts on another pool than ${names} when one can take it (the step failed there on the pool); ${result.leaves.length === 1 ? 'that pool' : 'those'} only if none can`);
  }
  if (result.avoid.length) console.log(`  route    ${routeSummary(result.route)} · kept for later reruns; to remove it, export the plan, edit the route, then plan revise`);
  if (result.paused) console.log(`  resume   bullswarm workflow resume ${id}`);
  else console.log(`  watch    ${result.next.watch}`);
}

function printStepAccept(result, token) {
  const id = result.shortId ?? token;
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return; }
  if (result.status === 'rejected') {
    console.error(`✗ accept of ${result.step} rejected (run unchanged)`);
    for (const issue of result.issues ?? []) console.error(`  - ${issue}`);
    if (result.oldKernel) console.error(OLD_KERNEL_HINT(id));
    return;
  }
  if (result.status === 'queued') {
    console.log(`✓ accept of ${result.step} queued for ${id}; the running kernel applies it at its next check, and watch prints "plan revised"`);
    return;
  }
  if (result.kind === 'requirements') {
    console.log(`✓ ${result.requirements.join(', ')} accepted by your choice on ${result.step} · "${result.reason}" · revision ${result.programRevision}`);
    console.log('  evidence   choice (not proof; the run stays not verified)');
  } else {
    console.log(`✓ ${result.step} of ${id} accepted by your choice · "${result.reason}" · revision ${result.programRevision}`);
    console.log('  evidence   choice (not proof; the run is verified only by its checks)');
    if (result.dependents.length) console.log(`  dependents ${result.dependents.join(', ')} run now`);
  }
  for (const line of stepReopenedLines(result.reopened)) console.log(`  ${line}`);
  if (result.paused) console.log(`  resume     bullswarm workflow resume ${id}`);
  console.log(`  undo       ${result.next.undo}`);
}

function stepJson(action, result) {
  const { code, why, notes, ...rest } = result;
  return JSON.stringify({ action, ...rest, ...(why ? { why } : {}), ...(notes?.length ? { notes } : {}) }, null, 2);
}

function listFlag(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
}

async function relaunchRun(runId) {
  const resolved = resolveRunId(BULLSWARM_DIR(), runId);
  const doc = JSON.parse(readFileSync(join(resolved.runDir, 'goal.json'), 'utf8'));
  return launchDetachedResume(doc, runId, {});
}

const STEP_VERBS = ['restart', 'rerun', 'accept'];

async function wfStep(opts) {
  const verb = opts.rest[0];
  const path = STEP_VERBS.includes(verb) ? ['workflow', 'step', verb] : ['workflow', 'step'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [, token, stepId] = opts.rest;
  if (!STEP_VERBS.includes(verb) || !token || !stepId) { console.error(`usage: ${usageLine(STEP_VERBS.includes(verb) ? path : ['workflow', 'step', 'restart'])}`); return 2; }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  const waitSec = opts.wait == null ? (verb === 'restart' ? 60 : 120) : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  if (verb === 'rerun') {
    const result = await rerunV2Step({
      bullswarmDir: BULLSWARM_DIR(), token, stepId, avoid: listFlag(opts.avoid),
      pools: configuredPools() ?? [], labels: loadPoolLabels(BULLSWARM_DIR()), waitMs: waitSec * 1000, relaunch: relaunchRun,
    });
    if (opts.json) console.log(stepJson('step-rerun', result));
    else printStepRerun(result, token);
    return result.code;
  }
  if (verb === 'accept') {
    const result = await acceptV2Step({
      bullswarmDir: BULLSWARM_DIR(), token, stepId, reason: opts.reason, requirements: listFlag(opts.requirement),
      waitMs: waitSec * 1000, relaunch: relaunchRun,
    });
    if (opts.json) console.log(stepJson('step-accept', result));
    else printStepAccept(result, token);
    return result.code;
  }
  let poolNames = null;
  let pools = null;
  if (opts.pool) {
    pools = configuredPools();
    poolNames = pools ? pools.map((pool) => pool.name) : null;
  }
  const result = await restartV2Step({
    bullswarmDir: BULLSWARM_DIR(), token, stepId, pool: opts.pool ?? null, poolNames, pools, waitMs: waitSec * 1000,
  });
  const id = result.shortId ?? result.runId ?? token;
  const payload = {
    action: 'step-restart', ...result, code: undefined,
    ...(result.status === 'error' ? {} : { next: { watch: `bullswarm workflow watch ${id} --until trouble` } }),
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return result.code; }
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return result.code; }
  if (result.status === 'refused') { console.error(`✗ ${stepId} in ${id} was not restarted: ${result.why}`); return result.code; }
  const where = result.pool ? ` on ${result.pool}` : '';
  if (result.status === 'restarted') {
    console.log(withPoolLabels(`✓ restarted ${stepId} in ${id}: stopped ${result.stoppedAttemptId}${result.stoppedPool ? ` on ${result.stoppedPool}` : ''}; it runs again with its handoff${where}`, BULLSWARM_DIR()));
  } else {
    console.log(withPoolLabels(`✓ restart requested for ${stepId} in ${id}; its kernel stops ${result.stoppedAttemptId} at its next control check and runs it again with its handoff${where}`, BULLSWARM_DIR()));
  }
  console.log(`  watch    ${payload.next.watch}`);
  return result.code;
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

// The help path whose usage line explains this workflow verb. Returns null
// for a verb with no help node — the dispatcher's default branch already
// answers those with guidance and exit 2.
function workflowHelpPath(sub, opts) {
  if (!sub) return ['workflow'];
  if (sub === 'action') return opts.rest[0] === 'show' ? ['workflow', 'action', 'show'] : ['workflow', 'action'];
  if (sub === 'task') return opts.rest[0] === 'show' ? ['workflow', 'task', 'show'] : ['workflow', 'task'];
  if (sub === 'step') return ['restart', 'rerun', 'accept'].includes(opts.rest[0]) ? ['workflow', 'step', opts.rest[0]] : ['workflow', 'step'];
  const LEAVES = ['goal', 'cancel', 'pause', 'resume', 'capabilities', 'tui', 'events', 'watch', 'steer', 'reindex', 'reprice'];
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
    'out', 'rerun', 'base-revision', 'wait', 'width', 'height', 'until', 'pool',
    'avoid', 'requirement',
  ]);
  // Repeatable value flags collect every value (step rerun --avoid, step
  // accept --requirement).
  const listFlags = new Set(['avoid', 'requirement']);
  const assign = (key, value) => {
    if (listFlags.has(key)) out[key] = [...(out[key] ?? []), value];
    else out[key] = value;
  };
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
      if (eq > 0) assign(key, a.slice(eq + 1));
      else if (valueFlags.has(key)) {
        if (missingValue(i)) errors.push(`--${key} requires a value`);
        else assign(key, argv[++i]);
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
