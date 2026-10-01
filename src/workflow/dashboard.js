import { withV2Cancellation } from './v2-cancellation.js';
import { reconcileActivity, scheduleReconcile } from './reconcile.js';
import { spawnRetentionSweep } from '../lib/retention.js';
// Interactive workflow dashboard, inspired by Claude Code's /workflows view.
// It deliberately uses only ANSI sequences and Node's standard streams.

import { statSync } from 'node:fs';
import { readJsonSafe } from '../lib/fsjson.js';
import { join } from 'node:path';
import { listRuns, resolveRunId, isLegacyRunDir, legacyRunLine } from './short-id.js';
import { readEvents } from './events.js';
import { glyphs } from '../lib/glyphs.js';
import { integrationStatus, installIntegration } from '../integrate.js';
import { loadUsage, parseMouse } from './usage-view.js';
// The 0.33.0 pages: the render kit, the two aggregation models, and the four
// view modules each territory owns. The shell composes them and owns no
// arithmetic of its own beyond laying the lines out.
import { columns } from './dash-kit.js';
import { PERIODS, TREND_METRICS, modelsModel, overviewModel, poolsModel, projectsModel, trendModel } from './stats-model.js';
import { biggestRuns, budgetModel } from './budget-model.js';
import { historyLines } from './history-view.js';
import { dayKey, historyDays } from './history.js';
import { readRollups, rollupIndexPath } from './rollup.js';
import { loadState } from '../lib/state.js';
import { listTasks, taskKey } from '../lib/tasks.js';
import { filterDashboardRows } from './runs-view.js';
import { workflowPanelModel } from './run-model.js';
import {
  renderWorkflowOverviewPanel,
  workflowTimelineLines,
  runTimelineFold,
} from './run-view.js';
// The Usage page's `[edit]` hands the terminal to the same control centre
// `bullswarm setup` opens, so the rungs the reader just saw and the ones they
// are about to change are the same program's.
import { openSetupTui as openSetupControlCentre } from '../setup.js';
import { stepPageModel } from './step-model.js';
import { taskStepModel } from './task-step.js';
import { withPoolLabels } from '../lib/pool-labels.js';
// The one-concept modules this file was split into (0.38.2). dashboard.js
// keeps the TUI loop and the JSON entry points, and re-exports the names the
// product reads from it.
import { ESC, ANSI_SGR, meterAnsi } from './dashboard-ansi.js';
import { clamp } from './dashboard-clamp.js';
import { keyPressed } from './dashboard-keys.js';
import { DASHBOARD_PAGES, PERIOD_ITEMS, STATS_TABS, FLEET_TABS, STEP_SECTIONS } from './dashboard-pages.js';
import { readLicencePerDay } from './dashboard-licence.js';
import { writeClipboard } from './dashboard-clipboard.js';
import { requestCancel } from './dashboard-cancel.js';
import { dashboardRows, activeDashboardRows, detailRow } from './dashboard-rows.js';
import { renderDetails } from './dashboard-details.js';
import { renderDashboardPage } from './dashboard-render.js';
export { requestCancel } from './dashboard-cancel.js';
export { dashboardRows } from './dashboard-rows.js';
export { readLicencePerDay, writeClipboard, activeDashboardRows, renderDetails };
export { renderDashboardPage } from './dashboard-render.js';

