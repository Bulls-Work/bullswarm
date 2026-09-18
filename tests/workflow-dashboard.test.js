import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DASHBOARD_KEYS, activeDashboardRows, dashboardModel, dashboardRows, overviewSnapshot, readLicencePerDay, renderDashboard, renderDashboardPage, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, runDashboard, writeClipboard } from '../src/workflow/dashboard.js';
import { readRollups } from '../src/workflow/rollup.js';
import { SUBSTITUTED_GLYPHS } from '../src/lib/glyphs.js';
import { appendEvent, readEvents } from '../src/workflow/events.js';
import { cmdWorkflow } from '../src/workflow/cli.js';
import { createV2GoalDocument, createV2DurableState, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

// These tests assert the unicode presentation, so pin it: the glyph table
// otherwise follows the developer's terminal and would fall back to ascii
// when the suite runs inside Apple Terminal.
process.env.BULLSWARM_UNICODE = '1';
// BULLSWARM_ASCII outranks it, and it is the workaround the README hands
// an affected user, so a contributor may well have it in their shell.
delete process.env.BULLSWARM_ASCII;

function v2Actions() {
  return [
    { id: 'audit-files', purpose: 'Audit every file', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['audit.md'], prompt: 'Audit them.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['audit'] },
    { id: 'inspect-audit', purpose: 'Inspect the audit', dependsOn: ['audit-files'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['audit'], produces: [] },
  ];
}

function writeV2Run(home, {
  runId, shortId, goal, status = 'running', startedAt = new Date().toISOString(),
  finishedAt = null, live = false, running = false,
}) {
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const document = createV2GoalDocument({
    goal, cwd: home,
    requirements: [{ id: 'requirement-1', text: 'Every file is audited.', mandatory: true }],
    settings: { scout: false },
  });
  let state = createV2State(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Audit then inspect.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: v2Actions() },
  });
  // Accepting a program moves the lifecycle on, so the caller's status wins.
  state.lifecycle = { status, startedAt, finishedAt, resultFile: null };
  if (running) {
    Object.assign(state.actions[0], { status: 'running', startedAt, attempts: 1 });
    state.attempts.push({
      id: 'audit-files-1', actionId: 'audit-files', ordinal: 1, status: 'running',
      pool: 'planner-agent', model: 'planner-v1', startedAt, finishedAt: null,
      lastActivityAt: startedAt, outputBytesObserved: 42,
    });
  }
  // A live kernel pid is what makes a run read as ongoing.
  if (live) state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return { dir, state };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-'));
  writeV2Run(home, {
    runId: 'wf-test', shortId: 'abc234', goal: 'Audit every file autonomously.',
    live: true, running: true,
  });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function addHistoricalRun(home) {
  writeV2Run(home, {
    runId: 'wf-done', shortId: 'def345', goal: 'Audit documentation freshness.',
    status: 'completed', startedAt: '2026-08-30T01:00:00.000Z',
    finishedAt: '2026-08-30T01:05:00.000Z',
  });
}

function addV2HistoricalRun(home) {
  const dir = join(home, 'workflows', 'wf-v2-newer');
  mkdirSync(dir, { recursive: true });
  const goal = createV2GoalDocument({
    goal: 'Newer V2 dashboard run.',
    cwd: home,
    requirements: [{ id: 'inspect', text: 'Inspect the workflow.', mandatory: true }],
  });
  const state = createV2State(goal, { runId: 'wf-v2-newer', shortId: 'v2n456' });
  state.lifecycle = {
    status: 'completed',
    startedAt: '2026-08-30T02:00:00.000Z',
    finishedAt: '2026-08-30T02:05:00.000Z',
    resultFile: null,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Timeline redesign: the overview timeline groups events under phase segment
// headers shaped `── Implement ──────── 2m10s ──` instead of prefixing every
// event line with `[Phase: ...]`. A phase re-opened after another phase ran in
// between reads `── Implement · continued ── …`, and a viewport that starts mid
// segment re-emits that continuation header. The helpers below read the
// timeline pane structurally so the assertions never depend on dash padding,
// panel geometry, or the terminal width in use.
// ---------------------------------------------------------------------------

// 0.33.0 draws the timeline flat: a `── timeline ──` rule and the rows under
// it, one column in from the left margin, down to the sticky nav. The pane is
// still read structurally, so the assertions do not depend on dash padding or
// the terminal width in use.
function timelinePaneRows(screen) {
  const rows = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
  const top = rows.findIndex((line) => /^──+ timeline ──/.test(line.trimEnd()));
  if (top < 0) return [];
  const pane = [];
  for (const line of rows.slice(top + 1)) {
    if (/^\s*\[.+\]\s*$/.test(line)) break; // the sticky nav closes the page
    pane.push(line.replace(/^ /, '').trimEnd());
  }
  // The nav is sticky, so a short body is padded out to it; those blanks are
  // the frame's, not the timeline's.
  while (pane.length && !pane.at(-1).trim()) pane.pop();
  return pane;
}

function timelineSegments(screen) {
  const segments = [];
  for (const line of timelinePaneRows(screen)) {
    const header = /^─{2,}\s+(.+?)\s+─{2,}\s+(\S+)\s+─+$/.exec(line);
    if (header) segments.push({ label: header[1].replace(/^Phase \d+ · /, ''), elapsed: header[2], rows: [] });
    else if (/^─{2,}[^─]*$/.test(line)) segments.push({ label: line.replace(/─+/g, ' ').trim().replace(/^Phase \d+ · /, ''), elapsed: null, rows: [] });
    else if (/^─{2,}/.test(line)) segments.push({ label: line.replace(/─+/g, ' ').trim().replace(/^Phase \d+ · /, ''), elapsed: null, rows: [] });
    else if (segments.length && line.trim()) segments[segments.length - 1].rows.push(line);
  }
  return segments;
}

function normalizeRow(line) {
  return line.replace(/^\d{2}:\d{2}/, 'HH:MM').replace(/\s+/g, ' ').trim();
}

function segmentRows(screen, label) {
  return timelineSegments(screen)
    .filter((segment) => segment.label === label)
    .flatMap((segment) => segment.rows);
}

const iso = (seconds, base = '2026-08-29T00:00:00.000Z') =>
  new Date(Date.parse(base) + seconds * 1000).toISOString();

test('dashboard renders ongoing run progress and details', () => {
  const { home, cleanup } = fixture();
  try {
    const rows = dashboardRows(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].legacy, false);
    assert.equal(rows[0].stepsTotal, 2);
    assert.match(renderDashboard({ rows }), /abc234 · Audit every file autonomously/);
    assert.match(renderDashboard({ rows }), /0\/1 workers/);
    assert.match(renderDetails(rows[0]), /audit-files · running/);
    assert.match(renderDetails(rows[0]), /goal:   Audit every file autonomously/);
    assert.match(renderDetails(rows[0]), /status: running/);
    assert.match(renderDetails(rows[0]), /requirement-1/);
  } finally { cleanup(); }
});

test('V2 dashboard renders durable presentation stages, dense timeline, live filtering, and plain next step', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2-'));
  try {
    const runId = 'wf-v2dash-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2d234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    state.presentation.stages[0].startedAt = iso(2);
    state.presentation.stages[0].completedAt = iso(5);
    Object.assign(state.actions[0], { status: 'succeeded', startedAt: iso(2), finishedAt: iso(5), attempts: 1 });
    state.attempts.push({ id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: iso(5) });
    state.presentation.stages[1].startedAt = iso(6);
    Object.assign(state.actions[1], { status: 'running', startedAt: iso(6), attempts: 1 });
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay:b', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null, lastActivityAt: iso(7), outputBytesObserved: 42, lastAgentEvent: { at: iso(7), kind: 'tool', summary: 'node --test' } });
    const emit = (type, committedAt, payload) => appendEvent(dir, state, type, { ...payload, committedAt });
    emit('workflow.started', iso(0), {});
    emit('planner.finished', iso(1), { turn: 1, ok: true, summary: 'Implement then collect independent evidence.' });
    emit('presentation.stage_started', iso(2), { stageId: 'r1-implementation', label: 'Implementation' });
    emit('action.finished', iso(5), { actionId: 'implement-result', status: 'succeeded' });
    emit('presentation.stage_completed', iso(5), { stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1 });
    emit('presentation.stage_started', iso(6), { stageId: 'r1-evidence', label: 'Evidence' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    // 0.33.0 paints the plan strip, the phase count and the run's pool share
    // above the timeline, so the same timeline needs the rows those take.
    const screen = renderWorkflowTui(row, { width: 120, height: 42 });
    assert.doesNotMatch(screen, /\[Workflow Planner\] plan created/);
    assert.match(screen, /── plan .*phase 2 of 2 · 1\/2 steps/);
    assert.match(screen, /● Goal accepted/);
    assert.match(screen, /── Phase 1 · Implementation/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /├─ started/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /└─✓ completed/);
    assert.match(screen, /── Phase 2 · Evidence/);
    assert.doesNotMatch(timelinePaneRows(screen).join('\n'), /\[Phase:/);
    assert.match(screen, /check-result · relay:b · gpt-5\.6-luna/);
    assert.equal(workflowPanelModel(row).phases[0].name, 'r1-implementation');
    // The Run page draws no panel border at any width: flat rules only. The
    // timeline's own ├─/│ tree glyphs are content, not a frame, so the test
    // looks for a border at the edge of a row.
    for (const line of plain(screen).split('\n')) {
      assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
        `a panel border survived: ${line}`);
    }
    const narrowTimeline = renderWorkflowTui(row, { width: 60, height: 26, focus: 0 });
    const narrowPhases = renderWorkflowTui(row, { width: 60, height: 26, focus: 0, mobileTimeline: false });
    const narrowAgents = renderWorkflowTui(row, { width: 60, height: 26, focus: 1 });
    assert.match(plain(narrowTimeline), /── timeline ─/);
    assert.doesNotMatch(plain(narrowTimeline), /── phases · 2/);
    assert.match(plain(narrowPhases), /── phases · 2/);
    assert.doesNotMatch(plain(narrowPhases), /── timeline ─/);
    assert.match(plain(narrowAgents), /Evidence · 0\/1 complete/);
    const cancelled = requestCancel(home, 'v2d234', { source: 'test', requesterPid: 1234 });
    assert.equal(cancelled.state.cancellation.requested, true);
    assert.equal(cancelled.state.cancellation.source, 'test');
    assert.equal(cancelled.state.cancellation.requesterPid, 1234);
    const cancellationEvent = readEvents(join(home, 'workflows', 'wf-v2dash-abcdef'))
      .find((event) => event.type === 'workflow.cancellation_requested');
    assert.equal(cancellationEvent.payload.source, 'test');
    assert.equal(cancellationEvent.payload.requesterPid, 1234);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unified dashboard lists active before recent runs and renders a selected-run preview', () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    const active = dashboardRows(home);
    const all = dashboardRows(home, { all: true });
    assert.equal(active.length, 1);
    assert.deepEqual(all.map((row) => row.shortId), ['abc234', 'def345']);

    const desktop = renderDashboard({
      rows: all, allRows: all, selected: 1, previewRow: all[1],
      filter: 'all', width: 120, height: 30,
    });
    assert.match(desktop, /1 active · 0 waiting · 1 recent/);
    assert.match(desktop, /def345 · Audit documentation freshness/);
    assert.match(desktop, /0\/2 actions · 5m00s · finis/);
    assert.match(desktop, /Workflow timeline/);

    const mobile = renderDashboard({
      rows: all, allRows: all, selected: 0, previewRow: all[0],
      filter: 'all', width: 60, height: 24,
    });
    assert.match(mobile, /Runs · all/);
    assert.match(mobile, /abc234 · Audit every file/);
    assert.match(mobile, /def345 · Audit documentation/);
    assert.doesNotMatch(mobile, /Workflow timeline/);
    assert.match(mobile, /Enter open · \/ filter · a active\/all/);
    const plain = mobile.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.equal(Math.max(...plain.split('\n').map((line) => line.length)) <= 60, true);
  } finally { cleanup(); }
});

test('all-runs ordering uses the V2 lifecycle start time and keeps the initial list layout', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    const all = dashboardRows(home, { all: true });
    assert.deepEqual(all.map((row) => row.shortId), ['abc234', 'v2n456', 'def345']);

    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 60;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = cmdWorkflow([], { bullswarmDir: home, input, output });
    input.emit('data', Buffer.from('r')); // Home -> Runs
    assert.match(plain(lastFrame(output)), /── active ─/);
    assert.match(plain(lastFrame(output)), /abc234  Audit every file/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('a run ID passed to the dashboard opens that run on the Run page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30, token: 'v2n456' });
    const runPage = lastFrame(session.output);
    assert.match(frameHeader(runPage), /^ v2n456 completed · .* · 0\/0 actions · done/);
    assert.match(plain(runPage), /── timeline ─/);
    session.press('\r'); // the run page opens its agents
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ v2n456 completed/);
    session.press(ESC_KEY); // and out to Home
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('r'); // where r lists every run
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('a Runs-table cursor on a finished run survives the refresh tick, so Enter opens that run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    // A short refresh so several ticks land between the arrow key and Enter.
    const session = shellSession(home, { columns: 120, rows: 30, refreshMs: 10 });
    session.press('r'); // Home -> Runs (active filter, the day table below)
    session.press('\u001b[B'); // active run -> the finished run's table row
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    session.press('\r');
    assert.match(frameHeader(lastFrame(session.output)), /^ v2n456 completed/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('recent-list V2 selection opens that run on the Run page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30 });
    session.press('r'); // Home -> Runs
    session.press('a'); // active -> all
    session.press('\u001b[B'); // active run -> newer V2 run
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · all/);
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    session.press('\r');
    assert.match(frameHeader(lastFrame(session.output)), /^ v2n456 completed/);
    assert.match(plain(lastFrame(session.output)), /── plan ─/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('live dashboard navigation preserves V2 drilldowns, mobile panes, and empty active fallback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);

    // Desktop: the run page -> its agents -> the planner -> technical planner.
    const desktop = shellSession(home, { columns: 120, rows: 30, token: 'abc234' });
    assert.match(desktop.press('\r'), /Implementation · 0\/1 complete/);
    assert.match(desktop.press('o'), /Workflow Planner · overview/);
    assert.match(desktop.press('v'), /Workflow Planner · technical details/);
    assert.equal(await desktop.quit(), 0);

    // Mobile: the run page opens on the timeline, t exposes the phases.
    const mobile = shellSession(home, { columns: 80, rows: 30, token: 'abc234' });
    assert.match(plain(mobile.press('t')), /── phases ·/);
    assert.doesNotMatch(plain(mobile.press('t')), /── phases ·/);
    assert.match(plain(mobile.press('t')), /── phases ·/);
    assert.equal(await mobile.quit(), 0);

    // Bare active view: the merged Runs page still shows the day table, and
    // `a` toggles to the all-runs filter.
    const emptyHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-empty-'));
    addV2HistoricalRun(emptyHome);
    const empty = shellSession(emptyHome, { columns: 120, rows: 30 });
    empty.press('r');
    assert.match(plain(lastFrame(empty.output)), /── active ─/);
    assert.match(plain(lastFrame(empty.output)), /nothing in flight/);
    empty.press('a');
    assert.match(plain(lastFrame(empty.output)), /v2n456.*Newer V2 dashboard run/);
    assert.equal(await empty.quit(), 0);
    rmSync(emptyHome, { recursive: true, force: true });
  } finally { cleanup(); }
});

test('the Runs active block draws a live run exactly as Home\u2019s running section does', () => {
  // Requirement 7: the `active` block is the same renderer as Home's
  // `running` section, so a live run gets its plan strip and per-step bar on
  // both pages. Compare the painted rows, not the section title.
  const { home, cleanup } = fixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const live = rows.filter((entry) => entry.ongoing);
    assert.equal(live.length, 1, 'the fixture must have one live run');
    const model = dashboardModel(live[0], { runs: live, rollups: readRollups(home) });
    const opts = { width: 120, height: 60, rows, allRows: rows, selectedRunId: live[0].runId };
    const homeFrame = renderDashboardPage(model, { ...opts, page: 'home' }).lines.map(plain);
    const runsFrame = renderDashboardPage(model, { ...opts, page: 'runs' }).lines.map(plain);

    const section = (lines, title, stopAt) => {
      const at = lines.findIndex((line) => line.startsWith(`\u2500\u2500 ${title} \u2500`));
      assert.ok(at >= 0, `no ${title} section in ${lines.join('\n')}`);
      const rest = lines.slice(at + 1);
      const end = rest.findIndex((line) => /^\u2500\u2500 /.test(line) || stopAt.test(line));
      return rest.slice(0, end === -1 ? rest.length : end).filter((line) => line.trim());
    };
    const running = section(homeFrame, 'running', /^ \u2500 /);
    const active = section(runsFrame, 'active', /No workflow history|days loaded/);
    assert.ok(running.length, homeFrame.join('\n'));
    // Every row Home paints for the live run is the row Runs paints for it.
    for (const line of running) assert.ok(active.includes(line), `Runs is missing Home's row:\n${line}\n---\n${active.join('\n')}`);
    // And it really is a live run with its plan strip, not the empty state.
    const strip = running.find((line) => line.includes('abc234'));
    assert.ok(strip, running.join('\n'));
    assert.match(running.join('\n'), /\u25b6\u2500\u2500\u25cb\s+audit-files/);
    assert.ok(!active.some((line) => line.includes('nothing in flight')), active.join('\n'));
  } finally { cleanup(); }
});

test('tui with a run ID prints a historical text tree without a TTY', async () => {
  const { home, cleanup } = fixture();
  try {
    let printed = '';
    const output = { isTTY: false, write: (chunk) => { printed += chunk; } };
    const code = await runDashboard(home, { token: 'abc234', input: { isTTY: false }, output });
    assert.equal(code, 0);
    assert.match(printed, /bullswarm · abc234/);
    assert.match(printed, /presentation stages:/);
    assert.match(printed, /── timeline ─/);
    assert.match(printed, /── Preflight/);
    assert.doesNotMatch(printed, /Press b to go back/);
    assert.doesNotMatch(printed, /\x1b/);
  } finally { cleanup(); }
});

test('dashboard JSON supports listing, show, and cancellation', () => {
  const { home, cleanup } = fixture();
  try {
    const listed = dashboardJson(home);
    assert.equal(listed.action, 'list');
    assert.equal(listed.count, 1);
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.action, 'show');
    const cancelled = dashboardJson(home, { token: 'abc234', cancel: true });
    assert.equal(cancelled.action, 'cancel');
    assert.equal(JSON.parse(readFileSync(join(home, 'workflows', 'wf-test', 'cancellation.json'))).requested, true);
    assert.equal(requestCancel(home, 'abc234').alreadyFinished, false);
  } finally { cleanup(); }
});

test('dashboard JSON show includes live state and report when present', () => {
  const { home, cleanup } = fixture();
  try {
    writeFileSync(join(home, 'workflows', 'wf-test', 'report.json'), JSON.stringify({ status: 'completed' }));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.state.intent.goal, 'Audit every file autonomously.');
    assert.deepEqual(shown.report, { status: 'completed' });
  } finally { cleanup(); }
});

test('dashboard loads a legacy opencode2 attempt without rewriting its run history', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.attempts.push({
      id: 'legacy-1', actionId: 'audit-files', ordinal: 1,
      pool: 'opencode2', model: 'kaihk/gpt-5.6-luna', status: 'succeeded',
    });
    writeFileSync(statePath, JSON.stringify(state));
    const before = readFileSync(statePath, 'utf8');
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.state.attempts.at(-1).pool, 'opencode2');
    assert.ok(dashboardRows(home)[0], 'the dashboard still indexes the run');
    assert.equal(readFileSync(statePath, 'utf8'), before);
  } finally { cleanup(); }
});

test('dashboard rows expose the running action and its live attempt', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    Object.assign(state.attempts[0], {
      pool: 'opencode2', model: 'relay/gpt-5.6-luna', outputBytesObserved: 321,
      lastAgentEvent: { kind: 'shell_command', summary: 'npm test' },
    });
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    assert.equal(row.currentStep.id, 'audit-files');
    assert.equal(row.phase, 'Implementation');
    assert.equal(row.activeAgents[0].model, 'relay/gpt-5.6-luna');
    const tui = renderWorkflowTui(row, { width: 120, height: 40 });
    assert.match(tui, /audit-files · opencode2 · relay\/gpt-5\.6-luna/);
    assert.match(tui, /npm test/);
  } finally { cleanup(); }
});

