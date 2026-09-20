import { withV2Cancellation } from './v2-cancellation.js';
// Interactive workflow dashboard, inspired by Claude Code's /workflows view.
// It deliberately uses only ANSI sequences and Node's standard streams.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readJsonSafe, readJsonForUpdate, writeJsonAtomic } from '../lib/fsjson.js';
import { join } from 'node:path';
import { listRuns, resolveRunId, v2RunnerLiveness, isLegacyRunState, isLegacyRunDir, isOngoing, legacyRunLine, readKernelStderrTail } from './short-id.js';
import { appendEvent, readEvents } from './events.js';
import { isDeliveredWorkflowStatus } from './status.js';
import { presentationStageStatus, projectV2DependencyStages } from './v2-presentation.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { asciiGlyphsPreferred, glyphs, spinnerGlyph } from '../lib/glyphs.js';
import { integrationStatus, installIntegration } from '../integrate.js';
import { loadUsage, parseMouse, METER_COLORS, meterBar, paceWord, untilText } from './usage-view.js';
// The 0.33.0 pages: the render kit, the two aggregation models, and the four
// view modules each territory owns. The shell composes them and owns no
// arithmetic of its own beyond laying the lines out.
import { absentLine, chartRowCount, columns, compactRow, columnBars, cut, formatDashboardValue, periodToggle, progressBar, rule, seriesColor, shareBar, sparkline, tabsRow } from './dash-kit.js';
import { PERIODS, TREND_METRICS, modelsModel, overviewModel, poolsModel, projectsModel, trendModel } from './stats-model.js';
import { biggestRuns, budgetModel } from './budget-model.js';
import { budgetLines, budgetNotes } from './budget-view.js';
import { fleetLines } from './fleet-view.js';
import { statsLines } from './stats-view.js';
import { historyLines, historyNote } from './history-view.js';
import { dayKey, historyDays } from './history.js';
import { readRollups, rollupIndexPath } from './rollup.js';
import { loadState } from '../lib/state.js';
import { readMeterHistoryDays } from '../meters/registry.js';
import { listTasks } from '../lib/tasks.js';
import { attemptOutputSeries } from './v2-state.js';
import { formatMoneyPair } from '../lib/usage-basis.js';
import {
  taskToday,
} from './home-model.js';
import {
  homePage,
} from './home-view.js';
import {
  dashboardRunLines,
  daysWithTasks,
  filterDashboardRows,
  isWaitingWorkflow,
  listWindow,
  runsPage,
} from './runs-view.js';
import {
  workflowPanelModel,
  planProgress,
  planStripParts,
  runEconomics,
} from './run-model.js';
import {
  runFrame,
  renderWorkflowOverviewPanel,
  workflowTimelineLines,
  runPage,
} from './run-view.js';
// N1: a missing measurement never becomes a confident zero. Number(null) is
// 0 and Number.isFinite(0) is true, so every reading below goes through this.
import { finiteOrNull } from '../lib/num.js';
// The Usage page's `[edit]` hands the terminal to the same control centre
// `bullswarm setup` opens, so the rungs the reader just saw and the ones they
// are about to change are the same program's.
import { openSetupTui as openSetupControlCentre } from '../setup.js';
import { stepPageModel } from './step-model.js';
import { taskStepModel } from './task-step.js';
import { renderStepPage, stepFooterText } from './step-view.js';

const ESC = '\x1b[';
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

function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
}

/** The quota window a pool's pacing reads, out of one retained meter sample. */
function pacedWindow(pool, sample) {
  const preferred = pool?.pacingWindow === 'monthly' ? 'monthly'
    : pool?.pacingWindow === 'five_hour' ? 'five_hour' : 'weekly';
  return sample?.[preferred] ?? sample?.weekly ?? sample?.monthly ?? sample?.five_hour;
}

/**
 * Providers restate the same window boundary with sub-second jitter on every
 * read (`12:00:00.645530Z`, then `12:00:00.200253Z`), so two readings count as
 * the same window unless the boundary moves by at least a minute. A real
 * rollover moves it by hours or days.
 */
const RESET_TOLERANCE_MS = 60_000;

/**
 * One reading per local day for a pool, and whether its quota window rolled
 * over on that day. A reset is a recorded `resets_at` moving to a new instant
 * — never a falling utilization, which is also what a refund or a corrected
 * reading looks like. The walk covers every retained sample in order, so a
 * reset that happened between two daily readings still lands on its own day.
 */
function poolDayReadings(pool, days) {
  const readings = new Map();
  let lastResetAtMs = null;
  for (const date of Object.keys(days).sort()) {
    const samples = [...days[date]].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    const reading = { value: null, resetsAt: null, reset: false };
    for (const sample of samples) {
      const window = pacedWindow(pool, sample);
      const resetsAt = typeof window?.resets_at === 'string' ? window.resets_at
        : typeof window?.resetsAt === 'string' ? window.resetsAt : null;
      const resetAtMs = resetsAt ? Date.parse(resetsAt) : NaN;
      if (Number.isFinite(resetAtMs)) {
        if (lastResetAtMs != null && Math.abs(resetAtMs - lastResetAtMs) >= RESET_TOLERANCE_MS) reading.reset = true;
        lastResetAtMs = resetAtMs;
      }
      const value = finiteOrNull(window?.utilization);
      if (value != null) {
        reading.value = value;
        reading.resetsAt = resetsAt;
      }
    }
    readings.set(date, reading);
  }
  return readings;
}

/** Read the retained per-pool meter log into one real row per local day. */
export function readLicencePerDay(bullswarmDir, pools, { period = '7d', now = Date.now(), rollups = [] } = {}) {
  const enabled = (Array.isArray(pools) ? pools : []).filter((pool) => pool?.name && pool.enabled !== false);
  const histories = enabled.map((pool) => {
    const days = readMeterHistoryDays(pool.name, { dir: join(bullswarmDir, 'meters') });
    return { pool, days, readings: poolDayReadings(pool, days) };
  });
  const recordedDays = histories.flatMap((entry) => Object.keys(entry.days));
  if (!recordedDays.length) return { period, rows: [], reason: 'meter history is not loaded' };

  const nowDay = dayStart(now);
  let requestedStart;
  if (period === '30d') requestedStart = nowDay - 29 * 86_400_000;
  else if (period === 'all') {
    const times = (Array.isArray(rollups) ? rollups : [])
      .map((record) => Date.parse(record?.finishedAt ?? record?.startedAt ?? ''))
      .filter(Number.isFinite);
    requestedStart = times.length ? dayStart(Math.min(...times)) : dayStart(Date.parse(recordedDays.sort()[0]));
  } else requestedStart = nowDay - 6 * 86_400_000;

  const firstRecorded = recordedDays.sort()[0];
  const rows = [];
  for (let at = requestedStart; at <= nowDay; at = new Date(new Date(at).setDate(new Date(at).getDate() + 1)).getTime()) {
    const date = localDayKey(at);
    const segments = [];
    for (const { pool, readings } of histories) {
      const reading = readings.get(date);
      if (!reading || reading.value == null) continue;
      // Stats Pools marks the reset day with `▏`; it needs the fact, not a
      // guess from a value that fell.
      const segment = { name: pool.name, value: reading.value };
      if (reading.resetsAt) segment.resetsAt = reading.resetsAt;
      if (reading.reset) segment.reset = true;
      segments.push(segment);
    }
    rows.push({ date, segments });
  }
  const reason = localDayKey(requestedStart) < firstRecorded
    ? `Meter logs retain data from ${firstRecorded}; earlier days in ${period} are blank.`
    : null;
  return { period, rows, reason };
}

/**
 * The local clipboard, for a terminal that will not take OSC 52: pbcopy on
 * macOS, wl-copy under Wayland. Returns which tool carried it, or why none
 * did — the message on screen names one or the other, never both.
 */
export function writeClipboard(text, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const tools = [];
  if (platform === 'darwin') tools.push('pbcopy');
  if (env.WAYLAND_DISPLAY) tools.push('wl-copy');
  if (env.DISPLAY) tools.push('xclip');
  for (const tool of tools) {
    try {
      const result = run(tool, tool === 'xclip' ? ['-selection', 'clipboard'] : [], { input: text });
      if (!result?.error && (result?.status === 0 || result?.status == null)) return { ok: true, tool };
    } catch { /* try the next one */ }
  }
  return { ok: false, tool: null, reason: tools.length ? `${tools.join(' and ')} failed` : 'no pbcopy, wl-copy or xclip on this machine' };
}
/** Lines of the goal the Preflight segment shows before an ellipsis. */
const GOAL_PREVIEW_LINES = 5;
const SIDEBAR_WIDTH = 34;
const V2_TERMINAL = new Set(['completed', 'partial', 'cancelled', 'failed']);
/** A run directory that wrote one of these has finished; the index has it. */
const FINISHED_MARKERS = Object.freeze(['rollup.json', 'result.json', 'report.json']);
const stateStatus = (state) => state?.lifecycle?.status;
const stateStartedAt = (state) => state?.lifecycle?.startedAt;
const stateFinishedAt = (state) => state?.lifecycle?.finishedAt;

// Keep navigation wording and bindings in one place. Rendering and input use
// the same vocabulary so a hint never describes a different action.
const keyRow = (keys, label, bindings) => Object.freeze({ keys, label, bindings: Object.freeze(bindings) });

// 0.33.0 rebinds three keys the 0.32 viewer used: `r` was refresh (the 1 s
// timer already refreshes, so nothing is lost), `b` was move out (Esc and the
// left arrow still are), and `Tab` was the next workflow (Shift+Tab still
// cycles workflows, and Tab now walks a page's sub-tabs). The changelog
// records the change; the Help page names every key below.
export const DASHBOARD_KEYS = Object.freeze({
  home: keyRow('h', 'Home', ['h']),
  runs: keyRow('r', 'Runs', ['r']),
  budget: keyRow('b', 'Budget', ['b']),
  stats: keyRow('s', 'Stats', ['s']),
  history: keyRow('y', 'History', ['y']),
  fleet: keyRow('f', 'Fleet', ['f']),
  help: keyRow('?', 'Help', ['?']),
  openRun: keyRow('1\u20139', 'open that run', []),
  nextTab: keyRow('Tab', 'next sub-tab', ['\t']),
  cycleWorkflow: keyRow('Shift+Tab', 'cycle workflows', ['\x1b[Z']),
  period: keyRow('p', 'cycle the period', ['p']),
  up: keyRow('\u2191/k', 'move up', ['\x1b[A', 'k']),
  down: keyRow('\u2193/j', 'move down', ['\x1b[B', 'j']),
  in: keyRow('Enter/\u2192/l', 'open', ['\r', '\n', '\x1b[C', 'l']),
  out: keyRow('Esc/\u2190', 'move out', ['\x1b', '\x1b[D']),
  pageUp: keyRow('PgUp', 'scroll up a screen', ['\x1b[5~']),
  pageDown: keyRow('PgDn', 'scroll down a screen', ['\x1b[6~']),
  top: keyRow('Home', 'top', ['\x1b[H', '\x1b[1~', '\x1bOH']),
  end: keyRow('End', 'bottom', ['\x1b[F', '\x1b[4~', '\x1bOF']),
  copy: keyRow('ctrl+s', 'copy the screen', ['\x13']),
  detach: keyRow('q', 'quit', ['q', '\x03']),
});

