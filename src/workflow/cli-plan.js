// `bullswarm workflow plan`: contract, validate, show, submit, export and
// revise.

import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REQUIREMENT_GRANULARITY_HINT } from './goal.js';
import { programAdvisories } from './action-validator.js';
import { isProgramV3, programV3Facts, stepV3Facts, v3IssueWording } from './program-v3.js';
import { controlSummaryLines, programControl } from './gates-loops.js';
import { deserializeV2DurableState, v2PlannerMode } from './v2-state.js';
import { reviseV2Program } from './run-control.js';
import { submitCallerPlannerResponse, callerPlannerSubmitCommand, readCallerPlannerRequest } from './caller-planner.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { routeSummary } from './step-route.js';
import {
  createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, REVISION_CHANGE_KINDS, V2RevisionError,
} from './v2-revision.js';
import { isProgramWorkflow } from './execution-policy.js';
import {
  buildV2PlannerContract, normalizeCallerPlannerResponse, V2PlannerValidationError, workspacePathIssues,
} from './v2-planner.js';
import { runWorkflowWatch } from './watch-cli.js';
import { peekSteering } from './steering.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { buildV3Contract } from './contract-v3.js';
import { parseFlags, flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal, loadV2RunState } from './cli-run-lookup.js';
import {
  modelPoolIssues, pinnedPoolIssues, programNamesModel, programRoutes, routePoolIssues, configuredPools, livePoolNames,
} from './cli-pool-checks.js';
import { executeGoalDocument, launchDetachedResume, printGoalLaunchInstructions } from './cli-launch.js';
import { buildNewGoalDocument } from './cli-goal-document.js';
import {
  readJsonFile, goalNextCommands, refuseProgramInvalid, loadCallerProgram, previewValidateInitialProgram,
  VERIFY_ROUNDS_NOTE, setsVerifyRounds, printAdvisories, printValidationIssues,
} from './cli-program-checks.js';

