// The shared renderer for every Stats surface.
//
// This module owns no model arithmetic and reads no dashboard state.  It turns
// already-rolled-up values into bounded terminal lines and durable hit regions;
// the shell can then translate those regions into its existing mouse adapter.

import {
  columnBars,
  columns,
  cut,
  dateLabels,
  formatDashboardValue,
  periodToggle,
  rule,
  seriesColor,
  seriesColors,
  shareBarMeta,
  tabsRow,
} from './dash-kit.js';
import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import { formatMoneyPair } from '../lib/usage-basis.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const BOLD = '\x1b[1m';
const NO_BOLD = '\x1b[22m';
const HEX = /^#[0-9a-f]{6}$/i;

const TABS = Object.freeze([
  { id: 'spending', label: 'Spending', key: 's' },
  { id: 'pool', label: 'Pool', key: 'p' },
  { id: 'model', label: 'Model', key: 'm' },
  { id: 'project', label: 'Project', key: 'j' },
]);
const PERIODS = Object.freeze([
  { id: '7d', label: 'Last 7 days', key: '7' },
  { id: '30d', label: 'Last 30 days', key: '3' },
  { id: 'all', label: 'All time', key: 'a' },
]);
const PERIOD_LABELS = Object.freeze({ '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' });

function visible(text) {
  return String(text ?? '').replace(SGR, '');
}

function widthOf(width, fallback = 55) {
  const value = Number(width);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fit(text, width) {
  const cols = widthOf(width);
  const source = String(text ?? '');
  return visible(source).length <= cols ? source : cut(source, cols);
}

function modelRemainderNamesModel(remainder) {
  const parts = String(remainder ?? '').split(/[-_]/).filter(Boolean);
  if (parts.length < 2) return false;
  const isVersion = (part) => /^(?:v)?\d+(?:[._]\d+)*$/i.test(part);
  return parts.some(isVersion) && parts.some((part) => /[a-z]/i.test(part) && !isVersion(part));
}

function modelLabelStages(value) {
  const source = String(value ?? '');
  if (!source) return [''];
  const candidates = [source];
  const slash = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'));
  const pathName = slash >= 0 ? source.slice(slash + 1) : source;
  if (pathName && pathName !== source) candidates.push(pathName);
  const base = candidates.at(-1) ?? source;
  const dash = base.indexOf('-');
  if (dash > 0) {
    const remainder = base.slice(dash + 1);
    if (modelRemainderNamesModel(remainder)) candidates.push(remainder);
  }
  return [...new Set(candidates)];
}

function modelLabelAtWidth(value, width) {
  const cols = widthOf(width);
  const candidates = modelLabelStages(value);
  for (const candidate of candidates) {
    if (visible(candidate).length <= cols) return candidate;
  }
  return middleCut(candidates.at(-1) ?? String(value ?? ''), cols);
}

/**
 * Return the reader-facing short form for a data-series name.
 *
 * The untouched name remains on every payload and in the legend; this helper
 * is only for labels painted inside a bounded panel.  Pool scopes are the
 * useful identity after the final colon.  Projects retain their deliberate
 * repository suffix rule; models use the identity-preserving staged rule
 * below when the caller supplies the panel's actual label width.
 */
export function shortenLabel(value, context = {}) {
  const source = String(value ?? '');
  if (!source) return '';
  const options = typeof context === 'string' ? { kind: context } : (context ?? {});
  if (options.full === true) return source;

  const kind = String(options.kind ?? options.type ?? '').trim().toLowerCase();
  const requestedWidth = options.width ?? options.labelWidth;
  const scope = source.lastIndexOf(':');
  if (kind === 'model') {
    // Model names are identity-bearing.  A caller that knows its label column
    // gets the first semantic stage that fits; without a width, retain the
    // untouched name so the panel measurer can decide from its actual room.
    const modelSource = scope >= 0 && scope < source.length - 1 ? source.slice(scope + 1) : source;
    return requestedWidth == null ? modelSource : modelLabelAtWidth(modelSource, requestedWidth);
  }

  if (scope >= 0 && scope < source.length - 1) return source.slice(scope + 1);

  const pathSegments = source.split(/[\\/]/).filter(Boolean);
  const lastPath = pathSegments.at(-1) ?? source;
  if (pathSegments.length > 1 || kind === 'project' || kind === 'model') {
    const dashSegments = lastPath.split('-').filter(Boolean);
    if (dashSegments.length > 1) return dashSegments.at(-1);
    return lastPath;
  }
  return source;
}

function middleCut(text, width) {
  const source = visible(text);
  const cols = widthOf(width);
  if (source.length <= cols) return source;
  if (cols <= 1) return '…'.slice(0, cols);

  const budget = cols - 1;
  const segments = source.split(/[:\\/\\-]/).filter(Boolean);
  const suffixCandidate = segments.at(-1) ?? source;
  // Keep a complete distinguishing tail whenever it fits.  This gives the
  // scoped form `claude-co…acme` rather than losing the scope to a prefix cut.
  const suffixLength = suffixCandidate.length < budget ? suffixCandidate.length : Math.max(1, Math.floor(budget / 2));
  const leftLength = Math.max(1, budget - suffixLength);
  let left = source.slice(0, leftLength).replace(/[:\\/\\-]+$/, '');
  if (!left) left = source.slice(0, leftLength);
  let right = suffixCandidate.slice(-suffixLength);
  const remaining = cols - (left.length + 1 + right.length);
  if (remaining < 0) right = right.slice(Math.max(0, -remaining));
  return `${left}…${right}`.slice(0, cols);
}

function duplicateLabels(labels) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.values()].some((count) => count > 1);
}

function collisionIndexes(labels) {
  const indexes = new Set();
  const grouped = new Map();
  labels.forEach((label, index) => {
    const entries = grouped.get(label) ?? [];
    entries.push(index);
    grouped.set(label, entries);
  });
  for (const entries of grouped.values()) if (entries.length > 1) entries.forEach((index) => indexes.add(index));
  return indexes;
}

function uniqueLabels(labels, fullLabels, width) {
  const out = [];
  const used = new Set();
  labels.forEach((label, index) => {
    let candidate = label;
    if (used.has(candidate)) {
      const full = fullLabels[index] ?? candidate;
      const base = middleCut(full, width);
      candidate = base;
      let attempt = 2;
      while (used.has(candidate) && attempt < 100) {
        const suffix = String(attempt);
        candidate = widthOf(width) <= suffix.length
          ? suffix.slice(-widthOf(width))
          : `${middleCut(full, widthOf(width) - suffix.length - 1)} ${suffix}`;
        candidate = fit(candidate, width);
        attempt += 1;
      }
    }
    out.push(candidate);
    used.add(candidate);
  });
  return out;
}

