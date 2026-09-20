// Width-independent data shaping for the Home page.
//
// Home owns the finished-today/task ledger projection and the per-pool
// accounting rows. Rendering stays in home-view.js; shared dashboard helpers
// remain shell-owned so the other pages keep their compatibility contract.

import { finiteOrNull } from '../lib/num.js';
import { dayKey } from './history.js';
import {
  TOKEN_SOURCE_RANK,
  tokenSourceOf,
  worstSubscriptionBasis,
  worstTokenSource,
} from './dashboard.js';
import { formatMoneyPair } from '../lib/usage-basis.js';

function taskToday(task, nowMs, { finished = false } = {}) {
  const at = finished ? (task?.endedAt ?? task?.finishedAt) : (task?.startedAt ?? task?.endedAt ?? task?.finishedAt);
  return dayKey(at) === dayKey(nowMs);
}

// `dayKey` deliberately uses the resolved local time zone and therefore goes
// through Intl. Home can receive hundreds of historical rollups, but an
// instant more than 27 hours from now cannot share today's local calendar
// date (including a DST-length day). Reject those cheaply before formatting.
function isToday(value, nowMs, today = dayKey(nowMs)) {
  const at = Date.parse(value ?? '');
  if (!Number.isFinite(at) || Math.abs(at - nowMs) > 27 * 60 * 60 * 1000) return false;
  return dayKey(at) === today;
}

// One identity for a finished task row, used everywhere a task can arrive from
// two sources at once (the day's rows AND `tasks.finished`). A task recorded
// before the single-task ledger has neither `id` nor `taskFile`, so keying on
// those alone silently deduplicated nothing and every legacy task was listed
// and counted twice. The fallback is the tuple the decision log always has.
function taskIdentity(task) {
  const id = task?.id ?? task?.taskFile;
  if (id != null && id !== '') return `id:${id}`;
  const at = task?.endedAt ?? task?.finishedAt ?? task?.ts ?? task?.startedAt ?? '';
  const pool = task?.pool ?? task?.picked ?? '';
  return `at:${at}|${pool}|${task?.lane ?? ''}|${task?.durationMs ?? ''}`;
}

function todayMinutesText(value) {
  const minutes = finiteOrNull(value);
  return minutes == null ? null : `${minutes.toFixed(1)}m`;
}

function todayMinutesNumberText(value) {
  const minutes = finiteOrNull(value);
  return minutes == null ? null : minutes.toFixed(1);
}

/** Return the first non-empty line from a list of human-authored labels. */
function firstMeaningfulLine(...values) {
  for (const value of values) {
    for (const line of String(value ?? '').split(/\r?\n/)) {
      const text = line.trim();
      if (text) return text;
    }
  }
  return null;
}

function recordState(record) {
  return record?.state ?? {};
}

/** A durable run status, including live rows that have not got a rollup yet. */
function runStatus(record) {
  const raw = record?.ongoing
    ? (record?.status ?? recordState(record)?.lifecycle?.status ?? 'running')
    : (record?.status ?? recordState(record)?.lifecycle?.status ?? null);
  const value = String(raw ?? '').trim().toLowerCase().replaceAll('_', ' ');
  if (!value && record?.ongoing) return 'running';
  if (value === 'succeeded' || value === 'success') return 'completed';
  if (value === 'complete' || value === 'finished') return 'completed';
  return value || '—';
}

/** The independent verification verdict is deliberately tri-state. */
function runVerdict(record) {
  if (record?.verified === true || record?.state?.outcome?.verified === true) return 'verified';
  if (record?.verified === false || record?.state?.outcome?.verified === false) return 'not verified';
  return '—';
}

function runName(record) {
  return firstMeaningfulLine(
    record?.goal,
    record?.state?.intent?.goal,
    record?.state?.intent?.description,
    record?.name,
    record?.state?.name,
    record?.shortId,
    record?.runId,
  ) ?? 'run';
}

function runProject(record) {
  return firstMeaningfulLine(
    record?.project,
    record?.state?.project,
    record?.state?.intent?.project,
    record?.state?.intent?.cwd && String(record.state.intent.cwd).split('/').filter(Boolean).at(-1),
    record?.cwd && String(record.cwd).split('/').filter(Boolean).at(-1),
  ) ?? '—';
}