function keyHint(name) {
  const action = DASHBOARD_KEYS[name];
  return `${action.keys.split('/')[0]} ${action.label}`;
}

function keyPressed(name, key) {
  return DASHBOARD_KEYS[name].bindings?.includes(key) ?? false;
}

function navigationFooter({
  list = false, depth = 0, narrow = false, filterEditing = false, mobileTimeline = true,
  timelineSelection = null, dependencyGroups = false,
} = {}) {
  if (filterEditing) return 'Filter: {query}█ · Enter apply · Esc clear';
  if (list) {
    return narrow
      ? `${keyHint('in')} · / filter · a active/all · ${keyHint('detach')} · ${keyHint('out')} · ${keyHint('cycleWorkflow')} · r refresh`
      : `${keyHint('up')} · ${keyHint('in')} · / filter · a active/all · ${keyHint('detach')} · ${keyHint('out')} · ${keyHint('cycleWorkflow')} · r refresh · c stop`;
  }
  const extras = depth >= 4 ? ' · PgUp/PgDn scroll' : '';
  const phaseNavigation = narrow && depth <= 2 && mobileTimeline;
  const phaseToggle = narrow && depth <= 2
    ? ` · t ${mobileTimeline ? 'phases' : 'timeline'}`
    : '';
  const movement = phaseNavigation ? '↑ previous phase · ↓ next phase' : `${keyHint('up')} · ${keyHint('down')}`;
  const open = phaseNavigation ? `Enter ${timelineSelection === 0 ? 'planner' : 'agents'}` : keyHint('in');
  return `${movement}${phaseToggle} · ${open} · ${keyHint('out')} · ${keyHint('cycleWorkflow')} · o planner · v technical · c stop · ${keyHint('detach')}${extras}`;
}

function breadcrumbSegments(row, { depth = 0, phase = null, agent = null } = {}) {
  const state = row?.state ?? {};
  const run = row ? `${row.shortId ?? row.runId ?? '------'} · ${workflowRunLabel(row)}` : null;
  const segments = ['Workflows'];
  if (run) segments.push(run);
  if (depth >= 2 && phase) segments.push(phase.label ?? phase.name ?? String(phase));
  if (depth >= 3 && agent) segments.push(agent.action?.id ?? agent.id ?? String(agent));
  return segments;
}

function breadcrumbLine(segments, width) {
  let parts = [...segments];
  while (parts.length > 1 && ` ${parts.join(' › ')}`.length > width) parts.pop();
  if (` ${parts.join(' › ')}`.length <= width) return ` ${parts.join(' › ')}`;
  return truncate(` ${parts.join(' › ')}`, width);
}

function compactUsage(usage) {
  if (!usage) return 'usage pending';
  const tokens = usage.tokens ?? {};
  const tokenText = `tokens read=${tokens.standardRead ?? '?'} cache-read=${tokens.cacheRead ?? '?'} cache-write=${tokens.cacheWrite ?? '?'} output=${tokens.output ?? '?'}`;
  const cost = formatMoneyPair({
    api: usage.api ?? { usd: usage.cost?.estimatedUsd ?? null, tokenSource: usage.tokenSource },
    subscription: usage.subscription,
    tokenSource: usage.tokenSource,
    tokens,
  });
  const quota = usage.normalizedQuota?.estimatedPercent == null
    ? usage.normalizedQuota?.knownSubtotalPercent != null
      ? `quota≥${usage.normalizedQuota.knownSubtotalPercent}% (partial)` : 'quota=?'
    : `quota≈${usage.normalizedQuota.estimatedPercent}%`;
  return `${tokenText} · ${cost} · ${quota}`;
}