function colourMarker(marker, colour, enabled) {
  if (!enabled || !HEX.test(String(colour ?? ''))) return marker;
  const value = Number.parseInt(String(colour).slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${marker}${'\x1b[0m'}`;
}

function asDrawn(value, width, renderer) {
  if (value && Array.isArray(value.lines)) {
    return { lines: value.lines.map((line) => fit(line, width)), regions: Array.isArray(value.regions) ? value.regions : [], meta: value.meta };
  }
  if (value && typeof value === 'object') return renderer({ ...value, width });
  return renderer({ width });
}

function unitName(unit) {
  if (unit === 'usd' || unit === '$' || unit === 'money') return 'usd';
  if (unit === 'minutes' || unit === 'minute') return 'minutes';
  if (unit === 'runs' || unit === 'run') return 'runs';
  if (unit === 'attempts' || unit === 'attempt') return 'attempts';
  if (unit === 'percent' || unit === '%') return 'percent';
  return 'count';
}

function unitForColumnBars(unit) {
  const normalized = unitName(unit);
  if (normalized === 'usd') return '$';
  if (normalized === 'minutes') return 'minutes';
  if (normalized === 'percent') return '%';
  if (normalized === 'runs') return '';
  if (normalized === 'attempts') return '';
  return '';
}

function formatValue(value, unit) {
  const number = finite(value);
  if (number == null) return 'value unavailable';
  const normalized = unitName(unit);
  if (normalized === 'usd') {
    const api = formatMoneyPair({ api: { usd: number, tokenSource: 'provider-reported' }, subscription: null })
      .split(' · ')[0];
    return api.replace(/ api(?: summed| estimated)?$/, '');
  }
  if (normalized === 'minutes') return formatDashboardValue(number, 'minutes');
  if (normalized === 'percent') return `${Number((number * 100).toFixed(1))}%`;
  if (normalized === 'runs') return `${number} run${number === 1 ? '' : 's'}`;
  if (normalized === 'attempts') return `${number} attempt${number === 1 ? '' : 's'}`;
  return String(number);
}

function sourcedValue(value, unit, tokenSource) {
  const text = formatValue(value, unit);
  return tokenSource?.startsWith?.('estimated:') && unitName(unit) === 'usd' ? `≈${text}` : text;
}

function formatShare(share) {
  const number = finite(share);
  if (number == null) return 'share unavailable';
  return `${Number((number * 100).toFixed(1))}%`;
}

function sourceShare(part, total) {
  const explicit = finite(part?.share);
  if (explicit != null) return explicit;
  const value = finite(part?.value);
  return value != null && total > 0 ? value / total : null;
}

function payloadFor(part, common = {}) {
  const value = finite(part?.value);
  const total = finite(part?.total) ?? finite(common.total);
  const derivedTotal = total ?? (finite(common.totalValue) ?? null);
  return {
    tab: common.tab ?? null,
    metric: common.metric ?? null,
    period: common.period ?? null,
    bucketKey: common.bucketKey ?? null,
    bucketLabel: common.bucketLabel ?? null,
    series: part?.series ?? part?.id ?? null,
    label: part?.label ?? part?.name ?? null,
    value,
    total: derivedTotal,
    share: sourceShare(part, derivedTotal ?? 0),
    unit: unitName(part?.unit ?? common.unit),
    tokenSource: part?.tokenSource ?? common.tokenSource ?? null,
    basis: part?.basis ?? common.basis ?? null,
    apiUsd: part?.apiUsd ?? common.apiUsd ?? null,
    subscriptionUsd: part?.subscriptionUsd ?? common.subscriptionUsd ?? null,
    subscriptionDeltaPct: part?.subscriptionDeltaPct ?? common.subscriptionDeltaPct ?? null,
    subscriptionWindow: part?.subscriptionWindow ?? common.subscriptionWindow ?? null,
    subscriptionBasis: part?.subscriptionBasis ?? common.subscriptionBasis ?? null,
  };
}

function sourceParts(parts) {
  return (Array.isArray(parts) ? parts : []).filter(Boolean);
}

function lineWithReason(label, reason, width) {
  const name = String(label ?? '').trim();
  const why = String(reason ?? '').trim();
  return fit([name, '—', why].filter(Boolean).join(' '), width);
}

function chartLabels(buckets, width) {
  const cellWidth = width >= 180 ? 12 : width >= 90 ? 8 : 6;
  return (Array.isArray(buckets) ? buckets : []).map((bucket) => {
    const key = bucket?.key ?? '';
    const label = bucket?.label == null ? '' : String(bucket.label);
    // ISO labels are raw model keys, not reader-facing axis labels.  An
    // already-formatted label is retained so a caller can supply a merged
    // bucket range explicitly.
    if (!label || /^\d{4}-\d{1,2}-\d{1,2}/.test(label)) {
      return dateLabel(key, { width, cellWidth, bucketSpan: bucket?.bucketSpan ?? 1 });
    }
    return label;
  });
}

/** Calendar axis label; concrete dates are always retained (never just `S`). */
export function dateLabel(key, options = {}) {
  return dateLabels([key], options)[0] ?? '';
}

/**
 * Render one horizontal allocation and register the exact cells painted by
 * each part.  A positive part too small for a cell still gets a sliver and a
 * hit region of its own, while its payload keeps the real, tiny reading;
 * `partialGlyph` only chooses which sliver dash-kit draws.
 */
export function renderShareBar({
  parts, width, colors = true, partialGlyph = null,
  tab, metric, period, bucketKey = null, bucketLabel = null,
  unit, basis = null,
} = {}) {
  const cols = widthOf(width, 20);
  const source = sourceParts(parts);
  const rendered = shareBarMeta(source, { width: cols, colors, partialGlyph });
  const total = source.reduce((sum, part) => {
    const value = finite(part?.value);
    return value == null ? sum : sum + Math.max(0, value);
  }, 0);
  const regions = [];
  rendered.parts.forEach((geometry, index) => {
    if (!(geometry.width > 0)) return;
    const part = source[index] ?? {};
    const totalValue = finite(part.total) ?? (total > 0 ? total : null);
    const payload = payloadFor({ ...part, total: totalValue, share: finite(part.share) ?? (total > 0 ? geometry.value / total : null) }, {
      tab, metric, period, bucketKey, bucketLabel, unit, basis, total: totalValue,
    });
    regions.push({ kind: 'share', row: 1, columns: { start: geometry.x, end: geometry.x + geometry.width - 1 }, payload });
  });
  const tooSmall = rendered.parts
    .map((geometry, index) => ({ geometry, part: source[index] }))
    .filter(({ geometry, part }) => geometry.width === 0 && finite(part?.value) > 0)
    .map(({ part }) => part?.label ?? part?.id)
    .filter(Boolean);
  return { lines: [fit(rendered.text, cols)], regions, meta: { tooSmall } };
}

function rowParts(row) {
  if (Array.isArray(row?.parts) && row.parts.length) return sourceParts(row.parts);
  const value = finite(row?.value);
  const total = finite(row?.total);
  if (value == null) return [];
  const measuredTotal = total ?? (finite(row?.share) != null && row.share > 0 ? value / row.share : value);
  const remainder = measuredTotal == null ? 0 : Math.max(0, measuredTotal - value);
  return [
    { id: row.id ?? row.label ?? 0, label: row.label, value, total: measuredTotal, share: finite(row.share) ?? (measuredTotal > 0 ? value / measuredTotal : null), color: row.color, tokenSource: row.tokenSource, unit: row.unit },
    ...(remainder > 0 ? [{ id: '__remainder__', value: remainder, total: measuredTotal, __background: true }] : []),
  ];
}

function moreRow(row, label) {
  return row?.id === '__more__' || /^\+\d+ more$/.test(String(label ?? ''));
}

/**
 * Collect the geometry inputs for a panel without painting it.  The desktop
 * grid uses this pass for all four panels before any one of them is rendered,
 * so a local label/bar decision cannot leak into its neighbours.
 */
function panelMetrics({ rows, width, unit, labelKind, labelWidth = null, barWidth = null } = {}) {
  const cols = widthOf(width, 55);
  const normalizedKind = String(labelKind ?? '').trim().toLowerCase();
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const fullLabels = list.map((row) => String(row.fullLabel ?? row.label ?? row.id ?? ''));
  const shortLabels = fullLabels.map((label) => shortenLabel(label, { kind: labelKind }));
  const longest = shortLabels.reduce((most, label) => Math.max(most, visible(label).length), 0);
  const suffixes = list.map((row) => {
    if (finite(row.value) == null) return `— ${row.missingReason ?? 'value unavailable'}`;
    const valueText = row.valueText ?? sourcedValue(row.value, unit, row.tokenSource);
    const shareText = finite(row.share) == null ? '' : ` ${formatShare(row.share)}`;
    return `${valueText}${shareText}`;
  });
  const suffixLongest = suffixes.reduce((most, value) => Math.max(most, visible(value).length), 0);
  // A missing-value explanation is prose, not a measured value column.  It
  // may be compacted in a narrow shared cell; measured readings and shares
  // are the widths that decide whether a bar can remain.
  const measuredSuffixLongest = list.reduce((most, row, index) => finite(row.value) == null
    ? most
    : Math.max(most, visible(suffixes[index]).length), 0);
  const requestedLabel = labelWidth == null
    ? normalizedKind === 'model'
      ? Math.max(1, longest + 1)
      : Math.min(Math.max(1, longest + 1), Math.max(1, Math.floor(cols * 0.36)))
    : Math.max(1, Math.trunc(Number(labelWidth)) || 1);
  const requestedBar = barWidth == null ? Math.max(1, Math.floor(cols * 0.2)) : Math.max(1, Math.trunc(Number(barWidth)) || 1);
  const moreLongest = list.reduce((most, row, index) => moreRow(row, fullLabels[index])
    ? Math.max(most, visible(shortLabels[index]).length)
    : most, 0);
  return {
    list,
    fullLabels,
    shortLabels,
    suffixes,
    longest,
    suffixLongest,
    measuredSuffixLongest,
    moreLongest,
    measuredLabel: labelWidth == null ? Math.max(1, longest) : requestedLabel,
    requestedLabel,
    requestedBar,
  };
}

/**
 * Resolve a panel's labels to unique text at a given column width, using the
 * escalation the renderer has always used: a plain cut, then a middle cut for
 * the names that collided, then a uniquifier.  The grid measurer and the
 * renderer must ask the same question — a collision the renderer can resolve
 * is not a reason to take a bar away.
 */
function resolveLabels(shortLabels, fullLabels, labelCols) {
  let labels = shortLabels.map((label) => cut(label, labelCols));
  let usedMiddleCut = false;
  if (duplicateLabels(labels)) {
    const collisions = collisionIndexes(labels);
    labels = labels.map((label, index) => collisions.has(index)
      ? middleCut(fullLabels[index], labelCols)
      : label);
    usedMiddleCut = collisions.size > 0;
  }
  if (duplicateLabels(labels)) labels = uniqueLabels(labels, fullLabels, labelCols);
  return { labels, usedMiddleCut, resolved: !duplicateLabels(labels) };
}

/**
 * Measure one geometry for a desktop two-by-two panel grid.
 *
 * The returned label width is a grid-wide column.  Bars are an all-or-none
 * affordance: retaining the requested bar in every cell is allowed only when
 * the shared label and each panel's value field fit in that cell.  A narrow
 * grid therefore drops every bar together, while a stacked phone render can
 * continue to measure each panel independently.
 */
export function measurePanelGridLayout(panels, widths, { gap = 2 } = {}) {
  const list = (Array.isArray(panels) ? panels : []).slice(0, 4);
  const cells = list.map((panel, index) => panelMetrics({
    ...panel,
    width: Array.isArray(widths) ? widths[index] : widths,
  }));
  if (!cells.length) return { labelWidth: 1, barWidth: 0, barEnabled: false, gap: 1, cells: [] };

  const desiredLabel = Math.max(1, ...cells.map((cell) => cell.measuredLabel));
  const desiredBar = Math.max(1, ...cells.map((cell) => cell.requestedBar));
  const valueGap = Math.max(1, Math.trunc(Number(gap)) || 2);
  const barFits = cells.every((cell, index) => {
    const width = widthOf(Array.isArray(widths) ? widths[index] : widths, 55);
    // Two names that collide at this width are only fatal when the renderer
    // cannot pull them apart.  Testing the raw cut instead meant one repeated
    // project name switched every bar off, in all four panels, at every
    // desktop width — including 200 columns, where everything fits twice over.
    const { resolved } = resolveLabels(cell.shortLabels, cell.fullLabels, desiredLabel);
    return desiredLabel + valueGap + desiredBar + cell.measuredSuffixLongest <= width
      && resolved;
  });

  const barWidth = barFits ? desiredBar : 0;
  const rowGap = barFits ? valueGap : 1;
  const valueCaps = cells.map((cell, index) => {
    const width = widthOf(Array.isArray(widths) ? widths[index] : widths, 55);
    return Math.max(1, width - rowGap - barWidth - cell.measuredSuffixLongest);
  });
  const safeCap = Math.max(1, Math.min(...valueCaps));
  const labelFloor = 3;
  let labelWidth = Math.max(labelFloor, Math.min(desiredLabel, safeCap));

  // A more-row label is a reader-facing count, not a disposable ellipsis.
  // Preserve it when a long value field would otherwise make the shared
  // column too small; the value renderer will compact that field to its
  // already-reserved right-aligned column.
  const moreWidth = Math.max(0, ...cells.map((cell) => cell.moreLongest));
  if (moreWidth > labelWidth) labelWidth = moreWidth;

  return {
    labelWidth,
    barWidth,
    barEnabled: barWidth > 0,
    gap: rowGap,
    cells,
    widths: Array.isArray(widths) ? widths.map((width) => widthOf(width, 55)) : cells.map(() => widthOf(widths, 55)),
  };
}

/** A titled list of rows, each with a share bar and sourced value wording. */
export function renderPanel({
  title, rows, width, labelWidth = null, barWidth = null,
  tab, metric, period, unit, basis = null, colors = true, labelKind = null, layout = null,
} = {}) {
  const cols = widthOf(width, 55);
  const measured = panelMetrics({ rows, width: cols, unit, labelKind, labelWidth, barWidth });
  const list = measured.list;
  const heading = fit(rule(title ?? '', null, cols), cols);
  const lines = [heading];
  const regions = [];
  if (!list.length) {
    lines.push(lineWithReason('—', 'no measured data', cols));
    return { lines, regions };
  }
  const { fullLabels, shortLabels, suffixes, suffixLongest, requestedLabel, requestedBar } = measured;
  // There are always exactly three fields and two one-cell gaps. Keep a
  // useful suffix field (the value/share pair) by shrinking the label first,
  // then the bar, when a desktop grid cell is too narrow for the requested
  // widths. The resulting label and bar widths are shared by every row.
  const gaps = 2;
  const minLabel = Math.min(3, Math.max(1, cols - gaps));
  const minBar = 1;
  // A numeric reading is the row's conclusion, so it is the one field that
  // must never be sacrificed to fit a grid cell. Reserve its full width,
  // shrink the label first, and drop this panel's bars altogether when even a
  // one-cell bar would force the value to be clipped.
  const suffixTarget = Math.min(suffixLongest, Math.max(1, cols - minLabel - 1));
  let rowGaps = gaps;
  let barCols = Math.min(requestedBar, Math.max(minBar, cols - rowGaps - minLabel - suffixTarget));
  let labelCols = Math.min(requestedLabel, Math.max(minLabel, cols - rowGaps - barCols - suffixTarget));
  const modelKind = String(labelKind ?? '').trim().toLowerCase() === 'model';
  if (layout) {
    rowGaps = Math.max(1, Math.trunc(Number(layout.gap)) || 1);
    barCols = layout.barEnabled === false ? 0 : Math.max(0, Math.trunc(Number(layout.barWidth)) || 0);
    labelCols = Math.max(1, Math.trunc(Number(layout.labelWidth)) || 1);
    // A shared plan is measured against the actual cell widths. Keep this
    // defensive clamp so an ad-hoc caller cannot make a line overrun.
    const available = Math.max(1, cols - rowGaps - barCols - 1);
    labelCols = Math.min(labelCols, available);
  } else if (labelCols + rowGaps + barCols + suffixTarget > cols
    || suffixTarget < suffixLongest
    || cols - rowGaps - barCols - suffixTarget < minLabel) {
    barCols = 0;
    rowGaps = 1;
    labelCols = Math.max(1, cols - rowGaps - suffixTarget);
  }
  // Model identity is more useful than a decorative share bar.  If the full
  // names cannot fit beside the measured value field, give the label column
  // the bar's room before asking the staged model rule to shorten them.
  if (modelKind && !layout && labelWidth == null && barCols > 0 && labelCols < measured.longest) {
    barCols = 0;
    rowGaps = 1;
    labelCols = Math.max(1, Math.min(requestedLabel, cols - rowGaps - suffixTarget));
  }
  let suffixCols = Math.max(1, cols - rowGaps - labelCols - barCols);
  const labelsAtWidth = () => modelKind
    ? fullLabels.map((label) => shortenLabel(label, { kind: 'model', width: labelCols }))
    : shortLabels.map((label) => cut(label, labelCols));
  let displayLabels = labelsAtWidth();
  let usedMiddleCut = false;
  let barsDroppedForCollision = false;
  if (duplicateLabels(displayLabels)) {
    // A clipped label is not an acceptable identity.  Give the names the bar
    // column's space first; the value/share suffix remains reserved.
    if (barCols > 0 && !layout) {
      barCols = 0;
      rowGaps = 1;
      labelCols = Math.max(1, cols - rowGaps - suffixTarget);
      suffixCols = Math.max(1, cols - rowGaps - labelCols);
      barsDroppedForCollision = true;
      displayLabels = labelsAtWidth();
    }
    const resolvedLabels = resolveLabels(modelKind ? displayLabels : shortLabels, fullLabels, labelCols);
    displayLabels = resolvedLabels.labels;
    usedMiddleCut = resolvedLabels.usedMiddleCut;
  }
  const padRight = (text, width) => {
    const source = String(text ?? '');
    const clipped = cut(source, width);
    return `${clipped}${' '.repeat(Math.max(0, width - visible(clipped).length))}`;
  };
  const padLeft = (text, width) => {
    const source = String(text ?? '');
    let clipped = cut(source, width);
    // Never leave a separator as the final visible character before the
    // clipping ellipsis; that reads as a dangling continuation marker.
    clipped = clipped.replace(/[ ·—]+…$/, '…');
    return `${' '.repeat(Math.max(0, width - visible(clipped).length))}${clipped}`;
  };
  list.forEach((row, rowIndex) => {
    const value = finite(row.value);
    const label = padRight(displayLabels[rowIndex], labelCols);
    const barGap = barCols > 0 ? ' ' : '';
    const suffixGap = ' ';
    if (value == null) {
      lines.push(`${label}${barGap}${' '.repeat(barCols)}${suffixGap}${padLeft(suffixes[rowIndex], suffixCols)}`);
      return;
    }
    const parts = rowParts(row);
    const bar = barCols > 0 ? shareBarMeta(parts, { width: barCols, colors }) : { text: '', parts: [] };
    const suffix = suffixes[rowIndex];
    const line = `${label}${barGap}${padRight(bar.text, barCols)}${suffixGap}${padLeft(suffix, suffixCols)}`;
    lines.push(line);
    const total = finite(row.total) ?? (finite(row.share) != null && row.share > 0 ? value / row.share : value);
    // A row's bar is one affordance, not only its foreground cells.  The
    // track remains visibly drawn when a small value rounds to zero filled
    // cells, and the remainder glyphs are still part of the same bar.  Keep a
    // single region over the complete painted track so every cell answers the
    // same name/value/share payload (and avoid overlapping foreground and
    // background regions in the shell's hit-test).
    if (barCols > 0 && /[▓▒░█▏#.|]/.test(visible(bar.text))) {
      const share = finite(row.share) ?? (total > 0 ? value / total : null);
      const payload = payloadFor({ ...row, total, share, label: fullLabels[rowIndex] }, {
        tab, metric, period, unit: row.unit ?? unit, basis, total,
      });
      const start = labelCols + 2;
      const end = start + barCols - 1;
      const clippedEnd = Math.min(end, visible(line).length);
      if (clippedEnd >= start) regions.push({ kind: 'share', row: lines.length, columns: { start, end: clippedEnd }, payload });
    }
  });
  return {
    lines,
    regions,
    meta: {
      labelKind,
      labels: displayLabels,
      fullLabels,
      barDropped: barCols === 0,
      barsDroppedForCollision,
      usedMiddleCut,
    },
  };
}

function chartOptions(width, height, rowCount, unit, mark, totals, cumulative, colors) {
  const cols = widthOf(width, 55);
  const col = cols >= 180 ? 12 : cols >= 90 ? 8 : 6;
  return {
    width: cols,
    height: height ?? 6,
    rowCount: rowCount ?? undefined,
    col,
    barW: Math.max(1, col - 2),
    unit: unitForColumnBars(unit),
    mark: mark ?? '',
    totals: totals !== false,
    cumulative: cumulative === true,
    colors,
  };
}

function bucketPayload(bucket, value, total, common = {}) {
  const measured = finite(value);
  return {
    tab: common.tab ?? null,
    metric: common.metric ?? null,
    period: common.period ?? null,
    bucketKey: bucket?.key ?? null,
    bucketLabel: bucket?.label ?? null,
    series: common.series ?? null,
    label: common.label ?? 'total',
    value: measured,
    total: finite(total),
    share: measured != null && finite(total) != null && total > 0 ? measured / total : (measured != null && total === measured ? 1 : null),
    unit: unitName(common.unit),
    tokenSource: bucket?.tokenSource ?? common.tokenSource ?? null,
    basis: bucket?.basis ?? common.basis ?? null,
  };
}

function barX(column, meta) {
  return column.x + (meta.cellWidth > 1 ? 1 : 0);
}

function addColumnRegion(regions, column, meta, offset, bucket, value, common) {
  if (!column || !(column.eighths > 0) || !(column.height > 0)) return;
  const start = barX(column, meta);
  const end = start + Math.max(1, column.barWidth ?? meta.barWidth) - 1;
  const payload = bucketPayload(bucket, value, value, common);
  for (let row = meta.chartRows - column.height + 1; row <= meta.chartRows; row += 1) {
    regions.push({ kind: 'column', row: offset + row, columns: { start, end }, payload });
  }
}

function chartLabelBucket(bucket, label) {
  return { ...(bucket ?? {}), label: label ?? bucket?.label ?? bucket?.key ?? null };
}

// columnBars keeps one cell per bucket, so a long 30-day window can make its
// labels narrower than a useful date token. Replace the label/value rows with
// a stride of full tokens plus one blank cell; every bar remains present and
// each shown token still identifies the bucket directly below it.
function datedColumnLine(chart, values, width, formatter = (value) => value, valuesAreView = false) {
  const meta = chart?.meta;
  if (!meta || !Number.isFinite(meta.axisRow) || !meta.columns?.length) return null;
  const prefix = ' '.repeat(Math.max(0, meta.axisWidth))
    + visible(chart[meta.axisRow - 1] ?? '').slice(meta.axisWidth, meta.axisWidth + 1);
  const cells = Array.from({ length: width }, () => ' ');
  [...prefix].forEach((character, index) => { if (index < cells.length) cells[index] = character; });
  const viewValues = meta.columns.map((column, index) => {
    const sourceIndex = column.sourceIndex ?? index;
    return formatter(values?.[valuesAreView ? index : sourceIndex], sourceIndex);
  });
  const longest = viewValues.reduce((most, value) => Math.max(most, visible(value).length), 0);
  // Equal-width tokens need an empty cell between them. If a token is wider
  // than a cell, leave the following one (or more) blank and use the next
  // bucket as the next label anchor.
  const stride = Math.max(1, Math.ceil((longest + 1) / Math.max(1, meta.cellWidth)));
  let lastEnd = prefix.length;
  for (let index = 0; index < viewValues.length; index += stride) {
    const value = visible(viewValues[index]);
    if (!value) continue;
    const start = Math.max(prefix.length, (meta.columns[index].x ?? prefix.length + 1) - 1);
    if (start < lastEnd || start >= cells.length) continue;
    const end = Math.min(cells.length, start + value.length);
    if (end <= start) continue;
    [...value.slice(0, end - start)].forEach((character, offset) => { cells[start + offset] = character; });
    lastEnd = end;
  }
  return cells.join('');
}

function datedAxisLine(chart, labels, width) {
  return datedColumnLine(chart, labels, width, (value) => value ?? '');
}

function datedValueLine(chart, sums, width, unit, mark) {
  return datedColumnLine(chart, sums, width, (value) => {
    const number = finite(value);
    if (number == null) return '';
    if (unitName(unit) === 'usd') return `${mark ?? ''}${formatDashboardValue(number, 'money')}`;
    if (unitName(unit) === 'minutes') return `${mark ?? ''}${formatDashboardValue(number, 'minutes')}`;
    return `${mark ?? ''}${number}`;
  }, true);
}

/** One measured series across dated buckets. */
export function renderColumnChart({
  title, buckets, width, height, rowCount = null,
  unit, mark = '', totals = true, cumulative = false,
  tab, metric, period, basis = null, colors = true,
} = {}) {
  const cols = widthOf(width, 55);
  const list = Array.isArray(buckets) ? buckets : [];
  const labels = chartLabels(list, cols);
  const values = list.map((bucket) => finite(bucket?.value));
  const heading = fit(rule(title ?? '', null, cols), cols);
  if (!labels.length) return { lines: [heading, lineWithReason('—', 'no measured data', cols)], regions: [] };
  if (!values.some((value) => value != null)) {
    return { lines: [heading, lineWithReason('—', 'no measured values', cols)], regions: [] };
  }
  const chart = columnBars([{ name: 'total', values, color: seriesColor('total') }], labels, chartOptions(cols, height, rowCount, unit, mark, totals, cumulative, colors));
  const lines = [heading, ...chart.map((line) => fit(line, cols))];
  const regions = [];
  const meta = chart.meta;
  const datedAxis = datedAxisLine(chart, labels, cols);
  if (datedAxis && meta?.axisRow != null) lines[meta.axisRow] = datedAxis;
  const datedValues = meta?.valueRow != null ? datedValueLine(chart, meta.sums, cols, unit, mark) : null;
  if (datedValues && meta?.valueRow != null) lines[meta.valueRow] = datedValues;
  if (meta) {
    meta.columns.forEach((column, index) => {
      const sourceIndex = column.sourceIndex ?? index;
      const bucket = chartLabelBucket(list[sourceIndex], labels[sourceIndex]);
      addColumnRegion(regions, column, meta, 1, bucket, meta.sums[index], { tab, metric, period, unit, basis });
    });
  }
  return { lines, regions, meta: { chart: meta } };
}

function otherSourceNames(column, sourceSeries, bucketIndex, totalEighths) {
  if (!column?.segments?.some((entry) => entry.sourceIndex < 0)) return [];
  const entries = sourceSeries.map((series, sourceIndex) => ({
    sourceIndex,
    name: series.id ?? series.label ?? series.name ?? null,
    value: Math.max(0, finite(series.values?.[bucketIndex]) ?? 0),
  })).filter((entry) => entry.value > 0).sort((a, b) => a.value - b.value || a.sourceIndex - b.sourceIndex);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const tiny = entries.filter((entry) => total > 0 && (entry.value / total) * totalEighths < 1);
  const nonTiny = entries.length - tiny.length;
  const slots = Math.max(0, totalEighths - nonTiny);
  return tiny.length > slots ? tiny.map((entry) => entry.name).filter(Boolean) : [];
}

function stackSliceRows(column, meta) {
  const chosen = new Map();
  for (let row = 1; row <= meta.chartRows; row += 1) {
    const visibleSlices = (column.segments ?? []).filter((entry) => row >= entry.rowStart && row <= entry.rowEnd);
    if (!visibleSlices.length) continue;
    // A terminal cell can contain a partial lower slice and a foreground
    // upper slice.  Assign the cell to the upper slice once so hit regions
    // tile without overlap; the glyph still retains both colours.
    const top = visibleSlices.reduce((best, entry) => (entry.high > best.high ? entry : best), visibleSlices[0]);
    if (!chosen.has(top)) chosen.set(top, []);
    chosen.get(top).push(row);
  }
  return [...chosen.entries()].flatMap(([entry, rows]) => {
    const ranges = [];
    let start = rows[0];
    let previous = rows[0];
    for (let index = 1; index <= rows.length; index += 1) {
      const current = rows[index];
      if (current === previous + 1) { previous = current; continue; }
      ranges.push({ entry, start, end: previous });
      start = current;
      previous = current;
    }
    return ranges;
  });
}

/** A dated stacked chart with total-column and per-slice hover geometry. */
export function renderStackedColumnChart({
  title, buckets, series, width, height, rowCount = null,
  unit, mark = '', totals = true, cumulative = false,
  tab, metric, period, basis = null, colors = true,
} = {}) {
  const cols = widthOf(width, 55);
  const list = Array.isArray(buckets) ? buckets : [];
  const sourceSeries = (Array.isArray(series) ? series : []).filter(Boolean).map((entry) => ({
    ...entry,
    values: Array.isArray(entry.values) ? entry.values : [],
  }));
  const labels = chartLabels(list, cols);
  const heading = fit(rule(title ?? '', null, cols), cols);
  if (!labels.length) return { lines: [heading, lineWithReason('—', 'no measured data', cols)], regions: [] };
  const names = sourceSeries.map((entry) => entry.id ?? entry.label ?? entry.name ?? null);
  const generatedColors = sourceSeries.some((entry) => !entry.color) ? seriesColors(names) : null;
  const painterSeries = sourceSeries.map((entry, index) => ({
    name: names[index],
    values: entry.values,
    color: entry.color ?? generatedColors?.get(names[index]) ?? seriesColor(names[index] ?? ''),
  }));
  if (!painterSeries.some((entry) => entry.values.some((value) => finite(value) != null))) {
    return { lines: [heading, lineWithReason('—', 'no measured values', cols)], regions: [] };
  }
  const chart = columnBars(painterSeries, labels, chartOptions(cols, height, rowCount, unit, mark, totals, cumulative, colors));
  const lines = [heading, ...chart.map((line) => fit(line, cols))];
  const regions = [];
  const meta = chart.meta;
  const datedAxis = datedAxisLine(chart, labels, cols);
  if (datedAxis && meta?.axisRow != null) lines[meta.axisRow] = datedAxis;
  const datedValues = meta?.valueRow != null ? datedValueLine(chart, meta.sums, cols, unit, mark) : null;
  if (datedValues && meta?.valueRow != null) lines[meta.valueRow] = datedValues;
  if (meta) {
    meta.columns.forEach((column, index) => {
      const sourceIndex = column.sourceIndex ?? index;
      const bucket = chartLabelBucket(list[sourceIndex], labels[sourceIndex]);
      const total = meta.sums[index];
      addColumnRegion(regions, column, meta, 1, bucket, total, { tab, metric, period, unit, basis });
      for (const { entry, start, end } of stackSliceRows(column, meta)) {
        const names = entry.sourceIndex < 0 ? otherSourceNames(column, sourceSeries, sourceIndex, column.eighths) : [];
        const seriesEntry = entry.sourceIndex >= 0 ? sourceSeries[entry.sourceIndex] : null;
        const label = entry.name ?? seriesEntry?.label ?? seriesEntry?.id ?? null;
        const value = entry.sourceIndex < 0
          ? names.reduce((sum, name) => {
            const found = sourceSeries.find((candidate) => (candidate.id ?? candidate.label ?? candidate.name) === name);
            return sum + (found ? Math.max(0, finite(found.values?.[sourceIndex]) ?? 0) : 0);
          }, 0)
          : Math.max(0, finite(seriesEntry?.values?.[sourceIndex]) ?? entry.value);
        const share = finite(total) != null && total > 0 ? value / total : null;
        const startColumn = entry.columnStart ?? barX(column, meta);
        const endColumn = entry.columnEnd ?? (startColumn + Math.max(1, column.barWidth ?? meta.barWidth) - 1);
        const payload = {
            tab: tab ?? null,
            metric: metric ?? null,
            period: period ?? null,
            bucketKey: bucket.key ?? null,
            bucketLabel: bucket.label ?? null,
            series: entry.sourceIndex < 0 ? null : (seriesEntry?.id ?? seriesEntry?.label ?? entry.name ?? null),
            label,
            value: finite(value),
            total: finite(total),
            share,
            unit: unitName(unit),
            // A series can span measured and unmeasured days.  The bucket is
            // the authoritative source for this slice; using a series-wide
            // fallback first would mark a measured day as `unknown` merely
            // because another day in the series had no cost reading.
            tokenSource: bucket?.tokenSource ?? seriesEntry?.tokenSource ?? null,
            basis: seriesEntry?.basis ?? bucket.basis ?? basis ?? null,
            sourceIndex: entry.sourceIndex,
            sourceNames: names,
          };
        for (let row = start; row <= end; row += 1) {
          regions.push({ kind: 'slice', row: 1 + row, columns: { start: startColumn, end: endColumn }, payload });
        }
      }
    });
  }
  return { lines, regions, meta: { chart: meta } };
}

/** Legend text wraps names but never creates data hit regions. */
export function renderLegend({ items, width, activeSeries = null, colors = true } = {}) {
  const cols = widthOf(width, 55);
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return { lines: [fit('Legend — no measured series', cols)], regions: [] };
  const generatedColors = list.some((item) => !item.color)
    ? seriesColors(list.map((item) => item.id ?? item.label ?? ''))
    : null;
  const tokens = list.map((item) => {
    const id = item.id ?? item.label ?? '';
    // Legends are the resolver for compact panel labels: always paint the
    // untouched series identity, while still routing it through the shared
    // shortening helper so panels and legends cannot grow separate rules.
    const fullLabel = String(item.fullLabel ?? item.id ?? item.label ?? '');
    const label = shortenLabel(fullLabel, { full: true });
    const marker = colors
      ? colourMarker(asciiGlyphsPreferred() ? '#' : '●', item.color ?? generatedColors?.get(id) ?? seriesColor(id), true)
      : '#';
    const plain = `${marker} ${label}`;
    const text = colors && String(id) === String(activeSeries) ? `${BOLD}${plain}${NO_BOLD}` : plain;
    return { text, plain };
  });
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const next = current ? `${current}  ${token.text}` : token.text;
    if (current && visible(next).length > cols) {
      lines.push(fit(current, cols));
      current = token.text;
    } else if (!current && visible(token.text).length > cols) {
      lines.push(fit(token.text, cols));
      current = '';
    } else current = next;
  }
  if (current) lines.push(fit(current, cols));
  return { lines: lines.length ? lines : [''], regions: [] };
}

/** Summary text is sourced prose, never a clickable bar. */
export function renderSummaryCard({ title, items, width, tab, metric, period, basis = null } = {}) {
  const cols = widthOf(width, 55);
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const lines = [fit(rule(title ?? 'Summary', null, cols), cols)];
  if (!list.length) lines.push(lineWithReason('—', 'no measured data', cols));
  list.forEach((item) => {
    const value = finite(item.value);
    const text = value == null
      ? lineWithReason(item.label ?? item.id, item.missingReason ?? item.note ?? 'value unavailable', cols)
      : fit(`${item.label ?? item.id ?? ''} ${item.valueText ?? sourcedValue(value, item.unit, item.tokenSource)}${item.note ? ` · ${item.note}` : ''}`, cols);
    lines.push(text);
  });
  void tab;
  void metric;
  void period;
  void basis;
  return { lines, regions: [] };
}

function childRegions(regions, child, rowOffset, columnOffset, maxWidth, lineCount) {
  for (const region of Array.isArray(child?.regions) ? child.regions : []) {
    const start = Math.max(1, columnOffset + Math.max(1, Number(region.columns?.start) || 1));
    const end = Math.min(maxWidth, columnOffset + Math.max(1, Number(region.columns?.end) || start));
    const row = rowOffset + Math.max(1, Number(region.row) || 1);
    if (end < start || row < 1 || row > lineCount) continue;
    regions.push({ ...region, row, columns: { start, end } });
  }
}

function appendLines(target, source, width) {
  for (const line of Array.isArray(source) ? source : []) target.push(fit(line, width));
}

function panelDescriptor(value, width) {
  return asDrawn(value, width, renderPanel);
}

function desktopPanelGrid(panelList, width, gap) {
  const inner = Math.max(2, width - gap);
  const cellWidths = [Math.ceil(inner / 2), Math.floor(inner / 2)];
  const raw = panelList.slice(0, 4);
  const layout = measurePanelGridLayout(raw, [cellWidths[0], cellWidths[1], cellWidths[0], cellWidths[1]]);
  const drawn = raw.map((panel, index) => panelDescriptor({
    ...panel,
    layout,
  }, cellWidths[index % 2]));
  const compose = (top, bottom) => {
    const offset = top.lines.length + 1;
    return {
      lines: [...top.lines, '', ...bottom.lines],
      regions: [
        ...(top.regions ?? []),
        ...(bottom.regions ?? []).map((region) => ({ ...region, row: region.row + offset })),
      ],
      meta: { layout },
    };
  };
  return [compose(drawn[0], drawn[2]), compose(drawn[1], drawn[3])];
}

/**
 * Compose the stable four-tab Stats surface.  On desktop the dated chart and
 * two-by-two panel grid share a row; on a phone the same cells are stacked in
 * order.  The blank hover row is reserved in both modes.
 */
export function renderStatsSurface({
  tab, period, width, height, stackBy = null,
  tabs = TABS, summary, chart, panels, legend, notes = [], ansi = true,
} = {}) {
  const cols = widthOf(width, 55);
  const activeTab = TABS.some((item) => item.id === tab) ? tab : 'spending';
  const activePeriod = PERIODS.some((item) => item.id === period) ? period : '7d';
  const nav = tabsRow(tabs, { active: activeTab, width: cols, action: (item) => ({ kind: 'tab', tab: item.id }) });
  const controls = periodToggle(PERIODS, { active: activePeriod, width: cols });
  const tabLabel = TABS.find((item) => item.id === activeTab)?.label ?? 'Spending';
  const toggle = activeTab === 'spending' ? `  [${stackBy === 'model' ? 'By Model' : 'By Pool'}] ${stackBy === 'model' ? 'By Pool' : 'By Model'}` : '';
  const controlText = fit(`${tabLabel} · ${PERIOD_LABELS[activePeriod] ?? activePeriod}${toggle}`, cols);
  const lines = [fit(nav.text, cols), controlText, ' '.repeat(cols)];
  const regions = [];
  const controlsMeta = [
    ...nav.regions.map((region) => ({ row: 1, x: region.x, width: region.width, action: region.action })),
    ...controls.regions.map((region) => ({ row: 2, x: region.x, width: region.width, action: region.action })),
  ];

  const summaryDrawn = asDrawn(summary, cols, renderSummaryCard);
  const summaryStart = lines.length;
  appendLines(lines, summaryDrawn.lines, cols);
  childRegions(regions, summaryDrawn, summaryStart, 0, cols, lines.length);

  const panelList = (Array.isArray(panels) ? panels : []).slice(0, 4);
  const chartDrawn = asDrawn(chart, cols, renderColumnChart);
  const desktop = cols >= 80 && panelList.length > 0;
  const bodyStart = lines.length;
  if (!desktop) {
    appendLines(lines, chartDrawn.lines, cols);
    childRegions(regions, chartDrawn, bodyStart, 0, cols, lines.length);
    for (const panel of panelList) {
      const gap = lines.length ? 1 : 0;
      if (gap) lines.push('');
      const start = lines.length;
      const rendered = panelDescriptor(panel, cols);
      appendLines(lines, rendered.lines, cols);
      childRegions(regions, rendered, start, 0, cols, lines.length);
    }
  } else {
    const gutter = 2;
    const leftWidth = Math.max(1, Math.floor((cols - gutter) / 2));
    const rightWidth = Math.max(1, cols - gutter - leftWidth);
    const renderedPanels = panelList.length >= 4 && panelList.slice(0, 4).every((panel) => !Array.isArray(panel?.lines))
      ? desktopPanelGrid(panelList, rightWidth, gutter)
      : panelList.map((panel) => panelDescriptor(panel, rightWidth));
    const grid = columns(renderedPanels.map((rendered) => ({ rows: rendered.lines })), { width: rightWidth, gap: 2 });
    const outer = columns([
      { rows: chartDrawn.lines, width: leftWidth },
      { rows: grid, width: rightWidth },
    ], { width: cols, gap: gutter });
    appendLines(lines, outer, cols);
    const outerCols = outer.meta?.columns ?? [];
    const chartColumn = outerCols[0];
    if (chartColumn) childRegions(regions, chartDrawn, bodyStart, chartColumn.x - 1, cols, lines.length);
    const gridColumn = outerCols[1];
    if (gridColumn) {
      const gridCols = grid.meta?.columns ?? [];
      renderedPanels.forEach((rendered, index) => {
        const cell = gridCols[index];
        if (!cell) return;
        childRegions(regions, rendered, bodyStart, gridColumn.x - 1 + cell.x - 1, cols, lines.length);
      });
    }
  }

  const legendDrawn = asDrawn(legend, cols, renderLegend);
  const legendStart = lines.length;
  appendLines(lines, legendDrawn.lines, cols);
  childRegions(regions, legendDrawn, legendStart, 0, cols, lines.length);
  for (const note of Array.isArray(notes) ? notes : []) lines.push(fit(String(note ?? ''), cols));
  // `ansi:false` is a capture mode for tests and frames; remove styling from
  // every line without changing the geometry already recorded above.
  const outputLines = lines.map((line) => ansi ? line : visible(line));
  return {
    lines: outputLines,
    regions,
    meta: { controls: controlsMeta, hoverRow: 3, bodyMode: desktop ? 'desktop' : 'stacked', height, width: cols },
  };
}

/** One wording function for the shell's transient and pinned hover row. */
export function formatHoverLabel(payload = {}) {
  const unknownCost = unitName(payload.unit) === 'usd' && payload.tokenSource === 'unknown';
  const value = unknownCost ? null : finite(payload.value);
  const estimated = typeof payload.tokenSource === 'string' && payload.tokenSource.startsWith('estimated:');
  const kind = payload.kind
    ?? (payload.bucketKey == null && payload.label ? 'share' : payload.series ? 'slice' : 'column');
  const missingText = kind === 'slice' ? (payload.missingReason ?? 'not measured') : 'value unavailable';
  let valueText = value == null
    ? missingText
    : `${estimated && unitName(payload.unit) === 'usd' ? '≈' : ''}${formatValue(value, payload.unit)}`;
  if (value != null && unitName(payload.unit) === 'usd' && payload.subscriptionUsd != null) {
    valueText = formatMoneyPair({
      api: { usd: payload.apiUsd ?? value },
      tokenSource: payload.tokenSource,
      tokens: payload.tokens ?? null,
      subscription: {
        usd: payload.subscriptionUsd,
        deltaPct: payload.subscriptionDeltaPct,
        window: payload.subscriptionWindow,
        basis: payload.subscriptionBasis,
      },
    });
  }
  const shareText = formatShare(payload.share);
  const date = payload.bucketLabel ?? payload.bucketKey ?? 'date unavailable';
  if (value == null || finite(payload.share) == null && kind !== 'column') {
    if (kind === 'share') return `${payload.label ?? 'row'} · ${valueText} · ${shareText} of panel`;
    return `${date} · ${payload.series ?? payload.label ?? 'total'} · ${valueText} · ${shareText} of the day`;
  }
  if (kind === 'share') return `${payload.label ?? payload.series ?? 'row'} · ${valueText} · ${shareText} of panel`;
  if (kind === 'slice') return `${date} · ${payload.series ?? payload.label ?? 'series'} · ${valueText} · ${shareText} of day`;
  return `${date} · total · ${valueText} · ${shareText} of day`;
}
