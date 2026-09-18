// The Stats page renderer.
//
// The stats-model module owns the arithmetic.  This module deliberately only
// turns those model objects into terminal lines and hit regions.  It accepts a
// complete set of models (`{ overview, trend, pools, models, projects }`) as
// well as the individual model shapes; that keeps the renderer useful while
// the dashboard shell refreshes each part at a different cadence.
//
// The composition is the approved prototype's (docs/design/prototype-frames):
// a heatmap sized to the history that exists, with month labels and the
// palette's four-shade ramp; a three-column figure grid carrying the busiest
// day and the streaks; Trends' stacks coloured per pool with a drawn
// running-total row and a capped legend; a real stepped line chart for
// licence-per-day and for per-model worker-minutes; one row per project with a
// sparkline beside its name.
//
// The prototype's numbers are illustrative; every figure here is the product's
// own reading, and a figure that is not a measurement keeps its `≈` and its
// basis.  A source the model does not carry is a blank with its reason, never
// an invented axis.

import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import {
  absentLine, chartRowCount, columnBars, columns, compactRow, cut, formatDashboardValue, heatRow, niceStep, periodToggle, progressBar, rule, seriesColor, seriesColors, sparkline, tabsRow,
} from './dash-kit.js';
import { METER_COLORS, paceWord, severityColor } from './usage-view.js';
import { PERIODS, TREND_METRICS } from './stats-model.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NO_BOLD = '\x1b[22m';
const TABS = Object.freeze([
  { id: 'overview', label: 'Overview', key: 'o' },
  { id: 'trends', label: 'Trends', key: 't' },
  { id: 'pools', label: 'Pools', key: 'p' },
  { id: 'models', label: 'Models', key: 'm' },
  { id: 'projects', label: 'Projects', key: 'j' },
]);
const PERIOD_ITEMS = Object.freeze([
  { id: '7d', label: 'Last 7 days', key: '7' },
  { id: '30d', label: 'Last 30 days', key: '3' },
  { id: 'all', label: 'All time', key: 'a' },
]);
/**
 * The Trends chips in the prototype's words.  `worker-minutes` is the one the
 * prototype does not name: it is the product's own measure and keeps its own
 * name rather than borrowing `licence used`, which is a different quantity and
 * gets its own chip where the meter history reaches.
 */
const METRIC_ITEMS = Object.freeze([
  { id: 'runs', label: 'runs finished' },
  { id: 'verified', label: 'verified share' },
  { id: 'spend', label: 'spent' },
  { id: 'minutes', label: 'worker-minutes' },
]);
/** The metric the retained licence history can answer. Not a TREND_METRICS id. */
const LICENCE_METRIC = 'licence';

/**
 * The colour a series takes, by rank.  The prototype names four roles for its
 * legends in this order (purple, amber, green, cyan) and paints the project
 * sparkline orange; the rest of the palette follows.
 */
const weekdayNames = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const monthNames = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

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

function textOf(value, fallback = '') {
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

function wrapped(text, width, indent = '') {
  const room = Math.max(1, widthOf(width) - visible(indent).length);
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [indent];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= room) current = next;
    else if (current) { lines.push(`${indent}${current}`); current = word; }
    else { lines.push(`${indent}${cut(word, room)}`); current = ''; }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const fgOf = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
};

/** `text` in one of the palette's hex values; a plain capture keeps the text. */
function painted(text, color, ansi) {
  const source = String(text ?? '');
  if (!ansi || !source || !isHex(color)) return source;
  return `${fgOf(color)}${source}${RESET}`;
}

function dimmed(text, ansi) {
  return painted(text, METER_COLORS.dim, ansi);
}

function bolded(text, ansi) {
  return ansi ? `${BOLD}${text}${NO_BOLD}${RESET}` : String(text ?? '');
}

// `y` is the 1-based index of the line the region was painted on, so the
// shell places a hit by row instead of searching for the text again.
function addRegion(regions, line, y, x, span, action) {
  const start = Math.max(1, Math.trunc(Number(x) || 1));
  const requested = Math.max(0, Math.trunc(Number(span) || 0));
  const room = Math.max(0, visible(line).length - start + 1);
  const actual = Math.min(requested, room);
  if (!actual || !action) return;
  regions.push({ x: start, y, width: actual, action });
}

function pushLine(lines, regions, text, width, ansi = true, lineRegions = []) {
  const line = fit(text, width, ansi);
  lines.push(line);
  const y = lines.length;
  for (const entry of lineRegions) addRegion(regions, line, y, entry.x, entry.width, entry.action);
  return line;
}

function pushWrapped(lines, regions, text, width, ansi = true, indent = ' ') {
  for (const line of wrapped(text, width, indent)) pushLine(lines, regions, line, width, ansi);
}

function modelObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeTab(value) {
  const id = String(value ?? 'overview').trim().toLowerCase();
  return TABS.some((tab) => tab.id === id) ? id : 'overview';
}

function normalizePeriod(value) {
  const id = String(value ?? '7d').trim().toLowerCase();
  return PERIODS.includes(id) ? id : '7d';
}

/** `licence` is accepted only when the payload actually carries the history. */
function normalizeMetric(value, licence = false) {
  const id = String(value ?? 'runs').trim().toLowerCase();
  if (id === LICENCE_METRIC) return licence ? id : 'runs';
  return TREND_METRICS.includes(id) ? id : 'runs';
}

function periodItem(period) {
  return PERIOD_ITEMS.find((item) => item.id === period) ?? PERIOD_ITEMS[0];
}

/** The prototype's period words, as the chart rules print them. */
function periodWords(period) {
  if (period === '30d') return 'last 30 days';
  if (period === 'all') return 'all time';
  return 'last 7 days';
}

function asRows(candidate) {
  if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === 'object');
  if (candidate && Array.isArray(candidate.rows)) return candidate.rows.filter((row) => row && typeof row === 'object');
  if (candidate?.rows && typeof candidate.rows === 'object') return Object.values(candidate.rows).filter((row) => row && typeof row === 'object');
  return [];
}

function tableModel(stats, kind, overview) {
  const hasRows = (candidate) => candidate && typeof candidate === 'object'
    && (Array.isArray(candidate.rows) || (candidate.rows && typeof candidate.rows === 'object'));
  if (modelObject(stats)?.kind === kind && hasRows(stats)) return stats;
  const direct = modelObject(stats)?.[kind];
  if (direct && !Array.isArray(direct) && hasRows(direct)) return direct;
  const table = modelObject(stats)?.tables?.[kind];
  if (table && !Array.isArray(table) && hasRows(table)) return table;
  const named = modelObject(stats)?.[`${kind.slice(0, -1)}Model`];
  if (named && !Array.isArray(named) && hasRows(named)) return named;
  const singular = modelObject(stats)?.[kind.slice(0, -1)];
  if (singular && !Array.isArray(singular) && hasRows(singular)) return singular;
  const breakdown = modelObject(overview)?.breakdown;
  if (Array.isArray(breakdown?.[kind])) {
    return {
      rows: breakdown[kind],
      totals: null,
      notes: [],
      licence: kind === 'pools' ? overview?.today?.licence ?? null : null,
    };
  }
  if (Array.isArray(direct)) return { rows: direct, totals: null, notes: [] };
  return { rows: [], totals: null, notes: [] };
}

function overviewModel(stats) {
  const object = modelObject(stats) ?? {};
  const nested = modelObject(object.overview) ?? modelObject(object.overviewModel);
  if (!nested) return object;
  // Some shells keep the shared breakdown beside the overview object while
  // others keep it inside; preserve either shape without copying arithmetic.
  return object.breakdown && !nested.breakdown ? { ...nested, breakdown: object.breakdown } : nested;
}

function trendModel(stats, metric, period) {
  const object = modelObject(stats) ?? {};
  const candidates = [
    Array.isArray(object.buckets) ? object : null,
    object.trend,
    object.trends,
    object[metric],
    modelObject(object.overview)?.trend,
  ];
  const find = (candidate) => {
    if (Array.isArray(candidate)) {
      const exact = candidate.find((entry) => entry && typeof entry === 'object'
        && (!entry.metric || entry.metric === metric)
        && (!entry.period || entry.period === period)
        && Array.isArray(entry.buckets));
      return exact ?? candidate.map(find).find(Boolean) ?? null;
    }
    if (!candidate || typeof candidate !== 'object') return null;
    if (Array.isArray(candidate.buckets)) return candidate;
    const byMetric = candidate[metric];
    const metricModel = find(byMetric);
    if (metricModel) return metricModel;
    if (Array.isArray(byMetric?.buckets)) return byMetric;
    if (Array.isArray(byMetric?.[period]?.buckets)) return byMetric[period];
    const byPeriod = candidate[period];
    const periodModel = find(byPeriod);
    if (periodModel) return periodModel;
    if (Array.isArray(byPeriod?.buckets)) return byPeriod;
    if (Array.isArray(byPeriod?.[metric]?.buckets)) return byPeriod[metric];
    return null;
  };
  for (const candidate of candidates) {
    const found = find(candidate);
    if (found) return found;
  }
  return null;
}

function totalFromRows(rows, field) {
  let total = 0;
  let measured = false;
  for (const row of rows) {
    const value = finite(row?.[field]);
    if (value == null) continue;
    total += value;
    measured = true;
  }
  return measured ? total : null;
}

function percent(value) {
  const number = finite(value);
  return number == null ? null : `${Math.round(number * 100)}%`;
}

function apiEstimate(value) {
  const money = formatDashboardValue(value, 'money');
  return money == null ? null : `≈ ${money} API-equivalent estimate`;
}

function spendText(value) {
  return apiEstimate(value) ?? 'estimate unavailable (no recorded API-equivalent cost)';
}