test('workflow TUI honors terminal widths below the previous 38-column floor', () => {
  const { home, cleanup } = fixture();
  try {
    const row = dashboardRows(home)[0];
    for (const width of [20, 28, 37]) {
      const plain = renderWorkflowTui(row, { width, height: 20 })
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      assert.equal(Math.max(...plain.split('\n').map((line) => line.length)) <= width, true);
    }
  } finally { cleanup(); }
});

test('the interactive TUI takes the alternate screen with mouse reporting, and q only detaches', async () => {
  const { home, cleanup } = fixture();
  try {
    const session = shellSession(home, { columns: 110, rows: 26, token: 'abc234' });
    // SGR mouse reporting is asked for with the alternate screen.
    assert.equal(session.output.text.includes('\x1b[?1000h\x1b[?1006h'), true);
    session.press('\r'); // run -> its agents
    session.press('\r'); // agents -> the selected step
    assert.match(frameHeader(lastFrame(session.output)), /audit-files · run abc234/);
    session.press(ESC_KEY);
    assert.equal(await session.quit(), 0);
    assert.deepEqual(session.input.rawModes, [true, false]);
    assert.match(session.output.text, /\x1b\[\?1049h/);
    assert.match(session.output.text, /\x1b\[\?1049l/);
    // Leaving releases the mouse and shows the cursor again.
    assert.match(session.output.text, /\x1b\[\?1006l\x1b\[\?1000l\x1b\[\?25h\x1b\[\?1049l/);
    // Detaching the viewer never asks the kernel to stop.
    assert.equal(existsSync(join(home, 'workflows', 'wf-test', 'cancellation.json')), false);
  } finally { cleanup(); }
});

test('bare workflow dashboard navigates active and recent runs on mobile', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    const session = shellSession(home, { columns: 60, rows: 26 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('r'); // Home -> Runs
    session.press('a'); // active -> all
    session.press('\u001b[B'); // select the historical run
    session.press('\r'); // open it on the Run page
    session.press(ESC_KEY); // back to Home
    session.press('r'); // and on to Runs, which owns the filter
    session.press('/');
    session.press('def');
    session.press('\r');
    assert.match(plain(lastFrame(session.output)), /Showing workflows matching “def”/);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · all/);
    // The project derives from the run's goal.json cwd (requirement 3), so the
    // temp fixture home names the row, not `unknown project`.
    // The widest visible duration in this day is six cells, so the elastic
    // goal gives back one cell to keep `5m` and `12h34m` whole.
    assert.match(plain(lastFrame(session.output)), /✓ def345  bs-dashboa… Audit documentation f…/);
    assert.match(plain(session.output.text), /── timeline ─/);
    assert.equal(await session.quit(), 0);
    assert.deepEqual(session.input.rawModes, [true, false]);
    assert.match(session.output.text, /\x1b\[\?1049l/);
  } finally { cleanup(); }
});

test('interactive TUI repaints spinner frames in place without clearing the screen', async () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.currentPhase = { index: 0, name: 'review', total: 1 };
    state.actionLedger = [{ id: 'fan', phase: 'review', kind: 'run', status: 'running', attempts: [0] }];
    state.attempts = [{
      actionId: 'fan', attemptNumber: 1, pool: 'grok', model: 'grok-4.6', status: 'running',
      startedAt: new Date().toISOString(),
    }];
    state.activeAgents = { fan: {
      stepId: 'fan', pool: 'grok', model: 'grok-4.6', attempt: 1, status: 'running',
      startedAt: new Date().toISOString(),
    } };
    writeFileSync(statePath, JSON.stringify(state));

    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 110;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = runDashboard(home, {
      token: 'abc234', input, output, refreshMs: 60_000, spinnerMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.equal((output.text.match(/\x1b\[2J/g) ?? []).length, 1, 'alternate screen is cleared only once');
    assert.ok((output.text.match(/\x1b\[H/g) ?? []).length >= 3, 'spinner frames repaint from cursor home');
    assert.ok((output.text.match(/\x1b\[K/g) ?? []).length >= output.rows, 'each row clears only its stale tail');
  } finally { cleanup(); }
});

test('narrow interactive TUI opens on the timeline and t toggles the phase browser', async () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.lifecycle = { status: 'completed', startedAt: iso(0), finishedAt: iso(120), resultFile: null };
    for (const action of state.actions) Object.assign(action, { status: 'succeeded', startedAt: iso(10), finishedAt: iso(110) });
    state.attempts = [
      { id: 'audit-files-1', actionId: 'audit-files', ordinal: 1, status: 'succeeded', pool: 'luna', startedAt: iso(10), finishedAt: iso(40) },
      { id: 'inspect-audit-1', actionId: 'inspect-audit', ordinal: 1, status: 'succeeded', pool: 'luna', startedAt: iso(50), finishedAt: iso(110) },
    ];
    // Durable action events are what give each dependency level its own
    // timeline segment to navigate between.
    for (const action of state.actions) {
      appendEvent(join(home, 'workflows', 'wf-test'), state, 'action.started', { actionId: action.id });
      appendEvent(join(home, 'workflows', 'wf-test'), state, 'action.finished', { actionId: action.id, status: 'succeeded' });
    }
    writeFileSync(statePath, JSON.stringify(state));
    const session = shellSession(home, { columns: 80, rows: 26, token: 'abc234' });
    const timelineText = lastFrame(session.output);
    // The narrow run page opens on the timeline; ↓ selects its first segment.
    session.press('\u001b[B');
    const preflightText = lastFrame(session.output);
    session.press('\u001b[C'); // the selected Preflight opens the Workflow Planner
    const plannerText = lastFrame(session.output);
    session.press(ESC_KEY); // and back out to the timeline
    session.press('\u001b[B');
    session.press('\u001b[C'); // the selected phase opens its agents
    const agentsText = lastFrame(session.output);
    session.press(ESC_KEY);
    session.press('t');
    const phasesText = lastFrame(session.output);
    assert.equal(await session.quit(), 0);
    assert.match(plain(timelineText), /── timeline ─/);
    assert.match(preflightText, /\x1b\[7m── Preflight/);
    assert.match(plannerText, /Workflow Planner · overview/);
    assert.match(agentsText, /Implementation · 1\/1 complete/);
    const visibleWidths = paintedRows(timelineText).map((line) => plain(line).length);
    assert.ok(visibleWidths.every((lineWidth) => lineWidth <= 80 - 1), 'mobile frames reserve the terminal wrap column');
    assert.match(plain(phasesText), /── phases · 2/);
    assert.doesNotMatch(plain(phasesText), /── timeline ─/);
  } finally { cleanup(); }
});

test('JSON inspection exposes the same durable state and events as the run directory', () => {
  const { home, cleanup } = fixture();
  try {
    const runDir = join(home, 'workflows', 'wf-test');
    const statePath = join(runDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    appendEvent(runDir, state, 'action.finished', { actionId: 'audit-files', status: 'succeeded' });
    writeFileSync(statePath, JSON.stringify(state));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.deepEqual(shown.state, JSON.parse(readFileSync(statePath, 'utf8')));
    assert.deepEqual(shown.events, readEvents(runDir));
  } finally { cleanup(); }
});

test('a torn state.json (writer mid-write) never crashes the observation paths', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    // Overwrite with a mid-write snapshot cut inside a string — the exact
    // shape of the observed `workflow tui` crash (2026-08-29).
    writeFileSync(statePath, '{"runId":"wf-test","shortId":"abc234","status":"running","intent":{"goal":"do the th');
    assert.doesNotThrow(() => dashboardRows(home));
    const shown = dashboardJson(home, { token: 'wf-test' });
    assert.equal(shown.action, 'show');
    assert.equal(shown.state, null);
    // Mutating paths must refuse loudly rather than silently no-op.
    assert.throws(() => requestCancel(home, 'wf-test'), /unreadable.*retry the command/s);
  } finally { cleanup(); }
});

function plain(screen) {
  return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// ---------------------------------------------------------------------------
// Unified application shell: the workflows list, a run, a phase, and an agent
// are four depths of one hierarchy. Each depth carries the same persistent
// breadcrumb, the same key grammar, and the same drill-down, so the helpers
// below read the breadcrumb and the footer structurally — never by panel
// geometry, hint order, or the exact wording a binding happens to use today.
// ---------------------------------------------------------------------------

function shellRunState({ runId, shortId, goal, agentId, startedAt }) {
  const document = createV2GoalDocument({
    goal, cwd: tmpdir(),
    requirements: [{ id: 'requirement-1', text: 'The viewer is unified.', mandatory: true }],
    settings: { scout: false },
  });
  let state = createV2State(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Scan then build.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'scan', purpose: 'Scan the viewer', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['scan.md'], prompt: 'Scan it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['scan'] },
      { id: agentId, purpose: 'Build the viewer', dependsOn: ['scan'], affects: ['requirement-1'], ownedFiles: ['build.md'], prompt: 'Build it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: ['scan'], produces: ['build'] },
      { id: `${agentId}-evidence`, purpose: 'Inspect the build', dependsOn: [agentId], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['build'], produces: [] },
    ] },
  });
  state.lifecycle = { status: 'running', startedAt, finishedAt: null, resultFile: null };
  Object.assign(state.actions[0], { status: 'succeeded', startedAt, finishedAt: startedAt, attempts: 1 });
  Object.assign(state.actions[1], { status: 'running', startedAt, attempts: 1 });
  state.attempts = [
    { id: 'scan-1', actionId: 'scan', ordinal: 1, pool: 'opencode2', model: 'luna', status: 'succeeded', startedAt, finishedAt: startedAt },
    { id: `${agentId}-1`, actionId: agentId, ordinal: 1, pool: 'codex', model: 'sol', status: 'running', startedAt, finishedAt: null },
  ];
  state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
  return state;
}

// Two live runs of the same shape: the sibling exists at every depth, so Tab
// has an equivalent location to land on instead of falling back to the root.
const SHELL_RUNS = [
  {
    runId: 'wf-alpha', shortId: 'aaa111', goal: 'unified-shell', agentId: 'build-alpha',
    startedAt: '2026-08-29T00:02:00.000Z',
  },
  {
    runId: 'wf-beta', shortId: 'bbb222', goal: 'sibling-run', agentId: 'build-beta',
    startedAt: '2026-08-29T00:01:00.000Z',
  },
];

function shellFixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-shell-'));
  mkdirSync(join(home, 'history'), { recursive: true });
  writeFileSync(
    join(home, 'history', 'runs.jsonl'),
    `${rollupFixture().map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  for (const run of SHELL_RUNS) {
    const dir = join(home, 'workflows', run.runId);
    mkdirSync(dir, { recursive: true });
    const state = shellRunState(run);
    // Durable action events give each dependency level its own timeline segment.
    appendEvent(dir, state, 'action.started', { actionId: 'scan' });
    appendEvent(dir, state, 'action.finished', { actionId: 'scan', status: 'succeeded' });
    appendEvent(dir, state, 'action.started', { actionId: run.agentId });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// The painted rows of one frame: the clear/home escape a repaint opens with
// renders nothing, so the header is the first row and the nav the last.
function paintedRows(screen) {
  const rows = plain(screen).split('\n');
  if (rows[0] === '') rows.shift();
  return rows;
}

/** The page tab row: the first painted row of every frame. */
function tabRow(screen) {
  return plain(String(paintedRows(screen)[0] ?? '')).replace(/\s+$/, '');
}

/** The tabs the row actually painted, in order. */
function tabNames(screen) {
  return tabRow(screen).trim().split(/\s{2,}/).filter(Boolean);
}

/** The sticky header: the row under the tab row. */
function frameHeader(screen) {
  return String(paintedRows(screen)[1] ?? '').replace(/\s+$/, '');
}

/** The sticky bottom nav as its `[ label ]` buttons, marks included. */
function navButtons(screen) {
  const nav = plain(String(paintedRows(screen).at(-1) ?? ''));
  // A run button's digit (`[ 1.aaa111 ]`) is dropped: the tests name runs by id.
  return [...nav.matchAll(/\[ ([^\]]*?) \]/g)].map((match) => match[1].trim().replace(/^(● )?[1-9]\./, '$1'));
}

/** Every page the 0.33.0 shell has, in the order Help lists them. */
const DASHBOARD_PAGE_NAMES = ['home', 'runs', 'run', 'step', 'budget', 'stats', 'history', 'fleet', 'help'];

/** The tab the row painted inverted — the page the reader is on. */
function activeTab(screen) {
  const rows = String(screen).split('\n');
  const row = rows[0] === '' ? rows[1] : rows[0];
  const match = /\x1b\[7m(.*?)\x1b\[0m/.exec(String(row ?? ''));
  return match ? plain(match[1]) : '';
}

/**
 * Two rollup records, the shape `~/.bullswarm/history/runs.jsonl` holds: one
 * verified run with a recorded API-equivalent estimate, one that recorded
 * none. Nothing here declares a subscription price, which is the state every
 * pool on a real machine is in until an operator declares one.
 */
function rollupFixture(now = Date.now()) {
  const day = (back) => new Date(now - back * 86_400_000).toISOString();
  return [
    {
      schemaVersion: 'bullswarm.workflow.rollup.v1',
      runId: 'wf-zzz', shortId: 'zzz999', project: 'bullswarm', goal: 'Rebuild the dashboard shell',
      startedAt: day(0), finishedAt: day(0), status: 'completed', verified: true,
      requirements: { passed: 3, total: 3 }, minutes: { wall: 41, agent: 63 },
      pools: { relay: { attempts: 2, minutes: 40, costUsd: 0.42, tokens: 1200 } },
      models: { 'gpt-5.6-luna': { attempts: 2, minutes: 40 } }, legacy: false,
    },
    {
      schemaVersion: 'bullswarm.workflow.rollup.v1',
      runId: 'wf-yyy', shortId: 'yyy888', project: 'project-a', goal: 'Tidy the repo',
      startedAt: day(2), finishedAt: day(2), status: 'failed', verified: false,
      requirements: { passed: 1, total: 3 }, minutes: { wall: 12, agent: 15 },
      pools: { relay: { attempts: 1, minutes: 12, costUsd: null, tokens: null } },
      models: { 'gpt-5.6-mini': { attempts: 1, minutes: 12 } }, legacy: false,
    },
  ];
}

/**
 * The day rows `historyDays` returns for the same two runs. The keys are
 * local dates, because `dayKey` groups a run by the day it finished in the
 * reader's own zone, not in UTC.
 */
function dayFixture(now = Date.now()) {
  const key = (back) => {
    const at = new Date(now - back * 86_400_000);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  };
  // historyDays files each record under the day it belongs to and hands the
  // page that day's `rows`, so the fixture carries them the same way.
  const records = rollupFixture(now);
  const rowsOn = (back) => records.filter((record) => {
    const at = new Date(record.finishedAt);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` === key(back);
  });
  return [
    { date: key(0), runs: 1, finished: 1, verified: 1, verifiedShare: 1, spendUsd: 0.42, rows: rowsOn(0) },
    { date: key(1), runs: 0, finished: 0, verified: 0, verifiedShare: null, spendUsd: null, rows: [] },
    { date: key(2), runs: 1, finished: 1, verified: 0, verifiedShare: 0, spendUsd: null, rows: rowsOn(2) },
  ];
}

/** The last frame written to a fake output, with its leading paint escape. */
function lastFrame(output) {
  const frames = output.text.split('\x1b[H');
  return frames[frames.length - 1];
}

/** Clicks the first painted occurrence of `needle`, the way a mouse would. */
function clickOn(session, needle) {
  const rows = paintedRows(lastFrame(session.output)).map(plain);
  for (const [index, row] of rows.entries()) {
    const at = row.indexOf(needle);
    if (at < 0) continue;
    session.press(`\x1b[<0;${at + 1};${index + 1}M`);
    return { x: at + 1, y: index + 1 };
  }
  throw new Error(`"${needle}" is not painted in the frame:\n${rows.join('\n')}`);
}

/** The next macrotask, so an async usage read can land before an assertion. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('every page paints its tab row, its own sticky header, and a nav that marks the run', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    assert.ok(row, 'the fixture run is listed');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
      rollups: rollupFixture(),
      days: dayFixture(),
    });
    const page = (name, extra = {}) => renderDashboardPage(model, {
      page: name, width: 100, height: 30, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha', ...extra,
    }).lines.join('\n');

    // The tab row is the first row of every page, the active tab inverted.
    for (const name of DASHBOARD_PAGE_NAMES) {
      assert.deepEqual(
        tabNames(page(name)),
        ['Home', 'Runs', 'Budget', 'Stats', 'Fleet'],
        `${name} painted the wrong tab row`,
      );
    }
    // Run and Step are read as Runs, so the tab row marks Runs on both.
    for (const [name, active] of [['home', 'Home'], ['runs', 'Runs'], ['run', 'Runs'], ['step', 'Runs'],
      ['budget', 'Budget'], ['stats', 'Stats'], ['history', 'Runs'], ['fleet', 'Fleet']]) {
      assert.ok(String(page(name)).includes(`\x1b[7m`), `${name} painted no active tab`);
      assert.ok(activeTab(page(name)).includes(active), `${name} marked ${activeTab(page(name))}, not ${active}`);
    }
    assert.equal(activeTab(page('help')), '', 'Help has no highlighted tab');

    // The header names the page: the product on Home, the run on Run, the step
    // on Step, the window on Budget, the tab on Stats.
    assert.match(frameHeader(page('home')), /^ bullswarm · home/);
    assert.match(frameHeader(page('runs')), /^ bullswarm · runs/);
    assert.match(frameHeader(page('run')), /^ aaa111 running · .* · 1\/3 actions/);
    assert.match(frameHeader(page('step')), /^ .* build-alpha · run aaa111/);
    assert.match(frameHeader(page('budget')), /^ Budget · /);
    assert.match(frameHeader(page('stats')), /^ Stats · overview/);
    assert.match(frameHeader(page('history')), /^ bullswarm · runs · \S+ · \d+ day/);
    assert.match(frameHeader(page('fleet')), /^ Fleet · by lane/);
    assert.match(frameHeader(page('help')), /^ bullswarm · help/);

    // One button per ongoing run, then help and quit, the current run marked.
    assert.deepEqual(navButtons(page('home')), ['● aaa111', 'bbb222', '?.help', 'quit']);
    assert.deepEqual(navButtons(page('run')), ['● aaa111', 'bbb222', '?.help', 'quit']);
    assert.deepEqual(navButtons(page('budget')), ['aaa111', 'bbb222', '?.help', 'quit']);
    assert.deepEqual(navButtons(page('help')), ['aaa111', 'bbb222', '● ?.help', 'quit']);
    // Step prepends the way back out.
    assert.deepEqual(navButtons(page('step')), ['back', '● aaa111', 'bbb222', '?.help', 'quit']);

    for (const name of DASHBOARD_PAGE_NAMES) {
      const frame = renderDashboardPage(model, {
        page: name, width: 100, height: 30, rows, allRows: rows, selectedRunId: 'wf-alpha',
      });
      assert.ok(frame.lines.length <= 30, `${name} painted ${frame.lines.length} rows`);
      assert.match(plain(frame.lines.at(-1)), /\[ quit \]/, `${name} lost its bottom nav`);
    }
  } finally { cleanup(); }
});

test('every nav button is prefixed by its underlined key, and digits open runs in nav order', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
    });
    const frame = renderDashboardPage(model, {
      page: 'home', width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
    });
    const nav = String(frame.lines.at(-1));
    const key = (text) => `\x1b[4m${text}\x1b[24m`;
    assert.ok(nav.includes(`[ ● ${key('1')}.aaa111 ]`), 'the current run carries 1. inside its button');
    assert.ok(nav.includes(`[ ${key('2')}.bbb222 ]`), 'the second run carries 2. inside its button');
    assert.ok(nav.includes(`[ ${key('?')}.help ]`), 'help underlines its ?');
    assert.ok(nav.includes(`[ ${key('q')}uit ]`), 'quit underlines its q');
    // b is Budget now, so the way back out of a step carries no key letter.
    const step = renderDashboardPage(model, {
      page: 'step', width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
    });
    assert.ok(String(step.lines.at(-1)).includes('[ back ]'), 'the step page keeps its way out');

    // The tab row underlines the key that opens each page.
    const tabs = String(frame.lines[0]);
    for (const [letter, label] of [['r', 'uns'], ['b', 'udget'], ['s', 'tats'], ['f', 'leet']]) {
      assert.ok(tabs.includes(`${key(letter.toUpperCase())}${label}`) || tabs.includes(`${key(letter)}${label}`),
        `the ${label} tab does not underline ${letter}`);
    }

    // The digit a button shows is the digit that opens that run.
    const session = shellSession(home, { columns: 100, rows: 24 });
    session.press('2');
    assert.match(frameHeader(lastFrame(session.output)), / bbb222 running/);
    session.press('1');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    session.press('q');
  } finally { cleanup(); }
});

test('Budget, Fleet and Help open with no run selected: a fresh install, or only finished runs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-empty-'));
  try {
    mkdirSync(join(home, 'workflows'), { recursive: true });
    const session = shellSession(home, { columns: 100, rows: 24 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('b');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    session.press('f');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    session.press('?');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help/);
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, 'Budget');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no page paints past the terminal or comes up blank, at 120x40 and at 55x26', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows,
      usage: usageFixture(),
      integration: { ok: false, agents: [{ agent: 'codex', skill: { status: 'missing' }, awareness: false }] },
      rollups: rollupFixture(),
      days: dayFixture(),
    });

    // 55 columns is the phone layout; frameWidth() subtracts one below 100,
    // so the terminal paints 54 and every page must fit it.
    for (const [width, height] of [[120, 40], [54, 26], [32, 20], [60, 26], [80, 30], [99, 30], [200, 40]]) {
      for (const name of DASHBOARD_PAGE_NAMES) {
        for (const tab of ['overview', 'trends', 'pools', 'models', 'projects']) {
          const frame = renderDashboardPage(model, {
            page: name, width, height, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
            phaseIndex: 1, agentIndex: 0, statsTab: tab, metric: 'spend', period: '30d',
          });
          const screen = frame.lines.join('\n');
          const overflow = paintedRows(screen).filter((line) => [...line].length > width);
          assert.deepEqual(overflow, [], `width ${width} ${name}/${tab} overflowed`);
          // No page is blank: it paints a header, a body and the nav.
          assert.ok(frameHeader(screen).trim().length > 0, `width ${width} ${name} painted no header`);
          assert.ok(paintedRows(screen).filter((line) => line.trim()).length >= 3, `width ${width} ${name} came up blank`);
          assert.match(plain(paintedRows(screen).at(-1)), /\[/, `width ${width} ${name} lost its nav`);
          if (name !== 'stats') break;
        }
      }
    }
  } finally { cleanup(); }
});

test('at 55 columns Fleet leaves the tab row and the nav tail is [Top] [End] [Help]', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows[0], { runs: rows.filter((entry) => entry.ongoing), usage: usageFixture() });
    const narrow = renderDashboardPage(model, { page: 'home', width: 54, height: 26, rows, allRows: rows });
    // With History merged into Runs there is room for the whole tab row again;
    // Fleet only leaves below 38 columns.
    assert.deepEqual(tabNames(narrow.lines.join('\n')), ['Home', 'Runs', 'Budget', 'Stats', 'Fleet']);
    const nav = plain(narrow.lines.at(-1));
    assert.match(nav, /\[Top\] \[End\] \[\?\.Help\]\s*$/);
    assert.doesNotMatch(nav, /\[ quit \]/);
    // Fleet comes back the moment it is the page being read.
    const fleet = renderDashboardPage(model, { page: 'fleet', width: 54, height: 26, rows, allRows: rows });
    assert.ok(tabNames(fleet.lines.join('\n')).includes('Fleet'), 'the active page never leaves the tab row');
    // Every one of the three tail buttons is clickable.
    const tail = narrow.regions.filter((region) => region.y === narrow.lines.length);
    assert.deepEqual(tail.map((region) => region.action.kind).slice(-3), ['top', 'end', 'page']);
    // And the Help page says which layout the reader is looking at.
    const help = plain(renderDashboardPage(model, { page: 'help', width: 54, height: 60 }).lines.join('\n'));
    assert.match(help, /\[Top\] \[End\] \[\?\.Help\]/);
    assert.match(help, /Fleet leaves the tab row/);
  } finally { cleanup(); }
});

test('the nav records a hit region for every button, run row, tile, bar and step row', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows, usage: usageFixture(), rollups: rollupFixture(), days: dayFixture(),
    });

    const runFrame = renderDashboardPage(model, {
      page: 'run', width: 100, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const nav = runFrame.regions.filter((region) => region.y === runFrame.lines.length);
    assert.deepEqual(nav.map((region) => region.action.kind), ['run', 'run', 'page', 'quit']);
    assert.deepEqual(nav.map((region) => region.action.page).filter(Boolean), ['help']);
    for (const region of nav) {
      const painted = plain(runFrame.lines[region.y - 1]).slice(region.x1 - 1, region.x2);
      assert.match(painted, /^\[ .+ \]$/, `${painted} is not a whole button`);
    }
    // Every step row the timeline prints opens that step, and so does every
    // glyph of the plan strip above it.
    const steps = runFrame.regions.filter((region) => region.action.kind === 'step');
    assert.ok(steps.length >= 3, `expected the plan strip and the timeline rows to be clickable: ${steps.length}`);
    assert.ok(new Set(steps.map((region) => region.action.actionId)).has('scan'));
    assert.ok(new Set(steps.map((region) => region.action.actionId)).has('build-alpha'));

    // Home: every tile, every breakdown bar, every run and every recent row.
    const homeFrame = renderDashboardPage(model, {
      page: 'home', width: 100, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const kinds = (frame, kind) => frame.regions.filter((region) => region.action.kind === kind);
    // One region per today tile, plus the breakdown's own spent-per-day column.
    assert.deepEqual(
      [...new Set(kinds(homeFrame, 'trend').map((region) => region.action.metric))],
      ['runs', 'verified', 'spend'],
    );
    for (const metric of ['runs', 'verified']) {
      assert.equal(kinds(homeFrame, 'trend').filter((region) => region.action.metric === metric).length, 1,
        `the ${metric} tile records exactly one hit region`);
    }
    assert.ok(kinds(homeFrame, 'tab').length >= 1, 'the licence tile and the bars open a Stats tab');
    assert.deepEqual(kinds(homeFrame, 'period').map((region) => region.action.period), ['7d', '30d', 'all']);
    const runRows = kinds(homeFrame, 'run').filter((region) => region.y !== homeFrame.lines.length);
    assert.ok(runRows.some((region) => region.action.runId === 'wf-alpha'));
    assert.ok(kinds(homeFrame, 'step').length >= 2, 'the per-run glyph strip is clickable');
    // Every region sits inside the line it was painted on.
    for (const frame of [homeFrame, runFrame]) {
      for (const region of frame.regions) {
        const line = plain(frame.lines[region.y - 1] ?? '');
        assert.ok(region.x1 >= 1 && region.x2 <= Math.max(1, line.length),
          `region ${JSON.stringify(region.action)} at ${region.x1}–${region.x2} is outside "${line}"`);
      }
    }

    // The page tab row opens its page from every page.
    const tabs = homeFrame.regions.filter((region) => region.action.kind === 'page' && region.y === 1);
    assert.deepEqual(tabs.map((region) => region.action.page), ['home', 'runs', 'budget', 'stats', 'fleet']);

    // Fleet's own tabs switch the grouping, and `[edit]` is the e key.
    const fleetFrame = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30 });
    const fleetTabs = fleetFrame.regions.filter((region) => region.action.kind === 'tab');
    assert.deepEqual(fleetTabs.map((region) => region.action.tab), ['lane', 'provider']);
    // fleet-view paints the row and records the regions; the shell only moves
    // them onto the frame, so each one still covers the words it was drawn on.
    const tabsRowText = plain(fleetFrame.lines[fleetTabs[0].y - 1]);
    assert.match(tabsRowText.slice(fleetTabs[0].x1 - 1, fleetTabs[0].x2), /by lane/);
    assert.match(tabsRowText.slice(fleetTabs[1].x1 - 1, fleetTabs[1].x2), /by provider/);
    const edit = fleetFrame.regions.find((region) => region.action.kind === 'edit');
    assert.match(plain(fleetFrame.lines[edit.y - 1]).slice(edit.x1 - 1, edit.x2), /edit/);

    // Stats' five sub-tabs are the same five Tab walks.
    const statsFrame = renderDashboardPage(model, { page: 'stats', width: 100, height: 30 });
    assert.deepEqual(
      statsFrame.regions.filter((region) => region.action.kind === 'tab').map((region) => region.action.tab),
      ['overview', 'trends', 'pools', 'models', 'projects'],
    );
    // Stats' dense rows remain real hit targets at desktop and phone widths:
    // pool meters open the matching Budget view, while model/project rows use
    // the deliberately chosen History fallback (there is no row filter yet).
    for (const width of [120, 54]) {
      const statsPage = (tab) => renderDashboardPage(model, {
        page: 'stats', width, height: 80, rows, allRows: rows, selectedRunId: 'wf-alpha',
        statsTab: tab, period: '7d', metric: 'runs',
      });
      const poolsFrame = statsPage('pools');
      const poolRegions = poolsFrame.regions.filter((region) => region.action.kind === 'page'
        && region.action.page === 'budget' && region.action.pool);
      assert.ok(poolRegions.some((region) => region.action.pool === 'relay'), `pool meter missing at ${width}`);
      const modelsFrame = statsPage('models');
      assert.ok(modelsFrame.regions.some((region) => region.action.kind === 'page' && region.action.page === 'history'), `model row missing at ${width}`);
      const projectsFrame = statsPage('projects');
      assert.ok(projectsFrame.regions.some((region) => region.action.kind === 'page' && region.action.page === 'history'), `project row missing at ${width}`);
      for (const frame of [poolsFrame, modelsFrame, projectsFrame]) {
        for (const region of frame.regions) {
          const line = plain(frame.lines[region.y - 1] ?? '');
          assert.ok(region.x1 >= 1 && region.x2 <= Math.max(1, line.length), `stats region overrun at ${width}`);
        }
      }
    }
    // History's run rows open that run.
    const historyFrame = renderDashboardPage(model, { page: 'history', width: 100, height: 30 });
    // The bottom nav's run buttons are the same { kind: 'run' } action, so a
    // body row is one that is not on the nav's own line.
    const historyRuns = historyFrame.regions.filter((region) => region.action.kind === 'run'
      && region.y !== historyFrame.lines.length);
    assert.ok(historyRuns.length >= 1, 'a History row opens its run');
    // The merged page opens with the active runs (aaa111), so pick the
    // finished run's region explicitly.
    const zzzRun = historyRuns.find((region) => region.action.runId === 'wf-zzz');
    assert.ok(zzzRun, 'a finished run row opens its run');
    assert.match(
      plain(historyFrame.lines[zzzRun.y - 1]).slice(zzzRun.x1 - 1, zzzRun.x2),
      /zzz999/,
    );
  } finally { cleanup(); }
});

// The two navigation moves that only exist in the input loop. Each keypress is
// delivered synchronously, so the returned repaint frame is exactly the screen
// that key produced — nothing else can have painted in between.
const ESC_KEY = String.fromCharCode(27);

/** Two pools and their rungs: the shape `loadUsage` hands the pages. */
function usageFixture(nowMs = Date.now()) {
  const at = (ms) => new Date(nowMs + ms).toISOString();
  return {
    pools: [
      {
        name: 'relay', enabled: true, usedPct: 32, elapsedPct: 27, pace: 5.4, pacingWindow: 'weekly',
        incumbentLane: ['build'], quarantine: null,
        meterSnapshot: {
          captured_at: at(-3 * 60_000), plan_type: 'max',
          five_hour: { utilization: 32, resets_at: at(3_600_000) },
          seven_day: { utilization: 55, resets_at: at(2 * 86_400_000) },
          monthly_quota: { used: 63.5, limit: 70, unit: 'credits' },
        },
      },
      {
        name: 'codex', enabled: false, usedPct: 81, elapsedPct: 60, pace: -21, pacingWindow: 'monthly',
        incumbentLane: [], quarantine: null, meterSnapshot: null,
      },
    ],
    assignments: [{ pool: 'relay', actionId: 'build-alpha', lane: 'build' }],
    rungs: [
      { pool: 'relay', tier: 'high', model: 'vendor/gpt-5.6-luna', reasoning: 'high', dispatches: 3, okShare: 0.67, medianMinutes: 12 },
      { pool: 'relay', tier: 'medium', model: 'vendor/gpt-5.6-mini', reasoning: 'medium', dispatches: 0, okShare: null, medianMinutes: null },
    ],
    capturedAt: at(-3 * 60_000),
  };
}

function shellSession(home, {
  columns = 120, rows = 30, token = null, homeDir = home, openSetupTui = null, refreshMs = 60_000,
} = {}) {
  class FakeInput extends EventEmitter {
    isTTY = true;
    rawModes = [];
    setRawMode(value) { this.rawModes.push(value); }
    resume() {}
    pause() {}
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    text = '';
    constructor(width, height) { super(); this.columns = width; this.rows = height; }
    write(chunk) { this.text += chunk; }
  }
  const input = new FakeInput();
  const output = new FakeOutput(columns, rows);
  const running = runDashboard(home, {
    input, output, refreshMs, token, homeDir, openSetupTui,
  });
  const press = (key) => {
    const before = output.text.length;
    input.emit('data', Buffer.from(key));
    return output.text.slice(before);
  };
  return { input, output, running, press, quit: () => { press('q'); return running; } };
}

test('Shift+Tab re-enters the sibling run at the page it was left on', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    session.press('\r'); // run -> agents
    session.press('\r'); // agents -> the selected step
    const atStep = lastFrame(session.output);
    assert.match(frameHeader(atStep), /build-alpha · run aaa111/);

    // 0.33.0 gives Tab the sub-tabs; Shift+Tab is the key that still cycles
    // workflows, and it cycles, so two presses come back here.
    const sibling = session.press(`${ESC_KEY}[Z`);
    assert.ok(sibling.length, 'Shift+Tab repainted the screen');
    // same page, the sibling workflow's own agent, marked current in the nav
    assert.match(frameHeader(sibling), /build-beta · run bbb222/);
    const buttons = navButtons(sibling);
    assert.equal(buttons[0], 'back', 'the sibling is entered at the same depth');
    assert.ok(buttons.includes('● bbb222'), `the sibling is the current run: ${buttons.join(' ')}`);
    assert.ok(!buttons.includes('● aaa111'));
    assert.doesNotMatch(sibling, /build-alpha/);

    // and cycling on comes back the same way, still on the step page
    const back = session.press(`${ESC_KEY}[Z`);
    assert.match(frameHeader(back), /build-alpha · run aaa111/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Enter walks in and Esc walks out one page at a time', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);

    session.press('\r'); // run -> its agents
    session.press('\r'); // agents -> the selected step
    assert.match(frameHeader(lastFrame(session.output)), /build-alpha · run aaa111/);
    assert.equal(navButtons(lastFrame(session.output))[0], 'back');

    const run = session.press(ESC_KEY); // step -> the run's agents
    assert.match(frameHeader(run), / aaa111 running/);
    assert.ok(!navButtons(run).includes('back'), 'the step page was left behind');
    assert.doesNotMatch(run, /bullswarm · home/);

    const timeline = session.press(ESC_KEY); // agents -> the run's timeline
    assert.match(frameHeader(timeline), / aaa111 running/);
    assert.doesNotMatch(timeline, /bullswarm · home/);

    const list = session.press(ESC_KEY); // run -> home
    assert.match(frameHeader(list), /^ bullswarm · home/);
    assert.doesNotMatch(list, /Workflow timeline/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('the Help page names every key, and the keys the nav buttons carry open them', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    session.press('?');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help/);
    // The whole page, not just the window it opens on: every key the table
    // binds is named, and every click the pages record.
    const whole = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 100, height: 80 });
    const help = plain(whole.lines.join('\n'));
    for (const name of Object.keys(DASHBOARD_KEYS)) {
      assert.ok(help.includes(DASHBOARD_KEYS[name].keys), `the help page lost ${name} (${DASHBOARD_KEYS[name].keys})`);
    }
    for (const text of ['tile', 'bar', 'wheel', 'y confirms it', 'r was refresh', 'OSC 52']) {
      assert.ok(help.includes(text), `the help page lost ${text}`);
    }
    // And at 55 columns every row of it fits the 54 the frame paints.
    const narrowHelp = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 54, height: 80 });
    for (const line of narrowHelp.lines) assert.ok(plain(line).length <= 54, `help clipped at 55 columns: ${plain(line)}`);
    assert.ok(plain(narrowHelp.lines.join('\n')).includes('ctrl+s'), 'the narrow help page lost ctrl+s');
    // ? -> help -> Esc -> home -> b -> budget -> Esc -> home
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('b');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    // the digit a nav button carries opens that run
    session.press('2');
    assert.match(frameHeader(lastFrame(session.output)), / bbb222 running/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('V2 planned steps name each action work or evidence, never undefined', () => {
  // Regression: the planned-steps list printed `action.kind`, a field only
  // authored drafts carry. Every V2 run rendered "<id> · undefined · <status>"
  // for every step that had no agent yet. Observed live on run zx9vni.
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-role-'));
  try {
    const runId = 'wf-role-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Close the UI gaps and prove the suite is green', cwd: '/tmp/repo',
      requirements: [{ id: 'requirement-1', text: 'The UI gaps are closed' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'role12' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Fix, then verify.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'shell-and-visual-system', purpose: 'Close the shell gaps', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['src/shell.js'], prompt: 'Fix it.', lane: 'build', effort: 'high', evidenceFor: [], inputs: [], produces: ['shell'] },
        { id: 'space-and-spaces', purpose: 'Close the Space gaps', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['src/space.js'], prompt: 'Fix it.', lane: 'build', effort: 'high', evidenceFor: [], inputs: [], produces: ['space'] },
        { id: 'verify-surfaces', purpose: 'Verify the surfaces', dependsOn: ['shell-and-visual-system', 'space-and-spaces'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['shell', 'space'], produces: [] },
      ] },
    });
    // One action running, no attempt recorded yet: exactly the state that shows
    // the planned-steps list because no agent can be selected.
    state.presentation.stages[0].startedAt = iso(2);
    Object.assign(state.actions[0], { status: 'running', startedAt: iso(2), attempts: 1 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    const row = dashboardRows(home)[0];
    const agentPane = renderWorkflowTui(row, { width: 120, height: 30, focus: 1 });
    assert.match(plain(agentPane), /no agent has started in this phase yet/);
    assert.match(plain(agentPane), /planned steps in this phase:/);
    assert.doesNotMatch(agentPane, /undefined/);
    assert.match(agentPane, /shell-and-visual-system · work · running/);
    assert.match(agentPane, /space-and-spaces · work · pending/);

    // The evidence stage names its actions by the role the kernel gives them.
    const evidencePane = renderWorkflowTui(row, { width: 120, height: 30, focus: 1, phaseIndex: 1 });
    assert.doesNotMatch(evidencePane, /undefined/);
    assert.match(evidencePane, /verify-surfaces · evidence · pending/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a V2 run whose kernel died is not reported as running', async () => {
  // Regression: V2 states recorded no runner pid or heartbeat, and
  // reconcileInterruptedRun skipped V2 entirely, so a kernel that died left
  // state.json saying "running" forever. Observed live on run zx9vni, which
  // showed "running · 0/6 actions" for 17 minutes with no process alive.
  const { v2RunnerLiveness } = await import('../src/workflow/short-id.js');
  const at = (ms) => new Date(ms).toISOString();
  const now = 1_000_000_000_000;
  const v2 = (status, runner) => ({
    schemaVersion: 'bullswarm.workflow.state.v2', lifecycle: { status }, runner,
  });

  const live = v2('running', { pid: 4242, startedAt: at(now - 60_000), lastHeartbeatAt: at(now - 1_000) });
  assert.equal(v2RunnerLiveness(live, { now, processAlive: () => true }).alive, true);

  // The exact shape of the reported failure: process gone, state still active.
  const dead = v2RunnerLiveness(live, { now, processAlive: () => false });
  assert.equal(dead.alive, false);
  assert.match(dead.reason, /runner process 4242 is gone/);

  // Alive pid but a heartbeat that stopped advancing is also not running.
  const wedged = v2RunnerLiveness(
    v2('running', { pid: 4242, startedAt: at(now - 600_000), lastHeartbeatAt: at(now - 300_000) }),
    { now, processAlive: () => true },
  );
  assert.equal(wedged.alive, false);
  assert.match(wedged.reason, /has not updated the run/);

  // A caller-planner pause is ownerless by design and must never be flagged.
  assert.equal(v2RunnerLiveness(v2('waiting', null), { now, processAlive: () => false }).alive, true);
  for (const status of ['completed', 'partial', 'cancelled', 'failed']) {
    assert.equal(v2RunnerLiveness(v2(status, null), { now, processAlive: () => false }).alive, true);
  }

  // No runner record and no run directory: no evidence, so no accusation.
  assert.equal(v2RunnerLiveness(v2('running', null), { now, processAlive: () => false }).alive, true);

  // A run directory whose state.json went silent for longer than the legacy
  // window is the only signal available for pre-heartbeat runs.
  const home = mkdtempSync(join(tmpdir(), 'bs-liveness-'));
  try {
    writeFileSync(join(home, 'state.json'), '{}');
    const fresh = v2RunnerLiveness(v2('running', null), { now: Date.now(), processAlive: () => false, runDir: home });
    assert.equal(fresh.alive, true, 'a just-written state is not stale');
    const stale = v2RunnerLiveness(v2('running', null), { now: Date.now() + 3_600_000, processAlive: () => false, runDir: home });
    assert.equal(stale.alive, false);
    assert.match(stale.reason, /no heartbeat recorded/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('program dashboard projects saved categories into dependency levels with overlapping activity', () => {
  const goal = createV2GoalDocument({ goal: 'Research docs', cwd: '/tmp',
    requirements: [{ id: 'correct', text: 'Correct comparison' }], settings: { scout: false, executionMode: 'program' } });
  const state = createV2State(goal, { runId: 'wf-levels-abcdef', shortId: 'lv1234' });
  state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
  state.program = { actions: [
    { id: 'fast', purpose: 'Read docs', dependsOn: [], ownedFiles: ['a.md'] },
    { id: 'slow', purpose: 'Research docs', dependsOn: [], ownedFiles: ['b.md'] },
    { id: 'next', purpose: 'Write comparison', dependsOn: ['fast'], ownedFiles: ['result.md'] },
  ] };
  state.actions = [
    { id: 'fast', status: 'succeeded', startedAt: iso(1), finishedAt: iso(2) },
    { id: 'slow', status: 'running', startedAt: iso(1) },
    { id: 'next', status: 'running', startedAt: iso(3) },
  ];
  state.presentation.stages = [{ id: 'old', label: 'Documentation', actionIds: ['fast', 'slow', 'next'], startedAt: iso(1) }];
  const row = { state, events: [{ type: 'presentation.stage_started', committedAt: iso(1), payload: { label: 'Documentation' } }] };
  const before = JSON.stringify(state);
  const model = workflowPanelModel(row);
  assert.deepEqual(model.phases.map((phase) => phase.status), ['active', 'active']);
  for (const width of [60, 120]) {
    const screen = renderWorkflowTui(row, { width, height: 40 });
    assert.match(screen, /Phase 1/);
    assert.match(screen, /Phase 2/);
    // The phases are the program's dependency groups, never keyword-inferred.
    assert.doesNotMatch(screen, /Documentation/);
    assert.match(plain(renderWorkflowTui(row, { width, height: 40, mobileTimeline: false })), /── phases · 2/);
  }
  assert.equal(JSON.stringify(state), before);
});

// A running worker has no durable finish event, so the timeline used to show
// only its level's "├─ started" row for the whole time it ran while the Live
// pane counted its elapsed time. The level must list the worker with the
// spinner and the same live duration, without counting it as a milestone.
test('V2 timeline lists a running worker under its level with a spinner and live elapsed time', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2-live-'));
  try {
    const runId = 'wf-v2live-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2l234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    state.presentation.stages[0].startedAt = iso(2);
    state.presentation.stages[0].completedAt = iso(5);
    Object.assign(state.actions[0], { status: 'succeeded', startedAt: iso(2), finishedAt: iso(5), attempts: 1 });
    state.attempts.push({ id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: iso(5) });
    // appendEvent stamps committedAt with the wall clock; this fixture needs the
    // durable history to predate the worker that is still running, as it does
    // in a real run, so events are written with explicit timestamps.
    let sequence = 0;
    const emit = (type, committedAt, payload) => {
      sequence += 1;
      appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ sequence, type, schemaVersion: 1, payload, committedAt })}\n`);
      state.events.sequence = sequence;
    };
    emit('workflow.started', iso(0), {});
    emit('planner.finished', iso(1), { turn: 1, ok: true, summary: 'Implement then collect independent evidence.' });
    emit('presentation.stage_started', iso(2), { stageId: 'r1-implementation', label: 'Implementation' });
    emit('action.finished', iso(5), { actionId: 'implement-result', status: 'succeeded' });
    emit('presentation.stage_completed', iso(5), { stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1 });
    // the evidence level has started but its worker has not been dispatched yet
    state.presentation.stages[1].startedAt = iso(6);
    emit('presentation.stage_started', iso(6), { stageId: 'r1-evidence', label: 'Evidence' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const before = renderWorkflowTui(dashboardRows(home)[0], { width: 120, height: 30 });
    const milestones = /── timeline ─+ (\d+) milestones? ──/.exec(before)[1];
    assert.match(segmentRows(before, 'Evidence').join('\n'), /├─ started/);
    assert.doesNotMatch(segmentRows(before, 'Evidence').join('\n'), /check-result/);

    // the worker starts 65 seconds ago and is still running
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    Object.assign(state.actions[1], { status: 'running', startedAt, attempts: 1 });
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay:b', model: 'gpt-5.6-luna', startedAt, finishedAt: null, lastActivityAt: startedAt, outputBytesObserved: 42 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const running = renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 0 });
    const evidence = segmentRows(running, 'Evidence').map(normalizeRow);
    assert.equal(evidence[0], 'HH:MM ├─ started');
    assert.match(evidence[1], /^HH:MM │ ├─⠋ check-result 1m0[5-9]s$/, evidence.join('\n'));
    // the spinner animates with the frame counter like the Live pane
    assert.match(segmentRows(renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 3 }), 'Evidence').join('\n'), /├─⠸ check-result/);
    // a live row is not a durable milestone
    assert.equal(/── timeline ─+ (\d+) milestones? ──/.exec(running)[1], milestones);
    // the level header still reads running rather than a finished duration
    assert.equal(timelineSegments(running).find((segment) => segment.label === 'Evidence').elapsed, 'running');

    // the agent pane leads with the elapsed time; token usage only exists once the attempt finishes
    const agents = renderWorkflowTui(row, { width: 130, height: 22, focus: 1, spinnerFrame: 0 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.match(agents, /check-result · relay:b · gpt-5\.6-luna · #1 · 1m0[5-9]s/);
    assert.doesNotMatch(agents, /#1 · pending/);
    // Token usage only arrives when an attempt finishes, so a running worker's
    // row carries its elapsed time and no token count at all.
    assert.doesNotMatch(agents, /check-result[^\n]*tok/);

    // once the worker finishes, its durable row replaces the live one
    const finishedAt = new Date().toISOString();
    Object.assign(state.actions[1], { status: 'succeeded', finishedAt });
    state.attempts[1] = { ...state.attempts[1], status: 'succeeded', finishedAt, usage: { tokens: { totalKnown: 1200 } } };
    emit('evidence.recorded', finishedAt, { actionId: 'check-result', requirements: ['result-correct'], statuses: { 'result-correct': 'passed' } });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const done = renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 120, height: 30 });
    const doneRows = segmentRows(done, 'Evidence').map(normalizeRow);
    assert.equal(doneRows.filter((line) => line.includes('check-result')).length, 1, doneRows.join('\n'));
    assert.match(doneRows.join('\n'), /├─✓ check-result 1m0[5-9]s/);
    assert.match(renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 130, height: 22, focus: 1, phaseIndex: 1 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), /#1 · 1\.2k tok · 1m0[5-9]s/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('V2 attempt rows and the agent pane show the applied reasoning level next to the model', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-reasoning-'));
  try {
    const runId = 'wf-v2reas-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
      workerRouting: { reasoning: 'xhigh' },
    });
    let state = createV2State(goal, { runId, shortId: 'v2r234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', reasoning: 'max', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    state.presentation.stages[0].startedAt = iso(2);
    state.presentation.stages[0].completedAt = iso(5);
    Object.assign(state.actions[0], { status: 'succeeded', startedAt: iso(2), finishedAt: iso(5), attempts: 1 });
    // Finished attempt: the action's own override was applied.
    state.attempts.push({
      id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'succeeded',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: iso(5),
      reasoning: { requested: 'max', applied: 'max', source: 'action', clamped: false },
      routing: { reason: 'most-behind capable pool', candidates: [], effort: 'low', lane: 'build' },
    });
    state.presentation.stages[1].startedAt = iso(6);
    Object.assign(state.actions[1], { status: 'running', startedAt: iso(6), attempts: 1 });
    // Running attempt: the run-wide level was clamped to what the connector takes.
    state.attempts.push({
      id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running',
      pool: 'relay:b', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null,
      reasoning: { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const live = renderWorkflowTui(row, { width: 120, height: 30 });
    // The live row shows the level the running worker is actually thinking at.
    assert.match(live, /check-result · relay:b · gpt-5\.6-luna · high/);
    // Phase 1 holds the finished attempt; its own override reads next to the model.
    const phaseOne = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 });
    assert.match(plain(phaseOne), /implement-result · relay · gpt-5\.6-luna · max · #1/);
    // The drilled-in agent pane states it as a labelled field beside effort.
    const agentPane = plain(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(agentPane, /succeeded · gpt-5\.6-luna · max/);
    // The V2 tier lives under attempt.routing; both fields read correctly.
    assert.match(agentPane, /relay · attempt 1 · effort low · reasoning max/);
    // Narrow mode keeps the same fact on the single full-width agent pane.
    const narrow = plain(renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 1, agentIndex: 0 }));
    assert.match(narrow, /gpt-5\.6-luna · max/);
    // The durable record is what observation reads, so JSON carries it too.
    assert.deepEqual(
      dashboardJson(home, { token: 'v2r234' }).state.attempts.map((attempt) => attempt.reasoning.applied),
      ['max', 'high'],
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('attempts without a reasoning record render exactly as before', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-noreasoning-'));
  try {
    const runId = 'wf-v2plain-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2p234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    Object.assign(state.actions[0], { status: 'running', startedAt: iso(2), attempts: 1 });
    state.presentation.stages[0].startedAt = iso(2);
    state.attempts.push({
      id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'running',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: null, reasoning: null,
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const live = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.match(live, /implement-result · relay · gpt-5\.6-luna\s+\d/);
    assert.doesNotMatch(live, /gpt-5\.6-luna · /);
    const pane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 });
    assert.match(pane, /implement-result · relay · gpt-5\.6-luna · #1/);
    const agentPane = plain(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(agentPane, /relay · attempt 1 · effort auto/);
    assert.doesNotMatch(agentPane, /reasoning/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Rendering behaviours that outlived the V1 executor.
//
// The authored-graph removal deleted the tests that drove workflowPanelModel
// and renderWorkflowTui with a V1 state shape, but the behaviours they covered
// are still live for V2 runs: blocked-action naming, one segment header per
// phase change, the mid-segment continuation header, parallel work grouped in
// declared level order, the narrow layout, and auto-follow. The fixtures below
// rebuild those situations out of a real durable V2 state plus real durable
// events, so the assertions are ported and the V1 state shape is not.
// ---------------------------------------------------------------------------

// appendEvent stamps committedAt from the wall clock. These fixtures run on the
// fixed `iso()` clock instead, which each event carries in its payload, so the
// durable JSONL is written for real and read back at its fixture time.
function durableEvents(dir) {
  return readEvents(dir).map((event) => ({
    ...event,
    committedAt: event.payload?.committedAt ?? event.committedAt,
  }));
}

const v2Action = (overrides) => ({
  dependsOn: [], affects: [], ownedFiles: [], prompt: 'Do it.',
  lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  ...overrides,
});

// One accepted V2 program on disk: durable state.json plus the two events every
// run opens with. The caller fills in action outcomes and emits the rest.
function newV2Run({
  runId, shortId, goal, actions, settings = {}, summary = 'One bounded program.',
  requirements = [{ id: 'requirement-1', text: 'The goal is delivered.', mandatory: true }],
}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2render-'));
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const document = createV2GoalDocument({
    goal, cwd: home, requirements, settings: { scout: false, ...settings },
  });
  let state = createV2DurableState(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary,
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
  });
  state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
  state.planner.attempts.push({
    ordinal: 1, turn: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna',
    startedAt: iso(2), finishedAt: iso(10),
  });
  const emit = (type, committedAt, payload = {}) => appendEvent(dir, state, type, { ...payload, committedAt });
  emit('workflow.started', iso(0));
  emit('planner.finished', iso(10), { turn: 1, ok: true, summary });
  const byId = Object.fromEntries(state.actions.map((action) => [action.id, action]));
  const succeed = (id, from, to) => {
    Object.assign(byId[id], { status: 'succeeded', startedAt: iso(from), finishedAt: iso(to), attempts: 1 });
    state.attempts.push({
      id: `${id}-1`, actionId: id, ordinal: 1, status: 'succeeded',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(from), finishedAt: iso(to),
    });
  };
  const start = (id, from) => {
    Object.assign(byId[id], { status: 'running', startedAt: iso(from), attempts: 1 });
    state.attempts.push({
      id: `${id}-1`, actionId: id, ordinal: 1, status: 'running',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(from), finishedAt: null,
    });
  };
  // The row the dashboard would build for this run: durable state read back
  // from disk, durable events read back from the JSONL.
  const row = () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const durable = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    return {
      runId, shortId, status: durable.lifecycle.status, runDir: dir,
      state: durable, events: durableEvents(dir),
    };
  };
  return {
    home, dir, state, byId, emit, succeed, start, row,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const segmentLabels = (screen) => timelineSegments(screen).map((segment) => segment.label);

// Preflight, a finished Discovery phase, and a running Implementation phase.
// The Evidence phase is planned but never started, so it never opens a segment.
function segmentedV2Run() {
  const run = newV2Run({
    runId: 'wf-segment-aaaaaa', shortId: 'sgm234',
    goal: 'Discover, implement, then prove it.',
    summary: 'Discover, implement, prove.',
    actions: [
      v2Action({ id: 'discover-a', purpose: 'Discover the inputs', lane: 'analyze', produces: ['inputs'] }),
      v2Action({ id: 'discover-b', purpose: 'Discover the outputs', lane: 'analyze', produces: ['outputs'] }),
      v2Action({ id: 'implement-a', purpose: 'Implement the module', ownedFiles: ['src/a.js'], dependsOn: ['discover-a'], inputs: ['inputs'], produces: ['module'], affects: ['requirement-1'] }),
      v2Action({ id: 'implement-b', purpose: 'Implement the adapter', ownedFiles: ['src/b.js'], dependsOn: ['discover-b'], inputs: ['outputs'], produces: ['adapter'], affects: ['requirement-1'] }),
      v2Action({ id: 'verify-all', purpose: 'Prove every requirement', lane: 'analyze', dependsOn: ['implement-a', 'implement-b'], inputs: ['module', 'adapter'], evidenceFor: ['requirement-1'] }),
    ],
  });
  run.succeed('discover-a', 20, 80);
  run.succeed('discover-b', 20, 90);
  run.succeed('implement-a', 160, 220);
  run.start('implement-b', 230);
  run.state.presentation.stages[0].startedAt = iso(20);
  run.state.presentation.stages[0].completedAt = iso(150);
  run.state.presentation.stages[1].startedAt = iso(160);
  run.emit('presentation.stage_started', iso(20), { stageId: 'r1-discovery', label: 'Discovery' });
  run.emit('action.finished', iso(80), { actionId: 'discover-a', status: 'succeeded' });
  run.emit('action.finished', iso(90), { actionId: 'discover-b', status: 'succeeded' });
  run.emit('presentation.stage_completed', iso(150), { stageId: 'r1-discovery', label: 'Discovery', status: 'completed', completed: 2, total: 2 });
  run.emit('presentation.stage_started', iso(160), { stageId: 'r1-implementation', label: 'Implementation' });
  run.emit('action.finished', iso(220), { actionId: 'implement-a', status: 'succeeded' });
  return run;
}

// One phase with more rows than any short viewport holds.
function longPhaseV2Run() {
  const works = Array.from({ length: 12 }, (_, index) => v2Action({
    id: `work-${index}`, purpose: `Implement work ${index}`,
    ownedFiles: [`src/work-${index}.js`], produces: [`artifact-${index}`], affects: ['requirement-1'],
  }));
  const run = newV2Run({
    runId: 'wf-longphase-aaaaaa', shortId: 'lng234',
    goal: 'Render more rows than the viewport holds.',
    actions: [
      ...works,
      v2Action({ id: 'work-tail', purpose: 'Implement the tail', ownedFiles: ['src/tail.js'], produces: ['artifact-tail'], affects: ['requirement-1'] }),
      v2Action({
        id: 'verify-all', purpose: 'Prove every requirement', lane: 'analyze',
        dependsOn: [...works.map((action) => action.id), 'work-tail'],
        inputs: [...works.map((_, index) => `artifact-${index}`), 'artifact-tail'],
        evidenceFor: ['requirement-1'],
      }),
    ],
  });
  run.state.presentation.stages[0].startedAt = iso(20);
  run.emit('presentation.stage_started', iso(20), { stageId: 'r1-implementation', label: 'Implementation' });
  works.forEach((action, index) => {
    run.succeed(action.id, 60 + index * 120, 120 + index * 120);
    run.emit('action.finished', iso(120 + index * 120), { actionId: action.id, status: 'succeeded' });
  });
  run.start('work-tail', 60 + 12 * 120);
  return run;
}

test('a dependency level whose action never dispatched names the dependency that blocked it', () => {
  const run = newV2Run({
    runId: 'wf-blocked-aaaaaa', shortId: 'blk234',
    goal: 'Harden the core after proving it.',
    summary: 'Implement, prove, then harden.',
    settings: { executionMode: 'program' },
    requirements: [
      { id: 'requirement-1', text: 'The core is correct.', mandatory: true },
      { id: 'requirement-2', text: 'The core is hardened.', mandatory: false },
    ],
    actions: [
      v2Action({ id: 'implement-core', purpose: 'Implement the core', ownedFiles: ['src/core.js'], produces: ['core'], affects: ['requirement-1'] }),
      v2Action({ id: 'verify-core', purpose: 'Prove the core', lane: 'analyze', dependsOn: ['implement-core'], inputs: ['core'], produces: ['core-report'], evidenceFor: ['requirement-1'] }),
      v2Action({ id: 'harden-core', purpose: 'Harden the core', ownedFiles: ['src/harden.js'], dependsOn: ['verify-core'], inputs: ['core-report'], affects: ['requirement-2'] }),
    ],
  });
  try {
    run.succeed('implement-core', 60, 120);
    Object.assign(run.byId['verify-core'], {
      status: 'failed', startedAt: iso(130), finishedAt: iso(190), attempts: 1,
      lastFailure: { kind: 'verdict', message: 'the core report is not passing' },
    });
    run.state.attempts.push({
      id: 'verify-core-1', actionId: 'verify-core', ordinal: 1, status: 'failed',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(130), finishedAt: iso(190),
    });
    // A blocked action is marked terminal without ever being started: the
    // scheduler records finishedAt and the dependency failure, and no attempt
    // is ever appended for it.
    Object.assign(run.byId['harden-core'], {
      status: 'blocked', startedAt: null, finishedAt: iso(195),
      lastFailure: { kind: 'dependency', message: 'dependency verify-core did not succeed' },
    });
    run.emit('action.finished', iso(120), { actionId: 'implement-core', status: 'succeeded' });
    run.emit('action.finished', iso(190), { actionId: 'verify-core', status: 'failed' });
    run.emit('action.finished', iso(195), { actionId: 'harden-core', status: 'blocked', why: 'dependency verify-core did not succeed' });
    run.state.ledger.requirements['requirement-1'].status = 'failed';
    run.state.lifecycle = { status: 'partial', startedAt: iso(0), finishedAt: iso(200), resultFile: null };
    const row = run.row();

    const model = workflowPanelModel(row, { phaseIndex: 2 });
    const blockedLevel = model.phases[2];
    assert.equal(blockedLevel.label, 'Phase 3 · harden-core');
    assert.deepEqual(blockedLevel.blockedActions, [
      { id: 'harden-core', kind: 'action', blockedBy: ['verify-core'] },
    ]);
    // Never dispatched means no attempt, so the agent list is empty and the
    // pane must explain the absence rather than claim nothing started yet.
    assert.deepEqual(model.agents, []);
    assert.deepEqual(model.phases[0].blockedActions, []);
    assert.deepEqual(model.phases[1].blockedActions, []);

    const agents = plain(renderWorkflowTui(row, { width: 120, height: 30, phaseIndex: 2, focus: 1 }));
    assert.match(agents, /⊘ harden-core · never dispatched · blocked by verify-core/);
    assert.doesNotMatch(agents, /Not started yet/);

    const detail = plain(renderWorkflowTui(row, { width: 120, height: 30, phaseIndex: 2, focus: 2 }));
    assert.match(detail, /⊘ harden-core · work · never dispatched/);
    assert.match(detail, /blocked by verify-core/);

    // The timeline marks the same action with ⊘, never with the ✓ a finished
    // action carries or the × a dispatched failure carries.
    const timeline = timelinePaneRows(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 2 }));
    assert.match(timeline.join('\n'), /├─⊘ harden-core/);
    assert.match(timeline.join('\n'), /├─× verify-core/);
  } finally { run.cleanup(); }
});

test('the timeline opens one segment header per phase change instead of prefixing every event line', () => {
  const run = segmentedV2Run();
  try {
    const screen = renderWorkflowTui(run.row(), { width: 120, height: 44 });
    const pane = timelinePaneRows(screen);

    // One header per phase change, in chronological order, none repeated
    // between two events of the same phase.
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discovery', 'Implementation']);
    assert.equal(pane.filter((line) => /^─{2,}\s+Phase 1 · Discovery\s/.test(line)).length, 1);

    // The event lines themselves no longer name their phase.
    assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
    assert.deepEqual(pane.filter((line) => /\[(Discovery|Implementation|Preflight):? ?[^\]]*\]/.test(line)), []);

    // Glyphs, action names, timestamps and right-aligned durations survive.
    // (timestamps render in the local zone, so only their shape is asserted)
    assert.deepEqual(segmentRows(screen, 'Discovery').map(normalizeRow), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ discover-a 1m00s',
      'HH:MM │ ├─✓ discover-b 1m10s',
      'HH:MM └─✓ completed 2/2',
    ]);

    // The running phase keeps its started row, shows its live worker, and
    // reports no completion.
    const implementation = segmentRows(screen, 'Implementation').join('\n');
    assert.match(implementation, /├─ started/);
    assert.match(implementation, /├─✓ implement-a\s+1m00s/);
    assert.match(implementation, /├─.\simplement-b/);
    assert.deepEqual(segmentRows(screen, 'Implementation').filter((line) => line.includes('completed')), []);
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Implementation').elapsed, 'running');
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Discovery').elapsed, '2m10s');

    // Every blank separator inside the timeline introduces a segment header.
    pane.forEach((line, index) => {
      if (line.trim() || index === pane.length - 1) return;
      const next = pane[index + 1];
      assert.ok(!next.trim() || /^─{2,}/.test(next), `blank row ${index} is not a segment separator: ${next}`);
    });

    // A planned phase that never started opens no segment at all.
    assert.equal(workflowPanelModel(run.row()).phases[2].label, 'Evidence');
    assert.deepEqual(segmentLabels(screen).filter((label) => label === 'Evidence'), []);
  } finally { run.cleanup(); }
});

test('parallel dependency levels stay grouped in declared level order', () => {
  const run = newV2Run({
    runId: 'wf-parallel-aaaaaa', shortId: 'par234',
    goal: 'Interleave two dependency levels in time.',
    summary: 'Two independent builds, then two proofs.',
    settings: { executionMode: 'program', concurrency: 2 },
    requirements: [
      { id: 'requirement-1', text: 'The module works.', mandatory: true },
      { id: 'requirement-2', text: 'The adapter works.', mandatory: true },
    ],
    actions: [
      v2Action({ id: 'implement-a', purpose: 'Implement the module', ownedFiles: ['src/a.js'], produces: ['a'], affects: ['requirement-1'] }),
      v2Action({ id: 'implement-b', purpose: 'Implement the adapter', ownedFiles: ['src/b.js'], produces: ['b'], affects: ['requirement-2'] }),
      v2Action({ id: 'verify-a', purpose: 'Prove the module', lane: 'analyze', dependsOn: ['implement-a'], inputs: ['a'], evidenceFor: ['requirement-1'] }),
      v2Action({ id: 'verify-b', purpose: 'Prove the adapter', lane: 'analyze', dependsOn: ['implement-b'], inputs: ['b'], evidenceFor: ['requirement-2'] }),
    ],
  });
  try {
    // Levels overlap in wall-clock time: level 2's first proof finishes before
    // level 1's second build does.
    run.succeed('implement-a', 60, 120);
    run.succeed('verify-a', 150, 180);
    run.succeed('implement-b', 210, 240);
    run.succeed('verify-b', 250, 280);
    run.emit('action.finished', iso(120), { actionId: 'implement-a', status: 'succeeded' });
    run.emit('evidence.recorded', iso(180), { actionId: 'verify-a', status: 'succeeded' });
    run.emit('action.finished', iso(240), { actionId: 'implement-b', status: 'succeeded' });
    run.emit('evidence.recorded', iso(280), { actionId: 'verify-b', status: 'succeeded' });
    for (const requirement of Object.values(run.state.ledger.requirements)) requirement.status = 'passed';
    run.state.lifecycle = { status: 'completed', startedAt: iso(0), finishedAt: iso(300), resultFile: null };
    const row = run.row();

    // The durable events really are interleaved; the grouping is the renderer's.
    assert.deepEqual(
      row.events.filter((event) => event.payload.actionId).map((event) => event.payload.actionId),
      ['implement-a', 'verify-a', 'implement-b', 'verify-b'],
    );

    const screen = renderWorkflowTui(row, { width: 120, height: 40 });
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Parallel work', 'Parallel analysis']);
    assert.deepEqual(segmentRows(screen, 'Parallel work').map(normalizeRow), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ implement-a 1m00s',
      'HH:MM │ ├─✓ implement-b 30s',
      'HH:MM └─✓ completed 2/2',
    ]);
    assert.deepEqual(segmentRows(screen, 'Parallel analysis').map(normalizeRow).slice(0, 4), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ verify-a 30s',
      'HH:MM │ ├─✓ verify-b 30s',
      'HH:MM └─✓ completed 2/2',
    ]);
    // Phase 2 opened while phase 1 was still running: the clock column proves
    // the rows were reordered by declared phase, not by time.
    const clock = (label, index) => segmentRows(screen, label)[index].slice(0, 5);
    assert.ok(clock('Parallel work', 2) > clock('Parallel analysis', 0),
      `level 1's second worker should postdate level 2's start:\n${timelinePaneRows(screen).join('\n')}`);
    // A program's phases are its dependency groups: no keyword phase prefix.
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
  } finally { run.cleanup(); }
});

test('a timeline viewport that starts mid-segment re-emits a continuation header', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    // With room for every row the phase is introduced once and never continued.
    const tall = renderWorkflowTui(row, { width: 100, height: 60 });
    assert.deepEqual(segmentLabels(tall), ['Preflight', 'Implementation']);
    assert.deepEqual(timelinePaneRows(tall).filter((line) => line.includes('continued')), []);

    const short = renderWorkflowTui(row, { width: 100, height: 34 });
    const pane = timelinePaneRows(short);
    const marker = pane.findIndex((line) => line.includes('earlier timeline rows'));
    assert.ok(marker >= 0, `expected a scrolled viewport:\n${pane.join('\n')}`);
    // The scrolled-into segment is re-announced before its first visible event,
    // and the first visible event is a timestamped milestone, never an orphaned
    // detail row.
    assert.match(pane[marker + 1], /^─{2,}\s+Phase 1 · Implementation · continued\s+─{2,}/);
    assert.match(pane[marker + 2], /^\d{2}:\d{2}\s/);
    assert.deepEqual(segmentLabels(short), ['Implementation · continued']);
    assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
  } finally { run.cleanup(); }
});

test('the timeline auto-follows the newest event until the viewer scrolls back', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    const following = renderWorkflowTui(row, { width: 100, height: 34 });
    const pane = timelinePaneRows(following);
    // Auto-follow ends on the newest event — the running worker — and never
    // claims there is anything newer below the viewport.
    assert.match(pane.filter((line) => line.trim()).at(-1), /work-tail/);
    assert.deepEqual(pane.filter((line) => line.includes('newer timeline rows')), []);
    assert.match(frameHeader(following), /^ lng234 /);

    // Scrolling back holds older rows in place and says how much is newer.
    const scrolled = timelinePaneRows(renderWorkflowTui(row, { width: 100, height: 34, detailScroll: 4 }));
    assert.match(scrolled.at(-1), /↓ 4 newer timeline rows/);
    assert.deepEqual(scrolled.filter((line) => line.includes('work-tail')), []);
    assert.match(scrolled[0], /↑ \d+ earlier timeline rows/);
    // The continuation header travels with the scrolled viewport too.
    assert.match(scrolled[1], /^─{2,}\s+Phase 1 · Implementation · continued\s+─{2,}/);
  } finally { run.cleanup(); }
});

test('narrow timeline rendering keeps the segment headers and never overflows the pane', () => {
  const run = segmentedV2Run();
  const long = longPhaseV2Run();
  try {
    const row = run.row();
    // Tall enough that the whole timeline fits: nothing here is a scroll artifact.
    const screen = renderWorkflowTui(row, { width: 60, height: 60 });
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discovery', 'Implementation']);
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
    assert.match(segmentRows(screen, 'Discovery').join('\n'), /├─✓ discover-a/);
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Implementation').elapsed, 'running');

    // Headers obey the narrow width like every other row, on every narrow pane
    // the viewer can open.
    const overflow = (rendered, width) => plain(rendered)
      .split('\n').filter((line) => [...line].length > width);
    for (const width of [60, 52, 44]) {
      for (const options of [
        { focus: 0 }, { focus: 0, mobileTimeline: false }, { focus: 1 }, { focus: 2 },
        { focus: 0, timelineSelection: 0 }, { focus: 0, orchestratorDetail: true }, { focus: 0, workflowVerbose: true },
      ]) {
        const narrow = renderWorkflowTui(row, { width, height: 26, ...options });
        assert.deepEqual(overflow(narrow, width), [], `width ${width} ${JSON.stringify(options)} overflowed`);
      }
    }

    // And the narrow viewport re-emits the continuation header when it scrolls.
    const scrolled = renderWorkflowTui(long.row(), { width: 60, height: 34 });
    const narrowPane = timelinePaneRows(scrolled);
    const marker = narrowPane.findIndex((line) => line.includes('earlier timeline'));
    assert.ok(marker >= 0, `expected a scrolled narrow viewport:\n${narrowPane.join('\n')}`);
    assert.match(narrowPane[marker + 1], /^─{2,}\s+Phase 1 · Implementation · continue/);
    assert.deepEqual(overflow(scrolled, 60), []);
  } finally { run.cleanup(); long.cleanup(); }
});

test('a narrow terminal wraps the agent detail pane to its full width, not the sidebar remainder', () => {
  const { home, cleanup } = fixture();
  try {
    const row = dashboardRows(home)[0];
    const contentWidths = (screen) => plain(screen).split('\n').map((line) => line.trimEnd().length);
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 });
    // The step and the pool it ran on are both named, each on its own row of
    // the label/value table the page now is.
    assert.match(plain(narrow), /audit-files · run abc234/);
    assert.match(plain(narrow), /Pool {6}planner-agent/);
    const widest = Math.max(...contentWidths(narrow));
    // 60 columns minus the 34-column sidebar minus padding is 22: the width the
    // detail used to wrap at even though the narrow pane spans the whole screen.
    assert.ok(widest > 22, `narrow detail still wraps at ${widest} columns`);
    assert.ok(widest <= 60, `narrow detail overflows the frame: ${widest} columns`);
    const wide = plain(renderWorkflowTui(row, { width: 120, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(wide, /audit-files · run abc234/);
    assert.match(wide, /Pool {6}planner-agent/);
    // And no panel border survives on either: the page is flat rules now.
    for (const line of `${wide}\n${plain(narrow)}`.split('\n')) {
      assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
        `a panel border survived: ${line}`);
    }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The pages the mod asked for: the Usage page with its meter windows, rungs,
// tabs and read-only note; the Home install button; the mouse; and the setup
// hand-off. Each page is a pure function of a model, so every expectation
// below is a frame the terminal would paint verbatim.
// ---------------------------------------------------------------------------

test('the Budget page draws every pool meter, its money and what still fits', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage, rollups: rollupFixture(), prices: { subscriptions: {} } });
  const frame = renderDashboardPage(model, { page: 'budget', width: 100, height: 40 });
  const text = plain(frame.lines.join('\n'));

  assert.match(frameHeader(text), /^ Budget · \d+ days to /);
  assert.match(text, /relay · weekly plan/);
  // The reworked pool rows (requirement 8): the used meter, the blank shares
  // with their reasons, the room row, and the money line with its basis.
  assert.match(text, /no measured usage rate yet/);
  assert.match(text, /27% of the window gone/);
  assert.match(text, /64 of 70 credits/);
  // Money is the recorded estimate, labelled, and the undeclared plan price is
  // a blank with the reason — never a number.
  assert.match(text, /≈ \$0\.42 of API-equivalent work/);
  assert.match(text, /Declare a price: bullswarm strategy set-subscription/);
  // The notes sit above the nav, and the nav is still whole.
  assert.match(plain(frame.lines.at(-1)), /\[ quit \]/);
});

test('Home keeps all three period choices on their own clickable row at 55 columns', () => {
  const model = dashboardModel(null, { usage: usageFixture(), rollups: rollupFixture() });
  const frame = renderDashboardPage(model, { page: 'home', width: 55, height: 100, period: '7d' });
  const lines = frame.lines.map(plain);
  const toggleRow = lines.findIndex((line) => line.includes('Last 7 days') && line.includes('All time'));
  assert.ok(toggleRow >= 0, lines.join('\n'));
  assert.ok(lines[toggleRow - 1].startsWith('── last 7 days '), lines.join('\n'));
  assert.deepEqual(frame.regions
    .filter((region) => region.y === toggleRow + 1 && region.action.kind === 'period')
    .map((region) => region.action.period), ['7d', '30d', 'all']);
});

test('Stats Pools loads retained meter-history days and leaves older days blank with a reason', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-dashboard-'));
  try {
    const historyDir = join(home, 'meters', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'relay.jsonl'), [
      JSON.stringify({ captured_at: '2026-09-14T12:00:00Z', weekly: { utilization: 20 } }),
      JSON.stringify({ captured_at: '2026-09-15T12:00:00Z', weekly: { utilization: 25 } }),
    ].join('\n'));
    const pools = [{ name: 'relay', enabled: true, pacingWindow: 'weekly', usedPct: 25, elapsedPct: 30 }];
    const rollups = [{ runId: 'wf-old', startedAt: '2026-08-20T00:00:00Z', finishedAt: '2026-08-20T01:00:00Z', pools: {} }];
    const history = readLicencePerDay(home, pools, {
      period: '30d', now: Date.parse('2026-09-16T12:00:00Z'), rollups,
    });
    assert.ok(history.rows.some((row) => row.date === '2026-09-14' && row.segments[0]?.value === 20));
    assert.ok(history.rows.some((row) => row.date === '2026-08-18' && row.segments.length === 0));
    assert.match(history.reason, /earlier days in 30d are blank/);

    const model = dashboardModel(null, {
      usage: { pools, assignments: [], rungs: [] }, rollups, period: '30d', meterHistory: history,
    });
    const text = plain(renderDashboardPage(model, {
      page: 'stats', statsTab: 'pools', period: '30d', width: 120, height: 100,
    }).lines.join('\n'));
    assert.doesNotMatch(text, /meter history is not loaded/);
    assert.match(text, /2026-09-14/);
    assert.match(text, /earlier days in 30d are blank/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Stats Pools marks the day a pool\u2019s quota window reset, and ignores the jitter in resets_at', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-reset-'));
  try {
    const historyDir = join(home, 'meters', 'history');
    mkdirSync(historyDir, { recursive: true });
    // The provider restates the same boundary with sub-second jitter on every
    // read; only the 09-16 line moves the window a week on, which is a reset.
    writeFileSync(join(historyDir, 'relay.jsonl'), [
      JSON.stringify({ captured_at: '2026-09-14T12:00:00Z', weekly: { utilization: 60, resets_at: '2026-09-16T05:00:00.449022+00:00' } }),
      JSON.stringify({ captured_at: '2026-09-15T12:00:00Z', weekly: { utilization: 90, resets_at: '2026-09-16T05:00:00.112700+00:00' } }),
      JSON.stringify({ captured_at: '2026-09-16T12:00:00Z', weekly: { utilization: 8, resets_at: '2026-09-23T05:00:00.803155+00:00' } }),
    ].join('\n'));
    const pools = [{ name: 'relay', enabled: true, pacingWindow: 'weekly', usedPct: 8, elapsedPct: 12 }];
    const history = readLicencePerDay(home, pools, {
      period: '7d', now: Date.parse('2026-09-16T18:00:00Z'), rollups: [],
    });
    const on = (date) => history.rows.find((row) => row.date === date)?.segments[0];
    assert.equal(on('2026-09-14')?.reset, undefined);
    assert.equal(on('2026-09-15')?.reset, undefined);
    assert.equal(on('2026-09-16')?.reset, true);
    assert.equal(on('2026-09-16')?.resetsAt, '2026-09-23T05:00:00.803155+00:00');

    const model = dashboardModel(null, {
      usage: { pools, assignments: [], rungs: [] }, rollups: [], period: '7d', meterHistory: history,
    });
    const text = plain(renderDashboardPage(model, {
      page: 'stats', statsTab: 'pools', period: '7d', width: 120, height: 100,
    }).lines.join('\n'));
    const row = text.split('\n').find((line) => line.includes('relay') && line.includes('%'));
    assert.match(row, /\u258f/, row);
    assert.match(text, /a drop after \u258f is the window resetting/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the Fleet page draws the rungs under its two tabs, with the read-only note', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage });
  const byLane = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30 });
  const text = plain(byLane.lines.join('\n'));
  assert.match(frameHeader(text), /^ Fleet · by lane$/);
  assert.match(text, /by lane\s+by provider\s+\[ edit \]/);
  assert.match(text, /read-only here · edit opens bullswarm setup/);
  assert.match(text, /gpt-5\.6-luna · high/);
  assert.match(text, /3 runs · 67% ok · p50 12m/);

  const byProvider = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30, fleetBy: 'provider' });
  const providerText = plain(byProvider.lines.join('\n'));
  assert.match(frameHeader(providerText), /^ Fleet · by provider$/);
  assert.match(providerText, /by lane\s+by provider/);
  assert.match(providerText, /relay/);
});

test('meters are background-coloured cells on Budget, and no plain bar survives', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage, rollups: rollupFixture() });
  const budget = renderDashboardPage(model, { page: 'budget', width: 100, height: 40 }).lines.join('\n');
  // #b6bd73 below 50% used, #e9c880 from 50%, #bf6c69 from 80%, track #3a3a3a.
  assert.ok(budget.includes('\x1b[48;2;182;189;115m'), 'the green fill is a background-coloured cell');
  assert.ok(budget.includes('\x1b[48;2;58;58;58m'), 'the track is a background-coloured cell');
  assert.match(budget, /\x1b\[38;2;255;255;255m▏/, 'the elapsed mark is a white ▏');
});

test('the Runs integration line offers [install] until every agent is installed, then reads [installed ✓]', () => {
  const offered = renderDashboardPage(dashboardModel(null, {
    runs: [],
    integration: {
      ok: false,
      agents: [
        { agent: 'codex', skill: { status: 'installed' }, awareness: true },
        { agent: 'claude', skill: { status: 'missing' }, awareness: false, mod: { status: 'missing' }, hooksFlag: false },
      ],
    },
  }), { page: 'help', width: 100, height: 60 });
  const text = offered.lines.join('\n');
  // Requirement 7: the agents block lives on Help now, not Runs.
  assert.match(text, /agent integration\s+\[install\]/);
  assert.match(text, /codex\s+skill ✓ · awareness ✓/);
  assert.match(text, /claude\s+skill — · awareness — · mod — · hooks —/);
  const install = offered.regions.find((region) => region.action.kind === 'install');
  assert.equal(plain(offered.lines[install.y - 1]).slice(install.x1 - 1, install.x2), '[install]');

  const done = renderDashboardPage(dashboardModel(null, {
    runs: [],
    integration: {
      ok: true,
      agents: [{ agent: 'claude', skill: { status: 'installed' }, awareness: true, mod: { status: 'installed' }, hooksFlag: true }],
    },
  }), { page: 'help', width: 100, height: 60 });
  const doneText = done.lines.join('\n');
  assert.match(doneText, /\[installed ✓\]/);
  assert.match(doneText, /claude\s+skill ✓ · awareness ✓ · mod ✓ · hooks ✓/);
  assert.equal(done.regions.some((region) => region.action.kind === 'install'), false, 'the button is inert once everything is installed');
});

test('a mouse click runs the same action its key does, and the wheel moves the window', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // A short terminal, so the Home body is taller than its window.
    const session = shellSession(home, { columns: 100, rows: 14 });
    // The wheel walks the body window down and the header reports it.
    const before = frameHeader(lastFrame(session.output));
    session.press('\x1b[<65;10;6M');
    const scrolled = frameHeader(lastFrame(session.output));
    assert.match(scrolled, / · \d+–\d+\/\d+$/);
    assert.notEqual(scrolled, before);

    clickOn(session, '[ 2.bbb222 ]');
    assert.match(frameHeader(lastFrame(session.output)), / bbb222 running/);
    // The tab row is clickable, and every tab opens the page its key opens.
    clickOn(session, 'Budget');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    clickOn(session, 'Fleet');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · edit opens bullswarm setup/);
    // Fleet's own sub-tab click is the same move Tab makes.
    clickOn(session, 'by provider');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · by provider$/);
    session.press('\t');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · by lane$/);

    // Esc goes Home; its run rows are clickable, and so are its step glyphs.
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, '1.aaa111');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    // `build-alpha ` with its trailing space: the plan band also names
    // `build-alpha-evidence`, and a bare prefix would click that instead.
    clickOn(session, 'build-alpha ');
    const step = lastFrame(session.output);
    assert.match(frameHeader(step), /build-alpha · run aaa111/);
    assert.equal(navButtons(step)[0], 'back');
    clickOn(session, '[ back ]');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { cleanup(); }
});

test('Runs history jump reaches the first day without creating an unbounded scroll area', () => {
  const model = dashboardModel(null, { days: dayFixture().slice(0, 1) });
  const options = { page: 'runs', width: 120, height: 50 };
  const first = renderDashboardPage(model, options);
  const offset = first.anchor.history - 1;
  const jumped = renderDashboardPage(model, { ...options, bodyScroll: offset });
  assert.equal(jumped.body.offset, offset);
  assert.match(plain(jumped.lines[2]), /^── .* ──/);
  const beyond = renderDashboardPage(model, { ...options, bodyScroll: 100000 });
  assert.equal(beyond.body.total, first.body.total);
  assert.equal(beyond.body.offset, offset);
});

test('a Trends column opens History at its first bucket day', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30 });
    session.press('s');
    clickOn(session, 'Trends');
    const today = new Date();
    const label = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][today.getDay()]} ${today.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][today.getMonth()]}`;
    assert.ok(plain(lastFrame(session.output)).includes(label), `trend chart did not paint today's bucket: ${label}`);
    clickOn(session, label);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · /);
    assert.ok(plain(lastFrame(session.output)).includes(label), 'History did not land on the clicked bucket day');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('a finished run opened from Budget remains selected across two refreshes', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // A legacy connector JSON is enough to give Budget one real pool without
    // loading any packaged providers in this isolated test home.
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'relay.json'), JSON.stringify({ name: 'relay', lanes: ['build'] }));
    const finishedAt = new Date().toISOString();
    writeV2Run(home, {
      runId: 'wf-zzz', shortId: 'zzz999', goal: 'Rebuild the dashboard shell', status: 'completed',
      startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt,
    });
    const session = shellSession(home, { columns: 120, rows: 36, refreshMs: 10 });
    session.press('b');
    await settle();
    assert.ok(plain(lastFrame(session.output)).includes('zzz999'), 'Budget did not paint the finished workflow');
    clickOn(session, 'zzz999');
    assert.match(frameHeader(lastFrame(session.output)), /zzz999 completed/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.match(frameHeader(lastFrame(session.output)), /zzz999 completed/, 'refresh lost the finished selection');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('the Runs [install] button installs the agent integration in-process', async () => {
  const { home, cleanup } = shellFixture();
  const agentHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-integrate-'));
  try {
    const session = shellSession(home, { columns: 100, rows: 60, homeDir: agentHome });
    session.press('?');
    assert.match(plain(lastFrame(session.output)), /\[install\]/);
    session.press('i');
    const frame = plain(lastFrame(session.output));
    // The status line reflects it, and every agent's result is shown inline:
    // the skill, the awareness block, and for Claude the mod and hooks flag.
    assert.match(frame, /agent integration\s+\[installed ✓\]/);
    assert.match(frame, /install results/);
    assert.match(frame, /codex · skill installed · awareness installed/);
    assert.match(frame, /claude · skill installed · awareness installed · mod linked · hooks flag set/);
    assert.match(frame, /grok · skill installed · awareness installed/);
    assert.equal(await session.quit(), 0);
    assert.equal(existsSync(join(agentHome, '.codex', 'skills', 'bullswarm')), true);
  } finally { cleanup(); rmSync(agentHome, { recursive: true, force: true }); }
});

test('the [edit] button pauses the dashboard for setup and resumes on the Fleet page', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const handoffs = [];
    const openSetupTui = async ({ bullswarmDir, input, output }) => {
      handoffs.push({ bullswarmDir, isTTY: input.isTTY, painted: output.text.length });
    };
    const session = shellSession(home, { columns: 100, rows: 26, token: 'wf-alpha', openSetupTui });
    session.press('f');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    const before = session.output.text.length;
    session.press('e');
    await settle();
    await settle();

    assert.equal(handoffs.length, 1, 'the injected control centre ran once');
    assert.equal(handoffs[0].bullswarmDir, home);
    const handover = session.output.text.slice(before);
    // The terminal is handed over cleanly: mouse reporting and the cursor
    // restored, the alternate screen left.
    assert.ok(handover.includes('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'), 'the dashboard did not release the terminal');
    // And taken back: alternate screen, hidden cursor, mouse reporting on.
    assert.ok(handover.includes('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h'), 'the dashboard did not take the terminal back');
    assert.deepEqual(session.input.rawModes, [true, false, true]);
    // It returns to the Fleet page with the note and a fresh repaint.
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · edit opens bullswarm setup/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The three things the 0.33.0 acceptance asks of the shell: every key reaches
// its page or its action, every clickable atom runs the same action its key
// runs, and no money or licence figure is ever painted as a bare number.
// ---------------------------------------------------------------------------

test('every key in the table reaches its page or its action', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30 });
    const header = () => frameHeader(lastFrame(session.output));
    const screen = () => plain(lastFrame(session.output));

    // r b s y f ? — one key per page; y is Runs at its History table.
    for (const [key, expected] of [
      ['r', /^ bullswarm · runs/],
      ['b', /^ Budget · /],
      ['s', /^ Stats · overview/],
      ['y', /^ bullswarm · runs · /],
      ['f', /^ Fleet · by lane/],
      ['?', /^ bullswarm · help/],
    ]) {
      session.press(key);
      assert.match(header(), expected, `${key} did not open its page`);
      session.press(ESC_KEY);
      assert.match(header(), /^ bullswarm · home/, `Esc did not come back from ${key}`);
    }
    session.press('?');
    assert.match(header(), /^ bullswarm · help/);

    // 1–9 open the run that carries that digit in the nav.
    session.press('1');
    assert.match(header(), / aaa111 running/);
    session.press('2');
    assert.match(header(), / bbb222 running/);
    session.press('9');
    assert.match(screen(), /no run 9 in flight/);

    // Esc and the left arrow both walk out, step -> run -> home.
    session.press('\r');
    session.press('\r');
    assert.match(header(), /build-beta · run bbb222/);
    session.press('\x1b[D');
    assert.match(header(), / bbb222 running/);
    session.press(ESC_KEY);
    session.press(ESC_KEY);
    assert.match(header(), /^ bullswarm · home/);

    // Tab walks the sub-tabs of the pages that have them, and says so on the
    // pages that do not.
    session.press('s');
    assert.match(header(), /^ Stats · overview/);
    session.press('\t');
    assert.match(header(), /^ Stats · trends/);
    session.press('\t');
    assert.match(header(), /^ Stats · pools/);
    session.press('f');
    session.press('\t');
    assert.match(header(), /^ Fleet · by provider/);
    session.press(ESC_KEY);
    session.press('\t');
    assert.match(screen(), /Tab walks the sub-tabs on Stats and Fleet/);

    // Shift+Tab still cycles workflows.
    session.press('1');
    assert.match(header(), / aaa111 running/);
    session.press(`${ESC_KEY}[Z`);
    assert.match(header(), / bbb222 running/);
    session.press(ESC_KEY);

    // p cycles the period, and every page drawn over one follows it.
    session.press('p');
    assert.match(screen(), /Period · Last 30 days/);
    session.press('p');
    assert.match(screen(), /Period · All time/);
    session.press('p');
    assert.match(screen(), /Period · Last 7 days/);

    // The movement keys walk the body window, and Home/End jump it.
    session.press('h'); // a page long enough to scroll
    const top = header();
    session.press('\x1b[B');
    session.press('j');
    const moved = header();
    assert.notEqual(moved, top, 'down/j did not move the window');
    session.press('\x1b[A');
    session.press('k');
    assert.equal(header(), top, 'up/k did not come back');
    session.press('\x1b[6~'); // PgDn
    assert.notEqual(header(), top, 'PgDn did not move the window');
    session.press('\x1b[H'); // Home
    assert.equal(header(), top, 'Home did not go back to the top');
    session.press('\x1b[F'); // End
    assert.match(header(), / · \d+–\d+\/\d+$/);
    session.press('\x1b[5~'); // PgUp
    session.press('\x1b[H');
    assert.equal(header(), top);

    // ctrl+s copies the painted screen, and says how it carried it.
    session.press('\x13');
    assert.match(screen(), /screen copied \(OSC 52\) · \d+ lines/);
    assert.match(session.output.text, /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);

    // q quits, and never asks a kernel to stop.
    assert.equal(await session.quit(), 0);
    assert.equal(existsSync(join(home, 'workflows', 'wf-alpha', 'cancellation.json')), false);
  } finally { cleanup(); }
});

test('a pending stop still takes y, and Help says so', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30, token: 'wf-alpha' });
    session.press('c');
    assert.match(plain(lastFrame(session.output)), /Stop this workflow\? y confirm/);
    session.press('y');
    assert.match(plain(lastFrame(session.output)), /Stop requested for aaa111/);
    assert.equal(existsSync(join(home, 'workflows', 'wf-alpha', 'cancellation.json')), true);
    // And with no question on the screen, y is Runs at its History table.
    session.press('y');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · /);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('ctrl+s falls back to the local clipboard, and the message names the tool', () => {
  const calls = [];
  const run = (tool, args, options) => { calls.push({ tool, args, input: options.input }); return { status: 0 }; };
  assert.deepEqual(
    writeClipboard('two\nlines', { platform: 'darwin', env: {}, run }),
    { ok: true, tool: 'pbcopy' },
  );
  assert.deepEqual(calls, [{ tool: 'pbcopy', args: [], input: 'two\nlines' }]);

  const wayland = [];
  assert.deepEqual(
    writeClipboard('x', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run: (tool, args, options) => { wayland.push(tool); return { status: 0 }; },
    }),
    { ok: true, tool: 'wl-copy' },
  );
  assert.deepEqual(wayland, ['wl-copy']);

  // A machine with neither says so rather than claiming a copy that never was.
  const none = writeClipboard('x', { platform: 'linux', env: {}, run: () => ({ status: 1 }) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no pbcopy, wl-copy or xclip/);

  // A tool that fails is reported as a failure, not as a copy.
  const failing = writeClipboard('x', { platform: 'darwin', env: {}, run: () => ({ error: new Error('nope') }) });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /pbcopy failed/);
});

test('every clickable atom runs the same action its key runs', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // Each pair is [what to click, the key that does the same thing].
    const session = shellSession(home, { columns: 120, rows: 30 });
    const header = () => frameHeader(lastFrame(session.output));
    for (const [needle, key, expected] of [
      ['Runs', 'r', /^ bullswarm · runs/],
      ['Budget', 'b', /^ Budget · /],
      ['Stats', 's', /^ Stats · overview/],
      ['Runs', 'y', /^ bullswarm · runs · /],
      ['Fleet', 'f', /^ Fleet · by lane/],
      ['Home', null, /^ bullswarm · home/],
    ]) {
      session.press(ESC_KEY);
      clickOn(session, needle);
      const clicked = header();
      assert.match(clicked, expected, `clicking ${needle} did not open its page`);
      if (!key) continue;
      session.press(ESC_KEY);
      session.press(key);
      if (key === 'y') {
        // y opens Runs at its first day header; the tab click opens it at the
        // top, so the pair is compared by page and filter, not scroll offset.
        assert.match(header(), /^ bullswarm · runs · /, `clicking ${needle} and pressing ${key} disagree`);
        assert.equal(header().replace(/ · [\d–]+\/\d+$/, ''), clicked.replace(/ · [\d–]+\/\d+$/, ''),
          `clicking ${needle} and pressing ${key} disagree`);
        continue;
      }
      assert.equal(header(), clicked, `clicking ${needle} and pressing ${key} disagree`);
    }

    // A run button and its digit are the same action.
    session.press(ESC_KEY);
    clickOn(session, '[ 2.bbb222 ]');
    const byClick = header();
    session.press(ESC_KEY);
    session.press('2');
    assert.equal(header(), byClick);

    // A Home tile opens the chart of the metric it shows: the spend tile
    // carries today's recorded estimate, and clicking it charts spend.
    session.press(ESC_KEY);
    clickOn(session, '≈ $0.42');
    assert.match(header(), /^ Stats · trends/);

    // The period toggle is the same move p makes.
    session.press(ESC_KEY);
    clickOn(session, 'Last 30 days');
    const afterClick = plain(lastFrame(session.output));
    assert.match(afterClick, /Last 30 days/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('with no declared price and no measured licence rate, no bare number is painted', () => {
  // The state of every pool on a real machine today: a live meter, no
  // `spend.pacing.ratePerMinute`, no declared subscription price, and
  // `normalizedQuota.estimatedPercent` null on every attempt.
  const usage = usageFixture();
  for (const pool of usage.pools) delete pool.spend;
  const rollups = rollupFixture().map((record) => ({
    ...record,
    pools: Object.fromEntries(Object.entries(record.pools)
      .map(([name, entry]) => [name, { ...entry, costUsd: null }])),
  }));
  const model = dashboardModel(null, { usage, rollups, days: dayFixture(), prices: { subscriptions: {} } });

  for (const page of ['home', 'budget', 'stats', 'history']) {
    for (const width of [120, 54]) {
      const text = plain(renderDashboardPage(model, { page, width, height: 40 }).lines.join('\n'));
      // Every money figure on screen carries its ≈ and its basis; a figure
      // with no source is a blank with the reason beside it.
      for (const match of text.matchAll(/\$\s?[\d.]+/g)) {
        const before = text.slice(Math.max(0, match.index - 2), match.index);
        assert.ok(before.includes('≈'), `${page} at ${width} painted a bare ${match[0]}: ${before}${match[0]}`);
      }
      // And no licence percent is claimed for a run or a pool without a rate.
      assert.doesNotMatch(text, /≈ \d+\.\d+% of its/, `${page} at ${width} claimed a licence share with no measured rate`);
    }
  }

  // Home says why each blank tile is blank rather than printing a zero. The
  // phone layout gives each tile its own row, so the whole reason is there.
  const home = plain(renderDashboardPage(model, { page: 'home', width: 54, height: 40 }).lines.join('\n'));
  assert.match(home, /no finished run recorded an estimate/);
  // Budget says what is missing and how to declare it. The reworked pool rows
  // (requirement 8) put the blank-with-reason inline: no measured rate, and
  // the declare-price command in the notes.
  const budget = plain(renderDashboardPage(model, { page: 'budget', width: 120, height: 40 }).lines.join('\n'));
  assert.match(budget, /no measured usage rate yet/);
  assert.match(budget, /API estimate unrecorded/);
  assert.match(budget, /Declare a price: bullswarm strategy set-subscription/);
});

test('a run with no recorded estimate and no measured rate paints blanks, not zeroes', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) delete pool.spend;
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    const text = plain(renderDashboardPage(model, {
      page: 'run', width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    assert.match(text, /no attempt recorded an API-equivalent estimate/);
    // Requirement 8: an unmetered pool is one line of words, never a track.
    assert.match(text, /free model · no licence meter/);
    assert.match(text, /— ETA —: build-alpha, build-alpha-evidence have no recorded duration yet/);
    assert.doesNotMatch(text, /\$0\.00/);
  } finally { cleanup(); }
});

test('the Step page writes an unmetered pool in words, never a dotted track', () => {
  // Requirement 8 applies to every page, not just Run: the owner's Step frame
  // showed `opencode ······················  — · —`.
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) delete pool.spend;
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    for (const width of [55, 120, 170, 200]) {
      const lines = plain(renderDashboardPage(model, {
        page: 'step', width, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
        phaseIndex: 0, agentIndex: 0,
      }).lines.join('\n')).split('\n');
      for (const line of lines) {
        assert.ok(!/·{6,}/.test(line), `${width} kept a dotted track: ${line}`);
      }
      const budget = lines.findIndex((line) => /^── budget ─/.test(line));
      assert.ok(budget >= 0, lines.join('\n'));
      assert.match(lines[budget + 1], /free model · no licence meter/, `${width}: ${lines[budget + 1]}`);
    }
  } finally { cleanup(); }
});

test('a paused run\u2019s live block says how to continue it, not that it is waiting', () => {
  // Requirement 8: the owner's screenshot showed `waiting for the next
  // dispatch` under a run that was paused, which reads as \u201cany moment now\u201d.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    state.lifecycle.status = 'paused';
    delete state.lifecycle.finishedAt;
    for (const attempt of state.attempts ?? []) {
      if (attempt.status === 'running') attempt.status = 'cancelled';
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage: usageFixture() });
    // The band is three columns at 120, so the sentence needs the wide frame to
    // be read whole; both widths must have dropped `waiting for the next
    // dispatch`.
    const wide = plain(renderDashboardPage(model, {
      page: 'run', width: 200, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    assert.match(wide, /paused · bullswarm workflow resume \w+ continues it/, wide);
    for (const width of [55, 120, 200]) {
      const text = plain(renderDashboardPage(model, {
        page: 'run', width, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
      }).lines.join('\n'));
      assert.match(text, /paused · bullswarm workflow resume/, text);
      assert.doesNotMatch(text, /waiting for the next dispatch/, text);
    }
  } finally { cleanup(); }
});

test('an explicitly recorded "estimatedUsd: null" stays blank and is never counted as priced', () => {
  // The shape the real corpus actually writes: the attempt has a cost object
  // and the figure inside it is null.  Number(null) is 0 and Number.isFinite(0)
  // is true, so a bare Number() here paints "≈ $0.00 · 2 of 2 attempts priced"
  // for a run that priced nothing.  Observed live on 2026-09-17 against run
  // ahvsda, whose ten attempts all record estimatedUsd: null.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    for (const attempt of state.attempts) {
      attempt.usage = { cost: { estimatedUsd: null, breakdown: null, basis: 'unknown: no model rate metadata' } };
      attempt.wallSec = null;
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) pool.spend = { pacing: { window: 'weekly', ratePerMinute: null, source: null, samples: 0 } };
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    for (const page of ['run', 'step']) {
      const text = plain(renderDashboardPage(model, {
        page, width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
      }).lines.join('\n'));
      assert.doesNotMatch(text, /\$0\.00/, `${page} manufactured a zero from a null estimate`);
      assert.doesNotMatch(text, /attempts priced/, `${page} counted a null estimate as priced`);
      assert.match(text, /no attempt recorded an API-equivalent estimate|recorded no estimate/);
      // A null ratePerMinute is a blank share, never 0.00%.
      assert.doesNotMatch(text, /≈ 0\.00% of its/, `${page} claimed a zero licence share`);
    }
  } finally { cleanup(); }
});

test('Home paints in under 50 ms with 293 run directories present', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-perf-'));
  try {
    // The corpus this machine actually has: 293 run directories, each with a
    // state.json far too big to parse on a 1 s timer, and the index that is
    // read instead.
    mkdirSync(join(home, 'history'), { recursive: true });
    const filler = 'x'.repeat(20_000);
    const records = [];
    for (let index = 0; index < 293; index += 1) {
      const runId = `wf-perf-${String(index).padStart(4, '0')}`;
      const shortId = `p${String(index).padStart(5, '0')}`;
      const dir = join(home, 'workflows', runId);
      mkdirSync(dir, { recursive: true });
      const finishedAt = new Date(Date.now() - index * 3_600_000).toISOString();
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId,
        lifecycle: { status: 'completed', startedAt: finishedAt, finishedAt },
        intent: { goal: `perf run ${index}`, cwd: '/tmp' },
        actions: [], attempts: [], planner: { status: 'completed', turns: 1, attempts: [] },
        presentation: { stages: [] }, ledger: { requirements: {} }, notes: filler,
      }));
      // A finished run writes rollup.json, which is how the refresh path knows
      // it never has to open that state.json again.
      writeFileSync(join(dir, 'rollup.json'), '{}');
      records.push(JSON.stringify({
        schemaVersion: 'bullswarm.workflow.rollup.v1', runId, shortId,
        project: 'bullswarm', goal: `perf run ${index}`, startedAt: finishedAt, finishedAt,
        status: 'completed', verified: index % 2 === 0, requirements: { passed: 1, total: 1 },
        minutes: { wall: 10 + (index % 30), agent: 12 },
        pools: { relay: { attempts: 1, minutes: 10, costUsd: 0.01, tokens: 100 } },
        models: { luna: { attempts: 1, minutes: 10 } }, legacy: false,
      }));
    }
    writeFileSync(join(home, 'history', 'runs.jsonl'), `${records.join('\n')}\n`);

    const runs = activeDashboardRows(home);
    assert.deepEqual(runs, [], 'a finished run is never parsed on the refresh path');
    const rollups = readRollups(home);
    assert.equal(rollups.length, 293, 'the index carries every finished run');

    // The measurement: one whole Home paint, model and render, over the index.
    const paint = () => renderDashboardPage(
      dashboardModel(null, { runs, rollups, days: [] }),
      { page: 'home', width: 120, height: 40 },
    );
    const frame = paint();
    assert.ok(frame.lines.length > 0, 'Home painted nothing');
    // The best of five: this suite runs its files in parallel, so a single
    // wall-clock sample measures the machine's load as much as the paint.
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const start = process.hrtime.bigint();
      paint();
      best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
    }
    assert.ok(best < 50, `Home took ${best.toFixed(1)}ms with 293 run directories`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an ascii terminal gets ascii: no substituted glyph survives on a page the shell draws', () => {
  const { home, cleanup } = shellFixture();
  const before = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows.find((entry) => entry.runId === 'wf-alpha'), {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      rollups: rollupFixture(),
      days: dayFixture(),
    });
    // Fleet is left out: `[● by lane]` is fleet-view's own literal, reported
    // to the integrator rather than patched from another territory.
    for (const page of ['home', 'runs', 'run', 'step', 'budget', 'stats', 'history', 'help']) {
      for (const width of [120, 54]) {
        const text = plain(renderDashboardPage(model, {
          page, width, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
        }).lines.join('\n'));
        for (const glyph of SUBSTITUTED_GLYPHS) {
          assert.ok(!text.includes(glyph), `${page} at ${width} painted ${glyph} in ascii mode`);
        }
        for (const line of text.split('\n')) {
          assert.ok([...line].length <= width, `${page} at ${width} overflowed in ascii mode`);
        }
      }
    }
  } finally {
    if (before === undefined) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = before;
    cleanup();
  }
});

