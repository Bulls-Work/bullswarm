// `bullswarm workflow capabilities`: the engine's program vocabulary (lanes,
// kinds, deliverables, evidence) and this machine's pools, as a
// probing caller reads them.

import { KIND_DEFAULTS } from './action-validator.js';
import { DELIVERABLE_TYPES, EVIDENCE_TYPES, STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES } from './step-vocabulary.js';
import {
  EVIDENCE_DEFAULT_TIMEOUT_SEC, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_TIMEOUT_SEC, EVIDENCE_ENV_KEYS, CHECKER_PATH,
} from './evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from './schema-check.js';
import { workerSilenceTimeoutSec } from './v2-dispatch.js';
import { loadState } from '../lib/state.js';
import { BULLSWARM_DIR } from './cli-run-lookup.js';
import { livePoolNames } from './cli-pool-checks.js';

export async function wfCapabilities(opts) {
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
        // Program-mode vocabulary beside kinds: the deliverable types a step
        // may promise, and the evidence types.
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
          caller: 'the only mode: the calling agent authors the program (workflow plan contract|validate, workflow goal --program, workflow add); the kernel never dispatches a planner and never waits for the caller: a run that needs a decision finishes, and its result hands the decision back',
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