function spendShort(value) {
  const money = formatDashboardValue(value, 'money');
  return money == null ? null : `≈ ${money} API`;
}

function minutesText(value) {
  return formatDashboardValue(value, 'minutes') ?? 'worker time unavailable';
}

/** `Thu 17 Sep`, the frame's own day label. */
function dateLabel(value) {
  const source = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (!match) return source || 'unknown day';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (!Number.isFinite(date.getTime())) return source;
  const weekday = weekdayNames[(date.getDay() + 6) % 7];
  return `${weekday} ${date.getDate()} ${monthNames[date.getMonth()]}`;
}

/** `10 Sep`, the frame's chart label. */
function shortDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return textOf(value, '');
  return `${Number(match[3])} ${monthNames[Number(match[2]) - 1]}`;
}

function bucketLabel(bucket) {
  if (bucket == null) return 'unknown';
  if (typeof bucket.label === 'string' && bucket.label && !/^nan$/i.test(bucket.label)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket.label)) return dateLabel(bucket.label);
    return bucket.label;
  }
  return textOf(dateLabel(bucket.key ?? bucket.date ?? bucket.from), 'unknown');
}

/** Merge adjacent model buckets when a phone-width chart cannot give each one
 * a readable label and two-cell column.  The first bucket remains the action's
 * drill target, so a grouped 30-day or all-time column opens its first day. */
function mergeTrendBuckets(group) {
  const first = group[0] ?? {};
  const last = group.at(-1) ?? first;
  let value = null;
  let runs = 0;
  const segmentMap = new Map();
  for (const bucket of group) {
    const amount = finite(bucket?.value);
    if (amount != null) value = (value ?? 0) + amount;
    runs += finite(bucket?.runs) ?? 0;
    for (const segment of Array.isArray(bucket?.segments) ? bucket.segments : []) {
      const part = finite(segment?.value);
      if (part == null) continue;
      const current = segmentMap.get(segment.name) ?? { value: 0, color: segment.color };
      current.value += part;
      if (!current.color && segment.color) current.color = segment.color;
      segmentMap.set(segment.name, current);
    }
  }
  return {
    ...first,
    key: first.key,
    label: group.length > 1 ? `${bucketLabel(first)}–${bucketLabel(last)}` : first.label,
    from: first.from,
    to: last.to,
    runs,
    value,
    segments: [...segmentMap.entries()]
      .map(([name, part]) => ({ name, value: part.value, color: part.color }))
      .sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name))),
  };
}

function trendDisplayBuckets(buckets, period, width) {
  const list = Array.isArray(buckets) ? buckets : [];
  if (!list.length) return [];
  // The prototype uses weekly columns for the 30-day view.  All-time buckets
  // already arrive weekly; a longer corpus is coalesced only as far as the
  // available terminal can display with a useful four-cell label.
  let groupSize = period === '30d' ? 7 : 1;
  const maxColumns = Math.max(1, Math.floor((widthOf(width) - 8) / 4));
  if (Math.ceil(list.length / groupSize) > maxColumns) {
    groupSize = Math.max(groupSize, Math.ceil(list.length / maxColumns));
  }
  const out = [];
  for (let index = 0; index < list.length; index += groupSize) {
    out.push(mergeTrendBuckets(list.slice(index, index + groupSize)));
  }
  return out;
}

/**
 * The x labels a chart's cells can carry: `10 Sep` where the cell is wide
 * enough, the day alone where it is not, and the prototype's `today` / `now`
 * for the newest day (the bucket the model's own range ends in).
 */
function chartTickLabels(entries, cellWidth, { narrow = false } = {}) {
  // A cell reserves its last column as the gap to the next one, which is the
  // room the label really has.
  const room = Math.max(0, Math.trunc(cellWidth) - 1);
  return entries.map((entry, index) => {
    const key = String(entry?.key ?? '');
    const merged = String(entry?.label ?? '').includes('–');
    if (index === entries.length - 1 && !merged && entry?.key != null) {
      if (narrow) return room >= 3 ? 'now' : '';
      // A wide chart can carry the same concrete day label the History page
      // uses.  Keep `today` as the compact fallback when the cell is tighter.
      const concrete = dateLabel(entry.key ?? entry.date);
      if (room >= visible(concrete).length && concrete !== 'unknown day') return concrete;
      if (room >= 5) return 'today';
      return room >= 3 ? 'now' : '';
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
    if (!match) {
      const text = String(entry?.label ?? '');
      return visible(text).length <= room ? text : '';
    }
    const day = String(Number(match[3]));
    const month = monthNames[Number(match[2]) - 1] ?? '';
    if (room >= 6) return `${day} ${month}`;
    return room >= 1 ? day : '';
  });
}

/** How wide one chart cell gets for `count` cells inside `cols`. */
function cellWidthFor(cols, count, { axisRoom = 6, base = 12 } = {}) {
  const axisWidth = Math.max(1, Math.min(axisRoom, cols - 1 - count));
  const available = Math.max(1, cols - axisWidth - 1);
  return Math.max(1, Math.min(base, Math.floor(available / Math.max(1, count))));
}

function metricLabel(metric) {
  const item = METRIC_ITEMS.find((entry) => entry.id === metric);
  if (item) return item.label;
  return metric === LICENCE_METRIC ? 'licence used' : metric;
}

function metricValueText(metric, value) {
  if (metric === 'spend') return spendText(value);
  const number = finite(value);
  if (number == null) return `${metricLabel(metric)} unavailable`;
  if (metric === 'minutes') return `${minutesText(number)} measured`;
  if (metric === 'verified') return `${Math.round(number)} verified`;
  return `${Math.round(number)} runs`;
}

/** The metrics whose figures are money, so their chart marks them as estimates. */
const MONEY_METRICS = Object.freeze(['spend']);
/** What any figure that is not a measurement carries in front of it. */
const ESTIMATE_MARK = '≈';
const MONEY_BASIS = 'Basis: ≈ $ API-equivalent estimates, recorded per attempt and summed over the period · — = none recorded';
const MONEY_BASIS_SHORT = '≈ $ API-equivalent estimate · — = none recorded';
const OVERVIEW_BASIS = 'Basis: ≈ $ API-equivalent estimates, recorded per attempt and summed over the period.';
const OVERVIEW_BASIS_SHORT = '≈ $ API-equivalent estimate, recorded per attempt.';

/**
 * The one line under a money chart that says what its figures are and what its
 * blank is. Budget and Home both call this quantity an API-equivalent estimate
 * and name the per-attempt recordings it sums, so the chart says the same in
 * the same words; a frame too narrow for the whole sentence gets the short
 * form, because a basis is only stated when it fits on one readable line.
 */
function moneyBasisLine(width, { overview = false } = {}) {
  const full = ` ${overview ? OVERVIEW_BASIS : MONEY_BASIS}`;
  if (visible(full).length <= widthOf(width)) return full;
  return ` ${overview ? OVERVIEW_BASIS_SHORT : MONEY_BASIS_SHORT}`;
}

function lineWithParts(parts, width, ansi = true) {
  const original = parts.map((part) => String(part?.text ?? '')).join('');
  const line = fit(original, width, ansi);
  const regions = [];
  let column = 1;
  for (const part of parts) {
    const text = String(part?.text ?? '');
    const span = visible(text).length;
    if (part?.action && column + span - 1 <= visible(line).length) {
      regions.push({ x: column, width: span, action: part.action });
    } else if (part?.action && column <= visible(line).length) {
      regions.push({ x: column, width: Math.max(1, visible(line).length - column + 1), action: part.action });
    }
    column += span;
  }
  return { line, regions };
}

function pushParts(lines, regions, parts, width, ansi = true) {
  const result = lineWithParts(parts, width, ansi);
  lines.push(result.line);
  const y = lines.length;
  for (const region of result.regions) regions.push({ ...region, y });
  return result.line;
}

function addPeriodRow(lines, regions, period, width, ansi) {
  const rendered = periodToggle(PERIOD_ITEMS, {
    active: period,
    width: widthOf(width),
    action: (item) => ({ kind: 'period', period: item.id }),
  });
  const text = ` ${rendered.text}`;
  const line = fit(text, width, ansi);
  lines.push(line);
  const y = lines.length;
  for (const region of rendered.regions) {
    const x = region.x + 1;
    const span = Math.min(region.width, Math.max(0, visible(line).length - x + 1));
    if (span > 0) regions.push({ x, y, width: span, action: region.action });
  }
}

/**
 * The title rule with the period toggle drawn inside it, the way the prototype
 * composes `── licence used per day, by pool ─── All time · Last 7 days ────`.
 * When the toggle cannot sit inside the rule it takes its own row underneath,
 * which is the prototype's own phone composition.
 */
function addTitleRule(lines, regions, title, period, width, ansi) {
  const cols = widthOf(width);
  const rendered = periodToggle(PERIOD_ITEMS, {
    active: period,
    width: cols,
    action: (item) => ({ kind: 'period', period: item.id }),
  });
  const plain = rendered.text;
  const head = title ? `── ${title} ` : '';
  const tail = plain ? ` ${plain} ──` : '';
  if (!plain || visible(head).length + visible(tail).length + 4 > cols) {
    pushLine(lines, regions, rule(title, null, cols), cols, ansi);
    addPeriodRow(lines, regions, period, cols, ansi);
    return;
  }
  const dashes = Math.max(1, cols - visible(head).length - visible(tail).length);
  const line = fit(`${head}${'─'.repeat(dashes)}${tail}`, cols, ansi);
  lines.push(line);
  const y = lines.length;
  const start = visible(head).length + dashes + 1;
  for (const region of rendered.regions) {
    const x = start + region.x - 1;
    const span = Math.min(region.width, Math.max(0, visible(line).length - x + 1));
    if (span > 0) regions.push({ x, y, width: span, action: region.action });
  }
}

function addMetricRow(lines, regions, metric, width, ansi, { licence = false } = {}) {
  const cols = widthOf(width);
  const items = licence ? [...METRIC_ITEMS, { id: LICENCE_METRIC, label: 'licence used' }] : [...METRIC_ITEMS];
  // A frame too narrow for every chip drops the product's own worker-minutes
  // chip before the prototype's four, and never drops the active one: the
  // reader's position is the one thing the row must keep.
  const build = (kept) => kept.flatMap((item, index) => (index ? [{ text: '  ' }] : []).concat({
    text: item.id === metric ? `[${item.label}]` : item.label,
    action: { kind: 'metric', metric: item.id },
  }));
  let kept = items.slice();
  const widthOfRow = () => build(kept).reduce((sum, part) => sum + visible(part.text).length, 0) + 1;
  while (kept.length > 1 && widthOfRow() > cols) {
    const candidates = kept
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.id !== metric);
    if (!candidates.length) break;
    const pick = candidates.find(({ item }) => item.id === 'minutes') ?? candidates[candidates.length - 1];
    kept = kept.filter((_, index) => index !== pick.index);
  }
  pushParts(lines, regions, [{ text: ' ' }, ...build(kept)], cols, ansi);
}

