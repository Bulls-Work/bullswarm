// The Runs page renderer.
//
// This module owns the Runs list and its history projection. The shell keeps
// the legacy renderDashboard adapter and the shared layout/palette helpers;
// Home supplies the same active-run block through activeRunLines.

import { dayKey } from './history.js';
import { historyLines } from './history-view.js';
import { taskIdentity } from './home-model.js';
import { activeRunLines } from './home-view.js';
import {
  clamp,
  dimText,
  durationText,
  moneyText,
  meterAnsi,
  pushView,
  runEconomics,
  selectLine,
  stateFinishedAt,
  stateStartedAt,
  stateStatus,
  statusIcon,
  TERMINAL_ACTIONS,
  workflowRunLabel,
  workflowStatusIcon,
} from './dashboard.js';

function isWaitingWorkflow(state) {
  const value = String(stateStatus(state) ?? '').toLowerCase();
  return value.includes('waiting') || value === 'paused';
}

function workflowConcernCount(row) {
  const concerns = row?.state?.outcome?.concerns ?? row?.report?.concerns ?? [];
  return Array.isArray(concerns) ? concerns.length : 0;
}

function dashboardRunLines(rows, selected, narrow, width) {
  if (!rows.length) return [{ selected: false, lines: ['No workflows in this view.'] }];
  return rows.map((row, index) => {
    const state = row.state ?? {};
    const selectedRow = index === selected;
    const legacy = Boolean(row.legacy);
    const durableStatus = legacy ? state.status : stateStatus(state);
    const icon = legacy ? '·'
      : row.ongoing ? statusIcon(durableStatus ?? 'running')
        : workflowStatusIcon({ status: durableStatus });
    const elapsed = legacy
      ? durationText(state.startedAt, state.finishedAt)
      : durationText(stateStartedAt(state) ?? row.report?.startedAt, stateFinishedAt(state) ?? row.report?.finishedAt);
    const workerAttempts = legacy ? [] : (state.attempts ?? []).filter((attempt) =>
      attempt.actionId !== state.orchestration?.actionId && attempt.actionId !== 'orchestrator');
    const finished = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
    // A legacy row claims no progress: 0.27.0 never reads its steps.
    let progress = legacy ? 'legacy'
      : workerAttempts.length
        ? `${finished}/${workerAttempts.length} workers`
        : `${row.stepsOk ?? 0}/${row.stepsTotal ?? 0} actions`;
    const concerns = legacy ? 0 : workflowConcernCount(row);
    const status = concerns ? `${concerns} concern${concerns === 1 ? '' : 's'}` : humanWorkflowStatus(durableStatus, row.ongoing);
    const name = workflowRunLabel(row);
    const phase = legacy ? 'legacy' : humanPhaseName(row.phase ?? 'starting');
    const economics = legacy ? null : runEconomics(row, [], Date.now());
    const spend = economics ? moneyText(economics) : null;
    const spendLabel = spend ?? (legacy ? null : 'cost unknown');
    if (narrow) {
      const inner = Math.max(1, width - 4);
      return {
        selected: selectedRow,
        lines: [
          selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, inner),
          selectLine(`  ${progress} · ${elapsed}${spendLabel ? ` · ${spendLabel}` : ''}`, selectedRow, false, inner),
          selectLine(`  ${phase} · ${status}`, selectedRow, false, inner),
          '',
        ],
      };
    }
    return {
      selected: selectedRow,
      lines: [
        selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, 44),
        selectLine(`  ${progress} · ${elapsed} · ${status}${spendLabel ? ` · ${spendLabel}` : ''}`, selectedRow, false, 44),
        '',
      ],
    };
  });
}

function listWindow(groups, selected, height, narrow) {
  const linesPerGroup = narrow ? 4 : 3;
  const capacity = Math.max(1, Math.floor(height / linesPerGroup));
  const start = clamp(selected - Math.floor(capacity / 2), 0, Math.max(0, groups.length - capacity));
  return groups.slice(start, start + capacity).flatMap((group) => group.lines).slice(0, height);
}

function humanWorkflowStatus(status, ongoing) {
  const value = String(status ?? '').replaceAll('_', ' ');
  if (ongoing && (!value || value === 'running')) return 'running';
  if (value === 'completed') return 'finished';
  if (value === 'completed with concerns') return 'finished with concerns';
  return value || (ongoing ? 'running' : 'finished');
}

function humanPhaseName(value) {
  return String(value ?? 'starting').replaceAll('-', ' ').replaceAll(':', ' › ');
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
  const matches = (run) => !query || `${run.runId ?? ''} ${run.shortId ?? ''} ${run.goal ?? workflowRunLabel(run)} ${run.id ?? ''} ${run.taskFile ?? ''} ${run.lane ?? ''} ${run.pool ?? ''} ${run.model ?? ''} ${run.project ?? ''}`.toLowerCase().includes(query);
  activeRunLines({
    ...model,
    runs: active.filter(matches),
    tasks: { ...(model.tasks ?? {}), inflight: (model.tasks?.inflight ?? []).filter(matches) },
  }, opts, body, 'active');
  body.push('');
  body.anchor = { history: body.lines.length + 1, cursor: null };
  const ids = new Set(active.map((run) => run.runId));
  const days = daysWithTasks(model.days, (model.tasks?.finished ?? []).filter(matches)).map((day) => ({
    ...day,
    rows: (day.rows ?? []).filter((run) => !ids.has(run.runId) && matches(run)),
  }));
  pushView(body, historyLines(days, { width, ansi: meterAnsi() }));
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
    body.lines[cursor.y - 1] = `\x1b[7m${body.lines[cursor.y - 1]}\x1b[0m`;
    body.anchor.cursor = cursor.y;
  }
  body.runRows = runRows.map((region) => ({ runId: region.action.runId, y: region.y }));
  body.taskRows = taskRegions.map((region) => ({ taskId: region.action.taskId, y: region.y }));
  body.cursorAction = cursor?.action ?? null;
  return ` bullswarm · runs · ${opts.filter === 'all' ? 'all' : 'active'} · ${days.length} days`;
}

export {
  isWaitingWorkflow,
  workflowConcernCount,
  dashboardRunLines,
  listWindow,
  humanWorkflowStatus,
  humanPhaseName,
  filterDashboardRows,
  daysWithTasks,
  runsPage,
};
