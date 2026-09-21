// Stats is a data adapter around stat-kit. All arithmetic belongs to
// stats-model; this module chooses model-owned values for the four tabs and
// turns them into the shared surface's input shape.

import { formatDashboardValue, periodToggle, seriesColors } from './dash-kit.js';
import {
  chartAxisRowIndex,
  formatHoverLabel,
  paintChartHoverReadout,
  renderColumnChart,
  renderLegend,
  renderPanel,
  renderStackedColumnChart,
  renderStatsSurface,
  measurePanelGridLayout,
} from './stat-kit.js';
import { apiMoney, apiMoneyText, formatMoneyPair } from '../lib/usage-basis.js';
import { honestApiTotalText, spendFacts } from './spend-facts.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TABS = Object.freeze([
  { id: 'spending', label: 'Spending', key: 's' },
  { id: 'pool', label: 'Pool', key: 'p' },
  { id: 'model', label: 'Model', key: 'm' },
  { id: 'project', label: 'Project', key: 'j' },
]);
const PERIODS = Object.freeze([
  { id: '7d', label: '7d', key: '7' },
  { id: '30d', label: '30d', key: '3' },
  { id: 'all', label: 'all', key: 'a' },
]);
const TAB_ALIASES = Object.freeze({ overview: 'spending', trends: 'spending', pools: 'pool', models: 'model', projects: 'project' });

export const STATS_TABS = Object.freeze(TABS.map((tab) => tab.id));

const visible = (value) => String(value ?? '').replace(SGR, '');
const RESET = '\x1b[0m';

/**
 * Clip a line by terminal cells without discarding its SGR sequences. The
 * divider and the panel grid are composed after their children render, so a
 * plain String#slice here would either move the divider or leave a colour run
 * open. This deliberately has no ellipsis: the desktop frame historically
 * clipped at the column edge and its geometry must not move.
 */
