// The Usage page of the terminal dashboard, ported from the Claude Mod
// (mods/bullswarm/hooks/pool-rows.tsx, pools.ts, pane.tsx): the meter bars,
// the per-pool windows and rung table, the loader behind them and the SGR
// mouse parser the dashboard clicks with. Every renderer is pure — strings
// in, strings out — so the pages can be tested without a terminal; only
// loadUsage reads disk.

import { buildPools, buildPoolsLive } from '../lib/config.js';
import { listAssignments } from '../lib/assignments.js';
import { rungsFor } from '../lib/strategy.js';
import { finiteOrNull } from '../lib/num.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { attachForecast } from '../lib/forecast.js';
import { loadState } from '../lib/state.js';
import { asciiGlyphsPreferred } from '../lib/glyphs.js';

/**
 * The one palette the product draws from. The first four are the truecolour
 * meter set the Claude Mod's status line renders with — green below 50% used,
 * amber from 50%, red from 80%, over this track. The rest are the roles the
 * approved prototype paints, every value lifted from its own CSS
 * (docs/design/dashboard-prototype.html, the `:root` block at line 7 and the
 * `.t1`-`.t4` heat classes at line 41), named by the role the prototype gives
 * them and not by where they happen to be used:
 *
 *   purple  --purple    `.p`: a run's licence share, its cost, budget figures
 *   orange  --coral     `.o`: sparklines, key figures, the by-project bars
 *   cyan    --cyan      `.c`: run markers, model names, live sparklines
 *   dim     --term-dim  `.d`: secondary text, reasons, an empty track
 *   others  --others    the "everything else" band of a share bar
 *   mark    .mark       the white mark at the elapsed point of a meter
 *   heat    .t1-.t4     the four shades of the heatmap ramp, darkest first
 *
 * Named, not ANSI-coloured, because a terminal theme remaps the basic colours.
 * mods/bullswarm/hooks/pool-rows.tsx holds its own copy of green, amber, red
 * and the track for the Claude Mod pane; those two copies are kept in step by
 * hand, so a change to any of those four belongs in both files.
 */
export const METER_COLORS = Object.freeze({
  green: '#b6bd73',
  amber: '#e9c880',
  red: '#bf6c69',
  track: '#3a3a3a',
  purple: '#a99cf0',
  orange: '#d2856b',
  cyan: '#8fc7cf',
  dim: '#7c7f8a',
  others: '#55575f',
  mark: '#ffffff',
  heat: Object.freeze(['#4a3f38', '#7a5a48', '#b07a5b', '#d2856b']),
});

const RESET = '\x1b[0m';

const rgbOf = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const bg = (hex) => `\x1b[48;2;${rgbOf(hex).join(';')}m`;
const fg = (hex) => `\x1b[38;2;${rgbOf(hex).join(';')}m`;

/** The fill colour of a meter by how much is used; no reading is the track. */
export function severityColor(usedPct) {
  if (usedPct == null) return METER_COLORS.track;
  if (usedPct >= 80) return METER_COLORS.red;
  if (usedPct >= 50) return METER_COLORS.amber;
  return METER_COLORS.green;
}

/**
 * A bar of exactly `width` cells: a `▇` texture filled up to used% in the
 * severity colour, `░` over the track beyond it, and a white `▏` at the cell
 * elapsed% falls in (a `▕` in the last cell once the window has fully
 * elapsed). The glyphs carry the reading, so the bar is legible in a terminal
 * that drops colour and in a plain-text capture of one; the cells keep the
 * background they always had, so a colour terminal reads the same solid band
 * as before. An ascii terminal gets `#`, `.` and `|` in place of the three
 * glyphs. Without ansi the cells are `#`, `.` and `|` with no escapes at all,
 * so a fixture can be asserted as text. A pool with no meter draws a dotted
 * track and no mark.
 */
