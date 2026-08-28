// Goal-driven workflow bootstrap.
//
// Users provide intent, not a workflow graph. Bullswarm supplies the bounded
// orchestration contract and lets the selected planner expand the durable plan.

import { resolve } from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const AUTONOMOUS_ORCHESTRATOR_PROMPT = [
  'You are the autonomous orchestrator for the user goal in the durable workflow context.',
  'Your job is to compile the goal into a complete workflow program. The runtime executes every action you propose, in dependency order and in parallel, without consulting you, and calls you again only at the program boundary: when every action has finished or the graph is blocked.',
  'Own the workflow from initial decomposition through implementation and independent verification.',
  'The user did not author a graph and must not be asked to steer routine execution.',
  'This is a control-plane decision thread, not a worker assignment. Do not invoke Bullswarm, run shell commands, call tools, or modify repository files. Use only the durable context supplied below and return the requested decision JSON; delegate all inspection, implementation, and verification as bounded actions.',
  '',
  'At every checkpoint:',
  '1. Observe the intent, completed actions, artifacts, failures, verification results, available capabilities, and remaining budget.',
  '2. If evidence is insufficient, return needs_more_work with the COMPLETE program: every bounded run, fanout, and verify action you can see now, not the smallest step. Independent actions run concurrently; dependent actions start as soon as their dependencies succeed. One planning round trip costs minutes, so a decision with one action when several are obvious is the expensive choice, and anything decidable by data (how many items, whether a check passed, whether to repair once) belongs in the program, not in a later decision.',
  '3. Give workers self-contained prompts with the exact goal, absolute working directory, the files they may edit (and that they must not touch others), the expected artifact, and the exact acceptance command. A worker sees only its own prompt.',
  '4. Assign every action a short kebab-case phase name such as discover, fix, verify-items, or verify-suite. Phases are forward-only: never append new work to a phase that already finished.',
  '5. Use dependsOn only for real data or same-file ordering dependencies. For N known items propose N fix actions and N verify actions (each verify depending only on its own fix) plus one final verify depending on all of them; use fanout with inline items when every item needs the identical prompt. When the item count is unknown, propose a discovery run whose prompt ends with "RETURN ONLY a JSON array of <items>" and a fanout with itemsFrom "outputs.<discovery-id>.outFile", so the runtime fans out the moment discovery finishes.',
  '   A verify action with exactly one dependency automatically reviews that dependency artifact (a fan-out artifact summarises every item); you do not need to supply a review path. Give every verify a repair policy {"prompt": "<how to fix what the verifier rejects>", "maxRounds": 1-3} so a rejected verdict is fixed and re-checked inside the program instead of costing another checkpoint.',
  '6. Recover from a failed action with a new bounded action in a new phase when useful; do not repeat an identical failed plan.',
  '7. Require concrete verification of changed behavior. For code changes, obtain relevant test or inspection evidence before completion.',
  '8. Return complete only when durable outputs prove the original goal and its acceptance checks are satisfied.',
  '',
  'Do not return proceed: this autonomous workflow has no hidden static work after this gate.',
  'Do not ask the initiating user to construct JSON or choose agents.',
  'Do not propose pool, addDir, taskFile, shell authority, or unbounded work; Bullswarm owns routing and process authority.',
  'Treat maxAgents, maxWorkflowSeconds, and maxExpansionRounds as planning targets, not hard stop conditions.',
  'As those targets approach, converge aggressively: consolidate existing artifacts, avoid optional investigation, and finish with the best useful outcome rather than spending on marginal refinements.',
  'Exceed an advisory target only for a small essential action needed to avoid discarding otherwise-completable work or skipping required verification.',
  'Return stop when unresolved concerns make verified completion disproportionate or when a concrete safety, authority, capability, dependency, or external blocker remains. Stop returns a qualified final outcome; it is not a blanket workflow failure when useful work exists.',
].join('\n');

