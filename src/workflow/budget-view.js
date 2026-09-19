import { cut } from './dash-kit.js';
import { METER_COLORS } from './usage-view.js';

const SGR = /\x1b\[[0-9;]*m/g;
const COMMAND = 'bullswarm strategy set-subscription <pool> --monthly-usd <amount>';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const PACE_THRESHOLD_PP = 15;

function columns(width) {
  return Number.isFinite(Number(width)) ? Math.max(1, Math.trunc(Number(width))) : 120;
}

function visible(text) {
  return String(text ?? '').replace(SGR, '');
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

const WHITE = '\x1b[38;2;255;255;255m';

function bg(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function paint(text, hex, ansi) {
  if (!ansi) return visible(text);
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}${RESET}`;
}

function rowsOf(budget) {
  if (Array.isArray(budget)) return budget;
  if (Array.isArray(budget?.rows)) return budget.rows;
  if (budget?.rows && typeof budget.rows === 'object') return Object.values(budget.rows);
  return Array.isArray(budget?.pools) ? budget.pools : [];
}

function durationText(minutes) {
  const value = Math.round(Number(minutes));
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return 'now';
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  if (hours < 24) return mins ? `${hours}h${String(mins).padStart(2, '0')}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days}d${remainder}h` : `${days}d`;
}

function resetDuration(window) {
  const minutes = finite(window?.resetsInMinutes);
  if (minutes != null) return durationText(minutes);
  if (window?.resetsAt && Number.isFinite(Date.parse(window.resetsAt))) {
    return durationText((Date.parse(window.resetsAt) - Date.now()) / 60_000);
  }
  return null;
}

function computedPace(window) {
  const used = finite(window?.usedPct);
  const elapsed = finite(window?.elapsedPct);
  if (used == null || elapsed == null) return null;
  const points = Math.round(elapsed - used);
  const signed = `${points >= 0 ? '+' : '−'}${Math.abs(points)}pp`;
  if (points >= PACE_THRESHOLD_PP) return `slow ${signed}`;
  if (points <= -PACE_THRESHOLD_PP) return `fast ${signed}`;
  return `on track ${signed}`;
}

function windowPace(window) {
  const supplied = typeof window?.paceText === 'string' ? window.paceText.trim() : '';
  if (/^(?:on track [+-−]\d+pp|slow \+\d+pp|fast −\d+pp)$/.test(supplied)) return supplied;
  return computedPace(window) ?? null;
}

function paceColor(pace) {
  if (pace?.startsWith('slow ')) return METER_COLORS.amber;
  if (pace?.startsWith('fast ')) return METER_COLORS.red;
  if (pace?.startsWith('on track ')) return METER_COLORS.green;
  return METER_COLORS.dim;
}

function windowBar(window, width, ansi) {
  const cells = Math.max(0, Math.trunc(width));
  if (!cells) return '';
  const used = finite(window?.usedPct);
  const elapsed = finite(window?.elapsedPct);
  // A pool that has spent anything at all shows at least one cell: rounding a
  // live 1% or 2% down to an empty track reads as "untouched", which is wrong.
  const exact = used == null ? 0 : (used / 100) * cells;
  const filled = used == null || used <= 0
    ? 0
    : Math.max(1, Math.min(cells, Math.floor(exact)));
  let mark = -1;
  let markGlyph = '\u258f';
  if (elapsed != null) {
    mark = Math.floor((elapsed / 100) * cells);
    if (mark >= cells) { mark = cells - 1; markGlyph = '\u2595'; }
  }
  if (!ansi) {
    let plainOut = '';
    for (let index = 0; index < cells; index += 1) {
      plainOut += index === mark ? '|' : index < filled ? '#' : '.';
    }
    return plainOut;
  }
  // Background-coloured cells, not glyph bars: the fill has to read as one
  // solid block at any font (the owner's 0.33.0 review), and the colour says
  // pace — green on track, amber slow, red burning ahead of the clock.
  const fill = paceColor(windowPace(window));
  let out = '';
  for (let index = 0; index < cells; index += 1) {
    const cellBg = index < filled ? fill : METER_COLORS.track;
    out += index === mark
      ? `${bg(cellBg)}${WHITE}${markGlyph}${RESET}`
      : `${bg(cellBg)} ${RESET}`;
  }
  return out;
}

function creditText(row) {
  const credits = row?.credits;
  const used = finite(credits?.used);
  const limit = finite(credits?.limit);
  if (used == null || limit == null) return null;
  return `${Math.round(used)} of ${Math.round(limit)} ${credits.unit || 'credits'}`;
}

function isMonthly(window) {
  return window?.key === 'mo' || window?.key === 'monthly' || window?.label === 'monthly';
}

function windowLabel(window) {
  return String(window?.key ?? window?.label ?? 'window');
}

function resetLine(window, ansi) {
  const reset = resetDuration(window);
  const base = paint(reset ? `  resets ${reset}` : '  reset time unavailable', METER_COLORS.dim, ansi);
  const pace = windowPace(window);
  return pace ? `${base}${paint(` · ${pace}`, paceColor(pace), ansi)}` : base;
}

function planLine(row, ansi) {
  const subscription = row?.subscription ?? null;
  const price = finite(subscription?.monthlyPriceUsd);
  if (price != null) {
    const origin = subscription?.origin === 'detected'
      ? `detected ${subscription.detectedPlan ?? row.detectedPlan ?? row.planType ?? 'plan'}`
      : 'declared';
    const amount = Number.isInteger(price) ? price : price.toFixed(2);
    return paint(`plan · $${amount}/mo ${origin}`, METER_COLORS.dim, ansi);
  }
  if (row?.detectedPlan) return paint(`plan ${row.detectedPlan} · price unknown`, METER_COLORS.dim, ansi);
  return null;
}

function windowsOf(row) {
  return (Array.isArray(row?.windows) ? row.windows : [])
    .filter((window) => finite(window?.usedPct) != null);
}

function percentText(window) {
  const percent = finite(window?.usedPct);
  return percent == null ? '\u2014' : `${percent.toFixed(1)}%`;
}

/**
 * One measuring pass over every pool, so the label column and the percent
 * column line up down the whole page rather than per pool.
 */
function windowMetrics(rows, width) {
  let labelWidth = 3;
  let rightWidth = 6;
  for (const row of rows) {
    for (const window of windowsOf(row)) {
      labelWidth = Math.max(labelWidth, visible(windowLabel(window)).length);
      rightWidth = Math.max(rightWidth, visible(percentText(window)).length);
    }
  }
  return { labelWidth, rightWidth, barWidth: Math.max(1, width - labelWidth - 4 - rightWidth) };
}

function windowLines(row, metrics, ansi) {
  const windows = windowsOf(row);
  if (!windows.length) return [];
  const { labelWidth, rightWidth, barWidth } = metrics;
  const credits = creditText(row);
  // Credits belong to the window they meter, which is the monthly one where a
  // pool has it. A pool that reports credits and no monthly window must not
  // lose them, so they ride on the last window it does report.
  const creditIndex = credits
    ? (windows.findIndex(isMonthly) >= 0 ? windows.findIndex(isMonthly) : windows.length - 1)
    : -1;
  const lines = [];
  for (const [index, window] of windows.entries()) {
    const right = percentText(window).padStart(rightWidth);
    lines.push(`${windowLabel(window).padEnd(labelWidth)}  ${windowBar(window, barWidth, ansi)}  ${right}`);
    const extra = index === creditIndex ? ` \u00b7 ${credits}` : '';
    lines.push(`${resetLine(window, ansi)}${extra ? paint(extra, METER_COLORS.dim, ansi) : ''}`);
  }
  return lines;
}

export function budgetLines(budget, { width = 120, ansi = true } = {}) {
  const cols = columns(width);
  const rows = rowsOf(budget);
  const regions = [];
  if (!rows.length) return { lines: [cut('Budget · no pool budget data is available', cols)], regions };

  const lines = [];
  const metrics = windowMetrics(rows, cols);
  for (const [index, row] of rows.entries()) {
    const name = String(row?.name ?? 'pool');
    lines.push(cut(ansi ? `${BOLD}${name}${RESET}` : name, cols));
    lines.push(...windowLines(row, metrics, ansi).map((line) => cut(line, cols)));
    const plan = planLine(row, ansi);
    if (plan) lines.push(cut(plan, cols));
    if (index < rows.length - 1) lines.push('');
  }
  if (budget?.disabledPools?.length) {
    lines.push(cut(paint(`disabled: ${budget.disabledPools.join(', ')}`, METER_COLORS.dim, ansi), cols));
  }
  return { lines, regions };
}

function wrap(text, width) {
  let rest = visible(text);
  const lines = [];
  const cols = Math.max(1, width);
  while (rest.length > cols) {
    const space = rest.lastIndexOf(' ', cols);
    const at = space > 0 ? space : cols;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

export function budgetNotes(budget, { width = 120 } = {}) {
  const cols = columns(width);
  const rows = rowsOf(budget);
  const unpriced = rows
    .filter((row) => finite(row?.subscription?.monthlyPriceUsd) == null)
    .map((row) => row?.name)
    .filter(Boolean);
  const notes = [];
  if (unpriced.length) notes.push(`Declare a price: ${COMMAND} · no price for ${unpriced.join(', ')}`);
  notes.push('spend by run is on Home and Stats');
  return notes.flatMap((note) => wrap(note, cols));
}