function clipVisible(value, width) {
  const text = String(value ?? '');
  const number = Number(width);
  const cols = Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  if (cols <= 0) return '';
  if (visible(text).length <= cols) return text;
  let out = '';
  let used = 0;
  for (let index = 0; index < text.length && used < cols;) {
    if (text[index] === '\x1b') {
      const match = text.slice(index).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    out += text[index];
    index += 1;
    used += 1;
  }
  return `${out}${text.includes('\x1b') ? RESET : ''}`;
}

function padVisible(value, width) {
  const number = Number(width);
  const cols = Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  if (cols <= 0) return '';
  const clipped = clipVisible(value, cols);
  return `${clipped}${' '.repeat(Math.max(0, cols - visible(clipped).length))}`;
}
function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function widthOf(width, fallback = 55) {
  const number = Number(width);
  return Number.isFinite(number) ? Math.max(1, Math.trunc(number)) : fallback;
}
function fit(value, width) {
  const text = String(value ?? '');
  const cols = widthOf(width);
  return visible(text).length <= cols ? text : clipVisible(text, cols);
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function normalizeTab(value) {
  const id = String(value ?? 'spending').trim().toLowerCase();
  const normalized = TAB_ALIASES[id] ?? id;
  return STATS_TABS.includes(normalized) ? normalized : 'spending';
}
function normalizePeriod(value) {
  const id = String(value ?? '7d').trim().toLowerCase();
  return PERIODS.some((period) => period.id === id) ? id : '7d';
}
function rowName(row) {
  return String(row?.name ?? row?.id ?? row?.label ?? 'unknown');
}
function colorName(name) {
  const value = String(name ?? '');
  return value === 'model cost unavailable' ? 'unallocated' : value;
}
function panelRowName(row) {
  if (!row || row.id === '__more__' || /^\+\d+ more$/.test(String(row.label ?? ''))) return null;
  const name = String(row.fullLabel ?? row.label ?? row.id ?? '').trim();
  return name || null;
}
function panelColorNames(panels) {
  return [...new Set((Array.isArray(panels) ? panels : [])
    .flatMap((panelInput) => Array.isArray(panelInput?.rows) ? panelInput.rows : [])
    .map(panelRowName)
    .filter(Boolean)
    .map(colorName))];
}
function colorPanels(panels, colors) {
  return (Array.isArray(panels) ? panels : []).map((panelInput) => ({
    ...panelInput,
    rows: (Array.isArray(panelInput?.rows) ? panelInput.rows : []).map((row) => {
      const name = panelRowName(row);
      if (!name) return row;
      const color = colors?.get(colorName(name));
      return color ? { ...row, color } : row;
    }),
  }));
}
function rowsOf(candidate) {
  if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === 'object');
  if (candidate && Array.isArray(candidate.rows)) return candidate.rows.filter((row) => row && typeof row === 'object');
  if (candidate?.rows && typeof candidate.rows === 'object') return Object.values(candidate.rows).filter((row) => row && typeof row === 'object');
  return [];
}
function tableModel(stats, kind, overview) {
  const source = object(stats) ?? {};
  const direct = source[kind];
  if (direct && !Array.isArray(direct)) return direct;
  const named = source[`${kind.slice(0, -1)}Model`];
  if (named && !Array.isArray(named)) return named;
  const breakdown = object(overview)?.breakdown;
  if (Array.isArray(breakdown?.[kind])) return { rows: breakdown[kind], totals: null, notes: [] };
  if (Array.isArray(direct)) return { rows: direct, totals: null, notes: [] };
  return { rows: [], totals: null, notes: [] };
}
function overviewModel(stats) {
  const source = object(stats) ?? {};
  const nested = object(source.overview) ?? object(source.overviewModel);
  if (!nested) return source;
  return source.breakdown && !nested.breakdown ? { ...nested, breakdown: source.breakdown } : nested;
}
function findTrend(candidate, metric = null) {
  if (!candidate) return null;
  if (Array.isArray(candidate)) return candidate.find((entry) => entry && (!metric || entry.metric === metric) && Array.isArray(entry.buckets)) ?? null;
  if (Array.isArray(candidate.buckets)) return !metric || candidate.metric === metric ? candidate : null;
  if (typeof candidate !== 'object') return null;
  for (const value of Object.values(candidate)) {
    const found = findTrend(value, metric);
    if (found) return found;
  }
  return null;
}
function trendFor(stats, tab, stackBy) {
  const source = object(stats) ?? {};
  const model = object(source.models);
  const project = object(source.projects);
  const pool = object(source.pools);
  if (tab === 'spending' && stackBy === 'model') {
    const cost = findTrend(source.modelSpendPerDay, 'spend') ?? findTrend(source.modelSpendTrend, 'spend') ?? findTrend(source.trends?.spend?.model, 'spend');
    if (cost) return { trend: cost, metric: 'spend', unit: 'usd', modelCostMeasured: true };
    const minutes = findTrend(source.modelTrend, 'minutes') ?? findTrend(model?.trend, 'minutes') ?? findTrend(source.trends?.minutes?.model, 'minutes');
    return { trend: minutes, metric: 'minutes', unit: 'minutes', modelCostMeasured: false };
  }
  if (tab === 'spending' || tab === 'pool') {
    const spend = findTrend(source.spendPerDay, 'spend') ?? findTrend(source.poolSpendPerDay, 'spend') ?? findTrend(source.trend, 'spend') ?? findTrend(pool?.trend, 'spend');
    return { trend: spend, metric: 'spend', unit: 'usd', modelCostMeasured: false };
  }
  if (tab === 'model') {
    const minutes = findTrend(source.modelTrend, 'minutes') ?? findTrend(model?.trend, 'minutes') ?? findTrend(source.trend, 'minutes');
    return { trend: minutes, metric: 'minutes', unit: 'minutes', modelCostMeasured: false };
  }
  const runs = findTrend(source.projectTrend, 'runs') ?? findTrend(project?.trend, 'runs') ?? findTrend(source.trend, 'runs');
  return { trend: runs, metric: 'runs', unit: 'runs', modelCostMeasured: false };
}
function totalFor(rows, totals, field, valueOf = null) {
  const declared = finite(totals?.[field]);
  if (declared != null) return declared;
  const read = valueOf ?? ((row) => finite(row?.[field]));
  let total = null;
  for (const row of rows) {
    const value = read(row);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}
function shareFor(row, value, total, preferred = null) {
  const explicit = finite(preferred);
  if (explicit != null) return explicit;
  return value != null && total != null && total > 0 ? value / total : null;
}
function costValue(row) {
  return apiMoney(row)?.usd ?? null;
}

function moneyText(rowOrValue, tokenSource = null, options = {}) {
  const row = rowOrValue && typeof rowOrValue === 'object'
    ? rowOrValue
    : { apiUsd: rowOrValue, tokenSource };
  const money = apiMoney(row);
  const subscription = row.subscription ?? {
    usd: finite(row.subscriptionUsd),
    deltaPct: finite(row.subscriptionDeltaPct ?? row.deltaPct),
    window: row.subscriptionWindow ?? row.window,
    basis: row.subscriptionBasis,
  };
  // The whole-scope label: the strict amount with its own basis words, or the
  // recorded subtotal marked `≈`. A partial scope replaces it with the Run
  // spend block's own lower bound and coverage (`at least $X · N unmeasured`).
  const pair = formatMoneyPair({
    api: { usd: money && !money.partial ? money.usd : null, tokenSource: row.tokenSource ?? tokenSource },
    subscription,
    tokens: row.tokens ?? null,
  });
  const [wholeApi, ...subscriptionText] = pair.split(' · ');
  const legacyApi = money?.partial
    ? apiMoneyText(money, null, row.tokens ?? null, options)
    : wholeApi;
  const facts = spendFacts(row);
  // A panel cell has room for the amount and its share and nothing else — a
  // longer phrase switches the panel grid's bars off, taking every row's hit
  // region with them. So the cell keeps the `at least` marker and drops the
  // word `api` (its panel title says what the money is) and the coverage
  // counts, which `coverageNote()` states once for the page and the hover
  // carries per row.
  const apiText = facts
    ? honestApiTotalText(facts, {
      api: options.compact === true ? null : 'api',
      whole: legacyApi,
      counts: options.compact === true ? 'none' : options.counts ?? 'unmeasured',
    })
    : legacyApi;
  // A panel row has a dozen columns for its conclusion, so it drops the
  // `sub unknown (…)` prose an amount-less subscription carries; the page's
  // own notes state the basis once instead. The summary keeps the full pair.
  if (options.compact === true && finite(subscription.usd) == null) return apiText;
  return [apiText, ...subscriptionText].join(' · ');
}
function minuteText(value) {
  const number = finite(value);
  return number == null ? 'value unavailable' : formatDashboardValue(number, 'minutes');
}
function countText(value, word) {
  const number = finite(value);
  return number == null ? 'value unavailable' : `${number} ${word}${number === 1 ? '' : 's'}`;
}
function percentText(value) {
  const number = finite(value);
  return number == null ? 'value unavailable' : `${Number((number * 100).toFixed(1))}%`;
}
function reasonFor(field, row = null) {
  if (row?.missingReason) return row.missingReason;
  if (field === 'apiEquivalentUsd') return 'cost not recorded';
  if (field === 'minutes') return 'worker-minutes not measured';
  if (field === 'attempts') return 'attempts not recorded';
  if (field === 'verified') return 'verification not recorded';
  return 'value unavailable';
}
function panelRows(table, field, unit, { shareField = null, valueText = null, missingReason = null } = {}) {
  const rows = rowsOf(table);
  const moneyField = field === 'apiEquivalentUsd';
  // The panel's whole is the sum of the figures its rows print, so a period
  // whose total is a strict-only null still measures its shares over every
  // recorded amount (S1: a share of nothing stays null).
  const total = totalFor(rows, table?.totals, field, moneyField ? costValue : null);
  return rows.map((row) => {
    const money = moneyField ? apiMoney(row) : null;
    const raw = money ? money.usd : finite(row?.[field]);
    let text = null;
    const hasSubscriptionMoney = unit === 'usd' && (
      finite(row?.subscriptionUsd) != null
      || finite(row?.subscription?.usd) != null
    );
    if (raw != null || hasSubscriptionMoney) {
      if (valueText) text = valueText(row, raw);
      // A panel cell has room for the amount, its share and nothing else, so
      // the row carries the `≈` mark and the panel's own share; the coverage
      // that makes a subtotal readable as a lower bound is named in full on
      // the hover and once for the page in the Coverage note.
      else if (unit === 'usd') text = moneyText(row, null, { compact: true, coverage: false });
      else if (unit === 'minutes') text = minuteText(raw);
      else if (unit === 'runs') text = countText(raw, 'run');
      else if (unit === 'attempts') text = countText(raw, 'attempt');
      else if (unit === 'percent') text = `${raw}%`;
    }
    return {
      id: rowName(row), label: rowName(row), fullLabel: rowName(row), value: raw, total,
      share: shareFor(row, raw, total, shareField ? row?.[shareField] : null),
      valueText: text,
      missingReason: missingReason ?? reasonFor(field, row),
      // A subtotal's coverage travels with the row so a hover can word the
      // figure as the lower bound it is.
      partial: money?.partial === true,
      priced: money?.priced ?? null,
      attempts: money?.attempts ?? null,
    };
  });
}
function limitedRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= 6) return list;
  return [...list.slice(0, 5), { id: '__more__', label: `+${list.length - 5} more`, value: null, missingReason: 'scroll for more' }];
}
function panel(title, rows, tab, metric, period, unit, basis = null, labelKind = null, sharedGrid = true) {
  // The desktop renderer measures one label/bar plan across all four cells.
  // The stacked phone path keeps the requested bar size but may measure each
  // full-width panel independently.
  return { title, rows: limitedRows(rows), labelWidth: sharedGrid ? null : 14, barWidth: 6, tab, metric, period, unit, basis, labelKind, sharedGrid };
}
/**
 * The fourth panel's rows. A duration is the run's active interval union where
 * the rollup carries one; where an index `workflow reprice` has not corrected
 * yet, the recorded span stands in and the row names how many runs that
 * covered, instead of printing `not recorded` over figures the records hold.
 */
