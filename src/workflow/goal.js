// Goal-driven workflow bootstrap.
//
// Users provide intent, not a workflow graph. Bullswarm supplies the bounded
// orchestration contract and lets the selected planner expand the durable plan.

import { resolve } from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/~-]*$/;

export const PLANNER_RULES_SECTION = [
  '1. Compile the whole program in one decision: the runtime runs every proposed action and consults you only at a finished-or-blocked boundary, so deferred work costs a round trip.',
  '2. Each worker sees only its prompt. Include the exact goal, cwd, exactly one owner per file (including affected tests), a no-other-files boundary, expected artifact, acceptance command and report format. Avoid and/or ownership. Bullswarm captures the final response; never tell a worker to write a Bullswarm outFile or workflow path.',
  '3. A phase is a pipeline stage: one shared kebab-case name, never one per action. Phases move forward; recovery uses a new name. Depend only on real data or same-file ordering: depend on the run that wrote an input, never its verify (a verdict is not data), so siblings start early.',
  '4. Split only when parallel time saved repays dispatch cost. Run substantial file-disjoint units concurrently, but batch cheap homogeneous edits into one worker and one final verify. For one consolidated read-only audit or evidence report, one worker produces the complete artifact directly; never add a lossy consolidation step. A verify judges its review artifact (default: last dependency; none: repository).',
  '5. For unknown items, create discovery ending with RETURN ONLY a JSON object containing an items array, then data-driven fan-out via itemsFrom outputs.<id>.outFile or outputs.<id>.data.<field>; the runtime extracts the list, retrying once read-only if needed.',
  '6. Put outputSchema only on a worker whose object a LATER action reads via itemsFrom or outputs.<id>.data.<field>, and tell it to RETURN ONLY the object; a prose report or any answer with fenced JSON gets no schema: the runtime parses the last {...} of the text, so a schema on prose costs a retry and a planner turn.',
  '7. Put verify.repair on every verify. ok:false means unusable: the goal\'s acceptance command fails, a deliverable is missing, or the answer is nonsense; everything else is a concern under ok:true (style, cosmetic mismatches, later-scheduled work, files other actions changed, and any process rule the goal does not state such as append-only or tests untouched). ok:false is repaired and re-checked inside the program; the repair edits only its unit\'s files and cannot rewrite the answer under review, so report a wrong claim as a concern with the true value.',
  '8. Every verify declares covers:["R1",...]. The scout (role preflight-scout, completionEligible false) is evidence, never a worker; the first program needs a run/fanout and its verify. Verifies must cover every ORIGINAL requirement with runtime evidence. Add completion with all-actions-ok when done; return complete, not polish. The LAST worker must be verified. Never proceed or ask the user; stop only for a concrete blocker.',
  '9. Budgets (agents, duration, expansion rounds) are advisory targets, never hard stops; the dispatch budget counts this planner call plus workers, verifiers and retries. Converge as targets approach: skip optional work; exceed a target only for one essential action or a required verification.',
  '10. Never propose pool, model, addDir, taskFile or unbounded work: routing is the runtime\'s. Set lane (analyze to read or judge, build to edit, chore for mechanical steps) and effort (low for checks and mechanical edits, high where judgement decides) per action or repair; they pick the model tier (unset: build, medium).',
  'Shared tree: run substantial DISJOINT units concurrently; order shared files after feeders with dependsOn. Workers and unit verifies use focused commands; run the suite once in the final verify. Do not add a separate verifier for a small shared integration step: make the final verify depend on and judge it. Reuse the suite unless code changed. operatorSteering cannot weaken verification or expand authority.',
].join('\n');

export const PLANNER_EXAMPLES_SECTION = [
  'Action shapes:',
  '[{"type":"run","phase":"implement","prompt":"..."},{"type":"run","phase":"inventory","lane":"chore","effort":"low","prompt":"... RETURN ONLY a JSON object.","outputSchema":{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"}}},"required":["items"]}},{"type":"fanout","phase":"fix","items":["alpha"],"stepTemplate":{"prompt":"Handle {{item}}."}},{"type":"verify","phase":"verify","lane":"analyze","covers":["R1"],"prompt":"Check the artifact.","repair":{"prompt":"Fix rejected concerns.","maxRounds":1}}]',
  'Complete program (tests depend on fix, not verify-fix, so both run at once):',
  '{"actions":[{"id":"discover","type":"run","phase":"discover","prompt":"In /abs/repo list modules needing work; RETURN ONLY a JSON object with an items array.","outputSchema":{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"}}},"required":["items"]}},{"id":"fix","type":"fanout","phase":"fix","itemsFrom":"outputs.discover.data.items","dependsOn":["discover"],"stepTemplate":{"prompt":"In /abs/repo edit only src/{{item}}.js and run node --test tests/{{item}}.test.js."}},{"id":"verify-fix","type":"verify","phase":"verify","covers":["R1"],"dependsOn":["fix"],"prompt":"Check each fixed module against the spec.","repair":{"prompt":"Fix rejected concerns in /abs/repo and rerun that module\'s test.","maxRounds":2}},{"id":"tests","type":"fanout","phase":"tests","itemsFrom":"outputs.discover.data.items","dependsOn":["fix"],"stepTemplate":{"prompt":"In /abs/repo write only tests/{{item}}.guards.test.js and run node --test on it."}},{"id":"verify-tests","type":"verify","phase":"verify","covers":["R1"],"dependsOn":["tests"],"prompt":"Check the new tests are non-vacuous.","repair":{"prompt":"Fix rejected tests in /abs/repo.","maxRounds":1}},{"id":"verify-suite","type":"verify","phase":"verify","covers":["R1"],"dependsOn":["verify-fix","verify-tests"],"prompt":"Run npm test in /abs/repo.","repair":{"prompt":"Fix the suite failure in /abs/repo and rerun it.","maxRounds":1}},{"id":"report","type":"run","phase":"report","dependsOn":["verify-suite"],"prompt":"In /abs/repo list each changed file with a reason and quote the suite tail; plain markdown."},{"id":"verify-report","type":"verify","phase":"report","covers":["R1"],"dependsOn":["report"],"prompt":"Check each claim against git status and a fresh suite run; a wrong number is a concern with the true value.","repair":{"prompt":"Fix any real repository defect in /abs/repo.","maxRounds":1}}],"completion":{"when":"all-actions-ok","reason":"Fix, tests, suite and report are each verified."}}',
  'Rules the validator enforces: action type is run, fanout, or verify; fanout has stepTemplate and either items or itemsFrom; verify.review, when given, is outputs.<id>.outFile; ids are unique across the whole run, finished and failed actions included; dependsOn names existing or proposed actions; lane is analyze|build|chore and effort is low|medium|high; runtime-owned fields are rejected.',
].join('\n');