function tokenText(usage) {
  const tokens = usage?.tokens;
  if (!tokens) return '';
  const reported = tokens.totalKnown;
  const total = Number.isFinite(reported)
    ? reported
    : ['standardRead', 'cacheRead', 'cacheWrite', 'output']
      .map((key) => tokens[key])
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
  if (!total) return '';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

// The reasoning level an attempt actually ran at, shown next to the model
// because they answer two different questions: which brain, and how hard it
// thought. Absent (older runs, connectors with no reasoning control, or a
// `default` that deliberately passes nothing) renders nothing at all.
export function reasoningText(attempt) {
  const applied = attempt?.reasoning?.applied;
  return typeof applied === 'string' && applied ? applied : '';
}

export function requestCancel(bullswarmDir, token, { source = 'api', requesterPid = process.pid } = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = readJsonForUpdate(statePath, 'workflow state');
  // A legacy run has no kernel to ask, so nothing is written and nothing is
  // claimed: the caller is told what it is and left alone.
  if (isLegacyRunState(state)) return { ...resolved, legacy: true, alreadyFinished: true };
  if (V2_TERMINAL.has(state.lifecycle.status)) return { ...resolved, state, alreadyFinished: true };
  const requestedAt = new Date().toISOString();
  state.cancellation = {
    requested: true,
    requestedAt,
    reason: 'operator requested stop',
    source,
    requesterPid,
  };
  appendEvent(resolved.runDir, state, 'workflow.cancellation_requested', {
    requestedAt,
    reason: state.cancellation.reason,
    source,
    requesterPid,
  });
  // The operator owns this intent file; only the kernel owns state.json.
  writeJsonAtomic(join(resolved.runDir, 'cancellation.json'), state.cancellation);
  return { ...resolved, state, alreadyFinished: false };
}

/**
 * One listed run, enriched with everything the pages read: its events, its
 * liveness, its step counts and the attempts in flight.
 */
function enrichRunRow(r) {
  const state = r.state ?? {};
  // A legacy row is five read-only fields and a marker; its detail pane is
  // one line and it offers nothing to drive. A torn state.json lands here
  // too, which keeps observation non-crashing until the writer settles.
  if (r.legacy || isLegacyRunState(state)) {
    return {
      ...r,
      legacy: true,
      events: [],
      status: state.status ?? 'unknown',
      phase: 'legacy',
      stepsOk: 0,
      stepsTotal: 0,
      activeAgents: [],
      currentPhase: null,
      currentStep: null,
      usage: null,
    };
  }
  const actions = state.actions ?? [];
  const runningAttempts = (state.attempts ?? []).filter((attempt) => attempt.status === 'running');
  const current = actions.find((action) => action.status === 'running') ?? actions.find((action) => ['ready', 'pending'].includes(action.status));
  const stage = state.presentation?.stages?.find((item) => item.actionIds.includes(current?.id))
    ?? state.presentation?.stages?.findLast((item) => item.startedAt)
    ?? null;
  const liveness = v2RunnerLiveness(state, { runDir: r.runDir });
  return {
    ...r,
    events: readEvents(r.runDir),
    liveness,
    kernelStderrTail: !liveness.alive ? readKernelStderrTail(r.runDir) : [],
    status: state.cancellation?.requested ? 'stopping'
      : liveness.alive ? state.lifecycle.status : 'interrupted',
    phase: stage?.label ?? (state.preflight?.scout?.status === 'running' ? 'Preflight: Scout' : state.planner?.status === 'running' ? 'Workflow Planner' : 'starting'),
    stepsOk: actions.filter((action) => action.status === 'succeeded').length,
    stepsTotal: actions.length,
    activeAgents: runningAttempts,
    currentPhase: stage,
    currentStep: current ?? null,
    usage: state.usage ?? null,
  };
}

const byNewestStart = (a, b) => {
  if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
  return String(stateStartedAt(b.state) ?? b.report?.startedAt ?? '')
    .localeCompare(String(stateStartedAt(a.state) ?? a.report?.startedAt ?? ''));
};

export function dashboardRows(bullswarmDir, { all = false } = {}) {
  return listRuns(bullswarmDir)
    .filter((r) => all || r.ongoing)
    .sort(byNewestStart)
    .map(enrichRunRow);
}

/**
 * The runs in flight, without parsing every run directory.
 *
 * `listRuns` parses all 293 `state.json` files on this machine — 22 MB and
 * about 100 ms against a 1 s refresh timer — which is why Home, Stats,
 * History and Budget read `~/.bullswarm/history/runs.jsonl` instead. The nav
 * and the running block still need live state, so this walks the same
 * directories and parses only the ones that can still be running: a run that
 * wrote `rollup.json`, `result.json` or `report.json` has finished, and its
 * numbers live in the index.
 */
export function activeDashboardRows(bullswarmDir) {
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return [];
  let entries;
  try { entries = readdirSync(runsRoot, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wf-')) continue;
    const dir = join(runsRoot, entry.name);
    if (FINISHED_MARKERS.some((marker) => existsSync(join(dir, marker)))) continue;
    const statePath = join(dir, 'state.json');
    if (!existsSync(statePath)) continue;
    let raw = null;
    try { raw = JSON.parse(readFileSync(statePath, 'utf8')); } catch { continue; }
    // A legacy run is never ongoing, so it never reaches the running block.
    if (isLegacyRunState(raw)) continue;
    const state = withV2Cancellation(raw, dir);
    if (!isOngoing(dir, state)) continue;
    rows.push(enrichRunRow({
      runId: entry.name, shortId: state?.shortId ?? null, runDir: dir, dir,
      legacy: false, state, report: null, ongoing: true,
    }));
  }
  return rows.sort(byNewestStart);
}

export function renderDashboard({
  rows, allRows = rows, selected = 0, message = null, width = 120, height = 36,
  filter = 'active', query = '', filterEditing = false, spinnerFrame = 0,
  previewRow = null,
} = {}) {
  width = Math.max(20, Number(width) || 120);
  height = Math.max(12, Number(height) || 36);
  rows = rows ?? [];
  allRows = allRows ?? rows;
  const narrow = width < 100;
  const active = allRows.filter((row) => row.ongoing).length;
  const waiting = allRows.filter((row) => isWaitingWorkflow(row.state)).length;
  const historical = Math.max(0, allRows.length - active);
  const selectedRow = previewRow ?? rows[selected] ?? null;
  const summary = `${active} active · ${waiting} waiting · ${historical} recent`;
  const header = [
    breadcrumbLine(breadcrumbSegments(null), width),
    truncate(` bullswarm workflows · ${summary}`, width),
    selectedRow
      ? truncate(` ${selectedRow.shortId ?? '------'} · ${workflowRunLabel(selectedRow)}`, width)
      : truncate(` ${filter === 'active' ? 'Active workflows' : 'All workflows'}`, width),
  ];
  const footer = filterEditing
    ? truncate(navigationFooter({ filterEditing }).replace('{query}', query), width)
    : truncate(navigationFooter({ list: true, narrow }), width);
  const messageLine = message
    ? truncate(` ${message}`, width)
    : truncate(` Runs · ${filter}${query ? ` · filter “${query}”` : ''} · workflow continues after dashboard exit`, width);
  const bodyHeight = Math.max(6, height - header.length - 2);
  const listLines = dashboardRunLines(rows, selected, narrow, width);

  let body;
  if (narrow) {
    const body = renderPanel(
      `Runs · ${filter}`,
      listWindow(listLines, selected, bodyHeight - 2, true),
      width,
      bodyHeight,
    );
    return [`${ESC}2J${ESC}H`, ...header, ...body, messageLine, footer].join('\n');
  }
  const leftWidth = Math.min(SIDEBAR_WIDTH, Math.max(1, width - 3));
  const rightWidth = Math.max(1, width - leftWidth);
  const left = renderPanel(
    `Runs · ${filter}`,
    listWindow(listLines, selected, bodyHeight - 2, false),
    leftWidth,
    bodyHeight,
  );
  let right;
  if (selectedRow?.legacy && rightWidth >= 3) {
    right = renderPanel('Selected workflow', wrapLines([
      legacyRunLine({ shortId: selectedRow.shortId, runId: selectedRow.runId, runDir: selectedRow.runDir }),
    ], Math.max(1, rightWidth - 4)), rightWidth, bodyHeight);
  } else if (selectedRow?.state && rightWidth >= 3) {
    const model = workflowPanelModel(selectedRow);
    right = renderWorkflowOverviewPanel(model, rightWidth, bodyHeight, spinnerFrame, 0);
  } else {
    const hint = allRows.length && filter === 'active'
      ? ['No active workflows.', '', 'Press a to browse recent runs.']
      : ['No workflow runs yet.', '', 'Start one with:', 'bullswarm workflow goal "…"'];
    right = renderPanel('Selected workflow', hint, rightWidth, bodyHeight);
  }
  body = joinPanels(left, right);
  return [`${ESC}2J${ESC}H`, ...header, ...body, messageLine, footer].join('\n');
}

function workflowRunLabel(row) {
  const state = row?.state ?? {};
  // A legacy row carries only the workflow name and goal it recorded.
  if (row?.legacy) return String(state.name ?? state.goal ?? row?.runId ?? 'workflow').split('\n')[0].trim();
  return String(state.intent?.goal ?? state.intent?.description ?? row?.runId ?? 'workflow')
    .split('\n')[0]
    .trim();
}

export function renderDetails(row, { interactive = true } = {}) {
  const state = row?.state ?? {};
  // A legacy run has no readable graph left, so the pane says exactly what the
  // CLI says and stops there.
  if (row?.legacy || isLegacyRunState(state)) {
    return [
      `${ESC}2J${ESC}H`,
      legacyRunLine({ shortId: row?.shortId, runId: row?.runId, runDir: row?.runDir }),
      ...(interactive ? ['', ` ${keyHint('out')} · r refresh · ${keyHint('detach')}`] : []),
    ].join('\n');
  }
  return renderV2Details(row, { interactive });
}

function renderV2Details(row, { interactive = true } = {}) {
  const state = row.state;
  const lines = [
    `${ESC}2J${ESC}H`,
    ` bullswarm · ${row.shortId ?? state.shortId ?? state.runId}`,
    '',
    ` status: ${state.lifecycle.status}`,
    ...(isProgramWorkflow(state) ? [` mode:   program in ${state.config.settings.workspaceMode ?? 'shared'} workspace; requirement evidence reported separately`] : []),
    ` goal:   ${state.intent.goal}`,
    ` dir:    ${row.runDir ?? '—'}`,
    '',
    ' presentation stages:',
  ];
  for (const stage of isProgramWorkflow(state) ? projectV2DependencyStages(state) : state.presentation.stages) {
    const progress = presentationStageStatus(stage, state.actions);
    const status = stage.completedAt ? (progress.successful ? 'completed' : 'completed with gaps') : stage.startedAt ? 'running' : 'not started';
    lines.push(`   ${statusIcon(status)} ${stage.label} · ${progress.completed}/${progress.total} · ${status}`);
    for (const id of stage.actionIds) {
      const action = state.actions.find((entry) => entry.id === id);
      lines.push(`     ${statusIcon(action?.status)} ${id} · ${action?.status ?? 'pending'}`);
    }
  }
  if (!state.presentation.stages.length) lines.push('   planning has not created the first program yet');
  lines.push('', ' workflow planner:');
  lines.push(`   ${statusIcon(state.planner.status)} ${state.planner.status} · ${state.planner.turns} checkpoint${state.planner.turns === 1 ? '' : 's'}`);
  lines.push(`   latest: ${state.planner.lastDecision?.summary ?? 'not available'}`);
  lines.push('', ' requirements:');
  for (const requirement of Object.values(state.ledger.requirements)) {
    lines.push(`   ${statusIcon(requirement.status)} ${requirement.id} · ${requirement.status}`);
  }
  lines.push('', ' recent events:');
  for (const event of (row.events ?? []).slice(-12)) lines.push(`   #${event.sequence} ${event.type}`);
  if (!(row.events ?? []).length) lines.push('   none');
  if (row.kernelStderrTail?.length) lines.push('', ' kernel log: available');
  if (interactive) lines.push('', ` ${keyHint('out')} · c stop · r refresh · ${keyHint('detach')}`);
  return lines.join('\n');
}

const TERMINAL_ACTIONS = new Set([
  'succeeded', 'failed', 'failed_retryable', 'failed_terminal', 'skipped', 'cancelled', 'removed',
]);

function renderPanel(title, content, width, height) {
  const inner = Math.max(1, width - 2);
  const label = truncate(` ${title} `, inner);
  const top = `┌${label}${'─'.repeat(Math.max(0, inner - label.length))}┐`;
  const rows = [top];
  for (let i = 0; i < height - 2; i++) rows.push(`│${panelCell(content[i] ?? '', inner)}│`);
  rows.push(`└${'─'.repeat(inner)}┘`);
  return rows;
}

function joinPanels(left, right) {
  return left.map((line, index) => `${line}${right[index] ?? ''}`);
}

export function clockText(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The durable byte timeline for one attempt, plus its measured total. */
export function outputSparkline(attempt, runDir, width = 8) {
  let series = [];
  try { series = attemptOutputSeries(attempt, runDir); } catch { series = []; }
  if (!series.length) return '';
  const values = series.map((sample) => sample?.[1]).filter((value) => Number.isFinite(value));
  if (!values.length) return '';
  const total = values.at(-1);
  const spark = sparkline(values, width);
  return spark ? `${spark} ${formatBytes(total)}` : '';
}

export function dimText(value, width) {
  return `\x1b[2m${truncate(value, width)}\x1b[0m`;
}

// ------------------------------------------------- the palette on the page
//
// The pages name a palette role — or the stable hex returned by dash-kit for a
// pool/model series — and never invent a colour. Every value comes from
// METER_COLORS in usage-view.js, the one palette the product has; this file
// adds none. Colour is off wherever the meters are off, so an ascii terminal
// and a plain-text capture read the same words with no escapes in them.

const SGR_RESET = '\x1b[0m';
const SGR_BOLD = '\x1b[1m';
const SGR_NO_BOLD = '\x1b[22m';

const rgbOf = (hex) => {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** `text` in the palette's `role`, or untouched where colour is off. */
export function tint(text, role) {
  const body = String(text ?? '');
  if (!body || !meterAnsi()) return body;
  const hex = typeof role === 'string' && role.startsWith('#') ? role : METER_COLORS[role];
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return body;
  return `\x1b[38;2;${rgbOf(hex).join(';')}m${body}${SGR_RESET}`;
}

/** A key figure or a key name, bold where the terminal can be bold. */
function strong(text) {
  const body = String(text ?? '');
  if (!body || !meterAnsi()) return body;
  return `${SGR_BOLD}${body}${SGR_NO_BOLD}`;
}

/** The run marks, each in the colour the tagged prototype frame gives it. */
const okMark = () => tint(glyphs().ok, 'green');
const failMark = () => tint(glyphs().fail, 'red');
const runningMark = () => tint(glyphs().started, 'cyan');
const pendingMark = () => dimText(glyphs().pending, 2);

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

export function actionRoleLabel(action) {
  if (action.kind) return action.kind;
  if (Array.isArray(action.evidenceFor) && action.evidenceFor.length) return 'evidence';
  if (action.lane || action.prompt) return 'work';
  return 'action';
}

export function agentDetailLines(model, width, spinnerFrame) {
  const agent = model.selectedAgent;
  if (!agent) {
    const lines = ['No agent selected.', '', 'Planned steps in this phase:'];
    for (const action of model.selectedPhase.actions) {
      const blocked = (model.selectedPhase.blockedActions ?? []).find((entry) => entry.id === action.id);
      lines.push(blocked
        ? `${glyphs().blocked} ${action.id} · ${actionRoleLabel(action)} · never dispatched`
        : `${statusIcon(action.status, spinnerFrame)} ${action.id} · ${actionRoleLabel(action)} · ${action.status}`);
      if (blocked) {
        lines.push(`  blocked by ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : 'a failed dependency'}`);
      }
    }
    if (!model.selectedPhase.actions.length) lines.push('· waiting for the orchestrator to add work');
    return wrapLines(lines, width);
  }
  const { action, attempt, active } = agent;
  const liveActions = active?.lastActions ?? attempt?.lastActions ?? [];
  const routing = attempt?.routing;
  const reasoning = reasoningText(attempt) || reasoningText(active);
  const lines = [
    `${statusIcon(agent.status, spinnerFrame)} ${agent.status} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''}`,
    // V1 stores the tier on the attempt; V2 stores it under routing. Reading
    // only the V1 shape made every V2 attempt render `effort auto`, right
    // beside the reasoning level it was resolved against.
    `${agent.pool} · attempt ${attempt?.attemptNumber ?? active?.attempt ?? 1} · effort ${attempt?.effort ?? routing?.effort ?? active?.effort ?? 'auto'}${reasoning ? ` · reasoning ${reasoning}` : ''}`,
    '',
    `Step · ${action.id} · ${actionRoleLabel(action)}`,
  ];
  if (routing?.reason) lines.push(`Route: ${routing.reason}`);
  if (attempt?.startedAt ?? active?.startedAt) lines.push(`Started: ${attempt?.startedAt ?? active.startedAt}`);
  if (attempt?.finishedAt) lines.push(`Finished: ${attempt.finishedAt}`);
  if (active?.lastActivityAt) lines.push(`Last activity: ${active.lastActivityAt} · ${active.outputBytesObserved ?? 0} bytes`);
  if (active?.stall?.status === 'suspected_stalled') {
    lines.push(`${glyphs().warn} Suspected stalled: ${active.stall.silentForSec}s without evidence; never auto-killed`);
  }
  if (attempt?.failureReason) lines.push(`Failure: ${attempt.failureReason}`);
  const taskFile = attempt?.taskFile ?? active?.taskFile;
  const prompt = taskPreview(taskFile);
  lines.push('', `Prompt${prompt.length ? ` · ${prompt.length} lines shown` : ''}`);
  if (prompt.length) lines.push(...prompt.map((line) => `  ${line}`));
  else lines.push('  unavailable');
  const historicalActionIds = new Set(model.events
    .filter((event) => event.type === 'attempt.agent_action'
      && event.payload?.actionId === action.id
      && (attempt?.attemptNumber == null || event.payload?.attemptNumber === attempt.attemptNumber))
    .map((event) => event.payload?.agentAction?.id)
    .filter(Boolean));
  const totalActions = active?.actionCount ?? attempt?.actionCount
    ?? Math.max(liveActions.length, historicalActionIds.size);
  const activityLabel = totalActions > liveActions.length
    ? `Activity · last ${liveActions.length} of ${totalActions}`
    : 'Activity';
  lines.push('', compactUsage(attempt?.usage), '', activityLabel);
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  const firstVisibleActionNumber = Math.max(1, totalActions - liveActions.length + 1);
  for (const [index, step] of liveActions.entries()) {
    lines.push(`#${firstVisibleActionNumber + index} ${statusIcon(step.status, spinnerFrame)} ${step.kind} · ${step.status}`);
    if (step.summary) lines.push(`  ${step.summary}`);
  }
  const output = model.state.outputs?.[action.id];
  const outcome = outcomePreview(attempt?.outFile ?? active?.outFile ?? output?.outFile, output);
  if (outcome.length) lines.push('', 'Outcome', ...outcome.map((line) => `  ${line}`));
  lines.push('', 'Artifacts:');
  lines.push(`task: ${attempt?.taskFile ?? active?.taskFile ?? '—'}`);
  lines.push(`output: ${attempt?.outFile ?? active?.outFile ?? '—'}`);
  return wrapLines(lines, width);
}

export function taskPreview(path, limit = 6) {
  if (!path || !existsSync(path)) return [];
  try {
    const all = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    const shown = all.slice(0, limit);
    if (all.length > limit) shown.push(`… ${all.length - limit} more lines`);
    return shown;
  } catch {
    return [];
  }
}

export function outcomePreview(path, output, maxChars = 64 * 1024) {
  let text = '';
  try {
    if (path && existsSync(path)) text = readFileSync(path, 'utf8');
  } catch { /* fall through to the durable state preview */ }
  if (!text && typeof output?.outputText === 'string') text = output.outputText;
  if (!text && output?.verify) text = JSON.stringify(output.verify, null, 2);
  if (!text.trim()) return [];
  const truncated = text.length > maxChars;
  const lines = text.slice(0, maxChars).split(/\r?\n/);
  if (truncated) lines.push('… outcome truncated in TUI; open the artifact for the complete result');
  return lines;
}

export function wrapLines(lines, width) {
  const out = [];
  for (const line of lines) {
    if (!line) { out.push(''); continue; }
    let rest = String(line);
    while (rest.length > width) {
      let split = rest.lastIndexOf(' ', width);
      if (split < Math.floor(width * 0.5)) split = width;
      out.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart();
    }
    out.push(rest);
  }
  return out;
}

// Workflow-level glyph for a terminal run.
function workflowStatusIcon(state, spinnerFrame = 0) {
  return statusIcon(state?.status, spinnerFrame);
}

export function statusIcon(status, spinnerFrame = 0) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed' || value.startsWith('succeeded')) return glyphs().ok;
  if (value === 'completed_with_concerns') return '!'; // legacy runs
  if (value === 'dependency_blocked') return glyphs().blocked;
  if (value.startsWith('failed') || value === 'cancelled' || value === 'interrupted') return glyphs().fail;
  if (value === 'running' || value === 'active' || value === 'planning') {
    return spinnerGlyph(spinnerFrame);
  }
  if (value.includes('waiting') || value === 'queued' || value === 'paused'
    || value === 'blocked' || value === 'starting' || value === 'reviewing evidence'
    || value === 'directing execution') return glyphs().waiting;
  if (value === 'skipped' || value === 'removed' || value === 'superseded') return '–';
  return glyphs().pending;
}

export function durationText(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return 'time pending';
  const end = Date.parse(finishedAt ?? '') || Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function truncate(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function panelWindow(lines, selectedIndex, itemHeight, height) {
  if (lines.length <= height) return lines;
  const header = lines[0];
  const content = lines.slice(1);
  const room = Math.max(1, height - 1);
  const selectedRow = Math.max(0, selectedIndex * itemHeight);
  const start = clamp(selectedRow - Math.floor(room / 2), 0, Math.max(0, content.length - room));
  return [header, ...content.slice(start, start + room)];
}

function timelineText(value) {
  return typeof value === 'string' ? value : value?.text ?? '';
}

function panelCell(value, width) {
  const text = timelineText(value);
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const clipped = plain.length > width ? truncate(plain, width) : plain;
  const styled = text.includes('\x1b[') && plain.length <= width ? text : clipped;
  return `${styled}${' '.repeat(Math.max(0, width - clipped.length))}`;
}

function selectLine(value, selected, focused, width) {
  const text = truncate(`${selected ? '› ' : '  '}${value}`, width);
  return selected && focused ? `\x1b[7m${text}\x1b[0m` : text;
}

function dimLine(value, width) {
  return `\x1b[2m${truncate(`  ${value}`, width)}\x1b[0m`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function detailRow(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const legacy = isLegacyRunDir(resolved.runDir);
  const state = legacy ? null : withV2Cancellation(readJsonSafe(join(resolved.runDir, 'state.json')), resolved.runDir);
  const report = readJsonSafe(join(resolved.runDir, 'report.json'));
  return {
    ...resolved, legacy, state, report,
    events: legacy ? [] : readEvents(resolved.runDir),
    status: state?.lifecycle?.status,
  };
}

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

// ---------------------------------------------------------------------------
// The paged dashboard: Home, Runs, Run, Step, Budget, Stats, Fleet (History is the day table inside Runs)
// and Help.
//
// Every paint draws the page tab row, one sticky header, a window over the
// body, an optional message line and note, then the sticky bottom nav. Each
// tab, tile, bar, run row, day row, step and nav button records the columns
// it was painted in, so an SGR mouse press runs the same action its key runs
// and the wheel moves the same window.
//
// The pages own no arithmetic. Money and licence figures come from
// budget-model and stats-model, and every one of them is painted with `≈` and
// its basis, or as a blank with the reason it cannot be measured.
// ---------------------------------------------------------------------------

const ANSI_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Every page the dashboard has, in the order the help page lists them. */
const DASHBOARD_PAGES = Object.freeze(['home', 'runs', 'run', 'step', 'task', 'budget', 'stats', 'history', 'fleet', 'help']);
/** The tab row above the body; `key` is the key that opens the page. */
const PAGE_TABS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', key: 'h' }),
  Object.freeze({ id: 'runs', label: 'Runs', key: 'r' }),
  Object.freeze({ id: 'budget', label: 'Budget', key: 'b' }),
  Object.freeze({ id: 'stats', label: 'Stats', key: 's' }),
  Object.freeze({ id: 'fleet', label: 'Fleet', key: 'f' }),
]);
/** Run and Step are read as Runs: the tab row marks the page they came from. */
const TAB_OF_PAGE = Object.freeze({ run: 'runs', step: 'runs', task: 'runs', history: 'runs' });
/** The period toggle, in the order `p` cycles it. */
const PERIOD_ITEMS = Object.freeze([
  Object.freeze({ id: '7d', label: 'Last 7 days' }),
  Object.freeze({ id: '30d', label: 'Last 30 days' }),
  Object.freeze({ id: 'all', label: 'All time' }),
]);
/** Stats' sub-tabs and Fleet's, in the order Tab cycles them. */
const STATS_TABS = Object.freeze(['spending', 'pool', 'model', 'project']);
const FLEET_TABS = Object.freeze(['lane', 'provider']);
/** How many columns a painted line really occupies. */
export const visibleLength = (value) => String(value ?? '').replace(ANSI_SGR, '').length;
/** The one-line commands that operate the product, as Runs lists them. */
const DASHBOARD_COMMANDS = Object.freeze([
  'bullswarm run',
  'bullswarm workflow goal "<goal>"',
  'bullswarm workflow watch <id> --next',
  'bullswarm workflow reindex',
  'bullswarm setup',
  'bullswarm doctor',
]);
const STEP_SECTIONS = Object.freeze(['activity', 'attempts', 'outcome', 'prompt']);

/** Meters are background-coloured cells; an ascii terminal gets the plain bar. */
export function meterAnsi() {
  return !asciiGlyphsPreferred();
}

/** The blank a figure with no measurable source is painted as. */
export function blank() {
  return asciiGlyphsPreferred() ? '-' : '—';
}

/** `≈` with the basis beside it, or the ascii twin. */
export function about() {
  return asciiGlyphsPreferred() ? '~' : '≈';
}

const TOKEN_SOURCE_RANK = Object.freeze({
  unknown: 0,
  'estimated:utf8-bytes/4': 1,
  'transcript-summed': 2,
  'provider-reported': 3,
});
const SUBSCRIPTION_BASIS_RANK = Object.freeze({
  'unknown:no-price': 0,
  'unknown:no-meter': 1,
  'unknown:no-cost': 2,
  'calibrated:usd-per-pct': 3,
  'observed:meter-delta': 4,
});

function tokenSourceOf(value, cost = null) {
  if (Object.hasOwn(TOKEN_SOURCE_RANK, value)) return value;
  return cost != null ? 'estimated:utf8-bytes/4' : 'unknown';
}

function worstTokenSource(current, candidate) {
  const next = tokenSourceOf(candidate);
  if (current == null) return next;
  return TOKEN_SOURCE_RANK[next] < TOKEN_SOURCE_RANK[current] ? next : current;
}

function subscriptionBasisOf(value) {
  return Object.hasOwn(SUBSCRIPTION_BASIS_RANK, value) ? value : 'unknown:no-meter';
}

function worstSubscriptionBasis(current, candidate) {
  const next = subscriptionBasisOf(candidate);
  if (current == null) return next;
  return SUBSCRIPTION_BASIS_RANK[next] < SUBSCRIPTION_BASIS_RANK[current] ? next : current;
}

function usageBasisText(value, tokenSource) {
  return formatMoneyPair({ api: { usd: value, tokenSource: tokenSourceOf(tokenSource, value) } });
}

/**
 * Money, always as the estimate it is. `estimateInvocationUsage` prices the
 * task and output text at API rates with no cache split, so every `$` on this
 * dashboard is an API-equivalent estimate and says so; an amount nobody
 * recorded is null, and the caller paints a blank with the reason.
 */
export function moneyText(value, tokenSource) {
  if (value && typeof value === 'object') {
    if (value.api || Object.hasOwn(value, 'apiUsd') || Object.hasOwn(value, 'apiEquivalentUsd')) {
      return formatMoneyPair({
        api: value.api ?? { usd: value.apiUsd ?? value.apiEquivalentUsd ?? null, tokenSource: value.tokenSource },
        subscription: value.subscription ?? {
          usd: value.subscriptionUsd ?? null,
          deltaPct: value.subscriptionDeltaPct ?? null,
          window: value.subscriptionWindow ?? null,
          basis: value.subscriptionBasis ?? 'unknown:no-meter',
        },
        tokenSource: value.tokenSource,
        tokens: value.tokens ?? null,
      });
    }
    return formatMoneyPair(value);
  }
  return formatMoneyPair({
    api: { usd: value, tokenSource: tokenSourceOf(tokenSource, value) },
    subscription: null,
  });
}

export function minutesText(value) {
  return formatDashboardValue(value, 'minutes');
}

/** `42m` / `2h05m` since an ISO time. */
function ageText(iso, nowMs) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins)) return '';
  return minutesText(mins) ?? '';
}

/** `19:22` in the reader's own zone, for an ETA or a milestone. */
function clockAt(ms) {
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
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

/** `text` underlined, so a key hint reads as one. */
const underline = (text) => `\x1b[4m${text}\x1b[24m`;

/**
 * The page tab row: the active tab inverted with its key letter underlined.
 * Fleet is dropped while the terminal is narrow unless it is the page being
 * read. Help remains available from the bottom nav and the `?` key, but is
 * intentionally not a top-level tab.
 */
function pageTabs(page, width) {
  const active = TAB_OF_PAGE[page] ?? (page === 'help' ? null : page);
  const hidden = [];
  if (width < 38) hidden.push('fleet');
  return tabsRow(PAGE_TABS, { active, width, hidden });
}

/**
 * The bottom nav: one button per ongoing run, then the page's tail.
 *
 * A run's digit sits inside its button (`[ 1.aaa111 ]`) and a label's key
 * letter is underlined, so the keys read off the nav. Below 100 columns the
 * tail is the phone layout's `[Top] [End] [?.Help]`; the run buttons keep the
 * left and drop from the end when they do not fit.
 */
function navParts(model, { page, width, selectedRunId, stepView = 'overview', stepDetail = false }) {
  const narrow = width < 100;
  const button = (item) => {
    const mark = item.mark ? `${glyphs().ongoing} ` : '';
    // A digit is never a label's key, however the run id spells itself, and a
    // capitalised label ([Help]) still underlines the lower-case key that
    // presses it.
    const at = /^[a-z]$/.test(item.key ?? '') ? item.label.toLowerCase().indexOf(item.key) : -1;
    const label = at >= 0
      ? `${item.label.slice(0, at)}${underline(item.label[at])}${item.label.slice(at + 1)}`
      : item.key ? `${underline(item.key)}.${item.label}` : item.label;
    return item.tight ? `[${mark}${label}]` : `[ ${mark}${label} ]`;
  };
  // The Run page owns its compact footer: navigation back to the catalogue,
  // the selected run chip, and the page-local plan/follow controls. Keeping it
  // in the shell means it is painted once, below the scrollable body, and the
  // same hints are available at every terminal width.
  if (page === 'run') {
    const selected = model.runs.find((run) => run.runId === selectedRunId) ?? model.runs[0] ?? null;
    const items = [];
    items.push({ key: null, label: 'back', action: { kind: 'back' } });
    if (selected) items.push({ key: null, label: `1.${selected.shortId ?? '------'}`, mark: true, tight: false, action: { kind: 'run', runId: selected.runId } });
    const prefix = items.map((item) => button(item)).join(' ');
    const hint = width < 100
      ? ' Enter open · p plan · ? help'
      : ' Enter open step · p plan boxes · Space follow · ? help';
    const available = Math.max(1, width - prefix.length - 2);
    const parts = [{ text: ' ' }];
    items.forEach((item, index) => {
      if (index) parts.push({ text: ' ' });
      parts.push({ text: button(item), action: item.action });
    });
    parts.push({ text: ` ${cut(hint, available)}` });
    return parts;
  }
  if (page === 'step' || page === 'task') {
    const selected = page === 'step'
      ? model.runs.find((run) => run.runId === selectedRunId) ?? model.runs[0] ?? null
      : null;
    const items = [{ key: null, label: 'back', action: { kind: 'back' } }];
    // The phone keeps only its back control and the short hints; the selected
    // run chip is the desktop context marker, matching the Run page footer.
    if (!narrow && selected) {
      items.push({ key: null, label: `1.${selected.shortId ?? '------'}`, mark: true, tight: false, action: { kind: 'run', runId: selected.runId } });
    }
    const prefix = items.map((item) => button(item)).join(' ');
    const view = stepDetail === true ? 'detail' : stepView === 'detail' ? 'detail' : 'overview';
    const hint = stepFooterText(null, { phone: narrow, view });
    const available = Math.max(1, width - prefix.length - 2);
    const parts = [{ text: ' ' }];
    items.forEach((item) => {
      parts.push({ text: button(item), action: item.action });
      parts.push({ text: ' ' });
    });
    // Desktop separates the button group from the prose hint by one extra
    // cell; the phone keeps the compact two-cell gap from the approved frame.
    parts.push({ text: `${narrow ? ' ' : '  '}${cut(hint, available)}` });
    return parts;
  }
  const back = page === 'step' || page === 'task' ? [{ key: null, label: 'back', action: { kind: 'back' } }] : [];
  // The run the reader is on is marked wherever a run is what they are
  // reading; the other pages mark themselves in the tab row instead.
  const onRunPage = page === 'home' || page === 'run' || page === 'step' || page === 'runs';
  const runs = model.runs.map((run, index) => ({
    key: index < 9 ? String(index + 1) : null,
    label: run.shortId ?? '------',
    mark: onRunPage && run.runId === selectedRunId,
    action: { kind: 'run', runId: run.runId },
  }));
  const tail = narrow
    ? [
      { key: null, label: 'Top', tight: true, action: { kind: 'top' } },
      { key: null, label: 'End', tight: true, action: { kind: 'end' } },
      { key: '?', label: 'Help', tight: true, mark: page === 'help', action: { kind: 'page', page: 'help' } },
    ]
    : [
      { key: '?', label: 'help', mark: page === 'help', action: { kind: 'page', page: 'help' } },
      { key: 'q', label: 'quit', action: { kind: 'quit' } },
    ];
  // The way out is the last thing to go: the tail is kept whole and the run
  // buttons fill whatever the terminal has left for them. A terminal too
  // narrow for the whole tail still gets its last button.
  const lineLength = (items) => 1 + items.reduce((sum, item) => sum + visibleLength(button(item)) + 1, 0);
  const moreButton = (count) => ({
    key: null,
    label: `+${count} more`,
    action: { kind: 'page', page: 'runs' },
  });
  // Keep the fixed hints together whenever they fit. If the terminal is too
  // narrow even for those hints, retain the existing fallback of dropping
  // their leftmost entries until at least one remains.
  const fittedTail = [...tail];
  while (fittedTail.length > 1 && lineLength([...back, ...fittedTail]) > width) fittedTail.shift();

  let shown = [...runs];
  let more = null;
  if (lineLength([...back, ...shown, ...fittedTail]) > width) {
    // Once there is overflow, the reader's current run is the useful thing
    // to keep on the phone. Preserve each item's Runs-page digit while
    // moving that selected chip to the front; the remaining visible chips
    // continue in Runs-page order.
    const selected = runs.find((run) => run.mark) ?? runs[0] ?? null;
    const ordered = selected ? [selected, ...runs.filter((run) => run !== selected)] : [];
    shown = ordered.length ? [ordered[0]] : [];
    for (const run of ordered.slice(1)) {
      const hidden = runs.length - (shown.length + 1);
      if (lineLength([...back, ...shown, run, moreButton(hidden), ...fittedTail]) > width) break;
      shown.push(run);
    }
    const hidden = runs.length - shown.length;
    if (hidden > 0) more = moreButton(hidden);
  }

  const parts = [{ text: ' ' }];
  for (const item of [...back, ...shown, ...(more ? [more] : []), ...fittedTail]) {
    parts.push({ text: button(item), action: item.action });
    parts.push({ text: ' ' });
  }
  return parts;
}

/** `skill ✓ · awareness ✓`, plus the mod link and hooks flag for Claude. */
function integrationAgentLine(entry) {
  const ok = glyphs().ok;
  const mark = (installed) => (installed ? ok : '—');
  const parts = [
    `skill ${mark(entry.skill?.status === 'installed')}`,
    `awareness ${mark(entry.awareness === true)}`,
  ];
  if (entry.mod !== undefined) {
    parts.push(`mod ${mark(entry.mod?.status === 'installed')}`, `hooks ${mark(entry.hooksFlag === true)}`);
  }
  return `${String(entry.agent ?? '?').padEnd(8)} ${parts.join(' · ')}`;
}

/** What `installIntegration` changed, agent by agent. */
function installResultLines(result) {
  const lines = [' install results'];
  for (const change of result?.changes ?? []) {
    const parts = [
      `skill ${change.skill?.changed ? 'installed' : 'already installed'}`,
      `awareness ${change.awareness?.reason ?? 'unchanged'}`,
    ];
    if (change.mod) parts.push(`mod ${change.mod.changed ? 'linked' : 'already linked'}`);
    if (change.hooksFlag) parts.push(`hooks flag ${change.hooksFlag.reason ?? 'unchanged'}`);
    lines.push(`   ${change.agent} · ${parts.join(' · ')}`);
  }
  if (lines.length === 1) lines.push('   nothing to change');
  return lines;
}

/**
 * The action a painted row names, when it is one of the run's actions.
 * Boundary-checked so `implement` never matches `implement-two`.
 */
function tileText(tile, width) {
  const value = tile.value ?? blank();
  const spark = tile.spark ? `  ${tile.spark}` : '';
  return cut(`${value}${spark}`, width);
}

function todayPoolMinute(value, nowMs) {
  const started = Date.parse(value?.startedAt ?? '');
  const finished = Date.parse(value?.finishedAt ?? value?.endedAt ?? '');
  const wall = finiteOrNull(value?.wallSec);
  if (wall != null && wall >= 0) return wall / 60;
  const duration = finiteOrNull(value?.durationMs);
  if (duration != null && duration >= 0) return duration / 60_000;
  if (!Number.isFinite(started) || dayKey(value?.startedAt) !== dayKey(nowMs)) return 0;
  return Math.max(0, (Number.isFinite(finished) ? finished : nowMs) - started) / 60_000;
}

function todayLivePoolMinute(value, nowMs) {
  const started = Date.parse(value?.startedAt ?? '');
  if (!Number.isFinite(started)) return 0;
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  return Math.max(0, nowMs - Math.max(started, dayStart.getTime())) / 60_000;
}

/** Metered pools that did work today, followed by the remaining meters. */
function homeLicencePools(model, nowMs) {
  const metered = (model.stats?.overview?.today?.licence?.pools ?? [])
    .filter((pool) => pool?.name && pool.usedPct != null)
    .map((pool) => ({ ...pool, _todayMinutes: 0, _workedToday: false }));
  if (!metered.length) return { pools: [], omitted: 0 };
  const byName = new Map(metered.map((pool) => [pool.name, pool]));
  const add = (name, minutes, worked = true) => {
    const pool = byName.get(name);
    if (!pool) return;
    pool._workedToday ||= worked;
    const amount = finiteOrNull(minutes);
    if (amount != null && amount >= 0) pool._todayMinutes += amount;
  };

  // The spent tile attributes finished workflow rollups to their finish day.
  for (const record of model.rollups ?? []) {
    if (dayKey(record?.finishedAt) !== dayKey(nowMs)) continue;
    for (const [name, entry] of Object.entries(record?.pools ?? {})) {
      const attempts = finiteOrNull(entry?.attempts) ?? 0;
      const minutes = finiteOrNull(entry?.minutes);
      add(name, minutes, attempts > 0 || (minutes != null && minutes > 0));
    }
  }
  // Standalone `bullswarm run` tasks are not workflow rollups, but are still
  // today's worker minutes and must keep their metered pool visible.
  for (const task of model.tasks?.finished ?? []) {
    if (!taskToday(task, nowMs, { finished: true })) continue;
    add(task.pool, todayPoolMinute(task, nowMs));
  }
  for (const task of model.tasks?.inflight ?? []) {
    if (!taskToday(task, nowMs)) continue;
    add(task.pool, todayPoolMinute(task, nowMs));
  }

  const assignmentKeys = new Set();
  for (const assignment of model.assignments ?? []) {
    if (!assignment?.pool || !assignment.startedAt) continue;
    assignmentKeys.add(`${assignment.runId ?? ''}:${assignment.actionId ?? assignment.id ?? ''}`);
    add(assignment.pool, todayLivePoolMinute(assignment, nowMs));
  }
  // A live workflow assignment can briefly be absent while its state record is
  // already running. Include that durable attempt without double-counting an
  // assignment we just saw.
  for (const run of model.runs ?? []) {
    for (const attempt of run?.state?.attempts ?? []) {
      if (!attempt?.pool || attempt.status !== 'running' || !attempt.startedAt) continue;
      const key = `${run.runId ?? ''}:${attempt.actionId ?? attempt.id ?? ''}`;
      if (assignmentKeys.has(key)) continue;
      add(attempt.pool, todayLivePoolMinute(attempt, nowMs));
    }
  }

  const worked = metered.filter((pool) => pool._workedToday)
    .sort((a, b) => b._todayMinutes - a._todayMinutes || a.name.localeCompare(b.name));
  const idle = metered.filter((pool) => !pool._workedToday)
    .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0) || a.name.localeCompare(b.name));
  return { pools: [...worked, ...idle], omitted: 0 };
}

