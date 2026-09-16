// The Stats page renderer.
//
// The stats-model module owns the arithmetic.  This module deliberately only
// turns those model objects into terminal lines and hit regions.  It accepts a
// complete set of models (`{ overview, trend, pools, models, projects }`) as
// well as the individual model shapes; that keeps the renderer useful while
// the dashboard shell refreshes each part at a different cadence.

import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import {
  columnBars, cut, formatDashboardValue, heatRow, periodToggle, progressBar, rule, stackedBars, tabsRow,
} from './dash-kit.js';
import { PERIODS, TREND_METRICS } from './stats-model.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
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
const METRIC_ITEMS = Object.freeze([
  { id: 'runs', label: 'Runs', key: 'r' },
  { id: 'spend', label: 'Spend', key: 's' },
  { id: 'minutes', label: 'Minutes', key: 'm' },
  { id: 'verified', label: 'Verified', key: 'v' },
]);

const metricLabel = Object.freeze({ runs: 'runs', spend: 'spend', minutes: 'worker-minutes', verified: 'verified runs' });
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

function normalizeMetric(value) {
  const id = String(value ?? 'runs').trim().toLowerCase();
  return TREND_METRICS.includes(id) ? id : 'runs';
}

function periodItem(period) {
  return PERIOD_ITEMS.find((item) => item.id === period) ?? PERIOD_ITEMS[0];
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

function minutesText(value) {
  return formatDashboardValue(value, 'minutes') ?? 'worker time unavailable';
}

function dateLabel(value) {
  const source = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (!match) return source || 'unknown day';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (!Number.isFinite(date.getTime())) return source;
  const weekday = weekdayNames[(date.getDay() + 6) % 7];
  return `${weekday} ${date.getDate()} ${monthNames[date.getMonth()]}`;
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

function compactBucketLabel(bucket, narrow, period) {
  const key = String(bucket?.key ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return cut(bucketLabel(bucket), narrow ? 4 : 14);
  const month = monthNames[Number(match[2]) - 1] ?? '';
  const day = String(Number(match[3]));
  if (!narrow) return bucketLabel(bucket);
  return period === 'all' ? `${day}${month}` : day;
}

function narrowMonthTitle(buckets) {
  const months = [];
  for (const bucket of buckets) {
    const match = /^\d{4}-(\d{2})-\d{2}$/.exec(String(bucket?.key ?? ''));
    const month = match ? monthNames[Number(match[1]) - 1] : null;
    if (month && !months.includes(month)) months.push(month);
  }
  return months.length ? months.join('–') : null;
}

function metricValueText(metric, value) {
  if (metric === 'spend') return spendText(value);
  const number = finite(value);
  if (number == null) return `${metricLabel[metric] ?? metric} unavailable`;
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

/**
 * The one line under a money chart that says what its figures are and what its
 * blank is. Budget and Home both call this quantity an API-equivalent estimate
 * and name the per-attempt recordings it sums, so the chart says the same in
 * the same words; a frame too narrow for the whole sentence gets the short
 * form, because a basis is only stated when it fits on one readable line.
 */
function moneyBasisLine(width) {
  const full = ` ${MONEY_BASIS}`;
  return visible(full).length <= widthOf(width) ? full : ` ${MONEY_BASIS_SHORT}`;
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

function addMetricRow(lines, regions, metric, width, ansi) {
  const pieces = [];
  for (const item of METRIC_ITEMS) {
    if (pieces.length) pieces.push({ text: '  ' });
    pieces.push({ text: item.id === metric ? `[${item.label}]` : item.label, action: { kind: 'metric', metric: item.id } });
  }
  pushParts(lines, regions, pieces, width, ansi);
}

function emptyReason(model, metric, period) {
  const notes = Array.isArray(model?.notes) ? model.notes.filter(Boolean).join('; ') : '';
  const nulls = Array.isArray(model?.nulls) && model.nulls.length ? 'the model has no measured value' : '';
  if (metric === 'spend') return `no recorded API-equivalent estimates in ${period}`;
  if (metric === 'minutes') return `no measured worker-minutes in ${period}`;
  if (notes) return notes;
  if (nulls) return nulls;
  return `no ${metricLabel[metric] ?? metric} recorded in ${period}`;
}

function overviewLines(model, lines, regions, width, period, ansi) {
  const heat = model?.heat;
  const days = Array.isArray(heat?.days) ? heat.days : [];
  lines.push('');
  pushLine(lines, regions, rule('activity · history that exists', null, width), width, ansi);
  if (!days.length) {
    pushLine(lines, regions, ` ${fit('No workflow history yet — the heatmap has no measured days.', Math.max(0, widthOf(width) - 1), ansi)}`, width, ansi);
  } else {
    const weeks = Array.isArray(heat?.weeks) && heat.weeks.length
      ? heat.weeks
      : Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
    const byWeekday = (weekday) => weeks.map((week) => {
      const day = Array.isArray(week)
        ? (week[weekday]?.weekday === weekday ? week[weekday] : week.find((entry) => entry?.weekday === weekday))
        : null;
      return !day || day.inHistory === false ? null : day.value;
    });
    const prefix = 5;
    for (const weekday of [0, 2, 4]) {
      const values = byWeekday(weekday);
      const row = heatRow(values, { width: Math.max(0, widthOf(width) - prefix), ansi });
      pushLine(lines, regions, ` ${weekdayNames[weekday]}  ${row}`, width, ansi);
    }
    const span = finite(heat?.spanDays);
    const max = finite(heat?.max);
    pushLine(lines, regions, ` Less ${asciiGlyphsPreferred() ? '.:=#' : '░▒▓█'} More · ${span == null ? 'history length unavailable' : `${Math.round(span)} measured days`} · busiest ${max == null ? 'unavailable' : `${Math.round(max)} runs`}`, width, ansi);
  }
  lines.push('');
  addPeriodRow(lines, regions, period, width, ansi);
  lines.push('');

  const breakdown = model?.breakdown ?? {};
  const poolRows = asRows(breakdown.pools);
  const projectRows = asRows(breakdown.projects);
  const modelRows = asRows(breakdown.models);
  const keys = model?.keys ?? {};
  const workflows = finite(keys.workflows)
    ?? finite(model?.totals?.runs)
    ?? finite(model?.today?.finished)
    ?? totalFromRows(projectRows, 'runs')
    ?? totalFromRows(poolRows, 'runs');
  const verified = finite(model?.verified) ?? finite(model?.totals?.verified) ?? finite(model?.today?.verified);
  const measuredVerified = verified ?? totalFromRows(projectRows, 'verified');
  const verifiedShare = percent(model?.verifiedShare ?? model?.totals?.verifiedShare ?? model?.today?.verifiedShare)
    ?? (measuredVerified != null && workflows > 0 ? `${Math.round(measuredVerified / workflows * 100)}%` : null);
  const spend = totalFromRows(poolRows, 'apiEquivalentUsd')
    ?? finite(model?.totals?.apiEquivalentUsd)
    ?? finite(model?.apiEquivalentUsd)
    ?? finite(model?.today?.apiEquivalentUsd);

  const workflowText = workflows == null ? 'workflows unavailable' : `${Math.round(workflows)} workflows`;
  const verificationText = verifiedShare ?? (measuredVerified == null ? 'verified share unavailable' : `${Math.round(measuredVerified)} verified`);
  pushParts(lines, regions, [
    { text: ' Workflows: ' },
    { text: workflowText, action: { kind: 'metric', metric: 'runs' } },
    { text: ` · ${verificationText}` },
  ], width, ansi);
  if (widthOf(width) < 90) {
    pushLine(lines, regions, ` Agent time: ${minutesText(keys.totalAgentMinutes)}`, width, ansi);
    pushParts(lines, regions, [
      { text: ' Spent: ' },
      { text: spendText(spend), action: { kind: 'metric', metric: 'spend' } },
    ], width, ansi);
  } else {
    pushParts(lines, regions, [
      { text: ' Agent time: ' },
      { text: minutesText(keys.totalAgentMinutes) },
      { text: ' · Spent: ' },
      { text: spendText(spend), action: { kind: 'metric', metric: 'spend' } },
    ], width, ansi);
  }
  const active = finite(keys.activeDays);
  pushLine(lines, regions, ` Active days: ${active == null ? 'unavailable' : Math.round(active)} · period ${period}`, width, ansi);
  const licence = model?.today?.licence ?? model?.licence;
  const maxLicence = finite(licence?.maxUsedPct);
  if (maxLicence == null) {
    pushWrapped(lines, regions, `Licence: unavailable (${licence?.basis ?? 'no measured pool meter'}).`, width, ansi, ' ');
  } else {
    const mean = finite(licence?.meanUsedPct);
    pushLine(lines, regions, ` Licence: max ${Math.round(maxLicence)}% used (${textOf(licence?.maxPool, 'pool')})${mean == null ? '' : ` · mean ${Math.round(mean)}%`}`, width, ansi);
    if (licence?.basis) pushWrapped(lines, regions, `Basis: ${licence.basis}.`, width, ansi, ' ');
  }

  const favouritePool = modelObject(keys.favouritePool);
  const favouriteModel = modelObject(keys.favouriteModel);
  const busiestProject = modelObject(keys.busiestProject);
  const poolTotal = totalFromRows(poolRows, 'attempts');
  const modelTotal = totalFromRows(modelRows, 'attempts');
  const projectTotal = totalFromRows(projectRows, 'runs');
  const shareFor = (entry, total, field = 'attempts') => entry && total > 0 ? `${Math.round((finite(entry[field]) ?? 0) / total * 100)}%` : 'share unavailable';
  pushLine(lines, regions, ` Favourite pool: ${textOf(favouritePool?.name, 'unavailable')} (${shareFor(favouritePool, poolTotal)})`, width, ansi);
  pushLine(lines, regions, ` Favourite model: ${textOf(favouriteModel?.name, 'unavailable')} (${shareFor(favouriteModel, modelTotal)})`, width, ansi);
  pushLine(lines, regions, ` Busiest project: ${textOf(busiestProject?.name, 'unavailable')} (${shareFor(busiestProject, projectTotal, 'runs')})`, width, ansi);
  pushLine(lines, regions, ` Median run: ${minutesText(keys.medianRunMinutes)} · longest ${minutesText(keys.longestRunMinutes)}`, width, ansi);
  lines.push('');
  const playful = keys.longestRunMinutes == null
    ? ' Your longest-run story is waiting for a measured duration.'
    : ' Your longest run would have taken a person about 3 working days.';
  pushLine(lines, regions, playful, width, ansi);
}

function trendLines(stats, lines, regions, width, period, metric, ansi) {
  lines.push('');
  addMetricRow(lines, regions, metric, width, ansi);
  addPeriodRow(lines, regions, period, width, ansi);
  lines.push('');
  const model = trendModel(stats, metric, period);
  const buckets = Array.isArray(model?.buckets) ? model.buckets : [];
  const measured = buckets.some((bucket) => finite(bucket?.value) != null);
  const total = finite(model?.total);
  if (!model || !buckets.length || !measured && (total == null || total === 0)) {
    pushLine(lines, regions, rule(`${metricLabel[metric] ?? metric} · ${period}`, null, width), width, ansi);
    pushWrapped(lines, regions, `Empty chart: no data — ${emptyReason(model, metric, period)}.`, width, ansi, ' ');
    return;
  }

  const displayBuckets = trendDisplayBuckets(buckets, period, width);
  const narrow = widthOf(width) < 90;
  const money = MONEY_METRICS.includes(metric);
  const segmentNames = [];
  const segmentColors = new Map();
  for (const bucket of displayBuckets) {
    for (const segment of Array.isArray(bucket?.segments) ? bucket.segments : []) {
      if (!segmentNames.includes(segment.name)) segmentNames.push(segment.name);
      if (!segmentColors.has(segment.name) && segment.color) segmentColors.set(segment.name, segment.color);
    }
  }
  const series = segmentNames.length
    ? segmentNames.map((name) => ({
      color: segmentColors.get(name),
      values: displayBuckets.map((bucket) => bucket.value == null
        ? null
        : finite(bucket.segments?.find?.((segment) => segment.name === name)?.value) ?? 0),
    }))
    : [{ values: displayBuckets.map((bucket) => bucket.value) }];
  const labels = displayBuckets.map((bucket) => compactBucketLabel(bucket, narrow, period));
  const chartLines = columnBars(series, labels, {
    width: widthOf(width),
    height: narrow ? 5 : 8,
    col: narrow ? 6 : 12,
    barW: narrow ? 2 : 7,
    unit: money ? '$' : '',
    // A licence estimate is money too; a measured count is not, and carries
    // no mark at all.
    mark: money ? ESTIMATE_MARK : '',
    totals: true,
    cumulative: money,
    colors: ansi,
  });
  const calendar = narrow && period !== 'all' ? narrowMonthTitle(displayBuckets) : null;
  pushLine(lines, regions, rule(`${metricLabel[metric] ?? metric} · ${period}${calendar ? ` · ${calendar}` : ''}${model?.truncated ? ' · history starts later' : ''}`, null, width), width, ansi);
  const meta = chartLines.meta ?? { chartRows: 0, axisRow: null, valueRow: null, columns: [] };
  chartLines.forEach((line, lineIndex) => {
    const lineRegions = [];
    for (const [index, column] of meta.columns.entries()) {
      const bucket = displayBuckets[index];
      const action = { kind: 'trend', metric, period, bucket: bucket?.key ?? String(index) };
      // A region on every painted cell makes the visible column clickable;
      // the value row below also carries one for an empty/unmeasured bucket.
      const painted = lineIndex < meta.chartRows
        && column.height > 0
        && lineIndex >= meta.chartRows - column.height;
      const valueRow = meta.valueRow != null && lineIndex === meta.valueRow - 1;
      const labelRow = meta.axisRow != null && lineIndex === meta.axisRow - 1;
      if (painted || valueRow || labelRow) lineRegions.push({ x: column.x, width: column.width, action });
    }
    pushLine(lines, regions, line, width, ansi, lineRegions);
  });
  if (money) pushLine(lines, regions, moneyBasisLine(width), width, ansi);
  if (segmentNames.length) pushLine(lines, regions, ` Legend: ${segmentNames.map((name) => `█ ${cut(name, 18)}`).join(' · ')}`, width, ansi);
  if (model?.segmentBasis) pushLine(lines, regions, ` Split basis: ${model.segmentBasis}`, width, ansi);
  pushLine(lines, regions, ` Total: ${metricValueText(metric, model?.total)} · running total`, width, ansi);
}

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

function poolMeterLines(model, lines, regions, width, ansi) {
  const rows = asRows(model);
  const history = licenceHistoryRows(model);
  const liveRows = rows.filter((row) => modelObject(row?.live) || finite(row?.usedPct) != null);
  if (!liveRows.length && Array.isArray(model?.licence?.pools)) {
    for (const meter of model.licence.pools) liveRows.push({ name: meter.name, live: meter });
  }
  pushLine(lines, regions, rule('licence per day · live meters', null, width), width, ansi);
  if (history.length) {
    const chartRows = history.map((entry) => {
      return { label: historyLabel(entry), segments: historySegments(entry) };
    });
    for (const line of stackedBars(chartRows, { width: widthOf(width), colors: ansi })) pushLine(lines, regions, line, width, ansi);
    if (model?.meterHistoryReason) pushWrapped(lines, regions, model.meterHistoryReason, width, ansi, ' ');
  } else {
    pushWrapped(lines, regions, 'Licence-per-day chart unavailable: meter history is not loaded.', width, ansi, ' ');
  }
  if (!liveRows.length) {
    pushWrapped(lines, regions, 'No live pool meter is available; licence usage is not measured.', width, ansi, ' ');
    return;
  }
  const nameWidth = Math.min(18, Math.max(7, Math.floor(widthOf(width) / 4)));
  for (const row of liveRows) {
    const meter = row.live ?? row;
    const used = finite(meter?.usedPct);
    const elapsed = finite(meter?.elapsedPct);
    const usedText = used == null ? 'meter unavailable' : `${Math.round(used)}% used`;
    const elapsedText = elapsed == null ? '' : `/${Math.round(elapsed)}% elapsed`;
    const suffix = `${usedText}${elapsedText}`;
    // Reserve enough room for both measured figures before choosing the bar
    // width.  The old fixed subtraction could clip the elapsed percentage at
    // 54 columns, leaving a licence figure without its complete label.
    const barWidth = Math.max(1, widthOf(width) - nameWidth - suffix.length - 3);
    const bar = used == null ? '·'.repeat(barWidth) : progressBar(used / 100, barWidth);
    pushLine(lines, regions, ` ${cut(textOf(row.name, 'unknown'), nameWidth).padEnd(nameWidth)} ${bar} ${usedText}${elapsedText}`, width, ansi, [
      { x: nameWidth + 3, width: barWidth, action: { kind: 'page', page: 'budget', pool: textOf(row.name, 'unknown') } },
    ]);
  }
}

function tableLines(kind, model, lines, regions, width, period, ansi) {
  const label = kind === 'pool' ? 'pools' : kind === 'project' ? 'projects' : kind;
  const rows = asRows(model);
  lines.push('');
  pushLine(lines, regions, rule(`${label} · ${period}`, null, width), width, ansi);
  if (!rows.length) {
    pushWrapped(lines, regions, `No ${label} data for ${period}; no measured workflows are in this period.`, width, ansi, ' ');
    return;
  }
  const mostUsed = model?.mostUsed;
  if (mostUsed) pushLine(lines, regions, ` Most used: ${textOf(mostUsed, 'unavailable')} · share is measured worker-minutes, not licence`, width, ansi);
  const nameWidth = Math.min(24, Math.max(8, Math.floor(widthOf(width) / 4)));
  for (const row of rows) {
    const runs = finite(row.runs);
    const complete = finite(row.workflowsCompleted);
    const share = percent(row.minutesShare);
    const p50 = finite(row.medianWallMinutes);
    const lead = ` ${cut(textOf(row.name, 'unknown'), nameWidth).padEnd(nameWidth)} ${runs == null ? '—' : `${Math.round(runs)} runs`} · ${complete == null ? 'completed unavailable' : `${Math.round(complete)} completed`} · ${share ?? 'share unavailable'} measured time`;
    const rowAction = kind === 'model' || kind === 'project'
      ? { kind: 'page', page: 'history' }
      : null;
    pushLine(lines, regions, lead, width, ansi, rowAction ? [{ x: 1, width: widthOf(width), action: rowAction }] : []);
    const details = [];
    if (finite(row.attempts) != null) details.push(`${Math.round(row.attempts)} attempts`);
    if (p50 != null) details.push(`p50 ${minutesText(p50)}`);
    if (kind !== 'model') details.push(spendText(row.apiEquivalentUsd));
    if (details.length) {
      const moneyDetail = details.find((detail) => detail.includes('$'));
      const otherDetails = details.filter((detail) => detail !== moneyDetail);
      if (otherDetails.length) pushWrapped(lines, regions, otherDetails.join(' · '), width, ansi, '   ');
      // Keep the estimate and its basis together.  A narrow screen may wrap
      // the surrounding p50/attempt facts, but it must never leave a bare
      // dollar figure on a line whose basis is on another clipped line.
      if (moneyDetail) pushWrapped(lines, regions, moneyDetail, width, ansi, '   ');
    }
  }
  const notes = Array.isArray(model?.notes) ? model.notes.filter(Boolean) : [];
  if (kind === 'model' && !notes.some((note) => /cost|api-equivalent/i.test(String(note)))) {
    notes.push('API-equivalent estimate is unavailable per model: cost is recorded per pool, not per model.');
  }
  for (const note of notes) pushWrapped(lines, regions, `Note: ${note}`, width, ansi, ' ');
}

function statsLines(stats, { width = 120, tab = 'overview', period = '7d', metric = 'runs', ansi = true } = {}) {
  const cols = widthOf(width);
  const activeTab = normalizeTab(tab);
  const activePeriod = normalizePeriod(period);
  const activeMetric = normalizeMetric(metric);
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
  if (activeTab === 'overview') overviewLines(overview, lines, regions, cols, activePeriod, ansi);
  else if (activeTab === 'trends') trendLines(stats, lines, regions, cols, activePeriod, activeMetric, ansi);
  else if (activeTab === 'pools') {
    const base = tableModel(stats, 'pools', overview);
    const model = {
      ...base,
      licencePerDay: base.licencePerDay ?? stats?.licencePerDay ?? stats?.licenceHistory ?? null,
      meterHistory: base.meterHistory ?? stats?.meterHistory ?? null,
    };
    lines.push('');
    addPeriodRow(lines, regions, activePeriod, cols, ansi);
    poolMeterLines(model, lines, regions, cols, ansi);
    tableLines('pool', model, lines, regions, cols, activePeriod, ansi);
  } else if (activeTab === 'models') {
    lines.push('');
    addPeriodRow(lines, regions, activePeriod, cols, ansi);
    tableLines('model', tableModel(stats, 'models', overview), lines, regions, cols, activePeriod, ansi);
  } else {
    lines.push('');
    addPeriodRow(lines, regions, activePeriod, cols, ansi);
    tableLines('project', tableModel(stats, 'projects', overview), lines, regions, cols, activePeriod, ansi);
  }

  return { lines, regions };
}

export { statsLines };
