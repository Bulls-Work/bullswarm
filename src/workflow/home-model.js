// Width-independent data shaping for the Home page.
//
// Home owns the finished-today/task ledger projection and the per-pool
// accounting rows. Rendering stays in home-view.js; shared dashboard helpers
// remain shell-owned so the other pages keep their compatibility contract.
//
// A top-run card answers with the same figures the Run page answers with: a
// rollup written before `minutes.active` and `steps` existed leaves Home with
// nothing to print, so the card reads the run's own state through the Run
// page's own duration arithmetic (`runDurationFacts`) rather than measuring a
// second time and disagreeing.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe } from '../lib/fsjson.js';
import { finiteOrNull } from '../lib/num.js';
import { dayKey } from './history.js';
import {
  TOKEN_SOURCE_RANK,
  tokenSourceOf,
  worstSubscriptionBasis,
  worstTokenSource,
} from './dashboard.js';
import { withV2Cancellation } from './v2-cancellation.js';
import { taskIdentity } from '../lib/tasks.js';
import { runClockText, runDurationFacts } from './run-model.js';
import { verifyRoundLabel } from './verify-rounds.js';
import { honestApiTotalText, recordSpendFacts, spendFacts } from './spend-facts.js';
import { readCalibration } from '../lib/subscription-cost.js';
import { apiMoney, apiMoneyText, formatMoney, formatMoneyPair } from '../lib/usage-basis.js';

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

/**
 * The period's median run duration, with the basis that produced it.
 *
 * A run belongs to the day it finished, falling back to its start only when
 * it recorded none — the same placement the Stats range selection reads, so
 * the Overview band's figures and this band's median describe one set.
 * Active minutes are the figure; a period whose records carry no provable
 * active interval (an index `workflow reprice` has not corrected yet) falls
 * back to the spans they do carry, and the caller labels that as a span.
 */
function medianRunDuration(records, { from = null, to = null } = {}) {
  const inPeriod = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const at = Date.parse(record.finishedAt ?? record.startedAt ?? '');
    if (!Number.isFinite(at)) continue;
    if (from != null && at < from) continue;
    if (to != null && at > to) continue;
    inPeriod.push(record);
  }
  for (const [key, basis] of [['active', 'active'], ['span', 'span'], ['wall', 'span']]) {
    const values = inPeriod
      .map((record) => finiteOrNull(record?.minutes?.[key]))
      .filter((value) => value != null && value >= 0);
    if (!values.length) continue;
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    const minutes = sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
    return { minutes: Math.round(minutes * 100) / 100, basis };
  }
  return { minutes: null, basis: null };
}

function runStepCounts(record) {
  const state = recordState(record);
  const actions = Array.isArray(state.actions) ? state.actions : [];
  const definitions = Array.isArray(state.program?.actions) ? state.program.actions : [];
  const doneFromActions = actions.filter((action) => action?.status === 'succeeded').length;
  const totalFromActions = Math.max(actions.length, definitions.length);
  // Steps are actions, never requirements: a record that predates the
  // `steps` rollup field falls back to counting its actions, and a record
  // with neither shows no count rather than a requirement tally.
  const done = finiteOrNull(record?.steps?.done ?? record?.stepsOk);
  const total = finiteOrNull(record?.steps?.total ?? record?.stepsTotal);
  return {
    done: done != null && done >= 0 ? done : totalFromActions ? doneFromActions : null,
    total: total != null && total >= 0 ? total : totalFromActions || null,
  };
}

/** The home everything durable lives in: `$BULLSWARM_HOME`, else `~/.bullswarm`. */
function bullswarmHome() {
  const home = process.env.BULLSWARM_HOME?.trim();
  return home && home.length ? home : join(homedir(), '.bullswarm');
}

/** `<BULLSWARM_HOME>/workflows/<runId>`, the directory the Run page opens. */
function runDirectory(record) {
  if (record?.runDir) return String(record.runDir);
  if (!record?.runId) return null;
  return join(bullswarmHome(), 'workflows', String(record.runId));
}

