// The Stats legend's regions: a hit target per legend name, share regions
// re-anchored on the glyphs painted, and the selected series in bold.
// N1: a missing measurement never becomes a confident zero. Number(null) is
// 0 and Number.isFinite(0) is true, so every reading below goes through this.
import { finiteOrNull } from '../lib/num.js';
import { ANSI_SGR } from './dashboard-ansi.js';

/**
 * Add a shell hit target for each visible Stats legend name.  The shared
 * renderer quite intentionally treats a legend as explanatory text, but the
 * interactive shell still needs to let a reader tap the same series there as
 * on its chart slice.  Aggregate one measured cell per date so the legend
 * label carries an honest value/share rather than counting the painted height
 * of a column more than once.
 */
function addStatsLegendRegions(view) {
  if (!view || !Array.isArray(view.lines)) return view;
  const lines = view.lines;
  const legendAt = lines.findIndex((line) => String(line ?? '').replace(ANSI_SGR, '').startsWith('Legend'));
  if (legendAt < 0) return view;
  const cells = new Map();
  for (const region of Array.isArray(view.regions) ? view.regions : []) {
    const payload = region?.action?.payload;
    const kind = payload?.kind;
    if (!payload || (kind !== 'slice' && kind !== 'column')) continue;
    const identity = String(payload.series ?? payload.label ?? '').trim();
    if (!identity || identity === 'total') continue;
    const bucket = String(payload.bucketKey ?? payload.bucketLabel ?? '');
    const key = `${identity}\u0000${bucket}`;
    if (cells.has(key)) continue;
    cells.set(key, { identity, payload });
  }
  if (!cells.size) return view;
  const grouped = new Map();
  for (const cell of cells.values()) {
    const entry = grouped.get(cell.identity) ?? { identity: cell.identity, cells: [] };
    entry.cells.push(cell.payload);
    grouped.set(cell.identity, entry);
  }
  const extra = [];
  for (const { identity, cells: entries } of grouped.values()) {
    let value = 0;
    let hasValue = false;
    let total = 0;
    let hasTotal = false;
    const first = entries[0] ?? {};
    for (const payload of entries) {
      const measured = finiteOrNull(payload.value);
      if (measured != null) { value += measured; hasValue = true; }
      const measuredTotal = finiteOrNull(payload.total);
      if (measuredTotal != null) { total += measuredTotal; hasTotal = true; }
    }
    const aggregate = {
      ...first,
      kind: 'share',
      bucketKey: null,
      bucketLabel: null,
      series: identity,
      label: identity,
      value: hasValue ? value : null,
      total: hasTotal ? total : null,
      share: hasValue && hasTotal && total > 0 ? value / total : null,
    };
    const action = {
      kind: 'slice',
      tab: aggregate.tab,
      metric: aggregate.metric,
      period: aggregate.period,
      bucket: null,
      series: identity,
      payload: aggregate,
    };
    const lineIndex = lines.findIndex((line, index) => {
      if (index < legendAt) return false;
      const plain = String(line ?? '').replace(ANSI_SGR, '');
      const at = plain.indexOf(identity);
      if (at < 0) return false;
      const before = plain[at - 1] ?? ' ';
      const after = plain[at + identity.length] ?? ' ';
      return !/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after);
    });
    if (lineIndex < 0) continue;
    const plain = String(lines[lineIndex] ?? '').replace(ANSI_SGR, '');
    const x = plain.indexOf(identity) + 1;
    if (x < 1) continue;
    const width = Math.min(identity.length, Math.max(0, plain.length - x + 1));
    if (width > 0) extra.push({ x, y: lineIndex + 1, width, action });
  }
  return extra.length ? { ...view, regions: [...(view.regions ?? []), ...extra] } : view;
}

/**
 * Keep the shell's hit cells on the glyphs actually painted by a panel.  The
 * shared panel metadata is intentionally independent of ANSI styling; when a
 * narrow label is clipped, a styled bar can begin a couple of cells before
 * the logical label-column offset.  Re-anchor only share regions, and only
 * when a contiguous share-glyph run is present, so chart-column and legend
 * geometry remains untouched (and a future corrected metadata path is a
 * no-op).
 */
function alignStatsShareRegions(view) {
  const shareGlyph = /[▓▒░█▏#.|]/;
  const sourceLines = Array.isArray(view?.lines) ? view.lines : [];
  for (const region of Array.isArray(view?.regions) ? view.regions : []) {
    if (region?.action?.payload?.kind !== 'share' || !(region.width > 0)) continue;
    const line = String(sourceLines[(Number(region.y) || 1) - 1] ?? '').replace(ANSI_SGR, '');
    if (line.trimStart().startsWith('Legend')) continue;
    const positions = [];
    for (let index = 0; index < line.length; index += 1) {
      if (shareGlyph.test(line[index])) positions.push(index + 1);
    }
    if (!positions.length) continue;
    const runs = [];
    let start = positions[0];
    let previous = positions[0];
    for (let index = 1; index <= positions.length; index += 1) {
      const current = positions[index];
      if (current === previous + 1) { previous = current; continue; }
      runs.push({ start, end: previous });
      start = current;
      previous = current;
    }
    const target = Number(region.x) || 1;
    const run = runs
      .map((candidate) => ({ candidate, distance: target < candidate.start
        ? candidate.start - target : target > candidate.end ? target - candidate.end : 0 }))
      .sort((left, right) => left.distance - right.distance)[0]?.candidate;
    if (!run) continue;
    const width = Math.min(region.width, run.end - run.start + 1);
    if (width > 0) { region.x = run.start; region.width = width; }
  }
  return view;
}

/** Bold just the matching legend name while leaving its coloured marker alone. */
function boldStatsLegend(view, series) {
  const identity = String(series ?? '').trim();
  if (!identity || !Array.isArray(view?.lines)) return view;
  const legendAt = view.lines.findIndex((line) => String(line ?? '').replace(ANSI_SGR, '').startsWith('Legend'));
  if (legendAt < 0) return view;
  for (let index = legendAt; index < view.lines.length; index += 1) {
    const source = String(view.lines[index] ?? '');
    const plain = source.replace(ANSI_SGR, '');
    let at = plain.indexOf(identity);
    while (at >= 0) {
      const before = plain[at - 1] ?? ' ';
      const after = plain[at + identity.length] ?? ' ';
      if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
        view.lines[index] = boldVisibleSpan(source, at, at + identity.length);
        return view;
      }
      at = plain.indexOf(identity, at + 1);
    }
  }
  return view;
}

function boldVisibleSpan(line, start, end) {
  const sgr = /\x1b\[[0-9;?]*[A-Za-z]/y;
  let out = '';
  let cell = 0;
  let at = 0;
  while (at < line.length) {
    sgr.lastIndex = at;
    const match = sgr.exec(line);
    if (match) {
      out += match[0];
      at += match[0].length;
      continue;
    }
    if (cell === start) out += '\x1b[1m';
    out += line[at];
    cell += 1;
    if (cell === end) out += '\x1b[22m';
    at += 1;
  }
  if (cell <= start) return line;
  if (cell < end) out += '\x1b[22m';
  return out;
}

export {
  addStatsLegendRegions,
  alignStatsShareRegions,
  boldStatsLegend,
};
