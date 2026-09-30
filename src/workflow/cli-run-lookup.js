// Where the workflow verbs find things: the home (BULLSWARM_HOME, read on
// every call) and the run a token names, refusing a run no verb may drive
// before any verb drives it.

import { withV2Cancellation } from './v2-cancellation.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveRunId, isLegacyRunDir, isLegacyRunState, legacyRunLine } from './short-id.js';
import { isProgramV3Run, readRunFeatures } from './run-features.js';
import { legacyRollupRecord, readLegacyRunFacts } from './rollup.js';

// BULLSWARM_DIR is read on every call so that changes to the
// BULLSWARM_HOME env var (e.g. set per-test) are honored, not
// captured at module load. (The previous module-level IIFE form
// silently broke resume-by-shortId for any run whose BULLSWARM_HOME
// differed from the one in effect when the module was first
// imported.)
function bullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

export const BULLSWARM_DIR = bullswarmDir; // back-compat for any external import

// Legacy (pre-0.27.0 authored-graph) runs are read-only history. The verbs
// that act on one without a view of it (cancel, action show, tui --cancel)
// answer with the same sentence and exit 2 before doing anything else.
// Returns null when `token` is not a legacy run, so the caller carries on.
export function legacyRunRefusal(token, { json = false } = {}) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) return null;
  if (!isLegacyRunDir(resolved.runDir)) return null;
  const message = legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir });
  if (json) console.log(JSON.stringify({ legacy: true, runId: resolved.runId, shortId: resolved.shortId ?? null, dir: resolved.runDir, message }, null, 2));
  else console.error(message);
  return 2;
}

// 0.38.0: only a run marked `programFormat: 3` is driven. Every other run (v2,
// stage 1/2/3, legacy) was started by an earlier Bullswarm and is view-only:
// resume, pause, steer and step rerun/accept/restart answer with one sentence
// and exit 2 before doing anything else. Nothing is rewritten. Returns null for
// a v3 run, or a token that names no run, so the caller carries on.
export function viewOnlyRunLine(id) {
  return `run ${id} was started by an earlier Bullswarm and is view-only; start a new run: bullswarm workflow goal "<goal>" --cwd <run folder> --program <file.json>`;
}

export function drivableRunRefusal(token, { json = false } = {}, verb) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) return null;
  if (!isLegacyRunDir(resolved.runDir) && isProgramV3Run(readRunFeatures(resolved.runDir))) return null;
  const message = viewOnlyRunLine(resolved.shortId ?? resolved.runId);
  if (json) console.log(JSON.stringify({ viewOnly: true, verb, runId: resolved.runId, shortId: resolved.shortId ?? null, dir: resolved.runDir, message }, null, 2));
  else console.error(message);
  return 2;
}

// D3: what `runs show`, `runs result`, `watch` and `tui` print for a legacy run,
// read from the files it left (readLegacyRunFacts). Minutes and cost it never
// measured stay unknown. `legacy`, `runId`, `shortId`, `dir` and `message` are
// the keys the refusal these verbs used to print carried.
export function legacyRunSummary({ runId, shortId = null, runDir }) {
  const facts = readLegacyRunFacts(runDir, { runId, shortId });
  const record = legacyRollupRecord(facts);
  return {
    legacy: true, runId, shortId: facts.shortId ?? null, dir: runDir,
    project: facts.project, goal: facts.goal, status: facts.status,
    startedAt: record.startedAt, finishedAt: record.finishedAt, timeSource: facts.timeSource,
    minutes: { active: null, span: record.minutes.span }, cost: null,
    message: legacyRunLine({ shortId: facts.shortId ?? null, runId, runDir }),
  };
}

const GOAL_CHARS = 200;

export function legacySummaryLines(summary) {
  const goal = typeof summary.goal === 'string' ? summary.goal.replace(/\s+/g, ' ').trim() : '';
  const clipped = goal.length > GOAL_CHARS ? `${goal.slice(0, GOAL_CHARS - 1)}…` : goal;
  const when = (value) => value ?? 'unknown';
  return [
    `# run  ${summary.runId}  (${summary.shortId ?? 'no shortId'})  legacy`,
    `# dir  ${summary.dir}`,
    `# goal  ${clipped || '?'}`,
    `# status  ${summary.status ?? 'unknown'}`,
    `# started  ${when(summary.startedAt)}`,
    `# finished ${when(summary.finishedAt)}`,
    `# times from  ${summary.timeSource ?? 'unknown'}`,
    `# minutes  ${summary.minutes.span == null ? 'unknown' : `${summary.minutes.span} span`}, active unknown · cost unknown`,
    summary.message,
  ];
}

export function loadV2RunState(token) {
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = withV2Cancellation(JSON.parse(readFileSync(statePath, 'utf8')), resolved.runDir);
  if (isLegacyRunState(state)) throw new Error(`run "${token}" is not an autonomous V2 run`);
  return { ...resolved, state };
}