export function meterBar(usedPct, elapsedPct, width, { ansi = true } = {}) {
  const cells = Math.max(0, Math.trunc(width));
  if (usedPct == null) {
    const dots = '·'.repeat(cells);
    return ansi ? `${bg(METER_COLORS.track)}${dots}${RESET}` : dots;
  }
  const fill = severityColor(usedPct);
  const filled = Math.max(0, Math.min(cells, Math.floor((usedPct / 100) * cells)));
  let mark = -1;
  let glyph = '▏';
  if (elapsedPct != null) {
    mark = Math.floor((elapsedPct / 100) * cells);
    if (mark >= cells) {
      mark = cells - 1;
      glyph = '▕';
    }
  }
  if (!ansi) {
    let out = '';
    for (let i = 0; i < cells; i += 1) out += i === mark ? '|' : i < filled ? '#' : '.';
    return out;
  }
  const ascii = asciiGlyphsPreferred();
  const fillGlyph = ascii ? '#' : '▇';
  const trackGlyph = ascii ? '.' : '░';
  const markGlyph = ascii ? '|' : glyph;
  let out = '';
  let i = 0;
  while (i < cells) {
    const cellBg = i < filled ? fill : METER_COLORS.track;
    if (i === mark) {
      out += `${bg(cellBg)}${fg(METER_COLORS.mark)}${markGlyph}`;
      i += 1;
      continue;
    }
    const runFill = i < filled;
    let j = i;
    while (j < cells && j !== mark && (j < filled) === runFill) j += 1;
    const color = runFill ? fill : METER_COLORS.track;
    // The glyph is painted in the cell's own colour: a colour terminal sees
    // the solid band it always saw, and a reader without colour sees the
    // texture rather than a row of blanks.
    out += `${bg(color)}${fg(color)}${(runFill ? fillGlyph : trackGlyph).repeat(j - i)}`;
    i = j;
  }
  return `${out}${RESET}`;
}

/**
 * `slow +36pp` (quota to spare), `hot −20pp` (running ahead of the window)
 * or `on track ±5pp`, with the colour that reads for it. No elapsed mark
 * means no pace: an empty word and the track colour.
 */
export function paceWord(usedPct, elapsedPct) {
  if (usedPct == null || elapsedPct == null) return { text: '', color: METER_COLORS.track };
  const pp = Math.round(elapsedPct - usedPct);
  const signed = `${pp >= 0 ? '+' : '−'}${String(Math.abs(pp))}pp`;
  if (pp >= 15) return { text: `slow ${signed}`, color: METER_COLORS.amber };
  if (pp <= -15) return { text: `hot ${signed}`, color: METER_COLORS.red };
  return { text: `on track ${signed}`, color: METER_COLORS.green };
}

const WINDOW_FIELDS = [['5h', 'five_hour'], ['7d', 'seven_day'], ['mo', 'monthly']];
const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 86_400_000, mo: 30 * 86_400_000 };
const PACING_KEY = {
  fiveHour: '5h', '5h': '5h', weekly: '7d', '7d': '7d', monthly: 'mo', mo: 'mo',
};

function creditsOf(snapshot) {
  const quota = snapshot?.monthly_quota ?? null;
  const used = finiteOrNull(quota?.used);
  const limit = finiteOrNull(quota?.limit);
  if (used == null || limit == null) return null;
  const unit = typeof quota?.unit === 'string' && quota.unit ? quota.unit : 'credits';
  return { used, limit, unit };
}

/**
 * Every meter window one pool reports, oldest contract first: the window's
 * used% and reset time from `meterSnapshot`, and its elapsed% from the
 * reset time and the window's length — except the pool's own pacing window,
 * whose elapsed% is the pool's (that is the number routing uses). A monthly
 * window that does not pace is measured against 30 days. The reading's
 * credit meter, when the provider counts credits, hangs off the array as
 * `credits` so a caller can iterate windows and still read it.
 */
export function poolWindows(pool, nowMs = Date.now()) {
  const snapshot = pool?.meterSnapshot ?? null;
  const windows = [];
  const pacingKey = PACING_KEY[pool?.pacingWindow] ?? null;
  if (snapshot) {
    for (const [key, field] of WINDOW_FIELDS) {
      const raw = snapshot[field];
      const usedPct = finiteOrNull(raw?.utilization);
      if (usedPct == null) continue;
      const resetsAt = typeof raw?.resets_at === 'string' ? raw.resets_at : null;
      let elapsedPct = null;
      if (key === pacingKey && finiteOrNull(pool?.elapsedPct) != null) {
        elapsedPct = pool.elapsedPct;
      } else if (resetsAt) {
        const left = Date.parse(resetsAt) - nowMs;
        if (Number.isFinite(left)) {
          elapsedPct = Math.max(0, Math.min(100, 100 - (left / WINDOW_MS[key]) * 100));
        }
      }
      windows.push({ key, usedPct, resetsAt, elapsedPct });
    }
  }
  windows.credits = creditsOf(snapshot);
  return windows;
}

