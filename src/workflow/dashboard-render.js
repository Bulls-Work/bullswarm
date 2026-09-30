// One frame of the paged dashboard (renderDashboardPage): Home, Runs, Run,
// Step, Budget, Stats, Fleet (History is the day table inside Runs) and Help.
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
import { legacyRunLine } from './short-id.js';
import { cut } from './dash-kit.js';
import { PERIODS, TREND_METRICS } from './stats-model.js';
import { budgetNotes } from './budget-view.js';
import { homePage } from './home-view.js';
import { runsPage } from './runs-view.js';
import { workflowPanelModel } from './run-model.js';
import { runPage } from './run-view.js';
import { stepPageModel } from './step-model.js';
import { taskStepModel } from './task-step.js';
import { renderStepPage } from './step-view.js';
import { dimText, truncate, visibleLength } from './dashboard-ansi.js';
import { frameBuilder, windowOf, drawWindow } from './dashboard-frame.js';
import { pageTabs, navParts } from './dashboard-nav.js';
import { budgetPage } from './dashboard-page-budget.js';
import { fleetPage } from './dashboard-page-fleet.js';
import { helpPage } from './dashboard-page-help.js';
import { historyPageNotes } from './dashboard-page-history.js';
import { statsPage } from './dashboard-page-stats.js';
import { DASHBOARD_PAGES, STATS_TABS, FLEET_TABS } from './dashboard-pages.js';

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
  // Rendering is the only dashboard boundary where ids become labels. Clone
  // the model so navigation/aggregation code sees a consistent name on every
  // page while the live and durable models retain their pool ids.
  const labels = new Map((model?.pools ?? [])
    .filter((pool) => pool?.name && pool?.poolLabel && pool.poolLabel !== pool.name)
    .map((pool) => [pool.name, pool.poolLabel]));
  if (labels.size) {
    const replace = (text) => {
      let out = String(text);
      for (const [pool, label] of [...labels].sort((a, b) => b[0].length - a[0].length)) {
        out = out.split(pool).join(label);
      }
      return out;
    };
    const visit = (value) => {
      if (typeof value === 'string') return labels.get(value) ?? replace(value);
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [labels.get(key) ?? key, visit(child)]));
    };
    model = visit(model);
  }
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
  frame.push(cut(`${header}${window.position}`, width));
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
