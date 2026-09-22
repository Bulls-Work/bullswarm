// The render kit the 0.33.0 pages compose from: the thin rules, the page tab
// row and the period toggle, the share, progress and stacked bars, the
// sparkline and the heat row, the column band and the compact row, the axis
// step and the visible-cell truncation.
// Every function is pure — strings in, strings out — so a page renders and is
// asserted without a terminal, and none of them reads a TTY.
//
// A page never draws a dotted or blank track, meter or bar for missing data;
// it writes the reason in words on that row with absentLine(). Measured zero
// is data, not absence. Legacy bar defaults require callers to guard absence.
//
// Two rules hold for every function here:
//
//   1. Nothing paints past `width`. Distances are counted in visible cells
//      (SGR escapes are zero width), so a caller that asks for 54 columns gets
//      at most 54, at any width from 32 to 200.
//   2. asciiGlyphsPreferred() decides the glyph, never the anatomy: the
//      unicode glyph is the default and its ascii twin is exactly one column
//      wide, the discipline src/lib/glyphs.js documents. Its fallbacks differ
//      in count where the shape needs it — a sparkline scaled over eight
//      levels reads as well over five.
//
// Colours come from the one palette the product has, METER_COLORS in
// usage-view.js, and this file invents none. That palette now carries the
// prototype's purple, orange, cyan and dim roles, its "others" band and its
// four heat shades, so the heat ramp is the palette's own and a caller names a
// role rather than a hex. Where the prototype used colour for an affordance
// this kit still substitutes attributes that need no colour: the active tab
// and the active period are inverted, every key letter is underlined, and the
// parts after the first in a share bar are dimmed.
//
// A region is `{ x, width, action }` with `x` the 1-based column inside the
// returned line — the same base as parseMouse()'s coordinates — so the shell
// maps it onto its `{ x1, x2 }` hit regions without arithmetic.

import { formatMoney } from '../lib/usage-basis.js';
import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import { METER_COLORS } from './usage-view.js';

// Series colours are keyed by the name being drawn, not by the order in
// which a particular period happens to return it.  The two grey roles are
// deliberately reserved for the honest aggregations the charts can produce.
// Fourteen hues, muted to sit with the meter colours; the first six are the
// meter roles themselves so pools keep the colours they had. The two greys
// are reserved for the honest aggregations (`unknown`, `other`).
export const SERIES_PALETTE = Object.freeze([
  METER_COLORS.purple, METER_COLORS.amber, METER_COLORS.green, METER_COLORS.cyan, METER_COLORS.orange, METER_COLORS.red,
  '#d69ac4', // pink
  '#7fbfa8', // teal
  '#7fa3e0', // blue
  '#c9d47a', // lime
  '#c98ad9', // magenta
  '#d9b060', // gold
  '#9bc4e8', // sky
  '#e08a7a', // coral
]);
const SERIES_COLOR_GREYS = Object.freeze({ unknown: METER_COLORS.dim, other: METER_COLORS.others });

function seriesHash(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const seriesKey = (name) => String(name ?? '').trim().toLowerCase();
const greyFor = (key) => {
  if (!key || key === 'unknown') return SERIES_COLOR_GREYS.unknown;
  if (key === 'other' || key.startsWith('other (')) return SERIES_COLOR_GREYS.other;
  return null;
};

/** A deterministic colour for a pool/model series across every period. */
export function seriesColor(name) {
  const key = seriesKey(name);
  return greyFor(key) ?? SERIES_PALETTE[seriesHash(key) % SERIES_PALETTE.length];
}

/**
 * Colours for every series drawn together. Each name starts from its own
 * deterministic colour (`seriesColor`), so a pool keeps its colour from one
 * period to the next; when two names in the same chart would share a hue the
 * later one (in the order given) moves to the next unused hue, so no two
 * series in one chart look alike until the palette is exhausted.
 */
export function seriesColors(names) {
  const assigned = new Map();
  const used = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    if (assigned.has(name)) continue;
    const key = seriesKey(name);
    const grey = greyFor(key);
    if (grey) { assigned.set(name, grey); continue; }
    let at = seriesHash(key) % SERIES_PALETTE.length;
    for (let probe = 0; probe < SERIES_PALETTE.length && used.has(SERIES_PALETTE[at]); probe += 1) {
      at = (at + 1) % SERIES_PALETTE.length;
    }
    used.add(SERIES_PALETTE[at]);
    assigned.set(name, SERIES_PALETTE[at]);
  }
  return assigned;
}

// A descriptive alias for callers that do not use the chart terminology.
export const paletteColor = seriesColor;

