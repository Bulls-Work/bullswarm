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
import { formatMoney, formatMoneyPair } from '../lib/usage-basis.js';
// N1: a missing measurement never becomes a confident zero. Number(null) is
// 0 and Number.isFinite(0) is true, so every reading below goes through this.
import { finiteOrNull } from '../lib/num.js';
// The Usage page's `[edit]` hands the terminal to the same control centre
// `bullswarm setup` opens, so the rungs the reader just saw and the ones they
// are about to change are the same program's.
import { openSetupTui as openSetupControlCentre } from '../setup.js';

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
function reasoningText(attempt) {
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

function isWaitingWorkflow(state) {
  const value = String(stateStatus(state) ?? '').toLowerCase();
  return value.includes('waiting') || value === 'paused';
}

function workflowRunLabel(row) {
  const state = row?.state ?? {};
  // A legacy row carries only the workflow name and goal it recorded.
  if (row?.legacy) return String(state.name ?? state.goal ?? row?.runId ?? 'workflow').split('\n')[0].trim();
  return String(state.intent?.goal ?? state.intent?.description ?? row?.runId ?? 'workflow')
    .split('\n')[0]
    .trim();
}

function workflowConcernCount(row) {
  const concerns = row?.state?.outcome?.concerns ?? row?.report?.concerns ?? [];
  return Array.isArray(concerns) ? concerns.length : 0;
}

function dashboardRunLines(rows, selected, narrow, width) {
  if (!rows.length) return [{ selected: false, lines: ['No workflows in this view.'] }];
  return rows.map((row, index) => {
    const state = row.state ?? {};
    const selectedRow = index === selected;
    const legacy = Boolean(row.legacy);
    const durableStatus = legacy ? state.status : stateStatus(state);
    const icon = legacy ? '·'
      : row.ongoing ? statusIcon(durableStatus ?? 'running')
        : workflowStatusIcon({ status: durableStatus });
    const elapsed = legacy
      ? durationText(state.startedAt, state.finishedAt)
      : durationText(stateStartedAt(state) ?? row.report?.startedAt, stateFinishedAt(state) ?? row.report?.finishedAt);
    const workerAttempts = legacy ? [] : (state.attempts ?? []).filter((attempt) =>
      attempt.actionId !== state.orchestration?.actionId && attempt.actionId !== 'orchestrator');
    const finished = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
    // A legacy row claims no progress: 0.27.0 never reads its steps.
    let progress = legacy ? 'legacy'
      : workerAttempts.length
        ? `${finished}/${workerAttempts.length} workers`
        : `${row.stepsOk ?? 0}/${row.stepsTotal ?? 0} actions`;
    const concerns = legacy ? 0 : workflowConcernCount(row);
    const status = concerns ? `${concerns} concern${concerns === 1 ? '' : 's'}` : humanWorkflowStatus(durableStatus, row.ongoing);
    const name = workflowRunLabel(row);
    const phase = legacy ? 'legacy' : humanPhaseName(row.phase ?? 'starting');
    const economics = legacy ? null : runEconomics(row, [], Date.now());
    const spend = economics ? moneyText(economics) : null;
    const spendLabel = spend ?? (legacy ? null : 'cost unknown');
    if (narrow) {
      const inner = Math.max(1, width - 4);
      return {
        selected: selectedRow,
        lines: [
          selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, inner),
          selectLine(`  ${progress} · ${elapsed}${spendLabel ? ` · ${spendLabel}` : ''}`, selectedRow, false, inner),
          selectLine(`  ${phase} · ${status}`, selectedRow, false, inner),
          '',
        ],
      };
    }
    return {
      selected: selectedRow,
      lines: [
        selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, 44),
        selectLine(`  ${progress} · ${elapsed} · ${status}${spendLabel ? ` · ${spendLabel}` : ''}`, selectedRow, false, 44),
        '',
      ],
    };
  });
}

function listWindow(groups, selected, height, narrow) {
  const linesPerGroup = narrow ? 4 : 3;
  const capacity = Math.max(1, Math.floor(height / linesPerGroup));
  const start = clamp(selected - Math.floor(capacity / 2), 0, Math.max(0, groups.length - capacity));
  return groups.slice(start, start + capacity).flatMap((group) => group.lines).slice(0, height);
}

function humanWorkflowStatus(status, ongoing) {
  const value = String(status ?? '').replaceAll('_', ' ');
  if (ongoing && (!value || value === 'running')) return 'running';
  if (value === 'completed') return 'finished';
  if (value === 'completed with concerns') return 'finished with concerns';
  return value || (ongoing ? 'running' : 'finished');
}

function humanPhaseName(value) {
  return String(value ?? 'starting').replaceAll('-', ' ').replaceAll(':', ' › ');
}

function filterDashboardRows(rows, filter, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  return (rows ?? []).filter((row) => {
    if (filter === 'active' && !row.ongoing) return false;
    if (!needle) return true;
    const state = row.state ?? {};
    return [row.shortId, row.runId, state.name, state.goal, state.intent?.goal, row.phase, row.status, stateStatus(state)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
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

export function workflowPanelModel(row, { phaseIndex = null, agentIndex = null } = {}) {
  const state = row.state;
  const actionDefinitions = new Map((state.program?.actions ?? []).map((action) => [action.id, action]));
  const actionStates = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const dependencyGroups = isProgramWorkflow(state);
  const stages = dependencyGroups ? projectV2DependencyStages(state) : state.presentation?.stages ?? [];
  const currentStageIndex = Math.max(0, stages.findIndex((stage) => stage.actionIds.some((id) => ['running', 'ready'].includes(actionStates.get(id)?.status))));
  const selectedPhaseIndex = clamp(phaseIndex == null ? currentStageIndex : phaseIndex, 0, Math.max(0, stages.length - 1));
  const phases = stages.map((stage) => {
    const progress = presentationStageStatus(stage, state.actions);
    const actionEntries = stage.actionIds.map((id) => ({ ...actionDefinitions.get(id), ...actionStates.get(id) }));
    const active = actionEntries.some((action) => action.status === 'running');
    const failed = actionEntries.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
    return {
      name: stage.id, label: stage.label,
      status: active ? 'active' : stage.completedAt ? (failed ? 'failed' : 'completed') : stage.startedAt ? 'waiting' : 'pending',
      actions: actionEntries, completed: progress.completed, total: progress.total,
      blockedActions: actionEntries.filter((action) => action.status === 'blocked').map((action) => ({ id: action.id, kind: 'action', blockedBy: action.dependsOn ?? [] })),
    };
  });
  if (!phases.length) phases.push({ name: 'planning', label: 'Planning', status: state.planner.status === 'running' ? 'active' : 'pending', actions: [], completed: 0, total: 0, blockedActions: [] });
  const selectedPhase = phases[selectedPhaseIndex] ?? phases[0];
  const agents = [];
  for (const action of selectedPhase.actions) {
    for (const attempt of (state.attempts ?? []).filter((entry) => entry.actionId === action.id)) {
      agents.push({
        key: `attempt:${attempt.id}`, action, attempt: { ...attempt, attemptNumber: attempt.ordinal, outFile: attempt.outputFile },
        active: attempt.status === 'running' ? { ...attempt, stepId: action.id, attempt: attempt.ordinal, outFile: attempt.outputFile } : null,
        pool: attempt.pool ?? 'unassigned', model: attempt.model ?? 'connector model',
        // A worker stopped by a plan revision or a pause did not fail; say why it stopped.
        status: attempt.status === 'cancelled' && ['superseded', 'paused'].includes(attempt.failureKind) ? attempt.failureKind : attempt.status,
      });
    }
  }
  const activeIndex = Math.max(0, agents.findIndex((agent) => agent.status === 'running'));
  const selectedAgentIndex = agents.length ? clamp(agentIndex == null ? activeIndex : agentIndex, 0, agents.length - 1) : 0;
  const callerPlanned = (state.config?.settings?.plannerMode ?? 'caller') === 'caller';
  const plannerAttempts = state.planner?.attempts ?? [];
  const latestPlanner = plannerAttempts.at(-1) ?? null;
  const activePlanner = plannerAttempts.findLast((attempt) => attempt.status === 'running') ?? null;
  const orchestrator = {
    autonomous: true, actionId: 'workflow-planner', attempts: plannerAttempts,
    active: activePlanner, latestAttempt: latestPlanner,
    status: state.planner.status,
    // In caller mode no planner agent is ever dispatched, so "selecting ·
    // connector model" would describe a process that cannot exist.
    pool: activePlanner?.pool ?? latestPlanner?.pool ?? state.config?.plannerRouting?.pool ?? state.config?.plannerRouting?.preferredPool
      ?? (callerPlanned ? 'caller' : 'selecting'),
    model: activePlanner?.model ?? latestPlanner?.model ?? state.config?.plannerRouting?.model ?? state.config?.plannerRouting?.preferredModel
      ?? (callerPlanned ? 'you are the planner' : 'connector model'),
    latestDecision: state.planner.lastDecision,
  };
  return {
    row, state, stages, dependencyGroups, events: row.events ?? [], orchestrator, phases,
    phaseIndex: selectedPhaseIndex, selectedPhase, agents,
    agentIndex: selectedAgentIndex, selectedAgent: agents[selectedAgentIndex] ?? null,
  };
}

/**
 * The Run and Step pages' panels: the hierarchy the viewer always drew — the
 * timeline/Live/Next overview, the phases, the agents, the agent detail — laid
 * out for a body of `bodyHeight` rows. The page around it owns the sticky
 * header, the pools and the nav.
 */
function runFrame(row, {
  width = 120, height = 36, focus = 0, phaseIndex = null, agentIndex = null,
  detailScroll = 0, message = null, confirmCancel = false,
  controlSelected = false, orchestratorDetail = false, orchestratorVerbose = false,
  workflowVerbose = false, mobileTimeline = true, timelineSelection = null,
  spinnerFrame = 0, bodyHeight: pageBodyHeight = null,
} = {}) {
  width = Math.max(20, Number(width) || 120);
  height = Math.max(18, Number(height) || 36);
  const narrow = width < 100;
  const model = workflowPanelModel(row, { phaseIndex, agentIndex });
  const state = model.state;
  const status = row?.status ?? stateStatus(state) ?? 'starting';
  const elapsed = durationText(stateStartedAt(state), stateFinishedAt(state));
  const phaseComplete = model.selectedPhase.completed;
  const phaseTotal = model.selectedPhase.total;
  const attempts = state.attempts ?? [];
  const workerAttempts = attempts.filter((attempt) => attempt.actionId !== model.orchestrator.actionId);
  const finishedAgents = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const agentProgress = workerAttempts.length ? `${finishedAgents}/${workerAttempts.length} workers · ` : '';
  const terminalLabel = stateFinishedAt(state)
    ? ` · ${status === 'completed' ? 'done' : status}${isProgramWorkflow(state) && status === 'completed' ? hasPassingRequirementEvidence(state) ? ' · evidence passed' : ' · unverified' : ''}`
    : '';
  const runName = state.workflow ?? row?.shortId ?? state.shortId ?? row?.runId ?? 'workflow';
  // The page's sticky header names the run the way the nav's own button does;
  // the body below is the hierarchy, sized to the page's window.
  const bodyHeight = Math.max(6, Number(pageBodyHeight) || height - 8);

  const phaseLines = [];
  model.phases.forEach((phase, index) => {
    const icon = statusIcon(phase.status, spinnerFrame);
    const count = phase.total ? ` ${phase.completed}/${phase.total}` : '';
    phaseLines.push(selectLine(
      `${index + 1} ${icon} ${phase.label}${count}`,
      index === model.phaseIndex && !controlSelected,
      focus === 0 && !controlSelected,
      width,
    ));
  });

  const agentLines = [];
  if (!model.agents.length) {
    const blockedActions = model.selectedPhase.blockedActions ?? [];
    if (blockedActions.length) {
      for (const blocked of blockedActions) {
        agentLines.push(dimLine(
          `${glyphs().blocked} ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : 'a failed dependency'}`,
          width,
        ));
      }
    } else agentLines.push(dimLine('Not started yet', width));
  }
  model.agents.forEach((agent, index) => {
    const icon = statusIcon(agent.status, spinnerFrame);
    const attempt = agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1;
    const selected = index === model.agentIndex;
    const tokens = tokenText(agent.attempt?.usage);
    const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
    const age = durationText(agent.attempt?.startedAt ?? agent.active?.startedAt, agent.attempt?.finishedAt);
    agentLines.push(selectLine(
      `${icon} ${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${attempt}${tokens ? ` · ${tokens}` : ''}${age !== 'time pending' ? ` · ${age}` : ''}`,
      selected, focus === 1, width,
    ));
  });

  // Wide terminals keep the hierarchy and preview visible together. Narrow
  // terminals show one full-width pane at a time so mobile/SSH text remains
  // readable and explicit back navigation preserves the same hierarchy.
  const leftWidth = Math.min(SIDEBAR_WIDTH, Math.max(1, width - 3));
  const rightWidth = Math.max(1, width - leftWidth);
  // The detail text is wrapped once, before the layout below picks a body, so
  // it must wrap to the pane it will actually occupy: the full width on a
  // narrow terminal (one pane at a time), the right column beside the sidebar
  // otherwise. Wrapping to the right column on a 60-column phone left every
  // line at 22 characters inside a 58-character panel.
  const paneWidth = Math.max(20, (narrow ? width : rightWidth) - 4);
  const orchestrationLines = orchestratorDetailLines(model, paneWidth, spinnerFrame, { verbose: orchestratorVerbose });
  const detail = orchestratorDetail ? orchestrationLines : agentDetailLines(model, paneWidth, spinnerFrame);
  const technical = workflowTechnicalLines(model, paneWidth);
  const contentHeight = bodyHeight - 2;
  const scrollSource = workflowVerbose ? technical : detail;
  const maxScroll = Math.max(0, scrollSource.length - contentHeight);
  const scroll = clamp(detailScroll, 0, maxScroll);
  const visiblePhases = panelWindow(['', ...phaseLines], model.phaseIndex, 1, contentHeight).slice(1);
  const visibleAgents = panelWindow(['', ...agentLines], model.agentIndex, 1, contentHeight).slice(1);
  const visibleDetail = detail.slice(scroll, scroll + contentHeight);
  const phaseTitle = `Phases · ${model.phases.length}`;
  const orchestrationNavLines = model.orchestrator.autonomous
    ? [
      selectLine(
        `${model.orchestrator.active ? statusIcon('running', spinnerFrame)
          : stateFinishedAt(state) ? workflowStatusIcon({ status: stateStatus(state) }, spinnerFrame)
            : statusIcon(model.orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)}`,
        controlSelected,
        focus === 0 && !orchestratorDetail,
        leftWidth - 2,
      ),
      dimLine(
        [model.orchestrator.pool, model.orchestrator.model].filter(Boolean).join(' · ') || 'select to inspect',
        leftWidth - 2,
      ),
      dimLine(plannerUsageSummary(model), leftWidth - 2),
    ]
    : [];
  const narrowWorkflowLines = model.orchestrator.autonomous
    ? [...orchestrationNavLines, '', ...visiblePhases]
    : visiblePhases;
  const agentTitle = `${model.selectedPhase.label} · ${phaseComplete}/${phaseTotal} complete`;
  const detailTitle = model.selectedAgent
    ? `${model.selectedAgent.action.id} · ${model.selectedAgent.pool}`
    : 'Agent activity';

  let body;
  if (narrow) {
    if (orchestratorDetail) {
      body = renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, width, bodyHeight);
    } else if (workflowVerbose) {
      body = renderPanel('Workflow technical details', technical.slice(scroll, scroll + contentHeight), width, bodyHeight);
    } else if (focus === 0 && mobileTimeline) {
      const selectedTimelineSegment = timelineSelection === 0
        ? 'Preflight'
        : timelineSelection > 0 ? model.phases[timelineSelection - 1]?.label : null;
      body = renderWorkflowOverviewPanel(
        model, width, bodyHeight, spinnerFrame, detailScroll,
        selectedTimelineSegment,
      );
    } else if (focus === 0) {
      body = renderPanel(phaseTitle, visiblePhases, width, bodyHeight);
    } else if (focus === 1) {
      body = renderPanel(agentTitle, visibleAgents, width, bodyHeight);
    } else {
      body = renderPanel(detailTitle, visibleDetail, width, bodyHeight);
    }
  } else if (orchestratorDetail) {
    body = joinPanels(
      renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, bodyHeight),
      renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, rightWidth, bodyHeight),
    );
  } else if (workflowVerbose) {
    const visibleTechnical = technical.slice(scroll, scroll + contentHeight);
    const left = model.orchestrator.autonomous
      ? [
        ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
        ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
      ]
      : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(left, renderPanel('Workflow technical details', visibleTechnical, rightWidth, bodyHeight));
  } else if (focus < 2) {
    const left = focus === 1
      ? renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight)
      : model.orchestrator.autonomous
        ? [
          ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
          ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
        ]
        : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(
         left,
        controlSelected
        ? renderPanel(`Workflow Planner · ${model.orchestrator.status}`, orchestrationLines.slice(0, contentHeight), rightWidth, bodyHeight)
        : focus === 0
          ? renderWorkflowOverviewPanel(model, rightWidth, bodyHeight, spinnerFrame, detailScroll)
          : renderPanel(detailTitle, compactAgentPreviewLines(model, Math.max(20, rightWidth - 4), spinnerFrame), rightWidth, bodyHeight),
       );
  } else {
    body = joinPanels(
      renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight),
      renderPanel(detailTitle, visibleDetail, rightWidth, bodyHeight),
    );
  }

  return {
    body, model, state, status, elapsed, terminalLabel, agentProgress, runName, narrow,
  };
}

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

