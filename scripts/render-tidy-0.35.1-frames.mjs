import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  dashboardModel,
  dashboardRows,
  renderDashboardPage,
} from '../src/workflow/dashboard.js';
import { listTasks } from '../src/lib/tasks.js';
import { readRollups, rollupRecord } from '../src/workflow/rollup.js';
import { workflowPanelModel } from '../src/workflow/run-model.js';

export const SNAPSHOT = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
export const FRAME_DIR = new URL('../docs/design/tidy-0.35.1/frames/', import.meta.url);
export const WIDTHS = Object.freeze([55, 120, 200]);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const clone = (value) => structuredClone(value);
const atMs = (value) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
};
const plain = (line) => String(line ?? '').replace(ANSI, '').replace(/\s+$/, '');

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

function render(model, options) {
  return renderDashboardPage(model, options).lines.map(plain);
}

function assertWidth(name, width, lines) {
  for (const [index, line] of lines.entries()) {
    const length = [...line].length;
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

export function buildRealFrames({ snapshot = SNAPSHOT } = {}) {
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
  for (const width of WIDTHS) {
    const height = 60;
    frames.set(`real-home-${width}.txt`, render(dashboardModel(null, {
      rollups, nowMs, runs: [], tasks: taskLedger, usage: { pools: [], assignments: [] },
    }), { page: 'home', width, height, nowMs }));

    for (const [state, projected] of [['running', runRunning], ['finished', { row: finishedRun, nowMs }]]) {
      const selected = selection(projected.row, state === 'running' ? 'integrate' : 'verify');
      frames.set(`real-run-${state}-${width}.txt`, render(dashboardModel(projected.row, {
        runs: [projected.row], rollups, nowMs: projected.nowMs,
      }), {
        page: 'run', width, height, nowMs: projected.nowMs,
        selectedRunId: projected.row.runId, ...selected,
      }));
    }

    for (const [state, projected, actionId, ordinal] of [
      ['running', stepRunning, 'step-model', 1],
      ['finished', { row: stepRun, nowMs }, 'step-model', 1],
      ['failed', stepFailed, 'step-view', 1],
    ]) {
      const selected = selection(projected.row, actionId);
      for (const view of ['overview', 'detail']) {
        frames.set(`real-step-${view}-${state}-${width}.txt`, render(dashboardModel(projected.row, {
          runs: [projected.row], rollups, nowMs: projected.nowMs,
        }), {
          page: 'step', width, height, nowMs: projected.nowMs,
          selectedRunId: projected.row.runId, stepView: view,
          stepAttemptOrdinal: ordinal, ...selected,
        }));
      }
    }

    frames.set(`real-task-${width}.txt`, render(dashboardModel(null, {
      task, taskRunsDir: join(snapshot, 'runs'), nowMs,
    }), { page: 'task', width, height, nowMs, stepView: 'overview' }));

    // The two Stats pages the owner reviewed at 200 columns. Both read the
    // same refreshed rollups as Home, so a frame is never a second arithmetic.
    for (const tab of ['spending', 'model']) {
      frames.set(`real-stats-${tab}-${width}.txt`, render(dashboardModel(null, {
        rollups, nowMs, runs: [], tasks: taskLedger, usage: { pools: [], assignments: [] },
        period: '30d',
      }), { page: 'stats', width, height, nowMs, statsTab: tab, period: '30d' }));
    }
  }
  for (const [name, lines] of frames) assertWidth(name, Number(name.match(/-(\d+)\.txt$/)?.[1]), lines);
  return frames;
}

export function writeRealFrames(options = {}) {
  const frames = buildRealFrames(options);
  mkdirSync(FRAME_DIR, { recursive: true });
  for (const [name, lines] of frames) writeFileSync(new URL(name, FRAME_DIR), `${lines.join('\n')}\n`);
  return frames;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const frames = writeRealFrames({ snapshot: process.argv[2] ?? SNAPSHOT });
  process.stdout.write(`rendered ${frames.size} real frames\n`);
}
