// The History page's day rollup.
//
// One row per calendar day, newest first, carrying every workflow: the records
// in the rollup index, plus the runs the index cannot hold yet. Finished
// single-task records may share those day rows as typed task entries. `listRuns` is
// never called here — it parses every state.json (measured 293 files, 22 MB,
// ~100 ms on this machine, 2026-09-16) to build a whole run list History does
// not need. The run directories are opened only where the index is silent (H6),
// and never for a run the index already names.
//
// Doctrine:
//   H1. The day boundary is the reader's own local zone, resolved at call
//       time from Intl.DateTimeFormat().resolvedOptions().timeZone. No
//       hard-coded zone, and no UTC "day" that puts a 6 pm run on tomorrow.
//   H2. `runs` counts the runs a day STARTED; `finished` counts the runs it
//       FINISHED. A run launched at 23:50 and delivered at 00:30 is one
//       started run yesterday and one finished run today. Verified counts and
//       spend attach to the day the run finished, because that is the day its
//       record exists.
//   H3. Spend is never invented. `spendUsd` is the sum of the estimates the
//       day's runs actually recorded; a day where no run recorded one is
//       null, not 0.
//   H4. Scroll-back stops at real history. Days are emitted consecutively so
//       an empty day still renders a row, but never past the oldest run on
//       record — 15 days of V2 history does not scroll into 2019.
//   H5. A day carries its own records in `rows`, newest last, so the page
//       that draws one workflow per line never has to re-derive which day a
//       run belongs to. The day a run is filed under is the day it FINISHED
//       (H2); a run still running is filed under the day it started, so it
//       is visible rather than absent.
//   H6. The index holds the runs that finished. History is a timeline of
//       every workflow, so the run directories the index does not name are
//       read too — a run still in flight has no record by definition, and a
//       home that has not been reindexed yet still has its finished runs.
//       After `workflow reindex` that set is the in-flight runs alone, and a
//       directory the index names is never opened: the index is the steady
//       state, the scan is the correction.
//   H7. The counts on a day are truthful and separate: `rows` is every
//       workflow filed there, `runs` every workflow that started there,
//       `finished` only the entries a finish time filed, and `legacyRows` /
//       `unfinishedRows` count what a row is. Nothing is counted twice.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe } from '../lib/fsjson.js';
import { projectName } from '../lib/project.js';
import { legacyRollupRecord, readLegacyRunFacts, readRollups, rollupRecord } from './rollup.js';
import { isLegacyRunState, isOngoing } from './short-id.js';
import { readGoalProject } from './goal.js';

const DAY_MS = 86_400_000;

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

