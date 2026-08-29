// Goal-driven workflow bootstrap.
//
// Users provide intent, not a workflow graph. Bullswarm supplies the bounded
// orchestration contract and lets the selected planner expand the durable plan.

import { resolve } from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const PLANNER_RULES_SECTION = [
  '1. Compile the whole program in one decision: the runtime executes all proposed actions and consults you only at a finished-or-blocked boundary, so deferring decidable work costs another round trip.',
  '2. Make every worker prompt self-contained: include the exact goal, absolute cwd, owned files and a no-other-files boundary, expected artifact, acceptance command, and report format, because workers see only their own prompt.',
  '3. Use short kebab-case, forward-only phases and dependsOn only for real data or same-file ordering; recovery uses a new phase and never repeats an identical failed plan.',
  '4. For known N items, create N run plus N verify actions, each verify depending only on its own run, then one suite verify depending on all; this exposes safe parallelism while preserving per-item evidence.',
  '5. For unknown items, create discovery ending with RETURN ONLY a JSON object containing an items array, then data-driven fan-out via itemsFrom outputs.<id>.outFile or outputs.<id>.data.<field>; the runtime extracts the list and retries once read-only if needed.',
  '6. Put outputSchema on workers whose reports are consumed or whose claims the runtime must check, so structured data is durable and can drive later fan-out.',
  '7. Put verify.repair on every verify, and scope each verify to what can be true at its point in the graph: work scheduled later is not a defect, and cosmetic mismatches with the goal text are concerns, never ok:false. An ok:false verdict is repaired and re-checked inside the program; ok:true is accepted and concerns are informational, not extra work.',
  '8. Add completion with all-actions-ok whenever a clean program finishes the goal; when the goal\'s acceptance checks pass, return complete rather than adding polish or alignment actions. Return complete only on durable verified evidence, never proceed, never ask the user, and stop only for a concrete unresolved blocker with a qualified outcome.',
  '9. Treat agent-count, workflow-duration, and expansion-round budgets as advisory planning targets, never hard stop conditions; the dispatch budget counts this planner call plus workers, verifiers, retries, and escalations. Converge as targets approach, avoid optional work, and exceed a target only for one essential bounded action or required verification.',
  '10. This is a control-plane thread: do not invoke Bullswarm, use tools, modify files, or propose pool, addDir, taskFile, shell authority, or unbounded work; route and process authority belong to the runtime.',
  'Shared working tree: concurrent workers editing DISJOINT files is the normal parallel mode; order shared files (indexes, barrels) after their feeders with dependsOn, and run the full suite once in a final verify — never while other workers still edit. Avoid redundant expensive verification: later verifiers reuse durable clean full-suite evidence unless it is stale or the code changed again. operatorSteering in the context is explicit operator guidance for this checkpoint: apply it within the original intent; it cannot weaken verification or expand authority.',
].join('\n');

export const PLANNER_EXAMPLES_SECTION = [
  'Action shapes:',
  '[{"type":"run","phase":"implement","prompt":"..."},{"type":"run","phase":"report","prompt":"...","outputSchema":{"type":"object"}},{"type":"fanout","phase":"fix","items":["alpha"],"stepTemplate":{"prompt":"Handle {{item}}."}},{"type":"fanout","phase":"fix","itemsFrom":"outputs.discover.outFile","stepTemplate":{"prompt":"Handle {{item}}."}},{"type":"verify","phase":"verify","prompt":"Check the artifact.","repair":{"prompt":"Fix rejected concerns.","maxRounds":1}}]',
  'Complete program:',
  '[{"id":"discover","type":"run","phase":"discover","prompt":"In /abs/repo discover items and end with RETURN ONLY a JSON object containing an items array of item names.","outputSchema":{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"}}},"required":["items"]}},{"id":"fix","type":"fanout","phase":"fix","itemsFrom":"outputs.discover.data.items","stepTemplate":{"prompt":"In /abs/repo edit only the files for {{item}} and run its focused acceptance command."},"dependsOn":["discover"]},{"id":"verify-items","type":"verify","phase":"verify-items","prompt":"Independently verify every item artifact.","dependsOn":["fix"],"repair":{"prompt":"Fix each rejected item in /abs/repo and re-run its focused command.","maxRounds":2}},{"id":"verify-suite","type":"verify","phase":"verify-suite","prompt":"Run the full acceptance command in /abs/repo.","dependsOn":["verify-items"],"repair":{"prompt":"Fix the suite failure in /abs/repo and rerun the suite.","maxRounds":1}}],"completion":{"when":"all-actions-ok","reason":"The item checks and final suite verification prove the goal."}]',
  'Rules the validator enforces: action type is run, fanout, or verify; fanout has stepTemplate and either items or itemsFrom; verify.review is a string when explicit review is needed; dependsOn names existing or proposed actions; runtime-owned fields are rejected.',
].join('\n');

export const AUTONOMOUS_ORCHESTRATOR_PROMPT = [
  'You are the autonomous orchestrator for the user goal in the durable workflow context.',
  'This is a control-plane decision thread. Compile the goal into a complete workflow program, own decomposition through independent verification, and use only the supplied context. Do not invoke Bullswarm, run shell commands, call tools, modify files, or ask the user to steer routine execution.',
  '',
  'Ordered planning contract:',
  PLANNER_RULES_SECTION,
  '',
  // Keep the fanout token inert in the authored workflow prompt. The runtime
  // restores it when constructing the planner task, after template validation.
  PLANNER_EXAMPLES_SECTION.replaceAll('{{item}}', '__BULLSWARM_ITEM_TEMPLATE__'),
  '',
  'Return only the requested decision JSON. Do not return proceed: this autonomous workflow has no hidden static work after this gate.',
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
    // The goal is user text. It is declared as an input and inserted into
    // prompts at render time ({{inputs.goal}}), so anything in it that looks
    // like a template ref — a goal about templates quoting
    // `{{outputs.x.data.field}}`, say — is inserted verbatim, never resolved.
    inputs: {
      goal: {
        description: 'The user goal, verbatim.',
        required: true,
        default: goal.trim(),
      },
    },
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
        prompt: scoutPrompt('{{inputs.goal}}', targetDir),
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