function emptyReason(model, metric, period) {
  const notes = Array.isArray(model?.notes) ? model.notes.filter(Boolean).join('; ') : '';
  const nulls = Array.isArray(model?.nulls) && model.nulls.length ? 'the model has no measured value' : '';
  if (metric === 'spend') return `no recorded API-equivalent estimates in ${period}`;
  if (metric === 'minutes') return `no measured worker-minutes in ${period}`;
  if (notes) return notes;
  if (nulls) return nulls;
  return `no ${metricLabel(metric)} recorded in ${period}`;
}

// ------------------------------------------------------------------ the figures

/**
 * The figures the prototype's grid carries that the key-value block does not
 * compute: the busiest day, the streak still alive, and the longest streak —
 * all read off the heat grid, which is the same days the heatmap above draws.
 * A day with no runs is a quiet day; the days before the history started carry
 * `inHistory: false` and are skipped rather than counted as quiet.
 */
function streakFigures(heat) {
  const days = (Array.isArray(heat?.days) ? heat.days : []).filter((day) => day?.inHistory !== false);
  if (!days.length) return { mostActiveDay: null, currentStreak: null, longestStreak: null };
  const busiest = days.reduce((best, day) => {
    const runs = finite(day.runs) ?? 0;
    return runs > (finite(best?.runs) ?? 0) ? day : best;
  }, days[0]);
  let longest = 0;
  let running = 0;
  for (const day of days) {
    running = (finite(day.runs) ?? 0) > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }
  // A streak is current while the newest measured day carried work and the
  // days before it ran back without a gap.
  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if ((finite(days[index].runs) ?? 0) <= 0) break;
    current += 1;
  }
  return {
    mostActiveDay: { date: busiest.date, runs: finite(busiest.runs) ?? 0 },
    currentStreak: current,
    longestStreak: longest,
  };
}

/** The longest run's short id, when the model carries one beside the minutes. */
function longestRunId(keys, model) {
  const candidates = [
    keys?.longestRun?.shortId, keys?.longestRun?.runId, keys?.longestRunShortId, keys?.longestRunId,
    model?.longestRun?.shortId, model?.longestRunId,
  ];
  for (const candidate of candidates) {
    const text = textOf(candidate, '');
    if (text) return text.length > 12 ? cut(text, 12) : text;
  }
  return null;
}

/**
 * The figure grid: three columns of four where the frame can carry them (the
 * prototype's own composition), one row per figure on a phone, where every
 * figure is one item and nothing is clipped to make a column fit.  Returns the
 * lines and the hit regions relative to the first line.
 */
function figureLines(model, width, ansi) {
  const cols = widthOf(width);
  const keys = model?.keys ?? {};
  const poolRows = asRows(model?.breakdown?.pools);
  const projectRows = asRows(model?.breakdown?.projects);
  const modelRows = asRows(model?.breakdown?.models);
  const workflows = finite(keys.workflows)
    ?? finite(model?.totals?.runs)
    ?? finite(model?.today?.finished)
    ?? totalFromRows(projectRows, 'runs')
    ?? totalFromRows(poolRows, 'runs');
  // The overview's figures follow its selected period.  `today.verifiedShare`
  // is a separate tile and must not leak into a seven-/thirty-day summary
  // when the period model already carries verified counts per row.
  const verified = finite(model?.verified) ?? finite(model?.totals?.verified);
  const measuredVerified = verified ?? totalFromRows(projectRows, 'verified') ?? totalFromRows(poolRows, 'verified');
  const verifiedShare = percent(model?.verifiedShare ?? model?.totals?.verifiedShare)
    ?? (measuredVerified != null && workflows > 0 ? `${Math.round(measuredVerified / workflows * 100)}%` : null);
  const spend = totalFromRows(poolRows, 'apiEquivalentUsd')
    ?? finite(model?.totals?.apiEquivalentUsd)
    ?? finite(model?.apiEquivalentUsd);
  const active = finite(keys.activeDays);
  const heat = model?.heat ?? {};
  const streak = streakFigures(heat);
  const span = finite(heat.spanDays);
  const favouritePool = modelObject(keys.favouritePool);
  const favouriteModel = modelObject(keys.favouriteModel);
  const busiestProject = modelObject(keys.busiestProject);
  const poolTotal = totalFromRows(poolRows, 'attempts');
  const modelTotal = totalFromRows(modelRows, 'attempts');
  const projectTotal = totalFromRows(projectRows, 'runs');
  const shareFor = (entry, total, field = 'attempts') => (entry && total > 0
    ? `${Math.round((finite(entry[field]) ?? 0) / total * 100)}%`
    : 'share unavailable');
  const runId = longestRunId(keys, model);

  const orange = (value) => painted(value, METER_COLORS.orange, ansi);
  const workflowText = workflows == null ? 'unavailable' : orange(`${Math.round(workflows)}`);
  const agentTime = finite(keys.totalAgentMinutes) == null
    ? 'Agent time: unavailable'
    : `Agent time: ${orange(minutesText(keys.totalAgentMinutes))}`;
  const spentShortText = spendShort(spend);
  const spentText = spentShortText == null ? 'Spent: estimate unavailable' : `Spent: ${orange(spentShortText)}`;
  const activeDays = active == null ? 'Active days: unavailable' : `Active days: ${orange(`${Math.round(active)}`)}`;
  const longestRun = finite(keys.longestRunMinutes) == null
    ? 'Longest run: unavailable'
    : `Longest run: ${orange(minutesText(keys.longestRunMinutes))}${runId ? ` (${runId})` : ''}`;
  const mostActive = streak.mostActiveDay
    ? `Most active day: ${orange(dateLabel(streak.mostActiveDay.date))} (${orange(`${Math.round(streak.mostActiveDay.runs)}`)} runs)`
    : 'Most active day: unavailable';
  const days = (count) => `${count} ${count === 1 ? 'day' : 'days'}`;
  const currentStreak = streak.currentStreak == null
    ? 'Current streak: unavailable'
    : `Current streak: ${orange(days(streak.currentStreak))}`;
  const longestStreak = streak.longestStreak == null
    ? 'Longest streak: unavailable'
    : `Longest streak: ${orange(days(streak.longestStreak))}`;
  const medianRun = finite(keys.medianRunMinutes) == null
    ? 'Median run: unavailable'
    : `Median run: ${orange(minutesText(keys.medianRunMinutes))}`;
  const favouritePoolText = `Favourite pool: ${orange(textOf(favouritePool?.name, 'unavailable'))} (${orange(shareFor(favouritePool, poolTotal))})`;
  const favouriteModelText = `Favourite model: ${orange(textOf(favouriteModel?.name, 'unavailable'))} (${orange(shareFor(favouriteModel, modelTotal))})`;
  const busiestProjectText = `Busiest project: ${orange(textOf(busiestProject?.name, 'unavailable'))} (${orange(shareFor(busiestProject, projectTotal, 'runs'))})`;

  if (cols < 90) {
    // The phone keeps one row per figure: the prototype's own six, then the
    // figures the phone frame has no room for.
    const rows = [
      ` Workflows: ${workflowText}${verifiedShare ? ` · verified ${orange(verifiedShare)}` : ''}`,
      ` ${agentTime} · ${spentText}`,
      ` ${activeDays}${span == null ? '' : ` / ${Math.round(span)}`}${streak.currentStreak == null ? '' : ` · streak ${streak.currentStreak}`}`,
      ` ${mostActive}`,
      ` ${longestRun}`,
      ` ${favouritePoolText}`,
      ` ${favouriteModelText}`,
      ` ${busiestProjectText}`,
      ` ${medianRun}${streak.longestStreak == null ? '' : ` · longest streak ${days(streak.longestStreak)}`}`,
    ];
    return { rows, regions: [] };
  }

  const cells = [
    { rows: [` Workflows: ${workflowText}${verifiedShare ? ` · verified ${verifiedShare}` : ''}`, ` ${activeDays}`, ` ${mostActive}`, ` ${busiestProjectText}`] },
    { rows: [` ${agentTime}`, ` ${longestRun}`, ` ${currentStreak}`, ` ${medianRun}`] },
    { rows: [` ${spentText}`, ` ${favouritePoolText}`, ` ${favouriteModelText}`, ` ${longestStreak}`] },
  ];
  const grid = columns(cells, { width: cols, gap: 2 });
  const meta = grid.meta ?? { columns: [] };
  const regions = [];
  // The two figures the Trends tab can chart: the run count and the spend.
  for (const [column, line, metric] of [[1, 1, 'runs'], [3, 1, 'spend']]) {
    const cell = meta.columns[column - 1];
    if (!cell) continue;
    regions.push({ line, x: cell.x, width: cell.width, action: { kind: 'metric', metric } });
  }
  return { rows: grid, regions };
}

