// Goal-driven workflow bootstrap.
//
// Users provide intent, not a workflow graph. Bullswarm supplies the bounded
// orchestration contract and lets the selected planner expand the durable plan.

import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { projectOf } from '../lib/project.js';

export const GOAL_PROJECT_SCHEMA_VERSION = 'bullswarm.workflow.project.v1';

// Project identity is resolved once, at goal time, and kept beside the goal
// document. Resolving it later — at finish, or during `workflow reindex` —
// can answer differently or not at all: a branch worktree gets deleted, a
// remote gets renamed, a checkout moves. The run is stamped with what was
// true when it was launched.
//
// It is a sibling file rather than a field of goal.json because the V2 goal
// document is a closed, hashed schema (`intentId` is a digest of `intent`,
// and src/workflow/v2-state.js rejects any unknown key); adding a field there
// is a schema change in a file this territory does not own. See the report.
export function goalProjectPath(runDir) {
  return join(runDir, 'project.json');
}

/**
 * Record the project a run's working directory belongs to. Never throws: a
 * launch must not fail because git is missing or the record could not be
 * written.
 *
 * @returns {{schemaVersion: string, name: string|null, remote: string|null,
 *            toplevel: string|null, cwd: string, recordedAt: string}|null}
 */
export function recordGoalProject(runDir, cwd, { now = () => new Date().toISOString() } = {}) {
  try {
    const identity = projectOf(cwd);
    const document = {
      schemaVersion: GOAL_PROJECT_SCHEMA_VERSION,
      name: identity.name,
      remote: identity.remote,
      toplevel: identity.toplevel,
      cwd: typeof cwd === 'string' ? cwd : null,
      recordedAt: now(),
    };
    writeJsonAtomic(goalProjectPath(runDir), document);
    return document;
  } catch {
    return null;
  }
}

/** What a run recorded at goal time, or null when it recorded nothing. */
export function readGoalProject(runDir) {
  const document = readJsonSafe(goalProjectPath(runDir), null);
  if (!document || typeof document !== 'object') return null;
  if (document.schemaVersion !== GOAL_PROJECT_SCHEMA_VERSION) return null;
  return document;
}

export function extractScoutUnitIds(report) {
  const source = String(report ?? '').trim();
  for (let index = source.lastIndexOf('['); index >= 0; index = source.lastIndexOf('[', index - 1)) {
    try {
      const parsed = JSON.parse(source.slice(index));
      if (!Array.isArray(parsed) || !parsed.length) continue;
      const units = parsed.map((unit) => String(unit).trim());
      if (units.some((unit) => !/^[a-z0-9][a-z0-9-]*$/.test(unit))) continue;
      if (new Set(units).size !== units.length) continue;
      return units;
    } catch { /* try an earlier trailing array opener */ }
  }
  return [];
}

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
    'UNITS OF WORK: one bullet per coherent, independently observable acceptance slice the goal implies (behavior, transition, module, finding, page). If one numbered requirement contains several independently testable clauses or state transitions, split those clauses into separate ordered slices even though they share one requirement and the same files; avoid an umbrella unit named after the whole requirement. For each: quote the decisive acceptance qualifiers it owns (especially every, always, any depth, same, narrow/mobile, negative constraints, and fallback behavior), name the exact production and test files it may need to change, the exact focused command that proves it is done, anything already present, and semantic dependencies. Existing implementation or tests that contradict the goal are migration work, not acceptance authority: state the conflict explicitly and assign a mutation-capable owner that can change both production behavior and its tests. Explicitly identify tests that specify behavior introduced by another unit: each focused regression belongs with that behavior implementation, while later cross-cutting acceptance may depend on the integrated earlier slices.',
    'When a requirement spans several ordered slices, add one final cross-cutting acceptance slice after them. That slice must own the relevant production files as well as tests, must exercise every decisive qualifier across the integrated result, and must be authorized to close discovered behavior gaps. A tests-only regression slice is not a valid final owner for cross-cutting behavior.',
    'SHARED FILES: files that more than one slice would touch. Shared ownership forbids parallel mutation, but it does not require one monolithic action: if the slices are independently testable, recommend a small ordered sequence that reuses the same owned files and builds on the integrated prior slice.',
    'RISKS: anything that constrains the plan (files that must not change, flaky tests, missing tools, ambiguous requirements).',
    'Finally, END your output with a JSON array of the unit-of-work names in UNITS OF WORK, e.g. ["csv","duration"]. Nothing after the array.',
  ].join('\n');
}