function licencePoolName(value, cellWidth) {
  const full = String(value ?? '');
  const suffix = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full;
  // A pool identity is kept whole when the cell has ordinary room. If it
  // cannot fit, switch at the provider boundary; never paint an ellipsis into
  // a pool name that looks like a different provider.
  if (cellWidth >= 12 && full.length <= Math.max(12, cellWidth - 8)) return full;
  const suffixRoom = Math.max(1, cellWidth - 8);
  return suffix.length <= suffixRoom ? suffix : '';
}

/**
 * Keep the Home tile honest when a short viewport cannot paint every meter.
 * Worked pools are always retained; only the idle tail may collapse into the
 * explicit `+N pools` row.
 */
function homeLicenceDisplay(order, { narrow = false, bodyHeight = null, height = 36 } = {}) {
  const pools = order?.pools ?? [];
  const worked = pools.filter((pool) => pool._workedToday);
  // Home reserves room for its summary, in-flight block and recent history.
  // A normal frame therefore grows naturally; only genuinely short frames
  // exercise the summary row.
  const available = Number(bodyHeight) || Math.max(1, Number(height) - 2);
  const reserve = narrow ? 8 : 9;
  const rowBudget = Math.max(1, available - reserve);
  if (pools.length <= rowBudget || !pools.length) return { pools, omitted: 0 };
  const idle = pools.filter((pool) => !pool._workedToday);
  const idleSlots = Math.max(0, rowBudget - worked.length - 1);
  const shown = [...worked, ...idle.slice(0, idleSlots)];
  return { pools: shown, omitted: Math.max(0, pools.length - shown.length) };
}