// ------------------------------------------------------------------ line charts

/**
 * The licence ladder: 0 to 100% in quarters.  A licence reading is a share of
 * a quota, and the severity colours mean what they mean against that quota —
 * so the axis is the quota's own, not the observed maximum's.
 */
function percentageAxis() {
  return { step: 25, ticks: [0, 25, 50, 75, 100] };
}

/**
 * A stepped line chart: one line per series across the chart's x positions,
 * drawn with the prototype's glyphs (`─ ┌ ┐ └ ┘ │`) over a real y axis whose
 * ticks come from the values that exist.  Pools draw one line for the day's
 * licence reading in its severity colour; Models draw one line per model in
 * the model's own colour.
 *
 * Each x position owns `cellWidth` columns: the first is the joint where the
 * vertical connector between the previous level and this one is drawn, and the
 * rest carry the horizontal run.  A null reading breaks the line rather than
 * dropping it to zero — a day nobody measured is not a day at zero.  Lines are
 * drawn lowest rank first, so the series a reader is most likely to be looking
 * for sits on top at a shared level, and a crossing becomes `┼`.
 */
function stepChart(series, labels, {
  width = 120, height = 4, mark = '', unit = '', colors = true, severity = false, tail = null,
  labelRoom = 0, labelFor = null,
} = {}) {
  const cols = widthOf(width);
  const rows = Math.max(1, Math.trunc(Number(height)) || 4);
  const xLabels = (Array.isArray(labels) ? labels : []).map((label) => String(label ?? ''));
  const list = (Array.isArray(series) ? series : []).filter(Boolean);
  if (cols <= 0 || !list.length || !xLabels.length) return [];

  const measured = list.flatMap((entry) => (Array.isArray(entry.values) ? entry.values : []).map(finite))
    .filter((value) => value != null && value >= 0);
  if (!measured.length) return [];
  const axisInfo = unit === '%' ? percentageAxis() : niceStep(Math.max(...measured), rows);
  const top = axisInfo.ticks.at(-1) ?? 0;
  if (!(top > 0)) return [];

  const tickText = (value) => `${mark}${unit === '%'
    ? `${Number(value.toPrecision(3))}%`
    : unit === 'minutes' ? minutesText(value) : `${unit}${value}`}`;
  const gutter = axisInfo.ticks.reduce((most, tick) => Math.max(most, tickText(tick).length), 0) + 1;
  if (gutter + 2 > cols) return [];
  let count = xLabels.length;
  let cellWidth = Math.max(2, Math.floor((cols - gutter) / count));
  // More days than the frame can draw: keep the newest, which is where a
  // reader's eye goes first.
  while (count > 1 && gutter + cellWidth * count > cols) {
    count -= 1;
    cellWidth = Math.max(2, Math.floor((cols - gutter) / count));
  }
  const offset = xLabels.length - count;
  const view = xLabels.slice(offset);
  // A cell too narrow for a readable date labels every `every`-th cell and
  // lets the label span the run of cells it stands for, so a month-long chart
  // still reads `19 Aug  26 Aug …` instead of a row of single digits.
  const every = labelRoom > 0 ? Math.max(1, Math.ceil((labelRoom + 1) / cellWidth)) : 1;
  const stride = cellWidth * every;
  const asked = typeof labelFor === 'function' ? labelFor(stride) : null;
  const labelTexts = Array.isArray(asked) ? asked.slice(offset) : view;
  const seriesView = list.map((entry) => ({
    ...entry,
    values: (Array.isArray(entry.values) ? entry.values : []).slice(offset),
  }));

  const axisRow = rows;
  const rowOf = (value) => Math.max(0, Math.min(axisRow, axisRow - Math.round((value / top) * rows)));
  const grid = Array.from({ length: rows + 1 }, () => Array.from({ length: cols }, () => ({ ch: '', color: null })));
  const strong = (ch) => ch === '┌' || ch === '┐' || ch === '└' || ch === '┘' || ch === '┼';
  const put = (row, col, ch, color) => {
    if (row < 0 || row > axisRow || col < 0 || col >= cols) return;
    const cell = grid[row][col];
    if (!cell.ch) { cell.ch = ch; cell.color = color; return; }
    if (cell.ch === ch) return;
    if (!strong(cell.ch) && !strong(ch)) { cell.ch = '┼'; return; }
    if (strong(ch) && !strong(cell.ch)) { cell.ch = ch; cell.color = color; }
  };

  for (const entry of [...seriesView].reverse()) {
    let previousRow = null;
    view.forEach((_, index) => {
      const value = finite(entry.values?.[index]);
      if (value == null || value < 0) { previousRow = null; return; }
      const row = rowOf(value);
      const color = severity ? severityColor(value) : (entry.color ?? null);
      const joint = gutter + index * cellWidth;
      const start = index === 0 ? gutter : joint + 1;
      const end = Math.min(cols - 1, gutter + (index + 1) * cellWidth - 1);
      for (let col = start; col <= end; col += 1) put(row, col, '─', color);
      if (previousRow != null && index > 0) {
        const rising = row < previousRow;
        put(previousRow, joint, rising ? '┘' : '┐', color);
        put(row, joint, rising ? '┌' : '└', color);
        for (let between = Math.min(row, previousRow) + 1; between < Math.max(row, previousRow); between += 1) {
          put(between, joint, '│', color);
        }
      }
      previousRow = row;
    });
  }

  const tickAt = new Map();
  for (const tick of axisInfo.ticks) {
    const row = rowOf(tick);
    if (!tickAt.has(row)) tickAt.set(row, tick);
  }
  const lines = [];
  for (let row = 0; row <= axisRow; row += 1) {
    const tick = tickAt.get(row);
    const label = tick == null ? '' : tickText(tick);
    const axis = row === axisRow ? '┼' : '┤';
    let line = `${' '.repeat(Math.max(0, gutter - 1 - visible(label).length))}${label}${axis}`;
    let current = null;
    let run = '';
    const flush = () => {
      if (!run) return;
      line += colors && isHex(current) ? `${fgOf(current)}${run}${RESET}` : run;
      run = '';
    };
    for (let col = gutter; col < cols; col += 1) {
      const cell = grid[row][col];
      const color = cell.ch ? cell.color : null;
      if (cell.ch && color === current && run.trim()) { run += cell.ch; continue; }
      flush();
      if (cell.ch) { current = color; run = cell.ch; } else { current = null; run = ' '; flush(); }
    }
    flush();
    lines.push(line.replace(/ +$/, ''));
  }

  // The x labels: one per cell where they fit, every `every`-th cell where
  // they do not, so a narrow frame reads the newest days rather than clipped
  // month names.
  let labelLine = ' '.repeat(gutter);
  let index = 0;
  while (index < count) {
    const show = index === count - 1 || (count - 1 - index) % every === 0;
    const text = show ? cut(String(labelTexts[index] ?? ''), Math.max(0, stride - 1)) : '';
    const span = show ? stride : cellWidth;
    labelLine += `${text}${' '.repeat(Math.max(0, span - visible(text).length))}`;
    index += show ? every : 1;
  }
  let trailing = labelLine.replace(/ +$/, '');
  if (tail) {
    const tailText = `▏ ${tail}`;
    const room = cols - visible(trailing).length - tailText.length;
    if (room >= 1) trailing += `${' '.repeat(room)}${dimmed(tailText, colors)}`;
  }
  lines.push(trailing);
  Object.defineProperty(lines, 'meta', {
    enumerable: false,
    value: {
      axisRow: axisRow + 1, cellWidth, gutter, rows, top, ticks: axisInfo.ticks,
      columns: view.map((label, index) => ({ label, x: gutter + index * cellWidth + 1, width: cellWidth })),
    },
  });
  return lines;
}

// --------------------------------------------------------------------- trends

/**
 * The legend: every series the chart drew, wrapped onto as many rows as the
 * width needs — a legend never ends mid-name, never hides a name behind
 * `+N more`, and never paints past the width.
 */
function legendRows(names, { width = 120, ansi = true, colorOf = null } = {}) {
  const cols = widthOf(width);
  const items = (Array.isArray(names) ? names : []).filter(Boolean);
  if (!items.length || cols <= 0) return [];
  const mark = asciiGlyphsPreferred() ? '#' : '█';
  const separator = dimmed(' · ', ansi);
  const part = (entry) => `${painted(mark, colorOf ? colorOf(entry) : null, ansi)} ${entry.name}`;
  const rows = [];
  let current = [];
  for (const entry of items) {
    const candidate = [...current, entry].map(part).join(separator);
    if (current.length && visible(candidate).length > cols - 1) {
      rows.push(current);
      current = [entry];
    } else current.push(entry);
  }
  if (current.length) rows.push(current);
  return rows.map((row) => fit(` ${row.map(part).join(separator)}`, cols, ansi));
}

