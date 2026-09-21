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

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

function taskText(record, home) {
  if (typeof record?.taskText === 'string' && record.taskText.trim()) return record.taskText;
  const path = nullableString(record?.taskFile);
  if (!path) return null;
  const candidates = [path, home ? join(home, 'runs', basename(path)) : null].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      // Task prompts are bounded at write time. Keep a defensive display-side
      // ceiling so a corrupt ledger pointer cannot make the dashboard ingest
      // an arbitrary large file.
      const text = readFileSync(candidate, 'utf8').slice(0, 256 * 1024);
      return text.trim() || null;
    } catch { /* a legacy or disappearing task file remains displayable */ }
  }
  return null;
}

function taskRow(record, home) {
  const usage = record?.usage && typeof record.usage === 'object' ? record.usage : null;
  const prompt = taskText(record, home);
  const amount = finiteNumber(record?.apiEquivalentUsd
    ?? record?.apiUsd
    ?? record?.costUsd
    ?? usage?.api?.usd
    ?? usage?.cost?.estimatedUsd);
  const tokenSource = nullableString(record?.tokenSource ?? usage?.tokenSource);
  return {
    id: nullableString(record?.id),
    lane: nullableString(record?.lane),
    pool: nullableString(record?.pool ?? record?.picked),
    model: nullableString(record?.model),
    project: projectOf(record),
    startedAt: nullableString(record?.startedAt),
    taskFile: nullableString(record?.taskFile),
    ...(prompt == null ? {} : { taskText: prompt }),
    ...(usage == null ? {} : { usage }),
    ...(amount == null ? {} : { apiEquivalentUsd: amount }),
    ...(tokenSource == null ? {} : { tokenSource }),
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

function finishedRow(entry, home) {
  const row = taskRow(entry, home);
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

// One identity for a finished task row, used everywhere a task can arrive from
// two sources at once (the day's rows AND `tasks.finished`). A task recorded
// before the single-task ledger has neither `id` nor `taskFile`, so keying on
// those alone silently deduplicated nothing and every legacy task was listed
// and counted twice. The fallback is the tuple the decision log always has.
export function taskIdentity(task) {
  const id = task?.id ?? task?.taskFile;
  if (id != null && id !== '') return `id:${id}`;
  const at = task?.endedAt ?? task?.finishedAt ?? task?.ts ?? task?.startedAt ?? '';
  const pool = task?.pool ?? task?.picked ?? '';
  return `at:${at}|${pool}|${task?.lane ?? ''}|${task?.durationMs ?? ''}`;
}

/**
 * The id a task row opens by: its ledger id or task file, else the identity
 * tuple above. Never null: a row keyed `null` equalled the dashboard's "no
 * task selected", so Enter on a workflow row opened the first task that
 * predates the ledger instead (seen on the owner's home, 0.35.2).
 */
export function taskKey(task) {
  const id = task?.id ?? task?.taskFile;
  return id != null && id !== '' ? id : taskIdentity(task);
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
    .map((record) => taskRow(record, home))
    .sort((a, b) => (timeMs(b.startedAt) ?? -Infinity) - (timeMs(a.startedAt) ?? -Infinity));

  const state = readJsonSafe(join(home, 'state.json'), null);
  const entries = Array.isArray(state?.decisionLog) ? state.decisionLog : [];
  const finished = entries
    .filter((entry) => isRunEntry(entry) && sinceAllows(entry, sinceMs))
    .map((entry) => finishedRow(entry, home))
    .sort((a, b) => {
      const at = timeMs(a.endedAt) ?? timeMs(a.startedAt) ?? -Infinity;
      const bt = timeMs(b.endedAt) ?? timeMs(b.startedAt) ?? -Infinity;
      return bt - at;
    });

  return { inflight, finished };
}