function renderWorkflowOverviewPanel(model, width, height, spinnerFrame, timelineScroll = 0, selectedTimelineSegment = null) {
  const inner = Math.max(1, width - 2);
  const timeline = workflowTimelineLines(model, inner, spinnerFrame);
  const live = workflowLiveLines(model, inner, spinnerFrame);
  const next = workflowNextLines(model, inner);
  const contentRows = Math.max(3, height - 4); // outer border + two section dividers
  const nextRows = Math.min(next.length, 2);
  const liveRows = Math.min(live.lines.length, Math.max(2, Math.floor(contentRows * 0.42)));
  const timelineRows = Math.max(1, contentRows - liveRows - nextRows);
  const maxTimelineScroll = Math.max(0, timeline.lines.length - timelineRows);
  const selectedHeader = selectedTimelineSegment
    ? timeline.lines.findIndex((line) => line?.header && line.segment === selectedTimelineSegment)
    : -1;
  const scroll = clamp(timelineScroll, 0, maxTimelineScroll);
  const end = selectedHeader >= 0
    ? Math.min(timeline.lines.length, selectedHeader + timelineRows)
    : Math.max(0, timeline.lines.length - scroll);
  let start = selectedHeader >= 0
    ? selectedHeader
    : Math.max(0, end - timelineRows);
  if (start > 0 && selectedHeader < 0) {
    // Reserve one row for the continuation header while keeping the newest
    // timestamped milestone in view.
    start = Math.max(0, end - Math.max(0, timelineRows - 1));
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]))) start += 1;
  }
   let visibleTimeline = timeline.lines.slice(start, end);
   if (start > 0 && selectedHeader < 0) {
     visibleTimeline.unshift(dimText(`↑ ${start} earlier timeline rows`, inner));
     const continuation = visibleTimeline.find((line) => line?.segment)?.segment
       ?? currentTimelineSegment(model);
     if (continuation) {
       const priorHeader = timeline.lines.find((line) => line?.header && line.segment === continuation);
       const header = continuationHeader(
         timelineSegmentDisplayName(continuation, model),
         priorHeader?.elapsed ?? 'running',
         inner,
         visibleTimeline.find((line) => line?.segment === continuation)?.at,
       );
       header.segment = continuation;
       visibleTimeline.splice(1, 0, header);
     }
    // Scrolled views already carry the upward marker and continuation header;
    // omit inter-segment spacer rows so the viewport retains the latest event.
    visibleTimeline = visibleTimeline.filter((line) => timelineText(line) !== '');
  }
  if (end < timeline.lines.length && visibleTimeline.length) {
    const marker = dimText(`↓ ${timeline.lines.length - end} newer timeline rows`, inner);
    if (visibleTimeline.length >= timelineRows) visibleTimeline[visibleTimeline.length - 1] = marker;
    else visibleTimeline.push(marker);
  }
   if (start > 0 && selectedHeader < 0 && visibleTimeline.length > timelineRows) {
     // The continuation marker and header are structural context, not
     // expendable event rows. Keep both and trim the oldest visible events.
     visibleTimeline = [visibleTimeline[0], visibleTimeline[1],
       ...visibleTimeline.slice(-(timelineRows - 2))];
   } else {
     visibleTimeline = visibleTimeline.slice(0, timelineRows);
   }
  if (selectedTimelineSegment) {
    visibleTimeline = visibleTimeline.map((line) => line?.header && line.segment === selectedTimelineSegment
      ? { ...line, text: `\x1b[7m${timelineText(line)}\x1b[0m` }
      : line);
  }
  const visibleLive = live.lines.slice(0, liveRows);
  const visibleNext = next.slice(0, nextRows);
  const title = ` Workflow timeline · ${timeline.milestoneCount} milestone${timeline.milestoneCount === 1 ? '' : 's'} `;
  const rows = [`┌${truncate(title, inner)}${'─'.repeat(Math.max(0, inner - truncate(title, inner).length))}┐`];
  for (const line of visibleTimeline) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 1 + timelineRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider(`Live · ${live.running} running`, inner));
  for (const line of visibleLive) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 2 + timelineRows + liveRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider('Next', inner));
  for (const line of visibleNext) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < height - 1) rows.push(`│${panelCell('', inner)}│`);
  rows.push(`└${'─'.repeat(inner)}┘`);
  return rows.slice(0, height);
}

function sectionDivider(label, inner) {
  const text = truncate(` ${label} `, inner);
  return `├${text}${'─'.repeat(Math.max(0, inner - text.length))}┤`;
}

function groupedTimeline(events, model, width, workflowFinishedAt) {
  const chronological = (a, b) => Date.parse(a.at) - Date.parse(b.at)
    || Number(a.sequence ?? Number.MAX_SAFE_INTEGER) - Number(b.sequence ?? Number.MAX_SAFE_INTEGER);
  events.sort(chronological);
  // Phase blocks are a navigable program, so present adjacent phase activity in
  // the declared order even when parallel workers finish out of order. Planner
  // checkpoints remain chronological boundaries between separate programs.
  const phaseRank = new Map(model.phases.map((phase, index) => [phase.label, index]));
  const orderedEvents = [];
  for (let index = 0; index < events.length;) {
    if (!phaseRank.has(events[index].segment)) {
      orderedEvents.push(events[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < events.length && phaseRank.has(events[end].segment)) end += 1;
    orderedEvents.push(...events.slice(index, end).sort((a, b) =>
      phaseRank.get(a.segment) - phaseRank.get(b.segment) || chronological(a, b)));
    index = end;
  }
  const segments = new Map();
  for (const event of orderedEvents) {
    const name = event.segment ?? 'Workflow';
    const firstAt = event.startedAt ?? event.at;
    if (!segments.has(name)) segments.set(name, { name, events: [], first: firstAt, last: event.at });
    const segment = segments.get(name);
    segment.events.push(event);
    if (Date.parse(firstAt) < Date.parse(segment.first)) segment.first = firstAt;
    if (Date.parse(event.at) > Date.parse(segment.last)) segment.last = event.at;
  }
  const lines = [];
  let previousSegment = null;
  const openedSegments = new Set();
  for (const event of orderedEvents) {
    if (event.segment !== previousSegment) {
      if (lines.length) lines.push('');
      const segment = segments.get(event.segment ?? 'Workflow');
      const segmentFinishedAt = segment.last;
      const currentSegment = currentTimelineSegment(model);
      const running = !workflowFinishedAt && (segment.name === currentSegment
        || (model.dependencyGroups && model.phases.some((phase) => phase.label === segment.name && phase.status === 'active')));
      const elapsed = running ? 'running' : durationText(segment.first, segmentFinishedAt);
      const displayName = timelineSegmentDisplayName(segment.name, model);
      const header = openedSegments.has(segment.name)
        ? continuationHeader(displayName, elapsed, width)
        : segmentHeader(displayName, elapsed, width);
      header.segment = segment.name;
      lines.push(header);
      openedSegments.add(segment.name);
      previousSegment = event.segment;
    }
    lines.push(...event.lines.map((line) => ({ text: line, segment: event.segment, at: event.at })));
  }
  if (!lines.length) lines.push({ text: 'Waiting for the first durable workflow milestone', segment: null });
  return { lines, milestoneCount: orderedEvents.filter((event) => !event.live).length };
}

function timelineSegmentDisplayName(name, model) {
  const phaseIndex = model.phases.findIndex((phase) => phase.label === name);
  return phaseIndex >= 0 && !model.dependencyGroups ? `Phase ${phaseIndex + 1} · ${name}` : name;
}

function workflowTimelineLines(model, width, spinnerFrame = 0, { goalPreview = true } = {}) {
  const { state } = model;
  const rows = [];
  const add = (at, label, right = '', detail = null, segment = 'Workflow', startedAt = null, extra = {}) => {
    if (!at) return;
    const details = detail == null ? [] : Array.isArray(detail) ? detail : [detail];
    rows.push({
      at, startedAt, segment, ...extra,
      lines: [timelineRow(at, label, right, width), ...details.filter((line) => line != null && line !== '').map((line) => timelineDetail(line, width))],
    });
  };
  // Preflight opens with the goal itself, wrapped over a few lines, and the
  // file it was accepted from, so the reader never depends on a truncated
  // one-line header to know what the run is for.
  const runDir = model.row?.runDir ?? null;
  const goalText = String(state.intent?.goal ?? state.workflow ?? '').trim();
  const goalWidth = Math.max(20, width - 7);
  // A goal is often several lines (a sentence, then numbered deliverables);
  // wrap each of its own lines, or a line break would sit inside one row
  // and split the frame.
  const goalSource = goalText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const goalLines = wrapLines(goalSource, goalWidth).slice(0, GOAL_PREVIEW_LINES);
  if (goalLines.length === GOAL_PREVIEW_LINES && wrapLines(goalSource, goalWidth).length > GOAL_PREVIEW_LINES) {
    goalLines[GOAL_PREVIEW_LINES - 1] = truncate(`${goalLines[GOAL_PREVIEW_LINES - 1]} …`, goalWidth);
  }
  // The Run page prints the goal above the timeline, where the reader sees it
  // without scrolling; there it passes `goalPreview: false` so the same five
  // wrapped rows are not replayed inside the first milestone. The mod pane's
  // `--overview` frame keeps them.
  add(state.lifecycle.startedAt, `${glyphs().ongoing} Goal accepted`, '', [
    ...(goalPreview ? goalLines : []),
    runDir ? `goal file · ${join(runDir, 'goal.json')}` : null,
    model.dependencyGroups ? 'phases may overlap as actions become ready' : 'preparing repository reconnaissance',
  ], 'Preflight');
  const eventByType = new Map();
  for (const event of model.events) {
    if (!eventByType.has(event.type)) eventByType.set(event.type, []);
    eventByType.get(event.type).push(event);
  }
  for (const event of eventByType.get('preflight.scout_started') ?? []) add(event.committedAt, `${glyphs().ongoing} Scout started`, '', event.payload?.purpose, 'Preflight');
  for (const event of eventByType.get('preflight.scout_finished') ?? []) {
    const attempt = state.preflight.scout.attempts.at(-1);
    const detail = [attempt?.pool, attempt?.model, tokenText(attempt?.usage)].filter(Boolean).join(' · ');
    add(event.committedAt, `${event.payload?.status === 'succeeded' ? glyphs().ok : '×'} Scout ${event.payload?.status === 'succeeded' ? 'completed' : 'could not complete'}`, durationText(state.preflight.scout.startedAt, state.preflight.scout.finishedAt), detail, 'Preflight');
  }
  for (const event of eventByType.get('planner.finished') ?? []) {
    const turn = Number(event.payload?.turn ?? 1);
    // The first plan is implied by the levels that follow it, so its own
    // milestone only repeated them; later revisions and rejections stay,
    // since they change what the levels mean.
    if (event.payload?.ok && turn === 1) continue;
    const label = event.payload?.ok
      ? turn === 1 ? '[Workflow Planner] plan created' : `[Workflow Planner] plan updated #${turn}`
      : '[Workflow Planner] planning attempt rejected';
    const attempt = state.planner.attempts.findLast((item) => item.turn === turn);
    const programFile = runDir
      ? join(runDir, turn === 1 ? 'initial-planner-response.json' : `planner-response-turn-${turn}.json`)
      : null;
    const actionCount = (state.program?.actions ?? []).length;
    const levelCount = model.dependencyGroups ? model.stages.length : 0;
    const shape = event.payload?.ok && actionCount
      ? `${actionCount} action${actionCount === 1 ? '' : 's'}${levelCount ? ` in ${levelCount} phase${levelCount === 1 ? '' : 's'}` : ''}`
      : null;
    add(
      event.committedAt,
      `${event.payload?.ok ? glyphs().plan : '×'} ${label}`,
      attempt ? durationText(attempt.startedAt, attempt.finishedAt) : '',
      [
        shape && programFile && existsSync(programFile) ? `${shape} · plan file · ${programFile}` : shape,
        event.payload?.summary ?? event.payload?.why,
      ],
      turn === 1 ? 'Preflight' : 'Planner',
      attempt?.startedAt,
    );
  }
  const stageById = new Map(model.stages.map((stage) => [stage.id, stage]));
  if (model.dependencyGroups) {
    for (const stage of model.stages) {
      add(stage.startedAt, '├─ started', '', null, stage.label);

    }
  }
  for (const event of model.events) {
    if (!model.dependencyGroups && event.type === 'presentation.stage_started') {
      add(event.committedAt, '├─ started', '', null, event.payload.label);
    }
    if (event.type === 'action.finished' || event.type === 'evidence.recorded') {
      const actionId = event.payload?.actionId;
      const runtime = state.actions.find((action) => action.id === actionId);
      const stage = model.stages.find((item) => item.actionIds.includes(actionId));
      const status = runtime?.status === 'succeeded' ? glyphs().ok : runtime?.status === 'blocked' ? glyphs().blocked : '×';
      add(event.committedAt, `│  ├─${status} ${actionId}`, runtime?.startedAt ? durationText(runtime.startedAt, runtime.finishedAt) : '', null, stage?.label ?? 'Work');
    }
    if (!model.dependencyGroups && event.type === 'presentation.stage_completed') {
      const stage = stageById.get(event.payload?.stageId);
      const ok = event.payload?.status === 'completed';
      add(event.committedAt, `└─${ok ? glyphs().ok : '×'} completed`, `${event.payload.completed}/${event.payload.total}`, null, stage?.label ?? event.payload.label);
    }
  }
  // A worker that is still running has no durable finish event yet, so the
  // timeline would otherwise show only its level's "started" row while the
  // Live pane reports the same worker with a ticking elapsed time. Present it
  // under its level with the spinner and the same live duration. It is not a
  // milestone, so it does not count toward the pane title.
  if (!state.lifecycle.finishedAt) {
    for (const runtime of state.actions) {
      if (runtime.status !== 'running' || !runtime.startedAt) continue;
      const stage = model.stages.find((item) => item.actionIds.includes(runtime.id));
      add(runtime.startedAt, `│  ├─${statusIcon('running', spinnerFrame)} ${runtime.id}`, durationText(runtime.startedAt), null, stage?.label ?? 'Work', null, { live: true });
    }
  }
  if (model.dependencyGroups) for (const stage of model.stages) {
    if (!stage.completedAt) continue;
    const progress = presentationStageStatus(stage, state.actions);
    // finishedAt precedes the durable action-finished event by a few ms.
    // A projected level closes after those events, never above its last worker.
    const at = [stage.completedAt, ...model.events.filter((event) =>
      ['action.finished', 'evidence.recorded'].includes(event.type) && stage.actionIds.includes(event.payload?.actionId))
      .map((event) => event.committedAt)].filter(Boolean).sort().at(-1);
    add(at, `└─${progress.successful ? glyphs().ok : '×'} completed`, `${progress.completed}/${progress.total}`, null, stage.label);
  }
  if (state.lifecycle.finishedAt) {
    const status = state.lifecycle.status;
    const finalSegment = model.stages.findLast((stage) => stage.startedAt)?.label ?? 'Workflow';
    add(state.lifecycle.finishedAt, `${status === 'completed' ? glyphs().ok : status === 'partial' ? '!' : '×'} Workflow ${status === 'completed' ? 'complete - result is ready' : `${status} - result is ready`}`, durationText(state.lifecycle.startedAt, state.lifecycle.finishedAt), null, finalSegment);
  }
  return groupedTimeline(rows, model, width, state.lifecycle.finishedAt);
}

function segmentHeader(name, elapsed, width) {
  if (width < 40) {
    const suffix = ` ── ${elapsed} ──`;
    const available = width - suffix.length - 3;
    const text = available >= String(name).length
      ? `── ${name}${suffix}`
      : `── ${truncate(name, Math.max(1, available))}${suffix}`;
    return { text: truncate(text, width), segment: name, elapsed, header: true };
  }
  const text = `── ${name} `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${name} ──`, width), segment: name, elapsed, header: true };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment: name, elapsed, header: true };
}

function continuationHeader(segment, elapsed, width, at = null) {
  if (width < 40) {
    // Keep the segment name readable in the compact pane; the continuation
    // marker already distinguishes this header from the initial one.
    const text = `── ${segment} · continued ──`;
    return { text: truncate(text, width), segment, elapsed, header: true, at };
  }
  const text = `── ${segment} · continued `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${segment} · continued ──`, width), segment, elapsed, header: true, at };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment, elapsed, header: true, at };
}

function currentTimelineSegment(model) {
  const { state } = model;
  const activeAction = state.actions.find((action) => action.status === 'running');
  return model.stages.find((stage) => stage.actionIds.includes(activeAction?.id))?.label
    ?? (state.preflight?.scout?.status === 'running' ? 'Preflight'
      : state.planner.status === 'running'
        ? (state.actions.length ? 'Planner' : 'Preflight')
        : 'Workflow');
}

function timelineText(value) {
  return typeof value === 'string' ? value : value?.text ?? '';
}

