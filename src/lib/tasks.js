// The single-task ledger consumed by the dashboard and the Mod pane.
//
// A run has two durable surfaces with deliberately different lifetimes:
//   - assignments/*.json is the live, cross-process source while the worker is
//     running;
//   - state.json's decisionLog is the finished source after the assignment is
//     released.
// This module normalizes both into the small row shape UI code needs. It is a
// display reader: missing/torn files and older records produce null fields,
// never an exception or a made-up duration. A missing project is recoverable
// only when the old record also preserved its cwd; records with no cwd stay
// anonymous.

import { join } from 'node:path';
import { readJsonSafe } from './fsjson.js';
import { listAssignments } from './assignments.js';
import { projectName } from './project.js';

const TASK_KIND = 'run';

function timeMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function nullableString(value) {
  return typeof value === 'string' && value ? value : null;
}

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function durationMs(entry, startedAt, endedAt) {
  const recorded = finiteNumber(entry?.durationMs);
  if (recorded != null && recorded >= 0) return recorded;
  // `wallSec` is the measured worker interval on the legacy decision-log
  // shape. Prefer it over timestamps, whose ISO precision can be coarser.
  const wallSec = finiteNumber(entry?.wallSec);
  if (wallSec != null && wallSec >= 0) return wallSec * 1000;
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  if (start != null && end != null && end >= start) return end - start;
  return null;
}

function projectOf(entry) {
  const recorded = nullableString(entry?.project) ?? nullableString(entry?.projectName);
  if (recorded) return recorded;
  const cwd = nullableString(entry?.cwd);
  return cwd ? projectName(cwd) : null;
}

function taskRow(record) {
  return {
    id: nullableString(record?.id),
    lane: nullableString(record?.lane),
    pool: nullableString(record?.pool ?? record?.picked),
    model: nullableString(record?.model),
    project: projectOf(record),
    startedAt: nullableString(record?.startedAt),
    taskFile: nullableString(record?.taskFile),
    // The out file is the row's only pointer at what the worker actually
    // wrote, and the two surfaces spell it differently: an assignment and the
    // CLI decision log write `outFile`, the workflow attempt shape writes
    // `outputFile`. Both normalize to `outFile` here so the Runs task pane has
    // one field to render; null when the record predates the field.
    outFile: nullableString(record?.outFile ?? record?.outputFile),
    // Same spelling as a workflow attempt: the persisted JSONL capture, or
    // null on records that predate single-task stream persistence.
    streamFile: nullableString(record?.streamFile ?? record?.eventStream ?? record?.streamPath ?? record?.stream),
  };
}

function isRunEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  // `kind` is the new explicit discriminator. `source` keeps entries written
  // during the transition readable, and the final fallback recognizes the
  // pre-kind CLI shape (picked + outFile) without claiming workflow-v2 rows.
  if (entry.kind === TASK_KIND || entry.source === TASK_KIND) return true;
  return entry.source == null && entry.picked != null && entry.outFile != null;
}

function eventTime(entry) {
  return timeMs(entry?.endedAt) ?? timeMs(entry?.finishedAt)
    ?? timeMs(entry?.startedAt) ?? timeMs(entry?.ts);
}

function sinceAllows(entry, sinceMs) {
  if (sinceMs == null) return true;
  const event = eventTime(entry);
  // Older entries can lack every lifecycle timestamp. Keeping them is the
  // only honest tolerant behavior: absence cannot prove they predate `since`.
  return event == null || event >= sinceMs;
}

function finishedRow(entry) {
  const row = taskRow(entry);
  const endedAt = nullableString(entry?.endedAt ?? entry?.finishedAt ?? entry?.ts);
  const reasonValue = entry && Object.hasOwn(entry, 'reason')
    ? entry.reason
    : entry?.ok === false ? entry.why : null;
  return {
    ...row,
    endedAt,
    ok: nullableBoolean(entry?.ok),
    reason: nullableString(reasonValue),
    durationMs: durationMs(entry, row.startedAt, endedAt),
  };
}

/**
 * List single-task work from a Bullswarm home.
 *
 * @param {{home?: string, since?: string|number|Date, now?: string|number|Date}} options
 * @returns {{inflight: object[], finished: object[]}}
 */
export function listTasks({ home, since = null, now = Date.now() } = {}) {
  if (typeof home !== 'string' || !home) return { inflight: [], finished: [] };
  const sinceMs = timeMs(since);
  const nowMs = timeMs(now) ?? Date.now();

  const inflight = listAssignments(home, { now: nowMs })
    .filter((record) => record?.source === TASK_KIND)
    .map(taskRow)
    .sort((a, b) => (timeMs(b.startedAt) ?? -Infinity) - (timeMs(a.startedAt) ?? -Infinity));

  const state = readJsonSafe(join(home, 'state.json'), null);
  const entries = Array.isArray(state?.decisionLog) ? state.decisionLog : [];
  const finished = entries
    .filter((entry) => isRunEntry(entry) && sinceAllows(entry, sinceMs))
    .map(finishedRow)
    .sort((a, b) => {
      const at = timeMs(a.endedAt) ?? timeMs(a.startedAt) ?? -Infinity;
      const bt = timeMs(b.endedAt) ?? timeMs(b.startedAt) ?? -Infinity;
      return bt - at;
    });

  return { inflight, finished };
}
