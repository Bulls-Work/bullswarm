// The History page renderer.
//
// historyDays() returns a page of the timeline: finished records, the legacy
// runs the index carries, and the runs still in flight, each filed under its
// day.  The shell may enrich those day objects with the records it has already
// read; this renderer accepts the common `runs`, `rows`, `workflows`, and
// `entries` names so paging remains a shell concern.  It never scans run
// directories or reads the filesystem.
//
// Two row kinds carry no finished record, and each says so rather than
// painting a blank where a number belongs:
//
//   legacy      a pre-0.27.0 run: `legacy · read-only` stays in the elastic
//               summary, alongside the duration and finish clock when known,
//               while the fixed result mark remains at the row start.
//   unfinished  a run with no finish time: `● running · 42m elapsed` while a
//               kernel owns it, `■ interrupted · no result recorded` once none
//               does.  Its `elapsedMinutes` is measured, never estimated.

import { glyphs } from '../lib/glyphs.js';
import { formatUsageBasis } from '../lib/usage-basis.js';
import { compactRow, cut, formatDashboardValue, rule } from './dash-kit.js';
import { METER_COLORS } from './usage-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const rgbOf = (hex) => {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

function tint(text, role, ansi) {
  const value = String(text ?? '');
  if (!ansi || !METER_COLORS[role]) return value;
  return `\x1b[38;2;${rgbOf(METER_COLORS[role]).join(';')}m${value}${RESET}`;
}

function bold(text, ansi) {
  const value = String(text ?? '');
  return ansi ? `${BOLD}${value}${RESET}` : value;
}

function visible(text) {
  return String(text ?? '').replace(SGR, '');
}

