// Loading run rows for the dashboard: listed and in-flight runs enriched with
// their events, liveness and step counts, and one run's detail row.
import { withV2Cancellation } from './v2-cancellation.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readJsonSafe } from '../lib/fsjson.js';
import { join } from 'node:path';
import { listRuns, runEntry, resolveRunId, v2RunnerLiveness, isLegacyRunState, isLegacyRunDir, isOngoing, readKernelStderrTail, runStartingFacts } from './short-id.js';
import { readEvents } from './events.js';
import { stateStartedAt } from './dashboard-run-state.js';

/** A run directory that wrote one of these has finished; the index has it. */
const FINISHED_MARKERS = Object.freeze(['rollup.json', 'result.json', 'report.json']);

/**
 * One listed run, enriched with everything the pages read: its events, its
 * liveness, its step counts and the attempts in flight.
 */
function enrichRunRow(r) {
  // A run whose kernel has not written state.json yet: starting, or stopped
  // before it started. Never a legacy row.
  if (r.starting) return startingRow(r, r.starting);
  const state = r.state ?? {};
  // A legacy row is five read-only fields and a marker; its detail pane is
  // one line and it offers nothing to drive. A torn state.json lands here
  // too, which keeps observation non-crashing until the writer settles.
  if (r.legacy || isLegacyRunState(state)) {
    return {
      ...r,
      legacy: true,
      events: [],
      status: state.status ?? 'unknown',
      phase: 'legacy',
      stepsOk: 0,
      stepsTotal: 0,
      activeAgents: [],
      currentPhase: null,
      currentStep: null,
      usage: null,
    };
  }
  const actions = state.actions ?? [];
  const runningAttempts = (state.attempts ?? []).filter((attempt) => attempt.status === 'running');
  const current = actions.find((action) => action.status === 'running') ?? actions.find((action) => ['ready', 'pending'].includes(action.status));
  const stage = state.presentation?.stages?.find((item) => item.actionIds.includes(current?.id))
    ?? state.presentation?.stages?.findLast((item) => item.startedAt)
    ?? null;
  const liveness = v2RunnerLiveness(state, { runDir: r.runDir });
  return {
    ...r,
    events: readEvents(r.runDir),
    liveness,
    kernelStderrTail: !liveness.alive ? readKernelStderrTail(r.runDir) : [],
    status: state.cancellation?.requested ? 'stopping'
      : liveness.alive ? state.lifecycle.status : 'interrupted',
    phase: stage?.label ?? (state.preflight?.scout?.status === 'running' ? 'Preflight: Scout' : state.planner?.status === 'running' ? 'Workflow Planner' : 'starting'),
    stepsOk: actions.filter((action) => action.status === 'succeeded').length,
    stepsTotal: actions.length,
    activeAgents: runningAttempts,
    currentPhase: stage,
    currentStep: current ?? null,
    usage: state.usage ?? null,
  };
}

function startingRow(r, starting) {
  return {
    ...r,
    legacy: false,
    starting,
    events: [],
    kernelStderrTail: starting.alive ? [] : readKernelStderrTail(r.runDir),
    status: starting.alive ? 'starting' : 'interrupted',
    phase: 'starting',
    stepsOk: 0,
    stepsTotal: 0,
    activeAgents: [],
    currentPhase: null,
    currentStep: null,
    usage: null,
  };
}

const byNewestStart = (a, b) => {
  if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
  return String(stateStartedAt(b.state) ?? b.report?.startedAt ?? '')
    .localeCompare(String(stateStartedAt(a.state) ?? a.report?.startedAt ?? ''));
};

export function dashboardRows(bullswarmDir, { all = false } = {}) {
  return listRuns(bullswarmDir)
    .filter((r) => all || r.ongoing)
    .sort(byNewestStart)
    .map(enrichRunRow);
}

// The files a listed row is built from. A finished run whose files and
// directory listing are unchanged gives the same row, so it is not read again.
const ROW_SOURCES = Object.freeze(['state.json', 'events.jsonl', 'result.json', 'report.json', 'cancellation.json', ...FINISHED_MARKERS]);