function trendLines(stats, lines, regions, width, period, metric, ansi, licence, poolModel = null, rowCount = null) {
  const cols = widthOf(width);
  lines.push('');
  addMetricRow(lines, regions, metric, cols, ansi, { licence });
  addPeriodRow(lines, regions, period, cols, ansi);
  lines.push('');
  if (metric === LICENCE_METRIC) {
    // `statsLines` normalizes top-level licence history into the pools model;
    // use that same normalized payload here so the chip and its chart cannot
    // disagree when a shell keeps the history beside the table.
    licenceTrendLines(poolModel ?? stats, lines, regions, cols, period, ansi);
    return;
  }
  const model = trendModel(stats, metric, period);
  const buckets = Array.isArray(model?.buckets) ? model.buckets : [];
  const measured = buckets.some((bucket) => {
    const value = finite(bucket?.value);
    if (value == null) return false;
    // Count metrics legitimately carry zero-valued buckets. A run count of
    // zero with no `runs` evidence is an empty period, not a chart whose axis
    // should be invented at zero.
    if (metric === 'runs' || metric === 'verified') {
      return value > 0 || (finite(bucket?.runs) ?? 0) > 0;
    }
    return true;
  });
  const total = finite(model?.total);
  if (!model || !buckets.length || (!measured && (total == null || total === 0))) {
    pushLine(lines, regions, rule(`${metricLabel(metric)} · ${periodWords(period)}`, null, cols), cols, ansi);
    pushWrapped(lines, regions, `Empty chart: no data — ${emptyReason(model, metric, period)}.`, cols, ansi, ' ');
    return;
  }

  const displayBuckets = trendDisplayBuckets(buckets, period, cols);
  const narrow = cols < 90;
  const money = MONEY_METRICS.includes(metric);
  const base = narrow ? 6 : Math.max(12, Math.floor((cols - 8) / displayBuckets.length));
  const names = [];
  for (const bucket of displayBuckets) {
    for (const segment of Array.isArray(bucket?.segments) ? bucket.segments : []) {
      if (!names.includes(segment.name)) names.push(segment.name);
    }
  }
  const colorByName = seriesColors(names);

  const series = names.length
    ? names.map((name) => ({
      color: colorByName.get(name),
      values: displayBuckets.map((bucket) => (bucket.value == null
        ? null
        : finite(bucket.segments?.find?.((segment) => segment.name === name)?.value) ?? 0)),
    }))
    : [{ values: displayBuckets.map((bucket) => bucket.value) }];
  const cellWidth = cellWidthFor(cols, displayBuckets.length, { axisRoom: 6 + (money ? 1 : 0), base });
  const labels = chartTickLabels(displayBuckets, cellWidth, { narrow: narrow || base < 12 });
  const chartLines = columnBars(series, labels, {
    width: cols,
    rowCount: rowCount ?? chartRowCount(narrow ? 26 : 36),
    col: base,
    barW: narrow ? Math.max(3, base - 1) : Math.max(7, base - 5),
    unit: money ? '$' : '',
    // A licence estimate is money too; a measured count is not, and carries
    // no mark at all.
    mark: money ? ESTIMATE_MARK : '',
    totals: true,
    // The running-total row the chart used to only name.
    cumulative: true,
    colors: ansi,
  });
  pushLine(lines, regions, rule(`${metricLabel(metric)} · ${periodWords(period)} · ${model?.bucketBy === 'week' ? 'per week' : 'per day'}${model?.truncated ? ' · history starts later' : ''}`, null, cols), cols, ansi);
  const meta = chartLines.meta ?? { chartRows: 0, axisRow: null, valueRow: null, columns: [] };
  chartLines.forEach((line, lineIndex) => {
    const lineRegions = [];
    for (const [index, column] of meta.columns.entries()) {
      // columnBars may keep only the newest columns at phone width. Preserve
      // the source bucket for its drill action instead of relabelling the
      // newest chart cell as the oldest bucket.
      const bucket = displayBuckets[column.sourceIndex ?? index];
      const action = { kind: 'trend', metric, period, bucket: bucket?.key ?? String(index) };
      // A region on every painted cell makes the visible column clickable;
      // the value row below also carries one for an empty/unmeasured bucket.
      const paintedCell = lineIndex < meta.chartRows
        && column.height > 0
        && lineIndex >= meta.chartRows - column.height;
      const valueRow = meta.valueRow != null && lineIndex === meta.valueRow - 1;
      const labelRow = meta.axisRow != null && lineIndex === meta.axisRow - 1;
      if (paintedCell || valueRow || labelRow) lineRegions.push({ x: column.x, width: column.width, action });
    }
    pushLine(lines, regions, line, cols, ansi, lineRegions);
  });
  if (money) pushLine(lines, regions, moneyBasisLine(cols), cols, ansi);
  const legendNames = chartLines.meta?.legend?.length ? chartLines.meta.legend : names;
  for (const line of legendRows(legendNames.map((name) => ({ name })), { width: cols, ansi, colorOf: (entry) => colorByName.get(entry.name) ?? seriesColor(entry.name) })) {
    pushLine(lines, regions, line, cols, ansi);
  }
  if (model?.segmentBasis) pushLine(lines, regions, ` ${dimmed(`Split basis: ${model.segmentBasis}`, ansi)}`, cols, ansi);
  const closing = metric === 'spend'
    ? (spendShort(total) ?? 'estimate unavailable')
    : (total == null ? `${metricLabel(metric)} unavailable` : metricValueText(metric, total));
  pushLine(lines, regions, ` ${painted(closing, METER_COLORS.orange, ansi)} ${dimmed(`over ${periodWords(period)}`, ansi)}`, cols, ansi);
}

/** The licence chip's own chart: the day's licence reading, per day. */
function licenceTrendLines(stats, lines, regions, cols, period, ansi) {
  // Accept both the complete stats envelope and the normalized pools table;
  // the latter is what `statsLines` passes when history lives beside rows.
  const model = modelObject(stats?.pools) ?? modelObject(stats) ?? {};
  const rows = licenceHistoryRows(model);
  pushLine(lines, regions, rule(`licence used · ${periodWords(period)} · per day`, null, cols), cols, ansi);
  if (!rows.length) {
    pushWrapped(lines, regions, `Empty chart: no data — ${textOf(model?.meterHistoryReason, 'meter history is not loaded').replace(/\.$/, '')}.`, cols, ansi, ' ');
    return;
  }
  if (!licenceSeries(rows).some((value) => value != null)) {
    pushWrapped(lines, regions, 'Empty chart: no data — no measured licence readings are retained.', cols, ansi, ' ');
    return;
  }
  for (const line of licenceChart(rows, cols, ansi)) pushLine(lines, regions, line, cols, ansi);
  const historyReason = textOf(model?.meterHistoryReason, '');
  if (historyReason) pushWrapped(lines, regions, historyReason, cols, ansi, ' ');
  const values = licenceSeries(rows).filter((value) => value != null);
  const peak = values.length ? Math.max(...values) : null;
  pushLine(lines, regions, ` ${painted(peak == null ? 'licence unavailable' : `${Math.round(peak)}% peak`, METER_COLORS.orange, ansi)} ${dimmed(`over ${periodWords(period)}`, ansi)}`, cols, ansi);
}

// ---------------------------------------------------------------------- pools

function historyValue(entry) {
  if (entry == null) return null;
  const direct = finite(entry?.usedPct ?? entry?.value ?? entry?.used);
  if (direct != null) return direct;
  for (const key of ['seven_day', 'weekly', 'five_hour', 'monthly']) {
    const value = finite(entry?.[key]?.utilization ?? entry?.[key]?.usedPct ?? entry?.[key]?.value);
    if (value != null) return value;
  }
  return finite(entry);
}

function historyLabel(entry, fallback = 'day') {
  const value = entry?.date ?? entry?.label ?? entry?.key ?? entry?.captured_at ?? entry?.capturedAt;
  const text = textOf(value, fallback);
  const isoDay = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  return isoDay ?? text.replace(/\.\d{3}Z$/, '');
}

function historySegments(entry) {
  if (Array.isArray(entry?.segments)) {
    return entry.segments
      .map((segment) => ({ name: textOf(segment?.name, ''), value: historyValue(segment), color: segment?.color }))
      .filter((segment) => segment.name || segment.value != null);
  }
  if (entry?.pools && typeof entry.pools === 'object' && !Array.isArray(entry.pools)) {
    return Object.entries(entry.pools)
      .map(([name, value]) => ({ name, value: historyValue(value), color: value?.color }))
      .filter((segment) => segment.value != null);
  }
  const value = historyValue(entry);
  return value == null ? [] : [{ value }];
}

function licenceHistoryRows(model) {
  const candidates = [model?.licencePerDay, model?.meterHistory, model?.licence?.days, model?.licence?.history, model?.licence];
  const candidate = candidates.find((value) => Array.isArray(value) && value.length)
    ?? candidates.find((value) => value != null);
  if (Array.isArray(candidate)) return candidate;
  if (!candidate || typeof candidate !== 'object') return [];
  if (Array.isArray(candidate.days)) return candidate.days;
  if (Array.isArray(candidate.history)) return candidate.history;

  // Accept either {date: entry} or {pool: entries}.  In the latter shape we
  // keep one row per pool/day rather than averaging unlike windows.
  const entries = Object.entries(candidate);
  if (entries.every(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))) {
    return entries.map(([date, entry]) => ({ date, ...(entry && typeof entry === 'object' ? entry : { value: entry }) }));
  }
  const rows = [];
  for (const [pool, values] of entries) {
    if (Array.isArray(values)) {
      for (const entry of values) rows.push({ ...(entry && typeof entry === 'object' ? entry : { value: entry }), label: `${pool} ${historyLabel(entry)}` });
    }
  }
  return rows;
}

/**
 * The day's licence reading: the hottest pool that reported one that day.  The
 * meters below the chart name every pool's own reading, so the line is the
 * fleet's pressure at that moment and the severity colours say how close it
 * ran to the window's ceiling.
 */