function cancellationSummary(cancellation) {
  if (!cancellation?.requested) return null;
  return { requested: true, requestedAt: cancellation.requestedAt ?? null, reason: cancellation.reason ?? null, source: cancellation.source ?? null };
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

// --- workflow plan: the caller-as-planner surface -----------------------------
// `contract` renders the exact planning contract for a goal before any run
// exists; `show` prints the durable request a paused run left for its caller;
// `submit` validates and applies a caller-authored program (or an exhausted
// decision) and relaunches the paused kernel.

export async function wfPlan(rest) {
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
function planningGoalDocument(opts, path, { allowProgram = false, programV3 = false } = {}) {
  const goal = opts.rest.join(' ').trim();
  if (!goal) { console.error(`usage: ${usageLine(path)}`); return { exit: 2 }; }
  const flagError = contractFlagError(opts, { allowProgram });
  if (flagError) { console.error(`✗ ${flagError}`); return { exit: 2 }; }
  let doc;
  try { doc = buildNewGoalDocument(goal, opts, { mode: 'caller', programSupplied: true, programV3 }); }
  catch (err) { console.error(`✗ invalid goal options: ${err.message}`); return { exit: 2 }; }
  if (!existsSync(doc.intent.cwd) || !statSync(doc.intent.cwd).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${doc.intent.cwd}`);
    return { exit: 1 };
  }
  return { goal, doc };
}

// The goal a bare `plan contract` describes: the v3 format does not depend on
// the goal, so the contract prints with goal null and '<goal>' in its commands.
const PLACEHOLDER_GOAL = '<goal>';

function planContract(opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', 'contract'])); return 0; }
  const bare = !opts.rest.join(' ').trim();
  // A v2 contract numbers requirements from the goal text, so it needs one.
  if (bare && opts.v2 === true) {
    console.error('✗ --v2 needs the goal: its requirement IDs come from the goal text');
    console.error(`usage: ${usageLine(['workflow', 'plan', 'contract'])}`);
    return 2;
  }
  const built = planningGoalDocument(bare ? { ...opts, rest: [PLACEHOLDER_GOAL] } : opts, ['workflow', 'plan', 'contract'], { programV3: opts.v2 !== true });
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  const next = goalNextCommands(goal, doc.intent.cwd, opts);
  // v3 by default (contract-v3.js); --v2 prints the contract of old programs.
  if (opts.v2 !== true) {
    const contract = buildV3Contract({ goal: bare ? null : goal, cwd: doc.intent.cwd, next, workerReasoning: doc.config.workerRouting?.reasoning ?? null });
    console.log(JSON.stringify(contract, null, 2));
    return 0;
  }
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
  // Read once: a program from /dev/stdin or a pipe cannot be read twice.
  let response = null, loadError = null;
  try { response = loadCallerProgram(opts); } catch (err) { loadError = err; }
  const programV3 = isProgramV3(response);
  const built = planningGoalDocument(opts, ['workflow', 'plan', 'validate'], { allowProgram: true, programV3 });
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  let accepted;
  try { if (loadError) throw loadError; accepted = previewValidateInitialProgram(doc, response); }
  catch (err) {
    if (err instanceof V2PlannerValidationError) return refuseProgramInvalid(goal, opts, err.issues, { message: 'program invalid against the contract (nothing launched)' });
    console.error(`✗ ${err.message}`);
    return 2;
  }
  // Everything a launch refuses, validate refuses too.
  const workspaceIssues = workspacePathIssues(accepted.program, doc.intent.cwd, { isolated: doc.config.settings.workspaceMode === 'isolated' });
  const routing = doc.config?.workerRouting ?? {};
  const pinned = Boolean(routing.strictPool ?? routing.pool);
  if (pinned || programRoutes(accepted.program.actions) || programNamesModel(accepted.program.actions, doc)) {
    const { pools } = await livePoolNames();
    if (pinned) workspaceIssues.push(...pinnedPoolIssues(doc, accepted.program, pools));
    workspaceIssues.push(...routePoolIssues(accepted.program.actions, pools, doc));
    workspaceIssues.push(...modelPoolIssues(accepted.program.actions, pools, doc));
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
        // A v3 program declares no kind or role; the stored role (act, for an
        // outward deliverable) is derived, and its deliverable already says it.
        ...(action.kind && !programV3 ? { kind: action.kind } : {}),
        ...(action.role && !programV3 ? { role: action.role } : {}),
        ...(action.deliverable ? { deliverable: action.deliverable } : {}),
        ...(action.evidence ? { evidence: action.evidence } : {}),
        lane: action.lane, effort: action.effort,
        ...(action.reasoning ? { reasoning: action.reasoning } : {}),
        ...(action.route ? { route: action.route } : {}),
        dependsOn: action.dependsOn,
        affects: action.affects, evidenceFor: action.evidenceFor, ownedFiles: action.ownedFiles,
        ...stepV3Facts(action),
      })),
      ...programV3Facts(accepted.program),
    },
    // Advice about the accepted program. Present (possibly empty) on every
    // valid program so a caller can read it without probing for the key.
    advisories: programAdvisories(accepted.program, { requirements: programV3 ? null : doc.intent.requirements })
      .map((item) => (programV3 ? { ...item, message: v3IssueWording(item.message) } : item)),
    ...(setsVerifyRounds(accepted.program) ? { verifyRoundsMeaning: 'fix cycles' } : {}),
    next: { launch: next.launch },
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    const control = programControl(accepted.program);
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    console.log(control
      ? `✓ program v3 valid: ${count(payload.program.actions.length, 'step')}, ${count(control.gates.length, 'gate')}, ${count(control.loops.length, 'loop')} (nothing launched)`
      : `✓ program valid against the contract: ${count(payload.program.actions.length, 'action')} for ${count(payload.requirements.length, 'requirement')} (nothing launched)`);
    for (const action of payload.program.actions) console.log(`  ${action.id.padEnd(24)} ${action.lane}/${action.effort}${action.kind ? ` kind=${action.kind}` : ''}${action.role ? ` role=${action.role}` : ''}${action.deliverable ? ` deliverable=${action.deliverable.type}${action.deliverable.paths?.length ? `:${action.deliverable.paths.join(',')}` : ''}` : ''}${action.evidence ? ` evidence=${action.evidence.map((item) => item.type).join(',')}` : ''}${action.reasoning ? ` reasoning=${action.reasoning}` : ''}${control ? `${action.answer ? ' answer' : ''}${action.dependsOn.length ? ` after ${action.dependsOn.join(', ')}` : ''}` : action.evidenceFor.length ? ` evidence for ${action.evidenceFor.join(', ')}` : ` affects ${action.affects.join(', ') || '(none)'}`}${action.route ? ` route: ${routeSummary(action.route)}` : ''}`);
    for (const line of controlSummaryLines(control)) console.log(line);
    printAdvisories(payload.advisories, { stream: console.log });
    if (payload.verifyRoundsMeaning) console.log(VERIFY_ROUNDS_NOTE);
    console.log(`  launch   ${next.launch}`);
  }
  return 0;
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