/**
 * The active minutes, span and step tally the Run page prints for this run.
 *
 * A rollup written before 0.35.1 carries neither `minutes.active` nor `steps`,
 * and a card that prints `active — · steps —` beside a Run header reading
 * `active 354.94m · 19/19 actions` is the two pages disagreeing about one run.
 * So the card reads the same two files the Run page's row reads (state.json,
 * overlaid with the operator's cancellation intent, plus report.json) and
 * measures them with the Run page's own union arithmetic.
 *
 * `null` when the row already answers for itself, when the run has no
 * directory on disk (a legacy run, or a home the index outlived), or when the
 * state is unreadable — the caller keeps whatever the row recorded, dashes
 * included, rather than turning a missing file into a measurement.
 */
function runPageFacts(record, nowMs = Date.now()) {
  const steps = runStepCounts(record);
  const storedActive = finiteOrNull(record?.minutes?.active);
  if (record?.legacy === true || (storedActive != null && steps.done != null && steps.total != null)) return null;
  const runDir = runDirectory(record);
  if (!runDir) return null;
  let state = null;
  let report = null;
  try {
    state = withV2Cancellation(readJsonSafe(join(runDir, 'state.json'), null), runDir);
    report = readJsonSafe(join(runDir, 'report.json'), null);
  } catch { return null; }
  if (!state || typeof state !== 'object') return null;
  const duration = runDurationFacts({ runId: record?.runId ?? null, runDir, state, report }, { nowMs });
  return {
    minutes: {
      active: duration.activeMinutes,
      span: duration.spanMinutes,
      label: 'active',
      intervals: duration.intervals,
    },
    steps: runStepCounts({ ...record, state }),
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
    apiKnownSubtotalUsd: apiUsd == null ? info.apiKnownSubtotalUsd ?? null : null,
    apiCoverage: info.apiCoverage ?? null,
    facts: recordSpendFacts(record, attempts),
    tokenSource,
    tokens: record?.usage?.tokens ?? null,
  };
}

/**
 * A money pair whose API side says what it is. The whole amount when every
 * attempt was priced (`≈ $9.52 api summed` while the priced attempts are
 * estimates); `at least $X api · N unmeasured` when the scope holds attempts
 * nobody priced — the Run spend block's own words, through its own helper;
 * `api unknown`, with its unmeasured count, when nothing recorded an amount.
 */
function moneyPairText(input) {
  const { apiText, subscriptionText } = moneyPairParts(input);
  return [apiText, subscriptionText].filter((part) => part != null && part !== '').join(' · ');
}

/**
 * The pair as its two sides, each already honest.
 *
 * `apiText` is the money phrase (`at least $9.52 api · 3 unmeasured`);
 * `apiSlotText` is the same phrase for a surface whose own label already
 * says API (a card's `API …` slot); `subscriptionText` is unchanged.
 */
function moneyPairParts(input) {
  const pair = formatMoneyPair(input);
  const separator = pair.indexOf(' · ');
  const subscriptionText = separator < 0 ? '' : pair.slice(separator + 3);
  const money = apiMoney({
    apiUsd: input?.api?.usd ?? null,
    apiKnownSubtotalUsd: input?.apiKnownSubtotalUsd ?? null,
    apiCoverage: input?.apiCoverage ?? null,
    tokenSource: input?.tokenSource ?? null,
  });
  // The whole-scope label: the pair's own words for a complete amount, or the
  // subtotal the record really holds, marked `≈`.
  const wholeApi = money?.partial
    ? apiMoneyText(money, null, input?.tokens ?? null, { coverage: false })
    : (separator < 0 ? pair : pair.slice(0, separator));
  const facts = input?.facts ?? null;
  if (!facts) return { apiText: wholeApi, apiSlotText: wholeApi, subscriptionText };
  // A card's slot is the amount with its own estimate glyph, and the whole
  // honest phrase when a partial total has coverage words to carry.
  const glyph = wholeApi.startsWith('≈ ') ? '≈ ' : wholeApi.startsWith('~ ') ? '~ ' : '';
  const amount = finiteOrNull(money?.usd ?? input?.api?.usd);
  const slotWhole = amount == null ? null : `${glyph}${formatMoney(amount, input?.tokens ?? null)}`;
  return {
    apiText: honestApiTotalText(facts, { whole: wholeApi }),
    apiSlotText: honestApiTotalText(facts, { api: null, whole: slotWhole }),
    subscriptionText,
  };
}

