// `bullswarm workflow plan`: contract and validate. The verbs 0.38.0 removed
// (show, submit, export, revise) answer with one sentence.

import { existsSync, statSync } from 'node:fs';
import { programAdvisories } from './action-validator.js';
import { programV3Facts, stepV3Facts, v3IssueWording } from './program-v3.js';
import { controlSummaryLines, programControl } from './gates-loops.js';
import { routeSummary } from './step-route.js';
import { V2PlannerValidationError, workspacePathIssues } from './v2-planner.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { buildV3Contract } from './contract-v3.js';
import { parseFlags, flagErrors, removedFlagExit } from './workflow-flags.js';
import { drivableRunRefusal } from './cli-run-lookup.js';
import {
  modelPoolIssues, pinnedPoolIssues, programNamesModel, programRoutes, routePoolIssues, livePoolNames,
} from './cli-pool-checks.js';
import { buildNewGoalDocument } from './cli-goal-document.js';
import {
  goalNextCommands, refuseProgramInvalid, loadCallerProgram, previewValidateInitialProgram, printAdvisories,
  ProgramV2RefusedError, refuseProgramV2,
} from './cli-program-checks.js';

// Flags that only make sense on a launch have no meaning for the read-only
// planning commands.
function contractFlagError(opts, { allowProgram = false } = {}) {
  if (opts.planner !== undefined) return '--planner was removed; the planning commands always describe caller-planner mode';
  if (!allowProgram && opts.program !== undefined) return 'this command takes the goal text only; pass --program to workflow plan validate or workflow goal';
  if (opts.resume !== undefined || opts.request !== undefined) return '--resume and --request do not apply to the planning commands';
  return null;
}

// --- workflow plan: the caller-as-planner surface -----------------------------
// `contract` renders the v3 program format before any run exists; `validate`
// checks a program against it without launching.

// D8: the verbs 0.38.0 removed answer with exit 2 and one sentence naming what
// replaced them, for one release, because a saved run's hints still name them.
// On a run an earlier Bullswarm started, the sentence is the view-only one.
const ADD_STEPS = 'append steps with bullswarm workflow add <runId> --steps <file.json>';
const NO_WAITING = `runs no longer wait for a caller program; ${ADD_STEPS}`;
const NO_EDITING = `a v3 run's steps are never edited; ${ADD_STEPS}, or run one again with bullswarm workflow step rerun <runId> <step>`;
const REMOVED_VERBS = Object.freeze({ show: NO_WAITING, submit: NO_WAITING, export: NO_EDITING, revise: NO_EDITING });

function removedPlanVerb(sub, opts) {
  if (opts.help) { console.log(helpText(['workflow', 'plan', sub])); return 0; }
  const token = opts.rest[0];
  if (token) {
    const viewOnly = drivableRunRefusal(token, opts, `plan ${sub}`);
    if (viewOnly !== null) return viewOnly;
  }
  const message = `plan ${sub} was removed in 0.38.0: ${REMOVED_VERBS[sub]}`;
  if (opts.json) console.log(JSON.stringify({ error: 'removed', verb: `plan ${sub}`, message }, null, 2));
  else console.error(`✗ ${message}`);
  return 2;
}

export async function wfPlan(rest) {
  const [head, ...tail] = rest;
  const sub = flagName(head) ? undefined : head;
  const opts = parseFlags(sub === undefined ? rest : tail);
  if (Object.hasOwn(REMOVED_VERBS, sub ?? '')) return removedPlanVerb(sub, opts);
  const subs = ['contract', 'validate'];
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
    const removed = removedFlagExit(opts);
    if (removed !== null) return removed;
    const flagExit = flagErrors(opts, ['workflow', 'plan', sub]);
    if (flagExit !== null) return flagExit;
  }
  switch (sub) {
    case 'contract': return planContract(opts);
    case 'validate': return planValidate(opts);
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
  try { doc = buildNewGoalDocument(goal, opts); }
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
  const built = planningGoalDocument(bare ? { ...opts, rest: [PLACEHOLDER_GOAL] } : opts, ['workflow', 'plan', 'contract']);
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  const next = goalNextCommands(goal, doc.intent.cwd, opts);
  const contract = buildV3Contract({ goal: bare ? null : goal, cwd: doc.intent.cwd, next, workerReasoning: doc.config.workerRouting?.reasoning ?? null });
  console.log(JSON.stringify(contract, null, 2));
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
  const built = planningGoalDocument(opts, ['workflow', 'plan', 'validate'], { allowProgram: true });
  if (built.exit !== undefined) return built.exit;
  const { goal, doc } = built;
  let accepted;
  try { if (loadError) throw loadError; accepted = previewValidateInitialProgram(doc, response); }
  catch (err) {
    if (err instanceof ProgramV2RefusedError) return refuseProgramV2(opts);
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
    advisories: programAdvisories(accepted.program, { requirements: null })
      .map((item) => ({ ...item, message: v3IssueWording(item.message) })),
    next: { launch: next.launch },
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    const control = programControl(accepted.program);
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    console.log(`✓ program v3 valid: ${count(payload.program.actions.length, 'step')}, ${count(control.gates.length, 'gate')}, ${count(control.loops.length, 'loop')} (nothing launched)`);
    for (const action of payload.program.actions) console.log(`  ${action.id.padEnd(24)} ${action.lane}/${action.effort}${action.deliverable ? ` deliverable=${action.deliverable.type}${action.deliverable.paths?.length ? `:${action.deliverable.paths.join(',')}` : ''}` : ''}${action.evidence ? ` evidence=${action.evidence.map((item) => item.type).join(',')}` : ''}${action.reasoning ? ` reasoning=${action.reasoning}` : ''}${action.answer ? ' answer' : ''}${action.dependsOn.length ? ` after ${action.dependsOn.join(', ')}` : ''}${action.route ? ` route: ${routeSummary(action.route)}` : ''}`);
    for (const line of controlSummaryLines(control)) console.log(line);
    printAdvisories(payload.advisories, { stream: console.log });
    console.log(`  launch   ${next.launch}`);
  }
  return 0;
}