/**
 * `widget-lib@cmd ▇▇▇▇▇▇░░░░ 15m/17m`, the per-step bar the prototype draws
 * beside the plan strip.
 *
 */
function integrationLines(model, opts, body) {
  const { width } = opts;
  body.push('');
  body.push(rule('agents', null, width));
  const installed = model.integration?.ok === true;
  const button = installed ? `[installed ${glyphs().ok}]` : '[install]';
  const prefix = ' agent integration  ';
  const suffix = installed ? ' · every agent already has it' : ' · i installs the skill and the awareness block for every agent';
  const fits = visibleLength(prefix) + visibleLength(button) + visibleLength(suffix) <= width;
  body.parts([
    { text: prefix },
    { text: button, action: installed ? null : { kind: 'install' } },
    { text: fits ? dimText(suffix, Math.max(0, width - visibleLength(prefix) - visibleLength(button))) : '' },
  ]);
  if (!model.integration) {
    body.push(dimText('   reading the agent integration…', width));
  } else {
    for (const entry of model.integration.agents ?? []) {
      body.push(dimText(`   ${integrationAgentLine(entry)}`, width));
    }
    if (model.installResult) {
      for (const line of installResultLines(model.installResult)) body.push(dimText(truncate(line, width), width));
    }
  }

  body.push('');
  body.push(rule('run it', null, width));
  for (const command of DASHBOARD_COMMANDS) body.push(dimText(`   ${command}`, width));
  return ' bullswarm · runs';
}

