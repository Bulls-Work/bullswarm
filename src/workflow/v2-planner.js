import { ACTION_PROGRAM_SCHEMA_VERSION, validateActionProgram } from './action-validator.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consolidateV2Gaps } from './v2-outcome.js';
import { validateV2DurableState, validateV2GoalDocument } from './v2-state.js';
import { deriveV2PresentationStages, deriveV2DependencyStages } from './v2-presentation.js';
import { extractScoutUnitIds } from './goal.js';
import { isProgramWorkflow } from './execution-policy.js';

export const V2_PLANNER_RESPONSE_SCHEMA_VERSION = 'bullswarm.workflow.planner-response.v2';

const RESPONSE_FIELDS = new Set(['schemaVersion', 'kind', 'summary', 'program', 'reason']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export class V2PlannerValidationError extends Error {
  constructor(issues) {
    super(`V2 planner response invalid: ${issues.length} problem(s)`);
    this.name = 'V2PlannerValidationError';
    this.issues = [...issues];
  }
}

function substantive(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function runtimeFromState(state) {
  const freshEvidenceRequirementIds = Object.values(state.ledger.requirements)
    .filter((requirement) => requirement.status === 'passed')
    .map((requirement) => requirement.id);
  const knownArtifacts = [];
  for (const action of state.program.actions) for (const id of action.produces ?? []) knownArtifacts.push({ id, producer: action.id });
  return {
    requirements: state.intent.requirements.map(({ id, mandatory }) => ({ id, mandatory })),
    knownActions: state.program.actions.map((action) => ({
      id: action.id,
      dependsOn: clone(action.dependsOn),
      affects: clone(action.affects),
      ownedFiles: clone(action.ownedFiles),
      evidenceFor: clone(action.evidenceFor),
      produces: clone(action.produces ?? []),
    })),
    knownArtifacts,
    freshEvidenceRequirementIds,
    workspaceMutation: state.intent.constraints?.workspaceMutation ?? 'allowed',
    maxActions: Number(state.config.settings.maxActions ?? 100),
    maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 100,
    enforceMaxActions: false,
    enforceMaxParallel: false,
    requireMandatoryEvidence: !isProgramWorkflow(state),
    relaxedGraph: isProgramWorkflow(state),
    requireOwnedFiles: isProgramWorkflow(state) && state.config.settings.workspaceMode === 'isolated',
  };
}

export function validateV2PlannerResponse(response, state, {
  boundary = state?.program?.actions?.length ? 'gaps' : 'initial',
  requiredScoutUnits = [],
} = {}) {
  validateV2DurableState(state);
  const issues = [];
  if (!plain(response)) throw new V2PlannerValidationError(['response must be a plain object']);
  for (const key of Object.keys(response)) if (!RESPONSE_FIELDS.has(key)) issues.push(`response.${key} is not allowed`);
  if (response.schemaVersion !== V2_PLANNER_RESPONSE_SCHEMA_VERSION) issues.push(`schemaVersion must be "${V2_PLANNER_RESPONSE_SCHEMA_VERSION}"`);
  if (!['program', 'exhausted'].includes(response.kind)) issues.push('kind must be program|exhausted');
  if (!substantive(response.summary)) issues.push('summary must be a substantive string');
  let program = null;
  if (response.kind === 'program') {
    if (response.reason !== undefined) issues.push('reason is allowed only for kind=exhausted');
    if (!plain(response.program)) issues.push('program must be an object for kind=program');
    else try {
      program = validateActionProgram(response.program, runtimeFromState(state));
      if (!isProgramWorkflow(state) && boundary === 'initial' && requiredScoutUnits.length) {
        const workIds = new Set(program.actions
          .filter((action) => action.evidenceFor.length === 0)
          .map((action) => action.id));
        const missing = requiredScoutUnits.filter((unit) => !workIds.has(unit));
        if (missing.length) issues.push(`program is missing exact scout work actions: ${missing.join(', ')}`);
      }
    }
    catch (error) { issues.push(...(Array.isArray(error?.issues) ? error.issues : [error.message])); }
  }
  if (response.kind === 'exhausted') {
    if (boundary !== 'gaps') issues.push('kind=exhausted is allowed only at a real gap boundary');
    if (response.program !== undefined) issues.push('program is not allowed for kind=exhausted');
    if (!substantive(response.reason)) issues.push('reason must be a substantive string for kind=exhausted');
  }
  if (issues.length) throw new V2PlannerValidationError(issues);
  return response.kind === 'program'
    ? { schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION, kind: 'program', summary: response.summary.trim(), program }
    : { schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION, kind: 'exhausted', summary: response.summary.trim(), reason: response.reason.trim() };
}

export function parseV2PlannerResponse(text, state, options = {}) {
  const source = String(text ?? '').trim();
  const ends = source.endsWith('```') ? source.slice(0, -3).trimEnd() : source;
  const starts = [];
  for (let index = 0; index < ends.length; index += 1) if (ends[index] === '{') starts.push(index);
  const errors = [];
  for (const start of starts) {
    try {
      const candidate = JSON.parse(ends.slice(start));
      return validateV2PlannerResponse(candidate, state, options);
    } catch (error) {
      if (Array.isArray(error?.issues)) errors.push(...error.issues);
      else errors.push(error.message);
    }
  }
  throw new V2PlannerValidationError(errors.length ? [...new Set(errors)] : ['response did not contain a trailing JSON object']);
}

export function readPlannerCandidate(candidatePath, state, options = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath) {
    return { ok: false, errors: ['candidatePath must be a non-empty string'] };
  }
  try {
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
    return { ok: true, errors: [], value: validateV2PlannerResponse(candidate, state, options) };
  } catch (error) {
    return {
      ok: false,
      errors: error instanceof V2PlannerValidationError
        ? [...error.issues]
        : [`validated planner candidate unavailable: ${error.message}`],
    };
  }
}

export function createV2PlannerContext(state, { scout = null, steering = [], correction = null, boundary = null } = {}) {
  validateV2DurableState(state);
  const plannerBoundary = boundary ?? (state.program.actions.length ? 'gaps' : 'initial');
  const actionStates = new Map(state.actions.map((action) => [action.id, action]));
  return {
    schemaVersion: 'bullswarm.workflow.planner-context.v2',
    boundary: plannerBoundary,
    intent: clone(state.intent),
    targets: {
      advisoryOnly: true,
      actions: Number(state.config.settings.maxActions ?? 100),
      actionsUsed: state.program.actions.length,
      actionsRemaining: Number(state.config.settings.maxActions ?? 100) - state.program.actions.length,
      agents: Number(state.config.settings.maxAgents ?? 30),
      agentsUsed: Number(state.budget.agents ?? 0),
      agentsRemaining: Number(state.config.settings.maxAgents ?? 30) - Number(state.budget.agents ?? 0),
      expansionRounds: Number(state.config.settings.maxExpansionRounds ?? 2),
      expansionRoundsUsed: Number(state.budget.expansions ?? 0),
      expansionRoundsRemaining: Number(state.config.settings.maxExpansionRounds ?? 2) - Number(state.budget.expansions ?? 0),
    },
    execution: {
      concurrency: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 1,
      mode: state.config.settings.executionMode ?? 'verified',
      workspaceMode: state.config.settings.workspaceMode ?? 'shared',
    },
    knownActions: state.program.actions.map((action) => ({
      id: action.id, purpose: action.purpose, dependsOn: clone(action.dependsOn),
      affects: clone(action.affects), evidenceFor: clone(action.evidenceFor),
      ownedFiles: clone(action.ownedFiles), produces: clone(action.produces ?? []),
      status: actionStates.get(action.id)?.status ?? 'pending',
    })),
    freshPassedRequirements: Object.values(state.ledger.requirements).filter((requirement) => requirement.status === 'passed').map((requirement) => requirement.id),
    gaps: plannerBoundary === 'gaps' ? consolidateV2Gaps(state) : null,
    scout: scout == null ? null : String(scout),
    scoutUnits: extractScoutUnitIds(scout),
    steering: Array.isArray(steering) ? steering.map(String) : [],
    correction: correction == null ? null : clone(correction),
  };
}

// One source of truth for the planning contract. The dispatched planner
// prompt, the caller-facing `workflow plan contract`, and every durable
// planner request render these same lines, so an external planner (a frontier
// agent driving Bullswarm directly) and a dispatched planner obey one rulebook.
export function v2PlannerContractRules({ workspaceMutation = 'allowed', boundary = 'initial', plannerMode = 'dispatched', executionMode = 'verified', workspaceMode = 'shared' } = {}) {
  if (!['dispatched', 'caller'].includes(plannerMode)) throw new TypeError('plannerMode must be dispatched or caller');
  if (executionMode === 'program') return [
    'Author the complete bounded dependency graph once. The kernel runs it to the end and returns every action result. It does not request automatic gap rounds or require evidence actions to finish.',
    'dependsOn expresses the ordering you need. Independent actions start up to the concurrency cap, and a dependent starts as soon as its own inputs are ready. A failed action skips its dependents; other branches continue. Never create artificial dependencies merely to group phases.',
    'Every action has a self-contained prompt describing its purpose, repository context, expected files, and concrete acceptance commands. Dependency output artifacts are passed to the worker; ask it to read them, including outstanding requests for shared-file changes.',
    'Plan coherent acceptance slices: keep behavior and its focused tests together. Cover each requested outcome. Scout units and numeric targets are advisory, not reasons for rejecting an otherwise useful program.',
    'Use analyze for read-only investigation or evidence, build for contextual implementation, and chore with low effort for deterministic mechanical edits. Medium is the default for ordinary analysis and implementation. Reserve high for architecture, ambiguous tradeoffs, or cross-cutting integration judgment.',
    workspaceMode === 'isolated'
      ? 'This run explicitly requests isolation. Mutating actions need exact ownedFiles; only declared changes are integrated. Order overlapping writers. Evidence actions inspect the integrated target workspace.'
      : 'All agents share the target worktree. ownedFiles lists intended territory and provides overlap scheduling hints; it is not an exact-file enforcement gate. Overlapping territories are serialized automatically. An analyze action is read-only. A build/chore action with empty ownedFiles is an unrestricted integrator and runs alone.',
    'Build shared contracts first, then fan out independent territories. Tell workers that others share the tree, to preserve sibling edits, avoid whole-repository formatting and git resets, and report cross-territory requests instead of making conflicting edits. Never commit unless the user explicitly requires a commit.',
    'After a parallel implementation wave, include one integrator depending on all writers. It reads their outputs, applies cross-territory requests, reconciles shared files, and runs the repository acceptance commands. In a shared workspace, use build with empty ownedFiles to let that sole integrator fix any file.',
    'Judge acceptance with observable behavior and the repository checks. Reproduce regressions where applicable, run focused tests after changes, then the requested full gates on the integrated tree. Preserve every acceptance qualifier; do not accept vacuous tests or a green unrelated suite as proof.',
    'Evidence actions are optional. To request structured independent judgment, use analyze with evidenceFor and empty affects/ownedFiles. They must depend on all work affecting their requirements. Their prompt specifies checks only; the kernel supplies the evidence JSON contract. Negative evidence is reported and never silently converted to verified success.',
    'The result status describes graph execution; verified separately records passing requirement evidence. Read per-action failures, outputs, and evidence before claiming the product is ready. Repairs or further investigation belong in an explicitly authored follow-up program.',
    workspaceMutation === 'forbidden'
      ? 'This goal is read-only: every action must use analyze with empty ownedFiles. Put reports in the captured final response.'
      : 'Mutations are allowed within the task purpose. Preserve user changes and follow the shared-territory or explicit isolation rules above.',
    boundary === 'steering'
      ? 'The user has queued steering. Preserve completed history and append only the actions needed to honor it.'
      : 'Return a program response containing the entire graph. Do not invent provider, model, timeout, phase, repair, or retry fields.',
  ];
  return [
    'Propose the smallest complete bounded action program that can satisfy the supplied requirements. The kernel, not you, decides completion and failure.',
    'The numeric values in context.targets are advisory planning targets, never execution ceilings. Prefer to stay within them by consolidating optional work, but exceed them whenever the smallest essential program needs more actions, agent dispatches, or gap rounds. Reaching or crossing a target is not a reason to return exhausted.',
    'context.execution.concurrency limits only how many dependency-ready actions run at once. It does not limit the total number of independent actions in the program; the scheduler will batch wider programs safely.',
    'Use only generic actions. A work action declares affects and any exact ownedFiles. affects means the action directly owns and delivers a bounded acceptance slice of that requirement; merely editing a supporting test or sharing a file does not make an action affect every requirement associated with that file. An evidence action declares evidenceFor, has empty affects/ownedFiles, and independently inspects the work it judges.',
    'Choose lane from the action itself, not from the overall goal: analyze is read-only investigation, judgment, or evidence; build changes behavior, documentation, or tests and requires contextual implementation; chore is only deterministic mechanical mutation with no design choice. Evidence actions must use analyze. Analyze actions cannot own files. Chore actions must use low effort.',
    'Choose effort independently from lane, using the cheapest tier sufficient for this one action. Low is for fixed-procedure checks or mechanical edits whose success is objectively decidable. Medium is the default for normal bounded analysis or implementation with local decisions. High is exceptional: use it only when architecture, ambiguous tradeoffs, cross-cutting integration, or adversarial acceptance judgment materially determines correctness. If uncertain, choose medium.',
    'Do not choose high merely because an action uses analyze, supplies evidence, affects an important requirement, mentions many files, or belongs to a difficult overall goal. Do not choose low merely because an action is short. Examples: exact file comparison or formatting update = low; ordinary scoped feature plus focused test = medium; choosing an architecture across subsystems = high; running deterministic acceptance commands = low; interpreting ambiguous cross-cutting acceptance evidence = high.',
    'Dependencies represent required data or exact-file ordering only. Do not serialize unrelated work. Do not add reviewer, verify, repair, phase, completion, pool, model, timeout, or retry fields.',
    'Every mandatory unresolved requirement needs an evidence action. Parallel actions must be both file-disjoint and acceptance-independent. Isolated parallel siblings cannot see each other\'s unintegrated changes. If one action writes tests for behavior introduced by another action, combine code and tests under one owner or make the test action depend on and consume an artifact from the implementation action; never run new behavioral tests against the unchanged baseline in parallel. Prompts must be self-contained and include exact scope plus acceptance evidence.',
    'For mutating behavioral work, keep implementation and its focused regression test under one coherent owner. The action must prove the regression on the untouched baseline, then exercise the real production entry point or state transition after the change; disconnected helpers, no-op assertions, and test-only behavior do not satisfy acceptance.',
    'For interactive or state-machine work, action prompts must require a transition matrix for every affected level and input, using distinguishable before/after fixtures and assertions on the resulting live state or selected item. An output assertion that only finds text already present before the input is vacuous and must not be proposed as acceptance evidence.',
    'For Node focused tests, action prompts must require `node --test-timeout=60000 --test <focused files>` and forbid raw `node --test` plus `--test-force-exit`. This bounds a broken test subprocess without imposing a wall-clock limit on a healthy long-running agent.',
    'When a focused test baseline is known, action prompts must treat execution beyond 60 seconds or twice that baseline (whichever is greater) without progress as an open-handle or unresolved-async defect to interrupt and diagnose, never as an unbounded wait.',
    'Bound actions by coherent acceptance slices, not merely by shared files. When a goal has several independently testable cross-cutting behaviors in the same files, prefer a small ordered sequence whose actions reuse those exact ownedFiles and each deliver one behavior plus its focused regression. Do not collapse an entire multi-requirement feature into one monolithic worker just because its files overlap, and do not split one behavior from its own test.',
    'Treat the scout\'s independently testable units as the default action boundaries. A single long requirement may be affected by several ordered actions, each closing one observable clause; multiple actions may therefore list the same requirement in affects. Do not merge scout units merely because they share a requirement ID or owned files. Merge only when the combined change is genuinely trivial for one bounded worker.',
    plannerMode === 'caller'
      ? 'context.scoutUnits (present only when a kernel scout ran) lists the scout\'s independently testable units as advisory default action boundaries. A caller planner is not required to reuse those IDs and the response is never rejected for a missing unit; still cover every clause a unit names with some action, or leave it explicitly to a later program revision.'
      : 'Every exact ID in context.scoutUnits is a kernel-required work action. Use each ID unchanged on one non-evidence action and order shared-file units with dependencies. Do not rename, omit, or absorb one scout unit into another action; the response is rejected before dispatch if any unit is missing.',
    'Goal requirements outrank the current implementation, current tests, and descriptive scout prose. Preserve exact universal and negative qualifiers such as every, always, any depth, same, narrow/mobile, must not, and fallback behavior in the responsible action prompts. If an existing test asserts contradictory behavior, the action must own and update both production code and that test; never instruct a worker to preserve the contradiction.',
    'A requirement may contain several sibling clauses assigned to different actions. List it in affects only when the action prompt names the exact clause it owns. Requirement context never expands ownedFiles: if another clause requires an unowned file or a different purpose, leave it to its own scout unit instead of asking this action to satisfy it.',
    'When several ordered work actions jointly affect one cross-cutting behavior, the scout\'s final acceptance unit must remain a mutation-capable action after those slices. Give it the relevant production files plus tests, require it to exercise every decisive qualifier over the integrated result, and authorize it to close any gap it finds. Do not turn that unit into tests-only regression work.',
    'For evidence actions, the prompt describes only what to inspect and which concrete checks to run. Never prescribe a response JSON, object, schema, envelope, format, or fields such as ok/concerns/summary; the V2 kernel exclusively supplies and validates the evidence output contract.',
    workspaceMutation === 'forbidden'
      ? 'This goal is deterministically read-only. Every action must have empty ownedFiles and must not modify workspace files; reports belong in the action output artifact.'
      : 'Workspace mutation is allowed only through exact ownedFiles declared by the action.',
    boundary === 'gaps'
      ? 'This is one consolidated gap boundary. Propose only new actions that close the supplied gaps. If no useful bounded action remains, return kind=exhausted with a concrete reason; this does not declare workflow failure.'
      : boundary === 'steering'
        ? 'This is a material user-steering boundary. Treat the supplied steering as new requirements for future work, preserve completed history, and propose only the smallest new actions needed to honor it.'
        : 'This is initial planning. Return kind=program with the complete useful program; kind=exhausted is invalid here.',
  ];
}

export const V2_PLANNER_RESPONSE_SHAPE = Object.freeze({
  program: '{schemaVersion:"bullswarm.workflow.planner-response.v2",kind:"program",summary,program:{schemaVersion:"bullswarm.workflow.program.v2",actions:[...]}}',
  exhausted: '{schemaVersion:"bullswarm.workflow.planner-response.v2",kind:"exhausted",summary,reason}',
});

export const V2_PROGRAM_ACTION_FIELDS = Object.freeze({
  id: 'unique lowercase kebab-case ID',
  purpose: 'one-line human purpose',
  dependsOn: 'action IDs whose data or exact-file ordering this action requires (empty array when independent)',
  affects: 'requirement IDs this work action directly owns a bounded acceptance slice of (empty for evidence actions)',
  ownedFiles: 'exact relative paths this action may mutate (empty for read-only or evidence actions)',
  prompt: 'self-contained worker instructions: exact scope, files, commands, and acceptance evidence',
  lane: 'analyze | build | chore',
  effort: 'high | medium | low',
  evidenceFor: 'requirement IDs this evidence action independently judges (empty for work actions)',
  inputs: 'optional artifact IDs consumed, each produced by a dependency ancestor',
  produces: 'optional artifact IDs this action produces for later actions',
});

function programActionFields(stateOrGoal) {
  return {
    ...V2_PROGRAM_ACTION_FIELDS,
    ...(isProgramWorkflow(stateOrGoal) ? {
      dependsOn: 'action IDs that must succeed before this action starts',
      ownedFiles: stateOrGoal.config.settings.workspaceMode === 'isolated'
        ? 'exact relative files a build/chore action may mutate; a non-empty list is required for isolated writers'
        : 'intended relative file territories; empty for analyze or for an unrestricted shared build/chore integrator',
    } : {}),
  };
}

export const V2_PROGRAM_EXAMPLE = Object.freeze({
  schemaVersion: 'bullswarm.workflow.planner-response.v2',
  kind: 'program',
  summary: 'Fix the parser, then independently inspect the fix.',
  program: {
    schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
    actions: [
      {
        id: 'fix-parser', purpose: 'Fix the parser defect with a focused regression test',
        dependsOn: [], affects: ['requirement-1'], ownedFiles: ['src/parser.js', 'tests/parser.test.js'],
        prompt: 'In <cwd>, fix the trailing-comma defect in src/parser.js. Add a focused regression in tests/parser.test.js that fails on the untouched baseline and passes after the fix. Run `node --test-timeout=60000 --test tests/parser.test.js`.',
        lane: 'build', effort: 'medium', evidenceFor: [], inputs: [], produces: ['parser-fix'],
      },
      {
        id: 'check-parser', purpose: 'Independently judge the parser requirement',
        dependsOn: ['fix-parser'], affects: [], ownedFiles: [],
        prompt: 'Inspect src/parser.js and tests/parser.test.js in <cwd>; run `node --test-timeout=60000 --test tests/parser.test.js` and confirm the regression exercises the production entry point.',
        lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['parser-fix'], produces: [],
      },
    ],
  },
});

export function buildV2PlannerPrompt(context) {
  if (!plain(context) || context.schemaVersion !== 'bullswarm.workflow.planner-context.v2') throw new TypeError('invalid V2 planner context');
  return [
    'You are the single logical Workflow Planner for Bullswarm autonomous V2.',
    ...v2PlannerContractRules({
      executionMode: context.execution?.mode,
      workspaceMode: context.execution?.workspaceMode,
      workspaceMutation: context.intent.constraints?.workspaceMutation ?? 'allowed',
      boundary: context.boundary,
    }),
    'Return only one JSON object with schemaVersion bullswarm.workflow.planner-response.v2.',
    `For kind=program use: ${V2_PLANNER_RESPONSE_SHAPE.program}.`,
    ...(context.execution?.mode === 'program' ? [] : [`For an exhausted gap boundary use: ${V2_PLANNER_RESPONSE_SHAPE.exhausted}.`]),
    '',
    JSON.stringify(context),
  ].join('\n');
}

export const V2_PLANNER_REQUEST_SCHEMA_VERSION = 'bullswarm.workflow.planner-request.v2';
export const V2_PLANNER_CONTRACT_SCHEMA_VERSION = 'bullswarm.workflow.planner-contract.v2';

// The caller-facing planning contract for a goal that has not started yet.
// A frontier agent reads this once, authors the initial program itself, and
// launches `workflow goal --program <file>`; no scout or planner dispatch is
// spent on work the caller already has in context.
export function buildV2PlannerContract(goalDocument, { launchCommand = null } = {}) {
  validateV2GoalDocument(goalDocument);
  const workspaceMutation = goalDocument.intent.constraints?.workspaceMutation ?? 'allowed';
  return {
    schemaVersion: V2_PLANNER_CONTRACT_SCHEMA_VERSION,
    goal: goalDocument.intent.goal,
    cwd: goalDocument.intent.cwd,
    intentId: goalDocument.intentId,
    requirements: clone(goalDocument.intent.requirements),
    constraints: { workspaceMutation },
    settings: clone(goalDocument.config.settings),
    rules: v2PlannerContractRules({ workspaceMutation, boundary: 'initial', plannerMode: 'caller', executionMode: goalDocument.config.settings.executionMode, workspaceMode: goalDocument.config.settings.workspaceMode }),
    program: {
      schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
      actionFields: programActionFields(goalDocument),
      validation: isProgramWorkflow(goalDocument) ? [
        'IDs are kebab-case and unique; every dependency exists and the graph has no cycles',
        'ownedFiles are scheduling territories; overlapping writers serialize, and an unrestricted shared integrator runs alone',
        'evidence actions are optional and depend on all work affecting the requirements they judge',
        'declared input artifacts come from dependency ancestors; plain dependencies do not require an artifact declaration',
        'kernel-owned routing chooses pools and models from lane and effort',
      ] : [
        'every requirement listed above that is mandatory needs at least one evidence action whose evidenceFor names it',
        'evidence actions must depend (transitively) on every work action that affects the requirement they judge',
        'two work actions with overlapping ownedFiles must be transitively ordered by dependsOn',
        'a work dependency must be justified by a consumed artifact or an overlapping owned path',
        'IDs are kebab-case and unique; no cycles; no pool, model, verify, repair, phase, fanout, or timeout fields',
        'kernel-owned routing chooses pools and models from lane and effort; the program never names providers',
      ],
      responseShape: V2_PLANNER_RESPONSE_SHAPE.program,
      bareProgramAccepted: 'a file containing only {schemaVersion:"bullswarm.workflow.program.v2",actions:[...]} is wrapped automatically; use --summary to name it',
      example: clone(V2_PROGRAM_EXAMPLE),
    },
    evidence: {
      note: 'Evidence agents receive a kernel-owned output contract; the program prompt only describes what to inspect. The requirement ledger, completion, and the stable result envelope are computed by the kernel.',
      resultSchema: 'bullswarm.workflow.result.v2',
    },
    plannerMode: 'caller',
    launch: launchCommand ? { command: launchCommand } : null,
  };
}

// The durable request a paused run leaves for its caller planner. It carries
// the exact context a dispatched planner would have received, the rules, and
// the precise submit step, so any agent can resume the run from a cold start.
export function createV2PlannerRequest(state, context, { turn, requestPath, candidatePath, correction = null, submitCommand = null, pendingSteering = [] } = {}) {
  if (!plain(context) || context.schemaVersion !== 'bullswarm.workflow.planner-context.v2') throw new TypeError('invalid V2 planner context');
  if (!Number.isInteger(turn) || turn < 1) throw new TypeError('turn must be a positive integer');
  if (!Array.isArray(pendingSteering)) throw new TypeError('pendingSteering must be an array');
  return {
    schemaVersion: V2_PLANNER_REQUEST_SCHEMA_VERSION,
    runId: state.runId,
    shortId: state.shortId,
    intentId: state.intentId,
    turn,
    boundary: context.boundary,
    plannerMode: 'caller',
    rules: v2PlannerContractRules({
      executionMode: context.execution?.mode,
      workspaceMode: context.execution?.workspaceMode,
      workspaceMutation: context.intent.constraints?.workspaceMutation ?? 'allowed',
      boundary: context.boundary,
      plannerMode: 'caller',
    }),
    responseShape: isProgramWorkflow(state) ? { program: V2_PLANNER_RESPONSE_SHAPE.program } : { ...V2_PLANNER_RESPONSE_SHAPE },
    actionFields: programActionFields(state),
    scoutUnitsAdvisory: true,
    context,
    // Steering queued for this run that no planner turn has consumed yet.
    // Submitting against this request marks exactly these entries delivered.
    pendingSteering: clone(pendingSteering),
    correction: correction ? clone(correction) : null,
    candidatePath,
    requestPath,
    submit: submitCommand ? { command: submitCommand } : null,
  };
}

// Accept a caller-authored planner response in either the full planner
// response envelope or as a bare program document.
export function normalizeCallerPlannerResponse(input, { summary = null, exhaustedReason = null } = {}) {
  if (!plain(input)) throw new V2PlannerValidationError(['planner response must be a JSON object']);
  if (input.schemaVersion === V2_PLANNER_RESPONSE_SCHEMA_VERSION) {
    if (substantive(summary) && !substantive(input.summary)) return { ...clone(input), summary: summary.trim() };
    return clone(input);
  }
  if (input.schemaVersion === ACTION_PROGRAM_SCHEMA_VERSION) {
    const actions = Array.isArray(input.actions) ? input.actions : [];
    const derived = actions.map((action) => action?.purpose).filter(substantive).slice(0, 3).join('; ');
    return {
      schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION,
      kind: 'program',
      summary: substantive(summary) ? summary.trim() : (derived || `Caller-authored program with ${actions.length} action(s)`),
      program: clone(input),
    };
  }
  if (input.kind === 'exhausted' || substantive(exhaustedReason)) {
    return {
      schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION,
      kind: 'exhausted',
      summary: substantive(summary) ? summary.trim() : (substantive(input.summary) ? input.summary.trim() : 'Caller planner reported no further useful bounded action.'),
      reason: substantive(exhaustedReason) ? exhaustedReason.trim() : input.reason,
    };
  }
  throw new V2PlannerValidationError([
    `planner response schemaVersion must be "${V2_PLANNER_RESPONSE_SCHEMA_VERSION}" or a bare "${ACTION_PROGRAM_SCHEMA_VERSION}" program`,
  ]);
}

export function applyV2PlannerResponse(state, response, options = {}) {
  const accepted = validateV2PlannerResponse(response, state, options);
  const next = clone(state);
  next.planner.turns += 1;
  next.planner.lastDecision = { kind: accepted.kind, summary: accepted.summary, ...(accepted.kind === 'exhausted' ? { reason: accepted.reason } : {}) };
  if (accepted.kind === 'exhausted') {
    next.planner.status = 'completed';
    return next;
  }
  next.planner.status = 'waiting';
  const revision = next.program.revision + 1;
  next.program = {
    schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
    revision,
    actions: [...next.program.actions, ...accepted.program.actions],
  };
  next.presentation.stages.push(...(isProgramWorkflow(next) ? deriveV2DependencyStages : deriveV2PresentationStages)(accepted.program.actions, revision));
  for (const action of accepted.program.actions) next.actions.push({
    id: action.id, status: 'pending', attempts: 0, programRevision: revision,
    workRevision: next.ledger.workRevision, startedAt: null, finishedAt: null,
    outputFile: null, artifactIds: [], lastFailure: null,
  });
  next.lifecycle.status = 'running';
  return next;
}

export function plannerCorrectionRequest(error, { attempt, maxCorrections = 1 } = {}) {
  if (!(error instanceof V2PlannerValidationError)) throw new TypeError('planner correction requires V2PlannerValidationError');
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(maxCorrections) || maxCorrections < 0) throw new TypeError('invalid planner correction bounds');
  return {
    allowed: attempt <= maxCorrections,
    attempt,
    maxCorrections,
    issues: [...error.issues],
    instruction: attempt <= maxCorrections
      ? 'Return one corrected full V2 planner response. Do not discuss the errors.'
      : 'Planner correction allowance exhausted; do not dispatch workers.',
  };
}

export function buildPlannerPreflight(statePath, boundary = 'initial', candidatePath, checkerPath = null) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath must be a non-empty string');
  if (!['initial', 'gaps', 'steering'].includes(boundary)) throw new TypeError('boundary must be initial|gaps|steering');
  if (typeof candidatePath !== 'string' || !candidatePath) throw new TypeError('candidatePath must be a non-empty string');
  const checker = checkerPath ?? fileURLToPath(new URL('../../bin/check-v2-plan.js', import.meta.url));
  const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(checker)} --state ${shellQuote(statePath)} --boundary ${boundary} --value ${shellQuote(candidatePath)}`;
  return [
    'MANDATORY V2 PLANNER DELIVERY before replying:',
    `1. Write only your complete planner response JSON to this exact durable path: ${shellQuote(candidatePath)}`,
    `2. Run: ${command}`,
    '3. If it exits non-zero, fix the candidate and rerun until it exits zero.',
    '4. Leave the validated candidate file in place. Bullswarm reads that exact file; do not copy, reproduce, or retype the JSON in your response.',
    '5. End your response with only a short confirmation that the durable planner candidate validated.',
  ].join('\n');
}

export const validatePlannerResponse = validateV2PlannerResponse;