/** The operating-system-command introducer and its terminator, for OSC 52. */
const OSC = '\x1b]';
const BEL = '\x07';
/** The SGR mouse reports parseMouse() consumes, stripped before a key read. */
const MOUSE_SEQUENCE = /\x1b\[<\d+;\d+;\d+[Mm]/g;
/**
 * How long an OSC 52 payload may be before the copy takes the local
 * clipboard instead. xterm's own limit is around 100 kB of sequence and
 * several terminals truncate well below that, so a screen that does not
 * comfortably fit goes through pbcopy or wl-copy, which say so.
 */
const OSC52_LIMIT = 74_000;
/** How far back History will load, seven days at a time, as the reader scrolls. */
const MAX_HISTORY_DAYS = 120;

/**
 * One static frame of a run's overview panel — the timeline, live and next
 * sections the interactive viewer draws — as plain text lines with no
 * escape codes, for a caller that embeds it (the Claude mod's pane).
 * @param {string} bullswarmDir
 * @param {string} token shortId or runId
 * @param {{width?: number, height?: number}} [opts]
 * @returns {{legacy: boolean, shortId: string, runId: string, lines: string[]}}
 */
export function overviewSnapshot(bullswarmDir, token, { width = 100, height = 30 } = {}) {
  const row = detailRow(bullswarmDir, token);
  if (row.legacy) {
    return { legacy: true, shortId: row.shortId, runId: row.runId, lines: [legacyRunLine({ shortId: row.shortId, runId: row.runId, runDir: row.runDir })] };
  }
  const model = workflowPanelModel(row);
  const lines = renderWorkflowOverviewPanel(model, Math.max(40, Number(width) || 100), Math.max(12, Number(height) || 30), 0, 0)
    .map((line) => String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  return { legacy: false, shortId: row.shortId, runId: row.runId, lines };
}

/**
 * The sparklines Home draws over the last seven days, one per tile.
 * Each is the same trend Stats charts, so the tile and its chart agree.
 */
function tileSparklines(rollups, nowMs) {
  const out = {};
  for (const metric of ['runs', 'verified', 'spend']) {
    const trend = trendModel(rollups, { metric, period: '7d', now: nowMs });
    out[metric] = trend.buckets.map((bucket) => bucket.value);
  }
  return out;
}

/**
 * The dashboard's data, gathered once per paint. Rendering stays a pure
 * function of this model and the options, so every page is testable without
 * a terminal, a clock or the operator's home directory.
 */
export function dashboardModel(row, {
  runs = null, usage = null, integration = null, installResult = null, nowMs = Date.now(),
  rollups = null, days = null, prices = null, period = '7d', budgetPeriod = 'week',
  metric = 'runs', meterHistory = null, tasks = null, task = null, taskRoot = null, taskRunsDir = null,
} = {}) {
  const pools = usage?.pools ?? [];
  const records = rollups ?? [];
  const model = {
    row: row ?? null,
    task: task ?? null,
    taskRoot: taskRoot ?? taskRunsDir ?? null,
    taskRunsDir: taskRunsDir ?? taskRoot ?? null,
    nowMs,
    runs: runs ?? (row && row.legacy !== true ? [row] : []),
    pools,
    assignments: usage?.assignments ?? [],
    rungs: usage?.rungs ?? [],
    capturedAt: usage?.capturedAt ?? null,
    integration,
    installResult,
    rollups: records,
    days: days ?? [],
    prices,
    stats: null,
    budget: null,
    tasks: {
      inflight: Array.isArray(tasks?.inflight) ? tasks.inflight : [],
      finished: Array.isArray(tasks?.finished) ? tasks.finished : [],
    },
  };
  // The aggregations are the models' arithmetic, run once per paint over the
  // rollup index — never over the run directories.
  try {
    const overview = overviewModel(records, pools, { period, now: nowMs });
    model.stats = {
      overview,
      breakdown: overview.breakdown,
      // The Trends tab charts the metric the reader chose, so the tile they
      // clicked and the chart it opened are the same series.
      trend: trendModel(records, { metric: TREND_METRICS.includes(metric) ? metric : 'runs', period, now: nowMs }),
      // Home's breakdown band always charts spend per day, whatever metric
      // the reader last opened in Trends; Trends keeps `trend` above.
      spendPerDay: trendModel(records, { metric: 'spend', period, now: nowMs }),
      pools: {
        ...poolsModel(records, pools, { period, now: nowMs }),
        licencePerDay: meterHistory?.rows ?? null,
        meterHistoryReason: meterHistory?.reason ?? null,
      },
      models: modelsModel(records, { period, now: nowMs }),
      projects: projectsModel(records, { period, now: nowMs }),
      sparklines: tileSparklines(records, nowMs),
    };
  } catch { model.stats = null; }
  try {
    const budget = budgetModel(pools, {
      rollups: records, prices, period: budgetPeriod, now: nowMs,
      sampledAt: usage?.capturedAt ?? null,
    });
    budget.biggestRuns = Object.fromEntries(budget.rows.map((entry) => [
      entry.name,
      biggestRuns(records, { pool: entry.name, period: budgetPeriod, now: nowMs, limit: 3 }).byMinutes,
    ]));
    model.budget = budget;
  } catch { model.budget = null; }
  return model;
}

/**
 * One frame of a run's dashboard page as a string, the way every existing
 * caller reads it. `page` defaults to Run, or Step when `focus` is at the
 * agent detail.
 */
export function renderWorkflowTui(row, options = {}) {
  return renderDashboardPage(dashboardModel(row, options), options).lines.join('\n');
}

export async function runDashboard(bullswarmDir, {
  input = process.stdin, output = process.stdout, refreshMs = 1000,
  spinnerMs = 400, token = null, openSetupTui = null, homeDir = process.env.HOME ?? '',
  clipboard = writeClipboard, autoReprice = true, autoPrune = true,
} = {}) {
  if ((!input.isTTY || !output.isTTY) && !token) throw new Error('workflow dashboard requires a TTY, or pass a run ID for a static text tree');
  if ((!input.isTTY || !output.isTTY) && token) {
    const row = detailRow(bullswarmDir, token);
    // Nothing to draw for a legacy run: the same single line the CLI prints.
    if (row.legacy) {
      output.write(`${legacyRunLine({ shortId: row.shortId, runId: row.runId, runDir: row.runDir })}\n`);
      return 2;
    }
    const details = renderDetails(row, { interactive: false });
    // A non-TTY run-ID inspection must expose the same segmented timeline as
    // the interactive viewer; otherwise real command output cannot evidence
    // the layout that users are being asked to inspect.
    const timeline = renderWorkflowTui(row, {
      width: Math.max(80, Number(output.columns) || 120),
      height: 80,
    });
    const text = withPoolLabels(`${details}\n\n${timeline}`.replace(ANSI_SGR, ''), bullswarmDir);
    output.write(`${text}\n`);
    return 0;
  }
  let selected = 0;
  const directRow = token ? detailRow(bullswarmDir, token) : null;
  // A legacy run has no drilldown: its page is the one line the CLI prints.
  const directV2 = Boolean(directRow) && !directRow.legacy;
  let message = null;
  let pricingNoteShown = false;
  let lastGoodRow = null;
  let dashboardFilter = directV2 ? 'all' : 'active';
  let query = '';
  let filterEditing = false;
  // The runs in flight, read every refresh without parsing 293 run
  // directories. The whole catalogue is only read when the Runs page asks
  // for it, because only that page lists finished runs one by one.
  let activeRuns = activeDashboardRows(bullswarmDir);
  let catalog = null;
  let allRows = activeRuns;
  let rows = filterDashboardRows(allRows, dashboardFilter, query);
  let lastPaintedFrame = null;
  let lastPaintedLines = null;
  // The clickable region under the mouse pointer: its words are painted in
  // reverse video the way the Mod pane lights a row. Only the region's own
  // cells, and within them only text — bars, meters and connector lines keep
  // their colours.
  let hover = null;
  // Stats slice labels are a separate affordance: the bars retain their
  // glyphs and colours, while a moving pointer names the exact series/day.
  // A click promotes the transient slice to a pin that survives motion until
  // Escape or another click.
  let sliceHover = null;
  let slicePinned = null;
  const clearSliceState = () => {
    sliceHover = null;
    slicePinned = null;
  };
  // Bars and meters inside a hovered region keep their colours; only the
  // words light up. A span is a run of non-bar cells with its blanks trimmed.
  const BAR_GLYPHS = /[█▇▆▅▄▃▂▁░▒▓▏▎▍▌▋▊▉─│┌┐└┘├┤┬┴┼╭╮╯╰○]/;
  const textSpans = (plain, from, to) => {
    const spans = [];
    let start = null;
    for (let at = from; at <= to; at += 1) {
      const isText = at < to && !BAR_GLYPHS.test(plain[at]);
      if (isText && start == null) start = at;
      if (!isText && start != null) {
        let a = start; let b = at;
        while (a < b && plain[a] === ' ') a += 1;
        while (b > a && plain[b - 1] === ' ') b -= 1;
        if (b > a) spans.push([a, b]);
        start = null;
      }
    }
    return spans;
  };
  // Walk the painted line, counting visible cells, and switch reverse video
  // on and off at the span edges; a reset inside a span (`\x1b[0m`) would
  // drop the reverse, so it is re-armed right after.
  const reverseTextSpans = (line, spans) => {
    if (!spans.length) return line;
    let out = '';
    let cell = 0;
    let inside = false;
    const opens = new Map(spans.map(([a]) => [a, true]));
    const closes = new Map(spans.map(([, b]) => [b, true]));
    const sgr = /\x1b\[[0-9;?]*[A-Za-z]/y;
    for (let at = 0; at < line.length;) {
      sgr.lastIndex = at;
      const match = sgr.exec(line);
      if (match) {
        out += match[0];
        if (inside && /\x1b\[0?m$/.test(match[0])) out += `${ESC}7m`;
        at += match[0].length;
        continue;
      }
      if (closes.has(cell) && inside) { out += `${ESC}27m`; inside = false; }
      if (opens.has(cell) && !inside) { out += `${ESC}7m`; inside = true; }
      out += line[at];
      cell += 1;
      at += 1;
    }
    if (inside) out += `${ESC}27m`;
    return out;
  };
  const stripAnsiText = (text) => String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let lastFrameText = null;
  let lastFrameResult = null;
  let regions = [];
  let usage = null;
  let integration = null;
  let installResult = null;
  let bodyScroll = 0;
  // Home, Stats, History and Budget all read the same index, re-read only
  // when it has actually changed.
  let rollups = [];
  let rollupFingerprint = null;
  let days = [];
  let prices = null;
  let meterHistory = null;
  let tasks = { inflight: [], finished: [] };
  let taskFingerprint = null;
  const readTaskLedger = () => {
    let next;
    try { next = listTasks({ home: bullswarmDir, now: Date.now() }); }
    catch { next = { inflight: [], finished: [] }; }
    const signature = [
      ...(next.inflight ?? []).map((entry) => [
        'i', entry.id, entry.startedAt, entry.lane, entry.pool, entry.model,
        entry.project, entry.taskFile,
      ].join(':')),
      ...(next.finished ?? []).map((entry) => [
        'f', entry.id, entry.endedAt, entry.ok, entry.durationMs, entry.lane,
        entry.pool, entry.model, entry.project, entry.taskFile, entry.reason,
      ].join(':')),
    ].join('|');
    if (signature !== taskFingerprint) {
      taskFingerprint = signature;
      tasks = next;
      rollupFingerprint = null;
    }
  };
  const ui = {
    page: token ? 'run' : 'home',
    focus: 0,
    period: '7d',
    statsTab: 'spending',
    statsStackBy: 'pool',
    metric: 'runs',
    fleetBy: 'lane',
    budgetPool: null,
    historyDays: 7,
    phaseIndex: null,
    agentIndex: null,
    detailScroll: 0,
    followActivePhase: true,
    followActiveAgent: true,
    confirmCancel: false,
    controlSelected: false,
    orchestratorDetail: false,
    orchestratorVerbose: false,
    workflowVerbose: false,
    mobileTimeline: true,
    timelineSelection: null,
    // The runs whose folded middle phases the reader opened in place, and
    // whether the cursor now sits on the fold's own `click to fold` line.
    foldOpen: new Set(),
    foldStop: false,
    // Step-page-only transient state. The durable attempt/activity model stays
    // immutable; these values drive selection, detail, filters, and section
    // navigation while the reader is on the Step page.
    stepDetail: false,
    stepView: 'overview',
    stepExpandedTurn: null,
    stepTurnIndex: null,
    stepSection: 'activity',
    stepSelectedEventIndex: null,
    stepAttemptOrdinal: null,
    stepFollow: true,
    stepFilter: 'all',
    stepToolPage: 0,
    // Where the overview's latest-turns window ends once the reader stops
    // following; null slides it with every new turn.
    stepWindowEnd: null,
    runPlanBoxes: false,
    runFollow: true,
    spinnerFrame: 0,
  };
  if (directV2) {
    const directIndex = rows.findIndex((row) => row.runId === directRow.runId);
    if (directIndex >= 0) selected = directIndex;
  }
  let selectedRunId = token ? directRow.runId : (rows[selected]?.runId ?? null);
  let selectedTaskId = null;

  /** The rollup index, re-read only when the file changed under us. */
  const readIndex = () => {
    let fingerprint = null;
    try {
      const stat = statSync(rollupIndexPath(bullswarmDir));
      fingerprint = `${stat.size}:${stat.mtimeMs}:${ui.historyDays}`;
    } catch { fingerprint = `absent:${ui.historyDays}`; }
    if (fingerprint === rollupFingerprint) return;
    rollupFingerprint = fingerprint;
    try { rollups = readRollups(bullswarmDir); } catch { rollups = []; }
    try { days = historyDays(bullswarmDir, { days: ui.historyDays, tasks: tasks.finished }); } catch { days = []; }
  };
  /** The declared subscription prices: the operator's, else the table's. */
  const readPrices = () => {
    try { prices = { subscriptions: loadState(bullswarmDir)?.strategy?.subscriptions ?? {} }; }
    catch { prices = { subscriptions: {} }; }
  };
  // The pools, the ledger and the rungs are read off disk (live meter reads
  // included), so the read lands after the frame it was asked for: the frame
  // paints at once and repaints when the data arrives. A later read wins.
  //
  // One read at a time. The refresh timer fires every second and loadUsage
  // shells out to the provider CLIs, which on a busy machine takes longer
  // than that: every tick used to issue a new ticket, so every result that
  // arrived was already superseded and the meters never landed at all — the
  // licence tile and the `budget · this week` block read "no pool reported a
  // licence meter" forever. A read in flight now absorbs the tick.
  let usageTicket = 0;
  let usageInFlight = false;
  // Meter snapshots and account discovery cost hundreds of milliseconds
  // (the Claude keychain read alone shells out to `security`), so usage is
  // reloaded every ten seconds, not on every one-second tick.
  const USAGE_EVERY_MS = 10_000;
  let usageLoadedAt = 0;
  const readUsage = ({ force = false } = {}) => {
    if (usageInFlight) return Promise.resolve(undefined);
    if (!force && usage && Date.now() - usageLoadedAt < USAGE_EVERY_MS) return Promise.resolve(undefined);
    const ticket = (usageTicket += 1);
    usageInFlight = true;
    return loadUsage(bullswarmDir).finally(() => { usageInFlight = false; }).then((loaded) => {
      if (ticket !== usageTicket) return undefined;
      usageLoadedAt = Date.now();
      // Budget's licence share is `ratePerMinute x measured minutes`, and
      // loadUsage now measures that rate itself — once per meter snapshot,
      // not once per one-second refresh.
      usage = loaded;
      meterHistory = readLicencePerDay(bullswarmDir, loaded.pools, {
        period: ui.period, now: Date.now(), rollups,
      });
      return paint();
    }, (err) => {
      if (ticket !== usageTicket) return undefined;
      message = `usage unavailable: ${err.message}`;
      return paint();
    });
  };
  const readIntegration = () => {
    try { integration = integrationStatus({ homeDir }); } catch (err) { message = `agent integration unavailable: ${err.message}`; }
  };
  // Clearing the entire alternate screen for every spinner frame produces a
  // visible blank flash on slower terminals, especially mobile SSH sessions.
  // Enter/clear the alternate screen once, then repaint each row in place.
  // Padding to the terminal height also removes remnants when switching from
  // a taller detail view to a shorter picker view.
  const writeFrame = (text) => {
    const clearPrefix = `${ESC}2J${ESC}H`;
    let source = String(text ?? '').startsWith(clearPrefix)
      ? String(text ?? '').slice(clearPrefix.length)
      : String(text ?? '');
    if (source.startsWith('\n')) source = source.slice(1);
    const height = Math.max(1, Number(output.rows) || source.split('\n').length);
    const lines = source.split('\n').slice(0, height);
    while (lines.length < height) lines.push('');
    lastFrameText = text;
    if (hover && hover.y >= 1 && hover.y <= lines.length) {
      const line = lines[hover.y - 1];
      const plain = stripAnsiText(line);
      const from = Math.max(0, hover.x1 - 1);
      const to = Math.min(plain.length, hover.x2);
      lines[hover.y - 1] = reverseTextSpans(line, textSpans(plain, from, to));
    }
    // Rewrite only the rows that changed since the last paint. A spinner
    // tick or a clock digit is then a few dozen bytes, not the whole 120×40
    // frame — the difference between smooth and laggy over a phone or a
    // remote terminal. A first paint, a resize, or a return from the setup
    // hand-off (lastPaintedFrame reset to null) writes the full frame.
    //
    // Each row is erased from its first column before it is painted, never
    // after: a row that fills the terminal leaves the cursor on its last cell
    // with a wrap pending, and an erase sent then clears that cell. Ghostty
    // does exactly that (its eraseLine starts at the cursor's column), which
    // cost every full-width row its last cell at 200 columns — `40%` read
    // `40` and a single-digit count vanished.
    if (lastPaintedFrame != null && Array.isArray(lastPaintedLines) && lastPaintedLines.length === lines.length) {
      let patch = '';
      let changed = 0;
      for (let row = 0; row < lines.length; row += 1) {
        if (lines[row] === lastPaintedLines[row]) continue;
        changed += 1;
        patch += `${ESC}${String(row + 1)};1H${ESC}K${lines[row]}`;
      }
      if (!changed) return;
      lastPaintedLines = lines.slice();
      lastPaintedFrame = patch;
      output.write(patch);
      return;
    }
    const frame = `${ESC}H${lines.map((line) => `${ESC}K${line}`).join('\n')}`;
    lastPaintedLines = lines.slice();
    lastPaintedFrame = frame;
    output.write(frame);
  };
  // Several mobile terminals auto-wrap when the final column is painted.
  // Leave one narrow-screen column unused so the right border remains stable.
  const frameWidth = () => {
    const columns = Math.max(20, Number(output.columns) || 120);
    return columns < 100 ? Math.max(20, columns - 1) : columns;
  };
  const frameHeight = () => Math.max(12, Number(output.rows) || 36);
  // A torn read while the runner writes state.json yields state:null for one
  // frame — keep painting the last good snapshot of the same run.
  const currentRow = () => {
    const fresh = detailRow(bullswarmDir, selectedRunId);
    const row = (fresh.state || fresh.legacy || lastGoodRow?.runId !== fresh.runId) ? fresh : lastGoodRow;
    if (row === fresh) lastGoodRow = fresh;
    return row;
  };
  /** The whole catalogue, parsed once and only for the page that lists it. */
  const ensureCatalog = () => {
    if (catalog) return catalog;
    try { catalog = dashboardRows(bullswarmDir, { all: true }); catalogAt = Date.now(); catalogSignature = `${activeSignature()}#${rollupFingerprint}`; }
    catch (err) { message = `display error: ${err.message}`; catalog = activeRuns; }
    allRows = catalog;
    rows = filterDashboardRows(allRows, dashboardFilter, query);
    const preserved = rows.findIndex((row) => row.runId === selectedRunId);
    if (preserved >= 0) selected = preserved;
    return catalog;
  };
  const pageOptions = () => ({
    width: frameWidth(),
    height: frameHeight(),
    page: ui.page,
    rows, allRows, selected,
    filter: dashboardFilter, query, filterEditing,
    selectedRunId, selectedTaskId, listSelectedId: selectedRunId, message, bodyScroll,
    period: ui.period, statsTab: ui.statsTab, statsStackBy: ui.statsStackBy,
    metric: ui.metric, fleetBy: ui.fleetBy,
    slice: slicePinned ?? sliceHover,
    budgetPool: ui.budgetPool,
    spinnerFrame: ui.spinnerFrame,
    focus: ui.focus,
    phaseIndex: ui.followActivePhase ? null : ui.phaseIndex,
    agentIndex: ui.followActiveAgent ? null : ui.agentIndex,
    detailScroll: ui.detailScroll,
    controlSelected: ui.controlSelected,
    orchestratorDetail: ui.orchestratorDetail,
    orchestratorVerbose: ui.orchestratorVerbose,
    workflowVerbose: ui.workflowVerbose,
    mobileTimeline: ui.mobileTimeline,
    timelineSelection: ui.timelineSelection,
    foldOpen: ui.foldOpen.has(selectedRunId),
    foldStop: ui.foldStop,
    confirmCancel: ui.confirmCancel,
    stepDetail: ui.stepDetail,
    stepView: ui.stepView,
    stepExpandedTurn: ui.stepExpandedTurn,
    stepTurnIndex: ui.stepTurnIndex,
    stepSection: ui.stepSection,
    stepSelectedEventIndex: ui.stepSelectedEventIndex,
    stepAttemptOrdinal: ui.stepAttemptOrdinal,
    stepFollow: ui.stepFollow,
    stepFilter: ui.stepFilter,
    stepToolPage: ui.stepToolPage,
    stepWindowEnd: ui.stepWindowEnd,
    planBoxes: ui.runPlanBoxes,
    runFollow: ui.runFollow,
  });
  const paintUnsafe = () => {
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    // Every page but Run and Step is paintable without a run; those two fall
    // back to Home without one.
    if ((ui.page === 'run' || ui.page === 'step') && !selectedRunId) ui.page = 'home';
    const row = ui.page === 'run' || ui.page === 'step' ? currentRow() : null;
    const task = ui.page === 'task'
      ? [...(tasks.inflight ?? []), ...(tasks.finished ?? [])].find((entry) => taskKey(entry) === selectedTaskId) ?? null
      : null;
    if (row && !row.legacy) {
      // The follow flags track whatever the page last resolved as current.
      const panel = workflowPanelModel(row, {
        phaseIndex: ui.followActivePhase ? null : ui.phaseIndex,
        agentIndex: ui.followActiveAgent ? null : ui.agentIndex,
      });
      ui.phaseIndex = panel.phaseIndex;
      ui.agentIndex = panel.agentIndex;
    }
    if (usage && meterHistory?.period !== ui.period) {
      meterHistory = readLicencePerDay(bullswarmDir, usage.pools, {
        period: ui.period, now: Date.now(), rollups,
      });
    }
    const model = dashboardModel(row, {
      runs: activeRuns,
      tasks,
      task,
      taskRunsDir: join(bullswarmDir, 'runs'),
      usage, integration, installResult, rollups, days, prices,
      period: ui.period, metric: ui.metric, meterHistory,
    });
    // The overview's latest-turns window slides while the reader follows the
    // step; once they stop, it stays where the last frame left it.
    if (ui.page === 'step' || ui.page === 'task') {
      if (ui.stepFollow) ui.stepWindowEnd = null;
      else if (ui.stepWindowEnd == null && Number.isInteger(lastFrameResult?.anchor?.step?.windowEnd)) {
        ui.stepWindowEnd = lastFrameResult.anchor.step.windowEnd;
      }
    }
    const frame = renderDashboardPage(model, pageOptions());
    regions = frame.regions;
    writeFrame(frame.lines.join('\n'));
    lastFrameResult = frame;
    return frame;
  };
  // A render error must never kill the TUI or strand the terminal in
  // alt-screen raw mode (crash observed 2026-08-29 at detailRow via the
  // repaint timer). Show the error in the message line and keep running.
  const paint = () => {
    try { return paintUnsafe(); } catch (err) {
      message = `display error: ${err.message}`;
      try {
        const frame = renderDashboardPage(dashboardModel(null, {
          runs: activeRuns, tasks, usage, integration, rollups, days, prices,
          taskRunsDir: join(bullswarmDir, 'runs'),
          meterHistory,
        }), { ...pageOptions(), page: 'home', message });
        regions = frame.regions;
        writeFrame(frame.lines.join('\n'));
        lastFrameResult = frame;
        return frame;
      } catch { /* keep the loop alive */ }
      return lastFrameResult;
    }
  };
  // The full catalogue reads every run directory (120–760 ms on a home with
  // 300 runs), far too much for a one-second tick. Rebuild it only when an
  // active run changed state, the history index changed, or 15 s passed;
  // the active rows themselves are cheap and stay fresh every tick.
  const CATALOG_TTL_MS = 15_000;
  let catalogAt = 0;
  let catalogSignature = null;
  const activeSignature = () => activeRuns.map((row) => `${row.runId}:${row.state?.lifecycle?.status ?? ''}:${row.ongoing ? 1 : 0}`).join('|');
  const refresh = () => {
    const previousRunId = selectedRunId;
    const previousTaskId = selectedTaskId;
    try {
      activeRuns = activeDashboardRows(bullswarmDir);
      readTaskLedger();
      const indexBefore = rollupFingerprint;
      readIndex();
      if (catalog) {
        const signature = `${activeSignature()}#${rollupFingerprint}`;
        const stale = Date.now() - catalogAt >= CATALOG_TTL_MS || signature !== catalogSignature || rollupFingerprint !== indexBefore;
        if (stale) {
          catalog = dashboardRows(bullswarmDir, { all: true });
          catalogAt = Date.now();
          catalogSignature = signature;
        }
        allRows = catalog;
      } else allRows = activeRuns;
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      const preserved = rows.findIndex((row) => row.runId === previousRunId);
      if (preserved >= 0) selected = preserved;
      else selected = clamp(selected, 0, Math.max(0, rows.length - 1));
      readIntegration();
      // While the detached pricing pass runs, say so quietly (never over
      // another message) and clear the note when it ends.
      const pricingNote = reconcileActivity(bullswarmDir);
      if (pricingNote && (!message || pricingNoteShown)) { message = pricingNote; pricingNoteShown = true; }
      else if (!pricingNote && pricingNoteShown) { if (message?.startsWith('pricing ')) message = null; pricingNoteShown = false; }
      void readUsage();
    } catch (err) { message = `display error: ${err.message}`; }
    // On the Runs page the cursor may sit on a finished row of the day table,
    // which the active-only catalogue does not hold; a refresh must not drag
    // it back onto the in-flight run, or Enter opens the wrong workflow.
    const tableKeepsCursor = ui.page === 'runs'
      && (lastFrameResult?.runRows ?? []).some((row) => row.runId === previousRunId);
    const taskStillExists = [...(tasks.inflight ?? []), ...(tasks.finished ?? [])]
      .some((row) => taskKey(row) === previousTaskId);
    const taskKeepsCursor = ui.page === 'runs'
      && (lastFrameResult?.taskRows ?? []).some((row) => row.taskId === previousTaskId)
      && taskStillExists;
    if (ui.page === 'runs' && !taskKeepsCursor && !tableKeepsCursor) selectedTaskId = null;
    selectedRunId = tableKeepsCursor ? previousRunId : (rows[selected]?.runId ?? selectedRunId);
    paint();
  };
  /** Opens one run's page, widening the filter when it hides that run. */
  const openRun = (runId) => {
    // A finished run can be reached from Budget, Stats or History before the
    // Runs page has ever loaded its catalogue.  Resolve the full index before
    // looking up the selection, otherwise the next refresh falls back to the
    // active-only rows and loses the run the reader just opened.
    ensureCatalog();
    selectedRunId = runId;
    let index = rows.findIndex((row) => row.runId === runId);
    if (index < 0 && dashboardFilter === 'active') {
      dashboardFilter = 'all';
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      index = rows.findIndex((row) => row.runId === runId);
    }
    if (index >= 0) selected = index;
    ui.page = 'run';
    ui.focus = 0;
    ui.followActivePhase = true;
    ui.followActiveAgent = true;
    ui.detailScroll = 0;
    ui.timelineSelection = null;
    ui.foldStop = false;
    ui.runPlanBoxes = false;
    ui.runFollow = true;
    bodyScroll = 0;
    message = null;
    paint();
  };
  const switchWorkflow = (delta) => {
    const catalogue = allRows.length ? allRows : activeRuns;
    if (!catalogue.length) return paint();
    const previousFocus = ui.focus;
    const previousPhaseIndex = ui.phaseIndex;
    const currentIndex = Math.max(0, catalogue.findIndex((row) => row.runId === selectedRunId));
    const nextIndex = (currentIndex + delta + catalogue.length) % catalogue.length;
    const next = catalogue[nextIndex];
    if (!next) return paint();
    selectedRunId = next.runId;
    let visibleIndex = rows.findIndex((row) => row.runId === next.runId);
    if (visibleIndex < 0 && dashboardFilter === 'active') {
      dashboardFilter = 'all';
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      visibleIndex = rows.findIndex((row) => row.runId === next.runId);
    }
    if (visibleIndex >= 0) selected = visibleIndex;
    if (ui.page === 'run' || ui.page === 'step') {
      const nextRow = detailRow(bullswarmDir, next.runId);
      if (nextRow.legacy) {
        ui.focus = 0;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      const nextModel = workflowPanelModel(nextRow, {
        phaseIndex: previousPhaseIndex,
        agentIndex: ui.agentIndex,
      });
      ui.followActivePhase = false;
      ui.followActiveAgent = false;
      const phaseExists = previousPhaseIndex == null || previousPhaseIndex < nextModel.phases.length;
      if (previousFocus > 0 && !phaseExists) {
        ui.focus = 0;
        ui.phaseIndex = nextModel.phaseIndex;
        ui.agentIndex = nextModel.agentIndex;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      ui.phaseIndex = previousFocus === 0 ? nextModel.phaseIndex
        : clamp(previousPhaseIndex ?? nextModel.phaseIndex, 0, nextModel.phases.length - 1);
      const agents = workflowPanelModel(nextRow, { phaseIndex: ui.phaseIndex }).agents;
      ui.agentIndex = ui.focus < 2 ? nextModel.agentIndex
        : clamp(ui.agentIndex ?? nextModel.agentIndex, 0, Math.max(0, agents.length - 1));
      ui.detailScroll = 0;
      ui.timelineSelection = null;
      ui.foldStop = false;
    }
    message = null;
    paint();
  };
  /**
   * The Run timeline's fold line opens the phases it stands for, and the
   * `click to fold` line that closes them folds them back. A click and Enter
   * on the cursor come here; the cursor stays on the line just used.
   */
  const toggleFold = (runId) => {
    if (!runId) return paint();
    const narrow = output.columns < 100 && ui.mobileTimeline;
    if (ui.foldOpen.has(runId)) {
      ui.foldOpen.delete(runId);
      ui.foldStop = false;
      if (narrow) ui.timelineSelection = 'fold';
    } else {
      ui.foldOpen.add(runId);
      ui.foldStop = true;
      if (ui.timelineSelection === 'fold') ui.timelineSelection = null;
    }
    message = null;
    return paint();
  };
  /** Opens the Step page on one action and, when named, one exact attempt. */
  const openStep = (actionId, runId = null, attemptOrdinal = null) => {
    if (runId && runId !== selectedRunId) selectedRunId = runId;
    const row = detailRow(bullswarmDir, selectedRunId);
    if (!row.legacy) {
      const panel = workflowPanelModel(row);
      const phaseIndex = panel.phases.findIndex((phase) => phase.actions.some((action) => action.id === actionId));
      if (phaseIndex >= 0) {
        ui.phaseIndex = phaseIndex;
        const agentIndex = workflowPanelModel(row, { phaseIndex }).agents
          .findIndex((agent) => agent.action.id === actionId);
        if (agentIndex >= 0) ui.agentIndex = agentIndex;
      }
      ui.followActivePhase = false;
      ui.followActiveAgent = false;
    }
    ui.page = 'step';
    ui.focus = 2;
    ui.detailScroll = 0;
    ui.stepDetail = false;
    ui.stepView = 'overview';
    ui.stepExpandedTurn = null;
    ui.stepTurnIndex = null;
    ui.stepSection = 'activity';
    ui.stepSelectedEventIndex = null;
    ui.stepAttemptOrdinal = Number.isInteger(attemptOrdinal) && attemptOrdinal > 0 ? attemptOrdinal : null;
    ui.stepFollow = true;
    ui.stepFilter = 'all';
    ui.stepToolPage = 0;
    ui.stepWindowEnd = null;
    bodyScroll = 0;
    paint();
  };
  /** Opens the compact detail page for one standalone task. */
  const openTask = (taskId) => {
    const found = [...(tasks.inflight ?? []), ...(tasks.finished ?? [])]
      .find((entry) => taskKey(entry) === taskId);
    if (!found) {
      message = 'That task is no longer in the ledger.';
      return paint();
    }
    selectedTaskId = taskId;
    ui.page = 'task';
    ui.focus = 0;
    bodyScroll = 0;
    ui.stepDetail = false;
    ui.stepView = 'overview';
    ui.stepExpandedTurn = null;
    ui.stepTurnIndex = null;
    ui.stepSection = 'activity';
    ui.stepSelectedEventIndex = null;
    ui.stepAttemptOrdinal = null;
    ui.stepFollow = true;
    ui.stepFilter = 'all';
    ui.stepToolPage = 0;
    ui.stepWindowEnd = null;
    message = null;
    return paint();
  };
  /**
   * Keep the Step page's cursor row on screen: the transcript is a long page,
   * so a cursor that walks past the window scrolls it along.
   */
  const revealStepCursor = () => {
    const frame = paint();
    const y = frame?.anchor?.step?.cursor;
    if (!Number.isInteger(y) || !frame?.body) return frame;
    const offset = frame.body.offset ?? 0;
    const capacity = Math.max(1, (frame.body.end ?? 1) - offset);
    let next = null;
    if (y <= offset) next = y - 1;
    // An opened row keeps a few of its fields in view under it.
    else if (y > offset + capacity - (ui.stepDetail ? Math.min(6, capacity - 1) : 0)) next = y - Math.max(1, ui.stepDetail ? 3 : capacity);
    if (next == null) return frame;
    bodyScroll = Math.max(0, next);
    return paint();
  };
  /**
   * The Step page's `overview · detail` toggle, from `v`, the activity rule or the
   * fold line. Detail opens on the turn the overview's cursor was on (the
   * newest, unless the reader moved), or at the top from the fold line.
   */
  const setStepView = (view, { fromFold = false } = {}) => {
    const next = view === 'detail' ? 'detail' : 'overview';
    const stepAnchor = lastFrameResult?.anchor?.step ?? null;
    const cursorTurn = Number.isInteger(ui.stepTurnIndex) ? ui.stepTurnIndex : null;
    ui.stepView = next;
    ui.stepDetail = false;
    ui.stepExpandedTurn = null;
    ui.stepToolPage = 0;
    ui.stepSection = 'activity';
    if (next === 'overview') {
      ui.stepSelectedEventIndex = null;
      if (ui.stepTurnIndex === -1) ui.stepTurnIndex = null;
      bodyScroll = 0;
      return paint();
    }
    const head = !fromFold && cursorTurn != null && cursorTurn >= 0
      ? (stepAnchor?.rows ?? []).find((row) => row.kind === 'turn' && row.turnIndex === cursorTurn)
      : null;
    ui.stepSelectedEventIndex = head?.index ?? null;
    bodyScroll = 0;
    const frame = paint();
    const y = frame?.anchor?.step?.cursor;
    if (!head || !Number.isInteger(y)) return frame;
    bodyScroll = Math.max(0, y - 2);
    return paint();
  };
  /** Opens a page, reading whatever that page needs the first time. */
  const openPage = (page, { pool = null } = {}) => {
    if (!DASHBOARD_PAGES.includes(page)) return paint();
    if (page !== 'stats') clearSliceState();
    const historyJump = page === 'history';
    if (historyJump) page = 'runs';
    if (page === 'runs') {
      ensureCatalog();
      // Runs is a fresh list entry point: an old Home/Stats selection must
      // not steal the cursor from the first in-flight row.  The active list is
      // already sorted newest-first by activeDashboardRows().
      selectedTaskId = null;
      selectedRunId = activeRuns[0]?.runId ?? null;
    }
    if ((page === 'run' || page === 'step') && !selectedRunId) {
      message = 'No workflow selected.';
      ui.page = 'home';
      return paint();
    }
    ui.page = page;
    ui.budgetPool = page === 'budget' ? (pool ? String(pool) : null) : null;
    ui.focus = page === 'step' ? 2 : 0;
    bodyScroll = 0;
    message = null;
    const frame = paint();
    if (historyJump) {
      bodyScroll = Math.max(0, (frame?.anchor?.history ?? 1) - 1);
      selectedRunId = frame?.runRows?.find((row) => row.y > bodyScroll)?.runId ?? selectedRunId;
      return paint();
    }
    // When no active run exists, the first visible row comes from the history
    // projection (or the task ledger).  Persist that rendered cursor so Up on
    // the first row remains clamped there and Enter opens exactly that row.
    if (page === 'runs' && frame?.cursorAction) {
      const cursor = frame.cursorAction;
      if (cursor.kind === 'task') {
        if (selectedTaskId !== cursor.taskId || selectedRunId != null) {
          selectedTaskId = cursor.taskId;
          selectedRunId = null;
          return paint();
        }
      } else if (cursor.kind === 'run' && selectedRunId !== cursor.runId) {
        selectedRunId = cursor.runId;
        selectedTaskId = null;
        return paint();
      }
    }
    return frame;
  };
  /** Esc and the left arrow walk out: step to run, every other page to Home. */
  const moveOut = () => {
    if (ui.page === 'task') {
      ui.page = 'runs';
      ui.focus = 0;
      bodyScroll = 0;
      ensureCatalog();
      return paint();
    }
    if (ui.page === 'step') {
      ui.page = 'run';
      ui.focus = 0;
      ui.detailScroll = 0;
      return paint();
    }
    if (ui.orchestratorDetail) {
      ui.orchestratorDetail = false;
      ui.orchestratorVerbose = false;
      ui.focus = 0;
      ui.controlSelected = output.columns >= 100;
      if (output.columns < 100 && ui.mobileTimeline) ui.timelineSelection = 0;
      ui.detailScroll = 0;
      return paint();
    }
    if (ui.workflowVerbose) {
      ui.workflowVerbose = false;
      ui.detailScroll = 0;
      return paint();
    }
    if (ui.page === 'run' && ui.focus > 0) {
      ui.focus -= 1;
      if (ui.focus === 0 && output.columns < 100 && ui.mobileTimeline) ui.timelineSelection = (ui.phaseIndex ?? 0) + 1;
      return paint();
    }
    ui.page = 'home';
    ui.focus = 0;
    bodyScroll = 0;
    return paint();
  };
  /**
   * History loads seven more days each time the reader nears the bottom of
   * what it already has, the way the prototype does. The frame reports how
   * tall its body was, so "near the bottom" is measured, not guessed.
   */
  const loadMoreHistory = () => {
    if (!['runs', 'history'].includes(ui.page) || ui.historyDays >= MAX_HISTORY_DAYS) return;
    const body = lastFrameResult?.body;
    if (body && body.end < body.total - 2) return;
    ui.historyDays = Math.min(MAX_HISTORY_DAYS, ui.historyDays + 7);
    try { days = historyDays(bullswarmDir, { days: ui.historyDays, tasks: tasks.finished }); } catch { /* keep what we have */ }
    // The next index read must not skip the wider window we just asked for.
    rollupFingerprint = null;
  };
  // The wheel: up walks back through whatever is above the window, down walks
  // on. The boxed panel counts rows back from its newest event; every page
  // body, Run v2's included, counts the first visible row.
  const scrollActivePage = (delta) => {
    if (ui.page === 'run' && (ui.orchestratorDetail || ui.workflowVerbose)) {
      ui.detailScroll = Math.max(0, ui.detailScroll + delta);
      return paint();
    }
    bodyScroll = Math.max(0, bodyScroll - delta);
    if (delta < 0) loadMoreHistory();
    return paint();
  };
  // The same install `bullswarm integrate install --yes` runs, in-process and
  // without a shell: every agent, judged by content, reported where it ran.
  const runInstall = () => {
    try {
      installResult = installIntegration({ approved: true, homeDir });
      integration = installResult.status;
      message = integration?.ok
        ? 'Agent integration installed.'
        : 'Agent integration is incomplete; see the results under the status.';
    } catch (err) { message = `install failed: ${err.message}`; }
    return paint();
  };
  const spin = () => {
    ui.spinnerFrame = (ui.spinnerFrame + 1) % glyphs().spinner.length;
    if (ui.page !== 'home' || activeRuns.length) paint();
  };
  /**
   * ctrl+s: the painted screen as plain text, through OSC 52 so it reaches
   * the clipboard of whatever machine the terminal is on. A payload past the
   * sequence limit most terminals accept, or an output that refuses the
   * write, falls back to pbcopy or wl-copy — and the message says which one
   * actually carried it.
   */
  const copyScreen = () => {
    const text = (lastFrameResult?.lines ?? [])
      .map((line) => String(line).replace(ANSI_SGR, '').replace(/\s+$/, ''))
      .join('\n');
    const payload = Buffer.from(text, 'utf8').toString('base64');
    if (payload.length <= OSC52_LIMIT) {
      try {
        output.write(`${OSC}52;c;${payload}${BEL}`);
        lastPaintedFrame = null;
        message = `screen copied (OSC 52) · ${text.split('\n').length} lines`;
        return paint();
      } catch { /* the terminal refused it; fall back to a local clipboard */ }
    }
    const result = clipboard(text);
    lastPaintedFrame = null;
    message = result?.ok
      ? `screen copied (${result.tool})`
      : `copy failed · ${result?.reason ?? 'no OSC 52, and no pbcopy or wl-copy on this machine'}`;
    return paint();
  };
  // Switching Fleet's grouping brings the table into view: on a machine with
  // several pools the windows alone fill the page, and a tab that changed
  // something the reader cannot see reads as a tab that did nothing.
  const showTab = (tab) => {
    if (ui.page === 'fleet' && FLEET_TABS.includes(tab)) ui.fleetBy = tab;
    else if (STATS_TABS.includes(tab)) { clearSliceState(); ui.page = 'stats'; ui.statsTab = tab; bodyScroll = 0; }
    else if (FLEET_TABS.includes(tab)) { ui.page = 'fleet'; ui.fleetBy = tab; bodyScroll = 0; }
    else return paint();
    const frame = paint();
    const tabs = frame?.anchor?.tabs;
    if (tabs != null && tabs > 1) {
      bodyScroll = tabs - 1;
      paint();
    }
    return undefined;
  };
  /** Tab: the next sub-tab of whatever page has them. */
  const nextTab = () => {
    if (ui.page === 'stats') {
      clearSliceState();
      const at = STATS_TABS.indexOf(ui.statsTab);
      ui.statsTab = STATS_TABS[(at + 1) % STATS_TABS.length];
      bodyScroll = 0;
      return paint();
    }
    if (ui.page === 'fleet') {
      const at = FLEET_TABS.indexOf(ui.fleetBy);
      return showTab(FLEET_TABS[(at + 1) % FLEET_TABS.length]);
    }
    message = 'Tab walks the sub-tabs on Stats and Fleet; this page has none.';
    return paint();
  };
  /** p: the next period, on every page that is drawn over one. */
  const nextPeriod = () => {
    clearSliceState();
    const at = PERIODS.indexOf(ui.period);
    ui.period = PERIODS[(at + 1) % PERIODS.length];
    message = `Period · ${PERIOD_ITEMS.find((item) => item.id === ui.period)?.label ?? ui.period}`;
    return paint();
  };
  const scrollToEnd = () => {
    bodyScroll = Math.max(0, ((lastFrameResult?.lines?.length ?? 24) + 1) * 40);
    const frame = paint();
    loadMoreHistory();
    return frame;
  };
  // `[edit]`: hand the terminal to the same control centre `bullswarm setup`
  // opens, then take it back and re-read the rungs the setup may have changed.
  const runEdit = async () => {
    const openSetup = openSetupTui ?? openSetupControlCentre;
    clearInterval(timer);
    clearInterval(spinnerTimer);
    input.removeListener('data', onData);
    output.removeListener?.('resize', onResize);
    input.setRawMode?.(false);
    input.pause?.();
    output.write(`${ESC}?1006l${ESC}?1003l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    try {
      await openSetup({ bullswarmDir, input, output });
    } catch (err) {
      message = `setup error: ${err.message}`;
    } finally {
      output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H${ESC}?1000h${ESC}?1003h${ESC}?1006h`);
      input.setRawMode?.(true);
      input.resume?.();
      input.on('data', onData);
      output.on?.('resize', onResize);
      lastPaintedFrame = null;
      timer = setInterval(refresh, refreshMs);
      timer.unref?.();
      spinnerTimer = setInterval(spin, Math.max(50, Number(spinnerMs) || 400));
      spinnerTimer.unref?.();
      readUsage();
      ui.page = 'fleet';
      ui.focus = 0;
      bodyScroll = 0;
      paint();
    }
  };
  const bucketDayKey = (value) => {
    const source = String(value ?? '');
    return /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : dayKey(value);
  };
  const historyDateLabel = (key) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    if (!Number.isFinite(date.getTime())) return null;
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
  };
  const openTrendBucket = (action) => {
    const target = bucketDayKey(action.bucket);
    const today = bucketDayKey(dayKey(Date.now()));
    if (target && today) {
      const parseKey = (key) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
        return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
      };
      const targetMs = parseKey(target);
      const todayMs = parseKey(today);
      if (targetMs != null && todayMs != null && targetMs <= todayMs) {
        const required = Math.floor((todayMs - targetMs) / 86_400_000) + 1;
        ui.historyDays = Math.min(MAX_HISTORY_DAYS, Math.max(ui.historyDays, required));
      }
    }
    ui.page = 'runs';
    ensureCatalog();
    ui.budgetPool = null;
    ui.focus = 0;
    bodyScroll = 0;
    message = null;
    try { days = historyDays(bullswarmDir, { days: ui.historyDays, tasks: tasks.finished }); }
    catch { days = []; }
    rollupFingerprint = null;
    if (target) {
      const rendered = historyLines(days, { width: frameWidth(), ansi: meterAnsi() });
      const label = historyDateLabel(target);
      const marker = label ? `── ${label} ` : null;
      const at = marker
        ? rendered.lines.findIndex((line) => String(line).replace(ANSI_SGR, '').startsWith(marker))
        : -1;
      if (at >= 0) {
        const frame = paint();
        bodyScroll = (frame?.anchor?.history ?? 1) - 1 + at;
      } else message = `History bucket ${target} is outside loaded history.`;
    }
    return paint();
  };
  /** Every click runs the same action its key runs. */
  const runAction = (action) => {
    if (!action) return undefined;
    if (action.kind === 'slice') {
      // A slice is a presentation target, not a navigation target. Keep its
      // durable chart values in the action so a repaint cannot recalculate a
      // different percentage from a changed rollup while it is pinned.
      slicePinned = action;
      sliceHover = action;
      return paint();
    }
    if (action.kind === 'page') return openPage(action.page, { pool: action.pool ?? null });
    if (action.kind === 'run') return openRun(action.runId);
    if (action.kind === 'task') return openTask(action.taskId);
    if (action.kind === 'step') return openStep(action.actionId, action.runId ?? null, action.attemptOrdinal ?? null);
    if (action.kind === 'fold') return toggleFold(action.runId ?? selectedRunId);
    if (action.kind === 'stepView') return setStepView(action.view, { fromFold: action.fromFold === true });
    if (action.kind === 'stepTurn') {
      // A click on a turn head is Enter on that turn (step-v2 rule 14).
      const head = (lastFrameResult?.anchor?.step?.rows ?? [])
        .find((row) => row.kind === 'turn' && row.turnIndex === action.turnIndex);
      ui.stepSection = 'activity';
      ui.stepTurnIndex = action.turnIndex;
      ui.stepExpandedTurn = ui.stepExpandedTurn === action.turnIndex ? null : action.turnIndex;
      ui.stepToolPage = 0;
      ui.stepSelectedEventIndex = head?.index ?? ui.stepSelectedEventIndex;
      ui.stepFollow = false;
      return paint();
    }
    if (action.kind === 'stepTool') {
      // A click on a transcript row selects it and opens its captured fields;
      // a second click closes them, as Enter does.
      ui.stepSection = 'activity';
      if (ui.stepSelectedEventIndex != null && Number(ui.stepSelectedEventIndex) === Number(action.eventIndex)) ui.stepDetail = !ui.stepDetail;
      else {
        ui.stepSelectedEventIndex = action.eventIndex;
        ui.stepDetail = true;
      }
      ui.stepFollow = false;
      return revealStepCursor();
    }
    if (action.kind === 'back') return moveOut();
    if (action.kind === 'install') return runInstall();
    if (action.kind === 'tab') return showTab(action.tab);
    if (action.kind === 'stackBy') {
      clearSliceState();
      if (ui.page === 'stats') ui.statsStackBy = action.statsStackBy === 'model' || action.stackBy === 'model' ? 'model' : 'pool';
      return paint();
    }
    if (action.kind === 'trend') {
      clearSliceState();
      if (PERIODS.includes(action.period)) ui.period = action.period;
      if (action.bucket != null) return openTrendBucket(action);
      ui.page = 'stats';
      ui.statsTab = 'spending';
      if (TREND_METRICS.includes(action.metric)) ui.metric = action.metric;
      bodyScroll = 0;
      return paint();
    }
    if (action.kind === 'period') {
      clearSliceState();
      if (PERIODS.includes(action.period)) ui.period = action.period;
      return paint();
    }
    if (action.kind === 'metric') {
      clearSliceState();
      if (TREND_METRICS.includes(action.metric)) ui.metric = action.metric;
      return paint();
    }
    if (action.kind === 'top') { bodyScroll = 0; ui.detailScroll = 0; return paint(); }
    if (action.kind === 'end') return scrollToEnd();
    if (action.kind === 'edit') { void runEdit(); return undefined; }
    if (action.kind === 'quit') return finish();
    return undefined;
  };
  // Only list rows light up — a run in a table, a step or phase in a plan.
  // Chart columns, tiles, meters, tabs and toggles are click targets too, but
  // reverse-painting a chart row destroys its colours and tells the reader
  // nothing a cursor would not.
  // A Step turn head and a transcript row are list rows too, and so are the
  // words of the activity rule's `overview · detail` toggle (rule 14): the
  // hover lights the word's text, never the dashes around it.
  const HOVER_KINDS = new Set(['run', 'step', 'task', 'stepTurn', 'stepTool', 'stepView']);
  const regionAt = (x, y) => regions.find((region) => y === region.y && x >= region.x1 && x <= region.x2
    && region.action && HOVER_KINDS.has(region.action.kind));
  // A stacked chart paints its total-column hit region before its per-slice
  // regions.  Prefer the slice (then a panel share) when the pointer lands on
  // overlapping cells; the total remains the fallback for an unstacked bar.
  const sliceRegionAt = (x, y) => regions
    .filter((region) => y === region.y && x >= region.x1 && x <= region.x2 && region.action?.kind === 'slice')
    .sort((left, right) => {
      const rank = (region) => {
        const kind = region.action?.payload?.kind;
        return kind === 'slice' ? 0 : kind === 'share' ? 1 : 2;
      };
      return rank(left) - rank(right);
    })[0] ?? null;
  const sliceKey = (action) => action?.kind === 'slice'
    ? [action.tab, action.metric, action.period, action.bucket, action.series,
      action.payload?.kind, action.payload?.label].join('|')
    : '';
  const sameSlice = (left, right) => sliceKey(left) === sliceKey(right);
  const hoverMove = (mouse) => {
    const sliceRegion = sliceRegionAt(mouse.x, mouse.y) ?? null;
    const nextSlice = sliceRegion?.action ?? null;
    let sliceChanged = false;
    if (!slicePinned && !sameSlice(nextSlice, sliceHover)) {
      sliceHover = nextSlice;
      sliceChanged = true;
    }
    const region = regionAt(mouse.x, mouse.y) ?? null;
    const next = region ? { y: region.y, x1: region.x1, x2: region.x2 } : null;
    const same = (next == null && hover == null)
      || (next && hover && next.y === hover.y && next.x1 === hover.x1 && next.x2 === hover.x2);
    if (!same) hover = next;
    if (sliceChanged) return paint();
    if (same) return undefined;
    if (lastFrameText != null) writeFrame(lastFrameText);
    return undefined;
  };
  const handleMouse = (mouse) => {
    if (mouse.kind === 'wheel-up') return scrollActivePage(3);
    if (mouse.kind === 'wheel-down') return scrollActivePage(-3);
    if (mouse.kind === 'move') return hoverMove(mouse);
    if (mouse.kind !== 'press') return undefined;
    const region = sliceRegionAt(mouse.x, mouse.y) ?? regions.find((entry) => mouse.y === entry.y
      && mouse.x >= entry.x1 && mouse.x <= entry.x2);
    const action = region?.action;
    if (action?.kind === 'slice') return runAction(action);
    if (slicePinned || sliceHover) {
      slicePinned = null;
      sliceHover = null;
      if (!action) return paint();
    }
    return runAction(action);
  };
  // Every way out releases the mouse before it leaves the alternate screen,
  // so the terminal is never left reporting clicks to a dead dashboard.
  let finished = false;
  let resolveDashboard = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearInterval(spinnerTimer);
    input.setRawMode?.(false);
    input.pause?.();
    input.removeListener('data', onData);
    output.removeListener?.('resize', onResize);
    output.write(`${ESC}?1006l${ESC}?1003l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    resolveDashboard?.(0);
  };
  const moveVertical = (delta) => {
    if (ui.page === 'home') {
      const listed = [
        ...(lastFrameResult?.runRows ?? []).map((row) => ({ ...row, kind: 'run' })),
        ...(lastFrameResult?.taskRows ?? []).map((row) => ({ ...row, kind: 'task' })),
      ].sort((a, b) => a.y - b.y);
      if (listed.length) {
        const at = listed.findIndex((entry) => entry.kind === 'task'
          ? selectedTaskId != null && entry.taskId === selectedTaskId
          : !selectedTaskId && entry.runId === selectedRunId);
        const wanted = at < 0 ? (delta > 0 ? 0 : listed.length - 1) : at + delta;
        // Once the cursor reaches the end of the Home list, keep the old
        // page-scroll affordance working as well. This matters for the rest
        // of Home below the today band (running, budget and trends), while a
        // cursor still moves through every today row first.
        if (wanted < 0 || wanted >= listed.length) {
          bodyScroll = Math.max(0, bodyScroll + delta);
          return paint();
        }
        const target = listed[wanted];
        if (target) {
          if (target.kind === 'task') selectedTaskId = target.taskId;
          else { selectedTaskId = null; selectedRunId = target.runId; }
          return paint();
        }
      }
      bodyScroll = Math.max(0, bodyScroll + delta);
      return paint();
    }
    if (ui.page === 'runs') {
      const listed = [
        ...(lastFrameResult?.runRows ?? []).map((row) => ({ ...row, kind: 'run' })),
        ...(lastFrameResult?.taskRows ?? []).map((row) => ({ ...row, kind: 'task' })),
      ].sort((a, b) => a.y - b.y);
      const at = listed.findIndex((entry) => entry.kind === 'task'
        ? selectedTaskId != null && entry.taskId === selectedTaskId
        : !selectedTaskId && entry.runId === selectedRunId);
      const target = listed[clamp(at < 0 ? (delta > 0 ? 0 : listed.length - 1) : at + delta, 0, Math.max(0, listed.length - 1))];
      if (target) {
        if (target.kind === 'task') selectedTaskId = target.taskId;
        else { selectedTaskId = null; selectedRunId = target.runId; }
        const capacity = Math.max(1, (lastFrameResult?.body.end ?? 1) - (lastFrameResult?.body.offset ?? 0));
        if (target.y <= bodyScroll) bodyScroll = target.y - 1;
        else if (target.y > bodyScroll + capacity) bodyScroll = target.y - capacity;
      } else bodyScroll = Math.max(0, bodyScroll + delta);
      if (delta > 0) loadMoreHistory();
      return paint();
    }
    if (ui.page !== 'run' && ui.page !== 'step') {
      bodyScroll = Math.max(0, bodyScroll + delta);
      if (delta > 0) loadMoreHistory();
      return paint();
    }
    const row = detailRow(bullswarmDir, selectedRunId);
    const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
    const narrowTimeline = output.columns < 100 && ui.mobileTimeline && ui.focus === 0;
    if (ui.orchestratorDetail || ui.workflowVerbose || narrowTimeline) {
      if (narrowTimeline) {
        const visibleSegments = new Set(workflowTimelineLines(model, Math.max(20, frameWidth() - 2), 0, { foldOpen: ui.foldOpen.has(selectedRunId) }).lines
          .filter((line) => line?.header)
          .map((line) => line.segment));
        const range = row?.state ? runTimelineFold(row) : null;
        const foldShown = range && !ui.foldOpen.has(selectedRunId);
        const navigable = [
          ...(visibleSegments.has('Preflight') ? [{ selection: 0, phaseIndex: null }] : []),
          ...model.phases
            .map((phase, index) => ({ phase, selection: index + 1, phaseIndex: index }))
            .filter(({ phase }) => visibleSegments.has(phase.label)),
        ];
        // The fold line is a stop of its own, between the phases either side of it.
        if (foldShown) {
          const before = navigable.filter((target) => target.phaseIndex == null || target.phaseIndex < range.start).length;
          navigable.splice(before, 0, { selection: 'fold', phaseIndex: null });
        }
        if (navigable.length) {
          let current = navigable.findIndex((target) => target.selection === ui.timelineSelection);
          // Off the `click to fold` line, Up lands on the last phase it closes
          // and Down on the phase after it.
          if (ui.foldStop && current < 0 && range) {
            const last = navigable.findIndex((target) => target.phaseIndex === range.end - 1);
            if (last >= 0) current = delta > 0 ? last : last + 1;
          }
          const base = current >= 0 ? current : (delta < 0 ? navigable.length : -1);
          const target = navigable[clamp(base + delta, 0, navigable.length - 1)];
          ui.foldStop = false;
          ui.timelineSelection = target.selection;
          if (target.phaseIndex != null) {
            ui.followActivePhase = false;
            ui.phaseIndex = target.phaseIndex;
            ui.agentIndex = null;
            ui.followActiveAgent = true;
          }
          ui.detailScroll = 0;
        }
      } else ui.detailScroll = Math.max(0, ui.detailScroll + delta);
      return paint();
    }
    if (ui.focus === 0) {
      if (model.orchestrator.autonomous && ui.controlSelected) {
        if (delta > 0) {
          ui.controlSelected = false;
          ui.followActivePhase = false;
          ui.phaseIndex = 0;
        }
        return paint();
      }
      if (model.orchestrator.autonomous && delta < 0 && model.phaseIndex === 0) {
        ui.controlSelected = true;
        ui.detailScroll = 0;
        return paint();
      }
      ui.foldStop = false;
      ui.followActivePhase = false;
      ui.phaseIndex = clamp(model.phaseIndex + delta, 0, model.phases.length - 1);
      ui.agentIndex = null;
      ui.followActiveAgent = true;
      ui.detailScroll = 0;
    } else if (ui.focus === 1) {
      ui.followActiveAgent = false;
      ui.agentIndex = clamp(model.agentIndex + delta, 0, Math.max(0, model.agents.length - 1));
      ui.detailScroll = 0;
    } else {
      ui.detailScroll = Math.max(0, ui.detailScroll + delta);
    }
    return paint();
  };
  const requestSelectedCancel = () => {
    const target = selectedRunId;
    if (!target) { message = 'No workflow selected.'; return paint(); }
    try {
      const result = requestCancel(bullswarmDir, target, { source: 'interactive-tui' });
      message = result.alreadyFinished
        ? 'That workflow has already finished.'
        : `Stop requested for ${result.shortId ?? result.runId}.`;
      ui.confirmCancel = false;
      refresh();
    } catch (err) { message = err.message; ui.confirmCancel = false; paint(); }
  };
  /** Enter: open the selected run, then its agents, then the selected step. */
  const drillIn = () => {
    if (ui.page === 'runs' || ui.page === 'home') {
      // Enter opens the row the page drew its cursor on — the same action a
      // click on that row runs — never a row found again by id: a task that
      // predates the ledger had no id, so its row matched "no task selected"
      // and Enter on a workflow row opened that task.
      const action = lastFrameResult?.cursorAction;
      if (action?.kind === 'task') return openTask(action.taskId);
      if (action?.kind === 'run') return openRun(action.runId);
      selectedRunId = ui.page === 'runs'
        ? (lastFrameResult?.runRows?.find((row) => row.runId === selectedRunId) ?? lastFrameResult?.runRows?.[0])?.runId
        : rows[selected]?.runId ?? activeRuns[0]?.runId ?? selectedRunId;
      if (!selectedRunId) {
        message = dashboardFilter === 'active'
          ? 'No active workflow selected · press a to browse recent runs.'
          : 'No workflow selected.';
        return paint();
      }
      return openRun(selectedRunId);
    }
    if (ui.page === 'task') return paint();
    if (ui.page !== 'run' && ui.page !== 'step') return paint();
    if (ui.orchestratorDetail) { message = 'Planner detail is the deepest level.'; return paint(); }
    if (ui.workflowVerbose) { message = 'Technical details are the deepest level.'; return paint(); }
    if (ui.focus === 0) {
      // The cursor on the timeline's fold line (or on the `click to fold` line
      // that closes it) toggles the fold instead of opening a step.
      if (ui.page === 'run') {
        const row = detailRow(bullswarmDir, selectedRunId);
        const range = row?.state ? runTimelineFold(row) : null;
        if (range) {
          const open = ui.foldOpen.has(selectedRunId);
          const narrow = output.columns < 100 && ui.mobileTimeline;
          const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
          const onFold = ui.foldStop
            || (!open && (narrow ? ui.timelineSelection === 'fold'
              : model.phaseIndex >= range.start && model.phaseIndex < range.end));
          if (onFold) return toggleFold(selectedRunId);
        }
      }
      if (output.columns < 100 && ui.mobileTimeline && ui.timelineSelection === 0) {
        const row = detailRow(bullswarmDir, selectedRunId);
        const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
        if (model.orchestrator.autonomous) {
          ui.orchestratorDetail = true;
          ui.orchestratorVerbose = false;
          ui.controlSelected = true;
        } else message = 'This workflow has no autonomous Workflow Planner.';
      } else {
        const row = detailRow(bullswarmDir, selectedRunId);
        const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
        const action = model.selectedPhase?.actions?.[0] ?? null;
        if (action) return openStep(action.id);
        message = 'No step belongs to this phase yet.';
      }
      return paint();
    }
    if (ui.focus === 1) {
      const row = detailRow(bullswarmDir, selectedRunId);
      const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
      const agent = model.agents[model.agentIndex] ?? null;
      if (agent) return openStep(agent.action.id);
      message = 'No agent has started in this phase yet.';
      return paint();
    }
    return paint();
  };
  const onDataUnsafe = (buf) => {
    const chunk = String(buf);
    // A mouse press runs its region's action; the sequence is never read as a
    // key. The wheel moves whatever window the page is scrolling.
    const mouse = parseMouse(chunk);
    if (mouse) handleMouse(mouse);
    const key = chunk.replace(MOUSE_SEQUENCE, '');
    if (!key) return;
    if (filterEditing) {
      if (key === '\r' || key === '\n') {
        filterEditing = false;
        message = query ? `Showing workflows matching “${query}”.` : null;
        return refresh();
      }
      if (keyPressed('out', key) || key === '') {
        filterEditing = false;
        query = '';
        message = null;
        return refresh();
      }
      if (key === '' || key === '\b') {
        query = query.slice(0, -1);
        return refresh();
      }
      if (/^[ -~]+$/.test(key)) {
        query += key;
        return refresh();
      }
      return;
    }
    // A pending stop still takes y; the Help page says so, and History's own
    // y is out of reach only while the question is on the screen.
    if (ui.confirmCancel) {
      if (key === 'y' || key === 'Y') return requestSelectedCancel();
      if (key === 'n' || key === 'N' || key === '' || key === '') {
        ui.confirmCancel = false;
        message = 'Workflow left running.';
        return paint();
      }
      return;
    }
    if (keyPressed('detach', key)) return finish();
    if (keyPressed('copy', key)) return copyScreen();
    if (keyPressed('home', key)) return openPage('home');
    if (keyPressed('help', key)) return openPage('help');
    if (keyPressed('runs', key)) return openPage('runs');
    if (keyPressed('budget', key)) return openPage('budget');
    if (keyPressed('stats', key)) return openPage('stats');
    if (keyPressed('history', key)) return openPage('history');
    // The Step page's own `f` follows its activity tail (record rule 9);
    // Fleet keeps the key everywhere else.
    if (keyPressed('fleet', key) && ui.page !== 'step' && ui.page !== 'task') return openPage('fleet');
    // `p` and Tab are global dashboard bindings elsewhere, but on Step/task they
    // are the page's prompt and section navigation. Handle them before the
    // period/sub-tab dispatch below; the remaining Step keys are handled in
    // the fuller branch after Home/End have had their normal precedence.
    const stepLikePage = ui.page === 'step' || ui.page === 'task';
    if (stepLikePage && (key === 'p' || key === '\t' || key === '\x1b[Z')) {
      if (key === 'p') ui.stepSection = 'prompt';
      else {
        const at = STEP_SECTIONS.indexOf(ui.stepSection);
        const delta = key === '\x1b[Z' ? -1 : 1;
        ui.stepSection = STEP_SECTIONS[(at + delta + STEP_SECTIONS.length) % STEP_SECTIONS.length];
      }
      ui.stepDetail = false;
      bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.[ui.stepSection] ?? 1) - 1);
      // Preserve the shell's long-standing sibling-workflow affordance too;
      // the Step region has already advanced, so callers that inspect the
      // local section still observe the design's reverse traversal.
      if (key === '\x1b[Z' && (allRows.length > 1 || activeRuns.length > 1)) return switchWorkflow(1);
      return paint();
    }
    if (ui.page === 'run' && key === 'p') {
      ui.runPlanBoxes = !ui.runPlanBoxes;
      return paint();
    }
    if (ui.page === 'run' && key === ' ') {
      ui.runFollow = !ui.runFollow;
      return paint();
    }
    if (keyPressed('period', key)) return nextPeriod();
    if (keyPressed('nextTab', key)) return nextTab();
    if (keyPressed('cycleWorkflow', key)) return switchWorkflow(1);
    if (keyPressed('top', key)) { bodyScroll = 0; ui.detailScroll = 0; return paint(); }
    if (keyPressed('end', key)) return scrollToEnd();
    // Step/task owns a small, page-local reader: arrows select captured events
    // retry attempts, Enter opens the selected event, Tab cycles sections,
    // Space follows the stream, and e/t choose the evidence filters. Keep it
    // before the dashboard-wide p/o/t bindings so those keys cannot steal a
    // Step interaction; q, Home, End and ? have already been handled above.
    if (stepLikePage) {
      const taskRecord = ui.page === 'task'
        ? [...(tasks.inflight ?? []), ...(tasks.finished ?? [])]
          .find((entry) => taskKey(entry) === selectedTaskId) ?? null
        : null;
      const row = ui.page === 'step' ? detailRow(bullswarmDir, selectedRunId) : null;
      const step = ui.page === 'task'
        ? taskStepModel(taskRecord, {
          nowMs: Date.now(),
          view: ui.stepView,
          expandedTurn: ui.stepExpandedTurn,
          selectedEventIndex: ui.stepSelectedEventIndex,
          attemptOrdinal: ui.stepAttemptOrdinal,
          activityFilter: ui.stepFilter,
          follow: ui.stepFollow,
        })
        : stepPageModel(row, {
          phaseIndex: ui.phaseIndex,
          agentIndex: ui.agentIndex,
          selectedEventIndex: ui.stepSelectedEventIndex,
          attemptOrdinal: ui.stepAttemptOrdinal,
          activityFilter: ui.stepFilter,
          follow: ui.stepFollow,
          view: ui.stepView,
          expandedTurn: ui.stepExpandedTurn,
        });
      const activityIndices = step.activity?.visibleEventIndices ?? [];
      const attempts = step.attemptHistory ?? [];
      const moveSelection = (delta) => {
        if (ui.stepSection === 'attempts') {
          if (!attempts.length) return;
          const at = attempts.findIndex((attempt) => Number(attempt.ordinal) === Number(ui.stepAttemptOrdinal ?? step.selectedAttempt?.ordinal));
          const next = clamp((at < 0 ? (delta > 0 ? -1 : attempts.length) : at) + delta, 0, attempts.length - 1);
          ui.stepAttemptOrdinal = attempts[next]?.ordinal ?? null;
          ui.stepFollow = false;
          ui.stepDetail = false;
          return;
        }
        const turns = step.activity?.turns ?? [];
        const stepAnchor = lastFrameResult?.anchor?.step ?? null;
        if (ui.stepView === 'overview' && turns.length) {
          // The stops are what the overview shows: the fold line (-1), then the
          // window's turns. The cursor starts on the newest of them.
          const shown = stepAnchor?.view === 'overview'
            ? (stepAnchor.rows ?? []).map((row) => (row.kind === 'fold' ? -1 : row.turnIndex)).filter(Number.isInteger)
            : [];
          const stops = shown.length ? shown : turns.map((turn) => turn.index);
          const current = Number.isInteger(ui.stepTurnIndex) && stops.includes(ui.stepTurnIndex)
            ? ui.stepTurnIndex
            : Number.isInteger(stepAnchor?.cursorTurn) && stops.includes(stepAnchor.cursorTurn)
              ? stepAnchor.cursorTurn
              : stops.at(-1);
          // Down from the newest turn a pinned window shows slides it one turn
          // onto the turns that arrived since.
          const windowEnd = stepAnchor?.windowEnd;
          if (delta > 0 && current === stops.at(-1) && Number.isInteger(windowEnd) && windowEnd < turns.length) {
            ui.stepWindowEnd = windowEnd + 1;
            ui.stepTurnIndex = windowEnd;
            ui.stepSelectedEventIndex = turns[windowEnd]?.responseIndex ?? null;
            ui.stepFollow = false;
            ui.stepToolPage = 0;
            return;
          }
          const next = stops[clamp(stops.indexOf(current) + delta, 0, stops.length - 1)];
          ui.stepTurnIndex = next;
          ui.stepSelectedEventIndex = next >= 0 ? turns[next]?.responseIndex ?? null : null;
          ui.stepFollow = false;
          ui.stepToolPage = 0;
          return;
        }
        if (ui.stepView === 'detail') {
          // The transcript's stops: each turn head and each tool row, in page
          // order. With no cursor yet it starts on the first (Down) or last
          // (Up) row on screen.
          const stops = stepAnchor?.view === 'detail' ? (stepAnchor.rows ?? []).filter((row) => row.index != null) : [];
          if (!stops.length) return;
          const at = ui.stepSelectedEventIndex == null ? -1
            : stops.findIndex((row) => Number(row.index) === Number(ui.stepSelectedEventIndex));
          let target;
          if (at < 0) {
            const top = lastFrameResult?.body?.offset ?? 0;
            const end = lastFrameResult?.body?.end ?? Infinity;
            const inView = stops.filter((row) => row.y > top && row.y <= end);
            target = (delta > 0 ? inView[0] : inView.at(-1)) ?? (delta > 0 ? stops[0] : stops.at(-1));
          } else target = stops[clamp(at + delta, 0, stops.length - 1)];
          ui.stepSelectedEventIndex = target.index;
          ui.stepFollow = false;
          ui.stepDetail = false;
          return;
        }
        if (!activityIndices.length) return;
        const at = activityIndices.findIndex((index) => Number(index) === Number(ui.stepSelectedEventIndex ?? step.activity?.selectedIndex));
        const next = clamp((at < 0 ? (delta > 0 ? -1 : activityIndices.length) : at) + delta, 0, activityIndices.length - 1);
        ui.stepSelectedEventIndex = activityIndices[next] ?? null;
        ui.stepFollow = false;
        ui.stepDetail = false;
      };
      if (keyPressed('up', key)) { moveSelection(-1); return ui.stepSection === 'attempts' ? paint() : revealStepCursor(); }
      if (keyPressed('down', key)) { moveSelection(1); return ui.stepSection === 'attempts' ? paint() : revealStepCursor(); }
      if (key === '\t' || key === '\x1b[Z') {
        const at = STEP_SECTIONS.indexOf(ui.stepSection);
        const delta = key === '\x1b[Z' ? -1 : 1;
        ui.stepSection = STEP_SECTIONS[(at + delta + STEP_SECTIONS.length) % STEP_SECTIONS.length];
        ui.stepDetail = false;
        bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.[ui.stepSection] ?? 1) - 1);
        return paint();
      }
      if (key === '\r' || key === '\n') {
        if (ui.stepSection === 'activity' && ui.stepView === 'overview' && ui.stepTurnIndex === -1) {
          // Enter on `turns 1–N · … · click for detail` opens the transcript.
          return setStepView('detail', { fromFold: true });
        }
        if (ui.stepSection === 'activity' && ui.stepView === 'detail') {
          // Enter opens (or closes) every captured field of the row under the
          // cursor; with no cursor yet it first lands on the row on screen.
          if (ui.stepSelectedEventIndex == null) moveSelection(1);
          else ui.stepDetail = !ui.stepDetail;
          return revealStepCursor();
        }
        if (ui.stepSection === 'activity' && ui.stepView === 'overview' && step.activity?.turns?.length) {
          const cursorTurn = lastFrameResult?.anchor?.step?.cursorTurn;
          const target = Number.isInteger(ui.stepTurnIndex)
            ? ui.stepTurnIndex
            : Number.isInteger(cursorTurn) && cursorTurn >= 0 ? cursorTurn : step.activity.turns.length - 1;
          ui.stepTurnIndex = target;
          ui.stepExpandedTurn = ui.stepExpandedTurn === target ? null : target;
          ui.stepToolPage = 0;
          ui.stepSelectedEventIndex = step.activity.turns[target]?.responseIndex ?? ui.stepSelectedEventIndex;
          ui.stepFollow = false;
        } else if (ui.stepSection === 'activity' && step.activity?.selectedEvent != null) {
          ui.stepDetail = !ui.stepDetail;
        }
        return paint();
      }
      if (key === 'v' || key === 'V') return setStepView(ui.stepView === 'detail' ? 'overview' : 'detail');
      // An expanded turn shows the newest three tool rows; Space and the page
      // keys walk that window back through the older ones before Space falls
      // through to its follow toggle.
      // The tool rows live on the presentation layer the view draws, not on the
      // durable activity model the selection walks.
      const expandedToolTurn = ui.stepView === 'overview'
        && ui.stepSection === 'activity'
        && ui.stepExpandedTurn != null
        ? (step.presentation?.activity?.turns ?? []).find((turn) => Number(turn.index) === Number(ui.stepExpandedTurn))
        : null;
      const toolRowCount = expandedToolTurn?.toolRows?.length ?? 0;
      const maxToolPage = Math.max(0, Math.ceil(toolRowCount / 3) - 1);
      if (expandedToolTurn && maxToolPage > 0
        && (key === ' ' || keyPressed('pageUp', key) || keyPressed('pageDown', key))) {
        const older = key === ' ' || keyPressed('pageUp', key);
        ui.stepToolPage = clamp(
          (Number.isInteger(ui.stepToolPage) ? ui.stepToolPage : 0) + (older ? 1 : -1),
          0,
          maxToolPage,
        );
        ui.stepFollow = false;
        return paint();
      }
      if (key === ' ') {
        ui.stepFollow = !ui.stepFollow;
        if (ui.stepFollow) { ui.stepSelectedEventIndex = null; ui.stepToolPage = 0; }
        return paint();
      }
      if (key === 'a') { ui.stepSection = 'attempts'; ui.stepDetail = false; bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.attempts ?? 1) - 1); return paint(); }
      if (key === 'o') { ui.stepSection = 'outcome'; ui.stepDetail = false; bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.outcome ?? 1) - 1); return paint(); }
      if (key === 'p') { ui.stepSection = 'prompt'; ui.stepDetail = false; bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.prompt ?? 1) - 1); return paint(); }
      if (key === 'e') { ui.stepFilter = ui.stepFilter === 'errors' ? 'all' : 'errors'; ui.stepSection = 'activity'; ui.stepDetail = false; return paint(); }
      // Record rule 9: one filter control. `t` cycles turns → tools → errors →
      // all. The model's default `all` lens is what the overview draws as
      // `turns`, so the first press moves to tools.
      if (key === 't') {
        ui.stepFilter = ui.stepFilter === 'turns' || ui.stepFilter === 'all' ? 'tools'
          : ui.stepFilter === 'tools' ? 'errors' : 'all';
        ui.stepSection = 'activity';
        ui.stepDetail = false;
        ui.stepToolPage = 0;
        return paint();
      }
      // `f` follows the step's own activity tail; Fleet keeps the key on
      // every other page (see the guard on the Fleet binding above).
      if (key === 'f') {
        ui.stepFollow = !ui.stepFollow;
        if (ui.stepFollow) { ui.stepSelectedEventIndex = null; ui.stepToolPage = 0; }
        return paint();
      }
      if (keyPressed('out', key) || key === '\x7f' || key === '\b') {
        if (ui.stepExpandedTurn != null) {
          ui.stepExpandedTurn = null;
          ui.stepToolPage = 0;
          return paint();
        }
        if (ui.stepDetail) { ui.stepDetail = false; return paint(); }
        return moveOut();
      }
    }
    if (ui.page === 'fleet' && key === 'e') { void runEdit(); return; }
    if (ui.page === 'runs') {
      if (key === '/') {
        filterEditing = true;
        message = null;
        return paint();
      }
      if (key === 'a') {
        dashboardFilter = dashboardFilter === 'active' ? 'all' : 'active';
        message = dashboardFilter === 'active' ? 'Showing active workflows.' : 'Showing active and recent workflows.';
        ensureCatalog();
        return refresh();
      }
    }
    if (ui.page === 'help' && key === 'i') return runInstall();
    if (/^[1-9]$/.test(key)) {
      const run = ui.page === 'runs' ? lastFrameResult?.runRows?.[Number(key) - 1] : activeRuns[Number(key) - 1];
      if (run) return openRun(run.runId);
      message = `no run ${key} in flight`;
      return paint();
    }
    if (keyPressed('out', key)) {
      if (slicePinned || sliceHover) {
        slicePinned = null;
        sliceHover = null;
        return paint();
      }
      return moveOut();
    }
    if (keyPressed('in', key) || key === '\r' || key === '\n') return drillIn();
    if (keyPressed('up', key)) return moveVertical(-1);
    if (keyPressed('down', key)) return moveVertical(1);
    // Spending's stack basis is a page-local view toggle.  Keep it on a
    // letter that is otherwise only meaningful on Run/Step, while the click
    // regions emitted by stats-view use the same state path below.
    if (ui.page === 'stats' && ui.statsTab === 'spending' && (key === 'v' || key === 'V')) {
      clearSliceState();
      ui.statsStackBy = ui.statsStackBy === 'model' ? 'pool' : 'model';
      return paint();
    }
    const runPageOpen = ui.page === 'run' || ui.page === 'step';
    // Run v2 is one flat page — header, plan, live/spend, timeline — that the
    // shell windows like every other body. Its boxed panel, which owned a
    // scroll of its own, only draws under the planner/technical drilldowns, so
    // those keep `detailScroll` and the page itself moves `bodyScroll`.
    const panelScroll = runPageOpen && (ui.orchestratorDetail || ui.workflowVerbose);
    if (keyPressed('pageUp', key)) {
      if (panelScroll) { ui.timelineSelection = null; ui.detailScroll += 8; return paint(); }
      bodyScroll = Math.max(0, bodyScroll - 8);
      return paint();
    }
    if (keyPressed('pageDown', key)) {
      if (panelScroll) { ui.timelineSelection = null; ui.detailScroll = Math.max(0, ui.detailScroll - 8); return paint(); }
      bodyScroll += 8;
      if (!runPageOpen) loadMoreHistory();
      return paint();
    }
    if (key === 'o' && runPageOpen) {
      const row = detailRow(bullswarmDir, selectedRunId);
      const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
      if (model.orchestrator.autonomous) {
        ui.workflowVerbose = false;
        ui.orchestratorDetail = true;
        ui.orchestratorVerbose = false;
        ui.controlSelected = true;
        ui.detailScroll = 0;
        message = null;
      } else message = 'This workflow has no autonomous orchestrator thread.';
      return paint();
    }
    if (key === 't' && runPageOpen && output.columns < 100 && !ui.orchestratorDetail && !ui.workflowVerbose) {
      ui.mobileTimeline = !ui.mobileTimeline;
      ui.focus = 0;
      ui.controlSelected = false;
      ui.detailScroll = 0;
      message = null;
      return paint();
    }
    if (key === 'v' && runPageOpen) {
      if (ui.orchestratorDetail) ui.orchestratorVerbose = !ui.orchestratorVerbose;
      else ui.workflowVerbose = !ui.workflowVerbose;
      ui.detailScroll = 0;
      message = null;
      return paint();
    }
    if (key === 'c' && runPageOpen) {
      ui.confirmCancel = true;
      message = null;
      return paint();
    }
  };
  const onData = (buf) => {
    // A key-handler error (e.g. a drill-in racing the writer) must never
    // kill the TUI; finish() still restores the terminal on q/Ctrl-C.
    try { onDataUnsafe(buf); } catch (err) {
      message = `display error: ${err.message}`;
      paint();
    }
  };
  const onResize = () => { lastPaintedFrame = null; paint(); };
  input.setRawMode?.(true);
  input.resume();
  // SGR mouse reporting travels with the alternate screen: on for the whole
  // session, off again in finish() and around the setup hand-off.
  output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H${ESC}?1000h${ESC}?1003h${ESC}?1006h`);
  readIntegration();
  readTaskLedger();
  readIndex();
  readPrices();
  if (token) ensureCatalog();
  paint();
  // Price unmeasured history in a detached, throttled child once the first
  // frame is up; the dashboard never waits for it. Repriced rollups arrive
  // through readIndex() on a later refresh.
  if (autoReprice) scheduleReconcile({ bullswarmDir, trigger: 'dashboard' });
  // The same for old workspace copies (retention); both are off in tests
  // that open the dashboard on a temporary home.
  if (autoPrune) spawnRetentionSweep({ bullswarmDir, trigger: 'dashboard' });
  let timer = setInterval(refresh, refreshMs);
  timer.unref?.();
  let spinnerTimer = setInterval(spin, Math.max(50, Number(spinnerMs) || 400));
  spinnerTimer.unref?.();
  input.on('data', onData);
  output.on?.('resize', onResize);
  void readUsage();
  return new Promise((resolve) => { resolveDashboard = resolve; });
}

export function dashboardJson(bullswarmDir, { all = false, token = null, cancel = false } = {}) {
  if (cancel) {
    const result = requestCancel(bullswarmDir, token, { source: 'cli' });
    // A caller-planner run paused at a boundary has no kernel alive to honor
    // the request; one resume finalizes it as cancelled.
    const pausedForCaller = !result.alreadyFinished && Boolean(result.state?.planner?.awaiting);
    const id = result.state?.shortId ?? result.runId ?? token;
    return {
      action: 'cancel',
      ...result,
      ...(pausedForCaller ? {
        pausedForCaller: true,
        finalize: `bullswarm workflow cancel ${id} --json`,
        note: 'the run is paused for its caller planner and no kernel is alive; workflow cancel finalizes it and records the cancelled result',
      } : {}),
    };
  }
  if (token) {
    const resolved = resolveRunId(bullswarmDir, token);
    if (!resolved) throw new Error(`no run found for "${token}"`);
    if (isLegacyRunDir(resolved.runDir)) {
      return {
        action: 'show', legacy: true, runId: resolved.runId, shortId: resolved.shortId ?? null,
        dir: resolved.runDir,
        message: legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir }),
      };
    }
    const state = withV2Cancellation(readJsonSafe(join(resolved.runDir, 'state.json')), resolved.runDir);
    const report = readJsonSafe(join(resolved.runDir, 'report.json'));
    const events = readEvents(resolved.runDir);
    return { action: 'show', ...resolved, state, report, events };
  }
  const runs = all ? listRuns(bullswarmDir) : dashboardRows(bullswarmDir);
  return { action: 'list', count: runs.length, runs };
}

// Callers that read the run panel through the dashboard keep this import
// path; the page modules import it from run-model.js, the module that owns it.
export {
  workflowPanelModel,
};
