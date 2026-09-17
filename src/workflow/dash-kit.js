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

import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import { METER_COLORS } from './usage-view.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const INVERT = '\x1b[7m';
const UNDERLINE = '\x1b[4m';
const NO_UNDERLINE = '\x1b[24m';
const SGR = /\x1b\[[0-9;]*m/g;
const HEX = /^#[0-9a-f]{6}$/i;

/** The columns a styled line really occupies. */
const visibleLength = (text) => String(text ?? '').replace(SGR, '').length;

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
  if (kind === 'money') return `$${number.toFixed(2)}`;
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
  const pad = (text, own) => {
    const clipped = cut(text, own);
    return `${clipped}${' '.repeat(Math.max(0, own - visibleLength(clipped)))}`;
  };
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
  const partials = new Set();
  if (typeof partialGlyph === 'string' && [...partialGlyph].length === 1) {
    list.forEach((part, index) => {
      if (!(part.value > 0) || counts[index]) return;
      const donor = counts.reduce((best, count, at) => count > counts[best] ? at : best, 0);
      if (counts[donor] > 1) {
        counts[donor] -= 1;
        counts[index] = 1;
        partials.add(index);
      }
    });
  }
  if (!counts.some((count) => count > 0)) return ' '.repeat(cols);
  let out = '';
  let painted = 0;
  list.forEach((part, index) => {
    const count = counts[index];
    if (!count) return;
    const run = partials.has(index) ? (ascii ? '|' : partialGlyph) : part.glyph.repeat(count);
    if (colors && part.color) out += `${fgOf(part.color)}${run}${RESET}`;
    else if (colors && part.index > 0) out += `${DIM}${run}${RESET}`;
    else out += run;
    painted += count;
  });
  return `${out}${' '.repeat(Math.max(0, cols - painted))}`;
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
 * painting NaN cells. Plain glyphs, so a caller colours the bar it draws; an
 * ascii terminal gets `#` and `.`.
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
  const sliver = partial && filled > whole && whole < cols ? (ascii ? '|' : partialGlyph) : '';
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
 * never rises above its own value; stacked slices are laid smallest-on-top,
 * every non-zero slice keeps at least one eighth (taken from the largest
 * slice), and a partial top cell carries the colour of its own slice. `meta`
 * exposes `axisTop`, `tickStep`, `rowsPerTick`, and per-column `eighths` and
 * `segments` (`{ sourceIndex, eighths, low, high }`) for hit regions.
 */
export function columnBars(series, labels, {
  width = null, height = 6, col = 8, barW = 6, unit = '$', mark = '', totals = true, cumulative = false,
  colors = true,
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
  const requestedRows = Math.max(1, cellsOf(height, 6));
  const baseCol = Math.max(1, Math.trunc(Number(col)) || 8);
  const markText = typeof mark === 'string' ? mark : '';
  // The tick gutter, the axis column, and the cell the mark needs in front of
  // the tick it qualifies. The prototype reserves six cells for a tick label
  // and one for the axis; on an unusually narrow input, reduce that gutter
  // before narrowing cells.
  const tickRoom = 6 + visibleLength(markText);
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
  const ascii = asciiGlyphsPreferred();
  const axis = ascii ? '|' : '┤';
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
  const axisInfo = niceStep(max, requestedRows);
  const axisTop = axisInfo.ticks.at(-1) ?? 0;
  const intervals = Math.max(1, axisInfo.ticks.length - 1);
  const rowsPerTick = Math.max(1, Math.floor(requestedRows / intervals));
  const rowCount = intervals * rowsPerTick;
  const scale = axisTop > 0 ? axisTop : 1;
  const eighths = sums.map((value) => value == null || value <= 0
    ? 0
    : Math.min(rowCount * 8, Math.floor(Number(((value / scale) * rowCount * 8).toPrecision(14)))));
  const heights = eighths.map((value) => Math.ceil(value / 8));
  const stacks = sums.map((_, index) => {
    const entries = seriesView.map((entry, sourceIndex) => ({
      color: entry.color, sourceIndex, value: Math.max(0, readAt(entry, index) ?? 0),
    })).filter((entry) => entry.value > 0).sort((a, b) => b.value - a.value || a.sourceIndex - b.sourceIndex);
    const counts = allocate(entries.map((entry) => entry.value), eighths[index]);
    for (let at = 0; at < counts.length; at += 1) {
      if (counts[at] > 0) continue;
      const donor = counts.reduce((best, count, candidate) => count > counts[best] ? candidate : best, 0);
      if (counts[donor] > 1) {
        counts[donor] -= 1;
        counts[at] = 1;
      }
    }
    let cursor = 0;
    return entries.map((entry, at) => {
      const low = cursor;
      cursor += counts[at];
      return { ...entry, low, high: cursor, eighths: counts[at] };
    });
  });

  const numberText = (value) => {
    const number = reading(value);
    if (number == null) return null;
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
    return `${markText}${unit ?? ''}${text}`;
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
  const ticksByRow = new Map(axisInfo.ticks.map((tick, index) => [index * rowsPerTick, tick]));
  const segmentCell = (index, row) => {
    const low = (row - 1) * 8;
    const filled = Math.max(0, Math.min(8, eighths[index] - low));
    if (!filled) return columnCell();
    const segments = stacks[index].filter((entry) => entry.high > low && entry.low < low + filled);
    const top = segments.at(-1);
    const glyph = ascii ? (filled === 8 ? block : '.') : SPARK_UNICODE[filled - 1];
    if (segments.length < 2 || !colors || ascii) return columnCell('', colored(glyph, top?.color));
    if (filled === 8 && segments.length === 2 && segments.every((entry) => isHex(entry.color))) {
      const lower = segments[0];
      const bottomGlyph = SPARK_UNICODE[lower.high - low - 1];
      return columnCell('', `${bgOf(rgbOf(top.color))}${fgOf(lower.color)}${bottomGlyph}${RESET}`);
    }
    const lanes = allocate(segments.map((entry) => Math.min(entry.high, low + filled) - Math.max(entry.low, low)), barWidth);
    for (let at = lanes.length - 1; at >= 0; at -= 1) {
      if (lanes[at]) continue;
      const donor = lanes.findIndex((count) => count > 1);
      if (donor >= 0) { lanes[donor] -= 1; lanes[at] = 1; }
    }
    const run = segments.map((entry, at) => colored(glyph.repeat(lanes[at]), entry.color)).join('');
    return cellWidth <= 1 ? run : ` ${run}${' '.repeat(cellWidth - barWidth - 1)}`;
  };

  const lines = [];
  for (let row = rowCount; row >= 1; row -= 1) {
    const tick = axisTop ? ticksByRow.get(row) ?? null : (row === 1 ? 0 : null);
    let line = cellText(numberText(tick) ?? '', axisWidth) + axis;
    for (let index = 0; index < n; index += 1) line += segmentCell(index, row);
    lines.push(line);
  }
  let labelsLine = cellText(numberText(0) ?? '0', axisWidth) + baseAxis;
  labelsView.forEach((label) => { labelsLine += columnCell(cellText(label, cellWidth - 1)); });
  lines.push(labelsLine);
  const valueRow = lines.length;
  if (totals) {
    let valuesLine = ' '.repeat(axisWidth + 1);
    sums.forEach((value) => { valuesLine += columnCell(numberText(value) ?? '—'); });
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
  Object.defineProperty(lines, 'meta', {
    enumerable: false,
    value: {
      axisWidth, cellWidth, barWidth, chartRows: rowCount, axisRow: rowCount + 1,
      axisTop, tickStep: axisInfo.step, rowsPerTick,
      valueRow: totals ? valueRow + 1 : null, cumulativeRow,
      columns: labelsView.map((label, index) => ({
        label, x: axisWidth + 2 + index * cellWidth, width: cellWidth,
        barWidth, height: heights[index], eighths: eighths[index], sourceIndex: offset + index,
        segments: stacks[index],
      })),
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