function attemptIntervals(record, nowMs = Date.now()) {
  const state = recordState(record);
  const attempts = [
    ...(state?.preflight?.scout?.attempts ?? []),
    ...(state?.planner?.attempts ?? []),
    ...(state?.attempts ?? []),
    ...(record?.attempts ?? []),
  ];
  const seen = new Set();
  const intervals = [];
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object') continue;
    const key = attempt.id ?? `${attempt.actionId ?? ''}:${attempt.ordinal ?? ''}:${attempt.startedAt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Date.parse(attempt.startedAt ?? '');
    if (!Number.isFinite(start)) continue;
    const explicitEnd = Date.parse(attempt.finishedAt ?? attempt.endedAt ?? '');
    const wallSec = finiteOrNull(attempt.wallSec);
    const end = Number.isFinite(explicitEnd)
      ? explicitEnd
      : wallSec != null && wallSec >= 0 ? start + wallSec * 1000
        : record?.ongoing ? nowMs : null;
    if (!Number.isFinite(end) || end < start) continue;
    intervals.push([start, end]);
  }
  return intervals;
}

function unionMinutes(intervals) {
  if (!intervals.length) return null;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let start = sorted[0][0];
  let finish = sorted[0][1];
  let total = 0;
  for (const [nextStart, nextFinish] of sorted.slice(1)) {
    if (nextStart <= finish) {
      finish = Math.max(finish, nextFinish);
      continue;
    }
    total += finish - start;
    start = nextStart;
    finish = nextFinish;
  }
  total += finish - start;
  return total / 60_000;
}

function spanMinutes(record, intervals = attemptIntervals(record)) {
  const stored = finiteOrNull(record?.minutes?.span);
  if (stored != null && stored >= 0) return stored;
  if (intervals.length) return (Math.max(...intervals.map((entry) => entry[1])) - Math.min(...intervals.map((entry) => entry[0]))) / 60_000;
  const started = Date.parse(record?.startedAt ?? recordState(record)?.lifecycle?.startedAt ?? '');
  const finished = Date.parse(record?.finishedAt ?? recordState(record)?.lifecycle?.finishedAt ?? '');
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) return (finished - started) / 60_000;
  return finiteOrNull(record?.minutes?.wall);
}

/** Active minutes and the explicitly secondary wall span. */
function runMinutesInfo(record, nowMs = Date.now()) {
  const intervals = attemptIntervals(record, nowMs);
  const storedActive = finiteOrNull(record?.minutes?.active);
  const derivedActive = unionMinutes(intervals);
  const active = storedActive != null && storedActive >= 0
    ? storedActive
    : derivedActive;
  return {
    active,
    span: spanMinutes(record, intervals),
    label: 'active',
    intervals,
  };
}

function runStepCounts(record) {
  const state = recordState(record);
  const actions = Array.isArray(state.actions) ? state.actions : [];
  const definitions = Array.isArray(state.program?.actions) ? state.program.actions : [];
  const doneFromActions = actions.filter((action) => action?.status === 'succeeded').length;
  const totalFromActions = Math.max(actions.length, definitions.length);
  const done = finiteOrNull(record?.steps?.done ?? record?.stepsOk ?? record?.requirements?.passed ?? record?.state?.requirements?.passed);
  const total = finiteOrNull(record?.steps?.total ?? record?.stepsTotal ?? record?.requirements?.total ?? record?.state?.requirements?.total);
  return {
    done: done != null && done >= 0 ? done : totalFromActions ? doneFromActions : null,
    total: total != null && total >= 0 ? total : totalFromActions || null,
  };
}

function recordMoneyInput(record) {
  const info = recordCostInfo(record);
  const state = recordState(record);
  const attempts = [
    ...(state?.preflight?.scout?.attempts ?? []),
    ...(state?.planner?.attempts ?? []),
    ...(state?.attempts ?? []),
  ].filter((attempt) => attempt && typeof attempt === 'object');
  const attemptApi = attempts.map((attempt) => finiteOrNull(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd));
  const attemptSub = attempts.map((attempt) => finiteOrNull(attempt?.usage?.subscription?.usd));
  const directApi = finiteOrNull(record?.usage?.api?.usd ?? record?.usage?.cost?.estimatedUsd);
  const directSub = finiteOrNull(record?.usage?.subscription?.usd);
  const apiUsd = info.apiUsd != null ? info.apiUsd
    : directApi != null ? directApi
    : attempts.length && attemptApi.every((value) => value != null)
      ? attemptApi.reduce((sum, value) => sum + value, 0) : null;
  const subscriptionUsd = info.subscriptionUsd != null ? info.subscriptionUsd
    : directSub != null ? directSub
    : attempts.length && attemptSub.every((value) => value != null)
      ? attemptSub.reduce((sum, value) => sum + value, 0) : null;
  let tokenSource = info.tokenSource === 'unknown'
    ? tokenSourceOf(record?.usage?.tokenSource, apiUsd) : info.tokenSource;
  let subscriptionBasis = info.subscriptionBasis === 'unknown:no-meter'
    ? (record?.usage?.subscriptionBasis ?? record?.usage?.subscription?.basis ?? 'unknown:no-meter') : info.subscriptionBasis;
  let subscriptionDeltaPct = info.subscription?.deltaPct
    ?? finiteOrNull(record?.usage?.subscriptionDeltaPct ?? record?.usage?.subscription?.deltaPct);
  let subscriptionWindow = info.subscription?.window
    ?? record?.usage?.subscriptionWindow ?? record?.usage?.subscription?.window ?? null;
  for (const attempt of attempts) {
    tokenSource = worstTokenSource(tokenSource, tokenSourceOf(attempt?.usage?.tokenSource, finiteOrNull(attempt?.usage?.api?.usd)));
    if (attempt?.usage?.subscription?.basis) subscriptionBasis = worstSubscriptionBasis(subscriptionBasis, attempt.usage.subscription.basis);
    const delta = finiteOrNull(attempt?.usage?.subscription?.deltaPct);
    if (delta != null) subscriptionDeltaPct = (subscriptionDeltaPct ?? 0) + delta;
    subscriptionWindow ??= attempt?.usage?.subscription?.window ?? null;
  }
  return {
    api: { usd: apiUsd, tokenSource },
    subscription: {
      usd: subscriptionUsd,
      deltaPct: subscriptionDeltaPct,
      window: subscriptionWindow,
      basis: subscriptionBasis,
    },
    tokenSource,
    tokens: record?.usage?.tokens ?? null,
  };
}

/** The shared formatter is the source of truth for every Home card money pair. */
function recordMoneyPair(record) {
  const input = recordMoneyInput(record);
  return { ...input, text: formatMoneyPair(input) };
}

function isActiveRun(record) {
  const status = runStatus(record);
  return record?.ongoing === true || ['running', 'active', 'planning', 'queued', 'waiting', 'paused'].includes(status);
}

function runIdentity(record) {
  const value = record?.runId ?? record?.shortId;
  return value == null ? null : String(value);
}

/** Build today's top-run cards: live rows first, then newest finished rows. */
function todayTopRuns(model, nowMs = Date.now(), { limit = 3 } = {}) {
  const date = dayKey(nowMs);
  const byId = new Map();
  const active = [];
  const finished = [];
  const add = (record, bucket) => {
    if (!record || record.kind === 'task' || record.task === true) return;
    const id = runIdentity(record) ?? `${record.startedAt ?? ''}:${record.finishedAt ?? ''}:${record.goal ?? ''}`;
    if (byId.has(id)) return;
    byId.set(id, record);
    bucket.push(record);
  };
  for (const record of model.runs ?? []) if (isActiveRun(record)) add(record, active);
  for (const record of model.rollups ?? []) {
    if (isActiveRun(record)) add(record, active);
    else if (isToday(record?.finishedAt ?? recordState(record)?.lifecycle?.finishedAt, nowMs, date)) add(record, finished);
  }
  // A caller can provide today's rows without a rollup index (for example, a
  // static page rendered while the index is being written).
  const day = (model.days ?? []).find((entry) => String(entry?.date) === date);
  for (const record of day?.rows ?? []) {
    if (record?.kind === 'task' || record?.task === true) continue;
    if (isActiveRun(record)) add(record, active);
    else if (isToday(record?.finishedAt, nowMs, date)) add(record, finished);
  }
  const newest = (a, b) => String(b?.finishedAt ?? b?.startedAt ?? '').localeCompare(String(a?.finishedAt ?? a?.startedAt ?? ''));
  active.sort((a, b) => String(b?.startedAt ?? recordState(b)?.lifecycle?.startedAt ?? '').localeCompare(String(a?.startedAt ?? recordState(a)?.lifecycle?.startedAt ?? '')));
  finished.sort(newest);
  return [...active, ...finished].slice(0, Math.max(0, Number(limit) || 0)).map((record) => {
    const minutes = runMinutesInfo(record, nowMs);
    const steps = runStepCounts(record);
    return {
      record,
      id: runIdentity(record),
      name: runName(record),
      project: runProject(record),
      status: runStatus(record),
      verdict: runVerdict(record),
      minutes,
      steps,
      money: recordMoneyPair(record),
      active: isActiveRun(record),
    };
  });
}

/** A task's measured duration, without turning a missing field into zero. */
function measuredTaskMinutes(task) {
  const duration = finiteOrNull(task?.durationMs);
  if (duration != null && duration >= 0) return duration / 60_000;
  const wallSec = finiteOrNull(task?.wallSec);
  if (wallSec != null && wallSec >= 0) return wallSec / 60;
  const started = Date.parse(task?.startedAt ?? '');
  const ended = Date.parse(task?.endedAt ?? task?.finishedAt ?? '');
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) return (ended - started) / 60_000;
  return null;
}

function todayDateLabel(value, { year = false } = {}) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : dayKey(value);
  if (!key) return 'today';
  const [yyyy, mm, dd] = key.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dd} ${months[mm - 1] ?? ''}${year ? ` ${yyyy}` : ''}`.trim();
}

