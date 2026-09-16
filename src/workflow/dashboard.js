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
import { loadUsage, parseMouse } from './usage-view.js';
// The 0.33.0 pages: the render kit, the two aggregation models, and the four
// view modules each territory owns. The shell composes them and owns no
// arithmetic of its own beyond laying the lines out.
import { cut, formatDashboardValue, periodToggle, progressBar, rule, shareBar, sparkline, tabsRow } from './dash-kit.js';
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

/** Read the retained per-pool meter log into one real row per local day. */
export function readLicencePerDay(bullswarmDir, pools, { period = '7d', now = Date.now(), rollups = [] } = {}) {
  const enabled = (Array.isArray(pools) ? pools : []).filter((pool) => pool?.name && pool.enabled !== false);
  const histories = enabled.map((pool) => ({ pool, days: readMeterHistoryDays(pool.name, { dir: join(bullswarmDir, 'meters') }) }));
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
    for (const { pool, days } of histories) {
      const samples = days[date] ?? [];
      const sample = samples.at(-1);
      if (!sample) continue;
      const preferred = pool.pacingWindow === 'monthly' ? 'monthly'
        : pool.pacingWindow === 'five_hour' ? 'five_hour' : 'weekly';
      const window = sample[preferred] ?? sample.weekly ?? sample.monthly ?? sample.five_hour;
      const value = finiteOrNull(window?.utilization);
      if (value != null) segments.push({ name: pool.name, value });
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
  runs: keyRow('r', 'Runs', ['r']),
  budget: keyRow('b', 'Budget', ['b']),
  stats: keyRow('s', 'Stats', ['s']),
  history: keyRow('y', 'History', ['y']),
  fleet: keyRow('f', 'Fleet', ['f']),
  help: keyRow('h/?', 'Help', ['h', '?']),
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
  const cost = usage.cost?.estimatedUsd != null
    ? `cost≈$${usage.cost.estimatedUsd}`
    : usage.cost?.knownSubtotalUsd != null
      ? `cost≥$${usage.cost.knownSubtotalUsd} (partial)` : 'cost=?';
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
    if (narrow) {
      const inner = Math.max(1, width - 4);
      return {
        selected: selectedRow,
        lines: [
          selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, inner),
          selectLine(`  ${progress} · ${elapsed}`, selectedRow, false, inner),
          selectLine(`  ${phase} · ${status}`, selectedRow, false, inner),
          '',
        ],
      };
    }
    return {
      selected: selectedRow,
      lines: [
        selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, 44),
        selectLine(`  ${progress} · ${elapsed} · ${status}`, selectedRow, false, 44),
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

function workflowTimelineLines(model, width, spinnerFrame = 0) {
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
  add(state.lifecycle.startedAt, `${glyphs().ongoing} Goal accepted`, '', [
    ...goalLines,
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
// The paged dashboard: Home, Runs, Run, Step, Budget, Stats, History, Fleet
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
const DASHBOARD_PAGES = Object.freeze(['home', 'runs', 'run', 'step', 'budget', 'stats', 'history', 'fleet', 'help']);
/** The tab row above the body; `key` is the key that opens the page. */
const PAGE_TABS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', key: null }),
  Object.freeze({ id: 'runs', label: 'Runs', key: 'r' }),
  Object.freeze({ id: 'budget', label: 'Budget', key: 'b' }),
  Object.freeze({ id: 'stats', label: 'Stats', key: 's' }),
  Object.freeze({ id: 'history', label: 'History', key: 'y' }),
  Object.freeze({ id: 'fleet', label: 'Fleet', key: 'f' }),
  Object.freeze({ id: 'help', label: 'Help', key: 'h' }),
]);
/** Run and Step are read as Runs: the tab row marks the page they came from. */
const TAB_OF_PAGE = Object.freeze({ run: 'runs', step: 'runs' });
/** The period toggle, in the order `p` cycles it. */
const PERIOD_ITEMS = Object.freeze([
  Object.freeze({ id: '7d', label: 'Last 7 days' }),
  Object.freeze({ id: '30d', label: 'Last 30 days' }),
  Object.freeze({ id: 'all', label: 'All time' }),
]);
/** Stats' sub-tabs and Fleet's, in the order Tab cycles them. */
const STATS_TABS = Object.freeze(['overview', 'trends', 'pools', 'models', 'projects']);
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

/**
 * Money, always as the estimate it is. `estimateInvocationUsage` prices the
 * task and output text at API rates with no cache split, so every `$` on this
 * dashboard is an API-equivalent estimate and says so; an amount nobody
 * recorded is null, and the caller paints a blank with the reason.
 */
function moneyText(value) {
  const text = formatDashboardValue(value, 'money');
  return text == null ? null : `${about()} ${text}`;
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
 * read, and Help only ever appears while it is.
 */
function pageTabs(page, width) {
  const active = TAB_OF_PAGE[page] ?? page;
  const hidden = ['help'];
  if (width < 100) hidden.push('fleet');
  return tabsRow(PAGE_TABS, { active, width, hidden });
}

/**
 * The bottom nav: one button per ongoing run, then the page's tail.
 *
 * A run's digit sits inside its button (`[ 1.aaa111 ]`) and a label's key
 * letter is underlined, so the keys read off the nav. Below 100 columns the
 * tail is the phone layout's `[Top] [End] [Help]`; the run buttons keep the
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
  const back = page === 'step' ? [{ key: null, label: 'back', action: { kind: 'back' } }] : [];
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
      { key: 'h', label: 'Help', tight: true, mark: page === 'help', action: { kind: 'page', page: 'help' } },
    ]
    : [
      { key: 'h', label: 'help', mark: page === 'help', action: { kind: 'page', page: 'help' } },
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
  const levels = planLevels(row);
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
  for (const action of remaining) {
    const assignment = assignments.find((entry) => entry.runId === row?.runId && entry.actionId === action.id);
    const expected = finiteOrNull(assignment?.expectedMinutes);
    if (expected == null) continue;
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
  const attempts = row?.state?.attempts ?? [];
  const byPool = new Map();
  let apiEquivalentUsd = null;
  let priced = 0;
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
    const cost = finiteOrNull(attempt?.usage?.cost?.estimatedUsd);
    if (cost != null) { apiEquivalentUsd = (apiEquivalentUsd ?? 0) + cost; priced += 1; }
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
  return { pools: rows, apiEquivalentUsd, pricedAttempts: priced, attempts: attempts.length };
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

/**
 * Home: today's four tiles, the period's breakdown by pool, model and
 * project, the runs in flight, and the recent list.
 */
function homePage(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  const stats = model.stats;
  const overview = stats?.overview ?? null;
  const today = overview?.today ?? null;
  const licence = today?.licence ?? null;
  const sparks = stats?.sparklines ?? {};
  const sparkWidth = narrow ? 7 : 7;

  body.push(rule(`today · ${today?.date ?? '—'}`, null, width));
  const tiles = [
    {
      key: 'finished',
      label: 'finished',
      value: today ? String(today.finished) : blank(),
      spark: sparkline(sparks.runs ?? [], sparkWidth),
      note: today ? `${today.verified} verified · ${model.runs.length} in flight` : 'no index yet',
      action: { kind: 'trend', metric: 'runs' },
    },
    {
      key: 'verified',
      label: 'verified',
      value: shareText(today?.verifiedShare) ?? blank(),
      spark: sparkline(sparks.verified ?? [], sparkWidth),
      note: today?.verifiedShare == null
        ? 'no run finished today'
        : `${today.verified} of ${today.finished} today`,
      action: { kind: 'trend', metric: 'verified' },
    },
    {
      key: 'spend',
      label: 'spent',
      value: moneyText(today?.apiEquivalentUsd) ?? blank(),
      spark: sparkline(sparks.spend ?? [], sparkWidth),
      note: today?.apiEquivalentUsd == null
        ? 'no finished run recorded an estimate'
        : `API-equivalent · ${today.pricedRuns} of ${today.finished} priced`,
      action: { kind: 'trend', metric: 'spend' },
    },
    {
      key: 'licence',
      label: 'licence',
      value: licence?.maxUsedPct == null
        ? blank()
        : `${licence.maxPool} ${percentText(licence.maxUsedPct)}`,
      spark: '',
      note: licence?.maxUsedPct == null
        ? String(licence?.basis ?? 'no pool reported a licence meter')
        : `busiest of ${licence.metered} metered pool${licence.metered === 1 ? '' : 's'}`,
      action: { kind: 'tab', tab: 'pools' },
    },
  ];

  const columns = narrow ? 1 : Math.max(1, Math.min(4, Math.floor((width - 1) / 28)));
  if (columns === 1) {
    for (const tile of tiles) {
      const label = ` ${tile.label.padEnd(9)}`;
      body.parts([
        { text: label },
        { text: tileText(tile, width - visibleLength(label)), action: tile.action },
      ]);
      body.push(dimText(`   ${cut(tile.note, width - 4)}`, width));
    }
  } else {
    // Every column is the same `cell` columns wide, so the label, the number
    // and the note under it line up whatever each one says.
    const cell = Math.floor((width - 1) / columns);
    const pad = (text) => {
      const shown = cut(text, cell - 1);
      return `${shown}${' '.repeat(Math.max(0, cell - visibleLength(shown)))}`;
    };
    for (let start = 0; start < tiles.length; start += columns) {
      const group = tiles.slice(start, start + columns);
      body.push(dimText(` ${group.map((tile) => pad(tile.label)).join('')}`, width));
      const parts = [{ text: ' ' }];
      for (const tile of group) {
        const text = tileText(tile, cell - 1);
        parts.push({ text, action: tile.action });
        parts.push({ text: ' '.repeat(Math.max(0, cell - visibleLength(text))) });
      }
      body.parts(parts);
      body.push(dimText(` ${group.map((tile) => pad(tile.note)).join('')}`, width));
    }
  }
  body.push(dimText(' click a tile for its chart in Stats', width));
  if (today?.basis) body.push(dimText(` ${cut(`money: ${today.basis}`, width - 2)}`, width));

  // The runs in flight are always visible, whatever else the page carries.
  body.push('');
  body.push(rule('running', null, width));
  if (!model.runs.length) {
    body.push(dimText(' nothing in flight · bullswarm workflow goal "<goal>" launches one', width));
  }
  model.runs.forEach((run, index) => {
    const progress = planProgress(run, { assignments: model.assignments, nowMs });
    const right = `${progress.phases ? `phase ${progress.phase} of ${progress.phases} · ` : ''}${progress.done}/${progress.total} steps${progress.eta ? ` · ETA ${progress.eta}` : ''}`;
    const label = ` ${glyphs().ongoing} ${index < 9 ? `${index + 1}.` : ''}${run.shortId ?? run.runId}`;
    const title = `  ${cut(workflowRunLabel(run), Math.max(8, width - visibleLength(label) - visibleLength(right) - 4))}`;
    const head = `${label}${title}`;
    body.parts([
      { text: head, action: { kind: 'run', runId: run.runId } },
      { text: ' '.repeat(Math.max(1, width - visibleLength(head) - visibleLength(right) - 1)) },
      { text: dimText(right, width) },
    ]);
    body.parts([{ text: '   ' }, ...planStripParts(run, { runId: run.runId })]);
    const live = (run.state?.actions ?? []).filter((action) => action.status === 'running');
    for (const action of live) {
      const assignment = model.assignments.find((entry) => entry.runId === run.runId && entry.actionId === action.id);
      const text = `   ${stepProgressText(action, assignment, { width, nowMs })}`;
      body.row(cut(text, width), { kind: 'step', runId: run.runId, actionId: action.id });
    }
    const economics = runEconomics(run, model.pools, nowMs);
    const draw = economics.pools.map((pool) => (pool.sharePct == null
      ? `${pool.name} ${blank()}`
      : `${pool.name} ${about()} ${formatDashboardValue(pool.sharePct, 'percent')} of its ${pool.window ?? 'pacing'} window`)).join(' · ');
    const money = moneyText(economics.apiEquivalentUsd);
    const spent = money ? `${money} API-equivalent estimate` : `${blank()} no attempt recorded an estimate`;
    body.push(dimText(cut(`   ${draw ? `${draw} · ` : ''}${spent}`, width), width));
  });

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
  const breakdown = overview?.breakdown ?? { pools: [], models: [], projects: [] };
  const sections = [
    { key: 'pools', label: 'by pool', tab: 'pools' },
    { key: 'models', label: 'by model', tab: 'models' },
    { key: 'projects', label: 'by project', tab: 'projects' },
  ];
  let any = false;
  for (const section of sections) {
    const rows = (breakdown[section.key] ?? []).slice(0, narrow ? 3 : 4);
    if (!rows.length) continue;
    any = true;
    body.push(dimText(` ${section.label} · share is measured worker-minutes`, width));
    const label = narrow ? 12 : 22;
    const top = rows.reduce((most, row) => Math.max(most, finiteOrNull(row.minutes) ?? 0), 0);
    const barWidth = Math.max(4, width - label - 12);
    for (const row of rows) {
      const minutes = Math.max(0, finiteOrNull(row.minutes) ?? 0);
      const share = shareText(row.minutesShare);
      const bar = top > 0 ? progressBar(minutes / top, barWidth) : ' '.repeat(barWidth);
      const text = ` ${cut(String(row.name ?? '?'), label).padEnd(label)} ${bar} ${share ?? blank()}`;
      body.row(cut(text, width), { kind: 'tab', tab: section.tab });
    }
  }
  if (!any) {
    body.push(dimText(' no finished run in this period · bullswarm workflow reindex backfills older runs', width));
  }

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
    const ok = record.verified === true ? glyphs().ok : record.status === 'completed' ? glyphs().pending : glyphs().fail;
    const money = moneyText(recordCost(record));
    const right = `${minutesText(record.minutes?.wall) ?? blank()} · ${money ? `${money}` : blank()}  ${ageText(record.finishedAt, nowMs)} ago`;
    const left = ` ${ok} ${record.shortId ?? record.runId}  ${cut(`${record.project ?? '—'} · ${String(record.goal ?? '').split('\n')[0]}`, Math.max(6, width - visibleLength(right) - 14))}`;
    body.row(
      cut(`${left}${' '.repeat(Math.max(1, width - visibleLength(left) - visibleLength(right) - 1))}${right}`, width),
      { kind: 'run', runId: record.runId },
    );
  }
  return ' bullswarm · home';
}

/** The API-equivalent estimate a rollup record carries, over its pools. */
function recordCost(record) {
  const direct = finiteOrNull(record?.apiEquivalentUsd ?? record?.costUsd);
  if (direct != null) return direct;
  let total = null;
  for (const entry of Object.values(record?.pools ?? {})) {
    const value = finiteOrNull(entry?.costUsd);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

/** Runs: the list, the filter, the agent integration and the commands. */
function runsPage(model, opts, body) {
  const { width, narrow } = opts;
  const rows = opts.rows ?? [];
  const allRows = opts.allRows ?? rows;
  const active = allRows.filter((row) => row.ongoing).length;
  const waiting = allRows.filter((row) => isWaitingWorkflow(row.state)).length;
  const recent = Math.max(0, allRows.length - active);
  body.push(dimText(` Runs · ${opts.filter === 'all' ? 'all' : 'active'}${opts.query ? ` · filter “${opts.query}”` : ''} · ${active} active · ${waiting} waiting · ${recent} recent`, width));
  const selected = clamp(opts.selected ?? 0, 0, Math.max(0, rows.length - 1));
  if (!rows.length) {
    body.row(' No workflows in this view.');
    body.row(dimText(opts.filter === 'all'
      ? ' Start one with: bullswarm workflow goal "…"'
      : ' Press a to browse recent runs.', width));
  }
  if (rows.length) dashboardRunLines(rows, selected, narrow, width).forEach((group, index) => {
    const runId = rows[index]?.runId ?? null;
    group.lines.forEach((line, lineIndex) => {
      if (!line) { body.push(''); return; }
      body.row(line, lineIndex === 0 && runId ? { kind: 'run', runId } : null);
    });
  });

  body.push('');
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
  body.push(dimText(' run it', width));
  for (const command of DASHBOARD_COMMANDS) body.push(dimText(`   ${command}`, width));
  return ' bullswarm · runs';
}

/**
 * Run: the plan strip, the phase count and the ETA, the pool share and the
 * spend, then the timeline/Live/Next overview the viewer has always drawn.
 *
 * The overview panel below is what `bullswarm workflow tui <id> --overview`
 * prints and what the Claude mod's `parseOverview` reads, so its box borders,
 * its `── ` section prefixes and its `HH:MM ` milestones are untouched: every
 * line this function adds is painted above it, outside the box.
 */
function runPage(model, opts, body) {
  const { width, bodyHeight, nowMs } = opts;
  const row = model.row;
  const progress = planProgress(row, { assignments: model.assignments, nowMs });
  const head = frameBuilder();
  const eta = progress.eta
    ? `ETA ${progress.eta}`
    : progress.remaining
      ? `ETA ${blank()}`
      : null;
  const right = [
    progress.phases ? `phase ${progress.phase} of ${progress.phases}` : null,
    `${progress.done}/${progress.total} steps`,
    eta,
  ].filter(Boolean).join(' · ');
  head.push(rule('plan', right, width));
  // The strip, and beside it whatever is running, so the plan costs the
  // timeline below it as few rows as it can.
  const strip = planStripParts(row, { runId: row?.runId ?? null });
  const live = (row?.state?.actions ?? []).filter((entry) => entry.status === 'running');
  const stripWidth = strip.reduce((sum, part) => sum + visibleLength(part.text), 0);
  const liveTexts = live.map((action) => ({
    action,
    text: stepProgressText(
      action,
      (model.assignments ?? []).find((entry) => entry.runId === row?.runId && entry.actionId === action.id),
      { width, nowMs },
    ),
  }));
  const inline = liveTexts.length === 1 && stripWidth + visibleLength(liveTexts[0].text) + 6 <= width;
  head.parts(inline
    ? [{ text: '  ' }, ...strip, { text: '  ' }, {
      text: liveTexts[0].text,
      action: { kind: 'step', actionId: liveTexts[0].action.id },
    }]
    : [{ text: '  ' }, ...strip]);
  if (!inline) {
    for (const entry of liveTexts) {
      head.row(cut(`  ${entry.text}`, width), { kind: 'step', actionId: entry.action.id });
    }
  }
  if (!progress.eta && progress.remaining) {
    const reason = `${progress.remaining - progress.measuredRemaining} of ${progress.remaining} remaining steps recorded no expected duration`;
    head.push(dimText(cut(`  ${reason}`, width), width));
  }

  const economics = runEconomics(row, model.pools, nowMs);
  const money = moneyText(economics.apiEquivalentUsd);
  const spent = money
    ? `${money} API-equivalent estimate · ${economics.pricedAttempts} of ${economics.attempts} attempts priced`
    : `spend ${blank()} · no attempt recorded an API-equivalent estimate`;
  head.push(rule('budget', spent, width));
  if (!economics.pools.length) {
    head.push(dimText(' no attempt has recorded a pool yet', width));
  }
  const nameWidth = economics.pools.reduce((most, pool) => Math.max(most, String(pool.name).length), 0);
  const barWidth = Math.max(4, Math.min(24, width - nameWidth - 46));
  for (const pool of economics.pools) {
    const bar = pool.sharePct == null || pool.usedPct == null
      ? ' '.repeat(barWidth)
      : shareBar([
        { value: Math.min(pool.sharePct, pool.usedPct) },
        { value: Math.max(0, pool.usedPct - pool.sharePct) },
        { value: Math.max(0, 100 - pool.usedPct) },
      ], { width: barWidth, colors: meterAnsi() });
    const share = pool.sharePct == null
      ? `${blank()} no measured %/minute rate for this pool`
      : `${about()} ${formatDashboardValue(pool.sharePct, 'percent')} of its ${pool.window ?? 'pacing'} window`;
    head.row(cut(` ${String(pool.name).padEnd(nameWidth)} ${bar}  ${share} · ${minutesText(pool.minutes)} measured`, width), { kind: 'page', page: 'budget' });
  }
  // The share bands only need naming where there is room to name them.
  if (Number(bodyHeight) >= 30 && economics.pools.some((pool) => pool.sharePct != null)) {
    const [mine, rest, free] = asciiGlyphsPreferred() ? ['#', '.', '|'] : ['▓', '▒', '░'];
    head.push(dimText(cut(` ${mine} this run · ${rest} the rest of the window · ${free} unused · share is the pool's measured %/minute × this run's minutes`, width), width));
  }

  const frame = runFrame(model.row, {
    ...opts,
    focus: opts.focus === 1 ? 1 : 0,
    bodyHeight: Math.max(6, bodyHeight - head.lines.length),
  });
  const { state, status, elapsed, terminalLabel } = frame;
  drawWindow(body, head, windowOf(head, { height: head.lines.length }));
  for (const line of frame.body) body.push(line);
  markStepRows(body, frame.body, frame.model);
  const shortId = state.shortId ?? model.row?.shortId ?? model.row?.runId ?? '------';
  const done = (state.actions ?? []).filter((action) => action.status === 'succeeded').length;
  const total = (state.actions ?? []).length;
  const age = elapsed && elapsed !== 'time pending' ? ` · ${elapsed}` : '';
  return truncate(` ${shortId} ${status}${age} · ${done}/${total} actions${terminalLabel}`, width);
}

/** Step: the agent panel the viewer always drew, with `[back]` in the nav. */
function stepPage(model, opts, body) {
  const { width, spinnerFrame, nowMs } = opts;
  const frame = runFrame(model.row, { ...opts, focus: 2 });
  const state = frame.model.state;
  const agent = frame.model.selectedAgent;
  const shortId = state.shortId ?? model.row?.shortId ?? '';
  const action = (state.actions ?? []).find((entry) => entry.id === agent?.action?.id) ?? null;
  if (action) {
    const assignment = (model.assignments ?? []).find((entry) => entry.runId === model.row?.runId && entry.actionId === action.id);
    body.push(action.status === 'running'
      ? cut(` ${stepProgressText(action, assignment, { width, nowMs })}`, width)
      : dimText(cut(` ${action.id} · ${action.status}`, width), width));
    const pool = agent?.pool ?? null;
    const economics = runEconomics(model.row, model.pools, nowMs).pools.find((entry) => entry.name === pool) ?? null;
    const money = moneyText(finiteOrNull(agent?.attempt?.usage?.cost?.estimatedUsd));
    body.push(dimText(cut(` ${pool ?? 'pool pending'} · ${economics?.sharePct == null
      ? `${blank()} no measured %/minute rate`
      : `${about()} ${formatDashboardValue(economics.sharePct, 'percent')} of its ${economics.window ?? 'pacing'} window for the whole run`} · ${money ? `${money} API-equivalent estimate` : `${blank()} this attempt recorded no estimate`}`, width), width));
    body.push('');
  }
  for (const line of frame.body) body.push(line);
  markStepRows(body, frame.body, frame.model);
  const label = agent
    ? `${statusIcon(agent.status, spinnerFrame)} ${agent.action.id} · run ${shortId}`
    : `${statusIcon('pending', spinnerFrame)} no step selected · run ${shortId}`;
  return truncate(` ${label}`, width);
}

/** Budget: every pool's licence meter, its money and what still fits. */
function budgetPage(model, opts, body) {
  const { width } = opts;
  if (!model.budget) {
    body.push(dimText(' reading the pool meters…', width));
    if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
    return ` Budget · this week${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
  }
  pushView(body, budgetLines(model.budget, { width, ansi: meterAnsi() }));
  if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
  return ` Budget · ${model.budget.days ?? 7} days to ${model.budget.timeZone ?? 'local'}${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
}

/** Fleet: the rungs by lane or by provider, read-only. */
function fleetPage(model, opts, body) {
  const { width } = opts;
  const by = FLEET_TABS.includes(opts.fleetBy) ? opts.fleetBy : 'lane';
  const view = fleetLines(model.pools, model.rungs, { width, by, nowMs: opts.nowMs, ansi: meterAnsi() });
  const before = body.lines.length;
  pushView(body, view);
  // fleet-view paints its own `[● by lane] [by provider]` tabs as text; the
  // shell makes them the same click Tab is.
  for (let index = before; index < body.lines.length; index += 1) {
    const plain = String(body.lines[index]).replace(ANSI_SGR, '');
    for (const [needle, id] of [['by lane]', 'lane'], ['by provider]', 'provider']]) {
      const at = plain.indexOf(needle);
      const start = at < 0 ? -1 : plain.lastIndexOf('[', at);
      if (start >= 0) {
        body.regions.push({ x1: start + 1, x2: at + needle.length, y: index + 1, action: { kind: 'tab', tab: id } });
        body.anchor = { tabs: index + 1 };
      }
    }
  }
  return ` Fleet · by ${by}`;
}

/** Stats: the five tabs, the four metrics and the three periods. */
function statsPage(model, opts, body) {
  const { width } = opts;
  const tab = STATS_TABS.includes(opts.statsTab) ? opts.statsTab : 'overview';
  const metric = TREND_METRICS.includes(opts.metric) ? opts.metric : 'runs';
  if (!model.stats) {
    body.push(dimText(' reading the rollup index…', width));
    return ' Stats';
  }
  pushView(body, statsLines(model.stats, {
    width, tab, period: opts.period, metric, ansi: meterAnsi(),
  }));
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
  for (const line of historyNote(model.days ?? [], { width })) notes.push(dimText(line, width));
}

/** Help: every key and every click, in rows that fit 55 columns. */
function helpPage(model, opts, body) {
  const { width } = opts;
  const keyWidth = width < 60 ? 11 : 16;
  const row = (keys, text) => body.push(truncate(` ${String(keys).padEnd(keyWidth)}${text}`, width));
  const named = (name, text) => row(DASHBOARD_KEYS[name].keys, text ?? DASHBOARD_KEYS[name].label);

  body.push(rule('pages', null, width));
  named('runs', 'Runs · every workflow');
  named('budget', 'Budget · licence and money');
  named('stats', 'Stats · charts');
  named('history', 'History · by date');
  named('fleet', 'Fleet · the rungs');
  named('help', 'this help');
  named('openRun', 'open that run from the nav');
  named('in', 'open the run, its steps, then one step');
  named('out', 'back one page, then Home');
  body.push('');
  body.push(rule('inside a page', null, width));
  named('nextTab', 'Stats and Fleet sub-tabs');
  named('cycleWorkflow', 'cycle workflows');
  named('period', '7 days · 30 days · all time');
  named('up', 'scroll one line');
  named('down', 'scroll one line');
  named('pageUp', 'a screen');
  named('pageDown', 'a screen');
  named('top', 'top of the page');
  named('end', 'bottom of the page');
  row('wheel', 'scrolls under the sticky header');
  body.push('');
  body.push(rule('clicks', null, width));
  row('tab', 'the tab row opens that page');
  row('tile', "today's number opens its chart");
  row('bar', 'a breakdown bar opens its Stats tab');
  row('trend bar', 'a Trends column opens History at its day');
  row('pool bar', 'a Pools meter opens Budget on that pool');
  row('model/project', 'a Models/Projects row opens History');
  row('period', 'the toggle sets the period');
  row('run', 'a run row or nav button opens it');
  row('step', 'a plan glyph or step row opens it');
  row('day', 'a History row opens that run');
  body.push('');
  body.push(rule('other', null, width));
  named('copy', 'copy the screen · OSC 52, else pbcopy/wl-copy');
  row('c · y', 'stop this workflow · y confirms it');
  row('e', 'edit the fleet (on Fleet)');
  row('/ · a · i', 'filter · active/all · install (on Runs)');
  row('o · v · t', 'planner · technical · phases (on Run)');
  named('detach', 'quit; the workflows keep running');
  body.push('');
  body.push(rule('layout', null, width));
  row('under 100', 'Fleet leaves the tab row until f opens it');
  row('under 100', 'the nav tail is [Top] [End] [Help]');
  row('rebound', 'r was refresh · b was back · Tab was workflows');
  body.push('');
  body.push(dimText(' the commands that operate the product', width));
  for (const command of DASHBOARD_COMMANDS) body.push(dimText(`   ${command}`, width));
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
    statsTab: STATS_TABS.includes(options.statsTab) ? options.statsTab : 'overview',
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
  if (page === 'history') historyPageNotes(model, opts, notes);
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
  } else if (page === 'home') header = homePage(model, opts, body);
  else if (page === 'runs') header = runsPage(model, opts, body);
  else if (page === 'budget') header = budgetPage(model, opts, body);
  else if (page === 'stats') header = statsPage(model, opts, body);
  else if (page === 'history') header = historyPage(model, opts, body);
  else if (page === 'fleet') header = fleetPage(model, opts, body);
  else if (page === 'help') header = helpPage(model, opts, body);
  else if (page === 'step') header = stepPage(model, { ...opts, bodyHeight }, body);
  else header = runPage(model, { ...opts, bodyHeight }, body);

  const frame = frameBuilder();
  frame.kit(pageTabs(page, width));
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
  metric = 'runs', meterHistory = null,
} = {}) {
  const pools = usage?.pools ?? [];
  const records = rollups ?? [];
  const model = {
    row: row ?? null,
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
    const budget = budgetModel(pools, { rollups: records, prices, period: budgetPeriod, now: nowMs });
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
  const ui = {
    page: token ? 'run' : 'home',
    focus: 0,
    period: '7d',
    statsTab: 'overview',
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
    try { days = historyDays(bullswarmDir, { days: ui.historyDays }); } catch { days = []; }
  };
  /** The declared subscription prices: the operator's, else the table's. */
  const readPrices = () => {
    try { prices = { subscriptions: loadState(bullswarmDir)?.strategy?.subscriptions ?? {} }; }
    catch { prices = { subscriptions: {} }; }
  };
  // The pools, the ledger and the rungs are read off disk (live meter reads
  // included), so the read lands after the frame it was asked for: the frame
  // paints at once and repaints when the data arrives. A later read wins.
  let usageTicket = 0;
  const readUsage = () => {
    const ticket = (usageTicket += 1);
    return loadUsage(bullswarmDir).then((loaded) => {
      if (ticket !== usageTicket) return undefined;
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
    const frame = `${ESC}H${lines.map((line) => `${line}${ESC}K`).join('\n')}`;
    if (frame === lastPaintedFrame) return;
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
    try { catalog = dashboardRows(bullswarmDir, { all: true }); }
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
    selectedRunId, message, bodyScroll,
    period: ui.period, statsTab: ui.statsTab, metric: ui.metric, fleetBy: ui.fleetBy,
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
          runs: activeRuns, usage, integration, rollups, days, prices,
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
  const refresh = () => {
    try {
      const previousRunId = selectedRunId;
      activeRuns = activeDashboardRows(bullswarmDir);
      readIndex();
      if (catalog) {
        catalog = dashboardRows(bullswarmDir, { all: true });
        allRows = catalog;
      } else allRows = activeRuns;
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      const preserved = rows.findIndex((row) => row.runId === previousRunId);
      if (preserved >= 0) selected = preserved;
      else selected = clamp(selected, 0, Math.max(0, rows.length - 1));
      readIntegration();
      void readUsage();
    } catch (err) { message = `display error: ${err.message}`; }
    selectedRunId = rows[selected]?.runId ?? selectedRunId;
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
  /** Opens a page, reading whatever that page needs the first time. */
  const openPage = (page, { pool = null } = {}) => {
    if (!DASHBOARD_PAGES.includes(page)) return paint();
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
    return paint();
  };
  /** Esc and the left arrow walk out: step to run, every other page to Home. */
  const moveOut = () => {
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
    if (ui.page !== 'history' || ui.historyDays >= MAX_HISTORY_DAYS) return;
    const body = lastFrameResult?.body;
    if (body && body.end < body.total - 2) return;
    ui.historyDays = Math.min(MAX_HISTORY_DAYS, ui.historyDays + 7);
    try { days = historyDays(bullswarmDir, { days: ui.historyDays }); } catch { /* keep what we have */ }
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
    else if (STATS_TABS.includes(tab)) { ui.page = 'stats'; ui.statsTab = tab; bodyScroll = 0; }
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
    output.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    try {
      await openSetup({ bullswarmDir, input, output });
    } catch (err) {
      message = `setup error: ${err.message}`;
    } finally {
      output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H${ESC}?1000h${ESC}?1006h`);
      input.setRawMode?.(true);
      input.resume?.();
      input.on('data', onData);
      output.on?.('resize', onResize);
      lastPaintedFrame = null;
      timer = setInterval(refresh, refreshMs);
      spinnerTimer = setInterval(spin, Math.max(50, Number(spinnerMs) || 400));
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
    ui.page = 'history';
    ui.budgetPool = null;
    ui.focus = 0;
    bodyScroll = 0;
    message = null;
    try { days = historyDays(bullswarmDir, { days: ui.historyDays }); }
    catch { days = []; }
    rollupFingerprint = null;
    if (target) {
      const rendered = historyLines(days, { width: frameWidth(), ansi: meterAnsi() });
      const label = historyDateLabel(target);
      const marker = label ? `── ${label} ` : null;
      const at = marker
        ? rendered.lines.findIndex((line) => String(line).replace(ANSI_SGR, '').startsWith(marker))
        : -1;
      if (at >= 0) bodyScroll = at;
      else message = `History bucket ${target} is outside loaded history.`;
    }
    return paint();
  };
  /** Every click runs the same action its key runs. */
  const runAction = (action) => {
    if (!action) return undefined;
    if (action.kind === 'page') return openPage(action.page, { pool: action.pool ?? null });
    if (action.kind === 'run') return openRun(action.runId);
    if (action.kind === 'step') return openStep(action.actionId, action.runId ?? null);
    if (action.kind === 'back') return moveOut();
    if (action.kind === 'install') return runInstall();
    if (action.kind === 'tab') return showTab(action.tab);
    if (action.kind === 'trend') {
      if (PERIODS.includes(action.period)) ui.period = action.period;
      if (action.bucket != null) return openTrendBucket(action);
      ui.page = 'stats';
      ui.statsTab = 'trends';
      if (TREND_METRICS.includes(action.metric)) ui.metric = action.metric;
      bodyScroll = 0;
      return paint();
    }
    if (action.kind === 'period') {
      if (PERIODS.includes(action.period)) ui.period = action.period;
      return paint();
    }
    if (action.kind === 'metric') {
      if (TREND_METRICS.includes(action.metric)) ui.metric = action.metric;
      return paint();
    }
    if (action.kind === 'top') { bodyScroll = 0; ui.detailScroll = 0; return paint(); }
    if (action.kind === 'end') return scrollToEnd();
    if (action.kind === 'edit') { void runEdit(); return undefined; }
    if (action.kind === 'quit') return finish();
    return undefined;
  };
  const handleMouse = (mouse) => {
    if (mouse.kind === 'wheel-up') return scrollActivePage(3);
    if (mouse.kind === 'wheel-down') return scrollActivePage(-3);
    if (mouse.kind !== 'press') return undefined;
    const action = regions.find((region) => mouse.y === region.y
      && mouse.x >= region.x1 && mouse.x <= region.x2)?.action;
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
    output.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    resolveDashboard?.(0);
  };
  const moveVertical = (delta) => {
    if (ui.page === 'runs') {
      selected = clamp(selected + delta, 0, Math.max(0, rows.length - 1));
      selectedRunId = rows[selected]?.runId ?? selectedRunId;
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
      selectedRunId = rows[selected]?.runId ?? activeRuns[0]?.runId ?? selectedRunId;
      if (!selectedRunId) {
        message = dashboardFilter === 'active'
          ? 'No active workflow selected · press a to browse recent runs.'
          : 'No workflow selected.';
        return paint();
      }
      return openRun(selectedRunId);
    }
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
      if (key === 'i') return runInstall();
    }
    if (/^[1-9]$/.test(key)) {
      const run = activeRuns[Number(key) - 1];
      if (run) return openRun(run.runId);
      message = `no run ${key} in flight`;
      return paint();
    }
    if (keyPressed('out', key)) return moveOut();
    if (keyPressed('in', key) || key === '\r' || key === '\n') return drillIn();
    if (keyPressed('up', key)) return moveVertical(-1);
    if (keyPressed('down', key)) return moveVertical(1);
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
  const onResize = () => paint();
  input.setRawMode?.(true);
  input.resume();
  // SGR mouse reporting travels with the alternate screen: on for the whole
  // session, off again in finish() and around the setup hand-off.
  output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H${ESC}?1000h${ESC}?1006h`);
  readIntegration();
  readIndex();
  readPrices();
  if (token) ensureCatalog();
  paint();
  let timer = setInterval(refresh, refreshMs);
  let spinnerTimer = setInterval(spin, Math.max(50, Number(spinnerMs) || 400));
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