function rowFingerprint(dir) {
  const parts = [];
  for (const name of ['', ...ROW_SOURCES]) {
    try {
      const stat = statSync(name ? join(dir, name) : dir);
      parts.push(`${stat.mtimeMs}:${stat.size}`);
    } catch { parts.push('-'); }
  }
  return parts.join('|');
}

/**
 * Every run, as `dashboardRows(dir, { all: true })` lists them, re-reading only
 * the run directories that changed since the last call with the same `cache`.
 *
 * The Runs page rebuilds its catalogue every 15 s and whenever an active run
 * changes status. Parsing every state.json and events.jsonl each time held the
 * panel at ~76% CPU with 1,067 runs (27 Nov). A finished run (one that wrote
 * a finished marker and is not ongoing) keeps its row until one of its files
 * changes; a run without a marker is read every time, because its liveness can
 * change with no file changing.
 */
export function catalogRows(bullswarmDir, cache = new Map()) {
  const runsRoot = join(bullswarmDir, 'workflows');
  let entries = [];
  try { entries = existsSync(runsRoot) ? readdirSync(runsRoot, { withFileTypes: true }) : []; } catch { entries = []; }
  // listRuns' order, so rows tied on start time sort the same way.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wf-')) continue;
    const dir = join(runsRoot, entry.name);
    seen.add(entry.name);
    const fingerprint = rowFingerprint(dir);
    const hit = cache.get(entry.name);
    if (hit && hit.settled && hit.fingerprint === fingerprint) {
      rows.push(hit.row);
      continue;
    }
    const listed = runEntry(entry.name, dir);
    const row = enrichRunRow(listed);
    const settled = !listed.ongoing && !listed.starting
      && FINISHED_MARKERS.some((marker) => existsSync(join(dir, marker)));
    cache.set(entry.name, { fingerprint, row, settled });
    rows.push(row);
  }
  for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name);
  return rows.sort(byNewestStart);
}

/**
 * The runs in flight, without parsing every run directory.
 *
 * `listRuns` parses all 293 `state.json` files on this machine — 22 MB and
 * about 100 ms against a 1 s refresh timer — which is why Home, Stats,
 * History and Budget read `~/.bullswarm/history/runs.jsonl` instead. The nav
 * and the running block still need live state, so this walks the same
 * directories and parses only the ones that can still be running: a run that
 * wrote `rollup.json`, `result.json` or `report.json` has finished, and its
 * numbers live in the index.
 */
export function activeDashboardRows(bullswarmDir) {
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return [];
  let entries;
  try { entries = readdirSync(runsRoot, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wf-')) continue;
    const dir = join(runsRoot, entry.name);
    if (FINISHED_MARKERS.some((marker) => existsSync(join(dir, marker)))) continue;
    const statePath = join(dir, 'state.json');
    if (!existsSync(statePath)) continue;
    let raw = null;
    try { raw = JSON.parse(readFileSync(statePath, 'utf8')); } catch { continue; }
    // A legacy run is never ongoing, so it never reaches the running block.
    if (isLegacyRunState(raw)) continue;
    const state = withV2Cancellation(raw, dir);
    if (!isOngoing(dir, state)) continue;
    rows.push(enrichRunRow({
      runId: entry.name, shortId: state?.shortId ?? null, runDir: dir, dir,
      legacy: false, state, report: null, ongoing: true,
    }));
  }
  return rows.sort(byNewestStart);
}

function detailRow(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const starting = runStartingFacts(resolved.runDir);
  if (starting) return startingRow({ ...resolved, state: null, report: null, ongoing: starting.alive }, starting);
  const legacy = isLegacyRunDir(resolved.runDir);
  const state = legacy ? null : withV2Cancellation(readJsonSafe(join(resolved.runDir, 'state.json')), resolved.runDir);
  const report = readJsonSafe(join(resolved.runDir, 'report.json'));
  return {
    ...resolved, legacy, state, report,
    events: legacy ? [] : readEvents(resolved.runDir),
    status: state?.lifecycle?.status,
  };
}

export {
  detailRow,
};