test('History loads seven more days each time the reader nears the bottom', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-history-'));
  try {
    // Thirty days of finished runs, one a day: more than the seven History
    // opens with, so scrolling has something to load.
    mkdirSync(join(home, 'history'), { recursive: true });
    mkdirSync(join(home, 'workflows'), { recursive: true });
    const records = [];
    for (let back = 0; back < 30; back += 1) {
      const at = new Date(Date.now() - back * 86_400_000).toISOString();
      records.push(JSON.stringify({
        schemaVersion: 'bullswarm.workflow.rollup.v1',
        runId: `wf-day-${back}`, shortId: `d${String(back).padStart(5, '0')}`,
        project: 'bullswarm', goal: `run ${back}`, startedAt: at, finishedAt: at,
        status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
        minutes: { wall: 10, agent: 12 },
        pools: { relay: { attempts: 1, minutes: 10, costUsd: 0.01, tokens: 10 } },
        models: { luna: { attempts: 1, minutes: 10 } }, legacy: false,
      }));
    }
    writeFileSync(join(home, 'history', 'runs.jsonl'), `${records.join('\n')}\n`);

    const session = shellSession(home, { columns: 100, rows: 20 });
    session.press('y');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · \S+ · 7 days/);
    // End is the bottom of what is loaded, so the next scroll asks for more.
    session.press('\x1b[F');
    session.press('\x1b[6~');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · \S+ · (14|21) days/);
    assert.equal(await session.quit(), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 0.33.0 visual fidelity: the composition the approved prototype frames draw.
//
// Home, Run, Step and Help are asserted against what the frames in
// docs/design/prototype-frames/ actually contain — the four-column breakdown
// band, the `── budget · this week ──` block, the flat Run page, the Step
// label/value table and the grouped Help rows — at the three widths the pass
// is judged at. The numbers stay the product's own; only the shape is pinned.
// ---------------------------------------------------------------------------

/** The model the fidelity assertions render, with real rollups and meters. */
function fidelityModel() {
  const { home, cleanup } = shellFixture();
  const rows = dashboardRows(home, { all: true });
  const row = rows.find((entry) => entry.runId === 'wf-alpha');
  const model = dashboardModel(row, {
    runs: rows.filter((entry) => entry.ongoing),
    usage: usageFixture(),
    rollups: rollupFixture(),
    days: dayFixture(),
    prices: { subscriptions: {} },
  });
  return { home, rows, row, model, cleanup };
}

const FIDELITY_SIZES = [[120, 40], [55, 26], [200, 50]];

test('phone Home keeps four named pools, separate breakdown rows and whole percentages', () => {
  const f = fidelityModel();
  try {
    const names = ['claude-code:acme', 'claude-code', 'codex', 'grok'];
    f.model.budget.rows = names.map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    for (const key of ['pools', 'models', 'projects']) {
      f.model.stats.overview.breakdown[key] = names.map((name) => ({ name, minutesShare: 0.24 }));
    }
    f.model.stats.overview.today.apiEquivalentUsd = null;
    for (const width of [55, 60]) {
      const text = plain(renderDashboardPage(f.model, { page: 'home', width, height: 150 }).lines.join('\n'));
      const budget = text.split('budget · this week')[1].split('last 7 days')[0];
      for (const name of names) assert.ok(budget.includes(name), budget);
      assert.match(text, /no estimate today/);
      const lines = text.split('\n');
      for (const heading of ['by pool', 'by model', 'by project']) {
        const at = lines.findIndex((line) => line.trim() === heading);
        assert.ok(at > 0);
        for (const row of lines.slice(at + 1, at + 4)) assert.match(row.trim(), /24%$/);
      }
      for (const label of ['Busiest project', 'Favourite model', 'Median run']) {
        assert.ok(lines.some((line) => line.startsWith(` ${label}:`)), text);
      }
    }
  } finally { f.cleanup(); }
});

test('the Home budget block says how many metered pools it left out', () => {
  const f = fidelityModel();
  try {
    const names = ['claude-code:acme', 'claude-code', 'codex', 'grok', 'command-code', 'opencode'];
    f.model.budget.rows = names.map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    for (const width of [55, 60, 120, 200]) {
      const text = plain(renderDashboardPage(f.model, { page: 'home', width, height: 150 }).lines.join('\n'));
      const block = text.split('budget · this week')[1].split('last 7 days')[0];
      // Four pools are drawn and the two it dropped are counted in words, so
      // the block never reads as “those are all my pools”.
      for (const name of names.slice(0, 4)) assert.ok(block.includes(name), `${name} missing at ${width}: ${block}`);
      assert.match(block, /\+2 more metered pools · b opens Budget/, `${width}: ${block}`);
    }
    // Exactly four: nothing was left out, so nothing is counted.
    f.model.budget.rows = names.slice(0, 4).map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    const four = plain(renderDashboardPage(f.model, { page: 'home', width: 55, height: 150 }).lines.join('\n'));
    assert.doesNotMatch(four.split('budget · this week')[1].split('last 7 days')[0], /more metered pool/);
    // Five: singular.
    f.model.budget.rows = names.slice(0, 5).map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    const five = plain(renderDashboardPage(f.model, { page: 'home', width: 55, height: 150 }).lines.join('\n'));
    assert.match(five.split('budget · this week')[1].split('last 7 days')[0], /\+1 more metered pool · b opens Budget/);
  } finally { f.cleanup(); }
});

test('no page paints past the width or comes up blank at 120x40, 55x26 and 200x50', () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      for (const name of DASHBOARD_PAGE_NAMES) {
        const frame = renderDashboardPage(f.model, {
          page: name, width, height, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
          phaseIndex: 0, agentIndex: 0,
        });
        const painted = paintedRows(frame.lines.join('\n'));
        for (const line of painted) {
          assert.ok([...line].length <= width, `${name} at ${width}x${height} painted ${[...line].length} columns: ${line}`);
        }
        assert.ok(painted.filter((line) => line.trim()).length >= 3, `${name} at ${width}x${height} came up blank`);
        assert.match(plain(painted.at(-1)), /\[/, `${name} at ${width}x${height} lost its nav`);
      }
    }
  } finally { f.cleanup(); }
});