function workflowLiveLines(model, width, spinnerFrame) {
  const { state, orchestrator } = model;
  const runningAttempts = state.attempts.filter((attempt) => attempt.status === 'running');
  const lines = [];
  const plannerRunning = orchestrator.active;
  // The planner appears here only while it is actually planning. Between
  // programs it is merely waiting on the workers listed below, which the
  // Next section already says; a "waiting" row of its own told nothing.
  if (plannerRunning) {
    lines.push(alignRight(`${statusIcon('planning', spinnerFrame)} [Workflow Planner] · ${orchestrator.pool} · ${orchestrator.model}`, 'planning', width));
    lines.push('   Choosing the next bounded program');
    const event = plannerRunning.lastAgentEvent;
    if (event) lines.push(`   ${glyphs().detail} ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
    const stream = streamActivityLine(plannerRunning);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  for (const attempt of runningAttempts) {
    const reasoning = reasoningText(attempt);
    lines.push(alignRight(`${statusIcon('running', spinnerFrame)} ${attempt.actionId} · ${attempt.pool ?? 'unassigned'} · ${attempt.model ?? 'connector model'}${reasoning ? ` · ${reasoning}` : ''}`, durationText(attempt.startedAt), width));
    const event = attempt.lastAgentEvent;
    lines.push(event
      ? `   ${glyphs().detail} ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`
      : `   ${glyphs().detail} waiting for the first semantic action event`);
    const stream = streamActivityLine(attempt);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  if (!lines.length) {
    const liveness = model.row?.liveness ?? v2RunnerLiveness(state, { runDir: model.row?.runDir });
    lines.push(stateFinishedAt(state)
      ? `${glyphs().ok} No live agents · workflow ${state.lifecycle.status}`
      : liveness.alive ? `${glyphs().waiting} Waiting for the next dispatch`
      : `${glyphs().fail} Kernel not running · ${liveness.reason}`);
    if (!stateFinishedAt(state) && !liveness.alive) {
      lines.push(`  resume it · bullswarm workflow resume ${state.shortId ?? state.runId}`);
    }
  }
  if (model.row?.kernelStderrTail?.length) lines.push('  kernel log: available');
  return { lines, running: runningAttempts.length + (plannerRunning ? 1 : 0) };
}

function workflowNextLines(model, width) {
  const { state } = model;
  if (stateFinishedAt(state)) return [truncate(`${glyphs().ok} Workflow ${state.lifecycle.status === 'completed' ? 'complete' : state.lifecycle.status} - result is ready`, width)];
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  if (running.length) return [truncate(`${glyphs().pending} Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`, width)];
  if (state.planner.status === 'running') return [`${glyphs().pending} Workflow Planner is creating the next bounded program`];
  if (state.planner.awaiting) {
    const token = state.shortId ?? state.runId;
    if (state.cancellation?.requested) return [truncate(`${glyphs().waiting} Cancellation requested while paused · bullswarm workflow cancel ${token} finalizes it`, width)];
    return [truncate(`${glyphs().waiting} Waiting for the caller planner (${state.planner.awaiting.boundary}) · bullswarm workflow plan show ${token}`, width)];
  }
  if (state.actions.some((action) => ['pending', 'ready'].includes(action.status))) return [`${glyphs().pending} Starting the next dependency-ready actions`];
  return [`${glyphs().pending} Workflow Planner will reassess remaining gaps`];
}

function workflowTechnicalLines(model, width) {
  const { state } = model;
  return wrapLines([
    `Schema · ${state.schemaVersion}`,
    `Status · ${state.lifecycle.status}`,
    `Started · ${state.lifecycle.startedAt ?? '—'}`,
    `Usage · ${state.usage.total} known tokens`,
    '', 'Action program',
    ...state.actions.map((action) => `${statusIcon(action.status)} ${action.id} · revision ${action.programRevision} · ${action.status}`),
    '', 'Requirement ledger',
    ...Object.values(state.ledger.requirements).map((requirement) => `${statusIcon(requirement.status)} ${requirement.id} · ${requirement.status}`),
    '', 'Recent durable events',
    ...model.events.slice(-12).map((event) => `#${event.sequence} ${event.type}`),
  ], width);
}

function timelineRow(at, label, right, width) {
  if (width < 40) return label;
  return alignRight(`${clockText(at)}  ${label}`, right, width);
}

function timelineDetail(text, width) {
  return truncate(`       ${text}`, width);
}

function alignRight(left, right, width) {
  const suffix = right ? String(right) : '';
  // Preserve the actionable event label in the compact preview; dropping a
  // duration is preferable to turning the action name into an ellipsis.
  if (width < 30) return truncate(left, width);
  if (!suffix) return truncate(left, width);
  const room = Math.max(1, width - suffix.length - 1);
  const lhs = truncate(left, room);
  return `${lhs}${' '.repeat(Math.max(1, width - lhs.length - suffix.length))}${suffix}`;
}

function clockText(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function streamActivityLine(agent) {
  if (!agent) return '';
  const at = agent.lastEventAt ?? agent.lastActivityAt;
  if (!at) return 'stream waiting for the first provider event';
  return `stream active ${durationText(at)} ago · ${formatBytes(agent.outputBytesObserved ?? 0)} observed`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The durable byte timeline for one attempt, plus its measured total. */
function outputSparkline(attempt, runDir, width = 8) {
  let series = [];
  try { series = attemptOutputSeries(attempt, runDir); } catch { series = []; }
  if (!series.length) return '';
  const values = series.map((sample) => sample?.[1]).filter((value) => Number.isFinite(value));
  if (!values.length) return '';
  const total = values.at(-1);
  const spark = sparkline(values, width);
  return spark ? `${spark} ${formatBytes(total)}` : '';
}

function taskIdText(task) {
  const raw = String(task?.id ?? task?.taskFile ?? 'task');
  return raw.length > 14 ? raw.slice(-8) : raw;
}

function taskPoolModelText(task) {
  return [task?.pool, task?.model].filter((value) => value != null && String(value).trim()).join(' · ')
    || 'pool/model unavailable';
}

function taskElapsedText(task, nowMs) {
  return ageText(task?.startedAt, nowMs) || 'time pending';
}

function taskToday(task, nowMs, { finished = false } = {}) {
  const at = finished ? (task?.endedAt ?? task?.finishedAt) : (task?.startedAt ?? task?.endedAt ?? task?.finishedAt);
  return dayKey(at) === dayKey(nowMs);
}

/** A measured worker duration with the precision the Home today band uses. */
// One identity for a finished task row, used everywhere a task can arrive from
// two sources at once (the day's rows AND `tasks.finished`). A task recorded
// before the single-task ledger has neither `id` nor `taskFile`, so keying on
// those alone silently deduplicated nothing and every legacy task was listed
// and counted twice. The fallback is the tuple the decision log always has.
function taskIdentity(task) {
  const id = task?.id ?? task?.taskFile;
  if (id != null && id !== '') return `id:${id}`;
  const at = task?.endedAt ?? task?.finishedAt ?? task?.ts ?? task?.startedAt ?? '';
  const pool = task?.pool ?? task?.picked ?? '';
  return `at:${at}|${pool}|${task?.lane ?? ''}|${task?.durationMs ?? ''}`;
}

function todayMinutesText(value) {
  const minutes = finiteOrNull(value);
  return minutes == null ? null : `${minutes.toFixed(1)}m`;
}

function todayMinutesNumberText(value) {
  const minutes = finiteOrNull(value);
  return minutes == null ? null : minutes.toFixed(1);
}

/** A task's measured duration, without turning a missing field into zero. */
function measuredTaskMinutes(task) {
  const duration = finiteOrNull(task?.durationMs);
  if (duration != null && duration >= 0) return duration / 60_000;
  const wallSec = finiteOrNull(task?.wallSec);
  if (wallSec != null && wallSec >= 0) return wallSec / 60;
  const started = Date.parse(task?.startedAt ?? '');
  const ended = Date.parse(task?.endedAt ?? task?.finishedAt ?? '');
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) return (ended - started) / 60_000;
  return null;
}

function todayDateLabel(value, { year = false } = {}) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : dayKey(value);
  if (!key) return 'today';
  const [yyyy, mm, dd] = key.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dd} ${months[mm - 1] ?? ''}${year ? ` ${yyyy}` : ''}`.trim();
}

function todayGoalLine(record, width) {
  const goal = String(record?.goal ?? '').split(/\r?\n/)[0].trim();
  return dimText(`  ${goal || 'goal unavailable'}`, width);
}

function todayWorkflowLine(record, width) {
  const glyph = record?.status === 'failed' ? glyphs().fail : glyphs().ok;
  const id = String(record?.shortId ?? record?.runId ?? '------');
  const project = cut(String(record?.project ?? 'unknown'), 10).padEnd(10);
  const minutes = todayMinutesText(record?.minutes?.wall) ?? blank();
  const verdict = record?.verified === true ? 'verified' : 'unverified';
  const line = `${glyph} ${id.padEnd(6)}  ${project}  ${minutes.padStart(6)}  ${verdict}`;
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
}

function todayTaskLine(task, width) {
  const id = taskIdText(task);
  const project = cut(String(task?.project ?? 'unknown'), 10).padEnd(10);
  const minutes = todayMinutesText(measuredTaskMinutes(task)) ?? blank();
  const result = task?.ok === false ? 'failed' : 'finished';
  const line = `${glyphs().inflight} ${id.padEnd(6)}  ${project}  ${minutes.padStart(6)}  ${result}`;
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
}

function todayRows(model, nowMs) {
  const date = dayKey(nowMs);
  const day = (model.days ?? []).find((entry) => String(entry?.date) === date) ?? null;
  const workflows = [];
  const workflowIds = new Set();
  const addWorkflow = (record) => {
    if (!record || record.kind === 'task' || record.task === true) return;
    if (record.unfinished === true || !record.finishedAt || dayKey(record.finishedAt) !== date) return;
    const id = record.runId ?? record.shortId;
    if (id != null && workflowIds.has(id)) return;
    if (id != null) workflowIds.add(id);
    workflows.push(record);
  };
  for (const record of day?.rows ?? []) addWorkflow(record);
  // A caller may render a model without asking History for a day page first;
  // the rollup index is the same durable source and fills that pure-rendering
  // case without scanning workflow directories.
  for (const record of model.rollups ?? []) addWorkflow(record);

  const tasks = [];
  const taskIds = new Set();
  const addTask = (task) => {
    if (!task || !taskToday(task, nowMs, { finished: true })) return;
    const id = taskIdentity(task);
    if (taskIds.has(id)) return;
    taskIds.add(id);
    tasks.push(task);
  };
  for (const row of day?.rows ?? []) {
    if (row?.kind === 'task' || row?.task === true) addTask(row);
  }
  for (const task of model.tasks?.finished ?? []) addTask(task);
  return { date, workflows, tasks };
}

function poolRatePerMinute(pool, budgetRow = null) {
  return finiteOrNull(pool?.spend?.pacing?.ratePerMinute
    ?? pool?.ratePerMinute
    ?? budgetRow?.share?.ratePerMinute);
}

function todayLicenceRows(model, today, nowMs) {
  const byName = new Map();
  const ensure = (name) => {
    if (!name) return null;
    if (!byName.has(name)) byName.set(name, {
      name, workflowMinutes: null, runMinutes: null, apiUsd: null,
      subscriptionUsd: null, subscriptionBasis: null, subscriptionDeltaPct: null,
      subscriptionWindow: null, tokenSource: null,
      worked: false, ratePerMinute: null, usedPct: null,
    });
    return byName.get(name);
  };
  const addMinutes = (row, key, value) => {
    const number = finiteOrNull(value);
    if (number == null || number < 0) return;
    row[key] = (row[key] ?? 0) + number;
  };
  for (const record of today.workflows) {
    for (const [name, entry] of Object.entries(record?.pools ?? {})) {
      const row = ensure(name);
      if (!row) continue;
      row.worked = true;
      addMinutes(row, 'workflowMinutes', entry?.minutes);
      const cost = finiteOrNull(entry?.costUsd);
      if (cost != null) row.apiUsd = (row.apiUsd ?? 0) + cost;
      const subscription = finiteOrNull(entry?.subscriptionUsd);
      if (subscription != null) row.subscriptionUsd = (row.subscriptionUsd ?? 0) + subscription;
      const deltaPct = finiteOrNull(entry?.subscriptionDeltaPct);
      if (deltaPct != null) row.subscriptionDeltaPct = (row.subscriptionDeltaPct ?? 0) + deltaPct;
      if (entry?.subscriptionWindow) {
        row.subscriptionWindow = row.subscriptionWindow == null || row.subscriptionWindow === entry.subscriptionWindow
          ? entry.subscriptionWindow : null;
      }
      if (entry?.subscriptionBasis) row.subscriptionBasis = worstSubscriptionBasis(row.subscriptionBasis, entry.subscriptionBasis);
      row.tokenSource = worstTokenSource(row.tokenSource, tokenSourceOf(entry?.tokenSource, cost));
    }
  }
  for (const task of today.tasks) {
    const row = ensure(task?.pool);
    if (!row) continue;
    row.worked = true;
    addMinutes(row, 'runMinutes', measuredTaskMinutes(task));
  }

  const budgetRows = new Map((model.budget?.rows ?? []).map((row) => [row.name, row]));
  const pools = Array.isArray(model.pools) ? model.pools : [];
  for (const pool of pools) {
    const row = byName.get(pool?.name);
    if (!row) continue;
    row.ratePerMinute = poolRatePerMinute(pool, budgetRows.get(pool.name));
    row.usedPct = finiteOrNull(pool?.usedPct);
  }
  for (const row of byName.values()) {
    row.ratePerMinute ??= poolRatePerMinute(null, budgetRows.get(row.name));
  }

  // Keep the provider/config order stable (the frame is a report, not a
  // ranking), then append a pool that was recorded by a rollup but is absent
  // from the current live meter list.
  const order = new Map(pools.map((pool, index) => [pool?.name, index]));
  return [...byName.values()]
    .filter((row) => row.worked)
    .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)
      || String(a.name).localeCompare(String(b.name)))
    .map((row) => ({
      ...row,
      workflowPct: row.ratePerMinute != null && row.workflowMinutes != null
        ? row.ratePerMinute * row.workflowMinutes : null,
    }));
}

function todayPoolName(name, width) {
  const full = String(name ?? '');
  const suffix = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full;
  if (full.length <= width) return full;
  if (suffix.length <= width) return suffix;
  return cut(full, width);
}

function todayTableRow(row, width, { header = false } = {}) {
  const desktop = width >= 60;
  const nameWidth = desktop ? 14 : 13;
  const specs = desktop
    ? { wf: 6, wfPct: 4, run: 7, api: 17, gaps: [4, 3, 3, 0] }
    : { wf: 6, wfPct: 4, run: 6, api: 12, gaps: [3, 3, 3, 0] };
  const labels = ['wf min', 'wf % (est.)', 'run min', 'API · sub'];
  const values = header ? labels : [
    todayMinutesNumberText(row?.workflowMinutes) ?? blank(),
    row?.workflowPct == null ? blank() : `${row.workflowPct.toFixed(1)}%`,
    todayMinutesNumberText(row?.runMinutes) ?? blank(),
    row?.apiUsd == null && row?.subscriptionUsd == null && !row?.tokenSource ? blank()
      : compactUsageBasisText({ apiUsd: row?.apiUsd, subscriptionUsd: row?.subscriptionUsd, tokenSource: row?.tokenSource, subscriptionBasis: row?.subscriptionBasis }, specs.api),
  ];
  const widths = [specs.wf, specs.wfPct, specs.run, specs.api];
  let line = header ? 'pool'.padEnd(nameWidth) : todayPoolName(row?.name, nameWidth).padEnd(nameWidth);
  if (header) {
    const headerWidths = desktop ? [6, 10, 7, 18] : [6, 10, 6, 13];
    values.forEach((value, index) => {
      line += String(value ?? '').padEnd(headerWidths[index]);
      line += ' '.repeat(index === values.length - 1 ? 0 : 1);
    });
  } else values.forEach((value, index) => {
    line += String(value ?? '').padStart(widths[index]);
    line += ' '.repeat(specs.gaps[index]);
  });
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
}

function todayBareRule(width) {
  return '─'.repeat(Math.max(0, width));
}

function todayPadded(value, width) {
  const text = String(value ?? '');
  return `${cut(text, width)}${' '.repeat(Math.max(0, width - visibleLength(cut(text, width))))}`;
}

function todayLicenceFootnotes(nowMs, width, desktop = false) {
  const date = dayKey(nowMs) ?? 'today';
  return desktop
    ? [
      'wf % = pool window points drawn by workflows today',
      '— = not measured · API≈ basis: provider-reported · transcript-summed · estimated',
      'cost unknown means no usage measurement exists',
      'live window used% is on Budget, not in this table',
    ].map((line) => todayPadded(line, width))
    : [
      'wf % = pool window points drawn by workflows today',
      '— = not measured · API≈: provider-reported · transcript-summed · estimated',
      `cost unknown · audit ${date}`,
      'live window used% lives on Budget, not here',
    ].map((line) => todayPadded(line, width));
}

/** The approved Home today band: finished work on the left, licence draw right. */
function homeTodayBand(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  const today = todayRows(model, nowMs);
  const workflowCount = today.workflows.length;
  const taskCount = today.tasks.length;
  const verified = today.workflows.filter((record) => record.verified === true).length;
  const workflowNoun = `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`;
  const taskNoun = `${taskCount} task${taskCount === 1 ? '' : 's'}`;
  const countText = `${workflowNoun} finished${taskCount ? ` · ${taskNoun} finished` : ''} · ${verified} verified`;
  // The phone has one line for the whole band. Once tasks are present, drop
  // the repeated word "finished" so the three required counts remain
  // visible instead of truncating the verification count.
  const narrowCountText = taskCount
    ? `${workflowNoun} · ${taskNoun} · ${verified} verified`
    : countText;
  const desktopCountText = `${workflowNoun}${taskCount ? ` · ${taskNoun}` : ''} · ${verified} verified`;
  const date = todayDateLabel(today.date, { year: !narrow });
  const licenceRows = todayLicenceRows(model, today, nowMs);
  const runIds = today.workflows.map((record) => record.runId ?? record.shortId).filter(Boolean);
  const taskIds = today.tasks.map((task) => task.id ?? task.taskFile).filter(Boolean);

  if (narrow) {
    body.push(todayPadded(`today · ${date} · ${narrowCountText}`, width));
    body.push(todayBareRule(width));
    if (!today.workflows.length && !today.tasks.length) body.push(todayPadded('no finished workflows or tasks today', width));
    for (const record of today.workflows) body.row(todayWorkflowLine(record, width), { kind: 'run', runId: record.runId ?? record.shortId });
    for (const task of today.tasks) body.row(todayTaskLine(task, width), { kind: 'task', taskId: task.id ?? task.taskFile });
    body.push(todayPadded('Enter on a run → its goal, steps and spend', width));
    body.push(todayBareRule(width));
    body.push(todayPadded('licence spent today · measured worker minutes', width));
    body.push(todayTableRow(null, width, { header: true }));
    if (!licenceRows.length) body.push(todayPadded('no measured pool work today', width));
    for (const row of licenceRows) {
      body.row(todayTableRow(row, width), { kind: 'page', page: 'budget', pool: row.name });
    }
    for (const line of todayLicenceFootnotes(nowMs, width, false)) body.push(line);
  } else {
    const leftWidth = 57;
    const rightWidth = Math.max(1, width - leftWidth - 2);
    body.push(todayPadded(`today · ${date}`, width));
    const left = [
      todayPadded(`finished today · ${desktopCountText}`, leftWidth),
      `${'─'.repeat(Math.max(0, leftWidth - 1))} `,
    ];
    if (!today.workflows.length && !today.tasks.length) left.push(todayPadded('no finished workflows or tasks today', leftWidth));
    for (const record of today.workflows) {
      left.push(todayWorkflowLine(record, leftWidth));
      left.push(todayGoalLine(record, leftWidth));
    }
    for (const task of today.tasks) left.push(todayTaskLine(task, leftWidth));
    left.push(todayPadded('Enter on a run → its steps and spend', leftWidth));
    const right = [
      todayPadded('licence spent today · measured worker minutes', rightWidth),
      todayBareRule(rightWidth),
      todayTableRow(null, rightWidth, { header: true }),
      ...licenceRows.map((row) => todayTableRow(row, rightWidth)),
      ...todayLicenceFootnotes(nowMs, rightWidth, true),
    ];
    const rows = Math.max(left.length, right.length);
    for (let index = 0; index < rows; index += 1) {
      const l = todayPadded(left[index] ?? '', leftWidth);
      const r = todayPadded(right[index] ?? '', rightWidth);
      const action = index >= 2 && index < 2 + today.workflows.length * 2
        && index % 2 === 0
        ? { kind: 'run', runId: today.workflows[(index - 2) / 2]?.runId ?? today.workflows[(index - 2) / 2]?.shortId }
        : index >= 2 + today.workflows.length * 2 && index < 2 + today.workflows.length * 2 + today.tasks.length
          ? { kind: 'task', taskId: today.tasks[index - (2 + today.workflows.length * 2)]?.id ?? today.tasks[index - (2 + today.workflows.length * 2)]?.taskFile }
          : null;
      const rightStart = 2;
      const poolIndex = index - rightStart;
      const rightAction = poolIndex >= 1 && poolIndex <= licenceRows.length
        ? { kind: 'page', page: 'budget', pool: licenceRows[poolIndex - 1]?.name }
        : null;
      body.parts([{ text: l, action }, { text: '│ ' }, { text: r, action: rightAction }]);
    }
  }
  // Capture only this band's rows before the running/recent sections append
  // their own click targets below it.
  body.runRows = body.regions
    .filter((region) => region.action?.kind === 'run')
    .map((region) => ({ runId: region.action.runId, y: region.y }));
  body.taskRows = body.regions
    .filter((region) => region.action?.kind === 'task')
    .map((region) => ({ taskId: region.action.taskId, y: region.y }));
  const desiredTask = opts.selectedTaskId;
  const desiredRun = opts.selectedRunId;
  const selectedTask = desiredTask && taskIds.includes(desiredTask) ? desiredTask : null;
  const selectedRun = desiredRun && runIds.includes(desiredRun) ? desiredRun : runIds[0] ?? null;
  body.cursorAction = selectedTask
    ? { kind: 'task', taskId: selectedTask }
    : selectedRun ? { kind: 'run', runId: selectedRun } : null;
  return { workflowCount, taskCount, verified };
}

function humanStatus(value) {
  return String(value ?? 'waiting').replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());
}

function plannerDisplayStatus(model) {
  const { orchestrator, state } = model;
  if (stateFinishedAt(state)) return state.lifecycle.status === 'completed' ? 'Completed' : humanStatus(state.lifecycle.status);
  if (orchestrator.active) return 'Creating or updating plan';
  if (state.attempts.some((attempt) => attempt.status === 'running')) return 'Waiting for workers';
  return humanStatus(state.planner.status);
}

function plannerUsageSummary(model) {
  return `Checkpoints ${model.orchestrator.attempts.length} · ${model.state.usage.total || 0} tok`;
}

function dimText(value, width) {
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
function tint(text, role) {
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

function orchestratorDetailLines(model, width, spinnerFrame, { verbose = false } = {}) {
  const { orchestrator, state } = model;
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  const now = orchestrator.active
    ? 'Creating or updating the bounded action program'
    : running.length ? `Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`
      : stateFinishedAt(state) ? 'Workflow finished' : 'Reviewing requirement gaps';
  const lines = [
    `${statusIcon(orchestrator.active ? 'planning' : orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)} · ${orchestrator.pool} · ${orchestrator.model}`,
    '', `Now · ${now}`,
    `Progress · ${state.actions.filter((action) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(action.status)).length}/${state.actions.length} actions settled · ${orchestrator.attempts.length} planning checkpoint${orchestrator.attempts.length === 1 ? '' : 's'}`,
    `Latest plan · ${state.planner.lastDecision?.summary ?? 'not created yet'}`,
  ];
  const event = orchestrator.active?.lastAgentEvent;
  if (event) lines.push(`Latest action · ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
  if (!verbose) {
    lines.push('', 'Recent activity');
    for (const attempt of orchestrator.attempts.slice(-3)) lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push('', 'Press v for checkpoint prompts, sessions, usage, and artifact paths.');
    return wrapLines(lines, width);
  }
  lines.push('', `Session · ${state.planner.session?.sessionId ?? 'pending'}${state.planner.session ? ' · resumable' : ''}`);
  for (const attempt of orchestrator.attempts) {
    const reasoning = reasoningText(attempt);
    lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${attempt.pool ?? '—'} · ${attempt.model ?? '—'}${reasoning ? ` · ${reasoning}` : ''} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push(`  task: ${attempt.taskFile ?? '—'}`, `  output: ${attempt.outputFile ?? '—'}`);
  }
  return wrapLines(lines, width);
}