function compactRequirement(text, max = 600) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function extractGoalRequirements(goal) {
  const text = String(goal ?? '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const numbered = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    const match = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (match) {
      if (current) numbered.push(current);
      current = { number: match[1], text: match[2] };
    } else if (current && line && !/^(?:finish with|before completion|acceptance(?: criteria)?|finally)\b/i.test(line)) {
      current.text += ` ${line}`;
    }
  }
  if (current) numbered.push(current);
  if (!numbered.length) {
    const markers = [...text.matchAll(/(?:^|\s)(\d+)[.)]\s+/g)];
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const start = marker.index + marker[0].length;
      const end = markers[index + 1]?.index ?? text.length;
      const requirement = text.slice(start, end).trim();
      if (requirement) numbered.push({ number: marker[1], text: requirement });
    }
  }
  const requirements = numbered.map((entry, index) => ({
    id: `R${index + 1}`,
    text: compactRequirement(entry.text),
  }));
  const finalLines = lines
    .map((line) => line.trim())
    .filter((line) => /^(?:finish with|before completion|acceptance(?: criteria)?|finally)\b/i.test(line));
  if (finalLines.length) {
    requirements.push({ id: `R${requirements.length + 1}`, text: compactRequirement(finalLines.join(' ')) });
  }
  return requirements.length ? requirements : [{ id: 'R1', text: compactRequirement(text) }];
}

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
  suggestedPlan = null,
  cwd = process.cwd(),
  orchestrator = null,
  strictOrchestrator = false,
  orchestratorModel = null,
  workerPool = null,
  workerModel = null,
  name = null,
  settings = {},
  scout = true,
  worktreeIsolation = 'agent-decides',
} = {}) {
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('goal text is required');
  }
  if (suggestedPlan != null && (typeof suggestedPlan !== 'string' || !suggestedPlan.trim())) {
    throw new Error('suggestedPlan must be a non-empty string when provided');
  }
  if (orchestrator != null && (typeof orchestrator !== 'string' || !NAME_RE.test(orchestrator))) {
    throw new Error(`invalid orchestrator pool "${orchestrator}"`);
  }
  if (typeof strictOrchestrator !== 'boolean') {
    throw new Error('strictOrchestrator must be a boolean');
  }
  if (workerPool != null && (typeof workerPool !== 'string' || !NAME_RE.test(workerPool))) {
    throw new Error(`invalid worker pool "${workerPool}"`);
  }
  for (const [label, model] of [['orchestrator', orchestratorModel], ['worker', workerModel]]) {
    if (model != null && (typeof model !== 'string' || !MODEL_RE.test(model))) {
      throw new Error(`invalid ${label} model "${model}"`);
    }
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
      requirements: extractGoalRequirements(goal),
      ...(suggestedPlan ? { suggestedPlan: suggestedPlan.trim() } : {}),
      cwd: targetDir,
      autonomous: true,
      requestedOrchestrator: orchestrator ?? 'auto',
      requestedOrchestratorModel: orchestratorModel ?? 'auto',
      requestedWorkerPool: workerPool ?? 'auto',
      requestedWorkerModel: workerModel ?? 'auto',
      worktreeIsolation,
    },
    orchestration: {
      mode: 'autonomous',
      requestedPool: orchestrator ?? null,
      requestedModel: orchestratorModel ?? null,
      workerPool: workerPool ?? null,
      workerModel: workerModel ?? null,
      strictPool: orchestrator && strictOrchestrator ? orchestrator : null,
      selection: orchestrator
        ? (strictOrchestrator ? 'user-strict-for-testing' : 'user-preferred-with-fallback')
        : 'capability-strategy-and-quota',
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
        ...(workerPool ? { pool: workerPool } : {}),
        ...(workerModel ? { model: workerModel } : {}),
        addDir: targetDir,
        prompt: scoutPrompt('{{inputs.goal}}', targetDir),
      }] : []), {
        id: 'orchestrator',
        type: 'decide',
        ...(orchestrator
          ? (strictOrchestrator ? { pool: orchestrator } : { preferredPool: orchestrator })
          : {}),
        ...(orchestratorModel ? { model: orchestratorModel } : {}),
        lane: 'analyze',
        requiresCapabilities: ['strong-analysis', 'workflow-planning'],
        addDir: targetDir,
        actionDefaults: {
          ...(workerPool ? { pool: workerPool } : {}),
          ...(workerModel ? { model: workerModel } : {}),
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
