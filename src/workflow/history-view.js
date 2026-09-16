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
//   legacy      a pre-0.27.0 run: `legacy · read-only` first, so a phone-width
//               cut can never drop the mark, then whatever the run recorded —
//               its duration, status word and finish clock when it has them.
//   unfinished  a run with no finish time: `● running · 42m elapsed` while a
//               kernel owns it, `■ interrupted · no result recorded` once none
//               does.  Its `elapsedMinutes` is measured, never estimated.

import { glyphs } from '../lib/glyphs.js';
import { cut, formatDashboardValue, rule } from './dash-kit.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

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

function apiEstimate(value) {
  const money = formatDashboardValue(value, 'money');
  return money == null ? null : `≈ ${money} API-equivalent estimate`;
}

function recordCost(run) {
  if (!run || typeof run !== 'object') return null;
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
    if (number != null) return number;
  }
  const pools = run.pools;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return null;
  let total = null;
  for (const entry of Object.values(pools)) {
    const value = finite(entry?.apiEquivalentUsd ?? entry?.costUsd ?? entry?.estimatedUsd);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

function durationMinutes(run) {
  if (!run || typeof run !== 'object') return null;
  const direct = [
    run.durationMinutes,
    run.minutes?.wall,
    run.wallMinutes,
    run.duration,
  ];
  for (const value of direct) {
    if (typeof value === 'string' && /[a-z]/i.test(value)) continue;
    const number = finite(value);
    if (number != null) return number;
  }
  const seconds = finite(run.wallSec ?? run.durationSec ?? run.attempt?.wallSec);
  return seconds == null ? null : seconds / 60;
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
  const minutes = durationMinutes(run);
  return minutes == null ? 'duration unavailable' : minutesText(minutes);
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
  if (run?.running) return 'running';
  const status = textOf(run?.status, null);
  if (!status) return 'stopped';
  return LIVE_STATUS_WORDS.has(status) ? 'interrupted' : status;
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
  for (const run of runs) {
    const cost = recordCost(run);
    if (cost != null) total = (total ?? 0) + cost;
  }
  return total;
}

function dayCount(day, runs) {
  if (runs.length) return runs.length;
  const finished = finite(day?.finished);
  if (finished != null) return Math.max(0, Math.round(finished));
  const count = finite(day?.runs);
  return count == null ? 0 : Math.max(0, Math.round(count));
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
    if (candidate.length <= cols) current = candidate;
    else if (current) { lines.push(`${indent}${current}`); current = word; }
    else {
      lines.push(`${indent}${cut(word, cols)}`);
      current = '';
    }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}

function renderRun(run, lines, regions, width, ansi) {
  const id = shortId(run) || '------';
  const action = { kind: 'run', runId: runId(run) || id };
  const detailIndent = widthOf(width) >= 60 ? '    ' : '  ';
  if (isLegacy(run)) {
    // The legacy mark sits before the project and the goal: at 55 columns a
    // fit drops the tail of the line, and a row must never lose the fact that
    // it is read-only history.
    push(lines, `  ${id}  legacy · read-only  ${project(run)}  ${goal(run)}`, width, ansi);
    addRegion(regions, lines, 3, id.length, action);
    const known = [];
    const minutes = durationMinutes(run);
    if (minutes != null) known.push(`ran ${minutesText(minutes)}`);
    const status = textOf(run.status ?? run.state?.status, null);
    if (status) known.push(status);
    const at = clock(runTime(run));
    // A time taken from a file's own mtime is a time, but not the run's: it
    // says when something last wrote to the directory. Label it rather than
    // let it read as the run's own record.
    const fromFiles = typeof run.timeSource === 'string' && run.timeSource.includes('directory');
    if (at) known.push(`finished ${at}${fromFiles ? ' (file time)' : ''}`);
    known.push('no V2 state or measured figures');
    for (const detail of wrapText(known.join(' · '), width, detailIndent)) push(lines, detail, width, ansi);
    return;
  }

  if (run?.unfinished === true) {
    // A run with no finish time: its elapsed time is the measured interval
    // from its own start, and the word says whether anything is still working
    // on it. Never a blank number — an unreadable start or last write says so.
    const mark = run.running ? glyphs().ongoing : glyphs().stopped;
    const suffix = run.running
      ? `${mark} running · ${elapsedText(run)} · no result yet`
      : `${mark} ${unfinishedWord(run)} · no result recorded · last write ${clock(run.lastWriteAt) ?? 'unavailable'}`;
    const leadWidth = widthOf(width);
    if (leadWidth >= 92) {
      const label = `  ${id}  ${project(run)}  ${goal(run)}`;
      // The separator is part of the budget: a row that does not count it is
      // one column over, and the frame then trims the mark the row exists for.
      const room = Math.max(1, leadWidth - visible(suffix).length - 2);
      push(lines, `${cut(label, room)}  ${suffix}`, width, ansi);
      addRegion(regions, lines, 3, id.length, action);
      return;
    }
    push(lines, `  ${id}  ${project(run)}  ${goal(run)}`, width, ansi);
    addRegion(regions, lines, 3, id.length, action);
    for (const detail of wrapText(suffix, width, detailIndent)) push(lines, detail, width, ansi);
    return;
  }

  const cost = recordCost(run);
  const estimate = apiEstimate(cost) ?? 'estimate unavailable (no recorded API-equivalent cost)';
  const at = clock(runTime(run)) ?? 'time unavailable';
  const duration = durationText(run);
  const leadWidth = widthOf(width);
  // At desktop widths the fields share one row.  On a phone the estimate's
  // required basis gets its own line so it is never clipped into a bare '$'.
  if (leadWidth >= 92) {
    const label = `  ${id}  ${project(run)}  ${goal(run)}`;
    const suffix = `  ${duration} · ${estimate} · ${at}`;
    const room = Math.max(1, leadWidth - visible(suffix).length - 1);
    const line = fit(`${cut(label, room)}${suffix}`, width, ansi);
    lines.push(line);
    addRegion(regions, lines, 3, id.length, action);
    return;
  }

  const label = fit(`  ${id}  ${project(run)}  ${goal(run)}`, width, ansi);
  lines.push(label);
  addRegion(regions, lines, 3, id.length, action);
  for (const detail of wrapText(`${duration} · ${estimate} · ${at}`, width, detailIndent)) lines.push(fit(detail, width, ansi));
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
    const onlyLegacy = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy)
      || (runs.length > 0 && runs.every((run) => isLegacy(run)));
    // A legacy-only day has no V2 usage record.  Even if a stale summary
    // happens to carry a spend field, showing it would make an unmeasured
    // legacy run look priced.
    const spend = onlyLegacy ? null : daySpend(day, runs);
    const summary = `${count} run${count === 1 ? '' : 's'}`;
    const money = apiEstimate(spend);
    // A day whose runs have not delivered has no estimate because there is no
    // result yet — a different reason from "nothing recorded", and the one the
    // reader needs.
    const inFlight = runs.length > 0 && runs.every((run) => run.unfinished === true);
    const basis = money ?? (inFlight ? 'no result recorded yet' : 'estimate unavailable (no recorded API-equivalent cost)');
    const right = `${summary} · ${basis}`;
    const ruleHeadWidth = visible(`── ${dateLabel(day.date)} `).length;
    const ruleTailWidth = visible(` ${right} ──`).length;
    if (cols >= 86 && ruleHeadWidth + ruleTailWidth < cols) {
      push(lines, rule(dateLabel(day.date), right, cols), cols, ansi);
    } else {
      push(lines, rule(`${dateLabel(day.date)} · ${summary}`, null, cols), cols, ansi);
      pushWrapped(lines, basis, cols, ansi);
    }
    if (!runs.length) {
      const legacyOnly = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy);
      pushWrapped(lines, legacyOnly
        ? '  Legacy workflows are read-only: no cost and no pool minutes were recorded.'
        : count > 0
          ? '  Workflow rows are not loaded for this day yet.'
          : '  No workflows recorded.', cols, ansi, '');
    } else {
      let normal = 0;
      for (const run of runs) {
        renderRun(run, lines, regions, cols, ansi);
        if (!isLegacy(run)) normal += 1;
      }
      if (!normal && runs.length) pushWrapped(lines, 'Legacy workflows are read-only: no cost and no pool minutes were recorded.', cols, ansi);
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