function licenceSeries(rows) {
  return rows.map((row) => {
    const values = historySegments(row).map((segment) => finite(segment.value)).filter((value) => value != null);
    return values.length ? Math.max(...values) : null;
  });
}

function licenceChart(rows, cols, ansi) {
  const values = licenceSeries(rows);
  const entries = rows.map((row) => ({ key: historyLabel(row) }));
  const narrow = cols < 90;
  return stepChart([{ values }], chartTickLabels(entries, cellWidthFor(cols, rows.length, { axisRoom: 4, base: 8 }), { narrow }), {
    width: cols,
    height: 4,
    unit: '%',
    colors: ansi,
    severity: true,
    tail: 'reset',
    // A day per cell is only readable while the cells are about a date wide;
    // a longer window labels every stride-th day instead of clipping them.
    labelRoom: 6,
    labelFor: (room) => chartTickLabels(entries, room, { narrow }),
  });
}

/**
 * Whether this day rolled the pool's quota window over. The producer says so
 * outright when it read the meter log; the `resetsAt` fallback exists for a
 * caller that only carries the boundary, and it allows a minute of slack
 * because providers restate the same boundary with sub-second jitter on every
 * read. A falling reading is never treated as a reset on its own — a refund
 * or a corrected reading looks the same.
 */
const RESET_SLACK_MS = 60_000;
function windowReset(segment, previous) {
  if (segment?.reset === true || segment?.windowReset === true) return true;
  const now = Date.parse(segment?.resetsAt ?? '');
  const before = Date.parse(previous?.resetsAt ?? '');
  return Number.isFinite(now) && Number.isFinite(before) && Math.abs(now - before) >= RESET_SLACK_MS;
}

/** A pool's own measured figures, one line's worth, or null when there are none. */
function poolFacts(row) {
  const runs = finite(row?.runs);
  if (runs == null) return null;
  const ok = percent(row?.okShare);
  const money = spendShort(row?.apiEquivalentUsd);
  const parts = [`${Math.round(runs)} runs`];
  if (ok) parts.push(`✓ ${ok}`);
  if (money) parts.push(money);
  return parts.join(' · ');
}

function poolMeterLines(model, lines, regions, cols, ansi) {
  const rows = asRows(model);
  const history = licenceHistoryRows(model);
  const liveRows = rows.filter((row) => modelObject(row?.live) || finite(row?.usedPct) != null);
  if (!liveRows.length && Array.isArray(model?.licence?.pools)) {
    for (const meter of model.licence.pools) liveRows.push({ name: meter.name, live: meter });
  }
  if (!history.length || !licenceSeries(history).some((value) => value != null)) {
    const reason = textOf(model?.meterHistoryReason, 'no measured licence readings are retained');
    pushWrapped(lines, regions, `Usage history unavailable: ${reason.replace(/\.$/, '')}.`, cols, ansi, ' ');
  }
  if (!liveRows.length) {
    pushWrapped(lines, regions, 'No live pool meter is available; licence usage is not measured.', cols, ansi, ' ');
    return;
  }
  lines.push('');
  const nameWidth = Math.min(cols < 90 ? 16 : 28, Math.max(7, ...liveRows.map((row) => textOf(row.name, 'unknown').length)));
  for (const row of liveRows) {
    const meter = modelObject(row.live) ? row.live : row;
    const used = finite(meter?.usedPct);
    const elapsed = finite(meter?.elapsedPct);
    // The pace word, not the reading pair: `48% · hot`, `37% · on track`.
    const word = paceWord(used, elapsed).text.replace(/\s*[+−]\d+pp$/, '');
    const reading = used == null ? 'meter unavailable' : `${Math.round(used)}%${word ? ` · ${word}` : ''}`;
    const facts = poolFacts(row);
    const name = cut(textOf(row.name, 'unknown'), nameWidth).padEnd(nameWidth);
    const actions = [{ x: 1, width: cols, action: { kind: 'page', page: 'budget', pool: textOf(row.name, 'unknown') } }];
    if (used == null) {
      // The name keeps the metered rows' one-cell indent and the reason starts
      // where their bar starts (` name spark `), so an unmetered pool reads as
      // another row rather than a stray line.
      const absent = absentLine(name, `meter unavailable${facts ? ` · ${facts}` : ''}`, { width: cols - 1, labelWidth: nameWidth + 9 });
      pushLine(lines, regions, absent ? ` ${absent}` : absent, cols, ansi, actions);
      continue;
    }
    const days = history.slice(-7);
    const segments = days.map((day) => Array.isArray(day.segments)
      ? day.segments.find((segment) => segment.name === row.name)
      : day.pools?.[row.name]);
    const values = segments.map((segment) => historyValue(segment));
    const markers = segments.flatMap((segment, index) => {
      const previous = segments[index - 1];
      return windowReset(segment, previous) ? [index] : [];
    });
    const shape = sparkline(values, 7, { markers });
    const historyText = shape ? [...shape].map((glyph, index) => values[index] == null && !markers.includes(index) ? ' ' : glyph).join('').padStart(7) : 'no history';
    const spark = painted(historyText, seriesColor(row.name), ansi);
    const tail = facts && cols >= 96 ? `  ${facts}` : '';
    const prefix = ` ${name} ${spark} `;
    const barWidth = Math.max(1, Math.min(64, cols - visible(prefix).length - reading.length - visible(tail).length - 2));
    const bar = progressBar(used / 100, barWidth);
    const color = severityColor(used);
    const markAt = used == null || elapsed == null
      ? null
      : Math.max(0, Math.min(barWidth - 1, Math.floor((elapsed / 100) * barWidth)));
    const paintedBar = markAt == null
      ? painted(bar, color, ansi)
      : `${painted(bar.slice(0, markAt), color, ansi)}${painted(asciiGlyphsPreferred() ? '|' : '▏', METER_COLORS.mark, ansi)}${painted(bar.slice(markAt + 1), color, ansi)}`;
    pushLine(lines, regions, `${prefix}${paintedBar}  ${reading}${tail}`, cols, ansi, actions);
    if (facts && cols < 96) pushLine(lines, regions, ` ${facts}`, cols, ansi, actions);
  }
  if (history.some((day) => historySegments(day).some((segment) => segment.value != null))) {
    pushWrapped(lines, regions, "each glyph is that day's usage at day end · a drop after ▏ is the window resetting", cols, ansi, ' ');
    if (model?.meterHistoryReason) pushWrapped(lines, regions, model.meterHistoryReason, cols, ansi, ' ');
  }
  const licence = modelObject(model?.licence);
  if (licence?.basis) pushWrapped(lines, regions, `Basis: ${licence.basis}.`, cols, ansi, ' ');
}

function poolLines(model, lines, regions, cols, period, ansi) {
  lines.push('');
  addTitleRule(lines, regions, 'licence by pool · last 7 days', period, cols, ansi);
  poolMeterLines(model, lines, regions, cols, ansi);
}

// --------------------------------------------------------------------- models

/** A model row's series, when the payload carries one keyed by name or by row. */
function rowSeries(model, row, index) {
  const direct = [row?.sparkline, row?.spark, row?.values, row?.daily]
    .find((value) => Array.isArray(value) && value.length);
  if (direct) return normalizeSeries(direct, 'runs');
  for (const map of [model?.sparklines, model?.series, model?.spark, model?.daily]) {
    const entry = modelObject(map)?.[row?.name] ?? (Array.isArray(map) ? map[index] : null);
    if (Array.isArray(entry) && entry.length) return normalizeSeries(entry, 'runs');
    if (Array.isArray(entry?.values)) return normalizeSeries(entry.values, 'runs');
  }
  return null;
}

/**
 * A table row's daily payload is deliberately richer than a sparkline's
 * scalar list (`{ date, runs, minutes, attempts }`).  Keep the view tolerant
 * of both that product shape and the small scalar fixture shape used by
 * callers: the Projects sparkline is runs/day, while a model chart is
 * worker-minutes/day.  Missing readings stay null, never a coerced zero.
 */
function normalizeSeries(values, field = 'runs') {
  if (!Array.isArray(values)) return null;
  return values.map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const candidate = entry[field] ?? entry.value ?? null;
      return finite(candidate);
    }
    return finite(entry);
  });
}

/**
 * At the wide frame, a seven-day series has only seven observations.  Repeat
 * each observed day over its proportional span so a wide sparkline uses the
 * available cells without fabricating intermediate measurements.  Narrow and
 * desktop prototype frames keep their original one-cell-per-day form.
 */
function stretchSeries(values, width) {
  const source = Array.isArray(values) ? values : [];
  const target = Math.max(0, Math.trunc(Number(width) || 0));
  if (!source.length || target <= 0) return [];
  if (target <= source.length) return source.slice(-target);
  return Array.from({ length: target }, (_, index) => source[Math.min(source.length - 1, Math.floor(index * source.length / target))]);
}

/**
 * How many cells one measured day may claim in a wide sparkline.  Past this a
 * seven-day series stops being a shape and becomes a run of identical glyphs,
 * so the rest of the frame goes to the figures beside the name instead.
 */
const WIDE_DAY_CELLS = 4;

/** The project sparkline window for a frame, retaining the measured values. */
function projectSparkline(values, name, cols) {
  const source = normalizeSeries(values, 'runs');
  if (!source || !source.some((value) => value != null)) return null;
  const wide = cols >= 160;
  const window = wide ? source : source.slice(-7);
  const width = wide
    ? Math.max(7, Math.min(window.length * WIDE_DAY_CELLS, Math.floor((cols - visible(name).length - 4) / 3)))
    : Math.min(7, window.length);
  const stretched = stretchSeries(window, width);
  const shape = sparkline(stretched, width);
  return shape || null;
}