// ------------------------------------------------------------ Run and Step

/**
 * Plan-strip metadata is all-or-nothing for pool and model names. A short
 * cell drops the pool first, then the model; it never paints `openc…` (or any
 * other partial pool name) as if that were an identity.
 */
function planAttemptMeta(attempt, width) {
  const cols = Math.max(0, Number(width) || 0);
  const pool = attempt?.pool ? String(attempt.pool) : null;
  const model = attempt?.model ? String(attempt.model) : null;
  const effortValue = attempt?.effort ?? attempt?.routing?.effort;
  const effort = effortValue ? String(effortValue) : null;
  const candidates = [
    [pool, model, effort],
    [model, effort],
    [effort],
    [],
  ];
  for (const candidate of candidates) {
    const text = candidate.filter(Boolean).join(' · ');
    if (!text || text.length <= cols) return text;
  }
  return '';
}

/** Budget: every pool's licence meter, its money and what still fits. */
function budgetPage(model, opts, body) {
  const { width } = opts;
  const sampled = model.budget?.sampleAgeText ? ` · sampled ${model.budget.sampleAgeText}` : '';
  if (!model.budget) {
    body.push(dimText(' reading the pool meters…', width));
    if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
    return ` Budget · this week${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
  }
  pushView(body, budgetLines(model.budget, { width, ansi: meterAnsi(), nowMs: opts.nowMs }));
  if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
  return ` Budget · ${model.budget.days ?? 7} days to ${model.budget.timeZone ?? 'local'}${sampled}${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
}

/** Fleet: the rungs by lane or by provider, read-only. */
function fleetPage(model, opts, body) {
  const { width } = opts;
  const by = FLEET_TABS.includes(opts.fleetBy) ? opts.fleetBy : 'lane';
  const view = fleetLines(model.pools, model.rungs, { width, by, nowMs: opts.nowMs, ansi: meterAnsi() });
  const before = body.lines.length;
  pushView(body, view);
  // fleet-view records its own sub-tab and `[ edit ]` regions, so the shell
  // only has to remember which row they were painted on for the scroll.
  const tabs = (view?.regions ?? []).find((region) => region?.action?.kind === 'tab');
  if (tabs?.y) body.anchor = { tabs: before + Number(tabs.y) };
  return ` Fleet · by ${by}`;
}

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

/** Stats: the four shared surfaces and the three periods. */
function statsPage(model, opts, body) {
  const { width } = opts;
  const tab = STATS_TABS.includes(opts.statsTab) ? opts.statsTab : 'spending';
  const stackBy = opts.statsStackBy === 'model' ? 'model' : 'pool';
  if (!model.stats) {
    body.push(dimText(' reading the rollup index…', width));
    return ' Stats';
  }
  const slice = opts.slice ?? null;
  const view = statsLines(model.stats, {
    width, height: opts.height, tab, period: opts.period, stackBy,
    ansi: meterAnsi(), slice,
  });
  // stat-kit deliberately keeps legend markers as presentation text.  The
  // shell adds the same durable bar action to the matching legend name so a
  // legend tap has the exact same label/pin affordance as a chart or panel
  // bar, without making the marker itself a second drawing system.
  const statsView = alignStatsShareRegions(addStatsLegendRegions(view));
  const activeSeries = slice?.payload?.series ?? slice?.series ?? null;
  if (activeSeries && meterAnsi()) boldStatsLegend(statsView, activeSeries);
  pushView(body, statsView);
  body.anchor = { tabs: 1 };
  return ` Stats · ${tab}`;
}

/** History: every workflow by date, newest first, older days on scroll. */
function historyPage(model, opts, body) {
  const { width } = opts;
  // `historyDays` files each record under the day it belongs to (history.js
  // H5), so the page draws the rows the model carries rather than rejoining
  // the index by day key here.
  const days = model.days ?? [];
  pushView(body, historyLines(days, { width, ansi: meterAnsi() }));
  if (!days.length) {
    body.push(dimText(' bullswarm workflow reindex backfills the history index from the run directories', width));
  }
  return ` History · ${days.length} day${days.length === 1 ? '' : 's'}`;
}

/** History's note: how many days are loaded, right above the bottom nav. */
function historyPageNotes(model, { width }, notes) {
  const days = daysWithTasks(model.days, model.tasks?.finished);
  for (const line of historyNote(days, { width })) notes.push(dimText(line, width));
}

/**
 * Help: every key and every click, grouped by what it is for.
 *
 * Keys that do the same kind of thing share a row — `r b s y f → Runs ·
 * Budget · Stats · History · Fleet` — so the page is about thirty rows rather
 * than one row per binding, and every row still fits the 54 columns the phone
 * frame paints. The key names are bold; the sentence beside them is not.
 *
 * Nothing here claims a key the shell does not run: the rows are built from
 * DASHBOARD_KEYS, so a rebinding moves the page with it.
 */
function helpPage(model, opts, body) {
  const { width } = opts;
  const narrow = width < 60;
  const keyWidth = narrow ? 12 : 16;
  const row = (keys, text) => {
    const label = ` ${strong(String(keys))}`;
    const pad = ' '.repeat(Math.max(1, keyWidth - visibleLength(String(keys))));
    body.push(cut(`${label}${pad}${text}`, width));
  };
  /** One row from several key names, the way the shell groups them. */
  const grouped = (names, text) => row(names.map((name) => DASHBOARD_KEYS[name].keys).join(' '), text);

  body.push(tint(truncate(narrow ? ' keys and clicks' : ' every key and click on this dashboard', width), 'dim'));
  body.push(rule('pages', null, width));
    grouped(['runs', 'budget', 'stats', 'fleet'], 'Runs · Budget · Stats · Fleet');
  row(DASHBOARD_KEYS.home.keys, 'Home');
  // History is the day table inside Runs now, so `y` is a jump, not a page.
  row(DASHBOARD_KEYS.history.keys, narrow ? 'the first day of Runs' : 'Runs, at the first day of its history');
  row(DASHBOARD_KEYS.help.keys, 'this help');
  row(DASHBOARD_KEYS.out.keys, narrow ? 'back, then Home' : 'back from a step, otherwise Home');
  row(DASHBOARD_KEYS.openRun.keys, 'open the numbered run in the nav');
  row(DASHBOARD_KEYS.in.keys, 'open the run, its steps, then one step');
  // Budget has no sub-tabs; Stats and Fleet do, and this says only that.
  row(DASHBOARD_KEYS.nextTab.keys, 'next sub-tab on Stats and Fleet');
  row(DASHBOARD_KEYS.cycleWorkflow.keys, 'cycle workflows');
  row(DASHBOARD_KEYS.period.keys, narrow ? 'period: 7 days · 30 days · all' : 'cycle the period: 7 days · 30 days · all time');

  body.push('');
  body.push(rule('moving', null, width));
  grouped(['up', 'down'], 'scroll one line');
  grouped(['pageUp', 'pageDown'], 'scroll a screen');
  grouped(['top', 'end'], 'top · bottom');
  row('wheel', 'scrolls the body under the sticky header');

  body.push('');
  body.push(rule('clicks', null, width));
  row('tab · period', 'the tab row opens a page · the toggle sets the period');
  row('tile', narrow ? 'a today number opens its chart' : "a today number opens its chart in Stats › Trends");
  row('bar', 'a breakdown bar opens its Stats tab · a trend bar opens its day');
  row('pool', 'a pool name or meter opens Budget on it');
  row('step', 'a plan glyph or step row opens the step');
  row('run', 'a run row or nav button opens the run');

  body.push('');
  body.push(rule('other', null, width));
  row('e · c · y', 'edit the fleet · stop this workflow · y confirms it');
  row('/ · a · i', 'filter · active/all · install (on Runs)');
  row('o · v · t', 'planner · technical · phases (on Run) · Stats By Pool/By Model');
  row(DASHBOARD_KEYS.copy.keys, 'copy the screen · OSC 52, else pbcopy/wl-copy');
  row(DASHBOARD_KEYS.detach.keys, 'quit to the shell; workflows keep running');
  row('under 100', 'Fleet leaves the tab row until f opens it');
  row('under 100', 'the nav tail is [Top] [End] [?.Help]');
  row('rebound', 'r was refresh · b was back · Tab was workflows');
  integrationLines(model, opts, body);
  return ' bullswarm · help';
}

/**
 * One frame of the dashboard: the page tab row, the sticky header, the body
 * window, the message line, the notes, and the sticky bottom nav — plus the
 * hit regions the mouse handler answers to.
 *
 * @param {object} model as `dashboardModel` builds it
 * @param {object} [options] width, height, page and the page's own state
 * @returns {{page: string, lines: string[], regions: Array<{x1: number, x2: number, y: number, action: object}>}}
 */
export function renderDashboardPage(model, options = {}) {
  const width = Math.max(20, Number(options.width) || 120);
  const height = Math.max(12, Number(options.height) || 36);
  const page = DASHBOARD_PAGES.includes(options.page)
    ? options.page
    : Number(options.focus) >= 2 ? 'step' : 'run';
  const opts = {
    ...options,
    width,
    height,
    page,
    narrow: options.narrow ?? width < 100,
    period: PERIODS.includes(options.period) ? options.period : '7d',
    statsTab: STATS_TABS.includes(options.statsTab) ? options.statsTab : 'spending',
    statsStackBy: options.statsStackBy === 'model' ? 'model' : 'pool',
    metric: TREND_METRICS.includes(options.metric) ? options.metric : 'runs',
    fleetBy: FLEET_TABS.includes(options.fleetBy) ? options.fleetBy : 'lane',
    nowMs: Number(options.nowMs) || model.nowMs || Date.now(),
  };
  const message = options.filterEditing
    ? `Filter: ${options.query ?? ''}█ · Enter apply · Esc clear`
    : options.confirmCancel
      ? 'Stop this workflow? y confirm · n/Esc keep running'
      : options.message ?? null;
  const messageLines = message ? [dimText(` ${message}`, width)] : [];
  const notes = frameBuilder();
  if (page === 'budget' && model.budget) {
    for (const line of budgetNotes(model.budget, { width })) notes.push(dimText(truncate(line, width), width));
  }
  if (page === 'history' || page === 'runs') historyPageNotes(model, opts, notes);
  const bodyHeight = Math.max(1, height - 2 - messageLines.length - notes.lines.length - 1);

  const body = frameBuilder();
  let header = '';
  // A legacy run is five read-only fields and a marker: its page is that one
  // line, still inside the shell so the nav can carry the reader back out.
  const legacyLine = model.row?.legacy
    ? legacyRunLine({ shortId: model.row.shortId, runId: model.row.runId, runDir: model.row.runDir })
    : null;
  if (legacyLine && (page === 'run' || page === 'step')) {
    body.row(legacyLine);
    body.push('');
    body.push(dimText(' read-only · the executor for authored-graph runs was removed; nothing here can be driven', width));
    header = ` ${model.row.shortId ?? model.row.runId ?? '------'} legacy`;
  } else if (page === 'home') header = homePage(model, { ...opts, bodyHeight }, body);
  else if (page === 'runs') header = runsPage(model, opts, body);
  else if (page === 'budget') header = budgetPage(model, opts, body);
  else if (page === 'stats') header = statsPage(model, opts, body);
  else if (page === 'history') header = runsPage(model, opts, body);
  else if (page === 'fleet') header = fleetPage(model, opts, body);
  else if (page === 'help') header = helpPage(model, opts, body);
  else if (page === 'step' || page === 'task') {
    if (page === 'task') {
      const taskStep = taskStepModel(model.task, {
        runsDir: model.taskRoot ?? model.taskRunsDir ?? null,
        nowMs: opts.nowMs,
        view: opts.stepView,
        expandedTurn: opts.stepExpandedTurn,
        selectedEventIndex: opts.stepSelectedEventIndex,
        attemptOrdinal: opts.stepAttemptOrdinal,
        activityFilter: opts.stepFilter,
        follow: opts.stepFollow,
      });
      header = renderStepPage(taskStep, { ...opts, bodyHeight }, body);
    } else {
      const stepPanel = workflowPanelModel(model.row, {
        phaseIndex: opts.phaseIndex,
        agentIndex: opts.agentIndex,
      });
      const stepActionId = stepPanel.selectedAgent?.action?.id
        ?? stepPanel.selectedPhase?.actions?.[0]?.id
        ?? null;
      const step = stepPageModel(model, {
        phaseIndex: opts.phaseIndex,
        agentIndex: opts.agentIndex,
        actionId: stepActionId,
        nowMs: opts.nowMs,
        selectedEventIndex: opts.stepSelectedEventIndex,
        attemptOrdinal: opts.stepAttemptOrdinal,
        activityFilter: opts.stepFilter,
        follow: opts.stepFollow,
        view: opts.stepView,
        expandedTurn: opts.stepExpandedTurn,
      });
      header = renderStepPage(step, { ...opts, bodyHeight }, body);
    }
  }
  else header = runPage(model, { ...opts, bodyHeight }, body);

  const frame = frameBuilder();
  frame.kit(pageTabs(page, width));
  if (page === 'runs' || page === 'history') {
    const padding = Math.max(0, (body.anchor?.history ?? 1) - 1 + bodyHeight - body.lines.length);
    for (let index = 0; index < padding; index += 1) body.push('');
  }
  const window = windowOf(body, { height: bodyHeight, scroll: opts.bodyScroll });
  frame.push(truncate(`${header}${window.position}`, width));
  drawWindow(frame, body, window);
  // The nav is sticky at the bottom: a body shorter than its window is padded
  // out to it rather than leaving the nav floating up the screen.
  for (let row = window.end - window.offset; row < bodyHeight; row += 1) frame.push('');
  for (const line of messageLines) frame.push(line);
  drawWindow(frame, notes, windowOf(notes, { height: notes.lines.length }));
  const nav = frameBuilder();
  nav.parts(navParts(model, {
    page,
    width,
    selectedRunId: opts.selectedRunId ?? model.row?.runId ?? null,
    stepView: opts.stepView,
    stepDetail: opts.stepDetail,
  }));
  drawWindow(frame, nav, windowOf(nav, { height: 1 }));

  const lines = frame.lines.slice(0, height).map((line) => (visibleLength(line) > width ? cut(line, width) : line));
  return {
    page,
    lines,
    // How tall the body was and how much of it the window showed, so a caller
    // knows when the reader has reached the end of what is loaded.
    body: { total: window.total, offset: window.offset, end: window.end },
    regions: frame.regions.filter((region) => region.y >= 1 && region.y <= lines.length && region.x1 <= width),
    // Where a page marked something worth scrolling to (a sub-tab row), as a
    // row of its body, so a caller can bring it into the window.
    anchor: body.anchor ?? null,
    runRows: body.runRows ?? [],
    taskRows: body.taskRows ?? [],
    cursorAction: body.cursorAction ?? null,
  };
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
  clipboard = writeClipboard,
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
    const text = `${details}\n\n${timeline}`.replace(ANSI_SGR, '');
    output.write(`${text}\n`);
    return 0;
  }
  let selected = 0;
  const directRow = token ? detailRow(bullswarmDir, token) : null;
  // A legacy run has no drilldown: its page is the one line the CLI prints.
  const directV2 = Boolean(directRow) && !directRow.legacy;
  let message = null;
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
    if (lastPaintedFrame != null && Array.isArray(lastPaintedLines) && lastPaintedLines.length === lines.length) {
      let patch = '';
      let changed = 0;
      for (let row = 0; row < lines.length; row += 1) {
        if (lines[row] === lastPaintedLines[row]) continue;
        changed += 1;
        patch += `${ESC}${String(row + 1)};1H${lines[row]}${ESC}K`;
      }
      if (!changed) return;
      lastPaintedLines = lines.slice();
      lastPaintedFrame = patch;
      output.write(patch);
      return;
    }
    const frame = `${ESC}H${lines.map((line) => `${line}${ESC}K`).join('\n')}`;
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
      ? [...(tasks.inflight ?? []), ...(tasks.finished ?? [])].find((entry) => (entry.id ?? entry.taskFile) === selectedTaskId) ?? null
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
      void readUsage();
    } catch (err) { message = `display error: ${err.message}`; }
    // On the Runs page the cursor may sit on a finished row of the day table,
    // which the active-only catalogue does not hold; a refresh must not drag
    // it back onto the in-flight run, or Enter opens the wrong workflow.
    const tableKeepsCursor = ui.page === 'runs'
      && (lastFrameResult?.runRows ?? []).some((row) => row.runId === previousRunId);
    const taskStillExists = [...(tasks.inflight ?? []), ...(tasks.finished ?? [])]
      .some((row) => (row.id ?? row.taskFile) === previousTaskId);
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
    }
    message = null;
    paint();
  };
  /** Opens the Step page on one action, in the phase that holds it. */
  const openStep = (actionId, runId = null) => {
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
    ui.stepAttemptOrdinal = null;
    ui.stepFollow = true;
    ui.stepFilter = 'all';
    ui.stepToolPage = 0;
    bodyScroll = 0;
    paint();
  };
  /** Opens the compact detail page for one standalone task. */
  const openTask = (taskId) => {
    const found = [...(tasks.inflight ?? []), ...(tasks.finished ?? [])]
      .find((entry) => (entry.id ?? entry.taskFile) === taskId);
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
    message = null;
    return paint();
  };
  /** Opens a page, reading whatever that page needs the first time. */
  const openPage = (page, { pool = null } = {}) => {
    if (!DASHBOARD_PAGES.includes(page)) return paint();
    if (page !== 'stats') clearSliceState();
    const historyJump = page === 'history';
    if (historyJump) page = 'runs';
    if (page === 'runs') ensureCatalog();
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
    if (action.kind === 'step') return openStep(action.actionId, action.runId ?? null);
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
  const HOVER_KINDS = new Set(['run', 'step', 'task']);
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
          ? entry.taskId === selectedTaskId
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
        ? entry.taskId === selectedTaskId
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
        const visibleSegments = new Set(workflowTimelineLines(model, Math.max(20, frameWidth() - 2)).lines
          .filter((line) => line?.header)
          .map((line) => line.segment));
        const navigable = [
          ...(visibleSegments.has('Preflight') ? [{ selection: 0, phaseIndex: null }] : []),
          ...model.phases
            .map((phase, index) => ({ phase, selection: index + 1, phaseIndex: index }))
            .filter(({ phase }) => visibleSegments.has(phase.label)),
        ];
        if (navigable.length) {
          const current = navigable.findIndex((target) => target.selection === ui.timelineSelection);
          const base = current >= 0 ? current : (delta < 0 ? navigable.length : -1);
          const target = navigable[clamp(base + delta, 0, navigable.length - 1)];
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
      if (ui.page === 'runs') {
        const task = lastFrameResult?.taskRows?.find((entry) => entry.taskId === selectedTaskId)
          ?? (lastFrameResult?.cursorAction?.kind === 'task' ? lastFrameResult.cursorAction : null);
        if (task) return openTask(task.taskId);
      } else {
        const action = lastFrameResult?.cursorAction;
        if (action?.kind === 'task') return openTask(action.taskId);
        if (action?.kind === 'run') return openRun(action.runId);
      }
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
          .find((entry) => (entry.id ?? entry.taskFile) === selectedTaskId) ?? null
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
        if (ui.stepView === 'overview' && turns.length) {
          const current = Number.isInteger(ui.stepTurnIndex)
            ? ui.stepTurnIndex
            : Number.isInteger(step.activity?.expandedTurn) ? step.activity.expandedTurn : (delta > 0 ? -1 : turns.length);
          const next = clamp(current + delta, 0, turns.length - 1);
          ui.stepTurnIndex = next;
          ui.stepSelectedEventIndex = turns[next]?.responseIndex ?? null;
          ui.stepFollow = false;
          ui.stepToolPage = 0;
          return;
        }
        if (!activityIndices.length) return;
        const at = activityIndices.findIndex((index) => Number(index) === Number(ui.stepSelectedEventIndex ?? step.activity?.selectedIndex));
        const next = clamp((at < 0 ? (delta > 0 ? -1 : activityIndices.length) : at) + delta, 0, activityIndices.length - 1);
        ui.stepSelectedEventIndex = activityIndices[next] ?? null;
        ui.stepFollow = false;
        ui.stepDetail = false;
      };
      if (keyPressed('up', key)) { moveSelection(-1); return paint(); }
      if (keyPressed('down', key)) { moveSelection(1); return paint(); }
      if (key === '\t' || key === '\x1b[Z') {
        const at = STEP_SECTIONS.indexOf(ui.stepSection);
        const delta = key === '\x1b[Z' ? -1 : 1;
        ui.stepSection = STEP_SECTIONS[(at + delta + STEP_SECTIONS.length) % STEP_SECTIONS.length];
        ui.stepDetail = false;
        bodyScroll = Math.max(0, Number(lastFrameResult?.anchor?.step?.[ui.stepSection] ?? 1) - 1);
        return paint();
      }
      if (key === '\r' || key === '\n') {
        if (ui.stepSection === 'activity' && ui.stepView === 'overview' && step.activity?.turns?.length) {
          const target = Number.isInteger(ui.stepTurnIndex)
            ? ui.stepTurnIndex
            : Number.isInteger(step.activity?.expandedTurn) ? step.activity.expandedTurn : 0;
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
      if (key === 'v' || key === 'V') {
        ui.stepView = ui.stepView === 'detail' ? 'overview' : 'detail';
        ui.stepDetail = false;
        ui.stepExpandedTurn = null;
        ui.stepToolPage = 0;
        return paint();
      }
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

// Home and Runs view modules consume these shell-owned primitives. Keeping the
// compatibility exports here lets existing Step/CLI callers retain their
// dashboard import path while page-specific functions move out of this file.
export {
  workflowPanelModel,
  runEconomics,
  SIDEBAR_WIDTH,
  compactUsage,
  tokenText,
  renderPanel,
  joinPanels,
  panelWindow,
  panelCell,
  dimLine,
  clamp,
  pushView,
  selectLine,
  stateStatus,
  stateStartedAt,
  stateFinishedAt,
  TERMINAL_ACTIONS,
  timelineText,
  workflowRunLabel,
  workflowStatusIcon,
  PERIOD_ITEMS,
  strong,
  pushColumns,
  TOKEN_SOURCE_RANK,
  SUBSCRIPTION_BASIS_RANK,
  tokenSourceOf,
  worstTokenSource,
  worstSubscriptionBasis,
  usageBasisText,
  ageText,
  clockAt,
  okMark,
  failMark,
  runningMark,
  pendingMark,
  planProgress,
  planStripParts,
};