function outcomeRows(outcomes) {
  if (!outcomes) return [{ id: 'outcome', label: 'Outcome data', value: null, missingReason: 'rollup outcomes unavailable' }];
  const statuses = Object.entries(outcomes.statusCounts ?? {});
  const statusTotal = statuses.reduce((sum, [, value]) => sum + (finite(value) ?? 0), 0);
  const completed = finite(outcomes.statusCounts?.completed) ?? 0;
  const otherStatuses = statuses.reduce((sum, [name, value]) => name === 'completed' ? sum : sum + (finite(value) ?? 0), 0);
  const statusText = statuses.length
    ? completed > 0
      ? `${completed} completed${otherStatuses > 0 ? ` · ${otherStatuses} other` : ''}`
      : `${statuses[0][1]} ${statuses[0][0]}${statuses.length > 1 ? ` · ${statusTotal - statuses[0][1]} other` : ''}`
    : null;
  const spanRuns = finite(outcomes.spanRuns) ?? 0;
  const durationRuns = finite(outcomes.durationRuns);
  // Compact enough for a shared panel cell: the page's own Durations note
  // spells the fallback out, and the count stays exact here.
  const spanNote = spanRuns > 0 && durationRuns != null ? ` · span ${spanRuns}/${durationRuns}` : '';
  const median = finite(outcomes.medianDurationMinutes ?? outcomes.medianActiveMinutes);
  const longest = finite(outcomes.longestDurationMinutes ?? outcomes.maxActiveMinutes);
  return [
    { id: 'status', label: 'Status', value: statuses.length ? statusTotal : null, valueText: statusText, missingReason: 'status not recorded' },
    { id: 'verified', label: 'Verified', value: finite(outcomes.verified), valueText: finite(outcomes.verified) == null ? null : `${outcomes.verified} verified`, share: outcomes.verifiedShare, total: outcomes.verifiedTotal, missingReason: 'verification not recorded' },
    { id: 'requirements', label: 'Requirements', value: finite(outcomes.requirementsPassed), valueText: finite(outcomes.requirementsPassed) != null && finite(outcomes.requirementsTotal) != null ? `${outcomes.requirementsPassed}/${outcomes.requirementsTotal} passed` : null, share: outcomes.requirementsShare, total: outcomes.requirementsTotal, missingReason: 'requirements not recorded' },
    { id: 'median-run', label: 'Median run', value: median, unit: 'minutes', valueText: median == null ? null : `${minuteText(median)} median${spanNote}`, missingReason: 'duration not recorded' },
    { id: 'longest-run', label: 'Longest run', value: longest, unit: 'minutes', valueText: longest == null ? null : `${minuteText(longest)} maximum${spanNote}`, missingReason: 'duration not recorded' },
  ];
}
function licenceRows(table) {
  return rowsOf(table).map((row) => {
    const used = finite(row?.live?.usedPct);
    const reset = row?.live?.resetsAt ? `reset ${String(row.live.resetsAt).slice(0, 10)}` : null;
    return { id: rowName(row), label: rowName(row), fullLabel: rowName(row), value: used, valueText: used == null ? null : `${used}%${reset ? ` · ${reset}` : ''}`, missingReason: 'meter unavailable' };
  });
}
function modelCostRows(table) {
  void table;
  return [{ id: 'model-cost', label: 'Cost', value: null, missingReason: 'per-pool only' }];
}