function friendlyActionKind(kind) {
  return ({
    read_file: 'Read file',
    write_file: 'Write file',
    response: 'Response',
    tool: 'Tool',
    bash: 'Command',
  })[kind] ?? String(kind ?? 'Action').replaceAll('_', ' ');
}

// The role shown between an action's id and its status. A program action states
// its nature in `kind` (mechanical, io-read, digest, check, implement,
// integration, architecture, adversarial-acceptance), so show that; for one written before
// kinds existed, derive the role the way the kernel defines it — an action that
// judges a requirement is evidence, anything else with a definition is work.
function actionRoleLabel(action) {
  if (action.kind) return action.kind;
  if (Array.isArray(action.evidenceFor) && action.evidenceFor.length) return 'evidence';
  if (action.lane || action.prompt) return 'work';
  return 'action';
}

function friendlyActionSummary(action) {
  const summary = String(action.summary ?? '').replace(/\s+/g, ' ').trim();
  if (action.kind === 'response' && /workflow\.decision|"decision"|needs_more_work/.test(summary)) {
    return 'Planner decision recorded';
  }
  return truncate(summary, 180);
}

function agentDetailLines(model, width, spinnerFrame) {
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

function compactAgentPreviewLines(model, width, spinnerFrame) {
  const agent = model.selectedAgent;
  if (!agent) return [
    `${model.selectedPhase.label} · ${model.selectedPhase.completed}/${model.selectedPhase.total} complete`,
    ...(model.selectedPhase.blockedActions ?? []).map((blocked) =>
      `${glyphs().blocked} ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.join(', ')}`),
    ...agentDetailLines(model, width, spinnerFrame),
  ];
  const liveActions = agent.active?.lastActions ?? agent.attempt?.lastActions ?? [];
  // Token usage only arrives when an attempt finishes, so a running worker
  // used to read "#1 · pending" here; its elapsed time is what is known now.
  const startedAt = agent.attempt?.startedAt ?? agent.active?.startedAt;
  const elapsed = startedAt ? durationText(startedAt, agent.attempt?.finishedAt) : '';
  const tokens = tokenText(agent.attempt?.usage);
  const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
  const lines = [
    `${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}${elapsed ? ` · ${elapsed}` : ''}${tokens ? ` · ${tokens}` : ''}`,
    `${statusIcon(agent.status, spinnerFrame)} ${agent.status} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''}`,
    `${agent.pool} · attempt ${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}`,
    `Tokens · ${tokenText(agent.attempt?.usage) || 'pending'}`,
    compactUsage(agent.attempt?.usage),
    '',
    'Recent steps',
  ];
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  for (const step of liveActions.slice(-4)) {
    lines.push(`${statusIcon(step.status, spinnerFrame)} ${friendlyActionKind(step.kind)}${step.summary ? ` · ${friendlyActionSummary(step)}` : ''}`);
  }
  return wrapLines(lines, width);
}

function taskPreview(path, limit = 6) {
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

function outcomePreview(path, output, maxChars = 64 * 1024) {
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

function wrapLines(lines, width) {
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

function statusIcon(status, spinnerFrame = 0) {
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

function durationText(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return 'time pending';
  const end = Date.parse(finishedAt ?? '') || Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function truncate(value, width) {
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
const visibleLength = (value) => String(value ?? '').replace(ANSI_SGR, '').length;
/** The one-line commands that operate the product, as Runs lists them. */
const DASHBOARD_COMMANDS = Object.freeze([
  'bullswarm run',
  'bullswarm workflow goal "<goal>"',
  'bullswarm workflow watch <id> --next',
  'bullswarm workflow reindex',
  'bullswarm setup',
  'bullswarm doctor',
]);

/** Meters are background-coloured cells; an ascii terminal gets the plain bar. */
function meterAnsi() {
  return !asciiGlyphsPreferred();
}

/** The blank a figure with no measurable source is painted as. */
function blank() {
  return asciiGlyphsPreferred() ? '-' : '—';
}

/** `≈` with the basis beside it, or the ascii twin. */
function about() {
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

function compactUsageBasisText(value, tokenSource, width = 20) {
  const text = value && typeof value === 'object'
    ? moneyText(value)
    : usageBasisText(value, tokenSource);
  if (text === 'cost unknown' || visibleLength(text) <= width) return text;
  return text
    .replace(' estimated', ' est')
    .replace(' summed', ' sum')
    .replace('$ ', '$')
    .slice(0, width);
}

/**
 * Money, always as the estimate it is. `estimateInvocationUsage` prices the
 * task and output text at API rates with no cache split, so every `$` on this
 * dashboard is an API-equivalent estimate and says so; an amount nobody
 * recorded is null, and the caller paints a blank with the reason.
 */
function moneyText(value, tokenSource) {
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

/** A percentage, to one decimal, or null when there is nothing to show. */
function percentText(value, digits = 0) {
  const amount = Number(value);
  if (value == null || !Number.isFinite(amount)) return null;
  return `${amount.toFixed(digits)}%`;
}

/** A share recorded as 0..1. */
function shareText(value) {
  const amount = Number(value);
  if (value == null || !Number.isFinite(amount)) return null;
  return `${Math.round(amount * 100)}%`;
}

/** `42m` / `2h05m` from minutes. */
function minutesText(value) {
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
function navParts(model, { page, width, selectedRunId }) {
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
  // buttons fill whatever the terminal has left for them — a terminal too
  // narrow for the whole tail still gets its last button.
  const lineLength = (items) => 1 + items.reduce((sum, item) => sum + visibleLength(button(item)) + 1, 0);
  const shown = [...runs];
  while (shown.length && lineLength([...back, ...shown, ...tail]) > width) shown.pop();
  while (tail.length > 1 && lineLength([...back, ...tail]) > width) tail.shift();

  const parts = [{ text: ' ' }];
  for (const item of [...back, ...shown, ...tail]) {
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
function actionNamedIn(text, actions) {
  let best = null;
  for (const action of actions) {
    const at = text.indexOf(action.id);
    if (at < 0) continue;
    const before = at === 0 ? ' ' : text[at - 1];
    const after = text[at + action.id.length] ?? ' ';
    if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(after)) continue;
    if (!best || action.id.length > best.id.length) best = action;
  }
  return best;
}

/** One clickable row per step the painted lines name. */
function markStepRows(builder, lines, model, runId = null) {
  const actions = model.state.actions ?? [];
  if (!actions.length) return;
  const from = builder.lines.length - lines.length;
  lines.forEach((line, index) => {
    const action = actionNamedIn(String(line).replace(ANSI_SGR, ''), actions);
    if (action) {
      builder.regions.push({
        x1: 1, x2: Math.max(1, visibleLength(line)), y: from + index + 1,
        action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
      });
    }
  });
}

// ------------------------------------------------------------------ a run

/**
 * The phases of a run's plan, each an array of its actions.
 *
 * These are the same dependency stages the Run page's own panel lists, read
 * through `workflowPanelModel`, so the strip, the phase count and the panel
 * below them can never disagree. A state too torn to project falls back to
 * the graph the actions themselves declare.
 */
function planLevels(row) {
  try {
    const phases = workflowPanelModel(row).phases
      .map((phase) => (phase.actions ?? []).filter((action) => action?.id));
    if (phases.some((phase) => phase.length)) return phases;
  } catch { /* fall through to the declared graph */ }
  const actions = row?.state?.actions ?? [];
  const byId = new Map(actions.map((action) => [action.id, action]));
  const depth = new Map();
  const depthOf = (action, seen = new Set()) => {
    if (depth.has(action.id)) return depth.get(action.id);
    if (seen.has(action.id)) return 0;
    seen.add(action.id);
    const parents = (action.dependsOn ?? []).map((id) => byId.get(id)).filter(Boolean);
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => depthOf(parent, seen))) : 0;
    depth.set(action.id, value);
    return value;
  };
  const levels = [];
  for (const action of actions) (levels[depthOf(action)] ??= []).push(action);
  return levels.map((level) => level ?? []);
}

const DONE_STATUS = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'skipped']);

/** `phase 2 of 4 · 5/8 steps`, plus the ETA when every remainder is measured. */
function planProgress(row, { assignments = [], nowMs = Date.now() } = {}) {
  const state = row?.state ?? {};
  const actions = state.actions ?? [];
  // The phase count in the Run header must be the same presentation-stage
  // list the plan strip and timeline use, not a separately re-derived graph.
  const levels = planStages(row).stages.map((stage) => stage.actions ?? []);
  const done = actions.filter((action) => action.status === 'succeeded').length;
  const running = levels.findIndex((level) => level.some((action) => action.status === 'running'));
  const pending = levels.findIndex((level) => level.some((action) => !DONE_STATUS.has(action.status)));
  const index = running >= 0 ? running : pending >= 0 ? pending : levels.length - 1;
  const phase = levels.length ? index + 1 : 0;

  // The ETA only exists when every step still to run recorded an expected
  // duration. Today only a dispatched step does (its live assignment carries
  // `expectedMinutes`), so a run with waiting steps says so instead of
  // inventing the minutes nobody measured.
  const remaining = actions.filter((action) => !DONE_STATUS.has(action.status));
  let minutes = 0;
  let measured = 0;
  const unmeasured = [];
  for (const action of remaining) {
    const assignment = assignments.find((entry) => entry.runId === row?.runId && entry.actionId === action.id);
    const expected = finiteOrNull(assignment?.expectedMinutes);
    if (expected == null) { unmeasured.push(action.id); continue; }
    const startedMs = Date.parse(assignment?.startedAt ?? '');
    const elapsed = Number.isFinite(startedMs) ? (nowMs - startedMs) / 60_000 : 0;
    minutes += Math.max(0, expected - elapsed);
    measured += 1;
  }
  const eta = remaining.length && measured === remaining.length
    ? clockAt(nowMs + minutes * 60_000)
    : null;
  return {
    phase,
    phases: levels.length,
    levels,
    done,
    total: actions.length,
    remaining: remaining.length,
    measuredRemaining: measured,
    unmeasured,
    eta,
  };
}

/** One glyph per step, in dependency order, each of them clickable. */
function planStripParts(row, { runId = null } = {}) {
  const levels = planLevels(row);
  const mark = glyphs();
  const parts = [];
  levels.forEach((level, levelIndex) => {
    if (levelIndex) parts.push({ text: '──' });
    level.forEach((action, index) => {
      if (index) parts.push({ text: ' ' });
      const glyph = action.status === 'succeeded' ? mark.ok
        : action.status === 'running' ? mark.started
          : ['failed', 'blocked', 'cancelled'].includes(action.status) ? mark.fail
            : mark.pending;
      parts.push({
        text: glyph,
        action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
      });
    });
  });
  return parts;
}

/**
 * What one run drew and spent, measured from its own attempts.
 *
 * Minutes are the wall clock each attempt recorded. A pool's licence share is
 * `ratePerMinute × those minutes`, the only licence arithmetic the plan
 * allows, and it is null — never zero — where the pool has no measured rate.
 * Money is the sum of the API-equivalent estimates the attempts recorded.
 */
function runEconomics(row, pools = [], nowMs = Date.now()) {
  // A run's economics cover every durable attempt, including optional scout
  // and planner turns.  Rollups and result envelopes use this same set; the
  // Run page must not silently omit their API/subscription usage.
  const attempts = [
    ...(row?.state?.preflight?.scout?.attempts ?? []),
    ...(row?.state?.planner?.attempts ?? []),
    ...(row?.state?.attempts ?? []),
  ];
  const byPool = new Map();
  let apiKnownSubtotalUsd = null;
  let subscriptionKnownSubtotalUsd = null;
  let priced = 0;
  let subscriptionPriced = 0;
  let measuredAttempts = 0;
  let tokenSource = null;
  let subscriptionBasis = null;
  let subscriptionDeltaPct = null;
  let subscriptionWindow = null;
  for (const attempt of attempts) {
    const name = attempt?.pool ?? null;
    const startedMs = Date.parse(attempt?.startedAt ?? '');
    const finishedMs = Date.parse(attempt?.finishedAt ?? '');
    const wall = finiteOrNull(attempt?.wallSec);
    const minutes = wall != null ? wall / 60
      : Number.isFinite(startedMs)
        ? Math.max(0, (Number.isFinite(finishedMs) ? finishedMs : nowMs) - startedMs) / 60_000
        : null;
    if (name && minutes != null) byPool.set(name, (byPool.get(name) ?? 0) + minutes);
    const cost = finiteOrNull(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd);
    const subscription = finiteOrNull(attempt?.usage?.subscription?.usd);
    const deltaPct = finiteOrNull(attempt?.usage?.subscription?.deltaPct);
    const source = tokenSourceOf(attempt?.usage?.tokenSource, cost);
    const basis = attempt?.usage?.subscription?.basis ?? 'unknown:no-meter';
    tokenSource = worstTokenSource(tokenSource, source);
    subscriptionBasis = worstSubscriptionBasis(subscriptionBasis, basis);
    if (deltaPct != null) subscriptionDeltaPct = (subscriptionDeltaPct ?? 0) + deltaPct;
    subscriptionWindow ??= attempt?.usage?.subscription?.window ?? null;
    if (cost != null) { apiKnownSubtotalUsd = (apiKnownSubtotalUsd ?? 0) + cost; priced += 1; }
    if (subscription != null) { subscriptionKnownSubtotalUsd = (subscriptionKnownSubtotalUsd ?? 0) + subscription; subscriptionPriced += 1; }
    if (cost != null && (source === 'provider-reported' || source === 'transcript-summed')) measuredAttempts += 1;
  }
  const rows = [...byPool.entries()].map(([name, minutes]) => {
    const pool = (Array.isArray(pools) ? pools : []).find((entry) => entry?.name === name) ?? null;
    const rate = finiteOrNull(pool?.spend?.pacing?.ratePerMinute);
    return {
      name,
      minutes,
      usedPct: finiteOrNull(pool?.usedPct),
      window: pool?.spend?.pacing?.window ?? pool?.pacingWindow ?? null,
      sharePct: rate == null ? null : rate * minutes,
      rateSource: pool?.spend?.pacing?.source ?? null,
    };
  }).sort((a, b) => b.minutes - a.minutes);
  return {
    pools: rows,
    apiEquivalentUsd: priced === attempts.length && attempts.length ? apiKnownSubtotalUsd : null,
    apiUsd: priced === attempts.length && attempts.length ? apiKnownSubtotalUsd : null,
    apiKnownSubtotalUsd,
    subscriptionUsd: subscriptionPriced === attempts.length && attempts.length ? subscriptionKnownSubtotalUsd : null,
    subscriptionKnownSubtotalUsd,
    subscription: {
      usd: subscriptionPriced === attempts.length && attempts.length ? subscriptionKnownSubtotalUsd : null,
      deltaPct: subscriptionDeltaPct,
      window: subscriptionWindow,
      basis: subscriptionBasis ?? 'unknown:no-meter',
    },
    tokenSource: tokenSource ?? 'unknown',
    pricedAttempts: priced,
    subscriptionPricedAttempts: subscriptionPriced,
    measuredAttempts,
    attempts: attempts.length,
  };
}

/** `shell-home ▇▇▇▇░░░ 12m/16m expected`, for a step with a live assignment. */
function stepProgressText(action, assignment, { width, nowMs }) {
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedMs = Date.parse(assignment?.startedAt ?? action?.startedAt ?? '');
  if (expected == null || expected <= 0 || !Number.isFinite(startedMs)) {
    return `${action.id} · running · no expected duration recorded`;
  }
  const elapsed = Math.max(0, (nowMs - startedMs) / 60_000);
  const bar = progressBar(elapsed / expected, Math.max(4, Math.min(12, Math.floor(width / 8))));
  return `${action.id} ${bar} ${minutesText(elapsed)}/${minutesText(expected)} expected`;
}

// ------------------------------------------------------------------- Home

/** One today tile: a number, its 7-day sparkline, and the line beneath it. */
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
function stepBarText(action, assignment, { width = 24, nowMs = Date.now(), pool = null } = {}) {
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedMs = Date.parse(assignment?.startedAt ?? action?.startedAt ?? '');
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : null;
  const short = pool == null ? null : String(pool).split(':').pop();
  const actionName = String(action.id);
  const clock = elapsed == null ? blank() : minutesText(elapsed);
  const measured = expected != null && expected > 0 && elapsed != null;
  const timing = `${clock}/${measured ? minutesText(expected) : blank()}`;
  // Pool names are identity labels. Keep the full `action@pool` only when it
  // can fit beside the timing and minimum bar; otherwise drop the pool as a
  // whole instead of letting compactRow paint an `openc…` fragment.
  const fullName = short ? `${actionName}@${short}` : actionName;
  const name = short && visibleLength(fullName) + visibleLength(timing) + 2 + 4 <= width
    ? fullName : actionName;
  const bars = Math.max(4, Math.min(10, width - visibleLength(name) - visibleLength(timing) - 2));
  const bar = measured
    ? tint(progressBar(elapsed / expected, bars), 'green')
    : tint((asciiGlyphsPreferred() ? '.' : '░').repeat(bars), 'dim');
  return {
    measured,
    text: compactRow([
      { text: name, grow: true, min: 1 },
      bar,
      timing,
    ], { width }),
  };
}

/** The assignment a run's step was dispatched under, if one was recorded. */
function assignmentOf(model, runId, actionId) {
  return (model.assignments ?? []).find((entry) => entry.runId === runId && entry.actionId === actionId) ?? null;
}

/** The pool a step's newest attempt ran on, for the `step@pool` label. */
function stepPool(row, actionId) {
  const attempt = (row?.state?.attempts ?? []).findLast((entry) => entry.actionId === actionId);
  return attempt?.pool ?? null;
}

/**
 * The `── budget · this week ──` block: one meter row per pool and one dim
 * reset/pace row beneath it.
 *
 * The money column is the one place this block could invent a figure, and it
 * does not: `monthlyPriceUsd` is null on every pool here, so the column is a
 * blank and the reason is printed once under the block rather than six times
 * inside it.
 */
function paceOnly(text) {
  const word = String(text ?? '').replace(/\s*[+\u2212-]\d+pp$/, '').trim();
  return word || blank();
}

/** How many metered pools the `budget · this week` block draws before it says
 * how many it left out. The block is a summary, not the Budget page, but a
 * silent cap reads as “those are all my pools”, so the ones it drops are
 * counted in words underneath. */
const BUDGET_WEEK_POOLS = 4;

function budgetWeekLines(body, model, { width, narrow, nowMs }) {
  const metered = (model.budget?.rows ?? [])
    .filter((row) => row.usedPct != null)
    .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0));
  const rows = metered.slice(0, BUDGET_WEEK_POOLS);
  const leftOut = metered.length - rows.length;
  body.push('');
  body.push(rule('budget · this week', null, width));
  if (!rows.length) {
    body.push(dimText(' no pool reported a licence meter · bullswarm doctor checks the meters', width));
    return;
  }
  const nameWidth = Math.min(16, rows.reduce((most, row) => Math.max(most, String(row.name).length), 0));
  const unpriced = [];
  for (const row of rows) {
    const name = cut(String(row.name), nameWidth).padEnd(nameWidth);
    const used = percentText(row.usedPct) ?? blank();
    const pace = paceWord(row.usedPct, row.elapsedPct);
    const money = row.subscription?.windowUsd == null
      ? blank()
      : formatMoney(row.subscription.windowUsd);
    if (row.subscription?.windowUsd == null) unpriced.push(row.name);
    const fits = row.fits == null
      ? null
      : `${row.fits} medium run${row.fits === 1 ? '' : 's'} fit${row.fits === 1 ? 's' : ''}`;
    const tail = narrow
      ? visibleLength(`${name} ${used} `) + 12
      : visibleLength(`${name} `) + 46;
    // The meter is capped: past 64 cells a longer bar says nothing more, so
    // the extra width at 200 columns goes to the row's words instead.
    const bar = meterBar(row.usedPct, row.elapsedPct, Math.max(4, Math.min(64, width - tail - 2)), { ansi: meterAnsi() });
    const severity = row.usedPct >= 80 ? 'red' : row.usedPct >= 50 ? 'amber' : 'green';
    body.row(
      narrow
        ? compactRow([
          { text: ` ${name}`, width: nameWidth + 1 },
          bar,
          { text: strong(used), width: 4, align: 'right' },
          { text: tint(paceOnly(pace.text), severity), grow: true, min: 3 },
        ], { width })
        : compactRow([
          { text: ` ${name}`, width: nameWidth + 1 },
          bar,
          { text: `${strong(used)} used`, width: 10, align: 'right', gap: 2 },
          { text: money, width: 8, align: 'right', gap: 2 },
          { text: tint(fits ?? blank(), severity), grow: true, min: 6, gap: 2 },
        ], { width }),
      { kind: 'page', page: 'budget', pool: row.name },
    );
    const reset = narrow
      ? `resets ${row.resetsAt ? untilText(row.resetsAt, nowMs) : blank()}`
      : `resets ${row.resetsText ?? blank()}`;
    const elapsed = percentText(row.elapsedPct);
    body.push(dimText(
      `   ${[reset, ...(narrow ? [row.subscription?.windowUsd == null ? null : money] : [elapsed ? `${elapsed} elapsed` : null, pace.text || null])].filter(Boolean).join(' · ')}`,
      width,
    ));
  }
  if (leftOut > 0) {
    body.push(dimText(
      ` +${leftOut} more metered pool${leftOut === 1 ? '' : 's'} · b opens Budget`,
      width,
    ));
  }
  if (unpriced.length) {
    // The phone has no room for the reason and the command on one row, so it
    // takes two rather than losing the command to a truncation.
    if (narrow) {
      body.push(dimText(` ${blank()} money: no declared subscription price`, width));
      body.push(dimText('   bullswarm strategy set-subscription', width));
    } else {
      body.push(dimText(
        ` ${blank()} money: no declared subscription price for ${unpriced.join(', ')} · bullswarm strategy set-subscription <pool> --monthly-usd`,
        width,
      ));
    }
  }
  // B1. The figures that are there are money at a DECLARED rate, not the
  // API-equivalent estimate every other `$` on this page is; say which.
  if (unpriced.length < rows.length) {
    body.push(dimText(' money at the declared subscription price, pro-rated over the window', width));
  }
}

/**
 * The four-column breakdown band: spent per day, by pool, by model, by
 * project. One row band at 120 and 200 columns, one column at 55.
 *
 * Each bar is a fraction of the percentage printed beside it — the same
 * number, drawn — rather than of the biggest row's minutes, which is what
 * made the old band's bars and its figures disagree.
 */
function breakdownCells(model, opts, { cellWidth }) {
  const { period } = opts;
  const breakdown = model.stats?.overview?.breakdown ?? { pools: [], models: [], projects: [] };
  const spend = model.stats?.spendPerDay ?? null;
  const rows = 4;
  const spendTokenSource = (spend?.buckets ?? []).reduce((source, bucket) => (
    bucket?.value == null
      ? source
      : worstTokenSource(source, tokenSourceOf(bucket?.tokenSource, bucket?.value))
  ), null) ?? tokenSourceOf(spend?.tokenSource, spend?.total);
  // The percent sits in a fixed four-cell field (`100%` at widest), right
  // aligned, so every bar in a list ends on the same column and `2%` lines
  // up under `19%` instead of stealing a cell from its bar.
  const barOf = (share, role, label, width) => {
    const value = Number(share);
    const raw = shareText(share) ?? blank();
    const text = raw.padStart(4);
    const bars = Math.max(3, width - visibleLength(label) - visibleLength(text) - 2);
    const bar = Number.isFinite(value) ? tint(progressBar(value, bars), role) : ' '.repeat(bars);
    return `${label} ${bar} ${text}`;
  };
  const listCell = (label, key, role, tab) => {
    const list = (breakdown[key] ?? []).slice(0, rows);
    const nameWidth = Math.min(
      Math.max(6, Math.floor(cellWidth / 2)),
      list.reduce((most, row) => Math.max(most, String(row.name ?? '?').length), 6),
    );
    return {
      action: { kind: 'tab', tab },
      rows: [
        dimText(label, cellWidth),
        ...(list.length
          ? list.map((row) => barOf(row.minutesShare, seriesColor(row.name ?? '?') ?? role, cut(String(row.name ?? '?'), nameWidth).padEnd(nameWidth), cellWidth))
          : [dimText('no finished run in this period', cellWidth)]),
      ],
    };
  };
  // Spent per day is the same series Stats charts, coloured the prototype's
  // cyan; the axis row carries the weekday letters.
  // S1/B5: with no recorded estimate in the period there is no series, and a
  // `$0.00` axis would be a confident zero. The column says so instead.
  const buckets = spend?.total == null ? [] : (spend?.buckets ?? []);
  // A numeric value explicitly marked unknown is not a measured chart point.
  // Drop it rather than painting a bare dollar axis; compatibility fixtures
  // with a numeric source omitted still resolve to the byte estimate above.
  const chartBuckets = buckets.filter((bucket) => (
    bucket?.value != null
    && tokenSourceOf(bucket?.tokenSource, bucket?.value) !== 'unknown'
  ));
  const chart = chartBuckets.length
    ? columnBars(
      [{ name: 'spent', values: chartBuckets.map((bucket) => bucket.value), color: METER_COLORS.cyan }],
      chartBuckets.map((bucket) => WEEKDAY_LETTERS[bucket.weekday] ?? String(bucket.label ?? '').slice(-2)),
      {
        width: cellWidth,
        rowCount: chartRowCount(opts.height ?? 36),
        col: Math.max(2, Math.floor((cellWidth - 7) / Math.max(1, chartBuckets.length))),
        barW: 3, unit: '$', mark: spendTokenSource === 'provider-reported' ? ''
          : spendTokenSource === 'transcript-summed' ? '≈'
            : spendTokenSource === 'estimated:utf8-bytes/4' ? '~' : '·',
        totals: false, colors: meterAnsi(),
      },
    )
    : [dimText((spend?.buckets ?? []).length
      ? 'no finished run recorded an estimate'
      : 'no finished run in this period', cellWidth)];
  return [
    {
      action: { kind: 'trend', metric: 'spend' },
      rows: [dimText(`spent per ${spend?.bucketBy === 'week' ? 'week' : 'day'}`, cellWidth), ...chart],
    },
    listCell('by pool', 'pools', 'green', 'pools'),
    listCell('by model', 'models', 'purple', 'models'),
    listCell('by project', 'projects', 'orange', 'projects'),
  ].map((cell) => ({ ...cell, period }));
}

const WEEKDAY_LETTERS = Object.freeze(['S', 'M', 'T', 'W', 'T', 'F', 'S']);

/**
 * The three-column summary band and the sentence that closes it.
 *
 * Every figure is the period's own measurement. The prototype's `7.7×`
 * multiple and its `$38.20` of subscription money have no source here — no
 * pool declares a price — so the sentence says what the runs recorded and
 * names it as the API-equivalent estimate it is.
 */
function summaryBand(body, model, opts) {
  const { width, narrow } = opts;
  const overview = model.stats?.overview ?? null;
  const keys = overview?.keys ?? null;
  if (!keys) return;
  const projects = model.stats?.projects ?? null;
  const verified = (overview.breakdown?.projects ?? []).reduce((sum, row) => sum + (row.verified ?? 0), 0);
  const runs = keys.workflows ?? 0;
  const spent = projects?.totals?.apiEquivalentUsd ?? null;
  const money = moneyText({ ...keys, apiUsd: spent });
  const share = runs ? shareText(verified / runs) : null;
  const named = (row) => (row?.name ? String(row.name) : blank());
  const figures = [
    [
      `Workflows: ${strong(tint(String(runs), 'orange'))} · verified ${tint(String(verified), 'orange')}${share ? ` (${share})` : ''}`,
      `Busiest project: ${tint(named(keys.busiestProject), 'orange')}${keys.busiestProject ? ` (${keys.busiestProject.runs})` : ''}`,
    ],
    [
      `Favourite pool: ${tint(named(keys.favouritePool), 'orange')}`,
      `Favourite model: ${tint(named(keys.favouriteModel), 'orange')}`,
    ],
    [
      `Spent: ${tint(money, 'orange')}`,
      `Median run: ${tint(minutesText(keys.medianRunMinutes) ?? blank(), 'orange')}`,
    ],
  ];
  body.push('');
  if (narrow) {
    for (const figure of figures.flat()) body.push(cut(` ${figure}`, width));
  } else {
    pushColumns(body, figures.map((rows) => ({ rows })), { width: width - 1, gap: 2 });
  }
  body.push('');
  const sentence = money && !money.includes('api unknown')
    ? `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded ${money} of API-equivalent work`
    : `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded no API-equivalent estimate`;
  body.push(cut(` ${tint(sentence, 'purple')}`, width));
}

/**
 * Home: the approved today band, the runs in flight, this week's licence
 * budget, the period's breakdown in four columns, the summary band and the
 * recent list.
 */
function homePage(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  homeTodayBand(model, opts, body);
  activeRunLines(model, opts, body);
  return homeDetails(model, opts, body);
}

function activeRunLines(model, opts, body, title = 'running') {
  const { width, narrow, nowMs } = opts;
  const tasks = Array.isArray(model.tasks?.inflight) ? model.tasks.inflight : [];
  body.push('');
  body.push(rule(title, null, width));
  if (!model.runs.length && !tasks.length) {
    body.push(dimText(' nothing in flight · bullswarm workflow goal "<goal>" launches one', width));
  }
  const unratedPools = new Set();
  model.runs.forEach((run, index) => {
    const progress = planProgress(run, { assignments: model.assignments, nowMs });
    const elapsed = ageText(stateStartedAt(run.state), nowMs);
    const right = [
      progress.phases ? `phase ${progress.phase}/${progress.phases}` : null,
      `${progress.done}/${progress.total}`,
      elapsed || null,
    ].filter(Boolean).join(' · ');
    const label = ` ${tint(glyphs().ongoing, 'cyan')} ${index < 9 ? `${index + 1}.` : ''}${run.shortId ?? run.runId}`;
    const title = `  ${cut(workflowRunLabel(run), Math.max(8, width - visibleLength(label) - visibleLength(right) - 4))}`;
    const head = `${label}${strong('')}${title}`;
    body.parts([
      { text: head, action: { kind: 'run', runId: run.runId } },
      { text: ' '.repeat(Math.max(1, width - visibleLength(head) - visibleLength(right) - 1)) },
      { text: dimText(right, width) },
    ]);

    const economics = runEconomics(run, model.pools, nowMs);
    for (const pool of economics.pools) if (pool.sharePct == null) unratedPools.add(pool.name);
    const draw = economics.pools.reduce(
      (sum, pool) => (pool.sharePct == null ? sum : (sum ?? 0) + pool.sharePct),
      null,
    );
    const money = moneyText(economics);
    const cost = `${tint(draw == null ? blank() : formatDashboardValue(draw, 'percent'), 'purple')} · ${tint(money ?? blank(), 'purple')}`;

    const live = (run.state?.actions ?? []).filter((action) => action.status === 'running');
    const bars = live.map((action) => {
      const bar = stepBarText(action, assignmentOf(model, run.runId, action.id), {
        width: narrow ? width - 4 : 30, nowMs, pool: stepPool(run, action.id),
      });
      return { action, ...bar };
    });

    if (narrow) {
      // The phone keeps the prototype's shape: the strip, one row per live
      // step, then the run's own draw and cost.
      body.parts([{ text: '   ' }, ...planStripParts(run, { runId: run.runId })]);
      for (const bar of bars) {
        body.row(`   ${bar.text}`, { kind: 'step', runId: run.runId, actionId: bar.action.id });
      }
      body.push(cut(`   ${cost}`, width));
    } else {
      // Two rows per run: the head above, and the strip, the per-step bars
      // and the cost on one band here.
      const strip = planStripParts(run, { runId: run.runId });
      const stripWidth = strip.reduce((sum, part) => sum + visibleLength(part.text), 0);
      const parts = [{ text: '   ' }, ...strip];
      let used = 3 + stripWidth;
      const room = width - visibleLength(cost) - 2;
      for (const bar of bars) {
        const span = visibleLength(bar.text) + 2;
        if (used + span > room) break;
        parts.push({ text: '  ' });
        parts.push({ text: bar.text, action: { kind: 'step', runId: run.runId, actionId: bar.action.id } });
        used += span;
      }
      parts.push({ text: ' '.repeat(Math.max(1, width - used - visibleLength(cost) - 1)) });
      parts.push({ text: cost });
      body.parts(parts);
    }
  });
  for (const task of tasks) {
    const label = `${glyphs().inflight} ${task?.lane ?? 'lane unavailable'} · ${taskPoolModelText(task)}`;
    const project = task?.project ? ` · ${task.project}` : '';
    const elapsed = taskElapsedText(task, nowMs);
    const line = compactRow([
      { text: ` ${label}`, grow: true, min: 8 },
      { text: `${taskIdText(task)}${project}`, grow: true, min: 4, gap: 2 },
      { text: elapsed, width: Math.max(5, visibleLength(elapsed)), align: 'right', gap: 2 },
      { text: ' ', width: 1, gap: 0 },
    ], { width });
    body.row(line, { kind: 'task', taskId: task?.id ?? task?.taskFile ?? null });
  }
  // The reasons, once for the whole section rather than on every row.
  if (unratedPools.size) {
    body.push(dimText(` ${blank()} no measured %/minute rate for ${[...unratedPools].join(', ')}, so no licence draw`, width));
  }

}

function homeDetails(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  budgetWeekLines(body, model, { width, narrow, nowMs });

  // The period's breakdown, and the toggle that changes it.
  const period = PERIOD_ITEMS.find((item) => item.id === opts.period) ?? PERIOD_ITEMS[0];
  body.push('');
  const toggle = periodToggle(PERIOD_ITEMS, { active: period.id, width: narrow ? width - 2 : Math.max(10, width - 24) });
  if (narrow) {
    body.push(rule(period.label.toLowerCase(), null, width));
    body.kit({ text: ` ${toggle.text}`, regions: toggle.regions.map((region) => ({ ...region, x: region.x + 1 })) });
  } else {
    const head = rule(period.label.toLowerCase(), null, Math.max(4, width - visibleLength(toggle.text) - 2));
    body.kit({ text: `${head} ${toggle.text} `, regions: toggle.regions.map((region) => ({ ...region, x: region.x + visibleLength(head) + 1 })) });
  }
  if (narrow) {
    // One column on the phone: the same four sections, stacked.
    for (const cell of breakdownCells(model, opts, { cellWidth: width - 1 })) {
      const base = body.lines.length;
      const rows = cell.rows;
      for (const line of rows) body.push(` ${cut(line, width - 1)}`);
      if (cell.action) {
        for (let row = base + 1; row <= body.lines.length; row += 1) {
          body.regions.push({ x1: 1, x2: width, y: row, action: cell.action });
        }
      }
    }
  } else {
    const gap = 2;
    const inner = Math.max(4, width - 1 - gap * 3);
    const cellWidth = Math.floor(inner / 4);
    pushColumns(body, breakdownCells(model, opts, { cellWidth }), { width: width - 1, gap });
  }
  if (!narrow) body.push(dimText(' spent per day carries the provider/transcript/estimate basis · share is measured worker-minutes · click a column for its Stats tab', width));

  summaryBand(body, model, opts);

  // The recent list: the newest finished runs the index holds.
  body.push('');
  body.push(rule('recent', 'history ›', width));
  const recent = [...(model.rollups ?? [])]
    .sort((a, b) => String(b.finishedAt ?? b.startedAt ?? '').localeCompare(String(a.finishedAt ?? a.startedAt ?? '')))
    .slice(0, narrow ? 3 : 5);
  if (!recent.length) {
    body.push(dimText(' no run has been rolled up yet · bullswarm workflow reindex backfills them', width));
  }
  for (const record of recent) {
    const ok = record.verified === true ? okMark() : record.status === 'completed' ? pendingMark() : failMark();
    const cost = recordCostInfo(record);
    const money = moneyText(cost);
    body.row(compactRow([
      { text: ` ${ok}`, width: 2 },
      { text: strong(record.shortId ?? record.runId), width: 7 },
      {
        text: cut(`${record.project ?? blank()} · ${String(record.goal ?? '').split('\n')[0]}`, Math.max(6, width - 34)),
        grow: true,
        min: 6,
        gap: 2,
      },
      { text: `${minutesText(record.minutes?.wall) ?? blank()} · ${money ?? blank()}`, width: 16, align: 'right', gap: 2 },
      { text: dimText(`${ageText(record.finishedAt, nowMs)} ago`, 12), width: 11, align: 'right', gap: 2 },
    ], { width }), { kind: 'run', runId: record.runId });
  }
  if (narrow) body.push(dimText(' ≈ API-equivalent estimates · click tiles for charts', width));
  return ' bullswarm · home';
}

/** Merge task ledger rows into a caller-supplied workflow day page. */
function daysWithTasks(days, tasks) {
  const source = Array.isArray(days) ? days : [];
  const out = source.map((day) => ({ ...day, rows: [...(day.rows ?? [])] }));
  const byDate = new Map(out.map((day) => [String(day.date), day]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const date = dayKey(task?.endedAt ?? task?.finishedAt ?? task?.startedAt);
    if (!date) continue;
    const day = byDate.get(date) ?? {
      date, runs: 0, finished: 0, verified: 0, verifiedShare: null, spendUsd: null,
      legacyRows: 0, unfinishedRows: 0, rows: [],
    };
    if (!byDate.has(date)) { byDate.set(date, day); out.push(day); }
    const id = taskIdentity(task);
    const alreadyListed = day.rows.some((row) => (row?.kind === 'task' || row?.task === true)
      && taskIdentity(row) === id);
    if (!alreadyListed) {
      day.rows.push({ ...task, kind: 'task', source: 'run' });
    }
  }
  return out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/** The API-equivalent estimate a rollup record carries, over its pools. */
function recordCost(record) {
  if (record?.usage && Object.hasOwn(record.usage, 'apiUsd')) return finiteOrNull(record.usage.apiUsd);
  const direct = finiteOrNull(record?.apiEquivalentUsd ?? record?.costUsd);
  if (direct != null) return direct;
  let total = null;
  for (const entry of Object.values(record?.pools ?? {})) {
    const value = finiteOrNull(entry?.costUsd);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

function recordCostInfo(record) {
  const value = recordCost(record);
  const usage = record?.usage ?? {};
  const subscription = {
    // A partial subtotal is evidence that some attempts were priced, not a
    // complete subscription amount.  Keep it out of the pair's dollar slot;
    // the strict `subscriptionUsd` field is the only value that may render
    // as a measured/calibrated subscription cost.
    usd: finiteOrNull(usage.subscriptionUsd),
    deltaPct: finiteOrNull(usage.deltaPct),
    window: usage.window ?? null,
    basis: usage.subscriptionBasis ?? 'unknown:no-meter',
  };
  let tokenSource = Object.hasOwn(TOKEN_SOURCE_RANK, record?.tokenSource) ? record.tokenSource : null;
  for (const entry of Object.values(record?.pools ?? {})) {
    const cost = finiteOrNull(entry?.costUsd);
    tokenSource = worstTokenSource(tokenSource, tokenSourceOf(entry?.tokenSource, cost));
  }
  return {
    value,
    apiUsd: value,
    tokenSource: tokenSource ?? tokenSourceOf(null, value),
    subscription,
    subscriptionUsd: subscription.usd,
    subscriptionBasis: subscription.basis,
  };
}

/** Runs: the list, the filter, the agent integration and the commands. */
function runsPage(model, opts, body) {
  const { width } = opts;
  const active = [...model.runs];
  for (const row of opts.allRows ?? []) {
    if ((row.ongoing || isWaitingWorkflow(row.state)) && !active.some((run) => run.runId === row.runId)) active.push(row);
  }
  const query = String(opts.query ?? '').toLowerCase();
  const matches = (run) => !query || `${run.runId ?? ''} ${run.shortId ?? ''} ${run.goal ?? workflowRunLabel(run)} ${run.id ?? ''} ${run.taskFile ?? ''} ${run.lane ?? ''} ${run.pool ?? ''} ${run.model ?? ''} ${run.project ?? ''}`.toLowerCase().includes(query);
  activeRunLines({
    ...model,
    runs: active.filter(matches),
    tasks: { ...(model.tasks ?? {}), inflight: (model.tasks?.inflight ?? []).filter(matches) },
  }, opts, body, 'active');
  body.push('');
  body.anchor = { history: body.lines.length + 1, cursor: null };
  const ids = new Set(active.map((run) => run.runId));
  const days = daysWithTasks(model.days, (model.tasks?.finished ?? []).filter(matches)).map((day) => ({
    ...day,
    rows: (day.rows ?? []).filter((run) => !ids.has(run.runId) && matches(run)),
  }));
  pushView(body, historyLines(days, { width, ansi: meterAnsi() }));
  if (opts.query) body.push(dimText(` filter “${opts.query}”`, width));
  const runRegions = body.regions.filter((region) => region.action?.kind === 'run');
  const taskRegions = body.regions.filter((region) => region.action?.kind === 'task');
  const desired = opts.listSelectedId ?? opts.selectedRunId ?? null;
  const runRows = runRegions.sort((a, b) => a.y - b.y);
  const allRows = [...runRegions, ...taskRegions].sort((a, b) => a.y - b.y);
  const desiredTask = opts.selectedTaskId ?? null;
  const wanted = desiredTask
    ? allRows.findIndex((region) => region.action.kind === 'task' && region.action.taskId === desiredTask)
    : allRows.findIndex((region) => region.action.kind === 'run' && region.action.runId === desired);
  const cursor = allRows[wanted >= 0 ? wanted : 0];
  if (cursor) {
    body.lines[cursor.y - 1] = `\x1b[7m${body.lines[cursor.y - 1]}\x1b[0m`;
    body.anchor.cursor = cursor.y;
  }
  body.runRows = runRows.map((region) => ({ runId: region.action.runId, y: region.y }));
  body.taskRows = taskRegions.map((region) => ({ taskId: region.action.taskId, y: region.y }));
  body.cursorAction = cursor?.action ?? null;
  return ` bullswarm · runs · ${opts.filter === 'all' ? 'all' : 'active'} · ${days.length} days`;
}

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

function planAttemptDetail(attempt, width) {
  const cols = Math.max(0, Number(width) || 0);
  const reasoning = reasoningText(attempt);
  const pool = attempt?.pool ? String(attempt.pool) : null;
  const model = attempt?.model ? String(attempt.model) : null;
  const effortValue = attempt?.effort ?? attempt?.routing?.effort;
  const effort = effortValue ? String(effortValue) : null;
  // Keep the pool/model identity atomic. If the full detail does not fit,
  // remove the pool, then the model; only a remaining effort/reasoning label
  // may be cut as a last resort. This prevents a short plan cell from ever
  // painting a misleading `openc…` pool name.
  const candidates = [
    [pool, model, effort, reasoning],
    [model, effort, reasoning],
    [effort, reasoning],
    [reasoning],
    [],
  ];
  for (const candidate of candidates) {
    const text = candidate.filter(Boolean).join(' · ');
    if (!text || text.length <= cols) return text;
  }
  return cols > 0 && reasoning ? cut(reasoning, cols) : '';
}

/**
 * The plan as the prototype draws it: the levels across the width with their
 * branch topology, a per-step bar on whatever is running, and the pool and
 * model each level ran on underneath.
 *
 * A plan with no real fan-out — every level exactly one step — keeps the
 * linear `▶──○` strip the page has always drawn; the topology only appears
 * where there is topology to draw.
 */
/** The presentation stages the Run page and its timeline agree on. */
function planStages(row) {
  try {
    const panel = workflowPanelModel(row);
    const definitions = new Map((panel.state.program?.actions ?? []).map((action) => [action.id, action]));
    const states = new Map((panel.state.actions ?? []).map((action) => [action.id, action]));
    const stages = (panel.stages ?? []).map((stage) => ({
      ...stage,
      actions: (stage.actionIds ?? [])
        .map((id) => ({ ...definitions.get(id), ...states.get(id) }))
        .filter((action) => action?.id),
    })).filter((stage) => stage.actions.length);
    if (stages.length) return { stages, dependencyGroups: panel.dependencyGroups };
  } catch { /* a torn state falls through to the action graph below */ }
  const levels = planLevels(row).filter((level) => level.length);
  return {
    dependencyGroups: true,
    stages: levels.map((actions, index) => ({
      id: `level-${index + 1}`, label: `Phase ${index + 1} · ${actions.length > 1 ? 'Parallel work' : actions[0].id}`,
      actionIds: actions.map((action) => action.id), actions,
      startedAt: actions.map((action) => action.startedAt).filter(Boolean).sort()[0] ?? null,
      completedAt: actions.map((action) => action.finishedAt).filter(Boolean).sort().at(-1) ?? null,
    })),
  };
}

function planStageLabel(stage, index) {
  const label = String(stage?.label ?? '').trim();
  return /^((?:Follow-up \d+: )?Phase \d+)(?: ·|$)/.test(label)
    ? label
    : `Phase ${index + 1} · ${label || 'starting'}`;
}

function planStageHeader(stage, index) {
  const actions = stage.actions ?? [];
  const progress = presentationStageStatus(stage, actions);
  const running = actions.some((action) => action.status === 'running');
  const failed = actions.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
  const status = running ? glyphs().started
    : failed ? glyphs().fail
      : progress.completed === progress.total && progress.total > 0 ? glyphs().ok : glyphs().pending;
  return `${planStageLabel(stage, index)} · ${progress.completed}/${progress.total} ${status}`;
}

function planStageActions(stage, limit = null) {
  const actions = stage.actions ?? [];
  if (limit == null || actions.length <= limit) return { actions, omitted: 0 };
  const keep = Math.max(1, Number(limit) || 1);
  const rank = (action) => action.status === 'running' ? 0
    : ['failed', 'blocked', 'cancelled'].includes(action.status) ? 1
      : action.status === 'succeeded' ? 3 : 2;
  const running = actions.filter((action) => action.status === 'running');
  const picked = [...running];
  for (const action of actions
    .filter((entry) => !picked.includes(entry))
    .sort((a, b) => rank(a) - rank(b))) {
    if (picked.length >= keep) break;
    picked.push(action);
  }
  // Keep the phase's authored order after prioritising running/failed work,
  // so the summary never makes a column look re-ordered.
  const shown = actions.filter((action) => picked.includes(action));
  return { actions: shown, omitted: Math.max(0, actions.length - shown.length) };
}

function planMoreParts(count, width) {
  return [{ text: dimText(`+${count} more`, Math.max(1, width)) }];
}

function phaseActionGlyph(action) {
  if (action.status === 'succeeded') return okMark();
  if (action.status === 'running') return runningMark();
  if (['failed', 'blocked', 'cancelled'].includes(action.status)) return failMark();
  return pendingMark();
}

function fittedParts(parts, width) {
  const limit = Math.max(0, Number(width) || 0);
  const out = [];
  let used = 0;
  for (const part of parts) {
    if (used >= limit) break;
    const text = String(part?.text ?? '');
    const room = limit - used;
    if (visibleLength(text) <= room) {
      out.push({ ...part, text });
      used += visibleLength(text);
      continue;
    }
    if (room > 0) out.push({ ...part, text: cut(text, room) });
    used = limit;
    break;
  }
  if (used < limit) out.push({ text: ' '.repeat(limit - used) });
  return out;
}

/** One phase action row; metadata and the running bar are never subtitle rows. */
function planPhaseActionParts(action, { width, row, runId, assignments, nowMs, selectedId }) {
  const actionName = String(action.id);
  const name = selectedId === action.id ? `\x1b[7m${actionName}\x1b[0m` : actionName;
  const attempt = (row?.state?.attempts ?? []).findLast((entry) => entry.actionId === action.id) ?? null;
  const assignment = (assignments ?? []).find((entry) => entry.runId === runId && entry.actionId === action.id) ?? null;
  const prefix = `${phaseActionGlyph(action)} `;
  const base = [{ text: prefix }, {
    text: name,
    action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
  }];
  const fixed = visibleLength(prefix) + visibleLength(name);
  const expected = finiteOrNull(assignment?.expectedMinutes ?? attempt?.expectedMinutes);
  const startedMs = Date.parse(attempt?.startedAt ?? action?.startedAt ?? '');
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : null;
  const elapsedText = elapsed == null ? null : minutesText(elapsed);
  const p50Text = expected == null ? blank() : minutesText(expected);
  const timing = action.status === 'running' ? `${elapsedText ?? blank()}/${p50Text}` : '';
  const spark = action.status === 'running' ? outputSparkline(attempt, row?.runDir, 8) : '';
  const minBar = action.status === 'running' ? 4 : 0;
  const timingWidth = timing ? visibleLength(timing) + 1 : 0;
  const sparkWidth = spark ? visibleLength(spark) + 1 : 0;
  const reasoning = attempt ? reasoningText(attempt) : '';
  const detailAttempt = attempt && reasoning ? { ...attempt, effort: null, routing: { ...(attempt.routing ?? {}), effort: null } } : attempt;
  // Prefer the complete pool/model identity when the cell can make room for
  // it. A narrow phase cell may still fall back to model/reasoning, but a
  // desktop cell should not spend all its space on a long progress bar first.
  const fullDetail = detailAttempt ? planAttemptDetail(detailAttempt, Number.MAX_SAFE_INTEGER) : '';
  const fullDetailWidth = visibleLength(fullDetail);
  let barWidth = action.status === 'running' && width - fixed - timingWidth - sparkWidth - 1 >= minBar
    ? Math.max(minBar, Math.min(10, width - fixed - timingWidth - sparkWidth - 1)) : 0;
  if (action.status === 'running' && fullDetail && width - fixed - timingWidth - sparkWidth - fullDetailWidth - 1 >= 1) {
    barWidth = Math.min(10, Math.max(1, width - fixed - timingWidth - sparkWidth - fullDetailWidth - 1));
  }
  // Seven phases at 120 columns leave deliberately small cells. Keep a
  // running step's bar and elapsed/p50 on its row by using a one-cell bar and
  // compact separators before ever dropping the running measurement.
  const compactBar = action.status === 'running' && !barWidth && width - fixed - visibleLength(timing) >= 1;
  if (compactBar) barWidth = 1;
  const detailRoom = Math.max(0, width - fixed - (barWidth ? barWidth + timingWidth + sparkWidth : 1));
  const detail = detailAttempt ? planAttemptDetail(detailAttempt, detailRoom) : '';
  if (detail) base.push({ text: ` · ${dimText(detail, detailRoom + 24)}` });
  if (barWidth) {
    const measured = expected != null && expected > 0 && elapsed != null;
    const ratio = measured ? elapsed / expected : 0;
    const bar = measured
      ? tint(progressBar(ratio, barWidth), 'green')
      : tint((asciiGlyphsPreferred() ? '.' : '░').repeat(barWidth), 'dim');
    base.push({ text: compactBar ? `${bar}${timing}` : ` ${bar} ${timing}${spark ? ` · ${spark}` : ''}` });
  }
  return fittedParts(base, width);
}

/**
 * The Run plan: presentation phases are columns on desktop, and the same
 * phase headers precede a stacked list below 120 columns. There are no
 * connectors between steps; desktop has one connector per neighbouring phase,
 * on the header row only.
 */
function planDagLines(row, {
  width, runId = null, assignments = [], nowMs = Date.now(), pools = true, selectedId = null, maxRows = null,
} = {}) {
  const { stages } = planStages(row);
  if (!stages.length) return [];
  const headers = stages.map((stage, index) => planStageHeader(stage, index));
  const actionLimit = Number.isFinite(Number(maxRows)) && Number(maxRows) >= 1
    ? Math.max(1, Math.trunc(Number(maxRows)) - 1) : null;
  const displayed = stages.map((stage) => planStageActions(stage, actionLimit));
  const rowsFor = (stage, index, cellWidth) => [
    headers[index],
    ...displayed[index].actions.map((action) => planPhaseActionParts(action, {
      width: cellWidth, row, runId, assignments, nowMs, selectedId,
    })),
    ...(displayed[index].omitted ? [planMoreParts(displayed[index].omitted, cellWidth)] : []),
  ];
  if (width < 120) {
    const out = [];
    stages.forEach((stage, index) => {
      out.push({ parts: [{ text: rule(headers[index], null, width) }] });
      for (const action of displayed[index].actions) {
        out.push({ parts: planPhaseActionParts(action, {
          width: Math.max(1, width - 1), row, runId, assignments, nowMs, selectedId,
        }).map((part, at) => at === 0 ? { ...part, text: ` ${part.text}` } : part) });
      }
      if (displayed[index].omitted) out.push({ parts: [{ text: ` ${dimText(`+${displayed[index].omitted} more`, width - 1)}` }] });
    });
    return out;
  }

  // `columns` is used only for its width calculation. Its fit policy retains
  // one cell per phase at desktop widths, while the parts below keep only the
  // step name clickable and the pool/model dim.
  // The body gives every plan row one leading margin, so reserve it before
  // asking the kit to divide the desktop band.
  const sizing = columns(stages.map((stage, index) => ({ rows: rowsFor(stage, index, 1) })), { width: Math.max(1, width - 1), gap: 2 });
  const columnsMeta = sizing.meta?.columns ?? [];
  if (columnsMeta.length !== stages.length) {
    // A pathological plan with more phases than cells still gets every phase
    // in the readable stacked form rather than silently dropping a column.
    return planDagLines(row, { width: 119, runId, assignments, nowMs, pools, selectedId, maxRows });
  }
  const height = displayed.reduce((most, stage) => Math.max(most, 1 + stage.actions.length + (stage.omitted ? 1 : 0)), 1);
  const out = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const parts = [];
    columnsMeta.forEach((column, index) => {
      if (index) parts.push({ text: rowIndex === 0 ? '──' : '  ' });
      const cellParts = rowIndex === 0
        ? [{ text: headers[index] }]
        : (displayed[index].actions[rowIndex - 1]
          ? planPhaseActionParts(displayed[index].actions[rowIndex - 1], {
            width: column.width, row, runId, assignments, nowMs, selectedId,
          })
          : displayed[index].omitted && rowIndex === displayed[index].actions.length + 1
            ? planMoreParts(displayed[index].omitted, column.width)
          : [{ text: '' }]);
      parts.push(...fittedParts(cellParts, column.width));
    });
    out.push({ parts: [{ text: ' ' }, ...parts] });
  }
  return out;
}

/**
 * The timeline, flat: the same rows the mod pane reads, windowed to the space
 * the page has for them and with no box drawn around them.
 *
 * `renderWorkflowOverviewPanel` still draws the boxed frame for
 * `bullswarm workflow tui <id> --overview`, untouched; this is the page's own
 * reading of the same lines.
 */
function flatTimelineLines(panel, { width, rows, scroll = 0, selectedSegment = null, spinnerFrame = 0 } = {}) {
  const timeline = workflowTimelineLines(panel, width, spinnerFrame, { goalPreview: false });
  const room = Math.max(1, Number(rows) || 1);
  const selectedHeader = selectedSegment
    ? timeline.lines.findIndex((line) => line?.header && line.segment === selectedSegment)
    : -1;
  const maxScroll = Math.max(0, timeline.lines.length - room);
  const at = clamp(scroll, 0, maxScroll);
  // The newest rows fill the window, which is what a reader watching a run
  // wants; a selected segment only re-anchors it when that segment has
  // already scrolled out of view, so choosing a phase never empties the page.
  let end = Math.max(0, timeline.lines.length - at);
  let start = Math.max(0, end - room);
  const anchored = selectedHeader >= 0 && (selectedHeader < start || selectedHeader >= end);
  if (anchored) {
    start = selectedHeader;
    end = Math.min(timeline.lines.length, selectedHeader + room);
  }
  if (start > 0 && !anchored) {
    start = Math.max(0, end - Math.max(0, room - 1));
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]))) start += 1;
  }
  let visible = timeline.lines.slice(start, end);
  if (start > 0 && !anchored) {
    visible.unshift(dimText(`↑ ${start} earlier timeline rows`, width));
    const continuation = visible.find((line) => line?.segment)?.segment ?? currentTimelineSegment(panel);
    if (continuation) {
      const prior = timeline.lines.find((line) => line?.header && line.segment === continuation);
      const header = continuationHeader(
        timelineSegmentDisplayName(continuation, panel),
        prior?.elapsed ?? 'running',
        width,
        visible.find((line) => line?.segment === continuation)?.at,
      );
      header.segment = continuation;
      visible.splice(1, 0, header);
    }
    visible = visible.filter((line) => timelineText(line) !== '');
  }
  if (end < timeline.lines.length && visible.length && !anchored) {
    const marker = dimText(`↓ ${timeline.lines.length - end} newer timeline rows`, width);
    if (visible.length >= room) visible[visible.length - 1] = marker;
    else visible.push(marker);
  }
  visible = visible.length > room
    ? [visible[0], visible[1], ...visible.slice(-(room - 2))]
    : visible;
  const out = visible.slice(0, room).map((line) => {
    const text = timelineText(line);
    if (line?.header) {
      return line.segment === selectedSegment ? `\x1b[7m${text}\x1b[0m` : dimText(text, width);
    }
    return text;
  });
  // The milestone count the panel used to carry in its title; the mod pane and
  // the tests both read it, and a live row is still not a milestone.
  Object.defineProperty(out, 'milestones', { enumerable: false, value: timeline.milestoneCount });
  return out;
}

/** `✓ 3  ▶ 2  ○ 3`, the run's steps by the state they are in. */
function stepTally(row) {
  const actions = row?.state?.actions ?? [];
  const done = actions.filter((action) => action.status === 'succeeded').length;
  const running = actions.filter((action) => action.status === 'running').length;
  const failed = actions.filter((action) => ['failed', 'blocked', 'cancelled'].includes(action.status)).length;
  const waiting = Math.max(0, actions.length - done - running - failed);
  return [
    `${okMark()} ${done}`,
    running ? `${runningMark()} ${running}` : null,
    failed ? `${failMark()} ${failed}` : null,
    `${dimText(glyphs().pending, 2)} ${waiting}`,
  ].filter(Boolean).join('  ');
}

/** The `budget` cell of the Run page's triptych: one row per pool it drew on. */
function runBudgetRows(economics, { width }) {
  if (!economics.pools.length) return [absentLine('', 'no attempt has recorded a pool yet', { width })];
  if (economics.pools.every((pool) => pool.sharePct == null)) {
    return [absentLine('', 'free model · no licence meter', { width })];
  }
  return economics.pools.flatMap((pool) => {
    if (pool.sharePct == null) return [absentLine(pool.name, 'free model · no licence meter', { width })];
    const percent = pool.sharePct > 0 && pool.sharePct < 1 ? pool.sharePct.toFixed(1) : String(Math.round(pool.sharePct));
    const window = pool.window === 'monthly' ? 'monthly' : pool.window === 'five_hour' ? 'five-hour' : 'weekly';
    const share = `${about()} ${percent}% of the ${window} plan`;
    const name = String(pool.name);
    const bars = Math.min(20, width - visibleLength(name) - visibleLength(share) - 2);
    if (bars < 4) return [cut(name, width), cut(`${tint(progressBar(pool.sharePct / 100, 4, { partialGlyph: '▏' }), 'purple')} ${share}`, width)];
    return [`${name} ${tint(progressBar(pool.sharePct / 100, bars, { partialGlyph: '▏' }), 'purple')} ${share}`];
  });
}

/** The `live` cell: what is running now and the last thing each one did. */
function runLiveRows(panel, { width, nowMs, limit = 3 }) {
  const running = (panel.state.attempts ?? []).filter((attempt) => attempt.status === 'running');
  // A run whose kernel is gone says so, and says the two things a reader can
  // do about it — the same words `renders` and `workflow runs show` use.
  const dead = [];
  if (!stateFinishedAt(panel.state)) {
    const liveness = panel.row?.liveness ?? v2RunnerLiveness(panel.state, { runDir: panel.row?.runDir });
    if (!liveness.alive) {
      dead.push(dimText(cut(`${glyphs().fail} kernel not running · ${liveness.reason}`, width), width + 8));
      dead.push(dimText(cut(`  resume it · bullswarm workflow resume ${panel.state.shortId ?? panel.state.runId}`, width), width + 8));
    }
  }
  if (panel.row?.kernelStderrTail?.length) dead.push(dimText('  kernel log: available', width + 8));
  if (!running.length) {
    return [dimText(stateFinishedAt(panel.state)
      ? `no live agents · workflow ${panel.state.lifecycle.status}`
      : panel.state.lifecycle?.status === 'paused'
        ? `paused · bullswarm workflow resume ${panel.state.shortId ?? panel.state.runId} continues it`
        : 'waiting for the next dispatch', width), ...dead];
  }
  const rows = [...dead];
  for (const attempt of running.slice(0, limit)) {
    const elapsed = durationText(attempt.startedAt);
    const spark = outputSparkline(attempt, panel.row?.runDir, 8);
    const total = spark ? ` · output ${spark}` : '';
    const action = `${runningMark()} ${attempt.actionId}`;
    const pool = attempt.pool == null ? 'unassigned' : String(attempt.pool);
    const suffix = `· ${elapsed}${total}`;
    const full = `${action} · ${pool} ${suffix}`;
    // A pool is an identity, not prose. Keep it whole when the live cell has
    // room; otherwise omit it before the final line cut so a narrow Run page
    // cannot paint a misleading `openc…` name.
    const line = visibleLength(full) <= width
      ? full
      : `${action} ${suffix}`;
    rows.push(cut(dimText(line, width + 24), width));
    const event = attempt.lastAgentEvent;
    rows.push(dimText(cut(`  ${glyphs().detail} ${event
      ? `${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`
      : 'waiting for the first semantic action event'}`, width), width + 8));
  }
  return rows;
}

/** The `so far` cell: the steps, the time, the spend and what is not measured. */
function runSoFarRows(row, panel, progress, economics, { width, nowMs }) {
  const money = moneyText(economics);
  const elapsed = durationText(stateStartedAt(panel.state), stateFinishedAt(panel.state));
  const label = (name, value) => `${name.padEnd(9)}${value}`;
  return [
    label('steps', stepTally(row)),
    label('time', `${elapsed}${progress.eta ? ` · ETA ${progress.eta}` : ` · ETA ${blank()}`}`),
    label('spent', tint(money, 'purple')),
    dimText(cut(`${economics.measuredAttempts} of ${economics.attempts} attempts measured`, width), width + 8),
  ];
}

/** Why the triptych's blanks are blank, once, across the page's own width. */
function runBlankReasons(economics, progress) {
  return [
    economics.apiEquivalentUsd == null ? 'cost unknown: no usage measurement exists' : null,
    !progress.eta && progress.unmeasured?.length
      ? `ETA ${blank()}: ${progress.unmeasured.join(', ')} ${progress.unmeasured.length === 1 ? 'has' : 'have'} no recorded duration yet`
      : null,
  ].filter(Boolean);
}

/**
 * Run: the goal, the plan with its topology and its bars, the budget / live /
 * so far triptych, and the timeline — all flat, with no panel borders.
 *
 * The boxed frame `bullswarm workflow tui <id> --overview` prints is
 * `renderWorkflowOverviewPanel`, which this function no longer calls and did
 * not change; the Claude mod's `parseOverview` still reads exactly what it
 * read before. The `o` planner view and the `v` technical view keep their
 * panels: the prototype has no frame for either, and they are diagnostic
 * sub-views a reader opens deliberately.
 */
function runPage(model, opts, body) {
  const { width, bodyHeight, nowMs, narrow, spinnerFrame } = opts;
  const row = model.row;
  const panel = workflowPanelModel(row, { phaseIndex: opts.phaseIndex, agentIndex: opts.agentIndex });
  const state = panel.state;
  const status = row?.status ?? stateStatus(state) ?? 'starting';
  const shortId = state.shortId ?? row?.shortId ?? row?.runId ?? '------';
  const done = (state.actions ?? []).filter((action) => action.status === 'succeeded').length;
  const total = (state.actions ?? []).length;
  const elapsed = durationText(stateStartedAt(state), stateFinishedAt(state));
  const terminalLabel = stateFinishedAt(state)
    ? ` · ${status === 'completed' ? 'done' : status}${isProgramWorkflow(state) && status === 'completed' ? hasPassingRequirementEvidence(state) ? ' · evidence passed' : ' · unverified' : ''}`
    : '';
  const header = truncate(` ${shortId} ${status}${elapsed && elapsed !== 'time pending' ? ` · ${elapsed}` : ''} · ${done}/${total} actions${terminalLabel}`, width);

  // The planner and technical views keep the panels they always drew: the
  // prototype has no frame for either and both are opened deliberately.
  if (opts.orchestratorDetail || opts.workflowVerbose) {
    const frame = runFrame(row, { ...opts, focus: opts.focus === 1 ? 1 : 0, bodyHeight });
    for (const line of frame.body) body.push(line);
    markStepRows(body, frame.body, frame.model);
    return header;
  }

  // The goal, above the timeline rather than replayed inside it.
  const goal = String(state.intent?.goal ?? state.workflow ?? '').trim();
  const goalRows = wrapLines(goal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), width - 2)
    .slice(0, narrow ? 2 : 2);
  for (const line of goalRows) body.push(cut(` ${line}`, width));

  const progress = planProgress(row, { assignments: model.assignments, nowMs });
  const right = [
    progress.phases ? `phase ${progress.phase} of ${progress.phases}` : null,
    `${progress.done}/${progress.total} steps`,
    progress.eta ? `ETA ${progress.eta}` : progress.remaining ? `ETA ${blank()}` : null,
  ].filter(Boolean).join(' · ');
  body.push(rule('plan', right, width));
  const selectedId = opts.focus === 1 ? panel.selectedAgent?.action?.id ?? null : null;
  // Keep a small reserve for the licence/live band, its explanations, and a
  // few timeline rows. The plan itself reports any action rows that could not
  // fit, while all phase headers remain visible in their authored order.
  const planRowBudget = Math.max(1, (Number(bodyHeight) || 24) - body.lines.length - 12);
  for (const line of planDagLines(row, {
    width, runId: row?.runId ?? null, assignments: model.assignments, nowMs, pools: !narrow, selectedId,
    maxRows: planRowBudget,
  })) body.parts(line.parts);

  // The prototype's budget / live / so far triptych: one row band at the
  // desktop widths, three stacked sections on the phone.
  const economics = runEconomics(row, model.pools, nowMs);
  body.push('');
  if (narrow) {
    // The phone spends the prototype's rows: the budget, one `so far` line
    // under it, then what is live — and leaves the timeline the rest.
    body.push(rule('licence this run used', null, width));
    for (const line of runBudgetRows(economics, { width: width - 2 })) body.push(` ${cut(line, width - 1)}`);
    const money = moneyText(economics);
    body.push(cut(` so far ${tint(money, 'purple')} · ${economics.measuredAttempts} of ${economics.attempts} attempts measured · ${stepTally(row)} · ${durationText(stateStartedAt(state), stateFinishedAt(state))}${progress.eta ? ` · ETA ${progress.eta}` : ` · ETA ${blank()}`}`, width));
    body.push('');
    body.push(rule('live', null, width));
    for (const line of runLiveRows(panel, { width: width - 2, nowMs, limit: 2 })) body.push(` ${cut(line, width - 1)}`);
  } else {
    const gap = 2;
    const inner = Math.max(9, width - gap * 2);
    const cellWidth = Math.floor(inner / 3);
    // The rules sit on the page's own left margin; the rows under them are
    // indented one column, the way every other section on the page is.
    const inset = (rows) => rows.map((line) => ` ${cut(line, cellWidth - 1)}`);
    pushColumns(body, [
      { rule: 'licence this run used', rows: inset(runBudgetRows(economics, { width: cellWidth - 1 })), action: { kind: 'page', page: 'budget' } },
      { rule: 'live', rows: inset(runLiveRows(panel, { width: cellWidth - 1, nowMs })) },
      { rule: 'so far', rows: inset(runSoFarRows(row, panel, progress, economics, { width: cellWidth - 1, nowMs })) },
    ], { width, gap, indent: 0 });
  }
  // Every blank in the three cells above, and the reason for it, once.
  for (const reason of runBlankReasons(economics, progress)) {
    body.push(dimText(` ${blank()} ${reason}`, width));
  }

  body.push('');
  // What fills the rest of the body: the timeline, the phase list `t` shows
  // instead of it, or the selected phase's steps once Enter has walked in.
  const used = body.lines.length;
  const rows = Math.max(3, Math.max(6, Number(bodyHeight) || 24) - used - 1);
  if (opts.focus === 1) {
    const phase = panel.selectedPhase;
    body.push(rule(`${phase.label} · ${phase.completed}/${phase.total} complete`, null, width));
    if (!panel.agents.length) {
      const blocked = phase.blockedActions ?? [];
      for (const entry of blocked) {
        body.push(dimText(` ${glyphs().blocked} ${entry.id} · never dispatched · blocked by ${entry.blockedBy.length ? entry.blockedBy.join(', ') : 'a failed dependency'}`, width));
      }
      // No agent has been dispatched, so the phase says what it plans to run
      // and the role the kernel gave each step — never `undefined`.
      body.push(dimText(' no agent has started in this phase yet', width));
      body.push(dimText(' planned steps in this phase:', width));
      for (const entry of phase.actions) {
        if (blocked.some((item) => item.id === entry.id)) continue;
        body.row(
          cut(` ${statusIcon(entry.status, spinnerFrame)} ${entry.id} · ${actionRoleLabel(entry)} · ${entry.status}`, width),
          { kind: 'step', actionId: entry.id },
        );
      }
      if (!phase.actions.length) body.push(dimText(' waiting for the planner to add work', width));
    }
    panel.agents.forEach((agent, index) => {
      const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
      const age = durationText(agent.attempt?.startedAt ?? agent.active?.startedAt, agent.attempt?.finishedAt);
      const tokens = tokenText(agent.attempt?.usage);
      body.row(
        selectLine(
          `${statusIcon(agent.status, spinnerFrame)} ${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}${tokens ? ` · ${tokens}` : ''}${age !== 'time pending' ? ` · ${age}` : ''}`,
          index === panel.agentIndex, true, width,
        ),
        { kind: 'step', actionId: agent.action.id },
      );
    });
    // Whatever the step list leaves goes back to the timeline rather than to
    // blank rows: the reader is still reading a run.
    const left = rows - (body.lines.length - used) - 2;
    if (left >= 4) {
      body.push('');
      const tail = flatTimelineLines(panel, {
        width: width - 1, rows: left - 1, scroll: opts.detailScroll ?? 0, spinnerFrame,
      });
      body.push(rule('timeline', `${tail.milestones} milestone${tail.milestones === 1 ? '' : 's'}`, width));
      const from = body.lines.length;
      for (const line of tail) body.push(` ${cut(line, width - 1)}`);
      markStepRows(body, body.lines.slice(from), panel, row?.runId ?? null);
    }
  } else if (opts.mobileTimeline === false) {
    body.push(rule(`phases · ${panel.phases.length}`, null, width));
    panel.phases.forEach((phase, index) => {
      body.push(selectLine(
        `${index + 1} ${statusIcon(phase.status, spinnerFrame)} ${phase.label}${phase.total ? ` ${phase.completed}/${phase.total}` : ''}`,
        index === panel.phaseIndex, true, width,
      ));
    });
  } else {
    // The timeline follows the newest event by default. It only re-anchors on
    // a phase the reader chose — `phaseIndex` is null while the page is
    // following the active one — so choosing nothing never stops the follow.
    const selectedSegment = opts.mobileTimeline !== false && opts.timelineSelection != null
      ? (opts.timelineSelection === 0 ? 'Preflight' : panel.phases[opts.timelineSelection - 1]?.label ?? null)
      : opts.phaseIndex != null ? panel.phases[panel.phaseIndex]?.label ?? null : null;
    const lines = flatTimelineLines(panel, {
      width: width - 1, rows: rows - 1, scroll: opts.detailScroll ?? 0, selectedSegment, spinnerFrame,
    });
    body.push(rule('timeline', `${lines.milestones} milestone${lines.milestones === 1 ? '' : 's'}`, width));
    const from = body.lines.length;
    for (const line of lines) body.push(` ${cut(line, width - 1)}`);
    markStepRows(body, body.lines.slice(from), panel, row?.runId ?? null);
  }
  return header;
}

/**
 * Step: a label/value table — Status, Pool, Purpose, Route, Time — then the
 * budget, the first lines of the task, the output so far and the artifacts.
 */
function stepPage(model, opts, body) {
  const { width, spinnerFrame, nowMs, narrow } = opts;
  const panel = workflowPanelModel(model.row, { phaseIndex: opts.phaseIndex, agentIndex: opts.agentIndex });
  const state = panel.state;
  const agent = panel.selectedAgent;
  const shortId = state.shortId ?? model.row?.shortId ?? '';
  if (!agent) {
    body.push(dimText(' no step selected in this phase', width));
    for (const line of agentDetailLines(panel, Math.max(20, width - 2), spinnerFrame)) body.push(` ${cut(line, width - 1)}`);
    return truncate(` ${statusIcon('pending', spinnerFrame)} no step selected · run ${shortId}`, width);
  }
  const { action, attempt, active } = agent;
  const routing = attempt?.routing ?? active?.routing ?? null;
  const reasoning = reasoningText(attempt) || reasoningText(active);
  const labelWidth = narrow ? 10 : 10;
  const field = (name, value) => body.push(cut(` ${String(name).padEnd(labelWidth)}${value}`, width));

  const assignment = (model.assignments ?? []).find((entry) => entry.runId === model.row?.runId && entry.actionId === action.id);
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedAt = attempt?.startedAt ?? active?.startedAt ?? action?.startedAt ?? null;
  const startedMs = Date.parse(startedAt ?? '');
  const ranFor = Number.isFinite(startedMs)
    ? durationText(startedAt, attempt?.finishedAt)
    : null;

  field('Status', `${tint(agent.status, agent.status === 'running' ? 'cyan' : agent.status === 'succeeded' ? 'green' : 'dim')} · ${tint(agent.model, 'cyan')}${reasoning ? ` · ${reasoning}` : ''}`);
  // V1 stores the tier on the attempt, V2 under routing; reading only the V1
  // shape made every V2 attempt read `effort auto` beside its resolved level.
  field('Pool', `${tint(agent.pool, 'cyan')} · attempt ${attempt?.attemptNumber ?? active?.attempt ?? 1} · effort ${attempt?.effort ?? routing?.effort ?? active?.effort ?? 'auto'}${reasoning ? ` · reasoning ${reasoning}` : ''}`);
  field('Purpose', dimText(String(action.purpose ?? actionRoleLabel(action)), width - labelWidth - 1));
  if (routing?.reason) {
    const text = `${routing.lane ? `${routing.lane} lane → ` : ''}${agent.pool}: ${routing.reason}`;
    const wrapped = wrapLines([text], Math.max(10, width - labelWidth - 2));
    field('Route', dimText(wrapped[0] ?? '', width));
    for (const line of wrapped.slice(1, narrow ? 2 : 3)) {
      body.push(dimText(cut(` ${' '.repeat(labelWidth)}${line}`, width), width + 8));
    }
  }
  field('Time', dimText(`${startedAt ? `started ${clockText(startedAt)}` : 'not started'}${ranFor && ranFor !== 'time pending' ? ` · elapsed ${ranFor}` : ''}${expected == null ? ` · no expected duration recorded` : ` of ${minutesText(expected)} expected`}`, width));
  if (attempt?.failureReason) field('Failure', cut(String(attempt.failureReason), width - labelWidth - 1));
  if (active?.stall?.status === 'suspected_stalled') {
    field('Stall', `${glyphs().warn} ${active.stall.silentForSec}s without evidence; never auto-killed`);
  }

  // The budget for this one attempt: a licence share only where the pool has
  // a measured rate, and the estimate only where the attempt recorded one.
  body.push('');
  body.push(rule('budget', null, width));
  const pool = runEconomics(model.row, model.pools, nowMs).pools.find((entry) => entry.name === agent.pool) ?? null;
  const attemptCost = finiteOrNull(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd);
  const money = moneyText(attempt?.usage ?? { apiUsd: attemptCost, tokenSource: attempt?.usage?.tokenSource });
  if (pool?.usedPct == null) {
    // Requirement 8: no page draws an empty track for missing data. An
    // unmetered pool is a line of words here, the same words the Run page
    // uses, with whatever this attempt did record beside them.
    const reason = `free model · no licence meter · ${money}`;
    body.row(
      cut(` ${absentLine(String(agent.pool), reason, { width: width - 1 })}`, width + 8),
      { kind: 'page', page: 'budget', pool: agent.pool },
    );
  } else {
    // Whole percents, as the Run page writes them: a share under 1% keeps one
    // decimal so a real sliver is not rounded away to `0%`.
    const percent = pool.sharePct == null ? null
      : pool.sharePct > 0 && pool.sharePct < 1 ? pool.sharePct.toFixed(1) : String(Math.round(pool.sharePct));
    const window = pool.window === 'monthly' ? 'monthly' : pool.window === 'five_hour' ? 'five-hour' : 'weekly';
    const share = percent == null ? blank() : `${about()} ${percent}% of its ${window} window`;
    const name = cut(String(agent.pool), 14).padEnd(Math.min(14, String(agent.pool).length));
    const bars = Math.max(4, Math.min(32, width - visibleLength(name) - visibleLength(share) - visibleLength(money ?? '') - 12));
    const bar = meterBar(pool.usedPct, pool.elapsedPct, bars, { ansi: meterAnsi() });
    body.row(
      cut(` ${name} ${bar}  ${tint(share, 'purple')} · ${tint(money, 'purple')}`, width),
      { kind: 'page', page: 'budget', pool: agent.pool },
    );
    // Each blank above says which measurement it is waiting for, on one row.
    const why = [
      pool.sharePct == null ? `no measured %/minute rate for ${agent.pool}` : null,
      attemptCost == null ? 'cost unknown' : null,
    ].filter(Boolean);
    if (why.length) body.push(dimText(cut(` ${blank()} ${why.join(' · ')}`, width), width + 8));
  }

  const taskFile = attempt?.taskFile ?? active?.taskFile ?? null;
  const prompt = wrapLines(taskPreview(taskFile, Infinity), width - 4);
  const taskRows = narrow ? 4 : 2;
  body.push('');
  body.push(rule('task · first lines', null, width));
  if (!prompt.length) body.push(dimText('   no task file was recorded for this attempt', width));
  for (const line of prompt.slice(0, taskRows)) body.push(cut(`   ${line}`, width));
  if (prompt.length > taskRows) body.push(dimText(`   … ${prompt.length - taskRows} more lines`, width));

  const output = state.outputs?.[action.id];
  const outFile = attempt?.outFile ?? active?.outFile ?? output?.outFile ?? null;
  const outcome = outcomePreview(outFile, output);
  const bytes = finiteOrNull(active?.outputBytesObserved ?? attempt?.outputBytesObserved);
  const live = agent.status === 'running' ? 'live' : 'recorded';
  body.push('');
  body.push(rule('output', `${live} · ${bytes == null ? blank() : formatBytes(bytes)}`, width));
  if (!outcome.length) body.push(dimText('   nothing has been written to the output file yet', width));
  const outRows = narrow ? 6 : 10;
  for (const line of wrapLines(outcome.slice(0, outRows), width - 4)) body.push(cut(`   ${line}`, width));

  body.push('');
  body.push(rule('artifacts', null, width));
  body.push(dimText(cut(`   task:   ${taskFile ?? blank()}`, width), width + 8));
  body.push(dimText(cut(`   output: ${outFile ?? blank()}`, width), width + 8));

  const headerSpark = agent.status === 'running'
    ? outputSparkline(attempt ?? active, model.row?.runDir, 10)
    : '';
  return truncate(` ${statusIcon(agent.status, spinnerFrame)} ${action.id} · run ${shortId} · ${agent.status}${headerSpark ? ` · output ${headerSpark}` : ''}`, width);
}

/** A compact detail view for one standalone `bullswarm run` task. */
function taskPage(model, opts, body) {
  const { width } = opts;
  const task = model.task;
  if (!task) {
    body.push(dimText(' no task selected', width));
    return ' task';
  }
  const result = task.ok === true ? 'ok' : task.ok === false
    ? String(task.reason ?? 'failed').replace(/\s+/g, ' ')
    : 'result unavailable';
  const reason = task.reason == null ? (task.ok === true ? 'none recorded' : 'not recorded')
    : String(task.reason).replace(/\s+/g, ' ');
  const duration = task.durationMs == null ? 'duration unavailable' : formatDashboardValue(task.durationMs / 60_000, 'minutes') ?? 'duration unavailable';
  body.push(rule('task', null, width));
  body.push(cut(` lane    ${task.lane ?? blank()}`, width));
  body.push(cut(` pool    ${taskPoolModelText(task)}`, width));
  body.push(cut(` project ${task.project ?? blank()}`, width));
  body.push(cut(` result  ${result}`, width));
  body.push(cut(` time    ${duration} · ${task.endedAt ?? task.startedAt ?? blank()}`, width));
  body.push('');
  body.push(rule('artifacts', null, width));
  body.push(dimText(cut(` task:   ${task.taskFile ?? blank()}`, width), width));
  body.push(dimText(cut(` output: ${task.outFile ?? task.outputFile ?? blank()}`, width), width));
  body.push(dimText(cut(` reason:  ${reason}`, width), width));
  return ` task · ${taskIdText(task)} · ${result}`;
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
  pushView(body, budgetLines(model.budget, { width, ansi: meterAnsi() }));
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
  else if (page === 'step') header = stepPage(model, { ...opts, bodyHeight }, body);
  else if (page === 'task') header = taskPage(model, { ...opts, bodyHeight }, body);
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
  nav.parts(navParts(model, { page, width, selectedRunId: opts.selectedRunId ?? model.row?.runId ?? null }));
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
  metric = 'runs', meterHistory = null, tasks = null, task = null,
} = {}) {
  const pools = usage?.pools ?? [];
  const records = rollups ?? [];
  const model = {
    row: row ?? null,
    task: task ?? null,
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
      ui.focus = 1;
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
  // on. The timeline counts rows back from its newest event, a page body
  // counts the first visible row.
  const scrollActivePage = (delta) => {
    if (ui.page === 'run' && ui.focus === 0 && !ui.orchestratorDetail && !ui.workflowVerbose) {
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
        ui.focus = 1;
        ui.followActiveAgent = true;
        ui.detailScroll = 0;
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
    if (keyPressed('fleet', key)) return openPage('fleet');
    if (keyPressed('period', key)) return nextPeriod();
    if (keyPressed('nextTab', key)) return nextTab();
    if (keyPressed('cycleWorkflow', key)) return switchWorkflow(1);
    if (keyPressed('top', key)) { bodyScroll = 0; ui.detailScroll = 0; return paint(); }
    if (keyPressed('end', key)) return scrollToEnd();
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
    const timelineScroll = runPageOpen && ui.focus === 0 && !ui.orchestratorDetail && !ui.workflowVerbose;
    if (keyPressed('pageUp', key)) {
      if (timelineScroll) { ui.timelineSelection = null; ui.detailScroll += 8; return paint(); }
      if (runPageOpen) ui.detailScroll = Math.max(0, ui.detailScroll - 8);
      else bodyScroll = Math.max(0, bodyScroll - 8);
      return paint();
    }
    if (keyPressed('pageDown', key)) {
      if (timelineScroll) { ui.timelineSelection = null; ui.detailScroll = Math.max(0, ui.detailScroll - 8); return paint(); }
      if (runPageOpen) ui.detailScroll += 8;
      else { bodyScroll += 8; loadMoreHistory(); }
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
