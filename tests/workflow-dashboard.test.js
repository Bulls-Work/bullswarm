import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dashboardModel, dashboardRows, renderDashboard, renderDashboardPage, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, runDashboard } from '../src/workflow/dashboard.js';
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

function timelinePaneRows(screen) {
  const rows = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
  const top = rows.findIndex((line) => line.includes('Workflow timeline ·'));
  if (top < 0) return [];
  const left = rows[top].indexOf('┌ Workflow timeline');
  const pane = [];
  for (const line of rows.slice(top + 1)) {
    const cell = line.slice(left);
    if (!cell.startsWith('│')) break; // the Live divider closes the timeline pane
    pane.push(cell.replace(/^│/, '').replace(/│$/, '').trimEnd());
  }
  return pane;
}

function timelineSegments(screen) {
  const segments = [];
  for (const line of timelinePaneRows(screen)) {
    const header = /^─{2,}\s+(.+?)\s+─{2,}\s+(\S+)\s+─+$/.exec(line);
    if (header) segments.push({ label: header[1].replace(/^Phase \d+ · /, ''), elapsed: header[2], rows: [] });
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
    const screen = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.doesNotMatch(screen, /\[Workflow Planner\] plan created/);
    assert.match(screen, /● Goal accepted/);
    assert.match(screen, /── Phase 1 · Implementation/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /├─ started/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /└─✓ completed/);
    assert.match(screen, /── Phase 2 · Evidence/);
    assert.doesNotMatch(timelinePaneRows(screen).join('\n'), /\[Phase:/);
    assert.match(screen, /check-result · relay:b · gpt-5\.6-luna/);
    assert.doesNotMatch(screen, /Live[^]*implement-result · relay/);
    assert.match(screen, /Waiting for 1 worker/);
    assert.equal(workflowPanelModel(row).phases[0].name, 'r1-implementation');
    const narrowTimeline = renderWorkflowTui(row, { width: 60, height: 26, focus: 0 });
    const narrowPhases = renderWorkflowTui(row, { width: 60, height: 26, focus: 0, mobileTimeline: false });
    const narrowAgents = renderWorkflowTui(row, { width: 60, height: 26, focus: 1 });
    assert.match(narrowTimeline, /Workflow timeline/);
    assert.doesNotMatch(narrowTimeline, /Phases · 2/);
    assert.match(narrowPhases, /Phases · 2/);
    assert.doesNotMatch(narrowPhases, /Workflow timeline/);
    assert.match(narrowAgents, /Evidence · 0\/1 complete/);
    assert.doesNotMatch(narrowAgents, /Workflow timeline/);
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
    assert.match(output.text, /Runs · active/);
    assert.match(output.text, /abc234 · Audit every file/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('a run ID passed to the dashboard opens that run on the Run page', async () => {
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30, token: 'v2n456' });
    const runPage = lastFrame(session.output);
    assert.match(frameHeader(runPage), /^ v2n456 completed · .* · 0\/0 actions · done/);
    assert.match(plain(runPage), /Workflow timeline/);
    session.press('\r'); // the run page opens its agents
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ v2n456 completed/);
    session.press(ESC_KEY); // and out to Home, where the run is listed
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    assert.match(plain(lastFrame(session.output)), /v2n456 · Newer V2 dashboard run/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('recent-list V2 selection opens that run on the Run page', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30 });
    session.press('a'); // active -> all
    session.press('\u001b[B'); // active run -> newer V2 run
    assert.match(plain(lastFrame(session.output)), /Runs · all/);
    assert.match(plain(lastFrame(session.output)), /v2n456 · Newer V2 dashboard run/);
    session.press('\r');
    assert.match(frameHeader(lastFrame(session.output)), /^ v2n456 completed/);
    assert.match(plain(lastFrame(session.output)), /Phases ·/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('live dashboard navigation preserves V2 drilldowns, mobile panes, and empty active fallback', async () => {
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
    assert.match(mobile.press('t'), /Phases ·/);
    assert.doesNotMatch(mobile.press('t'), /Phases ·/);
    assert.match(mobile.press('t'), /Phases ·/);
    assert.equal(await mobile.quit(), 0);

    // Bare active view: no active rows show the explicit recent-runs escape.
    const emptyHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-empty-'));
    addV2HistoricalRun(emptyHome);
    const empty = shellSession(emptyHome, { columns: 120, rows: 30 });
    assert.match(plain(lastFrame(empty.output)), /Press a to browse recent runs\./);
    empty.press('a');
    assert.match(plain(lastFrame(empty.output)), /Runs · all/);
    assert.match(plain(lastFrame(empty.output)), /v2n456 · Newer V2 dashboard run/);
    assert.equal(await empty.quit(), 0);
    rmSync(emptyHome, { recursive: true, force: true });
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
    assert.match(printed, /Workflow timeline/);
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

test('bare workflow dashboard navigates active and recent runs on mobile', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    const session = shellSession(home, { columns: 60, rows: 26 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('a'); // active -> all
    session.press('\u001b[B'); // select the historical run
    session.press('\r'); // open it on the Run page
    session.press(ESC_KEY); // back to Home
    session.press('/');
    session.press('def');
    session.press('\r');
    assert.match(plain(lastFrame(session.output)), /Showing workflows matching “def”/);
    assert.match(plain(lastFrame(session.output)), /Runs · all/);
    assert.match(plain(lastFrame(session.output)), /def345 · Audit documentation/);
    assert.match(session.output.text, /Workflow timeline/);
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
    assert.match(plain(timelineText), /Workflow timeline/);
    assert.match(preflightText, /\x1b\[7m── Preflight/);
    assert.match(plannerText, /Workflow Planner · overview/);
    assert.match(agentsText, /Implementation · 1\/1 complete/);
    const visibleWidths = paintedRows(timelineText)
      .filter((line) => line.includes('│') || line.includes('┐') || line.includes('┘'))
      .map((line) => line.length);
    assert.ok(visibleWidths.every((lineWidth) => lineWidth <= 80 - 1), 'mobile frames reserve the terminal wrap column');
    assert.match(plain(phasesText), /Phases · 2/);
    assert.doesNotMatch(plain(phasesText), /Workflow timeline/);
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

/** The sticky header: the first painted row of the frame. */
function frameHeader(screen) {
  return String(paintedRows(screen)[0] ?? '').replace(/\s+$/, '');
}

/** The sticky bottom nav as its `[ label ]` buttons, marks included. */
function navButtons(screen) {
  const nav = plain(String(paintedRows(screen).at(-1) ?? ''));
  return [...nav.matchAll(/\[ ([^\]]*?) \]/g)].map((match) => match[1].trim());
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

test('every page paints its own sticky header, and the nav marks the run and the page', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    assert.ok(row, 'the fixture run is listed');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
    });
    const page = (name, extra = {}) => renderDashboardPage(model, {
      page: name, width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha', ...extra,
    }).lines.join('\n');

    // The header names the page: the product on Home, the run on Run, the step
    // on Step (`✓ id · run <id>`), the meter sample on Usage.
    assert.match(frameHeader(page('home')), /^ bullswarm · home/);
    assert.match(frameHeader(page('run')), /^ aaa111 running · .* · 1\/3 actions/);
    assert.match(frameHeader(page('step')), /^ .* build-alpha · run aaa111$/);
    assert.match(frameHeader(page('usage')), /^ Pools · sampled 3m ago$/);
    assert.match(frameHeader(page('help')), /^ bullswarm · help$/);

    // One button per ongoing run, then usage, help and quit — the current run
    // and the current page carrying the mark.
    assert.deepEqual(navButtons(page('home')), ['● aaa111', 'bbb222', 'usage', 'help', 'quit']);
    assert.deepEqual(navButtons(page('run')), ['● aaa111', 'bbb222', 'usage', 'help', 'quit']);
    assert.deepEqual(navButtons(page('usage')), ['aaa111', 'bbb222', '● usage', 'help', 'quit']);
    assert.deepEqual(navButtons(page('help')), ['aaa111', 'bbb222', 'usage', '● help', 'quit']);
    // Step prepends the way back out.
    assert.deepEqual(navButtons(page('step')), ['back', '● aaa111', 'bbb222', 'usage', 'help', 'quit']);

    for (const name of ['home', 'run', 'step', 'usage', 'help']) {
      const frame = renderDashboardPage(model, {
        page: name, width: 100, height: 26, rows, allRows: rows, selectedRunId: 'wf-alpha',
      });
      assert.ok(frame.lines.length <= 26, `${name} painted ${frame.lines.length} rows`);
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
    assert.match(nav, new RegExp(`${key('1')}\\. \\[ ● aaa111 \\]`.replace(/\x1b\[/g, '\\x1b\\[')));
    assert.ok(nav.includes(`${key('2')}. [ bbb222 ]`), 'the second run carries 2.');
    assert.ok(nav.includes(`[ ${key('u')}sage ]`), 'usage underlines its u');
    assert.ok(nav.includes(`[ ${key('h')}elp ]`), 'help underlines its h');
    assert.ok(nav.includes(`[ ${key('q')}uit ]`), 'quit underlines its q');
    const step = renderDashboardPage(model, {
      page: 'step', width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
    });
    assert.ok(String(step.lines.at(-1)).includes(`[ ${key('b')}ack ]`), 'back underlines its b');

    // The digit a button shows is the digit that opens that run.
    const session = shellSession(home, { columns: 100, rows: 24 });
    session.press('2');
    assert.match(frameHeader(lastFrame(session.output)), / bbb222 running/);
    session.press('1');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    session.press('q');
  } finally { cleanup(); }
});

test('Usage and Help open with no run selected: a fresh install with no runs, or only finished ones', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-empty-'));
  try {
    mkdirSync(join(home, 'workflows'), { recursive: true });
    const session = shellSession(home, { columns: 100, rows: 24 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('u');
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
    session.press('?');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help$/);
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, '[ usage ]');
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a frame never paints past the terminal, at any page or width', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows,
      usage: usageFixture(),
      integration: { ok: false, agents: [{ agent: 'codex', skill: { status: 'missing' }, awareness: false }] },
    });

    for (const width of [32, 60, 80, 100, 200]) {
      for (const name of ['home', 'run', 'step', 'usage', 'help']) {
        const screen = renderDashboardPage(model, {
          page: name, width, height: 30, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
          phaseIndex: 1, agentIndex: 0,
        }).lines.join('\n');
        const overflow = paintedRows(screen).filter((line) => [...line].length > width);
        assert.deepEqual(overflow, [], `width ${width} ${name} overflowed`);
        // Whatever the width, the header survives and the nav is drawn whole.
        assert.ok(frameHeader(screen).trim().length > 0, `width ${width} ${name} painted no header`);
        assert.match(plain(paintedRows(screen).at(-1)), /\[ quit \]/, `width ${width} ${name} lost its nav`);
      }
    }
  } finally { cleanup(); }
});

test('the nav records a hit region for every button, run row and step row', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, { runs: rows, usage: usageFixture() });

    const runFrame = renderDashboardPage(model, {
      page: 'run', width: 100, height: 30, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const nav = runFrame.regions.filter((region) => region.y === runFrame.lines.length);
    assert.deepEqual(nav.map((region) => region.action.kind), ['open-run', 'open-run', 'page', 'page', 'quit']);
    assert.deepEqual(nav.map((region) => region.action.page).filter(Boolean), ['usage', 'help']);
    for (const region of nav) {
      const painted = plain(runFrame.lines[region.y - 1]).slice(region.x1 - 1, region.x2);
      assert.match(painted, /^([1-9]\. )?\[ .+ \]$/, `${painted} is not a whole button`);
    }
    // Every step row the timeline prints opens that step.
    const steps = runFrame.regions.filter((region) => region.action.kind === 'open-step');
    assert.ok(steps.length >= 2, `expected the timeline step rows to be clickable: ${steps.length}`);
    assert.deepEqual(new Set(steps.map((region) => region.action.actionId)), new Set(['scan', 'build-alpha']));

    // The Home run rows open their run, and the Usage tabs switch grouping.
    const homeFrame = renderDashboardPage(model, {
      page: 'home', width: 100, height: 30, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const runRows = homeFrame.regions.filter((region) => region.action.kind === 'open-run'
      && region.y !== homeFrame.lines.length);
    assert.deepEqual(runRows.map((region) => region.action.runId), ['wf-alpha', 'wf-beta']);
    assert.equal(plain(homeFrame.lines[runRows[0].y - 1]).slice(runRows[0].x1 - 1, runRows[0].x2).includes('aaa111'), true);

    const usageFrame = renderDashboardPage(model, { page: 'usage', width: 100, height: 30 });
    const tabs = usageFrame.regions.filter((region) => region.action.kind === 'rungs');
    assert.deepEqual(tabs.map((region) => region.action.by), ['lane', 'provider']);
    const tabsRow = plain(usageFrame.lines[tabs[0].y - 1]);
    assert.equal(tabsRow.slice(tabs[0].x1 - 1, tabs[0].x2), '[● by lane]');
    assert.equal(tabsRow.slice(tabs[1].x1 - 1, tabs[1].x2), '[by provider]');
    // `[edit]` in the read-only note is the key e button.
    const edit = usageFrame.regions.find((region) => region.action.kind === 'edit');
    assert.equal(plain(usageFrame.lines[edit.y - 1]).slice(edit.x1 - 1, edit.x2), '[edit]');
    assert.equal(edit.y, usageFrame.lines.length - 1, 'the note sits right above the nav');
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
  columns = 120, rows = 30, token = null, homeDir = home, openSetupTui = null,
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
    input, output, refreshMs: 60_000, token, homeDir, openSetupTui,
  });
  const press = (key) => {
    const before = output.text.length;
    input.emit('data', Buffer.from(key));
    return output.text.slice(before);
  };
  return { input, output, running, press, quit: () => { press('q'); return running; } };
}

test('Tab re-enters the sibling run at the page it was left on', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    session.press('\r'); // run -> agents
    session.press('\r'); // agents -> the selected step
    const atStep = lastFrame(session.output);
    assert.match(frameHeader(atStep), /build-alpha · run aaa111/);

    const sibling = session.press('\t');
    assert.ok(sibling.length, 'Tab repainted the screen');
    // same page, the sibling workflow's own agent, marked current in the nav
    assert.match(frameHeader(sibling), /build-beta · run bbb222/);
    const buttons = navButtons(sibling);
    assert.equal(buttons[0], 'back', 'the sibling is entered at the same depth');
    assert.ok(buttons.includes('● bbb222'), `the sibling is the current run: ${buttons.join(' ')}`);
    assert.ok(!buttons.includes('● aaa111'));
    assert.doesNotMatch(sibling, /build-alpha/);

    // and Shift+Tab comes back the same way, still on the step page
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
    const help = plain(lastFrame(session.output));
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help$/);
    for (const key of ['u · ?', 'q', 'Tab / Shift+Tab', '1–9']) assert.ok(help.includes(key), `the help page lost ${key}`);
    // ? -> help -> Esc -> home -> u -> usage -> Esc -> home
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('u');
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
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
    assert.match(agentPane, /No agent selected\./);
    assert.match(agentPane, /Planned steps in this phase:/);
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
    assert.match(renderWorkflowTui(row, { width, height: 40, mobileTimeline: false }), /Phases · 2/);
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
    const milestones = /Workflow timeline · (\d+) milestones?/.exec(before)[1];
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
    assert.equal(/Workflow timeline · (\d+) milestones?/.exec(running)[1], milestones);
    // the level header still reads running rather than a finished duration
    assert.equal(timelineSegments(running).find((segment) => segment.label === 'Evidence').elapsed, 'running');

    // the agent pane leads with the elapsed time; token usage only exists once the attempt finishes
    const agents = renderWorkflowTui(row, { width: 130, height: 22, focus: 1, spinnerFrame: 0 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.match(agents, /check-result · relay:b · gpt-5\.6-luna · #1 · 1m0[5-9]s/);
    assert.doesNotMatch(agents, /#1 · pending/);
    assert.match(agents, /Tokens · pending/);

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
    assert.match(renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 130, height: 22, focus: 1, phaseIndex: 1 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), /#1 · 1m0[5-9]s · 1\.2k tok/);
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
    assert.match(phaseOne, /implement-result · relay · gpt-5\.6-luna · max · #1/);
    assert.match(phaseOne, /succeeded · gpt-5\.6-luna · max/);
    // The drilled-in agent pane states it as a labelled field beside effort.
    const agentPane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 });
    assert.match(agentPane, /succeeded · gpt-5\.6-luna · max/);
    // The V2 tier lives under attempt.routing; both fields read correctly.
    assert.match(agentPane, /relay · attempt 1 · effort low · reasoning max/);
    // Narrow mode keeps the same fact on the single full-width agent pane.
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 1, agentIndex: 0 });
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
    const agentPane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 });
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
    const tall = renderWorkflowTui(row, { width: 100, height: 46 });
    assert.deepEqual(segmentLabels(tall), ['Preflight', 'Implementation']);
    assert.deepEqual(timelinePaneRows(tall).filter((line) => line.includes('continued')), []);

    const short = renderWorkflowTui(row, { width: 100, height: 22 });
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
    const following = renderWorkflowTui(row, { width: 100, height: 22 });
    const pane = timelinePaneRows(following);
    // Auto-follow ends on the newest event — the running worker — and never
    // claims there is anything newer below the viewport.
    assert.match(pane.filter((line) => line.trim()).at(-1), /work-tail/);
    assert.deepEqual(pane.filter((line) => line.includes('newer timeline rows')), []);
    assert.match(frameHeader(following), /^ lng234 /);

    // Scrolling back holds older rows in place and says how much is newer.
    const scrolled = timelinePaneRows(renderWorkflowTui(row, { width: 100, height: 22, detailScroll: 4 }));
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
    const screen = renderWorkflowTui(row, { width: 60, height: 44 });
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
    const scrolled = renderWorkflowTui(long.row(), { width: 60, height: 22 });
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
    const contentWidths = (screen) => plain(screen).split('\n')
      .filter((line) => line.startsWith('│') && line.endsWith('│'))
      .map((line) => line.slice(1, -1).trimEnd().length);
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 });
    assert.match(plain(narrow), /audit-files · planner-agent/);
    const widest = Math.max(...contentWidths(narrow));
    // 60 columns minus the 34-column sidebar minus padding is 22: the width the
    // detail used to wrap at even though the narrow pane spans the whole screen.
    assert.ok(widest > 22, `narrow detail still wraps at ${widest} columns`);
    assert.ok(widest <= 58, `narrow detail overflows the panel: ${widest} columns`);
    const wide = plain(renderWorkflowTui(row, { width: 120, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(wide, /audit-files · planner-agent/);
    // Wide layout is unchanged: two panels side by side on every body row.
    assert.ok(wide.split('\n').some((line) => /^│.*││.*│$/.test(line)));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The pages the mod asked for: the Usage page with its meter windows, rungs,
// tabs and read-only note; the Home install button; the mouse; and the setup
// hand-off. Each page is a pure function of a model, so every expectation
// below is a frame the terminal would paint verbatim.
// ---------------------------------------------------------------------------

test('the Usage page draws every meter window, the rungs, the tabs and the read-only note', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage });
  const frame = renderDashboardPage(model, { page: 'usage', width: 100, height: 30 });
  const text = plain(frame.lines.join('\n'));

  assert.match(frameHeader(text), /^ Pools · sampled 3m ago$/);
  // Every window of the enabled pool: its bar, its used%, its reset time and
  // the pace word the elapsed mark implies, then the credit meter.
  assert.match(text, /relay · max/);
  assert.match(text, /5h {2}/);
  assert.match(text, /32\.0%/);
  assert.match(text, /resets 1h00m · slow \+48pp/);
  assert.match(text, /7d {2}/);
  assert.match(text, /55\.0%/);
  assert.match(text, /hot −28pp/);
  assert.match(text, /63\.5 \/ 70 credits/);
  // A disabled pool draws no windows.
  assert.doesNotMatch(text, /codex/);
  // The rungs with the local record, under the two tabs, the active one marked.
  assert.match(text, /Rungs · model · reasoning · record, per lane and pool/);
  assert.match(text, /\[● by lane\] \[by provider\]/);
  assert.match(text, /gpt-5\.6-luna · high/);
  assert.match(text, /3 runs · 67% ok · p50 12m/);
  assert.match(text, /high · integration · architecture · adversarial-acceptance/);
  // The note is whole, wrapped, right above the nav.
  assert.equal(plain(frame.lines.at(-2)), 'read-only here · [edit] opens bullswarm setup');
  assert.match(plain(frame.lines.at(-1)), /\[ ● usage \]/);

  const byProvider = renderDashboardPage(model, { page: 'usage', width: 100, height: 30, rungsBy: 'provider' });
  const providerText = plain(byProvider.lines.join('\n'));
  assert.match(providerText, /\[by lane\] \[● by provider\]/);
  assert.match(providerText, /relay · weekly window · 32% used of 27% elapsed/);
});

test('meters are background-coloured cells, and the compact rows use them too', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage });
  const usagePage = renderDashboardPage(model, { page: 'usage', width: 100, height: 30 }).lines.join('\n');
  // #b6bd73 below 50% used, #e9c880 from 50%, #bf6c69 from 80%, track #3a3a3a.
  assert.ok(usagePage.includes('\x1b[48;2;182;189;115m'), 'the green fill is a background-coloured cell');
  assert.ok(usagePage.includes('\x1b[48;2;233;200;128m'), 'the amber fill is a background-coloured cell');
  assert.ok(usagePage.includes('\x1b[48;2;58;58;58m'), 'the track is a background-coloured cell');
  assert.match(usagePage, /\x1b\[38;2;255;255;255m▏/, 'the elapsed mark is a white ▏');

  const rows = [{ runId: 'wf-alpha', shortId: 'aaa111', ongoing: true, state: {} }];
  const home = renderDashboardPage(dashboardModel(null, { runs: rows, usage }), {
    page: 'home', width: 100, height: 30, rows, allRows: rows,
  }).lines.join('\n');
  assert.match(home, /Pools ▸/);
  assert.ok(home.indexOf('\x1b[48;2;182;189;115m') > home.indexOf('relay'), 'the pool row carries a filled bar');
  assert.ok(home.includes('\x1b[48;2;58;58;58m'), 'and the same track behind it');
  assert.doesNotMatch(home, /█/, 'no `█░` bar survives anywhere');
});

test('the Home integration line offers [install] until every agent is installed, then reads [installed ✓]', () => {
  const offered = renderDashboardPage(dashboardModel(null, {
    runs: [],
    integration: {
      ok: false,
      agents: [
        { agent: 'codex', skill: { status: 'installed' }, awareness: true },
        { agent: 'claude', skill: { status: 'missing' }, awareness: false, mod: { status: 'missing' }, hooksFlag: false },
      ],
    },
  }), { page: 'home', width: 100, height: 30 });
  const text = offered.lines.join('\n');
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
  }), { page: 'home', width: 100, height: 30 });
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

    clickOn(session, '[ bbb222 ]');
    assert.match(frameHeader(lastFrame(session.output)), / bbb222 running/);
    clickOn(session, '[ usage ]');
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · \[edit\] opens bullswarm setup/);

    // Esc goes Home; its run rows are clickable, and so are the step rows.
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, 'aaa111 · unified-shell');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    clickOn(session, 'build-alpha');
    const step = lastFrame(session.output);
    assert.match(frameHeader(step), /build-alpha · run aaa111/);
    assert.equal(navButtons(step)[0], 'back');
    clickOn(session, '[ back ]');
    assert.match(frameHeader(lastFrame(session.output)), / aaa111 running/);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { cleanup(); }
});

test('the Home [install] button installs the agent integration in-process', async () => {
  const { home, cleanup } = shellFixture();
  const agentHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-integrate-'));
  try {
    const session = shellSession(home, { columns: 100, rows: 30, homeDir: agentHome });
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

test('the [edit] button pauses the dashboard for setup and resumes on the Usage page', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const handoffs = [];
    const openSetupTui = async ({ bullswarmDir, input, output }) => {
      handoffs.push({ bullswarmDir, isTTY: input.isTTY, painted: output.text.length });
    };
    const session = shellSession(home, { columns: 100, rows: 26, token: 'wf-alpha', openSetupTui });
    session.press('u');
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
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
    // It returns to the Usage page with the note and a fresh repaint.
    assert.match(frameHeader(lastFrame(session.output)), /^ Pools · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · \[edit\] opens bullswarm setup/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});