function desktopPanelColumns(panels, rightWidth, tab, period) {
  const inner = Math.max(2, rightWidth - 2);
  const widths = [Math.ceil(inner / 2), Math.floor(inner / 2)];
  const layout = panels.every((panelInput) => panelInput?.sharedGrid !== false)
    ? measurePanelGridLayout(panels, [widths[0], widths[1], widths[0], widths[1]])
    : null;
  const compose = (top, bottom, width) => {
    const draw = (input) => renderPanel({ ...input, width, ...(layout ? { layout } : {}) });
    const first = draw(top);
    const second = draw(bottom);
    const offset = first.lines.length + 1;
    return {
      // Keep each pre-rendered cell bounded before the outer grid joins it.
      // This is the panel-side sibling of the chart divider's visible-width
      // composition and retains the bar SGR codes while doing so.
      lines: [...first.lines.map((line) => padVisible(line, width)), '', ...second.lines.map((line) => padVisible(line, width))],
      regions: [
        ...(first.regions ?? []),
        ...(second.regions ?? []).map((region) => ({ ...region, row: region.row + offset })),
      ],
      tab,
      period,
    };
  };
  return [
    compose(panels[0], panels[2], widths[0]),
    compose(panels[1], panels[3], widths[1]),
  ];
}

function addDesktopDivider(chart, leftWidth, bodyHeight) {
  const lines = Array.from({ length: Math.max(bodyHeight, chart.lines.length) }, (_, index) => {
    const bodyWidth = Math.max(0, leftWidth - 1);
    const padded = padVisible(chart.lines[index] ?? '', bodyWidth);
    return `${padded}│`;
  });
  return { ...chart, lines, regions: chart.regions ?? [] };
}
function dailyTrendFromRows(table, field, unit) {
  const rows = rowsOf(table);
  const keys = [...new Set(rows.flatMap((row) => Array.isArray(row.daily) ? row.daily.map((day) => day?.date).filter(Boolean) : []))].sort();
  if (!keys.length) return null;
  const buckets = keys.map((key) => {
    const segments = [];
    let value = null;
    for (const row of rows) {
      const day = row.daily?.find((entry) => entry?.date === key);
      const amount = finite(day?.[field]);
      if (amount == null || (unit === 'minutes' && amount === 0)) continue;
      value = (value ?? 0) + amount;
      if (amount > 0) segments.push({ name: rowName(row), value: amount });
    }
    return { key, label: key, value, segments };
  });
  return { metric: unit === 'minutes' ? 'minutes' : 'runs', bucketBy: 'day', buckets, total: buckets.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0) };
}
function normalizedTrend(info, table, tab) {
  const trend = info.trend ?? (tab === 'model' ? dailyTrendFromRows(table, 'minutes', 'minutes') : null) ?? (tab === 'project' ? dailyTrendFromRows(table, 'runs', 'runs') : null);
  return trend && Array.isArray(trend.buckets) ? trend : { metric: info.metric, buckets: [], total: null };
}
function chartInput(info, table, tab, stackBy, width, period, extraColorNames = [], geometry = {}) {
  const trend = normalizedTrend(info, table, tab);
  // A `usd` bucket is the strict day total when every attempt carried a price,
  // else the recorded subtotal over the attempts that did: the same lower bound
  // the panels print, flagged so every label can name its coverage.
  const moneyByBucket = trend.buckets.map((bucket) => (info.unit === 'usd' ? apiMoney(bucket) : null));
  const sourceBuckets = trend.buckets.map((bucket, index) => {
    const money = moneyByBucket[index];
    const tokenSource = bucket.tokenSource ?? trend.tokenSource ?? null;
    return {
      key: bucket.key,
      label: bucket.label ?? bucket.key,
      value: info.unit === 'usd' ? money?.usd ?? null : finite(bucket.value),
      tokenSource,
      unit: info.unit,
      basis: trend.segmentBasis ?? info.basis ?? null,
      partial: money?.partial === true,
      priced: money?.priced ?? null,
      attempts: money?.attempts ?? null,
    };
  });
  const names = [...new Set(trend.buckets.flatMap((bucket) => (Array.isArray(bucket.segments) ? bucket.segments : []).map((segment) => String(segment.name ?? segment.id ?? 'unknown'))))];
  // A series' own price source is the pool's recorded one. A day whose worst
  // source is unknown must not blank a pool whose own figure was priced; a day
  // that is itself a subtotal draws every recorded slice it has.
  const seriesSources = new Map(rowsOf(table).map((row) => [rowName(row), row.tokenSource ?? null]));
  const valuesByName = new Map(names.map((name) => [name, trend.buckets.map((bucket, index) => {
    const segment = (bucket.segments ?? []).find((entry) => String(entry.name ?? entry.id ?? 'unknown') === name);
    if (info.unit !== 'usd') return finite(segment?.value);
    if (moneyByBucket[index]?.partial !== true && (bucket.tokenSource ?? trend.tokenSource) === 'unknown') return null;
    return finite(segment?.value);
  })]));
  const fallback = trend.buckets.map((bucket, index) => {
    const measured = info.unit === 'usd' ? moneyByBucket[index]?.usd ?? null : finite(bucket.value);
    const split = (bucket.segments ?? []).reduce((sum, segment) => sum + (finite(segment?.value) ?? 0), 0);
    return measured != null && measured - split > 1e-9 ? measured - split : null;
  });
  // By Model deliberately switches to the measured worker-minute trend when
  // per-model dollars are absent. Do not add a second null dollar slice on
  // top of that series: it would double-paint the measured column and make a
  // null cost placeholder look like another metric.
  const placeholder = tab === 'spending' && stackBy === 'model'
    && info.metric === 'spend' && !info.modelCostMeasured;
  const subtotalSeries = { subtotal: true, partial: true };
  if (placeholder || (!names.length && fallback.some((value) => value != null))) {
    const fallbackName = info.metric === 'spend' ? 'model cost unavailable' : 'unallocated';
    names.push(fallbackName);
    valuesByName.set(fallbackName, placeholder ? sourceBuckets.map((bucket) => bucket.value) : fallback);
  } else if (fallback.some((value) => value != null)) {
    names.push('unallocated');
    valuesByName.set('unallocated', fallback);
  }
  // Chart identities lead the allocation; visible panel-only identities are
  // appended so they can never displace a hue already used by the chart.
  const colorNames = names.map(colorName);
  const panelColors = Array.isArray(extraColorNames) ? extraColorNames.map(colorName) : [];
  const colors = seriesColors([...colorNames, ...panelColors]);
  const series = names.map((name, index) => {
    const unallocated = name === 'unallocated' && !placeholder;
    return {
      id: name,
      label: name,
      values: valuesByName.get(name),
      color: colors.get(colorNames[index]),
      tokenSource: seriesSources.get(name) ?? null,
      ...(unallocated ? subtotalSeries : {}),
    };
  });
  const title = tab === 'spending'
    ? info.modelCostMeasured ? 'Spend per day · API-equivalent · model' : stackBy === 'model' ? 'Worker-minutes per day · model cost is not measured' : 'Spend per day · API-equivalent · pool'
    : tab === 'pool' ? 'Spend per day · API-equivalent · pool' : tab === 'model' ? 'Worker-minutes per day · model' : 'Runs per day · project';
  // Keep the chart's marker aligned with the money rule: `~` means a local
  // byte estimate, and a day whose attempts were only partly priced is a
  // lower bound, marked in the Run spend block's own words. The mark also
  // sizes `columnBars`' tick gutter, so a marked chart keeps its whole label
  // (`at least $160.00`).
  const partial = sourceBuckets.some((bucket) => bucket.partial);
  const mark = info.unit === 'usd'
    ? partial ? 'at least ' : sourceBuckets.some((bucket) => bucket.tokenSource === 'estimated:utf8-bytes/4') ? '~' : ''
    : '';
  const chartArgs = {
    title,
    buckets: sourceBuckets,
    series,
    width,
    unit: info.unit,
    mark,
    totals: false,
    tab,
    metric: info.metric,
    period,
    basis: trend.segmentBasis ?? info.basis ?? null,
    ...(geometry.fill ? { fill: true, fitHeight: geometry.fit === true } : {}),
  };
  const drawn = (rows) => renderStackedColumnChart({ ...chartArgs, height: rows, rowCount: rows });
  const chart = (info.unit === 'usd' || info.unit === 'minutes' || info.unit === 'runs')
    ? geometry.fit ? chartFilling(drawn, geometry.rows ?? 6) : drawn(geometry.rows ?? 6)
    : renderColumnChart({ title, buckets: sourceBuckets, width, height: 6, unit: info.unit, totals: false, tab, metric: info.metric, period });
  if (placeholder) {
    for (const region of chart.regions ?? []) {
      if (region.kind !== 'slice' || region.payload?.series !== 'model cost unavailable') continue;
      region.payload = {
        ...region.payload,
        value: null,
        share: null,
        series: null,
        label: 'model cost unavailable',
        missingReason: 'not measured',
      };
    }
  }
  return { chart, trend, names, colors, placeholder };
}
function summaryItems(overview, outcomes, poolTable, projectTable) {
  const keys = object(overview?.keys) ?? {};
  const workflows = finite(keys.workflows) ?? totalFor(rowsOf(projectTable), projectTable?.totals, 'runs');
  const workerMinutes = finite(keys.totalWorkerMinutes);
  const money = apiMoney(keys);
  const activeDays = finite(keys.activeDays);
  const totals = [
    workflows == null ? null : countText(workflows, 'workflow'),
    workerMinutes == null ? null : `${workerMinutes} worker-minutes`,
    money == null && finite(keys.subscriptionUsd) == null ? null : `${moneyText({ ...keys, apiUsd: money?.partial ? null : money?.usd })}`,
    activeDays == null ? null : `${activeDays} active days`,
  ].filter(Boolean).join(' · ');
  // Verification, requirements and duration already have a durable home in
  // the fourth Spending/Project panel. Keep the summary to one line of totals
  // that are otherwise not visible together, so it is a header rather than a
  // second Outcome panel.
  return [{ id: 'totals', label: 'Totals', value: totals ? 0 : null, valueText: totals || null, missingReason: 'no measured totals' }];
}
function panelSet({ tab, stackBy, period, poolTable, modelTable, projectTable, outcomes, basis }) {
  const poolSpend = panelRows(poolTable, 'apiEquivalentUsd', 'usd');
  const poolMinutes = panelRows(poolTable, 'minutes', 'minutes', { shareField: 'minutesShare' });
  const poolAttempts = panelRows(poolTable, 'attempts', 'attempts');
  const modelMinutes = panelRows(modelTable, 'minutes', 'minutes', { shareField: 'minutesShare' });
  const modelAttempts = panelRows(modelTable, 'attempts', 'attempts');
  const modelVerified = panelRows(modelTable, 'verified', 'runs', { shareField: 'verifiedShare', valueText: (_row, value) => `${value} verified` });
  const projectRuns = panelRows(projectTable, 'runs', 'runs');
  const projectMinutes = panelRows(projectTable, 'minutes', 'minutes', { shareField: 'minutesShare' });
  const projectSpend = panelRows(projectTable, 'apiEquivalentUsd', 'usd');
  if (tab === 'spending') {
    const byModel = stackBy === 'model';
    return [
      // Spending's By Model comparison keeps the model identity readable for
      // hover/legend parity; the dedicated Model tab applies the compact
      // model-name form through the same renderer.
      { ...panel(byModel ? 'Model worker-minutes' : 'Pool spend', byModel ? modelMinutes : poolSpend, tab, byModel ? 'minutes' : 'spend', period, byModel ? 'minutes' : 'usd', basis, byModel ? null : 'pool', !byModel) },
      { ...panel(byModel ? 'Model attempts' : 'Pool worker-minutes', byModel ? modelAttempts : poolMinutes, tab, byModel ? 'attempts' : 'minutes', period, byModel ? 'attempts' : 'minutes', basis, byModel ? null : 'pool', !byModel) },
      { ...panel('Project runs', projectRuns, tab, 'runs', period, 'runs', basis, 'project', !byModel) },
      { ...panel('Outcome & duration', outcomeRows(outcomes), tab, 'outcome', period, 'count', basis, null, !byModel) },
    ];
  }
  if (tab === 'pool') return [
    panel('Pool spend', poolSpend, tab, 'spend', period, 'usd', null, 'pool'), panel('Pool worker-minutes', poolMinutes, tab, 'minutes', period, 'minutes', null, 'pool'), panel('Pool attempts', poolAttempts, tab, 'attempts', period, 'attempts', null, 'pool'), panel('Licence / reset history', licenceRows(poolTable), tab, 'percent', period, 'percent', null, 'pool'),
  ];
  if (tab === 'model') return [
    panel('Model worker-minutes', modelMinutes, tab, 'minutes', period, 'minutes', null, 'model'), panel('Model attempts', modelAttempts, tab, 'attempts', period, 'attempts', null, 'model'), panel('Model verified / ok', modelVerified, tab, 'verified', period, 'runs', null, 'model'), panel('Cost availability', modelCostRows(modelTable), tab, 'spend', period, 'usd', null, 'model'),
  ];
  return [
    panel('Project runs', projectRuns, tab, 'runs', period, 'runs', null, 'project'), panel('Project worker-minutes', projectMinutes, tab, 'minutes', period, 'minutes', null, 'project'), panel('Project API-equivalent', projectSpend, tab, 'spend', period, 'usd', null, 'project'), panel('Outcome & duration', outcomeRows(outcomes), tab, 'outcome', period, 'count'),
  ];
}
/**
 * The one line a page needs when its money is partly a subtotal: `reprice`
 * does not invent a price for an attempt that never recorded one, so a period
 * can hold both kinds, and a figure over the priced attempts has to say so
 * once rather than per row — in the Run spend block's own words.
 */
