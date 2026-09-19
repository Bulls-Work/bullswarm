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

function taskToday(task, nowMs, { finished = false } = {}) {
  const at = finished ? (task?.endedAt ?? task?.finishedAt) : (task?.startedAt ?? task?.endedAt ?? task?.finishedAt);
  return dayKey(at) === dayKey(nowMs);
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
    if (record.unfinished === true || !record.finishedAt || dayKey(record.finishedAt) !== date) return;
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
      const subscription = finiteOrNull(entry?.subscriptionUsd);
      if (subscription != null) row.subscriptionUsd = (row.subscriptionUsd ?? 0) + subscription;
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
    .map((row) => ({
      ...row,
      workflowPct: row.ratePerMinute != null && row.workflowMinutes != null
        ? row.ratePerMinute * row.workflowMinutes : null,
    }));
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
};