function todayRows(model, nowMs) {
  const date = dayKey(nowMs);
  const day = (model.days ?? []).find((entry) => String(entry?.date) === date) ?? null;
  const workflows = [];
  const workflowIds = new Set();
  const addWorkflow = (record) => {
    if (!record || record.kind === 'task' || record.task === true) return;
    if (record.unfinished === true || !record.finishedAt || !isToday(record.finishedAt, nowMs, date)) return;
    const id = record.runId ?? record.shortId;
    if (id != null && workflowIds.has(id)) return;
    if (id != null) workflowIds.add(id);
    workflows.push(record);
  };
  for (const record of day?.rows ?? []) addWorkflow(record);
  // A caller may render a model without asking History for a day page first;
  // the rollup index is the same durable source and fills that pure-rendering
  // case without scanning workflow directories.
  for (const record of model.rollups ?? []) addWorkflow(record);

  const tasks = [];
  const taskIds = new Set();
  const addTask = (task) => {
    if (!task || !taskToday(task, nowMs, { finished: true })) return;
    const id = taskIdentity(task);
    if (taskIds.has(id)) return;
    taskIds.add(id);
    tasks.push(task);
  };
  for (const row of day?.rows ?? []) {
    if (row?.kind === 'task' || row?.task === true) addTask(row);
  }
  for (const task of model.tasks?.finished ?? []) addTask(task);
  return { date, workflows, tasks };
}