/** The per-model or per-project trend the page charts, when the shell hands one over. */
function tableTrend(model) {
  for (const candidate of [model?.trend, model?.trends, model?.series]) {
    const found = modelObject(candidate);
    if (found && Array.isArray(found.buckets)) return found;
  }
  return null;
}

/** Build the model chart directly when a caller supplies row.daily only. */
function trendFromDailyRows(rows) {
  const list = asRows(rows);
  const names = list.map((row) => textOf(row?.name, 'unknown'));
  const count = list.reduce((most, row) => Math.max(most, Array.isArray(row?.daily) ? row.daily.length : 0), 0);
  if (!count || !names.length) return null;
  const buckets = Array.from({ length: count }, (_, index) => {
    const first = list.find((row) => Array.isArray(row?.daily) && row.daily[index]);
    const entry = first?.daily?.[index];
    return {
      key: textOf(entry?.date, String(index)),
      label: textOf(entry?.date, String(index)),
      segments: list.map((row, rowIndex) => {
        const day = Array.isArray(row?.daily) ? row.daily[index] : null;
        return {
          name: names[rowIndex],
          value: finite(day?.minutes ?? day?.value),
          minutes: finite(day?.minutes ?? day?.value),
          attempts: finite(day?.attempts),
        };
      }),
    };
  });
  return { metric: 'minutes', unit: 'worker-minutes', bucketBy: 'day', buckets };
}

/** The per-name series out of a trend model, kept in the rows' own order. */
function seriesFromTrend(trend, names, cols, { axisRoom = 7, narrow = false } = {}) {
  const buckets = Array.isArray(trend?.buckets) ? trend.buckets : [];
  const labels = chartTickLabels(buckets, cellWidthFor(cols, buckets.length, { axisRoom, base: 8 }), { narrow });
  return {
    labels,
    series: names.map((name) => ({
      name,
      values: buckets.map((bucket) => {
        const segment = (bucket?.segments ?? []).find((entry) => entry.name === name);
        return segment == null ? null : finite(segment.value);
      }),
    })),
    bucketBy: trend?.bucketBy ?? 'day',
  };
}