test("Home's 7-day breakdown is four columns on one band at 120 and 200, and one column at 55", () => {
  const f = fidelityModel();
  try {
    const bandOf = (width) => {
      const frame = renderDashboardPage(f.model, {
        page: 'home', width, height: 90, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
      });
      const lines = paintedRows(frame.lines.join('\n')).map(plain);
      const head = lines.findIndex((line) => /spent per day/.test(line));
      assert.ok(head >= 0, `no breakdown band at ${width} columns:\n${lines.join('\n')}`);
      return { lines, head };
    };
    // 120 and 200: the four headings share one row, in the prototype's order.
    for (const width of [120, 200]) {
      const { lines, head } = bandOf(width);
      assert.match(lines[head], /spent per day.*by pool.*by model.*by project/,
        `the four columns did not share a row at ${width}`);
      // And the bars under them are proportional to the percentage beside them.
      const pool = lines.slice(head + 1, head + 5).find((line) => /\d+%$/.test(line.trim()));
      const share = Number(/(\d+)%$/.exec(pool.trim())[1]);
      const bar = /([▇█]+)[░\s]*\s\d+%$/.exec(pool.trim());
      const track = /([▇█]+)([░]*)\s\d+%$/.exec(pool.trim());
      assert.ok(bar, `no bar beside the percentage at ${width}: ${pool}`);
      const filled = track[1].length;
      const cells = filled + track[2].length;
      assert.ok(Math.abs(filled / cells - share / 100) <= 0.12,
        `the bar is ${filled}/${cells} cells for ${share}% at ${width}: ${pool}`);
    }
    // 55: the same four sections, one under the other.
    const narrow = bandOf(55);
    assert.doesNotMatch(narrow.lines[narrow.head], /by pool/, 'the phone kept four columns on one row');
    for (const heading of ['by pool', 'by model', 'by project']) {
      assert.ok(narrow.lines.slice(narrow.head).some((line) => line.trim().startsWith(heading)),
        `the phone lost the ${heading} column`);
    }
  } finally { f.cleanup(); }
});

