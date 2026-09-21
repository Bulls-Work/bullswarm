import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTasks } from '../src/lib/tasks.js';
import { dashboardModel, dashboardRows, renderDashboardPage } from '../src/workflow/dashboard.js';
import { historyDays } from '../src/workflow/history.js';
import { readRollups, rollupRecord } from '../src/workflow/rollup.js';

export const SNAPSHOT = fileURLToPath(new URL('../tests/fixtures/home-351/', import.meta.url));
export const FRAME_DIR = new URL('../docs/design/runs-table-0.35.4/frames/', import.meta.url);
export const WIDTHS = Object.freeze([55, 120, 200]);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const plain = (line) => String(line ?? '').replace(ANSI, '').replace(/\s+$/, '');
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

export function buildRunsFrames({ snapshot = SNAPSHOT } = {}) {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Hong_Kong';
  try {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const allRows = dashboardRows(snapshot, { all: true });
    const runs = allRows.filter((row) => row.ongoing);
    const tasks = listTasks({ home: snapshot, now: nowMs });
    const stored = readRollups(snapshot);
    const storedById = new Map(stored.map((row) => [row.runId, row]));
    const refreshed = allRows.filter((row) => !row.legacy).map((row) => {
      const previous = storedById.get(row.runId) ?? {};
      return rollupRecord(row.state, readJson(join(row.runDir, 'result.json')), {
        project: previous.project ?? row.state?.project ?? null,
        cwd: previous.cwd ?? row.state?.intent?.cwd ?? null,
        now: nowMs,
      });
    });
    const refreshedById = new Map(refreshed.map((row) => [row.runId, row]));
    const days = historyDays(snapshot, { days: 7, now: nowMs, tasks: tasks.finished }).map((day) => ({
      ...day,
      rows: (day.rows ?? []).map((row) => refreshedById.get(row.runId) ?? row),
    }));
    const model = dashboardModel(null, {
      runs, rollups: refreshed, days, tasks, nowMs,
      usage: { pools: [], assignments: [] },
    });
    const frames = new Map();
    for (const width of WIDTHS) {
      const lines = renderDashboardPage(model, {
        page: 'runs', filter: 'all', width, height: 70, nowMs, allRows,
      }).lines.map(plain);
      for (const [index, line] of lines.entries()) {
        if ([...line].length > width) throw new Error(`runs-${width}:${index + 1} exceeds ${width} columns`);
      }
      frames.set(`runs-${width}.txt`, lines);
    }
    return frames;
  } finally {
    if (previous == null) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(FRAME_DIR, { recursive: true });
  const frames = buildRunsFrames();
  for (const [name, lines] of frames) writeFileSync(new URL(name, FRAME_DIR), `${lines.join('\n')}\n`);
  process.stdout.write(`wrote ${frames.size} Runs frames\n`);
}