function coverageNote(table) {
  const totals = object(table)?.totals;
  const attempts = finite(totals?.attempts);
  const priced = finite(totals?.pricedAttempts);
  if (attempts == null || priced == null || priced >= attempts) return null;
  const unmeasured = attempts - priced;
  return `Coverage · ${unmeasured} of ${attempts} attempts recorded no price; every spend total over this scope reads at least $X · ${unmeasured} unmeasured.`;
}

/**
 * The duration counterpart: an index `workflow reprice` has not corrected yet
 * holds no active union, so the medians and the longest run are measured over
 * the spans the same records kept. One line says how many runs that was.
 */
function durationNote(outcomes) {
  const spanRuns = finite(outcomes?.spanRuns);
  const durationRuns = finite(outcomes?.durationRuns);
  if (spanRuns == null || durationRuns == null || spanRuns === 0) return null;
  return `Durations · ${spanRuns} of ${durationRuns} runs recorded no active interval union; their span stands in until workflow reprice fills it.`;
}

function legendItems(names, colors = null) {
  return names.map((name) => {
    const resolvedName = colorName(name);
    return { id: name, label: name, fullLabel: name, color: colors?.get(resolvedName) };
  });
}
function actionForRegion(region) {
  const payload = region.payload ?? {};
  return { kind: 'slice', tab: payload.tab, metric: payload.metric, period: payload.period, bucket: payload.bucketKey ?? null, series: payload.series ?? null, payload: { ...payload, kind: region.kind } };
}