// Read-only survey that runs before the orchestrator's first decision, so the
// program it compiles names real files, modules, and commands instead of
// guessing — the equivalent of the inline scouting a Claude Code session does
// before authoring a Workflow script.
export function scoutPrompt(goal, cwd) {
  return [
    'You are the read-only SCOUT for an autonomous workflow. Another agent will turn the goal below into a program of parallel worker actions using ONLY your report, so be concrete and complete.',
    `Working directory (absolute): ${cwd}`,
    `Goal: ${goal}`,
    '',
    'Survey what the goal touches. Do NOT modify, create, or delete any file; do not install dependencies; do not commit.',
    'Report under exactly these headings, at most ~80 lines total:',
    'TREE: the directory tree to depth 3 (skip node_modules, .git, build output), one entry per line.',
    'MANIFEST: package/build manifest facts that matter (name, language/runtime, test command, lint/format command, module system).',
    'TEST STATUS: run the test command once and report the exact pass/fail counts and any failing test names.',
    'UNITS OF WORK: one bullet per independent item the goal implies (module, file, finding, page). For each: the exact files it owns, the exact focused command that proves it is done, and anything already present.',
    'SHARED FILES: files that more than one unit would touch (indexes, barrels, README tables, config) and therefore must be edited by one action after the others.',
    'RISKS: anything that constrains the plan (files that must not change, flaky tests, missing tools, ambiguous requirements).',
    'Finally, END your output with a JSON array of the unit-of-work names in UNITS OF WORK, e.g. ["csv","duration"]. Nothing after the array.',
  ].join('\n');
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected an integer from ${min} to ${max}, got "${value}"`);
  }
  return parsed;
}

export function buildGoalWorkflow({
  goal,
  cwd = process.cwd(),
  orchestrator = null,
  name = null,
  settings = {},
  scout = true,
  worktreeIsolation = 'agent-decides',
} = {}) {
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('goal text is required');
  }
  if (orchestrator != null && (typeof orchestrator !== 'string' || !NAME_RE.test(orchestrator))) {
    throw new Error(`invalid orchestrator pool "${orchestrator}"`);
  }

  const targetDir = resolve(cwd);
  const workflowName = name ?? `goal-${Date.now().toString(36)}`;
  if (!NAME_RE.test(workflowName)) throw new Error(`invalid generated workflow name "${workflowName}"`);

  const maxAgents = positiveInt(settings.maxAgents, 30, { max: 500 });
  const maxExpansionRounds = positiveInt(settings.maxExpansionRounds, 8, { max: 50 });
  const maxActions = positiveInt(settings.maxActions, 40, { max: 1000 });
  const maxItemsPerExpansion = positiveInt(settings.maxItemsPerExpansion, 24, { max: 100 });
  const maxWorkflowSeconds = positiveInt(settings.maxWorkflowSeconds, 3600, { max: 86_400 });
  const concurrency = positiveInt(settings.concurrency, 8, { max: 16 });
  const retryAttempts = positiveInt(settings.retryAttempts, 1, { min: 0, max: 3 });
  if (!['agent-decides', 'off', 'required'].includes(worktreeIsolation)) {
    throw new Error(`invalid worktree isolation policy "${worktreeIsolation}"`);
  }
  const worktreeInstruction = worktreeIsolation === 'required'
    ? 'Worktree isolation policy: required when the selected agent supports it.'
    : worktreeIsolation === 'off'
      ? 'Worktree isolation policy: disabled; work in the supplied directory.'
      : 'Worktree isolation policy: agent decides whether isolation is useful; do not introduce a worktree for routine sequential work.';

  return {
    schemaVersion: 'bullswarm.workflow.v1',
    name: workflowName,
    mode: 'adaptive',
    description: 'Autonomous goal-driven workflow generated by Bullswarm.',
    intent: {
      goal: goal.trim(),
      cwd: targetDir,
      autonomous: true,
      requestedOrchestrator: orchestrator ?? 'auto',
      worktreeIsolation,
    },
    orchestration: {
      mode: 'autonomous',
      requestedPool: orchestrator ?? null,
      selection: orchestrator ? 'user-pinned-for-testing' : 'capability-strategy-and-quota',
      completionPolicy: {
        requireSuccessfulWorker: true,
        requireSuccessfulVerification: true,
      },
    },
    inputs: {},
    settings: {
      concurrency,
      retryAttempts,
      escalateOnFail: true,
      maxAgents,
      warnAtAgents: Math.min(20, maxAgents),
      maxExpansionRounds,
      maxActions,
      maxItemsPerExpansion,
      maxWorkflowSeconds,
    },
    phases: [{
      name: 'autonomous-delivery',
      steps: [...(scout === true ? [{
        id: 'scout',
        type: 'run',
        lane: 'analyze',
        addDir: targetDir,
        prompt: scoutPrompt(goal.trim(), targetDir),
      }] : []), {
        id: 'orchestrator',
        type: 'decide',
        ...(orchestrator ? { pool: orchestrator } : {}),
        lane: 'analyze',
        requiresCapabilities: ['strong-analysis', 'workflow-planning'],
        addDir: targetDir,
        actionDefaults: {
          lane: 'build',
          requiresCapabilities: ['code-reading', 'file-editing'],
          addDir: targetDir,
        },
        prompt: `${AUTONOMOUS_ORCHESTRATOR_PROMPT}\n\n${worktreeInstruction}`,
        onError: 'fail',
      }],
    }],
  };
}
