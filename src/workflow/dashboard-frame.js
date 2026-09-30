// The frame and window builder: lines that remember where each clickable part
// was painted, a view module's regions shifted into place, and the window a
// body is drawn through.
import { columns } from './dash-kit.js';
import { visibleLength } from './dashboard-ansi.js';
import { clamp } from './dashboard-clamp.js';

/**
 * A `columns()` band painted into the body at `indent`, each column clickable
 * over its own rows. `cells` carry an optional `action`; a cell columns()
 * dropped for want of room simply has no region.
 */
function pushColumns(body, cells, { width, gap = 2, indent = 1 } = {}) {
  const lines = columns(cells, { width, gap });
  const base = body.lines.length;
  for (const line of lines) body.push(`${' '.repeat(indent)}${line}`);
  for (const [index, column] of (lines.meta?.columns ?? []).entries()) {
    const action = cells[index]?.action;
    if (!action) continue;
    // A cell may name the rows it reacts to — a tile is one click on its
    // number, not three on a number, a label and a caption.
    const only = cells[index]?.actionRows ?? null;
    for (let row = 0; row < column.rows; row += 1) {
      if (only && !only.includes(row)) continue;
      const painted = visibleLength(body.lines[base + row] ?? '');
      const x1 = column.x + indent;
      const x2 = Math.min(painted, x1 + Math.max(1, column.width) - 1);
      if (x2 >= x1) body.regions.push({ x1, x2, y: base + row + 1, action });
    }
  }
  return lines;
}

/** A line builder that remembers where each clickable part was painted. */
function frameBuilder() {
  const builder = {
    lines: [],
    regions: [],
    push(text = '') { builder.lines.push(text); return builder; },
    /** A row that reacts to a click anywhere on it. */
    row(text = '', action = null) {
      builder.lines.push(text);
      if (action) {
        builder.regions.push({ x1: 1, x2: Math.max(1, visibleLength(text)), y: builder.lines.length, action });
      }
      return builder;
    },
    /** One line from parts: `{ text, action }` makes that text clickable. */
    parts(parts) {
      let column = 1;
      let text = '';
      for (const part of parts) {
        const span = visibleLength(part.text);
        if (part.action) {
          builder.regions.push({ x1: column, x2: Math.max(column, column + span - 1), y: builder.lines.length + 1, action: part.action });
        }
        column += span;
        text += part.text;
      }
      builder.lines.push(text);
      return builder;
    },
    /** A dash-kit `{ text, regions }` row, its regions shifted by `indent`. */
    kit({ text = '', regions = [] } = {}, indent = 0) {
      builder.lines.push(`${' '.repeat(indent)}${text}`);
      for (const region of regions) {
        builder.regions.push({
          x1: region.x + indent,
          x2: region.x + indent + Math.max(1, region.width) - 1,
          y: builder.lines.length,
          action: region.action,
        });
      }
      return builder;
    },
  };
  return builder;
}

/**
 * A view module's lines and its regions, appended to a builder.
 *
 * budget-view, fleet-view, stats-view and history-view each return regions as
 * `{ x, y, width, action }`, where `y` is the 1-based row of the view's own
 * lines the region was painted on.  The shell only has to shift that row by
 * where the view landed in the body, so a click always reaches the row it was
 * drawn on instead of the shell searching the text for it.  A region without
 * a usable row is dropped rather than made to fire the wrong action.
 */
function pushView(builder, view) {
  const lines = Array.isArray(view) ? view : (view?.lines ?? []);
  const regions = Array.isArray(view) ? [] : (view?.regions ?? []);
  const base = builder.lines.length;
  for (const line of lines) builder.lines.push(line);
  for (const region of regions) {
    if (!region?.action || !(region.width > 0)) continue;
    const row = Number(region.y);
    if (!Number.isInteger(row) || row < 1 || row > lines.length) continue;
    builder.regions.push({
      x1: region.x, x2: region.x + region.width - 1, y: base + row, action: region.action,
    });
  }
  return builder;
}

/** The window a body is drawn through, and its `first–last/total` label. */
function windowOf(body, { height, scroll = 0 } = {}) {
  const total = body.lines.length;
  const capacity = Math.max(1, Number(height) || 1);
  const offset = clamp(scroll, 0, Math.max(0, total - capacity));
  const end = Math.min(total, offset + capacity);
  const scrolled = offset > 0 || total > end;
  return { offset, end, total, position: scrolled ? ` · ${offset + 1}–${end}/${total}` : '' };
}

/** Copies a windowed body into the frame, moving its hit regions down with it. */
function drawWindow(frame, body, window) {
  const base = frame.lines.length;
  for (let index = window.offset; index < window.end; index += 1) frame.lines.push(body.lines[index]);
  for (const region of body.regions) {
    if (region.y > window.offset && region.y <= window.end) {
      frame.regions.push({ ...region, y: base + (region.y - window.offset) });
    }
  }
  return frame;
}

export {
  pushColumns,
  frameBuilder,
  pushView,
  windowOf,
  drawWindow,
};
