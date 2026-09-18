// Per-run rollup: the one record the dashboard reads instead of rescanning
// every run.
//
// Measured on this machine 2026-09-16: `listRuns` parses 293 state.json files
// (22 MB) in about 100 ms, against the dashboard's 1,000 ms refresh timer.
// Home, Stats and History cannot afford that every second, so each finished
// run writes one small record — `<runDir>/rollup.json` — and appends it to an
// append-only index at `~/.bullswarm/history/runs.jsonl`. Reading the index
// is one file and one pass.
//
// Doctrine:
//   R1. rollupRecord() is pure. No filesystem, no clock beyond the injected
//       `now`, no git. Everything it cannot read from the state and the
//       result envelope it hands back as null.
//   R2. Money is never guessed. `costUsd` is the sum of the estimates the run
//       actually recorded on its attempts; a run that recorded none gets
//       null, never 0. Zero-for-unknown is how a dashboard invents spend.
//   R3. Legacy pre-0.27.0 runs have no V2 state.json, so their record is
//       minimal: identity, the times the run's own files prove, the status it
//       recorded, no cost and no pool minutes. `legacy: true` is what marks
//       one; a record this module builds from V2 state says `legacy: false`.
//       The times come from readLegacyRunFacts — report.json, then
//       state.json, then the run directory's own file times — and never from
//       the clock, so writing the record cannot move what it records.
//   R4. The index is idempotent by runId. Finishing, reopening and finishing
//       again, or re-running `workflow reindex`, leaves exactly one line per
//       run — the newest one.

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync, readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';
import { projectName } from '../lib/project.js';
import { readGoalProject } from './goal.js';

export const ROLLUP_SCHEMA_VERSION = 'bullswarm.workflow.rollup.v1';

const MINUTE_MS = 60_000;
const DURATION_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function round(value, places) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Number(null) is 0 and Number(false) is 0. A recorded `estimatedUsd: null`
// means "this run measured no cost" and must stay null all the way to the
// screen (R2), so every numeric read goes through here rather than through a
// bare Number() that would silently coin a zero.
function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A time bound may be an ISO string, a Date, epoch milliseconds, or a
// relative duration ('7d', '24h') measured back from `now` — the same
// vocabulary `workflow runs --since` already accepts.
export function toBoundMs(bound, now = Date.now()) {
  if (bound == null) return null;
  if (bound instanceof Date) return Number.isFinite(bound.getTime()) ? bound.getTime() : null;
  if (typeof bound === 'number') return Number.isFinite(bound) ? bound : null;
  const text = String(bound).trim();
  if (!text) return null;
  const duration = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(text);
  if (duration) return now - Number(duration[1]) * DURATION_MS[duration[2].toLowerCase()];
  return parseIso(text);
}

// Attempts carry their pool, model, wall seconds, and whatever usage the
// dispatcher recorded. `null` pool/model keys land under 'unknown', which is
// what src/workflow/v2-runtime.js addUsage() already does for pool totals.
function attemptTotals(attempts) {
  const pools = {};
  const models = {};
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || typeof attempt !== 'object') continue;
    const poolKey = attempt.pool ?? 'unknown';
    const modelKey = attempt.model ?? 'unknown';
    const wallSec = finiteNumber(attempt.wallSec);
    const minutes = wallSec != null && wallSec >= 0 ? wallSec / 60 : null;
    const costUsd = finiteNumber(attempt.usage?.cost?.estimatedUsd);
    const tokens = finiteNumber(attempt.usage?.tokens?.totalKnown);

    const pool = pools[poolKey] ??= { attempts: 0, minutes: null, costUsd: null, tokens: null };
    pool.attempts += 1;
    if (minutes != null) pool.minutes = (pool.minutes ?? 0) + minutes;
    // R2: only an attempt that recorded an estimate moves the money.
    if (costUsd != null) pool.costUsd = (pool.costUsd ?? 0) + costUsd;
    if (tokens != null) pool.tokens = (pool.tokens ?? 0) + tokens;

    const model = models[modelKey] ??= { attempts: 0, minutes: null };
    model.attempts += 1;
    if (minutes != null) model.minutes = (model.minutes ?? 0) + minutes;
  }
  for (const pool of Object.values(pools)) {
    pool.minutes = round(pool.minutes, 2);
    pool.costUsd = round(pool.costUsd, 6);
    pool.tokens = pool.tokens == null ? null : Math.round(pool.tokens);
  }
  for (const model of Object.values(models)) model.minutes = round(model.minutes, 2);
  return { pools, models };
}

