// bullswarm workflow CLI — goal | plan | runs | watch | tui.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRuns, cmdReindex } from './runs-cli.js';
import { runDashboard, dashboardJson, overviewSnapshot } from './dashboard.js';
import { KIND_DEFAULTS } from './action-validator.js';
import { wfAdd, wfContinue, wfWait } from './cli-steps.js';
import { DELIVERABLE_TYPES, EVIDENCE_TYPES, STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES } from './step-vocabulary.js';
import { EVIDENCE_DEFAULT_TIMEOUT_SEC, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_TIMEOUT_SEC, EVIDENCE_ENV_KEYS, CHECKER_PATH } from './evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from './schema-check.js';
import { workerSilenceTimeoutSec } from './v2-dispatch.js';
import { v2RoleCatalog } from './v2-planner.js';
import { loadState } from '../lib/state.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { cmdReprice } from './reprice.js';
import { resolvePoolId } from '../lib/pool-labels.js';
import { workflowHelpPath, parseFlags, flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal } from './cli-run-lookup.js';
import { programRoutes, routePoolIssues, configuredPools, livePoolNames } from './cli-pool-checks.js';
import { launchDetachedResume } from './cli-launch.js';
import { wfPlan } from './cli-plan.js';
import { wfGoal } from './cli-goal.js';
import { wfStep } from './cli-step-verbs.js';
import { wfPause, wfCancel, wfResume, wfSteer } from './cli-run-verbs.js';
import { wfEvents, wfWatch, wfAction, wfTask } from './cli-inspect.js';

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