/** The shared formatter is the source of truth for every Home card money pair. */
function recordMoneyPair(record) {
  const input = recordMoneyInput(record);
  return { ...input, ...moneyPairParts(input), text: moneyPairText(input) };
}

function isActiveRun(record) {
  const status = runStatus(record);
  return record?.ongoing === true || ['running', 'active', 'planning', 'queued', 'waiting', 'paused'].includes(status);
}

/**
 * The mark the Run page header gives a run's status (run-view.js runPage):
 * completed/succeeded is the tick, failed/partial/cancelled/interrupted the
 * cross, and any other status the ongoing dot. Verification is not part of
 * it — the Run page never reads a completed run as pending — so a recent row
 * takes the mark from here and cannot drift from the page it opens. The
 * status is the record's own raw word, as the header reads it.
 *
 * @returns {{glyph: 'ok'|'fail'|'ongoing', tone: 'green'|'red'|'amber'|null}}
 */
function runStatusMark(record) {
  const status = String(record?.status ?? recordState(record)?.lifecycle?.status ?? 'starting');
  if (status === 'completed' || status === 'succeeded') return { glyph: 'ok', tone: 'green' };
  if (['failed', 'partial', 'cancelled', 'interrupted'].includes(status)) return { glyph: 'fail', tone: 'red' };
  return { glyph: 'ongoing', tone: status === 'running' ? 'amber' : null };
}