function chartBarHover(hovered) {
  if (!hovered || typeof hovered !== 'object') return false;
  const kind = hovered.kind;
  return kind === 'slice' || kind === 'column' || (hovered.bucketKey != null && kind !== 'share');
}

function barColumnStart(regions, hovered) {
  const bucket = hovered?.bucketKey ?? null;
  const series = hovered?.series ?? null;
  const kind = hovered?.kind;
  const match = (Array.isArray(regions) ? regions : []).find((region) => {
    const payload = region.payload ?? {};
    if (bucket != null && payload.bucketKey !== bucket) return false;
    if (kind === 'share' || payload.kind === 'share' || region.kind === 'share') return false;
    if (series != null && (payload.series ?? null) !== series) return false;
    if (series == null && kind === 'slice' && payload.series) return false;
    return region.kind === 'slice' || region.kind === 'column' || payload.kind === 'slice' || payload.kind === 'column';
  });
  const start = Number(match?.columns?.start);
  return Number.isFinite(start) && start > 0 ? start : 1;
}
function addToggleRegions(regions, line, tab, stackBy) {
  if (tab !== 'spending') return;
  const plain = visible(line);
  for (const [value, label] of [['pool', '[By Pool]'], ['model', 'By Model']]) {
    const at = plain.indexOf(label);
    if (at < 0) continue;
    regions.push({ x: at + 1, y: 2, width: label.length, action: { kind: 'stackBy', stackBy: value, statsStackBy: value, active: stackBy === value } });
  }
}

