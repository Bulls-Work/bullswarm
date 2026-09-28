// Starting a run's kernel from the CLI: in this process (executeGoalDocument,
// which prints the outcome), or as a detached child for a new run or a
// resume, waiting until the child holds the run and then printing how to
// watch it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { newRunId, isProcessAlive } from './short-id.js';
import { isProgramV3 } from './program-v3.js';
import {
  parkedFailures, programControl, v3LaunchInstruction, waitingDocument, waitingOutcomeLines,
} from './gates-loops.js';
import { v2PlannerMode } from './v2-state.js';
import { runV2AutonomousWorkflow } from './v2-runtime.js';
import { formatV2HandbackLines, formatV2ProofLine, summarizeV2Result } from './v2-outcome.js';
import { BULLSWARM_DIR } from './cli-run-lookup.js';

export async function executeGoalDocument({ doc, pools, opts, runId, resumeRunId, initialPlannerResponse = null }) {
  const result = await runV2AutonomousWorkflow({
    bullswarmDir: BULLSWARM_DIR(), goalDocument: doc, pools, runId, resumeRunId, initialPlannerResponse,
  });
  if (!result.result && result.state?.lifecycle?.status === 'interrupted') {
    const interrupted = { action: 'workflow-interrupted', runId: result.runId, shortId: result.shortId, status: 'interrupted', next: `bullswarm workflow goal --resume ${result.shortId ?? result.runId}` };
    if (opts.json) console.log(JSON.stringify(interrupted, null, 2));
    else if (!opts.quiet) console.log(`workflow ${result.shortId ?? result.runId} interrupted; edits retained. Resume with: ${interrupted.next}`);
    return 130;
  }
  // A v3 run parked at a gate or an out-of-rounds loop (gates-loops.js).
  if (!result.result && result.waiting) {
    const failed = parkedFailures(result.state);
    const document = waitingDocument({ runId: result.runId, shortId: result.shortId, waitingFor: result.waiting, failed });
    if (opts.json) console.log(JSON.stringify(document, null, 2));
    else if (!opts.quiet) console.log(waitingOutcomeLines(result.shortId ?? result.runId, result.waiting, failed).join('\n'));
    return 0;
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
      if (!isProgramV3(result.state?.program)) console.log(`verification: ${result.result.verified ? 'all mandatory requirements have passing evidence' : 'not independently verified; inspect action outputs and evidence'}`);
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

function goalObserveCommands(token, { callerPlanner = false, v3 = false } = {}) {
  return {
    watch: `bullswarm workflow watch ${token}${v3 ? ' --until trouble' : ''}`,
    summary: `bullswarm workflow runs show ${token}`,
    result: `bullswarm workflow runs result ${token} --json`,
    dashboard: `bullswarm workflow tui ${token}`,
    inspect: `bullswarm workflow tui --json ${token}`,
    events: `bullswarm workflow events --json ${token} --after 0`,
    steer: `bullswarm workflow steer ${token} --message "<guidance>"`,
    cancel: `bullswarm workflow cancel ${token} --json`,
    ...(callerPlanner && v3 ? { add: `bullswarm workflow add ${token} --steps part.json` } : {}),
    ...(callerPlanner && !v3 ? { plan: `bullswarm workflow plan export ${token} --out plan.json` } : {}),
  };
}

export async function launchDetachedResume(doc, runId, opts) {
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
  const control = programControl(state?.program);
  const launch = {
    action: 'goal-resumed',
    runId,
    shortId: state?.shortId ?? null,
    status: state?.lifecycle?.status ?? 'resuming',
    pid: child.pid,
    observe: goalObserveCommands(token, { callerPlanner: v2PlannerMode(doc) === 'caller', v3: Boolean(control) }),
    logs: { stdout: stdoutPath, stderr: stderrPath },
  };
  launch.instructions = goalLaunchInstructions(launch.observe, control && { control, token });
  return launch;
}

export async function launchDetachedGoal(doc, opts, { initialPlannerResponse = null } = {}) {
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
  const control = programControl(initialPlannerResponse);
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
    observe: goalObserveCommands(token, { callerPlanner, v3: Boolean(control) }),
    logs: { stdout: stdoutPath, stderr: stderrPath },
    ...(opts.verifyRoundsMeaning ? { verifyRoundsMeaning: opts.verifyRoundsMeaning } : {}),
  };
  launch.instructions = goalLaunchInstructions(launch.observe, control && { control, token });
  if (!opts.silentLaunch && opts.json) console.log(JSON.stringify(launch, null, 2));
  else if (!opts.silentLaunch) {
    printGoalLaunchInstructions(launch);
  }
  return launch;
}

function goalLaunchInstructions(observe, v3 = null) {
  return {
    // A v3 run: work is added, and the run says where it stops (gates-loops.js).
    ...(observe.add ? { callerPlanner: v3LaunchInstruction(v3?.control, v3?.token) } : {}),
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
      purpose: observe.add ? 'Stay quiet until you are needed: a gate waits, a loop runs out of rounds, a step needs you, or the run ends.' : 'Follow low-noise semantic progress until the workflow is terminal.',
      command: observe.watch,
    },
    humanTui: {
      purpose: 'Open the interactive Phase → Agent → Activity browser; q detaches safely.',
      command: observe.dashboard,
    },
    result: {
      purpose: observe.add ? 'After it finishes, obtain the stable result: each step\'s facts and checked answer, and a handback of anything left with your options.' : 'After it finishes, obtain the stable result: verification, and a handback of anything left with your options (continue, retry, take over, restart).',
      command: observe.result,
    },
    cancel: {
      purpose: 'Stop the run cooperatively; a paused run is finalized immediately.',
      command: observe.cancel,
    },
  };
}

export function printGoalLaunchInstructions(launch) {
  console.log(`workflow ${launch.shortId ?? launch.runId} continues independently; next commands:`);
  for (const [name, instruction] of Object.entries(launch.instructions)) {
    console.log(`  ${name.padEnd(13)} ${instruction.command}`);
    console.log(`                 ${instruction.purpose}`);
  }
}
