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
import { taskKey } from '../lib/tasks.js';
import { formatMoney, formatUsageBasis } from '../lib/usage-basis.js';
import { runMinutesInfo, runProject, runStepCounts } from './home-model.js';
import { poolUsageAggregate, recordSpendFacts, spendFacts } from './spend-facts.js';
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

/**
 * The scope's money in the Runs list's own words.
 *
 * A whole scope keeps the estimate label it always had. A scope holding
 * attempts nobody priced reads `at least $X · N unmeasured` — the Run spend
 * block's own wording, through its own helper — so the row can never pass a
 * lower bound off as the whole sum. Nothing recorded stays `(cost unknown)`.
 */
function apiEstimateFor(info, { compact = false } = {}) {
  const whole = apiEstimate(info?.value ?? null, info?.tokenSource, { compact });
  const facts = info?.facts ?? null;
  const amount = finite(facts?.apiKnownSubtotalUsd);
  if (amount == null || !(facts.unmeasured > 0 || facts.running > 0)) return whole;
  const counted = [
    facts.running > 0 ? `${facts.running} running` : null,
    facts.unmeasured > 0 ? `${facts.unmeasured} unmeasured` : null,
  ].filter(Boolean).join(' · ');
  const text = `at least ${formatMoney(amount)}${counted ? ` · ${counted}` : ''}`;
  return compact ? text : `(${text})`;
}