test('Home phone tiles and every live step keep their bars on one row', () => {
  const f = fidelityModel();
  try {
    const running = f.model.runs[0];
    running.state.actions = [
      { ...running.state.actions[0], id: 'first-live-action', status: 'running' },
      { ...running.state.actions[0], id: 'second-live-action', status: 'running' },
    ];
    const frame = renderDashboardPage(f.model, {
      page: 'home', width: 54, height: 120, rows: f.rows, allRows: f.rows,
    });
    const lines = paintedRows(frame.lines.join('\n')).map(plain);
    const today = lines.slice(lines.findIndex((line) => /── today/.test(line)) + 1,
      lines.findIndex((line) => /── running/.test(line))).filter((line) => line.trim());
    assert.equal(today.filter((line) => /^ finished\s/.test(line)).length, 1);
    assert.equal(today.filter((line) => /^ spent\s/.test(line)).length, 1);
    assert.ok(today.length <= 4, today.join('\n'));
    for (const id of ['first-live-action', 'second-live-action']) {
      const row = lines.find((line) => line.includes(id));
      assert.ok(row, `missing ${id}`);
      assert.match(row, /░{4,}.*\/—/, `missing indeterminate bar: ${row}`);
    }
    for (const line of lines) {
      assert.ok([...line].length <= 54, line);
      for (const match of line.matchAll(/\$/g)) {
        assert.match(line.slice(Math.max(0, match.index - 2), match.index), /≈/, line);
      }
    }
  } finally { f.cleanup(); }
});