function poolRatePerMinute(pool, budgetRow = null) {
  return finiteOrNull(pool?.spend?.pacing?.ratePerMinute
    ?? pool?.ratePerMinute
    ?? budgetRow?.share?.ratePerMinute);
}

function todayLicenceRows(model, today, nowMs) {
  const byName = new Map();
  const ensure = (name) => {
    if (!name) return null;
    if (!byName.has(name)) byName.set(name, {
      name, workflowMinutes: null, runMinutes: null, apiUsd: null,
      subscriptionUsd: null, subscriptionBasis: null, subscriptionDeltaPct: null,
      subscriptionWindow: null, tokenSource: null,
      apiUnknown: false, subscriptionUnknown: false,
      worked: false, ratePerMinute: null, usedPct: null,
    });
    return byName.get(name);
  };
  const addMinutes = (row, key, value) => {
    const number = finiteOrNull(value);
    if (number == null || number < 0) return;
    row[key] = (row[key] ?? 0) + number;
  };
  for (const record of today.workflows) {
    for (const [name, entry] of Object.entries(record?.pools ?? {})) {
      const row = ensure(name);
      if (!row) continue;
      row.worked = true;
      addMinutes(row, 'workflowMinutes', entry?.minutes);
      const cost = finiteOrNull(entry?.costUsd);
      if (cost != null) row.apiUsd = (row.apiUsd ?? 0) + cost;
      else row.apiUnknown = true;
      const subscription = finiteOrNull(entry?.subscriptionUsd);
      if (subscription != null) row.subscriptionUsd = (row.subscriptionUsd ?? 0) + subscription;
      else row.subscriptionUnknown = true;
      const deltaPct = finiteOrNull(entry?.subscriptionDeltaPct);
      if (deltaPct != null) row.subscriptionDeltaPct = (row.subscriptionDeltaPct ?? 0) + deltaPct;
      if (entry?.subscriptionWindow) {
        row.subscriptionWindow = row.subscriptionWindow == null || row.subscriptionWindow === entry.subscriptionWindow
          ? entry.subscriptionWindow : null;
      }
      if (entry?.subscriptionBasis) row.subscriptionBasis = worstSubscriptionBasis(row.subscriptionBasis, entry.subscriptionBasis);
      row.tokenSource = worstTokenSource(row.tokenSource, tokenSourceOf(entry?.tokenSource, cost));
    }
  }
  for (const task of today.tasks) {
    const row = ensure(task?.pool);
    if (!row) continue;
    row.worked = true;
      addMinutes(row, 'runMinutes', measuredTaskMinutes(task));
  }

  const budgetRows = new Map((model.budget?.rows ?? []).map((row) => [row.name, row]));
  const pools = Array.isArray(model.pools) ? model.pools : [];
  for (const pool of pools) {
    const row = byName.get(pool?.name);
    if (!row) continue;
    row.ratePerMinute = poolRatePerMinute(pool, budgetRows.get(pool.name));
    row.usedPct = finiteOrNull(pool?.usedPct);
  }
  for (const row of byName.values()) {
    row.ratePerMinute ??= poolRatePerMinute(null, budgetRows.get(row.name));
  }

  // Keep the provider/config order stable (the frame is a report, not a
  // ranking), then append a pool that was recorded by a rollup but is absent
  // from the current live meter list.
  const order = new Map(pools.map((pool, index) => [pool?.name, index]));
  return [...byName.values()]
    .filter((row) => row.worked)
    .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)
      || String(a.name).localeCompare(String(b.name)))
    .map((row) => {
      const output = {
        ...row,
        apiUsd: row.apiUnknown ? null : row.apiUsd,
        subscriptionUsd: row.subscriptionUnknown ? null : row.subscriptionUsd,
        workflowPct: row.ratePerMinute != null && row.workflowMinutes != null
          ? row.ratePerMinute * row.workflowMinutes : null,
      };
      // Keep the pre-0.35.1 enumerable shape stable for callers that persisted
      // this projection, while exposing the new plain-word licence facts as
      // ordinary readable properties to the Home renderer and new consumers.
      Object.defineProperties(output, {
        workerMinutes: { value: row.workflowMinutes, enumerable: false },
        weeklyShare: {
          value: row.ratePerMinute != null && row.workflowMinutes != null
            ? row.ratePerMinute * row.workflowMinutes : null,
          enumerable: false,
        },
        apiUnknown: { value: row.apiUnknown, enumerable: false },
        subscriptionUnknown: { value: row.subscriptionUnknown, enumerable: false },
      });
      return output;
    });
}