// The result envelope is the authority on requirements when it exists; a run
// finalized before this module shipped, or one whose envelope is gone, falls
// back to the durable ledger.
function requirementTotals(state, result) {
  const fromResult = Array.isArray(result?.requirements) ? result.requirements : null;
  if (fromResult) {
    return { passed: fromResult.filter((entry) => entry?.status === 'passed').length, total: fromResult.length };
  }
  const ledger = state?.ledger?.requirements;
  if (ledger && typeof ledger === 'object') {
    const entries = Object.values(ledger);
    return { passed: entries.filter((entry) => entry?.status === 'passed').length, total: entries.length };
  }
  const intent = Array.isArray(state?.intent?.requirements) ? state.intent.requirements : [];
  return { passed: 0, total: intent.length };
}

/**
 * The durable record for one finished run. Pure (R1).
 *
 * @param {object} state   the V2 durable state
 * @param {object|null} result  the stable result envelope, when one exists
 * @param {{project?: string|null, now?: number}} [options]
 */
export function rollupRecord(state, result, { project = null, now = Date.now() } = {}) {
  const lifecycle = state?.lifecycle ?? {};
  const startedAtMs = parseIso(lifecycle.startedAt);
  const finishedAt = lifecycle.finishedAt ?? result?.finishedAt ?? isoOf(now);
  const finishedAtMs = parseIso(finishedAt);
  const agentSeconds = finiteNumber(state?.budget?.seconds);
  const { pools, models } = attemptTotals(state?.attempts);
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId: state?.runId ?? result?.runId ?? null,
    shortId: state?.shortId ?? result?.shortId ?? null,
    project: project ?? null,
    goal: state?.intent?.goal ?? result?.goal ?? null,
    cwd: state?.intent?.cwd ?? null,
    startedAt: lifecycle.startedAt ?? null,
    finishedAt: finishedAt ?? null,
    status: result?.status ?? lifecycle.status ?? null,
    verified: result?.verified === true,
    requirements: requirementTotals(state, result),
    minutes: {
      wall: startedAtMs != null && finishedAtMs != null ? round((finishedAtMs - startedAtMs) / MINUTE_MS, 2) : null,
      agent: agentSeconds != null && agentSeconds >= 0 ? round(agentSeconds / 60, 2) : null,
    },
    pools,
    models,
    legacy: false,
  };
}

export function rollupPath(runDir) {
  return join(runDir, 'rollup.json');
}

/** The record a run directory holds, or null when it has none (or a foreign one). */
export function readRollup(runDir) {
  const record = readJsonSafe(rollupPath(runDir), null);
  if (!record || typeof record !== 'object') return null;
  if (record.schemaVersion !== ROLLUP_SCHEMA_VERSION) return null;
  return record;
}

export function rollupIndexPath(bullswarmDir) {
  return join(bullswarmDir, 'history', 'runs.jsonl');
}

// <bullswarmDir>/workflows/<runId> → <bullswarmDir>
export function bullswarmDirOfRun(runDir) {
  return dirname(dirname(runDir));
}

function readIndexLines(bullswarmDir) {
  const path = rollupIndexPath(bullswarmDir);
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseIndexLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && record.runId ? record : null;
  } catch {
    // A torn final line (a writer mid-append) is skipped, not fatal: the
    // index is an accelerator, and the run directory still holds the truth.
    return null;
  }
}

/** Every record in the index, oldest line first, one per runId (R4). */
export function readRollupIndex(bullswarmDir) {
  const byId = new Map();
  for (const line of readIndexLines(bullswarmDir)) {
    const record = parseIndexLine(line);
    if (record) byId.set(record.runId, record);
  }
  return [...byId.values()];
}

/**
 * Append one record to the history index, idempotently by runId (R4).
 *
 * @returns {{runId: string, appended: boolean, replaced: boolean}}
 */