/** Finished runs only: a live or reopened run belongs to the running block. */
function isFinishedRun(record) {
  return record != null && record.unfinished !== true && !isActiveRun(record);
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
    // Only the cards on screen pay for a state read, and only when their own
    // row cannot answer; the run's own files give the Run page's figures.
    const page = runPageFacts(record, nowMs);
    const minutes = page?.minutes ?? runMinutesInfo(record, nowMs);
    const steps = page?.steps ?? runStepCounts(record);
    return {
      record,
      id: runIdentity(record),
      name: runName(record),
      project: runProject(record),
      // While a run is in its repair loop the card says which round it is
      // working toward (`verify round 2/3`) in place of `running`.
      status: verifyRoundLabel(recordState(record)) ?? runStatus(record),
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

/**
 * The Home card's duration sentence, using the Run header's h/m/s clock.
 *
 * Active time is the primary answer.  A proved wall span is appended only
 * when its rendered clock differs, so a card never repeats one duration as
 * both active and span.  When only a span exists, keep that basis explicit.
 */
function cardDurationText(minutes) {
  const active = finiteOrNull(minutes?.active);
  const span = finiteOrNull(minutes?.span);
  const activeText = active != null && active >= 0 ? runClockText(active) : null;
  const spanText = span != null && span >= 0 ? runClockText(span) : null;
  if (activeText && spanText && spanText !== activeText) return `${activeText} active of ${spanText}`;
  if (activeText) return activeText;
  if (spanText) return `span ${spanText}`;
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

function poolWindow(pool, row = null) {
  return pool?.spend?.pacing?.window ?? pool?.pacingWindow ?? row?.subscriptionWindow ?? null;
}

/**
 * The window drop a calibration ledger attributes to the runs in `runIds`.
 *
 * A ledger sample is durable evidence: it names the run and attempt whose
 * meter movement it observed (`appendCalibrationFromResult`), carries the
 * observed `deltaPct`, and only eligible, conserved observations are stored.
 * Summing the samples one pool's runs own is therefore a measurement of the
 * share of the window that work consumed — never an extrapolation. Samples
 * with no run attribution (a `bullswarm run` task, a study) stay out: they
 * cannot be attributed to the row's scope, so they are not used.
 *
 * A ledger whose own window differs from the pool's is not this column's
 * measurement and is refused rather than relabelled.
 */
function ledgerWindowShare(ledger, runIds, window = null) {
  if (!ledger || !runIds?.size || !Array.isArray(ledger.samples)) return null;
  if (window && ledger.window && ledger.window !== window) return null;
  let pct = null;
  let samples = 0;
  for (const sample of ledger.samples) {
    if (!sample?.runId || !runIds.has(String(sample.runId))) continue;
    const delta = finiteOrNull(sample.deltaPct);
    if (delta == null || delta <= 0) continue;
    pct = (pct ?? 0) + delta;
    samples += 1;
  }
  return pct == null ? null : { pct, samples };
}

function todayLicenceRows(model, today, nowMs) {
  const byName = new Map();
  const ensure = (name) => {
    if (!name) return null;
    if (!byName.has(name)) byName.set(name, {
      name, workflowMinutes: null, runMinutes: null, apiUsd: null,
      apiKnownSubtotalUsd: null, attempts: null, pricedAttempts: null,
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
  // Which of today's runs each pool's ledger may be attributed to: the run id
  // a calibration sample carries is the workflow's own `wf-…` id.
  const runIdsByPool = new Map();
  for (const record of today.workflows) {
    const runId = record?.runId ?? null;
    for (const [name, entry] of Object.entries(record?.pools ?? {})) {
      const row = ensure(name);
      if (!row) continue;
      if (runId != null) {
        const ids = runIdsByPool.get(name) ?? new Set();
        ids.add(String(runId));
        runIdsByPool.set(name, ids);
      }
      row.worked = true;
      addMinutes(row, 'workflowMinutes', entry?.minutes);
      // A v2 pool entry keeps its strict amount in `apiUsd` and leaves the
      // legacy `costUsd` null even when every attempt was priced, so reading
      // `costUsd` alone marked measured pools unknown.
      const cost = finiteOrNull(entry?.apiUsd ?? entry?.costUsd);
      if (cost != null) row.apiUsd = (row.apiUsd ?? 0) + cost;
      else row.apiUnknown = true;
      // A pool entry whose attempts were only partly priced records no
      // `costUsd`, but it does record the sum over the attempts that were.
      // Keep that beside the strict figure so the licence row can show the
      // lower bound instead of a dash that reads as "this pool was free".
      const subtotal = finiteOrNull(entry?.apiKnownSubtotalUsd) ?? cost;
      if (subtotal != null) row.apiKnownSubtotalUsd = (row.apiKnownSubtotalUsd ?? 0) + subtotal;
      // Coverage counts travel only when the entry names them: a pre-0.35.2
      // entry recorded a whole amount and no counts, and reading its missing
      // `pricedAttempts` as zero would mark every legacy pool as having one
      // unpriced attempt it never had.
      const count = finiteOrNull(entry?.attempts);
      const priced = finiteOrNull(entry?.pricedAttempts);
      if (count != null) row.attempts = (row.attempts ?? 0) + count;
      if (priced != null) row.pricedAttempts = (row.pricedAttempts ?? 0) + priced;
      const measured = finiteOrNull(entry?.measuredAttempts);
      if (measured != null) row.measuredAttempts = (row.measuredAttempts ?? 0) + measured;
      if (subtotal != null && (count == null || priced == null)) row.countsIncomplete = true;
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
    row.window = poolWindow(pool, row);
    row.usedPct = finiteOrNull(pool?.usedPct);
  }
  for (const row of byName.values()) {
    row.ratePerMinute ??= poolRatePerMinute(null, budgetRows.get(row.name));
  }

  // The calibration ledger lives in the same live home as the meter list, so
  // it is consulted only when the caller supplied that list (`model.pools`):
  // a pure-rollup render — the committed frames, a fixture — never reads a
  // home it was not handed, and a home whose meters could not be read has no
  // ledger to pair them with either.
  const liveRead = pools.length > 0;

  // Keep the provider/config order stable (the frame is a report, not a
  // ranking), then append a pool that was recorded by a rollup but is absent
  // from the current live meter list.
  const order = new Map(pools.map((pool, index) => [pool?.name, index]));
  return [...byName.values()]
    .filter((row) => row.worked)
    .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)
      || String(a.name).localeCompare(String(b.name)))
    .map((row) => {
      const apiUsd = row.apiUnknown ? null : row.apiUsd;
      const apiKnownSubtotalUsd = finiteOrNull(row.apiKnownSubtotalUsd);
      // The window-share line, in one place and one basis at a time. The
      // calibration ledger's measured drop wins when it attributes one to
      // today's runs; otherwise the pool's own measured rate times today's
      // worker-minutes is a pace estimate, and the renderer labels it as such;
      // otherwise the share is unknown and reads as a dash — never a guess
      // beside an unknown for the same thing.
      const window = row.window ?? row.subscriptionWindow ?? null;
      const measured = liveRead
        ? ledgerWindowShare(readCalibration(row.name, { home: bullswarmHome() }), runIdsByPool.get(row.name), window)
        : null;
      const pacePct = row.ratePerMinute != null && row.workflowMinutes != null
        ? row.ratePerMinute * row.workflowMinutes : null;
      const share = measured
        ? { pct: measured.pct, basis: 'measured', samples: measured.samples }
        : pacePct != null
          ? { pct: pacePct, basis: 'pace', samples: null }
          : { pct: null, basis: null, samples: null };
      const output = {
        ...row,
        apiUsd,
        subscriptionUsd: row.subscriptionUnknown ? null : row.subscriptionUsd,
        workflowPct: pacePct,
      };
      // Keep the pre-0.35.1 enumerable shape stable for callers that persisted
      // this projection, while exposing the new plain-word licence facts as
      // ordinary readable properties to the Home renderer and new consumers.
      Object.defineProperties(output, {
        workerMinutes: { value: row.workflowMinutes, enumerable: false },
        weeklyShare: { value: share.pct, enumerable: false },
        shareBasis: { value: share.basis, enumerable: false },
        shareSamples: { value: share.samples, enumerable: false },
        apiUnknown: { value: row.apiUnknown, enumerable: false },
        subscriptionUnknown: { value: row.subscriptionUnknown, enumerable: false },
        // The API side of the row through the Run spend block's own helper:
        // `at least $X` with its coverage when attempts went unpriced. A row
        // whose entries never recorded the coverage counts keeps its whole
        // amount unqualified, the way it always read.
        apiFacts: {
          value: spendFacts(row.countsIncomplete
            ? { apiKnownSubtotalUsd }
            : {
              attempts: row.attempts,
              pricedAttempts: row.pricedAttempts,
              measuredAttempts: row.measuredAttempts ?? 0,
              apiKnownSubtotalUsd,
            }),
          enumerable: false,
        },
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
    // The strict fields above stay strict. A run whose attempts were only
    // partly priced still recorded the sum over the ones that were; carrying
    // it named, with its coverage, is what lets a surface print the lower
    // bound instead of a dash that reads as "this run was free".
    apiKnownSubtotalUsd: value == null ? finiteOrNull(usage.apiKnownSubtotalUsd) : null,
    apiCoverage: {
      priced: finiteOrNull(usage.pricedAttempts),
      attempts: finiteOrNull(usage.attempts),
    },
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
  cardDurationText,
  poolRatePerMinute,
  todayLicenceRows,
  recordCost,
  recordCostInfo,
  moneyPairText,
  firstMeaningfulLine,
  runStatus,
  runVerdict,
  verifyRoundLabel,
  runName,
  runProject,
  attemptIntervals,
  unionMinutes,
  spanMinutes,
  runMinutesInfo,
  medianRunDuration,
  runStepCounts,
  recordMoneyInput,
  recordMoneyPair,
  isActiveRun,
  isFinishedRun,
  runStatusMark,
  todayTopRuns,
};