// Building an Intl.DateTimeFormat costs about 0.1 ms, and a 181-run history
// asks for two day keys per run. The formatter is cached against the zone it
// was built for, so a zone change (a test pinning TZ, a laptop crossing a
// border) still rebuilds it rather than answering from the old one.
let formatterZone = null;
let formatter = null;
function dayFormatter() {
  const zone = localTimeZone();
  if (zone !== formatterZone) {
    formatterZone = zone;
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return formatter;
}

/**
 * 'YYYY-MM-DD' for an instant, in the resolved local zone (H1).
 *
 * @param {string|number|Date} iso  an ISO timestamp, epoch ms, or a Date
 * @returns {string|null} null when the instant cannot be read
 */
export function dayKey(iso) {
  const ms = iso instanceof Date ? iso.getTime()
    : typeof iso === 'number' ? iso
    : typeof iso === 'string' ? Date.parse(iso)
    : NaN;
  if (!Number.isFinite(ms)) return null;
  const parts = dayFormatter().formatToParts(new Date(ms));
  const field = (type) => parts.find((part) => part.type === type)?.value ?? null;
  const [year, month, day] = [field('year'), field('month'), field('day')];
  return year && month && day ? `${year}-${month}-${day}` : null;
}

// Calendar arithmetic on the key itself, so it never depends on a zone offset
// that a DST change moves underneath it.
function shiftDayKey(key, days) {
  const [year, month, day] = String(key).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function emptyDay(date) {
  return {
    date, runs: 0, finished: 0, verified: 0, verifiedShare: null, spendUsd: null,
    legacyRows: 0, unfinishedRows: 0, rows: [],
  };
}

/** A finished `bullswarm run` row is kept distinct from workflow history. */
function taskHistoryRow(task) {
  const recorded = typeof task?.project === 'string' && task.project.trim()
    ? task.project.trim()
    : typeof task?.projectName === 'string' && task.projectName.trim()
      ? task.projectName.trim()
      : null;
  const cwd = typeof task?.cwd === 'string' && task.cwd.trim() ? task.cwd.trim() : null;
  return {
    ...task,
    project: recorded ?? (cwd ? projectName(cwd) : null),
    kind: 'task',
    source: 'run',
  };
}

function recordSpendUsd(record) {
  const pools = record?.pools;
  if (!pools || typeof pools !== 'object') return null;
  let total = null;
  for (const pool of Object.values(pools)) {
    // `costUsd: null` means the run measured no cost. Number(null) is 0, so
    // a bare Number() here would quietly coin a zero-dollar day (H3).
    const cost = pool?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) total = (total ?? 0) + cost;
  }
  return total;
}

// Minutes between a recorded start and an instant, or null when either is
// unreadable. A run whose start is in the future (a clock that moved) reports
// no elapsed time rather than a negative one.
function elapsedMinutes(startedAt, untilMs) {
  const startMs = Date.parse(startedAt ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(untilMs)) return null;
  return Math.max(0, (untilMs - startMs) / 60_000);
}

function lastWriteIso(path) {
  try {
    const stat = statSync(path);
    return Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null;
  } catch { return null; }
}

// One run directory the index does not name, read the way its own kind has to
// be read (H6). Returns a finished record, a legacy record, an unfinished row,
// or null when the directory says nothing reliable.
/** `projectName(cwd)` runs `git`; within one rebuild, each cwd is asked once. */
function projectNameCached(cwd, cache) {
  if (!cache || cwd == null) return projectName(cwd);
  if (cache.has(cwd)) return cache.get(cwd);
  const name = projectName(cwd);
  cache.set(cwd, name);
  return name;
}

function uncoveredRun(bullswarmDir, name, now, projectByCwd = null) {
  const runDir = join(bullswarmDir, 'workflows', name);
  try { if (!statSync(runDir).isDirectory()) return null; } catch { return null; }
  const statePath = join(runDir, 'state.json');
  const hasState = existsSync(statePath);
  const state = hasState ? readJsonSafe(statePath, null) : null;
  // A state.json that will not parse is a writer mid-rename, not a legacy run:
  // 0.27.0's rule is that a torn read is never reported as history (short-id.js
  // isLegacyRunDir). Say nothing about it rather than file half a run.
  if (hasState && state == null) return null;

  if (!hasState || isLegacyRunState(state)) {
    // A legacy directory: exactly the minimal record `workflow reindex`
    // writes for it, from the same functions, so the two can never disagree.
    return legacyRollupRecord(readLegacyRunFacts(runDir, { runId: name }));
  }

  const shortId = state.shortId ?? null;
  // The same derivation `workflow reindex` uses (runs-cli.js projectFor): the
  // recorded goal project first, then the run's own working directory. A
  // finished run the index has not caught up with is named by its project,
  // never `unknown project`, when a cwd is on record.
  const project = readGoalProject(runDir)?.name
    ?? projectNameCached(state.intent?.cwd ?? null, projectByCwd);
  const startedAt = state.lifecycle?.startedAt ?? null;
  if (state.lifecycle?.finishedAt) {
    // Finished, and the index simply has not caught up (a home nothing has
    // reindexed yet). The record is built by the same pure function the
    // finish-time write and reindex call, so the row is the one they would
    // have written — never a finish time of our own, which is why `now` can
    // only reach a record whose state already carries the finish.
    const result = readJsonSafe(join(runDir, 'result.json'), null);
    return rollupRecord(state, result, { project, now });
  }
  // No finish time: the workflow exists but has not delivered, so it is filed
  // where it started (H5) and marked unfinished. `running` is the same
  // liveness question every other surface asks, so a kernel that died reports
  // stopped — with the last moment the run was written, which is a real
  // measurement of how long it lived, not an estimate of how long it ran.
  const running = isOngoing(runDir, state);
  const lastWriteAt = running ? null : lastWriteIso(statePath);
  const untilMs = running ? now : Date.parse(lastWriteAt ?? '');
  return {
    runId: name,
    shortId,
    project,
    goal: state.intent?.goal ?? null,
    startedAt,
    status: state.lifecycle?.status ?? null,
    legacy: false,
    unfinished: true,
    running,
    elapsedMinutes: elapsedMinutes(startedAt, untilMs),
    lastWriteAt,
  };
}

/**
 * Every run directory the index does not already name (H6). After
 * `workflow reindex` that is the runs still in flight; on a home nothing has
 * reindexed it is every run, which is why the index exists.
 */
function uncoveredRuns(bullswarmDir, indexedIds, now) {
  const runsRoot = join(bullswarmDir, 'workflows');
  let names;
  try { names = readdirSync(runsRoot); } catch { return []; }
  const rows = [];
  // The project name of an unindexed run comes from `git` in its working
  // directory; many runs share a directory, so each is asked once per rebuild.
  const projectByCwd = new Map();
  for (const name of names.sort()) {
    if (!name.startsWith('wf-') || indexedIds.has(name)) continue;
    const row = uncoveredRun(bullswarmDir, name, now, projectByCwd);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Day rows for the History page, newest first.
 *
 * @param {string} bullswarmDir
 * @param {{before?: string|null, days?: number, now?: number, tasks?: Array<object>}} [options]
 *        `before` is a 'YYYY-MM-DD' key (or any instant dayKey() accepts);
 *        the first row returned is strictly before it, which is how the page
 *        loads seven more days each time the reader nears the bottom.
 * @returns {Array<{date: string, runs: number, finished: number,
 *                  verified: number, verifiedShare: number|null,
 *                  spendUsd: number|null, legacyRows: number,
 *                  unfinishedRows: number, rows: Array<object>}>}
 */
export function historyDays(bullswarmDir, {
  before = null, days = 7, now = Date.now(), tasks = [],
} = {}) {
  const wanted = Number.isInteger(days) && days > 0 ? days : 7;
  const records = readRollups(bullswarmDir);
  const byDay = new Map();
  const dayOf = (date) => {
    let entry = byDay.get(date);
    if (!entry) { entry = emptyDay(date); byDay.set(date, entry); }
    return entry;
  };

  const indexed = new Set(records.map((record) => record?.runId).filter(Boolean));
  let oldest = null;
  for (const record of [...records, ...uncoveredRuns(bullswarmDir, indexed, now)]) {
    // An unfinished row has no finish time by definition, whatever it carries.
    const finishedDay = record.unfinished === true ? null : dayKey(record.finishedAt);
    const startedDay = dayKey(record.startedAt);
    if (startedDay) {
      dayOf(startedDay).runs += 1;
      if (!oldest || startedDay < oldest) oldest = startedDay;
    }
    if (finishedDay) {
      const day = dayOf(finishedDay);
      day.finished += 1;
      day.rows.push(record);
      if (record.verified === true) day.verified += 1;
      const spend = recordSpendUsd(record);
      if (spend != null) day.spendUsd = (day.spendUsd ?? 0) + spend;
      if (!oldest || finishedDay < oldest) oldest = finishedDay;
    } else if (startedDay) {
      // H5: a run with no finish time is still a workflow that day's reader
      // wants to see; it is filed where it started.
      dayOf(startedDay).rows.push(record);
    }
  }
  // Single tasks have no workflow rollup and must not affect workflow counts,
  // spend, or verification. They do share the day table, ordered by their
  // own endedAt timestamp alongside finished workflows.
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const endedDay = dayKey(task?.endedAt ?? task?.finishedAt);
    const startedDay = dayKey(task?.startedAt);
    const date = endedDay ?? startedDay;
    if (!date) continue;
    dayOf(date).rows.push(taskHistoryRow(task));
    if (!oldest || date < oldest) oldest = date;
  }
  if (!oldest) return [];

  const beforeKey = before == null ? null : (/^\d{4}-\d{2}-\d{2}$/.test(String(before)) ? String(before) : dayKey(before));
  const start = beforeKey ? shiftDayKey(beforeKey, -1) : dayKey(now);
  if (!start || start < oldest) return [];

  const rows = [];
  for (let date = start; date && date >= oldest && rows.length < wanted; date = shiftDayKey(date, -1)) {
    const day = byDay.get(date) ?? emptyDay(date);
    rows.push({
      ...day,
      // H3: a share of nothing is not 0%.
      verifiedShare: day.finished ? Math.round((day.verified / day.finished) * 10_000) / 10_000 : null,
      spendUsd: day.spendUsd == null ? null : Math.round(day.spendUsd * 1e6) / 1e6,
      // H7: counted from the rows themselves, so a header can never claim a
      // number the day does not hold.
      legacyRows: day.rows.filter((row) => row.legacy === true).length,
      unfinishedRows: day.rows.filter((row) => row.unfinished === true).length,
    });
  }
  return rows;
}