function modelLines(model, lines, regions, cols, period, ansi, rowCount = null) {
  lines.push('');
  const rows = asRows(model);
  const names = rows.map((row) => textOf(row.name, 'unknown'));
  // A model the buckets chart but the period list does not carry (for example,
  // a model last used just outside a table window) still gets its line drawn
  // and keyed.  Palette roles repeat deterministically after the available
  // roles are exhausted; every row therefore keeps a coloured key rather than
  // silently falling back to an unkeyed dim marker.
  const bucketNames = (Array.isArray(tableTrend(model)?.buckets) ? tableTrend(model).buckets : [])
    .flatMap((bucket) => Array.isArray(bucket?.segments) ? bucket.segments.map((segment) => textOf(segment?.name, '')) : [])
    .filter(Boolean);
  const keyed = [...new Set([...names, ...bucketNames])];
  const colorsBy = seriesColors(keyed);
  const trend = tableTrend(model) ?? trendFromDailyRows(rows);
  const drawn = trend
    ? seriesFromTrend(trend, keyed.filter((name) => (trend.buckets ?? [])
      .some((bucket) => (bucket?.segments ?? []).some((segment) => segment.name === name))), cols, { narrow: cols < 90 })
    : null;
  const chartUnit = 'minutes';
  addTitleRule(lines, regions, 'worker-minutes per day', period, cols, ansi);
  const chart = drawn && drawn.series.length
    ? columnBars(drawn.series.map((entry) => ({
      ...entry,
      color: colorsBy.get(entry.name),
      name: entry.name,
    })), drawn.labels, {
      width: cols,
      rowCount: rowCount ?? chartRowCount(cols < 90 ? 26 : 36),
      col: Math.max(2, Math.floor((cols - 7) / Math.max(1, drawn.labels.length))),
      barW: cols < 90 ? Math.max(3, Math.floor((cols - 7) / Math.max(1, drawn.labels.length)) - 1) : 7,
      unit: chartUnit,
      totals: true,
      colors: ansi,
    }) : [];
  if (chart.length) {
    for (const line of chart) pushLine(lines, regions, line, cols, ansi);
    for (const line of legendRows(drawn.series.map((entry) => ({ name: entry.name })), { width: cols, ansi, colorOf: (entry) => colorsBy.get(entry.name) })) {
      pushLine(lines, regions, line, cols, ansi);
    }
  } else {
    pushWrapped(lines, regions, 'No per-model daily series is loaded, so there is no chart to draw: the rollup records cost per pool, and the list below is the page\'s own model breakdown.', cols, ansi, ' ');
  }
  lines.push('');
  if (!rows.length) {
    pushWrapped(lines, regions, `No model data for ${period}; no measured workflows are in this period.`, cols, ansi, ' ');
    return;
  }
  const bullet = asciiGlyphsPreferred() ? '*' : '●';
  const basis = Number.isFinite(Number(model?.seriesTotalRows)) && Number(model.seriesTotalRows) > 0
    ? `${Math.max(0, Math.trunc(Number(model.seriesRows ?? 0)))} of ${Math.trunc(Number(model.seriesTotalRows))} rollups carried the per-model series`
    : null;
  for (const row of rows) {
    const name = textOf(row.name, 'unknown');
    const dotColor = colorsBy.get(name) ?? METER_COLORS.dim;
    const share = percent(row.minutesShare);
    const attempts = finite(row.attempts);
    const ok = percent(row.okShare);
    const p50 = finite(row.medianWallMinutes);
    const parts = [];
    if (attempts != null) parts.push(`${Math.round(attempts)} attempts`);
    // The ok-rate beside the attempt count, as the prototype draws it.
    parts.push(ok ? `${ok} ok` : 'ok-rate unavailable');
    if (p50 != null) parts.push(`p50 ${minutesText(p50)}`);
    if (cols < 90) {
      // The phone keeps one row per model: bullet, name and figures share the
      // row, squeezed with cut() rather than wrapped into a second form.
      pushLine(lines, regions, ` ${compactRow([
        { text: painted(bullet, dotColor, ansi) },
        // Keep a readable prefix of the model name while the figures field
        // gives cells back first.  This avoids a long model becoming only `…`
        // when the phone still has room for its key and facts.
        { text: bolded(name, ansi), width: Math.min(8, Math.max(1, visible(name).length)) },
        share ? { text: dimmed(`(${share})`, ansi), align: 'right' } : null,
        { text: dimmed(`· ${parts.join(' · ')}`, ansi), align: 'right', grow: true, min: 8 },
      // The row is written with a one-cell indent, so the fields share the
      // frame minus that cell; passing the full width would cost the last
      // field its final character to the frame's own truncation.
      ], { width: Math.max(1, cols - 1) })}`, cols, ansi, [
        { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
      ]);
      continue;
    }
    const heading = ` ${painted(bullet, dotColor, ansi)} ${bolded(name, ansi)}${share ? ` ${dimmed(`(${share})`, ansi)}` : ''}`;
    pushLine(lines, regions, heading, cols, ansi, [
      { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
    ]);
    pushLine(lines, regions, `   ${dimmed(parts.join(' · '), ansi)}`, cols, ansi, [
      { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
    ]);
  }
  if (basis) pushLine(lines, regions, ` ${dimmed(`Basis: ${basis}.`, ansi)}`, cols, ansi);
  pushLine(lines, regions, ` ${dimmed('Share is measured worker-minutes, not a licence draw.', ansi)}`, cols, ansi);
  const notes = Array.isArray(model?.notes) ? model.notes.filter(Boolean) : [];
  if (!notes.length) notes.push('no per-model money: the rollup record measures cost per pool, not per model');
  for (const note of notes) pushWrapped(lines, regions, painted(`Note: ${note}`, METER_COLORS.dim, ansi), cols, ansi, ' ');
}

// ------------------------------------------------------------------- projects

function projectLines(model, lines, regions, cols, period, ansi) {
  addPeriodRow(lines, regions, period, cols, ansi);
  lines.push('');
  // There is no 200-column prototype frame for Projects.  At the wide frame,
  // keep the list's section explicit across the available surface (rather
  // than leaving an empty band when a period has no sparkline data); populated
  // rows then use the same width for their measured sparkline.
  if (cols >= 160) pushLine(lines, regions, rule('projects · runs per day', null, cols), cols, ansi);
  const rows = asRows(model);
  if (!rows.length) {
    pushWrapped(lines, regions, `No project data for ${period}; no measured workflows are in this period.`, cols, ansi, ' ');
    return;
  }
  const trend = tableTrend(model);
  const names = rows.map((row) => textOf(row.name, 'unknown'));
  const fromTrend = trend ? new Map(seriesFromTrend(trend, names, cols).series.map((entry) => [entry.name, entry.values])) : new Map();
  let hasSeries = false;
  for (const [index, row] of rows.entries()) {
    const name = textOf(row.name, 'unknown');
    const values = fromTrend.get(name) ?? rowSeries(model, row, index);
    const shape = values && values.length ? projectSparkline(values, name, cols) : null;
    if (shape) hasSeries = true;
    const runs = finite(row.runs);
    const ok = percent(row.okShare);
    const money = spendShort(row.apiEquivalentUsd);
    const median = finite(row.medianWallMinutes);
    const parts = [];
    if (runs != null) parts.push(`${Math.round(runs)} runs`);
    if (ok) parts.push(`✓ ${ok}`);
    if (money) parts.push(money);
    if (median != null) parts.push(`${minutesText(median)} median`);
    const tail = `· ${parts.join(' · ')}`;
    if (cols < 90) {
      // The phone keeps one row per project: name, sparkline and figures on
      // the same row, squeezed rather than wrapped into a second form.
      pushLine(lines, regions, ` ${compactRow([
        // Keep a readable name prefix.  The figures field is elastic and gives
        // cells back before the name, so a long project does not collapse to a
        // lone ellipsis while its key facts still fit.
        { text: bolded(name, ansi), width: Math.min(8, Math.max(1, visible(name).length)) },
        shape ? {
          text: painted(shape, METER_COLORS.orange, ansi),
          width: visible(shape).length,
          min: Math.max(1, visible(shape).length),
        } : null,
        { text: dimmed(tail, ansi), align: 'right', grow: true, min: 8 },
      // The row is written with a one-cell indent, so the fields share the
      // frame minus that cell; passing the full width would cost the last
      // field its final character to the frame's own truncation.
      ], { width: Math.max(1, cols - 1) })}`, cols, ansi, [
        { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
      ]);
      continue;
    }
    if (cols >= 160) {
      // The wide frame has room for name, shape and figures on one row: the
      // figures sit against the right edge so the extra width carries facts
      // rather than a stretched glyph run.
      pushLine(lines, regions, ` ${compactRow([
        { text: bolded(name, ansi), width: Math.max(1, visible(name).length), min: 8 },
        shape ? {
          text: painted(shape, METER_COLORS.orange, ansi),
          width: visible(shape).length,
          min: 7,
          gap: 3,
        } : null,
        { text: dimmed(parts.join(' · '), ansi), align: 'right', grow: true, min: 8 },
      // The row is written with a one-cell indent, so the fields share the
      // frame minus that cell; passing the full width would cost the last
      // field its final character to the frame's own truncation.
      ], { width: Math.max(1, cols - 1) })}`, cols, ansi, [
        { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
      ]);
      continue;
    }
    pushLine(lines, regions, ` ${bolded(name, ansi)}${shape ? `   ${painted(shape, METER_COLORS.orange, ansi)}` : ''}`, cols, ansi, [
      { x: 1, width: cols, action: { kind: 'page', page: 'history' } },
    ]);
    pushLine(lines, regions, `   ${parts.join(' · ')}`, cols, ansi);
  }
  const basis = Number.isFinite(Number(model?.seriesTotalRows)) && Number(model.seriesTotalRows) > 0
    ? `${Math.max(0, Math.trunc(Number(model.seriesRows ?? 0)))} of ${Math.trunc(Number(model.seriesTotalRows))} rollups carried the per-project series`
    : null;
  if (basis) pushLine(lines, regions, ` ${dimmed(`Basis: ${basis}.`, ansi)}`, cols, ansi);
  if (!hasSeries) {
    pushWrapped(lines, regions, painted('No per-project daily series is loaded, so sparklines are unavailable.', METER_COLORS.dim, ansi), cols, ansi, ' ');
  }
  const notes = Array.isArray(model?.notes) ? model.notes.filter(Boolean) : [];
  for (const note of notes) pushWrapped(lines, regions, painted(`Note: ${note}`, METER_COLORS.dim, ansi), cols, ansi, ' ');
}

// ------------------------------------------------------------------ the page

function statsLines(stats, { width = 120, height = 36, tab = 'overview', period = '7d', metric = 'runs', ansi = true } = {}) {
  const cols = widthOf(width);
  const contentCols = cols;
  const activeTab = normalizeTab(tab);
  const activePeriod = normalizePeriod(period);
  const lines = [];
  const regions = [];

  const nav = tabsRow(TABS, {
    active: activeTab,
    width: cols,
    action: (item) => ({ kind: 'tab', tab: item.id }),
  });
  pushLine(lines, regions, nav.text, cols, ansi, nav.regions.map((region) => ({
    x: region.x, width: region.width, action: region.action,
  })));
  pushLine(lines, regions, ` ${activeTab[0].toUpperCase()}${activeTab.slice(1)} · ${periodItem(activePeriod).label}`, cols, ansi);

  const overview = overviewModel(stats);
  // The pools table carries the retained licence history beside its rows, so
  // the licence chip and the licence charts read from the one place.
  const poolRows = tableModel(stats, 'pools', overview);
  const pools = {
    ...poolRows,
    licencePerDay: poolRows.licencePerDay ?? stats?.licencePerDay ?? stats?.licenceHistory ?? null,
    meterHistory: poolRows.meterHistory ?? stats?.meterHistory ?? null,
    // The live meters' own basis — which pools are measured, and in which
    // window — lives with the overview's licence tile when the table has none.
    licence: poolRows.licence ?? modelObject(overview)?.today?.licence ?? null,
  };
  const licence = licenceHistoryRows(pools)
    .some((row) => historySegments(row).some((segment) => finite(segment.value) != null));
  const activeMetric = normalizeMetric(metric, licence);
  if (activeTab === 'overview') overviewLines(overview, lines, regions, contentCols, activePeriod, ansi);
  else if (activeTab === 'trends') trendLines(stats, lines, regions, contentCols, activePeriod, activeMetric, ansi, licence, pools, chartRowCount(height));
  else if (activeTab === 'pools') {
    poolLines(pools, lines, regions, contentCols, activePeriod, ansi);
  } else if (activeTab === 'models') {
    const base = tableModel(stats, 'models', overview);
    modelLines({ ...base, trend: base.trend ?? stats?.modelTrend ?? null }, lines, regions, contentCols, activePeriod, ansi, chartRowCount(height));
  } else {
    const base = tableModel(stats, 'projects', overview);
    projectLines({ ...base, trend: base.trend ?? stats?.projectTrend ?? null }, lines, regions, contentCols, activePeriod, ansi);
  }

  return { lines, regions };
}

function overviewLines(model, lines, regions, width, period, ansi) {
  const cols = widthOf(width);
  const heat = model?.heat;
  const days = Array.isArray(heat?.days) ? heat.days : [];
  lines.push('');
  pushLine(lines, regions, rule('activity · history that exists', null, cols), cols, ansi);
  if (!days.length) {
    pushWrapped(lines, regions, 'No workflow history yet — the heatmap has no measured days.', cols, ansi, ' ');
  } else {
    const weeks = Array.isArray(heat?.weeks) && heat.weeks.length
      ? heat.weeks
      : Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
    const prefix = 6;
    const room = Math.max(0, cols - prefix);
    const cellsFit = Math.max(1, Math.floor((room + 1) / 2));
    const shown = weeks.slice(Math.max(0, weeks.length - cellsFit));
    const monthLine = monthHeader(shown, prefix, room, ansi);
    if (monthLine) pushLine(lines, regions, monthLine, cols, ansi);
    for (const weekday of [0, 2, 4]) {
      const values = shown.map((week) => {
        const day = Array.isArray(week) ? week.find((entry) => entry?.weekday === weekday) ?? null : null;
        return !day || day.inHistory === false ? null : day.value;
      });
      const row = heatRow(values, { width: room, ansi });
      pushLine(lines, regions, ` ${weekdayNames[weekday]}  ${row}`, cols, ansi);
    }
    const span = finite(heat?.spanDays);
    const max = finite(heat?.max);
    const legend = `${heatRow([0, 0.34, 0.67, 1], { width: 8, ansi })}`;
    pushLine(lines, regions, ` ${dimmed('Less', ansi)} ${legend} ${dimmed('More', ansi)} · ${span == null ? 'history length unavailable' : `${Math.round(span)} measured days`} · busiest ${max == null ? 'unavailable' : `${Math.round(max)} runs`}`, cols, ansi);
  }
  lines.push('');
  addPeriodRow(lines, regions, period, cols, ansi);
  lines.push('');

  const figures = figureLines(model, cols, ansi);
  const start = lines.length;
  for (const line of figures.rows) pushLine(lines, regions, line, cols, ansi);
  for (const region of figures.regions) {
    const line = figures.rows[region.line - 1] ?? '';
    const span = Math.min(region.width, Math.max(0, visible(line).length - region.x + 1));
    if (span > 0) regions.push({ x: region.x, y: start + region.line, width: span, action: region.action });
  }
  pushLine(lines, regions, moneyBasisLine(cols, { overview: true }), cols, ansi);
  lines.push('');
  const playful = finite(model?.keys?.longestRunMinutes) == null
    ? 'Your longest-run story is waiting for a measured duration'
    : 'Your longest run would have taken a person about 3 working days';
  pushLine(lines, regions, ` ${painted(playful, METER_COLORS.purple, ansi)}`, cols, ansi);
}

/** The month names above the heat grid, one per month the grid reaches into. */
function monthHeader(weeks, prefix, room, ansi) {
  const marks = [];
  let lastMonth = null;
  weeks.forEach((week, index) => {
    const first = Array.isArray(week) ? week.find((day) => day && day.inHistory !== false) ?? week.find((day) => day) : null;
    const match = /^\d{4}-(\d{2})-\d{2}$/.exec(String(first?.date ?? ''));
    if (!match) return;
    const month = monthNames[Number(match[1]) - 1];
    if (!month || month === lastMonth) return;
    lastMonth = month;
    marks.push({ at: prefix + index * 2, month });
  });
  if (!marks.length) return null;
  let line = '';
  let last = -3;
  for (const mark of marks) {
    // `last` is the final painted column of the previous month.  A month may
    // start immediately after it (with one blank column between labels); the
    // old `last + month.length` guard incorrectly hid `Sep` after `Aug` in a
    // five-week phone grid.
    if (mark.at <= last) continue;
    line += `${' '.repeat(Math.max(0, mark.at - visible(line).length))}${dimmed(mark.month, ansi)}`;
    last = mark.at + mark.month.length - 1;
  }
  return visible(line).length <= room ? line : null;
}

export { statsLines };