export function appendRollupIndex(bullswarmDir, record) {
  if (!record?.runId) throw new TypeError('a rollup record needs a runId to be indexed');
  const path = rollupIndexPath(bullswarmDir);
  const line = JSON.stringify(record);
  const lines = readIndexLines(bullswarmDir);
  const existing = lines.filter((entry) => parseIndexLine(entry)?.runId === record.runId);
  if (existing.length === 1 && existing[0] === line) {
    return { runId: record.runId, appended: false, replaced: false };
  }
  if (existing.length) {
    // Rewrite: one line per run, the newest wins. Atomic, so a concurrent
    // reader never sees a half-written index.
    const kept = lines.filter((entry) => parseIndexLine(entry)?.runId !== record.runId);
    atomicWriteFileSync(path, `${[...kept, line].join('\n')}\n`);
    return { runId: record.runId, appended: true, replaced: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  // A single line under the pipe-buffer size appends atomically, so two
  // kernels finishing at once cannot interleave their records.
  appendFileSync(path, `${line}\n`);
  return { runId: record.runId, appended: true, replaced: false };
}

/**
 * Write `<runDir>/rollup.json` and append it to the history index.
 *
 * The project is whatever the run recorded at goal time; a run that predates
 * that recording resolves it from its cwd instead.
 */
export function writeRunRollup(runDir, state, result, { now = Date.now(), project } = {}) {
  const cwd = state?.intent?.cwd ?? null;
  const resolvedProject = project !== undefined
    ? project
    : (readGoalProject(runDir)?.name ?? (cwd ? projectName(cwd) : null));
  const record = rollupRecord(state, result, { project: resolvedProject, now });
  writeJsonAtomic(rollupPath(runDir), record);
  appendRollupIndex(bullswarmDirOfRun(runDir), record);
  return record;
}

// ------------------------------------------------------- legacy run records
//
// A pre-0.27.0 run directory has no V2 state: no lifecycle, no attempts, no
// requirement ledger. It is still a workflow the History timeline has to
// carry, so it gets one minimal record and nothing more. Where V2 state is
// silent, the record is null — never 0, never a guessed cost, never a pool
// minute. Its `goal` is the workflow name the run recorded, because that is
// the label the run itself left behind.

function isoFrom(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isoOfMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The run directory's files, except the rollup this module writes into it: a
// record may not be its own evidence of when the run finished, or writing it
// would move the time it records and break idempotency (R4).
function ownFileTimes(runDir) {
  let oldest = null;
  let newest = null;
  let names;
  try { names = readdirSync(runDir); } catch { return { oldest, newest }; }
  for (const name of names) {
    if (name === 'rollup.json') continue;
    let stat;
    try { stat = statSync(join(runDir, name)); } catch { continue; }
    if (!stat.isFile() || !Number.isFinite(stat.mtimeMs)) continue;
    if (oldest == null || stat.mtimeMs < oldest) oldest = stat.mtimeMs;
    if (newest == null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return { oldest, newest };
}

/**
 * What a legacy run directory can prove about itself, read from the files it
 * holds. `timeSource` names which one answered each time — `report` (the run's
 * own summary), `state` (the little its state.json recorded), `directory` (the
 * file times, the last resort), or `a+b` when the two times came from
 * different places — so a caller never has to guess how firm a time is. A
 * directory with no readable time at all reports nulls, not `now`.
 */
export function readLegacyRunFacts(runDir, { runId = null, shortId = null, project } = {}) {
  const report = readJsonSafe(join(runDir, 'report.json'), null);
  const state = readJsonSafe(join(runDir, 'state.json'), null);
  const reportStart = isoFrom(report?.startedAt);
  const reportFinish = isoFrom(report?.finishedAt);
  const stateStart = isoFrom(state?.startedAt);
  const stateFinish = isoFrom(state?.finishedAt);
  const needsFileTimes = (reportStart == null && stateStart == null)
    || (reportFinish == null && stateFinish == null);
  const times = needsFileTimes ? ownFileTimes(runDir) : { oldest: null, newest: null };
  const sourceOf = (inReport, inState) => (inReport ? 'report' : inState ? 'state' : 'directory');
  const startSource = sourceOf(reportStart != null, stateStart != null);
  const finishSource = sourceOf(reportFinish != null, stateFinish != null);
  const resolvedProject = project !== undefined ? project : (readGoalProject(runDir)?.name ?? null);
  return {
    runId,
    shortId: report?.shortId ?? state?.shortId ?? shortId ?? null,
    project: resolvedProject ?? null,
    // The label the run itself left: the workflow name — a bare string in the
    // earliest runs, an object later, exactly as short-id.js reads it for a
    // read-only row — else whatever goal it recorded. Never a cost.
    goal: report?.workflow
      ?? state?.name
      ?? (typeof state?.workflow === 'string' ? state.workflow : state?.workflow?.name)
      ?? state?.goal
      ?? report?.goal
      ?? null,
    status: report?.status ?? state?.status ?? null,
    startedAt: reportStart ?? stateStart ?? isoOfMs(times.oldest),
    finishedAt: reportFinish ?? stateFinish ?? isoOfMs(times.newest),
    timeSource: startSource === finishSource ? startSource : `${startSource}+${finishSource}`,
  };
}

/**
 * The minimal, durable record for a legacy run directory (R3). Pure: it shapes
 * the facts a reader resolved and reads nothing itself.
 *
 * `requirements` is 0 passed of 0 recorded — a legacy run left no ledger, and
 * a fabricated total would read as requirements that failed. `minutes.wall` is
 * the interval between the two times the run itself recorded, and only when
 * both came from the same one: a file time says when a file was last written,
 * which is not the moment the run stopped, so subtracting it from a recorded
 * start would report a duration the run never had. `pools` and `models` are
 * empty: no attempt was ever measured for this run.
 */
export function legacyRollupRecord(facts = {}) {
  const startedAt = isoFrom(facts.startedAt);
  const finishedAt = isoFrom(facts.finishedAt);
  const startedMs = Date.parse(startedAt ?? '');
  const finishedMs = Date.parse(finishedAt ?? '');
  const wallMinutes = (facts.timeSource === 'report' || facts.timeSource === 'state')
    && Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
    ? round((finishedMs - startedMs) / MINUTE_MS, 2)
    : null;
  return {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId: facts.runId ?? null,
    shortId: facts.shortId ?? null,
    project: facts.project ?? null,
    goal: facts.goal ?? null,
    cwd: null,
    startedAt,
    finishedAt,
    status: facts.status ?? null,
    verified: false,
    requirements: { passed: 0, total: 0 },
    minutes: { wall: wallMinutes, agent: null },
    pools: {},
    models: {},
    legacy: true,
    timeSource: facts.timeSource ?? null,
  };
}

/**
 * Write `<runDir>/rollup.json` for a legacy run and append it to the history
 * index. The record is derived from the directory's own files only, so running
 * it twice produces the same line and the index reports it as present (R4).
 */
export function writeLegacyRollup(runDir, { runId = null, shortId = null, project } = {}) {
  const record = legacyRollupRecord(readLegacyRunFacts(runDir, { runId, shortId, project }));
  writeJsonAtomic(rollupPath(runDir), record);
  appendRollupIndex(bullswarmDirOfRun(runDir), record);
  return record;
}

// Fallback path only (see readRollups): reads `rollup.json` out of every run
// directory. This never opens a state.json, so it costs a stat and a small
// read per directory rather than the 22 MB `listRuns` parses.
function scanRunDirRollups(bullswarmDir) {
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return [];
  let names;
  try { names = readdirSync(runsRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith('wf-')) continue;
    const dir = join(runsRoot, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const record = readRollup(dir);
    if (record) out.push(record);
  }
  return out;
}

function recordTimeMs(record) {
  return parseIso(record?.finishedAt) ?? parseIso(record?.startedAt);
}

/**
 * Records newest first.
 *
 * Reads the index. Falls back to the run directories when the index is empty,
 * or when the caller asks for a window that starts before the oldest indexed
 * run — the case where a run finished before the index existed.
 *
 * @param {string} bullswarmDir
 * @param {{since?: *, until?: *, limit?: number|null, now?: number}} [options]
 *        `since` is inclusive, `until` exclusive; both accept an ISO string,
 *        a Date, epoch milliseconds, or a relative duration such as '7d'.
 */
export function readRollups(bullswarmDir, { since = null, until = null, limit = null, now = Date.now() } = {}) {
  const indexed = readRollupIndex(bullswarmDir);
  const byId = new Map(indexed.map((record) => [record.runId, record]));
  const sinceMs = toBoundMs(since, now);
  const untilMs = toBoundMs(until, now);

  const indexedTimes = indexed.map(recordTimeMs).filter((ms) => ms != null);
  const oldestIndexed = indexedTimes.length ? Math.min(...indexedTimes) : null;
  // The fallback is deliberately narrow. An empty index means nothing has
  // been recorded yet, and a window that opens before the oldest indexed run
  // is asking for history the index may not carry. An unbounded read trusts
  // the index instead of scanning: `bullswarm workflow reindex` is what makes
  // the index complete, and the whole point of this module is that the
  // dashboard's 1 s refresh reads one file.
  const needsFallback = indexed.length === 0
    || oldestIndexed == null
    || (sinceMs != null && sinceMs < oldestIndexed);
  if (needsFallback) {
    for (const record of scanRunDirRollups(bullswarmDir)) {
      if (!byId.has(record.runId)) byId.set(record.runId, record);
    }
  }

  const records = [...byId.values()].filter((record) => {
    const ms = recordTimeMs(record);
    if (sinceMs != null && (ms == null || ms < sinceMs)) return false;
    if (untilMs != null && (ms == null || ms >= untilMs)) return false;
    return true;
  });
  records.sort((a, b) => (recordTimeMs(b) ?? 0) - (recordTimeMs(a) ?? 0));
  return Number.isInteger(limit) && limit > 0 ? records.slice(0, limit) : records;
}