/** `1h41m`, `2d9h`, or `now` once the time has passed. No time, no text. */
export function untilText(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const mins = Math.round((Date.parse(iso) - nowMs) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return 'now';
  if (mins < 60) return `${String(mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h${String(mins % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(hours / 24))}d${String(hours % 24)}h`;
}

/** The oldest meter snapshot among the pools, ISO, or null when none read. */
function capturedAtOf(pools) {
  const times = (pools ?? [])
    .map((pool) => pool?.meterSnapshot?.captured_at)
    .filter((at) => typeof at === 'string');
  if (!times.length) return null;
  return times.sort()[0];
}

/**
 * What the Usage page draws from: the pools as `bullswarm pools` builds them
 * (live meter readings, falling back to the last state build when the live
 * read throws), the in-flight ledger `bullswarm assignments` reads, and the
 * rung table `bullswarm strategy rungs` prints, flattened to one record per
 * pool × tier. `capturedAt` is the oldest meter snapshot among them.
 */
// attachForecast re-reads every pool's meter history (about 110 ms on this
// machine), so a page refreshing once a second must not pay for it each tick.
// What it stamped is cached against the meter snapshot it was measured from
// and re-stamped while that snapshot stands; one entry per home.
const forecastCache = new Map();

/**
 * Stamp `spend` (with its `pacing.ratePerMinute`), `inflight` and the
 * `projected*Pct` fields onto the pool views, reusing the last measurement
 * while the meter snapshot has not moved.
 *
 * Without this, `poolBudget` has no `ratePerMinute`, and every licence share
 * and "what still fits" figure on the Budget page renders blank even on a
 * pool whose rate really was measured.
 */
function attachPacing(pools, bullswarmDir, { nowMs, capturedAt }) {
  const list = Array.isArray(pools) ? pools : [];
  if (!list.length || typeof bullswarmDir !== 'string' || !bullswarmDir) return list;
  const cached = forecastCache.get(bullswarmDir);
  if (capturedAt != null && cached && cached.capturedAt === capturedAt) {
    for (const pool of list) Object.assign(pool, cached.stamped.get(pool.name) ?? {});
    return list;
  }
  const keysBefore = list.map((pool) => new Set(Object.keys(pool)));
  const valuesBefore = list.map((pool) => ({ ...pool }));
  try {
    attachForecast(list, bullswarmDir, {
      now: nowMs,
      decisionLog: loadState(bullswarmDir)?.decisionLog ?? [],
    });
  } catch {
    // A forecast is an optimization, never a precondition: the pools are
    // still the live meter reading, the licence share just stays blank.
    return list;
  }
  // Cache by field name rather than a fixed list, so a field attachForecast
  // gains later is carried across a refresh without changing this file.
  const stamped = new Map();
  list.forEach((pool, index) => {
    const changed = {};
    for (const [key, value] of Object.entries(pool)) {
      if (!keysBefore[index].has(key) || valuesBefore[index][key] !== value) changed[key] = value;
    }
    stamped.set(pool.name, changed);
  });
  if (capturedAt != null) forecastCache.set(bullswarmDir, { capturedAt, stamped });
  return list;
}

export async function loadUsage(bullswarmDir, nowMs = Date.now()) {
  let built;
  try {
    built = await buildPoolsLive(bullswarmDir, nowMs, { getReadings: getAllMeterReadings });
  } catch {
    built = buildPools(bullswarmDir, nowMs);
  }
  const { state, connectors, pools } = built;
  const assignments = listAssignments(bullswarmDir, { now: nowMs });
  const rungs = rungsFor({
    pools,
    connectors,
    strategy: state?.strategy ?? {},
    decisionLog: state?.decisionLog ?? [],
  }).map((row) => ({
    pool: row.pool,
    tier: row.tier,
    model: row.model ?? null,
    reasoning: row.reasoning?.applied ?? null,
    dispatches: row.record?.dispatches ?? 0,
    okShare: row.record?.okShare ?? null,
    medianMinutes: row.record?.medianMinutes ?? null,
  }));
  const capturedAt = capturedAtOf(pools);
  attachPacing(pools, bullswarmDir, { nowMs, capturedAt });
  return { pools, assignments, rungs, capturedAt };
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * The first SGR mouse report in a key chunk, as the dashboard needs it:
 * button 0 pressed, the button released (`m`, or the 3 that some terminals
 * send), and the wheel (64 up, 65 down). Coordinates are 1-based cells, the
 * same ones the enables `\x1b[?1000h\x1b[?1003h\x1b[?1006h` report. Motion with
 * no button held is `move`. Anything else — plain keys, drags, another button — is null.
 */
export function parseMouse(chunk) {
  const match = SGR_MOUSE.exec(String(chunk ?? ''));
  if (!match) return null;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (button & 64) return { kind: (button & 1) === 1 ? 'wheel-down' : 'wheel-up', x, y };
  if (match[4] === 'm') return { kind: 'release', x, y };
  if ((button & 3) === 0 && (button & 32) === 0) return { kind: 'press', x, y };
  // Motion (bit 32) with no button held, reported under `\x1b[?1003h`: the
  // pointer moved over a cell. Drags (a button held while moving) stay null.
  if ((button & 32) !== 0 && (button & 3) === 3) return { kind: 'move', x, y };
  return null;
}
