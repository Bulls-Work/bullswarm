import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  dashboardModel,
  dashboardRows,
  renderDashboardPage,
} from '../src/workflow/dashboard.js';
import { listTasks } from '../src/lib/tasks.js';
import { readRollups, rollupRecord } from '../src/workflow/rollup.js';
import { workflowPanelModel } from '../src/workflow/run-model.js';

// The scrubbed in-repo copy of the real home (scripts/build-test-home.mjs).
export const SNAPSHOT = fileURLToPath(new URL('../tests/fixtures/home-351/', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
// The zone the owner reviewed the frames in: every clock a frame prints reads
// the same on any machine.
const FRAME_TZ = 'Asia/Hong_Kong';
export const FRAME_DIR = new URL('../docs/design/tidy-0.35.1/frames/', import.meta.url);
// The same frames with their SGR codes kept, so a reviewer can grep a colour
// instead of taking a screenshot's word for it (requirement 5).
export const COLOUR_DIR = new URL('../docs/design/tidy-0.35.1/frames/colour/', import.meta.url);
export const WIDTHS = Object.freeze([55, 120, 200]);
// The colour pass was approved on the narrow and the wide terminal only: the
// two widths the Step and Run records draw their rules at.
export const COLOUR_WIDTHS = Object.freeze([55, 200]);
// The seven screens the colour rules name: Step in both views, Run in both
// states, the single task and Home.
export const COLOUR_FRAMES = Object.freeze([
  'home',
  'run-running', 'run-finished',
  'step-overview-finished', 'step-overview-running', 'step-detail-finished',
  'task',
]);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const clone = (value) => structuredClone(value);
const atMs = (value) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
};
const plain = (line) => String(line ?? '').replace(ANSI, '').replace(/\s+$/, '');
// A painted line keeps every escape; only the padding spaces a full-width row
// ends on are dropped, so the file is the frame and not the terminal's blanks.
const painted = (line) => String(line ?? '').replace(/[ \t]+$/, '');
/** Display cells a frame line occupies: escapes carry no width. */
export const displayCells = (line) => [...String(line ?? '').replace(ANSI, '')].length;

function actionStatus(attempts, mode, targetActionId) {
  if (!attempts.length) return 'pending';
  const latest = attempts.at(-1);
  if (latest.status === 'running') return 'running';
  if (latest.status === 'succeeded') return 'succeeded';
  if (mode === 'failed' && latest.actionId === targetActionId) return 'failed';
  return 'pending';
}

/**
 * Reconstruct a historical screen from timestamps already present in the
 * supplied snapshot. No duration, event, route, money or result is invented:
 * future attempts are hidden and the attempt crossing the capture instant is
 * projected as open. The failed projection stops on a recorded interrupted
 * attempt and preserves its exact failure fields.
 */
export function historicalProjection(source, actionId, ordinal, mode) {
  const row = clone(source);
  const original = row.state.attempts.find((attempt) => (
    attempt.actionId === actionId && Number(attempt.ordinal) === Number(ordinal)
  ));
  if (!original) throw new Error(`snapshot has no ${actionId} attempt ${ordinal}`);
  const start = atMs(original.startedAt);
  const finish = atMs(original.finishedAt);
  if (start == null || finish == null) throw new Error(`${original.id} has no closed real interval`);
  const nowMs = mode === 'running' ? start + Math.floor((finish - start) / 2) : finish;

  row.state.attempts = row.state.attempts
    .filter((attempt) => (atMs(attempt.startedAt) ?? Infinity) <= nowMs)
    .map((attempt) => {
      const projected = clone(attempt);
      if ((atMs(projected.finishedAt) ?? Infinity) > nowMs) {
        projected.status = 'running';
        projected.finishedAt = null;
        projected.wallSec = null;
        projected.why = null;
        projected.failureKind = null;
        projected.usage = null;
      }
      return projected;
    });

  for (const action of row.state.actions ?? []) {
    const attempts = row.state.attempts.filter((attempt) => attempt.actionId === action.id);
    action.status = actionStatus(attempts, mode, actionId);
    action.attempts = attempts.length;
    action.startedAt = attempts[0]?.startedAt ?? null;
    action.finishedAt = action.status === 'succeeded' || action.status === 'failed'
      ? attempts.at(-1)?.finishedAt ?? null : null;
  }
  for (const stage of row.state.presentation?.stages ?? []) {
    const actions = (stage.actionIds ?? []).map((id) => row.state.actions.find((action) => action.id === id)).filter(Boolean);
    stage.startedAt = actions.find((action) => action.startedAt)?.startedAt ?? null;
    stage.completedAt = actions.length && actions.every((action) => action.status === 'succeeded')
      ? actions.map((action) => action.finishedAt).filter(Boolean).sort().at(-1) ?? null
      : null;
  }
  row.state.lifecycle.status = mode === 'running' ? 'running' : 'partial';
  row.state.lifecycle.finishedAt = mode === 'running' ? null : original.finishedAt;
  row.state.outcome = null;
  row.state.result = null;
  row.status = row.state.lifecycle.status;
  row.ongoing = mode === 'running';
  return { row, nowMs };
}

function selection(row, actionId) {
  const panel = workflowPanelModel(row);
  const phaseIndex = panel.phases.findIndex((phase) => phase.actions.some((action) => action.id === actionId));
  const phase = Math.max(0, phaseIndex);
  const agents = workflowPanelModel(row, { phaseIndex: phase }).agents;
  const agentIndex = Math.max(0, agents.findIndex((agent) => agent.action.id === actionId));
  return { phaseIndex: phase, agentIndex };
}

function render(model, options, colour) {
  return renderDashboardPage(model, options).lines.map(colour ? painted : plain);
}

function assertWidth(name, width, lines) {
  for (const [index, line] of lines.entries()) {
    const length = displayCells(line);
    if (length > width) throw new Error(`${name}:${index + 1} is ${length} columns at width ${width}`);
  }
}

function taskWithCopiedPaths(task, snapshot) {
  const runsDir = join(snapshot, 'runs');
  return {
    ...task,
    taskFile: task.taskFile ? join(runsDir, basename(task.taskFile)) : null,
    outFile: task.outFile ? join(runsDir, basename(task.outFile)) : null,
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function refreshedRollups(rows, stored, nowMs) {
  const byRun = new Map(stored.map((record) => [record.runId, record]));
  return rows.map((row) => {
    const previous = byRun.get(row.runId) ?? {};
    return rollupRecord(row.state, readJson(join(row.runDir, 'result.json')), {
      project: previous.project ?? row.state?.project ?? null,
      cwd: previous.cwd ?? row.state?.intent?.cwd ?? null,
      now: nowMs,
    });
  });
}

/**
 * Render the 0.35.1 review frames from the scrubbed real home.
 *
 * `colour: false` writes the plain `real-*.txt` set at every width — the text
 * frames the records quote. `colour: true` renders the same screens with their
 * SGR codes kept, at the two widths the colour rules were approved at, for the
 * subset the rules name. Both read one snapshot and one render, so a colour
 * frame is never a second arithmetic of the plain one.
 */
export function buildRealFrames({ snapshot = SNAPSHOT, colour = false } = {}) {
  // The pages print run folders and task files. Rendered from the repository
  // root through a relative path, in one pinned zone, a frame reads the same
  // on every checkout; both are restored before returning.
  const cwd = process.cwd();
  const tz = process.env.TZ;
  const home = relative(REPO, resolve(cwd, snapshot)) || '.';
  process.chdir(REPO);
  process.env.TZ = FRAME_TZ;
  try {
    return renderRealFrames(home, colour);
  } finally {
    process.chdir(cwd);
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}

function renderRealFrames(snapshot, colour) {
  if (!existsSync(join(snapshot, 'history', 'runs.jsonl'))) throw new Error(`snapshot missing: ${snapshot}`);
  const rows = dashboardRows(snapshot, { all: true });
  const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
  const rollups = refreshedRollups(rows, readRollups(snapshot), nowMs);
  const finishedRun = rows.find((row) => row.shortId === 'euqrni');
  const stepRun = rows.find((row) => row.shortId === 'va7k9a');
  if (!finishedRun || !stepRun) throw new Error('required real runs euqrni and va7k9a are absent');

  const runRunning = historicalProjection(finishedRun, 'integrate', 1, 'running');
  const stepRunning = historicalProjection(stepRun, 'step-model', 1, 'running');
  const stepFailed = historicalProjection(stepRun, 'step-view', 1, 'failed');
  const taskLedger = listTasks({ home: snapshot, now: nowMs });
  const task = taskWithCopiedPaths(
    (taskLedger.finished ?? []).find((entry) => entry.id === 'a58fb95e-6f73-4f3a-88d5-8a063155fb3c'),
    snapshot,
  );
  if (!task?.id) throw new Error('required real standalone task is absent');

  const frames = new Map();
  // A colour frame exists only for the screens and widths the rules cover; the
  // plain set stays whole, so neither list is trimmed by the other.
  const wanted = (name) => !colour || COLOUR_FRAMES.includes(name);
  const keep = (name, width, lines) => { if (wanted(name)) frames.set(`real-${name}-${width}.txt`, lines); };
  for (const width of colour ? COLOUR_WIDTHS : WIDTHS) {
    const height = 60;
    keep('home', width, render(dashboardModel(null, {
      rollups, nowMs, runs: [], tasks: taskLedger, usage: { pools: [], assignments: [] },
    }), { page: 'home', width, height, nowMs }, colour));

    for (const [state, projected] of [['running', runRunning], ['finished', { row: finishedRun, nowMs }]]) {
      const selected = selection(projected.row, state === 'running' ? 'integrate' : 'verify');
      keep(`run-${state}`, width, render(dashboardModel(projected.row, {
        runs: [projected.row], rollups, nowMs: projected.nowMs,
      }), {
        page: 'run', width, height, nowMs: projected.nowMs,
        selectedRunId: projected.row.runId, ...selected,
      }, colour));
    }

    for (const [state, projected, actionId, ordinal] of [
      ['running', stepRunning, 'step-model', 1],
      ['finished', { row: stepRun, nowMs }, 'step-model', 1],
      ['failed', stepFailed, 'step-view', 1],
    ]) {
      const selected = selection(projected.row, actionId);
      for (const view of ['overview', 'detail']) {
        keep(`step-${view}-${state}`, width, render(dashboardModel(projected.row, {
          runs: [projected.row], rollups, nowMs: projected.nowMs,
        }), {
          page: 'step', width, height, nowMs: projected.nowMs,
          selectedRunId: projected.row.runId, stepView: view,
          stepAttemptOrdinal: ordinal, ...selected,
        }, colour));
      }
    }

    keep('task', width, render(dashboardModel(null, {
      task, taskRunsDir: join(snapshot, 'runs'), nowMs,
    }), { page: 'task', width, height, nowMs, stepView: 'overview' }, colour));

    // The two Stats pages the owner reviewed at 200 columns. Both read the
    // same refreshed rollups as Home, so a frame is never a second arithmetic.
    for (const tab of ['spending', 'model']) {
      keep(`stats-${tab}`, width, render(dashboardModel(null, {
        rollups, nowMs, runs: [], tasks: taskLedger, usage: { pools: [], assignments: [] },
        period: '30d',
      }), { page: 'stats', width, height, nowMs, statsTab: tab, period: '30d' }, colour));
    }
  }
  for (const [name, lines] of frames) assertWidth(name, Number(name.match(/-(\d+)\.txt$/)?.[1]), lines);
  return frames;
}

export function writeRealFrames(options = {}) {
  const frames = buildRealFrames({ ...options, colour: false });
  mkdirSync(FRAME_DIR, { recursive: true });
  for (const [name, lines] of frames) writeFileSync(new URL(name, FRAME_DIR), `${lines.join('\n')}\n`);
  return frames;
}

/** The same screens with their SGR codes kept, under `frames/colour/`. */
export function writeColourFrames(options = {}) {
  const frames = buildRealFrames({ ...options, colour: true });
  mkdirSync(COLOUR_DIR, { recursive: true });
  for (const [name, lines] of frames) writeFileSync(new URL(name, COLOUR_DIR), `${lines.join('\n')}\n`);
  return frames;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // `--colour` writes the painted set only, `--plain` the text set only; with
  // neither flag the script regenerates both, which is what a release pass wants.
  const args = process.argv.slice(2);
  const only = args.find((arg) => arg === '--colour' || arg === '--plain') ?? null;
  const snapshot = args.find((arg) => !arg.startsWith('--')) ?? SNAPSHOT;
  if (only !== '--colour') {
    process.stdout.write(`rendered ${writeRealFrames({ snapshot }).size} real frames\n`);
  }
  if (only !== '--plain') {
    process.stdout.write(`rendered ${writeColourFrames({ snapshot }).size} colour frames\n`);
  }
}