function widthOf(width, fallback = 120) {
  const number = Number(width);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOf(value, fallback) {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return fallback;
  const text = String(value).trim();
  return !text || /^(?:nan|undefined|null)$/i.test(text) ? fallback : text;
}

/** Single `bullswarm run` entries share the table but not workflow totals. */
function isTask(run) {
  return run?.kind === 'task' || run?.task === true;
}

function clean(text, ansi) {
  return ansi ? String(text ?? '') : visible(text);
}

function fit(text, width, ansi = true) {
  const cols = widthOf(width);
  const source = clean(text, ansi);
  if (visible(source).length <= cols) return source;
  return clean(cut(source, cols), ansi);
}

function push(lines, text, width, ansi = true) {
  const line = fit(text, width, ansi);
  lines.push(line);
  return line;
}

function pushWrapped(lines, text, width, ansi = true, indent = '  ') {
  for (const line of wrapText(text, width, indent)) push(lines, line, width, ansi);
}

// A region always names the row it was painted on: `y` is the 1-based index
// of the line that was just pushed, so the shell never has to guess which row
// a hit belongs to.
function addRegion(regions, lines, x, span, action) {
  const y = lines.length;
  const line = lines[y - 1];
  const start = Math.max(1, Math.trunc(Number(x) || 1));
  const requested = Math.max(0, Math.trunc(Number(span) || 0));
  const room = Math.max(0, visible(line).length - start + 1);
  const actual = Math.min(requested, room);
  if (actual > 0 && action) regions.push({ x: start, y, width: actual, action });
}

function dateKey(value) {
  if (value == null) return null;
  const source = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
  const ms = value instanceof Date ? value.getTime() : Date.parse(source);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateLabel(value) {
  const key = dateKey(value);
  if (!key) return String(value ?? 'unknown day');
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (!Number.isFinite(date.getTime())) return key;
  return `${WEEKDAYS[date.getDay()]} ${day} ${MONTHS[month - 1]}`;
}

function dateMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function clock(value) {
  if (typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value.trim())) {
    const [hour, minute] = value.trim().split(':').map(Number);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const ms = dateMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const TOKEN_SOURCE_RANK = Object.freeze({
  unknown: 0,
  'estimated:utf8-bytes/4': 1,
  'transcript-summed': 2,
  'provider-reported': 3,
});

function tokenSourceOf(value, cost = null) {
  if (Object.hasOwn(TOKEN_SOURCE_RANK, value)) return value;
  return cost != null ? 'estimated:utf8-bytes/4' : 'unknown';
}

function worstTokenSource(current, candidate) {
  const next = tokenSourceOf(candidate);
  if (current == null) return next;
  return TOKEN_SOURCE_RANK[next] < TOKEN_SOURCE_RANK[current] ? next : current;
}

function costInfo(value, tokenSource) {
  const basis = tokenSourceOf(tokenSource, value);
  return {
    value: finite(value),
    tokenSource: basis,
    text: formatUsageBasis({ tokenSource: basis, costUsd: value }),
  };
}

function apiEstimate(value, tokenSource, { compact = false } = {}) {
  const info = costInfo(value, tokenSource);
  return info.text === 'cost unknown' ? '(cost unknown)' : compact ? info.text : `(${info.text} API)`;
}

function recordCostInfo(run) {
  if (!run || typeof run !== 'object') return costInfo(null, 'unknown');
  const direct = [
    run.apiEquivalentUsd,
    run.apiEquivalent?.usd,
    run.costUsd,
    run.estimateUsd,
    run.estimatedUsd,
    run.estimate,
    run.usage?.cost?.estimatedUsd,
    run.result?.usage?.cost?.estimatedUsd,
  ];
  for (const value of direct) {
    const number = finite(value);
    if (number != null) return costInfo(number, run.tokenSource);
  }
  const pools = run.pools;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return costInfo(null, run.tokenSource);
  let total = null;
  let tokenSource = Object.hasOwn(TOKEN_SOURCE_RANK, run.tokenSource) ? run.tokenSource : null;
  for (const entry of Object.values(pools)) {
    const value = finite(entry?.apiEquivalentUsd ?? entry?.costUsd ?? entry?.estimatedUsd);
    if (value != null) total = (total ?? 0) + value;
    tokenSource = worstTokenSource(tokenSource, tokenSourceOf(entry?.tokenSource, value));
  }
  return costInfo(total, tokenSource);
}

// Rows show `minutes.active`, the union of the run's attempt intervals. A
// record written before 0.35 keeps only the `wall` alias, which this release
// redefined as the run's span; that fallback keeps its number but says `span`,
// because a span is never passed off as active time (docs/guide/cost.md).
function durationFacts(run) {
  if (!run || typeof run !== 'object') return { minutes: null, span: false };
  const direct = [
    { value: run.durationMinutes, span: false },
    { value: run.minutes?.active, span: false },
    { value: run.minutes?.wall, span: true },
    { value: run.wallMinutes, span: true },
    { value: run.duration, span: false },
  ];
  for (const { value, span } of direct) {
    if (typeof value === 'string' && /[a-z]/i.test(value)) continue;
    const number = finite(value);
    if (number != null) return { minutes: number, span };
  }
  const seconds = finite(run.wallSec ?? run.durationSec ?? run.attempt?.wallSec);
  if (seconds != null) return { minutes: seconds / 60, span: false };
  const durationMs = finite(run.durationMs);
  return { minutes: durationMs == null ? null : durationMs / 60_000, span: false };
}

function minutesText(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return total >= 60
    ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m`
    : `${total}m`;
}

function durationText(run) {
  if (typeof run?.duration === 'string' && /[a-z]/i.test(run.duration.trim())) return run.duration.trim();
  if (typeof run?.durationText === 'string' && run.durationText.trim()) return run.durationText.trim();
  const { minutes, span } = durationFacts(run);
  if (minutes == null) return 'duration unavailable';
  return span ? `span ${minutesText(minutes)}` : minutesText(minutes);
}

function displayedDuration(run) {
  if (unfinishedRun(run)) {
    // The summary already carries the words `elapsed unavailable`; repeating
    // that sentence in a fixed duration cell would steal the whole goal on a
    // wide row. A measured live duration remains a real duration; otherwise
    // the cell has no number to show.
    return run.running && finite(run.elapsedMinutes) != null
      ? elapsedText(run).replace(/ elapsed$/, '')
      : '—';
  }
  return durationText(run);
}

// How long a run still in flight has been going, from its recorded start to
// the instant the model measured. A run with no readable start says so rather
// than printing a bare unit.
function elapsedText(run) {
  const minutes = finite(run?.elapsedMinutes);
  return minutes == null ? 'elapsed unavailable' : `${minutesText(minutes)} elapsed`;
}

// Statuses that claim a kernel is working right now. A run whose kernel is
// gone keeps one of these in its state forever, so the reader says interrupted
// — the same substitution `workflow runs` makes, so the two never disagree.
const LIVE_STATUS_WORDS = new Set(['queued', 'planning', 'running', 'ready-to-finalize']);

function unfinishedWord(run) {
  if (run?.running === true) return 'running';
  const status = statusValue(run);
  if (!status) return 'stopped';
  return LIVE_STATUS_WORDS.has(status) ? 'interrupted' : status;
}

function unfinishedRun(run) {
  const hasFinish = Boolean(run?.finishedAt || run?.endedAt || run?.completedAt);
  const liveStatus = LIVE_STATUS_WORDS.has(statusValue(run));
  return !isLegacy(run) && Boolean(run?.unfinished === true || run?.running === true || (!hasFinish && liveStatus));
}

function isLegacy(run) {
  return Boolean(run?.legacy || run?.isLegacy || run?.v2 === false || run?.kind === 'legacy');
}

function runId(run) {
  const value = run?.runId ?? run?.id ?? run?.shortId;
  return textOf(value, '');
}

function shortId(run) {
  const short = run?.shortId ?? run?.short_id;
  if (short != null && textOf(short, '')) return textOf(short, '');
  const id = runId(run);
  return id.length > 6 ? id.slice(-6) : id;
}

function project(run) {
  const value = run?.project ?? run?.projectName ?? run?.repository;
  return textOf(value, 'unknown project');
}

function goal(run) {
  const value = run?.goal ?? run?.label ?? run?.title ?? run?.purpose;
  return textOf(value, 'goal unavailable').replace(/\s+/g, ' ');
}

function runTime(run) {
  return run?.finishedAt ?? run?.endedAt ?? run?.completedAt ?? run?.at ?? run?.time ?? run?.startedAt ?? null;
}

function candidateRuns(day) {
  if (!day || typeof day !== 'object') return [];
  for (const key of ['runs', 'rows', 'workflows', 'entries', 'records', 'workflowRuns', 'legacyRuns']) {
    if (Array.isArray(day[key])) return day[key].filter((run) => run && typeof run === 'object');
    if (day[key] && typeof day[key] === 'object') return Object.values(day[key]).filter((run) => run && typeof run === 'object');
  }
  if (day.run && typeof day.run === 'object') return [day.run];
  return [];
}

function topLevelDays(value) {
  if (Array.isArray(value)) {
    const objects = value.filter((day) => day && typeof day === 'object');
    // A caller that already has rollup records may pass them directly.  Group
    // that flat form by the finished (or started) local date rather than
    // manufacturing an "unknown day" heading for every record.
    if (objects.length && objects.every((entry) => !entry.date && (entry.finishedAt || entry.startedAt))) {
      const groups = new Map();
      for (const record of objects) {
        const date = dateKey(record.finishedAt ?? record.startedAt) ?? 'unknown';
        const group = groups.get(date) ?? { date, runs: [] };
        group.runs.push(record);
        groups.set(date, group);
      }
      return [...groups.values()];
    }
    return objects;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.days)) return topLevelDays(value.days);
    if (value.date) return [value];
    const keyed = Object.entries(value)
      .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .map(([date, runs]) => Array.isArray(runs) ? { date, runs } : { date, ...runs });
    if (keyed.length) return keyed;
  }
  return [];
}

function daySpend(day, runs) {
  const stated = finite(day?.spendUsd ?? day?.apiEquivalentUsd ?? day?.spend);
  if (stated != null) return stated;
  let total = null;
  for (const run of runs.filter((entry) => !isTask(entry))) {
    const cost = isLegacy(run) ? costInfo(null, 'unknown') : recordCostInfo(run);
    if (cost.value != null) total = (total ?? 0) + cost.value;
  }
  return total;
}

function daySpendInfo(day, runs) {
  const stated = finite(day?.spendUsd ?? day?.apiEquivalentUsd ?? day?.spend);
  let tokenSource = tokenSourceOf(day?.tokenSource, stated);
  if (stated != null) {
    for (const run of runs.filter((entry) => !isTask(entry) && !isLegacy(entry))) {
      tokenSource = worstTokenSource(tokenSource, recordCostInfo(run).tokenSource);
    }
    return costInfo(stated, tokenSource);
  }
  let total = null;
  for (const run of runs.filter((entry) => !isTask(entry) && !isLegacy(entry))) {
    const info = recordCostInfo(run);
    tokenSource = worstTokenSource(tokenSource, info.tokenSource);
    if (info.value != null) total = (total ?? 0) + info.value;
  }
  return costInfo(total, tokenSource);
}

function dayCount(day, runs) {
  const workflows = runs.filter((run) => !isTask(run));
  if (workflows.length) return workflows.length;
  const finished = finite(day?.finished);
  if (finished != null) return Math.max(0, Math.round(finished));
  const count = finite(day?.runs);
  return count == null ? 0 : Math.max(0, Math.round(count));
}

function taskCount(runs) {
  return runs.filter((run) => isTask(run)).length;
}

function dayRows(day) {
  return candidateRuns(day).slice().sort((a, b) => {
    const left = dateMs(runTime(a));
    const right = dateMs(runTime(b));
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return right - left;
  });
}

function wrapText(text, width, indent = '') {
  const cols = Math.max(1, widthOf(width) - visible(indent).length);
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [indent];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visible(candidate).length <= cols) current = candidate;
    else if (current) { lines.push(`${indent}${current}`); current = word; }
    else {
      lines.push(`${indent}${cut(word, cols)}`);
      current = '';
    }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}

function statusValue(run) {
  return textOf(
    run?.status
      ?? run?.state?.status
      ?? run?.state?.lifecycle?.status
      ?? run?.lifecycle?.status
      ?? run?.result?.status,
    null,
  )?.toLowerCase() ?? null;
}

/** The mark is a result, not a second status sentence. */
function resultMark(run) {
  if (unfinishedRun(run)) return run.running === true ? glyphs().ongoing : glyphs().stopped;
  const status = statusValue(run);
  if (status === 'completed' || status === 'success' || status?.startsWith('succeeded')) return glyphs().ok;
  if (status && /(?:failed|failure|error|cancel(?:led)?|interrupted|partial|blocked|budget[_-]exhausted|stopped|aborted|timed[_-]?out|completed[_-]with[_-](?:gaps|concerns))/.test(status)) {
    return glyphs().fail;
  }
  // Callers that hand the view a finished rollup may omit the lifecycle word;
  // a recorded finish is still a result and keeps the prototype's ✓ mark.
  return run?.finishedAt || run?.endedAt || run?.completedAt ? glyphs().ok : glyphs().pending;
}

function markRole(mark, run) {
  if (unfinishedRun(run)) return run.running ? 'cyan' : 'red';
  if (mark === glyphs().ok) return 'green';
  if (mark === glyphs().fail) return 'red';
  return 'dim';
}

function rowSummary(run) {
  const base = goal(run);
  if (isLegacy(run)) return `legacy · read-only · ${base}`;
  if (unfinishedRun(run)) {
    return run.running === true
      ? `running · ${elapsedText(run)} · no result yet · ${base}`
      : `${unfinishedWord(run)} · no result recorded · ${base}`;
  }
  return base;
}

/**
 * One compact row. The first five fields are the stable identity columns;
 * the summary grows and gives cells back before the right-aligned duration,
 * estimate and clock. A one-cell trailing spacer reserves the prototype's
 * final blank without painting it, keeping the right columns stable at 120.
 */
function runRow(run, width, ansi, { durationWidth = null } = {}) {
  const cols = widthOf(width);
  const desktop = cols >= 100;
  const phone = !desktop;
  const id = shortId(run) || '------';
  // Legacy directories have no V2 measurement contract. Ignore any stale
  // cost-shaped field a caller may have attached instead of pricing a
  // read-only row by accident.
  const cost = isLegacy(run) ? costInfo(null, 'unknown') : recordCostInfo(run);
  const estimate = isLegacy(run) ? null : apiEstimate(cost.value, cost.tokenSource, { compact: phone });
  const mark = resultMark(run);
  const duration = displayedDuration(run);
  const durationCells = Math.max(1, Math.trunc(Number(durationWidth) || 0), visible(duration).length);
  const projectWidth = desktop
    ? 25
    : Math.min(18, Math.max(9, Math.floor(cols * 0.2)));
  // A legacy row's read-only marker is the important fact on a phone. Keep
  // it whole when the wider duration cell consumes the last elastic cells;
  // the goal remains available on desktop and in the day header.
  const summary = phone && isLegacy(run) ? 'legacy · read-only' : rowSummary(run);
  const summaryFloor = phone && isLegacy(run) ? visible(summary).length : 1;
  // A live run has a start but no result time; never let its start clock read
  // as a finished timestamp. A stopped run may expose its last file write,
  // which is the only honest time available for that row.
  const atValue = unfinishedRun(run)
    ? (run.running === true ? null : run?.lastWriteAt)
    : runTime(run);
  const at = clock(atValue) ?? '—';
  const timeText = tint(at, 'dim', ansi);
  // Keep the approximation marker and basis at every width. A phone row
  // drops the trailing API word but retains the full estimated label.
  const estimateText = estimate ? tint(estimate, 'dim', ansi) : '';
  const estimateWidth = Math.max(1, visible(estimate || '(cost unknown)').length);
  const compactUnfinished = phone && cols < 70 && unfinishedRun(run);
  const rightFields = compactUnfinished
    ? []
    : [
      { text: duration, width: durationCells, align: 'right', gap: 1 },
      ...((!isLegacy(run) && !unfinishedRun(run)) ? [
        { text: estimate ? '·' : '', width: 1, gap: 1 },
        { text: estimateText || '(cost unknown)', width: estimateWidth, align: 'right', gap: 0 },
      ] : []),
      { text: timeText, width: 5, align: 'right', gap: 2 },
    ];
  return {
    id,
    idWidth: Math.min(6, visible(id).length),
    line: compactRow([
      { text: ' ', width: 1 },
      { text: tint(mark, markRole(mark, run), ansi), width: 1, gap: 0 },
      { text: bold(id, ansi), width: 6, gap: 1 },
      { text: project(run), width: projectWidth, gap: 2 },
      { text: summary, grow: true, min: summaryFloor, gap: desktop ? 2 : 1 },
      ...rightFields,
      { text: ' ', width: 1, gap: 0 },
    ], { width: cols, gap: 1 }),
  };
}

function renderRun(run, lines, regions, width, ansi, options = {}) {
  const action = { kind: 'run', runId: runId(run) || shortId(run) || '------' };
  const rendered = runRow(run, width, ansi, options);
  lines.push(fit(rendered.line, width, ansi));
  // The shell has always made the id the click target. The leading spacer and
  // result mark restore its prototype x coordinate at column 4.
  addRegion(regions, lines, 4, rendered.idWidth, action);
}

function taskId(task) {
  const value = textOf(task?.id ?? task?.taskFile, 'task');
  // UUID-backed assignments are not useful as a whole on a table row. Keep
  // the short human-authored ids intact, and use the stable tail for UUIDs.
  return value.length > 14 ? value.slice(-8) : value;
}

function taskPoolModel(task) {
  return [task?.pool, task?.model].filter((value) => value != null && String(value).trim()).join(' · ') || 'pool/model unavailable';
}

function taskResult(task) {
  if (task?.ok === true) return 'ok';
  if (task?.ok === false) return textOf(task.reason, 'failed').replace(/\s+/g, ' ');
  return 'result unavailable';
}

function taskRow(task, lines, regions, width, ansi, { durationWidth = null } = {}) {
  const cols = widthOf(width);
  const duration = durationText(task);
  const durationCells = Math.max(1, Math.trunc(Number(durationWidth) || 0), visible(duration).length);
  const at = clock(task?.endedAt ?? task?.finishedAt ?? task?.startedAt) ?? '—';
  const identity = [task?.lane ?? 'lane unavailable', taskId(task), taskPoolModel(task)]
    .filter(Boolean).join(' · ');
  const result = taskResult(task);
  // Keep the outcome visible while the identity gives back cells on narrow
  // terminals. Reasons are intentionally short in the ledger; a longer
  // legacy reason is still bounded so the duration and clock remain fixed.
  const resultWidth = Math.max(2, Math.min(24, visible(result).length));
  const mark = glyphs().inflight;
  const line = compactRow([
    { text: ' ', width: 1 },
    { text: tint(mark, task?.ok === false ? 'red' : task?.ok === true ? 'green' : 'cyan', ansi), width: 1, gap: 0 },
    { text: identity, grow: true, min: 1, gap: 2 },
    { text: result, width: resultWidth, gap: 2 },
    { text: duration, width: durationCells, align: 'right', gap: 2 },
    { text: tint(at, 'dim', ansi), width: 5, align: 'right', gap: 2 },
    { text: ' ', width: 1, gap: 0 },
  ], { width: cols, gap: 1 });
  lines.push(fit(line, cols, ansi));
  addRegion(regions, lines, 4, Math.max(1, visible(line).length - 3), {
    kind: 'task', taskId: task?.id ?? task?.taskFile ?? null,
  });
}

/**
 * Render date groups, newest date first and each day's workflows newest first.
 * Regions use 1-based x coordinates relative to the line that owns them; the
 * shell associates them with the returned line while composing its frame.
 */
export function historyLines(days, { width = 120, ansi = true } = {}) {
  const cols = widthOf(width);
  const list = topLevelDays(days).slice().sort((a, b) => {
    const left = dateKey(a.date);
    const right = dateKey(b.date);
    return String(right ?? '').localeCompare(String(left ?? ''));
  });
  const lines = [];
  const regions = [];
  if (!list.length) {
    push(lines, ' No workflow history loaded yet.', cols, ansi);
    return { lines, regions };
  }

  for (const day of list) {
    const runs = dayRows(day);
    const count = dayCount(day, runs);
    const tasks = taskCount(runs);
    const workflowRows = runs.filter((run) => !isTask(run));
    const onlyLegacy = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy)
      || (workflowRows.length > 0 && workflowRows.every((run) => isLegacy(run)));
    // A legacy-only day has no V2 usage record.  Even if a stale summary
    // happens to carry a spend field, showing it would make an unmeasured
    // legacy run look priced.
    const summary = `${count} run${count === 1 ? '' : 's'}${tasks ? ` · ${tasks} task${tasks === 1 ? '' : 's'}` : ''}`;
    // A day whose runs have not delivered has no estimate because there is no
    // result yet — a different reason from "nothing recorded", and the one the
    // reader needs.
    const inFlight = workflowRows.length > 0 && workflowRows.every((run) => unfinishedRun(run));
    const spend = onlyLegacy ? costInfo(null, 'unknown') : daySpendInfo(day, runs);
    const money = onlyLegacy || inFlight ? null : apiEstimate(spend.value, spend.tokenSource);
    const basis = money ?? (inFlight ? 'no result recorded yet' : 'estimate unavailable (no recorded API-equivalent cost)');
    const title = bold(dateLabel(day.date), ansi);
    const right = `${summary} · ${money ? tint(money, 'orange', ansi) : tint(basis, 'dim', ansi)}`;
    const ruleHeadWidth = visible(`── ${dateLabel(day.date)} `).length;
    const ruleTailWidth = visible(` ${right} ──`).length;
    if (ruleHeadWidth + ruleTailWidth < cols) {
      push(lines, rule(title, right, cols), cols, ansi);
    } else {
      push(lines, rule(`${title} · ${summary}`, null, cols), cols, ansi);
      pushWrapped(lines, money ? tint(money, 'orange', ansi) : tint(basis, 'dim', ansi), cols, ansi, '');
    }
    if (!runs.length) {
      const legacyOnly = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy);
      pushWrapped(lines, legacyOnly
        ? '  Legacy workflows are read-only: no cost and no pool minutes were recorded.'
        : count > 0
          ? '  Workflow rows are not loaded for this day yet.'
          : '  No workflows recorded.', cols, ansi, '');
    } else {
      const durationWidth = runs.reduce((longest, run) => Math.max(longest, visible(isTask(run) ? durationText(run) : displayedDuration(run)).length), 5);
      let normal = 0;
      for (const run of runs) {
        if (isTask(run)) taskRow(run, lines, regions, cols, ansi, { durationWidth });
        else {
          renderRun(run, lines, regions, cols, ansi, { durationWidth });
          if (!isLegacy(run)) normal += 1;
        }
      }
      if (!normal && workflowRows.length) pushWrapped(lines, 'Legacy workflows are read-only: no cost and no pool minutes were recorded.', cols, ansi);
    }
    lines.push('');
  }
  if (lines.at(-1) === '') lines.pop();
  return { lines, regions };
}

/** The shell renders this immediately above the sticky navigation. */
export function historyNote(days, { width = 120 } = {}) {
  const count = topLevelDays(days).length;
  const noun = count === 1 ? 'day' : 'days';
  return [fit(`${count} ${noun} loaded · older days load as you scroll`, width, false)];
}