test("Home's budget block meters every pool and prints no bare number with no declared price", () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      const text = plain(renderDashboardPage(f.model, {
        page: 'home', width, height: Math.max(height, 90), rows: f.rows, allRows: f.rows,
      }).lines.join('\n'));
      assert.match(text, /── budget · this week ─/, `no budget block at ${width}`);
      // Inside the block every money figure is either an estimate carrying its
      // ≈ or money at a declared subscription rate, and the block says which.
      const rows = text.split('\n');
      const from = rows.findIndex((line) => /── budget · this week ─/.test(line));
      const to = rows.findIndex((line, index) => index > from && /^── /.test(line));
      const block = rows.slice(from, to < 0 ? rows.length : to).join('\n');
      const declared = block.includes('at the declared subscription price');
      for (const match of block.matchAll(/\$\s?[\d.]+/g)) {
        const before = block.slice(Math.max(0, match.index - 2), match.index);
        assert.ok(before.includes('≈') || declared,
          `the budget block at ${width} painted a bare ${match[0]} with no basis`);
      }
      // The reason is said once for the block, not once per pool row.
      const reasons = block.split('\n').filter((line) => /no declared subscription price/.test(line));
      assert.equal(reasons.length, 1, `the declare-a-price reason was repeated at ${width}`);
      assert.match(block, /bullswarm strategy set-subscription/,
        `the block at ${width} did not say how to declare a price`);
    }
  } finally { f.cleanup(); }
});