function recordCostInfo(run) {
  const empty = { ...costInfo(null, 'unknown'), known: null, facts: null, counts: { attempts: 0, priced: 0, measured: 0, running: 0 } };
  if (!run || typeof run !== 'object') return empty;
  // The rollup's own usage aggregate carries the counts that say whether an
  // amount is whole; the direct fields below only say how much it is.
  const usageFacts = spendFacts(run.usage);
  const countsOf = (facts) => {
    const attempts = finite(facts?.attempts) ?? 0;
    const unmeasured = finite(facts?.unmeasured) ?? 0;
    const running = finite(facts?.running) ?? 0;
    return {
      attempts,
      priced: Math.max(0, attempts - unmeasured - running),
      measured: finite(facts?.measured) ?? 0,
      running,
    };
  };
  const direct = [
    run.apiEquivalentUsd,
    run.apiEquivalent?.usd,
    run.costUsd,
    run.estimateUsd,
    run.estimatedUsd,
    run.estimate,
    run.usage?.cost?.estimatedUsd,
    run.usage?.api?.usd,
    run.result?.usage?.cost?.estimatedUsd,
    run.result?.usage?.api?.usd,
  ];
  for (const value of direct) {
    const number = finite(value);
    if (number != null) {
      return {
        ...costInfo(number, run.tokenSource ?? run.usage?.tokenSource ?? run.result?.usage?.tokenSource),
        known: number,
        facts: usageFacts ?? spendFacts({ apiKnownSubtotalUsd: number }),
        counts: usageFacts ? countsOf(usageFacts) : { attempts: 0, priced: 0, measured: 0, running: 0 },
      };
    }
  }
  const attempts = [
    ...(run?.state?.preflight?.scout?.attempts ?? []),
    ...(run?.state?.planner?.attempts ?? []),
    ...(run?.state?.attempts ?? run?.attempts ?? []),
  ];
  if (attempts.length) {
    let known = null;
    let tokenSource = null;
    for (const attempt of attempts) {
      const amount = finite(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd);
      if (amount != null) known = (known ?? 0) + amount;
      tokenSource = worstTokenSource(tokenSource, attempt?.usage?.tokenSource);
    }
    const facts = recordSpendFacts(run, attempts);
    return {
      ...costInfo(known, tokenSource),
      known,
      facts,
      counts: {
        attempts: attempts.length,
        priced: attempts.filter((attempt) => finite(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd) != null).length,
        measured: attempts.filter((attempt) => attempt?.usage?.tokenSource === 'provider-reported').length,
        running: facts?.running ?? 0,
      },
    };
  }
  const aggregate = poolUsageAggregate(run.pools);
  if (!aggregate) return { ...costInfo(null, run.tokenSource), known: null, facts: null, counts: empty.counts };
  let tokenSource = Object.hasOwn(TOKEN_SOURCE_RANK, run.tokenSource) ? run.tokenSource : null;
  for (const entry of Object.values(run.pools ?? {})) {
    tokenSource = worstTokenSource(tokenSource, tokenSourceOf(entry?.tokenSource, finite(entry?.apiUsd ?? entry?.costUsd)));
  }
  // A legacy entry's missing coverage counts must not be read as "nothing was
  // priced": the aggregate only carries them when every entry named them.
  const counts = aggregate.complete
    ? { attempts: aggregate.attempts ?? 0, priced: aggregate.priced ?? 0, measured: aggregate.measured ?? 0, running: 0 }
    : { attempts: 0, priced: 0, measured: 0, running: 0 };
  const facts = usageFacts ?? spendFacts({
    attempts: aggregate.complete ? aggregate.attempts : null,
    pricedAttempts: aggregate.complete ? aggregate.priced : null,
    measuredAttempts: aggregate.measured,
    apiKnownSubtotalUsd: aggregate.known,
  });
  return {
    ...costInfo(aggregate.known, tokenSource),
    known: aggregate.known,
    facts,
    counts,
  };
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
  if (run?.running === true || run?.ongoing === true) return 'running';
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
  const value = run?.goal ?? run?.state?.intent?.goal ?? run?.state?.goal
    ?? run?.label ?? run?.title ?? run?.purpose;
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

/**
 * The day's spend, with the coverage that produced it.
 *
 * The day's stated `spendUsd` sums only the strict whole-scope amounts its
 * runs recorded, so a day holding one partly-priced run and one whole run
 * states the whole run's amount and looks complete. The rows themselves know
 * better: when any of them leaves attempts unpriced, the view sums their
 * recorded amounts and the count of attempts that are missing, so the day
 * rule reads `at least $X · N unmeasured` instead of a total it does not
 * have.
 */
function daySpendInfo(day, runs) {
  const stated = finite(day?.spendUsd ?? day?.apiEquivalentUsd ?? day?.spend);
  const entries = runs
    .filter((run) => !isTask(run) && !isLegacy(run))
    .map((run) => recordCostInfo(run));
  const partial = entries.some((info) => info.facts != null
    && (info.facts.unmeasured > 0 || info.facts.running > 0));
  if (stated != null && !partial) {
    let tokenSource = tokenSourceOf(day?.tokenSource, stated);
    for (const info of entries) tokenSource = worstTokenSource(tokenSource, info.tokenSource);
    return { ...costInfo(stated, tokenSource), facts: spendFacts({ apiKnownSubtotalUsd: stated }) };
  }
  let total = null;
  let known = null;
  let attempts = 0;
  let priced = 0;
  let measured = 0;
  let tokenSource = tokenSourceOf(day?.tokenSource, stated);
  for (const info of entries) {
    tokenSource = worstTokenSource(tokenSource, info.tokenSource);
    if (info.value != null) total = (total ?? 0) + info.value;
    if (info.known != null) known = (known ?? 0) + info.known;
    attempts += info.counts?.attempts ?? 0;
    priced += info.counts?.priced ?? 0;
    measured += info.counts?.measured ?? 0;
  }
  return {
    ...costInfo(total, tokenSource),
    known,
    facts: spendFacts({ attempts, pricedAttempts: priced, measuredAttempts: measured, apiKnownSubtotalUsd: known }),
  };
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
  if (unfinishedRun(run)) return run.running === true || run.ongoing === true ? glyphs().ongoing : glyphs().stopped;
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
  if (unfinishedRun(run)) return run.running || run.ongoing ? 'cyan' : 'red';
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

function taskId(task) {
  const value = textOf(task?.id ?? task?.taskFile, '');
  if (!value) return '—';
  // UUID-backed assignments are not useful as a whole on a table row. Keep
  // the short human-authored ids intact, and use the stable tail for UUIDs.
  return value.length > 8 ? value.slice(-8) : value;
}

function cleanTaskDescription(value) {
  return String(value ?? '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s*\([^)]*(?:worktree|branch\s+[^)]*|\bHEAD\b|open[- ]source)[^)]*\)\s*/gi, ' ')
    .replace(/^\s*(?:(?:workspace|repository|cwd)\s*:\s*)?(?:~|\.{0,2}\/|[A-Za-z]:\\)[^\s,;:]*(?:\s*[-–—:]\s*|\s+)/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

function taskSentences(source) {
  return String(source ?? '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((line) => line.trim().split(/(?<=[.!?])\s+(?=[A-Z#])/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function taskPreamble(sentence) {
  return /^(?:You are\b|Workspace:|Read-only\b|Repository:|cwd\b)/i.test(sentence.trim());
}

// Standing rules a worker brief repeats ("Edit only …", "Do not commit.",
// "Never read or write …") say how to work, not what the task is about.
function taskRule(sentence) {
  return /^(?:Run (?:every|all) commands?\b|Edit (?:only|nothing|no)\b|Only edit\b|Do not\b|Don't\b|Never\b|You may\b|Commit nothing\b|Leave (?:the|changes|it)\b|Real data only\b|No test\.skip\b|Work only\b|Territory:)/i
    .test(sentence.trim());
}

// A brief that opens with setup usually names its subject on a labelled line:
// "Outcome: …", "Goal: …", "Defect (owner screenshot): …". Labels are tried in
// this order, so a Defect wins over the Deliver list that follows it.
const SUBJECT_LABELS = ['outcome', 'goal', 'task', 'question', 'problem', 'defects?', 'bug', 'deliver'];

function labelledSubject(source) {
  const lines = String(source ?? '').replace(/\r/g, '').split('\n').map((line) => line.trim());
  for (const label of SUBJECT_LABELS) {
    const pattern = new RegExp(`^${label}\\b[^\\n]{0,100}?:\\s+(\\S.*)$`, 'i');
    for (const line of lines) {
      const text = line.match(pattern)?.[1];
      if (!text) continue;
      const first = taskSentences(text)[0]?.replace(/^\([0-9A-Za-z]\)\s*/, '') ?? '';
      if (!first) continue;
      return /^[a-z]+\b(?![/.`])/.test(first) ? first[0].toUpperCase() + first.slice(1) : first;
    }
  }
  return null;
}

function mostlyPath(sentence) {
  const withoutFacts = String(sentence ?? '')
    .replace(/\([^)]*(?:worktree|branch|\bHEAD\b|open[- ]source)[^)]*\)/gi, '')
    .trim();
  if (!withoutFacts) return true;
  const words = withoutFacts.split(/\s+/);
  return words.length <= 2 && words.every((word) => /^(?:(?:~|\.{0,2}\/|[A-Za-z]:\\)|[^\s]*[/\\][^\s]*)/.test(word));
}

/** A task's subject, ignoring worker/worktree setup prose when possible. */
export function taskDescription(task) {
  const source = typeof task?.taskText === 'string' ? task.taskText : '';
  const heading = source.split(/\r?\n/)
    .map((line) => line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .find(Boolean);
  if (heading) return cleanTaskDescription(heading) || '—';
  const labelled = labelledSubject(source);
  if (labelled) return cleanTaskDescription(labelled) || '—';
  const sentences = taskSentences(source);
  const chosen = sentences.find((sentence) => !taskPreamble(sentence) && !taskRule(sentence) && !mostlyPath(sentence))
    ?? sentences.find((sentence) => !taskPreamble(sentence) && !mostlyPath(sentence))
    ?? sentences.find((sentence) => !mostlyPath(sentence))
    ?? sentences[0];
  return cleanTaskDescription(chosen) || '—';
}

function taskDescriptionFallback(task) {
  const lane = textOf(task?.lane, '');
  const pool = textOf(task?.pool ?? task?.picked, '');
  return `${lane ? `${lane} task` : 'task'}${pool ? ` on ${pool}` : ''}`;
}

function compactMoney(info) {
  const amount = finite(info?.known ?? info?.value);
  if (amount == null) return '—';
  const lowerBound = (info?.facts?.unmeasured ?? 0) > 0 || (info?.facts?.running ?? 0) > 0;
  const prefix = lowerBound ? '≥'
    : info?.tokenSource === 'provider-reported' ? ''
      : info?.tokenSource === 'transcript-summed' ? '≈' : '~';
  const money = amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`;
  return `${prefix}${money}`;
}

function taskStartTime(record) {
  const direct = record?.startedAt;
  if (dateMs(direct) != null) return direct;
  const ended = dateMs(record?.endedAt ?? record?.finishedAt ?? record?.ts);
  const duration = finite(record?.durationMs);
  return ended != null && duration != null && duration >= 0 ? ended - duration : null;
}

function tableRowModel(record, nowMs = Date.now()) {
  const task = isTask(record);
  const legacy = !task && isLegacy(record);
  const cost = legacy ? costInfo(null, 'unknown') : recordCostInfo(record);
  let minutes = null;
  let fallback = false;
  if (task) {
    const measured = durationFacts(record).minutes;
    if (measured != null) minutes = measured;
    else {
      const started = dateMs(record?.startedAt);
      if (started != null && !record?.endedAt && !record?.finishedAt) minutes = Math.max(0, nowMs - started) / 60_000;
    }
  } else {
    const facts = runMinutesInfo(record, nowMs);
    minutes = facts.active;
    if (minutes == null) {
      minutes = durationFacts(record).minutes ?? facts.span;
      fallback = minutes != null;
    }
    if (minutes == null && finite(record?.elapsedMinutes) != null) minutes = finite(record.elapsedMinutes);
  }
  const steps = task ? null : runStepCounts(record);
  const id = task ? taskId(record) : shortId(record) || '—';
  const recordedTime = typeof record?.duration === 'string' && record.duration.trim()
    ? record.duration.trim().replace(/^span\s+/, '')
    : null;
  const mark = task
    ? record?.ok === false ? glyphs().fail
      : record?.ok === true || record?.endedAt || record?.finishedAt ? glyphs().ok : glyphs().ongoing
    : resultMark(record);
  const described = task ? taskDescription(record) : goal(record);
  const descriptionFallback = task && described === '—';
  return {
    record,
    task,
    mark,
    role: task ? (record?.ok === false ? 'red' : record?.ok === true || record?.endedAt || record?.finishedAt ? 'green' : 'cyan') : markRole(mark, record),
    id,
    project: runProject(record),
    what: descriptionFallback ? taskDescriptionFallback(record) : described,
    whatFallback: descriptionFallback,
    kind: task ? 'task' : steps.done != null && steps.total != null ? `${steps.done}/${steps.total} steps` : '—',
    time: minutes == null ? recordedTime ?? '—' : minutesText(minutes),
    timeFallback: fallback,
    cost: compactMoney(cost),
    start: clock(task ? taskStartTime(record) : record?.startedAt ?? record?.state?.lifecycle?.startedAt) ?? '—',
    action: task
      ? { kind: 'task', taskId: taskKey(record) }
      : { kind: 'run', runId: runId(record) || shortId(record) || '—' },
    unpriced: legacy ? 0
      : task ? (cost.value == null ? 1 : 0)
        : Math.max(0, cost?.facts?.unmeasured ?? (cost.value == null ? 1 : 0)),
    costInfo: cost,
  };
}

function tableLayout(rows, width) {
  const cols = widthOf(width);
  const max = (key, floor, ceiling) => Math.min(ceiling, Math.max(floor, ...rows.map((row) => visible(row[key]).length)));
  const layout = {
    id: 8,
    project: max('project', 7, 18),
    kind: max('kind', 4, 11),
    time: max('time', 4, 8),
    cost: max('cost', 1, 14),
    start: 5,
    showProject: true,
    showKind: true,
    showStart: true,
  };
  const fixed = () => 3 + layout.id
    + (layout.showProject ? 2 + layout.project : 0)
    + (layout.showKind ? 2 + layout.kind : 0)
    + 2 + layout.time + 2 + layout.cost
    + (layout.showStart ? 2 + layout.start : 0);
  // The description is the only elastic cell. It contracts first; once it
  // reaches its useful floor, columns disappear in the specified order.
  for (const key of ['showStart', 'showKind', 'showProject']) {
    if (cols - fixed() >= 10) break;
    layout[key] = false;
  }
  layout.what = Math.max(0, cols - fixed() - 2);
  return layout;
}

function cell(value, width, ansi, { align = 'left', role = null, strongText = false } = {}) {
  const plain = fit(value, width, false);
  const padded = align === 'right' ? plain.padStart(width) : plain.padEnd(width);
  if (strongText) return bold(padded, ansi);
  return role ? tint(padded, role, ansi) : padded;
}

/** Render one interleaved section with a single column calculation. */
export function runTableLines(records, {
  width = 120, ansi = true, nowMs = Date.now(), layout: suppliedLayout = null,
} = {}) {
  const cols = widthOf(width);
  const rows = (records ?? []).map((record) => tableRowModel(record, nowMs));
  const layout = suppliedLayout ?? tableLayout(rows, cols);
  const lines = [];
  const regions = [];
  for (const row of rows) {
    const parts = [
      ' ', tint(row.mark, row.role, ansi), ' ', cell(row.id, layout.id, ansi, { strongText: true }),
    ];
    if (layout.showProject) parts.push('  ', cell(row.project, layout.project, ansi));
    if (layout.what > 0) parts.push('  ', cell(row.what, layout.what, ansi, { role: row.whatFallback || row.what === '—' ? 'dim' : null }));
    if (layout.showKind) parts.push('  ', cell(row.kind, layout.kind, ansi, { align: 'right', role: row.kind === '—' ? 'dim' : null }));
    parts.push(
      '  ', cell(row.time, layout.time, ansi, { align: 'right', role: row.timeFallback || row.time === '—' ? 'dim' : null }),
      '  ', cell(row.cost, layout.cost, ansi, { align: 'right', role: 'dim' }),
    );
    if (layout.showStart) parts.push('  ', cell(row.start, layout.start, ansi, { align: 'right', role: 'dim' }));
    const line = fit(parts.join(''), cols, ansi);
    lines.push(line);
    // Hover covers text only, not terminal padding; Enter and click therefore
    // resolve through the same row action without lighting unused columns.
    addRegion(regions, lines, 2, Math.max(1, visible(line).length - 1), row.action);
  }
  return { lines, regions, rows, layout };
}

/** One layout shared by active rows and every currently loaded history day. */
export function runTableLayout(records, { width = 120, nowMs = Date.now() } = {}) {
  return tableLayout((records ?? []).map((record) => tableRowModel(record, nowMs)), width);
}

/**
 * Render date groups, newest date first and each day's workflows newest first.
 * Regions use 1-based x coordinates relative to the line that owns them; the
 * shell associates them with the returned line while composing its frame.
 */
export function historyLines(days, { width = 120, ansi = true, nowMs = Date.now(), layout = null } = {}) {
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

  const sharedLayout = layout ?? runTableLayout(list.flatMap(dayRows), { width: cols, nowMs });
  for (const day of list) {
    const runs = dayRows(day);
    const count = dayCount(day, runs);
    const tasks = taskCount(runs);
    const workflowRows = runs.filter((run) => !isTask(run));
    const onlyLegacy = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy)
      || (workflowRows.length > 0 && workflowRows.every((run) => isLegacy(run)));
    const summary = `${count} run${count === 1 ? '' : 's'}${tasks ? ` · ${tasks} task${tasks === 1 ? '' : 's'}` : ''}`;
    const table = runTableLines(runs, { width: cols, ansi, nowMs, layout: sharedLayout });
    let amount = null;
    let source = null;
    let unpriced = 0;
    for (const row of table.rows) {
      if (row.costInfo?.known != null) amount = (amount ?? 0) + row.costInfo.known;
      source = worstTokenSource(source, row.costInfo?.tokenSource);
      unpriced += row.unpriced;
    }
    // A day supplied as counts only can still carry its indexed total.
    if (!table.rows.length) amount = finite(day?.spendUsd ?? day?.apiEquivalentUsd ?? day?.spend);
    const money = onlyLegacy ? '—' : compactMoney({
      known: amount,
      value: amount,
      tokenSource: source ?? tokenSourceOf(day?.tokenSource, amount),
      facts: { unmeasured: unpriced, running: 0 },
    });
    const title = bold(dateLabel(day.date), ansi);
    const moneyText = money === '—' ? tint(money, 'dim', ansi) : tint(money, 'orange', ansi);
    const unpricedText = unpriced ? `${unpriced} unpriced` : '';
    const choices = [
      `${summary} · ${moneyText}${unpricedText ? ` · ${unpricedText}` : ''}`,
      `${summary}${unpricedText ? ` · ${unpricedText}` : ''}`,
      summary,
    ];
    const right = choices.find((candidate) => visible(rule(title, candidate, cols)).length === cols
      && visible(rule(title, candidate, cols)).endsWith(`${visible(candidate)} ──`)) ?? summary;
    push(lines, rule(title, right, cols), cols, ansi);
    if (!runs.length) {
      const legacyOnly = Boolean(day.legacyOnly || day.onlyLegacy || day.legacy);
      pushWrapped(lines, legacyOnly
        ? '  Legacy workflows are read-only: no cost and no pool minutes were recorded.'
        : count > 0
          ? '  Workflow rows are not loaded for this day yet.'
          : '  No workflows recorded.', cols, ansi, '');
    } else {
      const rowOffset = lines.length;
      for (const line of table.lines) lines.push(line);
      for (const region of table.regions) regions.push({ ...region, y: rowOffset + region.y });
      const normal = workflowRows.filter((run) => !isLegacy(run)).length;
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