/**
 * How many lines the panel column occupies: one heading and one line per row
 * per panel, plus the blank line `desktopPanelColumns` puts between the two
 * panels stacked in a cell. Measured from the row lists rather than from a
 * render, because the chart beside them takes its height from this figure and
 * is drawn first.
 */
function panelColumnHeight(panels) {
  const list = Array.isArray(panels) ? panels : [];
  const height = (panelInput) => 1 + Math.max(1, Array.isArray(panelInput?.rows) ? panelInput.rows.length : 0);
  return Math.max(height(list[0]) + 1 + height(list[2]), height(list[1]) + 1 + height(list[3]));
}

/**
 * Draw a chart that fills the rows its panel has.
 *
 * The stat-kit filled-chart path normalizes the bar rows after the shared axis
 * has chosen its nice tick step. Keep the requested budget here: reducing it
 * to a whole tick would put the axis back above the panel grid's bottom.
 */
function chartFilling(render, budget) {
  return render(budget);
}

/** Render the four fixed Stats tabs through the shared stat-kit surface. */
function statsLines(stats, { width = 120, height = 36, tab = 'spending', period = '7d', stackBy = 'pool', ansi = true, slice = null } = {}) {
  const cols = widthOf(width);
  const activeTab = normalizeTab(tab);
  const activePeriod = normalizePeriod(period);
  const basis = stackBy === 'model' ? 'model worker-minutes; model cost is not measured' : 'rollup values; cost is recorded per pool';
  const overview = overviewModel(stats);
  const poolTable = tableModel(stats, 'pools', overview);
  const modelTable = tableModel(stats, 'models', overview);
  const projectTable = tableModel(stats, 'projects', overview);
  const outcomes = object(stats)?.outcomes ?? overview?.outcomes ?? null;
  const info = trendFor(stats, activeTab, stackBy);
  const desktop = cols >= 80;
  const chartWidth = desktop ? Math.max(1, Math.floor((cols - 2) / 2)) : cols;
  const summary = { title: `Summary · ${activePeriod}`, items: summaryItems(overview, outcomes, poolTable, projectTable), width: cols };
  const panels = panelSet({ tab: activeTab, stackBy, period: activePeriod, poolTable, modelTable, projectTable, outcomes, basis });
  const chartTable = activeTab === 'spending' || activeTab === 'pool' ? poolTable : activeTab === 'model' ? modelTable : projectTable;
  // The chart fills the panel it shares with the grid: on desktop its bars
  // take their width from the chart column's own columns and their height from
  // the rows the panel grid occupies, so a wide terminal shows wide bars rather
  // than a narrow strip with blank rows beside it. Heading, axis, and the
  // under-axis readout are the three rows taken out of that budget, so the
  // padded last chart row stays aligned with the last panel row. The stacked
  // phone layout has no panel beside the chart to match, so it keeps its own
  // six rows and uses the gap already under the axis.
  const geometry = desktop
    ? { fill: true, fit: true, rows: Math.max(1, panelColumnHeight(panels) - 3) }
    : { rows: 6 };
  // One map feeds the chart, legend, and every visible panel row in this
  // render. The placeholder +N more row is deliberately not a name.
  const chartData = chartInput(info, chartTable, activeTab, stackBy, chartWidth, activePeriod, panelColorNames(panels), geometry);
  const coloredPanels = colorPanels(panels, chartData.colors);
  const surfacePanels = desktop
    ? desktopPanelColumns(coloredPanels, Math.max(1, cols - 2 - chartWidth), activeTab, activePeriod)
    : coloredPanels;
  const panelHeight = surfacePanels.reduce((most, panelInput) => Math.max(most, panelInput.lines?.length ?? 0), 0);
  const surfaceChart = desktop ? addDesktopDivider(chartData.chart, chartWidth, panelHeight) : chartData.chart;
  const legendDrawn = renderLegend({ items: legendItems(chartData.names, chartData.colors), width: cols, colors: true });
  const legend = { ...legendDrawn, lines: legendDrawn.lines.map((line, index) => index === 0 ? `Legend  ${line}` : line) };
  const notes = [];
  const trend = chartData.trend;
  if (activeTab === 'spending' && stackBy === 'model') {
    notes.push(info.modelCostMeasured
      ? 'Basis · measured model cost is available in this rollup.'
      : 'Basis · worker-minutes per day · model cost is not measured; no pool dollar value is prorated.');
  }
  if (activeTab === 'model') notes.push('Basis · cost per pool, not per model; model cost is not measured.');
  else if (trend?.segmentBasis) notes.push(`Basis · ${trend.segmentBasis}.`);
  if (info.unit === 'usd') {
    const coverage = coverageNote(chartTable);
    if (coverage) notes.push(coverage);
  }
  const durations = durationNote(outcomes);
  if (durations) notes.push(durations);
  if (trend?.truncated) notes.push('History · the requested period is longer than the retained rollups.');
  const surface = renderStatsSurface({ tab: activeTab, period: activePeriod, width: cols, height, stackBy, tabs: TABS, summary, chart: surfaceChart, panels: surfacePanels, legend, notes, ansi });
  const hovered = object(slice?.payload) ?? (slice?.kind === 'slice' || slice?.kind === 'share' || slice?.kind === 'column' ? slice : null);
  const hoverLabel = hovered
    ? formatHoverLabel({ ...hovered, kind: hovered.kind ?? slice?.kind }).replace(/of day/g, 'of the day')
    : null;
  surface.lines[2] = ' '.repeat(cols);
  if (hoverLabel && chartBarHover(hovered)) {
    const axisRow = chartAxisRowIndex(surface.lines, chartWidth);
    if (axisRow >= 0 && axisRow + 1 < surface.lines.length) {
      paintChartHoverReadout(surface.lines, {
        text: hoverLabel,
        axisRow,
        barX: barColumnStart(surface.regions, hovered),
        chartStart: 1,
        // Keep the desktop divider (and the panel grid beside it) intact.
        chartWidth: desktop ? Math.max(1, chartWidth - 1) : chartWidth,
        width: cols,
      });
      surface.meta.hoverRow = axisRow + 2;
    } else {
      surface.lines[2] = fit(` ${hoverLabel}`, cols);
    }
  } else if (hoverLabel) {
    surface.lines[2] = fit(` ${hoverLabel}`, cols);
  }
  const regions = [];
  for (const region of surface.regions ?? []) {
    if (!region?.payload || !region.columns) continue;
    const start = Number(region.columns.start) || 1;
    const end = Number(region.columns.end) || start;
    regions.push({ x: Math.max(1, start), y: Math.max(1, Number(region.row) || 1), width: Math.max(1, end - start + 1), action: actionForRegion(region) });
  }
  for (const control of surface.meta?.controls ?? []) {
    if (control.row === 1) regions.push({ x: control.x, y: control.row, width: control.width, action: control.action });
  }
  const periodControl = periodToggle(PERIODS, { active: activePeriod, width: cols });
  const activeLabel = TABS.find((item) => item.id === activeTab)?.label ?? 'Spending';
  const toggleText = activeTab === 'spending' ? `  [${stackBy === 'model' ? 'By Model' : 'By Pool'}] ${stackBy === 'model' ? 'By Pool' : 'By Model'}` : '';
  const controlLine = fit(`${activeLabel} · ${periodControl.text}${toggleText}`, cols);
  surface.lines[1] = ansi ? controlLine : visible(controlLine);
  for (const region of periodControl.regions ?? []) regions.push({ x: region.x + activeLabel.length + 3, y: 2, width: region.width, action: region.action });
  addToggleRegions(regions, surface.lines[1], activeTab, stackBy);
  return { lines: surface.lines, regions, meta: { ...surface.meta, tab: activeTab, period: activePeriod, stackBy } };
}

export { statsLines };