/** The API-equivalent estimate a rollup record carries, over its pools. */
function recordCost(record) {
  if (record?.usage && Object.hasOwn(record.usage, 'apiUsd')) return finiteOrNull(record.usage.apiUsd);
  const direct = finiteOrNull(record?.apiEquivalentUsd ?? record?.costUsd);
  if (direct != null) return direct;
  let total = null;
  for (const entry of Object.values(record?.pools ?? {})) {
    const value = finiteOrNull(entry?.costUsd);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

function recordCostInfo(record) {
  const value = recordCost(record);
  const usage = record?.usage ?? {};
  const subscription = {
    // A partial subtotal is evidence that some attempts were priced, not a
    // complete subscription amount.  Keep it out of the pair's dollar slot;
    // the strict `subscriptionUsd` field is the only value that may render
    // as a measured/calibrated subscription cost.
    usd: finiteOrNull(usage.subscriptionUsd),
    deltaPct: finiteOrNull(usage.deltaPct),
    window: usage.window ?? null,
    basis: usage.subscriptionBasis ?? 'unknown:no-meter',
  };
  let tokenSource = Object.hasOwn(TOKEN_SOURCE_RANK, record?.tokenSource) ? record.tokenSource : null;
  for (const entry of Object.values(record?.pools ?? {})) {
    const cost = finiteOrNull(entry?.costUsd);
    tokenSource = worstTokenSource(tokenSource, tokenSourceOf(entry?.tokenSource, cost));
  }
  return {
    value,
    apiUsd: value,
    tokenSource: tokenSource ?? tokenSourceOf(null, value),
    subscription,
    subscriptionUsd: subscription.usd,
    subscriptionBasis: subscription.basis,
  };
}

export {
  taskToday,
  taskIdentity,
  todayMinutesText,
  todayMinutesNumberText,
  measuredTaskMinutes,
  todayDateLabel,
  todayRows,
  poolRatePerMinute,
  todayLicenceRows,
  recordCost,
  recordCostInfo,
  firstMeaningfulLine,
  runStatus,
  runVerdict,
  runName,
  runProject,
  attemptIntervals,
  unionMinutes,
  spanMinutes,
  runMinutesInfo,
  runStepCounts,
  recordMoneyInput,
  recordMoneyPair,
  isActiveRun,
  todayTopRuns,
};
