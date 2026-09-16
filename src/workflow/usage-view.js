// The Usage page of the terminal dashboard, ported from the Claude Mod
// (mods/bullswarm/hooks/pool-rows.tsx, pools.ts, pane.tsx): the meter bars,
// the per-pool windows and rung table, the compact pool rows the Home and
// Run pages end with, the loader behind them and the SGR mouse parser the
// dashboard clicks with. Every renderer is pure — strings in, strings out —
// so the pages can be tested without a terminal; only loadUsage reads disk.

import { buildPools, buildPoolsLive } from '../lib/config.js';
import { listAssignments } from '../lib/assignments.js';
import { rungsFor, STRATEGY_TIERS } from '../lib/strategy.js';
import { finiteOrNull } from '../lib/num.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { attachForecast } from '../lib/forecast.js';
import { loadState } from '../lib/state.js';

/**
 * The truecolour meter palette: green below 50% used, amber from 50%, red
 * from 80%, on this track. Named, not ANSI-coloured, because a terminal
 * theme remaps the basic colours.
 */
export const METER_COLORS = Object.freeze({
  green: '#b6bd73',
  amber: '#e9c880',
  red: '#bf6c69',
  track: '#3a3a3a',
});

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[38;2;255;255;255m';
const SGR = /\x1b\[[0-9;]*m/g;

const chase = (text, code) => `${code}${text}${RESET}`;
const strip = (text) => text.replace(SGR, '');
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
 * A bar of exactly `width` cells: filled up to used% in the severity colour
 * over the track, with a white `▏` at the cell elapsed% falls in (a `▕` in
 * the last cell once the window has fully elapsed). Without ansi the cells
 * are `#`, `.` and `|`, so a fixture can be asserted as text. A pool with no
 * meter draws a dotted track and no mark.
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
  let out = '';
  let i = 0;
  while (i < cells) {
    const cellBg = i < filled ? fill : METER_COLORS.track;
    if (i === mark) {
      out += `${bg(cellBg)}${WHITE}${glyph}`;
      i += 1;
      continue;
    }
    const runFill = i < filled;
    let j = i;
    while (j < cells && j !== mark && (j < filled) === runFill) j += 1;
    out += `${bg(runFill ? fill : METER_COLORS.track)}${' '.repeat(j - i)}`;
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

/** Cut a styled line to `width` visible cells, keeping the escapes it keeps. */
function clipLine(text, width) {
  const cols = Math.max(0, Math.trunc(width));
  if (strip(text).length <= cols) return text;
  let out = '';
  let visible = 0;
  for (let i = 0; i < text.length && visible < cols;) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i);
      if (end > i) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
    visible += 1;
  }
  return text.includes('\x1b') ? `${out}${RESET}` : out;
}

const NAME_WIDTH = 16;
const BAR_WIDTH = 10;

/** `+35.9` / `−4.5` from the pool's surplus; no meter, no number. */
function paceText(pool) {
  if (finiteOrNull(pool?.pace) == null) return 'no meter';
  const pace = pool.pace;
  return `${pace >= 0 ? '+' : '−'}${Math.abs(pace).toFixed(1)}`;
}

/**
 * One compact row per enabled pool — the rows the Home and Run pages end
 * with: display name, a 10-cell bar, used/elapsed, the signed pace coloured
 * by severity, the action ids running there, and the lanes the pool is
 * incumbent for.
 */
export function poolSummaryLines(pools, assignments = [], { width = 120, ansi = true } = {}) {
  const tint = (text, code) => (ansi ? chase(text, code) : text);
  const busy = assignments ?? [];
  return (pools ?? [])
    .filter((pool) => pool.enabled)
    .map((pool) => {
      const name = String(pool.name).padEnd(NAME_WIDTH).slice(0, NAME_WIDTH);
      const used = pool.usedPct == null ? '  —' : `${String(Math.round(pool.usedPct)).padStart(3)}%`;
      const elapsed = pool.elapsedPct == null ? '' : `/${String(Math.round(pool.elapsedPct)).padStart(2)}%`;
      const state = pool.quarantine
        ? { word: 'quarantined', color: METER_COLORS.red }
        : { word: paceText(pool), color: severityColor(pool.usedPct) };
      const running = busy
        .filter((entry) => entry?.pool === pool.name)
        .map((entry) => entry.actionId ?? entry.lane)
        .filter(Boolean);
      const lanes = Array.isArray(pool.incumbentLane) && pool.incumbentLane.length
        ? `← ${pool.incumbentLane.join('/')}`
        : '';
      const line = [
        tint(name, BOLD),
        meterBar(pool.usedPct, pool.elapsedPct, BAR_WIDTH, { ansi }),
        ` ${tint(used, DIM)}`,
        tint(elapsed, DIM),
        `  ${tint(state.word, fg(state.color))}`,
        running.length ? `  ${tint(running.join(', '), CYAN)}` : '',
        lanes ? `  ${tint(lanes, DIM)}` : '',
      ].join('');
      return clipLine(line, width);
    });
}

const LANE_BLURB = {
  high: 'integration · architecture · adversarial-acceptance',
  medium: 'implement · check (the ordinary writers)',
  low: 'mechanical · io-read · digest',
};

const shortModel = (model) => (model ? String(model).split('/').pop() : '—');

/** `3 runs · 67% ok · p50 12m`, or the honest unknown. */
function rungRecordText(rung) {
  if (!rung.dispatches) return 'no runs yet';
  const text = [`${String(rung.dispatches)} run${rung.dispatches === 1 ? '' : 's'}`];
  if (rung.okShare != null) text.push(`${String(Math.round(rung.okShare * 100))}% ok`);
  if (rung.medianMinutes != null) text.push(`p50 ${String(Math.round(rung.medianMinutes))}m`);
  return text.join(' · ');
}

/** `<window> window · <used>% used of <elapsed>% elapsed`, plus state. */
function poolBlurb(pool) {
  const meter = pool.usedPct != null && pool.elapsedPct != null
    ? `${String(Math.round(pool.usedPct))}% used of ${String(Math.round(pool.elapsedPct))}% elapsed`
    : 'no meter';
  const window = pool.pacingWindow === 'monthly' || pool.pacingWindow === 'weekly'
    ? pool.pacingWindow
    : '';
  const lanes = Array.isArray(pool.incumbentLane) && pool.incumbentLane.length
    ? `incumbent for ${pool.incumbentLane.join('/')}`
    : '';
  return [
    window ? `${window} window` : '',
    meter,
    pool.quarantine ? 'quarantined' : '',
    lanes,
  ].filter(Boolean).join(' · ');
}

const rungFor = (rungs, pool, tier) =>
  (rungs ?? []).find((rung) => rung?.pool === pool.name && rung?.tier === tier);

/** The rungs of one pool by lane: a group per tier, a row per pool. */
function laneGroups(pools, rungs) {
  const groups = [];
  for (const tier of STRATEGY_TIERS) {
    const mine = pools
      .map((pool) => ({ pool, rung: rungFor(rungs, pool, tier) }))
      .filter((entry) => entry.rung?.model);
    if (!mine.length) continue;
    groups.push({
      title: tier,
      blurb: LANE_BLURB[tier] ?? '',
      rows: mine.map((entry) => ({ sub: entry.pool.name, rung: entry.rung })),
    });
  }
  return groups;
}

/** The rungs of one pool by provider: a group per pool, a row per tier. */
function providerGroups(pools, rungs) {
  const groups = [];
  for (const pool of pools) {
    const mine = STRATEGY_TIERS
      .map((tier) => ({ tier, rung: rungFor(rungs, pool, tier) }))
      .filter((entry) => entry.rung?.model);
    if (!mine.length) continue;
    groups.push({
      title: pool.name,
      blurb: poolBlurb(pool),
      rows: mine.map((entry) => ({ sub: entry.tier, rung: entry.rung })),
    });
  }
  return groups;
}

/**
 * The whole Usage page body: per enabled pool its name and plan type, every
 * meter window as a full-width bar with its reset time and pace word, the
 * credit meter when the provider counts credits; then the rung table, the
 * two grouping tabs and the groups — by lane (the effort a kind resolves
 * to) or by provider. The page's header, bottom nav and the read-only note
 * above it belong to the dashboard frame, not to these lines.
 */
export function usageLines(pools, rungs, { width = 120, rungsBy = 'lane', nowMs = Date.now(), ansi = true } = {}) {
  const tint = (text, code) => (ansi ? chase(text, code) : text);
  const cols = Math.min(Math.trunc(width) || 120, 120);
  const barWidth = Math.max(10, cols - 12);
  const enabled = (pools ?? []).filter((pool) => pool.enabled);
  const rows = [];
  const line = (text) => rows.push(clipLine(text, cols));

  for (const pool of enabled) {
    const plan = typeof pool.meterSnapshot?.plan_type === 'string' ? pool.meterSnapshot.plan_type : null;
    line(`${tint(String(pool.name), BOLD)}${plan ? tint(` · ${plan}`, DIM) : ''}`);
    const windows = poolWindows(pool, nowMs);
    if (!windows.length) line(tint('  no meter reported', DIM));
    for (const window of windows) {
      const used = `${window.usedPct.toFixed(1)}%`.padStart(6);
      line(
        tint(`${window.key.padEnd(3)} `, DIM)
        + meterBar(window.usedPct, window.elapsedPct, barWidth, { ansi })
        + tint(` ${used}`, fg(severityColor(window.usedPct))),
      );
      const pace = paceWord(window.usedPct, window.elapsedPct);
      const resets = window.resetsAt ? `resets ${untilText(window.resetsAt, nowMs)}` : 'no reset time';
      line(`    ${tint(resets, DIM)}${pace.text ? ` · ${tint(pace.text, fg(pace.color))}` : ''}`);
    }
    if (windows.credits) {
      const { used, limit, unit } = windows.credits;
      line(`    ${tint(`${String(used)} / ${String(limit)} ${unit}`, DIM)}`);
    }
    line('');
  }

  line(`${tint('Rungs', BOLD)}${tint(' · model · reasoning · record, per lane and pool', DIM)}`);
  const byProvider = rungsBy === 'provider';
  line(`[${byProvider ? 'by lane' : '● by lane'}] [${byProvider ? '● by provider' : 'by provider'}]`);

  const all = rungs ?? [];
  const groups = byProvider ? providerGroups(enabled, all) : laneGroups(enabled, all);
  // The pool column keeps at least one blank cell before the model: a pool
  // named exactly NAME_WIDTH characters (`claude-code:wati`) would otherwise
  // run straight into it. The record line is indented to the same column.
  const subWidth = Math.max(NAME_WIDTH, ...groups.flatMap(
    (group) => group.rows.map((row) => String(row.sub ?? '').length + 1),
  ));
  const recordIndent = ' '.repeat(subWidth + 2);
  for (const group of groups) {
    line('');
    line(`${tint(group.title, BOLD)}${group.blurb ? tint(` · ${group.blurb}`, DIM) : ''}`);
    for (const row of group.rows) {
      line(
        `  ${tint(row.sub.padEnd(subWidth).slice(0, subWidth), DIM)}`
        + tint(shortModel(row.rung.model), CYAN)
        + (row.rung.reasoning ? ` · ${row.rung.reasoning}` : ''),
      );
      line(`${recordIndent}${tint(rungRecordText(row.rung), DIM)}`);
    }
  }
  if (!all.length) line(tint('  reading rungs…', DIM));
  return rows;
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
 * same ones the enables `\x1b[?1000h\x1b[?1006h` report. Anything else —
 * plain keys, motion, another button — is null.
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
  return null;
}
