// The Runs page renderer.
//
// This module owns the Runs list and its history projection. The shell keeps
// the shared layout/palette helpers; Home supplies the same active-run block
// through activeRunLines.

import { dayKey } from './history.js';
import { historyLines, runTableLayout, runTableLines } from './history-view.js';
import { taskIdentity } from './home-model.js';
import { rule } from './dash-kit.js';
import { dimText, meterAnsi, pushView, stateStatus, workflowRunLabel } from './dashboard.js';

function isWaitingWorkflow(state) {
  const value = String(stateStatus(state) ?? '').toLowerCase();
  return value.includes('waiting') || value === 'paused';
}

// A selected row may already contain palette SGR resets.  Re-arm reverse
// video after each reset so the whole row remains visibly inverse, not just
// its first coloured cell.  Reverse video paints a cell's foreground as its
// background, so a grey cost or clock cell would show as a grey band inside
// the bar: only the status glyph (the row's first colour) keeps its colour,
// and dim is dropped.
function inverseLine(value) {
  let coloured = 0;
  const text = String(value ?? '')
    .replace(/\x1b\[(?:2|22)m/g, '')
    .replace(/\x1b\[(?:38;2;\d+;\d+;\d+|38;5;\d+|3[0-7]|9[0-7])m/g, (code) => (coloured++ === 0 ? code : ''));
  return `\x1b[7m${text.replace(/\x1b\[0m/g, '\x1b[0m\x1b[7m')}\x1b[27m\x1b[0m`;
}

function filterDashboardRows(rows, filter, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  return (rows ?? []).filter((row) => {
    if (filter === 'active' && !row.ongoing) return false;
    if (!needle) return true;
    const state = row.state ?? {};
    return [row.shortId, row.runId, state.name, state.goal, state.intent?.goal, row.phase, row.status, stateStatus(state)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

/** Merge task ledger rows into a caller-supplied workflow day page. */
function daysWithTasks(days, tasks) {
  const source = Array.isArray(days) ? days : [];
  const out = source.map((day) => ({ ...day, rows: [...(day.rows ?? [])] }));
  const byDate = new Map(out.map((day) => [String(day.date), day]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const date = dayKey(task?.endedAt ?? task?.finishedAt ?? task?.startedAt);
    if (!date) continue;
    const day = byDate.get(date) ?? {
      date, runs: 0, finished: 0, verified: 0, verifiedShare: null, spendUsd: null,
      legacyRows: 0, unfinishedRows: 0, rows: [],
    };
    if (!byDate.has(date)) { byDate.set(date, day); out.push(day); }
    const id = taskIdentity(task);
    const alreadyListed = day.rows.some((row) => (row?.kind === 'task' || row?.task === true)
      && taskIdentity(row) === id);
    if (!alreadyListed) {
      day.rows.push({ ...task, kind: 'task', source: 'run' });
    }
  }
  return out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/** Runs: the list, the filter, the agent integration and the commands. */
function runsPage(model, opts, body) {
  const { width } = opts;
  const active = [...model.runs];
  for (const row of opts.allRows ?? []) {
    if ((row.ongoing || isWaitingWorkflow(row.state)) && !active.some((run) => run.runId === row.runId)) active.push(row);
  }
  const query = String(opts.query ?? '').toLowerCase();
  const matches = (run) => !query || `${run.runId ?? ''} ${run.shortId ?? ''} ${run.goal ?? workflowRunLabel(run)} ${run.id ?? ''} ${run.taskFile ?? ''} ${run.taskText ?? ''} ${run.lane ?? ''} ${run.pool ?? ''} ${run.model ?? ''} ${run.project ?? ''}`.toLowerCase().includes(query);
  const activeRows = [
    ...active.filter(matches),
    ...(model.tasks?.inflight ?? []).filter(matches).map((task) => ({ ...task, kind: 'task', source: 'run' })),
  ].sort((a, b) => String(b?.startedAt ?? b?.state?.lifecycle?.startedAt ?? '')
    .localeCompare(String(a?.startedAt ?? a?.state?.lifecycle?.startedAt ?? '')));
  const ids = new Set(active.map((run) => run.runId));
  const days = daysWithTasks(model.days, (model.tasks?.finished ?? []).filter(matches)).map((day) => ({
    ...day,
    rows: (day.rows ?? []).filter((run) => !ids.has(run.runId) && matches(run)),
  }));
  const loadedRows = days.flatMap((day) => day.rows ?? []);
  const layout = runTableLayout([...activeRows, ...loadedRows], { width, nowMs: opts.nowMs });
  body.push('');
  body.push(rule('active', null, width));
  if (activeRows.length) pushView(body, runTableLines(activeRows, { width, ansi: meterAnsi(), nowMs: opts.nowMs, layout }));
  else body.push(dimText(' nothing in flight · bullswarm workflow goal "<goal>" launches one', width));
  body.push('');
  body.anchor = { history: body.lines.length + 1, cursor: null };
  pushView(body, historyLines(days, { width, ansi: meterAnsi(), nowMs: opts.nowMs, layout }));
  if (opts.query) body.push(dimText(` filter “${opts.query}”`, width));
  const runRegions = body.regions.filter((region) => region.action?.kind === 'run');
  const taskRegions = body.regions.filter((region) => region.action?.kind === 'task');
  const desired = opts.listSelectedId ?? opts.selectedRunId ?? null;
  const runRows = runRegions.sort((a, b) => a.y - b.y);
  const allRows = [...runRegions, ...taskRegions].sort((a, b) => a.y - b.y);
  const desiredTask = opts.selectedTaskId ?? null;
  const wanted = desiredTask
    ? allRows.findIndex((region) => region.action.kind === 'task' && region.action.taskId === desiredTask)
    : allRows.findIndex((region) => region.action.kind === 'run' && region.action.runId === desired);
  const cursor = allRows[wanted >= 0 ? wanted : 0];
  if (cursor) {
    body.lines[cursor.y - 1] = inverseLine(body.lines[cursor.y - 1]);
    body.anchor.cursor = cursor.y;
  }
  body.runRows = runRows.map((region) => ({ runId: region.action.runId, y: region.y }));
  body.taskRows = taskRegions.map((region) => ({ taskId: region.action.taskId, y: region.y }));
  body.cursorAction = cursor?.action ?? null;
  return ` bullswarm · runs · ${opts.filter === 'all' ? 'all' : 'active'} · ${days.length} days`;
}

export {
  isWaitingWorkflow,
  filterDashboardRows,
  daysWithTasks,
  runsPage,
};