/** Row budget shared by the chart callers at each frame height. */
export function chartRowCount(height, { min = 5, max = 16 } = {}) {
  const value = Number(height);
  const lower = Math.max(1, Math.trunc(Number(min)) || 5);
  const upper = Math.max(lower, Math.trunc(Number(max)) || 16);
  const derived = Number.isFinite(value) ? Math.floor((value - 2) / 4) : lower;
  return Math.max(lower, Math.min(upper, derived));
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const INVERT = '\x1b[7m';
const UNDERLINE = '\x1b[4m';
const NO_UNDERLINE = '\x1b[24m';
const SGR = /\x1b\[[0-9;]*m/g;
const HEX = /^#[0-9a-f]{6}$/i;

/** The columns a styled line really occupies. */
const visibleLength = (text) => String(text ?? '').replace(SGR, '').length;

/**
 * Clip a styled cell to its visible width, then pad the cell back to that
 * width. `cut()` owns the clipping/reset policy; this wrapper is the shared
 * compositor primitive so callers never fall back to String#length when a
 * cell carries SGR sequences.
 */
function padVisible(text, width) {
  const cols = colsOf(width, 0);
  if (cols <= 0) return '';
  const clipped = cut(text, cols);
  return `${clipped}${' '.repeat(Math.max(0, cols - visibleLength(clipped)))}`;
}

/** A width as a whole number of columns; anything unusable falls back. */
function colsOf(width, fallback) {
  const value = Number(width);
  if (!Number.isFinite(value)) return Math.max(0, Math.trunc(fallback));
  return Math.max(0, Math.trunc(value));
}

/**
 * A whole number of cells, or the fallback: a gap, a fixed field width or a
 * floor. Null, undefined and the empty string are "not given" rather than the
 * zero `Number()` calls them, and Infinity is not a number of cells — it would
 * reach String#repeat and throw.
 */
function cellsOf(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

const rgbOf = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const bgOf = (triple) => `\x1b[48;2;${triple.join(';')}m`;
const fgOf = (hex) => `\x1b[38;2;${rgbOf(hex).join(';')}m`;
const isHex = (value) => typeof value === 'string' && HEX.test(value);

/** Shared dashboard precision for money, licence rates and durations. */
export function formatDashboardValue(value, kind) {
  const number = reading(value);
  if (number == null) return null;
  if (kind === 'money') return formatMoney(number);
  if (kind === 'rate') {
    if (number === 0) return '0%/min';
    return `${Number(number.toPrecision(3))}%/min`;
  }
  if (kind === 'percent') return `${number === 0 ? 0 : Number(number.toPrecision(3))}%`;
  if (kind === 'minutes') {
    const total = Math.max(0, Math.round(number));
    if (total < 60) return `${total}m`;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  return String(number);
}

/**
 * `text` cut to `width` visible cells with a trailing `…`: escapes are kept
 * whole, measuring strips them first, and a reset closes whatever was still
 * open so no colour leaks past the cut. A line as short as the width is
 * returned untouched.
 */
export function cut(text, width = 20) {
  const cols = colsOf(width, 20);
  const source = String(text ?? '');
  if (cols <= 0) return '';
  if (visibleLength(source) <= cols) return source;
  let out = '';
  let used = 0;
  for (let index = 0; index < source.length && used < cols - 1;) {
    if (source[index] === '\x1b') {
      const end = source.indexOf('m', index);
      if (end > index) {
        out += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    out += source[index];
    index += 1;
    used += 1;
  }
  return `${out}…${source.includes('\x1b') ? RESET : ''}`;
}

/**
 * `── title ─────────── right ──`, exactly `width` columns: the title opens on
 * the left, the right end closes on the other, and the dashes take whatever is
 * between. Either side may be missing — both missing is a bare rule — and a
 * pair too long for the width is cut rather than allowed to overrun it.
 */
export function rule(title = null, right = null, width = 120) {
  const cols = colsOf(width, 120);
  if (cols <= 0) return '';
  const head = title == null || `${title}` === '' ? '' : `── ${title} `;
  const tail = right == null || `${right}` === '' ? '' : ` ${right} ──`;
  const used = visibleLength(head) + visibleLength(tail);
  if (used >= cols) return cut(`${head}${tail}`, cols);
  return `${head}${'─'.repeat(cols - used)}${tail}`;
}

/**
 * N cells laid side by side across `width`, one text block back: Home's
 * four-column breakdown, Run's budget/live/so-far triptych and Stats
 * Overview's three-column figure grid are the same problem in three places,
 * and this is the one helper all three call.
 *
 * A cell is `{ rule, rows, width }` — `rule` an optional column heading drawn
 * by rule() across that column, `rows` the lines beneath it, `width` a fixed
 * width for a column the caller has measured (the prototype's Run triptych is
 * 37/36/29, not three equal thirds). Cells without a width share what is left
 * evenly, the leftmost taking the odd column. The block is as tall as its
 * tallest cell, short columns ending in blanks so the columns below stay
 * aligned, and a line wider than its column is cut(), never wrapped: a band is
 * a band, and a caller that wants wrapping wraps before it calls. Trailing
 * blanks are trimmed, so no line and no column reaches past `width`, and cells
 * that cannot be given a column each are dropped from the right rather than
 * painted at zero width.
 *
 * The returned array of lines carries a non-enumerable `meta`,
 * `{ gap, columns: [{ x, width, rows }] }` with `x` the 1-based column the
 * cell starts at, so a page maps hit regions onto it without arithmetic.
 */
export function columns(cells, { width = 120, gap = 2 } = {}) {
  const cols = colsOf(width, 120);
  const list = (Array.isArray(cells) ? cells : []).filter(Boolean);
  const space = cellsOf(gap, 2);
  const band = (lines, meta) => {
    Object.defineProperty(lines, 'meta', { enumerable: false, value: meta });
    return lines;
  };
  if (cols <= 0 || !list.length) return band([], { gap: space, columns: [] });

  let kept = list;
  while (kept.length > 1 && cols < kept.length + space * (kept.length - 1)) kept = kept.slice(0, -1);
  const count = kept.length;
  const inner = Math.max(count, cols - space * (count - 1));

  const asked = kept.map((cell) => {
    const value = Number(cell.width);
    return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : null;
  });
  const elastic = asked.filter((value) => value == null).length;
  const claimed = asked.reduce((sum, value) => sum + (value ?? 0), 0);
  let widths;
  if (claimed + elastic <= inner) {
    const free = inner - claimed;
    const base = elastic ? Math.floor(free / elastic) : 0;
    const extra = elastic ? free - base * elastic : 0;
    let seen = 0;
    widths = asked.map((value) => {
      if (value != null) return value;
      const own = base + (seen < extra ? 1 : 0);
      seen += 1;
      return own;
    });
  } else {
    // The widths asked for do not fit: an even split is the one answer that
    // never paints past the band, and a caller sees it in `meta`.
    const base = Math.floor(inner / count);
    const extra = inner - base * count;
    widths = kept.map((_, index) => base + (index < extra ? 1 : 0));
  }

  const titled = kept.some((cell) => cell.rule != null && `${cell.rule}` !== '');
  const blocks = kept.map((cell, index) => {
    const rows = (Array.isArray(cell.rows) ? cell.rows : []).map((row) => String(row ?? ''));
    if (!titled) return rows;
    const head = cell.rule == null || `${cell.rule}` === '' ? '' : rule(cell.rule, null, widths[index]);
    return [head, ...rows];
  });
  const height = blocks.reduce((most, block) => Math.max(most, block.length), 0);
  const pad = (text, own) => padVisible(text, own);
  const lines = [];
  for (let row = 0; row < height; row += 1) {
    const line = blocks
      .map((block, index) => pad(block[row] ?? '', widths[index]))
      .join(' '.repeat(space));
    lines.push(line.replace(/ +$/, ''));
  }
  let at = 1;
  const regions = widths.map((own, index) => {
    const x = at;
    at += own + space;
    return { x, width: own, rows: blocks[index].length };
  });
  return band(lines, { gap: space, columns: regions });
}

/**
 * One row of fields across `width` whose elastic field shrinks before anything
 * is dropped: History's two-rows-per-run, Home's two-rows-per-tile and
 * Budget's seventeen-rows-per-pool are the same problem in three places, and
 * this is the one helper all three call.
 *
 * A field is `{ text, width, min, grow, align, gap }`, or a bare string for a
 * plain one. `width` fixes a column — a result mark, a run id, a duration;
 * `grow` marks the elastic field, which takes whatever the fixed fields leave
 * and gives it back first, never below `min` (1 by default); `align: 'right'`
 * pads inside the field's own width; `gap` is the blanks in front of the
 * field, one by default. Because the elastic field absorbs the slack, the
 * fields after it sit against the right edge of the row — which is how a
 * person, a pool, a duration and a cost fit on one phone row.
 *
 * Shrinking is cut(), so a squeezed field ends in `…` rather than vanishing.
 * Only when the fixed fields alone will not fit are fields dropped, from the
 * right, and the first field — the one that says what the row is — is never
 * dropped. The row is at most `width` visible cells and carries no trailing
 * blanks.
 */
export function compactRow(fields, { width = 55, gap = 1 } = {}) {
  const cols = colsOf(width, 55);
  const space = cellsOf(gap, 1);
  const list = (Array.isArray(fields) ? fields : [])
    .filter((field) => field != null && field !== false)
    .map((field) => {
      const spec = typeof field === 'object' ? field : { text: field };
      return {
        text: String(spec.text ?? ''),
        fixed: cellsOf(spec.width, null),
        min: cellsOf(spec.min, 1),
        lead: cellsOf(spec.gap, space),
        grow: spec.grow === true,
        right: spec.align === 'right',
      };
    });
  if (cols <= 0 || !list.length) return '';

  const leadOf = (field, index) => (index === 0 ? 0 : field.lead);
  const paint = (field, size) => {
    if (size <= 0) return '';
    const clipped = cut(field.text, size);
    const fill = ' '.repeat(Math.max(0, size - visibleLength(clipped)));
    return field.right ? `${fill}${clipped}` : `${clipped}${fill}`;
  };

  let kept = list;
  for (;;) {
    const sizes = kept.map((field) => field.fixed ?? visibleLength(field.text));
    let used = kept.reduce((sum, field, index) => sum + leadOf(field, index) + sizes[index], 0);
    if (used > cols) {
      // The elastic fields give their cells back first, the rightmost first,
      // and never below their floor: cut() before anything is dropped.
      for (let index = kept.length - 1; index >= 0 && used > cols; index -= 1) {
        if (!kept[index].grow) continue;
        const give = Math.min(sizes[index] - kept[index].min, used - cols);
        if (give > 0) {
          sizes[index] -= give;
          used -= give;
        }
      }
    } else if (used < cols) {
      const growers = kept.flatMap((field, index) => (field.grow ? [index] : []));
      if (growers.length) {
        const free = cols - used;
        const base = Math.floor(free / growers.length);
        const extra = free - base * growers.length;
        growers.forEach((index, at) => { sizes[index] += base + (at < extra ? 1 : 0); });
        used = cols;
      }
    }
    if (used <= cols || kept.length <= 1) {
      const line = kept
        .map((field, index) => `${' '.repeat(leadOf(field, index))}${paint(field, sizes[index])}`)
        .join('');
      return cut(line, cols).replace(/ +$/, '');
    }
    kept = kept.slice(0, -1);
  }
}

/** A label whose key letter is underlined; inverted too when it is active. */
function keyedText(label, key, active) {
  const at = key ? label.toLowerCase().indexOf(String(key).toLowerCase()) : -1;
  const inner = at >= 0
    ? `${label.slice(0, at)}${UNDERLINE}${label[at]}${NO_UNDERLINE}${label.slice(at + 1)}`
    : label;
  return active ? `${INVERT}${inner}${RESET}` : inner;
}

/**
 * One row of clickable items: the leading space, then the items joined by
 * `separator`. Items are dropped from the end to fit `width`, except the
 * active one, which is the reader's position and never falls off.
 */
function itemRow(items, { active = null, width = 120, separator = '  ', leading = true, action }) {
  const cols = width == null ? null : colsOf(width, 120);
  const kept = (Array.isArray(items) ? items : []).filter(Boolean).map((item) => {
    const label = String(item.label ?? '');
    const isActive = active != null && String(item.id) === String(active);
    const text = keyedText(label, item.key, isActive);
    return { isActive, text, width: visibleLength(text), action: action(item) };
  });
  const lineOf = () => `${leading ? ' ' : ''}${kept.map((item) => item.text).join(separator)}`;
  while (cols != null && kept.length > 1 && visibleLength(lineOf()) > cols) {
    let victim = -1;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (!kept[index].isActive) { victim = index; break; }
    }
    if (victim < 0) break;
    kept.splice(victim, 1);
  }
  let text = lineOf();
  if (cols != null && visibleLength(text) > cols) text = cut(text, cols);
  const painted = visibleLength(text);
  const regions = [];
  let column = leading ? 2 : 1;
  for (const item of kept) {
    if (column + item.width - 1 <= painted) regions.push({ x: column, width: item.width, action: item.action });
    column += item.width + separator.length;
  }
  return { text, regions };
}

/**
 * The page tab row: ` Home  Runs  Budget …`, the active tab inverted with its
 * key letter underlined, a tab named in `hidden` dropped unless it is the
 * active one, and a tab that does not fit dropped rather than painted past
 * `width`. Each region opens the page its tab names.
 *
 * `action` may override the region's action with `(tab) => action`; the frozen
 * default is `{ kind: 'page', page: <id> }`.
 */
export function tabsRow(tabs, { active = null, width = 120, hidden = [], action = null } = {}) {
  const hiddenIds = new Set((Array.isArray(hidden) ? hidden : []).map((id) => String(id)));
  const shown = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && (
    (active != null && String(tab.id) === String(active)) || !hiddenIds.has(String(tab.id))
  ));
  return itemRow(shown, {
    active,
    width,
    separator: '  ',
    leading: true,
    action: action ?? ((tab) => ({ kind: 'page', page: tab.id })),
  });
}

/**
 * `All time · Last 7 days · Last 30 days`, the active period inverted with its
 * key letter underlined, every region `{ kind: 'period', period: <id> }`.
 *
 * The frozen signature has no width; pass one and the row keeps its active
 * period and drops the rest to fit, and its regions stay relative to the text
 * this returns (a caller that prefixes a space shifts them by one).
 */
export function periodToggle(periods, { active = null, width = null, action = null } = {}) {
  return itemRow(Array.isArray(periods) ? periods : [], {
    active,
    width,
    separator: ' · ',
    leading: false,
    action: action ?? ((period) => ({ kind: 'period', period: period.id })),
  });
}

/** Hand out `cells` whole cells across `values`, largest remainder first. */
function allocate(values, cells) {
  if (!(cells > 0) || !values.length) return values.map(() => 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * cells);
  const counts = exact.map((value) => Math.floor(value));
  let left = cells - counts.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let step = 0; left > 0; step += 1) {
    counts[order[step % order.length].index] += 1;
    left -= 1;
    if (step > cells + values.length) break;
  }
  return counts;
}

const TINY_GLYPH = '\u258f';

/**
 * A part that has any value at all keeps at least one cell, borrowed from the
 * widest part that can spare one.  Rounding a live 1% down to nothing reads as
 * "never used", which is a different fact from "barely used".  The borrowed
 * cell is drawn as a sliver so the bar never overstates the reading either:
 * one of six cells is 17% of the track, and the value that earned it is not.
 * Returns the indexes that were promoted, so the caller can pick their glyph.
 */
function promoteTinyParts(values, counts) {
  const promoted = new Set();
  values.forEach((value, index) => {
    if (!(value > 0) || counts[index]) return;
    const donor = counts.reduce((best, count, at) => count > counts[best] ? at : best, 0);
    if (counts[donor] > 1) {
      counts[donor] -= 1;
      counts[index] = 1;
      promoted.add(index);
    }
  });
  return promoted;
}

/**
 * A reading, or null when there is none. Only a finite number — or a string
 * that is one — counts: `Number(null)`, `Number('')` and `Number([])` are all
 * 0, and any of them would paint a day with no data as a quiet one.
 */
function reading(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function absentLine(label, reason, { width = 55, labelWidth = 0 } = {}) {
  const [name, why] = [label, reason].map((value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim());
  // `labelWidth` lets a page that already lays its rows out in a label column
  // (Budget's `used` / `by bullswarm` / `room`) keep an absent row in the same
  // column instead of shifting it left by the default three-space join.
  const pad = Math.trunc(Number(labelWidth)) || 0;
  const joined = name && why && pad > 0 ? `${name.padEnd(pad)}${why}`
    : [name, why].filter(Boolean).join('   ');
  const text = cut(joined, colsOf(width, 55));
  return text ? `${DIM}${text}${RESET}` : '';
}

const SHARE_GLYPHS = Object.freeze(['▓', '▒', '░', '█']);
const SHARE_ASCII = Object.freeze(['#', '.', '|', '#']);

/**
 * A share bar of exactly `width` cells for parts `[{ value, glyph }]` that
 * between them are the whole: `▓▓▓▓▓▒▒▒░░`. Cells are handed out by largest
 * remainder, so the bar always adds up and no cell is lost to rounding. An
 * ascii terminal gets `# . |` whatever glyph the part names.
 *
 * With `colors` the first part keeps the terminal's own colour, a part that
 * names one of the palette's hex values is painted in it, and the parts after
 * the first are dimmed — the closest this palette comes to the prototype's
 * bright `▓` over quieter `▒` and `░`.
 *
 * A part with any value at all is never rounded away to nothing: it borrows a
 * cell from the widest part and is drawn as a sliver (`▏`, `|` in ascii), so a
 * live 1% reads as barely used rather than untouched without claiming a whole
 * cell's worth of share. `partialGlyph` only chooses which sliver is drawn.
 */
export function shareBar(parts, { width = 20, colors = true, partialGlyph = null } = {}) {
  const cols = colsOf(width, 20);
  if (cols <= 0) return '';
  const ascii = asciiGlyphsPreferred();
  const list = (Array.isArray(parts) ? parts : []).filter(Boolean).map((part, index) => ({
    value: Math.max(0, Number(part.value) || 0),
    glyph: ascii
      ? SHARE_ASCII[index] ?? SHARE_ASCII[SHARE_ASCII.length - 1]
      : (typeof part.glyph === 'string' && part.glyph ? part.glyph : SHARE_GLYPHS[index] ?? SHARE_GLYPHS[SHARE_GLYPHS.length - 1]),
    color: isHex(part.color) ? part.color : null,
    index,
  }));
  const counts = allocate(list.map((part) => part.value), cols);
  const partials = promoteTinyParts(list.map((part) => part.value), counts);
  const sliver = typeof partialGlyph === 'string' && [...partialGlyph].length === 1
    ? partialGlyph
    : TINY_GLYPH;
  if (!counts.some((count) => count > 0)) return ' '.repeat(cols);
  let out = '';
  let painted = 0;
  list.forEach((part, index) => {
    const count = counts[index];
    if (!count) return;
    const run = partials.has(index) ? (ascii ? '|' : sliver) : part.glyph.repeat(count);
    if (colors && part.color) out += `${fgOf(part.color)}${run}${RESET}`;
    else if (colors && part.index > 0) out += `${DIM}${run}${RESET}`;
    else out += run;
    painted += count;
  });
  return `${out}${' '.repeat(Math.max(0, cols - painted))}`;
}

/**
 * The geometry sibling of shareBar().  It deliberately repeats shareBar's
 * allocation rules instead of deriving widths from the rendered string: a
 * coloured or styled bar still has the same one-cell hit regions, and a
 * partial glyph moves one cell from the largest part just as shareBar does.
 * `x` is one-based, matching the other dash-kit metadata.
 */
export function shareBarMeta(parts, { width = 20, colors = true, partialGlyph = null } = {}) {
  const cols = colsOf(width, 20);
  const source = (Array.isArray(parts) ? parts : []).filter(Boolean);
  const list = source.map((part, index) => ({
    ...part,
    value: Math.max(0, Number(part.value) || 0),
    index,
  }));
  const counts = allocate(list.map((part) => part.value), cols);
  promoteTinyParts(list.map((part) => part.value), counts);
  const total = list.reduce((sum, part) => sum + part.value, 0);
  let x = 1;
  const geometries = list.map((part, index) => {
    const own = counts[index] || 0;
    const geometry = {
      id: part.id ?? part.label ?? index,
      x,
      width: own,
      value: part.value,
      share: reading(part.share) ?? (total > 0 ? part.value / total : null),
    };
    x += own;
    return geometry;
  });
  return { text: shareBar(parts, { width: cols, colors, partialGlyph }), parts: geometries };
}

const SPARK_UNICODE = Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);
const SPARK_ASCII = Object.freeze(['.', ':', '-', '=', '#']);

/**
 * `▂▅▃▇▆▄▅` over the last `width` values, scaled between the quietest and the
 * busiest of that window so the shape reads whatever the units. Fewer values
 * than the width returns that many cells rather than padding the line; a value
 * that is missing (null, NaN) is drawn at the low end, never as a peak; a flat
 * series sits at its low end unless it is a flat non-zero, which sits mid.
 * An ascii terminal gets `.:-=#`. `markers` names indexes in the original
 * values: ▏ replaces that day's glyph for a licence window reset (| in ascii).
 */
export function sparkline(values, width = 20, { markers = [] } = {}) {
  const cols = colsOf(width, 20);
  const list = Array.isArray(values) ? values : [];
  if (cols <= 0 || !list.length) return '';
  const window = list.slice(-cols).map(reading);
  const glyphs = asciiGlyphsPreferred() ? SPARK_ASCII : SPARK_UNICODE;
  const numbers = window.filter((value) => value != null);
  if (!numbers.length) return '';
  const low = Math.min(...numbers);
  const span = Math.max(...numbers) - low;
  const middle = Math.floor((glyphs.length - 1) / 2);
  const marked = new Set(Array.isArray(markers) ? markers : []);
  const offset = list.length - window.length;
  return window.map((value, index) => {
    if (marked.has(offset + index)) return asciiGlyphsPreferred() ? '|' : '▏';
    if (value == null) return glyphs[0];
    if (!span) return value > 0 ? glyphs[middle] : glyphs[0];
    const level = Math.round(((value - low) / span) * (glyphs.length - 1));
    return glyphs[Math.max(0, Math.min(glyphs.length - 1, level))];
  }).join('');
}

/**
 * `▇▇▇░░░░` for a fraction of the whole, rounded to the nearest cell and
 * clamped to the bar: a fraction of null or NaN fills nothing rather than
 * painting NaN cells. A fraction too small to round up to one cell still draws
 * a sliver (`▏`, `|` in ascii) rather than an empty track; only a true zero is
 * empty. Plain glyphs, so a caller colours the bar it draws; an ascii terminal
 * gets `#` and `.`. `partialGlyph` additionally shows the fractional tail of a
 * bar that is part-way through a cell.
 */
export function progressBar(fraction, width = 20, { partialGlyph = null } = {}) {
  const cols = colsOf(width, 20);
  if (cols <= 0) return '';
  const value = Number(fraction);
  const filled = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) * cols : 0;
  const partial = typeof partialGlyph === 'string' && [...partialGlyph].length === 1;
  const whole = Math.max(0, Math.min(cols, partial ? Math.floor(filled) : Math.round(filled)));
  const ascii = asciiGlyphsPreferred();
  const [full, empty] = ascii ? ['#', '.'] : ['▇', '░'];
  // Same rule as the share bars: anything spent at all keeps a mark.
  const wantsSliver = filled > whole && whole < cols && (partial || whole === 0);
  const sliver = wantsSliver ? (ascii ? '|' : (partial ? partialGlyph : TINY_GLYPH)) : '';
  return full.repeat(whole) + sliver + empty.repeat(cols - whole - (sliver ? 1 : 0));
}

/**
 * One horizontal stacked bar per row — a left label gutter and the row's
 * segments across the rest, `[{ label, segments: [{ value, color }] }]`:
 *
 *   claude-code ████████
 *   codex       █████
 *
 * The gutter follows the longest label and gives the bar at least two thirds
 * of the width; labels too long for it are cut. Segment cells are handed out
 * by largest remainder so the bar adds up, a row whose segments are empty or
 * zero draws an empty track rather than a full one, and no line passes
 * `width`. A segment's `color` is one of the palette's hex values; without it
 * the segment keeps the terminal's colour. An ascii terminal gets `#`.
 */
export function stackedBars(rows, { width = 120, colors = true } = {}) {
  const cols = colsOf(width, 120);
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (cols <= 0 || !list.length) return [];
  const labels = list.map((row) => String(row.label ?? ''));
  const longest = labels.reduce((most, label) => Math.max(most, visibleLength(label)), 0);
  const gutter = Math.min(longest + 1, Math.floor(cols / 3));
  const barWidth = Math.max(0, cols - gutter);
  const block = asciiGlyphsPreferred() ? '#' : '█';
  return list.map((row, index) => {
    const label = cut(labels[index], Math.max(0, gutter - 1));
    const lead = `${label}${' '.repeat(Math.max(0, gutter - visibleLength(label)))}`;
    const segments = (Array.isArray(row.segments) ? row.segments : [])
      .filter((segment) => segment && Number(segment.value) > 0);
    const counts = allocate(segments.map((segment) => Number(segment.value)), barWidth);
    let bar = '';
    let painted = 0;
    segments.forEach((segment, at) => {
      if (!counts[at]) return;
      const run = block.repeat(counts[at]);
      bar += colors && isHex(segment.color) ? `${fgOf(segment.color)}${run}${RESET}` : run;
      painted += counts[at];
    });
    return `${lead}${bar}${' '.repeat(Math.max(0, barWidth - painted))}`;
  });
}

/**
 * Geometry for stackedBars().  Segment widths are allocated by the exact
 * largest-remainder allocator used by the string painter; no second rounding
 * policy is introduced here.
 */
export function stackedBarsMeta(rows, { width = 120, colors = true } = {}) {
  const cols = colsOf(width, 120);
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const labels = list.map((row) => String(row.label ?? ''));
  const longest = labels.reduce((most, label) => Math.max(most, visibleLength(label)), 0);
  const gutter = Math.min(longest + 1, Math.floor(cols / 3));
  const barWidth = Math.max(0, cols - gutter);
  const geometry = list.map((row, rowIndex) => {
    const segments = (Array.isArray(row.segments) ? row.segments : [])
      .filter((segment) => segment && Number(segment.value) > 0)
      .map((segment, index) => ({ ...segment, value: Number(segment.value), index }));
    const counts = allocate(segments.map((segment) => segment.value), barWidth);
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    let x = gutter + 1;
    const result = segments.map((segment, index) => {
      const own = counts[index] || 0;
      const item = {
        id: segment.id ?? segment.label ?? index,
        x,
        width: own,
        value: segment.value,
        share: reading(segment.share) ?? (total > 0 ? segment.value / total : null),
      };
      x += own;
      return item;
    });
    return { row: rowIndex + 1, segments: result };
  });
  return { lines: stackedBars(rows, { width: cols, colors }), rows: geometry };
}

/**
 * A vertical, value-scaled column chart.  This is intentionally separate from
 * `stackedBars`: Home and the other tables use the horizontal row renderer,
 * while Trends needs one shared axis so a small day and a large day retain
 * their relative magnitude.
 *
 * `series` is `[{ values: number[], color?: hex }]`; each label gets one
 * column, and the series are stacked inside that column.  The returned array
 * is still just lines (like `stackedBars`), with a non-enumerable `meta` field
 * describing the chart rows and columns for a caller that needs hit regions.
 * `width` is optional; when supplied the columns are narrowed (and, only when
 * physically unavoidable, the oldest columns are dropped) to stay inside it.
 *
 * `mark` is what a figure that is not a measurement carries in front of it —
 * `≈` on an API-equivalent estimate — and it goes on every number the chart
 * prints: the axis ticks, the per-column value row and the running totals. A
 * column nobody recorded a figure for is still a blank; there is no reading to
 * qualify, and the caller states the reason beside the chart.
 *
 * The axis top and the row count are chosen together from `height`: the ticks
 * `niceStep` implies are laid one whole row apart (`meta.rowsPerTick`), so
 * every tick label sits on a row and the spacing between labels is even. Bars
 * are measured in eighths of a row and their top cell uses ▁▂▃▄▅▆▇█, so a bar
 * never rises above its own value; stacked slices are laid smallest at the bottom and biggest on top,
 * every non-zero slice keeps at least one eighth (taken from the largest
 * slice), and a partial top cell carries the colour of its own slice. `meta`
 * exposes `axisTop`, `tickStep`, `rowsPerTick`, and per-column `eighths` and
 * `segments`.  Each segment also has a flat `meta.slices` entry with its
 * series name/value and one-based row/column ranges in the returned block.
 */
export function columnBars(series, labels, {
  width = null, height = 6, rowCount: requestedRowCount = null, col = 8, barW = 6, unit = '$', mark = '', totals = true, cumulative = false,
  colors = true, axisRule = null, tickFormatter = null,
} = {}) {
  const sourceLabels = Array.isArray(labels) ? labels.map((label) => String(label ?? '')) : [];
  const sourceSeries = (Array.isArray(series) ? series : []).filter(Boolean).map((entry) => ({
    ...entry,
    values: Array.isArray(entry.values) ? entry.values : [],
  }));
  if (!sourceLabels.length) return [];

  const requested = width == null || !Number.isFinite(Number(width)) ? null : colsOf(width, 0);
  const maxColumns = requested == null ? sourceLabels.length : Math.max(1, requested - 2);
  const offset = Math.max(0, sourceLabels.length - maxColumns);
  const labelsView = sourceLabels.slice(offset);
  const seriesView = sourceSeries.map((entry) => ({
    ...entry,
    values: entry.values.slice(offset),
  }));
  const n = labelsView.length;
  const requestedRows = Math.max(1, cellsOf(requestedRowCount ?? height, 6));
  const baseCol = Math.max(1, Math.trunc(Number(col)) || 8);
  const markText = typeof mark === 'string' ? mark : '';
  const ascii = asciiGlyphsPreferred();
  const axis = ascii ? '|' : '┤';
  const plainAxis = ascii ? '|' : '│';
  const baseAxis = ascii ? '+' : '┼';
  const block = ascii ? '#' : '█';

  const readAt = (entry, index) => reading(entry?.values?.[index]);
  const sums = labelsView.map((_, index) => {
    let total = null;
    for (const entry of seriesView) {
      const value = readAt(entry, index);
      if (value == null) continue;
      total = (total ?? 0) + Math.max(0, value);
    }
    return total;
  });
  const max = sums.reduce((most, value) => value != null ? Math.max(most, value) : most, 0);
  const suppliedAxis = typeof axisRule === 'function' ? axisRule(max, requestedRows) : null;
  const axisInfo = suppliedAxis?.ticks?.length ? suppliedAxis : niceStep(max, requestedRows);
  const axisTop = axisInfo.ticks.at(-1) ?? 0;
  // The tick gutter, the axis column, and the cell the mark needs in front of
  // the tick it qualifies. The prototype's six cells hold a tick up to
  // `$99.99`; the axis this data produces can be wider (`$160.00`, and a
  // marked `≈$160.00`), and a cut tick is a label that measures nothing, so
  // the gutter is sized to the widest tick this axis will actually print. An
  // unusually narrow input still reduces it before narrowing cells.
  const numberText = (value) => (value == null ? null : typeof tickFormatter === 'function'
    ? tickFormatter(value, { unit, mark: markText })
    : numberTextOf(value, unit, markText));
  const tickRoom = axisInfo.ticks.reduce(
    (most, tick) => Math.max(most, visibleLength(numberText(tick) ?? '')),
    6 + visibleLength(markText),
  );
  const axisWidth = requested == null
    ? tickRoom
    : Math.max(1, Math.min(tickRoom, requested - 1 - n));
  const available = requested == null ? null : Math.max(1, requested - axisWidth - 1);
  const cellWidth = available == null
    ? baseCol
    : Math.max(1, Math.min(baseCol, Math.floor(available / n)));
  const barWidth = cellWidth <= 1
    ? 1
    : Math.max(1, Math.min(cellWidth - 1, Math.trunc(Number(barW)) || 1));
  const intervals = Math.max(1, axisInfo.ticks.length - 1);
  // Nice-number rounding can leave fewer intervals than requested (for
  // example a 0–20 axis at a wanted height of six).  Round the rows per tick
  // upward so the caller's minimum density is honoured rather than collapsing
  // the chart back to four rows.
  const rowsPerTick = suppliedAxis?.rowsPerTick == null
    ? Math.max(1, Math.ceil(requestedRows / intervals))
    : Math.max(1, Math.trunc(Number(suppliedAxis.rowsPerTick)) || 1);
  const scaledRows = intervals * rowsPerTick;
  const rowCount = suppliedAxis?.rowCount == null
    ? scaledRows
    : Math.max(scaledRows, Math.trunc(Number(suppliedAxis.rowCount)) || scaledRows);
  const scale = axisTop > 0 ? axisTop : 1;
  const eighths = sums.map((value) => value == null || value <= 0
    ? 0
    : Math.min(rowCount * 8, Math.floor(Number(((value / scale) * rowCount * 8).toPrecision(14)))));
  const heights = eighths.map((value) => Math.ceil(value / 8));
  const stacks = sums.map((_, index) => {
    const entries = seriesView.map((entry, sourceIndex) => ({
      color: entry.color, name: entry.name ?? null, sourceIndex, value: Math.max(0, readAt(entry, index) ?? 0),
    })).filter((entry) => entry.value > 0).sort((a, b) => a.value - b.value || a.sourceIndex - b.sourceIndex);
    const totalEighths = eighths[index];
    if (!entries.length || totalEighths <= 0) return [];
    // A single sub-eighth slice gets the one-cell minimum. Several can keep
    // that minimum while the column has enough eighths; only an impossible
    // allocation is collapsed into one dim `other` slice at the top.
    const tiny = entries.filter((entry) => (entry.value / sums[index]) * totalEighths < 1);
    let drawable = entries;
    // Keep every tiny slice when the column has enough eighths to give each
    // one a minimum. Only an actually impossible allocation (more tiny
    // slices than available eighths) is collapsed into the honest `other`
    // aggregate, drawn at the bottom of the column.
    const nonTiny = entries.length - tiny.length;
    const tinySlots = Math.max(0, totalEighths - nonTiny);
    if (tiny.length > tinySlots) {
      const tinyValue = tiny.reduce((sum, entry) => sum + entry.value, 0);
      const tinyIndexes = new Set(tiny.map((entry) => entry.sourceIndex));
      drawable = [
        {
          color: METER_COLORS.others,
          name: `other (${tiny.length} pools)`,
          otherCount: tiny.length,
          sourceIndex: -1,
          value: tinyValue,
        },
        ...entries.filter((entry) => !tinyIndexes.has(entry.sourceIndex)),
      ];
    }
    const counts = allocate(drawable.map((entry) => entry.value), totalEighths);
    for (let at = 0; at < counts.length; at += 1) {
      if (counts[at] > 0) continue;
      const donor = counts.reduce((best, count, candidate) => count > counts[best] ? candidate : best, 0);
      if (counts[donor] > 1) {
        counts[donor] -= 1;
        counts[at] = 1;
      }
    }
    let cursor = 0;
    return drawable.map((entry, at) => {
      const low = cursor;
      cursor += counts[at];
      return { ...entry, low, high: cursor, eighths: counts[at] };
    });
  });

  // A value under a column keeps one blank cell before the next column. When
  // the full text would fill the cell (`16h34m` in a six-cell phone column ran
  // straight into `3h52m`), a duration falls back to whole hours and anything
  // else is clipped, so neighbouring totals never read as one number.
  // Money keeps the whole cell (a six-cell phone column must still show
  // `≈$0.12`), so only durations, whose neighbours are the same length, give
  // up the last cell.
  const compactValue = (value) => {
    const full = numberText(value) ?? '—';
    if (unit !== 'minutes') return full;
    const limit = Math.max(1, cellWidth - 1);
    if (visibleLength(full) <= limit) return full;
    const number = reading(value);
    if (number != null && number >= 60) {
      const hours = `${markText}${Math.round(number / 60)}h`;
      if (visibleLength(hours) <= limit) return hours;
    }
    return cut(full, limit);
  };
  const cellText = (value, limit, fallback = '') => {
    if (limit <= 0) return '';
    const text = String(value ?? fallback);
    const clipped = cut(text, limit);
    return `${clipped}${' '.repeat(Math.max(0, limit - visibleLength(clipped)))}`;
  };
  const columnCell = (text = '', glyph = null) => {
    if (cellWidth <= 1) return glyph ?? ' ';
    const run = glyph ? `${glyph.repeat(barWidth)}${' '.repeat(Math.max(0, cellWidth - barWidth - 1))}` : '';
    // Value/label cells use the whole cell. Reserving a leading blank made a
    // six-cell phone column truncate a cents value (`≈$0.…`). Bars retain the
    // one-cell gutter that visually separates adjacent columns.
    return run ? ` ${run}` : cellText(text, cellWidth);
  };
  const colored = (text, color) => {
    if (!text || !colors || ascii || !isHex(color)) return text;
    return `${fgOf(color)}${text}${RESET}`;
  };
  // Positive ticks sit at exact whole-row intervals; zero belongs to the
  // baseline, not to the first bar row.
  const ticksByRow = new Map((suppliedAxis ? axisInfo.ticks.slice(1) : axisInfo.ticks)
    .map((tick, index) => suppliedAxis
      ? [(index + 1) * rowsPerTick, tick]
      : [index * rowsPerTick + 1, tick])
    .filter(([row]) => row <= rowCount));
  const segmentCell = (index, row) => {
    const low = (row - 1) * 8;
    const filled = Math.max(0, Math.min(8, eighths[index] - low));
    if (!filled) return columnCell();
    const segments = stacks[index].filter((entry) => entry.high > low && entry.low < low + filled);
    const top = segments.at(-1);
    const glyph = ascii ? (filled === 8 ? block : '.') : SPARK_UNICODE[filled - 1];
    if (segments.length < 2 || !colors || ascii) return columnCell('', colored(glyph, top?.color));
    // A cell is a vertical slice, never a set of horizontal colour lanes.
    // When two slices cross it, the lower one becomes the background and the
    // upper one the foreground; middle slices remain vertical in neighbouring
    // cells but never introduce a third colour into this row.
    const lower = segments[0];
    const run = glyph.repeat(barWidth);
    const painted = isHex(lower?.color) && isHex(top?.color)
      ? `${bgOf(rgbOf(lower.color))}${fgOf(top.color)}${run}${RESET}`
      : colored(run, top?.color);
    return cellWidth <= 1 ? painted : ` ${painted}${' '.repeat(Math.max(0, cellWidth - barWidth - 1))}`;
  };

  // A slice occupies a vertical run of eighths inside one rendered column.
  // Keep its hit geometry in the chart's own one-based line/column space so a
  // view can register the exact cells that carry that slice, rather than
  // guessing from the column label or the colour.  A slice that crosses a
  // row boundary owns both rows; ranges therefore cover every painted row,
  // with an intentional overlap where one terminal cell carries two
  // sub-row colours.
  const sliceGeometry = (columnIndex, entry) => {
    const columnX = axisWidth + 2 + columnIndex * cellWidth;
    const barX = columnX + (cellWidth > 1 ? 1 : 0);
    const barEnd = barX + Math.max(1, barWidth) - 1;
    const rowStart = Math.max(1, rowCount - Math.ceil(entry.high / 8) + 1);
    const rowEnd = Math.min(rowCount, rowCount - Math.floor(entry.low / 8));
    const columnRange = [barX, barEnd];
    const rowRange = [rowStart, rowEnd];
    return {
      ...entry,
      columnIndex,
      column: columnIndex,
      seriesIndex: entry.sourceIndex,
      seriesName: entry.name,
      series: entry.name,
      rowStart,
      rowEnd,
      columnStart: barX,
      columnEnd: barEnd,
      // The array forms are convenient for callers that only need a range;
      // the named aliases make the same metadata self-documenting in a
      // debugger and keep it usable by older view code.
      rowRange,
      columnRange,
      row: rowRange,
      col: columnRange,
      rows: { start: rowStart, end: rowEnd },
      columns: { start: barX, end: barEnd },
      x1: barX,
      x2: barEnd,
      y1: rowStart,
      y2: rowEnd,
    };
  };

  const lines = [];
  for (let row = rowCount; row >= 1; row -= 1) {
    const tick = axisTop ? ticksByRow.get(row) ?? null : (!suppliedAxis && row === 1 ? 0 : null);
    let line = cellText(numberText(tick) ?? '', axisWidth) + (suppliedAxis && tick == null ? plainAxis : axis);
    for (let index = 0; index < n; index += 1) line += segmentCell(index, row);
    lines.push(line);
  }
  let labelsLine = suppliedAxis
    ? cellText(numberText(0) ?? '0', axisWidth) + baseAxis
    : ' '.repeat(axisWidth) + baseAxis;
  labelsView.forEach((label) => { labelsLine += columnCell(cellText(label, cellWidth - 1)); });
  lines.push(labelsLine);
  const valueRow = lines.length;
  if (totals) {
    let valuesLine = ' '.repeat(axisWidth + 1);
    sums.forEach((value) => { valuesLine += columnCell(compactValue(value)); });
    lines.push(valuesLine);
  }
  let cumulativeRow = null;
  if (cumulative) {
    // One-based, like `axisRow` and `valueRow`: the row this line is painted on.
    cumulativeRow = lines.length + 1;
    let running = null;
    let cumulativeLine = cellText('total', axisWidth) + ' ';
    sums.forEach((value) => {
      if (value != null) running = (running ?? 0) + value;
      // A missing bucket has no cumulative observation of its own; leave that
      // cell blank instead of repeating the previous total as if the day were
      // measured. A measured zero still shows the running number.
      cumulativeLine += columnCell(value == null || running == null ? '' : numberText(running));
    });
    lines.push(cumulativeLine);
  }
  const columns = labelsView.map((label, index) => {
    const column = {
      label, x: axisWidth + 2 + index * cellWidth, width: cellWidth,
      barWidth, height: heights[index], eighths: eighths[index], sourceIndex: offset + index,
    };
    column.segments = stacks[index].map((entry) => sliceGeometry(index, entry));
    column.slices = column.segments;
    return column;
  });
  const slices = columns.flatMap((column) => column.segments);
  Object.defineProperty(lines, 'meta', {
    enumerable: false,
    value: {
      axisWidth, cellWidth, barWidth, chartRows: rowCount, axisRow: rowCount + 1,
      axisTop, tickStep: axisInfo.step, rowsPerTick,
      valueRow: totals ? valueRow + 1 : null, cumulativeRow,
      columns,
      // `slices` is the flat form a view can register directly.  The same
      // objects remain under their owning column for callers that already
      // consume `meta.columns`.
      slices,
      sliceGeometry: slices,
      legend: [...new Set(stacks.flatMap((column) => column
        .filter((entry) => entry.sourceIndex >= 0 || entry.name?.startsWith('other ('))
        .map((entry) => entry.name)
        .filter(Boolean)))],
      sums,
    },
  });
  return lines;
}

const HEAT_SHADES = Object.freeze(['░', '▒', '▓', '█']);
const HEAT_ASCII = Object.freeze(['.', ':', '=', '#']);

/**
 * The four heat backgrounds: the palette's own ramp, darkest first, which is
 * the prototype's `.t1`-`.t4`. Built at call time, not at import: usage-view.js
 * imports this module in the views, so a top-level read of METER_COLORS would
 * be a temporal-dead-zone trap.
 */
function heatRamp() {
  return METER_COLORS.heat.map((hex) => bgOf(rgbOf(hex)));
}

/**
 * One row of heatmap cells for values 0..1, separated by a single space so a
 * cell and its gap are two columns: `▓ █ ▒`. With `ansi` each cell is a
 * background-coloured cell — the ramp is the palette's four heat shades,
 * darkest first — and without it the cells are the density glyphs
 * `░▒▓█`, `.:=#` on an ascii terminal. A cell that is null or not a number is
 * the empty marker `·`: no value was recorded, which is not the same as a
 * measured zero. Cells past `width` are dropped from the left, so a narrow
 * terminal keeps the newest.
 */
export function heatRow(cells, { width = null, ansi = true } = {}) {
  const list = Array.isArray(cells) ? cells : [];
  const cols = width == null || !Number.isFinite(Number(width)) ? null : colsOf(width, 0);
  const room = cols == null ? list.length : Math.max(0, Math.floor((cols + 1) / 2));
  const window = room >= list.length ? list : (room === 0 ? [] : list.slice(-room));
  if (!window.length) return '';
  const shades = asciiGlyphsPreferred() ? HEAT_ASCII : HEAT_SHADES;
  const ramp = ansi ? heatRamp() : null;
  return window.map((value) => {
    const number = reading(value);
    if (number == null) return ansi ? `${DIM}·${RESET}` : '·';
    const level = Math.max(1, Math.ceil(Math.max(0, Math.min(1, number)) * shades.length));
    // Keep the density glyph visible in captures even when it is coloured.
    return ramp ? `${ramp[level - 1]}${shades[level - 1]}${RESET}` : shades[level - 1];
  }).join(' ');
}

/**
 * The axis step and the tick values it implies for a maximum and a wanted
 * number of intervals: `niceStep(12.85)` is `{ step: 5, ticks: [0, 5, 10, 15] }`.
 * The step is 1, 2, 5 or 10 times a power of ten, so a label is always a
 * readable number. Nothing measurable to scale — zero, negative, null, NaN —
 * is `{ step: 0, ticks: [0] }`; a chart with no data says so, it does not
 * invent an axis.
 */
export function niceStep(max, ticks = 4) {
  const value = Number(max);
  const count = Number.isFinite(Number(ticks)) && Number(ticks) >= 1 ? Math.trunc(Number(ticks)) : 4;
  if (!Number.isFinite(value) || value <= 0) return { step: 0, ticks: [0] };
  const rough = value / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / magnitude;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  const step = Number((factor * magnitude).toPrecision(12));
  const top = Math.ceil(value / step) * step;
  const values = [];
  for (let tick = 0; tick <= top + step / 2 && values.length <= count + 2; tick += step) {
    values.push(Number(tick.toPrecision(12)));
  }
  return { step, ticks: values };
}

/**
 * One number as a column chart prints it: the compact form for counts, the
 * money and duration forms for those units, always carrying the caller's mark
 * in front. `columnBars` measures its tick gutter and paints its ticks through
 * this one rule, so a label can never be sized differently from the way it is
 * drawn.
 */
function numberTextOf(value, unit, mark = '') {
  const number = reading(value);
  if (number == null) return null;
  const markText = typeof mark === 'string' ? mark : '';
  const absolute = Math.abs(number);
  let text;
  if (absolute >= 1000) text = `${(number / 1000).toFixed(absolute >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  else if (absolute >= 100) text = String(Math.round(number));
  else if (absolute >= 10) text = number.toFixed(0);
  else if (Number.isInteger(number)) text = String(number);
  else {
    text = number.toFixed(1);
    // A recorded fraction of a cent is still a recording; rounding it to
    // `0.0` would read as free, which is a different claim from "very small".
    if (number !== 0 && Number(text) === 0) text = number.toPrecision(1);
  }
  if (unit === '$') return `${markText}${formatDashboardValue(number, 'money')}`;
  if (unit === 'minutes') return `${markText}${formatDashboardValue(number, 'minutes')}`;
  return `${markText}${unit ?? ''}${text}`;
}

const DATE_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const DATE_WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

function dateParts(key) {
  const match = String(key ?? '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * Calendar labels shared by dated charts.  A compact phone label is always a
 * month+day token (never a weekday initial); roomier cells add the day/month
 * separator and, once a cell has ten columns, a three-letter weekday word.
 */
export function dateLabels(keys, { width = null, cellWidth = null, newest = false, bucketSpan = 1 } = {}) {
  const list = Array.isArray(keys) ? keys : [];
  return list.map((key) => dateLabel(key, { width, cellWidth, newest, bucketSpan }));
}

/** Format one ISO calendar bucket without allowing locale/timezone drift. */
function dateLabel(key, { width = null, cellWidth = null, newest = false, bucketSpan = 1 } = {}) {
  const start = dateParts(key);
  if (!start) return String(key ?? '');
  const span = Math.max(1, Math.trunc(Number(bucketSpan)) || 1);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + span - 1);
  const own = cellWidth == null || cellWidth === ''
    ? null
    : Number.isFinite(Number(cellWidth)) ? Math.max(1, Math.trunc(Number(cellWidth))) : null;
  const frame = Number.isFinite(Number(width)) ? Math.trunc(Number(width)) : null;
  // `newest` is intentionally not rendered as "today": the concrete date is
  // required on the axis; callers may use it only in hover prose.
  void newest;
  // The phone frame deliberately chooses the compact token even when an
  // unusually sparse chart happens to give one bucket six cells.  Medium and
  // wide frames can use the cell hint to opt into the richer forms.
  const roomy = frame != null && frame <= 55
    ? 5
    : own != null ? own : frame != null && frame >= 180 ? 10 : frame != null && frame >= 90 ? 6 : 5;
  const month = DATE_MONTHS[start.getUTCMonth()];
  const day = String(start.getUTCDate());
  const sameMonth = end.getUTCMonth() === start.getUTCMonth() && end.getUTCFullYear() === start.getUTCFullYear();
  if (span > 1) {
    const endDay = String(end.getUTCDate());
    if (roomy >= 10) return sameMonth
      ? `${DATE_WEEKDAYS[start.getUTCDay()]} ${day}–${endDay} ${month}`
      : `${DATE_WEEKDAYS[start.getUTCDay()]} ${day} ${month}–${endDay} ${DATE_MONTHS[end.getUTCMonth()]}`;
    if (roomy >= 6) return sameMonth ? `${day}–${endDay} ${month}` : `${day} ${month}–${endDay} ${DATE_MONTHS[end.getUTCMonth()]}`;
    return sameMonth ? `${month}${day}–${endDay}` : `${month}${day}–${endDay}${DATE_MONTHS[end.getUTCMonth()]}`;
  }
  if (roomy >= 10) return `${DATE_WEEKDAYS[start.getUTCDay()]} ${day} ${month}`;
  if (roomy >= 6) return `${day} ${month}`;
  return `${month}${day}`;
}
