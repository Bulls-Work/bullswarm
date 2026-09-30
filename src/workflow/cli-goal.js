// `bullswarm workflow goal`: a new run (refusing a duplicate of one still
// going, then checking the caller's program against the pools), a resume, or
// the detached child's relaunch. A new run launches detached unless
// --foreground; --watch follows it.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRunId, listRuns } from './short-id.js';
import { programAdvisories } from './action-validator.js';
import { isProgramV3, v3IssueWording } from './program-v3.js';
import { validateV2GoalDocument } from './v2-state.js';
import { V2PlannerValidationError, workspacePathIssues } from './v2-planner.js';
import { runWorkflowWatch } from './watch-cli.js';
import { helpText } from '../help.js';
import { flagErrors, removedFlagExit } from './workflow-flags.js';
import { BULLSWARM_DIR, drivableRunRefusal } from './cli-run-lookup.js';
import { modelPoolIssues, pinnedPoolIssues, routePoolIssues, livePoolNames } from './cli-pool-checks.js';
import { executeGoalDocument, launchDetachedGoal } from './cli-launch.js';
import { buildNewGoalDocument } from './cli-goal-document.js';
import {
  shellArg, goalArg, refuseProgramRequired, refuseProgramInvalid, loadCallerProgram, previewValidateInitialProgram,
  printAdvisories, ProgramV2RefusedError, refuseProgramV2,
} from './cli-program-checks.js';

function goalUsage() {
  return helpText(['workflow', 'goal']);
}

export function shouldAutoWatchGoal(opts) {
  return opts.watch === true && opts.detach !== true && opts.foreground !== true &&
    opts.json !== true && opts.resume == null && opts.request == null;
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

export async function wfGoal(opts) {
  if (opts.help) {
    console.log(goalUsage());
    return 0;
  }
  const removed = removedFlagExit(opts);
  if (removed !== null) return removed;
  const flagExit = flagErrors(opts, ['workflow', 'goal']);
  if (flagExit !== null) return flagExit;
  if (opts.watch && (opts.detach || opts.foreground || opts.json || opts.resume || opts.request)) {
    console.error('✗ --watch is only valid for a new human-readable independent launch; do not combine it with --detach, --foreground, --json, --resume, or --request');
    return 2;
  }
  // --planner was removed in 0.27.0: the caller writes the program.
  if (opts.planner !== undefined) { console.error('✗ --planner was removed: pass --program <file.json>; you write the program'); return 2; }
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
    const viewOnly = drivableRunRefusal(opts.resume, opts, 'goal --resume');
    if (viewOnly !== null) return viewOnly;
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
    if (opts['worker-pool'] || opts['worker-model'] || opts['worker-reasoning']) {
      console.error('✗ V2 resume preserves its durable routing contract; routing overrides are valid only when starting a new goal');
      return 2;
    }
    if (opts.program || opts.isolation !== undefined) {
      console.error(`✗ a resumed run keeps its program and workspace mode; to add steps use: bullswarm workflow add ${resolvedRun.shortId ?? resumeRunId} --steps <file.json>`);
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
    // D2 holds on the relaunch path too: a request carrying anything but a
    // program v3 (a 0.37.x request file, say) starts no run.
    if (!isProgramV3(initialPlannerResponse)) return refuseProgramV2(opts);
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
    if (!opts.program) return refuseProgramRequired(goal, opts);
    try {
      initialPlannerResponse = loadCallerProgram(opts);
      doc = buildNewGoalDocument(goal, opts);
    } catch (err) {
      if (err instanceof ProgramV2RefusedError) return refuseProgramV2(opts);
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
  const workerPool = doc.config.workerRouting?.pool ?? doc.config.workerRouting?.preferredPool ?? doc.config.workerRouting?.strictPool;
  if (workerPool && !names.includes(workerPool)) { console.error(`✗ requested worker pool "${workerPool}" is not available`); return 1; }
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
      ...modelPoolIssues(previewed.program.actions, pools, doc),
    ];
    if (workspaceIssues.length) return refuseProgramInvalid(doc.intent.goal, opts, workspaceIssues);
    // The same lines `plan validate` prints, at the moment the program is
    // actually launched. The kernel also stores them on the run state.
    printAdvisories(programAdvisories(previewed.program, { requirements: null })
      .map((item) => ({ ...item, message: v3IssueWording(item.message) })));
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