test('Run and Step draw no box-drawing panel at any of the three widths', () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      for (const page of ['run', 'step']) {
        for (const focus of page === 'run' ? [0, 1] : [2]) {
          const text = plain(renderDashboardPage(f.model, {
            page, width, height, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
            focus, phaseIndex: 0, agentIndex: 0,
          }).lines.join('\n'));
          for (const line of text.split('\n')) {
            assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
              `${page} at ${width} kept a panel border: ${line}`);
          }
        }
      }
    }
    // Run carries the prototype's triptych, and Step its label/value table.
    const run = plain(renderDashboardPage(f.model, {
      page: 'run', width: 120, height: 40, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    assert.match(run, /── licence this run used ─.*── live ─.*── so far ─/, 'the Run triptych is not one row band');
    assert.match(run, /── plan ─/);
    assert.match(run, /── timeline ─/);
    // And says `no recorded duration yet` once, not twice (requirement 8's
    // `ETA —:` wording).
    assert.equal(run.split('\n').filter((line) => /no recorded duration yet/.test(line)).length, 1);
    const step = plain(renderDashboardPage(f.model, {
      page: 'step', width: 120, height: 40, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
      focus: 2, phaseIndex: 0, agentIndex: 0,
    }).lines.join('\n'));
    for (const field of ['Status', 'Pool', 'Purpose', 'Time']) {
      assert.match(step, new RegExp(`^ ${field}\\s{2,}\\S`, 'm'), `Step lost its ${field} row`);
    }
    for (const section of ['budget', 'task · first lines', 'output', 'artifacts']) {
      assert.match(step, new RegExp(`── ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ─`), `Step lost its ${section} section`);
    }
  } finally { f.cleanup(); }
});

