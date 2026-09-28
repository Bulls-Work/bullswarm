// A caller's program before anything runs, as `workflow goal` and `workflow
// plan` share it: reading the file, the kernel's own acceptance preview, the
// advisories and issues they print, and the next commands they suggest.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createV2DurableState } from './v2-state.js';
import { normalizeCallerPlannerResponse, validateV2PlannerResponse } from './v2-planner.js';

export function readJsonFile(path, label) {
  let raw;
  try { raw = readFileSync(resolve(path), 'utf8'); }
  catch (err) { throw new Error(`cannot read ${label} ${path}: ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`${label} ${path} is not valid JSON: ${err.message}`); }
}

export function shellArg(value) {
  if (/^[A-Za-z0-9_./\-]+$/.test(value)) return value;
  // Single-quote for the shell: a JSON string would re-escape newlines as a
  // literal backslash-n, which does not round-trip through double quotes.
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// A goal is inlined into the next-commands only when it stays readable on one
// line; otherwise the caller (who already holds the text) sees a placeholder,
// so the guidance does not bury the commands under the whole goal.
export function goalArg(goal) {
  const text = String(goal);
  return text.includes('\n') || text.length > 120 ? '"<goal>"' : shellArg(text);
}

// The commands a caller can run next when it has a goal but no accepted program.
export function goalNextCommands(goal, cwd, { isolation = false, program } = {}) {
  const q = goalArg(goal);
  const c = shellArg(cwd);
  const workspaceFlag = isolation === true ? ' --isolation' : '';
  // The program file the caller named, absolute so the line works from any folder.
  const p = typeof program === 'string' && program !== '-' && !program.startsWith('/dev/') ? shellArg(resolve(program)) : 'plan.json';
  return {
    contract: `bullswarm workflow plan contract ${q} --cwd ${c}${workspaceFlag} --json`,
    validate: `bullswarm workflow plan validate ${q} --program ${p} --cwd ${c}${workspaceFlag} --json`,
    launch: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --program ${p} --json`,
    scout: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --scout`,
    orchestrator: `bullswarm workflow goal ${q} --cwd ${c}${workspaceFlag} --orchestrator auto`,
  };
}

const GOAL_NEXT_PURPOSES = Object.freeze({
  contract: 'the program format the kernel enforces: fields, rules, an example that validates',
  validate: 'check plan.json against that contract without launching',
  launch: 'launch with your program; zero planner or scout dispatches',
  scout: 'kernel surveys the repository first, then pauses for your program',
  orchestrator: 'dispatch a Workflow Planner agent instead of planning yourself',
});

function printGoalNext(next, { only = null } = {}) {
  for (const [name, command] of Object.entries(next)) {
    if (only && !only.includes(name)) continue;
    console.error(`  ${name.padEnd(13)} ${command}`);
    console.error(`                ${GOAL_NEXT_PURPOSES[name]}`);
  }
}

export function refuseProgramRequired(goal, opts) {
  const doc = {
    error: 'program-required',
    message: 'workflow goal needs a program: you are the Workflow Planner',
    next: goalNextCommands(goal, resolve(opts.cwd ?? process.cwd()), opts),
  };
  if (opts.json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.error(`✗ ${doc.message}.`);
    printGoalNext(doc.next);
  }
  return 2;
}

export function refuseProgramInvalid(goal, opts, issues, { message = 'caller program invalid (nothing ran)' } = {}) {
  const next = goalNextCommands(goal, resolve(opts.cwd ?? process.cwd()), opts);
  const doc = { error: 'program-invalid', message, issues: [...issues], next: { contract: next.contract, validate: next.validate } };
  if (opts.json) console.log(JSON.stringify(doc, null, 2));
  else {
    printValidationIssues(message, issues);
    printGoalNext(next, { only: ['contract', 'validate'] });
  }
  return 2;
}

export function loadCallerProgram(opts) {
  if (!opts.program) return null;
  const raw = readJsonFile(opts.program, 'program file');
  return normalizeCallerPlannerResponse(raw, { summary: opts.summary ?? null });
}

// Validate a caller-authored initial program against a preview of the exact
// durable state the run will start with, so an invalid program is rejected
// synchronously and nothing is launched or dispatched.
export function previewValidateInitialProgram(doc, response) {
  const preview = createV2DurableState(doc, { runId: 'wf-preview-000000', shortId: 'previe' });
  // The callers run workspacePathIssues next to their pinned-pool check.
  return validateV2PlannerResponse(response, preview, { boundary: 'initial', requiredScoutUnits: [], workspacePaths: false });
}

// D35: a program that sets verifyRounds is told that it now counts fix cycles.
export const VERIFY_ROUNDS_NOTE = 'note: defaults.verifyRounds counts fix cycles since this version (1 = one fix and one re-review, 0 = review only); it counted review rounds before';

export function setsVerifyRounds(program) {
  return program?.verifyRounds !== undefined || program?.defaults?.verifyRounds !== undefined;
}

// Advisories are advice, never a rejection: they go to stderr so a --json
// caller keeps a clean stdout document, and the exit code is untouched.
export function printAdvisories(advisories, { stream = console.error } = {}) {
  for (const advisory of advisories) {
    stream(`advisory: ${advisory.code}${advisory.actionId ? ` ${advisory.actionId}` : ''} — ${advisory.message}`);
  }
}

export function printValidationIssues(prefix, issues) {
  console.error(`✗ ${prefix}:`);
  for (const issue of issues) console.error(`  - ${issue}`);
}