test('Help groups the keys that share a purpose and names every key the shell runs', () => {
  const rendered = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 120, height: 90 });
  const whole = plain(rendered.lines.join('\n'));
  // Every binding the shell reads is named on the page.
  for (const name of Object.keys(DASHBOARD_KEYS)) {
    assert.ok(whole.includes(DASHBOARD_KEYS[name].keys), `help lost ${name} (${DASHBOARD_KEYS[name].keys})`);
  }
  // The page keys are one row, the way the prototype groups them. With
  // History merged into Runs and h rebound to Home, the pages row is r b s f
  // and h and ? get their own rows.
  assert.match(whole, /^ r b s f\s+Runs · Budget · Stats · Fleet$/m);
  assert.match(whole, /^ h\s+Home$/m);
  // `y` is a jump into Runs' history table now, not a page of its own.
  assert.match(whole, /^ y\s+Runs, at the first day of its history$/m);
  assert.match(whole, /^ \?\s+this help$/m);
  assert.match(whole, /^ ↑\/k ↓\/j\s+scroll one line$/m);
  // Budget has no sub-tabs, so the page does not say it has.
  assert.doesNotMatch(whole, /sub-tab[^\n]*Budget/);
  assert.match(whole, /next sub-tab on Stats and Fleet/);
  // And the page stays compact. Requirement 7 moved the agents and `run it`
  // blocks here from Runs, so the bound now covers 49 rows: the thirty the
  // page had, plus the two moved blocks.
  const body = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 120, height: 90 });
  assert.ok(body.body.total <= 52, `help is ${body.body.total} rows`);
  assert.ok(body.body.total >= 25, `help is only ${body.body.total} rows`);
  assert.match(rendered.lines.join('\n'), /\x1b\[38;2;124;127;138m/, 'Help secondary copy uses the shared grey role');
});

test('`workflow tui --overview` keeps the two shapes the Claude mod pane parses', () => {
  const { home, cleanup } = fixture();
  try {
    const snapshot = overviewSnapshot(home, 'abc234', { width: 100, height: 30 });
    const text = snapshot.lines.join('\n');
    // parseOverview reads `── ` section rules and `HH:MM ` milestones, and
    // strips the box border; all three are still what this command prints.
    assert.ok(snapshot.lines.some((line) => /^┌/.test(line)), 'the overview lost its box');
    const inner = snapshot.lines.map((line) => line.replace(/^│/, '').replace(/│$/, ''));
    assert.ok(inner.some((line) => /^── /.test(line)), 'the overview lost its section rules');
    assert.ok(inner.some((line) => /^\d{2}:\d{2}\s/.test(line)), 'the overview lost its milestones');
    // The goal preview only the Run page dropped is still here.
    assert.ok(inner.some((line) => /Goal accepted/.test(line)));
    assert.ok(inner.some((line) => /Audit every file autonomously\./.test(line)),
      'the overview lost the goal text the mod pane shows');
  } finally { cleanup(); }
});

// A fan the next level closes: the prototype (docs/design/prototype-frames/
// run-120.txt) rules each branch across to the joint and closes the last one
// with `┘`, so the plan never draws a `┴` with nothing beneath it — observed
// on run gqq2ra, 2026-09-17, where `stream-persist ─┴─ integrate` sat over a
// longer `└─ handoff-preamble` that connected to nothing.
test('the plan DAG closes a fan with ruled branches and a corner, never a hanging ┴', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-fan-'));
  try {
    const startedAt = '2026-09-17T06:46:00.000Z';
    const document = createV2GoalDocument({
      goal: 'fan and join', cwd: tmpdir(),
      requirements: [{ id: 'requirement-1', text: 'Both halves land.', mandatory: true }],
      settings: { scout: false, executionMode: 'program' },
    });
    let state = createV2State(document, { runId: 'wf-fan', shortId: 'fan111' });
    const step = (id, dependsOn, extra = {}) => ({
      id, purpose: `${id} purpose`, dependsOn, affects: ['requirement-1'], ownedFiles: [`${id}.md`], prompt: `${id}.`,
      lane: 'build', effort: 'low', evidenceFor: [], inputs: dependsOn, produces: [id], ...extra,
    });
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Fan then join.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        step('design-map', []),
        step('stream-persist', ['design-map']),
        step('handoff-preamble', ['design-map']),
        step('integrate', ['stream-persist', 'handoff-preamble']),
        step('verify', ['integrate'], { affects: [], evidenceFor: ['requirement-1'], lane: 'analyze', ownedFiles: [], produces: [] }),
      ] },
    });
    state.lifecycle = { status: 'running', startedAt, finishedAt: null, resultFile: null };
    for (const action of state.actions.slice(0, 3)) Object.assign(action, { status: 'succeeded', startedAt, finishedAt: startedAt, attempts: 1 });
    Object.assign(state.actions[3], { status: 'running', startedAt, attempts: 1 });
    state.attempts = state.actions.slice(0, 4).map((action, index) => ({
      id: `${action.id}-1`, actionId: action.id, ordinal: 1, pool: 'codex', model: 'luna',
      status: index < 3 ? 'succeeded' : 'running', startedAt, finishedAt: index < 3 ? startedAt : null,
    }));
    state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
    const dir = join(home, 'workflows', 'wf-fan');
    mkdirSync(dir, { recursive: true });
    // Durable action events give each dependency level its own phase, the
    // way a real run does; the plan reads its levels from those phases.
    appendEvent(dir, state, 'action.started', { actionId: 'design-map' });
    appendEvent(dir, state, 'action.finished', { actionId: 'design-map', status: 'succeeded' });
    for (const id of ['stream-persist', 'handoff-preamble']) appendEvent(dir, state, 'action.started', { actionId: id });
    for (const id of ['stream-persist', 'handoff-preamble']) appendEvent(dir, state, 'action.finished', { actionId: id, status: 'succeeded' });
    appendEvent(dir, state, 'action.started', { actionId: 'integrate' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows[0], { runs: rows, usage: usageFixture() });
    const frame = renderDashboardPage(model, { page: 'run', width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-fan' });
    const text = frame.lines.map(plain);
    const top = text.find((line) => line.includes('stream-persist'));
    const bottom = text.find((line) => line.includes('handoff-preamble'));
    assert.ok(top && bottom, 'both branches of the fan are drawn');
    assert.doesNotMatch(text.join('\n'), /┴/, 'no ┴ hangs over a branch that never connects');
    // The fan opens and closes with ┬ on the top row.
    assert.match(top, /design-map ─┬─ . stream-persist ─+┬── . integrate/);
    // The longer lower branch hangs under the ┬ that opened the fan, is ruled
    // across to the joint, and closes with ┘ exactly under the closing ┬.
    assert.match(bottom, /└─ . handoff-preamble ─+┘/);
    assert.equal(bottom.indexOf('└'), top.indexOf('┬'), 'the branch hangs under the joint that opened it');
    assert.equal(bottom.indexOf('┘'), top.lastIndexOf('┬'), 'the corner sits under the joint it closes');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
